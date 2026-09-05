import { withKeyLock } from "./session-jobs";
import { validateCustomDownloadStem } from "./download-path";
import {
  CAPTURE_PACK_SCHEMA_VERSION,
  isCaptureDraftItemV1,
  isCaptureDraftPreferencesV1,
  isCaptureDraftV1,
  isMediaSnapshotV1,
  normalizeCapturePageFolderLabel,
  type CaptureDraftItemV1,
  type CaptureDraftPreferencesV1,
  type CaptureDraftV1,
  type CaptureCopyChoiceV1,
  type MediaFamilyRefV1,
  type MediaSnapshotV1,
  type QualityPolicyV1,
} from "./capture-pack-types";

export const CAPTURE_DRAFT_STORAGE_KEY = "capture-draft-v1";
export const CAPTURE_DRAFT_STORAGE_OWNER = "background-service-worker" as const;
export const MAX_CAPTURE_DRAFT_ITEMS = 200;
export const MAX_CAPTURE_DRAFT_SERIALIZED_BYTES = 1024 * 1024;
export const MAX_CAPTURE_DRAFT_NAME_LENGTH = 120;

export type CaptureDraftLimits = {
  maxItems: number;
  maxSerializedBytes: number;
};

export const DEFAULT_CAPTURE_DRAFT_LIMITS: CaptureDraftLimits = {
  maxItems: MAX_CAPTURE_DRAFT_ITEMS,
  maxSerializedBytes: MAX_CAPTURE_DRAFT_SERIALIZED_BYTES,
};

export type CaptureDraftCommand =
  | { type: "get" }
  | {
      type: "add";
      expectedRevision: number;
      at: number;
      item: CaptureDraftItemV1;
      draftId?: string;
      draftName?: string;
      preferences?: CaptureDraftPreferencesV1;
    }
  | { type: "remove"; expectedRevision: number; at: number; itemId: string }
  | {
      type: "remove-page";
      expectedRevision: number;
      at: number;
      pageUrl: string | null;
    }
  | { type: "clear"; expectedRevision: number; at: number }
  | { type: "rename"; expectedRevision: number; at: number; name: string }
  | {
      type: "label-page";
      expectedRevision: number;
      at: number;
      pageUrl: string;
      label: string | null;
    }
  | {
      type: "set-item-custom-stem";
      expectedRevision: number;
      at: number;
      itemId: string;
      customStem: string | null;
    }
  | {
      type: "replace-media";
      expectedRevision: number;
      at: number;
      itemId: string;
      sourceTabId: number;
      media: MediaSnapshotV1;
      /** Background-frozen copy status for the replacement snapshot. */
      copyChoice?: CaptureCopyChoiceV1;
      family?: MediaFamilyRefV1;
      /** Background-resolved lease for the replacement media, if any. */
      headerLeaseId?: string;
    }
  | {
      type: "set-manifest-csv";
      expectedRevision: number;
      at: number;
      enabled: boolean;
    };

export type CaptureDraftSuccess = {
  ok: true;
  changed: boolean;
  draft: CaptureDraftV1 | null;
  alreadySelected?: true;
};

export type CaptureDraftFailure =
  | {
      ok: false;
      reason: "revision_conflict";
      expectedRevision: number;
      actualRevision: number;
      draft: CaptureDraftV1 | null;
    }
  | {
      ok: false;
      reason:
        | "no_active_draft"
        | "invalid_draft"
        | "invalid_item"
        | "duplicate_item_id"
        | "invalid_name"
        | "invalid_page_label"
        | "invalid_page_url"
        | "item_not_found"
        | "invalid_timestamp"
        | "revision_exhausted";
      draft: CaptureDraftV1 | null;
    }
  | {
      ok: false;
      reason: "duplicate_page_media";
      existingItemId: string;
      draft: CaptureDraftV1;
    }
  | {
      ok: false;
      reason: "item_limit";
      limit: number;
      draft: CaptureDraftV1 | null;
    }
  | {
      ok: false;
      reason: "serialized_byte_limit";
      limit: number;
      measuredBytes: number;
      draft: CaptureDraftV1 | null;
    };

