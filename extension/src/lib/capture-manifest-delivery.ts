import { CAPTURE_PACK_SCHEMA_VERSION, type CaptureManifestFormatV1 } from "./capture-pack-types";
import {
  cloneCaptureManifestSeed,
  isCaptureManifestSeedV1,
  type CaptureManifestSeedV1,
} from "./capture-manifest-seed";
import {
  DEFAULT_AUTO_RECONCILE_STATE,
  normalizeAutoReconcileState,
  type AutoReconcileStateV1,
} from "./quick-capture-auto-reconcile";

export const MAX_CAPTURE_MANIFEST_RECORD_BYTES = 640 * 1024;
export const MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS = 32;
const MAX_ATTEMPT_ID_LENGTH = 256;
const UNSAFE_TEXT_PATTERN = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export type CaptureManifestPublicErrorCode =
  | "MANIFEST_SERIALIZE_FAILED"
  | "MANIFEST_BLOB_FAILED"
  | "MANIFEST_SAVE_FAILED"
  | "MANIFEST_SAVE_STATE_UNKNOWN"
  | "MANIFEST_CANCELLED"
  | "UNKNOWN";

const PUBLIC_ERROR_CODES = new Set<CaptureManifestPublicErrorCode>([
  "MANIFEST_SERIALIZE_FAILED",
  "MANIFEST_BLOB_FAILED",
  "MANIFEST_SAVE_FAILED",
  "MANIFEST_SAVE_STATE_UNKNOWN",
  "MANIFEST_CANCELLED",
  "UNKNOWN",
]);

type CaptureManifestOutputBaseV1 = {
  format: CaptureManifestFormatV1;
  revision: number;
  attemptNo: number;
  /**
   * Append-only for the lifetime of the retained run. Retaining every accepted
   * attempt identity makes an old popup/panel command permanently recognizable
   * instead of allowing it to start another Chrome save after a later retry.
   */
  attemptIds: string[];
  updatedAt: number;
} & Partial<AutoReconcileStateV1>;

export type CaptureManifestOutputV1 =
  | (CaptureManifestOutputBaseV1 & { state: "pending"; attemptNo: 0; revision: 0 })
  | (CaptureManifestOutputBaseV1 & {
      state: "saving";
      attemptId: string;
      downloadId?: number;
    })
  | (CaptureManifestOutputBaseV1 & {
      state: "complete";
      attemptId: string;
      downloadId: number;
    })
  | (CaptureManifestOutputBaseV1 & {
      state: "failed";
      attemptId: string;
      errorCode: CaptureManifestPublicErrorCode;
      retryable: boolean;
      downloadId?: number;
    });

export type CaptureManifestRecordV1 = {
  schemaVersion: typeof CAPTURE_PACK_SCHEMA_VERSION;
  seed: CaptureManifestSeedV1;
  finalizedAt?: number;
  outputs: Partial<Record<CaptureManifestFormatV1, CaptureManifestOutputV1>>;
};

export type FinalizeCaptureManifestRecordResult =
  | { ok: true; changed: boolean; record: CaptureManifestRecordV1 }
  | { ok: false; reason: "invalid_record" | "invalid_finalized_at" | "already_started" | "already_finalized" };

export type CaptureManifestOutputActionV1 =
  | {
      type: "fail_before_delivery";
      format: CaptureManifestFormatV1;
      expectedRevision: number;
      attemptId: string;
      errorCode: CaptureManifestPublicErrorCode;
      retryable: boolean;
      now: number;
    }
  | {
      type: "begin";
      format: CaptureManifestFormatV1;
      expectedRevision: number;
      attemptId: string;
      now: number;
    }
  | {
      type: "record_download";
      format: CaptureManifestFormatV1;
      expectedRevision: number;
      attemptId: string;
      downloadId: number;
      now: number;
    }
  | {
      type: "complete";
      format: CaptureManifestFormatV1;
      expectedRevision: number;
      attemptId: string;
      downloadId: number;
      now: number;
    }
  | {
      type: "fail";
      format: CaptureManifestFormatV1;
      expectedRevision: number;
      attemptId: string;
      errorCode: CaptureManifestPublicErrorCode;
      retryable: boolean;
      now: number;
    };

