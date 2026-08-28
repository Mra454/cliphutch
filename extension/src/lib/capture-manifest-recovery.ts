import {
  DEFAULT_CAPTURE_MANIFEST_BLOB_MAX_ACTIVE,
  parseCaptureManifestBlobStatusResponse,
  type CaptureManifestBlobStatusEntry,
} from "./capture-manifest-blob";
import {
  cloneCaptureManifestRecord,
  isCaptureManifestRecordV1,
  type CaptureManifestOutputV1,
  type CaptureManifestRecordV1,
} from "./capture-manifest-delivery";
import { captureManifestDeliveryOrder } from "./capture-manifest-finalizer";
import type { CaptureManifestFormatV1 } from "./capture-pack-types";

export const CAPTURE_MANIFEST_RECOVERY_SCHEMA_VERSION = 1 as const;
export const MAX_CAPTURE_MANIFEST_RECOVERY_RECORDS = 30;
export const MAX_CAPTURE_MANIFEST_RECOVERY_DOWNLOADS =
  MAX_CAPTURE_MANIFEST_RECOVERY_RECORDS * 2;

export type CaptureManifestObservedDownloadV1 = {
  downloadId: number;
  /** `unknown` means the Chrome query failed; it is not equivalent to `missing`. */
  state: "in_progress" | "complete" | "interrupted" | "missing" | "unknown";
};

export type CaptureManifestOffscreenObservationV1 = {
  /** False when the offscreen context/status request could not be authoritatively observed. */
  known: boolean;
  active: readonly CaptureManifestBlobStatusEntry[];
};

export type CaptureManifestRecoveryInputV1 = {
  schemaVersion: typeof CAPTURE_MANIFEST_RECOVERY_SCHEMA_VERSION;
  /**
   * Orphan cleanup is safe only when this collection covers every retained
   * manifest record. A failed/partial storage enumeration must pass false.
   */
  recordsComplete: boolean;
  records: readonly CaptureManifestRecordV1[];
  offscreen: CaptureManifestOffscreenObservationV1;
  /** Exactly one observation for every saving output with a durable download ID. */
  downloads: readonly CaptureManifestObservedDownloadV1[];
};

type OutputScope = {
  runId: string;
  format: CaptureManifestFormatV1;
  attemptId: string;
  expectedRevision: number;
};

export type CaptureManifestRecoveryAction =
  | (OutputScope & {
      type: "complete_output";
      downloadId: number;
    })
  | (OutputScope & {
      type: "fail_output";
      errorCode: "MANIFEST_SAVE_FAILED" | "MANIFEST_SAVE_STATE_UNKNOWN";
      retryable: true;
    })
  | (OutputScope & {
      type: "monitor_download";
      downloadId: number;
    })
  | {
      /** Revoke ACK permanently retires this attempt ID in the offscreen registry. */
      type: "revoke_blob";
      runId: string;
      format: CaptureManifestFormatV1;
      attemptId: string;
      reason:
        | "saving_without_download_id"
        | "download_complete"
        | "download_interrupted"
        | "download_missing"
        | "terminal_output"
        | "orphan";
    };

export type CaptureManifestAutomaticStartV1 = {
  runId: string;
  format: CaptureManifestFormatV1;
  expectedRevision: number;
};

export type CaptureManifestRecoveryBlocker =
  | { type: "manifest_records_unknown" }
  | { type: "offscreen_status_unknown" }
  | (OutputScope & {
      type: "download_state_unknown";
      downloadId: number;
    })
  | { type: "blob_capacity_limited"; deferredCount: number };

export type CaptureManifestRecoveryFailureReason =
  | "invalid_input"
  | "unsupported_schema"
  | "too_many_records"
  | "invalid_record"
  | "quick_manifest_forbidden"
  | "duplicate_run"
  | "duplicate_attempt"
  | "duplicate_download_owner"
  | "invalid_offscreen_observation"
  | "invalid_download_observation"
  | "duplicate_download_observation"
  | "download_observation_required"
  | "unowned_download_observation"
  | "invalid_output_sequence"
  | "revision_exhausted";

