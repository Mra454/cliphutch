import { classifyUrl } from "./lib/detector";
import { addOrUpdateVideo, clearTab, getDetectedVideos } from "./lib/storage-session";
import { VIDEO_REQUEST_TYPES } from "./lib/constants";
import { inferFilename } from "./lib/filename";
import { getSettings } from "./lib/storage-local";
import { isLicensed } from "./lib/license";
import { FREE_DOWNLOAD_LIMIT, isRateLimited, recordDownload } from "./lib/rate-limit";
import {
  buildSessionRule,
  extractCapturedHeaders,
  hasReplayableHeaders,
  type CapturedHeaders,
} from "./lib/header-capture";
import type { DetectedVideo, VideoKind } from "./types";

type TabInfo = { pageUrl?: string; pageTitle?: string };

type Pending = {
  url: string;
  kind: VideoKind;
  tabId: number;
  tabInfo: Promise<TabInfo>;
  capturedHeaders?: CapturedHeaders;
};

const pendingByRequestId = new Map<string, Pending>();

// Captured headers from the page's original request, keyed by videoId.
// Used at download time to install a session DNR rule that replays them on
// extension-initiated fetches. In-memory only; lost on service-worker
// eviction (graceful degradation: download proceeds without replay).
const headersByVideoId = new Map<string, CapturedHeaders>();
const headersVideoIdsByTabId = new Map<number, Set<string>>();

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
  console.log("[cliphutch] background installed:", details.reason);
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("firstrun.html") });
  }
});

console.log("[cliphutch] service worker booted");

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

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const pending = pendingByRequestId.get(details.requestId);
    if (!pending) return;
    pending.capturedHeaders = extractCapturedHeaders(details.requestHeaders);
  },
  { urls: ["<all_urls>"], types: VIDEO_REQUEST_TYPES },
  ["requestHeaders", "extraHeaders"],
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

  if (pending.capturedHeaders && hasReplayableHeaders(pending.capturedHeaders)) {
    headersByVideoId.set(video.id, pending.capturedHeaders);
    let ids = headersVideoIdsByTabId.get(pending.tabId);
    if (!ids) {
      ids = new Set();
      headersVideoIdsByTabId.set(pending.tabId, ids);
    }
    ids.add(video.id);
  }

  await addOrUpdateVideo(pending.tabId, video);
  await updateBadge(pending.tabId);
}

function clearCapturedHeadersForTab(tabId: number): void {
  const ids = headersVideoIdsByTabId.get(tabId);
  if (!ids) return;
  for (const id of ids) headersByVideoId.delete(id);
  headersVideoIdsByTabId.delete(tabId);
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
  clearCapturedHeadersForTab(tabId);
  void clearTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    clearCapturedHeadersForTab(tabId);
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

let nextRuleId = 1;
const ruleIdsByJobKey = new Map<string, number>();

async function installHeaderReplayRule(
  jobKey: string,
  videoId: string,
  url: string,
  kind: "hls" | "dash" | "direct",
): Promise<void> {
  const captured = headersByVideoId.get(videoId);
  if (!captured || !hasReplayableHeaders(captured)) return;

  const ruleId = nextRuleId++;
  const rule = buildSessionRule({
    ruleId,
    url,
    kind,
    captured,
    extensionId: chrome.runtime.id,
  });
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
    ruleIdsByJobKey.set(jobKey, ruleId);
  } catch {
    // If rule install fails, the download still proceeds without replay.
  }
}

async function removeHeaderReplayRule(jobKey: string): Promise<void> {
  const ruleId = ruleIdsByJobKey.get(jobKey);
  if (ruleId === undefined) return;
  ruleIdsByJobKey.delete(jobKey);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  } catch {
    // Rule may already be gone if the session was cleared.
  }
}

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
  | { ok: true; downloadId?: number; jobId?: string }
  | { ok: false; error: string; code?: string };

