import { classifyUrl } from "./lib/detector";
import { addOrUpdateVideo, clearTab, getDetectedVideos } from "./lib/storage-session";
import {
  MIN_STILL_IMAGE_SIZE_BYTES,
  VIDEO_REQUEST_TYPES,
  WEBM_TRANSCODE_SIZE_CAP_BYTES,
} from "./lib/constants";
import { inferFilename } from "./lib/filename";
import { putJobRecord, updateJobRecord } from "./lib/session-jobs";
import { getSettings, type UserSettings } from "./lib/storage-local";
import { isLicensed } from "./lib/license";
import {
  FREE_DOWNLOAD_LIMIT,
  recordDownload,
  releaseDownloadReservation,
  reserveDownload,
} from "./lib/rate-limit";
import {
  buildSessionRule,
  extractCapturedHeaders,
  hasReplayableHeaders,
  type CapturedHeaders,
} from "./lib/header-capture";
import {
  clearCapturedHeadersForTab,
  getCapturedHeaders,
  saveCapturedHeaders,
} from "./lib/captured-headers";
import { filterCoveredByManifests } from "./lib/manifest-coverage";
import { isStillImage, isWebmDirectVideo } from "./lib/media-format";
import type {
  DetectedVideo,
  DashJob,
  HlsJob,
  WebmTranscodeJob,
  MediaKind,
} from "./types";

type TabInfo = { pageUrl?: string; pageTitle?: string };

type Pending = {
  url: string;
  tabId: number;
  tabInfo: Promise<TabInfo>;
  capturedHeaders?: CapturedHeaders;
};

type DomImageCandidate = {
  url: string;
  source?: "rendered-image" | "markup";
  width?: number;
  height?: number;
};

type DomImagesDetectedMessage = {
  type: "dom-images-detected";
  pageUrl?: string;
  pageTitle?: string;
  images?: DomImageCandidate[];
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

function hostname(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function hostMatchesFilter(host: string | undefined, filter: string): boolean {
  if (!host) return false;
  const normalized = host.toLowerCase().replace(/^www\./, "");
  const normalizedFilter = filter.toLowerCase().replace(/^www\./, "");
  return normalized === normalizedFilter || normalized.endsWith(`.${normalizedFilter}`);
}

function hostCoveredByFilters(host: string, filters: string[]): boolean {
  return filters.some((filter) => hostMatchesFilter(host, filter));
}

function isIgnoredBySettings(v: DetectedVideo, settings: UserSettings): boolean {
  const source = hostname(v.url);
  const page = hostname(v.pageUrl);
  return Boolean(
    (source && hostCoveredByFilters(source, settings.ignoredSourceHosts)) ||
      (page && hostCoveredByFilters(page, settings.ignoredPageHosts)),
  );
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
  const [videos, settings] = await Promise.all([getDetectedVideos(tabId), getSettings()]);
  // Match the popup's filtering — segments hidden when their parent
  // manifest is also detected — so the badge count matches what the
  // user actually sees in the popup. Without this, a 25-segment DASH
  // page reads "25" on the toolbar but "1 detected" in the popup.
  const visible = filterCoveredByManifests(videos).filter((v) => !isIgnoredBySettings(v, settings));
  const text = visible.length > 0 ? String(visible.length) : "";
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#4A90E2" });
    }
  } catch {
    // tab may have closed
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  void chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id !== undefined) void updateBadge(tab.id);
    }
  }).catch(() => undefined);
});

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

    pendingByRequestId.set(details.requestId, {
      url: details.url,
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

// 3xx statuses that carry a Location and are followed on the same requestId.
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

async function handleHeadersReceived(
  details: chrome.webRequest.WebResponseHeadersDetails,
): Promise<void> {
  const pending = pendingByRequestId.get(details.requestId);
  if (!pending) return;

  // A redirect hop is not the media response. Keep the pending entry so the
  // final hop (same requestId, resolved URL) is the one classified; deleting
  // here would drop CDN-signed media that 302s to an extensionless URL.
  if (typeof details.statusCode === "number" && REDIRECT_STATUS.has(details.statusCode)) {
    return;
  }
  pendingByRequestId.delete(details.requestId);

  // details.url is the resolved URL after any redirects; pending.url is the
  // originally requested one. Classify and store the resolved URL so the file
  // saved (and any header-replay rule) targets what actually served the media.
  const mediaUrl = details.url;

  const headers = details.responseHeaders;
  const contentType = headerValue(headers, "content-type");
  const contentDisposition = headerValue(headers, "content-disposition");
  const contentLengthRaw = headerValue(headers, "content-length");
  const sizeBytes = contentLengthRaw ? Number.parseInt(contentLengthRaw, 10) : undefined;

  const recl = classifyUrl(mediaUrl, contentType);
  if (recl.kind === "unknown" || recl.kind === "segment") return;
  const kind: MediaKind = recl.kind;
  const normalizedSize = sizeBytes !== undefined && Number.isFinite(sizeBytes) ? sizeBytes : undefined;
  if (kind === "image" && normalizedSize !== undefined && normalizedSize < MIN_STILL_IMAGE_SIZE_BYTES) return;

  const { pageUrl, pageTitle } = await pending.tabInfo;

  const video: DetectedVideo = {
    id: makeId(mediaUrl, pending.tabId),
    url: mediaUrl,
    kind,
    detectedAt: Date.now(),
    pageUrl,
    pageTitle,
    sizeBytes: normalizedSize,
    contentType: contentType ? contentType.split(";")[0].trim() : undefined,
    contentDisposition,
  };

  if (pending.capturedHeaders && hasReplayableHeaders(pending.capturedHeaders)) {
    await saveCapturedHeaders(video.id, pending.tabId, pending.capturedHeaders);
  }

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
  void clearCapturedHeadersForTab(tabId);
  void clearTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    void clearCapturedHeadersForTab(tabId);
    void clearTab(tabId).then(() => updateBadge(tabId));
  }
});

