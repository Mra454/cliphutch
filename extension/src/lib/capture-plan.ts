import type { DetectedVideo } from "../types";
import {
  CAPTURE_PACK_SCHEMA_VERSION,
  MAX_CAPTURE_PLAN_ITEMS,
  captureReviewPlanTotalsForItems,
  isCaptureDraftV1,
  isCaptureReviewPlanV1,
  isPersistentStreamQualityChoiceV1,
  isQualityChoiceV1,
  type CaptureDraftV1,
  type CaptureManifestSpecV1,
  type CapturePlanItemV1,
  type CapturePlanWarningV1,
  type CaptureReviewPlanV1,
  type MediaSnapshotV1,
  type QualityChoiceV1,
  type QualityPolicyV1,
} from "./capture-pack-types";
import {
  buildPageFolder,
  buildPackRoot,
  buildRelativeDownloadPath,
  dedupePlannedPaths,
  sanitizePathSegment,
} from "./download-path";
import { inferFilename } from "./filename";
import { WEBM_TRANSCODE_SIZE_CAP_BYTES } from "./constants";
import { canonicalCaptureManifestPackName } from "./capture-manifest";

const MAX_ID_LENGTH = 256;
const MAX_PLAN_SERIALIZED_BYTES = 1024 * 1024;
const QUALITY_REQUIRED_WARNING: CapturePlanWarningV1 = {
  code: "QUALITY_SELECTION_REQUIRED",
  message: "Choose one exact stream quality before starting this item.",
};
const WEBM_CONVERSION_WARNING: CapturePlanWarningV1 = {
  code: "WEBM_CONVERTS_TO_MP4",
  message: "ClipHutch will convert this WebM to MP4 locally. Output size is unknown until conversion finishes.",
};
const WEBM_UNKNOWN_SIZE_WARNING: CapturePlanWarningV1 = {
  code: "WEBM_SOURCE_SIZE_UNKNOWN",
  message: "The WebM source size is unknown. Conversion stops if the source exceeds the 128 MiB local limit.",
};
const WEBM_OVERSIZE_WARNING: CapturePlanWarningV1 = {
  code: "WEBM_SOURCE_TOO_LARGE",
  message: "This WebM is larger than ClipHutch's 128 MiB local conversion limit and cannot be included.",
};
const NATIVE_SOURCE_NOT_REVALIDATED_WARNING: CapturePlanWarningV1 = {
  code: "NATIVE_SOURCE_NOT_REVALIDATED",
  message: "Chrome checks this direct URL only when saving starts. Keep the source page open until the file begins.",
};
const UNSAFE_IDENTIFIER_PATTERN = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export type CapturePlanItemChoiceV1 = {
  itemId: string;
  include: boolean;
  qualityChoice?: QualityChoiceV1;
};

export type GenerateCaptureReviewPlanInput = {
  draft: CaptureDraftV1;
  expectedDraftRevision: number;
  planId: string;
  generatedAt: number;
  choices: CapturePlanItemChoiceV1[];
};

export type CapturePlanGenerationFailure = {
  ok: false;
  reason:
    | "invalid_input"
    | "invalid_draft"
    | "stale_draft_revision"
    | "duplicate_choice"
    | "missing_choice"
    | "unknown_item"
    | "unsupported_choice"
    | "path_planning_failed"
    | "serialized_byte_limit"
    | "invalid_generated_plan";
  itemId?: string;
  expectedDraftRevision?: number;
  actualDraftRevision?: number;
  limit?: number;
  measuredBytes?: number;
};

export type CapturePlanGenerationResult =
  | { ok: true; plan: CaptureReviewPlanV1 }
  | CapturePlanGenerationFailure;

type PreparedChoice = {
  itemId: string;
  include: boolean;
  qualityChoice?: QualityChoiceV1;
};

function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value === value.trim() &&
    !UNSAFE_IDENTIFIER_PATTERN.test(value)
  );
}

function safeQualityMetadata(choice: QualityChoiceV1): boolean {
  if (choice.mode === "direct") return true;
  if (choice.label !== undefined && UNSAFE_IDENTIFIER_PATTERN.test(choice.label)) return false;
  if (isPersistentStreamQualityChoiceV1(choice)) return true;
  if (choice.variantKind === "dash" && !safeId(choice.representationId)) return false;
  if (choice.variantKind === undefined && !safeId(choice.fixedVariantId)) return false;
  return true;
}

function safeTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    Number.isFinite(new Date(value).getTime())
  );
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

function clonePolicy(policy: QualityPolicyV1): QualityPolicyV1 {
  if (policy.mode === "manual") return { mode: "manual" };
  return {
    mode: "best_under_cap",
    maxEstimatedBytes: policy.maxEstimatedBytes,
    ...(policy.maxHeight === undefined ? {} : { maxHeight: policy.maxHeight }),
  };
}

function cloneQuality(choice: QualityChoiceV1): QualityChoiceV1 {
  if (choice.mode === "direct") return { mode: "direct" };
  const common = {
    mode: "stream" as const,
    policy: clonePolicy(choice.policy),
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
    estimateConfidence: choice.estimateConfidence,
  };
  if (isPersistentStreamQualityChoiceV1(choice)) {
    return {
      ...common,
      selector: {
        kind: choice.selector.kind,
        stableId: choice.selector.stableId,
      },
      maxDownloadBytes: choice.maxDownloadBytes,
    };
  }
  if (choice.variantKind === "hls") {
    return {
      ...common,
      variantKind: "hls",
      variantUrl: choice.variantUrl,
      ...(choice.fixedVariantId === undefined ? {} : { fixedVariantId: choice.fixedVariantId }),
    };
  }
  if (choice.variantKind === "dash") {
    return {
      ...common,
      variantKind: "dash",
      representationId: choice.representationId,
      ...(choice.fixedVariantId === undefined ? {} : { fixedVariantId: choice.fixedVariantId }),
    };
  }
  return { ...common, fixedVariantId: choice.fixedVariantId };
}

function cloneMedia(media: MediaSnapshotV1): MediaSnapshotV1 {
  return {
    mediaId: media.mediaId,
    kind: media.kind,
    url: media.url,
    detectedAt: media.detectedAt,
    ...(media.firstSeenAt === undefined ? {} : { firstSeenAt: media.firstSeenAt }),
    ...(media.lastSeenAt === undefined ? {} : { lastSeenAt: media.lastSeenAt }),
    ...(media.pageUrl === undefined ? {} : { pageUrl: media.pageUrl }),
    ...(media.pageTitle === undefined ? {} : { pageTitle: media.pageTitle }),
    ...(media.contentType === undefined ? {} : { contentType: media.contentType }),
    ...(media.contentDisposition === undefined
      ? {}
      : { contentDisposition: media.contentDisposition }),
    ...(media.sizeBytes === undefined ? {} : { sizeBytes: media.sizeBytes }),
    ...(media.width === undefined ? {} : { width: media.width }),
    ...(media.height === undefined ? {} : { height: media.height }),
    ...(media.durationSec === undefined ? {} : { durationSec: media.durationSec }),
    ...(media.bitrate === undefined ? {} : { bitrate: media.bitrate }),
    ...(media.codecs === undefined ? {} : { codecs: media.codecs }),
    provenance: [...media.provenance],
    ...(media.familyId === undefined ? {} : { familyId: media.familyId }),
  };
}

export function cloneCaptureReviewPlan(plan: CaptureReviewPlanV1): CaptureReviewPlanV1 {
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    planId: plan.planId,
    draftId: plan.draftId,
    draftRevision: plan.draftRevision,
    generatedAt: plan.generatedAt,
    relativeRoot: plan.relativeRoot,
    ...(plan.manifestSpec === undefined
      ? {}
      : {
          manifestSpec: {
            schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
            formats: [...plan.manifestSpec.formats],
            packName: plan.manifestSpec.packName,
            createdAt: plan.manifestSpec.createdAt,
            itemAddedAt: Object.fromEntries(
              plan.items.map((item) => [item.itemId, plan.manifestSpec?.itemAddedAt[item.itemId]]),
            ) as Record<string, number>,
          },
        }),
    items: plan.items.map((item) => ({
      itemId: item.itemId,
      include: item.include,
      media: cloneMedia(item.media),
      plannedRelativePath: item.plannedRelativePath,
      readiness: item.readiness,
      copyChoice: {
        candidateId: item.copyChoice.candidateId,
        confidence: item.copyChoice.confidence,
        reason: item.copyChoice.reason,
      },
      ...(item.readiness === "ready"
        ? { qualityChoice: cloneQuality(item.qualityChoice) }
        : {}),
      warnings: item.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
      })),
    })) as CapturePlanItemV1[],
    totals: {
      included: plan.totals.included,
      videos: plan.totals.videos,
      stills: plan.totals.stills,
      ...(plan.totals.estimatedBytes === undefined
        ? {}
        : { estimatedBytes: plan.totals.estimatedBytes }),
      unknownSizeCount: plan.totals.unknownSizeCount,
      requiredFreeVideoSlots: plan.totals.requiredFreeVideoSlots,
    },
  };
}

function exactObjectKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function prepareChoices(
  rawChoices: unknown,
  draft: CaptureDraftV1,
): { ok: true; choices: Map<string, PreparedChoice> } | CapturePlanGenerationFailure {
  if (!Array.isArray(rawChoices) || rawChoices.length > MAX_CAPTURE_PLAN_ITEMS) {
    return { ok: false, reason: "invalid_input" };
  }
  const choices = new Map<string, PreparedChoice>();
  for (const rawChoice of rawChoices) {
    if (rawChoice === null || typeof rawChoice !== "object" || Array.isArray(rawChoice)) {
      return { ok: false, reason: "invalid_input" };
    }
    const choice = rawChoice as Record<string, unknown>;
    if (
      !exactObjectKeys(choice, ["itemId", "include", "qualityChoice"]) ||
      !safeId(choice.itemId) ||
      typeof choice.include !== "boolean" ||
      (choice.qualityChoice !== undefined &&
        (!isQualityChoiceV1(choice.qualityChoice) || !safeQualityMetadata(choice.qualityChoice)))
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    if (choices.has(choice.itemId)) {
      return { ok: false, reason: "duplicate_choice", itemId: choice.itemId };
    }
    if (!Object.prototype.hasOwnProperty.call(draft.items, choice.itemId)) {
      return { ok: false, reason: "unknown_item", itemId: choice.itemId };
    }
    choices.set(choice.itemId, {
      itemId: choice.itemId,
      include: choice.include,
      ...(choice.qualityChoice === undefined
        ? {}
        : { qualityChoice: cloneQuality(choice.qualityChoice) }),
    });
  }
  for (const itemId of draft.orderedItemIds) {
    if (!choices.has(itemId)) return { ok: false, reason: "missing_choice", itemId };
  }
  return { ok: true, choices };
}

function resolveQuality(
  media: MediaSnapshotV1,
  supplied: QualityChoiceV1 | undefined,
  policy: QualityPolicyV1,
  allowLegacyQuickChoice: boolean,
):
  | {
      ok: true;
      readiness: "ready";
      quality: QualityChoiceV1;
      warnings: CapturePlanWarningV1[];
    }
  | {
      ok: true;
      readiness: "needs_choice";
      warnings: CapturePlanWarningV1[];
    }
  | {
      ok: true;
      readiness: "unsupported";
      warnings: CapturePlanWarningV1[];
    }
  | { ok: false } {
  if (media.kind === "direct" || media.kind === "image") {
    if (supplied !== undefined && supplied.mode !== "direct") return { ok: false };
    if (isWebm(media)) {
      if (media.sizeBytes !== undefined && media.sizeBytes > WEBM_TRANSCODE_SIZE_CAP_BYTES) {
        return {
          ok: true,
          readiness: "unsupported",
          warnings: [{ ...WEBM_OVERSIZE_WARNING }],
        };
      }
      return {
        ok: true,
        quality: { mode: "direct" },
        readiness: "ready",
        warnings: [
          { ...WEBM_CONVERSION_WARNING },
          ...(media.sizeBytes === undefined ? [{ ...WEBM_UNKNOWN_SIZE_WARNING }] : []),
        ],
      };
    }
    return {
      ok: true,
      quality: { mode: "direct" },
      readiness: "ready",
      warnings: [{ ...NATIVE_SOURCE_NOT_REVALIDATED_WARNING }],
    };
  }
  if (supplied === undefined) {
    return {
      ok: true,
      readiness: "needs_choice",
      warnings: [{ ...QUALITY_REQUIRED_WARNING }],
    };
  }
  if (isPersistentStreamQualityChoiceV1(supplied)) {
    if (supplied.selector.kind !== media.kind) return { ok: false };
    // A customer can explicitly choose one concrete selector even when their
    // draft default is automatic. Automatic choices, however, must freeze the
    // exact policy the Review disclosed; no cap/height drift is accepted.
    if (supplied.policy.mode === "manual") {
      return { ok: true, quality: cloneQuality(supplied), readiness: "ready", warnings: [] };
    }
    if (
      policy.mode !== "best_under_cap" ||
      supplied.policy.maxEstimatedBytes !== policy.maxEstimatedBytes ||
      supplied.policy.maxHeight !== policy.maxHeight
    ) return { ok: false };
    return { ok: true, quality: cloneQuality(supplied), readiness: "ready", warnings: [] };
  }
  if (
    !allowLegacyQuickChoice ||
    supplied.mode !== "stream" ||
    supplied.variantKind === undefined ||
    supplied.variantKind !== media.kind ||
    supplied.policy.mode !== policy.mode ||
    (supplied.policy.mode === "best_under_cap" &&
      (policy.mode !== "best_under_cap" ||
        supplied.policy.maxEstimatedBytes !== policy.maxEstimatedBytes ||
        supplied.policy.maxHeight !== policy.maxHeight))
  ) {
    return { ok: false };
  }
  return { ok: true, quality: cloneQuality(supplied), readiness: "ready", warnings: [] };
}

function sourceHost(media: MediaSnapshotV1): string | undefined {
  try {
    return new URL(media.pageUrl ?? media.url).hostname.replace(/^www\./i, "") || undefined;
  } catch {
    return undefined;
  }
}

function deterministicFallbackTitle(media: MediaSnapshotV1, generatedAt: number): string {
  const host = sourceHost(media) ?? "source";
  return `${host} ${new Date(generatedAt).toISOString().slice(0, 10)}`;
}

function isWebm(media: MediaSnapshotV1): boolean {
  if (media.kind !== "direct") return false;
  if (media.contentType?.split(";")[0].trim().toLowerCase() === "video/webm") return true;
  try {
    return new URL(media.url).pathname.toLowerCase().endsWith(".webm");
  } catch {
    return false;
  }
}

function detectedForFilename(
  media: MediaSnapshotV1,
  generatedAt: number,
): DetectedVideo {
  const fallbackTitle = deterministicFallbackTitle(media, generatedAt);
  return {
    id: media.mediaId,
    url: media.url,
    kind: media.kind,
    detectedAt: media.detectedAt,
    ...(media.firstSeenAt === undefined ? {} : { firstSeenAt: media.firstSeenAt }),
    ...(media.lastSeenAt === undefined ? {} : { lastSeenAt: media.lastSeenAt }),
    ...(media.pageUrl === undefined ? {} : { pageUrl: media.pageUrl }),
    pageTitle: sanitizePathSegment(media.pageTitle ?? "", { fallback: fallbackTitle }),
    ...(media.sizeBytes === undefined ? {} : { sizeBytes: media.sizeBytes }),
    ...(media.contentType === undefined ? {} : { contentType: media.contentType }),
    ...(media.contentDisposition === undefined
      ? {}
      : { contentDisposition: media.contentDisposition }),
    ...(media.width === undefined ? {} : { width: media.width }),
    ...(media.height === undefined ? {} : { height: media.height }),
    provenance: [...media.provenance],
    ...(media.familyId === undefined ? {} : { familyId: media.familyId }),
  };
}

function filenameFor(
  media: MediaSnapshotV1,
  quality: QualityChoiceV1 | undefined,
  generatedAt: number,
  customStem?: string,
): string {
  const forcedExtension = media.kind === "hls" || media.kind === "dash" || isWebm(media)
    ? ".mp4"
    : undefined;
  return inferFilename(detectedForFilename(media, generatedAt), {
    ...(customStem === undefined ? {} : { customStem }),
    ...(forcedExtension === undefined ? {} : { forcedExtension }),
    ...(quality?.mode === "stream" && quality.policy.mode === "manual" && quality.label
      ? { variantLabel: quality.label }
      : {}),
  });
}

function reserveManifestPaths(draft: CaptureDraftV1): string[] {
  const formats = [
    "json" as const,
    ...(draft.preferences.manifestFormats.includes("csv") ? ["csv" as const] : []),
  ];
  return formats.map((format) =>
    buildRelativeDownloadPath({
      packName: draft.name,
      filename: `_cliphutch-manifest.${format}`,
      includePageFolder: false,
    }));
}

function freezeManifestSpec(draft: CaptureDraftV1, planId: string): CaptureManifestSpecV1 | undefined {
  if (planId.startsWith("capture-single-plan:")) return undefined;
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    formats: [
      "json",
      ...(draft.preferences.manifestFormats.includes("csv") ? ["csv" as const] : []),
    ],
    packName: canonicalCaptureManifestPackName(draft.name),
    createdAt: draft.createdAt,
    itemAddedAt: Object.fromEntries(
      draft.orderedItemIds.map((itemId) => [itemId, draft.items[itemId].addedAt]),
    ),
  };
}

