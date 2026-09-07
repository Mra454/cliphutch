/**
 * Background-owned, session-only journal for Capture Run enqueue intent.
 *
 * The record is deliberately redacted: it contains identifiers, the first
 * authoritative entitlement/allocation decision, and a digest of the derived
 * execution plan, but never a media URL, planned filename, or full plan.
 *
 * `commandId` is the canonical, prefixed UI command (`capture-run-<uuid>`).
 * The queue coordinator may continue to use the stripped UUID; retaining the
 * UI form here prevents unrelated command namespaces from sharing a ledger.
 */
import {
  isCaptureReviewPlanV1,
  type CaptureReviewPlanV1,
} from "./capture-pack-types";
import { cloneCaptureReviewPlan } from "./capture-plan";
import {
  canonicalizeCaptureHeaderLeaseIdsByItemId,
  MAX_CAPTURE_HEADER_LEASE_IDS,
  type CaptureHeaderLeaseIdsByItemId,
} from "./capture-plan-options";
import {
  DEFAULT_AUTO_RECONCILE_STATE,
  normalizeAutoReconcileState,
  type AutoReconcileStateV1,
} from "./quick-capture-auto-reconcile";
import { withKeyLock } from "./session-jobs";

export const CAPTURE_RUN_INTENTS_STORAGE_KEY = "capture-run-intents-v1";
export const MAX_PENDING_CAPTURE_RUN_INTENTS = 20;
export const MAX_SETTLED_CAPTURE_RUN_INTENTS = 200;
export const MAX_CAPTURE_RUN_INTENT_RECORDS =
  MAX_PENDING_CAPTURE_RUN_INTENTS + MAX_SETTLED_CAPTURE_RUN_INTENTS;
export const MAX_CAPTURE_RUN_INTENTS_BYTES = 4 * 1024 * 1024;

const MAX_RAW_RECORDS_FOR_REPAIR = 400;
const MAX_ID_LENGTH = 256;
const MAX_ITEM_IDS = 200;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[a-z0-9._:-]+$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type CaptureRunIntentCreateInput = {
  /** Prefixed UI command ID, not the coordinator's stripped UUID. */
  commandId: string;
  planId: string;
  draftId: string;
  draftRevision: number;
  /** Original, ordered selection sent by the UI. */
  requestedFreeVideoItemIds: string[];
  /** First authoritative background entitlement decision. */
  licensed: boolean;
  /** Exact, ordered video allocation in the derived execution plan. */
  allocatedVideoItemIds: string[];
  /**
   * Background-only immutable lease bindings. Optional only for staged callers;
   * omission is canonicalized to the exact empty map.
   */
  headerLeaseIdsByItemId?: CaptureHeaderLeaseIdsByItemId;
  /** SHA-256 of the canonical derived execution plan. */
  executionPlanDigest: string;
  createdAt: number;
};

type NormalizedCaptureRunIntentCreateInput = Omit<
  CaptureRunIntentCreateInput,
  "headerLeaseIdsByItemId"
> & {
  headerLeaseIdsByItemId: CaptureHeaderLeaseIdsByItemId;
};

type CaptureRunIntentBaseV1 = NormalizedCaptureRunIntentCreateInput & {
  schemaVersion: 1;
} & AutoReconcileStateV1;

export type CaptureRunIntentReconciliationDisposition =
  | "accepted"
  | "recovery_needed"
  | "commit_state_unknown";

export type CaptureRunIntentV1 =
  | (CaptureRunIntentBaseV1 & { status: "pending" })
  | (CaptureRunIntentBaseV1 & {
      status: "committed";
      runId: string;
      reconciliationDisposition: CaptureRunIntentReconciliationDisposition;
    });

type CaptureRunIntentIndexV1 = {
  schemaVersion: 1;
  orderedCommandIds: string[];
  records: Record<string, CaptureRunIntentV1>;
};

export type CaptureRunIntentFailure =
  | { ok: false; reason: "invalid_input"; message: string }
  | { ok: false; reason: "storage_corrupt"; key: string }
  | {
      ok: false;
      reason: "storage_unavailable";
      operation: "get" | "set";
      commitState: "absent" | "unknown";
      message: string;
    }
  | { ok: false; reason: "pending_capacity"; limit: number }
  | { ok: false; reason: "serialized_byte_limit"; limit: number }
  | {
      ok: false;
      reason: "unresolved_intent";
      commandId: string;
      intent: CaptureRunIntentV1;
    }
  | {
      ok: false;
      reason: "command_conflict";
      commandId: string;
      intent: CaptureRunIntentV1;
    }
  | { ok: false; reason: "intent_not_found"; commandId: string }
  | {
      ok: false;
      reason: "run_conflict";
      commandId: string;
      existingRunId: string;
    };

export type CreateCaptureRunIntentResult =
  | {
      ok: true;
      changed: boolean;
      replayed: boolean;
      commitState: "committed";
      intent: CaptureRunIntentV1;
      prunedCommandIds: string[];
    }
  | CaptureRunIntentFailure;

export type FinalizeCaptureRunIntentResult =
  | {
      ok: true;
      changed: boolean;
      commitState: "committed";
      intent: Extract<CaptureRunIntentV1, { status: "committed" }>;
      prunedCommandIds: string[];
    }
  | CaptureRunIntentFailure;

