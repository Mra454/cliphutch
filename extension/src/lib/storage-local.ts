import { DEFAULT_HLS_SIZE_CAP_BYTES } from "./constants";

export type FilenameTemplate = "pageTitle" | "urlBasename" | "timestamp";

export type UserSettings = {
  filenameTemplate: FilenameTemplate;
  hlsSizeCapBytes: number;
  showFullUrlsByDefault: boolean;
};

const DEFAULTS: UserSettings = {
  filenameTemplate: "urlBasename",
  hlsSizeCapBytes: DEFAULT_HLS_SIZE_CAP_BYTES,
  showFullUrlsByDefault: false,
};

const KEY = "settings";

export async function getSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(KEY);
  const stored = result[KEY] as Partial<UserSettings> | undefined;
  return { ...DEFAULTS, ...(stored ?? {}) };
}

export async function setSettings(partial: Partial<UserSettings>): Promise<void> {
  const current = await getSettings();
  const next: UserSettings = { ...current, ...partial };
  await chrome.storage.local.set({ [KEY]: next });
}
