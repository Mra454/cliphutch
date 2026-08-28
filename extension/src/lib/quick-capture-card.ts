import type {
  CaptureDraftV1,
  CaptureJobStateV1,
  CaptureJobV1,
  CaptureReviewPlanV1,
} from "./capture-pack-types";

export const CAPTURE_JOB_ID_PREFIX = "capture-job:v1:";

export type QuickCaptureCardMode =
  | "none"
  | "awaiting_workspace"
  | "active"
  | "complete"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export type QuickCaptureCardModel = {
  mode: QuickCaptureCardMode;
  job: CaptureJobV1 | null;
  locked: boolean;
  canCancel: boolean;
  canRetry: boolean;
  canStartAgain: boolean;
  statusLabel: string | null;
  progressPercent: number | null;
};

const ACTIVE_STATES = new Set<CaptureJobStateV1>([
  "prepared",
  "queued",
  "starting",
  "running",
  "processing",
  "delivery_pending",
  "saving",
]);

export function captureJobBlocksQuickStart(job: CaptureJobV1): boolean {
  return job.state !== "complete" && job.state !== "failed" && job.state !== "cancelled";
}

/**
 * Keeps an exact returned identity authoritative across UI unmounts, while
 * allowing a reopened popup to restore one unambiguous active Quick Capture.
 */
export function resolveQuickCaptureJobBinding(input: {
  returnedJobId: string | undefined;
  mediaIds: readonly string[];
  jobs: readonly CaptureJobV1[];
}): string | null | undefined {
  if (input.returnedJobId !== undefined) {
    const returnedJob = input.jobs.find((job) => job.jobId === input.returnedJobId);
    if (!returnedJob || captureJobBlocksQuickStart(returnedJob)) return input.returnedJobId;
  }

  const mediaIds = new Set(input.mediaIds);
  const activeQuickJobs = input.jobs.filter((job) =>
    job.itemId.startsWith("capture-single-item:") &&
    mediaIds.has(job.snapshot.media.mediaId) &&
    captureJobBlocksQuickStart(job)
  );
  if (activeQuickJobs.length > 1) return null;
  if (activeQuickJobs.length === 1) return activeQuickJobs[0].jobId;
  return input.returnedJobId;
}

const STATUS_LABELS: Record<CaptureJobStateV1, string> = {
  prepared: "Preparing",
  queued: "Queued",
  starting: "Starting",
  running: "Downloading",
  processing: "Processing",
  delivery_pending: "Preparing save",
  saving: "Saving",
  complete: "Saved",
  failed: "Failed",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  save_state_unknown: "Save state unknown",
};

function progressPercent(job: CaptureJobV1): number | null {
  const ratio = job.progress?.ratio;
  if (typeof ratio === "number" && Number.isFinite(ratio)) {
    return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  }
  const completed = job.progress?.completed;
  const total = job.progress?.total;
  if (
    typeof completed === "number" && Number.isFinite(completed) &&
    typeof total === "number" && Number.isFinite(total) && total > 0
  ) {
    return Math.round(Math.min(1, Math.max(0, completed / total)) * 100);
  }
  return null;
}

/**
 * Binds a toolbar Quick Capture acceptance to exactly one background-owned
 * CaptureJob. Missing or ambiguous workspace observations stay locked: absence
 * is not proof that an accepted start is safe to repeat.
 */
export function createQuickCaptureCardModel(
  acceptedJobId: string | null | undefined,
  jobs: readonly CaptureJobV1[],
): QuickCaptureCardModel {
  if (acceptedJobId === undefined) {
    return {
      mode: "none",
      job: null,
      locked: false,
      canCancel: false,
      canRetry: false,
      canStartAgain: false,
      statusLabel: null,
      progressPercent: null,
    };
  }
  if (
    acceptedJobId === null ||
    !acceptedJobId.startsWith(CAPTURE_JOB_ID_PREFIX) ||
    acceptedJobId.length === CAPTURE_JOB_ID_PREFIX.length
  ) {
    return {
      mode: "outcome_unknown",
      job: null,
      locked: true,
      canCancel: false,
      canRetry: false,
      canStartAgain: false,
      statusLabel: "Start state unknown",
      progressPercent: null,
    };
  }

  const matches = jobs.filter((job) => job.jobId === acceptedJobId);
  if (matches.length !== 1) {
    return {
      mode: "awaiting_workspace",
      job: null,
      locked: true,
      canCancel: false,
      canRetry: false,
      canStartAgain: false,
      statusLabel: "Queued · syncing Activity",
      progressPercent: null,
    };
  }

  const job = matches[0];
  const common = {
    job,
    statusLabel: STATUS_LABELS[job.state] ?? "Status unavailable",
    progressPercent: progressPercent(job),
  };
  if (ACTIVE_STATES.has(job.state)) {
    return {
      ...common,
      mode: "active",
      locked: true,
      canCancel: true,
      canRetry: false,
      canStartAgain: false,
    };
  }
  if (job.state === "cancelling") {
    return {
      ...common,
      mode: "active",
      locked: true,
      canCancel: false,
      canRetry: false,
      canStartAgain: false,
    };
  }
  if (job.state === "save_state_unknown") {
    return {
      ...common,
      mode: "outcome_unknown",
      locked: true,
      canCancel: false,
      canRetry: false,
      canStartAgain: false,
    };
  }
  if (job.state === "complete") {
    return {
      ...common,
      mode: "complete",
      locked: false,
      canCancel: false,
      canRetry: false,
      canStartAgain: true,
    };
  }
  if (job.state === "cancelled") {
    return {
      ...common,
      mode: "cancelled",
      locked: false,
      canCancel: false,
      canRetry: true,
      canStartAgain: false,
    };
  }
  if (job.state === "failed") {
    return {
      ...common,
      mode: "failed",
      locked: false,
      canCancel: false,
      canRetry: job.error?.retryable === true,
      canStartAgain: false,
    };
  }
  // `jobs` is parsed by the strict workspace client, but fail closed if a
  // future state reaches an older popup before its semantics are understood.
  return {
    ...common,
    mode: "outcome_unknown",
    locked: true,
    canCancel: false,
    canRetry: false,
    canStartAgain: false,
  };
}

/**
 * Reports whether this exact reviewed draft contains bounded temporary source
 * access. C2 snapshots make source-tab closure safe; this signal exists only
 * to explain the fixed 60-minute lease expiry before a run begins.
 */
export function captureReviewHasExpiringSourceAccess(
  plan: CaptureReviewPlanV1,
  draft: CaptureDraftV1 | null,
): boolean {
  const matchingDraft =
    draft?.draftId === plan.draftId && draft.revision === plan.draftRevision
      ? draft
      : null;
  return plan.items.some((item) => {
    if (!item.include) return false;
    const draftItem = matchingDraft?.items[item.itemId];
    return draftItem?.headerLeaseId !== undefined;
  });
}