export type CaptureDraftReducerResult = CaptureDraftSuccess | CaptureDraftFailure;

export type StoredCaptureDraftParseResult =
  | { status: "empty" }
  | { status: "valid"; draft: CaptureDraftV1; serializedBytes: number }
  | {
      status: "invalid";
      reason: "corrupt" | "future_schema" | "item_limit" | "serialized_byte_limit";
      schemaVersion?: number;
      measuredBytes?: number;
    };

export type CaptureDraftStorageFailure = {
  ok: false;
  reason:
    | "storage_corrupt"
    | "storage_future_schema"
    | "storage_item_limit"
    | "storage_serialized_byte_limit"
    | "storage_unavailable";
  draft: CaptureDraftV1 | null;
  schemaVersion?: number;
  measuredBytes?: number;
  operation?: "read" | "write";
  /**
   * A rejected session-storage write is not proof that Chrome rejected the
   * commit. Callers coordinating header leases may compensate only when an
   * exact read-back proves the prior value is still present.
   */
  commitState?: "absent" | "unknown";
};

export type CaptureDraftStorageResult = CaptureDraftReducerResult | CaptureDraftStorageFailure;

const DEFAULT_QUALITY_POLICY: QualityPolicyV1 = { mode: "manual" };

function defaultPreferences(): CaptureDraftPreferencesV1 {
  return {
    folderMode: "pack_page",
    manifestFormats: ["json"],
    qualityPolicy: cloneQualityPolicy(DEFAULT_QUALITY_POLICY),
  };
}

function cloneQualityPolicy(policy: QualityPolicyV1): QualityPolicyV1 {
  return policy.mode === "manual"
    ? { mode: "manual" }
    : {
        mode: "best_under_cap",
        maxEstimatedBytes: policy.maxEstimatedBytes,
        maxHeight: policy.maxHeight,
      };
}

function cloneMedia(media: MediaSnapshotV1): MediaSnapshotV1 {
  return {
    mediaId: media.mediaId,
    kind: media.kind,
    url: media.url,
    detectedAt: media.detectedAt,
    firstSeenAt: media.firstSeenAt,
    lastSeenAt: media.lastSeenAt,
    pageUrl: media.pageUrl,
    pageTitle: media.pageTitle,
    contentType: media.contentType,
    contentDisposition: media.contentDisposition,
    sizeBytes: media.sizeBytes,
    width: media.width,
    height: media.height,
    durationSec: media.durationSec,
    bitrate: media.bitrate,
    codecs: media.codecs,
    provenance: [...media.provenance],
    familyId: media.familyId,
  };
}

function cloneItem(item: CaptureDraftItemV1): CaptureDraftItemV1 {
  return {
    itemId: item.itemId,
    addedAt: item.addedAt,
    sourceTabId: item.sourceTabId,
    ...(item.pageFolderLabel === undefined
      ? {}
      : { pageFolderLabel: item.pageFolderLabel }),
    ...(item.customStem === undefined
      ? {}
      : { customStem: item.customStem }),
    media: cloneMedia(item.media),
    family: item.family ? { familyId: item.family.familyId } : undefined,
    ...(item.copyChoice === undefined
      ? {}
      : {
          copyChoice: {
            candidateId: item.copyChoice.candidateId,
            confidence: item.copyChoice.confidence,
            reason: item.copyChoice.reason,
          },
        }),
    headerLeaseId: item.headerLeaseId,
  };
}

function clonePreferences(preferences: CaptureDraftPreferencesV1): CaptureDraftPreferencesV1 {
  return {
    folderMode: preferences.folderMode,
    manifestFormats: [...preferences.manifestFormats],
    qualityPolicy: cloneQualityPolicy(preferences.qualityPolicy),
  };
}