async function handleDownloadRequest(req: DownloadRequest): Promise<DownloadResponse> {
  const video = await findVideo(req.tabId, req.videoId);
  if (!video) return { ok: false, error: "Video not found in this tab." };


  if (!(await isLicensed()) && (await isRateLimited())) {
    return {
      ok: false,
      code: "RATE_LIMITED",
      error: `You've used all ${FREE_DOWNLOAD_LIMIT} free downloads in the last 24 hours. Upgrade for unlimited downloads.`,
    };
  }

  if (video.kind === "hls") {
    const result = await startHlsDownload(req, video);
    if (result.ok) await recordDownload();
    return result;
  }

  if (video.kind === "dash") {
    const result = await startDashDownload(req, video);
    if (result.ok) await recordDownload();
    return result;
  }

  const directJobKey = `direct:${video.id}`;
  await installHeaderReplayRule(directJobKey, video.id, video.url, "direct");
  try {
    const downloadId = await chrome.downloads.download({
      url: video.url,
      filename: inferFilename(video),
      conflictAction: "uniquify",
      saveAs: false,
    });
    if (downloadId === undefined) {
      await removeHeaderReplayRule(directJobKey);
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
    await recordDownload();
    return { ok: true, downloadId };
  } catch (err) {
    await removeHeaderReplayRule(directJobKey);
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
  if (job) {
    if (delta.state.current === "complete") {
      job.status = "complete";
      delete job.errorMessage;
      await setDownloadJob(job);
      await removeHeaderReplayRule(`direct:${job.videoId}`);
    } else if (delta.state.current === "interrupted") {
      job.status = "interrupted";
      job.errorMessage = DIRECT_DOWNLOAD_FAILURE_MESSAGE;
      await setDownloadJob(job);
      await removeHeaderReplayRule(`direct:${job.videoId}`);
    }
    return;
  }

  const hlsJobs = await getHlsJobs();
  const hls = Object.values(hlsJobs).find((j) => j.downloadId === delta.id);
  if (hls) {
    if (delta.state.current === "complete") {
      hls.status = "complete";
      await setHlsJob(hls);
      await removeHeaderReplayRule(`hls:${hls.jobId}`);
      void chrome.runtime.sendMessage({ type: "hls-download-revoke", jobId: hls.jobId }).catch(() => {});
    } else if (delta.state.current === "interrupted") {
      hls.status = "error";
      hls.errorMessage = DIRECT_DOWNLOAD_FAILURE_MESSAGE;
      hls.errorCode = "SAVE_INTERRUPTED";
      await setHlsJob(hls);
      await removeHeaderReplayRule(`hls:${hls.jobId}`);
      void chrome.runtime.sendMessage({ type: "hls-download-revoke", jobId: hls.jobId }).catch(() => {});
    }
    return;
  }

  const dashJobs = await getDashJobs();
  const dash = Object.values(dashJobs).find(
    (j) => j.videoDownloadId === delta.id || j.audioDownloadId === delta.id,
  );
  if (!dash) return;

  const isVideo = dash.videoDownloadId === delta.id;
  const newStatus: DashSaveStatus =
    delta.state.current === "complete" ? "complete" : "interrupted";
  if (isVideo) dash.videoSaveStatus = newStatus;
  else dash.audioSaveStatus = newStatus;

  const videoTerminal = dash.videoSaveStatus === "complete" || dash.videoSaveStatus === "interrupted";
  const audioTerminal =
    dash.audioDownloadId === undefined ||
    dash.audioSaveStatus === "complete" ||
    dash.audioSaveStatus === "interrupted";

  if (videoTerminal && audioTerminal) {
    const anyInterrupted =
      dash.videoSaveStatus === "interrupted" || dash.audioSaveStatus === "interrupted";
    if (anyInterrupted) {
      dash.status = "error";
      dash.errorMessage = DIRECT_DOWNLOAD_FAILURE_MESSAGE;
      dash.errorCode = "SAVE_INTERRUPTED";
    } else {
      dash.status = "complete";
    }
    await setDashJob(dash);
    await removeHeaderReplayRule(`dash:${dash.jobId}`);
    void chrome.runtime.sendMessage({ type: "dash-download-revoke", jobId: dash.jobId }).catch(() => {});
  } else {
    await setDashJob(dash);
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  void handleDownloadChange(delta);
});

type HlsJobStatus = "running" | "saving" | "complete" | "error" | "cancelled";

type HlsJob = {
  jobId: string;
  videoId: string;
  tabId: number;
  url: string;
  kind: "hls";
  startedAt: number;
  status: HlsJobStatus;
  progress: { done: number; total: number; bytes: number };
  downloadId?: number;
  errorCode?: string;
  errorMessage?: string;
};

const HLS_JOBS_KEY = "hls-download-jobs";

async function getHlsJobs(): Promise<Record<string, HlsJob>> {
  const result = await chrome.storage.session.get(HLS_JOBS_KEY);
  const jobs = result[HLS_JOBS_KEY];
  return jobs && typeof jobs === "object" ? (jobs as Record<string, HlsJob>) : {};
}

async function setHlsJob(job: HlsJob): Promise<void> {
  const jobs = await getHlsJobs();
  jobs[job.jobId] = job;
  await chrome.storage.session.set({ [HLS_JOBS_KEY]: jobs });
}

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = (await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  })) as chrome.runtime.ExtensionContext[] | undefined;
  if (contexts && contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: "Assemble HLS segments into a downloadable blob",
  });
}

