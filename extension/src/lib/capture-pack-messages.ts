import { normalizeCapturePageFolderLabel } from "./capture-pack-types";
import { validateCustomDownloadStem } from "./download-path";

const CAPTURE_DRAFT_COMMAND_PREFIX = "capture-draft-";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[a-z0-9._:-]+$/i;
const UNSAFE_NAME_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 120;
const MAX_PAGE_URL_LENGTH = 16_384;

export type CaptureDraftCommandId = string;

export type CaptureDraftGetRequest = {
  type: "capture-draft-get";
};

export type CaptureDraftAddRequest = {
  type: "capture-draft-add";
  commandId: CaptureDraftCommandId;
  expectedRevision: number;
  tabId: number;
  mediaId: string;
  customStem?: string;
};

export type CaptureDraftRemoveRequest = {
  type: "capture-draft-remove";
  commandId: CaptureDraftCommandId;
  expectedRevision: number;
  itemId: string;
};

export type CaptureDraftRemovePageRequest = {
  type: "capture-draft-remove-page";
  commandId: CaptureDraftCommandId;
  expectedRevision: number;
  pageUrl: string | null;
};

export type CaptureDraftClearRequest = {
  type: "capture-draft-clear";
  commandId: CaptureDraftCommandId;
  expectedRevision: number;
};

export type CaptureDraftRenameRequest = {
  type: "capture-draft-rename";
  commandId: CaptureDraftCommandId;
  expectedRevision: number;
  name: string;
};

export type CaptureDraftLabelPageRequest = {
  type: "capture-draft-label-page";
  commandId: CaptureDraftCommandId;
  expectedRevision: number;
  pageUrl: string;
  /** `null` is the canonical reset representation. */
  label: string | null;
};

export type CaptureDraftSetItemCustomStemRequest = {
  type: "capture-draft-set-item-custom-stem";
  commandId: CaptureDraftCommandId;
  expectedRevision: number;
  itemId: string;
  customStem: string | null;
};

export type CaptureDraftReplaceMediaRequest = {
  type: "capture-draft-replace-media";
  commandId: CaptureDraftCommandId;
  expectedRevision: number;
  itemId: string;
  tabId: number;
  mediaId: string;
};

export type CaptureDraftSetManifestCsvRequest = {
  type: "capture-draft-set-manifest-csv";
  commandId: CaptureDraftCommandId;
  expectedRevision: number;
  /** JSON remains mandatory; this controls only the optional CSV companion. */
  enabled: boolean;
};

export type CaptureDraftMutationRequest =
  | CaptureDraftAddRequest
  | CaptureDraftRemoveRequest
  | CaptureDraftRemovePageRequest
  | CaptureDraftClearRequest
  | CaptureDraftRenameRequest
  | CaptureDraftLabelPageRequest
  | CaptureDraftSetItemCustomStemRequest
  | CaptureDraftReplaceMediaRequest
  | CaptureDraftSetManifestCsvRequest;

export type CaptureDraftUiRequest = CaptureDraftGetRequest | CaptureDraftMutationRequest;

type DataRecord = Record<string, unknown>;

function exactDataRecord(value: unknown, allowedKeys: readonly string[]): DataRecord | undefined {
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

  const entries: Array<readonly [string, unknown]> = [];
  for (const key of allowedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function dataType(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID_PATTERN.test(value)
  );
}

function isSafeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_NAME_LENGTH &&
    value.trim().length > 0 &&
    !UNSAFE_NAME_PATTERN.test(value)
  );
}

function isSafePageUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PAGE_URL_LENGTH) {
    return false;
  }
  const parsed = new URL(value);
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export function isCaptureDraftCommandId(value: unknown): value is CaptureDraftCommandId {
  return (
    typeof value === "string" &&
    value.startsWith(CAPTURE_DRAFT_COMMAND_PREFIX) &&
    UUID_PATTERN.test(value.slice(CAPTURE_DRAFT_COMMAND_PREFIX.length))
  );
}

