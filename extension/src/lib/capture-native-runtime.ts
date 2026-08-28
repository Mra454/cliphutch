import type { CaptureJobV1 } from "./capture-pack-types";
import type {
  CaptureJobControlResult,
  UnguardedCaptureJobEvent,
} from "./capture-job-controller";

export type NativeDownloadState = "in_progress" | "complete" | "interrupted";

export type NativeDownloadObservation = {
  state: NativeDownloadState;
  actualBasename?: string;
  sizeBytes?: number;
};

export type CaptureNativeRuntimeDependencies = {
  applyEvent(input: {
    jobId: string;
    attemptId: string;
    event: UnguardedCaptureJobEvent;
  }): Promise<CaptureJobControlResult>;
  startDownload(options: {
    url: string;
    filename: string;
    conflictAction: "uniquify";
    saveAs: false;
  }): Promise<number>;
  cancelDownload(downloadId: number): Promise<void>;
  getDownloadObservation(downloadId: number): Promise<NativeDownloadObservation | undefined>;
};

export type CaptureNativeExecutionResult =
  | { ok: true; state: "saving" | "complete"; downloadId: number; job: CaptureJobV1 }
  | { ok: false; state: "not_started" | "failed" | "save_state_unknown"; detail: unknown };

function accepted(result: CaptureJobControlResult): result is Extract<
  CaptureJobControlResult,
  { ok: true }
> {
  return result.ok;
}

/**
 * Executes one already-claimed native job. The delivery intent is persisted
 * before the Downloads API side effect, and the accepted download ID is
 * persisted before the function reports success.
 */
export async function executeNativeCaptureJob(
  input: { jobId: string; attemptId: string },
  dependencies: CaptureNativeRuntimeDependencies,
): Promise<CaptureNativeExecutionResult> {
  const delivery = await dependencies.applyEvent({
    ...input,
    event: { type: "delivery-ready" },
  });
  if (!accepted(delivery)) return { ok: false, state: "not_started", detail: delivery };

  let downloadId: number;
  try {
    downloadId = await dependencies.startDownload({
      url: delivery.job.snapshot.media.url,
      filename: delivery.job.snapshot.plannedRelativePath,
      conflictAction: "uniquify",
      saveAs: false,
    });
    if (!Number.isSafeInteger(downloadId) || downloadId < 0) {
      throw new Error("Chrome did not return a valid download identifier.");
    }
  } catch (error) {
    const failed = await dependencies.applyEvent({
      ...input,
      event: {
        type: "fail",
        code: "NATIVE_START_FAILED",
        customerMessage: "Chrome could not start this file download.",
        retryable: true,
      },
    });
    return { ok: false, state: "failed", detail: failed.ok ? failed.job : error };
  }

  const saving = await dependencies.applyEvent({
    ...input,
    event: { type: "saving", downloadId },
  });
  if (!accepted(saving)) {
    await dependencies.cancelDownload(downloadId).catch(() => undefined);
    const unknown = await dependencies.applyEvent({
      ...input,
      event: {
        type: "save-state-unknown",
        code: "SAVE_STATE_UNKNOWN",
        customerMessage: "Chrome accepted a save, but ClipHutch could not confirm its state.",
      },
    });
    return { ok: false, state: "save_state_unknown", detail: unknown };
  }

  let observed: NativeDownloadObservation | undefined;
  try {
    observed = await dependencies.getDownloadObservation(downloadId);
  } catch {
    observed = undefined;
  }
  if (observed?.state === "complete") {
    const complete = await dependencies.applyEvent({
      ...input,
      event: {
        type: "complete",
        actualBasename: observed.actualBasename,
        sizeBytes: observed.sizeBytes,
      },
    });
    if (accepted(complete)) return { ok: true, state: "complete", downloadId, job: complete.job };
    return { ok: false, state: "save_state_unknown", detail: complete };
  }
  if (observed?.state === "interrupted") {
    const failed = await dependencies.applyEvent({
      ...input,
      event: {
        type: "fail",
        code: "SAVE_INTERRUPTED",
        customerMessage: "Chrome interrupted the file save.",
        retryable: true,
      },
    });
    return { ok: false, state: "failed", detail: failed };
  }
  return { ok: true, state: "saving", downloadId, job: saving.job };
}