export type UpdateCaptureRunIntentAutoReconcileResult =
  | {
      ok: true;
      changed: boolean;
      commitState: "committed";
      intent: CaptureRunIntentV1;
      prunedCommandIds: string[];
    }
  | CaptureRunIntentFailure;

export type AbandonCaptureRunIntentResult =
  | { ok: true; changed: boolean; commitState: "committed" }
  | CaptureRunIntentFailure;

export type GetCaptureRunIntentResult =
  | { ok: true; intent: CaptureRunIntentV1 | null; repairNeeded: boolean }
  | CaptureRunIntentFailure;

export type GetNewestUnresolvedCaptureRunIntentResult =
  | { ok: true; intent: CaptureRunIntentV1 | null; repairNeeded: boolean }
  | CaptureRunIntentFailure;

export type ListCaptureRunIntentsResult =
  | { ok: true; intents: CaptureRunIntentV1[]; repairNeeded: boolean }
  | CaptureRunIntentFailure;

export type RepairCaptureRunIntentJournalResult =
  | {
      ok: true;
      changed: boolean;
      commitState: "committed";
      intents: CaptureRunIntentV1[];
      prunedCommandIds: string[];
    }
  | CaptureRunIntentFailure;

type UnknownRecord = Record<string, unknown>;
type ParsedIndex = {
  index: CaptureRunIntentIndexV1;
  repairNeeded: boolean;
  prunedCommandIds: string[];
};

function invalidInput(message: string): CaptureRunIntentFailure {
  return { ok: false, reason: "invalid_input", message };
}

function unavailable(
  operation: "get" | "set",
  commitState: "absent" | "unknown",
): CaptureRunIntentFailure {
  return {
    ok: false,
    reason: "storage_unavailable",
    operation,
    commitState,
    message: "Chrome session storage is unavailable.",
  };
}

function exactDataRecord(value: unknown, allowedKeys: readonly string[]): UnknownRecord | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== allowedKeys.length ||
      ownKeys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    ) {
      return undefined;
    }
    const record = Object.create(null) as UnknownRecord;
    for (const key of allowedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return undefined;
  }
}

function exactDataRecordWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): UnknownRecord | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    ) {
      return undefined;
    }
    const record = Object.create(null) as UnknownRecord;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return undefined;
  }
}

function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID_PATTERN.test(value)
  );
}