export function cloneCaptureDraft(draft: CaptureDraftV1): CaptureDraftV1 {
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    draftId: draft.draftId,
    revision: draft.revision,
    name: draft.name,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    orderedItemIds: [...draft.orderedItemIds],
    items: Object.fromEntries(
      draft.orderedItemIds.map((itemId) => [itemId, cloneItem(draft.items[itemId])]),
    ),
    preferences: clonePreferences(draft.preferences),
  };
}

export function serializedCaptureDraftBytes(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : new TextEncoder().encode(json).byteLength;
  } catch {
    return undefined;
  }
}

function validLimits(limits: CaptureDraftLimits): boolean {
  return (
    Number.isSafeInteger(limits.maxItems) &&
    limits.maxItems >= 0 &&
    Number.isSafeInteger(limits.maxSerializedBytes) &&
    limits.maxSerializedBytes >= 0
  );
}

function validTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function normalizedDraftName(name: string): string | undefined {
  const normalized = name.trim();
  if (normalized.length === 0 || normalized.length > MAX_CAPTURE_DRAFT_NAME_LENGTH) {
    return undefined;
  }
  return normalized;
}

function normalizedHttpPageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function nextRevision(draft: CaptureDraftV1): number | undefined {
  return Number.isSafeInteger(draft.revision + 1) ? draft.revision + 1 : undefined;
}

function changedDraft(
  current: CaptureDraftV1,
  at: number,
  fields: Partial<Pick<CaptureDraftV1, "name" | "orderedItemIds" | "items" | "preferences">>,
): CaptureDraftV1 | undefined {
  const revision = nextRevision(current);
  if (revision === undefined) return undefined;
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    draftId: current.draftId,
    revision,
    name: fields.name ?? current.name,
    createdAt: current.createdAt,
    updatedAt: Math.max(current.updatedAt, at),
    orderedItemIds: fields.orderedItemIds ?? [...current.orderedItemIds],
    items: fields.items ?? Object.fromEntries(
      current.orderedItemIds.map((itemId) => [itemId, cloneItem(current.items[itemId])]),
    ),
    preferences: clonePreferences(fields.preferences ?? current.preferences),
  };
}

function failure(
  reason: Exclude<
    CaptureDraftFailure["reason"],
    "revision_conflict" | "item_limit" | "serialized_byte_limit" | "duplicate_page_media"
  >,
  draft: CaptureDraftV1 | null,
): CaptureDraftFailure {
  return { ok: false, reason, draft: draft ? cloneCaptureDraft(draft) : null };
}

function conflict(
  expectedRevision: number,
  draft: CaptureDraftV1 | null,
): CaptureDraftFailure {
  return {
    ok: false,
    reason: "revision_conflict",
    expectedRevision,
    actualRevision: draft?.revision ?? 0,
    draft: draft ? cloneCaptureDraft(draft) : null,
  };
}

function enforceCandidateLimits(
  candidate: CaptureDraftV1,
  current: CaptureDraftV1 | null,
  limits: CaptureDraftLimits,
): CaptureDraftReducerResult {
  if (!isCaptureDraftV1(candidate)) return failure("invalid_draft", current);
  if (candidate.orderedItemIds.length > limits.maxItems) {
    return {
      ok: false,
      reason: "item_limit",
      limit: limits.maxItems,
      draft: current ? cloneCaptureDraft(current) : null,
    };
  }
  const measuredBytes = serializedCaptureDraftBytes(candidate);
  if (measuredBytes === undefined) return failure("invalid_draft", current);
  if (measuredBytes > limits.maxSerializedBytes) {
    return {
      ok: false,
      reason: "serialized_byte_limit",
      limit: limits.maxSerializedBytes,
      measuredBytes,
      draft: current ? cloneCaptureDraft(current) : null,
    };
  }
  return { ok: true, changed: true, draft: candidate };
}

function findExactPageMedia(
  draft: CaptureDraftV1,
  item: CaptureDraftItemV1,
  excludingItemId?: string,
): CaptureDraftItemV1 | undefined {
  const pageUrl = normalizedHttpPageUrl(item.media.pageUrl);
  const existingId = draft.orderedItemIds.find((itemId) => {
    const existing = draft.items[itemId];
    return existing.itemId !== excludingItemId &&
      existing.media.mediaId === item.media.mediaId &&
      normalizedHttpPageUrl(existing.media.pageUrl) === pageUrl;
  });
  return existingId === undefined ? undefined : draft.items[existingId];
}

