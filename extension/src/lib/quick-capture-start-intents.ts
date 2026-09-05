/**
 * Background-only, session-scoped acceptance journal for the toolbar's
 * one-item Quick Capture path.
 *
 * The first validated plan and entitlement decision are authoritative. A
 * replay receives that frozen decision; it never rebuilds a plan from current
 * tab state or re-evaluates entitlement. Only the plan's canonical allowlist is
 * persisted, so caller-added headers, selectors, or URLs cannot hitchhike into
 * storage.
 */
import {
  isCaptureReviewPlanV1,
  type CaptureReviewPlanV1,
} from "./capture-pack-types";
import type { CaptureHeaderLeaseBindingV1 } from "./capture-header-leases";
import { cloneCaptureReviewPlan } from "./capture-plan";
import {
  canonicalizeCaptureHeaderLeaseIdsByItemId,
  type CaptureHeaderLeaseIdsByItemId,
} from "./capture-plan-options";
import { withKeyLock } from "./session-jobs";

export const QUICK_CAPTURE_START_INTENTS_STORAGE_KEY =
  "quick-capture-start-intents-v1";
export const MAX_SETTLED_QUICK_CAPTURE_START_INTENTS = 20;
export const MAX_QUICK_CAPTURE_START_INTENTS_BYTES = 2 * 1024 * 1024;
export const MAX_QUICK_CAPTURE_FROZEN_PLAN_BYTES = 256 * 1024;

const MAX_RAW_RECORDS = MAX_SETTLED_QUICK_CAPTURE_START_INTENTS + 1;
const MAX_PLAIN_DATA_DEPTH = 20;
const MAX_PLAIN_DATA_NODES = 4_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_DATA_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type QuickCaptureStartIdentityV1 = {
  commandId: string;
  coordinatorCommandId: string;
  runId: string;
  planId: string;
  draftId: string;
  itemId: string;
};

export type QuickCaptureStartDisposition =
  | "accepted"
  | "recovery_needed"
  | "commit_state_unknown";

export type QuickCaptureStartIntentCreateInput = {
  commandId: string;
  plan: CaptureReviewPlanV1;
  /** The first authoritative background entitlement decision. */
  licensed: boolean;
  /** Explicit null means this start needs no header lease. Undefined is legacy-only. */
  headerLease?: QuickCaptureStartHeaderLeaseV1 | null;
};

export type QuickCaptureStartHeaderLeaseV1 = {
  binding: CaptureHeaderLeaseBindingV1;
  owner: {
    runId: string;
    jobId: string;
    attemptId: string;
  };
  headerLeaseIdsByItemId: CaptureHeaderLeaseIdsByItemId;
  expiresAt: number;
};

type QuickCaptureStartIntentBaseV1 = {
  schemaVersion: 1;
  commandId: string;
  coordinatorCommandId: string;
  runId: string;
  licensed: boolean;
  plan: CaptureReviewPlanV1;
  createdAt: number;
  headerLease?: QuickCaptureStartHeaderLeaseV1 | null;
};

export type QuickCaptureStartIntentV1 =
  | (QuickCaptureStartIntentBaseV1 & { status: "pending" })
  | (QuickCaptureStartIntentBaseV1 & {
      status: "committed";
      reconciliationDisposition: QuickCaptureStartDisposition;
    });

type QuickCaptureStartIntentIndexV1 = {
  schemaVersion: 1;
  orderedCommandIds: string[];
  records: Record<string, QuickCaptureStartIntentV1>;
};

export type QuickCaptureStartIntentFailure =
  | { ok: false; reason: "invalid_input"; message: string }
  | { ok: false; reason: "storage_corrupt"; key: string }
  | {
      ok: false;
      reason: "storage_unavailable";
      operation: "get" | "set";
      commitState: "absent" | "unknown";
      message: string;
    }
  | {
      ok: false;
      reason: "serialized_byte_limit";
      limit: number;
    }
  | {
      ok: false;
      reason: "unresolved_intent";
      commandId: string;
      intent: QuickCaptureStartIntentV1;
    }
  | {
      ok: false;
      reason: "command_conflict";
      commandId: string;
      intent: QuickCaptureStartIntentV1;
    }
  | { ok: false; reason: "intent_not_found"; commandId: string }
  | {
      ok: false;
      reason: "run_conflict";
      commandId: string;
      expectedRunId: string;
    }
  | {
      ok: false;
      reason: "intent_committed";
      commandId: string;
      disposition: QuickCaptureStartDisposition;
    };

