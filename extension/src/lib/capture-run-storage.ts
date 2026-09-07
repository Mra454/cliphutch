/**
 * Background-only session adapter for Capture Pack runs and jobs.
 *
 * UI surfaces must use background messages instead of importing these writers;
 * the in-memory locks serialize one service-worker realm, not multiple extension
 * documents.
 */
import {
  CAPTURE_PACK_SCHEMA_VERSION,
  MAX_CAPTURE_RUN_JOB_IDS,
  isCaptureJobV1,
  isPersistentStreamQualityChoiceV1,
  isCaptureRunV1,
  type CaptureJobV1,
  type CaptureRunStatusV1,
  type CaptureRunV1,
  type MediaSnapshotV1,
  type QualityChoiceV1,
  type QualityPolicyV1,
} from "./capture-pack-types";
import { LEGAL_CAPTURE_JOB_TRANSITIONS } from "./capture-executor";
import {
  cloneCaptureManifestRecord,
  createCaptureManifestRecord,
  type CaptureManifestRecordV1,
} from "./capture-manifest-delivery";
import {
  cloneCaptureManifestSeed,
  isCaptureManifestSeedV1,
  type CaptureManifestSeedV1,
} from "./capture-manifest-seed";
import {
  captureManifestRecordKey,
  parseStoredCaptureManifestRecord,
} from "./capture-manifest-storage";
import { withKeyLock } from "./session-jobs";

export const CAPTURE_RUNS_STORAGE_KEY = "capture-runs-v1";
export const CAPTURE_JOB_STORAGE_PREFIX = "capture-job-v1:";
export const CAPTURE_COMMANDS_STORAGE_KEY = "capture-batch-command-records-v1";
export const MAX_TERMINAL_CAPTURE_RUNS = 10;
export const MAX_CAPTURE_JOBS_PER_RUN = MAX_CAPTURE_RUN_JOB_IDS;
export const MAX_ACTIVE_CAPTURE_RUNS = 20;
export const MAX_ACTIVE_CAPTURE_JOBS = 1_000;
export const MAX_SETTLED_CAPTURE_COMMANDS = 200;
export const MAX_CAPTURE_RUN_GRAPH_BYTES = 1024 * 1024;
export const MAX_CAPTURE_RUN_INDEX_BYTES = 512 * 1024;
export const MAX_CAPTURE_COMMAND_INDEX_BYTES = 512 * 1024;
const MAX_STORAGE_ID_LENGTH = 256;

export type CaptureRunIndexV1 = {
  schemaVersion: typeof CAPTURE_PACK_SCHEMA_VERSION;
  orderedRunIds: string[];
  runs: Record<string, CaptureRunV1>;
};

export type CaptureCommandRecordV1 = {
  schemaVersion: typeof CAPTURE_PACK_SCHEMA_VERSION;
  commandId: string;
  runId: string;
  planId: string;
  draftId: string;
  draftRevision: number;
  planDigest: string;
  createdAt: number;
  state: "pending" | "settled";
  runStatus: CaptureRunStatusV1;
};

export type CaptureCommandIndexV1 = {
  schemaVersion: typeof CAPTURE_PACK_SCHEMA_VERSION;
  orderedCommandIds: string[];
  records: Record<string, CaptureCommandRecordV1>;
};

export type StoredCaptureValueResult<T> =
  | { status: "empty" }
  | { status: "valid"; value: T }
  | { status: "invalid"; reason: "corrupt" | "future_schema"; schemaVersion?: number };

export type CaptureRunStorageFailure =
  | {
      ok: false;
      reason: "invalid_input";
      message: string;
    }
  | {
      ok: false;
      reason: "storage_unavailable";
      operation: "get" | "set" | "remove";
      message: string;
      committed: boolean;
    }
  | {
      ok: false;
      reason: "storage_corrupt" | "storage_future_schema";
      key: string;
      schemaVersion?: number;
    }
  | {
      ok: false;
      reason: "conflict";
      conflict:
        | "run_exists"
        | "command_exists"
        | "job_exists"
        | "attempt_mismatch"
        | "revision_mismatch"
        | "run_status_mismatch";
      id: string;
      expectedAttemptId?: string;
      actualAttemptId?: string;
      expectedRevision?: number;
      actualRevision?: number;
      expectedStatus?: CaptureRunStatusV1;
      actualStatus?: CaptureRunStatusV1;
    };

export type CommitCaptureRunResult =
  | {
      ok: true;
      changed: boolean;
      run: CaptureRunV1;
      jobs: CaptureJobV1[];
      prunedRunIds: string[];
    }
  | CaptureRunStorageFailure;

export type ReadCaptureRunResult =
  | { ok: true; run: CaptureRunV1 | null }
  | CaptureRunStorageFailure;

export type ListCaptureRunsResult =
  | { ok: true; runs: CaptureRunV1[] }
  | CaptureRunStorageFailure;

export type ReadCaptureCommandResult =
  | { ok: true; record: CaptureCommandRecordV1 | null }
  | CaptureRunStorageFailure;

export type ListCaptureCommandsResult =
  | { ok: true; records: CaptureCommandRecordV1[] }
  | CaptureRunStorageFailure;

export type ReadCaptureJobResult =
  | { ok: true; job: CaptureJobV1 | null }
  | CaptureRunStorageFailure;

export type MutateCaptureJobResult =
  | { ok: true; changed: boolean; job: CaptureJobV1 }
  | CaptureRunStorageFailure;

export type UpdateCaptureRunResult =
  | { ok: true; changed: boolean; run: CaptureRunV1; prunedRunIds: string[] }
  | CaptureRunStorageFailure;

type UnknownRecord = Record<string, unknown>;

const TERMINAL_RUN_STATUSES = new Set<CaptureRunStatusV1>([
  "complete",
  "partial",
  "cancelled",
]);
const TERMINAL_JOB_STATES = new Set<CaptureJobV1["state"]>([
  "complete",
  "failed",
  "cancelled",
  "save_state_unknown",
]);

function captureJobKey(jobId: string): string {
  return `${CAPTURE_JOB_STORAGE_PREFIX}${jobId}`;
}

function isValidStorageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STORAGE_ID_LENGTH;
}

