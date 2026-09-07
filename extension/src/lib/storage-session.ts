import { MAX_VIDEOS_PER_TAB } from "./constants";
import { withKeyLock } from "./session-jobs";
import type { DetectedVideo } from "../types";
import {
  detectedMediaIdentityToken,
  isSameDetectedMediaIdentity,
  mergeDetectedVideo,
  normalizeDetectedVideo,
} from "./media-identity";

const tabKey = (tabId: number) => `tab:${tabId}`;
const tabStatsKey = (tabId: number) => `tab:${tabId}:detection-stats-v1`;
const tabPageContextKey = (tabId: number) => `tab:${tabId}:page-context-v1`;
const MAX_TRACKED_DISCARDED_IDENTITIES = 2_000;

export type DetectionRetentionStats = {
  limit: number;
  retainedCount: number;
  droppedCount: number;
  evictedCount: number;
  droppedCountIsLowerBound: boolean;
  evictedCountIsLowerBound: boolean;
  truncated: boolean;
};

export type DetectionRetentionResult = DetectionRetentionStats & {
  action: "added" | "updated" | "dropped" | "added_after_eviction" | "ignored_stale_page";
  mediaId: string;
};

export type DetectionRetentionBatchResult = DetectionRetentionStats & {
  addedCount: number;
  updatedCount: number;
  droppedInBatchCount: number;
  evictedInBatchCount: number;
  ignoredStalePageCount: number;
};

function storedPageContext(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

type StoredDetectionRetentionStats = DetectionRetentionStats & {
  schemaVersion: 1;
  droppedIdentityTokens: string[];
  evictedIdentityTokens: string[];
};

function storedVideos(value: unknown): DetectedVideo[] {
  if (!Array.isArray(value)) return [];
  const normalized: DetectedVideo[] = [];
  // Session state should never exceed the shelf cap. Bound corrupt input work
  // while allowing invalid early entries to be skipped in favour of valid ones.
  const inspected = Math.min(value.length, MAX_VIDEOS_PER_TAB * 4);
  for (let index = 0; index < inspected && normalized.length < MAX_VIDEOS_PER_TAB; index += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) continue;
      const media = normalizeDetectedVideo(descriptor.value);
      if (!media) continue;
      const duplicateIndex = normalized.findIndex(
        (entry) => isSameDetectedMediaIdentity(entry, media),
      );
      if (duplicateIndex >= 0) {
        normalized[duplicateIndex] = mergeDetectedVideo(normalized[duplicateIndex], media);
      } else {
        normalized.push(media);
      }
    } catch {
      // One corrupt record must not hide the rest of the tab's valid shelf.
    }
  }
  return normalized;
}

function storedIdentityTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tokens: string[] = [];
  const inspected = Math.min(value.length, MAX_TRACKED_DISCARDED_IDENTITIES);
  for (let index = 0; index < inspected; index += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      const token = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (
        typeof token === "string" &&
        /^media-v1-[a-z0-9]+$/.test(token) &&
        !tokens.includes(token)
      ) {
        tokens.push(token);
      }
    } catch {
      return [];
    }
  }
  return tokens;
}

function storedStats(value: unknown, retainedCount: number): StoredDetectionRetentionStats {
  let droppedIdentityTokens: string[] = [];
  let evictedIdentityTokens: string[] = [];
  let droppedCountIsLowerBound = false;
  let evictedCountIsLowerBound = false;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (!Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
        droppedIdentityTokens = storedIdentityTokens(descriptors.droppedIdentityTokens?.value);
        evictedIdentityTokens = storedIdentityTokens(descriptors.evictedIdentityTokens?.value);
        droppedCountIsLowerBound = descriptors.droppedCountIsLowerBound?.value === true;
        evictedCountIsLowerBound = descriptors.evictedCountIsLowerBound?.value === true;
      }
    } catch {
      // Fall back to zeroed counters for malformed session metadata.
    }
  }
  return {
    schemaVersion: 1,
    limit: MAX_VIDEOS_PER_TAB,
    retainedCount,
    droppedCount: droppedIdentityTokens.length,
    evictedCount: evictedIdentityTokens.length,
    droppedCountIsLowerBound,
    evictedCountIsLowerBound,
    truncated: droppedIdentityTokens.length > 0 || evictedIdentityTokens.length > 0,
    droppedIdentityTokens,
    evictedIdentityTokens,
  };
}

