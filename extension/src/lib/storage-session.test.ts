import { describe, it, expect, beforeEach } from "vitest";
import { addOrUpdateVideo, clearTab, getDetectedVideos } from "./storage-session";
import type { DetectedVideo } from "../types";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get(keys: string | string[] | Record<string, unknown>) {
          const result: Record<string, unknown> = {};
          if (typeof keys === "string") {
            if (keys in store) result[keys] = store[keys];
          } else if (Array.isArray(keys)) {
            for (const k of keys) if (k in store) result[k] = store[k];
          } else if (keys && typeof keys === "object") {
            for (const k of Object.keys(keys)) {
              result[k] = k in store ? store[k] : (keys as Record<string, unknown>)[k];
            }
          }
          return Promise.resolve(result);
        },
        set(items: Record<string, unknown>) {
          Object.assign(store, items);
          return Promise.resolve();
        },
        remove(keys: string | string[]) {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete store[k];
          return Promise.resolve();
        },
      },
    },
  };
});

const mk = (url: string, partial: Partial<DetectedVideo> = {}): DetectedVideo => ({
  id: `id-${url}`,
  url,
  kind: "direct",
  detectedAt: 1,
  ...partial,
});

describe("addOrUpdateVideo", () => {
  it("adds a new entry", async () => {
    await addOrUpdateVideo(1, mk("https://a/v.mp4"));
    const list = await getDetectedVideos(1);
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe("https://a/v.mp4");
  });

  it("merges metadata when URL already exists", async () => {
    await addOrUpdateVideo(1, mk("https://a/v.mp4"));
    await addOrUpdateVideo(
      1,
      mk("https://a/v.mp4", {
        sizeBytes: 100,
        contentType: "video/mp4",
        contentDisposition: 'attachment; filename="x.mp4"',
      }),
    );
    const list = await getDetectedVideos(1);
    expect(list).toHaveLength(1);
    expect(list[0].sizeBytes).toBe(100);
    expect(list[0].contentType).toBe("video/mp4");
    expect(list[0].contentDisposition).toBe('attachment; filename="x.mp4"');
  });

  it("does not overwrite known metadata with undefined", async () => {
    await addOrUpdateVideo(1, mk("https://a/v.mp4", { sizeBytes: 100 }));
    await addOrUpdateVideo(1, mk("https://a/v.mp4"));
    const list = await getDetectedVideos(1);
    expect(list[0].sizeBytes).toBe(100);
  });

  it("respects MAX_VIDEOS_PER_TAB cap", async () => {
    for (let i = 0; i < 60; i++) {
      await addOrUpdateVideo(1, mk(`https://a/v${i}.mp4`));
    }
    const list = await getDetectedVideos(1);
    expect(list.length).toBe(50);
  });

  it("lets newly detected videos replace older images at the cap", async () => {
    await addOrUpdateVideo(1, mk("https://a/photo.jpg", { kind: "image" }));
    for (let i = 0; i < 49; i++) {
      await addOrUpdateVideo(1, mk(`https://a/v${i}.mp4`));
    }

    await addOrUpdateVideo(1, mk("https://a/priority.mp4"));

    const list = await getDetectedVideos(1);
    expect(list.length).toBe(50);
    expect(list.some((v) => v.url === "https://a/photo.jpg")).toBe(false);
    expect(list.some((v) => v.url === "https://a/priority.mp4")).toBe(true);
  });

  it("isolates tabs", async () => {
    await addOrUpdateVideo(1, mk("https://a/x.mp4"));
    await addOrUpdateVideo(2, mk("https://a/y.mp4"));
    expect((await getDetectedVideos(1))[0].url).toBe("https://a/x.mp4");
    expect((await getDetectedVideos(2))[0].url).toBe("https://a/y.mp4");
  });

  it("merges pageUrl/pageTitle as they arrive", async () => {
    await addOrUpdateVideo(1, mk("https://a/v.mp4"));
    await addOrUpdateVideo(1, mk("https://a/v.mp4", { pageTitle: "Cool video" }));
    const list = await getDetectedVideos(1);
    expect(list[0].pageTitle).toBe("Cool video");
  });
});

describe("clearTab", () => {
  it("removes all entries for the tab", async () => {
    await addOrUpdateVideo(1, mk("https://a/v.mp4"));
    await clearTab(1);
    expect(await getDetectedVideos(1)).toEqual([]);
  });

  it("only affects the specified tab", async () => {
    await addOrUpdateVideo(1, mk("https://a/v.mp4"));
    await addOrUpdateVideo(2, mk("https://a/v.mp4"));
    await clearTab(1);
    expect(await getDetectedVideos(1)).toEqual([]);
    expect(await getDetectedVideos(2)).toHaveLength(1);
  });
});

describe("getDetectedVideos", () => {
  it("returns [] for unknown tab", async () => {
    expect(await getDetectedVideos(999)).toEqual([]);
  });
});
