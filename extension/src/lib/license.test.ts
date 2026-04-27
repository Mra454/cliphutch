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
    expect(normalizeKey("  va-abcd-efgh-ijkl-mnop ")).toBe("VA-ABCD-EFGH-IJKL-MNOP");
  });

  it("strips internal whitespace", () => {
    expect(normalizeKey("VA-ABCD- EFGH-IJKL-MNOP")).toBe("VA-ABCD-EFGH-IJKL-MNOP");
  });
});

describe("isValidKeyFormat", () => {
  it.each([
    "VA-ABCD-EFGH-IJKL-MNOP",
    "VA-1234-5678-9ABC-DEFG",
    "VA-AAAA-BBBB-CCCC-DDDD",
    "va-abcd-efgh-ijkl-mnop", // case-insensitive via normalize
  ])("accepts %s", (k) => {
    expect(isValidKeyFormat(k)).toBe(true);
  });

  it.each([
    "",
    "VA-ABCD",
    "VA-ABCD-EFGH-IJKL",
    "ABCD-EFGH-IJKL-MNOP",
    "VA-ABCD-EFGH-IJKL-MNOPX", // too long
    "VA-ABC-EFGH-IJKL-MNOP", // too short group
    "VA-ABCD-EFGH-IJKL-MNOP-EXTRA",
    "VA-ABCD-EFGH-IJKL-MN!P", // invalid char
  ])("rejects %s", (k) => {
    expect(isValidKeyFormat(k)).toBe(false);
  });
});

describe("activateLicense", () => {
  it("activates a valid key", async () => {
    const r = await activateLicense("VA-ABCD-EFGH-IJKL-MNOP");
    expect(r.ok).toBe(true);
    expect(await isLicensed()).toBe(true);
    const license = await getLicense();
    expect(license.key).toBe("VA-ABCD-EFGH-IJKL-MNOP");
    expect(typeof license.activatedAt).toBe("number");
  });

  it("rejects invalid format", async () => {
    const r = await activateLicense("not-a-license");
    expect(r.ok).toBe(false);
    expect(await isLicensed()).toBe(false);
  });

  it("normalizes lowercase input", async () => {
    const r = await activateLicense("va-abcd-efgh-ijkl-mnop");
    expect(r.ok).toBe(true);
    expect((await getLicense()).key).toBe("VA-ABCD-EFGH-IJKL-MNOP");
  });
});

describe("deactivateLicense", () => {
  it("removes activation", async () => {
    await activateLicense("VA-ABCD-EFGH-IJKL-MNOP");
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
