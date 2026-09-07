import { describe, expect, it } from "vitest";
import type { DetectedVideo } from "../types";
import { sharedCleanTitleCountsByMediaId } from "./shared-title-counts";

function media(overrides: Partial<DetectedVideo> = {}): DetectedVideo {
  return {
    id: "media-1",
    url: "https://cdn.example/video.mp4",
    kind: "direct",
    detectedAt: 100,
    pageUrl: "https://site.example/gallery",
    pageTitle: "Gallery | Example",
    ...overrides,
  };
}

describe("sharedCleanTitleCountsByMediaId", () => {
  it("counts distinct video groups rather than alternate observations", () => {
    const counts = sharedCleanTitleCountsByMediaId([
      media({ id: "same-1", url: "https://cdn.example/same.mp4", detectedAt: 100 }),
      media({ id: "same-2", url: "https://CDN.EXAMPLE/same.mp4#fragment", detectedAt: 200 }),
    ]);

    expect(counts.get("same-1")).toBe(1);
    expect(counts.get("same-2")).toBe(1);
  });

  it("counts a cleaned title shared across different visible videos", () => {
    const counts = sharedCleanTitleCountsByMediaId([
      media({ id: "one", url: "https://cdn.example/one.mp4" }),
      media({ id: "two", url: "https://cdn.example/two.mp4" }),
    ]);

    expect(counts.get("one")).toBe(2);
    expect(counts.get("two")).toBe(2);
  });

  it("ignores stills and manifest-hidden child streams", () => {
    const counts = sharedCleanTitleCountsByMediaId([
      media({
        id: "master",
        kind: "hls",
        url: "https://cdn.example/master.m3u8",
        childUrls: ["https://cdn.example/1080.m3u8"],
      }),
      media({ id: "child", kind: "hls", url: "https://cdn.example/1080.m3u8" }),
      media({ id: "still", kind: "image", url: "https://cdn.example/poster.jpg" }),
    ]);

    expect(counts.get("master")).toBe(1);
    expect(counts.has("child")).toBe(false);
    expect(counts.has("still")).toBe(false);
  });
});
