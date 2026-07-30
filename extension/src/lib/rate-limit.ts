export const VIDEO_DOWNLOAD_HISTORY_KEY = "video-download-history";
const WINDOW_MS = 24 * 60 * 60 * 1000;

export const FREE_DOWNLOAD_LIMIT = 4;

type DownloadEvent = { at: number; id?: string };

export type DownloadReservation = { id: string };

let historyWriteQueue: Promise<unknown> = Promise.resolve();

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

function makeReservationId(now: number): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `quota-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function withHistoryWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = historyWriteQueue.then(fn, fn);
  historyWriteQueue = next.catch(() => undefined);
  return next;
}

export async function getDownloadCount(now: number = Date.now()): Promise<number> {
  const events = pruneOld(await getHistory(), now);
  return events.length;
}

export async function recordDownload(now: number = Date.now()): Promise<void> {
  await withHistoryWrite(async () => {
    const events = pruneOld(await getHistory(), now);
    events.push({ at: now });
    await setHistory(events);
  });
}

export async function isRateLimited(now: number = Date.now()): Promise<boolean> {
  const count = await getDownloadCount(now);
  return count >= FREE_DOWNLOAD_LIMIT;
}

export async function reserveDownload(now: number = Date.now()): Promise<DownloadReservation | null> {
  return withHistoryWrite(async () => {
    const events = pruneOld(await getHistory(), now);
    if (events.length >= FREE_DOWNLOAD_LIMIT) return null;
    const reservation = { id: makeReservationId(now) };
    await setHistory([...events, { at: now, id: reservation.id }]);
    return reservation;
  });
}

export async function releaseDownloadReservation(
  reservation: DownloadReservation | string | undefined,
  now: number = Date.now(),
): Promise<void> {
  const id = typeof reservation === "string" ? reservation : reservation?.id;
  if (!id) return;
  await withHistoryWrite(async () => {
    const events = pruneOld(await getHistory(), now);
    await setHistory(events.filter((event) => event.id !== id));
  });
}

export async function resetHistory(): Promise<void> {
  await chrome.storage.local.remove(VIDEO_DOWNLOAD_HISTORY_KEY);
}
