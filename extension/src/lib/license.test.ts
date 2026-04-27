import { describe, it, expect, beforeEach } from "vitest";
import {
  activateLicense,
  deactivateLicense,
  getLicense,
  isLicensed,
  isValidKeyFormat,
  normalizeKey,
} from "./license";

let store: Record<string, unknown>;

beforeEach(() => {
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
});

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
    "ch-abcd-efgh-ijkl-mnop", // case-insensitive via normalize
  ])("accepts %s", (k) => {
    expect(isValidKeyFormat(k)).toBe(true);
  });

  it.each([
    "",
    "CH-ABCD",
    "CH-ABCD-EFGH-IJKL",
    "ABCD-EFGH-IJKL-MNOP",
    "CH-ABCD-EFGH-IJKL-MNOPX", // too long
    "CH-ABC-EFGH-IJKL-MNOP", // too short group
    "CH-ABCD-EFGH-IJKL-MNOP-EXTRA",
    "CH-ABCD-EFGH-IJKL-MN!P", // invalid char
  ])("rejects %s", (k) => {
    expect(isValidKeyFormat(k)).toBe(false);
  });
});

describe("activateLicense", () => {
  it("activates a valid key", async () => {
    const r = await activateLicense("CH-ABCD-EFGH-IJKL-MNOP");
    expect(r.ok).toBe(true);
    expect(await isLicensed()).toBe(true);
    const license = await getLicense();
    expect(license.key).toBe("CH-ABCD-EFGH-IJKL-MNOP");
    expect(typeof license.activatedAt).toBe("number");
  });

  it("rejects invalid format", async () => {
    const r = await activateLicense("not-a-license");
    expect(r.ok).toBe(false);
    expect(await isLicensed()).toBe(false);
  });

  it("normalizes lowercase input", async () => {
    const r = await activateLicense("ch-abcd-efgh-ijkl-mnop");
    expect(r.ok).toBe(true);
    expect((await getLicense()).key).toBe("CH-ABCD-EFGH-IJKL-MNOP");
  });
});

describe("deactivateLicense", () => {
  it("removes activation", async () => {
    await activateLicense("CH-ABCD-EFGH-IJKL-MNOP");
    await deactivateLicense();
    expect(await isLicensed()).toBe(false);
    expect(await getLicense()).toEqual({});
  });
});

describe("isLicensed", () => {
  it("false when no license stored", async () => {
    expect(await isLicensed()).toBe(false);
  });
});