type DownloadStatus = "in_progress" | "complete" | "interrupted";

type DownloadJob = {
  videoId: string;
  tabId: number;
  downloadId: number;
  kind: MediaKind;
  startedAt: number;
  status: DownloadStatus;
  // Whether this download counts against the free-tier quota (videos do,
  // stills do not) and whether it has already been counted or reserved.
  countsAgainstQuota?: boolean;
  quotaRecorded?: boolean;
  quotaReservationId?: string;
  errorMessage?: string;
};

// DNR session rules persist for the whole browser session, but the previous
// in-memory nextRuleId counter and jobKey->ruleId map did not survive a
// service-worker restart: after eviction removeHeaderReplayRule no-op'd
// (leaking rules) and a reset counter collided with existing rule IDs. Derive
// the rule ID deterministically from the jobKey so both install and remove
// agree across restarts, and remove-then-add so a stale rule with the same ID
// is replaced rather than rejected.
function ruleIdForJobKey(jobKey: string): number {
  let h = 2166136261;
  for (let i = 0; i < jobKey.length; i++) {
    h ^= jobKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // DNR rule IDs must be positive integers; keep well within the safe range.
  return (h >>> 0) % 1_000_000_000 + 1;
}

async function installHeaderReplayRule(
  jobKey: string,
  videoId: string,
  url: string,
  kind: "hls" | "dash" | "direct",
): Promise<void> {
  const captured = await getCapturedHeaders(videoId);
  if (!captured || !hasReplayableHeaders(captured)) return;

  const ruleId = ruleIdForJobKey(jobKey);
  const rule = buildSessionRule({
    ruleId,
    url,
    kind,
    captured,
    extensionId: chrome.runtime.id,
  });
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [rule],
    });
  } catch {
    // If rule install fails, the download still proceeds without replay.
  }
}

async function removeHeaderReplayRule(jobKey: string): Promise<void> {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleIdForJobKey(jobKey)],
    });
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
  await putJobRecord(DOWNLOAD_JOBS_KEY, String(job.downloadId), job);
}

async function findVideo(tabId: number, videoId: string): Promise<DetectedVideo | undefined> {
  const list = await getDetectedVideos(tabId);
  return list.find((v) => v.id === videoId);
}

type DownloadRequest = {
  type: "download";
  tabId: number;
  videoId: string;
  variantId?: string;
  // HLS only: resolved URL of the audio rendition matched to the picked
  // variant. When set, downloadHls fetches it in parallel with the video and
  // muxes both into a single MP4.
  audioRenditionUrl?: string;
  // Resolution/quality label for the picked variant (e.g. "1080p"), threaded
  // through to the saved filename.
  variantLabel?: string;
  bypassSizeCap?: boolean;
};
type DownloadResponse =
  | { ok: true; downloadId?: number; jobId?: string }
  | { ok: false; error: string; code?: string };

type ListVariantsRequest = {
  type: "list-variants";
  tabId: number;
  videoId: string;
};
type VariantOption = {
  id: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
};
type ListVariantsResponse =
  | {
      ok: true;
      kind: "hls" | "dash";
      variants: VariantOption[];
      durationSec?: number;
      sizeCapBytes: number;
    }
  | { ok: false; error: string };

