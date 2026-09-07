import { validateCustomDownloadStem } from "./download-path";
import { isDownloadCommandId } from "./download-intent";

const MAX_ID_LENGTH = 256;
const MAX_URL_OR_SELECTOR_LENGTH = 16_384;
const MAX_VARIANT_LABEL_LENGTH = 120;
const SAFE_ID_PATTERN = /^[a-z0-9._:-]+$/i;
const CONTROL_OR_BIDI_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export type DownloadRequest = {
  type: "download";
  commandId: string;
  tabId: number;
  videoId: string;
  variantId?: string;
  audioRenditionUrl?: string;
  variantLabel?: string;
  customStem?: string;
  bypassSizeCap?: boolean;
};

type DataRecord = Record<string, unknown>;

function exactDataRecord(value: unknown, allowedKeys: readonly string[]): DataRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    ) {
      return undefined;
    }
    const result = Object.create(null) as DataRecord;
    for (const key of ownKeys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID_PATTERN.test(value) &&
    !CONTROL_OR_BIDI_PATTERN.test(value)
  );
}

function safeOptionalSelector(value: unknown): value is string | undefined {
  return value === undefined || (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_URL_OR_SELECTOR_LENGTH &&
    !CONTROL_OR_BIDI_PATTERN.test(value)
  );
}

function safeOptionalHttpUrl(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_URL_OR_SELECTOR_LENGTH ||
    CONTROL_OR_BIDI_PATTERN.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function safeOptionalLabel(value: unknown): value is string | undefined {
  return value === undefined || (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_VARIANT_LABEL_LENGTH &&
    !CONTROL_OR_BIDI_PATTERN.test(value)
  );
}

export function parseDownloadRequest(value: unknown): DownloadRequest | undefined {
  const record = exactDataRecord(value, [
    "type",
    "commandId",
    "tabId",
    "videoId",
    "variantId",
    "audioRenditionUrl",
    "variantLabel",
    "customStem",
    "bypassSizeCap",
  ]);
  if (
    !record ||
    record.type !== "download" ||
    !isDownloadCommandId(record.commandId) ||
    !safeNonNegativeInteger(record.tabId) ||
    !safeId(record.videoId) ||
    !safeOptionalSelector(record.variantId) ||
    !safeOptionalHttpUrl(record.audioRenditionUrl) ||
    !safeOptionalLabel(record.variantLabel) ||
    (record.bypassSizeCap !== undefined && typeof record.bypassSizeCap !== "boolean")
  ) {
    return undefined;
  }

  const customStem = record.customStem === undefined
    ? undefined
    : typeof record.customStem === "string"
      ? validateCustomDownloadStem(record.customStem)
      : undefined;
  if (record.customStem !== undefined && (customStem === undefined || !customStem.ok)) {
    return undefined;
  }

  return {
    type: "download",
    commandId: record.commandId,
    tabId: record.tabId,
    videoId: record.videoId,
    ...(record.variantId === undefined ? {} : { variantId: record.variantId }),
    ...(record.audioRenditionUrl === undefined ? {} : { audioRenditionUrl: record.audioRenditionUrl }),
    ...(record.variantLabel === undefined ? {} : { variantLabel: record.variantLabel }),
    ...(customStem?.ok ? { customStem: customStem.stem } : {}),
    ...(record.bypassSizeCap === undefined ? {} : { bypassSizeCap: record.bypassSizeCap }),
  };
}
