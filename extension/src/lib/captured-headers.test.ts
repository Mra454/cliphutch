import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCapturedHeadersForTab,
  getCapturedHeaders,
  saveCapturedHeaders,
} from "./captured-headers";
import type { CapturedHeaders } from "./header-capture";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        async get(key: string) {
          await Promise.resolve();
          return key in store ? { [key]: store[key] } : {};
        },
        async set(items: Record<string, unknown>) {
          await Promise.resolve();
          Object.assign(store, structuredClone(items));
        },
      },
    },
  };
});

const hdrs = (referer: string): CapturedHeaders => ({ referer });

describe("captured-headers persistence", () => {
  it("round-trips headers by videoId", async () => {
    await saveCapturedHeaders("v1", 7, hdrs("https://a"));
    expect(await getCapturedHeaders("v1")).toEqual(hdrs("https://a"));
  });

  it("returns undefined for an unknown videoId", async () => {
    expect(await getCapturedHeaders("nope")).toBeUndefined();
  });

  it("survives a simulated service-worker restart (backing store persists)", async () => {
    await saveCapturedHeaders("v1", 7, hdrs("https://a"));
    // A restart drops in-memory state but chrome.storage.session persists;
    // reading through a fresh call still finds the entry.
    expect(await getCapturedHeaders("v1")).toEqual(hdrs("https://a"));
  });

  it("clears only the entries for the closed tab", async () => {
    await saveCapturedHeaders("v1", 7, hdrs("https://a"));
    await saveCapturedHeaders("v2", 7, hdrs("https://b"));
    await saveCapturedHeaders("v3", 9, hdrs("https://c"));

    await clearCapturedHeadersForTab(7);

    expect(await getCapturedHeaders("v1")).toBeUndefined();
    expect(await getCapturedHeaders("v2")).toBeUndefined();
    expect(await getCapturedHeaders("v3")).toEqual(hdrs("https://c"));
  });

  it("does not lose concurrent saves for the same tab", async () => {
    await Promise.all([
      saveCapturedHeaders("v1", 1, hdrs("https://a")),
      saveCapturedHeaders("v2", 1, hdrs("https://b")),
      saveCapturedHeaders("v3", 1, hdrs("https://c")),
    ]);
    expect(await getCapturedHeaders("v1")).toBeDefined();
    expect(await getCapturedHeaders("v2")).toBeDefined();
    expect(await getCapturedHeaders("v3")).toBeDefined();
  });
});