function indexedRun(index: CaptureRunIndexV1, runId: string): CaptureRunV1 | undefined {
  return Object.prototype.hasOwnProperty.call(index.runs, runId) ? index.runs[runId] : undefined;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function futureSchemaVersion(value: unknown): number | undefined {
  try {
    const record = asRecord(value);
    if (!record) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, "schemaVersion");
    const version = descriptor?.value;
    return typeof version === "number" && Number.isSafeInteger(version) && version > CAPTURE_PACK_SCHEMA_VERSION
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalQualityPolicy(policy: QualityPolicyV1): QualityPolicyV1 {
  if (policy.mode === "manual") return { mode: "manual" };
  const result: QualityPolicyV1 = {
    mode: "best_under_cap",
    maxEstimatedBytes: policy.maxEstimatedBytes,
  };
  if (policy.maxHeight !== undefined) result.maxHeight = policy.maxHeight;
  return result;
}

function canonicalQualityChoice(choice: QualityChoiceV1): QualityChoiceV1 {
  if (choice.mode === "direct") return { mode: "direct" };
  const extras = {
    ...(choice.label === undefined ? {} : { label: choice.label }),
    ...(choice.width === undefined ? {} : { width: choice.width }),
    ...(choice.height === undefined ? {} : { height: choice.height }),
    ...(choice.videoBandwidth === undefined ? {} : { videoBandwidth: choice.videoBandwidth }),
    ...(choice.audioBandwidth === undefined ? {} : { audioBandwidth: choice.audioBandwidth }),
    ...(choice.combinedBandwidth === undefined
      ? {}
      : { combinedBandwidth: choice.combinedBandwidth }),
    ...(choice.durationSec === undefined ? {} : { durationSec: choice.durationSec }),
    ...(choice.estimatedBytes === undefined ? {} : { estimatedBytes: choice.estimatedBytes }),
  };
  if (isPersistentStreamQualityChoiceV1(choice)) {
    return {
      mode: "stream",
      policy: canonicalQualityPolicy(choice.policy),
      selector: {
        kind: choice.selector.kind,
        stableId: choice.selector.stableId,
      },
      maxDownloadBytes: choice.maxDownloadBytes,
      estimateConfidence: choice.estimateConfidence,
      ...extras,
    };
  }
  if (choice.variantKind === "hls") {
    return {
      mode: "stream",
      policy: canonicalQualityPolicy(choice.policy),
      variantKind: "hls",
      variantUrl: choice.variantUrl,
      fixedVariantId: choice.variantUrl,
      estimateConfidence: choice.estimateConfidence,
      ...extras,
    };
  }
  if (choice.variantKind === "dash") {
    return {
      mode: "stream",
      policy: canonicalQualityPolicy(choice.policy),
      variantKind: "dash",
      representationId: choice.representationId,
      fixedVariantId: choice.representationId,
      estimateConfidence: choice.estimateConfidence,
      ...extras,
    };
  }
  return {
    mode: "stream",
    policy: canonicalQualityPolicy(choice.policy),
    fixedVariantId: choice.fixedVariantId,
    estimateConfidence: choice.estimateConfidence,
    ...extras,
  };
}

function canonicalMedia(media: MediaSnapshotV1): MediaSnapshotV1 {
  const result: MediaSnapshotV1 = {
    mediaId: media.mediaId,
    kind: media.kind,
    url: media.url,
    detectedAt: media.detectedAt,
    provenance: [...media.provenance],
  };
  if (media.firstSeenAt !== undefined) result.firstSeenAt = media.firstSeenAt;
  if (media.lastSeenAt !== undefined) result.lastSeenAt = media.lastSeenAt;
  if (media.pageUrl !== undefined) result.pageUrl = media.pageUrl;
  if (media.pageTitle !== undefined) result.pageTitle = media.pageTitle;
  if (media.contentType !== undefined) result.contentType = media.contentType;
  if (media.contentDisposition !== undefined) result.contentDisposition = media.contentDisposition;
  if (media.sizeBytes !== undefined) result.sizeBytes = media.sizeBytes;
  if (media.width !== undefined) result.width = media.width;
  if (media.height !== undefined) result.height = media.height;
  if (media.durationSec !== undefined) result.durationSec = media.durationSec;
  if (media.bitrate !== undefined) result.bitrate = media.bitrate;
  if (media.codecs !== undefined) result.codecs = media.codecs;
  if (media.familyId !== undefined) result.familyId = media.familyId;
  return result;
}

function canonicalRun(run: CaptureRunV1): CaptureRunV1 {
  const result: CaptureRunV1 = {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    runId: run.runId,
    planId: run.planId,
    draftId: run.draftId,
    draftRevision: run.draftRevision,
    planDigest: run.planDigest,
    commandId: run.commandId,
    createdAt: run.createdAt,
    status: run.status,
    orderedJobIds: [...run.orderedJobIds],
  };
  if (run.manifestDownloadIds !== undefined) {
    result.manifestDownloadIds = [...run.manifestDownloadIds];
  }
  return result;
}

function canonicalCommandRecord(record: CaptureCommandRecordV1): CaptureCommandRecordV1 {
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    commandId: record.commandId,
    runId: record.runId,
    planId: record.planId,
    draftId: record.draftId,
    draftRevision: record.draftRevision,
    planDigest: record.planDigest,
    createdAt: record.createdAt,
    state: record.state,
    runStatus: record.runStatus,
  };
}

function commandRecordForRun(run: CaptureRunV1): CaptureCommandRecordV1 {
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    commandId: run.commandId,
    runId: run.runId,
    planId: run.planId,
    draftId: run.draftId,
    draftRevision: run.draftRevision,
    planDigest: run.planDigest,
    createdAt: run.createdAt,
    state: isTerminalRun(run) ? "settled" : "pending",
    runStatus: run.status,
  };
}

function commandMatchesRun(record: CaptureCommandRecordV1, run: CaptureRunV1): boolean {
  return (
    record.commandId === run.commandId &&
    record.runId === run.runId &&
    record.planId === run.planId &&
    record.draftId === run.draftId &&
    record.draftRevision === run.draftRevision &&
    record.planDigest === run.planDigest &&
    record.createdAt === run.createdAt &&
    record.runStatus === run.status &&
    record.state === (isTerminalRun(run) ? "settled" : "pending")
  );
}

function canonicalJob(job: CaptureJobV1): CaptureJobV1 {
  const result: CaptureJobV1 = {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    jobId: job.jobId,
    runId: job.runId,
    itemId: job.itemId,
    attemptId: job.attemptId,
    attemptNo: job.attemptNo,
    revision: job.revision,
    resourceClass: job.resourceClass,
    state: job.state,
    snapshot: {
      media: canonicalMedia(job.snapshot.media),
      plannedRelativePath: job.snapshot.plannedRelativePath,
      quality: canonicalQualityChoice(job.snapshot.quality),
    },
  };
  if (job.snapshot.headerLeaseId !== undefined) {
    result.snapshot.headerLeaseId = job.snapshot.headerLeaseId;
  }
  if (job.progress !== undefined) {
    result.progress = { phase: job.progress.phase };
    if (job.progress.completed !== undefined) result.progress.completed = job.progress.completed;
    if (job.progress.total !== undefined) result.progress.total = job.progress.total;
    if (job.progress.bytes !== undefined) result.progress.bytes = job.progress.bytes;
    if (job.progress.ratio !== undefined) result.progress.ratio = job.progress.ratio;
  }
  if (job.quotaReservationId !== undefined) result.quotaReservationId = job.quotaReservationId;
  if (job.downloadId !== undefined) result.downloadId = job.downloadId;
  if (job.result !== undefined) {
    result.result = {};
    if (job.result.actualBasename !== undefined) result.result.actualBasename = job.result.actualBasename;
    if (job.result.sizeBytes !== undefined) result.result.sizeBytes = job.result.sizeBytes;
  }
  if (job.error !== undefined) {
    result.error = {
      code: job.error.code,
      customerMessage: job.error.customerMessage,
      retryable: job.error.retryable,
    };
  }
  return result;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function serializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return undefined;
  }
}

function emptyRunIndex(): CaptureRunIndexV1 {
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    orderedRunIds: [],
    runs: Object.fromEntries([]),
  };
}

function emptyCommandIndex(): CaptureCommandIndexV1 {
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    orderedCommandIds: [],
    records: Object.fromEntries([]),
  };
}

function isTerminalRun(run: CaptureRunV1): boolean {
  return TERMINAL_RUN_STATUSES.has(run.status);
}

async function validateTerminalRunGraph(
  run: CaptureRunV1,
): Promise<{ ok: true } | CaptureRunStorageFailure> {
  if (!isTerminalRun(run)) return { ok: true };
  const keys = run.orderedJobIds.map(captureJobKey);
  const stored = await getSession(keys);
  if (!stored.ok) return stored;
  const jobs: CaptureJobV1[] = [];
  for (const jobId of run.orderedJobIds) {
    const key = captureJobKey(jobId);
    const parsed = parseStoredCaptureJob(stored.values[key]);
    if (parsed.status === "invalid") return corruptFailure(key, parsed);
    if (parsed.status === "empty" || parsed.value.runId !== run.runId) {
      return { ok: false, reason: "storage_corrupt", key };
    }
    jobs.push(parsed.value);
  }
  if (jobs.length === 0 || jobs.some((job) => !TERMINAL_JOB_STATES.has(job.state))) {
    return invalidInput("A terminal Capture Run requires every owned job to be terminal.");
  }
  const derivedStatus: CaptureRunStatusV1 = jobs.every((job) => job.state === "complete")
    ? "complete"
    : jobs.every((job) => job.state === "cancelled")
      ? "cancelled"
      : "partial";
  return run.status === derivedStatus
    ? { ok: true }
    : invalidInput("Capture Run terminal status does not match its owned job outcomes.");
}

function sortedRunIds(runs: Record<string, CaptureRunV1>): string[] {
  return Object.values(runs)
    .sort((left, right) => right.createdAt - left.createdAt || left.runId.localeCompare(right.runId))
    .map((run) => run.runId);
}

