import { beforeEach, describe, expect, it } from "vitest";
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
});