export type ReduceCaptureManifestOutputResult =
  | { ok: true; changed: boolean; record: CaptureManifestRecordV1 }
  | {
      ok: false;
      reason:
        | "invalid_record"
        | "invalid_action"
        | "unknown_format"
        | "revision_mismatch"
        | "attempt_mismatch"
        | "illegal_transition"
        | "retry_not_allowed";
      actualRevision?: number;
    };

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function exactKeys(record: UnknownRecord, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Reflect.ownKeys(record).every((key) => {
    if (typeof key !== "string" || !allowedKeys.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return Boolean(descriptor && "value" in descriptor && descriptor.enumerable);
  });
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    Number.isFinite(new Date(value).getTime());
}

function minimumFinalizedAt(record: CaptureManifestRecordV1): number {
  return Math.max(record.seed.createdAt, ...record.seed.items.map((item) => item.addedAt));
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function safeAttemptId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ATTEMPT_ID_LENGTH &&
    value === value.trim() && !UNSAFE_TEXT_PATTERN.test(value);
}

function safeAttemptIds(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) return false;
  const ids: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
      !safeAttemptId(descriptor.value)) return false;
    ids.push(descriptor.value);
  }
  return new Set(ids).size === ids.length;
}

function safeErrorCode(value: unknown): value is CaptureManifestPublicErrorCode {
  return typeof value === "string" && PUBLIC_ERROR_CODES.has(value as CaptureManifestPublicErrorCode);
}

function serializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return undefined;
  }
}

function canonicalOutput(output: CaptureManifestOutputV1): CaptureManifestOutputV1 {
  const autoReconcileState = normalizeAutoReconcileState({
    autoReconcileAttemptCount: output.autoReconcileAttemptCount,
    autoReconcileLastAttemptAt: output.autoReconcileLastAttemptAt,
    needsManualReconcile: output.needsManualReconcile,
  }) ?? DEFAULT_AUTO_RECONCILE_STATE;
  const common = {
    format: output.format,
    revision: output.revision,
    attemptNo: output.attemptNo,
    attemptIds: [...output.attemptIds],
    updatedAt: output.updatedAt,
    ...autoReconcileState,
  };
  if (output.state === "pending") return { ...common, state: "pending", revision: 0, attemptNo: 0 };
  if (output.state === "saving") {
    return {
      ...common,
      state: "saving",
      attemptId: output.attemptId,
      ...(output.downloadId === undefined ? {} : { downloadId: output.downloadId }),
    };
  }
  if (output.state === "complete") {
    return { ...common, state: "complete", attemptId: output.attemptId, downloadId: output.downloadId };
  }
  return {
    ...common,
    state: "failed",
    attemptId: output.attemptId,
    errorCode: output.errorCode,
    retryable: output.retryable,
    ...(output.downloadId === undefined ? {} : { downloadId: output.downloadId }),
  };
}

export function cloneCaptureManifestRecord(record: CaptureManifestRecordV1): CaptureManifestRecordV1 {
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    seed: cloneCaptureManifestSeed(record.seed),
    ...(record.finalizedAt === undefined ? {} : { finalizedAt: record.finalizedAt }),
    outputs: Object.fromEntries(
      record.seed.formats.map((format) => [format, canonicalOutput(record.outputs[format]!)]),
    ),
  };
}