function publicStats(stats: StoredDetectionRetentionStats): DetectionRetentionStats {
  return {
    limit: stats.limit,
    retainedCount: stats.retainedCount,
    droppedCount: stats.droppedCount,
    evictedCount: stats.evictedCount,
    droppedCountIsLowerBound: stats.droppedCountIsLowerBound,
    evictedCountIsLowerBound: stats.evictedCountIsLowerBound,
    truncated: stats.truncated,
  };
}

function recordDiscardedIdentity(
  stats: StoredDetectionRetentionStats,
  field: "dropped" | "evicted",
  media: DetectedVideo,
): void {
  const token = detectedMediaIdentityToken(media);
  if (!token) return;
  const tokens = field === "dropped"
    ? stats.droppedIdentityTokens
    : stats.evictedIdentityTokens;
  if (tokens.includes(token)) return;
  if (tokens.length >= MAX_TRACKED_DISCARDED_IDENTITIES) {
    if (field === "dropped") stats.droppedCountIsLowerBound = true;
    else stats.evictedCountIsLowerBound = true;
    return;
  }
  tokens.push(token);
  if (field === "dropped") stats.droppedCount = tokens.length;
  else stats.evictedCount = tokens.length;
  stats.truncated = true;
}

function disambiguateCollidingId(
  incoming: DetectedVideo,
  list: readonly DetectedVideo[],
  tabId: number,
): DetectedVideo {
  if (!list.some((entry) => entry.id === incoming.id)) return incoming;
  const prefix = `detected-v1-t${tabId.toString(36)}-`;
  let suffix = 2;
  let suffixText = `-${suffix}`;
  const sourceLength = Math.max(1, 256 - prefix.length - suffixText.length);
  const source = incoming.id.slice(0, sourceLength);
  let candidate = `${prefix}${source}${suffixText}`;
  while (list.some((entry) => entry.id === candidate)) {
    suffix += 1;
    suffixText = `-${suffix}`;
    candidate = `${prefix}${source.slice(0, 256 - prefix.length - suffixText.length)}${suffixText}`;
  }
  return { ...incoming, id: candidate };
}

function retainOne(
  tabId: number,
  list: DetectedVideo[],
  stats: StoredDetectionRetentionStats,
  normalizedIncoming: DetectedVideo,
): Pick<DetectionRetentionResult, "action" | "mediaId"> {
  const existingIndex = list.findIndex(
    (entry) => isSameDetectedMediaIdentity(entry, normalizedIncoming),
  );
  if (existingIndex >= 0) {
    const retainedMedia = mergeDetectedVideo(list[existingIndex], normalizedIncoming);
    list[existingIndex] = retainedMedia;
    return { action: "updated", mediaId: retainedMedia.id };
  }

  const incoming = disambiguateCollidingId(normalizedIncoming, list, tabId);
  if (list.length >= MAX_VIDEOS_PER_TAB) {
    const imageIndex = list.findIndex((entry) => entry.kind === "image");
    if (incoming.kind === "image" || imageIndex === -1) {
      recordDiscardedIdentity(stats, "dropped", incoming);
      return { action: "dropped", mediaId: incoming.id };
    }
    const [evicted] = list.splice(imageIndex, 1);
    recordDiscardedIdentity(stats, "evicted", evicted);
    list.push(incoming);
    return { action: "added_after_eviction", mediaId: incoming.id };
  }
  list.push(incoming);
  return { action: "added", mediaId: incoming.id };
}

export async function getDetectedVideos(tabId: number): Promise<DetectedVideo[]> {
  const key = tabKey(tabId);
  const result = await chrome.storage.session.get(key);
  return storedVideos(result[key]);
}

export async function getDetectionRetentionStats(tabId: number): Promise<DetectionRetentionStats> {
  const key = tabKey(tabId);
  const statsKey = tabStatsKey(tabId);
  const result = await chrome.storage.session.get([key, statsKey]);
  const list = storedVideos(result[key]);
  return publicStats(storedStats(result[statsKey], list.length));
}