function sortedCommandIds(records: Record<string, CaptureCommandRecordV1>): string[] {
  return Object.values(records)
    .sort((left, right) => right.createdAt - left.createdAt || left.commandId.localeCompare(right.commandId))
    .map((record) => record.commandId);
}

function compactCommandIndex(index: CaptureCommandIndexV1): CaptureCommandIndexV1 {
  const pending = Object.values(index.records).filter((record) => record.state === "pending");
  const settled = Object.values(index.records)
    .filter((record) => record.state === "settled")
    .sort((left, right) => right.createdAt - left.createdAt || left.commandId.localeCompare(right.commandId))
    .slice(0, MAX_SETTLED_CAPTURE_COMMANDS);
  const records = Object.fromEntries(
    [...pending, ...settled].map((record) => [record.commandId, canonicalCommandRecord(record)] as const),
  );
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    orderedCommandIds: sortedCommandIds(records),
    records,
  };
}

function isCaptureCommandRecordV1(value: unknown): value is CaptureCommandRecordV1 {
  try {
    const record = asRecord(value);
    return Boolean(
      record &&
        record.schemaVersion === CAPTURE_PACK_SCHEMA_VERSION &&
        isValidStorageId(record.commandId) &&
        isValidStorageId(record.runId) &&
        isValidStorageId(record.planId) &&
        isValidStorageId(record.draftId) &&
        Number.isSafeInteger(record.draftRevision) &&
        (record.draftRevision as number) >= 0 &&
        typeof record.planDigest === "string" &&
        /^[0-9a-f]{64}$/.test(record.planDigest) &&
        typeof record.createdAt === "number" &&
        Number.isFinite(record.createdAt) &&
        record.createdAt >= 0 &&
        (record.state === "pending" || record.state === "settled") &&
        (record.runStatus === "queued" ||
          record.runStatus === "running" ||
          record.runStatus === "complete" ||
          record.runStatus === "partial" ||
          record.runStatus === "cancelled") &&
        (record.state === "settled") === TERMINAL_RUN_STATUSES.has(record.runStatus as CaptureRunStatusV1),
    );
  } catch {
    return false;
  }
}

export function parseStoredCaptureCommandIndex(
  value: unknown,
): StoredCaptureValueResult<CaptureCommandIndexV1> {
  if (value === undefined) return { status: "empty" };
  try {
    const bytes = serializedBytes(value);
    if (bytes === undefined || bytes > MAX_CAPTURE_COMMAND_INDEX_BYTES) {
      return { status: "invalid", reason: "corrupt" };
    }
    const record = asRecord(value);
    if (!record) return { status: "invalid", reason: "corrupt" };
    if (record.schemaVersion !== CAPTURE_PACK_SCHEMA_VERSION) {
      const version = futureSchemaVersion(record);
      return version === undefined
        ? { status: "invalid", reason: "corrupt" }
        : { status: "invalid", reason: "future_schema", schemaVersion: version };
    }
    if (!Array.isArray(record.orderedCommandIds)) return { status: "invalid", reason: "corrupt" };
    if (record.orderedCommandIds.length > MAX_ACTIVE_CAPTURE_RUNS + MAX_SETTLED_CAPTURE_COMMANDS) {
      return { status: "invalid", reason: "corrupt" };
    }
    if (
      !record.orderedCommandIds.every(isValidStorageId) ||
      new Set(record.orderedCommandIds).size !== record.orderedCommandIds.length
    ) {
      return { status: "invalid", reason: "corrupt" };
    }
    const rawRecords = asRecord(record.records);
    if (!rawRecords || Object.keys(rawRecords).length !== record.orderedCommandIds.length) {
      return { status: "invalid", reason: "corrupt" };
    }
    const entries: Array<readonly [string, CaptureCommandRecordV1]> = [];
    const runIds = new Set<string>();
    let pendingCount = 0;
    let settledCount = 0;
    for (const commandId of record.orderedCommandIds) {
      if (!Object.prototype.hasOwnProperty.call(rawRecords, commandId)) {
        return { status: "invalid", reason: "corrupt" };
      }
      const rawRecord = rawRecords[commandId];
      if (!isCaptureCommandRecordV1(rawRecord) || rawRecord.commandId !== commandId) {
        return { status: "invalid", reason: "corrupt" };
      }
      if (runIds.has(rawRecord.runId)) return { status: "invalid", reason: "corrupt" };
      runIds.add(rawRecord.runId);
      if (rawRecord.state === "pending") pendingCount += 1;
      else settledCount += 1;
      entries.push([commandId, canonicalCommandRecord(rawRecord)] as const);
    }
    if (pendingCount > MAX_ACTIVE_CAPTURE_RUNS || settledCount > MAX_SETTLED_CAPTURE_COMMANDS) {
      return { status: "invalid", reason: "corrupt" };
    }
    const records = Object.fromEntries(entries);
    return {
      status: "valid",
      value: {
        schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
        orderedCommandIds: sortedCommandIds(records),
        records,
      },
    };
  } catch {
    return { status: "invalid", reason: "corrupt" };
  }
}

function compactRunIndex(
  index: CaptureRunIndexV1,
  protectedManifestRunIds: ReadonlySet<string> = new Set(),
): {
  index: CaptureRunIndexV1;
  prunedRuns: CaptureRunV1[];
} {
  const terminal = Object.values(index.runs)
    .filter(isTerminalRun)
    .sort((left, right) => right.createdAt - left.createdAt || left.runId.localeCompare(right.runId));
  const protectedTerminal = terminal.filter((run) => protectedManifestRunIds.has(run.runId));
  const settledTerminal = terminal.filter((run) => !protectedManifestRunIds.has(run.runId));
  const retainTerminalIds = new Set(
    [
      ...protectedTerminal,
      ...settledTerminal.slice(0, MAX_TERMINAL_CAPTURE_RUNS),
    ].map((run) => run.runId),
  );
  const prunedRuns = settledTerminal.slice(MAX_TERMINAL_CAPTURE_RUNS);
  const retainedEntries = Object.values(index.runs)
    .filter((run) => !isTerminalRun(run) || retainTerminalIds.has(run.runId))
    .map((run) => [run.runId, canonicalRun(run)] as const);
  const runs = Object.fromEntries(retainedEntries);
  return {
    index: {
      schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
      orderedRunIds: sortedRunIds(runs),
      runs,
    },
    prunedRuns,
  };
}

