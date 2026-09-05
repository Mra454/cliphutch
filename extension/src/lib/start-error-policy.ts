import { isCaptureExecutorErrorRetryable } from "./capture-error-policy";

const PERMANENT_IMMEDIATE_START_ERROR_CODES = new Set([
  "DIRECT_CREDENTIAL_REPLAY_REQUIRED",
  "MEDIA_UNSUPPORTED",
  "NATIVE_SOURCE_UNAVAILABLE",
  "NATIVE_SOURCE_CHANGED",
  "SOURCE_AUTH_FREEZE_FAILED",
]);

export function isImmediateStartErrorRetryable(code: unknown): boolean {
  if (typeof code !== "string") return true;
  if (code === "QUALITY_REQUIRED" || code === "RATE_LIMITED") return true;
  return isCaptureExecutorErrorRetryable(code) &&
    !PERMANENT_IMMEDIATE_START_ERROR_CODES.has(code);
}