export type CaptureManifestRecoveryResult =
  | {
      ok: true;
      schemaVersion: typeof CAPTURE_MANIFEST_RECOVERY_SCHEMA_VERSION;
      actions: CaptureManifestRecoveryAction[];
      blockers: CaptureManifestRecoveryBlocker[];
      eligibleAutomaticStarts: CaptureManifestAutomaticStartV1[];
      /** Execute ordered mutations/cleanup, stop on failure, then read and plan again. */
      requiresReplan: boolean;
    }
  | {
      ok: false;
      schemaVersion: typeof CAPTURE_MANIFEST_RECOVERY_SCHEMA_VERSION;
      reason: CaptureManifestRecoveryFailureReason;
      message: string;
      runId?: string;
      format?: CaptureManifestFormatV1;
      downloadId?: number;
    };

type DataRecord = Record<string, unknown>;

function failure(
  reason: CaptureManifestRecoveryFailureReason,
  message: string,
  detail: {
    runId?: string;
    format?: CaptureManifestFormatV1;
    downloadId?: number;
  } = {},
): CaptureManifestRecoveryResult {
  return {
    ok: false,
    schemaVersion: CAPTURE_MANIFEST_RECOVERY_SCHEMA_VERSION,
    reason,
    message,
    ...detail,
  };
}

function exactRecord(value: unknown, keys: readonly string[]): DataRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const ownKeys = Reflect.ownKeys(value);
  const allowed = new Set(keys);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    keys.some((key) => !ownKeys.includes(key))
  ) {
    return undefined;
  }
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of ownKeys) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function denseArrayValues(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  if (value.length > maximum) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => typeof key !== "string") ||
    !keys.includes("length")
  ) {
    return undefined;
  }
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    values.push(descriptor.value);
  }
  return values;
}

function safeDownloadId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseDownloadObservation(value: unknown): CaptureManifestObservedDownloadV1 | undefined {
  const record = exactRecord(value, ["downloadId", "state"]);
  if (
    !record ||
    !safeDownloadId(record.downloadId) ||
    (record.state !== "in_progress" &&
      record.state !== "complete" &&
      record.state !== "interrupted" &&
      record.state !== "missing" &&
      record.state !== "unknown")
  ) {
    return undefined;
  }
  return { downloadId: record.downloadId, state: record.state };
}

function blobIdentity(runId: string, attemptId: string): string {
  return `${runId}\0${attemptId}`;
}

function outputScope(
  record: CaptureManifestRecordV1,
  output: Exclude<CaptureManifestOutputV1, { state: "pending" }>,
): OutputScope {
  return {
    runId: record.seed.runId,
    format: output.format,
    attemptId: output.attemptId,
    expectedRevision: output.revision,
  };
}

function invalidDeliverySequence(record: CaptureManifestRecordV1): boolean {
  if (!record.seed.formats.includes("csv")) return false;
  const json = record.outputs.json;
  const csv = record.outputs.csv;
  if (!json || !csv) return true;
  if (json.state === "pending") return false;
  // A saving/newer CSV may be an explicit customer retry after JSON settled;
  // timestamps cannot distinguish that legitimate command from first-pass
  // history. Only a never-attempted CSV proves automatic ordering was broken.
  return csv.state === "pending";
}

function nextPendingOutput(
  record: CaptureManifestRecordV1,
): CaptureManifestAutomaticStartV1 | undefined {
  if (record.finalizedAt === undefined) return undefined;
  for (const format of captureManifestDeliveryOrder(record.seed)) {
    const output = record.outputs[format];
    if (!output) return undefined;
    if (output.state === "saving") return undefined;
    if (output.state === "pending") {
      return {
        runId: record.seed.runId,
        format,
        expectedRevision: output.revision,
      };
    }
    // Failed output attempts require a new customer command and attempt ID;
    // recovery never replays them automatically.
  }
  return undefined;
}