function canonicalCommandId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("capture-run-")) return undefined;
  const uuid = value.slice("capture-run-".length);
  return UUID_PATTERN.test(uuid) ? `capture-run-${uuid.toLowerCase()}` : undefined;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseIdArray(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ITEM_IDS) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== length + 1 ||
      ownKeys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= length;
      })
    ) {
      return undefined;
    }
    const ids: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !safeId(descriptor.value)) return undefined;
      ids.push(descriptor.value);
    }
    return new Set(ids).size === ids.length ? ids : undefined;
  } catch {
    return undefined;
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseHeaderLeaseIdMap(value: unknown = {}): CaptureHeaderLeaseIdsByItemId | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length > MAX_CAPTURE_HEADER_LEASE_IDS ||
      ownKeys.some((key) => typeof key !== "string" || !safeId(key))
    ) return undefined;
    const result = Object.create(null) as Record<string, string>;
    const seenLeaseIds = new Set<string>();
    // The authoritative plan-options layer has already put these keys in plan
    // order. Preserve that frozen order while comparing maps semantically.
    for (const rawKey of ownKeys) {
      const key = rawKey as string;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor || !("value" in descriptor) || !descriptor.enumerable ||
        !safeId(descriptor.value) || seenLeaseIds.has(descriptor.value)
      ) return undefined;
      result[key] = descriptor.value;
      seenLeaseIds.add(descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

function leaseMapsEqual(
  left: CaptureHeaderLeaseIdsByItemId,
  right: CaptureHeaderLeaseIdsByItemId,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((itemId) =>
      Object.prototype.hasOwnProperty.call(right, itemId) && right[itemId] === left[itemId]);
}

function parseCreateInput(value: unknown): NormalizedCaptureRunIntentCreateInput | undefined {
  const keys = [
    "commandId",
    "planId",
    "draftId",
    "draftRevision",
    "requestedFreeVideoItemIds",
    "licensed",
    "allocatedVideoItemIds",
    "headerLeaseIdsByItemId",
    "executionPlanDigest",
    "createdAt",
  ] as const;
  const record = exactDataRecord(value, keys) ?? exactDataRecord(
    value,
    keys.filter((key) => key !== "headerLeaseIdsByItemId"),
  );
  if (!record) return undefined;
  if (
    Object.prototype.hasOwnProperty.call(record, "headerLeaseIdsByItemId") &&
    record.headerLeaseIdsByItemId === undefined
  ) return undefined;
  const commandId = canonicalCommandId(record.commandId);
  const requestedFreeVideoItemIds = parseIdArray(record.requestedFreeVideoItemIds);
  const allocatedVideoItemIds = parseIdArray(record.allocatedVideoItemIds);
  const headerLeaseIdsByItemId = parseHeaderLeaseIdMap(record.headerLeaseIdsByItemId);
  if (
    !commandId ||
    !safeId(record.planId) ||
    !safeId(record.draftId) ||
    !safeInteger(record.draftRevision) ||
    !requestedFreeVideoItemIds ||
    typeof record.licensed !== "boolean" ||
    !allocatedVideoItemIds ||
    !headerLeaseIdsByItemId ||
    typeof record.executionPlanDigest !== "string" ||
    !DIGEST_PATTERN.test(record.executionPlanDigest) ||
    !safeInteger(record.createdAt) ||
    (!record.licensed && !arraysEqual(requestedFreeVideoItemIds, allocatedVideoItemIds))
  ) {
    return undefined;
  }
  return {
    commandId,
    planId: record.planId,
    draftId: record.draftId,
    draftRevision: record.draftRevision,
    requestedFreeVideoItemIds,
    licensed: record.licensed,
    allocatedVideoItemIds,
    headerLeaseIdsByItemId,
    executionPlanDigest: record.executionPlanDigest,
    createdAt: record.createdAt,
  };
}

function cloneIntent(intent: CaptureRunIntentV1): CaptureRunIntentV1 {
  const base: CaptureRunIntentBaseV1 = {
    schemaVersion: 1,
    commandId: intent.commandId,
    planId: intent.planId,
    draftId: intent.draftId,
    draftRevision: intent.draftRevision,
    requestedFreeVideoItemIds: [...intent.requestedFreeVideoItemIds],
    licensed: intent.licensed,
    allocatedVideoItemIds: [...intent.allocatedVideoItemIds],
    headerLeaseIdsByItemId: parseHeaderLeaseIdMap(intent.headerLeaseIdsByItemId)!,
    executionPlanDigest: intent.executionPlanDigest,
    createdAt: intent.createdAt,
    autoReconcileAttemptCount: intent.autoReconcileAttemptCount,
    ...(intent.autoReconcileLastAttemptAt === undefined
      ? {}
      : { autoReconcileLastAttemptAt: intent.autoReconcileLastAttemptAt }),
    needsManualReconcile: intent.needsManualReconcile,
  };
  return intent.status === "pending"
    ? { ...base, status: "pending" }
    : {
        ...base,
        status: "committed",
        runId: intent.runId,
        reconciliationDisposition: intent.reconciliationDisposition,
      };
}

function withAutoReconcileState(
  intent: CaptureRunIntentV1,
  state: AutoReconcileStateV1,
): CaptureRunIntentV1 {
  const next = { ...cloneIntent(intent), ...state };
  if (state.autoReconcileLastAttemptAt === undefined) {
    delete next.autoReconcileLastAttemptAt;
  }
  return next;
}

function parseIntent(value: unknown): CaptureRunIntentV1 | undefined {
  const statusRecord = exactDataRecordWithOptional(value, [
    "schemaVersion",
    "commandId",
    "planId",
    "draftId",
    "draftRevision",
    "requestedFreeVideoItemIds",
    "licensed",
    "allocatedVideoItemIds",
    "executionPlanDigest",
    "createdAt",
    "status",
  ], [
    "headerLeaseIdsByItemId",
    "runId",
    "reconciliationDisposition",
    "autoReconcileAttemptCount",
    "autoReconcileLastAttemptAt",
    "needsManualReconcile",
  ]);
  if (!statusRecord || statusRecord.schemaVersion !== 1) return undefined;
  const parsed = parseCreateInput({
    commandId: statusRecord.commandId,
    planId: statusRecord.planId,
    draftId: statusRecord.draftId,
    draftRevision: statusRecord.draftRevision,
    requestedFreeVideoItemIds: statusRecord.requestedFreeVideoItemIds,
    licensed: statusRecord.licensed,
    allocatedVideoItemIds: statusRecord.allocatedVideoItemIds,
    ...(Object.prototype.hasOwnProperty.call(statusRecord, "headerLeaseIdsByItemId")
      ? { headerLeaseIdsByItemId: statusRecord.headerLeaseIdsByItemId }
      : {}),
    executionPlanDigest: statusRecord.executionPlanDigest,
    createdAt: statusRecord.createdAt,
  });
  if (!parsed) return undefined;
  const autoReconcileState = normalizeAutoReconcileState({
    autoReconcileAttemptCount: statusRecord.autoReconcileAttemptCount,
    autoReconcileLastAttemptAt: statusRecord.autoReconcileLastAttemptAt,
    needsManualReconcile: statusRecord.needsManualReconcile,
  });
  if (!autoReconcileState) return undefined;
  if (statusRecord.status === "pending" && !("runId" in statusRecord)) {
    return { schemaVersion: 1, ...parsed, ...autoReconcileState, status: "pending" };
  }
  if (
    statusRecord.status === "committed" &&
    "runId" in statusRecord &&
    safeId(statusRecord.runId) &&
    (!("reconciliationDisposition" in statusRecord) ||
      statusRecord.reconciliationDisposition === "accepted" ||
      statusRecord.reconciliationDisposition === "recovery_needed" ||
      statusRecord.reconciliationDisposition === "commit_state_unknown")
  ) {
    return {
      schemaVersion: 1,
      ...parsed,
      ...autoReconcileState,
      status: "committed",
      runId: statusRecord.runId,
      reconciliationDisposition: "reconciliationDisposition" in statusRecord
        ? statusRecord.reconciliationDisposition as CaptureRunIntentReconciliationDisposition
        : "commit_state_unknown",
    };
  }
  return undefined;
}

function isUnresolvedParsedIntent(intent: CaptureRunIntentV1): boolean {
  return intent.status === "pending" || intent.reconciliationDisposition !== "accepted";
}

/** Total runtime predicate used by workspace/recovery routing. */
export function isCaptureRunIntentUnresolved(intent: unknown): boolean {
  try {
    const parsed = parseIntent(intent);
    return Boolean(parsed && isUnresolvedParsedIntent(parsed));
  } catch {
    return false;
  }
}

function intentsEqual(left: CaptureRunIntentV1, right: CaptureRunIntentV1): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.commandId === right.commandId &&
    left.planId === right.planId &&
    left.draftId === right.draftId &&
    left.draftRevision === right.draftRevision &&
    arraysEqual(left.requestedFreeVideoItemIds, right.requestedFreeVideoItemIds) &&
    left.licensed === right.licensed &&
    arraysEqual(left.allocatedVideoItemIds, right.allocatedVideoItemIds) &&
    leaseMapsEqual(left.headerLeaseIdsByItemId, right.headerLeaseIdsByItemId) &&
    left.executionPlanDigest === right.executionPlanDigest &&
    left.createdAt === right.createdAt &&
    left.autoReconcileAttemptCount === right.autoReconcileAttemptCount &&
    left.autoReconcileLastAttemptAt === right.autoReconcileLastAttemptAt &&
    left.needsManualReconcile === right.needsManualReconcile &&
    left.status === right.status &&
    (left.status !== "committed" ||
      (right.status === "committed" &&
        left.runId === right.runId &&
        left.reconciliationDisposition === right.reconciliationDisposition))
  );
}