export function createCaptureDraftCommandId(
  randomUUID: () => string = () => crypto.randomUUID(),
): CaptureDraftCommandId {
  const commandId = `${CAPTURE_DRAFT_COMMAND_PREFIX}${randomUUID()}`;
  if (!isCaptureDraftCommandId(commandId)) {
    throw new TypeError("The UUID source returned an invalid capture-draft command ID.");
  }
  return commandId;
}

function mutationBase(
  record: DataRecord,
): record is DataRecord & { commandId: CaptureDraftCommandId; expectedRevision: number } {
  return (
    isCaptureDraftCommandId(record.commandId) &&
    isSafeNonNegativeInteger(record.expectedRevision)
  );
}

function parseCaptureDraftUiRequestUnsafe(value: unknown): CaptureDraftUiRequest | undefined {
  switch (dataType(value)) {
    case "capture-draft-get": {
      const record = exactDataRecord(value, ["type"]);
      return record?.type === "capture-draft-get" ? { type: "capture-draft-get" } : undefined;
    }
    case "capture-draft-add": {
      const record = exactDataRecord(value, [
        "type",
        "commandId",
        "expectedRevision",
        "tabId",
        "mediaId",
        "customStem",
      ]) ?? exactDataRecord(value, [
        "type",
        "commandId",
        "expectedRevision",
        "tabId",
        "mediaId",
      ]);
      const customStem = record?.customStem === undefined
        ? undefined
        : typeof record.customStem === "string"
          ? validateCustomDownloadStem(record.customStem)
          : undefined;
      if (
        !record ||
        record.type !== "capture-draft-add" ||
        !mutationBase(record) ||
        !isSafeNonNegativeInteger(record.tabId) ||
        !isSafeId(record.mediaId) ||
        (record.customStem !== undefined && (customStem === undefined || !customStem.ok))
      ) {
        return undefined;
      }
      const customStemValue = customStem?.ok ? customStem.stem : undefined;
      return {
        type: "capture-draft-add",
        commandId: record.commandId,
        expectedRevision: record.expectedRevision,
        tabId: record.tabId,
        mediaId: record.mediaId,
        ...(customStemValue === undefined ? {} : { customStem: customStemValue }),
      };
    }
    case "capture-draft-remove": {
      const record = exactDataRecord(value, ["type", "commandId", "expectedRevision", "itemId"]);
      if (
        !record ||
        record.type !== "capture-draft-remove" ||
        !mutationBase(record) ||
        !isSafeId(record.itemId)
      ) {
        return undefined;
      }
      return {
        type: "capture-draft-remove",
        commandId: record.commandId,
        expectedRevision: record.expectedRevision,
        itemId: record.itemId,
      };
    }
    case "capture-draft-remove-page": {
      const record = exactDataRecord(value, ["type", "commandId", "expectedRevision", "pageUrl"]);
      if (
        !record ||
        record.type !== "capture-draft-remove-page" ||
        !mutationBase(record) ||
        !isSafePageUrl(record.pageUrl)
      ) {
        return undefined;
      }
      return {
        type: "capture-draft-remove-page",
        commandId: record.commandId,
        expectedRevision: record.expectedRevision,
        pageUrl: record.pageUrl,
      };
    }
    case "capture-draft-clear": {
      const record = exactDataRecord(value, ["type", "commandId", "expectedRevision"]);
      if (!record || record.type !== "capture-draft-clear" || !mutationBase(record)) {
        return undefined;
      }
      return {
        type: "capture-draft-clear",
        commandId: record.commandId,
        expectedRevision: record.expectedRevision,
      };
    }
    case "capture-draft-rename": {
      const record = exactDataRecord(value, ["type", "commandId", "expectedRevision", "name"]);
      if (
        !record ||
        record.type !== "capture-draft-rename" ||
        !mutationBase(record) ||
        !isSafeName(record.name)
      ) {
        return undefined;
      }
      return {
        type: "capture-draft-rename",
        commandId: record.commandId,
        expectedRevision: record.expectedRevision,
        name: record.name,
      };
    }
    case "capture-draft-label-page": {
      const record = exactDataRecord(value, [
        "type",
        "commandId",
        "expectedRevision",
        "pageUrl",
        "label",
      ]);
      const label = record ? normalizeCapturePageFolderLabel(record.label) : undefined;
      if (
        !record ||
        record.type !== "capture-draft-label-page" ||
        !mutationBase(record) ||
        typeof record.pageUrl !== "string" ||
        !isSafePageUrl(record.pageUrl) ||
        label === undefined
      ) {
        return undefined;
      }
      return {
        type: "capture-draft-label-page",
        commandId: record.commandId,
        expectedRevision: record.expectedRevision,
        pageUrl: new URL(record.pageUrl).href,
        label,
      };
    }
    case "capture-draft-replace-media": {
      const record = exactDataRecord(value, [
        "type",
        "commandId",
        "expectedRevision",
        "itemId",
        "tabId",
        "mediaId",
      ]);
      if (
        !record ||
        record.type !== "capture-draft-replace-media" ||
        !mutationBase(record) ||
        !isSafeId(record.itemId) ||
        !isSafeNonNegativeInteger(record.tabId) ||
        !isSafeId(record.mediaId)
      ) {
        return undefined;
      }
      return {
        type: "capture-draft-replace-media",
        commandId: record.commandId,
        expectedRevision: record.expectedRevision,
        itemId: record.itemId,
        tabId: record.tabId,
        mediaId: record.mediaId,
      };
    }
    case "capture-draft-set-item-custom-stem": {
      const record = exactDataRecord(value, [
        "type",
        "commandId",
        "expectedRevision",
        "itemId",
        "customStem",
      ]);
      const customStem = record?.customStem === null
        ? null
        : typeof record?.customStem === "string"
          ? validateCustomDownloadStem(record.customStem)
          : undefined;
      if (
        !record ||
        record.type !== "capture-draft-set-item-custom-stem" ||
        !mutationBase(record) ||
        !isSafeId(record.itemId) ||
        customStem === undefined ||
        (customStem !== null && !customStem.ok)
      ) {
        return undefined;
      }
      const customStemValue = customStem === null
        ? null
        : customStem.ok
          ? customStem.stem
          : undefined;
      if (customStemValue === undefined) return undefined;
      return {
        type: "capture-draft-set-item-custom-stem",
        commandId: record.commandId,
        expectedRevision: record.expectedRevision,
        itemId: record.itemId,
        customStem: customStemValue,
      };
    }
    case "capture-draft-set-manifest-csv": {
      const record = exactDataRecord(value, [
        "type",
        "commandId",
        "expectedRevision",
        "enabled",
      ]);
      if (
        !record ||
        record.type !== "capture-draft-set-manifest-csv" ||
        !mutationBase(record) ||
        typeof record.enabled !== "boolean"
      ) {
        return undefined;
      }
      return {
        type: "capture-draft-set-manifest-csv",
        commandId: record.commandId,
        expectedRevision: record.expectedRevision,
        enabled: record.enabled,
      };
    }
    default:
      return undefined;
  }
}

export function parseCaptureDraftUiRequest(value: unknown): CaptureDraftUiRequest | undefined {
  try {
    return parseCaptureDraftUiRequestUnsafe(value);
  } catch {
    return undefined;
  }
}

export function isCaptureDraftUiRequest(value: unknown): value is CaptureDraftUiRequest {
  return parseCaptureDraftUiRequest(value) !== undefined;
}

export function isCaptureDraftMutationRequest(value: unknown): value is CaptureDraftMutationRequest {
  const parsed = parseCaptureDraftUiRequest(value);
  return parsed !== undefined && parsed.type !== "capture-draft-get";
}

export function isCaptureDraftGetRequest(value: unknown): value is CaptureDraftGetRequest {
  return parseCaptureDraftUiRequest(value)?.type === "capture-draft-get";
}
