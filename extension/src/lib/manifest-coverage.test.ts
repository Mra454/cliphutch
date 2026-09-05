import { describe, expect, it } from "vitest";
import type { DetectedVideo } from "../types";
import {
  filterCoveredByManifests,
  manifestDirectoryPrefix,
  partitionCoveredByManifests,
} from "./manifest-coverage";

const v = (overrides: Partial<DetectedVideo> & Pick<DetectedVideo, "url" | "kind">): DetectedVideo => ({
  id: overrides.url,
  detectedAt: 0,
  ...overrides,
});

describe("manifestDirectoryPrefix", () => {
  it("returns origin + path up to last slash", () => {
    expect(manifestDirectoryPrefix("https://cdn.example.com/v/abc/playlist.m3u8")).toBe(
      "https://cdn.example.com/v/abc/",
    );
    expect(manifestDirectoryPrefix("https://cdn.example.com/manifest.mpd")).toBe(
      "https://cdn.example.com/",
    );
  });

  it("returns null on malformed URL", () => {
    expect(manifestDirectoryPrefix("not a url")).toBe(null);
  });
});

describe("filterCoveredByManifests", () => {
  it("returns all videos unchanged when no manifest is present", () => {
    const videos = [
      v({ url: "https://files.example.com/clip.mp4", kind: "direct" }),
      v({ url: "https://files.example.com/other.mp4", kind: "direct" }),
    ];
    expect(filterCoveredByManifests(videos)).toEqual(videos);
  });

  it("hides only high-confidence stream parts under a manifest directory", () => {
    const videos = [
      v({ url: "https://cdn.example.com/v/manifest.mpd", kind: "dash" }),
      v({ url: "https://cdn.example.com/v/seg-001.m4v", kind: "direct" }),
      v({ url: "https://cdn.example.com/v/init.m4v", kind: "direct" }),
      v({ url: "https://cdn.example.com/v/Track1.m4v", kind: "direct" }),
      v({ url: "https://cdn.example.com/elsewhere.mp4", kind: "direct" }),
    ];
    const filtered = filterCoveredByManifests(videos);
    expect(filtered).toHaveLength(4);
    expect(filtered.map((x) => x.url)).toEqual([
      "https://cdn.example.com/v/manifest.mpd",
      "https://cdn.example.com/v/seg-001.m4v",
      "https://cdn.example.com/v/Track1.m4v",
      "https://cdn.example.com/elsewhere.mp4",
    ]);
  });

  it("hides direct videos under any of multiple manifests on the page", () => {
    const videos = [
      v({ url: "https://a.example.com/x/master.m3u8", kind: "hls" }),
      v({ url: "https://b.example.com/y/manifest.mpd", kind: "dash" }),
      v({ url: "https://a.example.com/x/seg.ts", kind: "direct" }),
      v({ url: "https://b.example.com/y/video.m4s", kind: "direct" }),
      v({ url: "https://c.example.com/unrelated.mp4", kind: "direct" }),
    ];
    const filtered = filterCoveredByManifests(videos);
    expect(filtered.map((x) => x.url)).toEqual([
      "https://a.example.com/x/master.m3u8",
      "https://b.example.com/y/manifest.mpd",
      "https://c.example.com/unrelated.mp4",
    ]);
  });

  it("never hides manifest entries (they always stay visible)", () => {
    const videos = [
      v({ url: "https://cdn.example.com/master.mpd", kind: "dash" }),
      v({ url: "https://cdn.example.com/sub-master.m3u8", kind: "hls" }),
      v({ url: "https://cdn.example.com/clip.mp4", kind: "direct" }),
    ];
    const filtered = filterCoveredByManifests(videos);
    expect(filtered.map((x) => x.kind)).toEqual(["dash", "hls", "direct"]);
  });

  it("never treats an ordinary direct MP4 beside a root manifest as covered", () => {
    const videos = [
      v({ url: "https://cdn.example.com/master.m3u8", kind: "hls" }),
      v({ url: "https://cdn.example.com/clip.mp4", kind: "direct" }),
      v({ url: "https://cdn.example.com/chunk-1.m4s", kind: "direct" }),
    ];
    const partition = partitionCoveredByManifests(videos);
    expect(partition.visible.map((item) => item.url)).toEqual([
      "https://cdn.example.com/master.m3u8",
      "https://cdn.example.com/clip.mp4",
    ]);
    expect(partition.covered.map((item) => item.url)).toEqual([
      "https://cdn.example.com/chunk-1.m4s",
    ]);
  });

  it("preserves direct videos whose URL shares only the origin, not the directory", () => {
    const videos = [
      v({ url: "https://cdn.example.com/v/manifest.mpd", kind: "dash" }),
      v({ url: "https://cdn.example.com/other-dir/clip.mp4", kind: "direct" }),
    ];
    const filtered = filterCoveredByManifests(videos);
    expect(filtered.map((x) => x.url)).toEqual([
      "https://cdn.example.com/v/manifest.mpd",
      "https://cdn.example.com/other-dir/clip.mp4",
    ]);
  });

  it("hides HLS child playlists below a strict parent directory prefix", () => {
    const videos = [
      v({ url: "https://cdn.example.com/asset/playlist.m3u8", kind: "hls" }),
      v({ url: "https://cdn.example.com/asset/segments/video.m3u8", kind: "hls" }),
      v({ url: "https://cdn.example.com/asset/audio/en.m3u8", kind: "hls" }),
      v({ url: "https://cdn.example.com/asset/sibling.m3u8", kind: "hls" }),
    ];
    const partition = partitionCoveredByManifests(videos);
    expect(partition.visible.map((item) => item.url)).toEqual([
      "https://cdn.example.com/asset/playlist.m3u8",
      "https://cdn.example.com/asset/sibling.m3u8",
    ]);
    expect(partition.covered.map((item) => item.url)).toEqual([
      "https://cdn.example.com/asset/segments/video.m3u8",
      "https://cdn.example.com/asset/audio/en.m3u8",
    ]);
  });

  it("does not hide sibling-directory HLS videos from each other", () => {
    const videos = [
      v({ url: "https://cdn.example.com/video-a/master.m3u8", kind: "hls" }),
      v({ url: "https://cdn.example.com/video-b/master.m3u8", kind: "hls" }),
    ];
    expect(filterCoveredByManifests(videos).map((item) => item.url)).toEqual([
      "https://cdn.example.com/video-a/master.m3u8",
      "https://cdn.example.com/video-b/master.m3u8",
    ]);
  });

  it("hides exact listed HLS children even when they share the master directory", () => {
    const videos = [
      v({
        url: "https://cdn.example.com/asset/master.m3u8",
        kind: "hls",
        childUrls: [
          "https://cdn.example.com/asset/720p.m3u8",
          "https://cdn.example.com/asset/audio.m3u8",
        ],
      } as Partial<DetectedVideo> & Pick<DetectedVideo, "url" | "kind">),
      v({ url: "https://cdn.example.com/asset/720p.m3u8?token=secret", kind: "hls" }),
      v({ url: "https://cdn.example.com/asset/audio.m3u8?token=secret", kind: "hls" }),
    ];
    const partition = partitionCoveredByManifests(videos);
    expect(partition.visible.map((item) => item.url)).toEqual([
      "https://cdn.example.com/asset/master.m3u8",
    ]);
    expect(partition.covered.map((item) => item.url)).toEqual([
      "https://cdn.example.com/asset/720p.m3u8?token=secret",
      "https://cdn.example.com/asset/audio.m3u8?token=secret",
    ]);
  });

  it("never hides an HLS record that owns variants itself", () => {
    const videos = [
      v({
        url: "https://cdn.example.com/asset/master.m3u8",
        kind: "hls",
        childUrls: ["https://cdn.example.com/asset/nested/child.m3u8"],
      } as Partial<DetectedVideo> & Pick<DetectedVideo, "url" | "kind">),
      v({
        url: "https://cdn.example.com/asset/nested/child.m3u8",
        kind: "hls",
        childUrls: ["https://cdn.example.com/asset/nested/720p.m3u8"],
      } as Partial<DetectedVideo> & Pick<DetectedVideo, "url" | "kind">),
    ];
    expect(filterCoveredByManifests(videos).map((item) => item.url)).toEqual([
      "https://cdn.example.com/asset/master.m3u8",
      "https://cdn.example.com/asset/nested/child.m3u8",
    ]);
  });

  it("does not apply HLS child coverage rules to DASH records", () => {
    const videos = [
      v({
        url: "https://cdn.example.com/asset/manifest.mpd",
        kind: "dash",
        childUrls: ["https://cdn.example.com/asset/child.mpd"],
      } as Partial<DetectedVideo> & Pick<DetectedVideo, "url" | "kind">),
      v({ url: "https://cdn.example.com/asset/child.mpd", kind: "dash" }),
    ];
    expect(filterCoveredByManifests(videos).map((item) => item.url)).toEqual([
      "https://cdn.example.com/asset/manifest.mpd",
      "https://cdn.example.com/asset/child.mpd",
    ]);
  });
});
