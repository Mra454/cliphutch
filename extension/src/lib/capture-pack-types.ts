import { isSafeRelativeDownloadPath } from "./download-path";
import {
  MAX_VARIANT_BANDWIDTH,
  MAX_VARIANT_DIMENSION,
  MAX_VARIANT_DURATION_SEC,
  parseNormalizedVariantSelectorV1,
  type NormalizedVariantSelectorV1,
} from "./variant-options";
import {
  bestUnderCapEffectiveMaximumBytesV1,
  parseBestUnderCapQualityPolicyV1,
} from "./quality-policy";

export const CAPTURE_PACK_SCHEMA_VERSION = 1 as const;
export const MAX_CAPTURE_PLAN_ITEMS = 200;
export const MAX_CAPTURE_RUN_JOB_IDS = 200;
export const MAX_CAPTURE_MANIFEST_DOWNLOAD_IDS = 2;

const MAX_ID_LENGTH = 256;
const MAX_URL_LENGTH = 16_384;
const MAX_TITLE_LENGTH = 1_024;
const MAX_CONTENT_TYPE_LENGTH = 256;
const MAX_CONTENT_DISPOSITION_LENGTH = 2_048;
const MAX_CODECS_LENGTH = 1_024;
const MAX_DRAFT_NAME_LENGTH = 120;
export const MAX_CAPTURE_PAGE_FOLDER_LABEL_LENGTH = 120;
const MAX_PATH_LENGTH = 240;
const MAX_REASON_LENGTH = 2_048;
const MAX_ERROR_MESSAGE_LENGTH = 2_048;
const MAX_PROVENANCE_ENTRIES = 5;

export type MediaProvenanceV1 =
  | "network"
  | "rendered-image"
  | "picture"
  | "metadata"
  | "poster";

export type MediaSnapshotV1 = {
  mediaId: string;
  kind: "direct" | "hls" | "dash" | "image";
  url: string;
  detectedAt: number;
  firstSeenAt?: number;
  lastSeenAt?: number;
  pageUrl?: string;
  pageTitle?: string;
  contentType?: string;
  contentDisposition?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  bitrate?: number;
  codecs?: string;
  provenance: MediaProvenanceV1[];
  familyId?: string;
};

export type MediaFamilyRefV1 = {
  familyId: string;
};

/**
 * Background-frozen explanation of the exact copy selected for a draft item.
 * `candidateId` always addresses the item's own immutable media snapshot; the
 * contract never carries alternate URLs or other transient shelf records.
 */
export type CaptureCopyChoiceV1 = {
  candidateId: string;
  confidence: "exact" | "high" | "unproven";
  reason: string;
};

export type QualityPolicyV1 =
  | { mode: "manual" }
  | { mode: "best_under_cap"; maxEstimatedBytes: number; maxHeight?: number };

type StreamQualityMetadataV1 = {
  label?: string;
  width?: number;
  height?: number;
  videoBandwidth?: number;
  audioBandwidth?: number;
  combinedBandwidth?: number;
  durationSec?: number;
  estimatedBytes?: number;
  estimateConfidence: "exact" | "estimated" | "unknown";
};

/**
 * Persistence-safe C7 stream choice. Its opaque selector is resolved only
 * against a freshly fetched manifest; no child URL or raw DASH locator crosses
 * the normal Capture Pack plan/job boundary.
 */
export type PersistentStreamQualityChoiceV1 = StreamQualityMetadataV1 & {
  mode: "stream";
  policy: QualityPolicyV1;
  selector: NormalizedVariantSelectorV1;
  maxDownloadBytes: number;
  /** Legacy fields are present in the type only to keep union reads ergonomic. */
  variantKind?: undefined;
  variantUrl?: undefined;
  representationId?: undefined;
  fixedVariantId?: undefined;
};

type LegacyHlsStreamQualityChoiceV1 = StreamQualityMetadataV1 & {
  mode: "stream";
  policy: QualityPolicyV1;
  variantKind: "hls";
  variantUrl: string;
  fixedVariantId?: string;
  selector?: undefined;
  maxDownloadBytes?: undefined;
  representationId?: undefined;
};

type LegacyDashStreamQualityChoiceV1 = StreamQualityMetadataV1 & {
  mode: "stream";
  policy: QualityPolicyV1;
  variantKind: "dash";
  representationId: string;
  fixedVariantId?: string;
  selector?: undefined;
  maxDownloadBytes?: undefined;
  variantUrl?: undefined;
};

type LegacyGenericStreamQualityChoiceV1 = StreamQualityMetadataV1 & {
  /** Read-only compatibility for pre-contract session jobs. */
  mode: "stream";
  policy: QualityPolicyV1;
  variantKind?: undefined;
  fixedVariantId: string;
  selector?: undefined;
  maxDownloadBytes?: undefined;
  variantUrl?: undefined;
  representationId?: undefined;
};

export type QualityChoiceV1 =
  | { mode: "direct" }
  | PersistentStreamQualityChoiceV1
  | LegacyHlsStreamQualityChoiceV1
  | LegacyDashStreamQualityChoiceV1
  | LegacyGenericStreamQualityChoiceV1;

export type CaptureDraftPreferencesV1 = {
  folderMode: "pack_page";
  manifestFormats: Array<"json" | "csv">;
  qualityPolicy: QualityPolicyV1;
};