function requestMatchesParsed(
  intent: CaptureRunIntentV1,
  input: NormalizedCaptureRunIntentCreateInput,
): boolean {
  return (
    intent.commandId === input.commandId &&
    intent.planId === input.planId &&
    intent.draftId === input.draftId &&
    intent.draftRevision === input.draftRevision &&
    arraysEqual(intent.requestedFreeVideoItemIds, input.requestedFreeVideoItemIds) &&
    leaseMapsEqual(intent.headerLeaseIdsByItemId, input.headerLeaseIdsByItemId)
  );
}

/** Total runtime request matcher for integration/recovery code. */
export function captureRunIntentRequestMatches(
  intent: unknown,
  input: unknown,
): boolean {
  try {
    const parsedIntent = parseIntent(intent);
    const parsedInput = parseCreateInput(input);
    return Boolean(parsedIntent && parsedInput && requestMatchesParsed(parsedIntent, parsedInput));
  } catch {
    return false;
  }
}

/** Total runtime matcher for the frozen entitlement/allocation decision. */
export function captureRunIntentDecisionMatches(
  intent: unknown,
  decision: unknown,
): boolean {
  const record = exactDataRecord(decision, [
    "licensed",
    "allocatedVideoItemIds",
    "headerLeaseIdsByItemId",
    "executionPlanDigest",
  ]) ?? exactDataRecord(decision, [
    "licensed",
    "allocatedVideoItemIds",
    "executionPlanDigest",
  ]);
  const parsedIntent = parseIntent(intent);
  const allocated = record ? parseIdArray(record.allocatedVideoItemIds) : undefined;
  const headerLeaseIdsByItemId = record
    ? parseHeaderLeaseIdMap(record.headerLeaseIdsByItemId)
    : undefined;
  return Boolean(
    parsedIntent &&
    record &&
    typeof record.licensed === "boolean" &&
    allocated &&
    headerLeaseIdsByItemId &&
    typeof record.executionPlanDigest === "string" &&
    DIGEST_PATTERN.test(record.executionPlanDigest) &&
    parsedIntent.licensed === record.licensed &&
    arraysEqual(parsedIntent.allocatedVideoItemIds, allocated) &&
    leaseMapsEqual(parsedIntent.headerLeaseIdsByItemId, headerLeaseIdsByItemId) &&
    parsedIntent.executionPlanDigest === record.executionPlanDigest,
  );
}

