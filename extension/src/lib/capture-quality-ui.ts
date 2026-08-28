export type CaptureStreamEstimateConfidenceV1 = "exact" | "estimated" | "unknown";

function formatBytes(bytes: number): string {
  const kib = 1024;
  const mib = kib * 1024;
  const gib = mib * 1024;
  if (bytes >= gib) return `${(bytes / gib).toFixed(2)} GB`;
  if (bytes >= mib) return `${(bytes / mib).toFixed(1)} MB`;
  if (bytes >= kib) return `${(bytes / kib).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Customer-facing size truth for normalized HLS/DASH options and choices. */
export function captureStreamSizeCopy(
  estimatedBytes: number | undefined,
  confidence: CaptureStreamEstimateConfidenceV1,
): string {
  if (
    estimatedBytes === undefined ||
    !Number.isSafeInteger(estimatedBytes) ||
    estimatedBytes < 0 ||
    confidence === "unknown"
  ) {
    return "size unknown";
  }
  return `${confidence} ${formatBytes(estimatedBytes)}`;
}
