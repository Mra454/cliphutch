import { MAX_VIDEOS_PER_TAB } from "./constants";
import type { DetectedVideo } from "../types";

const tabKey = (tabId: number) => `tab:${tabId}`;

export async function getDetectedVideos(tabId: number): Promise<DetectedVideo[]> {
  const key = tabKey(tabId);
  const result = await chrome.storage.session.get(key);
  const value = result[key];
  return Array.isArray(value) ? (value as DetectedVideo[]) : [];
}

export async function addOrUpdateVideo(tabId: number, video: DetectedVideo): Promise<void> {
  const list = await getDetectedVideos(tabId);
  const existing = list.find((v) => v.url === video.url);

  if (existing) {
    if (video.sizeBytes !== undefined) existing.sizeBytes = video.sizeBytes;
    if (video.contentType !== undefined) existing.contentType = video.contentType;
    if (video.contentDisposition !== undefined) existing.contentDisposition = video.contentDisposition;
    if (video.pageUrl !== undefined) existing.pageUrl = video.pageUrl;
    if (video.pageTitle !== undefined) existing.pageTitle = video.pageTitle;
  } else {
    if (list.length >= MAX_VIDEOS_PER_TAB) return;
    list.push(video);
  }

  await chrome.storage.session.set({ [tabKey(tabId)]: list });
}

export async function clearTab(tabId: number): Promise<void> {
  await chrome.storage.session.remove(tabKey(tabId));
}