export type CreateQuickCaptureStartIntentResult =
  | {
      ok: true;
      changed: boolean;
      replayed: boolean;
      commitState: "committed";
      intent: QuickCaptureStartIntentV1;
      prunedCommandIds: string[];
    }
  | QuickCaptureStartIntentFailure;

export type UpdateQuickCaptureStartIntentResult =
  | {
      ok: true;
      changed: boolean;
      commitState: "committed";
      intent: Extract<QuickCaptureStartIntentV1, { status: "committed" }>;
      prunedCommandIds: string[];
    }
  | QuickCaptureStartIntentFailure;

export type AbandonQuickCaptureStartIntentResult =
  | { ok: true; changed: boolean; commitState: "committed" }
  | QuickCaptureStartIntentFailure;

export type GetQuickCaptureStartIntentResult =
  | { ok: true; intent: QuickCaptureStartIntentV1 | null }
  | QuickCaptureStartIntentFailure;

export type ListQuickCaptureStartIntentsResult =
  | { ok: true; intents: QuickCaptureStartIntentV1[] }
  | QuickCaptureStartIntentFailure;

type UnknownRecord = Record<string, unknown>;
type CanonicalCreateInput = {
  identity: QuickCaptureStartIdentityV1;
  plan: CaptureReviewPlanV1;
  licensed: boolean;
  headerLease: QuickCaptureStartHeaderLeaseV1 | null;
};

function invalidInput(message: string): QuickCaptureStartIntentFailure {
  return { ok: false, reason: "invalid_input", message };
}

function unavailable(
  operation: "get" | "set",
  commitState: "absent" | "unknown",
): QuickCaptureStartIntentFailure {
  return {
    ok: false,
    reason: "storage_unavailable",
    operation,
    commitState,
    message: "Chrome session storage is unavailable.",
  };
}

function exactDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
): UnknownRecord | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== allowedKeys.length ||
      keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    ) {
      return undefined;
    }
    const result = Object.create(null) as UnknownRecord;
    for (const key of allowedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

/** Returns the canonical IDs shared by the journal and queue coordinator. */
export function deriveQuickCaptureStartIdentity(
  value: unknown,
): QuickCaptureStartIdentityV1 | undefined {
  if (typeof value !== "string" || !value.startsWith("download-")) return undefined;
  const rawUuid = value.slice("download-".length);
  if (!UUID_PATTERN.test(rawUuid)) return undefined;
  const uuid = rawUuid.toLowerCase();
  return {
    commandId: `download-${uuid}`,
    coordinatorCommandId: uuid,
    runId: `capture-run:v1:${uuid}`,
    planId: `capture-single-plan:${uuid}`,
    draftId: `capture-single-draft:${uuid}`,
    itemId: `capture-single-item:${uuid}`,
  };
}

type PlainCloneState = { nodes: number; seen: Set<object> };
type PlainCloneResult = { ok: true; value: unknown } | { ok: false };

function clonePlainData(
  value: unknown,
  state: PlainCloneState,
  depth = 0,
): PlainCloneResult {
  if (depth > MAX_PLAIN_DATA_DEPTH || state.nodes >= MAX_PLAIN_DATA_NODES) {
    return { ok: false };
  }
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    state.nodes += 1;
    return { ok: true, value };
  }
  if (value === null || typeof value !== "object") return { ok: false };
  if (state.seen.has(value)) return { ok: false };
  state.seen.add(value);
  state.nodes += 1;
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return { ok: false };
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor)) return { ok: false };
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 1_000) {
        return { ok: false };
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
        return { ok: false };
      }
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
          return { ok: false };
        }
        const cloned = clonePlainData(descriptor.value, state, depth + 1);
        if (!cloned.ok) return cloned;
        result.push(cloned.value);
      }
      return { ok: true, value: result };
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { ok: false };
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) =>
        typeof key !== "string" || FORBIDDEN_DATA_KEYS.has(key),
      )
    ) {
      return { ok: false };
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const rawKey of ownKeys) {
      const key = rawKey as string;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        return { ok: false };
      }
      const cloned = clonePlainData(descriptor.value, state, depth + 1);
      if (!cloned.ok) return cloned;
      result[key] = cloned.value;
    }
    return { ok: true, value: result };
  } catch {
    return { ok: false };
  } finally {
    state.seen.delete(value);
  }
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

