import { describe, expect, it } from "vitest";
import { isCaptureExecutorErrorRetryable } from "./capture-error-policy";

describe("Capture executor error retry policy", () => {
  it.each([
    "VARIANT_STALE",
    "UNSUPPORTED_TS_CODEC",
    "RAW_AAC_AUDIO",
    "UNSUPPORTED_MEDIA_SHAPE",
    "MIXED_CONTAINER_AUDIO",
    "BYTERANGE",
    "BYTERANGE_UNSUPPORTED",
    "BYTERANGE_OUT_OF_BOUNDS",
    "DRM_PROTECTED",
    "ENCRYPTED",
    "LIVE",
    "EMPTY",
    "SIZE_CAP",
  ])("does not blindly retry the exact immutable attempt after %s", (code) => {
    expect(isCaptureExecutorErrorRetryable(code)).toBe(false);
  });

  it.each(["NETWORK", "ACCESS_DENIED", "PARSE", "CONCURRENT_LIMIT"])(
    "allows a fresh attempt for transient %s failures",
    (code) => expect(isCaptureExecutorErrorRetryable(code)).toBe(true),
  );
});
