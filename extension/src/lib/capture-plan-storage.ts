/**
 * Background-only session adapter for immutable Capture Review plans.
 * UI documents must route reads/writes through the service worker owner.
 */
import {
  CAPTURE_PACK_SCHEMA_VERSION,
  isPersistentStreamQualityChoiceV1,
  isCaptureReviewPlanV1,
  type CaptureReviewPlanV1,
} from "./capture-pack-types";
import { cloneCaptureReviewPlan } from "./capture-plan";
import { withKeyLock } from "./session-jobs";

export const CAPTURE_PLAN_INDEX_STORAGE_KEY = "capture-plans-v1";
export const CAPTURE_PLAN_STORAGE_PREFIX = "capture-plan-v1:";
export const CAPTURE_PLAN_STORAGE_OWNER = "background-service-worker" as const;
export const MAX_RECENT_CAPTURE_PLANS = 5;
export const MAX_RETAINED_CAPTURE_PLANS = MAX_RECENT_CAPTURE_PLANS + 1;
export const MAX_CAPTURE_PLAN_SERIALIZED_BYTES = 1024 * 1024;
const MAX_CAPTURE_PLAN_INDEX_BYTES = 16 * 1024;
export const MAX_CAPTURE_PLAN_STORAGE_BYTES =
  MAX_RETAINED_CAPTURE_PLANS * MAX_CAPTURE_PLAN_SERIALIZED_BYTES +
  MAX_CAPTURE_PLAN_INDEX_BYTES;
const MAX_ID_LENGTH = 256;
const UNSAFE_TEXT_PATTERN = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const CAPTURE_NEEDS_CHOICE_WARNING_CODES = new Set([
  "QUALITY_SELECTION_REQUIRED",
  "QUALITY_CONFIRMATION_REQUIRED",
  "QUALITY_FACTS_UNKNOWN",
]);

export type CapturePlanIndexV1 = {
  schemaVersion: typeof CAPTURE_PACK_SCHEMA_VERSION;
  activePlanId: string | null;
  orderedPlanIds: string[];
};

export type StoredCapturePlanResult =
  | { status: "empty" }
  | { status: "valid"; plan: CaptureReviewPlanV1; serializedBytes: number }
  | {
      status: "invalid";
      reason: "corrupt" | "future_schema" | "serialized_byte_limit";
      schemaVersion?: number;
      measuredBytes?: number;
    };

export type StoredCapturePlanIndexResult =
  | { status: "empty" }
  | { status: "valid"; index: CapturePlanIndexV1 }
  | {
      status: "invalid";
      reason: "corrupt" | "future_schema" | "serialized_byte_limit";
      schemaVersion?: number;
      measuredBytes?: number;
    };

export type CapturePlanStorageFailure =
  | {
      ok: false;
      reason: "invalid_plan" | "serialized_byte_limit";
      message: string;
      measuredBytes?: number;
      committed: false;
    }
  | {
      ok: false;
      reason: "storage_corrupt" | "storage_future_schema";
      key: string;
      schemaVersion?: number;
      committed: false;
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
      reason: "conflict";
      conflict: "plan_id_exists" | "plan_superseded";
      planId: string;
      activePlanId?: string;
      committed: false;
    };

type CapturePlanStorageUnavailable = Extract<
  CapturePlanStorageFailure,
  { reason: "storage_unavailable" }
>;

export type SaveCapturePlanResult =
  | {
      ok: true;
      changed: boolean;
      plan: CaptureReviewPlanV1;
      prunedPlanIds: string[];
    }
  | CapturePlanStorageFailure;

export type ReadCapturePlanResult =
  | { ok: true; plan: CaptureReviewPlanV1 | null }
  | CapturePlanStorageFailure;

export type ListCapturePlansResult =
  | { ok: true; activePlanId: string | null; plans: CaptureReviewPlanV1[] }
  | CapturePlanStorageFailure;

export type ClearCapturePlansResult =
  | { ok: true; removedPlanIds: string[]; preservedPlanIds: string[] }
  | CapturePlanStorageFailure;

type UnknownRecord = Record<string, unknown>;