async function handleDownloadRequest(req: DownloadRequest): Promise<DownloadResponse> {
  const video = await findVideo(req.tabId, req.videoId);
  if (!video) return { ok: false, error: "Media not found in this tab." };

  const countsAgainstVideoLimit = !isStillImage(video);
  let quotaReservationId: string | undefined;

  if (countsAgainstVideoLimit && !(await isLicensed())) {
    const reservation = await reserveDownload();
    if (!reservation) {
      return {
        ok: false,
        code: "RATE_LIMITED",
        error: `You've used all ${FREE_DOWNLOAD_LIMIT} free video downloads in the last 24 hours. Upgrade for unlimited video downloads.`,
      };
    }
    quotaReservationId = reservation.id;
  }

  if (video.kind === "hls") {
    return startHlsDownload(
      req,
      video,
      req.variantId,
      req.audioRenditionUrl,
      req.bypassSizeCap,
      quotaReservationId,
    );
  }

  if (video.kind === "dash") {
    return startDashDownload(req, video, req.variantId, req.bypassSizeCap, quotaReservationId);
  }

  if (isWebmDirectVideo(video)) {
    return startWebmTranscode(req, video, quotaReservationId);
  }

  // Header replay does NOT apply to chrome.downloads.download — those fetches
  // are initiated by the browser process, not the extension, so a DNR rule
  // scoped to initiatorDomains: [chrome.runtime.id] cannot match them. There
  // is no MV3-supported way to inject Referer / Authorization on a
  // chrome.downloads.download fetch. Direct files relying on cookies still
  // work because the browser attaches them automatically.
  const directSettings = await getSettings();
  try {
    const downloadId = await chrome.downloads.download({
      url: video.url,
      filename: inferFilename(video, { template: directSettings.filenameTemplate }),
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
      countsAgainstQuota: Boolean(quotaReservationId),
      quotaRecorded: Boolean(quotaReservationId),
      quotaReservationId,
    });
    return { ok: true, downloadId };
  } catch (err) {
    await releaseDownloadReservation(quotaReservationId);
    return {
      ok: false,
      error: err instanceof Error && err.message ? err.message : DIRECT_DOWNLOAD_FAILURE_MESSAGE,
    };
  }
}

async function handleDomImagesDetected(
  message: DomImagesDetectedMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !Array.isArray(message.images)) return;

  let changed = false;
  for (const image of message.images) {
    if (!image || typeof image.url !== "string") continue;
    const cls = classifyUrl(image.url);
    const isRenderedUnknownImage =
      cls.kind === "unknown" &&
      image.source === "rendered-image" &&
      typeof image.width === "number" &&
      typeof image.height === "number";
    if (cls.kind !== "image" && !isRenderedUnknownImage) continue;
    const video: DetectedVideo = {
      id: makeId(image.url, tabId),
      url: image.url,
      kind: "image",
      detectedAt: Date.now(),
      pageUrl: message.pageUrl,
      pageTitle: message.pageTitle,
    };
    await addOrUpdateVideo(tabId, video);
    changed = true;
  }

  if (changed) await updateBadge(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const m = message as { type?: string };
  if (m.type === "download") {
    void handleDownloadRequest(message as DownloadRequest).then(sendResponse);
    return true;
  }
  if (m.type === "list-variants") {
    void handleListVariantsRequest(message as ListVariantsRequest).then(sendResponse);
    return true;
  }
  if (m.type === "dom-images-detected") {
    void handleDomImagesDetected(message as DomImagesDetectedMessage, sender).catch(() => {});
    return false;
  }
  return false;
});

async function handleListVariantsRequest(
  req: ListVariantsRequest,
): Promise<ListVariantsResponse> {
  const video = await findVideo(req.tabId, req.videoId);
  if (!video) return { ok: false, error: "Video not found in this tab." };
  if (video.kind !== "hls" && video.kind !== "dash") {
    return { ok: false, error: "Variant picker is only available for HLS / DASH streams." };
  }

  try {
    await ensureOffscreenDocument();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not start offscreen document.",
    };
  }

  const lookupKey = `lookup:${video.id}`;
  await installHeaderReplayRule(lookupKey, video.id, video.url, video.kind);
  try {
    const result = (await chrome.runtime.sendMessage({
      type: "list-variants-start",
      url: video.url,
      kind: video.kind,
    })) as { ok: true; kind: "hls" | "dash"; variants: VariantOption[]; durationSec?: number } | { ok: false; error: string };

    if (!result || result.ok === false) {
      return { ok: false, error: (result && "error" in result && result.error) || "Manifest fetch failed" };
    }

    const settings = await getSettings();
    return { ...result, sizeCapBytes: settings.hlsSizeCapBytes };
  } finally {
    await removeHeaderReplayRule(lookupKey);
  }
}