function itemForMediaReplacement(
  draft: CaptureDraftV1,
  current: CaptureDraftItemV1,
  sourceTabId: number,
  media: MediaSnapshotV1,
  copyChoice?: CaptureCopyChoiceV1,
  family?: MediaFamilyRefV1,
  headerLeaseId?: string,
): CaptureDraftItemV1 {
  const next: CaptureDraftItemV1 = {
    itemId: current.itemId,
    addedAt: current.addedAt,
    sourceTabId,
    media: cloneMedia(media),
    ...(copyChoice === undefined
      ? {}
      : {
          copyChoice: {
            candidateId: copyChoice.candidateId,
            confidence: copyChoice.confidence,
            reason: copyChoice.reason,
          },
        }),
    ...(family === undefined ? {} : { family: { familyId: family.familyId } }),
    ...(headerLeaseId === undefined ? {} : { headerLeaseId }),
  };
  const previousPageUrl = normalizedHttpPageUrl(current.media.pageUrl);
  const nextPageUrl = normalizedHttpPageUrl(media.pageUrl);
  if (current.customStem !== undefined) next.customStem = current.customStem;
  if (!nextPageUrl) return next;

  if (previousPageUrl === nextPageUrl && current.pageFolderLabel !== undefined) {
    next.pageFolderLabel = current.pageFolderLabel;
  }
  if (previousPageUrl === nextPageUrl && current.pageFolderLabel !== undefined) return next;

  const targetPagePeerId = draft.orderedItemIds.find((itemId) =>
    itemId !== current.itemId &&
    normalizedHttpPageUrl(draft.items[itemId].media.pageUrl) === nextPageUrl
  );
  const targetPageLabel = targetPagePeerId === undefined
    ? undefined
    : draft.items[targetPagePeerId].pageFolderLabel;
  if (targetPageLabel !== undefined) next.pageFolderLabel = targetPageLabel;
  return next;
}

function itemWithInheritedPageLabel(
  draft: CaptureDraftV1,
  item: CaptureDraftItemV1,
): CaptureDraftItemV1 {
  const next = cloneItem(item);
  const pageUrl = normalizedHttpPageUrl(next.media.pageUrl);
  if (!pageUrl) return next;
  const pagePeerId = draft.orderedItemIds.find((itemId) =>
    normalizedHttpPageUrl(draft.items[itemId].media.pageUrl) === pageUrl
  );
  if (pagePeerId === undefined) return next;
  const inherited = draft.items[pagePeerId].pageFolderLabel;
  if (inherited === undefined) delete next.pageFolderLabel;
  else next.pageFolderLabel = inherited;
  return next;
}

function isSameCanonicalItem(left: CaptureDraftItemV1, right: CaptureDraftItemV1): boolean {
  return JSON.stringify(cloneItem(left)) === JSON.stringify(cloneItem(right));
}

export function createEmptyCaptureDraftV1(input: {
  draftId: string;
  name: string;
  now: number;
  preferences?: CaptureDraftPreferencesV1;
}): CaptureDraftV1 {
  const name = normalizedDraftName(input.name);
  const preferences = input.preferences ?? defaultPreferences();
  const draft: CaptureDraftV1 = {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    draftId: input.draftId,
    revision: 0,
    name: name ?? "",
    createdAt: input.now,
    updatedAt: input.now,
    orderedItemIds: [],
    items: {},
    preferences: clonePreferences(preferences),
  };
  if (!name || !validTimestamp(input.now) || !isCaptureDraftV1(draft)) {
    throw new TypeError("Invalid CaptureDraftV1 creation input");
  }
  return draft;
}

