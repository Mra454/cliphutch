import { type CaptureJobEvent } from "./capture-executor";
import {
  isCaptureJobV1,
  type CaptureJobStateV1,
  type CaptureJobV1,
} from "./capture-pack-types";

export const CAPTURE_RECOVERY_SCHEMA_VERSION = 1 as const;
export const MAX_CAPTURE_RECOVERY_RECORDS = 200;

const MAX_ID_LENGTH = 256;
const MAX_DOWNLOAD_FILENAME_LENGTH = 4_096;
const MAX_RESULT_BASENAME_LENGTH = 140;
const SAFE_ATTEMPT_ID_PATTERN = /^[a-z0-9._:-]+$/i;

const TERMINAL_STATES = new Set<CaptureJobStateV1>([
  "complete",
  "failed",
  "cancelled",
  "save_state_unknown",
]);

type TerminalCaptureJobState = "complete" | "failed" | "cancelled" | "save_state_unknown";

export type ActiveOffscreenAttemptV1 = {
  jobId: string;
  attemptId: string;
};

export type ObservedChromeDownloadV1 = {
  downloadId: number;
  state: "in_progress" | "complete" | "interrupted" | "missing";
  filename?: string;
  fileSize?: number;
};

export type CaptureRecoveryInputV1 = {
  schemaVersion: typeof CAPTURE_RECOVERY_SCHEMA_VERSION;
  jobs: readonly CaptureJobV1[];
  activeOffscreenAttempts: readonly ActiveOffscreenAttemptV1[];
  downloads: readonly ObservedChromeDownloadV1[];
};

type AttemptScopedAction = {
  jobId: string;
  attemptId: string;
  expectedRevision: number;
};

export type CaptureOffscreenExecutor = "hls" | "dash" | "webm";

export type CaptureRecoveryAction = AttemptScopedAction &
  (
    | { type: "schedule"; state: "prepared" | "queued" }
    | { type: "reattach_offscreen"; executor: CaptureOffscreenExecutor }
    | { type: "cancel_offscreen"; executor: CaptureOffscreenExecutor }
    | { type: "cancel_download"; downloadId: number }
    | { type: "monitor_download"; downloadId: number }
    | { type: "apply_event"; event: CaptureJobEvent }
    | {
        type: "cleanup_terminal";
        terminalState: TerminalCaptureJobState;
        resourceClass: CaptureJobV1["resourceClass"];
      }
  );

export type CaptureRecoveryFailureReason =
  | "invalid_input"
  | "unsupported_schema"
  | "too_many_records"
  | "invalid_job"
  | "duplicate_job"
  | "invalid_active_attempt"
  | "duplicate_active_job"
  | "invalid_download_observation"
  | "duplicate_download_observation"
  | "download_observation_required"
  | "revision_exhausted";

export type CaptureRecoveryResult =
  | {
      ok: true;
      schemaVersion: typeof CAPTURE_RECOVERY_SCHEMA_VERSION;
      actions: CaptureRecoveryAction[];
    }
  | {
      ok: false;
      schemaVersion: typeof CAPTURE_RECOVERY_SCHEMA_VERSION;
      reason: CaptureRecoveryFailureReason;
      message: string;
      jobId?: string;
      downloadId?: number;
    };

type UnknownRecord = Record<string, unknown>;
type UnguardedEvent<T> = T extends CaptureJobEvent
  ? Omit<T, "attemptId" | "expectedRevision">
  : never;

function failure(
  reason: CaptureRecoveryFailureReason,
  message: string,
  detail: { jobId?: string; downloadId?: number } = {},
): CaptureRecoveryResult {
  return {
    ok: false,
    schemaVersion: CAPTURE_RECOVERY_SCHEMA_VERSION,
    reason,
    message,
    ...detail,
  };
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    return undefined;
  }
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ATTEMPT_ID_PATTERN.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateActiveAttempt(value: unknown): value is ActiveOffscreenAttemptV1 {
  const record = exactRecord(value, ["jobId", "attemptId"]);
  return Boolean(
    record &&
      isBoundedId(record.jobId) &&
      isBoundedId(record.attemptId),
  );
}

