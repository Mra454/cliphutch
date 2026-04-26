import { classifyUrl } from "./lib/detector";
import { addOrUpdateVideo, clearTab, getDetectedVideos } from "./lib/storage-session";
import { VIDEO_REQUEST_TYPES } from "./lib/constants";
import type { DetectedVideo, VideoKind } from "./types";

type TabInfo = { pageUrl?: string; pageTitle?: string };

type Pending = {
  url: string;
  kind: VideoKind;
  tabId: number;
  tabInfo: Promise<TabInfo>;
};

const pendingByRequestId = new Map<string, Pending>();

function makeId(url: string, tabId: number): string {
  const input = `${tabId}:${url}`;
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function headerValue(
  headers: chrome.webRequest.HttpHeader[] | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return undefined;
}

async function resolveTabInfo(tabId: number): Promise<TabInfo> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { pageUrl: tab.url, pageTitle: tab.title };
  } catch {
    return {};
  }
}

async function updateBadge(tabId: number): Promise<void> {
  const videos = await getDetectedVideos(tabId);
  const text = videos.length > 0 ? String(videos.length) : "";
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#4A90E2" });
    }
  } catch {
    // tab may have closed
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[video-archive] background installed:", details.reason);
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("firstrun.html") });
  }
});

console.log("[video-archive] service worker booted");

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const cls = classifyUrl(details.url);
    if (cls.kind === "unknown" || cls.kind === "segment") return;

    pendingByRequestId.set(details.requestId, {
      url: details.url,
      kind: cls.kind,
      tabId: details.tabId,
      tabInfo: resolveTabInfo(details.tabId),
    });
  },
  { urls: ["<all_urls>"], types: VIDEO_REQUEST_TYPES },
);

async function handleHeadersReceived(
  details: chrome.webRequest.WebResponseHeadersDetails,
): Promise<void> {
  const pending = pendingByRequestId.get(details.requestId);
  if (!pending) return;
  pendingByRequestId.delete(details.requestId);

  const headers = details.responseHeaders;
  const contentType = headerValue(headers, "content-type");
  const contentDisposition = headerValue(headers, "content-disposition");
  const contentLengthRaw = headerValue(headers, "content-length");
  const sizeBytes = contentLengthRaw ? Number.parseInt(contentLengthRaw, 10) : undefined;

  const recl = classifyUrl(pending.url, contentType);
  if (recl.kind === "unknown" || recl.kind === "segment") return;
  const kind: VideoKind = recl.kind;

  const { pageUrl, pageTitle } = await pending.tabInfo;

  const video: DetectedVideo = {
    id: makeId(pending.url, pending.tabId),
    url: pending.url,
    kind,
    detectedAt: Date.now(),
    pageUrl,
    pageTitle,
    sizeBytes: sizeBytes !== undefined && Number.isFinite(sizeBytes) ? sizeBytes : undefined,
    contentType: contentType ? contentType.split(";")[0].trim() : undefined,
    contentDisposition,
  };

  await addOrUpdateVideo(pending.tabId, video);
  await updateBadge(pending.tabId);
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    void handleHeadersReceived(details);
  },
  { urls: ["<all_urls>"], types: VIDEO_REQUEST_TYPES },
  ["responseHeaders"],
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    pendingByRequestId.delete(details.requestId);
  },
  { urls: ["<all_urls>"], types: VIDEO_REQUEST_TYPES },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    pendingByRequestId.delete(details.requestId);
  },
  { urls: ["<all_urls>"], types: VIDEO_REQUEST_TYPES },
);

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "session") return;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeTabId = tabs[0]?.id;
  if (activeTabId === undefined) return;
  if (changes[`tab:${activeTabId}`]) await updateBadge(activeTabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void updateBadge(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    void clearTab(tabId).then(() => updateBadge(tabId));
  }
});