export function parseStoredCaptureDraft(
  value: unknown,
  limits: CaptureDraftLimits = DEFAULT_CAPTURE_DRAFT_LIMITS,
): StoredCaptureDraftParseResult {
  if (value === undefined) return { status: "empty" };
  if (!validLimits(limits)) return { status: "invalid", reason: "corrupt" };

  const serializedBytes = serializedCaptureDraftBytes(value);
  if (serializedBytes === undefined) return { status: "invalid", reason: "corrupt" };
  if (serializedBytes > limits.maxSerializedBytes) {
    return {
      status: "invalid",
      reason: "serialized_byte_limit",
      measuredBytes: serializedBytes,
    };
  }

  try {
    if (!isCaptureDraftV1(value)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const version = Object.getOwnPropertyDescriptor(value, "schemaVersion")?.value;
        if (
          typeof version === "number" &&
          Number.isSafeInteger(version) &&
          version > CAPTURE_PACK_SCHEMA_VERSION
        ) {
          return { status: "invalid", reason: "future_schema", schemaVersion: version };
        }
      }
      return { status: "invalid", reason: "corrupt" };
    }

    if (value.orderedItemIds.length > limits.maxItems) {
      return { status: "invalid", reason: "item_limit" };
    }
    return { status: "valid", draft: cloneCaptureDraft(value), serializedBytes };
  } catch {
    return { status: "invalid", reason: "corrupt" };
  }
}

