/** Background-owned session storage for redacted Capture Pack manifests. */
import { CAPTURE_PACK_SCHEMA_VERSION, type CaptureManifestFormatV1 } from "./capture-pack-types";
import {
  cloneCaptureManifestRecord,
  finalizeCaptureManifestRecord,
  isCaptureManifestRecordV1,
  reduceCaptureManifestOutput,
  updateCaptureManifestOutputAutoReconcileState,
  type CaptureManifestOutputActionV1,
  type CaptureManifestRecordV1,
  type ReduceCaptureManifestOutputResult,
} from "./capture-manifest-delivery";
import type { AutoReconcileStateV1 } from "./quick-capture-auto-reconcile";
import { withKeyLock } from "./session-jobs";

export const CAPTURE_MANIFEST_RECORD_STORAGE_PREFIX = "capture-manifest-record-v1:";
const CAPTURE_RUN_GRAPH_LOCK = "capture-runs-v1";
const MAX_RUN_ID_LENGTH = 256;
const UNSAFE_ID_PATTERN = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export type StoredCaptureManifestRecordResult =
  | { status: "empty" }
  | { status: "valid"; record: CaptureManifestRecordV1 }
  | { status: "invalid"; reason: "corrupt" | "future_schema"; schemaVersion?: number };

export type CaptureManifestStorageFailure =
  | { ok: false; reason: "invalid_input"; message: string }
  | { ok: false; reason: "not_found"; runId: string }
  | {
      ok: false;
      reason: "storage_corrupt" | "storage_future_schema";
      key: string;
      schemaVersion?: number;
    }
  | {
      ok: false;
      reason: "storage_unavailable";
      operation: "get" | "set";
      message: string;
      committed: boolean;
    }
  | {
      ok: false;
      reason: Exclude<ReduceCaptureManifestOutputResult, { ok: true }>["reason"];
      actualRevision?: number;
    };

export type GetCaptureManifestRecordResult =
  | { ok: true; record: CaptureManifestRecordV1 | null }
  | CaptureManifestStorageFailure;

export type MutateCaptureManifestOutputResult =
  | { ok: true; changed: boolean; record: CaptureManifestRecordV1 }
  | CaptureManifestStorageFailure;

export type UpdateCaptureManifestOutputAutoReconcileResult =
  | { ok: true; changed: boolean; record: CaptureManifestRecordV1 }
  | CaptureManifestStorageFailure;

export type FinalizeStoredCaptureManifestRecordResult =
  | { ok: true; changed: boolean; record: CaptureManifestRecordV1 }
  | CaptureManifestStorageFailure
  | { ok: false; reason: "invalid_finalized_at" | "already_started" | "already_finalized" };

function safeRunId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_RUN_ID_LENGTH &&
    value === value.trim() && !UNSAFE_ID_PATTERN.test(value);
}

export function captureManifestRecordKey(runId: string): string {
  return `${CAPTURE_MANIFEST_RECORD_STORAGE_PREFIX}${runId}`;
}

function futureSchemaVersion(value: unknown): number | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, "schemaVersion");
    return typeof descriptor?.value === "number" && Number.isSafeInteger(descriptor.value) &&
      descriptor.value > CAPTURE_PACK_SCHEMA_VERSION
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseStoredCaptureManifestRecord(
  value: unknown,
): StoredCaptureManifestRecordResult {
  if (value === undefined) return { status: "empty" };
  try {
    if (isCaptureManifestRecordV1(value)) {
      return { status: "valid", record: cloneCaptureManifestRecord(value) };
    }
    const schemaVersion = futureSchemaVersion(value);
    return schemaVersion === undefined
      ? { status: "invalid", reason: "corrupt" }
      : { status: "invalid", reason: "future_schema", schemaVersion };
  } catch {
    return { status: "invalid", reason: "corrupt" };
  }
}

function unavailable(
  operation: "get" | "set",
  error: unknown,
  committed = false,
): CaptureManifestStorageFailure {
  return {
    ok: false,
    reason: "storage_unavailable",
    operation,
    message: error instanceof Error ? error.message : "Chrome session storage is unavailable.",
    committed,
  };
}

function parsedFailure(
  key: string,
  parsed: Extract<StoredCaptureManifestRecordResult, { status: "invalid" }>,
): CaptureManifestStorageFailure {
  return parsed.reason === "future_schema"
    ? { ok: false, reason: "storage_future_schema", key, schemaVersion: parsed.schemaVersion }
    : { ok: false, reason: "storage_corrupt", key };
}

async function readRaw(key: string): Promise<
  { ok: true; value: unknown } | CaptureManifestStorageFailure
> {
  try {
    const stored: Record<string, unknown> = await chrome.storage.session.get(key);
    return { ok: true, value: stored[key] };
  } catch (error) {
    return unavailable("get", error);
  }
}