function canonicalOrder(records: Record<string, CaptureRunIntentV1>): string[] {
  return Object.keys(records).sort((leftId, rightId) => {
    const createdDifference = records[rightId].createdAt - records[leftId].createdAt;
    if (createdDifference !== 0) return createdDifference;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

function serializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? undefined
      : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return undefined;
  }
}

function buildIndex(
  source: Record<string, CaptureRunIntentV1>,
  preserveCommandId?: string,
):
  | { ok: true; index: CaptureRunIntentIndexV1; prunedCommandIds: string[] }
  | Extract<CaptureRunIntentFailure, { reason: "serialized_byte_limit" }> {
  const unresolvedIds = Object.keys(source).filter((commandId) =>
    isUnresolvedParsedIntent(source[commandId]),
  );
  const settledIds = Object.keys(source)
    .filter((commandId) => !isUnresolvedParsedIntent(source[commandId]))
    .sort((leftId, rightId) => {
      if (leftId === rightId) return 0;
      if (leftId === preserveCommandId) return -1;
      if (rightId === preserveCommandId) return 1;
      const createdDifference = source[rightId].createdAt - source[leftId].createdAt;
      if (createdDifference !== 0) return createdDifference;
      return leftId < rightId ? -1 : 1;
    });
  const retainedIds = new Set([
    ...unresolvedIds,
    ...settledIds.slice(0, MAX_SETTLED_CAPTURE_RUN_INTENTS),
  ]);
  const prunedCommandIds = settledIds.filter((commandId) => !retainedIds.has(commandId));
  const records: Record<string, CaptureRunIntentV1> = Object.fromEntries(
    [...retainedIds].map((commandId) => [commandId, cloneIntent(source[commandId])]),
  );

  while (true) {
    const orderedCommandIds = canonicalOrder(records);
    const index: CaptureRunIntentIndexV1 = { schemaVersion: 1, orderedCommandIds, records };
    const bytes = serializedBytes(index);
    if (bytes !== undefined && bytes <= MAX_CAPTURE_RUN_INTENTS_BYTES) {
      return { ok: true, index, prunedCommandIds };
    }
    const removable = [...orderedCommandIds]
      .reverse()
      .find((commandId) =>
        !isUnresolvedParsedIntent(records[commandId]) && commandId !== preserveCommandId,
      );
    if (!removable) {
      return {
        ok: false,
        reason: "serialized_byte_limit",
        limit: MAX_CAPTURE_RUN_INTENTS_BYTES,
      };
    }
    delete records[removable];
    prunedCommandIds.push(removable);
  }
}

function parseOrderHint(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RAW_RECORDS_FOR_REPAIR) {
      return undefined;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== length + 1 ||
      ownKeys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= length;
      })
    ) {
      return undefined;
    }
    const result: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      const commandId = canonicalCommandId(descriptor.value);
      if (!commandId) return undefined;
      result.push(commandId);
    }
    return result;
  } catch {
    return undefined;
  }
}

function parseRecordMap(value: unknown): {
  records: Record<string, CaptureRunIntentV1>;
  normalizedLegacy: boolean;
} | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > MAX_RAW_RECORDS_FOR_REPAIR ||
      keys.some((key) => typeof key !== "string")
    ) {
      return undefined;
    }
    const records: Record<string, CaptureRunIntentV1> = Object.create(null);
    let normalizedLegacy = false;
    for (const rawKey of keys) {
      const key = rawKey as string;
      const commandId = canonicalCommandId(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!commandId || commandId !== key || !descriptor || !("value" in descriptor)) {
        return undefined;
      }
      const intent = parseIntent(descriptor.value);
      if (!intent || intent.commandId !== commandId) return undefined;
      if (
        intent.status === "committed" &&
        Object.getOwnPropertyDescriptor(descriptor.value as object, "reconciliationDisposition") ===
          undefined
      ) {
        normalizedLegacy = true;
      }
      if (
        Object.getOwnPropertyDescriptor(descriptor.value as object, "headerLeaseIdsByItemId") ===
          undefined
      ) {
        normalizedLegacy = true;
      }
      records[commandId] = intent;
    }
    return { records, normalizedLegacy };
  } catch {
    return undefined;
  }
}

function emptyParsedIndex(): ParsedIndex {
  return {
    index: { schemaVersion: 1, orderedCommandIds: [], records: {} },
    repairNeeded: false,
    prunedCommandIds: [],
  };
}

function parseIndex(value: unknown): ParsedIndex | undefined {
  if (value === undefined) return emptyParsedIndex();
  const record = exactDataRecord(value, ["schemaVersion", "orderedCommandIds", "records"]);
  if (!record || record.schemaVersion !== 1) return undefined;
  const parsedRecords = parseRecordMap(record.records);
  if (!parsedRecords) return undefined;
  const { records } = parsedRecords;
  const unresolvedCount = Object.values(records).filter(isUnresolvedParsedIntent).length;
  if (unresolvedCount > MAX_PENDING_CAPTURE_RUN_INTENTS) return undefined;
  const built = buildIndex(records);
  if (!built.ok) return undefined;
  const hintedOrder = parseOrderHint(record.orderedCommandIds);
  if (!hintedOrder || hintedOrder.some((commandId) => !records[commandId])) return undefined;
  const repairNeeded =
    parsedRecords.normalizedLegacy ||
    !arraysEqual(hintedOrder, built.index.orderedCommandIds) ||
    built.prunedCommandIds.length > 0;
  return {
    index: built.index,
    repairNeeded,
    prunedCommandIds: built.prunedCommandIds,
  };
}

async function readStoredIndex(): Promise<
  { ok: true; parsed: ParsedIndex } | CaptureRunIntentFailure
> {
  try {
    const values: unknown = await chrome.storage.session.get(CAPTURE_RUN_INTENTS_STORAGE_KEY);
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      return { ok: false, reason: "storage_corrupt", key: CAPTURE_RUN_INTENTS_STORAGE_KEY };
    }
    const descriptor = Object.getOwnPropertyDescriptor(values, CAPTURE_RUN_INTENTS_STORAGE_KEY);
    if (descriptor && !("value" in descriptor)) {
      return { ok: false, reason: "storage_corrupt", key: CAPTURE_RUN_INTENTS_STORAGE_KEY };
    }
    const parsed = parseIndex(descriptor && "value" in descriptor ? descriptor.value : undefined);
    return parsed
      ? { ok: true, parsed }
      : { ok: false, reason: "storage_corrupt", key: CAPTURE_RUN_INTENTS_STORAGE_KEY };
  } catch {
    return unavailable("get", "unknown");
  }
}