export function parseStoredCaptureRunIndex(
  value: unknown,
): StoredCaptureValueResult<CaptureRunIndexV1> {
  if (value === undefined) return { status: "empty" };
  try {
    const bytes = serializedBytes(value);
    if (bytes === undefined || bytes > MAX_CAPTURE_RUN_INDEX_BYTES) {
      return { status: "invalid", reason: "corrupt" };
    }
    const record = asRecord(value);
    if (!record) return { status: "invalid", reason: "corrupt" };
    if (record.schemaVersion !== CAPTURE_PACK_SCHEMA_VERSION) {
      const version = futureSchemaVersion(record);
      return version === undefined
        ? { status: "invalid", reason: "corrupt" }
        : { status: "invalid", reason: "future_schema", schemaVersion: version };
    }
    if (!Array.isArray(record.orderedRunIds)) {
      return { status: "invalid", reason: "corrupt" };
    }
    const orderedRunIds = record.orderedRunIds;
    if (orderedRunIds.length > MAX_ACTIVE_CAPTURE_RUNS + MAX_TERMINAL_CAPTURE_RUNS) {
      return { status: "invalid", reason: "corrupt" };
    }
    if (
      !orderedRunIds.every((runId) => typeof runId === "string" && runId.length > 0) ||
      new Set(orderedRunIds).size !== orderedRunIds.length
    ) {
      return { status: "invalid", reason: "corrupt" };
    }
    const rawRuns = asRecord(record.runs);
    if (!rawRuns || Object.keys(rawRuns).length !== orderedRunIds.length) {
      return { status: "invalid", reason: "corrupt" };
    }
    const runEntries: Array<readonly [string, CaptureRunV1]> = [];
    const ownedJobIds = new Set<string>();
    const commandIds = new Set<string>();
    let activeCount = 0;
    let activeJobCount = 0;
    let terminalCount = 0;
    for (const runId of orderedRunIds) {
      if (!Object.prototype.hasOwnProperty.call(rawRuns, runId)) {
        return { status: "invalid", reason: "corrupt" };
      }
      const rawRun = rawRuns[runId];
      if (!isCaptureRunV1(rawRun) || rawRun.runId !== runId) {
        return { status: "invalid", reason: "corrupt" };
      }
      if (rawRun.orderedJobIds.length > MAX_CAPTURE_JOBS_PER_RUN) {
        return { status: "invalid", reason: "corrupt" };
      }
      for (const jobId of rawRun.orderedJobIds) {
        if (ownedJobIds.has(jobId)) return { status: "invalid", reason: "corrupt" };
        ownedJobIds.add(jobId);
      }
      const run = canonicalRun(rawRun);
      if (commandIds.has(run.commandId)) return { status: "invalid", reason: "corrupt" };
      commandIds.add(run.commandId);
      if (isTerminalRun(run)) terminalCount += 1;
      else {
        activeCount += 1;
        activeJobCount += run.orderedJobIds.length;
      }
      runEntries.push([runId, run] as const);
    }
    if (
      // Separate manifest records can temporarily protect media-terminal runs
      // while an output is pending/saving. The parser cannot inspect those
      // records atomically, so enforce the existing total 30-run bound here;
      // writers apply the stricter active+protected admission rule.
      terminalCount > MAX_ACTIVE_CAPTURE_RUNS + MAX_TERMINAL_CAPTURE_RUNS ||
      activeCount > MAX_ACTIVE_CAPTURE_RUNS ||
      activeJobCount > MAX_ACTIVE_CAPTURE_JOBS
    ) {
      return { status: "invalid", reason: "corrupt" };
    }
    const runs = Object.fromEntries(runEntries);
    return {
      status: "valid",
      value: {
        schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
        orderedRunIds: sortedRunIds(runs),
        runs,
      },
    };
  } catch {
    return { status: "invalid", reason: "corrupt" };
  }
}

async function manifestRetentionActiveRunIds(
  runs: readonly CaptureRunV1[],
): Promise<{ ok: true; runIds: Set<string> } | CaptureRunStorageFailure> {
  const terminal = runs.filter(isTerminalRun);
  if (terminal.length === 0) return { ok: true, runIds: new Set() };
  const keys = terminal.map((run) => captureManifestRecordKey(run.runId));
  const stored = await getSession(keys);
  if (!stored.ok) return stored;
  const runIds = new Set<string>();
  for (const run of terminal) {
    const key = captureManifestRecordKey(run.runId);
    const parsed = parseStoredCaptureManifestRecord(stored.values[key]);
    if (parsed.status === "invalid") {
      return parsed.reason === "future_schema"
        ? {
            ok: false,
            reason: "storage_future_schema",
            key,
            schemaVersion: parsed.schemaVersion,
          }
        : { ok: false, reason: "storage_corrupt", key };
    }
    if (parsed.status === "empty") continue;
    if (parsed.record.seed.runId !== run.runId) {
      return { ok: false, reason: "storage_corrupt", key };
    }
    if (parsed.record.seed.formats.some((format) => {
      const state = parsed.record.outputs[format]?.state;
      return state === "pending" || state === "saving";
    })) {
      runIds.add(run.runId);
    }
  }
  return { ok: true, runIds };
}

export function parseStoredCaptureJob(value: unknown): StoredCaptureValueResult<CaptureJobV1> {
  if (value === undefined) return { status: "empty" };
  try {
    const bytes = serializedBytes(value);
    if (bytes === undefined || bytes > MAX_CAPTURE_RUN_GRAPH_BYTES) {
      return { status: "invalid", reason: "corrupt" };
    }
    if (!isCaptureJobV1(value)) {
      const version = futureSchemaVersion(value);
      return version === undefined
        ? { status: "invalid", reason: "corrupt" }
        : { status: "invalid", reason: "future_schema", schemaVersion: version };
    }
    return { status: "valid", value: canonicalJob(value) };
  } catch {
    return { status: "invalid", reason: "corrupt" };
  }
}

function invalidInput(message: string): CaptureRunStorageFailure {
  return { ok: false, reason: "invalid_input", message };
}

function storageFailure(
  operation: "get" | "set" | "remove",
  error: unknown,
  committed = false,
): CaptureRunStorageFailure {
  return {
    ok: false,
    reason: "storage_unavailable",
    operation,
    message: error instanceof Error ? error.message : "Chrome session storage is unavailable.",
    committed,
  };
}

function corruptFailure(
  key: string,
  parsed: Extract<StoredCaptureValueResult<unknown>, { status: "invalid" }>,
): CaptureRunStorageFailure {
  return parsed.reason === "future_schema"
    ? {
        ok: false,
        reason: "storage_future_schema",
        key,
        schemaVersion: parsed.schemaVersion,
      }
    : { ok: false, reason: "storage_corrupt", key };
}

async function getSession(keys: string | string[]): Promise<
  { ok: true; values: Record<string, unknown> } | CaptureRunStorageFailure
> {
  try {
    const values: Record<string, unknown> = await chrome.storage.session.get(keys);
    return { ok: true, values };
  } catch (error) {
    return storageFailure("get", error);
  }
}

async function setSession(values: Record<string, unknown>): Promise<
  { ok: true } | CaptureRunStorageFailure
> {
  try {
    await chrome.storage.session.set(values);
    return { ok: true };
  } catch (error) {
    return storageFailure("set", error);
  }
}

async function removeSession(keys: string[]): Promise<
  { ok: true } | CaptureRunStorageFailure
> {
  if (keys.length === 0) return { ok: true };
  try {
    await chrome.storage.session.remove(keys);
    return { ok: true };
  } catch (error) {
    return storageFailure("remove", error, true);
  }
}

async function readIndex(): Promise<
  { ok: true; index: CaptureRunIndexV1 } | CaptureRunStorageFailure
> {
  const stored = await getSession(CAPTURE_RUNS_STORAGE_KEY);
  if (!stored.ok) return stored;
  const parsed = parseStoredCaptureRunIndex(stored.values[CAPTURE_RUNS_STORAGE_KEY]);
  if (parsed.status === "invalid") return corruptFailure(CAPTURE_RUNS_STORAGE_KEY, parsed);
  return { ok: true, index: parsed.status === "empty" ? emptyRunIndex() : parsed.value };
}

async function readCommandIndex(): Promise<
  { ok: true; index: CaptureCommandIndexV1 } | CaptureRunStorageFailure
> {
  const stored = await getSession(CAPTURE_COMMANDS_STORAGE_KEY);
  if (!stored.ok) return stored;
  const parsed = parseStoredCaptureCommandIndex(stored.values[CAPTURE_COMMANDS_STORAGE_KEY]);
  if (parsed.status === "invalid") return corruptFailure(CAPTURE_COMMANDS_STORAGE_KEY, parsed);
  return { ok: true, index: parsed.status === "empty" ? emptyCommandIndex() : parsed.value };
}

async function readRunAndCommandIndexes(): Promise<
  { ok: true; runs: CaptureRunIndexV1; commands: CaptureCommandIndexV1 } | CaptureRunStorageFailure
