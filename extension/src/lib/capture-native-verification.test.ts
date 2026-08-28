import { describe, expect, it } from "vitest";
import { verifyCaptureNativeMedia } from "./capture-native-verification";

describe("verifyCaptureNativeMedia", () => {
  it("accepts an exact specific MIME and preserves bounded response metadata", () => {
    expect(verifyCaptureNativeMedia({
      kind: "direct",
      expectedContentType: "video/mp4; charset=binary",
      observedContentType: "VIDEO/MP4",
      observedSizeBytes: 42,
    })).toEqual({ status: "verified", contentType: "video/mp4", sizeBytes: 42 });
  });

  it("treats a specific subtype change as stale within the same broad class", () => {
    expect(verifyCaptureNativeMedia({
      kind: "direct",
      expectedContentType: "video/mp4",
      observedContentType: "video/webm",
    })).toEqual({
      status: "mismatch",
      expectedContentType: "video/mp4",
      observedContentType: "video/webm",
    });
    expect(verifyCaptureNativeMedia({
      kind: "image",
      expectedContentType: "image/png",
      observedContentType: "image/jpeg",
    }).status).toBe("mismatch");
  });

  it("rejects a response from the wrong media class", () => {
    expect(verifyCaptureNativeMedia({
      kind: "image",
      observedContentType: "video/mp4",
    }).status).toBe("mismatch");
    expect(verifyCaptureNativeMedia({
      kind: "direct",
      observedContentType: "text/html",
    }).status).toBe("mismatch");
  });

  it("keeps missing and generic response types explicitly unverified", () => {
    expect(verifyCaptureNativeMedia({
      kind: "direct",
      expectedContentType: "video/mp4",
      observedSizeBytes: 12,
    })).toEqual({ status: "unverified", reason: "missing_content_type", sizeBytes: 12 });
    expect(verifyCaptureNativeMedia({
      kind: "image",
      expectedContentType: "image/png",
      observedContentType: "application/octet-stream",
    })).toEqual({ status: "unverified", reason: "generic_content_type" });
  });

  it("can establish a specific type when the original detection was generic", () => {
    expect(verifyCaptureNativeMedia({
      kind: "image",
      expectedContentType: "application/octet-stream",
      observedContentType: "image/webp",
    })).toEqual({ status: "verified", contentType: "image/webp" });
  });

  it("canonicalizes safe MIME aliases before comparison", () => {
    expect(verifyCaptureNativeMedia({
      kind: "image",
      expectedContentType: "image/jpg",
      observedContentType: "image/jpeg",
    }).status).toBe("verified");
    expect(verifyCaptureNativeMedia({
      kind: "direct",
      expectedContentType: "video/x-m4v",
      observedContentType: "video/mp4",
    }).status).toBe("verified");
  });
});
