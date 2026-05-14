export const VIDEO_DOWNLOAD_HISTORY_KEY = "video-download-history";
const WINDOW_MS = 24 * 60 * 60 * 1000;

export const FREE_DOWNLOAD_LIMIT = 4;

type DownloadEvent = { at: number };

async function getHistory(): Promise<DownloadEvent[]> {
  const result = await chrome.storage.local.get(VIDEO_DOWNLOAD_HISTORY_KEY);
  const stored = result[VIDEO_DOWNLOAD_HISTORY_KEY];
  return Array.isArray(stored) ? (stored as DownloadEvent[]) : [];
}

async function setHistory(events: DownloadEvent[]): Promise<void> {
  await chrome.storage.local.set({ [VIDEO_DOWNLOAD_HISTORY_KEY]: events });
}

function pruneOld(events: DownloadEvent[], now: number): DownloadEvent[] {
  return events.filter((e) => now - e.at < WINDOW_MS);
}

export async function getDownloadCount(now: number = Date.now()): Promise<number> {
  const events = pruneOld(await getHistory(), now);
  return events.length;
}

export async function recordDownload(now: number = Date.now()): Promise<void> {
  const events = pruneOld(await getHistory(), now);
  events.push({ at: now });
  await setHistory(events);
}

export async function isRateLimited(now: number = Date.now()): Promise<boolean> {
  const count = await getDownloadCount(now);
  return count >= FREE_DOWNLOAD_LIMIT;
}

export async function resetHistory(): Promise<void> {
  await chrome.storage.local.remove(VIDEO_DOWNLOAD_HISTORY_KEY);
}
