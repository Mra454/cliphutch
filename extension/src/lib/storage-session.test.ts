import { describe, it, expect, beforeEach } from "vitest";
import {
  addOrUpdateVideo,
  addOrUpdateVideos,
  clearTab,
  getDetectedVideos,
  getDetectionRetentionStats,
  retainDetectedVideosForPage,
} from "./storage-session";
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

  it("merges late dimensions, provenance, and observation timestamps", async () => {
    await addOrUpdateVideo(1, mk("https://a/v.mp4", {
      detectedAt: 100,
      firstSeenAt: 90,
      lastSeenAt: 100,
      width: 640,
      height: 360,
      provenance: ["rendered-image"],
      familyId: "family-1",
    }));
    const result = await addOrUpdateVideo(1, mk("https://a/v.mp4", {
      id: "late-id",
      detectedAt: 200,
      firstSeenAt: 80,
      lastSeenAt: 220,
      width: 1_920,
      height: 1_080,
      provenance: ["network", "picture"],
      familyId: "family-1",
    }));

    const [stored] = await getDetectedVideos(1);
    expect(result.action).toBe("updated");
    expect(result.mediaId).toBe(`id-https://a/v.mp4`);
    expect(stored).toMatchObject({
      id: `id-https://a/v.mp4`,
      detectedAt: 100,
      firstSeenAt: 80,
      lastSeenAt: 220,
      width: 1_920,
      height: 1_080,
      provenance: ["network", "rendered-image", "picture"],
      familyId: "family-1",
    });
  });

  it("merges normalized URL equivalents but preserves query token identity", async () => {
    const first = await addOrUpdateVideo(1, mk("https://a:443/v.mp4?token=one#first", {
      id: "stable-id",
    }));
    const merged = await addOrUpdateVideo(1, mk("https://A/v.mp4?token=one#second", {
      id: "later-id",
      sizeBytes: 20,
    }));
    await addOrUpdateVideo(1, mk("https://a/v.mp4?token=two", { id: "other-token" }));

    const list = await getDetectedVideos(1);
    expect(first.mediaId).toBe("stable-id");
    expect(merged.mediaId).toBe("stable-id");
    expect(list).toHaveLength(2);
    expect(list.find((item) => item.id === "stable-id")?.sizeBytes).toBe(20);
  });

  it("keeps exact media from distinct SPA page routes independent", async () => {
    await addOrUpdateVideo(1, mk("https://a/shared.mp4", {
      id: "route-one",
      pageUrl: "https://site.example/app#one",
    }));
    await addOrUpdateVideo(1, mk("https://a/shared.mp4", {
      id: "route-two",
      pageUrl: "https://site.example/app#two",
    }));

    expect((await getDetectedVideos(1)).map((item) => item.id)).toEqual([
      "route-one",
      "route-two",
    ]);
  });

  it("scopes the live tab shelf to the exact current SPA URL", async () => {
    await addOrUpdateVideos(1, [
      mk("https://a/one.mp4", { id: "one", pageUrl: "https://site.example/app#one" }),
      mk("https://a/two.mp4", { id: "two", pageUrl: "https://site.example/app#two" }),
      mk("https://a/unknown.mp4", { id: "unknown" }),
    ]);
    await retainDetectedVideosForPage(1, "https://site.example/app#two");

    expect((await getDetectedVideos(1)).map((item) => item.id)).toEqual(["two"]);
    expect(await getDetectionRetentionStats(1)).toMatchObject({
      retainedCount: 1,
      droppedCount: 0,
      evictedCount: 0,
      truncated: false,
    });
  });

  it("rejects late network and DOM batches from a previous SPA route", async () => {
    await retainDetectedVideosForPage(1, "https://site.example/app#new");
    const lateOne = await addOrUpdateVideo(1, mk("https://a/late.mp4", {
      id: "late-one",
      pageUrl: "https://site.example/app#old",
    }));
    const lateBatch = await addOrUpdateVideos(1, [mk("https://a/late.jpg", {
      id: "late-batch",
      kind: "image",
      pageUrl: "https://site.example/app#old",
    })]);
    await addOrUpdateVideo(1, mk("https://a/current.mp4", {
      id: "current",
      pageUrl: "https://site.example/app#new",
    }));

    expect(lateOne.action).toBe("ignored_stale_page");
    expect(lateBatch.ignoredStalePageCount).toBe(1);
    expect((await getDetectedVideos(1)).map((item) => item.id)).toEqual(["current"]);
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

  it("accounts for a large DOM snapshot in one bounded batch", async () => {
    const result = await addOrUpdateVideos(
      1,
      Array.from({ length: 600 }, (_, index) => mk(
        `https://a/image-${index}.jpg`,
        { kind: "image", id: `image-${index}` },
      )),
    );

    expect(await getDetectedVideos(1)).toHaveLength(50);
    expect(result).toMatchObject({
      addedCount: 50,
      droppedInBatchCount: 550,
      retainedCount: 50,
      droppedCount: 550,
      truncated: true,
    });
  });

  it("reports unique dropped identities without inflating on a repeated rescan", async () => {
    for (let i = 0; i < 50; i++) {
      await addOrUpdateVideo(1, mk(`https://a/v${i}.mp4`));
    }
    const dropped = mk("https://a/photo.jpg", { kind: "image" });
    const first = await addOrUpdateVideo(1, dropped);
    const repeated = await addOrUpdateVideo(1, dropped);

    expect(first.action).toBe("dropped");
    expect(repeated.action).toBe("dropped");
    expect(await getDetectionRetentionStats(1)).toEqual({
      limit: 50,
      retainedCount: 50,
      droppedCount: 1,
      evictedCount: 0,
      droppedCountIsLowerBound: false,
      evictedCountIsLowerBound: false,
      truncated: true,
    });
  });

  it("lets newly detected videos replace older images at the cap", async () => {
    await addOrUpdateVideo(1, mk("https://a/photo.jpg", { kind: "image" }));
    for (let i = 0; i < 49; i++) {
      await addOrUpdateVideo(1, mk(`https://a/v${i}.mp4`));
    }

    const result = await addOrUpdateVideo(1, mk("https://a/priority.mp4"));

    const list = await getDetectedVideos(1);
    expect(list.length).toBe(50);
    expect(list.some((v) => v.url === "https://a/photo.jpg")).toBe(false);
    expect(list.some((v) => v.url === "https://a/priority.mp4")).toBe(true);
    expect(result).toMatchObject({
      action: "added_after_eviction",
      retainedCount: 50,
      droppedCount: 0,
      evictedCount: 1,
      truncated: true,
    });
  });

  it("disambiguates the confirmed legacy 32-bit ID collision", async () => {
    const collidingId = "wwulu2";
    await addOrUpdateVideo(1, mk("https://cdn.example/media/1r.mp4", { id: collidingId }));
    const second = await addOrUpdateVideo(
      1,
      mk("https://cdn.example/media/30.mp4", { id: collidingId }),
    );

    const list = await getDetectedVideos(1);
    expect(list).toHaveLength(2);
    expect(new Set(list.map((item) => item.id)).size).toBe(2);
    expect(second.mediaId).toMatch(/^detected-v1-/);
  });

  it("rejects corrupt writes and filters corrupt stored records without invoking accessors", async () => {
    await expect(addOrUpdateVideo(1, mk("javascript:alert(1)"))).rejects.toThrow(/valid identity/i);
    let invoked = false;
    const accessor = { ...mk("https://a/secret.mp4") } as Record<string, unknown>;
    Object.defineProperty(accessor, "url", {
      enumerable: true,
      get() {
        invoked = true;
        return "https://a/secret.mp4";
      },
    });
    store["tab:1"] = [null, "bad", accessor, mk("https://a/good.mp4")];

    expect((await getDetectedVideos(1)).map((item) => item.url)).toEqual([
      "https://a/good.mp4",
    ]);
    expect(invoked).toBe(false);
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
    expect(await getDetectionRetentionStats(1)).toMatchObject({
      retainedCount: 0,
      droppedCount: 0,
      evictedCount: 0,
      truncated: false,
    });
  });

  it("only affects the specified tab", async () => {
    await addOrUpdateVideo(1, mk("https://a/v.mp4"));
    await addOrUpdateVideo(2, mk("https://a/v.mp4"));
    await clearTab(1);
    expect(await getDetectedVideos(1)).toEqual([]);
    expect(await getDetectedVideos(2)).toHaveLength(1);
  });
});

