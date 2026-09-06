import {
  createCaptureCancelCommandId,
  createCaptureManifestRetryCommandId,
  createCapturePlanCommandId,
  createCaptureRunCommandId,
  type CaptureVariantOptionV1,
  type CapturePlanChoiceSelectorV1,
  type CaptureReviewUiRequest,
  parseCaptureReviewUiRequest,
} from "./capture-review-messages";
import {
  parseCaptureWorkspaceManifests,
  type CaptureWorkspaceManifestV1,
} from "./capture-manifest-workspace";
export type { CaptureWorkspaceManifestV1 } from "./capture-manifest-workspace";
import {
  isCaptureDraftV1,
  isCaptureJobV1,
  isCaptureReviewPlanV1,
  isCaptureRunV1,
  type CaptureDraftV1,
  type CaptureJobV1,
  type CaptureReviewPlanV1,
  type CaptureRunV1,
} from "./capture-pack-types";
import { cloneCaptureDraft } from "./capture-pack-storage";
import { cloneCaptureReviewPlan } from "./capture-plan";

const MAX_OPTIONS = 200;
const MAX_RUNS = 30;
// Storage may retain 1,000 active jobs plus ten terminal runs of up to 200
// jobs each. The workspace parser must accept every graph the storage layer
// itself considers valid.
const MAX_JOBS = 3_000;
const MAX_PLANS = 6;
const MAX_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 512;
const SAFE_ID_PATTERN = /^[a-z0-9._:-]+$/i;
const CAPTURE_OPTION_ID_PATTERN = /^capture-option-v1-[0-9a-f]{40}$/;
const CAPTURE_PLAN_COMMAND_ID_PATTERN =
  /^capture-plan-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPTURE_RUN_COMMAND_ID_PATTERN =
  /^capture-run-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUICK_CAPTURE_COMMAND_ID_PATTERN =
  /^download-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const CAPTURE_JOB_ID_PATTERN = /^capture-job:v1:[0-9a-f]{64}$/;
const UNSAFE_LABEL_PATTERN = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

export type { CaptureVariantOptionV1 } from "./capture-review-messages";

export type CaptureWorkspaceQuotaV1 = {
  licensed: boolean;
  limit: number;
  used: number;
  remaining: number;
};

export type CaptureWorkspaceReviewContextV1 = {
  planId: string;
  commandId: string;
  choices: CapturePlanChoiceSelectorV1[];
  options: CaptureVariantOptionV1[];
};

type CaptureWorkspaceRunContextBaseV1 = {
  commandId: string;
  planId: string;
  draftId: string;
  draftRevision: number;
  requestedFreeVideoItemIds: string[];
  licensed: boolean;
  needsManualReconcile: boolean;
};

export type CaptureWorkspaceRunContextV1 = CaptureWorkspaceRunContextBaseV1 & (
  | { status: "pending"; reconciliationState: "pending"; runId?: never }
  | {
      status: "committed";
      reconciliationState: "committed_missing_run" | "committed_recovery_needed";
      runId: string;
    }
);

export type CaptureWorkspaceQuickCaptureContextV1 = {
  commandId: string;
  runId: string;
  planId: string;
  itemId: string;
  reconciliationState: "pending" | "commit_state_unknown" | "recovery_needed";
  needsManualReconcile: boolean;
  jobId?: string;
};

export type CapturePlanClientResult =
  | { ok: true; plan: CaptureReviewPlanV1; options: CaptureVariantOptionV1[]; commandId?: string }
  | {
      ok: false;
      reason: string;
      draft: CaptureDraftV1 | null;
      actualRevision?: number;
      commandId?: string;
    };

export type CaptureRunClientResult =
  | {
      ok: true;
      runId: string;
      replayed: boolean;
      disposition: "accepted" | "recovery_needed" | "commit_state_unknown";
      commandId?: string;
    }
  | { ok: false; reason: string; commandId?: string };

export type CaptureCancelClientResult =
  | { ok: true; job: CaptureJobV1; commandId?: string }
  | { ok: false; reason: string; commandId?: string };

export type CaptureManifestRetryClientResult =
  | {
      ok: true;
      runId: string;
      format: "json" | "csv";
      replayed: boolean;
      commandId?: string;
    }
  | { ok: false; reason: string; commandId?: string };