type WriteReadBack = "committed" | "absent" | "unknown";

async function readBackWrite(
  expected: CaptureRunIntentV1 | null,
  previous: CaptureRunIntentV1 | null,
  expectedIndexWhenNoIntent?: CaptureRunIntentIndexV1,
): Promise<WriteReadBack> {
  const read = await readStoredIndex();
  if (!read.ok) return "unknown";
  if (expected) {
    const stored = read.parsed.index.records[expected.commandId];
    if (stored && intentsEqual(stored, expected)) return "committed";
    if (!stored || (previous && intentsEqual(stored, previous))) return "absent";
    return "unknown";
  }
  if (!expectedIndexWhenNoIntent) return "unknown";
  const current = read.parsed.index;
  if (
    !read.parsed.repairNeeded &&
    arraysEqual(current.orderedCommandIds, expectedIndexWhenNoIntent.orderedCommandIds) &&
    current.orderedCommandIds.every((commandId) =>
      intentsEqual(current.records[commandId], expectedIndexWhenNoIntent.records[commandId]),
    )
  ) {
    return "committed";
  }
  return "absent";
}

async function writeIndex(
  index: CaptureRunIntentIndexV1,
  expected: CaptureRunIntentV1 | null,
  previous: CaptureRunIntentV1 | null,
): Promise<"committed" | CaptureRunIntentFailure> {
  try {
    await chrome.storage.session.set({ [CAPTURE_RUN_INTENTS_STORAGE_KEY]: index });
    return "committed";
  } catch {
    const commitState = await readBackWrite(expected, previous, expected ? undefined : index);
    return commitState === "committed"
      ? "committed"
      : unavailable("set", commitState);
  }
}

/**
 * SHA-256 identity for a guarded, canonical execution plan. The return value
 * can be stored in an intent; no plan contents leave this function.
 */
export async function digestCaptureRunExecutionPlan(
  plan: unknown,
  headerLeaseIdsByItemId: unknown = {},
): Promise<string | undefined> {
  try {
    if (!isCaptureReviewPlanV1(plan)) return undefined;
    const canonical: CaptureReviewPlanV1 = cloneCaptureReviewPlan(plan);
    const canonicalLeaseIds = canonicalizeCaptureHeaderLeaseIdsByItemId(
      canonical,
      headerLeaseIdsByItemId,
    );
    if (!canonicalLeaseIds) return undefined;
    const headerLeaseIds = canonical.items.flatMap((item) => {
      const leaseId = canonicalLeaseIds[item.itemId];
      return leaseId === undefined ? [] : [[item.itemId, leaseId]];
    });
    // Preserve pre-C2 plan-only digests for an in-flight empty-map session;
    // any actual lease binding moves to the versioned execution envelope.
    const serialized = headerLeaseIds.length === 0
      ? JSON.stringify(canonical)
      : JSON.stringify({ schemaVersion: 1, plan: canonical, headerLeaseIds });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return undefined;
  }
}

/** Gets one frozen intent without writing or importing any media data. */
export async function getCaptureRunIntent(commandId: string): Promise<GetCaptureRunIntentResult> {
  const canonicalId = canonicalCommandId(commandId);
  if (!canonicalId) return invalidInput("commandId must be capture-run-<uuid>.");
  const read = await readStoredIndex();
  if (!read.ok) return read;
  const intent = read.parsed.index.records[canonicalId];
  return {
    ok: true,
    intent: intent ? cloneIntent(intent) : null,
    repairNeeded: read.parsed.repairNeeded,
  };
}

/** Lists newest-first canonical records for recovery/reconciliation. */
export async function listCaptureRunIntents(): Promise<ListCaptureRunIntentsResult> {
  const read = await readStoredIndex();
  if (!read.ok) return read;
  return {
    ok: true,
    intents: read.parsed.index.orderedCommandIds.map((commandId) =>
      cloneIntent(read.parsed.index.records[commandId]),
    ),
    repairNeeded: read.parsed.repairNeeded,
  };
}

/** Returns the newest replay blocker, independent of the active draft/plan. */
export async function getNewestUnresolvedCaptureRunIntent(): Promise<
  GetNewestUnresolvedCaptureRunIntentResult
> {
  const read = await readStoredIndex();
  if (!read.ok) return read;
  const commandId = read.parsed.index.orderedCommandIds.find((candidate) =>
    isUnresolvedParsedIntent(read.parsed.index.records[candidate]),
  );
  return {
    ok: true,
    intent: commandId ? cloneIntent(read.parsed.index.records[commandId]) : null,
    repairNeeded: read.parsed.repairNeeded,
  };
}

/**
 * Creates the decision boundary. The request identity excludes re-evaluated
 * license/allocation fields, so a same-request retry receives the first frozen
 * decision rather than silently changing it.
 */
