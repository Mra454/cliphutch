import { MAX_VIDEOS_PER_TAB } from "./constants";
import { withKeyLock } from "./session-jobs";
import type { DetectedVideo } from "../types";

const tabKey = (tabId: number) => `tab:${tabId}`;

export async function getDetectedVideos(tabId: number): Promise<DetectedVideo[]> {
  const key = tabKey(tabId);
  const result = await chrome.storage.session.get(key);
  const value = result[key];
  return Array.isArray(value) ? (value as DetectedVideo[]) : [];
}

export async function addOrUpdateVideo(tabId: number, video: DetectedVideo): Promise<void> {
  const key = tabKey(tabId);
  // A page can fire several media/image responses at once; each add does a
  // read-modify-write on the same tab list, so serialize them or concurrent
  // adds clobber each other and detections vanish from the shelf.
  await withKeyLock(key, async () => {
    const list = await getDetectedVideos(tabId);
    const existing = list.find((v) => v.url === video.url);

    if (existing) {
      if (video.sizeBytes !== undefined) existing.sizeBytes = video.sizeBytes;
      if (video.contentType !== undefined) existing.contentType = video.contentType;
      if (video.contentDisposition !== undefined) existing.contentDisposition = video.contentDisposition;
      if (video.pageUrl !== undefined) existing.pageUrl = video.pageUrl;
      if (video.pageTitle !== undefined) existing.pageTitle = video.pageTitle;
    } else {
      if (list.length >= MAX_VIDEOS_PER_TAB) {
        const imageIndex = list.findIndex((v) => v.kind === "image");
        if (video.kind === "image" || imageIndex === -1) return;
        list.splice(imageIndex, 1);
      }
      list.push(video);
    }

    await chrome.storage.session.set({ [key]: list });
  });
}

export async function clearTab(tabId: number): Promise<void> {
  const key = tabKey(tabId);
  await withKeyLock(key, async () => {
    await chrome.storage.session.remove(key);
  });
}