export function reduceCaptureDraft(
  current: CaptureDraftV1 | null,
  command: CaptureDraftCommand,
  limits: CaptureDraftLimits = DEFAULT_CAPTURE_DRAFT_LIMITS,
): CaptureDraftReducerResult {
  if (!validLimits(limits) || (current !== null && !isCaptureDraftV1(current))) {
    return failure("invalid_draft", null);
  }
  if (current && current.orderedItemIds.length > limits.maxItems) {
    return {
      ok: false,
      reason: "item_limit",
      limit: limits.maxItems,
      draft: cloneCaptureDraft(current),
    };
  }
  if (current) {
    const currentBytes = serializedCaptureDraftBytes(current);
    if (currentBytes === undefined) return failure("invalid_draft", null);
    if (currentBytes > limits.maxSerializedBytes) {
      return {
        ok: false,
        reason: "serialized_byte_limit",
        limit: limits.maxSerializedBytes,
        measuredBytes: currentBytes,
        draft: cloneCaptureDraft(current),
      };
    }
  }
  if (command.type === "get") {
    return { ok: true, changed: false, draft: current ? cloneCaptureDraft(current) : null };
  }

  const expectedRevision = command.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return conflict(expectedRevision, current);
  }
  if (expectedRevision !== (current?.revision ?? 0)) return conflict(expectedRevision, current);
  if (!validTimestamp(command.at)) return failure("invalid_timestamp", current);

  if (command.type === "add" && !isCaptureDraftItemV1(command.item)) {
    return failure("invalid_item", current);
  }
  if (
    command.type === "replace-media" &&
    (!isMediaSnapshotV1(command.media) ||
      !Number.isSafeInteger(command.sourceTabId) || command.sourceTabId < 0)
  ) {
    return failure("invalid_item", current);
  }
  if (command.type === "set-manifest-csv" && typeof command.enabled !== "boolean") {
    return failure("invalid_draft", current);
  }
  if (
    command.type === "set-item-custom-stem" &&
    command.customStem !== null &&
    !validateCustomDownloadStem(command.customStem).ok
  ) {
    return failure("invalid_item", current);
  }

  if (!current) {
    if (command.type !== "add") return failure("no_active_draft", null);
    const draftId = command.draftId;
    const name = normalizedDraftName(command.draftName ?? "New Capture Pack");
    if (!draftId || !name || !isCaptureDraftPreferencesV1(command.preferences ?? defaultPreferences())) {
      return failure("invalid_draft", null);
    }
    let draft: CaptureDraftV1;
    try {
      draft = createEmptyCaptureDraftV1({
        draftId,
        name,
        now: command.at,
        preferences: command.preferences,
      });
    } catch {
      return failure("invalid_draft", null);
    }
    const candidate = changedDraft(draft, command.at, {
      orderedItemIds: [command.item.itemId],
      items: Object.fromEntries([[command.item.itemId, cloneItem(command.item)]]),
    });
    return candidate
      ? enforceCandidateLimits(candidate, null, limits)
      : failure("revision_exhausted", null);
  }

  if (command.type === "add") {
    // Once a page label exists, later shelf selections from that exact
    // normalized page inherit it so the all-items page invariant cannot split.
    const item = itemWithInheritedPageLabel(current, command.item);
    const sameId = current.items[item.itemId];
    if (sameId && isSameCanonicalItem(sameId, item)) {
      return {
        ok: true,
        changed: false,
        alreadySelected: true,
        draft: cloneCaptureDraft(current),
      };
    }
    if (sameId) {
      return failure("duplicate_item_id", current);
    }
    const samePageMedia = findExactPageMedia(current, item);
    if (samePageMedia) {
      return {
        ok: false,
        reason: "duplicate_page_media",
        existingItemId: samePageMedia.itemId,
        draft: cloneCaptureDraft(current),
      };
    }
    const candidate = changedDraft(current, command.at, {
      orderedItemIds: [...current.orderedItemIds, command.item.itemId],
      items: Object.fromEntries([
        ...current.orderedItemIds.map((itemId) => [itemId, cloneItem(current.items[itemId])] as const),
        [item.itemId, item],
      ]),
    });
    return candidate
      ? enforceCandidateLimits(candidate, current, limits)
      : failure("revision_exhausted", current);
  }

  if (command.type === "replace-media") {
    if (!Object.prototype.hasOwnProperty.call(current.items, command.itemId)) {
      return failure("item_not_found", current);
    }
    const existing = current.items[command.itemId];
    const replacement = itemForMediaReplacement(
      current,
      existing,
      command.sourceTabId,
      command.media,
      command.copyChoice,
      command.family,
      command.headerLeaseId,
    );
    if (!isCaptureDraftItemV1(replacement)) return failure("invalid_item", current);
    const duplicate = findExactPageMedia(current, replacement, existing.itemId);
    if (duplicate) {
      return {
        ok: false,
        reason: "duplicate_page_media",
        existingItemId: duplicate.itemId,
        draft: cloneCaptureDraft(current),
      };
    }
    if (isSameCanonicalItem(existing, replacement)) {
      return { ok: true, changed: false, draft: cloneCaptureDraft(current) };
    }
    const items = Object.fromEntries(current.orderedItemIds.map((itemId) => [
      itemId,
      itemId === existing.itemId ? replacement : cloneItem(current.items[itemId]),
    ]));
    const candidate = changedDraft(current, command.at, { items });
    return candidate
      ? enforceCandidateLimits(candidate, current, limits)
      : failure("revision_exhausted", current);
  }

  if (command.type === "remove") {
    if (!Object.prototype.hasOwnProperty.call(current.items, command.itemId)) {
      return { ok: true, changed: false, draft: cloneCaptureDraft(current) };
    }
    const orderedItemIds = current.orderedItemIds.filter((itemId) => itemId !== command.itemId);
    const items = Object.fromEntries(
      orderedItemIds.map((itemId) => [itemId, cloneItem(current.items[itemId])]),
    );
    const candidate = changedDraft(current, command.at, { orderedItemIds, items });
    return candidate
      ? enforceCandidateLimits(candidate, current, limits)
      : failure("revision_exhausted", current);
  }

  if (command.type === "remove-page") {
    const targetPageUrl = command.pageUrl === null
      ? null
      : normalizedHttpPageUrl(command.pageUrl);
    if (command.pageUrl !== null && targetPageUrl === undefined) {
      return failure("invalid_page_url", current);
    }
    const orderedItemIds = current.orderedItemIds.filter((itemId) => {
      const rawPageUrl = current.items[itemId].media.pageUrl;
      const pageUrl = rawPageUrl === undefined ? null : normalizedHttpPageUrl(rawPageUrl);
      return pageUrl !== targetPageUrl;
    });
    if (orderedItemIds.length === current.orderedItemIds.length) {
      return { ok: true, changed: false, draft: cloneCaptureDraft(current) };
    }
    const items = Object.fromEntries(
      orderedItemIds.map((itemId) => [itemId, cloneItem(current.items[itemId])]),
    );
    const candidate = changedDraft(current, command.at, { orderedItemIds, items });
    return candidate
      ? enforceCandidateLimits(candidate, current, limits)
      : failure("revision_exhausted", current);
  }

  if (command.type === "clear") {
    if (current.orderedItemIds.length === 0) {
      return { ok: true, changed: false, draft: cloneCaptureDraft(current) };
    }
    const candidate = changedDraft(current, command.at, { orderedItemIds: [], items: {} });
    return candidate
      ? enforceCandidateLimits(candidate, current, limits)
      : failure("revision_exhausted", current);
  }

  if (command.type === "label-page") {
    const pageUrl = normalizedHttpPageUrl(command.pageUrl);
    if (!pageUrl) return failure("invalid_page_url", current);
    const label = normalizeCapturePageFolderLabel(command.label);
    if (label === undefined) return failure("invalid_page_label", current);

    let matched = false;
    let changed = false;
    const items = Object.fromEntries(current.orderedItemIds.map((itemId) => {
      const next = cloneItem(current.items[itemId]);
      if (normalizedHttpPageUrl(next.media.pageUrl) !== pageUrl) return [itemId, next] as const;
      matched = true;
      const existing = next.pageFolderLabel ?? null;
      if (existing === label) return [itemId, next] as const;
      changed = true;
      if (label === null) delete next.pageFolderLabel;
      else next.pageFolderLabel = label;
      return [itemId, next] as const;
    }));
    if (!matched || !changed) {
      return { ok: true, changed: false, draft: cloneCaptureDraft(current) };
    }
    const candidate = changedDraft(current, command.at, { items });
    return candidate
      ? enforceCandidateLimits(candidate, current, limits)
      : failure("revision_exhausted", current);
  }

  if (command.type === "set-item-custom-stem") {
    if (!Object.prototype.hasOwnProperty.call(current.items, command.itemId)) {
      return failure("item_not_found", current);
    }
    const existing = current.items[command.itemId];
    if ((existing.customStem ?? null) === command.customStem) {
      return { ok: true, changed: false, draft: cloneCaptureDraft(current) };
    }
    const items = Object.fromEntries(current.orderedItemIds.map((itemId) => {
      const next = cloneItem(current.items[itemId]);
      if (itemId !== command.itemId) return [itemId, next] as const;
      if (command.customStem === null) delete next.customStem;
      else next.customStem = command.customStem;
      return [itemId, next] as const;
    }));
    const candidate = changedDraft(current, command.at, { items });
    return candidate
      ? enforceCandidateLimits(candidate, current, limits)
      : failure("revision_exhausted", current);
  }

  if (command.type === "set-manifest-csv") {
    const enabled = current.preferences.manifestFormats.includes("csv");
    if (enabled === command.enabled) {
      return { ok: true, changed: false, draft: cloneCaptureDraft(current) };
    }
    const candidate = changedDraft(current, command.at, {
      preferences: {
        ...clonePreferences(current.preferences),
        // JSON is an invariant, not a caller-controlled format selection.
        manifestFormats: command.enabled ? ["json", "csv"] : ["json"],
      },
    });
    return candidate
      ? enforceCandidateLimits(candidate, current, limits)
      : failure("revision_exhausted", current);
  }

  const name = normalizedDraftName(command.name);
  if (!name) return failure("invalid_name", current);
  if (name === current.name) {
    return { ok: true, changed: false, draft: cloneCaptureDraft(current) };
  }
  const candidate = changedDraft(current, command.at, { name });
  return candidate
    ? enforceCandidateLimits(candidate, current, limits)
    : failure("revision_exhausted", current);
}

