import type { DetectedVideo } from "../types";
import { freezeCaptureCopySelection } from "./capture-copy-choice";
import { createMediaSnapshotFromDetected } from "./capture-media-snapshot";
import type { CaptureDraftUiRequest } from "./capture-pack-messages";
import {
  cloneCaptureDraft,
  type CaptureDraftCommand,
  type CaptureDraftStorageResult,
} from "./capture-pack-storage";
import {
  normalizeCapturePageFolderLabel,
  type CaptureDraftItemV1,
  type CaptureDraftV1,
  type MediaSnapshotV1,
} from "./capture-pack-types";

export type CaptureDraftHandlerFailure = {
  ok: false;
  reason: "media_not_found" | "invalid_detected_media" | "header_lease_unavailable";
  draft: CaptureDraftV1 | null;
};

export type CaptureDraftHandlerResult = CaptureDraftStorageResult | CaptureDraftHandlerFailure;

export type CaptureDraftHandlerDependencies = {
  getDraft(): Promise<CaptureDraftStorageResult>;
  applyCommand(
    command: Exclude<CaptureDraftCommand, { type: "get" }>,
  ): Promise<CaptureDraftStorageResult>;
  /** One bounded, background-owned snapshot used for both lookup and ranking. */
  listDetectedMedia(tabId: number): Promise<DetectedVideo[]>;
  prepareHeaderLease(input: {
    commandId: string;
    draftId: string;
    itemId: string;
    sourceTabId: number;
    media: MediaSnapshotV1;
    hasCapturedReplayHeaders: boolean;
  }): Promise<{ ok: true; headerLeaseId?: string } | { ok: false }>;
  releaseDraftHeaderLease(input: {
    draftId: string;
    item: CaptureDraftItemV1;
  }): Promise<void>;
  now(): number;
};

function commandUuid(commandId: string): string {
  return commandId.slice("capture-draft-".length);
}

function itemIdForCommand(commandId: string): string {
  return `capture-item-${commandUuid(commandId)}`;
}

function draftIdForCommand(commandId: string): string {
  return `capture-pack-${commandUuid(commandId)}`;
}

function selectedReplay(
  draft: CaptureDraftV1 | null,
  itemId: string,
): CaptureDraftStorageResult | undefined {
  if (!draft || !Object.prototype.hasOwnProperty.call(draft.items, itemId)) return undefined;
  return {
    ok: true,
    changed: false,
    alreadySelected: true,
    draft: cloneCaptureDraft(draft),
  };
}

function revisionConflict(
  expectedRevision: number,
  draft: CaptureDraftV1 | null,
): CaptureDraftStorageResult {
  return {
    ok: false,
    reason: "revision_conflict",
    expectedRevision,
    actualRevision: draft?.revision ?? 0,
    draft: draft ? cloneCaptureDraft(draft) : null,
  };
}

function currentDraft(result: CaptureDraftStorageResult): CaptureDraftV1 | null {
  return result.draft ? cloneCaptureDraft(result.draft) : null;
}

function canonicalHttpPageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function pageLabelAlreadyApplied(
  draft: CaptureDraftV1 | null,
  pageUrl: string,
  label: string | null,
): boolean {
  if (!draft) return false;
  let matched = false;
  for (const itemId of draft.orderedItemIds) {
    const item = draft.items[itemId];
    if (
      item.media.pageUrl === undefined ||
      canonicalHttpPageUrl(item.media.pageUrl) !== pageUrl
    ) continue;
    matched = true;
    if ((item.pageFolderLabel ?? null) !== label) return false;
  }
  return matched;
}

function mediaReplacementAlreadyApplied(
  draft: CaptureDraftV1 | null,
  itemId: string,
  sourceTabId: number,
  mediaId: string,
  headerLeaseId?: string,
): boolean {
  if (!draft || !Object.prototype.hasOwnProperty.call(draft.items, itemId)) return false;
  const item = draft.items[itemId];
  return item.sourceTabId === sourceTabId &&
    item.media.mediaId === mediaId &&
    (headerLeaseId === undefined || item.headerLeaseId === headerLeaseId);
}

function definitivelyUncommitted(result: CaptureDraftStorageResult): boolean {
  return !result.ok && (
    result.reason !== "storage_unavailable" || result.commitState === "absent"
  );
}

async function releaseLeaseBestEffort(
  dependencies: CaptureDraftHandlerDependencies,
  draftId: string,
  item: CaptureDraftItemV1,
): Promise<void> {
  if (!item.headerLeaseId) return;
  try {
    await dependencies.releaseDraftHeaderLease({ draftId, item });
  } catch {
    // Startup lease reconciliation repairs interrupted cleanup. A customer
    // mutation that already committed must not be reported as failed merely
    // because best-effort secret cleanup needs a retry.
  }
}