export async function addOrUpdateVideo(
  tabId: number,
  video: DetectedVideo,
): Promise<DetectionRetentionResult> {
  const key = tabKey(tabId);
  const statsKey = tabStatsKey(tabId);
  const normalizedIncoming = normalizeDetectedVideo(video);
  if (!normalizedIncoming) {
    throw new TypeError("Detected media must have a valid identity, URL, kind, and time.");
  }
  // A page can fire several media/image responses at once; each add does a
  // read-modify-write on the same tab list, so serialize them or concurrent
  // adds clobber each other and detections vanish from the shelf.
  return withKeyLock(key, async () => {
    const contextKey = tabPageContextKey(tabId);
    const stored = await chrome.storage.session.get([key, statsKey, contextKey]);
    const list = storedVideos(stored[key]);
    const stats = storedStats(stored[statsKey], list.length);
    const pageContext = storedPageContext(stored[contextKey]);
    if (pageContext && normalizedIncoming.pageUrl !== pageContext) {
      return {
        ...publicStats(stats),
        action: "ignored_stale_page",
        mediaId: normalizedIncoming.id,
      };
    }
    const retained = retainOne(tabId, list, stats, normalizedIncoming);
    stats.retainedCount = list.length;
    await chrome.storage.session.set(
      retained.action === "dropped"
        ? { [statsKey]: stats }
        : { [key]: list, [statsKey]: stats },
    );
    return { ...publicStats(stats), ...retained };
  });
}

/**
 * Applies one DOM discovery snapshot in a single session write. This avoids
 * hundreds of read/modify/write cycles and ensures every candidate reaches
 * the same retention accounting instead of being silently sliced upstream.
 */
export async function addOrUpdateVideos(
  tabId: number,
  videos: readonly DetectedVideo[],
): Promise<DetectionRetentionBatchResult> {
  if (!Array.isArray(videos) || videos.length > MAX_TRACKED_DISCARDED_IDENTITIES * 5) {
    throw new TypeError("A detection batch must contain at most 10,000 media records.");
  }
  const normalized = videos.map((video) => {
    const candidate = normalizeDetectedVideo(video);
    if (!candidate) {
      throw new TypeError("Detected media must have a valid identity, URL, kind, and time.");
    }
    return candidate;
  });
  const key = tabKey(tabId);
  const statsKey = tabStatsKey(tabId);
  return withKeyLock(key, async () => {
    const contextKey = tabPageContextKey(tabId);
    const stored = await chrome.storage.session.get([key, statsKey, contextKey]);
    const list = storedVideos(stored[key]);
    const stats = storedStats(stored[statsKey], list.length);
    const pageContext = storedPageContext(stored[contextKey]);
    let addedCount = 0;
    let updatedCount = 0;
    let droppedInBatchCount = 0;
    let evictedInBatchCount = 0;
    let ignoredStalePageCount = 0;
    for (const candidate of normalized) {
      if (pageContext && candidate.pageUrl !== pageContext) {
        ignoredStalePageCount += 1;
        continue;
      }
      const retained = retainOne(tabId, list, stats, candidate);
      if (retained.action === "updated") updatedCount += 1;
      else if (retained.action === "dropped") droppedInBatchCount += 1;
      else {
        addedCount += 1;
        if (retained.action === "added_after_eviction") evictedInBatchCount += 1;
      }
    }
    stats.retainedCount = list.length;
    await chrome.storage.session.set({ [key]: list, [statsKey]: stats });
    return {
      ...publicStats(stats),
      addedCount,
      updatedCount,
      droppedInBatchCount,
      evictedInBatchCount,
      ignoredStalePageCount,
    };
  });
}

/** Keeps the tab shelf scoped to one exact SPA/document URL. */
export async function retainDetectedVideosForPage(
  tabId: number,
  pageUrl: string,
): Promise<DetectionRetentionStats> {
  let canonicalPageUrl: string;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
    canonicalPageUrl = parsed.href;
  } catch {
    throw new TypeError("pageUrl must be an absolute HTTP(S) URL.");
  }
  const key = tabKey(tabId);
  const statsKey = tabStatsKey(tabId);
  const contextKey = tabPageContextKey(tabId);
  return withKeyLock(key, async () => {
    const stored = await chrome.storage.session.get(key);
    const retained = storedVideos(stored[key]).filter(
      (media) => media.pageUrl === canonicalPageUrl,
    );
    const stats = storedStats(undefined, retained.length);
    await chrome.storage.session.set({
      [key]: retained,
      [statsKey]: stats,
      [contextKey]: canonicalPageUrl,
    });
    return publicStats(stats);
  });
}

export async function clearTab(tabId: number): Promise<void> {
  const key = tabKey(tabId);
  await withKeyLock(key, async () => {
    await chrome.storage.session.remove([key, tabStatsKey(tabId), tabPageContextKey(tabId)]);
  });
}