export type CaptureDraftItemV1 = {
  itemId: string;
  addedAt: number;
  sourceTabId?: number;
  /** Canonical, customer-authored folder label shared by one exact source page. */
  pageFolderLabel?: string;
  media: MediaSnapshotV1;
  family?: MediaFamilyRefV1;
  /** Optional only for drafts written before copy recommendations shipped. */
  copyChoice?: CaptureCopyChoiceV1;
  headerLeaseId?: string;
};

export type CaptureDraftV1 = {
  schemaVersion: typeof CAPTURE_PACK_SCHEMA_VERSION;
  draftId: string;
  revision: number;
  name: string;
  createdAt: number;
  updatedAt: number;
  orderedItemIds: string[];
  items: Record<string, CaptureDraftItemV1>;
  preferences: CaptureDraftPreferencesV1;
};

export type CapturePlanWarningV1 = {
  code: string;
  message: string;
};

export type CaptureManifestFormatV1 = "json" | "csv";

/**
 * Immutable, customer-reviewed manifest contract. The planner freezes this
 * independently from draft preferences so execution and retries cannot pick
 * up a later Hutch edit. Quick Capture plans deliberately omit this object.
 */
export type CaptureManifestSpecV1 = {
  schemaVersion: typeof CAPTURE_PACK_SCHEMA_VERSION;
  formats: CaptureManifestFormatV1[];
  packName: string;
  createdAt: number;
  itemAddedAt: Record<string, number>;
};

type CapturePlanItemBaseV1 = {
  itemId: string;
  include: boolean;
  media: MediaSnapshotV1;
  plannedRelativePath: string;
  copyChoice: CaptureCopyChoiceV1;
  warnings: CapturePlanWarningV1[];
};

export type CapturePlanItemV1 =
  | (CapturePlanItemBaseV1 & {
      readiness: "ready";
      qualityChoice: QualityChoiceV1;
    })
  | (CapturePlanItemBaseV1 & {
      readiness: "needs_choice" | "unsupported" | "stale";
      /** An unresolved/blocked item must never carry an executable selector. */
      qualityChoice?: never;
    });

export type CaptureReviewPlanV1 = {
  schemaVersion: typeof CAPTURE_PACK_SCHEMA_VERSION;
  planId: string;
  draftId: string;
  draftRevision: number;
  generatedAt: number;
  relativeRoot: string;
  manifestSpec?: CaptureManifestSpecV1;
  items: CapturePlanItemV1[];
  totals: {
    included: number;
    videos: number;
    stills: number;
    estimatedBytes?: number;
    unknownSizeCount: number;
    requiredFreeVideoSlots: number;
  };
};

export type CaptureRunStatusV1 =
  | "queued"
  | "running"
  | "complete"
  | "partial"
  | "cancelled";

export type CaptureRunV1 = {
  schemaVersion: typeof CAPTURE_PACK_SCHEMA_VERSION;
  runId: string;
  planId: string;
  draftId: string;
  draftRevision: number;
  planDigest: string;
  commandId: string;
  createdAt: number;
  status: CaptureRunStatusV1;
  orderedJobIds: string[];
  manifestDownloadIds?: number[];
};

export type CaptureJobStateV1 =
  | "prepared"
  | "queued"
  | "starting"
  | "running"
  | "processing"
  | "delivery_pending"
  | "saving"
  | "complete"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "save_state_unknown";

export type CaptureJobV1 = {
  schemaVersion: typeof CAPTURE_PACK_SCHEMA_VERSION;
  jobId: string;
  runId: string;
  itemId: string;
  attemptId: string;
  attemptNo: number;
  revision: number;
  resourceClass: "native" | "heavy";
  state: CaptureJobStateV1;
  snapshot: {
    media: MediaSnapshotV1;
    plannedRelativePath: string;
    quality: QualityChoiceV1;
    headerLeaseId?: string;
  };
  progress?: {
    phase: "queued" | "fetching" | "processing" | "saving";
    completed?: number;
    total?: number;
    bytes?: number;
    ratio?: number;
  };
  quotaReservationId?: string;
  downloadId?: number;
  result?: { actualBasename?: string; sizeBytes?: number };
  error?: { code: string; customerMessage: string; retryable: boolean };
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function isStringWithin(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0)
  );
}

function isOptionalStringWithin(
  value: unknown,
  maxLength: number,
  allowEmpty = true,
): value is string | undefined {
  return value === undefined || isStringWithin(value, maxLength, allowEmpty);
}

const CAPTURE_OPAQUE_ID_PATTERN = /^[a-z0-9._:-]+$/i;

function isOptionalCaptureOpaqueId(value: unknown): value is string | undefined {
  return value === undefined || (
    isStringWithin(value, MAX_ID_LENGTH) && CAPTURE_OPAQUE_ID_PATTERN.test(value)
  );
}

const UNSAFE_CAPTURE_LABEL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/**
 * Canonicalizes a page-folder label submitted by the UI. `null` means reset;
 * `undefined` means hostile or otherwise invalid input.
 */
export function normalizeCapturePageFolderLabel(
  value: unknown,
): string | null | undefined {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > MAX_CAPTURE_PAGE_FOLDER_LABEL_LENGTH ||
    UNSAFE_CAPTURE_LABEL_PATTERN.test(value)
  ) {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  return normalized.length <= MAX_CAPTURE_PAGE_FOLDER_LABEL_LENGTH
    ? normalized
    : undefined;
}

function isCanonicalCapturePageFolderLabel(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  const normalized = normalizeCapturePageFolderLabel(value);
  return typeof normalized === "string" && normalized === value;
}