function canonicalQuickCapturePlan(
  value: unknown,
  identity: QuickCaptureStartIdentityV1,
): CaptureReviewPlanV1 | undefined {
  const plain = clonePlainData(value, { nodes: 0, seen: new Set() });
  if (!plain.ok) return undefined;
  const inputBytes = serializedBytes(plain.value);
  if (
    inputBytes === undefined ||
    inputBytes > MAX_QUICK_CAPTURE_FROZEN_PLAN_BYTES ||
    !isCaptureReviewPlanV1(plain.value)
  ) {
    return undefined;
  }
  const plan = cloneCaptureReviewPlan(plain.value);
  const item = plan.items[0];
  if (
    !Number.isSafeInteger(plan.generatedAt) ||
    plan.generatedAt < 0 ||
    plan.planId !== identity.planId ||
    plan.draftId !== identity.draftId ||
    plan.items.length !== 1 ||
    !item ||
    item.itemId !== identity.itemId ||
    item.include !== true ||
    item.readiness !== "ready" ||
    plan.totals.included !== 1 ||
    plan.totals.videos + plan.totals.stills !== 1
  ) {
    return undefined;
  }
  const outputBytes = serializedBytes(plan);
  return outputBytes !== undefined && outputBytes <= MAX_QUICK_CAPTURE_FROZEN_PLAN_BYTES
    ? plan
    : undefined;
}

function safeLeaseText(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value;
}

function safeLeaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalQuickCaptureHeaderLease(
  value: unknown,
  identity: QuickCaptureStartIdentityV1,
  plan: CaptureReviewPlanV1,
): QuickCaptureStartHeaderLeaseV1 | null | undefined {
  if (value === null) return null;
  const record = exactDataRecord(value, [
    "binding",
    "owner",
    "headerLeaseIdsByItemId",
    "expiresAt",
  ]);
  const binding = record ? exactDataRecord(record.binding, [
    "leaseId",
    "draftId",
    "itemId",
    "mediaId",
    "sourceTabId",
    "pageUrl",
    "sourceUrl",
    "replayKind",
  ]) : undefined;
  const owner = record ? exactDataRecord(record.owner, ["runId", "jobId", "attemptId"]) : undefined;
  const item = plan.items[0];
  const headerLeaseIdsByItemId = record
    ? canonicalizeCaptureHeaderLeaseIdsByItemId(plan, record.headerLeaseIdsByItemId)
    : undefined;
  const expiresAt = record?.expiresAt;
  const sourceTabId = binding?.sourceTabId;
  const leaseId = binding?.leaseId;
  const draftId = binding?.draftId;
  const itemId = binding?.itemId;
  const mediaId = binding?.mediaId;
  const pageUrl = binding?.pageUrl;
  const sourceUrl = binding?.sourceUrl;
  const replayKind = binding?.replayKind;
  const runId = owner?.runId;
  const jobId = owner?.jobId;
  const attemptId = owner?.attemptId;
  if (
    !record ||
    !binding ||
    !owner ||
    !item ||
    !headerLeaseIdsByItemId ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 0 ||
    leaseId !== `capture-header-lease-v1:${identity.coordinatorCommandId}` ||
    draftId !== identity.draftId ||
    itemId !== identity.itemId ||
    mediaId !== item.media.mediaId ||
    typeof sourceTabId !== "number" ||
    !Number.isSafeInteger(sourceTabId) ||
    sourceTabId < 0 ||
    !safeLeaseUrl(pageUrl) ||
    !safeLeaseUrl(sourceUrl) ||
    sourceUrl !== item.media.url ||
    (replayKind !== "hls" && replayKind !== "dash" && replayKind !== "direct") ||
    runId !== identity.runId ||
    !safeLeaseText(jobId) ||
    !safeLeaseText(attemptId) ||
    headerLeaseIdsByItemId[identity.itemId] !== leaseId ||
    Object.keys(headerLeaseIdsByItemId).length !== 1
  ) {
    return undefined;
  }
  return {
    binding: {
      leaseId,
      draftId,
      itemId,
      mediaId,
      sourceTabId,
      pageUrl,
      sourceUrl,
      replayKind,
    },
    owner: {
      runId,
      jobId,
      attemptId,
    },
    headerLeaseIdsByItemId,
    expiresAt,
  };
}