export type CaptureQuickReconcileClientResult =
  | {
      ok: true;
      commandId: string;
      runId: string;
      planId: string;
      itemId: string;
      jobId: string;
    }
  | {
      ok: false;
      commandId: string;
      runId?: string;
      planId?: string;
      itemId?: string;
      reason: string;
      code?: string;
      customerMessage?: string;
    };

export type CaptureWorkspaceClientResult =
  | {
      ok: true;
      draft: CaptureDraftV1 | null;
      plans: CaptureReviewPlanV1[];
      runs: CaptureRunV1[];
      jobs: CaptureJobV1[];
      manifests: CaptureWorkspaceManifestV1[];
      quota: CaptureWorkspaceQuotaV1;
      reviewContext: CaptureWorkspaceReviewContextV1 | null;
      runContext: CaptureWorkspaceRunContextV1 | null;
      quickCaptureContext: CaptureWorkspaceQuickCaptureContextV1 | null;
    }
  | { ok: false; reason: string };

type DataRecord = Record<string, unknown>;

function dataRecord(value: unknown): DataRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return undefined;
    const result: DataRecord = Object.create(null) as DataRecord;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function safeId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID_PATTERN.test(value);
}

function boundedReason(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LABEL_LENGTH &&
    !UNSAFE_LABEL_PATTERN.test(value);
}

function quickCaptureIdentity(commandId: unknown): {
  commandId: string;
  coordinatorCommandId: string;
  runId: string;
  planId: string;
  draftId: string;
  itemId: string;
} | undefined {
  if (typeof commandId !== "string") return undefined;
  const match = QUICK_CAPTURE_COMMAND_ID_PATTERN.exec(commandId);
  if (!match) return undefined;
  const uuid = match[1].toLowerCase();
  const canonicalCommandId = `download-${uuid}`;
  if (commandId !== canonicalCommandId) return undefined;
  return {
    commandId: canonicalCommandId,
    coordinatorCommandId: uuid,
    runId: `capture-run:v1:${uuid}`,
    planId: `capture-single-plan:${uuid}`,
    draftId: `capture-single-draft:${uuid}`,
    itemId: `capture-single-item:${uuid}`,
  };
}