// Drive a stream job (HLS/DASH/WebM) to its terminal state from the Chrome
// download's final state. Idempotent and guarded so a duplicate or late signal
// cannot revert a job that already completed or was cancelled. Returns true if
// a matching stream job was found. Correlates by downloadId, which the
// blob-ready handler persists after chrome.downloads.download resolves.
async function applyStreamDownloadTerminal(
  downloadId: number,
  state: "complete" | "interrupted",
): Promise<boolean> {
  let chargeQuota = false;
  let quotaReservationToRelease: string | undefined;

  const hls = Object.values(await getHlsJobs()).find((j) => j.downloadId === downloadId);
  if (hls) {
    await updateHlsJob(hls.jobId, (j) => {
      if (j.status === "complete" || j.status === "cancelled") return false;
      const result = applyTerminalFields(j, state);
      chargeQuota = result.chargeQuota;
      quotaReservationToRelease = result.quotaReservationToRelease;
    });
    await removeHeaderReplayRule(`hls:${hls.jobId}`);
    if (chargeQuota) await recordDownload();
    await releaseDownloadReservation(quotaReservationToRelease);
    void chrome.runtime.sendMessage({ type: "hls-download-revoke", jobId: hls.jobId }).catch(() => {});
    return true;
  }

  const webm = Object.values(await getWebmTranscodeJobs()).find((j) => j.downloadId === downloadId);
  if (webm) {
    await updateWebmTranscodeJob(webm.jobId, (j) => {
      if (j.status === "complete" || j.status === "cancelled") return false;
      const result = applyTerminalFields(j, state);
      chargeQuota = result.chargeQuota;
      quotaReservationToRelease = result.quotaReservationToRelease;
    });
    await removeHeaderReplayRule(`webm:${webm.jobId}`);
    if (chargeQuota) await recordDownload();
    await releaseDownloadReservation(quotaReservationToRelease);
    void chrome.runtime.sendMessage({ type: "webm-transcode-revoke", jobId: webm.jobId }).catch(() => {});
    return true;
  }

  const dash = Object.values(await getDashJobs()).find((j) => j.downloadId === downloadId);
  if (dash) {
    await updateDashJob(dash.jobId, (j) => {
      if (j.status === "complete" || j.status === "cancelled") return false;
      const result = applyTerminalFields(j, state);
      chargeQuota = result.chargeQuota;
      quotaReservationToRelease = result.quotaReservationToRelease;
    });
    await removeHeaderReplayRule(`dash:${dash.jobId}`);
    if (chargeQuota) await recordDownload();
    await releaseDownloadReservation(quotaReservationToRelease);
    void chrome.runtime.sendMessage({ type: "dash-download-revoke", jobId: dash.jobId }).catch(() => {});
    return true;
  }

  return false;
}

// Applies the terminal fields to a stream job. New jobs reserve quota at
// kickoff; legacy jobs without a reservation are charged on first completion.
// Interrupted saves release an unused reservation.
function applyTerminalFields(
  job: {
    status: string;
    errorMessage?: string;
    errorCode?: string;
    countsAgainstQuota?: boolean;
    quotaRecorded?: boolean;
    quotaReservationId?: string;
  },
  state: "complete" | "interrupted",
): { chargeQuota: boolean; quotaReservationToRelease?: string } {
  if (state === "complete") {
    job.status = "complete";
    delete job.errorMessage;
    delete job.errorCode;
    if (job.countsAgainstQuota !== false && !job.quotaRecorded) {
      job.quotaRecorded = true;
      return { chargeQuota: true };
    }
    return { chargeQuota: false };
  }
  job.status = "error";
  job.errorMessage = DIRECT_DOWNLOAD_FAILURE_MESSAGE;
  job.errorCode = "SAVE_INTERRUPTED";
  const quotaReservationToRelease = job.quotaReservationId;
  delete job.quotaReservationId;
  return { chargeQuota: false, quotaReservationToRelease };
}

// The Chrome download for a just-saved stream blob can finish before
// blob-ready persists its downloadId, so onChanged fires with no job to match
// and the transition is lost. After persisting, reconcile against the download
// record to catch a completion that beat the write.
async function reconcileStreamSave(downloadId: number): Promise<void> {
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item && (item.state === "complete" || item.state === "interrupted")) {
      await applyStreamDownloadTerminal(downloadId, item.state);
    }
  } catch {
    // Best effort; onChanged remains the primary path.
  }
}