async function startHlsDownload(
  req: DownloadRequest,
  video: DetectedVideo,
): Promise<DownloadResponse> {
  const settings = await getSettings();
  const jobId = `hls-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  await setHlsJob({
    jobId,
    videoId: video.id,
    tabId: req.tabId,
    url: video.url,
    kind: "hls",
    startedAt: Date.now(),
    status: "running",
    progress: { done: 0, total: 0, bytes: 0 },
  });

  try {
    await ensureOffscreenDocument();
  } catch (err) {
    const job = (await getHlsJobs())[jobId];
    if (job) {
      job.status = "error";
      job.errorCode = "OFFSCREEN_INIT";
      job.errorMessage = err instanceof Error ? err.message : "Could not start offscreen document.";
      await setHlsJob(job);
    }
    return { ok: false, error: job?.errorMessage ?? "Could not start offscreen document." };
  }

  await installHeaderReplayRule(`hls:${jobId}`, video.id, video.url, "hls");

  void chrome.runtime
    .sendMessage({
      type: "hls-download-start",
      jobId,
      url: video.url,
      sizeCapBytes: settings.hlsSizeCapBytes,
    })
    .catch(() => {});

  return { ok: true, jobId };
}

async function handleHlsProgress(msg: {
  jobId: string;
  done: number;
  total: number;
  bytes: number;
}): Promise<void> {
  const jobs = await getHlsJobs();
  const job = jobs[msg.jobId];
  if (!job) return;
  job.progress = { done: msg.done, total: msg.total, bytes: msg.bytes };
  await setHlsJob(job);
}

async function handleHlsBlobReady(msg: {
  jobId: string;
  blobUrl: string;
  sizeBytes: number;
}): Promise<void> {
  const jobs = await getHlsJobs();
  const job = jobs[msg.jobId];
  if (!job) return;

  const video = await findVideo(job.tabId, job.videoId);
  if (!video) {
    job.status = "error";
    job.errorMessage = "Video missing when saving HLS download.";
    job.errorCode = "VIDEO_MISSING";
    await setHlsJob(job);
    await removeHeaderReplayRule(`hls:${msg.jobId}`);
    void chrome.runtime.sendMessage({ type: "hls-download-revoke", jobId: msg.jobId }).catch(() => {});
    return;
  }

  try {
    const downloadId = await chrome.downloads.download({
      url: msg.blobUrl,
      filename: inferFilename(video, { forcedExtension: ".ts" }),
      conflictAction: "uniquify",
      saveAs: false,
    });
    job.downloadId = downloadId;
    job.status = "saving";
    await setHlsJob(job);
  } catch (err) {
    job.status = "error";
    job.errorMessage = err instanceof Error ? err.message : "Could not save HLS file.";
    job.errorCode = "SAVE_FAILED";
    await setHlsJob(job);
    await removeHeaderReplayRule(`hls:${msg.jobId}`);
    void chrome.runtime.sendMessage({ type: "hls-download-revoke", jobId: msg.jobId }).catch(() => {});
  }
}

async function handleHlsError(msg: {
  jobId: string;
  code: string;
  userMessage: string;
}): Promise<void> {
  const jobs = await getHlsJobs();
  const job = jobs[msg.jobId];
  if (!job) return;
  job.status = msg.code === "CANCELLED" ? "cancelled" : "error";
  job.errorCode = msg.code;
  job.errorMessage = msg.userMessage;
  await setHlsJob(job);
  await removeHeaderReplayRule(`hls:${msg.jobId}`);
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== "object") return false;
  const m = message as { type?: string };
  if (m.type === "hls-download-progress") {
    void handleHlsProgress(message as Parameters<typeof handleHlsProgress>[0]);
  } else if (m.type === "hls-download-blob-ready") {
    void handleHlsBlobReady(message as Parameters<typeof handleHlsBlobReady>[0]);
  } else if (m.type === "hls-download-error") {
    void handleHlsError(message as Parameters<typeof handleHlsError>[0]);
  } else if (m.type === "dash-download-progress") {
    void handleDashProgress(message as Parameters<typeof handleDashProgress>[0]);
  } else if (m.type === "dash-download-blobs-ready") {
    void handleDashBlobsReady(message as Parameters<typeof handleDashBlobsReady>[0]);
  } else if (m.type === "dash-download-error") {
    void handleDashError(message as Parameters<typeof handleDashError>[0]);
  }
  return false;
});

type DashJobStatus = "running" | "saving" | "complete" | "error" | "cancelled";

type DashSaveStatus = "pending" | "complete" | "interrupted";

type DashJob = {
  jobId: string;
  videoId: string;
  tabId: number;
  url: string;
  kind: "dash";
  startedAt: number;
  status: DashJobStatus;
  progress: { videoDone: number; videoTotal: number; audioDone: number; audioTotal: number; bytes: number };
  videoDownloadId?: number;
  audioDownloadId?: number;
  videoSaveStatus?: DashSaveStatus;
  audioSaveStatus?: DashSaveStatus;
  errorCode?: string;
  errorMessage?: string;
};

const DASH_JOBS_KEY = "dash-download-jobs";

async function getDashJobs(): Promise<Record<string, DashJob>> {
  const result = await chrome.storage.session.get(DASH_JOBS_KEY);
  const jobs = result[DASH_JOBS_KEY];
  return jobs && typeof jobs === "object" ? (jobs as Record<string, DashJob>) : {};
}

async function setDashJob(job: DashJob): Promise<void> {
  const jobs = await getDashJobs();
  jobs[job.jobId] = job;
  await chrome.storage.session.set({ [DASH_JOBS_KEY]: jobs });
}

async function startDashDownload(
  req: DownloadRequest,
  video: DetectedVideo,
): Promise<DownloadResponse> {
  const settings = await getSettings();
  const jobId = `dash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  await setDashJob({
    jobId,
    videoId: video.id,
    tabId: req.tabId,
    url: video.url,
    kind: "dash",
    startedAt: Date.now(),
    status: "running",
    progress: { videoDone: 0, videoTotal: 0, audioDone: 0, audioTotal: 0, bytes: 0 },
  });

  try {
    await ensureOffscreenDocument();
  } catch (err) {
    const job = (await getDashJobs())[jobId];
    if (job) {
      job.status = "error";
      job.errorCode = "OFFSCREEN_INIT";
      job.errorMessage = err instanceof Error ? err.message : "Could not start offscreen document.";
      await setDashJob(job);
    }
    return { ok: false, error: job?.errorMessage ?? "Could not start offscreen document." };
  }

  await installHeaderReplayRule(`dash:${jobId}`, video.id, video.url, "dash");

  void chrome.runtime
    .sendMessage({
      type: "dash-download-start",
      jobId,
      url: video.url,
      sizeCapBytes: settings.hlsSizeCapBytes,
    })
    .catch(() => {});

  return { ok: true, jobId };
}

