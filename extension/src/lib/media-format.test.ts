import { describe, expect, it } from "vitest";
import { isStillImage, isWebmDirectVideo } from "./media-format";
import type { DetectedVideo } from "../types";

function video(partial: Partial<DetectedVideo>): DetectedVideo {
  return {
    id: "v",
    url: "https://example.com/video.mp4",
    kind: "direct",
    detectedAt: 1,
    ...partial,
  };
}

describe("isWebmDirectVideo", () => {
  it("matches direct WebM by extension", () => {
    expect(isWebmDirectVideo(video({ url: "https://example.com/video.webm" }))).toBe(true);
  });

  it("matches direct WebM by content type", () => {
    expect(isWebmDirectVideo(video({ url: "https://example.com/video", contentType: "video/webm; codecs=vp9" }))).toBe(true);
  });

  it("does not match MP4 direct video or HLS", () => {
    expect(isWebmDirectVideo(video({ url: "https://example.com/video.mp4" }))).toBe(false);
    expect(isWebmDirectVideo(video({ kind: "hls", url: "https://example.com/master.m3u8" }))).toBe(false);
  });
});

describe("isStillImage", () => {
  it("matches image media only", () => {
    expect(isStillImage(video({ kind: "image", url: "https://example.com/photo.jpg" }))).toBe(true);
    expect(isStillImage(video({ kind: "direct", url: "https://example.com/video.mp4" }))).toBe(false);
  });
});