function parseCreateInput(value: unknown): CanonicalCreateInput | undefined {
  const record = exactDataRecord(value, ["commandId", "plan", "licensed", "headerLease"]) ??
    exactDataRecord(value, ["commandId", "plan", "licensed"]);
  const identity = record ? deriveQuickCaptureStartIdentity(record.commandId) : undefined;
  if (!record || !identity || typeof record.licensed !== "boolean") return undefined;
  const plan = canonicalQuickCapturePlan(record.plan, identity);
  if (!plan) return undefined;
  const hasHeaderLease = Object.prototype.hasOwnProperty.call(record, "headerLease");
  const parsedHeaderLease = hasHeaderLease
    ? canonicalQuickCaptureHeaderLease(record.headerLease, identity, plan)
    : null;
  if (parsedHeaderLease === undefined) {
    return undefined;
  }
  const headerLease: QuickCaptureStartHeaderLeaseV1 | null = parsedHeaderLease;
  return {
    identity,
    plan,
    licensed: record.licensed,
    headerLease,
  };
}

function plansEqual(left: CaptureReviewPlanV1, right: CaptureReviewPlanV1): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function cloneIntent(intent: QuickCaptureStartIntentV1): QuickCaptureStartIntentV1 {
  const base: QuickCaptureStartIntentBaseV1 = {
    schemaVersion: 1,
    commandId: intent.commandId,
    coordinatorCommandId: intent.coordinatorCommandId,
    runId: intent.runId,
    licensed: intent.licensed,
    plan: cloneCaptureReviewPlan(intent.plan),
    createdAt: intent.createdAt,
    ...(intent.headerLease === undefined ? {} : { headerLease: cloneHeaderLease(intent.headerLease) }),
  };
  return intent.status === "pending"
    ? { ...base, status: "pending" }
    : {
        ...base,
        status: "committed",
        reconciliationDisposition: intent.reconciliationDisposition,
      };
}

function cloneHeaderLease(
  lease: QuickCaptureStartHeaderLeaseV1 | null,
): QuickCaptureStartHeaderLeaseV1 | null {
  if (lease === null) return null;
  return {
    binding: { ...lease.binding },
    owner: { ...lease.owner },
    headerLeaseIdsByItemId: { ...lease.headerLeaseIdsByItemId },
    expiresAt: lease.expiresAt,
  };
}

function parseIntent(value: unknown): QuickCaptureStartIntentV1 | undefined {
  const pending = exactDataRecord(value, [
    "schemaVersion",
    "commandId",
    "coordinatorCommandId",
    "runId",
    "licensed",
    "plan",
    "createdAt",
    "status",
    "headerLease",
  ]) ?? exactDataRecord(value, [
    "schemaVersion",
    "commandId",
    "coordinatorCommandId",
    "runId",
    "licensed",
    "plan",
    "createdAt",
    "status",
  ]);
  const committed = pending ? undefined : exactDataRecord(value, [
    "schemaVersion",
    "commandId",
    "coordinatorCommandId",
    "runId",
    "licensed",
    "plan",
    "createdAt",
    "status",
    "reconciliationDisposition",
    "headerLease",
  ]) ?? exactDataRecord(value, [
    "schemaVersion",
    "commandId",
    "coordinatorCommandId",
    "runId",
    "licensed",
    "plan",
    "createdAt",
    "status",
    "reconciliationDisposition",
  ]);
  const record = pending ?? committed;
  if (!record || record.schemaVersion !== 1) return undefined;
  const identity = deriveQuickCaptureStartIdentity(record.commandId);
  if (
    !identity ||
    record.coordinatorCommandId !== identity.coordinatorCommandId ||
    record.runId !== identity.runId ||
    typeof record.licensed !== "boolean"
  ) {
    return undefined;
  }
  const plan = canonicalQuickCapturePlan(record.plan, identity);
  if (!plan || record.createdAt !== plan.generatedAt) return undefined;
  const headerLease = Object.prototype.hasOwnProperty.call(record, "headerLease")
    ? canonicalQuickCaptureHeaderLease(record.headerLease, identity, plan)
    : undefined;
  if (headerLease === undefined && Object.prototype.hasOwnProperty.call(record, "headerLease")) {
    return undefined;
  }
  const base: QuickCaptureStartIntentBaseV1 = {
    schemaVersion: 1,
    commandId: identity.commandId,
    coordinatorCommandId: identity.coordinatorCommandId,
    runId: identity.runId,
    licensed: record.licensed,
    plan,
    createdAt: plan.generatedAt,
    ...(Object.prototype.hasOwnProperty.call(record, "headerLease") ? { headerLease } : {}),
  };
  if (pending && record.status === "pending") return { ...base, status: "pending" };
  if (
    committed &&
    record.status === "committed" &&
    (record.reconciliationDisposition === "accepted" ||
      record.reconciliationDisposition === "recovery_needed" ||
      record.reconciliationDisposition === "commit_state_unknown")
  ) {
    return {
      ...base,
      status: "committed",
      reconciliationDisposition: record.reconciliationDisposition,
    };
  }
  return undefined;
}

