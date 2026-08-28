/**
 * Strict UI-to-background contracts for Capture Pack review and execution.
 *
 * These requests deliberately contain no media URL, captured header, planned
 * path, snapshot, quota timestamp, license assertion, or job body. A manifest
 * retry names only its background-issued run and format; the service worker
 * resolves every durable output and entitlement fact from guarded storage.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[a-z0-9._:-]+$/i;
const CAPTURE_OPTION_ID_PATTERN = /^capture-option-v1-[0-9a-f]{40}$/;
const CAPTURE_RUN_ID_PATTERN =
  /^capture-run:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ID_LENGTH = 256;
const MAX_CAPTURE_ITEMS = 200;

export type CapturePlanChoiceSelectorV1 = {
  itemId: string;
  /** Opaque option ID issued by the most recent background preflight. */
  optionId: string;
};

export type CaptureVariantDisabledReasonV1 =
  | "drm"
  | "live"
  | "unsupported_codec"
  | "unsupported_container"
  | "unsupported_manifest_shape"
  | "unsupported_audio"
  | "permanent_download_failure"
  | "invalid_media"
  | "over_size_cap";

/** Redacted, customer-displayable variant metadata issued by background. */
export type CaptureVariantOptionV1 = {
  itemId: string;
  optionId: string;
  kind: "hls" | "dash";
  label: string;
  width?: number;
  height?: number;
  videoBandwidth?: number;
  audioBandwidth?: number;
  combinedBandwidth?: number;
  durationSec?: number;
  estimatedBytes?: number;
  estimateConfidence: "exact" | "estimated" | "unknown";
  supported: boolean;
  disabledReason?: CaptureVariantDisabledReasonV1;
  /** The reviewed automatic policy selected this option for the current plan. */
  selectedByPolicy?: true;
  /** Smallest supported hard-cap-safe option when automatic rules need confirmation. */
  suggestedForConfirmation?: true;
};

export type CapturePlanCreateRequest = {
  type: "capture-plan-create";
  commandId: string;
  draftId: string;
  expectedRevision: number;
  choices: CapturePlanChoiceSelectorV1[];
};

export type CaptureRunEnqueueRequest = {
  type: "capture-run-enqueue";
  commandId: string;
  planId: string;
  draftId: string;
  expectedRevision: number;
  /** Exact videos the free customer chose to spend remaining slots on. */
  freeVideoItemIds: string[];
};

export type CaptureJobCancelRequest = {
  type: "capture-job-cancel";
  commandId: string;
  jobId: string;
  attemptId: string;
};

export type CaptureQuickReconcileRequest = {
  type: "capture-quick-reconcile";
  /** Original canonical Quick Capture intent; no media or entitlement replay. */
  commandId: string;
};

export type CaptureManifestRetryRequest = {
  type: "capture-manifest-retry";
  commandId: string;
  /** The background resolves the durable manifest record from this run. */
  runId: string;
  format: "json" | "csv";
};

export type CaptureWorkspaceGetRequest = {
  type: "capture-workspace-get";
};

export type CaptureReviewUiRequest =
  | CapturePlanCreateRequest
  | CaptureRunEnqueueRequest
  | CaptureJobCancelRequest
  | CaptureQuickReconcileRequest
  | CaptureManifestRetryRequest
  | CaptureWorkspaceGetRequest;

type DataRecord = Record<string, unknown>;

function dataType(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "type");
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function exactDataRecord(value: unknown, allowedKeys: readonly string[]): DataRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== allowedKeys.length ||
      ownKeys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    ) {
      return undefined;
    }
    const result = Object.create(null) as DataRecord;
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

function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID_PATTERN.test(value)
  );
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function canonicalPrefixedCommandId(value: unknown, prefix: string): string | undefined {
  if (typeof value !== "string" || !value.startsWith(prefix)) return undefined;
  const uuid = value.slice(prefix.length);
  return UUID_PATTERN.test(uuid) ? `${prefix}${uuid.toLowerCase()}` : undefined;
}

function parseIdArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CAPTURE_ITEMS) return undefined;
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !isSafeId(descriptor.value)) return undefined;
    result.push(descriptor.value);
  }
  return new Set(result).size === result.length ? result : undefined;
}

function parseChoices(value: unknown): CapturePlanChoiceSelectorV1[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CAPTURE_ITEMS) return undefined;
  const choices: CapturePlanChoiceSelectorV1[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return undefined;
    const choice = exactDataRecord(descriptor.value, ["itemId", "optionId"]);
    if (
      !choice ||
      !isSafeId(choice.itemId) ||
      typeof choice.optionId !== "string" ||
      !CAPTURE_OPTION_ID_PATTERN.test(choice.optionId)
    ) return undefined;
    choices.push({ itemId: choice.itemId, optionId: choice.optionId });
  }
  return new Set(choices.map((choice) => choice.itemId)).size === choices.length
    ? choices
    : undefined;
}