> {
  const stored = await getSession([CAPTURE_RUNS_STORAGE_KEY, CAPTURE_COMMANDS_STORAGE_KEY]);
  if (!stored.ok) return stored;
  const parsedRuns = parseStoredCaptureRunIndex(stored.values[CAPTURE_RUNS_STORAGE_KEY]);
  if (parsedRuns.status === "invalid") return corruptFailure(CAPTURE_RUNS_STORAGE_KEY, parsedRuns);
  const parsedCommands = parseStoredCaptureCommandIndex(stored.values[CAPTURE_COMMANDS_STORAGE_KEY]);
  if (parsedCommands.status === "invalid") {
    return corruptFailure(CAPTURE_COMMANDS_STORAGE_KEY, parsedCommands);
  }
  const runs = parsedRuns.status === "empty" ? emptyRunIndex() : parsedRuns.value;
  const commands = parsedCommands.status === "empty" ? emptyCommandIndex() : parsedCommands.value;
  for (const runId of runs.orderedRunIds) {
    const run = runs.runs[runId];
    const command = Object.prototype.hasOwnProperty.call(commands.records, run.commandId)
      ? commands.records[run.commandId]
      : undefined;
    if (!command || !commandMatchesRun(command, run)) {
      return { ok: false, reason: "storage_corrupt", key: CAPTURE_COMMANDS_STORAGE_KEY };
    }
  }
  for (const commandId of commands.orderedCommandIds) {
    const command = commands.records[commandId];
    const run = indexedRun(runs, command.runId);
    if (command.state === "pending" && !run) {
      return { ok: false, reason: "storage_corrupt", key: CAPTURE_RUNS_STORAGE_KEY };
    }
    if (run && !commandMatchesRun(command, run)) {
      return { ok: false, reason: "storage_corrupt", key: CAPTURE_COMMANDS_STORAGE_KEY };
    }
  }
  return {
    ok: true,
    runs,
    commands,
  };
}

async function terminalOwnedJobKeys(prunedRuns: CaptureRunV1[]): Promise<
  { ok: true; keys: string[] } | CaptureRunStorageFailure
> {
  const candidates = prunedRuns.flatMap((run) => [
    ...run.orderedJobIds.map(captureJobKey),
    captureManifestRecordKey(run.runId),
  ]);
  if (candidates.length === 0) return { ok: true, keys: [] };
  const stored = await getSession(candidates);
  if (!stored.ok) return stored;
  const keys: string[] = [];
  for (const run of prunedRuns) {
    for (const jobId of run.orderedJobIds) {
      const key = captureJobKey(jobId);
      const parsed = parseStoredCaptureJob(stored.values[key]);
      if (
        parsed.status === "valid" &&
        parsed.value.runId === run.runId &&
        TERMINAL_JOB_STATES.has(parsed.value.state)
      ) {
        keys.push(key);
      }
    }
    // A manifest record has the same retention owner as its run. Removing an
    // absent key is harmless; retaining it after the run is pruned is not.
    keys.push(captureManifestRecordKey(run.runId));
  }
  return { ok: true, keys };
}

function initialGraph(
  rawRun: unknown,
  rawJobs: unknown[],
  rawManifestSeed?: CaptureManifestSeedV1 | null,
): {
  ok: true;
  run: CaptureRunV1;
  jobs: CaptureJobV1[];
  manifestRecord: CaptureManifestRecordV1 | null;
} | CaptureRunStorageFailure {
  if (!isCaptureRunV1(rawRun)) return invalidInput("Initial run does not satisfy CaptureRunV1.");
  const run = canonicalRun(rawRun);
  if (run.status !== "queued") return invalidInput("An initial Capture Run must be queued.");
  if (run.orderedJobIds.length > MAX_CAPTURE_JOBS_PER_RUN) {
    return invalidInput(`A Capture Run may contain at most ${MAX_CAPTURE_JOBS_PER_RUN} jobs.`);
  }
  if (!Array.isArray(rawJobs) || rawJobs.length !== run.orderedJobIds.length) {
    return invalidInput("Initial jobs must exactly match orderedJobIds.");
  }
  if (run.orderedJobIds.length === 0) {
    return invalidInput("An initial Capture Run must contain at least one job.");
  }
  const jobs: CaptureJobV1[] = [];
  const byId = new Map<string, CaptureJobV1>();
  const itemIds = new Set<string>();
  const quotaReservationIds = new Set<string>();
  for (const rawJob of rawJobs) {
    if (!isCaptureJobV1(rawJob)) return invalidInput("Initial job does not satisfy CaptureJobV1.");
    const job = canonicalJob(rawJob);
    if (job.state !== "prepared" || job.revision !== 0) {
      return invalidInput("Initial jobs must be prepared at revision 0.");
    }
    if (job.runId !== run.runId || byId.has(job.jobId) || itemIds.has(job.itemId)) {
      return invalidInput("Initial job ownership or identity is inconsistent.");
    }
    if (job.quotaReservationId !== undefined) {
      if (quotaReservationIds.has(job.quotaReservationId)) {
        return invalidInput("Initial jobs must own unique quota reservations.");
      }
      quotaReservationIds.add(job.quotaReservationId);
    }
    byId.set(job.jobId, job);
    itemIds.add(job.itemId);
  }
  for (const jobId of run.orderedJobIds) {
    const job = byId.get(jobId);
    if (!job) return invalidInput("Initial jobs must exactly match orderedJobIds.");
    jobs.push(job);
  }
  let manifestRecord: CaptureManifestRecordV1 | null = null;
  if (rawManifestSeed !== undefined && rawManifestSeed !== null) {
    if (!isCaptureManifestSeedV1(rawManifestSeed)) {
      return invalidInput("Initial manifest seed does not satisfy CaptureManifestSeedV1.");
    }
    const seed = cloneCaptureManifestSeed(rawManifestSeed);
    if (seed.runId !== run.runId || seed.planId !== run.planId) {
      return invalidInput("Initial manifest seed does not belong to this run and plan.");
    }
    const included = seed.items.filter((item) => item.included);
    if (
      included.length !== jobs.length ||
      included.some((item) => item.jobId === undefined) ||
      included.some((item) => {
        const job = jobs.find((candidate) => candidate.itemId === item.itemId);
        return !job || job.jobId !== item.jobId || job.snapshot.plannedRelativePath !== item.plannedPath;
      }) ||
      jobs.some((job) => !included.some((item) => item.itemId === job.itemId && item.jobId === job.jobId))
    ) {
      return invalidInput("Initial manifest seed does not exactly own the run jobs.");
    }
    manifestRecord = createCaptureManifestRecord(seed) ?? null;
    if (!manifestRecord) return invalidInput("Initial manifest output state is invalid.");
  }
  const graphBytes = serializedBytes({ run, jobs, manifestRecord });
  if (graphBytes === undefined || graphBytes > MAX_CAPTURE_RUN_GRAPH_BYTES) {
    return invalidInput(`A Capture Run graph may use at most ${MAX_CAPTURE_RUN_GRAPH_BYTES} serialized bytes.`);
  }
  return { ok: true, run, jobs, manifestRecord };
}

function immutableJobMatches(expected: CaptureJobV1, stored: CaptureJobV1): boolean {
  return (
    expected.jobId === stored.jobId &&
    expected.runId === stored.runId &&
    expected.itemId === stored.itemId &&
    expected.attemptId === stored.attemptId &&
    expected.attemptNo === stored.attemptNo &&
    expected.resourceClass === stored.resourceClass &&
    expected.quotaReservationId === stored.quotaReservationId &&
    valuesEqual(expected.snapshot, stored.snapshot)
  );
}

function runIdentityMatches(expected: CaptureRunV1, stored: CaptureRunV1): boolean {
  return (
    expected.runId === stored.runId &&
    expected.planId === stored.planId &&
    expected.draftId === stored.draftId &&
    expected.draftRevision === stored.draftRevision &&
    expected.planDigest === stored.planDigest &&
    expected.commandId === stored.commandId &&
    expected.createdAt === stored.createdAt &&
    valuesEqual(expected.orderedJobIds, stored.orderedJobIds)
  );
}

type CommitReadBack =
  | {
      status: "committed";
      run: CaptureRunV1;
      jobs: CaptureJobV1[];
      manifestRecord: CaptureManifestRecordV1 | null;
    }
  | { status: "absent" }
  | { status: "unknown" };