function validateDownloadObservation(value: unknown): value is ObservedChromeDownloadV1 {
  const record = exactRecord(value, ["downloadId", "state"], ["filename", "fileSize"]);
  if (
    !record ||
    !isSafeNonNegativeInteger(record.downloadId) ||
    (record.state !== "in_progress" &&
      record.state !== "complete" &&
      record.state !== "interrupted" &&
      record.state !== "missing") ||
    (record.filename !== undefined &&
      (typeof record.filename !== "string" ||
        record.filename.length > MAX_DOWNLOAD_FILENAME_LENGTH)) ||
    (record.fileSize !== undefined && !isSafeNonNegativeInteger(record.fileSize))
  ) {
    return false;
  }
  return record.state !== "missing" ||
    (record.filename === undefined && record.fileSize === undefined);
}

function offscreenExecutor(job: CaptureJobV1): CaptureOffscreenExecutor {
  if (job.snapshot.media.kind === "hls") return "hls";
  if (job.snapshot.media.kind === "dash") return "dash";
  return "webm";
}

function actionScope(job: CaptureJobV1, revisionOffset = 0): AttemptScopedAction {
  return {
    jobId: job.jobId,
    attemptId: job.attemptId,
    expectedRevision: job.revision + revisionOffset,
  };
}

function eventAction(
  job: CaptureJobV1,
  event: UnguardedEvent<CaptureJobEvent>,
  revisionOffset = 0,
): CaptureRecoveryAction {
  const scope = actionScope(job, revisionOffset);
  return {
    ...scope,
    type: "apply_event",
    event: {
      ...event,
      attemptId: scope.attemptId,
      expectedRevision: scope.expectedRevision,
    } as CaptureJobEvent,
  };
}

function terminalCleanupAction(
  job: CaptureJobV1,
  terminalState: TerminalCaptureJobState,
  revisionOffset = 0,
): CaptureRecoveryAction {
  return {
    ...actionScope(job, revisionOffset),
    type: "cleanup_terminal",
    terminalState,
    resourceClass: job.resourceClass,
  };
}

function transitionCapacityFailure(
  job: CaptureJobV1,
  transitionCount: number,
): CaptureRecoveryResult | undefined {
  if (job.revision <= Number.MAX_SAFE_INTEGER - transitionCount) return undefined;
  return failure(
    "revision_exhausted",
    "The capture job revision cannot safely advance during recovery.",
    { jobId: job.jobId },
  );
}

function safeActualBasename(filename: string | undefined): string | undefined {
  const basename = filename?.split(/[\\/]/).filter(Boolean).at(-1);
  if (
    !basename ||
    basename.length > MAX_RESULT_BASENAME_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(basename)
  ) {
    return undefined;
  }
  return basename;
}

function saveUnknownAction(
  job: CaptureJobV1,
  code: string,
  customerMessage: string,
): CaptureRecoveryAction {
  return eventAction(job, { type: "save-state-unknown", code, customerMessage });
}

function retryableFailureAction(
  job: CaptureJobV1,
  code: string,
  customerMessage: string,
): CaptureRecoveryAction {
  return eventAction(job, { type: "fail", code, customerMessage, retryable: true });
}

function completeAction(
  job: CaptureJobV1,
  observation: ObservedChromeDownloadV1,
  revisionOffset = 0,
): CaptureRecoveryAction {
  const actualBasename = safeActualBasename(observation.filename);
  return eventAction(
    job,
    {
      type: "complete",
      ...(actualBasename === undefined ? {} : { actualBasename }),
      ...(observation.fileSize === undefined ? {} : { sizeBytes: observation.fileSize }),
    },
    revisionOffset,
  );
}