function isHttpUrl(value: unknown): value is string {
  if (!isStringWithin(value, MAX_URL_LENGTH)) return false;
  const parsed = new URL(value);
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function isOptionalHttpUrl(value: unknown): value is string | undefined {
  return value === undefined || isHttpUrl(value);
}

function isSafeClipHutchDownloadPath(value: unknown): value is string {
  return (
    isStringWithin(value, MAX_PATH_LENGTH) &&
    value.startsWith("ClipHutch/") &&
    isSafeRelativeDownloadPath(value)
  );
}

function isSafeClipHutchRoot(value: unknown): value is string {
  return (
    isStringWithin(value, MAX_PATH_LENGTH - 13) &&
    value.split("/").length === 2 &&
    value.startsWith("ClipHutch/") &&
    isSafeRelativeDownloadPath(`${value}/capture.bin`)
  );
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalFiniteNonNegative(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNonNegative(value);
}

function isOptionalSafeNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || isSafeNonNegativeInteger(value);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.some((option) => option === value);
}

function isBoundedIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => isStringWithin(entry, MAX_ID_LENGTH));
}

const MEDIA_KINDS = ["direct", "hls", "dash", "image"] as const;
const MEDIA_PROVENANCE = [
  "network",
  "rendered-image",
  "picture",
  "metadata",
  "poster",
] as const;
const ESTIMATE_CONFIDENCE = ["exact", "estimated", "unknown"] as const;
const PLAN_READINESS = ["ready", "needs_choice", "unsupported", "stale"] as const;
const COPY_CONFIDENCE = ["exact", "high", "unproven"] as const;
const UNSAFE_COPY_REASON_PATTERN =
  /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const RUN_STATUSES = ["queued", "running", "complete", "partial", "cancelled"] as const;
const JOB_STATES = [
  "prepared",
  "queued",
  "starting",
  "running",
  "processing",
  "delivery_pending",
  "saving",
  "complete",
  "failed",
  "cancelling",
  "cancelled",
  "save_state_unknown",
] as const;
const PROGRESS_PHASES = ["queued", "fetching", "processing", "saving"] as const;

function isMediaSnapshotV1Unsafe(value: unknown): value is MediaSnapshotV1 {
  const record = asRecord(value);
  if (!record) return false;
  if (
    !isStringWithin(record.mediaId, MAX_ID_LENGTH) ||
    !isOneOf(record.kind, MEDIA_KINDS) ||
    !isHttpUrl(record.url) ||
    !isFiniteNonNegative(record.detectedAt) ||
    !isOptionalFiniteNonNegative(record.firstSeenAt) ||
    !isOptionalFiniteNonNegative(record.lastSeenAt) ||
    !isOptionalHttpUrl(record.pageUrl) ||
    !isOptionalStringWithin(record.pageTitle, MAX_TITLE_LENGTH) ||
    !isOptionalStringWithin(record.contentType, MAX_CONTENT_TYPE_LENGTH) ||
    !isOptionalStringWithin(record.contentDisposition, MAX_CONTENT_DISPOSITION_LENGTH) ||
    !isOptionalSafeNonNegativeInteger(record.sizeBytes) ||
    !isOptionalSafeNonNegativeInteger(record.width) ||
    !isOptionalSafeNonNegativeInteger(record.height) ||
    !isOptionalFiniteNonNegative(record.durationSec) ||
    !isOptionalFiniteNonNegative(record.bitrate) ||
    !isOptionalStringWithin(record.codecs, MAX_CODECS_LENGTH) ||
    !isOptionalStringWithin(record.familyId, MAX_ID_LENGTH, false)
  ) {
    return false;
  }
  if (record.firstSeenAt !== undefined && record.firstSeenAt > record.detectedAt) return false;
  if (record.lastSeenAt !== undefined && record.lastSeenAt < record.detectedAt) return false;
  if (
    record.firstSeenAt !== undefined &&
    record.lastSeenAt !== undefined &&
    record.firstSeenAt > record.lastSeenAt
  ) {
    return false;
  }
  if (
    !Array.isArray(record.provenance) ||
    record.provenance.length === 0 ||
    record.provenance.length > MAX_PROVENANCE_ENTRIES
  ) {
    return false;
  }
  if (!record.provenance.every((entry) => isOneOf(entry, MEDIA_PROVENANCE))) return false;
  return new Set(record.provenance).size === record.provenance.length;
}

export function isMediaSnapshotV1(value: unknown): value is MediaSnapshotV1 {
  try {
    return isMediaSnapshotV1Unsafe(value);
  } catch {
    return false;
  }
}

function isMediaFamilyRefV1Unsafe(value: unknown): value is MediaFamilyRefV1 {
  const record = asRecord(value);
  return Boolean(record && isStringWithin(record.familyId, MAX_ID_LENGTH));
}

export function isMediaFamilyRefV1(value: unknown): value is MediaFamilyRefV1 {
  try {
    return isMediaFamilyRefV1Unsafe(value);
  } catch {
    return false;
  }
}

function isQualityPolicyV1Unsafe(value: unknown): value is QualityPolicyV1 {
  const record = asRecord(value);
  if (!record) return false;
  if (record.mode === "manual") return true;
  return (
    record.mode === "best_under_cap" &&
    isSafeNonNegativeInteger(record.maxEstimatedBytes) &&
    record.maxEstimatedBytes > 0 &&
    isOptionalSafeNonNegativeInteger(record.maxHeight) &&
    (record.maxHeight === undefined || record.maxHeight > 0)
  );
}