function storageFailure(parsed: Extract<StoredCaptureDraftParseResult, { status: "invalid" }>): CaptureDraftStorageFailure {
  const reasonByParseReason = {
    corrupt: "storage_corrupt",
    future_schema: "storage_future_schema",
    item_limit: "storage_item_limit",
    serialized_byte_limit: "storage_serialized_byte_limit",
  } as const;
  return {
    ok: false,
    reason: reasonByParseReason[parsed.reason],
    draft: null,
    schemaVersion: parsed.schemaVersion,
    measuredBytes: parsed.measuredBytes,
  };
}

function storageUnavailable(
  operation: "read" | "write",
  draft: CaptureDraftV1 | null,
  commitState?: "absent" | "unknown",
): CaptureDraftStorageFailure {
  return {
    ok: false,
    reason: "storage_unavailable",
    operation,
    draft: draft ? cloneCaptureDraft(draft) : null,
    ...(commitState === undefined ? {} : { commitState }),
  };
}

function sameStoredDraft(
  left: CaptureDraftV1 | null,
  right: CaptureDraftV1 | null,
): boolean {
  try {
    return JSON.stringify(left ? cloneCaptureDraft(left) : null) ===
      JSON.stringify(right ? cloneCaptureDraft(right) : null);
  } catch {
    return false;
  }
}