type PagePathInput = { pageHost?: string; pageTitle?: string };

function canonicalFolderKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function pageIdentity(item: CaptureDraftV1["items"][string]): string {
  if (item.media.pageUrl !== undefined) return `url:${new URL(item.media.pageUrl).href}`;
  if (item.sourceTabId !== undefined) return `tab:${item.sourceTabId}`;
  return `item:${item.itemId}`;
}

function allocatePagePathInputs(draft: CaptureDraftV1): Map<string, PagePathInput> {
  const byIdentity = new Map<string, PagePathInput>();
  const folderOwners = new Map<string, string>();
  const byItemId = new Map<string, PagePathInput>();
  for (const itemId of draft.orderedItemIds) {
    const item = draft.items[itemId];
    const identity = pageIdentity(item);
    let pathInput = byIdentity.get(identity);
    if (!pathInput) {
      const pageHost = sourceHost(item.media);
      // The label is background-owned draft state and applies to every item
      // from this exact normalized page. It replaces only the customer-facing
      // title portion; the source host and collision allocator remain intact.
      const originalTitle = item.pageFolderLabel ?? item.media.pageTitle;
      let pageTitle = originalTitle;
      let folder = buildPageFolder(pageHost, pageTitle);
      let counter = 2;
      while (
        folderOwners.has(canonicalFolderKey(folder)) &&
        folderOwners.get(canonicalFolderKey(folder)) !== identity
      ) {
        // Prefixing keeps the disambiguator inside buildPageFolder's bound even
        // when an adversarially long title is truncated.
        pageTitle = `(${counter}) ${originalTitle?.trim() || "Untitled page"}`;
        folder = buildPageFolder(pageHost, pageTitle);
        counter += 1;
      }
      folderOwners.set(canonicalFolderKey(folder), identity);
      pathInput = {
        ...(pageHost === undefined ? {} : { pageHost }),
        ...(pageTitle === undefined ? {} : { pageTitle }),
      };
      byIdentity.set(identity, pathInput);
    }
    byItemId.set(itemId, pathInput);
  }
  return byItemId;
}