async function readBackInitialCommit(
  run: CaptureRunV1,
  jobs: CaptureJobV1[],
  manifestRecord: CaptureManifestRecordV1 | null,
): Promise<CommitReadBack> {
  const manifestKey = captureManifestRecordKey(run.runId);
  const keys = [
    CAPTURE_RUNS_STORAGE_KEY,
    CAPTURE_COMMANDS_STORAGE_KEY,
    manifestKey,
    ...jobs.map((job) => captureJobKey(job.jobId)),
  ];
  const stored = await getSession(keys);
  if (!stored.ok) return { status: "unknown" };
  const parsedRuns = parseStoredCaptureRunIndex(stored.values[CAPTURE_RUNS_STORAGE_KEY]);
  const parsedCommands = parseStoredCaptureCommandIndex(stored.values[CAPTURE_COMMANDS_STORAGE_KEY]);
  if (parsedRuns.status === "invalid" || parsedCommands.status === "invalid") {
    return { status: "unknown" };
  }
  const runIndex = parsedRuns.status === "empty" ? emptyRunIndex() : parsedRuns.value;
  const commandIndex = parsedCommands.status === "empty" ? emptyCommandIndex() : parsedCommands.value;
  const storedRun = indexedRun(runIndex, run.runId);
  const command = Object.prototype.hasOwnProperty.call(commandIndex.records, run.commandId)
    ? commandIndex.records[run.commandId]
    : undefined;
  const parsedJobs = jobs.map((job) => parseStoredCaptureJob(stored.values[captureJobKey(job.jobId)]));
  const parsedManifest = parseStoredCaptureManifestRecord(stored.values[manifestKey]);

  if (
    !storedRun && !command && parsedJobs.every((parsed) => parsed.status === "empty") &&
    parsedManifest.status === "empty"
  ) {
    return { status: "absent" };
  }
  if (
    !storedRun ||
    !command ||
    !runIdentityMatches(run, storedRun) ||
    !commandMatchesRun(command, storedRun) ||
    parsedJobs.some((parsed) => parsed.status !== "valid") ||
    (manifestRecord === null
      ? parsedManifest.status !== "empty"
      : parsedManifest.status !== "valid" || !valuesEqual(parsedManifest.record, manifestRecord))
  ) {
    return { status: "unknown" };
  }
  const committedJobs = parsedJobs.map((parsed) => (parsed.status === "valid" ? parsed.value : null));
  if (
    committedJobs.some((job) => job === null) ||
    committedJobs.some((job, index) => !job || !immutableJobMatches(jobs[index], job))
  ) {
    return { status: "unknown" };
  }
  return {
    status: "committed",
    run: storedRun,
    jobs: committedJobs as CaptureJobV1[],
    manifestRecord: parsedManifest.status === "valid"
      ? cloneCaptureManifestRecord(parsedManifest.record)
      : null,
  };
}

export async function commitInitialCaptureRun(
  run: CaptureRunV1,
  jobs: CaptureJobV1[],
  manifestSeed?: CaptureManifestSeedV1 | null,
): Promise<CommitCaptureRunResult> {
  const graph = initialGraph(run, jobs, manifestSeed);
  if (!graph.ok) return graph;

  return withKeyLock(CAPTURE_RUNS_STORAGE_KEY, async () => {
    const current = await readRunAndCommandIndexes();
    if (!current.ok) return current;

    const existingRun = indexedRun(current.runs, graph.run.runId);
    if (existingRun) {
      if (!runIdentityMatches(graph.run, existingRun)) {
        return {
          ok: false,
          reason: "conflict",
          conflict: "run_exists",
          id: graph.run.runId,
        };
      }
      const existingCommand = Object.prototype.hasOwnProperty.call(
        current.commands.records,
        graph.run.commandId,
      )
        ? current.commands.records[graph.run.commandId]
        : undefined;
      if (!existingCommand || !commandMatchesRun(existingCommand, existingRun)) {
        return { ok: false, reason: "storage_corrupt", key: CAPTURE_COMMANDS_STORAGE_KEY };
      }
      const manifestKey = captureManifestRecordKey(graph.run.runId);
      const storedJobs = await getSession([
        ...graph.jobs.map((job) => captureJobKey(job.jobId)),
        manifestKey,
      ]);
      if (!storedJobs.ok) return storedJobs;
      const replayJobs: CaptureJobV1[] = [];
      for (const expectedJob of graph.jobs) {
        const key = captureJobKey(expectedJob.jobId);
        const parsed = parseStoredCaptureJob(storedJobs.values[key]);
        if (parsed.status === "invalid") return corruptFailure(key, parsed);
        if (
          parsed.status === "empty" ||
          parsed.value.runId !== graph.run.runId ||
          !immutableJobMatches(expectedJob, parsed.value)
        ) {
          return { ok: false, reason: "storage_corrupt", key };
        }
        replayJobs.push(parsed.value);
      }
      const parsedManifest = parseStoredCaptureManifestRecord(storedJobs.values[manifestKey]);
      if (
        (graph.manifestRecord === null && parsedManifest.status !== "empty") ||
        (graph.manifestRecord !== null && (
          parsedManifest.status !== "valid" ||
          !valuesEqual(parsedManifest.record.seed, graph.manifestRecord.seed)
        ))
      ) {
        return { ok: false, reason: "storage_corrupt", key: manifestKey };
      }
      return {
        ok: true,
        changed: false,
        run: canonicalRun(existingRun),
        jobs: replayJobs,
        prunedRunIds: [],
      };
    }

    const commandOwner = Object.prototype.hasOwnProperty.call(current.commands.records, graph.run.commandId)
      ? current.commands.records[graph.run.commandId]
      : undefined;
    if (commandOwner) {
      return {
        ok: false,
        reason: "conflict",
        conflict: "command_exists",
        id: commandOwner.runId,
      };
    }

    const currentRuns = Object.values(current.runs.runs);
    const manifestRetention = await manifestRetentionActiveRunIds(currentRuns);
    if (!manifestRetention.ok) return manifestRetention;
    const activeRuns = currentRuns.filter((candidate) => !isTerminalRun(candidate));
    if (activeRuns.length + manifestRetention.runIds.size >= MAX_ACTIVE_CAPTURE_RUNS) {
      return invalidInput(`At most ${MAX_ACTIVE_CAPTURE_RUNS} Capture Runs may remain active.`);
    }
    const activeJobs = activeRuns.reduce((total, candidate) => total + candidate.orderedJobIds.length, 0);
    if (activeJobs + graph.jobs.length > MAX_ACTIVE_CAPTURE_JOBS) {
      return invalidInput(`At most ${MAX_ACTIVE_CAPTURE_JOBS} Capture Jobs may remain active.`);
    }

    const jobKeys = graph.jobs.map((job) => captureJobKey(job.jobId));
    const manifestKey = captureManifestRecordKey(graph.run.runId);
    const storedJobs = await getSession([...jobKeys, manifestKey]);
    if (!storedJobs.ok) return storedJobs;
    for (const key of jobKeys) {
      if (storedJobs.values[key] !== undefined) {
        const parsed = parseStoredCaptureJob(storedJobs.values[key]);
        if (parsed.status === "invalid") return corruptFailure(key, parsed);
        return { ok: false, reason: "conflict", conflict: "job_exists", id: key };
      }
    }
    if (storedJobs.values[manifestKey] !== undefined) {
      const parsed = parseStoredCaptureManifestRecord(storedJobs.values[manifestKey]);
      if (parsed.status === "invalid") {
        return parsed.reason === "future_schema"
          ? {
              ok: false,
              reason: "storage_future_schema",
              key: manifestKey,
              schemaVersion: parsed.schemaVersion,
            }
          : { ok: false, reason: "storage_corrupt", key: manifestKey };
      }
      return { ok: false, reason: "storage_corrupt", key: manifestKey };
    }

    const nextRuns = Object.fromEntries([
      ...current.runs.orderedRunIds.map((runId) => [runId, canonicalRun(current.runs.runs[runId])] as const),
      [graph.run.runId, graph.run] as const,
    ]);
    const compacted = compactRunIndex({
      schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
      orderedRunIds: sortedRunIds(nextRuns),
      runs: nextRuns,
    }, manifestRetention.runIds);
    const cleanup = await terminalOwnedJobKeys(compacted.prunedRuns);
    if (!cleanup.ok) return cleanup;

    const nextCommandRecords = Object.fromEntries([
      ...current.commands.orderedCommandIds.map((commandId) => [
        commandId,
        canonicalCommandRecord(current.commands.records[commandId]),
      ] as const),
      [graph.run.commandId, commandRecordForRun(graph.run)] as const,
    ]);
    const commands = compactCommandIndex({
      schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
      orderedCommandIds: sortedCommandIds(nextCommandRecords),
      records: nextCommandRecords,
    });
    const indexBytes = serializedBytes(compacted.index);
    const commandBytes = serializedBytes(commands);
    if (indexBytes === undefined || indexBytes > MAX_CAPTURE_RUN_INDEX_BYTES) {
      return invalidInput("The Capture Run index exceeds its serialized-byte limit.");
    }
    if (commandBytes === undefined || commandBytes > MAX_CAPTURE_COMMAND_INDEX_BYTES) {
      return invalidInput("The Capture command ledger exceeds its serialized-byte limit.");
    }

    const values: Record<string, unknown> = {
      [CAPTURE_RUNS_STORAGE_KEY]: compacted.index,
      [CAPTURE_COMMANDS_STORAGE_KEY]: commands,
    };
    for (const job of graph.jobs) values[captureJobKey(job.jobId)] = job;
    if (graph.manifestRecord !== null) values[manifestKey] = graph.manifestRecord;
    const written = await setSession(values);
    if (!written.ok) {
      const readBack = await readBackInitialCommit(graph.run, graph.jobs, graph.manifestRecord);
      if (readBack.status === "absent") return { ...written, committed: false };
      if (readBack.status === "unknown") return { ...written, committed: true };
      const removedAfterReadBack = await removeSession(cleanup.keys);
      if (!removedAfterReadBack.ok) return removedAfterReadBack;
      return {
        ok: true,
        changed: true,
        run: canonicalRun(readBack.run),
        jobs: readBack.jobs.map(canonicalJob),
        prunedRunIds: compacted.prunedRuns.map((candidate) => candidate.runId),
      };
    }
    const removed = await removeSession(cleanup.keys);
    if (!removed.ok) return removed;
    return {
      ok: true,
      changed: true,
      run: canonicalRun(graph.run),
      jobs: graph.jobs.map(canonicalJob),
      prunedRunIds: compacted.prunedRuns.map((candidate) => candidate.runId),
    };
  });
}

