import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  activateLicense,
  dismissLicenseNotice,
  deactivateLicense,
  getInstallationId,
  getLicense,
  getLicenseNotice,
  isLicensed,
  isValidKeyFormat,
  normalizeKey,
  removeLicenseLocally,
  revalidateIfStale,
  type LicenseState,
} from "./license";
import { REVALIDATION_INTERVAL_MS } from "./constants";

let store: Record<string, unknown>;
const ACTIVATION_ID = "11111111-1111-1111-1111-111111111111";

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
  const responseBody =
    typeof body === "object" &&
    body !== null &&
    "valid" in body &&
    body.valid === true &&
    !("activationId" in body)
      ? { ...body, activationId: ACTIVATION_ID }
      : body;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(responseBody), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ),
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

  it("single-flights simultaneous first-use initialization", async () => {
    const [id1, id2, id3] = await Promise.all([
      getInstallationId(),
      getInstallationId(),
      getInstallationId(),
    ]);

    expect(new Set([id1, id2, id3])).toEqual(new Set([id1]));
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });
});

describe("getLicense", () => {
  it("fails closed on malformed persisted entitlement state", async () => {
    store.license = {
      key: "not-a-license",
      activationId: "not-a-generation",
      lastValidatedAt: "yesterday",
    };

    expect(await getLicense()).toEqual({});
    expect(await isLicensed()).toBe(false);
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
    expect(license.activationId).toBe(ACTIVATION_ID);
  });

  it("normalizes lowercase input before sending", async () => {
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            valid: true,
            maxDevices: 5,
            activationId: ACTIVATION_ID,
          }), {
          headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await activateLicense("ch-abcd-efgh-ijkl-mnop");
    const init = fetchSpy.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.key).toBe("CH-ABCD-EFGH-IJKL-MNOP");
    expect(typeof body.installationId).toBe("string");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(/\/v2\/activate$/);
  });

  it("coalesces a queued repeat after the first activation succeeds", async () => {
    mockFetch({ valid: true, maxDevices: 5 });

    const [first, second] = await Promise.all([
      activateLicense(VALID),
      activateLicense(VALID),
    ]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("requires deactivation before a different key can replace the current one", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);

    expect(await activateLicense("CH-1234-5678-9ABC-DEFG")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Deactivate the current license"),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await getLicense()).key).toBe(VALID);
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

  it("rejects an untyped or malformed successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    const result = await activateLicense(VALID);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("invalid response") });
    expect(await isLicensed()).toBe(false);
  });

  it("treats 5xx as transient even if its body claims success", async () => {
    mockFetch({ valid: true, maxDevices: 5 }, 503);

    expect(await activateLicense(VALID)).toMatchObject({
      ok: false,
      error: expect.stringContaining("temporarily unavailable"),
    });
    expect(await isLicensed()).toBe(false);
  });
});

describe("deactivateLicense", () => {
  it("removes the local key only after the server confirms slot removal", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);
    mockFetch({ ok: true, active: false });

    expect(await deactivateLicense()).toEqual({ ok: true });
    expect(await isLicensed()).toBe(false);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toMatch(/\/v2\/deactivate$/);
    const requestBody = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? "{}"),
    );
    expect(requestBody).toMatchObject({
      activationId: ACTIVATION_ID,
      operationId: expect.any(String),
    });
  });

  it("keeps the key when the server cannot confirm deactivation", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);
    mockFetchNetworkError();

    expect(await deactivateLicense()).toMatchObject({
      ok: false,
      canRemoveLocally: true,
    });
    expect(await isLicensed()).toBe(true);
    const pendingOperation = (await getLicense()).pendingDeactivationId;
    expect(pendingOperation).toMatch(/^[0-9a-f-]{36}$/);

    mockFetch({ ok: true, active: false });
    expect(await deactivateLicense()).toEqual({ ok: true });
    const retryBody = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? "{}"),
    );
    expect(retryBody.operationId).toBe(pendingOperation);
  });

  it("offers an explicit local-only recovery that does not claim to free a slot", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);

    await removeLicenseLocally();

    expect(await isLicensed()).toBe(false);
  });

  it("sends one request for simultaneous repeats", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);
    mockFetch({ ok: true, active: false });

    const [first, second] = await Promise.all([
      deactivateLicense(),
      deactivateLicense(),
    ]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("upgrades a legacy local license with a status-only generation before deactivation", async () => {
    store.license = {
      key: VALID,
      activatedAt: 1,
      lastValidatedAt: 1,
    } satisfies LicenseState;
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            valid: true,
            active: true,
            maxDevices: 5,
            activationId: ACTIVATION_ID,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, active: false }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    expect(await deactivateLicense()).toEqual({ ok: true });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(/\/v2\/status$/);
    expect(String(fetchSpy.mock.calls[1]?.[0])).toMatch(/\/v2\/deactivate$/);
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

    mockFetch({ valid: true, active: true, maxDevices: 5 });
    expect(await revalidateIfStale(future)).toEqual({ status: "ok" });
    expect((await getLicense()).lastValidatedAt).toBe(future);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toMatch(/\/v2\/status$/);
  });

  it("does not let future persisted timestamps postpone validation indefinitely", async () => {
    const now = 10_000;
    store.license = {
      key: VALID,
      activatedAt: 1,
      lastValidatedAt: now + REVALIDATION_INTERVAL_MS,
      lastValidationAttemptAt: now + REVALIDATION_INTERVAL_MS,
      activationId: ACTIVATION_ID,
    } satisfies LicenseState;
    mockFetch({
      valid: true,
      active: true,
      maxDevices: 5,
      activationId: ACTIVATION_ID,
    });

    expect(await revalidateIfStale(now)).toEqual({ status: "ok" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await getLicense()).lastValidatedAt).toBe(now);
  });

  it("deactivates on REFUNDED", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);
    const future = Date.now() + REVALIDATION_INTERVAL_MS + 1000;

    mockFetch({ valid: false, reason: "REFUNDED" });
    expect(await revalidateIfStale(future)).toMatchObject({ status: "deactivated", reason: "REFUNDED" });
    expect(await isLicensed()).toBe(false);
    expect(await getLicenseNotice()).toMatchObject({
      reason: "REFUNDED",
      message: expect.stringContaining("free tier"),
    });
    expect(await getLicenseNotice()).toMatchObject({ reason: "REFUNDED" });
    await dismissLicenseNotice();
    expect(await getLicenseNotice()).toBeNull();
  });

  it("deactivates on REVOKED", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);
    const future = Date.now() + REVALIDATION_INTERVAL_MS + 1000;

    mockFetch({ valid: false, reason: "REVOKED" });
    expect(await revalidateIfStale(future)).toMatchObject({ status: "deactivated", reason: "REVOKED" });
    expect(await isLicensed()).toBe(false);
  });

  it("deactivates with an actionable notice when the installation is absent", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);
    const future = Date.now() + REVALIDATION_INTERVAL_MS + 1000;

    mockFetch({ valid: false, active: false, reason: "NOT_ACTIVATED" });
    const result = await revalidateIfStale(future);

    expect(result).toMatchObject({
      status: "deactivated",
      reason: "NOT_ACTIVATED",
      message: expect.stringContaining("activate this browser again"),
    });
    expect(await isLicensed()).toBe(false);
  });

  it("transient on network error keeps license cached", async () => {
    mockFetch({ valid: true, maxDevices: 5 });
    await activateLicense(VALID);
    const future = Date.now() + REVALIDATION_INTERVAL_MS + 1000;

    mockFetchNetworkError();
    expect(await revalidateIfStale(future)).toEqual({ status: "transient" });
    expect(await isLicensed()).toBe(true);
    expect(await revalidateIfStale(future + 1)).toEqual({ status: "skipped" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
