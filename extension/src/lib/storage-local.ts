import { DEFAULT_HLS_SIZE_CAP_BYTES, HARD_HLS_SIZE_CAP_BYTES } from "./constants";

export type FilenameTemplate = "auto" | "pageTitle" | "urlBasename" | "timestamp";
export type CapturePackQualityMode = "manual" | "best_under_cap";

export const CAPTURE_PACK_MAX_HEIGHT_OPTIONS = Object.freeze([
  480,
  720,
  1080,
  1440,
  2160,
] as const);
export type CapturePackMaxHeight = (typeof CAPTURE_PACK_MAX_HEIGHT_OPTIONS)[number];

export type UserSettings = {
  filenameTemplate: FilenameTemplate;
  hlsSizeCapBytes: number;
  capturePackQualityMode: CapturePackQualityMode;
  capturePackMaxHeight?: CapturePackMaxHeight;
  showFullUrlsByDefault: boolean;
  ignoredSourceHosts: string[];
  ignoredPageHosts: string[];
};

export const DEFAULT_SETTINGS: UserSettings = {
  filenameTemplate: "auto",
  hlsSizeCapBytes: DEFAULT_HLS_SIZE_CAP_BYTES,
  capturePackQualityMode: "best_under_cap",
  showFullUrlsByDefault: false,
  ignoredSourceHosts: [],
  ignoredPageHosts: [],
};

const KEY = "settings";
const MAX_IGNORED_HOST_FILTERS = 500;
const MAX_IGNORED_HOST_LENGTH = 2_048;

function ownDataValue(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isFilenameTemplate(value: unknown): value is FilenameTemplate {
  return (
    value === "auto" ||
    value === "pageTitle" ||
    value === "urlBasename" ||
    value === "timestamp"
  );
}

function isCapturePackQualityMode(value: unknown): value is CapturePackQualityMode {
  return value === "manual" || value === "best_under_cap";
}

function isCapturePackMaxHeight(value: unknown): value is CapturePackMaxHeight {
  return (
    typeof value === "number" &&
    CAPTURE_PACK_MAX_HEIGHT_OPTIONS.some((height) => height === value)
  );
}

function canonicalHostFilters(value: unknown): string[] {
  try {
    if (!Array.isArray(value) || value.length > MAX_IGNORED_HOST_FILTERS) return [];
    const result: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        descriptor.value.length === 0 ||
        descriptor.value.length > MAX_IGNORED_HOST_LENGTH
      ) {
        return [];
      }
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return [];
  }
}

function canonicalSettings(value: unknown): UserSettings {
  const filenameTemplate = ownDataValue(value, "filenameTemplate");
  const hlsSizeCapBytes = ownDataValue(value, "hlsSizeCapBytes");
  const capturePackQualityMode = ownDataValue(value, "capturePackQualityMode");
  const capturePackMaxHeight = ownDataValue(value, "capturePackMaxHeight");
  const showFullUrlsByDefault = ownDataValue(value, "showFullUrlsByDefault");

  return {
    filenameTemplate: isFilenameTemplate(filenameTemplate)
      ? filenameTemplate
      : DEFAULT_SETTINGS.filenameTemplate,
    hlsSizeCapBytes:
      typeof hlsSizeCapBytes === "number" &&
      Number.isSafeInteger(hlsSizeCapBytes) &&
      hlsSizeCapBytes > 0 &&
      hlsSizeCapBytes <= HARD_HLS_SIZE_CAP_BYTES
        ? hlsSizeCapBytes
        : DEFAULT_SETTINGS.hlsSizeCapBytes,
    capturePackQualityMode: isCapturePackQualityMode(capturePackQualityMode)
      ? capturePackQualityMode
      : DEFAULT_SETTINGS.capturePackQualityMode,
    ...(isCapturePackMaxHeight(capturePackMaxHeight)
      ? { capturePackMaxHeight }
      : {}),
    showFullUrlsByDefault:
      typeof showFullUrlsByDefault === "boolean"
        ? showFullUrlsByDefault
        : DEFAULT_SETTINGS.showFullUrlsByDefault,
    ignoredSourceHosts: canonicalHostFilters(ownDataValue(value, "ignoredSourceHosts")),
    ignoredPageHosts: canonicalHostFilters(ownDataValue(value, "ignoredPageHosts")),
  };
}

export async function getSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(KEY);
  return canonicalSettings(ownDataValue(result, KEY));
}

export async function setSettings(partial: Partial<UserSettings>): Promise<void> {
  const current = await getSettings();
  const next = canonicalSettings({ ...current, ...partial });
  await chrome.storage.local.set({ [KEY]: next });
}

export async function resetSettings(): Promise<void> {
  await chrome.storage.local.set({ [KEY]: DEFAULT_SETTINGS });
}