export function isQualityPolicyV1(value: unknown): value is QualityPolicyV1 {
  try {
    return isQualityPolicyV1Unsafe(value);
  } catch {
    return false;
  }
}

function hasExactOwnDataKeys(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !keys.includes(key))
  ) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && "value" in descriptor);
  });
}

function isExactPersistentPolicy(value: unknown): value is QualityPolicyV1 {
  if (!hasExactOwnDataKeys(
    value,
    ["mode", "maxEstimatedBytes", "maxHeight"],
    ["mode"],
  )) return false;
  if (value.mode === "manual") return Reflect.ownKeys(value).length === 1;
  return parseBestUnderCapQualityPolicyV1(value) !== undefined;
}

const PERSISTENT_STREAM_QUALITY_KEYS = [
  "mode",
  "policy",
  "selector",
  "maxDownloadBytes",
  "label",
  "width",
  "height",
  "videoBandwidth",
  "audioBandwidth",
  "combinedBandwidth",
  "durationSec",
  "estimatedBytes",
  "estimateConfidence",
] as const;

function isOptionalPositiveSafeIntegerWithin(
  value: unknown,
  maximum: number,
): value is number | undefined {
  return value === undefined || (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
  );
}

function projectedQualityBytes(
  combinedBandwidth: number | undefined,
  durationSec: number | undefined,
): number | undefined {
  if (combinedBandwidth === undefined || durationSec === undefined) return undefined;
  const value = Math.ceil(combinedBandwidth * (durationSec / 8));
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isPersistentStreamQualityChoiceV1Unsafe(
  value: unknown,
): value is PersistentStreamQualityChoiceV1 {
  if (!hasExactOwnDataKeys(
    value,
    PERSISTENT_STREAM_QUALITY_KEYS,
    ["mode", "policy", "selector", "maxDownloadBytes", "estimateConfidence"],
  )) return false;
  const selector = parseNormalizedVariantSelectorV1(value.selector);
  if (
    value.mode !== "stream" ||
    !isExactPersistentPolicy(value.policy) ||
    !selector ||
    !isStringWithin(selector.stableId, MAX_ID_LENGTH) ||
    !isOptionalStringWithin(value.label, MAX_TITLE_LENGTH) ||
    (typeof value.label === "string" && UNSAFE_CAPTURE_LABEL_PATTERN.test(value.label)) ||
    !isOptionalPositiveSafeIntegerWithin(value.width, MAX_VARIANT_DIMENSION) ||
    !isOptionalPositiveSafeIntegerWithin(value.height, MAX_VARIANT_DIMENSION) ||
    !isOptionalPositiveSafeIntegerWithin(value.videoBandwidth, MAX_VARIANT_BANDWIDTH) ||
    !isOptionalPositiveSafeIntegerWithin(value.audioBandwidth, MAX_VARIANT_BANDWIDTH) ||
    !isOptionalPositiveSafeIntegerWithin(value.combinedBandwidth, MAX_VARIANT_BANDWIDTH) ||
    !(typeof value.durationSec === "undefined" || (
      typeof value.durationSec === "number" &&
      Number.isFinite(value.durationSec) &&
      value.durationSec > 0 &&
      value.durationSec <= MAX_VARIANT_DURATION_SEC
    )) ||
    !isOptionalSafeNonNegativeInteger(value.estimatedBytes) ||
    !isOneOf(value.estimateConfidence, ESTIMATE_CONFIDENCE) ||
    !(typeof value.maxDownloadBytes === "number" &&
      Number.isSafeInteger(value.maxDownloadBytes) && value.maxDownloadBytes > 0)
  ) return false;

  const videoBandwidth = value.videoBandwidth;
  const audioBandwidth = value.audioBandwidth;
  if (
    (audioBandwidth !== undefined && videoBandwidth === undefined) ||
    (audioBandwidth !== undefined && videoBandwidth !== undefined &&
      (videoBandwidth > MAX_VARIANT_BANDWIDTH - audioBandwidth ||
        value.combinedBandwidth !== videoBandwidth + audioBandwidth)) ||
    (value.videoBandwidth !== undefined &&
      value.audioBandwidth === undefined &&
      value.combinedBandwidth !== undefined &&
      value.combinedBandwidth !== value.videoBandwidth) ||
    (value.estimateConfidence === "unknown" && value.estimatedBytes !== undefined) ||
    (value.estimateConfidence !== "unknown" && value.estimatedBytes === undefined) ||
    (value.estimateConfidence === "unknown" &&
      projectedQualityBytes(value.combinedBandwidth, value.durationSec) !== undefined) ||
    (value.estimateConfidence === "estimated" &&
      projectedQualityBytes(value.combinedBandwidth, value.durationSec) !== value.estimatedBytes) ||
    (value.estimatedBytes !== undefined && value.estimatedBytes > value.maxDownloadBytes)
  ) return false;

  if (value.policy.mode === "best_under_cap") {
    if (
      value.maxDownloadBytes !== value.policy.maxEstimatedBytes ||
      value.estimateConfidence === "unknown" ||
      value.estimatedBytes === undefined ||
      value.estimatedBytes > bestUnderCapEffectiveMaximumBytesV1(value.maxDownloadBytes) ||
      (value.policy.maxHeight !== undefined &&
        (value.height === undefined || value.height > value.policy.maxHeight))
    ) return false;
  }
  return true;
}

export function isPersistentStreamQualityChoiceV1(
  value: unknown,
): value is PersistentStreamQualityChoiceV1 {
  try {
    return isPersistentStreamQualityChoiceV1Unsafe(value);
  } catch {
    return false;
  }
}

function isQualityChoiceV1Unsafe(value: unknown): value is QualityChoiceV1 {
  const record = asRecord(value);
  if (!record) return false;
  if (record.mode === "direct") return true;
  if (record.selector !== undefined || record.maxDownloadBytes !== undefined) {
    return isPersistentStreamQualityChoiceV1Unsafe(value);
  }
  if (!(
    record.mode === "stream" &&
    isQualityPolicyV1(record.policy) &&
    isOptionalStringWithin(record.label, MAX_TITLE_LENGTH) &&
    isOptionalSafeNonNegativeInteger(record.width) &&
    isOptionalSafeNonNegativeInteger(record.height) &&
    isOptionalFiniteNonNegative(record.videoBandwidth) &&
    isOptionalFiniteNonNegative(record.audioBandwidth) &&
    isOptionalFiniteNonNegative(record.combinedBandwidth) &&
    (record.durationSec === undefined ||
      (typeof record.durationSec === "number" && Number.isFinite(record.durationSec) &&
        record.durationSec >= 0)) &&
    isOptionalSafeNonNegativeInteger(record.estimatedBytes) &&
    isOneOf(record.estimateConfidence, ESTIMATE_CONFIDENCE)
  )) {
    return false;
  }
  if (record.variantKind === "hls") {
    if (!isHttpUrl(record.variantUrl)) return false;
    if (record.fixedVariantId !== undefined && record.fixedVariantId !== record.variantUrl) return false;
  } else if (record.variantKind === "dash") {
    if (!isStringWithin(record.representationId, MAX_ID_LENGTH)) return false;
    if (
      record.fixedVariantId !== undefined &&
      record.fixedVariantId !== record.representationId
    ) return false;
  } else if (
    record.variantKind !== undefined ||
    !isStringWithin(record.fixedVariantId, MAX_ID_LENGTH)
  ) {
    return false;
  }
  return record.estimateConfidence === "unknown"
    ? record.estimatedBytes === undefined
    : record.estimatedBytes !== undefined;
}

export function isQualityChoiceV1(value: unknown): value is QualityChoiceV1 {
  try {
    return isQualityChoiceV1Unsafe(value);
  } catch {
    return false;
  }
}

function isCaptureDraftPreferencesV1Unsafe(
  value: unknown,
): value is CaptureDraftPreferencesV1 {
  const record = asRecord(value);
  if (!record || record.folderMode !== "pack_page" || !isQualityPolicyV1(record.qualityPolicy)) {
    return false;
  }
  if (!Array.isArray(record.manifestFormats)) return false;
  return record.manifestFormats.length === 1
    ? record.manifestFormats[0] === "json"
    : record.manifestFormats.length === 2 &&
      record.manifestFormats[0] === "json" &&
      record.manifestFormats[1] === "csv";
}

export function isCaptureDraftPreferencesV1(
  value: unknown,
): value is CaptureDraftPreferencesV1 {
  try {
    return isCaptureDraftPreferencesV1Unsafe(value);
  } catch {
    return false;
  }
}

function isCaptureDraftItemV1Unsafe(value: unknown): value is CaptureDraftItemV1 {
  const record = asRecord(value);
  const copyChoice = record?.copyChoice === undefined
    ? undefined
    : asRecord(record.copyChoice);
  const valid = Boolean(
    record &&
      isStringWithin(record.itemId, MAX_ID_LENGTH) &&
      isFiniteNonNegative(record.addedAt) &&
      isOptionalSafeNonNegativeInteger(record.sourceTabId) &&
      isCanonicalCapturePageFolderLabel(record.pageFolderLabel) &&
      isMediaSnapshotV1(record.media) &&
      (record.family === undefined || isMediaFamilyRefV1(record.family)) &&
      (record.copyChoice === undefined || (
        copyChoice &&
        isStringWithin(copyChoice.candidateId, MAX_ID_LENGTH) &&
        isOneOf(copyChoice.confidence, COPY_CONFIDENCE) &&
        isStringWithin(copyChoice.reason, MAX_REASON_LENGTH) &&
        !UNSAFE_COPY_REASON_PATTERN.test(copyChoice.reason as string)
      )) &&
      isOptionalCaptureOpaqueId(record.headerLeaseId),
  );
  if (!valid || !record) return false;
  const media = asRecord(record.media);
  if (copyChoice && copyChoice.candidateId !== media?.mediaId) return false;
  return record.pageFolderLabel === undefined || media?.pageUrl !== undefined;
}

export function isCaptureDraftItemV1(value: unknown): value is CaptureDraftItemV1 {
  try {
    return isCaptureDraftItemV1Unsafe(value);
  } catch {
    return false;
  }
}

function isCaptureDraftV1Unsafe(value: unknown): value is CaptureDraftV1 {
  const record = asRecord(value);
  if (
    !record ||
    record.schemaVersion !== CAPTURE_PACK_SCHEMA_VERSION ||
    !isStringWithin(record.draftId, MAX_ID_LENGTH) ||
    !isSafeNonNegativeInteger(record.revision) ||
    !isStringWithin(record.name, MAX_DRAFT_NAME_LENGTH) ||
    !isFiniteNonNegative(record.createdAt) ||
    !isFiniteNonNegative(record.updatedAt) ||
    record.updatedAt < record.createdAt ||
    !isBoundedIdArray(record.orderedItemIds) ||
    !isCaptureDraftPreferencesV1(record.preferences)
  ) {
    return false;
  }

  const items = asRecord(record.items);
  if (!items || new Set(record.orderedItemIds).size !== record.orderedItemIds.length) return false;
  const itemKeys = Object.keys(items);
  if (itemKeys.length !== record.orderedItemIds.length) return false;
  const folderLabelsByPage = new Map<string, string | null>();
  for (const itemId of record.orderedItemIds) {
    if (!Object.prototype.hasOwnProperty.call(items, itemId)) return false;
    const item = items[itemId];
    if (!isCaptureDraftItemV1(item) || item.itemId !== itemId) return false;
    if (item.media.pageUrl !== undefined) {
      const pageUrl = new URL(item.media.pageUrl).href;
      const label = item.pageFolderLabel ?? null;
      if (folderLabelsByPage.has(pageUrl) && folderLabelsByPage.get(pageUrl) !== label) {
        return false;
      }
      folderLabelsByPage.set(pageUrl, label);
    }
  }
  return true;
}

export function isCaptureDraftV1(value: unknown): value is CaptureDraftV1 {
  try {
    return isCaptureDraftV1Unsafe(value);
  } catch {
    return false;
  }
}

function isCapturePlanWarningV1(value: unknown): value is CapturePlanWarningV1 {
  const record = asRecord(value);
  return Boolean(
    record &&
      isStringWithin(record.code, MAX_ID_LENGTH) &&
      isStringWithin(record.message, MAX_ERROR_MESSAGE_LENGTH),
  );
}

function isCapturePlanItemV1(value: unknown, allowLegacy = false): value is CapturePlanItemV1 {
  const record = asRecord(value);
  if (!record) return false;
  const copyChoice = asRecord(record.copyChoice);
  const baseValid = Boolean(
    isStringWithin(record.itemId, MAX_ID_LENGTH) &&
      typeof record.include === "boolean" &&
      isMediaSnapshotV1(record.media) &&
      isSafeClipHutchDownloadPath(record.plannedRelativePath) &&
      isOneOf(record.readiness, PLAN_READINESS) &&
      copyChoice &&
      isStringWithin(copyChoice.candidateId, MAX_ID_LENGTH) &&
      isOneOf(copyChoice.confidence, COPY_CONFIDENCE) &&
      isStringWithin(copyChoice.reason, MAX_REASON_LENGTH) &&
      Array.isArray(record.warnings) &&
      record.warnings.every(isCapturePlanWarningV1)
  );
  if (!baseValid || !copyChoice) return false;
  const media = record.media as MediaSnapshotV1;
  if (
    copyChoice.candidateId !== media.mediaId ||
    UNSAFE_COPY_REASON_PATTERN.test(copyChoice.reason as string)
  ) {
    return false;
  }
  if (record.readiness === "ready") {
    return isQualityChoiceV1(record.qualityChoice) &&
      isQualityCompatibleWithMedia(media, record.qualityChoice, allowLegacy);
  }
  if (record.qualityChoice !== undefined) return false;
  return record.readiness !== "needs_choice" ||
    media.kind === "hls" ||
    media.kind === "dash";
}

function isCaptureManifestSpecV1ForPlan(
  value: unknown,
  itemIds: readonly string[],
  generatedAt: number,
): value is CaptureManifestSpecV1 {
  const record = asRecord(value);
  if (
    !record ||
    record.schemaVersion !== CAPTURE_PACK_SCHEMA_VERSION ||
    !Array.isArray(record.formats) ||
    record.formats.length < 1 ||
    record.formats.length > MAX_CAPTURE_MANIFEST_DOWNLOAD_IDS ||
    record.formats[0] !== "json" ||
    !record.formats.every((format) => format === "json" || format === "csv") ||
    new Set(record.formats).size !== record.formats.length ||
    !isStringWithin(record.packName, MAX_DRAFT_NAME_LENGTH) ||
    !isFiniteNonNegative(record.createdAt) ||
    record.createdAt > generatedAt
  ) {
    return false;
  }
  const addedAt = asRecord(record.itemAddedAt);
  if (!addedAt || Object.keys(addedAt).length !== itemIds.length) return false;
  for (const itemId of itemIds) {
    if (
      !Object.prototype.hasOwnProperty.call(addedAt, itemId) ||
      !isFiniteNonNegative(addedAt[itemId]) ||
      (addedAt[itemId] as number) < (record.createdAt as number) ||
      (addedAt[itemId] as number) > generatedAt
    ) {
      return false;
    }
  }
  return true;
}

export function isCaptureManifestSpecV1(value: unknown): value is CaptureManifestSpecV1 {
  try {
    const record = asRecord(value);
    if (!record) return false;
    const itemAddedAt = asRecord(record.itemAddedAt);
    if (!itemAddedAt) return false;
    return isCaptureManifestSpecV1ForPlan(value, Object.keys(itemAddedAt), Number.MAX_SAFE_INTEGER);
  } catch {
    return false;
  }
}

function isQualityCompatibleWithMedia(
  media: MediaSnapshotV1,
  quality: QualityChoiceV1,
  allowLegacy: boolean,
): boolean {
  if (isPersistentStreamQualityChoiceV1(quality)) {
    return (media.kind === "hls" || media.kind === "dash") &&
      quality.selector.kind === media.kind;
  }
  if (media.kind === "hls") {
    return quality.mode === "stream" &&
      (quality.variantKind === "hls" || (allowLegacy && quality.variantKind === undefined));
  }
  if (media.kind === "dash") {
    return quality.mode === "stream" &&
      (quality.variantKind === "dash" || (allowLegacy && quality.variantKind === undefined));
  }
  return quality.mode === "direct";
}

/**
 * Returns a defensible estimate of the final saved output, not merely the
 * detected source size. Keep every plan-total calculation on this one rule.
 */
export function capturePlanItemEstimatedOutputBytes(
  item: CapturePlanItemV1,
): number | undefined {
  if (item.readiness !== "ready") return undefined;
  if (item.media.kind === "direct") {
    const mime = item.media.contentType?.split(";")[0].trim().toLowerCase();
    let webmPath = false;
    try {
      webmPath = new URL(item.media.url).pathname.toLowerCase().endsWith(".webm");
    } catch {
      webmPath = false;
    }
    if (mime === "video/webm" || webmPath) return undefined;
  }
  return item.qualityChoice.mode === "stream"
    ? item.qualityChoice.estimatedBytes
    : item.media.sizeBytes;
}

/** Authoritative totals for both freshly generated and post-processed plans. */
export function captureReviewPlanTotalsForItems(
  items: readonly CapturePlanItemV1[],
): CaptureReviewPlanV1["totals"] | undefined {
  const included = items.filter((item) => item.include);
  const videos = included.filter((item) => item.media.kind !== "image").length;
  const stills = included.length - videos;
  const sizes = included.map(capturePlanItemEstimatedOutputBytes);
  const unknownSizeCount = sizes.filter((size) => size === undefined).length;
  const knownBytes = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
  if (!Number.isSafeInteger(knownBytes)) return undefined;
  return {
    included: included.length,
    videos,
    stills,
    ...(unknownSizeCount === 0 ? { estimatedBytes: knownBytes } : {}),
    unknownSizeCount,
    requiredFreeVideoSlots: videos,
  };
}

function isCaptureReviewPlanV1Unsafe(value: unknown): value is CaptureReviewPlanV1 {
  const record = asRecord(value);
  if (!record) return false;
  const totals = asRecord(record.totals);
  if (
    record.schemaVersion !== CAPTURE_PACK_SCHEMA_VERSION ||
    !isStringWithin(record.planId, MAX_ID_LENGTH) ||
    !isStringWithin(record.draftId, MAX_ID_LENGTH) ||
    !isSafeNonNegativeInteger(record.draftRevision) ||
    !isFiniteNonNegative(record.generatedAt) ||
    !isSafeClipHutchRoot(record.relativeRoot) ||
    !Array.isArray(record.items) ||
    record.items.length > MAX_CAPTURE_PLAN_ITEMS ||
    !record.items.every((item) => isCapturePlanItemV1(
      item,
      typeof record.planId === "string" && record.planId.startsWith("capture-single-plan:"),
    )) ||
    !totals ||
    !isSafeNonNegativeInteger(totals.included) ||
    !isSafeNonNegativeInteger(totals.videos) ||
    !isSafeNonNegativeInteger(totals.stills) ||
    !isOptionalSafeNonNegativeInteger(totals.estimatedBytes) ||
    !isSafeNonNegativeInteger(totals.unknownSizeCount) ||
    !isSafeNonNegativeInteger(totals.requiredFreeVideoSlots)
  ) {
    return false;
  }

  const items = record.items;
  if (new Set(items.map((item) => item.itemId)).size !== items.length) return false;
  // Quick Capture is deliberately a one-file fast path. Reject, rather than
  // merely ignore, a forged Quick plan that attempts to opt into Pack-only
  // manifest persistence or delivery.
  if (
    (record.planId as string).startsWith("capture-single-plan:") &&
    record.manifestSpec !== undefined
  ) {
    return false;
  }
  if (
    record.manifestSpec !== undefined &&
    !isCaptureManifestSpecV1ForPlan(
      record.manifestSpec,
      items.map((item) => item.itemId),
      record.generatedAt as number,
    )
  ) {
    return false;
  }
  if (!items.every((item) => item.plannedRelativePath.startsWith(`${record.relativeRoot}/`))) {
    return false;
  }
  const expected = captureReviewPlanTotalsForItems(items);
  if (!expected) return false;
  return (
    totals.included === expected.included &&
    totals.videos === expected.videos &&
    totals.stills === expected.stills &&
    totals.unknownSizeCount === expected.unknownSizeCount &&
    totals.requiredFreeVideoSlots === expected.requiredFreeVideoSlots &&
    totals.estimatedBytes === expected.estimatedBytes
  );
}

export function isCaptureReviewPlanV1(value: unknown): value is CaptureReviewPlanV1 {
  try {
    return isCaptureReviewPlanV1Unsafe(value);
  } catch {
    return false;
  }
}

function isCaptureRunV1Unsafe(value: unknown): value is CaptureRunV1 {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.schemaVersion === CAPTURE_PACK_SCHEMA_VERSION &&
      isStringWithin(record.runId, MAX_ID_LENGTH) &&
      isStringWithin(record.planId, MAX_ID_LENGTH) &&
      isStringWithin(record.draftId, MAX_ID_LENGTH) &&
      isSafeNonNegativeInteger(record.draftRevision) &&
      typeof record.planDigest === "string" &&
      /^[0-9a-f]{64}$/.test(record.planDigest) &&
      isStringWithin(record.commandId, MAX_ID_LENGTH) &&
      isFiniteNonNegative(record.createdAt) &&
      isOneOf(record.status, RUN_STATUSES) &&
      isBoundedIdArray(record.orderedJobIds) &&
      record.orderedJobIds.length <= MAX_CAPTURE_RUN_JOB_IDS &&
      new Set(record.orderedJobIds).size === record.orderedJobIds.length &&
      (record.manifestDownloadIds === undefined ||
        (Array.isArray(record.manifestDownloadIds) &&
          record.manifestDownloadIds.length <= MAX_CAPTURE_MANIFEST_DOWNLOAD_IDS &&
          record.manifestDownloadIds.every(isSafeNonNegativeInteger) &&
          new Set(record.manifestDownloadIds).size === record.manifestDownloadIds.length)),
  );
}