function isUnresolved(intent: QuickCaptureStartIntentV1): boolean {
  return intent.status === "pending" || intent.reconciliationDisposition !== "accepted";
}

export function isQuickCaptureStartIntentUnresolved(value: unknown): boolean {
  try {
    const intent = parseIntent(value);
    return Boolean(intent && isUnresolved(intent));
  } catch {
    return false;
  }
}

function requestMatches(
  intent: QuickCaptureStartIntentV1,
  input: CanonicalCreateInput,
): boolean {
  return intent.commandId === input.identity.commandId &&
    plansEqual(intent.plan, input.plan) &&
    headerLeasesEqual(intent.headerLease ?? null, input.headerLease);
}

/** The first licensed value is intentionally excluded from request identity. */
export function quickCaptureStartRequestMatches(intent: unknown, input: unknown): boolean {
  try {
    const parsedIntent = parseIntent(intent);
    const parsedInput = parseCreateInput(input);
    return Boolean(parsedIntent && parsedInput && requestMatches(parsedIntent, parsedInput));
  } catch {
    return false;
  }
}

function canonicalOrder(records: Record<string, QuickCaptureStartIntentV1>): string[] {
  return Object.keys(records).sort((left, right) => {
    const timeDifference = records[right].createdAt - records[left].createdAt;
    if (timeDifference !== 0) return timeDifference;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function recordsEqual(
  left: QuickCaptureStartIntentV1,
  right: QuickCaptureStartIntentV1,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.commandId === right.commandId &&
    left.coordinatorCommandId === right.coordinatorCommandId &&
    left.runId === right.runId &&
    left.licensed === right.licensed &&
    left.createdAt === right.createdAt &&
    plansEqual(left.plan, right.plan) &&
    headerLeasesEqual(left.headerLease, right.headerLease) &&
    left.status === right.status &&
    (left.status !== "committed" ||
      (right.status === "committed" &&
        left.reconciliationDisposition === right.reconciliationDisposition))
  );
}

function headerLeasesEqual(
  left: QuickCaptureStartHeaderLeaseV1 | null | undefined,
  right: QuickCaptureStartHeaderLeaseV1 | null | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left === null || right === null) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function indexesEqual(
  left: QuickCaptureStartIntentIndexV1,
  right: QuickCaptureStartIntentIndexV1,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.orderedCommandIds.length === right.orderedCommandIds.length &&
    left.orderedCommandIds.every((commandId, index) =>
      commandId === right.orderedCommandIds[index] &&
      Boolean(right.records[commandId]) &&
      recordsEqual(left.records[commandId], right.records[commandId]),
    )
  );
}

function buildIndex(
  source: Record<string, QuickCaptureStartIntentV1>,
  preserveCommandId?: string,
):
  | {
      ok: true;
      index: QuickCaptureStartIntentIndexV1;
      prunedCommandIds: string[];
    }
  | Extract<QuickCaptureStartIntentFailure, { reason: "serialized_byte_limit" }> {
  const unresolvedIds = Object.keys(source).filter((commandId) =>
    isUnresolved(source[commandId]),
  );
  const settledIds = Object.keys(source)
    .filter((commandId) => !isUnresolved(source[commandId]))
    .sort((left, right) => {
      if (left === preserveCommandId) return -1;
      if (right === preserveCommandId) return 1;
      const timeDifference = source[right].createdAt - source[left].createdAt;
      if (timeDifference !== 0) return timeDifference;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const retainedIds = new Set([
    ...unresolvedIds,
    ...settledIds.slice(0, MAX_SETTLED_QUICK_CAPTURE_START_INTENTS),
  ]);
  const prunedCommandIds = settledIds.filter((commandId) => !retainedIds.has(commandId));
  const records: Record<string, QuickCaptureStartIntentV1> = Object.create(null);
  for (const commandId of retainedIds) records[commandId] = cloneIntent(source[commandId]);

  while (true) {
    const orderedCommandIds = canonicalOrder(records);
    const index: QuickCaptureStartIntentIndexV1 = {
      schemaVersion: 1,
      orderedCommandIds,
      records,
    };
    const bytes = serializedBytes(index);
    if (bytes !== undefined && bytes <= MAX_QUICK_CAPTURE_START_INTENTS_BYTES) {
      return { ok: true, index, prunedCommandIds };
    }
    const removable = [...orderedCommandIds].reverse().find((commandId) =>
      !isUnresolved(records[commandId]) && commandId !== preserveCommandId,
    );
    if (!removable) {
      return {
        ok: false,
        reason: "serialized_byte_limit",
        limit: MAX_QUICK_CAPTURE_START_INTENTS_BYTES,
      };
    }
    delete records[removable];
    prunedCommandIds.push(removable);
  }
}

function parseOrder(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RAW_RECORDS) return undefined;
    if (Reflect.ownKeys(value).length !== length + 1) return undefined;
    const result: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      const identity = descriptor && "value" in descriptor
        ? deriveQuickCaptureStartIdentity(descriptor.value)
        : undefined;
      if (!descriptor || descriptor.enumerable !== true || !identity) return undefined;
      result.push(identity.commandId);
    }
    return new Set(result).size === result.length ? result : undefined;
  } catch {
    return undefined;
  }
}

