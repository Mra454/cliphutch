import { classifyUrl } from "./lib/detector";
import { addOrUpdateVideo, clearTab, getDetectedVideos } from "./lib/storage-session";
import { VIDEO_REQUEST_TYPES } from "./lib/constants";
import { inferFilename } from "./lib/filename";
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

type DownloadStatus = "in_progress" | "complete" | "interrupted";

type DownloadJob = {
  videoId: string;
  tabId: number;
  downloadId: number;
  kind: VideoKind;
  startedAt: number;
  status: DownloadStatus;
  errorMessage?: string;
};

const DOWNLOAD_JOBS_KEY = "download-jobs";

const DIRECT_DOWNLOAD_FAILURE_MESSAGE =
  "The file URL was detected, but Chrome could not download it. The link may have expired, or the server requires headers, cookies, or a referrer that this extension does not store.";

async function getDownloadJobs(): Promise<Record<string, DownloadJob>> {
  const result = await chrome.storage.session.get(DOWNLOAD_JOBS_KEY);
  const jobs = result[DOWNLOAD_JOBS_KEY];
  return jobs && typeof jobs === "object" ? (jobs as Record<string, DownloadJob>) : {};
}

async function setDownloadJob(job: DownloadJob): Promise<void> {
  const jobs = await getDownloadJobs();
  jobs[String(job.downloadId)] = job;
  await chrome.storage.session.set({ [DOWNLOAD_JOBS_KEY]: jobs });
}

async function findVideo(tabId: number, videoId: string): Promise<DetectedVideo | undefined> {
  const list = await getDetectedVideos(tabId);
  return list.find((v) => v.id === videoId);
}

type DownloadRequest = { type: "download"; tabId: number; videoId: string };
type DownloadResponse =
  | { ok: true; downloadId: number }
  | { ok: false; error: string };

async function handleDownloadRequest(req: DownloadRequest): Promise<DownloadResponse> {
  const video = await findVideo(req.tabId, req.videoId);
  if (!video) return { ok: false, error: "Video not found in this tab." };

  if (video.kind === "hls" || video.kind === "dash") {
    return { ok: false, error: `${video.kind.toUpperCase()} download is not implemented in v0.1.` };
  }

  try {
    const downloadId = await chrome.downloads.download({
      url: video.url,
      filename: inferFilename(video),
      conflictAction: "uniquify",
      saveAs: false,
    });
    if (downloadId === undefined) {
      return { ok: false, error: DIRECT_DOWNLOAD_FAILURE_MESSAGE };
    }
    await setDownloadJob({
      videoId: video.id,
      tabId: req.tabId,
      downloadId,
      kind: video.kind,
      startedAt: Date.now(),
      status: "in_progress",
    });
    return { ok: true, downloadId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && err.message ? err.message : DIRECT_DOWNLOAD_FAILURE_MESSAGE,
    };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object" || message.type !== "download") return false;
  void handleDownloadRequest(message as DownloadRequest).then(sendResponse);
  return true;
});

async function handleDownloadChange(delta: chrome.downloads.DownloadDelta): Promise<void> {
  if (!delta.state) return;
  const jobs = await getDownloadJobs();
  const job = jobs[String(delta.id)];
  if (!job) return;

  if (delta.state.current === "complete") {
    job.status = "complete";
    delete job.errorMessage;
    await setDownloadJob(job);
  } else if (delta.state.current === "interrupted") {
    job.status = "interrupted";
    job.errorMessage = DIRECT_DOWNLOAD_FAILURE_MESSAGE;
    await setDownloadJob(job);
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  void handleDownloadChange(delta);
});