async function handleDownloadChange(delta: chrome.downloads.DownloadDelta): Promise<void> {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;

  const jobs = await getDownloadJobs();
  if (jobs[String(delta.id)]) {
    let chargeQuota = false;
    let quotaReservationToRelease: string | undefined;
    await updateJobRecord<DownloadJob>(DOWNLOAD_JOBS_KEY, String(delta.id), (job) => {
      if (state === "complete") {
        job.status = "complete";
        delete job.errorMessage;
        if (job.countsAgainstQuota !== false && !job.quotaRecorded) {
          job.quotaRecorded = true;
          chargeQuota = true;
        }
      } else {
        job.status = "interrupted";
        job.errorMessage = DIRECT_DOWNLOAD_FAILURE_MESSAGE;
        quotaReservationToRelease = job.quotaReservationId;
        delete job.quotaReservationId;
      }
    });
    if (chargeQuota) await recordDownload();
    await releaseDownloadReservation(quotaReservationToRelease);
    return;
  }

  await applyStreamDownloadTerminal(delta.id, state);
}

chrome.downloads.onChanged.addListener((delta) => {
  void handleDownloadChange(delta);
});

const HLS_JOBS_KEY = "hls-download-jobs";

async function getHlsJobs(): Promise<Record<string, HlsJob>> {
  const result = await chrome.storage.session.get(HLS_JOBS_KEY);
  const jobs = result[HLS_JOBS_KEY];
  return jobs && typeof jobs === "object" ? (jobs as Record<string, HlsJob>) : {};
}

async function setHlsJob(job: HlsJob): Promise<void> {
  await putJobRecord(HLS_JOBS_KEY, job.jobId, job);
}

// Atomic read-modify-write of one HLS job. `mutate` sees the current stored job
// so a status guard cannot be defeated by a stale snapshot.
async function updateHlsJob(
  jobId: string,
  mutate: (job: HlsJob) => boolean | void,
): Promise<void> {
  await updateJobRecord(HLS_JOBS_KEY, jobId, mutate);
}

const WEBM_TRANSCODE_JOBS_KEY = "webm-transcode-jobs";

async function getWebmTranscodeJobs(): Promise<Record<string, WebmTranscodeJob>> {
  const result = await chrome.storage.session.get(WEBM_TRANSCODE_JOBS_KEY);
  const jobs = result[WEBM_TRANSCODE_JOBS_KEY];
  return jobs && typeof jobs === "object" ? (jobs as Record<string, WebmTranscodeJob>) : {};
}

async function setWebmTranscodeJob(job: WebmTranscodeJob): Promise<void> {
  await putJobRecord(WEBM_TRANSCODE_JOBS_KEY, job.jobId, job);
}

async function updateWebmTranscodeJob(
  jobId: string,
  mutate: (job: WebmTranscodeJob) => boolean | void,
): Promise<void> {
  await updateJobRecord(WEBM_TRANSCODE_JOBS_KEY, jobId, mutate);
}

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = (await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  })) as chrome.runtime.ExtensionContext[] | undefined;
  if (contexts && contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: "Assemble streams or convert WebM files into downloadable MP4 blobs",
  });
}

// When the user explicitly clicks "Continue anyway" past the size cap, allow
// up to 10× the configured cap. Caps the runaway-memory blast radius while
// honoring the explicit opt-in.
const BYPASS_CAP_MULTIPLIER = 10;

async function startHlsDownload(
  req: DownloadRequest,
  video: DetectedVideo,
  variantId: string | undefined,
  audioRenditionUrl: string | undefined,
  bypassSizeCap: boolean | undefined,
  quotaReservationId: string | undefined,
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
    variantLabel: req.variantLabel,
    countsAgainstQuota: Boolean(quotaReservationId),
    quotaRecorded: Boolean(quotaReservationId),
    quotaReservationId,
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
    await releaseDownloadReservation(quotaReservationId);
    return { ok: false, error: job?.errorMessage ?? "Could not start offscreen document." };
  }

  await installHeaderReplayRule(`hls:${jobId}`, video.id, video.url, "hls");

  const effectiveCap = bypassSizeCap
    ? settings.hlsSizeCapBytes * BYPASS_CAP_MULTIPLIER
    : settings.hlsSizeCapBytes;

  void chrome.runtime
    .sendMessage({
      type: "hls-download-start",
      jobId,
      url: video.url,
      sizeCapBytes: effectiveCap,
      variantUrl: variantId,
      audioUrl: audioRenditionUrl,
    })
    .catch(() => {});

  return { ok: true, jobId };
}