/**
 * Pure authoritative planner. Callers choose only inclusion and a bounded
 * stream selection; every source snapshot, copy identity, path, and total is
 * derived from the canonical draft.
 */
export function generateCaptureReviewPlan(
  input: GenerateCaptureReviewPlanInput,
): CapturePlanGenerationResult {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      !exactObjectKeys(input as unknown as Record<string, unknown>, [
        "draft",
        "expectedDraftRevision",
        "planId",
        "generatedAt",
        "choices",
      ]) ||
      !safeId(input.planId) ||
      !Number.isSafeInteger(input.expectedDraftRevision) ||
      input.expectedDraftRevision < 0 ||
      !safeTimestamp(input.generatedAt)
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    if (
      !isCaptureDraftV1(input.draft) ||
      input.draft.orderedItemIds.length > MAX_CAPTURE_PLAN_ITEMS ||
      !safeId(input.draft.draftId) ||
      input.draft.orderedItemIds.some((itemId) => !safeId(itemId)) ||
      input.draft.orderedItemIds.some((itemId) => !safeId(input.draft.items[itemId].media.mediaId))
    ) {
      return { ok: false, reason: "invalid_draft" };
    }
    if (input.expectedDraftRevision !== input.draft.revision) {
      return {
        ok: false,
        reason: "stale_draft_revision",
        expectedDraftRevision: input.expectedDraftRevision,
        actualDraftRevision: input.draft.revision,
      };
    }
    if (input.generatedAt < input.draft.updatedAt) {
      return { ok: false, reason: "invalid_input" };
    }
    const preparedChoices = prepareChoices(input.choices, input.draft);
    if (!preparedChoices.ok) return preparedChoices;

    const rawItems: CapturePlanItemV1[] = [];
    const rawPaths: string[] = [];
    const pagePathInputs = allocatePagePathInputs(input.draft);
    for (const itemId of input.draft.orderedItemIds) {
      const draftItem = input.draft.items[itemId];
      const choice = preparedChoices.choices.get(itemId);
      if (!choice) return { ok: false, reason: "missing_choice", itemId };
      const resolved = resolveQuality(
        draftItem.media,
        choice.qualityChoice,
        input.draft.preferences.qualityPolicy,
        input.planId.startsWith("capture-single-plan:"),
      );
      if (!resolved.ok) return { ok: false, reason: "unsupported_choice", itemId };

      const plannedRelativePath = buildRelativeDownloadPath({
        packName: input.draft.name,
        ...pagePathInputs.get(itemId),
        filename: filenameFor(
          draftItem.media,
          resolved.readiness === "ready" ? resolved.quality : undefined,
          input.generatedAt,
          draftItem.customStem,
        ),
      });
      rawPaths.push(plannedRelativePath);
      rawItems.push({
        itemId,
        include: choice.include,
        media: cloneMedia(draftItem.media),
        plannedRelativePath,
        readiness: resolved.readiness,
        copyChoice: draftItem.copyChoice === undefined
          ? {
              candidateId: draftItem.media.mediaId,
              confidence: "exact",
              reason: "Exact media selected from the Capture Pack draft.",
            }
          : {
              candidateId: draftItem.copyChoice.candidateId,
              confidence: draftItem.copyChoice.confidence,
              reason: draftItem.copyChoice.reason,
            },
        ...(resolved.readiness === "ready"
          ? { qualityChoice: cloneQuality(resolved.quality) }
          : {}),
        warnings: resolved.warnings.map((warning) => ({ ...warning })),
      } as CapturePlanItemV1);
    }

    const manifestPaths = input.planId.startsWith("capture-single-plan:")
      ? []
      : reserveManifestPaths(input.draft);
    const plannedPaths = dedupePlannedPaths([...manifestPaths, ...rawPaths]).slice(
      manifestPaths.length,
    );
    const items = rawItems.map((item, index) => ({
      ...item,
      plannedRelativePath: plannedPaths[index],
    }));
    const totals = captureReviewPlanTotalsForItems(items);
    if (!totals) {
      return { ok: false, reason: "invalid_generated_plan" };
    }
    const manifestSpec = freezeManifestSpec(input.draft, input.planId);
    const plan: CaptureReviewPlanV1 = {
      schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
      planId: input.planId,
      draftId: input.draft.draftId,
      draftRevision: input.draft.revision,
      generatedAt: input.generatedAt,
      relativeRoot: buildPackRoot(input.draft.name),
      ...(manifestSpec === undefined ? {} : { manifestSpec }),
      items,
      totals,
    };
    const measuredBytes = serializedBytes(plan);
    if (measuredBytes === undefined) return { ok: false, reason: "invalid_generated_plan" };
    if (measuredBytes > MAX_PLAN_SERIALIZED_BYTES) {
      return {
        ok: false,
        reason: "serialized_byte_limit",
        limit: MAX_PLAN_SERIALIZED_BYTES,
        measuredBytes,
      };
    }
    if (!isCaptureReviewPlanV1(plan)) return { ok: false, reason: "invalid_generated_plan" };
    return { ok: true, plan: cloneCaptureReviewPlan(plan) };
  } catch {
    return { ok: false, reason: "path_planning_failed" };
  }
}