function recordsEqual(left: CaptureManifestRecordV1, right: CaptureManifestRecordV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function writeRecordWithReadBack(
  key: string,
  previous: CaptureManifestRecordV1,
  candidate: CaptureManifestRecordV1,
): Promise<MutateCaptureManifestOutputResult> {
  try {
    await chrome.storage.session.set({ [key]: candidate });
    return { ok: true, changed: true, record: cloneCaptureManifestRecord(candidate) };
  } catch (error) {
    const readBackRaw = await readRaw(key);
    if (!readBackRaw.ok) return unavailable("set", error, true);
    const readBack = parseStoredCaptureManifestRecord(readBackRaw.value);
    if (readBack.status === "valid" && recordsEqual(readBack.record, candidate)) {
      return { ok: true, changed: true, record: cloneCaptureManifestRecord(readBack.record) };
    }
    if (readBack.status === "valid" && recordsEqual(readBack.record, previous)) {
      return unavailable("set", error, false);
    }
    return unavailable("set", error, true);
  }
}

export async function getCaptureManifestRecord(
  runId: string,
): Promise<GetCaptureManifestRecordResult> {
  if (!safeRunId(runId)) {
    return { ok: false, reason: "invalid_input", message: "runId must be a bounded identifier." };
  }
  const key = captureManifestRecordKey(runId);
  const raw = await readRaw(key);
  if (!raw.ok) return raw;
  const parsed = parseStoredCaptureManifestRecord(raw.value);
  if (parsed.status === "invalid") return parsedFailure(key, parsed);
  if (parsed.status === "empty") return { ok: true, record: null };
  if (parsed.record.seed.runId !== runId) return { ok: false, reason: "storage_corrupt", key };
  return { ok: true, record: cloneCaptureManifestRecord(parsed.record) };
}

export async function mutateCaptureManifestOutput(input: {
  runId: string;
  format: CaptureManifestFormatV1;
  action: CaptureManifestOutputActionV1;
}): Promise<MutateCaptureManifestOutputResult> {
  if (!safeRunId(input.runId) || input.action?.format !== input.format) {
    return { ok: false, reason: "invalid_input", message: "Manifest mutation identity is invalid." };
  }
  return withKeyLock(CAPTURE_RUN_GRAPH_LOCK, async () => {
    const key = captureManifestRecordKey(input.runId);
    const raw = await readRaw(key);
    if (!raw.ok) return raw;
    const parsed = parseStoredCaptureManifestRecord(raw.value);
    if (parsed.status === "invalid") return parsedFailure(key, parsed);
    if (parsed.status === "empty") return { ok: false, reason: "not_found", runId: input.runId };
    if (parsed.record.seed.runId !== input.runId) {
      return { ok: false, reason: "storage_corrupt", key };
    }
    const reduced = reduceCaptureManifestOutput(parsed.record, input.action);
    if (!reduced.ok) return { ok: false, reason: reduced.reason, ...(
      reduced.actualRevision === undefined ? {} : { actualRevision: reduced.actualRevision }
    ) };
    if (!reduced.changed) return reduced;
    return writeRecordWithReadBack(key, parsed.record, reduced.record);
  });
}

export async function updateStoredCaptureManifestOutputAutoReconcileState(input: {
  runId: string;
  format: CaptureManifestFormatV1;
  expectedRevision: number;
  attemptId: string;
  state: AutoReconcileStateV1;
}): Promise<UpdateCaptureManifestOutputAutoReconcileResult> {
  if (!safeRunId(input.runId)) {
    return { ok: false, reason: "invalid_input", message: "Manifest auto reconcile identity is invalid." };
  }
  return withKeyLock(CAPTURE_RUN_GRAPH_LOCK, async () => {
    const key = captureManifestRecordKey(input.runId);
    const raw = await readRaw(key);
    if (!raw.ok) return raw;
    const parsed = parseStoredCaptureManifestRecord(raw.value);
    if (parsed.status === "invalid") return parsedFailure(key, parsed);
    if (parsed.status === "empty") return { ok: false, reason: "not_found", runId: input.runId };
    if (parsed.record.seed.runId !== input.runId) {
      return { ok: false, reason: "storage_corrupt", key };
    }
    const updated = updateCaptureManifestOutputAutoReconcileState(parsed.record, input);
    if (!updated.ok) return { ok: false, reason: updated.reason, ...(
      updated.actualRevision === undefined ? {} : { actualRevision: updated.actualRevision }
    ) };
    if (!updated.changed) return updated;
    return writeRecordWithReadBack(key, parsed.record, updated.record);
  });
}

export async function finalizeStoredCaptureManifestRecord(input: {
  runId: string;
  finalizedAt: number;
}): Promise<FinalizeStoredCaptureManifestRecordResult> {
  if (!safeRunId(input.runId)) {
    return { ok: false, reason: "invalid_input", message: "runId must be a bounded identifier." };
  }
  return withKeyLock(CAPTURE_RUN_GRAPH_LOCK, async () => {
    const key = captureManifestRecordKey(input.runId);
    const raw = await readRaw(key);
    if (!raw.ok) return raw;
    const parsed = parseStoredCaptureManifestRecord(raw.value);
    if (parsed.status === "invalid") return parsedFailure(key, parsed);
    if (parsed.status === "empty") return { ok: false, reason: "not_found", runId: input.runId };
    if (parsed.record.seed.runId !== input.runId) {
      return { ok: false, reason: "storage_corrupt", key };
    }
    const finalized = finalizeCaptureManifestRecord(parsed.record, input.finalizedAt);
    if (!finalized.ok) return finalized;
    if (!finalized.changed) return finalized;
    return writeRecordWithReadBack(key, parsed.record, finalized.record);
  });
}