async function handleDashProgress(msg: {
  jobId: string;
  videoDone: number;
  videoTotal: number;
  audioDone: number;
  audioTotal: number;
  bytes: number;
}): Promise<void> {
  const jobs = await getDashJobs();
  const job = jobs[msg.jobId];
  if (!job) return;
  job.progress = {
    videoDone: msg.videoDone,
    videoTotal: msg.videoTotal,
    audioDone: msg.audioDone,
    audioTotal: msg.audioTotal,
    bytes: msg.bytes,
  };
  await setDashJob(job);
}

async function handleDashBlobsReady(msg: {
  jobId: string;
  videoBlobUrl: string;
  audioBlobUrl?: string;
  videoSizeBytes: number;
  audioSizeBytes?: number;
  videoMimeType: string;
  audioMimeType?: string;
}): Promise<void> {
  const jobs = await getDashJobs();
  const job = jobs[msg.jobId];
  if (!job) return;

  const video = await findVideo(job.tabId, job.videoId);
  if (!video) {
    job.status = "error";
    job.errorMessage = "Video missing when saving DASH download.";
    job.errorCode = "VIDEO_MISSING";
    await setDashJob(job);
    await removeHeaderReplayRule(`dash:${msg.jobId}`);
    void chrome.runtime.sendMessage({ type: "dash-download-revoke", jobId: msg.jobId }).catch(() => {});
    return;
  }

  try {
    const videoFilename = inferFilename(video, { forcedExtension: ".video.mp4" });
    const videoDownloadId = await chrome.downloads.download({
      url: msg.videoBlobUrl,
      filename: videoFilename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    job.videoDownloadId = videoDownloadId;
    job.videoSaveStatus = "pending";

    if (msg.audioBlobUrl) {
      const audioFilename = inferFilename(video, { forcedExtension: ".audio.m4a" });
      const audioDownloadId = await chrome.downloads.download({
        url: msg.audioBlobUrl,
        filename: audioFilename,
        conflictAction: "uniquify",
        saveAs: false,
      });
      job.audioDownloadId = audioDownloadId;
      job.audioSaveStatus = "pending";
    }

    job.status = "saving";
    await setDashJob(job);
  } catch (err) {
    job.status = "error";
    job.errorMessage = err instanceof Error ? err.message : "Could not save DASH files.";
    job.errorCode = "SAVE_FAILED";
    await setDashJob(job);
    await removeHeaderReplayRule(`dash:${msg.jobId}`);
    void chrome.runtime.sendMessage({ type: "dash-download-revoke", jobId: msg.jobId }).catch(() => {});
  }
}

async function handleDashError(msg: {
  jobId: string;
  code: string;
  userMessage: string;
}): Promise<void> {
  const jobs = await getDashJobs();
  const job = jobs[msg.jobId];
  if (!job) return;
  job.status = msg.code === "CANCELLED" ? "cancelled" : "error";
  job.errorCode = msg.code;
  job.errorMessage = msg.userMessage;
  await setDashJob(job);
  await removeHeaderReplayRule(`dash:${msg.jobId}`);
}