function isCaptureManifestOutputV1(
  value: unknown,
  expectedFormat: CaptureManifestFormatV1,
  createdAt: number,
): value is CaptureManifestOutputV1 {
  const record = asRecord(value);
  const autoReconcileState = normalizeAutoReconcileState({
    autoReconcileAttemptCount: record?.autoReconcileAttemptCount,
    autoReconcileLastAttemptAt: record?.autoReconcileLastAttemptAt,
    needsManualReconcile: record?.needsManualReconcile,
  });
  if (
    !record || record.format !== expectedFormat || !safeNonNegativeInteger(record.revision) ||
    !safeNonNegativeInteger(record.attemptNo) || !safeAttemptIds(record.attemptIds) ||
    !safeTimestamp(record.updatedAt) ||
    (record.updatedAt as number) < createdAt ||
    !autoReconcileState
  ) return false;
  const autoReconcileKeys = [
    ...(record.autoReconcileAttemptCount === undefined ? [] : ["autoReconcileAttemptCount"]),
    ...(record.autoReconcileLastAttemptAt === undefined ? [] : ["autoReconcileLastAttemptAt"]),
    ...(record.needsManualReconcile === undefined ? [] : ["needsManualReconcile"]),
  ];
  if (record.state === "pending") {
    return exactKeys(record, [
      "format", "state", "revision", "attemptNo", "attemptIds", "updatedAt",
      ...autoReconcileKeys,
    ]) && record.revision === 0 && record.attemptNo === 0 &&
      record.attemptIds.length === 0 && record.updatedAt === createdAt;
  }
  if (!safePositiveInteger(record.revision) || !safePositiveInteger(record.attemptNo) ||
      !safeAttemptId(record.attemptId) || record.attemptIds.length !== record.attemptNo ||
      record.attemptIds.at(-1) !== record.attemptId) return false;
  if (record.state === "saving") {
    return exactKeys(record, [
      "format", "state", "revision", "attemptNo", "attemptIds", "updatedAt", "attemptId",
      "downloadId", ...autoReconcileKeys,
    ]) && (record.downloadId === undefined || safeNonNegativeInteger(record.downloadId));
  }
  if (record.state === "complete") {
    return exactKeys(record, [
      "format", "state", "revision", "attemptNo", "attemptIds", "updatedAt", "attemptId",
      "downloadId", ...autoReconcileKeys,
    ]) && safeNonNegativeInteger(record.downloadId);
  }
  if (record.state === "failed") {
    return exactKeys(record, [
      "format", "state", "revision", "attemptNo", "attemptIds", "updatedAt", "attemptId",
      "errorCode", "retryable", "downloadId", ...autoReconcileKeys,
    ]) && safeErrorCode(record.errorCode) && typeof record.retryable === "boolean" &&
      (record.downloadId === undefined || safeNonNegativeInteger(record.downloadId));
  }
  return false;
}

export function isCaptureManifestRecordV1(value: unknown): value is CaptureManifestRecordV1 {
  try {
    const record = asRecord(value);
    if (
      !record || !exactKeys(record, ["schemaVersion", "seed", "finalizedAt", "outputs"]) ||
      record.schemaVersion !== CAPTURE_PACK_SCHEMA_VERSION ||
      !isCaptureManifestSeedV1(record.seed) ||
      (record.finalizedAt !== undefined && (
        !safeTimestamp(record.finalizedAt) || record.finalizedAt < minimumFinalizedAt(record as CaptureManifestRecordV1)
      ))
    ) return false;
    const outputs = asRecord(record.outputs);
    if (!outputs || Object.keys(outputs).length !== record.seed.formats.length) return false;
    if (Reflect.ownKeys(outputs).some((key) => typeof key !== "string" ||
      !(record.seed as CaptureManifestSeedV1).formats.includes(key as CaptureManifestFormatV1))) return false;
    for (const format of record.seed.formats) {
      if (!Object.prototype.hasOwnProperty.call(outputs, format) ||
        !isCaptureManifestOutputV1(outputs[format], format, record.seed.createdAt)) return false;
    }
    const allAttemptIds = record.seed.formats.flatMap(
      (format) => (outputs[format] as CaptureManifestOutputV1).attemptIds,
    );
    if (new Set(allAttemptIds).size !== allAttemptIds.length) return false;
    if (
      record.finalizedAt === undefined &&
      record.seed.formats.some((format) =>
        (outputs[format] as CaptureManifestOutputV1).state !== "pending")
    ) return false;
    const bytes = serializedBytes(value);
    return bytes !== undefined && bytes <= MAX_CAPTURE_MANIFEST_RECORD_BYTES;
  } catch {
    return false;
  }
}

export function createCaptureManifestRecord(seed: CaptureManifestSeedV1): CaptureManifestRecordV1 | undefined {
  if (!isCaptureManifestSeedV1(seed)) return undefined;
  const record: CaptureManifestRecordV1 = {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    seed: cloneCaptureManifestSeed(seed),
    outputs: Object.fromEntries(seed.formats.map((format) => [format, {
      format,
      state: "pending",
      revision: 0,
      attemptNo: 0,
      attemptIds: [],
      updatedAt: seed.createdAt,
      ...DEFAULT_AUTO_RECONCILE_STATE,
    }])),
  };
  return isCaptureManifestRecordV1(record) ? cloneCaptureManifestRecord(record) : undefined;
}

