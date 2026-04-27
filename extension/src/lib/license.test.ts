import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  activateLicense,
  deactivateLicense,
  getInstallationId,
  getLicense,
  isLicensed,
  isValidKeyFormat,
  normalizeKey,
  revalidateIfStale,
} from "./license";
import { REVALIDATION_INTERVAL_MS } from "./constants";

let store: Record<string, unknown>;

function mockChrome() {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get(keys: string) {
          return Promise.resolve(keys in store ? { [keys]: store[keys] } : {});
        },
        set(items: Record<string, unknown>) {
          Object.assign(store, items);
          return Promise.resolve();
        },
        remove(keys: string) {
          delete store[keys];
          return Promise.resolve();
        },
      },
    },
  };
  // crypto.randomUUID exists in Node 19+ which vitest uses by default. Make
  // it deterministic for tests.
  let n = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(
    () => `00000000-0000-0000-0000-${(++n).toString().padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
  );
}

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

function mockFetchNetworkError() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network down");
    }),
  );
}

beforeEach(() => {
  mockChrome();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mockChrome();
});

const VALID = "CH-ABCD-EFGH-IJKL-MNOP";

describe("normalizeKey", () => {
  it("uppercases and trims", () => {
    expect(normalizeKey("  ch-abcd-efgh-ijkl-mnop ")).toBe("CH-ABCD-EFGH-IJKL-MNOP");
  });

  it("strips internal whitespace", () => {
    expect(normalizeKey("CH-ABCD- EFGH-IJKL-MNOP")).toBe("CH-ABCD-EFGH-IJKL-MNOP");
  });
});

describe("isValidKeyFormat", () => {
  it.each([
    "CH-ABCD-EFGH-IJKL-MNOP",
    "CH-1234-5678-9ABC-DEFG",
    "CH-AAAA-BBBB-CCCC-DDDD",
    "ch-abcd-efgh-ijkl-mnop",
  ])("accepts %s", (k) => {
    expect(isValidKeyFormat(k)).toBe(true);
  });

  it.each([
    "",
    "CH-ABCD",
    "CH-ABCD-EFGH-IJKL",
    "ABCD-EFGH-IJKL-MNOP",
    "CH-ABCD-EFGH-IJKL-MNOPX",
    "CH-ABC-EFGH-IJKL-MNOP",
    "CH-ABCD-EFGH-IJKL-MNOP-EXTRA",
    "CH-ABCD-EFGH-IJKL-MN!P",
    "VA-ABCD-EFGH-IJKL-MNOP",
  ])("rejects %s", (k) => {
    expect(isValidKeyFormat(k)).toBe(false);
  });
});

describe("getInstallationId", () => {
  it("generates and persists a UUID on first call", async () => {
    const id1 = await getInstallationId();
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
    const id2 = await getInstallationId();
    expect(id2).toBe(id1);
  });
});

describe("activateLicense", () => {
  it("rejects invalid format without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await activateLicense("not-a-license");
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await isLicensed()).toBe(false);
  });

  it("activates when server returns valid", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    const r = await activateLicense(VALID);
    expect(r.ok).toBe(true);
    const license = await getLicense();
    expect(license.key).toBe(VALID);
    expect(typeof license.activatedAt).toBe("number");
    expect(typeof license.lastValidatedAt).toBe("number");
  });

  it("normalizes lowercase input before sending", async () => {
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ valid: true, maxDevices: 5 })),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await activateLicense("ch-abcd-efgh-ijkl-mnop");
    const init = fetchSpy.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.key).toBe("CH-ABCD-EFGH-IJKL-MNOP");
    expect(typeof body.installationId).toBe("string");
  });

  it("rejects when server says NOT_FOUND", async () => {
    mockFetch({ valid: false, reason: "NOT_FOUND" });
    const r = await activateLicense(VALID);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: expect.stringContaining("not found") });
    expect(await isLicensed()).toBe(false);
  });

  it("rejects with device-cap message on DEVICE_LIMIT", async () => {
    mockFetch({ valid: false, reason: "DEVICE_LIMIT", maxDevices: 5 });
    const r = await activateLicense(VALID);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: expect.stringContaining("5 devices") });
  });

  it("rejects with REFUNDED message", async () => {
    mockFetch({ valid: false, reason: "REFUNDED" });
    const r = await activateLicense(VALID);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: expect.stringContaining("refunded") });
  });

  it("returns network error if fetch throws", async () => {
    mockFetchNetworkError();
    const r = await activateLicense(VALID);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: expect.stringContaining("license server") });
    expect(await isLicensed()).toBe(false);
  });
});

describe("deactivateLicense", () => {
  it("removes activation", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);
    await deactivateLicense();
    expect(await isLicensed()).toBe(false);
  });
});

describe("revalidateIfStale", () => {
  it("skips when no license stored", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await revalidateIfStale()).toEqual({ status: "skipped" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips when last validation is fresh", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await revalidateIfStale()).toEqual({ status: "skipped" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-validates when stale and updates lastValidatedAt", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);

    const stored = (await getLicense());
    const oldValidatedAt = stored.lastValidatedAt!;
    const future = oldValidatedAt + REVALIDATION_INTERVAL_MS + 1000;

    mockFetch({ valid: true, maxDevices: 5 });
    expect(await revalidateIfStale(future)).toEqual({ status: "ok" });
    expect((await getLicense()).lastValidatedAt).toBe(future);
  });

  it("deactivates on REFUNDED", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);
    const future = Date.now() + REVALIDATION_INTERVAL_MS + 1000;

    mockFetch({ valid: false, reason: "REFUNDED" });
    expect(await revalidateIfStale(future)).toEqual({ status: "deactivated", reason: "REFUNDED" });
    expect(await isLicensed()).toBe(false);
  });

  it("deactivates on REVOKED", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);
    const future = Date.now() + REVALIDATION_INTERVAL_MS + 1000;

    mockFetch({ valid: false, reason: "REVOKED" });
    expect(await revalidateIfStale(future)).toEqual({ status: "deactivated", reason: "REVOKED" });
    expect(await isLicensed()).toBe(false);
  });

  it("transient on network error keeps license cached", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);
    const future = Date.now() + REVALIDATION_INTERVAL_MS + 1000;

    mockFetchNetworkError();
    expect(await revalidateIfStale(future)).toEqual({ status: "transient" });
    expect(await isLicensed()).toBe(true);
  });
});
