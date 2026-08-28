import {
  createCaptureDraftCommandId,
  type CaptureDraftUiRequest,
} from "./capture-pack-messages";
import { isCaptureDraftV1, type CaptureDraftV1 } from "./capture-pack-types";

export type CaptureDraftClientResult =
  | {
      ok: true;
      changed: boolean;
      alreadySelected?: boolean;
      draft: CaptureDraftV1 | null;
    }
  | {
      ok: false;
      reason: string;
      draft: CaptureDraftV1 | null;
      actualRevision?: number;
      existingItemId?: string;
    };

function parseClientResult(value: unknown): CaptureDraftClientResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const record = value as Record<string, unknown>;
    const draft = record.draft;
    if (draft !== null && !isCaptureDraftV1(draft)) return undefined;
    if (record.ok === true && typeof record.changed === "boolean") {
      return {
        ok: true,
        changed: record.changed,
        ...(record.alreadySelected === true ? { alreadySelected: true } : {}),
        draft,
      };
    }
    if (record.ok === false && typeof record.reason === "string" && record.reason.length <= 100) {
      return {
        ok: false,
        reason: record.reason,
        draft,
        ...(typeof record.actualRevision === "number" && Number.isSafeInteger(record.actualRevision)
          ? { actualRevision: record.actualRevision }
          : {}),
        ...(typeof record.existingItemId === "string" && record.existingItemId.length <= 256
          ? { existingItemId: record.existingItemId }
          : {}),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function sendCaptureDraftRequest(
  request: CaptureDraftUiRequest,
): Promise<CaptureDraftClientResult> {
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage(request);
  } catch {
    return { ok: false, reason: "background_unavailable", draft: null };
  }
  return parseClientResult(response) ?? {
    ok: false,
    reason: "invalid_background_response",
    draft: null,
  };
}

export function getCaptureDraft(): Promise<CaptureDraftClientResult> {
  return sendCaptureDraftRequest({ type: "capture-draft-get" });
}

export function addDetectedMediaToCaptureDraft(input: {
  tabId: number;
  mediaId: string;
  expectedRevision: number;
  commandId?: string;
}): Promise<CaptureDraftClientResult> {
  return sendCaptureDraftRequest({
    type: "capture-draft-add",
    commandId: input.commandId ?? createCaptureDraftCommandId(),
    expectedRevision: input.expectedRevision,
    tabId: input.tabId,
    mediaId: input.mediaId,
  });
}

export function removeCaptureDraftItem(input: {
  itemId: string;
  expectedRevision: number;
  commandId?: string;
}): Promise<CaptureDraftClientResult> {
  return sendCaptureDraftRequest({
    type: "capture-draft-remove",
    commandId: input.commandId ?? createCaptureDraftCommandId(),
    expectedRevision: input.expectedRevision,
    itemId: input.itemId,
  });
}

export function removeCaptureDraftPage(input: {
  pageUrl: string | null;
  expectedRevision: number;
  commandId?: string;
}): Promise<CaptureDraftClientResult> {
  return sendCaptureDraftRequest({
    type: "capture-draft-remove-page",
    commandId: input.commandId ?? createCaptureDraftCommandId(),
    expectedRevision: input.expectedRevision,
    pageUrl: input.pageUrl,
  });
}

export function clearCaptureDraft(input: {
  expectedRevision: number;
  commandId?: string;
}): Promise<CaptureDraftClientResult> {
  return sendCaptureDraftRequest({
    type: "capture-draft-clear",
    commandId: input.commandId ?? createCaptureDraftCommandId(),
    expectedRevision: input.expectedRevision,
  });
}

export function renameCaptureDraft(input: {
  name: string;
  expectedRevision: number;
  commandId?: string;
}): Promise<CaptureDraftClientResult> {
  return sendCaptureDraftRequest({
    type: "capture-draft-rename",
    commandId: input.commandId ?? createCaptureDraftCommandId(),
    expectedRevision: input.expectedRevision,
    name: input.name,
  });
}

export function labelCaptureDraftPage(input: {
  pageUrl: string;
  /** Empty/whitespace is accepted by the boundary as an explicit reset. */
  label: string | null;
  expectedRevision: number;
  commandId?: string;
}): Promise<CaptureDraftClientResult> {
  return sendCaptureDraftRequest({
    type: "capture-draft-label-page",
    commandId: input.commandId ?? createCaptureDraftCommandId(),
    expectedRevision: input.expectedRevision,
    pageUrl: input.pageUrl,
    label: input.label,
  });
}

export function replaceCaptureDraftMedia(input: {
  itemId: string;
  tabId: number;
  mediaId: string;
  expectedRevision: number;
  commandId?: string;
}): Promise<CaptureDraftClientResult> {
  return sendCaptureDraftRequest({
    type: "capture-draft-replace-media",
    commandId: input.commandId ?? createCaptureDraftCommandId(),
    expectedRevision: input.expectedRevision,
    itemId: input.itemId,
    tabId: input.tabId,
    mediaId: input.mediaId,
  });
}

export function setCaptureDraftManifestCsv(input: {
  enabled: boolean;
  expectedRevision: number;
  commandId?: string;
}): Promise<CaptureDraftClientResult> {
  return sendCaptureDraftRequest({
    type: "capture-draft-set-manifest-csv",
    commandId: input.commandId ?? createCaptureDraftCommandId(),
    expectedRevision: input.expectedRevision,
    enabled: input.enabled,
  });
}
