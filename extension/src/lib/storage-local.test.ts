import { beforeEach, describe, expect, it } from "vitest";
import { HARD_HLS_SIZE_CAP_BYTES } from "./constants";
import { DEFAULT_SETTINGS, getSettings, setSettings } from "./storage-local";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get(key: string) {
          return Promise.resolve(key in store ? { [key]: store[key] } : {});
        },
        set(items: Record<string, unknown>) {
          Object.assign(store, items);
          return Promise.resolve();
        },
      },
    },
  };
});

describe("getSettings", () => {
  it("defaults ignored domain filters for older stored settings", async () => {
    store.settings = {
      filenameTemplate: "pageTitle",
      hlsSizeCapBytes: 123,
      showFullUrlsByDefault: true,
    };

    await expect(getSettings()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      filenameTemplate: "pageTitle",
      hlsSizeCapBytes: 123,
      showFullUrlsByDefault: true,
      ignoredSourceHosts: [],
      ignoredPageHosts: [],
    });
  });

  it("persists ignored source and page hosts", async () => {
    await setSettings({
      ignoredSourceHosts: ["cdn.example"],
      ignoredPageHosts: ["news.example"],
    });

    const settings = await getSettings();
    expect(settings.ignoredSourceHosts).toEqual(["cdn.example"]);
    expect(settings.ignoredPageHosts).toEqual(["news.example"]);
  });

  it("persists the bounded Capture Pack quality preference", async () => {
    await setSettings({
      capturePackQualityMode: "manual",
      capturePackMaxHeight: 1080,
    });

    await expect(getSettings()).resolves.toMatchObject({
      capturePackQualityMode: "manual",
      capturePackMaxHeight: 1080,
    });

    await setSettings({
      capturePackQualityMode: "best_under_cap",
      capturePackMaxHeight: undefined,
    });

    const settings = await getSettings();
    expect(settings.capturePackQualityMode).toBe("best_under_cap");
    expect(Object.prototype.hasOwnProperty.call(settings, "capturePackMaxHeight")).toBe(false);
  });

  it("falls back field-by-field when stored settings are corrupt", async () => {
    store.settings = {
      filenameTemplate: "remote-code",
      hlsSizeCapBytes: HARD_HLS_SIZE_CAP_BYTES + 1,
      capturePackQualityMode: "largest",
      capturePackMaxHeight: 999,
      showFullUrlsByDefault: "yes",
      ignoredSourceHosts: ["cdn.example", 7],
      ignoredPageHosts: "news.example",
    };

    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid fields while dropping invalid optional values", async () => {
    store.settings = {
      filenameTemplate: "timestamp",
      hlsSizeCapBytes: 256 * 1024 * 1024,
      capturePackQualityMode: "best_under_cap",
      capturePackMaxHeight: Number.NaN,
      showFullUrlsByDefault: true,
      ignoredSourceHosts: ["cdn.example"],
      ignoredPageHosts: ["news.example"],
    };

    await expect(getSettings()).resolves.toEqual({
      filenameTemplate: "timestamp",
      hlsSizeCapBytes: 256 * 1024 * 1024,
      capturePackQualityMode: "best_under_cap",
      showFullUrlsByDefault: true,
      ignoredSourceHosts: ["cdn.example"],
      ignoredPageHosts: ["news.example"],
    });
  });

  it("does not invoke accessors or throw for a revoked stored object", async () => {
    const accessor = {};
    Object.defineProperty(accessor, "capturePackQualityMode", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    store.settings = accessor;
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    store.settings = proxy;
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });
});
