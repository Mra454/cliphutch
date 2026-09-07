import { describe, expect, it } from "vitest";
import { parseDownloadRequest } from "./download-request-message";

const commandId = "download-123e4567-e89b-42d3-a456-426614174000";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "download",
    commandId,
    tabId: 1,
    videoId: "media-1",
    ...overrides,
  };
}

describe("parseDownloadRequest", () => {
  it("accepts an exact download request and normalizes customStem", () => {
    expect(parseDownloadRequest(request({
      variantId: "https://cdn.example/1080.m3u8",
      audioRenditionUrl: "https://cdn.example/audio.m3u8",
      variantLabel: "1080p",
      customStem: "Cafe\u0301 Reel",
      bypassSizeCap: true,
    }))).toEqual({
      type: "download",
      commandId,
      tabId: 1,
      videoId: "media-1",
      variantId: "https://cdn.example/1080.m3u8",
      audioRenditionUrl: "https://cdn.example/audio.m3u8",
      variantLabel: "1080p",
      customStem: "Café Reel",
      bypassSizeCap: true,
    });
  });

  it("fails closed on unknown fields", () => {
    expect(parseDownloadRequest(request({ extra: true }))).toBeUndefined();
  });

  it.each([
    ["commandId", "download-not-a-uuid"],
    ["tabId", "1"],
    ["videoId", "../media"],
    ["variantId", ""],
    ["audioRenditionUrl", "javascript:alert(1)"],
    ["variantLabel", "x".repeat(121)],
    ["bypassSizeCap", "true"],
  ])("fails closed on wrong %s", (key, value) => {
    expect(parseDownloadRequest(request({ [key]: value }))).toBeUndefined();
  });

  it.each([".profile", "title.", "title ", "x".repeat(141)])(
    "fails closed on invalid customStem %s",
    (customStem) => {
      expect(parseDownloadRequest(request({ customStem }))).toBeUndefined();
    },
  );

  it("fails closed on accessor-bearing records", () => {
    const hostile = request();
    Object.defineProperty(hostile, "videoId", {
      enumerable: true,
      get() {
        throw new Error("accessor should not run");
      },
    });
    expect(parseDownloadRequest(hostile)).toBeUndefined();
  });
});