function planKnownDownload(
  job: CaptureJobV1,
  observation: ObservedChromeDownloadV1,
): CaptureRecoveryResult | CaptureRecoveryAction[] {
  if (job.state === "delivery_pending") {
    if (observation.state === "interrupted") {
      const exhausted = transitionCapacityFailure(job, 1);
      if (exhausted) return exhausted;
      return [
        retryableFailureAction(
          job,
          "RECOVERY_SAVE_INTERRUPTED",
          "Chrome interrupted the file save. Retry this item.",
        ),
        terminalCleanupAction(job, "failed", 1),
      ];
    }
    if (observation.state === "missing") {
      const exhausted = transitionCapacityFailure(job, 1);
      if (exhausted) return exhausted;
      return [
        saveUnknownAction(
          job,
          "RECOVERY_DOWNLOAD_MISSING",
          "Chrome no longer reports this download. Check Downloads before trying again.",
        ),
        terminalCleanupAction(job, "save_state_unknown", 1),
      ];
    }

    const transitionCount = observation.state === "complete" ? 2 : 1;
    const exhausted = transitionCapacityFailure(job, transitionCount);
    if (exhausted) return exhausted;
    const saving = eventAction(job, { type: "saving", downloadId: observation.downloadId });
    if (observation.state === "complete") {
      return [
        saving,
        completeAction(job, observation, 1),
        terminalCleanupAction(job, "complete", 2),
      ];
    }
    return [
      saving,
      {
        ...actionScope(job, 1),
        type: "monitor_download",
        downloadId: observation.downloadId,
      },
    ];
  }

  const exhausted = observation.state === "in_progress"
    ? undefined
    : transitionCapacityFailure(job, 1);
  if (exhausted) return exhausted;
  if (observation.state === "complete") {
    return [completeAction(job, observation), terminalCleanupAction(job, "complete", 1)];
  }
  if (observation.state === "interrupted") {
    return [
      retryableFailureAction(
        job,
        "RECOVERY_SAVE_INTERRUPTED",
        "Chrome interrupted the file save. Retry this item.",
      ),
      terminalCleanupAction(job, "failed", 1),
    ];
  }
  if (observation.state === "missing") {
    return [
      saveUnknownAction(
        job,
        "RECOVERY_DOWNLOAD_MISSING",
        "Chrome no longer reports this download. Check Downloads before trying again.",
      ),
      terminalCleanupAction(job, "save_state_unknown", 1),
    ];
  }
  return [
    {
      ...actionScope(job),
      type: "monitor_download",
      downloadId: observation.downloadId,
    },
  ];
}

function planCancelling(
  job: CaptureJobV1,
  activeAttempt: ActiveOffscreenAttemptV1 | undefined,
  observation: ObservedChromeDownloadV1 | undefined,
): CaptureRecoveryResult | CaptureRecoveryAction[] {
  const actions: CaptureRecoveryAction[] = [];
  const exactOffscreenAttempt = job.resourceClass === "heavy" &&
    activeAttempt?.attemptId === job.attemptId;
  if (exactOffscreenAttempt) {
    actions.push({
      ...actionScope(job),
      type: "cancel_offscreen",
      executor: offscreenExecutor(job),
    });
  }

  if (job.downloadId === undefined) {
    const exhausted = transitionCapacityFailure(job, 1);
    if (exhausted) return exhausted;
    // `cancel_offscreen` is an exact, acknowledged side effect. Once it
    // succeeds there is no Chrome delivery to observe, so finish the same
    // recovery plan instead of leaving the job in `cancelling` until another
    // service-worker wake.
    actions.push(eventAction(job, { type: "cancelled" }));
    actions.push(terminalCleanupAction(job, "cancelled", 1));
    return actions;
  }
  if (!observation) {
    return failure(
      "download_observation_required",
      "Recovery requires an explicit Chrome state or missing observation for this download.",
      { jobId: job.jobId, downloadId: job.downloadId },
    );
  }
  if (observation.state === "in_progress") {
    actions.push({
      ...actionScope(job),
      type: "cancel_download",
      downloadId: job.downloadId,
    });
    return actions;
  }

  if (observation.state === "complete") {
    const exhausted = transitionCapacityFailure(job, 1);
    if (exhausted) return exhausted;
    actions.push(completeAction(job, observation));
    actions.push(terminalCleanupAction(job, "complete", 1));
  } else if (observation.state === "interrupted") {
    const exhausted = transitionCapacityFailure(job, 1);
    if (exhausted) return exhausted;
    // The executor cancellation (when present) is ordered before this state
    // transition, and Chrome already proves delivery is interrupted.
    actions.push(eventAction(job, { type: "cancelled" }));
    actions.push(terminalCleanupAction(job, "cancelled", 1));
  } else {
    const exhausted = transitionCapacityFailure(job, 1);
    if (exhausted) return exhausted;
    actions.push(
      saveUnknownAction(
        job,
        "RECOVERY_CANCEL_OUTCOME_UNKNOWN",
        "Chrome no longer reports the download, so its cancellation outcome is unknown.",
      ),
    );
    actions.push(terminalCleanupAction(job, "save_state_unknown", 1));
  }
  return actions;
}