export function isCaptureRunV1(value: unknown): value is CaptureRunV1 {
  try {
    return isCaptureRunV1Unsafe(value);
  } catch {
    return false;
  }
}

function isCaptureJobProgressV1(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(
    record &&
      isOneOf(record.phase, PROGRESS_PHASES) &&
      isOptionalSafeNonNegativeInteger(record.completed) &&
      isOptionalSafeNonNegativeInteger(record.total) &&
      isOptionalSafeNonNegativeInteger(record.bytes) &&
      isOptionalFiniteNonNegative(record.ratio) &&
      (record.ratio === undefined || record.ratio <= 1),
  );
}

function isCaptureJobV1Unsafe(value: unknown): value is CaptureJobV1 {
  const record = asRecord(value);
  if (!record) return false;
  const snapshot = asRecord(record.snapshot);
  const result = record.result === undefined ? undefined : asRecord(record.result);
  const error = record.error === undefined ? undefined : asRecord(record.error);
  if (!(
    record.schemaVersion === CAPTURE_PACK_SCHEMA_VERSION &&
      isStringWithin(record.jobId, MAX_ID_LENGTH) &&
      isStringWithin(record.runId, MAX_ID_LENGTH) &&
      isStringWithin(record.itemId, MAX_ID_LENGTH) &&
      isStringWithin(record.attemptId, MAX_ID_LENGTH) &&
      isSafeNonNegativeInteger(record.attemptNo) &&
      record.attemptNo > 0 &&
      isSafeNonNegativeInteger(record.revision) &&
      (record.resourceClass === "native" || record.resourceClass === "heavy") &&
      isOneOf(record.state, JOB_STATES) &&
      snapshot &&
      isMediaSnapshotV1(snapshot.media) &&
      isSafeClipHutchDownloadPath(snapshot.plannedRelativePath) &&
      isQualityChoiceV1(snapshot.quality) &&
      isQualityCompatibleWithMedia(snapshot.media, snapshot.quality, true) &&
      isOptionalCaptureOpaqueId(snapshot.headerLeaseId) &&
      (record.progress === undefined || isCaptureJobProgressV1(record.progress)) &&
      isOptionalStringWithin(record.quotaReservationId, MAX_ID_LENGTH, false) &&
      isOptionalSafeNonNegativeInteger(record.downloadId) &&
      (result === undefined ||
        (isOptionalStringWithin(result.actualBasename, 255, false) &&
          (result.actualBasename === undefined ||
            (!result.actualBasename.includes("/") && !result.actualBasename.includes("\\"))) &&
          isOptionalSafeNonNegativeInteger(result.sizeBytes))) &&
      (error === undefined ||
        (isStringWithin(error.code, MAX_ID_LENGTH) &&
          isStringWithin(error.customerMessage, MAX_ERROR_MESSAGE_LENGTH) &&
          typeof error.retryable === "boolean"))
  )) {
    return false;
  }

  const media = snapshot.media;
  if ((media.kind === "hls" || media.kind === "dash") && record.resourceClass !== "heavy") {
    return false;
  }
  if (media.kind === "image" && record.resourceClass !== "native") return false;

  if (record.progress !== undefined) {
    const progress = asRecord(record.progress);
    if (
      progress &&
      typeof progress.completed === "number" &&
      typeof progress.total === "number" &&
      progress.completed > progress.total
    ) {
      return false;
    }
  }

  const progress = record.progress === undefined ? undefined : asRecord(record.progress);
  if (record.state === "prepared" || record.state === "starting" || record.state === "delivery_pending") {
    if (progress !== undefined) return false;
  } else if (record.state === "queued") {
    if (progress?.phase !== "queued") return false;
  } else if (record.state === "running") {
    if (progress?.phase !== "fetching") return false;
  } else if (record.state === "processing") {
    if (progress?.phase !== "processing") return false;
  } else if (record.state === "saving") {
    if (progress?.phase !== "saving" || record.downloadId === undefined) return false;
  } else if (record.state !== "cancelling" && progress !== undefined) {
    return false;
  }

  if (record.state === "failed" || record.state === "save_state_unknown") {
    return error !== undefined && result === undefined;
  }
  if (record.state === "complete") return result !== undefined && error === undefined;
  return error === undefined && result === undefined;
}

export function isCaptureJobV1(value: unknown): value is CaptureJobV1 {
  try {
    return isCaptureJobV1Unsafe(value);
  } catch {
    return false;
  }
}