export async function handleCaptureDraftUiRequest(
  request: CaptureDraftUiRequest,
  dependencies: CaptureDraftHandlerDependencies,
): Promise<CaptureDraftHandlerResult> {
  const currentResult = await dependencies.getDraft();
  if (request.type === "capture-draft-get") return currentResult;
  if (!currentResult.ok) return currentResult;

  const current = currentDraft(currentResult);
  const at = dependencies.now();

  if (request.type === "capture-draft-add") {
    const itemId = itemIdForCommand(request.commandId);
    const replay = selectedReplay(current, itemId);
    if (replay) return replay;
    if (request.expectedRevision !== (current?.revision ?? 0)) {
      return revisionConflict(request.expectedRevision, current);
    }

    let detectedShelf: DetectedVideo[];
    try {
      detectedShelf = await dependencies.listDetectedMedia(request.tabId);
    } catch {
      return { ok: false, reason: "invalid_detected_media", draft: current };
    }
    const frozenSelection = freezeCaptureCopySelection(request.mediaId, detectedShelf);
    if (!frozenSelection.ok) {
      return { ok: false, reason: frozenSelection.reason, draft: current };
    }
    const { selected: detected, copyChoice, family } = frozenSelection.value;

    let item: CaptureDraftItemV1;
    const draftId = current?.draftId ?? draftIdForCommand(request.commandId);
    let media: MediaSnapshotV1;
    try {
      media = createMediaSnapshotFromDetected(detected);
    } catch {
      return { ok: false, reason: "invalid_detected_media", draft: current };
    }
    let preparedLease: Awaited<ReturnType<CaptureDraftHandlerDependencies["prepareHeaderLease"]>>;
    try {
      preparedLease = await dependencies.prepareHeaderLease({
        commandId: request.commandId,
        draftId,
        itemId,
        sourceTabId: request.tabId,
        media,
        hasCapturedReplayHeaders: detected.hasCapturedReplayHeaders === true,
      });
    } catch {
      return { ok: false, reason: "header_lease_unavailable", draft: current };
    }
    if (!preparedLease.ok) {
      return { ok: false, reason: "header_lease_unavailable", draft: current };
    }
    item = {
      itemId,
      addedAt: at,
      sourceTabId: request.tabId,
      media,
      copyChoice,
      ...(family === undefined ? {} : { family }),
      ...(preparedLease.headerLeaseId === undefined
        ? {}
        : { headerLeaseId: preparedLease.headerLeaseId }),
    };

    const result = await dependencies.applyCommand({
      type: "add",
      expectedRevision: request.expectedRevision,
      at,
      item,
      draftId,
      draftName: current?.name ?? "New Capture Pack",
    });
    if (!result.ok && result.reason === "revision_conflict") {
      const replay = selectedReplay(result.draft, itemId);
      if (replay) return replay;
    }
    if (definitivelyUncommitted(result)) {
      await releaseLeaseBestEffort(dependencies, draftId, item);
    }
    return result;
  }

  if (request.type === "capture-draft-replace-media") {
    if (mediaReplacementAlreadyApplied(
      current,
      request.itemId,
      request.tabId,
      request.mediaId,
    )) {
      return { ok: true, changed: false, draft: current ? cloneCaptureDraft(current) : null };
    }
    if (request.expectedRevision !== (current?.revision ?? 0)) {
      return revisionConflict(request.expectedRevision, current);
    }
    if (!current || !Object.prototype.hasOwnProperty.call(current.items, request.itemId)) {
      return { ok: false, reason: "item_not_found", draft: current };
    }

    let detectedShelf: DetectedVideo[];
    try {
      detectedShelf = await dependencies.listDetectedMedia(request.tabId);
    } catch {
      return { ok: false, reason: "invalid_detected_media", draft: current };
    }
    const frozenSelection = freezeCaptureCopySelection(request.mediaId, detectedShelf);
    if (!frozenSelection.ok) {
      return { ok: false, reason: frozenSelection.reason, draft: current };
    }
    const { selected: detected, copyChoice, family } = frozenSelection.value;
    let media: CaptureDraftItemV1["media"];
    try {
      media = createMediaSnapshotFromDetected(detected);
      if (media.mediaId !== request.mediaId) {
        return { ok: false, reason: "invalid_detected_media", draft: current };
      }
    } catch {
      return { ok: false, reason: "invalid_detected_media", draft: current };
    }
    let preparedLease: Awaited<ReturnType<CaptureDraftHandlerDependencies["prepareHeaderLease"]>>;
    try {
      preparedLease = await dependencies.prepareHeaderLease({
        commandId: request.commandId,
        draftId: current.draftId,
        itemId: request.itemId,
        sourceTabId: request.tabId,
        media,
        hasCapturedReplayHeaders: detected.hasCapturedReplayHeaders === true,
      });
    } catch {
      return { ok: false, reason: "header_lease_unavailable", draft: current };
    }
    if (!preparedLease.ok) {
      return { ok: false, reason: "header_lease_unavailable", draft: current };
    }
    const result = await dependencies.applyCommand({
      type: "replace-media",
      expectedRevision: request.expectedRevision,
      at,
      itemId: request.itemId,
      sourceTabId: request.tabId,
      media,
      copyChoice,
      ...(family === undefined ? {} : { family }),
      ...(preparedLease.headerLeaseId === undefined
        ? {}
        : { headerLeaseId: preparedLease.headerLeaseId }),
    });
    if (!result.ok && result.reason === "revision_conflict") {
      const applied = mediaReplacementAlreadyApplied(
        result.draft,
        request.itemId,
        request.tabId,
        request.mediaId,
        preparedLease.headerLeaseId,
      );
      if (applied) {
        if (current.items[request.itemId].headerLeaseId !== preparedLease.headerLeaseId) {
          await releaseLeaseBestEffort(
            dependencies,
            current.draftId,
            current.items[request.itemId],
          );
        }
        return { ok: true, changed: false, draft: result.draft ? cloneCaptureDraft(result.draft) : null };
      }
    }
    if (result.ok) {
      if (current.items[request.itemId].headerLeaseId !== preparedLease.headerLeaseId) {
        await releaseLeaseBestEffort(
          dependencies,
          current.draftId,
          current.items[request.itemId],
        );
      }
    } else if (definitivelyUncommitted(result) && preparedLease.headerLeaseId) {
      await releaseLeaseBestEffort(dependencies, current.draftId, {
        ...current.items[request.itemId],
        sourceTabId: request.tabId,
        media,
        headerLeaseId: preparedLease.headerLeaseId,
      });
    }
    return result;
  }

  if (request.type === "capture-draft-label-page") {
    const pageUrl = canonicalHttpPageUrl(request.pageUrl);
    const label = normalizeCapturePageFolderLabel(request.label);
    if (pageUrl === undefined) {
      return { ok: false, reason: "invalid_page_url", draft: current };
    }
    if (label === undefined) {
      return { ok: false, reason: "invalid_page_label", draft: current };
    }
    // A lost response can replay the same command after its single revision
    // bump. The desired exact-page state is sufficient to reconcile it; a
    // stale command requesting any other state still conflicts below.
    if (pageLabelAlreadyApplied(current, pageUrl, label)) {
      return { ok: true, changed: false, draft: current ? cloneCaptureDraft(current) : null };
    }
    if (request.expectedRevision !== (current?.revision ?? 0)) {
      return revisionConflict(request.expectedRevision, current);
    }
    return dependencies.applyCommand({
      type: "label-page",
      expectedRevision: request.expectedRevision,
      at,
      pageUrl,
      label,
    });
  }

  if (request.type === "capture-draft-set-manifest-csv") {
    const enabled = current?.preferences.manifestFormats.includes("csv") ?? false;
    // Replaying a response-lost command after its revision bump is safe only
    // when the exact requested preference is already authoritative.
    if (current && enabled === request.enabled) {
      return { ok: true, changed: false, draft: cloneCaptureDraft(current) };
    }
    if (request.expectedRevision !== (current?.revision ?? 0)) {
      return revisionConflict(request.expectedRevision, current);
    }
    return dependencies.applyCommand({
      type: "set-manifest-csv",
      expectedRevision: request.expectedRevision,
      at,
      enabled: request.enabled,
    });
  }

  if (request.expectedRevision !== (current?.revision ?? 0)) {
    return revisionConflict(request.expectedRevision, current);
  }

  if (request.type === "capture-draft-remove") {
    const removed = current?.items[request.itemId];
    const result = await dependencies.applyCommand({
      type: "remove",
      expectedRevision: request.expectedRevision,
      at,
      itemId: request.itemId,
    });
    if (result.ok && result.changed && current && removed) {
      await releaseLeaseBestEffort(dependencies, current.draftId, removed);
    }
    return result;
  }
  if (request.type === "capture-draft-remove-page") {
    const canonicalPage = request.pageUrl === null ? null : new URL(request.pageUrl).href;
    const removed = current?.orderedItemIds.flatMap((itemId) => {
      const item = current.items[itemId];
      const matches = canonicalPage === null
        ? item.media.pageUrl === undefined
        : item.media.pageUrl === canonicalPage;
      return matches ? [item] : [];
    }) ?? [];
    const result = await dependencies.applyCommand({
      type: "remove-page",
      expectedRevision: request.expectedRevision,
      at,
      pageUrl: canonicalPage,
    });
    if (result.ok && result.changed && current) {
      await Promise.all(removed.map((item) =>
        releaseLeaseBestEffort(dependencies, current.draftId, item)));
    }
    return result;
  }
  if (request.type === "capture-draft-clear") {
    const removed = current?.orderedItemIds.map((itemId) => current.items[itemId]) ?? [];
    const result = await dependencies.applyCommand({
      type: "clear",
      expectedRevision: request.expectedRevision,
      at,
    });
    if (result.ok && result.changed && current) {
      await Promise.all(removed.map((item) =>
        releaseLeaseBestEffort(dependencies, current.draftId, item)));
    }
    return result;
  }
  return dependencies.applyCommand({
    type: "rename",
    expectedRevision: request.expectedRevision,
    at,
    name: request.name,
  });
}