describe("addOrUpdateVideo — concurrency", () => {
  it("does not lose detections when many adds race on one tab", async () => {
    // Each get resolves on a microtask before any set runs, so without
    // serialization every concurrent add reads the same snapshot and all but
    // one are lost. Under the cap, all must survive.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => addOrUpdateVideo(1, mk(`https://a/v${i}.mp4`))),
    );
    const list = await getDetectedVideos(1);
    expect(list).toHaveLength(20);
    expect(new Set(list.map((v) => v.url)).size).toBe(20);
  });

  it("never retains more than the cap and counts unique concurrent drops", async () => {
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => addOrUpdateVideo(1, mk(`https://a/v${i}.mp4`))),
    );
    expect(await getDetectedVideos(1)).toHaveLength(50);
    expect(await getDetectionRetentionStats(1)).toMatchObject({
      retainedCount: 50,
      droppedCount: 10,
      evictedCount: 0,
      truncated: true,
    });
  });

  it("does not lose a concurrent add on a different tab", async () => {
    await Promise.all([
      addOrUpdateVideo(1, mk("https://a/x.mp4")),
      addOrUpdateVideo(2, mk("https://a/y.mp4")),
    ]);
    expect(await getDetectedVideos(1)).toHaveLength(1);
    expect(await getDetectedVideos(2)).toHaveLength(1);
  });
});

describe("getDetectedVideos", () => {
  it("returns [] for unknown tab", async () => {
    expect(await getDetectedVideos(999)).toEqual([]);
  });

  it("returns canonical empty retention stats for an unknown tab", async () => {
    expect(await getDetectionRetentionStats(999)).toEqual({
      limit: 50,
      retainedCount: 0,
      droppedCount: 0,
      evictedCount: 0,
      droppedCountIsLowerBound: false,
      evictedCountIsLowerBound: false,
      truncated: false,
    });
  });
});
