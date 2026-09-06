import type { CaptureWorkspaceManifestOutputV1 } from "./capture-manifest-workspace";
import type { CaptureRunStatusV1 } from "./capture-pack-types";
import type { CaptureWorkspaceManifestV1 } from "./capture-manifest-workspace";

export type CaptureManifestOutputUiModel = {
  filename: string;
  statusLabel: string;
  detail: string;
  tone: "neutral" | "success" | "warning" | "error";
  actionLabel?: string;
};

const FAILURE_COPY: Record<
  Extract<CaptureWorkspaceManifestOutputV1, { state: "failed" }>["errorCode"],
  string
> = {
  MANIFEST_SERIALIZE_FAILED: "ClipHutch could not build this manifest.",
  MANIFEST_BLOB_FAILED: "ClipHutch could not prepare this manifest for saving.",
  MANIFEST_SAVE_FAILED: "Chrome could not save this manifest.",
  MANIFEST_SAVE_STATE_UNKNOWN:
    "Chrome may already have accepted this manifest. Check Downloads before retrying export.",
  MANIFEST_CANCELLED: "This manifest export was cancelled.",
  UNKNOWN: "This manifest could not be saved.",
};

export function captureManifestFilename(format: "json" | "csv"): string {
  return `_cliphutch-manifest.${format}`;
}

export function captureManifestRetryFailureMessage(reason: string): string {
  if (reason === "manifest_not_retryable") {
    return "This manifest cannot be exported again from the retained session record.";
  }
  if (reason === "manifest_not_found") {
    return "This manifest is no longer available in the current browsing session.";
  }
  if (reason === "manifest_retry_conflict") {
    return "Another export attempt already owns this manifest. Refresh Activity to see its state.";
  }
  return "ClipHutch could not export this manifest. Refresh Activity before trying again.";
}

export function capturePackActivityStatus(
  runStatus: CaptureRunStatusV1,
  manifest: CaptureWorkspaceManifestV1 | undefined,
): CaptureRunStatusV1 | "finalizing" {
  if (runStatus === "queued" || runStatus === "running" || !manifest) {
    return runStatus;
  }
  if (manifest.outputs.some((output) => output.state === "pending" || output.state === "saving")) {
    return "finalizing";
  }
  if (manifest.outputs.some((output) => output.state === "failed")) return "partial";
  return runStatus;
}

export function createCaptureManifestOutputUiModel(
  output: CaptureWorkspaceManifestOutputV1,
): CaptureManifestOutputUiModel {
  const filename = captureManifestFilename(output.format);
  if (output.state === "pending") {
    return {
      filename,
      statusLabel: "Waiting",
      detail: "ClipHutch will build this after every media item reaches a final state.",
      tone: "neutral",
    };
  }
  if (output.state === "saving") {
    return {
      filename,
      statusLabel: "Saving",
      detail: output.downloadId === undefined
        ? "Preparing the final local file."
        : "Chrome is saving the final local file.",
      tone: "neutral",
    };
  }
  if (output.state === "complete") {
    return {
      filename,
      statusLabel: "Saved",
      detail: "Chrome saved the local source manifest and may add a collision suffix to its name.",
      tone: "success",
    };
  }
  return {
    filename,
    statusLabel: output.errorCode === "MANIFEST_SAVE_STATE_UNKNOWN"
      ? "Checking save…"
      : "Not saved",
    detail: FAILURE_COPY[output.errorCode],
    tone: output.errorCode === "MANIFEST_SAVE_STATE_UNKNOWN" ? "warning" : "error",
    ...(output.retryable ? { actionLabel: "Retry export" } : {}),
  };
}