export async function getCaptureRun(runId: string): Promise<ReadCaptureRunResult> {
  if (!isValidStorageId(runId)) return invalidInput("runId must be a non-empty bounded identifier.");
  const current = await readIndex();
  if (!current.ok) return current;
  const run = indexedRun(current.index, runId);
  return { ok: true, run: run ? canonicalRun(run) : null };
}

export async function listCaptureRuns(): Promise<ListCaptureRunsResult> {
  const current = await readIndex();
  if (!current.ok) return current;
  return {
    ok: true,
    runs: current.index.orderedRunIds.map((runId) => canonicalRun(current.index.runs[runId])),
  };
}

export async function getCaptureCommandRecord(commandId: string): Promise<ReadCaptureCommandResult> {
  if (!isValidStorageId(commandId)) {
    return invalidInput("commandId must be a non-empty bounded identifier.");
  }
  const current = await readCommandIndex();
  if (!current.ok) return current;
  const record = Object.prototype.hasOwnProperty.call(current.index.records, commandId)
    ? current.index.records[commandId]
    : undefined;
  return { ok: true, record: record ? canonicalCommandRecord(record) : null };
}

/** Returns the redacted ledger, including settled commands whose UI runs were pruned. */
export async function listCaptureCommandRecords(): Promise<ListCaptureCommandsResult> {
  const current = await readCommandIndex();
  if (!current.ok) return current;
  return {
    ok: true,
    records: current.index.orderedCommandIds.map((commandId) =>
      canonicalCommandRecord(current.index.records[commandId])),
  };
}

export async function getCaptureJob(jobId: string): Promise<ReadCaptureJobResult> {
  if (!isValidStorageId(jobId)) return invalidInput("jobId must be a non-empty bounded identifier.");
  const key = captureJobKey(jobId);
  const stored = await getSession(key);
  if (!stored.ok) return stored;
  const parsed = parseStoredCaptureJob(stored.values[key]);
  if (parsed.status === "invalid") return corruptFailure(key, parsed);
  return { ok: true, job: parsed.status === "empty" ? null : parsed.value };
}

function progressDoesNotRegress(
  current: CaptureJobV1["progress"],
  candidate: CaptureJobV1["progress"],
): boolean {
  if (!current || !candidate || current.phase !== candidate.phase) return false;
  for (const field of ["completed", "total", "bytes", "ratio"] as const) {
    const before = current[field];
    const after = candidate[field];
    if (before !== undefined && (after === undefined || after < before)) return false;
  }
  return true;
}

function validPersistedJobTransition(current: CaptureJobV1, candidate: CaptureJobV1): boolean {
  if (candidate.state !== current.state) {
    return LEGAL_CAPTURE_JOB_TRANSITIONS[current.state].includes(candidate.state);
  }
  const currentWithoutProgress = canonicalJob(current);
  const candidateWithoutProgress = canonicalJob(candidate);
  currentWithoutProgress.revision = 0;
  candidateWithoutProgress.revision = 0;
  delete currentWithoutProgress.progress;
  delete candidateWithoutProgress.progress;
  return (
    !valuesEqual(current.progress, candidate.progress) &&
    valuesEqual(currentWithoutProgress, candidateWithoutProgress) &&
    progressDoesNotRegress(current.progress, candidate.progress)
  );
}

