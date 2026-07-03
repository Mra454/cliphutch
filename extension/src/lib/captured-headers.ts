// Captured request headers for detected media, persisted in
// chrome.storage.session. Detection and download can be minutes apart, and an
// MV3 service worker is evicted after ~30s idle, so keeping these only in an
// in-memory Map meant a later download installed no header-replay rule and
// header-gated fetches 403'd. Persisting survives the restart.

import { withKeyLock } from "./session-jobs";
import type { CapturedHeaders } from "./header-capture";

const KEY = "captured-headers";

type Entry = { tabId: number; headers: CapturedHeaders };

async function readAll(): Promise<Record<string, Entry>> {
  const result = await chrome.storage.session.get(KEY);
  const value = result[KEY];
  return value && typeof value === "object" ? (value as Record<string, Entry>) : {};
}

export async function saveCapturedHeaders(
  videoId: string,
  tabId: number,
  headers: CapturedHeaders,
): Promise<void> {
  await withKeyLock(KEY, async () => {
    const all = await readAll();
    all[videoId] = { tabId, headers };
    await chrome.storage.session.set({ [KEY]: all });
  });
}

export async function getCapturedHeaders(videoId: string): Promise<CapturedHeaders | undefined> {
  const all = await readAll();
  return all[videoId]?.headers;
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