/** Freezes the single pack completion time before either serializer starts. */
export function finalizeCaptureManifestRecord(
  rawRecord: unknown,
  finalizedAt: number,
): FinalizeCaptureManifestRecordResult {
  if (!isCaptureManifestRecordV1(rawRecord)) return { ok: false, reason: "invalid_record" };
  if (!safeTimestamp(finalizedAt) || finalizedAt < minimumFinalizedAt(rawRecord)) {
    return { ok: false, reason: "invalid_finalized_at" };
  }
  const record = cloneCaptureManifestRecord(rawRecord);
  if (record.finalizedAt !== undefined) {
    return record.finalizedAt === finalizedAt
      ? { ok: true, changed: false, record }
      : { ok: false, reason: "already_finalized" };
  }
  if (record.seed.formats.some((format) => record.outputs[format]?.state !== "pending")) {
    return { ok: false, reason: "already_started" };
  }
  record.finalizedAt = finalizedAt;
  return isCaptureManifestRecordV1(record)
    ? { ok: true, changed: true, record: cloneCaptureManifestRecord(record) }
    : { ok: false, reason: "invalid_finalized_at" };
}

function validActionEnvelope(action: CaptureManifestOutputActionV1): boolean {
  if (!action || typeof action !== "object" ||
    (action.format !== "json" && action.format !== "csv") ||
    !safeNonNegativeInteger(action.expectedRevision) || !safeTimestamp(action.now)) return false;
  if (!safeAttemptId(action.attemptId)) return false;
  if (action.type === "begin") return true;
  if (action.type === "record_download" || action.type === "complete") {
    return safeNonNegativeInteger(action.downloadId);
  }
  return (action.type === "fail" || action.type === "fail_before_delivery") &&
    safeErrorCode(action.errorCode) && typeof action.retryable === "boolean";
}

function recordOwnsAttemptId(
  record: CaptureManifestRecordV1,
  attemptId: string,
): boolean {
  return record.seed.formats.some(
    (format) => record.outputs[format]?.attemptIds.includes(attemptId),
  );
}