export async function mutateCaptureJob(input: {
  jobId: string;
  expectedAttemptId: string;
  expectedRevision: number;
  mutate: (current: CaptureJobV1) => unknown;
}): Promise<MutateCaptureJobResult> {
  if (
    !isValidStorageId(input.jobId) ||
    !isValidStorageId(input.expectedAttemptId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    typeof input.mutate !== "function"
  ) {
    return invalidInput("Capture Job mutation identifiers, revision, or callback are invalid.");
  }
  const key = captureJobKey(input.jobId);
  return withKeyLock(key, async () => {
      const stored = await getSession(key);
      if (!stored.ok) return stored;
      const parsed = parseStoredCaptureJob(stored.values[key]);
      if (parsed.status === "invalid") return corruptFailure(key, parsed);
      if (parsed.status === "empty") return { ok: false, reason: "storage_corrupt", key };
      const current = parsed.value;
      if (current.attemptId !== input.expectedAttemptId) {
        return {
          ok: false,
          reason: "conflict",
          conflict: "attempt_mismatch",
          id: input.jobId,
          expectedAttemptId: input.expectedAttemptId,
          actualAttemptId: current.attemptId,
        };
      }
      if (current.revision !== input.expectedRevision) {
        return {
          ok: false,
          reason: "conflict",
          conflict: "revision_mismatch",
          id: input.jobId,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        };
      }
      if (TERMINAL_JOB_STATES.has(current.state)) {
        return { ok: true, changed: false, job: canonicalJob(current) };
      }

      let rawCandidate: unknown;
      try {
        rawCandidate = input.mutate(canonicalJob(current));
      } catch {
        return invalidInput("Capture Job mutation threw an exception.");
      }
      if (!isCaptureJobV1(rawCandidate)) {
        return invalidInput("Capture Job mutation returned an invalid job.");
      }
      const candidate = canonicalJob(rawCandidate);
      if (
        candidate.jobId !== current.jobId ||
        candidate.runId !== current.runId ||
        candidate.itemId !== current.itemId ||
        candidate.attemptId !== current.attemptId ||
        candidate.attemptNo !== current.attemptNo ||
        candidate.resourceClass !== current.resourceClass ||
        candidate.quotaReservationId !== current.quotaReservationId ||
        !valuesEqual(candidate.snapshot, current.snapshot) ||
        candidate.revision !== current.revision + 1 ||
        !validPersistedJobTransition(current, candidate)
      ) {
        return invalidInput(
          "Capture Job mutation changed immutable fields, used an illegal transition, or did not advance revision once.",
        );
      }
      const written = await setSession({ [key]: candidate });
      if (!written.ok) return written;
      return { ok: true, changed: true, job: canonicalJob(candidate) };
  });
}

/**
 * One-way terminal metadata enrichment used before C5 freezes its normalized
 * source manifest. Terminal lifecycle state remains immutable: this adapter may
 * fill a previously unknown basename/size, but it never replaces a value that
 * was already observed or changes any execution identity/state.
 */
export async function enrichCompletedCaptureJobResult(input: {
  jobId: string;
  expectedAttemptId: string;
  expectedRevision: number;
  result: { actualBasename?: string; sizeBytes?: number };
}): Promise<MutateCaptureJobResult> {
  if (
    !isValidStorageId(input.jobId) ||
    !isValidStorageId(input.expectedAttemptId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.result === null ||
    typeof input.result !== "object" ||
    Array.isArray(input.result) ||
    Reflect.ownKeys(input.result).some(
      (key) => key !== "actualBasename" && key !== "sizeBytes",
    )
  ) {
    return invalidInput("Completed Capture Job result enrichment is invalid.");
  }
  const key = captureJobKey(input.jobId);
  return withKeyLock(key, async () => {
    const stored = await getSession(key);
    if (!stored.ok) return stored;
    const parsed = parseStoredCaptureJob(stored.values[key]);
    if (parsed.status === "invalid") return corruptFailure(key, parsed);
    if (parsed.status === "empty") return { ok: false, reason: "storage_corrupt", key };
    const current = parsed.value;
    if (current.attemptId !== input.expectedAttemptId) {
      return {
        ok: false,
        reason: "conflict",
        conflict: "attempt_mismatch",
        id: input.jobId,
        expectedAttemptId: input.expectedAttemptId,
        actualAttemptId: current.attemptId,
      };
    }
    if (current.revision !== input.expectedRevision) {
      return {
        ok: false,
        reason: "conflict",
        conflict: "revision_mismatch",
        id: input.jobId,
        expectedRevision: input.expectedRevision,
        actualRevision: current.revision,
      };
    }
    if (current.state !== "complete") {
      return invalidInput("Only a completed Capture Job can freeze a final download result.");
    }
    const candidate: CaptureJobV1 = {
      ...current,
      revision: current.revision + 1,
      result: {
        ...(current.result ?? {}),
        ...(current.result?.actualBasename !== undefined || input.result.actualBasename === undefined
          ? {}
          : { actualBasename: input.result.actualBasename }),
        ...(current.result?.sizeBytes !== undefined || input.result.sizeBytes === undefined
          ? {}
          : { sizeBytes: input.result.sizeBytes }),
      },
    };
    if (!isCaptureJobV1(candidate)) {
      return invalidInput("Completed Capture Job result enrichment is outside its safe bounds.");
    }
    if (valuesEqual(candidate.result, current.result)) {
      return { ok: true, changed: false, job: canonicalJob(current) };
    }
    const written = await setSession({ [key]: candidate });
    if (!written.ok) return written;
    return { ok: true, changed: true, job: canonicalJob(candidate) };
  });
}

const RUN_TRANSITIONS: Record<CaptureRunStatusV1, ReadonlySet<CaptureRunStatusV1>> = {
  queued: new Set(["queued", "running", "cancelled"]),
  running: new Set(["running", "complete", "partial", "cancelled"]),
  complete: new Set(["complete"]),
  partial: new Set(["partial"]),
  cancelled: new Set(["cancelled"]),
};

function manifestIdsOnlyAppend(current: CaptureRunV1, candidate: CaptureRunV1): boolean {
  const before = current.manifestDownloadIds ?? [];
  const after = candidate.manifestDownloadIds ?? [];
  return before.length <= after.length && before.every((downloadId, index) => after[index] === downloadId);
}

export async function updateCaptureRun(input: {
  runId: string;
  expectedStatus: CaptureRunStatusV1;
  update: (current: CaptureRunV1) => unknown;
}): Promise<UpdateCaptureRunResult> {
  if (!isValidStorageId(input.runId) || typeof input.update !== "function") {
    return invalidInput("Capture Run update identifier or callback is invalid.");
  }
  return withKeyLock(CAPTURE_RUNS_STORAGE_KEY, async () => {
    const current = await readRunAndCommandIndexes();
    if (!current.ok) return current;
    const existing = indexedRun(current.runs, input.runId);
    if (!existing) return { ok: false, reason: "storage_corrupt", key: CAPTURE_RUNS_STORAGE_KEY };
    if (existing.status !== input.expectedStatus) {
      return {
        ok: false,
        reason: "conflict",
        conflict: "run_status_mismatch",
        id: input.runId,
        expectedStatus: input.expectedStatus,
        actualStatus: existing.status,
      };
    }
    let rawCandidate: unknown;
    try {
      rawCandidate = input.update(canonicalRun(existing));
    } catch {
      return invalidInput("Capture Run update threw an exception.");
    }
    if (!isCaptureRunV1(rawCandidate)) return invalidInput("Capture Run update returned an invalid run.");
    const candidate = canonicalRun(rawCandidate);
    if (
      candidate.runId !== existing.runId ||
      candidate.planId !== existing.planId ||
      candidate.draftId !== existing.draftId ||
      candidate.draftRevision !== existing.draftRevision ||
      candidate.planDigest !== existing.planDigest ||
      candidate.commandId !== existing.commandId ||
      candidate.createdAt !== existing.createdAt ||
      !valuesEqual(candidate.orderedJobIds, existing.orderedJobIds) ||
      !manifestIdsOnlyAppend(existing, candidate) ||
      !RUN_TRANSITIONS[existing.status].has(candidate.status)
    ) {
      return invalidInput("Capture Run update changed immutable fields or used an invalid status transition.");
    }
    if (valuesEqual(candidate, existing)) {
      return { ok: true, changed: false, run: canonicalRun(existing), prunedRunIds: [] };
    }

    const terminalGraph = await validateTerminalRunGraph(candidate);
    if (!terminalGraph.ok) return terminalGraph;

    const runs = Object.fromEntries(
      current.runs.orderedRunIds.map((runId) => [
        runId,
        runId === candidate.runId ? candidate : canonicalRun(current.runs.runs[runId]),
      ]),
    );
    const manifestRetention = await manifestRetentionActiveRunIds(Object.values(runs));
    if (!manifestRetention.ok) return manifestRetention;
    const compacted = compactRunIndex({
      schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
      orderedRunIds: sortedRunIds(runs),
      runs,
    }, manifestRetention.runIds);
    const cleanup = await terminalOwnedJobKeys(compacted.prunedRuns);
    if (!cleanup.ok) return cleanup;
    const existingCommand = Object.prototype.hasOwnProperty.call(
      current.commands.records,
      candidate.commandId,
    )
      ? current.commands.records[candidate.commandId]
      : undefined;
    if (!existingCommand || !commandMatchesRun(existingCommand, existing)) {
      return { ok: false, reason: "storage_corrupt", key: CAPTURE_COMMANDS_STORAGE_KEY };
    }
    const commandRecords = Object.fromEntries(
      current.commands.orderedCommandIds.map((commandId) => [
        commandId,
        commandId === candidate.commandId
          ? commandRecordForRun(candidate)
          : canonicalCommandRecord(current.commands.records[commandId]),
      ]),
    );
    const commands = compactCommandIndex({
      schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
      orderedCommandIds: sortedCommandIds(commandRecords),
      records: commandRecords,
    });
    const indexBytes = serializedBytes(compacted.index);
    const commandBytes = serializedBytes(commands);
    if (indexBytes === undefined || indexBytes > MAX_CAPTURE_RUN_INDEX_BYTES) {
      return invalidInput("The Capture Run index exceeds its serialized-byte limit.");
    }
    if (commandBytes === undefined || commandBytes > MAX_CAPTURE_COMMAND_INDEX_BYTES) {
      return invalidInput("The Capture command ledger exceeds its serialized-byte limit.");
    }
    const written = await setSession({
      [CAPTURE_RUNS_STORAGE_KEY]: compacted.index,
      [CAPTURE_COMMANDS_STORAGE_KEY]: commands,
    });
    if (!written.ok) return written;
    const removed = await removeSession(cleanup.keys);
    if (!removed.ok) return removed;
    return {
      ok: true,
      changed: true,
      run: candidate,
      prunedRunIds: compacted.prunedRuns.map((run) => run.runId),
    };
  });
}