function planKey(planId: string): string {
  return `${CAPTURE_PLAN_STORAGE_PREFIX}${planId}`;
}

function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value === value.trim() &&
    !UNSAFE_TEXT_PATTERN.test(value)
  );
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
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

function futureSchemaVersion(value: unknown): number | undefined {
  try {
    const record = asRecord(value);
    if (!record) return undefined;
    const version = Object.getOwnPropertyDescriptor(record, "schemaVersion")?.value;
    return typeof version === "number" && Number.isSafeInteger(version) && version > 1
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

function emptyIndex(): CapturePlanIndexV1 {
  return { schemaVersion: CAPTURE_PACK_SCHEMA_VERSION, activePlanId: null, orderedPlanIds: [] };
}

function canonicalIndex(index: CapturePlanIndexV1): CapturePlanIndexV1 {
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    activePlanId: index.activePlanId,
    orderedPlanIds: [...index.orderedPlanIds],
  };
}

function isStorageSafePlan(plan: CaptureReviewPlanV1): boolean {
  const pathKeys = new Set<string>();
  const reservedManifestPaths = new Set(
    (plan.manifestSpec?.formats ?? []).map((format) =>
      `${plan.relativeRoot}/_cliphutch-manifest.${format}`
        .normalize("NFC")
        .toLocaleLowerCase("en-US")),
  );
  return (
    safeId(plan.planId) &&
    safeId(plan.draftId) &&
    plan.items.every(
      (item) => {
        const pathKey = item.plannedRelativePath.normalize("NFC").toLocaleLowerCase("en-US");
        if (pathKeys.has(pathKey) || reservedManifestPaths.has(pathKey)) return false;
        pathKeys.add(pathKey);
        if (
          !safeId(item.itemId) ||
          !safeId(item.media.mediaId) ||
          item.copyChoice.candidateId !== item.media.mediaId ||
          !safeId(item.copyChoice.candidateId) ||
          UNSAFE_TEXT_PATTERN.test(item.copyChoice.reason) ||
          item.warnings.length > 10 ||
          item.warnings.some(
            (warning) =>
              !safeId(warning.code) ||
              UNSAFE_TEXT_PATTERN.test(warning.message),
          )
        ) {
          return false;
        }
        if (item.readiness === "ready") {
          const quality = item.qualityChoice;
          if (item.media.kind === "direct" || item.media.kind === "image") {
            return quality.mode === "direct";
          }
          if (
            quality.mode !== "stream" ||
            (quality.label !== undefined && UNSAFE_TEXT_PATTERN.test(quality.label))
          ) return false;

          if (isPersistentStreamQualityChoiceV1(quality)) {
            return quality.selector.kind === item.media.kind &&
              safeId(quality.selector.stableId);
          }

          // Raw HLS/DASH locators are read-only compatibility for the Quick
          // Capture fast path. Normal Capture Pack plans must use the opaque
          // persistent selector contract above.
          if (!plan.planId.startsWith("capture-single-plan:")) return false;
          if (quality.variantKind === "hls") return item.media.kind === "hls";
          if (quality.variantKind === "dash") {
            return item.media.kind === "dash" && safeId(quality.representationId);
          }
          return safeId(quality.fixedVariantId);
        }
        if (item.readiness === "needs_choice") {
          return (item.media.kind === "hls" || item.media.kind === "dash") &&
            item.warnings.some((warning) =>
              CAPTURE_NEEDS_CHOICE_WARNING_CODES.has(warning.code),
            );
        }
        return item.warnings.length > 0;
      },
    )
  );
}

export function parseStoredCapturePlan(value: unknown): StoredCapturePlanResult {
  if (value === undefined) return { status: "empty" };
  try {
    const measuredBytes = serializedBytes(value);
    if (measuredBytes === undefined) return { status: "invalid", reason: "corrupt" };
    if (measuredBytes > MAX_CAPTURE_PLAN_SERIALIZED_BYTES) {
      return { status: "invalid", reason: "serialized_byte_limit", measuredBytes };
    }
    if (!isCaptureReviewPlanV1(value) || !isStorageSafePlan(value)) {
      const version = futureSchemaVersion(value);
      return version === undefined
        ? { status: "invalid", reason: "corrupt" }
        : { status: "invalid", reason: "future_schema", schemaVersion: version };
    }
    const canonical = cloneCaptureReviewPlan(value);
    const canonicalBytes = serializedBytes(canonical);
    if (canonicalBytes === undefined) return { status: "invalid", reason: "corrupt" };
    if (canonicalBytes > MAX_CAPTURE_PLAN_SERIALIZED_BYTES) {
      return {
        status: "invalid",
        reason: "serialized_byte_limit",
        measuredBytes: canonicalBytes,
      };
    }
    // Untrusted accessors may change between the raw validation reads and the
    // canonical clone. Validate the exact data object that will be returned or
    // persisted so a successful parse can never carry an invalid typed plan.
    if (!isCaptureReviewPlanV1(canonical) || !isStorageSafePlan(canonical)) {
      return { status: "invalid", reason: "corrupt" };
    }
    return {
      status: "valid",
      plan: canonical,
      serializedBytes: canonicalBytes,
    };
  } catch {
    return { status: "invalid", reason: "corrupt" };
  }
}

export function parseStoredCapturePlanIndex(value: unknown): StoredCapturePlanIndexResult {
  if (value === undefined) return { status: "empty" };
  try {
    const measuredBytes = serializedBytes(value);
    if (measuredBytes === undefined) return { status: "invalid", reason: "corrupt" };
    if (measuredBytes > MAX_CAPTURE_PLAN_INDEX_BYTES) {
      return { status: "invalid", reason: "serialized_byte_limit", measuredBytes };
    }
    const record = asRecord(value);
    if (!record) return { status: "invalid", reason: "corrupt" };
    if (record.schemaVersion !== CAPTURE_PACK_SCHEMA_VERSION) {
      const version = futureSchemaVersion(record);
      return version === undefined
        ? { status: "invalid", reason: "corrupt" }
        : { status: "invalid", reason: "future_schema", schemaVersion: version };
    }
    if (
      !Array.isArray(record.orderedPlanIds) ||
      record.orderedPlanIds.length > MAX_RETAINED_CAPTURE_PLANS ||
      !record.orderedPlanIds.every(safeId) ||
      new Set(record.orderedPlanIds).size !== record.orderedPlanIds.length ||
      (record.activePlanId !== null && !safeId(record.activePlanId)) ||
      (record.orderedPlanIds.length === 0 && record.activePlanId !== null) ||
      (record.activePlanId !== null && record.orderedPlanIds[0] !== record.activePlanId)
    ) {
      return { status: "invalid", reason: "corrupt" };
    }
    return {
      status: "valid",
      index: {
        schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
        activePlanId: record.activePlanId,
        orderedPlanIds: [...record.orderedPlanIds],
      },
    };
  } catch {
    return { status: "invalid", reason: "corrupt" };
  }
}

function storageFailure(
  key: string,
  parsed: Extract<StoredCapturePlanResult | StoredCapturePlanIndexResult, { status: "invalid" }>,
): CapturePlanStorageFailure {
  if (parsed.reason === "future_schema") {
    return {
      ok: false,
      reason: "storage_future_schema",
      key,
      schemaVersion: parsed.schemaVersion,
      committed: false,
    };
  }
  return { ok: false, reason: "storage_corrupt", key, committed: false };
}

function unavailable(
  operation: "get" | "set" | "remove",
  error: unknown,
  committed = false,
): CapturePlanStorageUnavailable {
  return {
    ok: false,
    reason: "storage_unavailable",
    operation,
    message: error instanceof Error ? error.message : "Chrome session storage is unavailable.",
    committed,
  };
}

async function getSession(keys: string | string[] | null): Promise<
  { ok: true; values: Record<string, unknown> } | CapturePlanStorageUnavailable
> {
  try {
    const values: Record<string, unknown> = await chrome.storage.session.get(keys);
    return { ok: true, values };
  } catch (error) {
    return unavailable("get", error);
  }
}

async function removeOrphanPlanRecords(
  index: CapturePlanIndexV1,
  preservePlanIds: readonly string[] = [],
): Promise<{ ok: true; removedPlanIds: string[] } | CapturePlanStorageUnavailable> {
  const stored = await getSession(null);
  if (!stored.ok) return stored;
  const retained = new Set([...index.orderedPlanIds, ...preservePlanIds]);
  const removedPlanIds = Object.keys(stored.values)
    .filter((key) => key.startsWith(CAPTURE_PLAN_STORAGE_PREFIX))
    .map((key) => key.slice(CAPTURE_PLAN_STORAGE_PREFIX.length))
    .filter((planId) => safeId(planId) && !retained.has(planId));
  const removed = await removeSession(removedPlanIds.map(planKey));
  return removed.ok ? { ok: true, removedPlanIds } : removed;
}

async function setSession(values: Record<string, unknown>): Promise<
  { ok: true } | CapturePlanStorageUnavailable
> {
  try {
    await chrome.storage.session.set(values);
    return { ok: true };
  } catch (error) {
    return unavailable("set", error);
  }
}

async function removeSession(keys: string[]): Promise<
  { ok: true } | CapturePlanStorageUnavailable
> {
  if (keys.length === 0) return { ok: true };
  try {
    await chrome.storage.session.remove(keys);
    return { ok: true };
  } catch (error) {
    return unavailable("remove", error, true);
  }
}

async function readIndex(): Promise<
  { ok: true; index: CapturePlanIndexV1 } | CapturePlanStorageFailure
> {
  const stored = await getSession(CAPTURE_PLAN_INDEX_STORAGE_KEY);
  if (!stored.ok) return stored;
  const parsed = parseStoredCapturePlanIndex(stored.values[CAPTURE_PLAN_INDEX_STORAGE_KEY]);
  if (parsed.status === "invalid") return storageFailure(CAPTURE_PLAN_INDEX_STORAGE_KEY, parsed);
  return { ok: true, index: parsed.status === "empty" ? emptyIndex() : parsed.index };
}

function plansEqual(left: CaptureReviewPlanV1, right: CaptureReviewPlanV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type SaveReadBack =
  | { status: "committed"; plan: CaptureReviewPlanV1 }
  | { status: "absent" }
  | { status: "unknown" };

async function readBackSave(plan: CaptureReviewPlanV1): Promise<SaveReadBack> {
  const key = planKey(plan.planId);
  const stored = await getSession([CAPTURE_PLAN_INDEX_STORAGE_KEY, key]);
  if (!stored.ok) return { status: "unknown" };
  const parsedIndex = parseStoredCapturePlanIndex(stored.values[CAPTURE_PLAN_INDEX_STORAGE_KEY]);
  const parsedPlan = parseStoredCapturePlan(stored.values[key]);
  if (parsedIndex.status === "invalid" || parsedPlan.status === "invalid") {
    return { status: "unknown" };
  }
  if (parsedPlan.status === "empty") {
    const indexed = parsedIndex.status === "valid" && parsedIndex.index.orderedPlanIds.includes(plan.planId);
    return indexed ? { status: "unknown" } : { status: "absent" };
  }
  if (
    parsedIndex.status !== "valid" ||
    parsedIndex.index.activePlanId !== plan.planId ||
    !parsedIndex.index.orderedPlanIds.includes(plan.planId) ||
    !plansEqual(parsedPlan.plan, plan)
  ) {
    return { status: "unknown" };
  }
  return { status: "committed", plan: parsedPlan.plan };
}

async function readPlanForIndex(
  planId: string,
  index: CapturePlanIndexV1,
): Promise<ReadCapturePlanResult> {
  if (!index.orderedPlanIds.includes(planId)) return { ok: true, plan: null };
  const key = planKey(planId);
  const stored = await getSession(key);
  if (!stored.ok) return stored;
  const parsed = parseStoredCapturePlan(stored.values[key]);
  if (parsed.status === "invalid") return storageFailure(key, parsed);
  if (parsed.status === "empty" || parsed.plan.planId !== planId) {
    return { ok: false, reason: "storage_corrupt", key, committed: false };
  }
  return { ok: true, plan: parsed.plan };
}

/** Saves a generated immutable plan and makes it the active review plan. */
export async function saveCaptureReviewPlan(
  rawPlan: CaptureReviewPlanV1,
): Promise<SaveCapturePlanResult> {
  const parsedInput = parseStoredCapturePlan(rawPlan);
  if (parsedInput.status !== "valid") {
    return parsedInput.status === "invalid" && parsedInput.reason === "serialized_byte_limit"
      ? {
          ok: false,
          reason: "serialized_byte_limit",
          message: "Capture Review plan exceeds the 1 MiB record limit.",
          measuredBytes: parsedInput.measuredBytes,
          committed: false,
        }
      : {
          ok: false,
          reason: "invalid_plan",
          message: "Capture Review plan is invalid.",
          committed: false,
        };
  }
  const plan = parsedInput.plan;

  return withKeyLock(CAPTURE_PLAN_INDEX_STORAGE_KEY, async () => {
    const current = await readIndex();
    if (!current.ok) return current;
    const key = planKey(plan.planId);
    const existingStored = await getSession(key);
    if (!existingStored.ok) return existingStored;
    const existing = parseStoredCapturePlan(existingStored.values[key]);
    if (existing.status === "invalid") return storageFailure(key, existing);
    const swept = await removeOrphanPlanRecords(current.index, [plan.planId]);
    if (!swept.ok) return swept;
    if (existing.status === "valid") {
      if (!plansEqual(existing.plan, plan)) {
        return {
          ok: false,
          reason: "conflict",
          conflict: "plan_id_exists",
          planId: plan.planId,
          committed: false,
        };
      }
      if (current.index.orderedPlanIds.includes(plan.planId)) {
        if (current.index.activePlanId !== plan.planId) {
          return {
            ok: false,
            reason: "conflict",
            conflict: "plan_superseded",
            planId: plan.planId,
            ...(current.index.activePlanId === null
              ? {}
              : { activePlanId: current.index.activePlanId }),
            committed: false,
          };
        }
        return {
          ok: true,
          changed: false,
          plan: cloneCaptureReviewPlan(existing.plan),
          prunedPlanIds: swept.removedPlanIds,
        };
      }
      // A matching unindexed record is the recoverable plan-only half of an
      // ambiguous multi-key set. The immutable content must match exactly
      // before the index can be repaired below.
    }
    if (current.index.orderedPlanIds.includes(plan.planId)) {
      if (current.index.activePlanId !== plan.planId) {
        return { ok: false, reason: "storage_corrupt", key, committed: false };
      }
      // The active index entry without its record is the other recoverable
      // half. Writing the exact retry input below restores the invariant.
    }

    const ordered = [
      plan.planId,
      ...current.index.orderedPlanIds.filter((planId) => planId !== plan.planId),
    ];
    const retainedPlanIds = ordered.slice(0, MAX_RETAINED_CAPTURE_PLANS);
    const prunedPlanIds = ordered.slice(MAX_RETAINED_CAPTURE_PLANS);
    const nextIndex: CapturePlanIndexV1 = {
      schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
      activePlanId: plan.planId,
      orderedPlanIds: retainedPlanIds,
    };
    const indexBytes = serializedBytes(nextIndex);
    if (indexBytes === undefined || indexBytes > MAX_CAPTURE_PLAN_INDEX_BYTES) {
      return {
        ok: false,
        reason: "invalid_plan",
        message: "Capture Review plan index exceeds its bounded size.",
        committed: false,
      };
    }
    const written = await setSession({
      [CAPTURE_PLAN_INDEX_STORAGE_KEY]: canonicalIndex(nextIndex),
      [key]: cloneCaptureReviewPlan(plan),
    });
    if (!written.ok) {
      const readBack = await readBackSave(plan);
      if (readBack.status === "absent") return { ...written, committed: false };
      if (readBack.status === "unknown") return { ...written, committed: true };
      const removedAfterReadBack = await removeSession(prunedPlanIds.map(planKey));
      if (!removedAfterReadBack.ok) return removedAfterReadBack;
      return {
        ok: true,
        changed: true,
        plan: cloneCaptureReviewPlan(readBack.plan),
        prunedPlanIds: [...swept.removedPlanIds, ...prunedPlanIds],
      };
    }
    const removed = await removeSession(prunedPlanIds.map(planKey));
    if (!removed.ok) return removed;
    return {
      ok: true,
      changed: true,
      plan: cloneCaptureReviewPlan(plan),
      prunedPlanIds: [...swept.removedPlanIds, ...prunedPlanIds],
    };
  });
}

/** Background-owned read of the plan currently shown by Review. */
export async function getActiveCaptureReviewPlan(): Promise<ReadCapturePlanResult> {
  return withKeyLock(CAPTURE_PLAN_INDEX_STORAGE_KEY, async () => {
    const current = await readIndex();
    if (!current.ok) return current;
    if (current.index.activePlanId === null) return { ok: true, plan: null };
    return readPlanForIndex(current.index.activePlanId, current.index);
  });
}

export async function getCaptureReviewPlan(planId: string): Promise<ReadCapturePlanResult> {
  if (!safeId(planId)) {
    return {
      ok: false,
      reason: "invalid_plan",
      message: "planId must be a bounded identifier.",
      committed: false,
    };
  }
  return withKeyLock(CAPTURE_PLAN_INDEX_STORAGE_KEY, async () => {
    const current = await readIndex();
    if (!current.ok) return current;
    return readPlanForIndex(planId, current.index);
  });
}

export async function listCaptureReviewPlans(): Promise<ListCapturePlansResult> {
  return withKeyLock(CAPTURE_PLAN_INDEX_STORAGE_KEY, async () => {
    const current = await readIndex();
    if (!current.ok) return current;
    const keys = current.index.orderedPlanIds.map(planKey);
    const stored = await getSession(keys);
    if (!stored.ok) return stored;
    const plans: CaptureReviewPlanV1[] = [];
    for (const planId of current.index.orderedPlanIds) {
      const key = planKey(planId);
      const parsed = parseStoredCapturePlan(stored.values[key]);
      if (parsed.status === "invalid") return storageFailure(key, parsed);
      if (parsed.status === "empty" || parsed.plan.planId !== planId) {
        return { ok: false, reason: "storage_corrupt", key, committed: false };
      }
      plans.push(parsed.plan);
    }
    return {
      ok: true,
      activePlanId: current.index.activePlanId,
      plans: plans.map(cloneCaptureReviewPlan),
    };
  });
}

/**
 * Clears the customer-visible active Review and removes every immutable plan
 * not required by an unresolved/active run. A protected historical plan may
 * remain addressable by ID without becoming the active Review again.
 */
export async function clearUnreferencedCaptureReviewPlans(
  rawPreservePlanIds: readonly string[],
): Promise<ClearCapturePlansResult> {
  if (
    !Array.isArray(rawPreservePlanIds) ||
    rawPreservePlanIds.length > 200 ||
    !rawPreservePlanIds.every(safeId) ||
    new Set(rawPreservePlanIds).size !== rawPreservePlanIds.length
  ) {
    return {
      ok: false,
      reason: "invalid_plan",
      message: "Protected plan IDs are invalid.",
      committed: false,
    };
  }
  const preservePlanIds = new Set(rawPreservePlanIds);
  return withKeyLock(CAPTURE_PLAN_INDEX_STORAGE_KEY, async () => {
    const current = await readIndex();
    if (!current.ok) return current;
    const retainedPlanIds = current.index.orderedPlanIds.filter((planId) =>
      preservePlanIds.has(planId));
    const removedPlanIds = current.index.orderedPlanIds.filter((planId) =>
      !preservePlanIds.has(planId));
    const nextIndex: CapturePlanIndexV1 = {
      schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
      activePlanId: null,
      orderedPlanIds: retainedPlanIds,
    };
    const written = await setSession({
      [CAPTURE_PLAN_INDEX_STORAGE_KEY]: canonicalIndex(nextIndex),
    });
    if (!written.ok) return written;
    const removed = await removeOrphanPlanRecords(nextIndex);
    if (!removed.ok) return removed;
    return {
      ok: true,
      removedPlanIds: [...new Set([...removedPlanIds, ...removed.removedPlanIds])],
      preservedPlanIds: [...retainedPlanIds],
    };
  });
}
