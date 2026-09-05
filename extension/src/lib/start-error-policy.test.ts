import { describe, expect, it } from "vitest";
import { isImmediateStartErrorRetryable } from "./start-error-policy";

describe("immediate start error retry policy", () => {
  it.each([
    "DIRECT_CREDENTIAL_REPLAY_REQUIRED",
    "MEDIA_UNSUPPORTED",
    "NATIVE_SOURCE_UNAVAILABLE",
    "NATIVE_SOURCE_CHANGED",
    "DRM_PROTECTED",
    "ENCRYPTED",
    "LIVE",
    "UNSUPPORTED_MEDIA_SHAPE",
    "UNSUPPORTED_TS_CODEC",
    "VARIANT_STALE",
    "SOURCE_AUTH_FREEZE_FAILED",
  ])("hides Retry for permanent immediate start error %s", (code) => {
    expect(isImmediateStartErrorRetryable(code)).toBe(false);
  });

  it.each([
    undefined,
    "QUALITY_REQUIRED",
    "RATE_LIMITED",
    "NETWORK",
    "ACCESS_DENIED",
    "CONCURRENT_LIMIT",
    "COMMAND_STATE_UNAVAILABLE",
  ])("keeps Retry available for %s", (code) => {
    expect(isImmediateStartErrorRetryable(code)).toBe(true);
  });
});