async function startWebmTranscode(
  req: DownloadRequest,
  video: DetectedVideo,
  quotaReservationId: string | undefined,
): Promise<DownloadResponse> {
  const jobId = `webm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  await setWebmTranscodeJob({
    jobId,
    videoId: video.id,
    tabId: req.tabId,
    url: video.url,
    kind: "direct",
    startedAt: Date.now(),
    status: "running",
    progress: { ratio: 0, message: "Starting WebM to MP4 transcode" },
    countsAgainstQuota: Boolean(quotaReservationId),
    quotaRecorded: Boolean(quotaReservationId),
    quotaReservationId,
  });

  try {
    await ensureOffscreenDocument();
  } catch (err) {
    const job = (await getWebmTranscodeJobs())[jobId];
    if (job) {
      job.status = "error";
      job.errorCode = "OFFSCREEN_INIT";
      job.errorMessage = err instanceof Error ? err.message : "Could not start offscreen document.";
      await setWebmTranscodeJob(job);
    }
    await releaseDownloadReservation(quotaReservationId);
    return { ok: false, error: job?.errorMessage ?? "Could not start offscreen document." };
  }

  // The transcoder fetches video.url from the offscreen document, which is an
  // extension-initiated request, so captured request headers can be replayed
  // via DNR just like the HLS/DASH segment fetches.
  await installHeaderReplayRule(`webm:${jobId}`, video.id, video.url, "direct");

  void chrome.runtime
    .sendMessage({
      type: "webm-transcode-start",
      jobId,
      url: video.url,
      sizeCapBytes: WEBM_TRANSCODE_SIZE_CAP_BYTES,
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
  await updateHlsJob(msg.jobId, (job) => {
    // A progress message that arrives after the job failed or finished must
    // never revert it to "running".
    if (job.status !== "running") return false;
    job.progress = { done: msg.done, total: msg.total, bytes: msg.bytes };
  });
}

async function handleHlsBlobReady(msg: {
  jobId: string;
  blobUrl: string;
  sizeBytes: number;
  containerExt: ".mp4" | ".ts";
}): Promise<void> {
  const jobs = await getHlsJobs();
  const job = jobs[msg.jobId];
  if (!job) return;

  const video = await findVideo(job.tabId, job.videoId);
  if (!video) {
    let quotaReservationToRelease: string | undefined;
    await updateHlsJob(msg.jobId, (j) => {
      if (j.status !== "running") return false;
      j.status = "error";
      j.errorMessage = "Video missing when saving HLS download.";
      j.errorCode = "VIDEO_MISSING";
      quotaReservationToRelease = j.quotaReservationId;
      delete j.quotaReservationId;
    });
    await releaseDownloadReservation(quotaReservationToRelease);
    await removeHeaderReplayRule(`hls:${msg.jobId}`);
    void chrome.runtime.sendMessage({ type: "hls-download-revoke", jobId: msg.jobId }).catch(() => {});
    return;
  }

  try {
    const { filenameTemplate } = await getSettings();
    const downloadId = await chrome.downloads.download({
      url: msg.blobUrl,
      filename: inferFilename(video, {
        forcedExtension: msg.containerExt,
        template: filenameTemplate,
        variantLabel: job.variantLabel,
      }),
      conflictAction: "uniquify",
      saveAs: false,
    });
    await updateHlsJob(msg.jobId, (j) => {
      // The job could have been cancelled during the save-initiation window.
      if (j.status !== "running") return false;
      j.downloadId = downloadId;
      j.containerExt = msg.containerExt;
      j.status = "saving";
    });
    await reconcileStreamSave(downloadId);
  } catch (err) {
    let quotaReservationToRelease: string | undefined;
    await updateHlsJob(msg.jobId, (j) => {
      if (j.status === "complete" || j.status === "cancelled") return false;
      j.status = "error";
      j.errorMessage = err instanceof Error ? err.message : "Could not save HLS file.";
      j.errorCode = "SAVE_FAILED";
      quotaReservationToRelease = j.quotaReservationId;
      delete j.quotaReservationId;
    });
    await releaseDownloadReservation(quotaReservationToRelease);
    await removeHeaderReplayRule(`hls:${msg.jobId}`);
    void chrome.runtime.sendMessage({ type: "hls-download-revoke", jobId: msg.jobId }).catch(() => {});
  }
}

async function handleHlsError(msg: {
  jobId: string;
  code: string;
  userMessage: string;
}): Promise<void> {
  let quotaReservationToRelease: string | undefined;
  await updateHlsJob(msg.jobId, (job) => {
    // Do not overwrite a job that already saved successfully.
    if (job.status === "complete") return false;
    job.status = msg.code === "CANCELLED" ? "cancelled" : "error";
    job.errorCode = msg.code;
    job.errorMessage = msg.userMessage;
    quotaReservationToRelease = job.quotaReservationId;
    delete job.quotaReservationId;
  });
  await releaseDownloadReservation(quotaReservationToRelease);
  await removeHeaderReplayRule(`hls:${msg.jobId}`);
}

async function handleWebmTranscodeProgress(msg: {
  jobId: string;
  ratio: number;
  message?: string;
}): Promise<void> {
  await updateWebmTranscodeJob(msg.jobId, (job) => {
    if (job.status !== "running") return false;
    job.progress = { ratio: msg.ratio, message: msg.message ?? job.progress.message };
  });
}

async function handleWebmTranscodeBlobReady(msg: {
  jobId: string;
  blobUrl: string;
  sizeBytes: number;
}): Promise<void> {
  const jobs = await getWebmTranscodeJobs();
  const job = jobs[msg.jobId];
  if (!job) return;

  const video = await findVideo(job.tabId, job.videoId);
  if (!video) {
    let quotaReservationToRelease: string | undefined;
    await updateWebmTranscodeJob(msg.jobId, (j) => {
      if (j.status !== "running") return false;
      j.status = "error";
      j.errorMessage = "Video missing when saving WebM transcode.";
      j.errorCode = "VIDEO_MISSING";
      quotaReservationToRelease = j.quotaReservationId;
      delete j.quotaReservationId;
    });
    await releaseDownloadReservation(quotaReservationToRelease);
    await removeHeaderReplayRule(`webm:${msg.jobId}`);
    void chrome.runtime.sendMessage({ type: "webm-transcode-revoke", jobId: msg.jobId }).catch(() => {});
    return;
  }

  try {
    const { filenameTemplate } = await getSettings();
    const downloadId = await chrome.downloads.download({
      url: msg.blobUrl,
      filename: inferFilename(video, {
        forcedExtension: ".mp4",
        template: filenameTemplate,
      }),
      conflictAction: "uniquify",
      saveAs: false,
    });
    await updateWebmTranscodeJob(msg.jobId, (j) => {
      if (j.status !== "running") return false;
      j.downloadId = downloadId;
      j.status = "saving";
    });
    await reconcileStreamSave(downloadId);
  } catch (err) {
    let quotaReservationToRelease: string | undefined;
    await updateWebmTranscodeJob(msg.jobId, (j) => {
      if (j.status === "complete" || j.status === "cancelled") return false;
      j.status = "error";
      j.errorMessage = err instanceof Error ? err.message : "Could not save transcoded MP4.";
      j.errorCode = "SAVE_FAILED";
      quotaReservationToRelease = j.quotaReservationId;
      delete j.quotaReservationId;
    });
    await releaseDownloadReservation(quotaReservationToRelease);
    await removeHeaderReplayRule(`webm:${msg.jobId}`);
    void chrome.runtime.sendMessage({ type: "webm-transcode-revoke", jobId: msg.jobId }).catch(() => {});
  }
}

async function handleWebmTranscodeError(msg: {
  jobId: string;
  code: string;
  userMessage: string;
}): Promise<void> {
  let quotaReservationToRelease: string | undefined;
  await updateWebmTranscodeJob(msg.jobId, (job) => {
    if (job.status === "complete") return false;
    job.status = msg.code === "CANCELLED" ? "cancelled" : "error";
    job.errorCode = msg.code;
    job.errorMessage = msg.userMessage;
    quotaReservationToRelease = job.quotaReservationId;
    delete job.quotaReservationId;
  });
  await releaseDownloadReservation(quotaReservationToRelease);
  await removeHeaderReplayRule(`webm:${msg.jobId}`);
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
  } else if (m.type === "dash-download-blob-ready") {
    void handleDashBlobReady(message as Parameters<typeof handleDashBlobReady>[0]);
  } else if (m.type === "dash-download-error") {
    void handleDashError(message as Parameters<typeof handleDashError>[0]);
  } else if (m.type === "webm-transcode-progress") {
    void handleWebmTranscodeProgress(message as Parameters<typeof handleWebmTranscodeProgress>[0]);
  } else if (m.type === "webm-transcode-blob-ready") {
    void handleWebmTranscodeBlobReady(message as Parameters<typeof handleWebmTranscodeBlobReady>[0]);
  } else if (m.type === "webm-transcode-error") {
    void handleWebmTranscodeError(message as Parameters<typeof handleWebmTranscodeError>[0]);
  }
  return false;
});

const DASH_JOBS_KEY = "dash-download-jobs";

async function getDashJobs(): Promise<Record<string, DashJob>> {
  const result = await chrome.storage.session.get(DASH_JOBS_KEY);
  const jobs = result[DASH_JOBS_KEY];
  return jobs && typeof jobs === "object" ? (jobs as Record<string, DashJob>) : {};
}

async function setDashJob(job: DashJob): Promise<void> {
  await putJobRecord(DASH_JOBS_KEY, job.jobId, job);
}

async function updateDashJob(
  jobId: string,
  mutate: (job: DashJob) => boolean | void,
): Promise<void> {
  await updateJobRecord(DASH_JOBS_KEY, jobId, mutate);
}

async function startDashDownload(
  req: DownloadRequest,
  video: DetectedVideo,
  variantId: string | undefined,
  bypassSizeCap: boolean | undefined,
  quotaReservationId: string | undefined,
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
    progress: { done: 0, total: 0, bytes: 0 },
    variantLabel: req.variantLabel,
    countsAgainstQuota: Boolean(quotaReservationId),
    quotaRecorded: Boolean(quotaReservationId),
    quotaReservationId,
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
    await releaseDownloadReservation(quotaReservationId);
    return { ok: false, error: job?.errorMessage ?? "Could not start offscreen document." };
  }

  await installHeaderReplayRule(`dash:${jobId}`, video.id, video.url, "dash");

  const effectiveCap = bypassSizeCap
    ? settings.hlsSizeCapBytes * BYPASS_CAP_MULTIPLIER
    : settings.hlsSizeCapBytes;

  void chrome.runtime
    .sendMessage({
      type: "dash-download-start",
      jobId,
      url: video.url,
      sizeCapBytes: effectiveCap,
      videoRepresentationId: variantId,
    })
    .catch(() => {});

  return { ok: true, jobId };
}

async function handleDashProgress(msg: {
  jobId: string;
  done: number;
  total: number;
  bytes: number;
}): Promise<void> {
  await updateDashJob(msg.jobId, (job) => {
    if (job.status !== "running") return false;
    job.progress = { done: msg.done, total: msg.total, bytes: msg.bytes };
  });
}

async function handleDashBlobReady(msg: {
  jobId: string;
  blobUrl: string;
  sizeBytes: number;
}): Promise<void> {
  const jobs = await getDashJobs();
  const job = jobs[msg.jobId];
  if (!job) return;

  const video = await findVideo(job.tabId, job.videoId);
  if (!video) {
    let quotaReservationToRelease: string | undefined;
    await updateDashJob(msg.jobId, (j) => {
      if (j.status !== "running") return false;
      j.status = "error";
      j.errorMessage = "Video missing when saving DASH download.";
      j.errorCode = "VIDEO_MISSING";
      quotaReservationToRelease = j.quotaReservationId;
      delete j.quotaReservationId;
    });
    await releaseDownloadReservation(quotaReservationToRelease);
    await removeHeaderReplayRule(`dash:${msg.jobId}`);
    void chrome.runtime.sendMessage({ type: "dash-download-revoke", jobId: msg.jobId }).catch(() => {});
    return;
  }

  try {
    const { filenameTemplate } = await getSettings();
    const downloadId = await chrome.downloads.download({
      url: msg.blobUrl,
      filename: inferFilename(video, {
        forcedExtension: ".mp4",
        template: filenameTemplate,
        variantLabel: job.variantLabel,
      }),
      conflictAction: "uniquify",
      saveAs: false,
    });
    await updateDashJob(msg.jobId, (j) => {
      if (j.status !== "running") return false;
      j.downloadId = downloadId;
      j.status = "saving";
    });
    await reconcileStreamSave(downloadId);
  } catch (err) {
    let quotaReservationToRelease: string | undefined;
    await updateDashJob(msg.jobId, (j) => {
      if (j.status === "complete" || j.status === "cancelled") return false;
      j.status = "error";
      j.errorMessage = err instanceof Error ? err.message : "Could not save DASH file.";
      j.errorCode = "SAVE_FAILED";
      quotaReservationToRelease = j.quotaReservationId;
      delete j.quotaReservationId;
    });
    await releaseDownloadReservation(quotaReservationToRelease);
    await removeHeaderReplayRule(`dash:${msg.jobId}`);
    void chrome.runtime.sendMessage({ type: "dash-download-revoke", jobId: msg.jobId }).catch(() => {});
  }
}

async function handleDashError(msg: {
  jobId: string;
  code: string;
  userMessage: string;
}): Promise<void> {
  let quotaReservationToRelease: string | undefined;
  await updateDashJob(msg.jobId, (job) => {
    if (job.status === "complete") return false;
    job.status = msg.code === "CANCELLED" ? "cancelled" : "error";
    job.errorCode = msg.code;
    job.errorMessage = msg.userMessage;
    quotaReservationToRelease = job.quotaReservationId;
    delete job.quotaReservationId;
  });
  await releaseDownloadReservation(quotaReservationToRelease);
  await removeHeaderReplayRule(`dash:${msg.jobId}`);
}