function hasOnlyKeys(record: DataRecord, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

/** Reject accessors, custom prototypes, symbols, cycles, and oversized graphs before guards read them. */
function isPassiveData(value: unknown, maxNodes = 20_000): boolean {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (candidate: unknown): boolean => {
    if (
      candidate === null || typeof candidate === "string" || typeof candidate === "number" ||
      typeof candidate === "boolean" || candidate === undefined
    ) return true;
    if (typeof candidate !== "object" || ++nodes > maxNodes) return false;
    const object = candidate as object;
    if (seen.has(object)) return false;
    seen.add(object);
    try {
      const prototype = Object.getPrototypeOf(object);
      if (
        Array.isArray(object)
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      ) return false;
      const keys = Reflect.ownKeys(object);
      if (keys.some((key) => typeof key !== "string")) return false;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !("value" in descriptor) || !visit(descriptor.value)) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  return visit(value);
}

function clonePassive<T>(value: T): T | undefined {
  if (!isPassiveData(value)) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

function safeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalPositive(value: unknown): value is number | undefined {
  return value === undefined || (safeNonNegative(value) && value > 0);
}

function optionalPositiveFinite(value: unknown): value is number | undefined {
  return value === undefined || (
    typeof value === "number" && Number.isFinite(value) && value > 0
  );
}

function parsedFailure(record: DataRecord | undefined): {
  ok: false;
  reason: string;
} | undefined {
  return record?.ok === false &&
    hasOnlyKeys(record, ["ok", "reason", "draft", "actualRevision"]) &&
    boundedReason(record.reason)
    ? { ok: false, reason: record.reason }
    : undefined;
}

function parseOption(value: unknown): CaptureVariantOptionV1 | undefined {
  const record = dataRecord(value);
  if (
    !record ||
    !safeId(record.itemId) ||
    typeof record.optionId !== "string" ||
    !CAPTURE_OPTION_ID_PATTERN.test(record.optionId) ||
    (record.kind !== "hls" && record.kind !== "dash") ||
    typeof record.label !== "string" ||
    record.label.length === 0 ||
    record.label.length > MAX_LABEL_LENGTH ||
    UNSAFE_LABEL_PATTERN.test(record.label) ||
    !optionalPositive(record.width) ||
    !optionalPositive(record.height) ||
    !optionalPositive(record.videoBandwidth) ||
    !optionalPositive(record.audioBandwidth) ||
    !optionalPositive(record.combinedBandwidth) ||
    !optionalPositiveFinite(record.durationSec) ||
    !optionalPositive(record.estimatedBytes) ||
    typeof record.supported !== "boolean" ||
    (record.selectedByPolicy !== undefined && record.selectedByPolicy !== true) ||
    (record.suggestedForConfirmation !== undefined &&
      record.suggestedForConfirmation !== true) ||
    !(record.disabledReason === undefined || (
      typeof record.disabledReason === "string" &&
      [
        "drm",
        "live",
        "unsupported_codec",
        "unsupported_container",
        "unsupported_manifest_shape",
        "unsupported_audio",
        "permanent_download_failure",
        "invalid_media",
        "over_size_cap",
      ].includes(record.disabledReason)
    )) ||
    record.estimateConfidence !== "exact" &&
    record.estimateConfidence !== "estimated" &&
    record.estimateConfidence !== "unknown"
  ) {
    return undefined;
  }
  const allowed = new Set([
    "itemId",
    "optionId",
    "kind",
    "label",
    "width",
    "height",
    "videoBandwidth",
    "audioBandwidth",
    "combinedBandwidth",
    "durationSec",
    "estimatedBytes",
    "estimateConfidence",
    "supported",
    "disabledReason",
    "selectedByPolicy",
    "suggestedForConfirmation",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  if (
    (record.estimateConfidence === "unknown" && record.estimatedBytes !== undefined) ||
    (record.estimateConfidence !== "unknown" && record.estimatedBytes === undefined) ||
    (record.supported && record.disabledReason !== undefined) ||
    (!record.supported && record.disabledReason === undefined) ||
    (record.selectedByPolicy === true && !record.supported) ||
    (record.suggestedForConfirmation === true && !record.supported) ||
    (record.selectedByPolicy === true && record.suggestedForConfirmation === true)
  ) return undefined;
  return {
    itemId: record.itemId,
    optionId: record.optionId,
    kind: record.kind,
    label: record.label,
    ...(record.width === undefined ? {} : { width: record.width }),
    ...(record.height === undefined ? {} : { height: record.height }),
    ...(record.videoBandwidth === undefined ? {} : { videoBandwidth: record.videoBandwidth }),
    ...(record.audioBandwidth === undefined ? {} : { audioBandwidth: record.audioBandwidth }),
    ...(record.combinedBandwidth === undefined
      ? {}
      : { combinedBandwidth: record.combinedBandwidth }),
    ...(record.durationSec === undefined ? {} : { durationSec: record.durationSec }),
    ...(record.estimatedBytes === undefined ? {} : { estimatedBytes: record.estimatedBytes }),
    estimateConfidence: record.estimateConfidence as CaptureVariantOptionV1["estimateConfidence"],
    supported: record.supported,
    ...(record.disabledReason === undefined
      ? {}
      : { disabledReason: record.disabledReason as CaptureVariantOptionV1["disabledReason"] }),
    ...(record.selectedByPolicy === true ? { selectedByPolicy: true as const } : {}),
    ...(record.suggestedForConfirmation === true
      ? { suggestedForConfirmation: true as const }
      : {}),
  };
}

function parseBoundedArray<T>(
  value: unknown,
  maxLength: number,
  parser: (item: unknown) => T | undefined,
): T[] | undefined {
  try {
    if (
      !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maxLength
    ) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some((key) => typeof key !== "string")
    ) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || length.value !== value.length) return undefined;
    const result: T[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      const parsed = parser(descriptor.value);
      if (parsed === undefined) return undefined;
      result.push(parsed);
    }
    return result;
  } catch {
    return undefined;
  }
}

function validOptionPolicyMarkers(options: readonly CaptureVariantOptionV1[]): boolean {
  const selectedByItem = new Set<string>();
  const suggestedByItem = new Set<string>();
  for (const option of options) {
    if (option.selectedByPolicy === true) {
      if (selectedByItem.has(option.itemId)) return false;
      selectedByItem.add(option.itemId);
    }
    if (option.suggestedForConfirmation === true) {
      if (suggestedByItem.has(option.itemId)) return false;
      suggestedByItem.add(option.itemId);
    }
  }
  return true;
}

export function parseCapturePlanClientResult(value: unknown): CapturePlanClientResult | undefined {
  const record = dataRecord(value);
  if (record?.ok === true) {
    if (!hasOnlyKeys(record, ["ok", "plan", "options"]) || !isPassiveData(record.plan)) {
      return undefined;
    }
    const options = parseBoundedArray(record.options, MAX_OPTIONS, parseOption);
    const candidatePlan = record.plan;
    if (
      !isCaptureReviewPlanV1(candidatePlan) || !options ||
      !validOptionPolicyMarkers(options)
    ) return undefined;
    const optionIds = new Set(options.map((option) => option.optionId));
    if (optionIds.size !== options.length || options.some((option) => {
      const item = candidatePlan.items.find((candidate) => candidate.itemId === option.itemId);
      return !item || item.media.kind !== option.kind;
    })) {
      return undefined;
    }
    return { ok: true, plan: cloneCaptureReviewPlan(candidatePlan), options };
  }
  const failure = parsedFailure(record);
  if (!failure) return undefined;
  const draft = record?.draft;
  if (draft !== null && (!isPassiveData(draft) || !isCaptureDraftV1(draft))) return undefined;
  return {
    ...failure,
    draft: draft === null ? null : cloneCaptureDraft(draft),
    ...(safeNonNegative(record?.actualRevision) ? { actualRevision: record.actualRevision } : {}),
  };
}

export function parseCaptureRunClientResult(value: unknown): CaptureRunClientResult | undefined {
  const record = dataRecord(value);
  if (
    record?.ok === true &&
    hasOnlyKeys(record, ["ok", "runId", "replayed", "disposition"]) &&
    safeId(record.runId) &&
    typeof record.replayed === "boolean" &&
    (record.disposition === "accepted" ||
      record.disposition === "recovery_needed" ||
      record.disposition === "commit_state_unknown")
  ) {
    return {
      ok: true,
      runId: record.runId,
      replayed: record.replayed,
      disposition: record.disposition as Extract<CaptureRunClientResult, { ok: true }>["disposition"],
    };
  }
  return parsedFailure(record);
}

export function parseCaptureCancelClientResult(value: unknown): CaptureCancelClientResult | undefined {
  const record = dataRecord(value);
  if (
    record?.ok === true &&
    hasOnlyKeys(record, ["ok", "job"]) &&
    isPassiveData(record.job) &&
    isCaptureJobV1(record.job)
  ) {
    const job = clonePassive(record.job);
    return job ? { ok: true, job } : undefined;
  }
  return parsedFailure(record);
}

export function parseCaptureManifestRetryClientResult(
  value: unknown,
): Omit<Extract<CaptureManifestRetryClientResult, { ok: true }>, "commandId"> |
  Extract<CaptureManifestRetryClientResult, { ok: false }> | undefined {
  const record = dataRecord(value);
  if (
    record?.ok === true &&
    hasOnlyKeys(record, ["ok", "runId", "format", "replayed"]) &&
    safeId(record.runId) &&
    (record.format === "json" || record.format === "csv") &&
    typeof record.replayed === "boolean"
  ) {
    return {
      ok: true,
      runId: record.runId,
      format: record.format,
      replayed: record.replayed,
    };
  }
  return record?.ok === false &&
    hasOnlyKeys(record, ["ok", "reason"]) &&
    boundedReason(record.reason)
    ? { ok: false, reason: record.reason }
    : undefined;
}

type ParsedQuickCaptureReconcileResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: string; code?: string; customerMessage: string };

export function parseCaptureQuickReconcileClientResult(
  value: unknown,
): ParsedQuickCaptureReconcileResult | undefined {
  const record = dataRecord(value);
  if (
    record?.ok === true &&
    hasOnlyKeys(record, ["ok", "jobId"]) &&
    typeof record.jobId === "string" &&
    CAPTURE_JOB_ID_PATTERN.test(record.jobId)
  ) {
    return { ok: true, jobId: record.jobId };
  }
  if (
    record?.ok === false &&
    hasOnlyKeys(record, ["ok", "error", "code"]) &&
    boundedReason(record.error) &&
    (record.code === undefined || safeId(record.code))
  ) {
    return {
      ok: false,
      reason: typeof record.code === "string" ? record.code : "reconcile_failed",
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      customerMessage: record.error,
    };
  }
  return undefined;
}

function parseQuota(value: unknown): CaptureWorkspaceQuotaV1 | undefined {
  const record = dataRecord(value);
  if (
    !record ||
    !hasOnlyKeys(record, ["licensed", "limit", "used", "remaining"]) ||
    typeof record.licensed !== "boolean" ||
    !safeNonNegative(record.limit) ||
    !safeNonNegative(record.used) ||
    !safeNonNegative(record.remaining) ||
    record.remaining > record.limit ||
    (!record.licensed && record.remaining !== Math.max(0, record.limit - record.used))
  ) {
    return undefined;
  }
  return {
    licensed: record.licensed,
    limit: record.limit,
    used: record.used,
    remaining: record.remaining,
  };
}

function parseReviewContext(value: unknown): CaptureWorkspaceReviewContextV1 | null | undefined {
  if (value === null) return null;
  const record = dataRecord(value);
  if (!record || !hasOnlyKeys(record, ["planId", "commandId", "choices", "options"])) return undefined;
  if (!safeId(record.planId) || typeof record.commandId !== "string" ||
      !CAPTURE_PLAN_COMMAND_ID_PATTERN.test(record.commandId)) return undefined;
  const choices = parseBoundedArray(record.choices, MAX_OPTIONS, (value) => {
    const choice = dataRecord(value);
    if (
      !choice || !hasOnlyKeys(choice, ["itemId", "optionId"]) || !safeId(choice.itemId) ||
      typeof choice.optionId !== "string" || !CAPTURE_OPTION_ID_PATTERN.test(choice.optionId)
    ) return undefined;
    return { itemId: choice.itemId, optionId: choice.optionId };
  });
  const options = parseBoundedArray(record.options, MAX_OPTIONS, parseOption);
  if (
    !choices || !options || !validOptionPolicyMarkers(options) ||
    new Set(choices.map((choice) => choice.itemId)).size !== choices.length ||
    new Set(options.map((option) => option.optionId)).size !== options.length
  ) return undefined;
  const optionKeys = new Set(options.map((option) => `${option.itemId}\u0000${option.optionId}`));
  if (choices.some((choice) => !optionKeys.has(`${choice.itemId}\u0000${choice.optionId}`))) {
    return undefined;
  }
  return {
    planId: record.planId,
    commandId: record.commandId,
    choices,
    options,
  };
}

function parseRunContext(value: unknown): CaptureWorkspaceRunContextV1 | null | undefined {
  if (value === null) return null;
  const record = dataRecord(value);
  if (!record ||
      !hasOnlyKeys(record, [
        "commandId", "planId", "draftId", "draftRevision",
        "requestedFreeVideoItemIds", "licensed", "status", "reconciliationState", "runId",
        "needsManualReconcile",
      ]) ||
      typeof record.commandId !== "string" ||
      !CAPTURE_RUN_COMMAND_ID_PATTERN.test(record.commandId) ||
      !safeId(record.planId) || !safeId(record.draftId) ||
      !safeNonNegative(record.draftRevision) || typeof record.licensed !== "boolean" ||
      typeof record.needsManualReconcile !== "boolean" ||
      (record.status !== "pending" && record.status !== "committed")) {
    return undefined;
  }
  const requestedFreeVideoItemIds = parseBoundedArray(
    record.requestedFreeVideoItemIds,
    200,
    (item) => safeId(item) ? item : undefined,
  );
  if (!requestedFreeVideoItemIds ||
      new Set(requestedFreeVideoItemIds).size !== requestedFreeVideoItemIds.length ||
      (record.licensed && requestedFreeVideoItemIds.length > 0)) {
    return undefined;
  }
  if (record.status === "pending") {
    if (record.reconciliationState !== "pending" || record.runId !== undefined) return undefined;
  } else if (
    !safeId(record.runId) ||
    (record.reconciliationState !== "committed_missing_run" &&
      record.reconciliationState !== "committed_recovery_needed")
  ) {
    return undefined;
  }
  const base: CaptureWorkspaceRunContextBaseV1 = {
    commandId: record.commandId,
    planId: record.planId,
    draftId: record.draftId,
    draftRevision: record.draftRevision,
    requestedFreeVideoItemIds,
    licensed: record.licensed,
    needsManualReconcile: record.needsManualReconcile,
  };
  return record.status === "pending"
    ? { ...base, status: "pending", reconciliationState: "pending" }
    : {
        ...base,
        status: "committed",
        reconciliationState: record.reconciliationState as
          "committed_missing_run" | "committed_recovery_needed",
        runId: record.runId as string,
      };
}

function parseQuickCaptureContext(
  value: unknown,
): CaptureWorkspaceQuickCaptureContextV1 | null | undefined {
  if (value === null) return null;
  const record = dataRecord(value);
  if (!record || !hasOnlyKeys(record, [
    "commandId",
    "runId",
    "planId",
    "itemId",
    "reconciliationState",
    "needsManualReconcile",
    "jobId",
  ])) return undefined;
  const identity = quickCaptureIdentity(record.commandId);
  if (
    !identity ||
    record.runId !== identity.runId ||
    record.planId !== identity.planId ||
    record.itemId !== identity.itemId ||
    (record.reconciliationState !== "pending" &&
      record.reconciliationState !== "commit_state_unknown" &&
      record.reconciliationState !== "recovery_needed") ||
    typeof record.needsManualReconcile !== "boolean" ||
    (record.jobId !== undefined &&
      (typeof record.jobId !== "string" || !CAPTURE_JOB_ID_PATTERN.test(record.jobId)))
  ) {
    return undefined;
  }
  return {
    commandId: identity.commandId,
    runId: identity.runId,
    planId: identity.planId,
    itemId: identity.itemId,
    reconciliationState: record.reconciliationState,
    needsManualReconcile: record.needsManualReconcile,
    ...(typeof record.jobId === "string" ? { jobId: record.jobId } : {}),
  };
}

export function parseCaptureWorkspaceClientResult(
  value: unknown,
): CaptureWorkspaceClientResult | undefined {
  const record = dataRecord(value);
  if (record?.ok !== true) return parsedFailure(record);
  if (!hasOnlyKeys(record, [
    "ok", "draft", "plans", "runs", "jobs", "manifests", "quota", "reviewContext", "runContext",
    "quickCaptureContext",
  ])) return undefined;
  const draft = record.draft;
  if (draft !== null && (!isPassiveData(draft) || !isCaptureDraftV1(draft))) return undefined;
  const plans = parseBoundedArray(record.plans, MAX_PLANS, (item) =>
    isPassiveData(item) && isCaptureReviewPlanV1(item) ? cloneCaptureReviewPlan(item) : undefined
  );
  const runs = parseBoundedArray(record.runs, MAX_RUNS, (item) =>
    isPassiveData(item) && isCaptureRunV1(item) ? clonePassive(item) : undefined
  );
  const jobs = parseBoundedArray(record.jobs, MAX_JOBS, (item) =>
    isPassiveData(item) && isCaptureJobV1(item) ? clonePassive(item) : undefined
  );
  const manifests = parseCaptureWorkspaceManifests(record.manifests);
  const quota = parseQuota(record.quota);
  const reviewContext = parseReviewContext(record.reviewContext);
  const runContext = parseRunContext(record.runContext);
  const quickCaptureContext = parseQuickCaptureContext(record.quickCaptureContext);
  if (
    !plans || !runs || !jobs || !manifests || !quota || reviewContext === undefined ||
    runContext === undefined || quickCaptureContext === undefined ||
    (runContext !== null && quickCaptureContext !== null)
  ) {
    return undefined;
  }
  const planIds = new Set(plans.map((plan) => plan.planId));
  const runIds = new Set(runs.map((run) => run.runId));
  const jobIds = new Set(jobs.map((job) => job.jobId));
  if (
    planIds.size !== plans.length || runIds.size !== runs.length || jobIds.size !== jobs.length
  ) return undefined;
  if (manifests.some((manifest) => {
    const run = runs.find((candidate) => candidate.runId === manifest.runId);
    return !run || run.planId.startsWith("capture-single-plan:");
  })) return undefined;
  const jobById = new Map(jobs.map((job) => [job.jobId, job]));
  const ownedJobIds = new Set<string>();
  for (const run of runs) {
    for (const jobId of run.orderedJobIds) {
      const job = jobById.get(jobId);
      if (!job || job.runId !== run.runId || ownedJobIds.has(jobId)) return undefined;
      ownedJobIds.add(jobId);
    }
  }
  if (ownedJobIds.size !== jobs.length) return undefined;
  if (reviewContext) {
    const contextPlan = plans.find((plan) => plan.planId === reviewContext.planId);
    if (!contextPlan || reviewContext.options.some((option) => {
      const item = contextPlan.items.find((candidate) => candidate.itemId === option.itemId);
      return !item || item.media.kind !== option.kind;
    })) return undefined;
  }
  if (runContext) {
    const contextPlan = plans.find((plan) => plan.planId === runContext.planId);
    const contextRun = runContext.status === "committed"
      ? runs.find((run) => run.runId === runContext.runId)
      : undefined;
    if (
      !contextPlan || contextPlan.draftId !== runContext.draftId ||
      contextPlan.draftRevision !== runContext.draftRevision ||
      runContext.requestedFreeVideoItemIds.some((itemId) => {
        const item = contextPlan.items.find((candidate) => candidate.itemId === itemId);
        return !item || !item.include || item.media.kind === "image";
      }) ||
      (runContext.status === "committed" &&
        (runContext.reconciliationState === "committed_missing_run"
          ? contextRun !== undefined
          : !contextRun ||
            contextRun.planId !== runContext.planId ||
            contextRun.draftId !== runContext.draftId ||
            contextRun.draftRevision !== runContext.draftRevision ||
            contextRun.commandId !== runContext.commandId.slice("capture-run-".length)))
    ) return undefined;
  }
  if (quickCaptureContext) {
    const identity = quickCaptureIdentity(quickCaptureContext.commandId);
    if (!identity) return undefined;
    const contextRun = runs.find((run) => run.runId === quickCaptureContext.runId);
    if (contextRun && (
      contextRun.planId !== quickCaptureContext.planId ||
      contextRun.draftId !== identity.draftId ||
      contextRun.draftRevision !== 1 ||
      contextRun.commandId !== identity.coordinatorCommandId ||
      contextRun.orderedJobIds.length !== 1
    )) return undefined;
    if (contextRun) {
      const contextJobId = contextRun.orderedJobIds[0];
      const contextJob = jobById.get(contextJobId);
      if (
        quickCaptureContext.jobId !== contextJobId ||
        !contextJob ||
        contextJob.runId !== quickCaptureContext.runId ||
        contextJob.itemId !== quickCaptureContext.itemId
      ) return undefined;
    } else if (quickCaptureContext.jobId !== undefined) {
      return undefined;
    }
  }
  return {
    ok: true,
    draft: draft === null ? null : cloneCaptureDraft(draft),
    plans,
    runs,
    jobs,
    manifests,
    quota,
    reviewContext,
    runContext,
    quickCaptureContext,
  };
}

async function send(request: CaptureReviewUiRequest): Promise<unknown> {
  const parsed = parseCaptureReviewUiRequest(request);
  if (!parsed) throw new TypeError("invalid_capture_review_request");
  return chrome.runtime.sendMessage(parsed);
}

export async function createCaptureReviewPlan(input: {
  draftId: string;
  expectedRevision: number;
  choices?: CapturePlanChoiceSelectorV1[];
  commandId?: string;
}): Promise<CapturePlanClientResult> {
  const requestedCommandId = input.commandId ?? createCapturePlanCommandId();
  const request = parseCaptureReviewUiRequest({
    type: "capture-plan-create",
    commandId: requestedCommandId,
    draftId: input.draftId,
    expectedRevision: input.expectedRevision,
    choices: input.choices ?? [],
  });
  if (!request || request.type !== "capture-plan-create") {
    return { ok: false, reason: "invalid_request", draft: null, commandId: requestedCommandId };
  }
  const commandId = request.commandId;
  try {
    const response = await send(request);
    const parsed = parseCapturePlanClientResult(response);
    const expectedPlanId = `capture-review-v1:${commandId.slice("capture-plan-".length)}`;
    if (
      parsed?.ok &&
      (parsed.plan.planId !== expectedPlanId ||
        parsed.plan.draftId !== input.draftId ||
        parsed.plan.draftRevision !== input.expectedRevision)
    ) {
      return { ok: false, reason: "mismatched_background_response", draft: null, commandId };
    }
    return parsed ? { ...parsed, commandId } : {
      ok: false,
      reason: "invalid_background_response",
      draft: null,
      commandId,
    };
  } catch {
    return { ok: false, reason: "outcome_unknown", draft: null, commandId };
  }
}

export async function enqueueCaptureReviewPlan(input: {
  planId: string;
  draftId: string;
  expectedRevision: number;
  freeVideoItemIds: string[];
  commandId?: string;
}): Promise<CaptureRunClientResult> {
  const requestedCommandId = input.commandId ?? createCaptureRunCommandId();
  const request = parseCaptureReviewUiRequest({
    type: "capture-run-enqueue",
    commandId: requestedCommandId,
    planId: input.planId,
    draftId: input.draftId,
    expectedRevision: input.expectedRevision,
    freeVideoItemIds: input.freeVideoItemIds,
  });
  if (!request || request.type !== "capture-run-enqueue") {
    return { ok: false, reason: "invalid_request", commandId: requestedCommandId };
  }
  const commandId = request.commandId;
  try {
    const response = await send(request);
    const parsed = parseCaptureRunClientResult(response);
    const expectedRunId = `capture-run:v1:${commandId.slice("capture-run-".length)}`;
    if (parsed?.ok && parsed.runId !== expectedRunId) {
      return { ok: false, reason: "mismatched_background_response", commandId };
    }
    return parsed ? { ...parsed, commandId } : {
      ok: false,
      reason: "invalid_background_response",
      commandId,
    };
  } catch {
    return { ok: false, reason: "outcome_unknown", commandId };
  }
}

export async function cancelCaptureJob(input: {
  jobId: string;
  attemptId: string;
  commandId?: string;
}): Promise<CaptureCancelClientResult> {
  const requestedCommandId = input.commandId ?? createCaptureCancelCommandId();
  const request = parseCaptureReviewUiRequest({
    type: "capture-job-cancel",
    commandId: requestedCommandId,
    jobId: input.jobId,
    attemptId: input.attemptId,
  });
  if (!request || request.type !== "capture-job-cancel") {
    return { ok: false, reason: "invalid_request", commandId: requestedCommandId };
  }
  const commandId = request.commandId;
  try {
    const response = await send(request);
    const parsed = parseCaptureCancelClientResult(response);
    if (
      parsed?.ok &&
      (parsed.job.jobId !== input.jobId || parsed.job.attemptId !== input.attemptId)
    ) {
      return { ok: false, reason: "mismatched_background_response", commandId };
    }
    return parsed ? { ...parsed, commandId } : {
      ok: false,
      reason: "invalid_background_response",
      commandId,
    };
  } catch {
    return { ok: false, reason: "outcome_unknown", commandId };
  }
}

export async function retryCaptureManifest(input: {
  runId: string;
  format: "json" | "csv";
  commandId?: string;
}): Promise<CaptureManifestRetryClientResult> {
  const requestedCommandId = input.commandId ?? createCaptureManifestRetryCommandId();
  const request = parseCaptureReviewUiRequest({
    type: "capture-manifest-retry",
    commandId: requestedCommandId,
    runId: input.runId,
    format: input.format,
  });
  if (!request || request.type !== "capture-manifest-retry") {
    return { ok: false, reason: "invalid_request", commandId: requestedCommandId };
  }
  const commandId = request.commandId;
  try {
    const response = await send(request);
    const parsed = parseCaptureManifestRetryClientResult(response);
    if (
      parsed?.ok &&
      (parsed.runId !== request.runId || parsed.format !== request.format)
    ) {
      return { ok: false, reason: "mismatched_background_response", commandId };
    }
    return parsed ? { ...parsed, commandId } : {
      ok: false,
      reason: "invalid_background_response",
      commandId,
    };
  } catch {
    // The caller must retain and replay this exact command ID. A fresh ID
    // could create a duplicate local export if Chrome accepted the first one.
    return { ok: false, reason: "outcome_unknown", commandId };
  }
}

export async function reconcileQuickCaptureStart(
  requestedCommandId: string,
): Promise<CaptureQuickReconcileClientResult> {
  const request = parseCaptureReviewUiRequest({
    type: "capture-quick-reconcile",
    commandId: requestedCommandId,
  });
  if (!request || request.type !== "capture-quick-reconcile") {
    return { ok: false, reason: "invalid_request", commandId: requestedCommandId };
  }
  const identity = quickCaptureIdentity(request.commandId);
  if (!identity) {
    return { ok: false, reason: "invalid_request", commandId: requestedCommandId };
  }
  const ownership = {
    commandId: identity.commandId,
    runId: identity.runId,
    planId: identity.planId,
    itemId: identity.itemId,
  };
  try {
    const response = await send(request);
    const parsed = parseCaptureQuickReconcileClientResult(response);
    if (!parsed) {
      return { ok: false, ...ownership, reason: "invalid_background_response" };
    }
    return parsed.ok
      ? { ok: true, ...ownership, jobId: parsed.jobId }
      : { ...ownership, ...parsed };
  } catch {
    return { ok: false, ...ownership, reason: "outcome_unknown" };
  }
}

export async function getCaptureWorkspace(): Promise<CaptureWorkspaceClientResult> {
  try {
    const response = await send({ type: "capture-workspace-get" });
    return parseCaptureWorkspaceClientResult(response) ?? {
      ok: false,
      reason: "invalid_background_response",
    };
  } catch {
    return { ok: false, reason: "background_unavailable" };
  }
}
