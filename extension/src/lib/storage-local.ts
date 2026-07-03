import { DEFAULT_HLS_SIZE_CAP_BYTES } from "./constants";

export type FilenameTemplate = "auto" | "pageTitle" | "urlBasename" | "timestamp";

export type UserSettings = {
  filenameTemplate: FilenameTemplate;
  hlsSizeCapBytes: number;
  showFullUrlsByDefault: boolean;
  ignoredSourceHosts: string[];
  ignoredPageHosts: string[];
};

export const DEFAULT_SETTINGS: UserSettings = {
  filenameTemplate: "auto",
  hlsSizeCapBytes: DEFAULT_HLS_SIZE_CAP_BYTES,
  showFullUrlsByDefault: false,
  ignoredSourceHosts: [],
  ignoredPageHosts: [],
};

const KEY = "settings";

export async function getSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(KEY);
  const stored = result[KEY] as Partial<UserSettings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...(stored ?? {}),
    ignoredSourceHosts: Array.isArray(stored?.ignoredSourceHosts) ? stored.ignoredSourceHosts : [],
    ignoredPageHosts: Array.isArray(stored?.ignoredPageHosts) ? stored.ignoredPageHosts : [],
  };
}

export async function setSettings(partial: Partial<UserSettings>): Promise<void> {
  const current = await getSettings();
  const next: UserSettings = { ...current, ...partial };
  await chrome.storage.local.set({ [KEY]: next });
}

export async function resetSettings(): Promise<void> {
  await chrome.storage.local.set({ [KEY]: DEFAULT_SETTINGS });
}