function planJob(
  job: CaptureJobV1,
  activeAttempt: ActiveOffscreenAttemptV1 | undefined,
  downloads: ReadonlyMap<number, ObservedChromeDownloadV1>,
): CaptureRecoveryResult | CaptureRecoveryAction[] {
  if (TERMINAL_STATES.has(job.state)) {
    return [
      {
        ...actionScope(job),
        type: "cleanup_terminal",
        terminalState: job.state as TerminalCaptureJobState,
        resourceClass: job.resourceClass,
      },
    ];
  }
  if (job.state === "prepared" || job.state === "queued") {
    return [{ ...actionScope(job), type: "schedule", state: job.state }];
  }
  if (job.state === "starting" || job.state === "running" || job.state === "processing") {
    if (job.resourceClass === "heavy" && activeAttempt?.attemptId === job.attemptId) {
      return [
        {
          ...actionScope(job),
          type: "reattach_offscreen",
          executor: offscreenExecutor(job),
        },
      ];
    }
    const exhausted = transitionCapacityFailure(job, 1);
    if (exhausted) return exhausted;
    return [
      retryableFailureAction(
        job,
        job.resourceClass === "heavy"
          ? "RECOVERY_OFFSCREEN_ATTEMPT_MISSING"
          : "RECOVERY_NATIVE_START_UNCONFIRMED",
        job.resourceClass === "heavy"
          ? "ClipHutch could not reconnect to local media processing. Retry this item."
          : "ClipHutch restarted before it confirmed the file save. Retry this item.",
      ),
      terminalCleanupAction(job, "failed", 1),
    ];
  }
  if (job.state === "delivery_pending" && job.downloadId === undefined) {
    const exhausted = transitionCapacityFailure(job, 1);
    if (exhausted) return exhausted;
    return [
      saveUnknownAction(
        job,
        "RECOVERY_DOWNLOAD_ID_UNKNOWN",
        "Chrome may have accepted this save. Check Downloads before trying again.",
      ),
      terminalCleanupAction(job, "save_state_unknown", 1),
    ];
  }
  if (job.state === "saving" && job.downloadId === undefined) {
    const exhausted = transitionCapacityFailure(job, 1);
    if (exhausted) return exhausted;
    return [
      saveUnknownAction(
        job,
        "RECOVERY_DOWNLOAD_ID_MISSING",
        "The saved download identity is missing. Check Downloads before trying again.",
      ),
      terminalCleanupAction(job, "save_state_unknown", 1),
    ];
  }
  if (job.state === "delivery_pending" || job.state === "saving") {
    const downloadId = job.downloadId as number;
    const observation = downloads.get(downloadId);
    if (!observation) {
      return failure(
        "download_observation_required",
        "Recovery requires an explicit Chrome state or missing observation for this download.",
        { jobId: job.jobId, downloadId },
      );
    }
    return planKnownDownload(job, observation);
  }
  if (job.state === "cancelling") {
    return planCancelling(
      job,
      activeAttempt,
      job.downloadId === undefined ? undefined : downloads.get(job.downloadId),
    );
  }
  return failure("invalid_job", "The capture job has no supported recovery state.", {
    jobId: job.jobId,
  });
}