export function reduceCaptureManifestOutput(
  rawRecord: unknown,
  action: CaptureManifestOutputActionV1,
): ReduceCaptureManifestOutputResult {
  if (!isCaptureManifestRecordV1(rawRecord)) return { ok: false, reason: "invalid_record" };
  if (!validActionEnvelope(action)) return { ok: false, reason: "invalid_action" };
  const record = cloneCaptureManifestRecord(rawRecord);
  if (record.finalizedAt === undefined) return { ok: false, reason: "illegal_transition" };
  const current = record.outputs[action.format];
  if (!current) return { ok: false, reason: "unknown_format" };
  if (current.revision !== action.expectedRevision) {
    return { ok: false, reason: "revision_mismatch", actualRevision: current.revision };
  }
  if (action.now < current.updatedAt || action.now < record.finalizedAt) {
    return { ok: false, reason: "invalid_action" };
  }

  let next: CaptureManifestOutputV1;
  if (action.type === "fail_before_delivery") {
    if (current.state === "failed" && !current.retryable) {
      return { ok: false, reason: "retry_not_allowed" };
    }
    if (recordOwnsAttemptId(record, action.attemptId)) {
      return { ok: false, reason: "attempt_mismatch" };
    }
    if (current.state !== "pending" && current.state !== "failed") {
      return { ok: false, reason: "illegal_transition" };
    }
    if (current.attemptIds.length >= MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS) {
      return { ok: false, reason: "retry_not_allowed" };
    }
    next = {
      format: current.format,
      state: "failed",
      revision: current.revision + 1,
      attemptNo: current.attemptNo + 1,
      attemptIds: [...current.attemptIds, action.attemptId],
      attemptId: action.attemptId,
      errorCode: action.errorCode,
      retryable: action.retryable,
      updatedAt: action.now,
      ...DEFAULT_AUTO_RECONCILE_STATE,
    };
  } else if (action.type === "begin") {
    if (current.state === "failed" && !current.retryable) {
      return { ok: false, reason: "retry_not_allowed" };
    }
    // An offscreen attempt is permanently retired after revoke. Replaying the
    // same customer command must return its first terminal outcome, not create
    // a second logical attempt whose Blob identity can never be reclaimed.
    if (recordOwnsAttemptId(record, action.attemptId)) {
      return { ok: false, reason: "attempt_mismatch" };
    }
    if (current.state !== "pending" && current.state !== "failed") {
      return { ok: false, reason: "illegal_transition" };
    }
    if (current.attemptIds.length >= MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS) {
      return { ok: false, reason: "retry_not_allowed" };
    }
    next = {
      format: action.format,
      state: "saving",
      revision: current.revision + 1,
      attemptNo: current.attemptNo + 1,
      attemptIds: [...current.attemptIds, action.attemptId],
      attemptId: action.attemptId,
      updatedAt: action.now,
      ...DEFAULT_AUTO_RECONCILE_STATE,
    };
  } else {
    if (current.state !== "saving") return { ok: false, reason: "illegal_transition" };
    if (current.attemptId !== action.attemptId) return { ok: false, reason: "attempt_mismatch" };
    if (action.type === "record_download") {
      if (current.downloadId !== undefined) {
        return current.downloadId === action.downloadId
          ? { ok: true, changed: false, record }
          : { ok: false, reason: "illegal_transition" };
      }
      next = {
        ...current,
        revision: current.revision + 1,
        downloadId: action.downloadId,
        updatedAt: action.now,
      };
    } else if (action.type === "complete") {
      if (current.downloadId !== action.downloadId) {
        return { ok: false, reason: "illegal_transition" };
      }
      next = {
        format: current.format,
        state: "complete",
        revision: current.revision + 1,
        attemptNo: current.attemptNo,
        attemptIds: [...current.attemptIds],
        attemptId: current.attemptId,
        downloadId: current.downloadId,
        updatedAt: action.now,
        ...DEFAULT_AUTO_RECONCILE_STATE,
      };
    } else {
      next = {
        format: current.format,
        state: "failed",
        revision: current.revision + 1,
        attemptNo: current.attemptNo,
        attemptIds: [...current.attemptIds],
        attemptId: current.attemptId,
        errorCode: action.errorCode,
        retryable: action.retryable,
        ...(current.downloadId === undefined ? {} : { downloadId: current.downloadId }),
        updatedAt: action.now,
        ...DEFAULT_AUTO_RECONCILE_STATE,
      };
    }
  }
  record.outputs[action.format] = next;
  return isCaptureManifestRecordV1(record)
    ? { ok: true, changed: true, record: cloneCaptureManifestRecord(record) }
    : { ok: false, reason: "invalid_action" };
}

export function updateCaptureManifestOutputAutoReconcileState(
  rawRecord: unknown,
  input: {
    format: CaptureManifestFormatV1;
    expectedRevision: number;
    attemptId: string;
    state: AutoReconcileStateV1;
  },
): ReduceCaptureManifestOutputResult {
  if (!isCaptureManifestRecordV1(rawRecord)) return { ok: false, reason: "invalid_record" };
  const state = normalizeAutoReconcileState(input.state);
  if (
    (input.format !== "json" && input.format !== "csv") ||
    !safeNonNegativeInteger(input.expectedRevision) ||
    !safeAttemptId(input.attemptId) ||
    !state
  ) return { ok: false, reason: "invalid_action" };
  const record = cloneCaptureManifestRecord(rawRecord);
  const current = record.outputs[input.format];
  if (!current) return { ok: false, reason: "unknown_format" };
  if (current.revision !== input.expectedRevision) {
    return { ok: false, reason: "revision_mismatch", actualRevision: current.revision };
  }
  if (current.state !== "failed") return { ok: false, reason: "illegal_transition" };
  if (current.attemptId !== input.attemptId) return { ok: false, reason: "attempt_mismatch" };
  const next: CaptureManifestOutputV1 = { ...current, ...state };
  if (state.autoReconcileLastAttemptAt === undefined) delete next.autoReconcileLastAttemptAt;
  record.outputs[input.format] = next;
  if (JSON.stringify(rawRecord) === JSON.stringify(record)) {
    return { ok: true, changed: false, record };
  }
  return isCaptureManifestRecordV1(record)
    ? { ok: true, changed: true, record: cloneCaptureManifestRecord(record) }
    : { ok: false, reason: "invalid_action" };
}