function parseRecordMap(value: unknown): Record<string, QuickCaptureStartIntentV1> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_RAW_RECORDS || keys.some((key) => typeof key !== "string")) {
      return undefined;
    }
    const records: Record<string, QuickCaptureStartIntentV1> = Object.create(null);
    for (const rawKey of keys) {
      const key = rawKey as string;
      const identity = deriveQuickCaptureStartIdentity(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !identity || identity.commandId !== key || !descriptor ||
        !("value" in descriptor) || descriptor.enumerable !== true
      ) {
        return undefined;
      }
      const intent = parseIntent(descriptor.value);
      if (!intent || intent.commandId !== key) return undefined;
      records[key] = intent;
    }
    return records;
  } catch {
    return undefined;
  }
}

function emptyIndex(): QuickCaptureStartIntentIndexV1 {
  return { schemaVersion: 1, orderedCommandIds: [], records: {} };
}

function parseIndex(value: unknown): QuickCaptureStartIntentIndexV1 | undefined {
  if (value === undefined) return emptyIndex();
  const record = exactDataRecord(value, ["schemaVersion", "orderedCommandIds", "records"]);
  if (!record || record.schemaVersion !== 1) return undefined;
  const order = parseOrder(record.orderedCommandIds);
  const records = parseRecordMap(record.records);
  if (!order || !records || order.length !== Object.keys(records).length) return undefined;
  if (Object.values(records).filter(isUnresolved).length > 1) return undefined;
  const canonical = canonicalOrder(records);
  if (!canonical.every((commandId, index) => order[index] === commandId)) return undefined;
  const index: QuickCaptureStartIntentIndexV1 = {
    schemaVersion: 1,
    orderedCommandIds: canonical,
    records,
  };
  const bytes = serializedBytes(index);
  return bytes !== undefined && bytes <= MAX_QUICK_CAPTURE_START_INTENTS_BYTES
    ? index
    : undefined;
}

async function readStoredIndex(): Promise<
  { ok: true; index: QuickCaptureStartIntentIndexV1 } | QuickCaptureStartIntentFailure
> {
  try {
    const values: unknown = await chrome.storage.session.get(
      QUICK_CAPTURE_START_INTENTS_STORAGE_KEY,
    );
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      return {
        ok: false,
        reason: "storage_corrupt",
        key: QUICK_CAPTURE_START_INTENTS_STORAGE_KEY,
      };
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      values,
      QUICK_CAPTURE_START_INTENTS_STORAGE_KEY,
    );
    if (descriptor && !("value" in descriptor)) {
      return {
        ok: false,
        reason: "storage_corrupt",
        key: QUICK_CAPTURE_START_INTENTS_STORAGE_KEY,
      };
    }
    const index = parseIndex(descriptor && "value" in descriptor
      ? descriptor.value
      : undefined);
    return index
      ? { ok: true, index }
      : {
          ok: false,
          reason: "storage_corrupt",
          key: QUICK_CAPTURE_START_INTENTS_STORAGE_KEY,
        };
  } catch {
    return unavailable("get", "unknown");
  }
}