function planCaptureRecoveryUnsafe(input: CaptureRecoveryInputV1): CaptureRecoveryResult {
  const record = exactRecord(
    input,
    ["schemaVersion", "jobs", "activeOffscreenAttempts", "downloads"],
  );
  if (!record) {
    return failure("invalid_input", "The capture recovery input is malformed.");
  }
  if (record.schemaVersion !== CAPTURE_RECOVERY_SCHEMA_VERSION) {
    return failure("unsupported_schema", "The capture recovery schema is not supported.");
  }
  if (!Array.isArray(record.jobs) || !Array.isArray(record.activeOffscreenAttempts) ||
    !Array.isArray(record.downloads)) {
    return failure("invalid_input", "Capture recovery collections must be arrays.");
  }
  if (
    record.jobs.length > MAX_CAPTURE_RECOVERY_RECORDS ||
    record.activeOffscreenAttempts.length > MAX_CAPTURE_RECOVERY_RECORDS ||
    record.downloads.length > MAX_CAPTURE_RECOVERY_RECORDS
  ) {
    return failure(
      "too_many_records",
      `Capture recovery accepts at most ${MAX_CAPTURE_RECOVERY_RECORDS} records per collection.`,
    );
  }

  const jobs = record.jobs as unknown[];
  const seenJobIds = new Set<string>();
  const seenAttemptIds = new Set<string>();
  for (const candidate of jobs) {
    if (!isCaptureJobV1(candidate)) {
      return failure("invalid_job", "Capture recovery received an invalid job record.");
    }
    if (seenJobIds.has(candidate.jobId) || seenAttemptIds.has(candidate.attemptId)) {
      return failure("duplicate_job", "Capture recovery received a duplicate job or attempt.", {
        jobId: candidate.jobId,
      });
    }
    seenJobIds.add(candidate.jobId);
    seenAttemptIds.add(candidate.attemptId);
  }

  const activeByJobId = new Map<string, ActiveOffscreenAttemptV1>();
  for (const candidate of record.activeOffscreenAttempts as unknown[]) {
    if (!validateActiveAttempt(candidate)) {
      return failure("invalid_active_attempt", "An active offscreen attempt identity is invalid.");
    }
    if (activeByJobId.has(candidate.jobId)) {
      return failure(
        "duplicate_active_job",
        "More than one active offscreen attempt was reported for a job.",
        { jobId: candidate.jobId },
      );
    }
    activeByJobId.set(candidate.jobId, { ...candidate });
  }

  const downloads = new Map<number, ObservedChromeDownloadV1>();
  for (const candidate of record.downloads as unknown[]) {
    if (!validateDownloadObservation(candidate)) {
      return failure(
        "invalid_download_observation",
        "A Chrome download observation is invalid.",
      );
    }
    if (downloads.has(candidate.downloadId)) {
      return failure(
        "duplicate_download_observation",
        "A Chrome download was observed more than once.",
        { downloadId: candidate.downloadId },
      );
    }
    downloads.set(candidate.downloadId, { ...candidate });
  }

  const actions: CaptureRecoveryAction[] = [];
  for (const job of jobs as CaptureJobV1[]) {
    const planned = planJob(job, activeByJobId.get(job.jobId), downloads);
    if (!Array.isArray(planned)) return planned;
    actions.push(...planned);
  }
  return {
    ok: true,
    schemaVersion: CAPTURE_RECOVERY_SCHEMA_VERSION,
    actions,
  };
}

/**
 * Produces a deterministic recovery plan in job order. Callers must execute an
 * action sequence in order and stop that job's sequence if an attempt/revision
 * guard no longer matches. No Chrome API, storage, or offscreen effect occurs
 * in this module.
 */
export function planCaptureRecovery(input: CaptureRecoveryInputV1): CaptureRecoveryResult {
  try {
    return planCaptureRecoveryUnsafe(input);
  } catch {
    return failure("invalid_input", "The capture recovery input could not be safely inspected.");
  }
}