export async function createCaptureRunIntent(
  rawInput: CaptureRunIntentCreateInput,
): Promise<CreateCaptureRunIntentResult> {
  const input = parseCreateInput(rawInput);
  if (!input) return invalidInput("Capture Run intent input is invalid.");
  return withKeyLock(CAPTURE_RUN_INTENTS_STORAGE_KEY, async () => {
    const read = await readStoredIndex();
    if (!read.ok) return read;
    const existing = read.parsed.index.records[input.commandId];
    if (existing) {
      return requestMatchesParsed(existing, input)
        ? {
            ok: true,
            changed: false,
            replayed: true,
            commitState: "committed",
            intent: cloneIntent(existing),
            // A replay does not persist an otherwise repairable compaction.
            prunedCommandIds: [],
          }
        : {
            ok: false,
            reason: "command_conflict",
            commandId: input.commandId,
            intent: cloneIntent(existing),
          };
    }
    const unresolvedCommandId = read.parsed.index.orderedCommandIds.find((commandId) =>
      isUnresolvedParsedIntent(read.parsed.index.records[commandId]),
    );
    if (unresolvedCommandId) {
      return {
        ok: false,
        reason: "unresolved_intent",
        commandId: unresolvedCommandId,
        intent: cloneIntent(read.parsed.index.records[unresolvedCommandId]),
      };
    }
    const unresolvedCount = Object.values(read.parsed.index.records)
      .filter(isUnresolvedParsedIntent).length;
    if (unresolvedCount >= MAX_PENDING_CAPTURE_RUN_INTENTS) {
      return {
        ok: false,
        reason: "pending_capacity",
        limit: MAX_PENDING_CAPTURE_RUN_INTENTS,
      };
    }
    const intent: CaptureRunIntentV1 = {
      schemaVersion: 1,
      ...input,
      ...DEFAULT_AUTO_RECONCILE_STATE,
      status: "pending",
    };
    const source = {
      ...read.parsed.index.records,
      [intent.commandId]: intent,
    };
    const built = buildIndex(source, intent.commandId);
    if (!built.ok) return built;
    const written = await writeIndex(built.index, intent, null);
    if (written !== "committed") return written;
    return {
      ok: true,
      changed: true,
      replayed: false,
      commitState: "committed",
      intent: cloneIntent(intent),
      prunedCommandIds: [
        ...new Set([...read.parsed.prunedCommandIds, ...built.prunedCommandIds]),
      ],
    };
  });
}

/**
 * Records the coordinator's durable reconciliation result. Only `accepted`
 * settles the intent; ambiguous dispositions remain replay blockers.
 */
export async function finalizeCaptureRunIntent(input: {
  commandId: string;
  runId: string;
  disposition: CaptureRunIntentReconciliationDisposition;
}): Promise<FinalizeCaptureRunIntentResult> {
  const record = exactDataRecord(input, ["commandId", "runId", "disposition"]);
  const commandId = record ? canonicalCommandId(record.commandId) : undefined;
  if (
    !record || !commandId || !safeId(record.runId) ||
    (record.disposition !== "accepted" &&
      record.disposition !== "recovery_needed" &&
      record.disposition !== "commit_state_unknown")
  ) {
    return invalidInput("Finalize input is invalid.");
  }
  const runId = record.runId;
  const disposition = record.disposition;
  return withKeyLock(CAPTURE_RUN_INTENTS_STORAGE_KEY, async () => {
    const read = await readStoredIndex();
    if (!read.ok) return read;
    const existing = read.parsed.index.records[commandId];
    if (!existing) return { ok: false, reason: "intent_not_found", commandId };
    if (existing.status === "committed") {
      if (existing.runId !== runId) {
        return {
          ok: false,
          reason: "run_conflict",
          commandId,
          existingRunId: existing.runId,
        };
      }
      const nextDisposition: CaptureRunIntentReconciliationDisposition =
        existing.reconciliationDisposition === "accepted" || disposition === "accepted"
          ? "accepted"
          : existing.reconciliationDisposition === "recovery_needed" ||
              disposition === "recovery_needed"
            ? "recovery_needed"
            : "commit_state_unknown";
      if (nextDisposition === existing.reconciliationDisposition) {
        return {
            ok: true,
            changed: false,
            commitState: "committed",
            intent: cloneIntent(existing) as Extract<CaptureRunIntentV1, { status: "committed" }>,
            // A replay does not persist an otherwise repairable compaction.
            prunedCommandIds: [],
          };
      }
      const intent: Extract<CaptureRunIntentV1, { status: "committed" }> = {
        ...withAutoReconcileState(
          existing,
          nextDisposition === "accepted"
            ? DEFAULT_AUTO_RECONCILE_STATE
            : {
                autoReconcileAttemptCount: existing.autoReconcileAttemptCount,
                ...(existing.autoReconcileLastAttemptAt === undefined
                  ? {}
                  : { autoReconcileLastAttemptAt: existing.autoReconcileLastAttemptAt }),
                needsManualReconcile: existing.needsManualReconcile,
              },
        ),
        status: "committed",
        runId,
        reconciliationDisposition: nextDisposition,
      };
      const source = { ...read.parsed.index.records, [commandId]: intent };
      const built = buildIndex(source, commandId);
      if (!built.ok) return built;
      const written = await writeIndex(built.index, intent, existing);
      if (written !== "committed") return written;
      return {
        ok: true,
        changed: true,
        commitState: "committed",
        intent: cloneIntent(intent) as Extract<CaptureRunIntentV1, { status: "committed" }>,
        prunedCommandIds: [
          ...new Set([...read.parsed.prunedCommandIds, ...built.prunedCommandIds]),
        ],
      };
    }
    const intent: Extract<CaptureRunIntentV1, { status: "committed" }> = {
      ...withAutoReconcileState(
        existing,
        disposition === "accepted"
          ? DEFAULT_AUTO_RECONCILE_STATE
          : {
              autoReconcileAttemptCount: existing.autoReconcileAttemptCount,
              ...(existing.autoReconcileLastAttemptAt === undefined
                ? {}
                : { autoReconcileLastAttemptAt: existing.autoReconcileLastAttemptAt }),
              needsManualReconcile: existing.needsManualReconcile,
            },
      ),
      status: "committed",
      runId,
      reconciliationDisposition: disposition,
    };
    const source = { ...read.parsed.index.records, [commandId]: intent };
    const built = buildIndex(source, commandId);
    if (!built.ok) return built;
    const written = await writeIndex(built.index, intent, existing);
    if (written !== "committed") return written;
    return {
      ok: true,
      changed: true,
      commitState: "committed",
      intent: cloneIntent(intent) as Extract<CaptureRunIntentV1, { status: "committed" }>,
      prunedCommandIds: [
        ...new Set([...read.parsed.prunedCommandIds, ...built.prunedCommandIds]),
      ],
    };
  });
}