async function readBackWrite(
  expected: QuickCaptureStartIntentIndexV1,
  previous: QuickCaptureStartIntentIndexV1,
): Promise<"committed" | "absent" | "unknown"> {
  const read = await readStoredIndex();
  if (!read.ok) return "unknown";
  if (indexesEqual(read.index, expected)) return "committed";
  if (indexesEqual(read.index, previous)) return "absent";
  return "unknown";
}

async function writeIndex(
  index: QuickCaptureStartIntentIndexV1,
  previous: QuickCaptureStartIntentIndexV1,
): Promise<"committed" | QuickCaptureStartIntentFailure> {
  try {
    await chrome.storage.session.set({
      [QUICK_CAPTURE_START_INTENTS_STORAGE_KEY]: index,
    });
    return "committed";
  } catch {
    const commitState = await readBackWrite(index, previous);
    return commitState === "committed"
      ? "committed"
      : unavailable("set", commitState);
  }
}

export async function getQuickCaptureStartIntent(
  commandId: string,
): Promise<GetQuickCaptureStartIntentResult> {
  const identity = deriveQuickCaptureStartIdentity(commandId);
  if (!identity) return invalidInput("commandId must be download-<uuid>.");
  const read = await readStoredIndex();
  if (!read.ok) return read;
  const intent = read.index.records[identity.commandId];
  return { ok: true, intent: intent ? cloneIntent(intent) : null };
}

export async function listQuickCaptureStartIntents(): Promise<
  ListQuickCaptureStartIntentsResult
> {
  const read = await readStoredIndex();
  if (!read.ok) return read;
  return {
    ok: true,
    intents: read.index.orderedCommandIds.map((commandId) =>
      cloneIntent(read.index.records[commandId]),
    ),
  };
}

export async function getNewestUnresolvedQuickCaptureStartIntent(): Promise<
  GetQuickCaptureStartIntentResult
> {
  const read = await readStoredIndex();
  if (!read.ok) return read;
  const commandId = read.index.orderedCommandIds.find((candidate) =>
    isUnresolved(read.index.records[candidate]),
  );
  return {
    ok: true,
    intent: commandId ? cloneIntent(read.index.records[commandId]) : null,
  };
}

/**
 * Freezes the first exact plan and entitlement decision. A same-plan replay
 * returns that decision even if the caller's current entitlement changed.
 */
export async function createQuickCaptureStartIntent(
  rawInput: QuickCaptureStartIntentCreateInput,
): Promise<CreateQuickCaptureStartIntentResult> {
  const input = parseCreateInput(rawInput);
  if (!input) return invalidInput("Quick Capture start intent input is invalid.");
  return withKeyLock(QUICK_CAPTURE_START_INTENTS_STORAGE_KEY, async () => {
    const read = await readStoredIndex();
    if (!read.ok) return read;
    const existing = read.index.records[input.identity.commandId];
    if (existing) {
      return requestMatches(existing, input)
        ? {
            ok: true,
            changed: false,
            replayed: true,
            commitState: "committed",
            intent: cloneIntent(existing),
            prunedCommandIds: [],
          }
        : {
            ok: false,
            reason: "command_conflict",
            commandId: input.identity.commandId,
            intent: cloneIntent(existing),
          };
    }
    const unresolvedCommandId = read.index.orderedCommandIds.find((commandId) =>
      isUnresolved(read.index.records[commandId]),
    );
    if (unresolvedCommandId) {
      return {
        ok: false,
        reason: "unresolved_intent",
        commandId: unresolvedCommandId,
        intent: cloneIntent(read.index.records[unresolvedCommandId]),
      };
    }
    const intent: QuickCaptureStartIntentV1 = {
      schemaVersion: 1,
      commandId: input.identity.commandId,
      coordinatorCommandId: input.identity.coordinatorCommandId,
      runId: input.identity.runId,
      licensed: input.licensed,
      plan: cloneCaptureReviewPlan(input.plan),
      createdAt: input.plan.generatedAt,
      status: "pending",
      headerLease: cloneHeaderLease(input.headerLease),
    };
    const source = { ...read.index.records, [intent.commandId]: intent };
    const built = buildIndex(source, intent.commandId);
    if (!built.ok) return built;
    const written = await writeIndex(built.index, read.index);
    if (written !== "committed") return written;
    return {
      ok: true,
      changed: true,
      replayed: false,
      commitState: "committed",
      intent: cloneIntent(intent),
      prunedCommandIds: built.prunedCommandIds,
    };
  });
}