async function readStoredDraft(): Promise<StoredCaptureDraftParseResult> {
  const stored: Record<string, unknown> = await chrome.storage.session.get(CAPTURE_DRAFT_STORAGE_KEY);
  return parseStoredCaptureDraft(stored[CAPTURE_DRAFT_STORAGE_KEY]);
}

/**
 * Background-service-worker adapter. Extension UI realms must send commands
 * through the background owner instead of writing this storage key directly.
 */
export async function getActiveCaptureDraft(): Promise<CaptureDraftStorageResult> {
  return withKeyLock(CAPTURE_DRAFT_STORAGE_KEY, async () => {
    let parsed: StoredCaptureDraftParseResult;
    try {
      parsed = await readStoredDraft();
    } catch {
      return storageUnavailable("read", null);
    }
    if (parsed.status === "invalid") return storageFailure(parsed);
    return reduceCaptureDraft(parsed.status === "valid" ? parsed.draft : null, { type: "get" });
  });
}

/**
 * Background-service-worker adapter. It is the sole writer; popup and side
 * panel callers must route revisioned commands through background messaging.
 */
export async function applyCaptureDraftCommand(
  command: Exclude<CaptureDraftCommand, { type: "get" }>,
): Promise<CaptureDraftStorageResult> {
  return withKeyLock(CAPTURE_DRAFT_STORAGE_KEY, async () => {
    let parsed: StoredCaptureDraftParseResult;
    try {
      parsed = await readStoredDraft();
    } catch {
      return storageUnavailable("read", null);
    }
    if (parsed.status === "invalid") return storageFailure(parsed);
    const current = parsed.status === "valid" ? parsed.draft : null;
    const result = reduceCaptureDraft(current, command);
    if (result.ok && result.changed && result.draft) {
      try {
        await chrome.storage.session.set({ [CAPTURE_DRAFT_STORAGE_KEY]: result.draft });
      } catch {
        // Chrome APIs can reject after committing a side effect. Re-read the
        // exact canonical draft before telling a higher-level lease saga that
        // it is safe to compensate. A matching candidate is success; an
        // unchanged prior value is definitively absent; every other state is
        // ambiguous and must retain both sides for startup reconciliation.
        let observed: CaptureDraftV1 | null;
        try {
          const reread = await readStoredDraft();
          if (reread.status === "invalid") {
            return storageUnavailable("write", current, "unknown");
          }
          observed = reread.status === "valid" ? reread.draft : null;
        } catch {
          return storageUnavailable("write", current, "unknown");
        }
        if (sameStoredDraft(observed, result.draft)) return result;
        return storageUnavailable(
          "write",
          observed,
          sameStoredDraft(observed, current) ? "absent" : "unknown",
        );
      }
    }
    return result;
  });
}
