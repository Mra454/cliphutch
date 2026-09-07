/**
 * Executor failures for which replaying the same immutable attempt cannot
 * change the outcome. A customer may Review again or create a new choice, but
 * the Activity retry action must not blindly repeat these exact inputs.
 */
const PERMANENT_CAPTURE_EXECUTOR_ERROR_CODES = new Set([
  "BYTERANGE",
  "BYTERANGE_OUT_OF_BOUNDS",
  "BYTERANGE_UNSUPPORTED",
  "DRM_PROTECTED",
  "EMPTY",
  "ENCRYPTED",
  "LIVE",
  "MIXED_CONTAINER_AUDIO",
  "RAW_AAC_AUDIO",
  "SIZE_CAP",
  "SOURCE_AUTH_EXPIRED",
  "UNSUPPORTED_MEDIA_SHAPE",
  "UNSUPPORTED_TS_CODEC",
  "VARIANT_STALE",
  // Background/preflight failures use these normalized names.
  "UNSUPPORTED_CODEC",
  "UNSUPPORTED_CONTAINER",
  "UNSUPPORTED_MANIFEST",
]);

export function isCaptureExecutorErrorRetryable(code: unknown): boolean {
  return typeof code !== "string" ||
    !PERMANENT_CAPTURE_EXECUTOR_ERROR_CODES.has(code);
}