export async function updateCaptureRunIntentAutoReconcileState(input: {
  commandId: string;
  state: AutoReconcileStateV1;
}): Promise<UpdateCaptureRunIntentAutoReconcileResult> {
  const record = exactDataRecord(input, ["commandId", "state"]);
  const commandId = record ? canonicalCommandId(record.commandId) : undefined;
  const state = record ? normalizeAutoReconcileState(record.state as Record<string, unknown>) : undefined;
  if (!record || !commandId || !state) {
    return invalidInput("Capture Run automatic reconcile update is invalid.");
  }
  return withKeyLock(CAPTURE_RUN_INTENTS_STORAGE_KEY, async () => {
    const read = await readStoredIndex();
    if (!read.ok) return read;
    const existing = read.parsed.index.records[commandId];
    if (!existing) return { ok: false, reason: "intent_not_found", commandId };
    const intent: CaptureRunIntentV1 = {
      ...withAutoReconcileState(existing, state),
    };
    if (intentsEqual(existing, intent)) {
      return {
        ok: true,
        changed: false,
        commitState: "committed",
        intent: cloneIntent(existing),
        prunedCommandIds: [],
      };
    }
    const source = { ...read.parsed.index.records, [commandId]: intent };
    const built = buildIndex(source, commandId);
    if (!built.ok) return built;
    const written = await writeIndex(built.index, intent, existing);
    if (written !== "committed") return written;
    return {
      ok: true,
      changed: true,
      commitState: "committed",
      intent: cloneIntent(intent),
      prunedCommandIds: [
        ...new Set([...read.parsed.prunedCommandIds, ...built.prunedCommandIds]),
      ],
    };
  });
}

/**
 * Removes a still-pending decision after the coordinator definitively rejects
 * before its durable acceptance boundary. Committed decisions are never
 * removed through this path.
 */
export async function abandonCaptureRunIntent(input: {
  commandId: string;
  executionPlanDigest: string;
}): Promise<AbandonCaptureRunIntentResult> {
  const record = exactDataRecord(input, ["commandId", "executionPlanDigest"]);
  const commandId = record ? canonicalCommandId(record.commandId) : undefined;
  if (
    !record || !commandId || typeof record.executionPlanDigest !== "string" ||
    !DIGEST_PATTERN.test(record.executionPlanDigest)
  ) {
    return invalidInput("Abandon input is invalid.");
  }
  return withKeyLock(CAPTURE_RUN_INTENTS_STORAGE_KEY, async () => {
    const read = await readStoredIndex();
    if (!read.ok) return read;
    const existing = read.parsed.index.records[commandId];
    if (!existing) return { ok: true, changed: false, commitState: "committed" };
    if (existing.status === "committed") {
      return {
        ok: false,
        reason: "run_conflict",
        commandId,
        existingRunId: existing.runId,
      };
    }
    if (existing.executionPlanDigest !== record.executionPlanDigest) {
      return {
        ok: false,
        reason: "command_conflict",
        commandId,
        intent: cloneIntent(existing),
      };
    }
    const records = { ...read.parsed.index.records };
    delete records[commandId];
    const built = buildIndex(records);
    if (!built.ok) return built;
    const written = await writeIndex(built.index, null, existing);
    if (written !== "committed") return written;
    return { ok: true, changed: true, commitState: "committed" };
  });
}

/** Canonicalizes index ordering and safely prunes settled records only. */
export async function repairCaptureRunIntentJournal(): Promise<
  RepairCaptureRunIntentJournalResult
> {
  return withKeyLock(CAPTURE_RUN_INTENTS_STORAGE_KEY, async () => {
    const read = await readStoredIndex();
    if (!read.ok) return read;
    const intents = read.parsed.index.orderedCommandIds.map((commandId) =>
      cloneIntent(read.parsed.index.records[commandId]),
    );
    if (!read.parsed.repairNeeded) {
      return {
        ok: true,
        changed: false,
        commitState: "committed",
        intents,
        prunedCommandIds: [],
      };
    }
    const written = await writeIndex(read.parsed.index, null, null);
    if (written !== "committed") return written;
    return {
      ok: true,
      changed: true,
      commitState: "committed",
      intents,
      prunedCommandIds: [...read.parsed.prunedCommandIds],
    };
  });
}