function planCaptureManifestRecoveryUnsafe(
  input: CaptureManifestRecoveryInputV1,
): CaptureManifestRecoveryResult {
  const envelope = exactRecord(input, [
    "schemaVersion",
    "recordsComplete",
    "records",
    "offscreen",
    "downloads",
  ]);
  if (!envelope || typeof envelope.recordsComplete !== "boolean") {
    return failure("invalid_input", "The manifest recovery input is malformed.");
  }
  if (envelope.schemaVersion !== CAPTURE_MANIFEST_RECOVERY_SCHEMA_VERSION) {
    return failure("unsupported_schema", "The manifest recovery schema is not supported.");
  }

  if (
    (Array.isArray(envelope.records) &&
      envelope.records.length > MAX_CAPTURE_MANIFEST_RECOVERY_RECORDS) ||
    (Array.isArray(envelope.downloads) &&
      envelope.downloads.length > MAX_CAPTURE_MANIFEST_RECOVERY_DOWNLOADS)
  ) {
    return failure("too_many_records", "The manifest recovery input exceeds its record bound.");
  }
  const recordValues = denseArrayValues(
    envelope.records,
    MAX_CAPTURE_MANIFEST_RECOVERY_RECORDS,
  );
  const downloadValues = denseArrayValues(
    envelope.downloads,
    MAX_CAPTURE_MANIFEST_RECOVERY_DOWNLOADS,
  );
  if (!recordValues || !downloadValues) {
    return failure("invalid_input", "Manifest recovery collections must be dense plain arrays.");
  }

  const offscreen = exactRecord(envelope.offscreen, ["known", "active"]);
  if (!offscreen || typeof offscreen.known !== "boolean") {
    return failure(
      "invalid_offscreen_observation",
      "The offscreen manifest Blob observation is malformed.",
    );
  }
  if (
    Array.isArray(offscreen.active) &&
    offscreen.active.length > DEFAULT_CAPTURE_MANIFEST_BLOB_MAX_ACTIVE
  ) {
    return failure("too_many_records", "The offscreen Blob observation exceeds its active bound.");
  }
  const activeValues = denseArrayValues(
    offscreen.active,
    DEFAULT_CAPTURE_MANIFEST_BLOB_MAX_ACTIVE,
  );
  if (!activeValues || (!offscreen.known && activeValues.length !== 0)) {
    return failure(
      "invalid_offscreen_observation",
      "An unknown offscreen observation cannot assert active Blob identities.",
    );
  }
  const parsedStatus = parseCaptureManifestBlobStatusResponse({ ok: true, active: activeValues });
  if (!parsedStatus) {
    return failure(
      "invalid_offscreen_observation",
      "The offscreen manifest Blob status is invalid.",
    );
  }

  const records: CaptureManifestRecordV1[] = [];
  const seenRuns = new Set<string>();
  const seenAttempts = new Set<string>();
  const downloadOwners = new Map<number, { runId: string; format: CaptureManifestFormatV1 }>();
  const unresolvedDownloads = new Map<
    number,
    { record: CaptureManifestRecordV1; output: Extract<CaptureManifestOutputV1, { state: "saving" }> }
  >();
  for (const candidate of recordValues) {
    if (!isCaptureManifestRecordV1(candidate)) {
      return failure("invalid_record", "Manifest recovery received an invalid durable record.");
    }
    // Canonicalize after validation so later planning cannot observe a Proxy or
    // caller mutation that changes identity/state between validation and use.
    const record = cloneCaptureManifestRecord(candidate);
    if (!isCaptureManifestRecordV1(record)) {
      return failure("invalid_record", "Manifest recovery could not canonicalize a durable record.");
    }
    if (record.seed.planId.startsWith("capture-single-plan:")) {
      return failure(
        "quick_manifest_forbidden",
        "Quick Capture cannot own or deliver a Capture Pack manifest.",
        { runId: record.seed.runId },
      );
    }
    if (seenRuns.has(record.seed.runId)) {
      return failure("duplicate_run", "Manifest recovery received a duplicate run.", {
        runId: record.seed.runId,
      });
    }
    seenRuns.add(record.seed.runId);
    if (invalidDeliverySequence(record)) {
      return failure(
        "invalid_output_sequence",
        "The manifest outputs do not preserve CSV-before-JSON delivery order.",
        { runId: record.seed.runId },
      );
    }
    for (const format of captureManifestDeliveryOrder(record.seed)) {
      const output = record.outputs[format];
      if (!output || output.state === "pending") continue;
      const attemptKey = blobIdentity(record.seed.runId, output.attemptId);
      if (seenAttempts.has(attemptKey)) {
        return failure("duplicate_attempt", "A manifest Blob attempt has multiple output owners.", {
          runId: record.seed.runId,
          format,
        });
      }
      seenAttempts.add(attemptKey);
      if (output.downloadId !== undefined) {
        const existing = downloadOwners.get(output.downloadId);
        if (existing) {
          return failure(
            "duplicate_download_owner",
            "A Chrome download ID has multiple manifest output owners.",
            { runId: record.seed.runId, format, downloadId: output.downloadId },
          );
        }
        downloadOwners.set(output.downloadId, { runId: record.seed.runId, format });
        if (output.state === "saving") {
          unresolvedDownloads.set(output.downloadId, { record, output });
        }
      }
    }
    records.push(record);
  }

  const downloads = new Map<number, CaptureManifestObservedDownloadV1>();
  for (const candidate of downloadValues) {
    const observation = parseDownloadObservation(candidate);
    if (!observation) {
      return failure(
        "invalid_download_observation",
        "A Chrome manifest download observation is invalid.",
      );
    }
    if (downloads.has(observation.downloadId)) {
      return failure(
        "duplicate_download_observation",
        "A Chrome manifest download was observed more than once.",
        { downloadId: observation.downloadId },
      );
    }
    if (!unresolvedDownloads.has(observation.downloadId)) {
      return failure(
        "unowned_download_observation",
        "A Chrome observation does not belong to a saving manifest output.",
        { downloadId: observation.downloadId },
      );
    }
    downloads.set(observation.downloadId, observation);
  }
  for (const [downloadId, owner] of unresolvedDownloads) {
    if (!downloads.has(downloadId)) {
      return failure(
        "download_observation_required",
        "Every saving manifest download needs an explicit Chrome state observation.",
        {
          runId: owner.record.seed.runId,
          format: owner.output.format,
          downloadId,
        },
      );
    }
  }

  const actions: CaptureManifestRecoveryAction[] = [];
  const blockers: CaptureManifestRecoveryBlocker[] = [];
  if (!envelope.recordsComplete) blockers.push({ type: "manifest_records_unknown" });
  if (!offscreen.known) blockers.push({ type: "offscreen_status_unknown" });

  const activeByIdentity = new Map(
    parsedStatus.active.map((entry) => [blobIdentity(entry.runId, entry.attemptId), entry] as const),
  );
  const claimedActive = new Set<string>();
  const addExactRevoke = (
    record: CaptureManifestRecordV1,
    output: Exclude<CaptureManifestOutputV1, { state: "pending" }>,
    reason: Extract<CaptureManifestRecoveryAction, { type: "revoke_blob" }>["reason"],
  ): void => {
    const identity = blobIdentity(record.seed.runId, output.attemptId);
    const active = activeByIdentity.get(identity);
    if (!active || active.format !== output.format) return;
    claimedActive.add(identity);
    actions.push({
      type: "revoke_blob",
      runId: record.seed.runId,
      format: output.format,
      attemptId: output.attemptId,
      reason,
    });
  };

  for (const record of records) {
    for (const format of captureManifestDeliveryOrder(record.seed)) {
      const output = record.outputs[format];
      if (!output || output.state === "pending") continue;
      const scope = outputScope(record, output);
      const identity = blobIdentity(record.seed.runId, output.attemptId);
      const active = activeByIdentity.get(identity);
      const exactActive = active?.format === output.format;

      if (output.state === "complete" || output.state === "failed") {
        if (exactActive) addExactRevoke(record, output, "terminal_output");
        continue;
      }
      if (output.downloadId === undefined) {
        if (output.revision >= Number.MAX_SAFE_INTEGER) {
          return failure(
            "revision_exhausted",
            "A manifest output revision cannot safely advance during recovery.",
            { runId: record.seed.runId, format },
          );
        }
        actions.push({
          ...scope,
          type: "fail_output",
          errorCode: "MANIFEST_SAVE_STATE_UNKNOWN",
          retryable: true,
        });
        if (exactActive) addExactRevoke(record, output, "saving_without_download_id");
        continue;
      }

      const observation = downloads.get(output.downloadId)!;
      if (observation.state === "in_progress") {
        if (exactActive) claimedActive.add(identity);
        actions.push({ ...scope, type: "monitor_download", downloadId: output.downloadId });
        continue;
      }
      if (observation.state === "unknown") {
        if (exactActive) claimedActive.add(identity);
        blockers.push({
          ...scope,
          type: "download_state_unknown",
          downloadId: output.downloadId,
        });
        continue;
      }
      if (output.revision >= Number.MAX_SAFE_INTEGER) {
        return failure(
          "revision_exhausted",
          "A manifest output revision cannot safely advance during recovery.",
          { runId: record.seed.runId, format, downloadId: output.downloadId },
        );
      }
      if (observation.state === "complete") {
        actions.push({ ...scope, type: "complete_output", downloadId: output.downloadId });
        if (exactActive) addExactRevoke(record, output, "download_complete");
        continue;
      }
      actions.push({
        ...scope,
        type: "fail_output",
        errorCode: observation.state === "missing"
          ? "MANIFEST_SAVE_STATE_UNKNOWN"
          : "MANIFEST_SAVE_FAILED",
        retryable: true,
      });
      if (exactActive) {
        addExactRevoke(
          record,
          output,
          observation.state === "missing" ? "download_missing" : "download_interrupted",
        );
      }
    }
  }

  if (envelope.recordsComplete && offscreen.known) {
    for (const active of parsedStatus.active) {
      const identity = blobIdentity(active.runId, active.attemptId);
      if (claimedActive.has(identity)) continue;
      actions.push({
        type: "revoke_blob",
        runId: active.runId,
        format: active.format,
        attemptId: active.attemptId,
        reason: "orphan",
      });
    }
  }

  const requiresReplan = actions.some(
    (action) => action.type !== "monitor_download",
  );
  const hasUnknownObservation = blockers.some(
    (blocker) => blocker.type === "manifest_records_unknown" ||
      blocker.type === "offscreen_status_unknown" ||
      blocker.type === "download_state_unknown",
  );
  const candidates = !requiresReplan && !hasUnknownObservation
    ? records.flatMap((record) => {
        const next = nextPendingOutput(record);
        return next ? [next] : [];
      })
    : [];
  const availableSlots = Math.max(
    0,
    DEFAULT_CAPTURE_MANIFEST_BLOB_MAX_ACTIVE - parsedStatus.active.length,
  );
  const eligibleAutomaticStarts = candidates.slice(0, availableSlots);
  const deferredCount = candidates.length - eligibleAutomaticStarts.length;
  if (deferredCount > 0) blockers.push({ type: "blob_capacity_limited", deferredCount });

  return {
    ok: true,
    schemaVersion: CAPTURE_MANIFEST_RECOVERY_SCHEMA_VERSION,
    actions,
    blockers,
    eligibleAutomaticStarts,
    requiresReplan,
  };
}

/**
 * Produces a deterministic, bounded plan without calling storage, Chrome, or
 * offscreen APIs. The caller must collect observations and execute the plan
 * under the background side-effect lock that excludes manifest starts and
 * terminal handlers; otherwise a newly-created Blob could resemble an orphan.
 * Execute actions in order and stop on any failed guard/ACK. Never reuse the
 * command/attempt ID from a revoke action because offscreen revoke tombstones it.
 * `eligibleAutomaticStarts` contains only never-attempted pending outputs; a
 * customer retry of a failed output must carry a fresh command/attempt ID.
 */
export function planCaptureManifestRecovery(
  input: CaptureManifestRecoveryInputV1,
): CaptureManifestRecoveryResult {
  try {
    return planCaptureManifestRecoveryUnsafe(input);
  } catch {
    return failure(
      "invalid_input",
      "The manifest recovery input could not be safely inspected.",
    );
  }
}