/**
 * Monotonically records the coordinator's result:
 * commit_state_unknown < recovery_needed < accepted.
 */
export async function updateQuickCaptureStartIntentDisposition(input: {
  commandId: string;
  runId: string;
  disposition: QuickCaptureStartDisposition;
}): Promise<UpdateQuickCaptureStartIntentResult> {
  const record = exactDataRecord(input, ["commandId", "runId", "disposition"]);
  const identity = record ? deriveQuickCaptureStartIdentity(record.commandId) : undefined;
  if (
    !record || !identity || typeof record.runId !== "string" ||
    (record.disposition !== "accepted" &&
      record.disposition !== "recovery_needed" &&
      record.disposition !== "commit_state_unknown")
  ) {
    return invalidInput("Quick Capture disposition update is invalid.");
  }
  if (record.runId !== identity.runId) {
    return {
      ok: false,
      reason: "run_conflict",
      commandId: identity.commandId,
      expectedRunId: identity.runId,
    };
  }
  const requestedDisposition = record.disposition as QuickCaptureStartDisposition;
  return withKeyLock(QUICK_CAPTURE_START_INTENTS_STORAGE_KEY, async () => {
    const read = await readStoredIndex();
    if (!read.ok) return read;
    const existing = read.index.records[identity.commandId];
    if (!existing) {
      return { ok: false, reason: "intent_not_found", commandId: identity.commandId };
    }
    const rank: Record<QuickCaptureStartDisposition, number> = {
      commit_state_unknown: 0,
      recovery_needed: 1,
      accepted: 2,
    };
    const disposition = existing.status === "committed" &&
        rank[existing.reconciliationDisposition] >= rank[requestedDisposition]
      ? existing.reconciliationDisposition
      : requestedDisposition;
    if (
      existing.status === "committed" &&
      existing.reconciliationDisposition === disposition
    ) {
      return {
        ok: true,
        changed: false,
        commitState: "committed",
        intent: cloneIntent(existing) as Extract<
          QuickCaptureStartIntentV1,
          { status: "committed" }
        >,
        prunedCommandIds: [],
      };
    }
    const intent: Extract<QuickCaptureStartIntentV1, { status: "committed" }> = {
      ...cloneIntent(existing),
      status: "committed",
      reconciliationDisposition: disposition,
    };
    const source = { ...read.index.records, [identity.commandId]: intent };
    const built = buildIndex(source, identity.commandId);
    if (!built.ok) return built;
    const written = await writeIndex(built.index, read.index);
    if (written !== "committed") return written;
    return {
      ok: true,
      changed: true,
      commitState: "committed",
      intent: cloneIntent(intent) as Extract<
        QuickCaptureStartIntentV1,
        { status: "committed" }
      >,
      prunedCommandIds: built.prunedCommandIds,
    };
  });
}

/** Removes only an exact pending intent after a definitive uncommitted result. */
export async function abandonQuickCaptureStartIntent(input: {
  commandId: string;
  plan: CaptureReviewPlanV1;
}): Promise<AbandonQuickCaptureStartIntentResult> {
  const record = exactDataRecord(input, ["commandId", "plan"]);
  const identity = record ? deriveQuickCaptureStartIdentity(record.commandId) : undefined;
  const plan = identity && record ? canonicalQuickCapturePlan(record.plan, identity) : undefined;
  if (!record || !identity || !plan) {
    return invalidInput("Quick Capture abandon input is invalid.");
  }
  return withKeyLock(QUICK_CAPTURE_START_INTENTS_STORAGE_KEY, async () => {
    const read = await readStoredIndex();
    if (!read.ok) return read;
    const existing = read.index.records[identity.commandId];
    if (!existing) return { ok: true, changed: false, commitState: "committed" };
    if (!plansEqual(existing.plan, plan)) {
      return {
        ok: false,
        reason: "command_conflict",
        commandId: identity.commandId,
        intent: cloneIntent(existing),
      };
    }
    if (existing.status === "committed") {
      return {
        ok: false,
        reason: "intent_committed",
        commandId: identity.commandId,
        disposition: existing.reconciliationDisposition,
      };
    }
    const records = { ...read.index.records };
    delete records[identity.commandId];
    const built = buildIndex(records);
    if (!built.ok) return built;
    const written = await writeIndex(built.index, read.index);
    if (written !== "committed") return written;
    return { ok: true, changed: true, commitState: "committed" };
  });
}