function parseCaptureReviewUiRequestUnsafe(value: unknown): CaptureReviewUiRequest | undefined {
  switch (dataType(value)) {
    case "capture-plan-create": {
      const record = exactDataRecord(value, [
        "type",
        "commandId",
        "draftId",
        "expectedRevision",
        "choices",
      ]);
      const choices = record ? parseChoices(record.choices) : undefined;
      const commandId = record
        ? canonicalPrefixedCommandId(record.commandId, "capture-plan-")
        : undefined;
      if (
        !record ||
        record.type !== "capture-plan-create" ||
        !commandId ||
        !isSafeId(record.draftId) ||
        !isRevision(record.expectedRevision) ||
        !choices
      ) {
        return undefined;
      }
      return {
        type: "capture-plan-create",
        commandId,
        draftId: record.draftId,
        expectedRevision: record.expectedRevision,
        choices,
      };
    }
    case "capture-run-enqueue": {
      const record = exactDataRecord(value, [
        "type",
        "commandId",
        "planId",
        "draftId",
        "expectedRevision",
        "freeVideoItemIds",
      ]);
      const freeVideoItemIds = record ? parseIdArray(record.freeVideoItemIds) : undefined;
      const commandId = record
        ? canonicalPrefixedCommandId(record.commandId, "capture-run-")
        : undefined;
      if (
        !record ||
        record.type !== "capture-run-enqueue" ||
        !commandId ||
        !isSafeId(record.planId) ||
        !isSafeId(record.draftId) ||
        !isRevision(record.expectedRevision) ||
        !freeVideoItemIds
      ) {
        return undefined;
      }
      return {
        type: "capture-run-enqueue",
        commandId,
        planId: record.planId,
        draftId: record.draftId,
        expectedRevision: record.expectedRevision,
        freeVideoItemIds,
      };
    }
    case "capture-job-cancel": {
      const record = exactDataRecord(value, [
        "type",
        "commandId",
        "jobId",
        "attemptId",
      ]);
      const commandId = record
        ? canonicalPrefixedCommandId(record.commandId, "capture-cancel-")
        : undefined;
      if (
        !record ||
        record.type !== "capture-job-cancel" ||
        !commandId ||
        !isSafeId(record.jobId) ||
        !isSafeId(record.attemptId)
      ) {
        return undefined;
      }
      return {
        type: "capture-job-cancel",
        commandId,
        jobId: record.jobId,
        attemptId: record.attemptId,
      };
    }
    case "capture-quick-reconcile": {
      const record = exactDataRecord(value, ["type", "commandId"]);
      const commandId = record
        ? canonicalPrefixedCommandId(record.commandId, "download-")
        : undefined;
      return record?.type === "capture-quick-reconcile" && commandId
        ? { type: "capture-quick-reconcile", commandId }
        : undefined;
    }
    case "capture-manifest-retry": {
      const record = exactDataRecord(value, ["type", "commandId", "runId", "format"]);
      const commandId = record
        ? canonicalPrefixedCommandId(record.commandId, "capture-manifest-retry-")
        : undefined;
      if (
        !record ||
        record.type !== "capture-manifest-retry" ||
        !commandId ||
        typeof record.runId !== "string" ||
        !CAPTURE_RUN_ID_PATTERN.test(record.runId) ||
        (record.format !== "json" && record.format !== "csv")
      ) {
        return undefined;
      }
      return {
        type: "capture-manifest-retry",
        commandId,
        runId: record.runId,
        format: record.format,
      };
    }
    case "capture-workspace-get": {
      const record = exactDataRecord(value, ["type"]);
      return record?.type === "capture-workspace-get"
        ? { type: "capture-workspace-get" }
        : undefined;
    }
    default:
      return undefined;
  }
}

export function parseCaptureReviewUiRequest(value: unknown): CaptureReviewUiRequest | undefined {
  try {
    return parseCaptureReviewUiRequestUnsafe(value);
  } catch {
    return undefined;
  }
}

export function isCaptureReviewUiRequest(value: unknown): value is CaptureReviewUiRequest {
  return parseCaptureReviewUiRequest(value) !== undefined;
}

function createCommandId(prefix: string, randomUUID: () => string): string {
  const id = canonicalPrefixedCommandId(`${prefix}${randomUUID()}`, prefix);
  if (!id) {
    throw new TypeError("The UUID source returned an invalid Capture Pack command ID.");
  }
  return id;
}

export function createCapturePlanCommandId(
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  return createCommandId("capture-plan-", randomUUID);
}

export function createCaptureRunCommandId(
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  return createCommandId("capture-run-", randomUUID);
}

export function createCaptureCancelCommandId(
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  return createCommandId("capture-cancel-", randomUUID);
}

export function createCaptureManifestRetryCommandId(
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  return createCommandId("capture-manifest-retry-", randomUUID);
}
