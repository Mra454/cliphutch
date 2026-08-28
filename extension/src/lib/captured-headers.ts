// Captured request headers for detected media, persisted in
// chrome.storage.session. Detection and download can be minutes apart, and an
// MV3 service worker is evicted after ~30s idle, so keeping these only in an
// in-memory Map meant a later download installed no header-replay rule and
// header-gated fetches 403'd. Persisting survives the restart.

import { withKeyLock } from "./session-jobs";
import type { CapturedHeaders } from "./header-capture";

const KEY = "captured-headers";

export type CapturedHeaderEntry = { tabId: number; headers: CapturedHeaders };

function cloneHeaders(value: unknown): CapturedHeaders | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const record = value as Record<string, unknown>;
    const named = ["referer", "origin", "userAgent", "authorization"] as const;
    if (named.some((key) => record[key] !== undefined && typeof record[key] !== "string")) {
      return undefined;
    }
    let custom: Record<string, string> | undefined;
    if (record.custom !== undefined) {
      if (!record.custom || typeof record.custom !== "object" || Array.isArray(record.custom)) {
        return undefined;
      }
      custom = {};
      for (const [name, headerValue] of Object.entries(record.custom)) {
        if (typeof headerValue !== "string") return undefined;
        custom[name] = headerValue;
      }
    }
    return {
      ...(typeof record.referer === "string" ? { referer: record.referer } : {}),
      ...(typeof record.origin === "string" ? { origin: record.origin } : {}),
      ...(typeof record.userAgent === "string" ? { userAgent: record.userAgent } : {}),
      ...(typeof record.authorization === "string"
        ? { authorization: record.authorization }
        : {}),
      ...(custom === undefined ? {} : { custom }),
    };
  } catch {
    return undefined;
  }
}

async function readAll(): Promise<Record<string, CapturedHeaderEntry>> {
  const result = await chrome.storage.session.get(KEY);
  const value = result[KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Record<string, CapturedHeaderEntry> = {};
  try {
    for (const [videoId, rawEntry] of Object.entries(value)) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
      const record = rawEntry as Record<string, unknown>;
      const headers = cloneHeaders(record.headers);
      if (
        !Number.isSafeInteger(record.tabId) ||
        (record.tabId as number) < 0 ||
        !headers
      ) continue;
      entries[videoId] = { tabId: record.tabId as number, headers };
    }
  } catch {
    return {};
  }
  return entries;
}

export async function saveCapturedHeaders(
  videoId: string,
  tabId: number,
  headers: CapturedHeaders,
): Promise<void> {
  await withKeyLock(KEY, async () => {
    const all = await readAll();
    const cloned = cloneHeaders(headers);
    if (!cloned) throw new TypeError("Captured headers are invalid.");
    all[videoId] = { tabId, headers: cloned };
    await chrome.storage.session.set({ [KEY]: all });
  });
}

export async function getCapturedHeaders(videoId: string): Promise<CapturedHeaders | undefined> {
  return (await getCapturedHeaderEntry(videoId))?.headers;
}

/**
 * Returns the authoritative tab binding together with an isolated header
 * clone. Capture-Pack lease creation must use this API and compare sourceTabId
 * instead of trusting an opaque media identifier as proof of tab ownership.
 */
export async function getCapturedHeaderEntry(
  videoId: string,
): Promise<CapturedHeaderEntry | undefined> {
  const entry = (await readAll())[videoId];
  if (!entry) return undefined;
  return { tabId: entry.tabId, headers: cloneHeaders(entry.headers) ?? {} };
}

export async function getCapturedHeadersForTab(
  videoId: string,
  tabId: number,
): Promise<CapturedHeaders | undefined> {
  const entry = await getCapturedHeaderEntry(videoId);
  return entry?.tabId === tabId ? entry.headers : undefined;
}

export async function clearCapturedHeadersForTab(tabId: number): Promise<void> {
  await withKeyLock(KEY, async () => {
    const all = await readAll();
    let changed = false;
    for (const [id, entry] of Object.entries(all)) {
      if (entry.tabId === tabId) {
        delete all[id];
        changed = true;
      }
    }
    if (changed) await chrome.storage.session.set({ [KEY]: all });
  });
}
