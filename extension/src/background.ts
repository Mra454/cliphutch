import { classifyUrl } from "./lib/detector";
import {
  addOrUpdateVideo,
  addOrUpdateVideos,
  clearTab,
  getDetectedVideos,
  retainDetectedVideosForPage,
} from "./lib/storage-session";
import {
  MIN_STILL_IMAGE_SIZE_BYTES,
  VIDEO_REQUEST_TYPES,
  WEBM_TRANSCODE_SIZE_CAP_BYTES,
} from "./lib/constants";
import { inferFilename } from "./lib/filename";
import { putJobRecord, updateJobRecord, withKeyLock } from "./lib/session-jobs";
import { getSettings, type UserSettings } from "./lib/storage-local";
import { isLicensed } from "./lib/license";
import {
  handleLicenseRuntimeMessage,
  isLicenseRuntimeMessage,
} from "./lib/license-runtime";
import {
  FREE_DOWNLOAD_LIMIT,
  chargeDownloadReservation,
  getDownloadCount,
  reconcileDownloadBatchReservations,
  recordDownload,
  releaseDownloadReservation,
  reserveDownload,
} from "./lib/rate-limit";
import {
  buildSessionRule,
  extractCapturedHeaders,
  hasDirectCredentialHeaders,
  hasReplayableHeaders,
  type CapturedHeaders,
} from "./lib/header-capture";
import {
  clearCapturedHeadersForTab,
  getCapturedHeaderEntry,
  getCapturedHeaders,
  saveCapturedHeaders,
} from "./lib/captured-headers";
import { filterCoveredByManifests } from "./lib/manifest-coverage";
import { isStillImage, isWebmDirectVideo } from "./lib/media-format";
import { createDetectedMediaRecordId } from "./lib/media-identity";
import {
  DOWNLOAD_COMMAND_RECORDS_KEY,
  PersistentCommandGate,
  isDownloadCommandId,
  type PersistentCommandRecord,
  type PersistentCommandStore,
} from "./lib/download-intent";
import { handleCaptureDraftUiRequest } from "./lib/capture-draft-handler";
import {
  claimCaptureHeaderLeaseBatch,
  claimCaptureHeaderLease,
  createCaptureHeaderLease,
  getCaptureHeaderLease,
  getClaimedCaptureHeaderLease,
  listCaptureHeaderLeases,
  releaseCaptureHeaderLease,
  releaseCaptureHeaderLeaseBatch,
  retireClaimedCaptureHeaderLease,
  sweepExpiredCaptureHeaderLeases,
  type CaptureHeaderLeaseBindingV1,
  type CaptureHeaderLeaseAttemptBindingV1,
  type CaptureHeaderLeaseSummaryV1,
  type CaptureHeaderLeaseV1,
} from "./lib/capture-header-leases";
import {
  CAPTURE_CLEANUP_RETRY_ALARM_NAME,
  CAPTURE_LEASE_EXPIRY_ALARM_NAME,
  nextCaptureLeaseExpiryAlarmTime,
  planCaptureCleanupRetry,
} from "./lib/capture-lease-expiry-alarm";
import { cleanupSweptCaptureLeaseDnrOwners } from "./lib/capture-expired-lease-cleanup";
import {
  buildCaptureDnrSessionRule,
  claimCaptureDnrOwner,
  listCaptureDnrOwners,
  releaseCaptureDnrOwner,
  type CaptureDnrOwnerV1,
  type CaptureDnrOwnerKind,
} from "./lib/capture-dnr-owners";
import { parseCaptureDraftUiRequest } from "./lib/capture-pack-messages";
import {
  parseCaptureReviewUiRequest,
  type CaptureManifestRetryRequest,
  type CapturePlanCreateRequest,
  type CaptureRunEnqueueRequest,
  type CaptureJobCancelRequest,
  type CaptureQuickReconcileRequest,
  type CaptureVariantOptionV1,
} from "./lib/capture-review-messages";
import {
  applyCaptureDraftCommand,
  getActiveCaptureDraft,
} from "./lib/capture-pack-storage";
import { generateCaptureReviewPlan } from "./lib/capture-plan";
import {
  clearUnreferencedCaptureReviewPlans,
  getActiveCaptureReviewPlan,
  getCaptureReviewPlan,
  listCaptureReviewPlans,
  saveCaptureReviewPlan,
} from "./lib/capture-plan-storage";
import {
  capturePlanOptionRequestMatches,
  clearUnreferencedCapturePlanOptions,
  getCapturePlanOptions,
  saveCapturePlanOptions,
  type CaptureHeaderLeaseIdsByItemId,
  type CapturePlanOptionsRecordV1,
} from "./lib/capture-plan-options";
import {
  applyCaptureVariantOptionBudget,
  buildCaptureVariantPreflight,
  resolveCaptureVariantOption,
  selectCaptureReviewVariantV1,
  type CaptureVariantPreflightEntryV1,
} from "./lib/capture-variant-preflight";
import {
  parseCaptureExecutionSnapshotDiscardResponseV1,
  parseCaptureVariantInspectResponseV1,
  type CaptureExecutionSnapshotDiscardMessageV1,
  type CaptureVariantInspectErrorCodeV1,
} from "./lib/offscreen-attempts";
import {
  normalizeVariantOptionsV1,
  type NormalizedVariantV1,
} from "./lib/variant-options";
import { revalidatePersistentCaptureStreamQualityV1 } from "./lib/capture-stream-quality";
import { isCaptureExecutorErrorRetryable } from "./lib/capture-error-policy";
import { allocateCaptureReviewPlan } from "./lib/capture-plan-allocation";
import { assessCaptureRunCapacity } from "./lib/capture-run-capacity";
import {
  claimCaptureJobsFifo,
  prepareCaptureJobs,
  type CaptureJobClaim,
} from "./lib/capture-executor";
import { applyStoredCaptureJobEvent } from "./lib/capture-job-controller";
import { executeNativeCaptureJob } from "./lib/capture-native-runtime";
import { preflightCaptureNativeSources } from "./lib/capture-native-preflight";
import { verifyCaptureNativeMedia } from "./lib/capture-native-verification";
import { createSingleCapturePlan } from "./lib/capture-single-plan";
import {
  prepareQuickCaptureHeaderLease,
  retirePreparedQuickCaptureHeaderLease,
  quickCaptureDownloadNeedsHeaderLease,
  type ClaimedQuickCaptureHeaderLease,
} from "./lib/quick-capture-lease";
import {
  persistAndReconcileQuickCaptureRunStart,
  reconcileQuickCaptureRunStart,
} from "./lib/quick-capture-run";
import { QUICK_CAPTURE_SOURCE_AUTH_EXPIRED_MESSAGE } from "./lib/quick-capture-run-messages";
import {
  activeJobOwnsQuickPlan,
  activeRunOwnsReviewPlan,
} from "./lib/capture-active-ownership";
import {
  abandonQuickCaptureStartIntent,
  createQuickCaptureStartIntent,
  getNewestUnresolvedQuickCaptureStartIntent,
  getQuickCaptureStartIntent,
  listQuickCaptureStartIntents,
  updateQuickCaptureStartIntentDisposition,
  type QuickCaptureStartIntentV1,
} from "./lib/quick-capture-start-intents";
import {
  getCaptureJob,
  getCaptureRun,
  enrichCompletedCaptureJobResult,
  listCaptureCommandRecords,
  listCaptureRuns,
  updateCaptureRun,
} from "./lib/capture-run-storage";
import {
  finalizeStoredCaptureManifestRecord,
  getCaptureManifestRecord,
  mutateCaptureManifestOutput,
} from "./lib/capture-manifest-storage";
import {
  buildCaptureManifestInput,
  captureManifestDownloadPath,
  serializeCaptureManifestForFormat,
} from "./lib/capture-manifest-finalizer";
import {
  captureManifestBlobCreateErrorIsRetryable,
  captureManifestBlobMimeType,
  captureManifestContentSizeBytes,
  parseCaptureManifestBlobCreateResponse,
  parseCaptureManifestBlobRevokeResponse,
  parseCaptureManifestBlobStatusResponse,
  sha256CaptureManifestContent,
  type CaptureManifestBlobStatusEntry,
} from "./lib/capture-manifest-blob";
import { createCaptureWorkspaceManifest } from "./lib/capture-manifest-workspace";
import { planCaptureManifestRecovery } from "./lib/capture-manifest-recovery";
import { createTrailingTaskScheduler } from "./lib/trailing-task-scheduler";
import type {
  CaptureManifestOutputV1,
  CaptureManifestPublicErrorCode,
  CaptureManifestRecordV1,
} from "./lib/capture-manifest-delivery";
import { MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS } from "./lib/capture-manifest-delivery";
import type {
  CaptureDraftItemV1,
  CaptureDraftV1,
  CaptureJobV1,
  CaptureManifestFormatV1,
  CaptureReviewPlanV1,
  CaptureRunV1,
  PersistentStreamQualityChoiceV1,
  QualityChoiceV1,
} from "./lib/capture-pack-types";
import {
  captureReviewPlanTotalsForItems,
  isPersistentStreamQualityChoiceV1,
  isCaptureReviewPlanV1,
} from "./lib/capture-pack-types";
import {
  enqueueCaptureRun,
  reconcileCaptureRunQueue,
} from "./lib/capture-run-coordinator";
import {
  abandonCaptureRunIntent,
  createCaptureRunIntent,
  digestCaptureRunExecutionPlan,
  finalizeCaptureRunIntent,
  getNewestUnresolvedCaptureRunIntent,
  isCaptureRunIntentUnresolved,
  listCaptureRunIntents,
  type CaptureRunIntentV1,
} from "./lib/capture-run-intents";
import {
  planCaptureRecovery,
  type ActiveOffscreenAttemptV1,
  type CaptureRecoveryAction,
  type ObservedChromeDownloadV1,
} from "./lib/capture-recovery";
import type {
  DetectedVideo,
  DashJob,
  HlsJob,
  WebmTranscodeJob,
  MediaKind,
  MediaProvenance,
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
  provenance?: MediaProvenance[];
  familyId?: string;
};

type DomImagesDetectedMessage = {
  type: "dom-images-detected";
  pageUrl?: string;
  pageTitle?: string;
  images?: DomImageCandidate[];
};

type ContentPageContextMessage = {
  type: "content-page-context";
  pageUrl?: string;
  pageTitle?: string;
};

const pendingByRequestId = new Map<string, Pending>();

async function restrictExtensionStorageAccess(): Promise<void> {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
}

// Content scripts need messaging, not direct access to license, quota, header,
// draft, or run records. Apply the restriction on every worker lifetime.
void restrictExtensionStorageAccess().catch(() => undefined);

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
    id: createDetectedMediaRecordId(pending.tabId),
    url: mediaUrl,
    kind,
    detectedAt: Date.now(),
    pageUrl,
    pageTitle,
    sizeBytes: normalizedSize,
    contentType: contentType ? contentType.split(";")[0].trim() : undefined,
    contentDisposition,
    hasCapturedReplayHeaders: Boolean(
      pending.capturedHeaders && hasReplayableHeaders(pending.capturedHeaders),
    ),
  };

  await withKeyLock(CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY, async () => {
    const retained = await addOrUpdateVideo(pending.tabId, video);
    if (
      retained.action !== "dropped" &&
      retained.action !== "ignored_stale_page" &&
      pending.capturedHeaders &&
      hasReplayableHeaders(pending.capturedHeaders)
    ) {
      await saveCapturedHeaders(retained.mediaId, pending.tabId, pending.capturedHeaders);
    }
  });
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
  void withKeyLock(CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY, async () => {
    await clearCapturedHeadersForTab(tabId);
    await clearTab(tabId);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
    void withKeyLock(CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY, async () => {
      await clearCapturedHeadersForTab(tabId);
      await clearTab(tabId);
    }).then(() => updateBadge(tabId));
  }
});

type DownloadStatus = "in_progress" | "complete" | "interrupted";

type DownloadJob = {
  commandId?: string;
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

const CAPTURE_RULE_OWNERS_KEY = "capture-dnr-rule-owners-v1";

async function readCaptureRuleOwners(): Promise<Record<string, number>> {
  const stored = await chrome.storage.session.get(CAPTURE_RULE_OWNERS_KEY);
  const raw = stored[CAPTURE_RULE_OWNERS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const owners: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      key.startsWith("capture:") &&
      key.length <= 600 &&
      Number.isSafeInteger(value) &&
      (value as number) > 0
    ) {
      owners[key] = value as number;
    }
  }
  return owners;
}

async function registerCaptureRuleOwner(jobKey: string, ruleId: number): Promise<void> {
  if (!jobKey.startsWith("capture:")) return;
  await withKeyLock(CAPTURE_RULE_OWNERS_KEY, async () => {
    const owners = await readCaptureRuleOwners();
    owners[jobKey] = ruleId;
    await chrome.storage.session.set({ [CAPTURE_RULE_OWNERS_KEY]: owners });
  });
}

async function forgetCaptureRuleOwner(jobKey: string): Promise<void> {
  if (!jobKey.startsWith("capture:")) return;
  await withKeyLock(CAPTURE_RULE_OWNERS_KEY, async () => {
    const owners = await readCaptureRuleOwners();
    if (!Object.prototype.hasOwnProperty.call(owners, jobKey)) return;
    delete owners[jobKey];
    if (Object.keys(owners).length === 0) {
      await chrome.storage.session.remove(CAPTURE_RULE_OWNERS_KEY);
    } else {
      await chrome.storage.session.set({ [CAPTURE_RULE_OWNERS_KEY]: owners });
    }
  });
}

async function installHeaderReplayRule(
  jobKey: string,
  videoId: string,
  url: string,
  kind: "hls" | "dash" | "direct",
): Promise<boolean> {
  const captured = await getCapturedHeaders(videoId);
  if (!captured || !hasReplayableHeaders(captured)) return true;

  const ruleId = ruleIdForJobKey(jobKey);
  const rule = buildSessionRule({
    ruleId,
    url,
    kind,
    captured,
    extensionId: chrome.runtime.id,
  });
  try {
    await registerCaptureRuleOwner(jobKey, ruleId);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [rule],
    });
    return true;
  } catch {
    // A Capture Run must not silently proceed after losing replay material.
    // The retained owner lets boot cleanup remove an ambiguously installed
    // rule; legacy single-file flows keep their existing best-effort behavior.
    return !jobKey.startsWith("capture:");
  }
}

async function removeHeaderReplayRule(jobKey: string): Promise<boolean> {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleIdForJobKey(jobKey)],
    });
    await forgetCaptureRuleOwner(jobKey);
    return true;
  } catch {
    // Capture owner entries intentionally remain for boot retry.
    return false;
  }
}

async function removeCaptureHeaderReplayRule(jobKey: string): Promise<boolean> {
  for (const delayMs of [0, 50, 250]) {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    if (await removeHeaderReplayRule(jobKey)) return true;
  }
  return false;
}

const DOWNLOAD_JOBS_KEY = "download-jobs";

const DIRECT_DOWNLOAD_FAILURE_MESSAGE =
  "The file URL was detected, but Chrome could not download it. The link may have expired, or the server requires headers, cookies, or a referrer that this extension does not store.";

function replacePlannedExtension(filename: string, extension: ".mp4" | ".ts"): string {
  const slash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  const dot = filename.lastIndexOf(".");
  const stem = dot > slash ? filename.slice(0, dot) : filename;
  return `${stem}${extension}`;
}

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
  commandId: string;
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
  | { ok: false; error: string; code?: string; cleanupPending?: true };

const MAX_STORED_DOWNLOAD_COMMANDS = 200;

function isStoredDownloadCommand(
  value: unknown,
): value is PersistentCommandRecord<DownloadResponse> {
  if (!value || typeof value !== "object") return false;
  const record = value as { version?: unknown; state?: unknown; response?: unknown };
  if (record.version !== 1) return false;
  if (record.state === "pending") return true;
  return record.state === "settled" && Boolean(record.response && typeof record.response === "object");
}

async function getDownloadCommandRecords(): Promise<
  Record<string, PersistentCommandRecord<DownloadResponse>>
> {
  const result = await chrome.storage.session.get(DOWNLOAD_COMMAND_RECORDS_KEY);
  const stored = result[DOWNLOAD_COMMAND_RECORDS_KEY];
  if (!stored || typeof stored !== "object") return {};
  const records: Record<string, PersistentCommandRecord<DownloadResponse>> = {};
  for (const [commandId, value] of Object.entries(stored as Record<string, unknown>)) {
    if (isDownloadCommandId(commandId) && isStoredDownloadCommand(value)) {
      records[commandId] = value;
    }
  }
  return records;
}

const downloadCommandStore: PersistentCommandStore<DownloadResponse> = {
  async read(commandId) {
    return (await getDownloadCommandRecords())[commandId];
  },
  async write(commandId, record) {
    await withKeyLock(DOWNLOAD_COMMAND_RECORDS_KEY, async () => {
      const records = await getDownloadCommandRecords();
      records[commandId] = record;
      const ordered = Object.entries(records).sort(([, a], [, b]) => {
        const aTime = a.state === "settled" ? a.settledAt : a.startedAt;
        const bTime = b.state === "settled" ? b.settledAt : b.startedAt;
        return bTime - aTime;
      });
      const pending = ordered.filter(([, value]) => value.state === "pending");
      const settled = ordered.filter(([, value]) => value.state === "settled");
      const retained = [
        ...pending,
        ...settled.slice(0, Math.max(0, MAX_STORED_DOWNLOAD_COMMANDS - pending.length)),
      ];
      await chrome.storage.session.set({
        // Never evict an unresolved command: losing its tombstone could turn a
        // later replay into a duplicate start. The cap applies to settled data.
        [DOWNLOAD_COMMAND_RECORDS_KEY]: Object.fromEntries(retained),
      });
    });
  },
};

function streamCommandResult(
  job: HlsJob | DashJob | WebmTranscodeJob,
): DownloadResponse {
  if (job.status === "error" || job.status === "cancelled") {
    return {
      ok: false,
      code: job.errorCode,
      error:
        job.errorMessage ??
        (job.status === "cancelled" ? "Download cancelled." : "Download could not start."),
    };
  }
  return { ok: true, jobId: job.jobId };
}

class QuickCaptureStartPendingError extends Error {
  constructor() {
    super("quick_capture_start_pending");
  }
}

function quickCaptureJobResponse(job: CaptureJobV1): DownloadResponse {
  if (job.state === "failed" || job.state === "cancelled") {
    return {
      ok: false,
      code: job.error?.code ?? job.state.toUpperCase(),
      error: job.error?.customerMessage ??
        (job.state === "cancelled" ? "Download cancelled." : "Download failed."),
    };
  }
  if (job.state === "save_state_unknown") {
    return {
      ok: false,
      code: "START_STATE_UNKNOWN",
      error: "Chrome may already have accepted this file. Check Activity and Chrome downloads before trying again.",
    };
  }
  return { ok: true, jobId: job.jobId };
}

async function readOwnedQuickCaptureJob(
  intent: QuickCaptureStartIntentV1,
): Promise<CaptureJobV1 | null> {
  const runResult = await getCaptureRun(intent.runId);
  if (!runResult.ok || !runResult.run) return null;
  const run = runResult.run;
  if (
    run.commandId !== intent.coordinatorCommandId ||
    run.planId !== intent.plan.planId ||
    run.draftId !== intent.plan.draftId ||
    run.draftRevision !== intent.plan.draftRevision ||
    run.orderedJobIds.length !== 1
  ) return null;
  const jobResult = await getCaptureJob(run.orderedJobIds[0]);
  if (
    !jobResult.ok || !jobResult.job ||
    jobResult.job.runId !== run.runId ||
    jobResult.job.itemId !== intent.plan.items[0]?.itemId
  ) return null;
  return jobResult.job;
}

function reconcileQuickCaptureStartIntent(
  intent: QuickCaptureStartIntentV1,
  quickLease?: ClaimedQuickCaptureHeaderLease | null,
): Promise<DownloadResponse> {
  return withKeyLock(
    CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY,
    async () => {
      const response = await reconcileQuickCaptureRunStart({
        intent,
        preparedLease: quickLease,
        dependencies: quickCaptureRunDependencies(),
      });
      if (!response.ok && response.cleanupPending) updateCaptureCleanupRetry(true);
      if (!response.ok && response.pending) throw new QuickCaptureStartPendingError();
      return response;
    },
  );
}

function quickCaptureRunDependencies() {
  return {
    now: () => Date.now(),
    freeDownloadLimit: FREE_DOWNLOAD_LIMIT,
    createQuickCaptureStartIntent,
    abandonQuickCaptureStartIntent,
    updateQuickCaptureStartIntentDisposition,
    enqueueCaptureRun,
    readOwnedQuickCaptureJob,
    getClaimedCaptureHeaderLease,
    retireQuickCaptureHeaderLease: (lease: ClaimedQuickCaptureHeaderLease) =>
      retirePreparedQuickCaptureHeaderLease(lease, {
        now: () => Date.now(),
        retireClaimedCaptureHeaderLease,
      }),
    scheduleCaptureLeaseExpiryAlarm: () => scheduleCaptureLeaseExpiryAlarm(),
    scheduleCaptureQueueDrain,
  };
}

async function recoverDownloadCommand(commandId: string): Promise<DownloadResponse> {
  const quickIntent = await getQuickCaptureStartIntent(commandId);
  if (!quickIntent.ok) throw new QuickCaptureStartPendingError();
  if (quickIntent.intent) return reconcileQuickCaptureStartIntent(quickIntent.intent);
  const captureCommandUuid = commandId.startsWith("download-")
    ? commandId.slice("download-".length).toLowerCase()
    : "";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(captureCommandUuid)) {
    const captureRun = await getCaptureRun(`capture-run:v1:${captureCommandUuid}`);
    if (!captureRun.ok) {
      return {
        ok: false,
        code: "START_STATE_UNKNOWN",
        error: "ClipHutch could not reconcile this download start. Check Activity before trying again.",
      };
    }
    if (captureRun.run) {
      const jobId = captureRun.run.orderedJobIds[0];
      if (!jobId) {
        return {
          ok: false,
          code: "START_STATE_UNKNOWN",
          error: "ClipHutch accepted this start but its file job is unavailable. Check Activity before trying again.",
        };
      }
      const captureJob = await getCaptureJob(jobId);
      if (!captureJob.ok || !captureJob.job) {
        return {
          ok: false,
          code: "START_STATE_UNKNOWN",
          error: "ClipHutch accepted this start but could not load its file job. Check Activity before trying again.",
        };
      }
      if (captureJob.job.state === "failed" || captureJob.job.state === "cancelled") {
        return {
          ok: false,
          code: captureJob.job.error?.code ?? captureJob.job.state.toUpperCase(),
          error: captureJob.job.error?.customerMessage ??
            (captureJob.job.state === "cancelled" ? "Download cancelled." : "Download failed."),
        };
      }
      if (captureJob.job.state === "save_state_unknown") {
        return {
          ok: false,
          code: "START_STATE_UNKNOWN",
          error: "Chrome may already have accepted this file. Check Activity and Chrome downloads before trying again.",
        };
      }
      return { ok: true, jobId: captureJob.job.jobId };
    }
  }
  const [directs, hlses, dashes, webms] = await Promise.all([
    getDownloadJobs(),
    getHlsJobs(),
    getDashJobs(),
    getWebmTranscodeJobs(),
  ]);
  const candidates: { startedAt: number; response: DownloadResponse }[] = [];
  for (const job of Object.values(directs)) {
    if (job.commandId !== commandId) continue;
    candidates.push({
      startedAt: job.startedAt,
      response:
        job.status === "interrupted"
          ? {
              ok: false,
              code: "SAVE_INTERRUPTED",
              error: job.errorMessage ?? DIRECT_DOWNLOAD_FAILURE_MESSAGE,
            }
          : { ok: true, downloadId: job.downloadId },
    });
  }
  for (const job of Object.values(hlses)) {
    if (job.commandId === commandId) {
      candidates.push({ startedAt: job.startedAt, response: streamCommandResult(job) });
    }
  }
  for (const job of Object.values(dashes)) {
    if (job.commandId === commandId) {
      candidates.push({ startedAt: job.startedAt, response: streamCommandResult(job) });
    }
  }
  for (const job of Object.values(webms)) {
    if (job.commandId === commandId) {
      candidates.push({ startedAt: job.startedAt, response: streamCommandResult(job) });
    }
  }
  candidates.sort((a, b) => b.startedAt - a.startedAt);
  return (
    candidates[0]?.response ?? {
      ok: false,
      code: "START_STATE_UNKNOWN",
      error:
        "ClipHutch was interrupted while confirming this start. Check Chrome downloads before choosing Download again.",
    }
  );
}

const downloadCommandGate = new PersistentCommandGate<DownloadResponse>(
  downloadCommandStore,
  recoverDownloadCommand,
);

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
      childUrls?: string[];
      parsedAsMaster?: boolean;
    }
  | { ok: false; error: string };

function singleCaptureQuality(
  request: DownloadRequest,
  media: DetectedVideo,
): QualityChoiceV1 | undefined {
  if (media.kind === "direct" || media.kind === "image") return { mode: "direct" };
  if (typeof request.variantId !== "string" || request.variantId.length === 0) return undefined;
  const common = {
    mode: "stream" as const,
    policy: { mode: "manual" as const },
    ...(request.variantLabel === undefined ? {} : { label: request.variantLabel }),
    estimateConfidence: "unknown" as const,
  };
  return media.kind === "hls"
    ? { ...common, variantKind: "hls", variantUrl: request.variantId }
    : { ...common, variantKind: "dash", representationId: request.variantId };
}

async function findActiveQuickCaptureJob(
  plan: CaptureReviewPlanV1,
): Promise<{ ok: true; job: CaptureJobV1 | null } | { ok: false }> {
  const runs = await listCaptureRuns();
  if (!runs.ok) return { ok: false };
  for (const run of runs.runs) {
    if (run.status !== "queued" && run.status !== "running") continue;
    for (const jobId of run.orderedJobIds) {
      const read = await getCaptureJob(jobId);
      if (!read.ok) return { ok: false };
      if (read.job && activeJobOwnsQuickPlan(read.job, plan, read.job.snapshot.headerLeaseId)) {
        return { ok: true, job: read.job };
      }
    }
  }
  return { ok: true, job: null };
}

async function handleSingleCaptureDownload(
  request: DownloadRequest,
  media: DetectedVideo,
): Promise<DownloadResponse> {
  const existingQuick = await getQuickCaptureStartIntent(request.commandId);
  if (!existingQuick.ok) throw new QuickCaptureStartPendingError();
  if (existingQuick.intent) {
    return reconcileQuickCaptureStartIntent(existingQuick.intent);
  }
  const unresolvedQuick = await getNewestUnresolvedQuickCaptureStartIntent();
  if (!unresolvedQuick.ok) throw new QuickCaptureStartPendingError();
  if (unresolvedQuick.intent) {
    return {
      ok: false,
      code: "PREVIOUS_START_UNRESOLVED",
      error: "Reconcile the previous Quick Capture start before starting another download.",
    };
  }
  const unresolved = await getNewestUnresolvedCaptureRunIntent();
  if (!unresolved.ok) {
    return {
      ok: false,
      code: "START_STATE_UNKNOWN",
      error: "ClipHutch could not safely check pending starts. Try again after reopening the extension.",
    };
  }
  if (unresolved.intent) {
    return {
      ok: false,
      code: "PREVIOUS_START_UNRESOLVED",
      error: "Reconcile the previous Capture Pack start before starting another download.",
    };
  }

  let plannedMedia = media;
  if (!isWebmDirectVideo(media) && (media.kind === "direct" || media.kind === "image")) {
    const captured = await getCapturedHeaders(media.id);
    if (captured && hasDirectCredentialHeaders(captured)) {
      return {
        ok: false,
        code: "DIRECT_CREDENTIAL_REPLAY_REQUIRED",
        error: "This file needs an Authorization or custom access header that Chrome's native saver cannot replay yet.",
      };
    }
    const checked = await preflightCaptureNativeSources([{ itemId: media.id, url: media.url }], {
      maxConcurrency: 1,
      batchTimeoutMs: 12_000,
    });
    const result = checked[0]?.result;
    if (!result?.ok) {
      return {
        ok: false,
        code: result?.code ?? "NATIVE_SOURCE_UNAVAILABLE",
        error: result?.customerMessage ?? "ClipHutch could not verify this media source.",
      };
    }
    const verification = verifyCaptureNativeMedia({
      kind: media.kind,
      expectedContentType: media.contentType,
      observedContentType: result.contentType,
      observedSizeBytes: result.sizeBytes,
    });
    if (verification.status === "mismatch") {
      return {
        ok: false,
        code: "NATIVE_SOURCE_CHANGED",
        error: "This source now returns a different media format. Refresh the source page and try again.",
      };
    }
    if (verification.status === "verified") {
      plannedMedia = {
        ...media,
        contentType: verification.contentType,
        ...(verification.sizeBytes === undefined ? {} : { sizeBytes: verification.sizeBytes }),
      };
    }
  }

  const generatedAt = Date.now();
  const settings = await getSettings();
  const prepared = createSingleCapturePlan({
    commandId: request.commandId,
    tabId: request.tabId,
    media: plannedMedia,
    generatedAt,
    filenameTemplate: settings.filenameTemplate,
    qualityChoice: singleCaptureQuality(request, media),
  });
  if (!prepared.ok) {
    return {
      ok: false,
      code: prepared.reason === "invalid_quality" ? "QUALITY_REQUIRED" : "MEDIA_UNSUPPORTED",
      error: prepared.reason === "invalid_quality"
        ? "Choose a supported stream quality before downloading."
        : isWebmDirectVideo(media) && media.sizeBytes !== undefined
          ? `This WebM exceeds ClipHutch's ${Math.round(WEBM_TRANSCODE_SIZE_CAP_BYTES / (1024 * 1024))} MiB conversion limit.`
          : "ClipHutch could not create a safe one-file download plan for this media.",
    };
  }

  return withKeyLock(CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY, async () => {
    const unresolvedPack = await getNewestUnresolvedCaptureRunIntent();
    if (!unresolvedPack.ok) throw new QuickCaptureStartPendingError();
    if (unresolvedPack.intent) {
      return {
        ok: false,
        code: "PREVIOUS_START_UNRESOLVED",
        error: "Reconcile the previous Capture Pack start before starting another download.",
      };
    }
    const activeOwner = await findActiveQuickCaptureJob(prepared.plan);
    if (!activeOwner.ok) throw new QuickCaptureStartPendingError();
    if (activeOwner.job) return quickCaptureJobResponse(activeOwner.job);
    let quickLease: ClaimedQuickCaptureHeaderLease | null = null;
    if (quickCaptureDownloadNeedsHeaderLease(media)) {
      let preparedJob: CaptureJobV1 | undefined;
      try {
        preparedJob = prepareCaptureJobs(prepared.plan, {
          runId: `capture-run:v1:${prepared.commandUuid}`,
        })[0];
      } catch {
        preparedJob = undefined;
      }
      if (!preparedJob) {
        return {
          ok: false,
          code: "SOURCE_AUTH_FREEZE_FAILED",
          error: "ClipHutch could not freeze this page's access for the download. Reload the page and try again.",
        };
      }
      const preparedLease = await prepareQuickCaptureHeaderLease({
        commandId: request.commandId,
        sourceTabId: request.tabId,
        media,
        plan: prepared.plan,
        job: preparedJob,
        dependencies: {
          now: () => Date.now(),
          hasReplayableHeaders,
          getCapturedHeaderEntry,
          createCaptureHeaderLease,
          claimCaptureHeaderLease,
          releaseCaptureHeaderLease,
          retireClaimedCaptureHeaderLease,
          cleanupSweptCaptureLeaseDnrOwners: (leaseIds) =>
            cleanupSweptCaptureLeaseDnrOwners(leaseIds, {
              listOwners: listCaptureDnrOwners,
              removeOwner: (owner) => removeCaptureLeasedHeaderRule(owner.jobKey, owner.leaseId),
            }),
          scheduleCaptureLeaseExpiryAlarm: () => scheduleCaptureLeaseExpiryAlarm(),
        },
      });
      if (!preparedLease.ok) {
        if (preparedLease.cleanupPending) updateCaptureCleanupRetry(true);
        return { ok: false, code: preparedLease.code, error: preparedLease.error };
      }
      quickLease = preparedLease.lease;
    }
    const response = await persistAndReconcileQuickCaptureRunStart({
      commandId: request.commandId,
      plan: prepared.plan,
      licensed: await isLicensed(),
      preparedLease: quickLease,
      dependencies: quickCaptureRunDependencies(),
    });
    if (!response.ok && response.cleanupPending) updateCaptureCleanupRetry(true);
    if (!response.ok && response.pending) throw new QuickCaptureStartPendingError();
    return response;
  });
}

async function handleDownloadRequestCore(req: DownloadRequest): Promise<DownloadResponse> {
  const video = await findVideo(req.tabId, req.videoId);
  if (!video) return { ok: false, error: "Media not found in this tab." };

  // New toolbar starts use the same immutable plan, quota ledger, scheduler,
  // cancellation, recovery, and Activity model as Capture Packs. The legacy
  // code below remains for one extension-update window so already-persisted v1
  // jobs can still be reconciled by their event handlers; it is not reached by
  // new requests.
  if (req.type === "download") return handleSingleCaptureDownload(req, video);

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

  let directDownloadId: number | undefined;
  try {
    if (video.kind === "hls") {
      return await startHlsDownload(
        req,
        video,
        req.variantId,
        req.audioRenditionUrl,
        req.bypassSizeCap,
        quotaReservationId,
      );
    }

    if (video.kind === "dash") {
      return await startDashDownload(req, video, req.variantId, req.bypassSizeCap, quotaReservationId);
    }

    if (isWebmDirectVideo(video)) {
      return await startWebmTranscode(req, video, quotaReservationId);
    }

    // Header replay does NOT apply to chrome.downloads.download — those fetches
    // are initiated by the browser process, not the extension, so a DNR rule
    // scoped to initiatorDomains: [chrome.runtime.id] cannot match them. There
    // is no MV3-supported way to inject Referer / Authorization on a
    // chrome.downloads.download fetch. Direct files relying on cookies still
    // work because the browser attaches them automatically.
    const directSettings = await getSettings();
    directDownloadId = await chrome.downloads.download({
      url: video.url,
      filename: inferFilename(video, { template: directSettings.filenameTemplate }),
      conflictAction: "uniquify",
      saveAs: false,
    });
    if (directDownloadId === undefined) {
      await releaseDownloadReservation(quotaReservationId);
      return { ok: false, error: DIRECT_DOWNLOAD_FAILURE_MESSAGE };
    }
    await setDownloadJob({
      commandId: req.commandId,
      videoId: video.id,
      tabId: req.tabId,
      downloadId: directDownloadId,
      kind: video.kind,
      startedAt: Date.now(),
      status: "in_progress",
      countsAgainstQuota: Boolean(quotaReservationId),
      quotaRecorded: Boolean(quotaReservationId),
      quotaReservationId,
    });
    return { ok: true, downloadId: directDownloadId };
  } catch (err) {
    // Chrome accepted the save before session-job persistence failed. Treat
    // that as accepted so the customer is never invited to start a duplicate.
    if (directDownloadId !== undefined) {
      return { ok: true, downloadId: directDownloadId };
    }
    // A stream job is persisted before offscreen setup. If a later setup step
    // throws, return that existing command-tagged job instead of inviting a
    // second start. The job remains visible and cancellable in the popup.
    if (video.kind === "hls" || video.kind === "dash" || isWebmDirectVideo(video)) {
      const recovered = await recoverDownloadCommand(req.commandId).catch(() => undefined);
      if (recovered && (recovered.ok || recovered.code !== "START_STATE_UNKNOWN")) {
        return recovered;
      }
    }
    await releaseDownloadReservation(quotaReservationId);
    return {
      ok: false,
      error: err instanceof Error && err.message ? err.message : DIRECT_DOWNLOAD_FAILURE_MESSAGE,
    };
  }
}

async function handleDownloadRequest(req: DownloadRequest): Promise<DownloadResponse> {
  if (!isDownloadCommandId(req.commandId)) {
    return {
      ok: false,
      code: "INVALID_COMMAND",
      error: "This download request is missing a valid customer-intent identifier.",
    };
  }
  try {
    return await downloadCommandGate.run(req.commandId, () => handleDownloadRequestCore(req));
  } catch {
    return {
      ok: false,
      code: "COMMAND_STATE_UNAVAILABLE",
      error:
        "ClipHutch could not safely confirm whether this start was accepted. Check Chrome downloads before choosing Download again.",
    };
  }
}

async function handleDomImagesDetected(
  message: DomImagesDetectedMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  if (
    tabId === undefined || !Array.isArray(message.images) ||
    message.images.length === 0 || message.images.length > 500
  ) return;

  const detected: DetectedVideo[] = [];
  const detectedAt = Date.now();
  for (const image of message.images) {
    if (!image || typeof image.url !== "string") continue;
    const cls = classifyUrl(image.url);
    const semanticImageEvidence = Array.isArray(image.provenance) &&
      image.provenance.some((entry) =>
        entry === "rendered-image" ||
        entry === "picture" ||
        entry === "metadata" ||
        entry === "poster"
      );
    const isRenderedUnknownImage =
      cls.kind === "unknown" &&
      (semanticImageEvidence ||
        (image.source === "rendered-image" &&
          typeof image.width === "number" &&
          typeof image.height === "number"));
    if (cls.kind !== "image" && !isRenderedUnknownImage) continue;
    detected.push({
      id: createDetectedMediaRecordId(tabId),
      url: image.url,
      kind: "image",
      detectedAt,
      pageUrl: message.pageUrl,
      pageTitle: message.pageTitle,
      width: image.width,
      height: image.height,
      provenance: image.provenance,
      familyId: image.familyId,
    });
  }

  if (detected.length > 0) {
    await withKeyLock(
      CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY,
      () => addOrUpdateVideos(tabId, detected),
    );
    await updateBadge(tabId);
  }
}

async function handleContentPageContext(
  message: ContentPageContextMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || typeof message.pageUrl !== "string") return;
  try {
    await withKeyLock(
      CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY,
      () => retainDetectedVideosForPage(tabId, message.pageUrl!),
    );
    await updateBadge(tabId);
  } catch {
    // Non-web and malformed page contexts cannot own a media shelf.
  }
}

function isTrustedExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.tab !== undefined || typeof sender.url !== "string") return false;
  try {
    return (
      new URL(sender.url).origin ===
      new URL(chrome.runtime.getURL("/")).origin
    );
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const m = message as { type?: string };
  if (isLicenseRuntimeMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) return false;
    void handleLicenseRuntimeMessage(message).then(sendResponse);
    return true;
  }
  const captureDraftRequest = parseCaptureDraftUiRequest(message);
  if (captureDraftRequest) {
    if (!isTrustedExtensionPageSender(sender)) return false;
    const executeDraftRequest = async () => {
      const response = await handleCaptureDraftUiRequest(captureDraftRequest, {
        getDraft: getActiveCaptureDraft,
        applyCommand: applyCaptureDraftCommand,
        listDetectedMedia: getDetectedVideos,
        prepareHeaderLease: prepareCaptureDraftHeaderLease,
        releaseDraftHeaderLease: releaseCaptureDraftHeaderLease,
        now: () => Date.now(),
      });
      if (
        captureDraftRequest.type !== "capture-draft-get" &&
        response.ok &&
        response.draft?.orderedItemIds.length === 0
      ) {
        const reviewStateClean = await reconcileClearedCaptureReviewState();
        if (!reviewStateClean) updateCaptureCleanupRetry(true);
        void scheduleCaptureQueueDrain();
      }
      return response;
    };
    const draftResponse = captureDraftRequest.type === "capture-draft-get"
      ? executeDraftRequest()
      : withKeyLock(CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY, executeDraftRequest);
    void draftResponse.then(sendResponse).catch(() => {
      sendResponse({
        ok: false,
        reason: "storage_unavailable",
        operation: "read",
        draft: null,
      });
    });
    return true;
  }
  const captureReviewRequest = parseCaptureReviewUiRequest(message);
  if (captureReviewRequest) {
    if (!isTrustedExtensionPageSender(sender)) return false;
    if (captureReviewRequest.type === "capture-plan-create") {
      void handleCapturePlanCreate(captureReviewRequest).then(sendResponse).catch(() => {
        sendResponse({
          ok: false,
          reason: "plan_unavailable",
          draft: null,
        });
      });
    } else if (captureReviewRequest.type === "capture-run-enqueue") {
      void withKeyLock(
        CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY,
        () => handleCaptureRunEnqueue(captureReviewRequest),
      ).then(sendResponse).catch(() => {
        sendResponse({ ok: false, reason: "enqueue_unavailable" });
      });
    } else if (captureReviewRequest.type === "capture-job-cancel") {
      void handleCaptureJobCancel(captureReviewRequest).then(sendResponse).catch(() => {
        sendResponse({ ok: false, reason: "cancel_unavailable" });
      });
    } else if (captureReviewRequest.type === "capture-quick-reconcile") {
      void handleCaptureQuickReconcile(captureReviewRequest).then(sendResponse).catch(() => {
        sendResponse({
          ok: false,
          code: "START_STATE_UNKNOWN",
          error: "ClipHutch could not safely reconcile this Quick Capture yet.",
        });
      });
    } else if (captureReviewRequest.type === "capture-manifest-retry") {
      void withKeyLock(
        CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY,
        () => withKeyLock(
          CAPTURE_ATTEMPT_SIDE_EFFECTS_LOCK_KEY,
          () => handleCaptureManifestRetry(captureReviewRequest),
        ),
      ).then(sendResponse).catch(() => {
        sendResponse({ ok: false, reason: "manifest_retry_unavailable" });
      });
    } else {
      void handleCaptureWorkspaceGet().then(sendResponse).catch(() => {
        sendResponse({ ok: false, reason: "workspace_unavailable" });
      });
    }
    return true;
  }
  if (m.type === "download") {
    if (!isTrustedExtensionPageSender(sender)) return false;
    void handleDownloadRequest(message as DownloadRequest).then(sendResponse);
    return true;
  }
  if (m.type === "list-variants") {
    if (!isTrustedExtensionPageSender(sender)) return false;
    void handleListVariantsRequest(message as ListVariantsRequest).then(sendResponse);
    return true;
  }
  if (m.type === "dom-images-detected") {
    void handleDomImagesDetected(message as DomImagesDetectedMessage, sender).catch(() => {});
    return false;
  }
  if (m.type === "content-page-context") {
    void handleContentPageContext(message as ContentPageContextMessage, sender).catch(() => {});
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
    })) as { ok: true; kind: "hls" | "dash"; variants: VariantOption[]; durationSec?: number; childUrls?: string[]; parsedAsMaster?: boolean } | { ok: false; error: string };

    if (!result || result.ok === false) {
      return { ok: false, error: (result && "error" in result && result.error) || "Manifest fetch failed" };
    }

    if (
      video.kind === "hls" &&
      (result.parsedAsMaster === true || (result.childUrls && result.childUrls.length > 0))
    ) {
      await withKeyLock(
        CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY,
        () => addOrUpdateVideo(req.tabId, {
          ...video,
          ...(result.childUrls && result.childUrls.length > 0 ? { childUrls: result.childUrls } : {}),
          ...(result.parsedAsMaster === true ? { parsedAsMaster: true } : {}),
        }),
      );
    }

    const settings = await getSettings();
    return { ...result, sizeCapBytes: settings.hlsSizeCapBytes };
  } finally {
    await removeHeaderReplayRule(lookupKey);
  }
}

type CaptureDraftVariantPreflight = {
  itemId: string;
  entries: CaptureVariantPreflightEntryV1[];
  error?: { code: string; customerMessage: string };
};

const CAPTURE_VARIANT_INSPECT_DEADLINE_MS = 30_000;

async function discardCaptureExecutionSnapshot(
  executionSnapshotId: string,
): Promise<void> {
  const message: CaptureExecutionSnapshotDiscardMessageV1 = {
    type: "capture-execution-snapshot-discard",
    executionSnapshotId,
  };
  // A structured-clone/message-port race can make an otherwise healthy
  // offscreen document miss one acknowledgement. Retrying the same opaque,
  // idempotent command is safe and keeps capacity recovery deterministic.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (parseCaptureExecutionSnapshotDiscardResponseV1(response)) return;
    } catch {
      // The offscreen document may already have closed, which also destroys
      // its in-memory cache. One immediate retry covers a live port race.
    }
  }
}

type CaptureNormalizedVariantInspection =
  | {
      ok: true;
      options: NormalizedVariantV1[];
      /** Fresh manifest locators, held only for this inspection call. */
      executionSourceByStableId: Map<
        string,
        { sourceId: string; audioSourceId?: string }
      >;
      executionSnapshotId?: string;
    }
  | { ok: false; code: CaptureVariantInspectErrorCodeV1 | "INVALID_RESPONSE" | "NORMALIZATION_FAILED" };
type CaptureVariantInspectionFailureCode = Extract<
  CaptureNormalizedVariantInspection,
  { ok: false }
>["code"];

async function inspectNormalizedCaptureVariants(input: {
  requestId: string;
  reviewId: string;
  url: string;
  kind: "hls" | "dash";
  deadlineAt: number;
  retainForExecution?: true;
}): Promise<CaptureNormalizedVariantInspection> {
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage({
      type: "capture-variant-inspect",
      requestId: input.requestId,
      reviewId: input.reviewId,
      url: input.url,
      kind: input.kind,
      deadlineAt: input.deadlineAt,
      ...(input.retainForExecution ? { retainForExecution: true } : {}),
    });
  } catch {
    return { ok: false, code: "FETCH_FAILED" };
  }
  const parsed = parseCaptureVariantInspectResponseV1(response);
  if (!parsed) return { ok: false, code: "INVALID_RESPONSE" };
  if (!parsed.ok) return parsed;
  if (!input.retainForExecution && parsed.executionSnapshotId !== undefined) {
    await discardCaptureExecutionSnapshot(parsed.executionSnapshotId);
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  if (input.retainForExecution && parsed.executionSnapshotId === undefined) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  const retainedSnapshotId = parsed.executionSnapshotId;
  let transferred = false;
  try {
    const normalized = await normalizeVariantOptionsV1({
      kind: input.kind,
      variants: parsed.variants,
    });
    if (!normalized.ok || normalized.options.length !== parsed.variants.length) {
      return { ok: false, code: "NORMALIZATION_FAILED" };
    }
    const executionSourceByStableId = new Map<
      string,
      { sourceId: string; audioSourceId?: string }
    >();
    for (let index = 0; index < normalized.options.length; index += 1) {
      executionSourceByStableId.set(
        normalized.options[index].stableId,
        {
          sourceId: parsed.variants[index].sourceId,
          ...(parsed.variants[index].audioSourceId === undefined
            ? {}
            : { audioSourceId: parsed.variants[index].audioSourceId }),
        },
      );
    }
    transferred = retainedSnapshotId !== undefined;
    return {
      ok: true,
      options: normalized.options,
      executionSourceByStableId,
      ...(retainedSnapshotId === undefined
        ? {}
        : { executionSnapshotId: retainedSnapshotId }),
    };
  } catch {
    return { ok: false, code: "NORMALIZATION_FAILED" };
  } finally {
    if (retainedSnapshotId !== undefined && !transferred) {
      await discardCaptureExecutionSnapshot(retainedSnapshotId);
    }
  }
}

function captureVariantInspectionFailure(
  code: CaptureVariantInspectionFailureCode,
): { code: string; customerMessage: string } {
  if (code === "DEADLINE_EXCEEDED" || code === "INVALID_DEADLINE") {
    return {
      code: "STREAM_PREFLIGHT_TIMEOUT",
      customerMessage: "The stream took too long to inspect. Refresh the source page and try Review again.",
    };
  }
  if (code === "RESPONSE_TOO_LARGE" || code === "REVIEW_BUDGET_EXCEEDED") {
    return {
      code: "STREAM_MANIFEST_TOO_LARGE",
      customerMessage: "This stream uses more manifest data than ClipHutch's bounded local inspector accepts.",
    };
  }
  if (code === "TOO_MANY_VARIANTS") {
    return {
      code: "STREAM_OPTION_LIMIT",
      customerMessage: "This stream exposes too many qualities for one bounded Capture Pack review.",
    };
  }
  if (code === "UNSUPPORTED_MANIFEST") {
    return {
      code: "STREAM_MANIFEST_UNSUPPORTED",
      customerMessage: "This stream uses a manifest layout ClipHutch cannot safely download yet.",
    };
  }
  return {
    code: "STREAM_PREFLIGHT_FAILED",
    customerMessage: "ClipHutch could not inspect the available stream qualities.",
  };
}

async function preflightCaptureDraftStream(
  item: CaptureDraftItemV1,
  commandId: string,
  leaseResolution: CaptureDraftLeaseResolution,
  maxDownloadBytes: number,
  deadlineAt: number,
): Promise<CaptureDraftVariantPreflight> {
  const kind = item.media.kind;
  if (kind !== "hls" && kind !== "dash") return { itemId: item.itemId, entries: [] };
  if (!leaseResolution.ok) {
    return {
      itemId: item.itemId,
      entries: [],
      error: leaseResolution.reason === "expired"
        ? {
            code: "SOURCE_AUTH_EXPIRED",
            customerMessage: "Source authorization expired. Reopen the source page and add this stream again.",
          }
        : {
            code: "SOURCE_AUTH_UNAVAILABLE",
            customerMessage: "ClipHutch could not safely read this stream's selected authorization snapshot.",
          },
    };
  }
  try {
    await ensureOffscreenDocument();
  } catch {
    return {
      itemId: item.itemId,
      entries: [],
      error: {
        code: "OFFSCREEN_INIT",
        customerMessage: "ClipHutch could not start its local stream inspector.",
      },
    };
  }

  const lookupKey = `capture:review:${commandId}:${item.itemId}`;
  const inspect = async (): Promise<CaptureDraftVariantPreflight> => {
    try {
      const replayReady = leaseResolution.lease
        ? await installCaptureLeasedHeaderRule({
            jobKey: lookupKey,
            ownerKind: "review",
            lease: leaseResolution.lease,
          })
        : true;
      if (!replayReady) {
        return {
          itemId: item.itemId,
          entries: [],
          error: {
            code: "SOURCE_AUTH_UNAVAILABLE",
            customerMessage: "ClipHutch could not safely reuse this stream's page authorization.",
          },
        };
      }
      const inspection = await inspectNormalizedCaptureVariants({
        requestId: `${commandId}:${item.itemId}`,
        reviewId: commandId,
        url: item.media.url,
        kind,
        deadlineAt,
      });
      if (!inspection.ok) {
        return {
          itemId: item.itemId,
          entries: [],
          error: captureVariantInspectionFailure(inspection.code),
        };
      }
      const normalized = await buildCaptureVariantPreflight({
        itemId: item.itemId,
        kind,
        variants: inspection.options,
        maxDownloadBytes,
      });
      return normalized.ok
        ? {
            itemId: item.itemId,
            entries: normalized.entries,
            ...(normalized.entries.some((entry) => entry.manualQualityChoice)
              ? {}
              : {
                  error: {
                    code: "STREAM_NO_SUPPORTED_VARIANTS",
                    customerMessage: "This stream has no supported quality within your saved hard size cap.",
                  },
                }),
          }
        : {
            itemId: item.itemId,
            entries: [],
            error: { code: normalized.code, customerMessage: normalized.customerMessage },
          };
    } catch {
      return {
        itemId: item.itemId,
        entries: [],
        error: {
          code: "STREAM_PREFLIGHT_FAILED",
          customerMessage: "ClipHutch could not inspect the available stream qualities.",
        },
      };
    }
  };
  activeCaptureReviewRuleKeys.add(lookupKey);
  let result: CaptureDraftVariantPreflight;
  try {
    result = await inspect();
  } finally {
    activeCaptureReviewRuleKeys.delete(lookupKey);
  }
  if (
    leaseResolution.lease &&
    !await removeCaptureLeasedHeaderRule(lookupKey, leaseResolution.lease.leaseId)
  ) {
    // A live Review rule intentionally blocks the heavy lane. Retry cleanup
    // immediately after the inspector releases that rule, even when the
    // bounded background retry budget elapsed during a slow preflight.
    void scheduleCaptureQueueDrain();
    return {
      itemId: item.itemId,
      entries: [],
      error: {
        code: "SOURCE_AUTH_CLEANUP_PENDING",
        customerMessage: "ClipHutch could not safely clear this stream's temporary review access. Try Review again.",
      },
    };
  }
  // The last live Review rule may have been the only thing holding the heavy
  // lane. Wake the queue now instead of waiting for unrelated extension work.
  void scheduleCaptureQueueDrain();
  return result;
}

async function preflightCaptureDraftStreams(
  draft: CaptureDraftV1,
  commandId: string,
  leaseResolutions: ReadonlyMap<string, CaptureDraftLeaseResolution>,
  maxDownloadBytes: number,
): Promise<CaptureDraftVariantPreflight[]> {
  const items = draft.orderedItemIds
    .map((itemId) => draft.items[itemId])
    .filter((item) => item.media.kind === "hls" || item.media.kind === "dash");
  const results = new Array<CaptureDraftVariantPreflight>(items.length);
  let nextIndex = 0;
  const deadlineAt = Date.now() + CAPTURE_VARIANT_INSPECT_DEADLINE_MS;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await preflightCaptureDraftStream(
        items[index],
        commandId,
        leaseResolutions.get(items[index].itemId) ?? { ok: true, lease: null },
        maxDownloadBytes,
        deadlineAt,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
  return results;
}

function captureDraftItemIsWebm(item: CaptureDraftItemV1): boolean {
  if (item.media.kind !== "direct") return false;
  if (item.media.contentType?.split(";")[0].trim().toLowerCase() === "video/webm") return true;
  try {
    return new URL(item.media.url).pathname.toLowerCase().endsWith(".webm");
  } catch {
    return false;
  }
}

function capturePlanId(commandId: string): string {
  return `capture-review-v1:${commandId.slice("capture-plan-".length)}`;
}

const CAPTURE_PLAN_DECISION_LOCK_KEY = "capture-plan-decision-v1";
const CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY = "capture-draft-acceptance-v1";
const CAPTURE_ATTEMPT_SIDE_EFFECTS_LOCK_KEY = "capture-attempt-side-effects-v1";
const capturePlanRequests = new Map<string, Promise<unknown>>();
const activeCaptureReviewRuleKeys = new Set<string>();
const activeCaptureStartingRuleKeys = new Set<string>();

function captureLeaseReplayKind(
  kind: CaptureDraftItemV1["media"]["kind"],
): CaptureHeaderLeaseBindingV1["replayKind"] {
  return kind === "hls" || kind === "dash" ? kind : "direct";
}

function captureHeaderLeaseIdForCommand(commandId: string): string {
  return `capture-header-lease-v1:${commandId.slice("capture-draft-".length).toLowerCase()}`;
}

function captureLeaseBindingForItem(
  draftId: string,
  item: CaptureDraftItemV1,
): CaptureHeaderLeaseBindingV1 | undefined {
  if (
    !item.headerLeaseId ||
    item.sourceTabId === undefined ||
    item.media.pageUrl === undefined
  ) return undefined;
  return {
    leaseId: item.headerLeaseId,
    draftId,
    itemId: item.itemId,
    mediaId: item.media.mediaId,
    sourceTabId: item.sourceTabId,
    pageUrl: item.media.pageUrl,
    sourceUrl: item.media.url,
    replayKind: captureLeaseReplayKind(item.media.kind),
  };
}

async function prepareCaptureDraftHeaderLease(input: {
  commandId: string;
  draftId: string;
  itemId: string;
  sourceTabId: number;
  media: CaptureDraftItemV1["media"];
  hasCapturedReplayHeaders: boolean;
}): Promise<{ ok: true; headerLeaseId?: string } | { ok: false }> {
  const entry = await getCapturedHeaderEntry(input.media.mediaId);
  if (!entry) {
    return input.hasCapturedReplayHeaders ? { ok: false } : { ok: true };
  }
  if (entry.tabId !== input.sourceTabId) return { ok: false };
  if (!hasReplayableHeaders(entry.headers)) {
    return input.hasCapturedReplayHeaders ? { ok: false } : { ok: true };
  }
  if (input.media.pageUrl === undefined) return { ok: false };
  const leaseId = captureHeaderLeaseIdForCommand(input.commandId);
  const created = await createCaptureHeaderLease({
    leaseId,
    draftId: input.draftId,
    itemId: input.itemId,
    mediaId: input.media.mediaId,
    sourceTabId: input.sourceTabId,
    pageUrl: input.media.pageUrl,
    sourceUrl: input.media.url,
    replayKind: captureLeaseReplayKind(input.media.kind),
    authoritativeHeaders: entry.headers,
    now: Date.now(),
  });
  if (!created.ok) return { ok: false };
  const expiredRulesRemoved = await cleanupSweptCaptureLeaseDnrOwners(
    created.sweptExpiredLeaseIds,
    {
      listOwners: listCaptureDnrOwners,
      removeOwner: (owner) => removeCaptureLeasedHeaderRule(owner.jobKey, owner.leaseId),
    },
  );
  if (!expiredRulesRemoved || !await scheduleCaptureLeaseExpiryAlarm()) {
    // Do not attach a sensitive lease to the Hutch unless Chrome has accepted
    // the wake that enforces its physical TTL.
    await releaseCaptureHeaderLease({
      leaseId: created.lease.leaseId,
      draftId: input.draftId,
      itemId: input.itemId,
      mediaId: input.media.mediaId,
      sourceTabId: input.sourceTabId,
      pageUrl: input.media.pageUrl,
      sourceUrl: input.media.url,
      replayKind: captureLeaseReplayKind(input.media.kind),
      owner: { kind: "draft_item" },
      now: Date.now(),
    });
    updateCaptureCleanupRetry(true);
    void scheduleCaptureQueueDrain();
    return { ok: false };
  }
  // Creating a lease can atomically prune an older expired lease record. Run
  // DNR reconciliation now so any independently stored expired rule is also
  // removed before more extension fetches begin.
  void scheduleCaptureQueueDrain();
  return { ok: true, headerLeaseId: created.lease.leaseId };
}

async function releaseCaptureDraftHeaderLease(input: {
  draftId: string;
  item: CaptureDraftItemV1;
}): Promise<void> {
  const binding = captureLeaseBindingForItem(input.draftId, input.item);
  if (!binding) return;
  const released = await releaseCaptureHeaderLease({
    ...binding,
    owner: { kind: "draft_item" },
    now: Date.now(),
  });
  if (!released.ok && released.reason !== "lease_not_found" && released.reason !== "lease_expired") {
    updateCaptureCleanupRetry(true);
    void scheduleCaptureQueueDrain();
    throw new Error("Capture header lease cleanup needs reconciliation.");
  }
  void scheduleCaptureLeaseExpiryAlarm();
  void scheduleCaptureQueueDrain();
}

type CaptureDraftLeaseResolution =
  | { ok: true; lease: CaptureHeaderLeaseV1 | null }
  | { ok: false; reason: "expired" | "unavailable" };

async function resolveCaptureDraftHeaderLease(
  draftId: string,
  item: CaptureDraftItemV1,
  now = Date.now(),
): Promise<CaptureDraftLeaseResolution> {
  if (!item.headerLeaseId) return { ok: true, lease: null };
  const binding = captureLeaseBindingForItem(draftId, item);
  if (!binding) return { ok: false, reason: "expired" };
  const result = await getCaptureHeaderLease({ ...binding, now });
  if (!result.ok) {
    return result.reason === "lease_expired" ||
      result.reason === "lease_not_found" ||
      result.reason === "binding_conflict"
      ? { ok: false, reason: "expired" }
      : { ok: false, reason: "unavailable" };
  }
  return result.lease
    ? { ok: true, lease: result.lease }
    : { ok: false, reason: "expired" };
}

async function resolveCaptureDraftHeaderLeases(
  draft: CaptureDraftV1,
  now = Date.now(),
): Promise<Map<string, CaptureDraftLeaseResolution>> {
  const entries = await Promise.all(draft.orderedItemIds.map(async (itemId) => [
    itemId,
    await resolveCaptureDraftHeaderLease(draft.draftId, draft.items[itemId], now),
  ] as const));
  return new Map(entries);
}

async function installCaptureLeasedHeaderRule(input: {
  jobKey: string;
  ownerKind: CaptureDnrOwnerKind;
  lease: CaptureHeaderLeaseV1;
  validateBeforeInstall?: () => Promise<boolean>;
}): Promise<boolean> {
  return withKeyLock(`capture-dnr-rule-op:${input.jobKey}`, async () => {
  if (input.validateBeforeInstall && !await input.validateBeforeInstall()) return false;
  if (Date.now() >= input.lease.expiresAt) return false;
  const claimed = await claimCaptureDnrOwner({
    jobKey: input.jobKey,
    leaseId: input.lease.leaseId,
    ownerKind: input.ownerKind,
    replayScope: input.lease.replayScope,
    expiresAt: input.lease.expiresAt,
  });
  if (!claimed.ok) return false;
  if (Date.now() >= input.lease.expiresAt) {
    await releaseCaptureDnrOwner({
      jobKey: input.jobKey,
      leaseId: input.lease.leaseId,
    });
    return false;
  }
  const rule = buildCaptureDnrSessionRule({
    owner: claimed.owner,
    captured: input.lease.headers,
    extensionId: chrome.runtime.id,
  });
  if (!rule) {
    await releaseCaptureDnrOwner({
      jobKey: input.jobKey,
      leaseId: input.lease.leaseId,
    });
    return false;
  }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [claimed.owner.ruleId],
      addRules: [rule],
    });
    if (Date.now() >= input.lease.expiresAt) {
      await removeCaptureLeasedHeaderRuleUnlocked(input.jobKey, input.lease.leaseId);
      return false;
    }
    return true;
  } catch {
    // Keep the metadata owner. Cleanup/recovery can remove an ambiguously
    // installed rule, while the caller must not start a fetch it cannot scope.
    return false;
  }
  });
}

async function removeCaptureLeasedHeaderRule(
  jobKey: string,
  expectedLeaseId?: string,
): Promise<boolean> {
  return withKeyLock(
    `capture-dnr-rule-op:${jobKey}`,
    () => removeCaptureLeasedHeaderRuleUnlocked(jobKey, expectedLeaseId),
  );
}

async function removeCaptureLeasedHeaderRuleUnlocked(
  jobKey: string,
  expectedLeaseId?: string,
): Promise<boolean> {
  for (const delayMs of [0, 50, 250]) {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    const listed = await listCaptureDnrOwners();
    if (!listed.ok) continue;
    const owner = listed.owners.find((candidate) => candidate.jobKey === jobKey);
    if (!owner) return true;
    if (expectedLeaseId !== undefined && owner.leaseId !== expectedLeaseId) return false;

    let removed = false;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [owner.ruleId] });
      removed = true;
    } catch {
      try {
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        removed = !rules.some((rule) => rule.id === owner.ruleId);
      } catch {
        removed = false;
      }
    }
    if (!removed) continue;
    const released = await releaseCaptureDnrOwner({ jobKey, leaseId: owner.leaseId });
    if (released.ok || released.reason === "owner_not_found") return true;
  }
  return false;
}

function withCapturePlanDecision<T>(task: () => Promise<T>): Promise<T> {
  return withKeyLock(CAPTURE_PLAN_DECISION_LOCK_KEY, () =>
    withKeyLock(CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY, task));
}

async function handleCapturePlanCreate(request: CapturePlanCreateRequest): Promise<unknown> {
  const existing = capturePlanRequests.get(request.commandId);
  if (existing) return existing;
  const operation = handleCapturePlanCreateUnlocked(request).finally(() => {
    if (capturePlanRequests.get(request.commandId) === operation) {
      capturePlanRequests.delete(request.commandId);
    }
  });
  capturePlanRequests.set(request.commandId, operation);
  return operation;
}

async function replayCapturePlanRecordLocked(
  planId: string,
  record: CapturePlanOptionsRecordV1,
): Promise<unknown> {
  const draft = await getActiveCaptureDraft();
  if (!draft.ok || !draft.draft) {
    return { ok: false, reason: "draft_unavailable", draft: null };
  }
  if (draft.draft.draftId !== record.draftId || draft.draft.revision !== record.draftRevision) {
    return {
      ok: false,
      reason: "revision_conflict",
      draft: draft.draft,
      actualRevision: draft.draft.revision,
    };
  }
  const active = await getActiveCaptureReviewPlan();
  if (!active.ok) return { ok: false, reason: "plan_storage_unavailable", draft: null };
  if (active.plan && active.plan.planId !== planId) {
    return { ok: false, reason: "plan_superseded", draft: null };
  }
  if (active.plan?.planId === planId) {
    if (JSON.stringify(active.plan) !== JSON.stringify(record.plan)) {
      return { ok: false, reason: "plan_storage_unavailable", draft: null };
    }
    if (record.state === "prepared") {
      const committed = await saveCapturePlanOptions({ ...record, state: "committed" });
      if (!committed.ok) return { ok: false, reason: "plan_storage_unavailable", draft: null };
    }
    return { ok: true, plan: record.plan, options: record.options };
  }
  if (record.state === "committed") {
    return { ok: false, reason: "plan_replay_unavailable", draft: null };
  }
  const repaired = await saveCaptureReviewPlan(record.plan);
  if (!repaired.ok) {
    return {
      ok: false,
      reason: repaired.reason === "conflict" ? "plan_superseded" : "plan_storage_unavailable",
      draft: null,
    };
  }
  const committed = await saveCapturePlanOptions({ ...record, state: "committed" });
  if (!committed.ok) return { ok: false, reason: "plan_storage_unavailable", draft: null };
  return { ok: true, plan: repaired.plan, options: record.options };
}

async function handleCapturePlanCreateUnlocked(request: CapturePlanCreateRequest): Promise<unknown> {
  const planId = capturePlanId(request.commandId);
  const [unresolvedBeforePreflight, quickBeforePreflight] = await Promise.all([
    getNewestUnresolvedCaptureRunIntent(),
    getNewestUnresolvedQuickCaptureStartIntent(),
  ]);
  if (!unresolvedBeforePreflight.ok || !quickBeforePreflight.ok) {
    return { ok: false, reason: "plan_storage_unavailable", draft: null };
  }
  if (unresolvedBeforePreflight.intent || quickBeforePreflight.intent) {
    // Every unresolved run depends on its retained immutable plan. Block plan
    // supersession until replay settles it so bounded plan retention cannot
    // prune the sole recovery input.
    return { ok: false, reason: "unresolved_start", draft: null };
  }
  const retainedOptions = await getCapturePlanOptions(planId);
  if (!retainedOptions.ok) {
    return { ok: false, reason: "plan_storage_unavailable", draft: null };
  }
  if (retainedOptions.record && !capturePlanOptionRequestMatches(retainedOptions.record, {
    commandId: request.commandId,
    draftId: request.draftId,
    draftRevision: request.expectedRevision,
    choices: request.choices,
  })) {
    return { ok: false, reason: "plan_command_conflict", draft: null };
  }
  if (retainedOptions.record) {
    return withCapturePlanDecision(async () => {
      const [unresolved, quickUnresolved] = await Promise.all([
        getNewestUnresolvedCaptureRunIntent(),
        getNewestUnresolvedQuickCaptureStartIntent(),
      ]);
      if (!unresolved.ok || !quickUnresolved.ok) {
        return { ok: false, reason: "plan_storage_unavailable", draft: null };
      }
      if (unresolved.intent || quickUnresolved.intent) {
        return { ok: false, reason: "unresolved_start", draft: null };
      }
      return replayCapturePlanRecordLocked(planId, retainedOptions.record!);
    });
  }

  const existing = await getCaptureReviewPlan(planId);
  if (!existing.ok) return { ok: false, reason: "plan_storage_unavailable", draft: null };
  if (existing.plan) {
    // The plan predates/missed its response journal. Its variant options cannot
    // be reconstructed without changing the command's meaning.
    return { ok: false, reason: "plan_replay_unavailable", draft: null };
  }

  const draftResult = await getActiveCaptureDraft();
  if (!draftResult.ok || !draftResult.draft) {
    return { ok: false, reason: "draft_unavailable", draft: draftResult.ok ? null : null };
  }
  const draft = draftResult.draft;
  if (draft.draftId !== request.draftId || draft.revision !== request.expectedRevision) {
    return {
      ok: false,
      reason: "revision_conflict",
      draft,
      actualRevision: draft.revision,
    };
  }

  const selectorByItemId = new Map(request.choices.map((choice) => [choice.itemId, choice.optionId]));
  if (request.choices.some((choice) => !Object.prototype.hasOwnProperty.call(draft.items, choice.itemId))) {
    return { ok: false, reason: "unknown_item_choice", draft };
  }
  if (request.choices.some((choice) => {
    const kind = draft.items[choice.itemId].media.kind;
    return kind !== "hls" && kind !== "dash";
  })) {
    return { ok: false, reason: "choice_not_allowed", draft };
  }

  let captureSettings: UserSettings;
  try {
    captureSettings = await getSettings();
  } catch {
    return { ok: false, reason: "plan_storage_unavailable", draft };
  }
  const captureQualityPolicy = captureSettings.capturePackQualityMode === "best_under_cap"
    ? {
        mode: "best_under_cap" as const,
        maxEstimatedBytes: captureSettings.hlsSizeCapBytes,
        ...(captureSettings.capturePackMaxHeight === undefined
          ? {}
          : { maxHeight: captureSettings.capturePackMaxHeight }),
      }
    : { mode: "manual" as const };

  let leaseResolutions: Map<string, CaptureDraftLeaseResolution>;
  try {
    leaseResolutions = await resolveCaptureDraftHeaderLeases(draft);
  } catch {
    return { ok: false, reason: "plan_storage_unavailable", draft };
  }
  if ([...leaseResolutions.values()].some(
    (resolution) => !resolution.ok && resolution.reason === "unavailable",
  )) {
    return { ok: false, reason: "plan_storage_unavailable", draft };
  }
  const expiredLeaseItemIds = new Set(
    [...leaseResolutions.entries()].flatMap(([itemId, resolution]) =>
      !resolution.ok && resolution.reason === "expired" ? [itemId] : []),
  );
  const preflights = await preflightCaptureDraftStreams(
    draft,
    request.commandId,
    leaseResolutions,
    captureSettings.hlsSizeCapBytes,
  );
  const optionBudget = applyCaptureVariantOptionBudget(
    preflights.map((preflight) => preflight.entries),
  );
  for (const index of optionBudget.overflowGroupIndexes) {
    const preflight = preflights[index];
    if (preflight) {
      preflight.entries = [];
      preflight.error = {
        code: "STREAM_OPTION_LIMIT",
        customerMessage: "This stream exposes too many qualities for one bounded Capture Pack review. Remove it or review it separately.",
      };
    }
  }
  const preflightByItemId = new Map(preflights.map((entry) => [entry.itemId, entry]));
  const nativeHeaderBlockedItemIds = new Set(draft.orderedItemIds.filter((itemId) => {
    const item = draft.items[itemId];
    const resolution = leaseResolutions.get(itemId);
    return (
      (item.media.kind === "direct" || item.media.kind === "image") &&
      !captureDraftItemIsWebm(item) &&
      resolution?.ok === true &&
      resolution.lease !== null &&
      hasDirectCredentialHeaders(resolution.lease.headers)
    );
  }));

  let nativePreflightByItemId = new Map<
    string,
    Awaited<ReturnType<typeof preflightCaptureNativeSources>>[number]["result"]
  >();
  try {
    const nativePreflights = await preflightCaptureNativeSources(
      draft.orderedItemIds.flatMap((itemId) => {
        const item = draft.items[itemId];
        return (
          (item.media.kind === "direct" || item.media.kind === "image") &&
          !captureDraftItemIsWebm(item) &&
          !nativeHeaderBlockedItemIds.has(itemId) &&
          !expiredLeaseItemIds.has(itemId)
        )
          ? [{ itemId, url: item.media.url }]
          : [];
      }),
    );
    nativePreflightByItemId = new Map(
      nativePreflights.map((entry) => [entry.itemId, entry.result]),
    );
  } catch {
    return { ok: false, reason: "native_preflight_unavailable", draft };
  }

  const publicOptions: CaptureVariantOptionV1[] = [];
  const streamPolicyWarningByItemId = new Map<string, { code: string; message: string }>();
  let invalidVariantSelection = false;
  const plannerChoices = draft.orderedItemIds.map((itemId) => {
    const preflight = preflightByItemId.get(itemId);
    if (!preflight) return { itemId, include: true };
    const requestedOptionId = selectorByItemId.get(itemId);
    const selection = selectCaptureReviewVariantV1({
      entries: preflight.entries,
      ...(requestedOptionId === undefined ? {} : { requestedOptionId }),
      policy: captureQualityPolicy,
      maxDownloadBytes: captureSettings.hlsSizeCapBytes,
    });
    if (selection.state === "needs_choice" && selection.reason === "confirmation_required") {
      const suggested = preflight.entries.find(
        (entry) => entry.normalizedOption.stableId === selection.suggestedStableId,
      );
      streamPolicyWarningByItemId.set(itemId, {
        code: "QUALITY_CONFIRMATION_REQUIRED",
        message: suggested === undefined
          ? "No supported quality fits every automatic size and resolution limit. Choose an available quality explicitly, or adjust the saved limits in Options."
          : `No supported quality fits every automatic size and resolution limit. ${
              selection.suggestionScope === "smallest_within_height"
                ? "Smallest supported option within your automatic height limit"
                : selection.suggestionScope === "smallest_exceeds_height"
                  ? "Smallest supported option, which also exceeds your automatic height limit"
                  : "Smallest supported option"
            }: ${suggested.publicOption.label}. Choose it explicitly to confirm, or adjust the saved limits in Options.`,
      });
    } else if (
      selection.state === "needs_choice" &&
      selection.reason !== "manual_selection_required"
    ) {
      streamPolicyWarningByItemId.set(itemId, {
        code: "QUALITY_FACTS_UNKNOWN",
        message: "Automatic quality could not safely decide because required size, resolution, or bitrate facts are Unknown. Choose a quality explicitly.",
      });
    } else if (selection.state === "unsupported") {
      preflight.error = {
        code: "STREAM_NO_SUPPORTED_VARIANTS",
        customerMessage: "This stream has no supported downloadable quality.",
      };
    } else if (selection.state === "invalid_input") {
      invalidVariantSelection = true;
    }
    publicOptions.push(...preflight.entries.map((entry) => (
      selection.state === "selected" && selection.automatic &&
        entry.normalizedOption.stableId === selection.selectedStableId
        ? { ...entry.publicOption, selectedByPolicy: true as const }
        : selection.state === "needs_choice" &&
            selection.reason === "confirmation_required" &&
            entry.normalizedOption.stableId === selection.suggestedStableId
          ? { ...entry.publicOption, suggestedForConfirmation: true as const }
        : entry.publicOption
    )));
    return {
      itemId,
      include: true,
      ...(selection.state === "selected"
        ? { qualityChoice: selection.qualityChoice }
        : {}),
    };
  });
  for (const choice of request.choices) {
    const preflight = preflightByItemId.get(choice.itemId);
    if (!preflight || !resolveCaptureVariantOption(preflight.entries, choice.optionId)?.manualQualityChoice) {
      return { ok: false, reason: "variant_choice_stale", draft };
    }
  }
  if (invalidVariantSelection) {
    return { ok: false, reason: "invalid_generated_plan", draft };
  }

  // Network inspection stays outside the global decision lock. Only the
  // revision re-check and immutable plan/journal commit are linearized.
  return withCapturePlanDecision(async () => {
    const [unresolved, quickUnresolved] = await Promise.all([
      getNewestUnresolvedCaptureRunIntent(),
      getNewestUnresolvedQuickCaptureStartIntent(),
    ]);
    if (!unresolved.ok || !quickUnresolved.ok) {
      return { ok: false, reason: "plan_storage_unavailable", draft: null };
    }
    if (unresolved.intent || quickUnresolved.intent) {
      return { ok: false, reason: "unresolved_start", draft: null };
    }
    const concurrentOptions = await getCapturePlanOptions(planId);
    if (!concurrentOptions.ok) {
      return { ok: false, reason: "plan_storage_unavailable", draft: null };
    }
    if (concurrentOptions.record) {
      if (!capturePlanOptionRequestMatches(concurrentOptions.record, {
        commandId: request.commandId,
        draftId: request.draftId,
        draftRevision: request.expectedRevision,
        choices: request.choices,
      })) {
        return { ok: false, reason: "plan_command_conflict", draft: null };
      }
      return replayCapturePlanRecordLocked(planId, concurrentOptions.record);
    }

    const currentDraftResult = await getActiveCaptureDraft();
    if (!currentDraftResult.ok || !currentDraftResult.draft) {
      return { ok: false, reason: "draft_unavailable", draft: null };
    }
    if (
      currentDraftResult.draft.draftId !== request.draftId ||
      currentDraftResult.draft.revision !== request.expectedRevision
    ) {
      return {
        ok: false,
        reason: "revision_conflict",
        draft: currentDraftResult.draft,
        actualRevision: currentDraftResult.draft.revision,
      };
    }
    const nativeVerificationByItemId = new Map(
      draft.orderedItemIds.flatMap((itemId) => {
        const item = draft.items[itemId];
        const result = nativePreflightByItemId.get(itemId);
        if (
          !result?.ok ||
          (item.media.kind !== "direct" && item.media.kind !== "image")
        ) return [];
        return [[itemId, verifyCaptureNativeMedia({
          kind: item.media.kind,
          expectedContentType: item.media.contentType,
          observedContentType: result.contentType,
          observedSizeBytes: result.sizeBytes,
        })] as const];
      }),
    );
    const planningDraft: CaptureDraftV1 = {
      ...draft,
      preferences: {
        ...draft.preferences,
        qualityPolicy: captureQualityPolicy,
      },
      items: Object.fromEntries(draft.orderedItemIds.map((itemId) => {
        const item = draft.items[itemId];
        const verification = nativeVerificationByItemId.get(itemId);
        if (verification?.status !== "verified") return [itemId, item];
        return [itemId, {
          ...item,
          media: {
            ...item.media,
            contentType: verification.contentType,
            ...(verification.sizeBytes === undefined
              ? {}
              : { sizeBytes: verification.sizeBytes }),
          },
        }];
      })),
    };
    const generated = generateCaptureReviewPlan({
      draft: planningDraft,
      expectedDraftRevision: request.expectedRevision,
      planId,
      generatedAt: Date.now(),
      choices: plannerChoices,
    });
    if (!generated.ok) return { ok: false, reason: generated.reason, draft };
    generated.plan.items = generated.plan.items.map((item) => {
      const error = preflightByItemId.get(item.itemId)?.error;
      const policyWarning = streamPolicyWarningByItemId.get(item.itemId);
      const nativeHeaderBlocked = nativeHeaderBlockedItemIds.has(item.itemId);
      const sourceAuthorizationExpired = expiredLeaseItemIds.has(item.itemId);
      const nativePreflight = nativePreflightByItemId.get(item.itemId);
      const nativeVerification = nativeVerificationByItemId.get(item.itemId);
      const nativeStale = nativePreflight !== undefined && (
        !nativePreflight.ok ||
        nativeVerification?.status === "mismatch"
      );
      if (!error && !nativeHeaderBlocked && !sourceAuthorizationExpired && !nativeStale) {
        const warnings = item.warnings
          .filter((warning) => warning.code !== "NATIVE_SOURCE_NOT_REVALIDATED")
          .map((warning) => (
            policyWarning && warning.code === "QUALITY_SELECTION_REQUIRED"
              ? policyWarning
              : warning
          ));
        return nativePreflight?.ok && nativeVerification?.status === "verified"
          ? { ...item, warnings }
          : policyWarning ? { ...item, warnings } : item;
      }
      return {
        itemId: item.itemId,
        include: item.include,
        media: item.media,
        plannedRelativePath: item.plannedRelativePath,
        readiness: nativeStale || sourceAuthorizationExpired
          ? "stale" as const
          : "unsupported" as const,
        copyChoice: item.copyChoice,
        warnings: error
          ? [{ code: error.code, message: error.customerMessage }]
          : sourceAuthorizationExpired
            ? [{
              code: "SOURCE_AUTH_EXPIRED",
              message: "Source authorization expired. Reopen the source page and add this item again.",
            }]
          : nativeHeaderBlocked
            ? [{
              code: "DIRECT_HEADER_REPLAY_REQUIRED",
              message: "This file uses page-specific request headers that Chrome's native saver cannot safely replay yet.",
            }]
            : nativePreflight && !nativePreflight.ok
              ? [{ code: nativePreflight.code, message: nativePreflight.customerMessage }]
              : [{
                  code: "NATIVE_SOURCE_CHANGED",
                  message: "This source now returns a different media format. Refresh the source page and review the pack again.",
                }],
      };
    });
    const transformedTotals = captureReviewPlanTotalsForItems(generated.plan.items);
    if (!transformedTotals) {
      return { ok: false, reason: "invalid_generated_plan", draft };
    }
    generated.plan.totals = transformedTotals;
    if (!isCaptureReviewPlanV1(generated.plan)) {
      return { ok: false, reason: "invalid_generated_plan", draft };
    }
    const headerLeaseIdsByItemId = Object.create(null) as Record<string, string>;
    for (const planItem of generated.plan.items) {
      const resolution = leaseResolutions.get(planItem.itemId);
      if (
        planItem.include &&
        planItem.readiness === "ready" &&
        resolution?.ok === true &&
        resolution.lease !== null
      ) {
        headerLeaseIdsByItemId[planItem.itemId] = resolution.lease.leaseId;
      }
    }
    const capacity = assessCaptureRunCapacity({
      plan: generated.plan,
      headerLeaseIdsByItemId,
    });
    if (!capacity.ok) {
      return {
        ok: false,
        reason: capacity.reason === "graph_too_large" ||
          capacity.reason === "manifest_seed_too_large"
          ? "pack_storage_limit"
          : "invalid_generated_plan",
        draft,
      };
    }
    const preparedRecord: CapturePlanOptionsRecordV1 = {
      schemaVersion: 1,
      planId,
      commandId: request.commandId,
      draftId: request.draftId,
      draftRevision: request.expectedRevision,
      choices: request.choices,
      options: publicOptions,
      headerLeaseIdsByItemId,
      plan: generated.plan,
      state: "prepared",
      createdAt: generated.plan.generatedAt,
    };
    const savedOptions = await saveCapturePlanOptions(preparedRecord);
    if (!savedOptions.ok) {
      return { ok: false, reason: "plan_storage_unavailable", draft };
    }
    const saved = await saveCaptureReviewPlan(generated.plan);
    if (!saved.ok) {
      return {
        ok: false,
        reason: saved.reason === "conflict" ? "plan_command_conflict" : "plan_storage_unavailable",
        draft,
      };
    }
    const committed = await saveCapturePlanOptions({
      ...preparedRecord,
      plan: saved.plan,
      state: "committed",
      createdAt: saved.plan.generatedAt,
    });
    if (!committed.ok) {
      // The prepared journal plus active immutable plan is intentionally
      // recoverable by the same command on the next request.
      return { ok: false, reason: "outcome_unknown", draft };
    }
    return { ok: true, plan: saved.plan, options: publicOptions };
  });
}

function recomputeCapturePlanForFreeAllocation(
  plan: CaptureReviewPlanV1,
  licensed: boolean,
  freeVideoItemIds: string[],
  maxFreeVideoSlots = FREE_DOWNLOAD_LIMIT,
) {
  return allocateCaptureReviewPlan({
    plan,
    licensed,
    freeVideoItemIds,
    maxFreeVideoSlots,
  });
}

function executionHeaderLeaseMap(
  plan: CaptureReviewPlanV1,
  reviewedMap: CaptureHeaderLeaseIdsByItemId,
): CaptureHeaderLeaseIdsByItemId {
  const result = Object.create(null) as Record<string, string>;
  for (const item of plan.items) {
    if (!item.include || item.readiness !== "ready") continue;
    const leaseId = reviewedMap[item.itemId];
    if (leaseId !== undefined) result[item.itemId] = leaseId;
  }
  return result;
}

async function buildCaptureHeaderLeaseClaims(input: {
  plan: CaptureReviewPlanV1;
  jobs: CaptureJobV1[];
  headerLeaseIdsByItemId: CaptureHeaderLeaseIdsByItemId;
  now: number;
}): Promise<
  | { ok: true; claims: CaptureHeaderLeaseAttemptBindingV1[] }
  | { ok: false; reason: "expired" | "unavailable" }
> {
  const expectedLeaseIds = Object.values(input.headerLeaseIdsByItemId);
  if (expectedLeaseIds.length === 0) return { ok: true, claims: [] };
  if (new Set(expectedLeaseIds).size !== expectedLeaseIds.length) {
    return { ok: false, reason: "unavailable" };
  }
  const listed = await listCaptureHeaderLeases(input.now);
  if (!listed.ok) return { ok: false, reason: "unavailable" };
  const byLeaseId = new Map(listed.leases.map((lease) => [lease.leaseId, lease]));
  const jobsByItemId = new Map(input.jobs.map((job) => [job.itemId, job]));
  const planByItemId = new Map(input.plan.items.map((item) => [item.itemId, item]));
  const claims: CaptureHeaderLeaseAttemptBindingV1[] = [];
  for (const [itemId, leaseId] of Object.entries(input.headerLeaseIdsByItemId)) {
    const lease = byLeaseId.get(leaseId);
    const job = jobsByItemId.get(itemId);
    const item = planByItemId.get(itemId);
    if (!lease) {
      return {
        ok: false,
        reason: listed.expiredLeaseIds.includes(leaseId) ? "expired" : "unavailable",
      };
    }
    if (
      !job || !item || !item.include || item.readiness !== "ready" ||
      job.snapshot.headerLeaseId !== leaseId ||
      lease.draftId !== input.plan.draftId ||
      lease.itemId !== itemId ||
      lease.mediaId !== item.media.mediaId ||
      lease.sourceUrl !== item.media.url ||
      lease.pageUrl !== item.media.pageUrl ||
      lease.replayKind !== captureLeaseReplayKind(item.media.kind)
    ) {
      return { ok: false, reason: "unavailable" };
    }
    claims.push({
      leaseId: lease.leaseId,
      draftId: lease.draftId,
      itemId: lease.itemId,
      mediaId: lease.mediaId,
      sourceTabId: lease.sourceTabId,
      pageUrl: lease.pageUrl,
      sourceUrl: lease.sourceUrl,
      replayKind: lease.replayKind,
      runId: job.runId,
      jobId: job.jobId,
      attemptId: job.attemptId,
    });
  }
  return { ok: true, claims };
}

async function handleCaptureRunEnqueue(request: CaptureRunEnqueueRequest): Promise<unknown> {
  const [intentsResult, quickUnresolved] = await Promise.all([
    listCaptureRunIntents(),
    getNewestUnresolvedQuickCaptureStartIntent(),
  ]);
  if (!intentsResult.ok || !quickUnresolved.ok) {
    return { ok: false, reason: "review_state_unavailable" };
  }
  if (quickUnresolved.intent) return { ok: false, reason: "unresolved_start" };
  let frozenIntent = intentsResult.intents.find(
    (intent) => intent.commandId === request.commandId,
  ) ?? null;
  let createdIntentThisRequest = false;
  if (
    frozenIntent &&
    (frozenIntent.planId !== request.planId ||
      frozenIntent.draftId !== request.draftId ||
      frozenIntent.draftRevision !== request.expectedRevision ||
      frozenIntent.requestedFreeVideoItemIds.length !== request.freeVideoItemIds.length ||
      frozenIntent.requestedFreeVideoItemIds.some(
        (itemId, index) => itemId !== request.freeVideoItemIds[index],
      ))
  ) {
    return { ok: false, reason: "command_conflict" };
  }
  if (
    !frozenIntent &&
    intentsResult.intents.some((intent) => isCaptureRunIntentUnresolved(intent))
  ) {
    return { ok: false, reason: "unresolved_start" };
  }

  let plan: CaptureReviewPlanV1;
  let reviewedHeaderLeaseIdsByItemId: CaptureHeaderLeaseIdsByItemId = Object.create(null);
  let currentLicensed = false;
  let used = 0;
  if (frozenIntent) {
    const frozenPlanResult = await getCaptureReviewPlan(frozenIntent.planId);
    if (!frozenPlanResult.ok || !frozenPlanResult.plan) {
      // An unresolved command remains authoritative even when its bounded
      // immutable plan has aged out. Never substitute the active plan.
      return { ok: false, reason: "outcome_unknown" };
    }
    plan = frozenPlanResult.plan;
    reviewedHeaderLeaseIdsByItemId = frozenIntent.headerLeaseIdsByItemId;
    if (
      plan.planId !== frozenIntent.planId ||
      plan.draftId !== frozenIntent.draftId ||
      plan.draftRevision !== frozenIntent.draftRevision
    ) {
      return { ok: false, reason: "outcome_unknown" };
    }
  } else {
    const [draftResult, planResult, optionsResult, licensedResult, usedResult] = await Promise.all([
      getActiveCaptureDraft(),
      getActiveCaptureReviewPlan(),
      getCapturePlanOptions(request.planId),
      isLicensed(),
      getDownloadCount(),
    ]);
    if (
      !draftResult.ok || !draftResult.draft || !planResult.ok || !planResult.plan ||
      !optionsResult.ok || !optionsResult.record || optionsResult.record.state !== "committed"
    ) {
      return { ok: false, reason: "review_state_unavailable" };
    }
    const draft = draftResult.draft;
    plan = planResult.plan;
    if (
      optionsResult.record.planId !== plan.planId ||
      optionsResult.record.draftId !== plan.draftId ||
      optionsResult.record.draftRevision !== plan.draftRevision ||
      JSON.stringify(optionsResult.record.plan) !== JSON.stringify(plan)
    ) {
      return { ok: false, reason: "review_state_unavailable" };
    }
    reviewedHeaderLeaseIdsByItemId = optionsResult.record.headerLeaseIdsByItemId ?? Object.create(null);
    currentLicensed = licensedResult;
    used = usedResult;
    if (
      plan.planId !== request.planId ||
      draft.draftId !== request.draftId ||
      draft.revision !== request.expectedRevision ||
      plan.draftId !== draft.draftId ||
      plan.draftRevision !== draft.revision
    ) {
      return { ok: false, reason: "review_is_stale" };
    }
    if (currentLicensed && request.freeVideoItemIds.length > 0) {
      return { ok: false, reason: "invalid_allocation" };
    }
  }

  if (!frozenIntent) {
    const runs = await listCaptureRuns();
    if (!runs.ok) return { ok: false, reason: "review_state_unavailable" };
    const activeOwner = runs.runs.find((run) => activeRunOwnsReviewPlan(run, plan));
    if (activeOwner) {
      return {
        ok: false,
        reason: "pack_already_active",
      };
    }
  }

  const allocateFromIntent = (intent: CaptureRunIntentV1) =>
    allocateCaptureReviewPlan({
      plan,
      licensed: intent.licensed,
      freeVideoItemIds: intent.licensed ? [] : intent.allocatedVideoItemIds,
      maxFreeVideoSlots: intent.licensed
        ? FREE_DOWNLOAD_LIMIT
        : intent.allocatedVideoItemIds.length,
    });

  let allocated = frozenIntent
    ? allocateFromIntent(frozenIntent)
    : recomputeCapturePlanForFreeAllocation(
        plan,
        currentLicensed,
        request.freeVideoItemIds,
        Math.max(0, FREE_DOWNLOAD_LIMIT - used),
      );
  if (!allocated.ok) {
    return {
      ok: false,
      reason: frozenIntent ? "outcome_unknown" : allocated.reason,
    };
  }
  let headerLeaseIdsByItemId = frozenIntent
    ? frozenIntent.headerLeaseIdsByItemId
    : executionHeaderLeaseMap(allocated.plan, reviewedHeaderLeaseIdsByItemId);
  let executionPlanDigest = await digestCaptureRunExecutionPlan(
    allocated.plan,
    headerLeaseIdsByItemId,
  );
  if (!executionPlanDigest) return { ok: false, reason: "invalid_execution_plan" };

  if (!frozenIntent) {
    const created = await createCaptureRunIntent({
      commandId: request.commandId,
      planId: request.planId,
      draftId: request.draftId,
      draftRevision: request.expectedRevision,
      requestedFreeVideoItemIds: request.freeVideoItemIds,
      licensed: currentLicensed,
      allocatedVideoItemIds: allocated.allocatedVideoItemIds,
      headerLeaseIdsByItemId,
      executionPlanDigest,
      createdAt: Date.now(),
    });
    if (!created.ok) {
      return {
        ok: false,
        reason: created.reason === "command_conflict"
          ? "command_conflict"
          : created.reason === "unresolved_intent"
            ? "unresolved_start"
            : "review_state_unavailable",
      };
    }
    frozenIntent = created.intent;
    headerLeaseIdsByItemId = frozenIntent.headerLeaseIdsByItemId;
    createdIntentThisRequest = created.changed && !created.replayed;
    allocated = allocateFromIntent(frozenIntent);
    if (!allocated.ok) {
      const abandoned = createdIntentThisRequest
        ? await abandonCaptureRunIntent({
            commandId: request.commandId,
            executionPlanDigest: frozenIntent.executionPlanDigest,
          })
        : undefined;
      return abandoned && !abandoned.ok
        ? { ok: false, reason: "outcome_unknown" }
        : { ok: false, reason: allocated.reason };
    }
    executionPlanDigest = await digestCaptureRunExecutionPlan(
      allocated.plan,
      headerLeaseIdsByItemId,
    );
    if (!executionPlanDigest || executionPlanDigest !== frozenIntent.executionPlanDigest) {
      const abandoned = createdIntentThisRequest
        ? await abandonCaptureRunIntent({
            commandId: request.commandId,
            executionPlanDigest: frozenIntent.executionPlanDigest,
          })
        : undefined;
      return abandoned && !abandoned.ok
        ? { ok: false, reason: "outcome_unknown" }
        : { ok: false, reason: "frozen_execution_plan_changed" };
    }
  } else if (executionPlanDigest !== frozenIntent.executionPlanDigest) {
    return { ok: false, reason: "outcome_unknown" };
  }

  // The intent canonicalizes the UUID. Always derive coordinator ownership
  // from that frozen form so an uppercase first request cannot fork a second
  // quota ledger/run on lowercase replay.
  const commandId = frozenIntent.commandId.slice("capture-run-".length);
  const deterministicRunId = `capture-run:v1:${commandId}`;

  let preparedJobs: CaptureJobV1[];
  try {
    preparedJobs = prepareCaptureJobs(allocated.plan, {
      runId: deterministicRunId,
      headerLeaseIdsByItemId,
    });
  } catch {
    return { ok: false, reason: "invalid_execution_plan" };
  }
  const leaseClaimPlan = await buildCaptureHeaderLeaseClaims({
    plan: allocated.plan,
    jobs: preparedJobs,
    headerLeaseIdsByItemId,
    now: Date.now(),
  });
  if (!leaseClaimPlan.ok) {
    if (createdIntentThisRequest) {
      const abandoned = await abandonCaptureRunIntent({
        commandId: frozenIntent.commandId,
        executionPlanDigest: frozenIntent.executionPlanDigest,
      });
      if (!abandoned.ok) return { ok: false, reason: "outcome_unknown" };
    } else {
      return { ok: false, reason: "outcome_unknown" };
    }
    return {
      ok: false,
      reason: leaseClaimPlan.reason === "expired"
        ? "source_authorization_expired"
        : "review_state_unavailable",
    };
  }
  let leaseClaimsChanged = false;
  if (leaseClaimPlan.claims.length > 0) {
    const claimed = await claimCaptureHeaderLeaseBatch({
      claims: leaseClaimPlan.claims,
      now: Date.now(),
    });
    if (!claimed.ok) {
      const definitelyAbsent = claimed.reason !== "storage_unavailable" ||
        claimed.commitState === "absent";
      if (createdIntentThisRequest && definitelyAbsent) {
        const abandoned = await abandonCaptureRunIntent({
          commandId: frozenIntent.commandId,
          executionPlanDigest: frozenIntent.executionPlanDigest,
        });
        if (!abandoned.ok) return { ok: false, reason: "outcome_unknown" };
        return {
          ok: false,
          reason: claimed.reason === "lease_expired" || claimed.reason === "lease_not_found"
            ? "source_authorization_expired"
            : "review_state_unavailable",
        };
      }
      return { ok: false, reason: "outcome_unknown" };
    }
    leaseClaimsChanged = claimed.changed;
  }

  let result: Awaited<ReturnType<typeof enqueueCaptureRun>>;
  try {
    result = await enqueueCaptureRun({
      plan: allocated.plan,
      commandId,
      licensed: frozenIntent.licensed,
      runId: deterministicRunId,
      now: Date.now(),
      headerLeaseIdsByItemId,
    });
  } catch {
    // The coordinator owns both the quota and graph acceptance boundaries.
    // A thrown call cannot prove either absent, so the frozen command must be
    // replayed instead of replaced.
    return { ok: false, reason: "outcome_unknown" };
  }
  if (!result.ok) {
    if (result.releaseFailed) {
      return { ok: false, reason: "outcome_unknown" };
    }
    if (!createdIntentThisRequest) {
      // This invocation can prove only its own rejection. A previous pending
      // invocation may already own quota or a graph, so preserve its command.
      return { ok: false, reason: "outcome_unknown" };
    }
    if (leaseClaimsChanged && leaseClaimPlan.claims.length > 0) {
      const released = await releaseCaptureHeaderLeaseBatch({
        releases: leaseClaimPlan.claims,
        now: Date.now(),
      });
      if (!released.ok) return { ok: false, reason: "outcome_unknown" };
    }
    const abandoned = await abandonCaptureRunIntent({
      commandId: frozenIntent.commandId,
      executionPlanDigest: frozenIntent.executionPlanDigest,
    });
    return abandoned.ok
      ? { ok: false, reason: result.reason }
      : { ok: false, reason: "outcome_unknown" };
  }
  if (result.runId !== deterministicRunId) {
    return { ok: false, reason: "outcome_unknown" };
  }

  let disposition = result.disposition;
  const runRead = await getCaptureRun(result.runId);
  if (!runRead.ok) {
    disposition = "commit_state_unknown";
  } else if (
    !runRead.run ||
    runRead.run.planId !== frozenIntent.planId ||
    runRead.run.draftId !== frozenIntent.draftId ||
    runRead.run.draftRevision !== frozenIntent.draftRevision ||
    runRead.run.commandId !== commandId
  ) {
    // Coordinator command ledgers may outlive a missing/incomplete graph. Run
    // existence with exact ownership is required before `accepted` can settle.
    disposition = "recovery_needed";
  }
  const finalized = await finalizeCaptureRunIntent({
    commandId: frozenIntent.commandId,
    runId: result.runId,
    disposition,
  });
  if (!finalized.ok) return { ok: false, reason: "outcome_unknown" };
  void scheduleCaptureQueueDrain();
  return {
    ok: true,
    runId: result.runId,
    replayed: result.replayed,
    disposition: finalized.intent.reconciliationDisposition,
  };
}

async function finishCaptureCancellation(job: CaptureJobV1): Promise<CaptureJobV1 | undefined> {
  const result = await applyStoredCaptureJobEvent({
    jobId: job.jobId,
    attemptId: job.attemptId,
    event: { type: "cancelled" },
  });
  if (!result.ok) return undefined;
  await settleCaptureTerminalQuota(result.job);
  const cleaned = await cleanupCaptureAttempt(result.job);
  await refreshCaptureRunStatus(result.job.runId);
  void scheduleCaptureQueueDrain();
  return cleaned ? result.job : undefined;
}

function handleCaptureJobCancel(request: CaptureJobCancelRequest): Promise<unknown> {
  return withKeyLock(
    CAPTURE_ATTEMPT_SIDE_EFFECTS_LOCK_KEY,
    () => handleCaptureJobCancelUnlocked(request),
  );
}

async function handleCaptureJobCancelUnlocked(request: CaptureJobCancelRequest): Promise<unknown> {
  const current = await getCaptureJob(request.jobId);
  if (!current.ok || !current.job) return { ok: false, reason: "job_not_found" };
  if (current.job.attemptId !== request.attemptId) {
    return { ok: false, reason: "attempt_is_stale" };
  }
  if (CAPTURE_TERMINAL_JOB_STATES.has(current.job.state)) {
    const cleaned = await cleanupCaptureAttempt(current.job);
    if (!cleaned) updateCaptureCleanupRetry(true);
    void scheduleCaptureQueueDrain();
    return cleaned
      ? { ok: true, job: current.job }
      : { ok: false, reason: "cleanup_pending", job: current.job };
  }
  const requested = await applyStoredCaptureJobEvent({
    jobId: current.job.jobId,
    attemptId: current.job.attemptId,
    event: { type: "request-cancel" },
  });
  if (!requested.ok) return { ok: false, reason: "cancel_state_changed" };
  if (requested.job.state === "cancelled") {
    await settleCaptureTerminalQuota(requested.job);
    const cleaned = await cleanupCaptureAttempt(requested.job);
    await refreshCaptureRunStatus(requested.job.runId);
    void scheduleCaptureQueueDrain();
    return cleaned
      ? { ok: true, job: requested.job }
      : { ok: false, reason: "cleanup_pending", job: requested.job };
  }

  if (current.job.state === "delivery_pending" && current.job.downloadId === undefined) {
    const unknown = await applyStoredCaptureJobEvent({
      jobId: current.job.jobId,
      attemptId: current.job.attemptId,
      event: {
        type: "save-state-unknown",
        code: "CANCEL_DELIVERY_UNKNOWN",
        customerMessage: "Chrome may have accepted this file before cancellation. Check Downloads before retrying.",
      },
    });
    if (!unknown.ok) return { ok: false, reason: "cancel_state_changed" };
    await settleCaptureTerminalQuota(unknown.job);
    const cleaned = await cleanupCaptureAttempt(unknown.job);
    await refreshCaptureRunStatus(unknown.job.runId);
    void scheduleCaptureQueueDrain();
    return cleaned
      ? { ok: true, job: unknown.job }
      : { ok: false, reason: "cleanup_pending", job: unknown.job };
  }
  if (current.job.downloadId !== undefined) {
    let cancelRequested = false;
    try {
      await chrome.downloads.cancel(current.job.downloadId);
      cancelRequested = true;
    } catch {
      cancelRequested = false;
    }
    let downloadReadKnown = false;
    const [download] = await chrome.downloads.search({ id: current.job.downloadId }).then(
      (items) => {
        downloadReadKnown = true;
        return items;
      },
      () => [] as chrome.downloads.DownloadItem[],
    );
    if (download?.state === "complete") {
      const completed = await applyStoredCaptureJobEvent({
        jobId: current.job.jobId,
        attemptId: current.job.attemptId,
        event: {
          type: "complete",
          actualBasename: finalBasename(download.filename),
          sizeBytes: download.fileSize !== undefined && download.fileSize >= 0
            ? download.fileSize
            : undefined,
        },
      });
      if (completed.ok) {
        await settleCaptureTerminalQuota(completed.job);
        const cleaned = await cleanupCaptureAttempt(completed.job);
        await refreshCaptureRunStatus(completed.job.runId);
        void scheduleCaptureQueueDrain();
        return cleaned
          ? { ok: true, job: completed.job }
          : { ok: false, reason: "cleanup_pending", job: completed.job };
      }
    }
    if (!cancelRequested || !downloadReadKnown) {
      return { ok: false, reason: "cancel_pending", job: requested.job };
    }
    if (!download) {
      const unknown = await applyStoredCaptureJobEvent({
        jobId: requested.job.jobId,
        attemptId: requested.job.attemptId,
        event: {
          type: "save-state-unknown",
          code: "CANCEL_SAVE_STATE_UNKNOWN",
          customerMessage: "Chrome no longer reports this save. Check Downloads before retrying.",
        },
      });
      if (!unknown.ok) return { ok: false, reason: "cancel_pending", job: requested.job };
      await settleCaptureTerminalQuota(unknown.job);
      const cleaned = await cleanupCaptureAttempt(unknown.job);
      await refreshCaptureRunStatus(unknown.job.runId);
      void scheduleCaptureQueueDrain();
      return cleaned
        ? { ok: true, job: unknown.job }
        : { ok: false, reason: "cleanup_pending", job: unknown.job };
    }
    if (download?.state === "in_progress") {
      // Chrome accepted cancellation but has not emitted the terminal
      // interrupted delta yet. Keep `cancelling` durable and let onChanged or
      // recovery settle it; reporting cancelled now would let a file finish
      // after the UI says it stopped.
      return { ok: true, job: requested.job };
    }
  }
  if (requested.job.resourceClass === "heavy") {
    await chrome.runtime.sendMessage({
      type: `${captureOffscreenPrefix(requested.job)}-cancel`,
      jobId: requested.job.jobId,
      attemptId: requested.job.attemptId,
    }).catch(() => undefined);
  }
  const cancelled = await finishCaptureCancellation(requested.job);
  return cancelled ? { ok: true, job: cancelled } : { ok: false, reason: "cancel_state_changed" };
}

async function handleCaptureQuickReconcile(
  request: CaptureQuickReconcileRequest,
): Promise<DownloadResponse> {
  try {
    return await downloadCommandGate.run(request.commandId, async () => {
      const read = await getQuickCaptureStartIntent(request.commandId);
      if (!read.ok) throw new QuickCaptureStartPendingError();
      if (!read.intent) {
        return {
          ok: false,
          code: "INTENT_NOT_FOUND",
          error: "This Quick Capture no longer has an unresolved start to reconcile.",
        };
      }
      return reconcileQuickCaptureStartIntent(read.intent);
    });
  } catch {
    return {
      ok: false,
      code: "START_STATE_UNKNOWN",
      error: "ClipHutch still cannot prove the Quick Capture outcome. No second download was started.",
    };
  }
}

async function handleCaptureWorkspaceGet(): Promise<unknown> {
  const [
    draftResult,
    plansResult,
    runsResult,
    unresolvedIntentResult,
    unresolvedQuickResult,
    licensed,
    used,
  ] = await Promise.all([
    getActiveCaptureDraft(),
    listCaptureReviewPlans(),
    listCaptureRuns(),
    getNewestUnresolvedCaptureRunIntent(),
    getNewestUnresolvedQuickCaptureStartIntent(),
    isLicensed(),
    getDownloadCount(),
  ]);
  if (
    !draftResult.ok || !plansResult.ok || !runsResult.ok ||
    !unresolvedIntentResult.ok || !unresolvedQuickResult.ok
  ) {
    return { ok: false, reason: "workspace_storage_unavailable" };
  }
  const activePlan = plansResult.activePlanId === null
    ? undefined
    : plansResult.plans.find((plan) => plan.planId === plansResult.activePlanId);
  if (plansResult.activePlanId !== null && !activePlan) {
    return { ok: false, reason: "workspace_storage_unavailable" };
  }
  const reviewOptions = activePlan
    ? await getCapturePlanOptions(activePlan.planId)
    : { ok: true as const, record: null };
  if (!reviewOptions.ok) {
    return { ok: false, reason: "workspace_storage_unavailable" };
  }
  if (
    reviewOptions.record && activePlan &&
    JSON.stringify(reviewOptions.record.plan) !== JSON.stringify(activePlan)
  ) {
    return { ok: false, reason: "workspace_storage_unavailable" };
  }
  const jobs: CaptureJobV1[] = [];
  const manifests = [];
  for (const run of runsResult.runs) {
    for (const jobId of run.orderedJobIds) {
      const result = await getCaptureJob(jobId);
      if (!result.ok || !result.job) {
        return { ok: false, reason: "workspace_job_unavailable" };
      }
      jobs.push(result.job);
    }
    if (!run.planId.startsWith("capture-single-plan:")) {
      const manifest = await getCaptureManifestRecord(run.runId);
      if (!manifest.ok) return { ok: false, reason: "workspace_manifest_unavailable" };
      if (manifest.record) {
        const summary = createCaptureWorkspaceManifest(manifest.record);
        if (!summary || summary.runId !== run.runId) {
          return { ok: false, reason: "workspace_manifest_unavailable" };
        }
        manifests.push(summary);
      }
    }
  }
  const unresolvedIntent = unresolvedIntentResult.intent;
  const unresolvedQuick = unresolvedQuickResult.intent;
  if (unresolvedIntent && unresolvedQuick) {
    return { ok: false, reason: "workspace_multiple_unresolved_starts" };
  }
  if (
    unresolvedIntent &&
    !plansResult.plans.some((plan) =>
      plan.planId === unresolvedIntent.planId &&
      plan.draftId === unresolvedIntent.draftId &&
      plan.draftRevision === unresolvedIntent.draftRevision,
    )
  ) {
    return { ok: false, reason: "workspace_recovery_plan_unavailable" };
  }
  const unresolvedRun = unresolvedIntent?.status === "committed"
    ? runsResult.runs.find((run) => run.runId === unresolvedIntent.runId)
    : undefined;
  const unresolvedQuickRun = unresolvedQuick
    ? runsResult.runs.find((run) =>
        run.runId === unresolvedQuick.runId &&
        run.commandId === unresolvedQuick.coordinatorCommandId &&
        run.planId === unresolvedQuick.plan.planId,
      )
    : undefined;
  const unresolvedQuickJob = unresolvedQuickRun?.orderedJobIds.length === 1
    ? jobs.find((job) =>
        job.jobId === unresolvedQuickRun.orderedJobIds[0] &&
        job.runId === unresolvedQuickRun.runId &&
        job.itemId === unresolvedQuick?.plan.items[0]?.itemId,
      )
    : undefined;
  return {
    ok: true,
    draft: draftResult.draft,
    plans: plansResult.plans,
    runs: runsResult.runs,
    jobs,
    manifests,
    quota: {
      licensed,
      limit: FREE_DOWNLOAD_LIMIT,
      used,
      remaining: licensed ? FREE_DOWNLOAD_LIMIT : Math.max(0, FREE_DOWNLOAD_LIMIT - used),
    },
    reviewContext: reviewOptions.record
      ? {
          planId: reviewOptions.record.planId,
          commandId: reviewOptions.record.commandId,
          choices: reviewOptions.record.choices,
          options: reviewOptions.record.options,
        }
      : null,
    runContext: unresolvedIntent
      ? {
          commandId: unresolvedIntent.commandId,
          planId: unresolvedIntent.planId,
          draftId: unresolvedIntent.draftId,
          draftRevision: unresolvedIntent.draftRevision,
          requestedFreeVideoItemIds: unresolvedIntent.requestedFreeVideoItemIds,
          licensed: unresolvedIntent.licensed,
          status: unresolvedIntent.status,
          reconciliationState: unresolvedIntent.status === "pending"
            ? "pending"
            : unresolvedRun
              ? "committed_recovery_needed"
              : "committed_missing_run",
          ...(unresolvedIntent.status === "committed"
            ? { runId: unresolvedIntent.runId }
            : {}),
        }
      : null,
    quickCaptureContext: unresolvedQuick
      ? {
          commandId: unresolvedQuick.commandId,
          runId: unresolvedQuick.runId,
          planId: unresolvedQuick.plan.planId,
          itemId: unresolvedQuick.plan.items[0].itemId,
          reconciliationState: unresolvedQuick.status === "pending"
            ? "pending"
            : unresolvedQuick.reconciliationDisposition,
          ...(unresolvedQuickJob === undefined ? {} : { jobId: unresolvedQuickJob.jobId }),
        }
      : null,
  };
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

async function findCaptureJobByDownloadId(
  downloadId: number,
): Promise<CaptureJobV1 | undefined> {
  const listed = await listCaptureRuns();
  if (!listed.ok) return undefined;
  for (const run of listed.runs) {
    const jobs = await captureJobsForRun(run);
    const match = jobs?.find((job) => job.downloadId === downloadId);
    if (match) return match;
  }
  return undefined;
}

function finalBasename(filename: string | undefined): string | undefined {
  return filename?.split(/[\\/]/).filter(Boolean).at(-1);
}

async function applyCaptureDownloadTerminal(
  downloadId: number,
  state: "complete" | "interrupted",
): Promise<boolean> {
  const job = await findCaptureJobByDownloadId(downloadId);
  if (!job) return false;
  let terminalJob: CaptureJobV1 | undefined;
  if (state === "complete") {
    const [item] = await chrome.downloads.search({ id: downloadId }).catch(() => [] as chrome.downloads.DownloadItem[]);
    const result = await applyStoredCaptureJobEvent({
      jobId: job.jobId,
      attemptId: job.attemptId,
      event: {
        type: "complete",
        actualBasename: finalBasename(item?.filename),
        sizeBytes: item?.fileSize !== undefined && item.fileSize >= 0 ? item.fileSize : undefined,
      },
    });
    if (result.ok) terminalJob = result.job;
  } else {
    const result = await applyStoredCaptureJobEvent({
      jobId: job.jobId,
      attemptId: job.attemptId,
      event: job.state === "cancelling"
        ? { type: "cancelled" }
        : {
            type: "fail",
            code: "SAVE_INTERRUPTED",
            customerMessage: "Chrome interrupted the file save.",
            retryable: true,
          },
    });
    if (result.ok) terminalJob = result.job;
  }
  if (terminalJob) await settleCaptureTerminalQuota(terminalJob);
  await cleanupCaptureAttempt(job);
  await refreshCaptureRunStatus(job.runId);
  void scheduleCaptureQueueDrain();
  return true;
}

async function handleDownloadChange(delta: chrome.downloads.DownloadDelta): Promise<void> {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;

  if (await applyCaptureManifestDownloadTerminal(delta.id, state)) return;
  if (await applyCaptureDownloadTerminal(delta.id, state)) return;

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
  void withKeyLock(
    CAPTURE_ATTEMPT_SIDE_EFFECTS_LOCK_KEY,
    () => handleDownloadChange(delta),
  );
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

let creatingOffscreenDocument: Promise<void> | undefined;

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = (await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  })) as chrome.runtime.ExtensionContext[] | undefined;
  if (contexts && contexts.length > 0) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification:
        "Assemble streams, convert WebM files, or create bounded redacted Capture Pack manifest blobs",
    }).finally(() => {
      creatingOffscreenDocument = undefined;
    });
  }
  await creatingOffscreenDocument;
}

// When the user explicitly clicks "Continue anyway" past the size cap, allow
// up to 10× the configured cap. Caps the runaway-memory blast radius while
// honoring the explicit opt-in.
const BYPASS_CAP_MULTIPLIER = 10;

const CAPTURE_TERMINAL_JOB_STATES = new Set<CaptureJobV1["state"]>([
  "complete",
  "failed",
  "cancelled",
  "save_state_unknown",
]);

async function settleCaptureTerminalQuota(job: CaptureJobV1): Promise<void> {
  if (!job.quotaReservationId || !CAPTURE_TERMINAL_JOB_STATES.has(job.state)) return;
  try {
    if (job.state === "complete" || job.state === "save_state_unknown") {
      await chargeDownloadReservation(job.quotaReservationId);
    } else {
      await releaseDownloadReservation(job.quotaReservationId);
    }
  } catch {
    // The redacted local quota ledger remains reconcilable on a later wake.
  }
}

let captureRecoveryBarrier: Promise<void> | undefined;
let captureCleanupRetryTimer: ReturnType<typeof setTimeout> | undefined;
let captureCleanupRetryAttempt = 0;

async function scheduleCaptureLeaseExpiryAlarm(now = Date.now()): Promise<boolean> {
  const listed = await listCaptureHeaderLeases(now);
  if (!listed.ok) return false;
  const when = nextCaptureLeaseExpiryAlarmTime({
    activeExpiresAt: listed.leases.map((lease) => lease.expiresAt),
    expiredLeaseCount: listed.expiredLeaseIds.length,
  }, now);
  try {
    if (when === undefined) {
      await chrome.alarms.clear(CAPTURE_LEASE_EXPIRY_ALARM_NAME);
    } else {
      await chrome.alarms.create(CAPTURE_LEASE_EXPIRY_ALARM_NAME, { when });
    }
    return true;
  } catch {
    return false;
  }
}

async function reconcileClearedCaptureReviewState(): Promise<boolean> {
  const draftRead = await getActiveCaptureDraft();
  if (!draftRead.ok) return false;
  if (draftRead.draft && draftRead.draft.orderedItemIds.length > 0) return true;

  const [runs, intents] = await Promise.all([
    listCaptureRuns(),
    listCaptureRunIntents(),
  ]);
  if (!runs.ok || !intents.ok) return false;
  const protectedPlanIds = new Set<string>();
  for (const run of runs.runs) {
    if (run.status === "queued" || run.status === "running") {
      protectedPlanIds.add(run.planId);
    }
  }
  for (const intent of intents.intents) {
    if (isCaptureRunIntentUnresolved(intent)) protectedPlanIds.add(intent.planId);
  }
  const orderedProtectedPlanIds = [...protectedPlanIds].sort();
  const [plans, options] = await Promise.all([
    clearUnreferencedCaptureReviewPlans(orderedProtectedPlanIds),
    clearUnreferencedCapturePlanOptions(orderedProtectedPlanIds),
  ]);
  return plans.ok && options.ok;
}

async function captureJobsForRun(run: CaptureRunV1): Promise<CaptureJobV1[] | undefined> {
  const reads = await Promise.all(run.orderedJobIds.map((jobId) => getCaptureJob(jobId)));
  if (reads.some((read) => !read.ok || !read.job)) return undefined;
  const jobs = reads.map((read) => (read.ok ? read.job : null)).filter(
    (job): job is CaptureJobV1 => Boolean(job),
  );
  return jobs.every((job) => job.runId === run.runId) ? jobs : undefined;
}

async function markCaptureRunRunning(runId: string): Promise<void> {
  const listed = await listCaptureRuns();
  if (!listed.ok) return;
  const run = listed.runs.find((candidate) => candidate.runId === runId);
  if (!run || run.status !== "queued") return;
  await updateCaptureRun({
    runId,
    expectedStatus: "queued",
    update: (current) => ({ ...current, status: "running" }),
  });
}

type CaptureManifestStartResult =
  | { ok: true; runId: string; format: CaptureManifestFormatV1; replayed: boolean }
  | { ok: false; reason: string };

function captureManifestBlobUrlIsOwned(blobUrl: string): boolean {
  try {
    const extensionOrigin = new URL(chrome.runtime.getURL("/")).origin;
    return new URL(blobUrl).protocol === "blob:" && blobUrl.startsWith(`blob:${extensionOrigin}/`);
  } catch {
    return false;
  }
}

function automaticCaptureManifestAttemptId(): string {
  return `capture-manifest-auto-${crypto.randomUUID().toLowerCase()}`;
}

async function revokeCaptureManifestBlob(runId: string, attemptId: string): Promise<boolean> {
  try {
    const response = parseCaptureManifestBlobRevokeResponse(
      await chrome.runtime.sendMessage({
        type: "capture-manifest-blob-revoke",
        runId,
        attemptId,
      }),
    );
    if (response?.runId === runId && response.attemptId === attemptId) return true;
  } catch {
    // A missing offscreen context proves it owns no Blob URL. Otherwise keep
    // the cleanup retry armed until the exact identity acknowledges revoke.
  }
  try {
    const contexts = (await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
      documentUrls: [chrome.runtime.getURL("offscreen.html")],
    })) as chrome.runtime.ExtensionContext[] | undefined;
    return !contexts || contexts.length === 0;
  } catch {
    return false;
  }
}

async function activeCaptureManifestBlobs(): Promise<{
  known: boolean;
  active: CaptureManifestBlobStatusEntry[];
}> {
  try {
    const contexts = (await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
      documentUrls: [chrome.runtime.getURL("offscreen.html")],
    })) as chrome.runtime.ExtensionContext[] | undefined;
    if (!contexts || contexts.length === 0) return { known: true, active: [] };
    const parsed = parseCaptureManifestBlobStatusResponse(
      await chrome.runtime.sendMessage({ type: "capture-manifest-blob-status" }),
    );
    return parsed ? { known: true, active: parsed.active } : { known: false, active: [] };
  } catch {
    return { known: false, active: [] };
  }
}

async function mutateManifestFailure(input: {
  runId: string;
  format: CaptureManifestFormatV1;
  attemptId: string;
  beforeDelivery: boolean;
  errorCode: CaptureManifestPublicErrorCode;
  retryable: boolean;
}): Promise<boolean> {
  const read = await getCaptureManifestRecord(input.runId);
  if (!read.ok || !read.record) return false;
  const current = read.record.outputs[input.format];
  if (!current) return false;
  if (current.state === "failed" && current.attemptId === input.attemptId) return true;
  if (input.beforeDelivery && current.state !== "pending" && current.state !== "failed") return false;
  if (!input.beforeDelivery && (current.state !== "saving" || current.attemptId !== input.attemptId)) {
    return false;
  }
  const result = await mutateCaptureManifestOutput({
    runId: input.runId,
    format: input.format,
    action: {
      type: input.beforeDelivery ? "fail_before_delivery" : "fail",
      format: input.format,
      expectedRevision: current.revision,
      attemptId: input.attemptId,
      errorCode: input.errorCode,
      retryable: input.retryable,
      now: Math.max(Date.now(), current.updatedAt, read.record.finalizedAt ?? 0),
    },
  });
  return result.ok;
}

async function freezeCaptureManifestJobResults(
  jobs: readonly CaptureJobV1[],
): Promise<CaptureJobV1[] | undefined> {
  const reconciled: CaptureJobV1[] = [];
  for (const job of jobs) {
    if (job.state !== "complete" || job.downloadId === undefined) {
      reconciled.push(job);
      continue;
    }
    let download: chrome.downloads.DownloadItem | undefined;
    try {
      [download] = await chrome.downloads.search({ id: job.downloadId });
    } catch {
      // A transient read cannot freeze an omission that a later JSON/CSV
      // serializer would otherwise observe differently. Retry finalization.
      return undefined;
    }
    if (!download) {
      // Chrome history can be cleared after the terminal event. The durable
      // terminal result is the safe fallback in that case.
      reconciled.push(job);
      continue;
    }
    if (download.state !== "complete") return undefined;
    const actualBasename = finalBasename(download.filename);
    const sizeBytes = download.fileSize !== undefined &&
        Number.isSafeInteger(download.fileSize) && download.fileSize >= 0
      ? download.fileSize
      : undefined;
    const frozen = await enrichCompletedCaptureJobResult({
      jobId: job.jobId,
      expectedAttemptId: job.attemptId,
      expectedRevision: job.revision,
      result: {
        ...(actualBasename === undefined ? {} : { actualBasename }),
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
      },
    });
    if (!frozen.ok) return undefined;
    reconciled.push(frozen.job);
  }
  return reconciled;
}

async function appendCaptureManifestDownloadId(runId: string, downloadId: number): Promise<boolean> {
  const read = await getCaptureRun(runId);
  if (!read.ok || !read.run) return false;
  if (read.run.manifestDownloadIds?.includes(downloadId)) return true;
  const existing = read.run.manifestDownloadIds ?? [];
  if (existing.length >= 2) return false;
  const updated = await updateCaptureRun({
    runId,
    expectedStatus: read.run.status,
    update: (current) => ({
      ...current,
      manifestDownloadIds: [...(current.manifestDownloadIds ?? []), downloadId],
    }),
  });
  return updated.ok;
}

async function createCaptureManifestBlob(input: {
  runId: string;
  attemptId: string;
  format: CaptureManifestFormatV1;
  content: string;
}): Promise<
  | { ok: true; blobUrl: string }
  | { ok: false; retryable: boolean }
> {
  try {
    await ensureOffscreenDocument();
    const contentDigest = await sha256CaptureManifestContent(input.content);
    const parsed = parseCaptureManifestBlobCreateResponse(
      await chrome.runtime.sendMessage({
        type: "capture-manifest-blob-create",
        runId: input.runId,
        attemptId: input.attemptId,
        format: input.format,
        content: input.content,
        contentDigest,
      }),
    );
    if (!parsed || parsed.runId !== input.runId || parsed.attemptId !== input.attemptId) {
      if (!await revokeCaptureManifestBlob(input.runId, input.attemptId)) {
        updateCaptureCleanupRetry(true);
      }
      return { ok: false, retryable: false };
    }
    if (!parsed.ok) {
      return {
        ok: false,
        retryable: captureManifestBlobCreateErrorIsRetryable(parsed.code),
      };
    }
    if (
      parsed.format !== input.format ||
      parsed.contentDigest !== contentDigest ||
      parsed.sizeBytes !== captureManifestContentSizeBytes(input.content) ||
      parsed.mimeType !== captureManifestBlobMimeType(input.format) ||
      !captureManifestBlobUrlIsOwned(parsed.blobUrl)
    ) {
      await revokeCaptureManifestBlob(input.runId, input.attemptId);
      return { ok: false, retryable: false };
    }
    return { ok: true, blobUrl: parsed.blobUrl };
  } catch {
    if (!await revokeCaptureManifestBlob(input.runId, input.attemptId)) {
      updateCaptureCleanupRetry(true);
    }
    return { ok: false, retryable: true };
  }
}

async function startCaptureManifestOutput(input: {
  run: CaptureRunV1;
  jobs: readonly CaptureJobV1[];
  format: CaptureManifestFormatV1;
  attemptId: string;
  trigger: "automatic" | "retry";
}): Promise<CaptureManifestStartResult> {
  const read = await getCaptureManifestRecord(input.run.runId);
  if (!read.ok || !read.record || read.record.finalizedAt === undefined) {
    return { ok: false, reason: "manifest_unavailable" };
  }
  if (input.run.planId.startsWith("capture-single-plan:")) {
    return { ok: false, reason: "quick_capture_has_no_manifest" };
  }
  const current = read.record.outputs[input.format];
  if (!current) return { ok: false, reason: "manifest_format_unavailable" };
  if (current.state === "saving") {
    return current.attemptId === input.attemptId
      ? { ok: true, runId: input.run.runId, format: input.format, replayed: true }
      : { ok: false, reason: "manifest_busy" };
  }
  if (current.state === "complete") {
    return current.attemptId === input.attemptId
      ? { ok: true, runId: input.run.runId, format: input.format, replayed: true }
      : { ok: false, reason: "manifest_already_complete" };
  }
  if (current.state === "failed" && current.attemptId === input.attemptId) {
    return { ok: false, reason: "manifest_attempt_failed" };
  }
  if (current.attemptIds.length >= MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS) {
    return { ok: false, reason: "manifest_retry_not_allowed" };
  }
  if (
    (input.trigger === "automatic" && current.state !== "pending") ||
    (input.trigger === "retry" && (current.state !== "failed" || !current.retryable))
  ) {
    return { ok: false, reason: "manifest_retry_not_allowed" };
  }

  const built = buildCaptureManifestInput({
    seed: read.record.seed,
    jobs: input.jobs,
    finalizedAt: read.record.finalizedAt,
    generatorVersion: chrome.runtime.getManifest().version,
  });
  if (!built.ok) {
    await mutateManifestFailure({
      runId: input.run.runId,
      format: input.format,
      attemptId: input.attemptId,
      beforeDelivery: true,
      errorCode: "MANIFEST_SERIALIZE_FAILED",
      retryable: false,
    });
    return { ok: false, reason: built.reason };
  }
  let content: string;
  try {
    content = serializeCaptureManifestForFormat(built.input, input.format);
  } catch {
    await mutateManifestFailure({
      runId: input.run.runId,
      format: input.format,
      attemptId: input.attemptId,
      beforeDelivery: true,
      errorCode: "MANIFEST_SERIALIZE_FAILED",
      retryable: false,
    });
    return { ok: false, reason: "manifest_serialize_failed" };
  }
  const path = captureManifestDownloadPath(read.record.seed, input.format);
  if (!path) {
    await mutateManifestFailure({
      runId: input.run.runId,
      format: input.format,
      attemptId: input.attemptId,
      beforeDelivery: true,
      errorCode: "MANIFEST_SERIALIZE_FAILED",
      retryable: false,
    });
    return { ok: false, reason: "manifest_path_invalid" };
  }
  const blob = await createCaptureManifestBlob({
    runId: input.run.runId,
    attemptId: input.attemptId,
    format: input.format,
    content,
  });
  if (!blob.ok) {
    await mutateManifestFailure({
      runId: input.run.runId,
      format: input.format,
      attemptId: input.attemptId,
      beforeDelivery: true,
      errorCode: "MANIFEST_BLOB_FAILED",
      retryable: blob.retryable,
    });
    return { ok: false, reason: "manifest_blob_failed" };
  }

  const latestBeforeBegin = await getCaptureManifestRecord(input.run.runId);
  const beforeBegin = latestBeforeBegin.ok ? latestBeforeBegin.record?.outputs[input.format] : undefined;
  if (!beforeBegin || (beforeBegin.state !== "pending" && beforeBegin.state !== "failed")) {
    await revokeCaptureManifestBlob(input.run.runId, input.attemptId);
    return { ok: false, reason: "manifest_state_changed" };
  }
  const begun = await mutateCaptureManifestOutput({
    runId: input.run.runId,
    format: input.format,
    action: {
      type: "begin",
      format: input.format,
      expectedRevision: beforeBegin.revision,
      attemptId: input.attemptId,
      now: Math.max(
        Date.now(),
        beforeBegin.updatedAt,
        latestBeforeBegin.ok ? latestBeforeBegin.record?.finalizedAt ?? 0 : 0,
      ),
    },
  });
  if (!begun.ok) {
    const replay = await getCaptureManifestRecord(input.run.runId);
    const output = replay.ok ? replay.record?.outputs[input.format] : undefined;
    if (output?.state !== "saving" || output.attemptId !== input.attemptId) {
      await revokeCaptureManifestBlob(input.run.runId, input.attemptId);
      return { ok: false, reason: "manifest_state_unavailable" };
    }
  }

  let downloadId: number;
  try {
    downloadId = await chrome.downloads.download({
      url: blob.blobUrl,
      filename: path,
      conflictAction: "uniquify",
      saveAs: false,
    });
    if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new Error("Invalid download ID");
  } catch {
    await mutateManifestFailure({
      runId: input.run.runId,
      format: input.format,
      attemptId: input.attemptId,
      beforeDelivery: false,
      errorCode: "MANIFEST_SAVE_FAILED",
      retryable: true,
    });
    if (!await revokeCaptureManifestBlob(input.run.runId, input.attemptId)) {
      updateCaptureCleanupRetry(true);
    }
    return { ok: false, reason: "manifest_save_failed" };
  }

  const afterDownload = await getCaptureManifestRecord(input.run.runId);
  const saving = afterDownload.ok ? afterDownload.record?.outputs[input.format] : undefined;
  const recorded = saving?.state === "saving" && saving.attemptId === input.attemptId
    ? await mutateCaptureManifestOutput({
        runId: input.run.runId,
        format: input.format,
        action: {
          type: "record_download",
          format: input.format,
          expectedRevision: saving.revision,
          attemptId: input.attemptId,
          downloadId,
          now: Math.max(Date.now(), saving.updatedAt),
        },
      })
    : undefined;
  if (!recorded?.ok) {
    await mutateManifestFailure({
      runId: input.run.runId,
      format: input.format,
      attemptId: input.attemptId,
      beforeDelivery: false,
      errorCode: "MANIFEST_SAVE_STATE_UNKNOWN",
      retryable: true,
    });
    if (!await revokeCaptureManifestBlob(input.run.runId, input.attemptId)) {
      updateCaptureCleanupRetry(true);
    }
    return { ok: false, reason: "manifest_save_state_unknown" };
  }

  const observed = await observedCaptureDownload(downloadId);
  if (observed?.state === "complete" || observed?.state === "interrupted" || observed?.state === "missing") {
    await applyCaptureManifestDownloadTerminal(
      downloadId,
      observed.state === "complete" ? "complete" : "interrupted",
      observed.state === "missing",
    );
  } else {
    // Chrome may deliver the terminal downloads.onChanged event after this
    // worker is evicted, or not wake the current lifetime for it at all. Feed
    // every unresolved accepted save into the durable drain/alarm recovery
    // path instead of relying on that event as the sole future observation.
    void scheduleCaptureQueueDrain();
  }
  return { ok: true, runId: input.run.runId, format: input.format, replayed: false };
}

let captureManifestFinalizationTask: Promise<void> | undefined;
let captureManifestFinalizationRequested = false;

function scheduleCaptureManifestFinalization(): void {
  captureManifestFinalizationRequested = true;
  if (captureManifestFinalizationTask) return;
  captureManifestFinalizationTask = (async () => {
    while (captureManifestFinalizationRequested) {
      captureManifestFinalizationRequested = false;
      const clean = await withKeyLock(
        CAPTURE_ATTEMPT_SIDE_EFFECTS_LOCK_KEY,
        () => reconcileCaptureManifests(true),
      );
      if (!clean) updateCaptureCleanupRetry(true);
    }
  })().catch(() => {
    updateCaptureCleanupRetry(true);
  }).finally(() => {
    captureManifestFinalizationTask = undefined;
    // A request arriving at the end of the completed task must not be lost.
    if (captureManifestFinalizationRequested) scheduleCaptureManifestFinalization();
  });
}

function captureManifestMediaIsTerminal(jobs: readonly CaptureJobV1[]): boolean {
  return jobs.length > 0 && jobs.every((job) => CAPTURE_TERMINAL_JOB_STATES.has(job.state));
}

function captureManifestMinimumFinalizedAt(record: CaptureManifestRecordV1): number {
  return Math.max(
    Date.now(),
    record.seed.createdAt,
    ...record.seed.items.map((item) => item.addedAt),
  );
}

async function applyCaptureManifestDownloadTerminal(
  downloadId: number,
  state: "complete" | "interrupted",
  missing = false,
): Promise<boolean> {
  const listed = await listCaptureRuns();
  if (!listed.ok) {
    updateCaptureCleanupRetry(true);
    return false;
  }
  const owners: Array<{
    run: CaptureRunV1;
    record: CaptureManifestRecordV1;
    output: CaptureManifestOutputV1;
  }> = [];
  for (const run of listed.runs) {
    if (run.planId.startsWith("capture-single-plan:")) continue;
    const read = await getCaptureManifestRecord(run.runId);
    if (!read.ok) {
      updateCaptureCleanupRetry(true);
      return false;
    }
    if (!read.record) continue;
    for (const format of read.record.seed.formats) {
      const output = read.record.outputs[format];
      if (output && output.state !== "pending" && output.downloadId === downloadId) {
        owners.push({ run, record: read.record, output });
      }
    }
  }
  if (owners.length === 0) return false;
  // Chrome download IDs are globally unique. Multiple durable owners indicate
  // corrupt state; consume the event rather than letting another ledger mutate.
  if (owners.length !== 1) {
    updateCaptureCleanupRetry(true);
    return true;
  }
  const { run, output } = owners[0];
  if (output.state === "complete") {
    if (!await appendCaptureManifestDownloadId(run.runId, downloadId)) {
      updateCaptureCleanupRetry(true);
    }
    const cleaned = await revokeCaptureManifestBlob(run.runId, output.attemptId);
    if (!cleaned) updateCaptureCleanupRetry(true);
    scheduleCaptureManifestFinalization();
    return true;
  }
  if (output.state === "failed") {
    const cleaned = await revokeCaptureManifestBlob(run.runId, output.attemptId);
    if (!cleaned) updateCaptureCleanupRetry(true);
    scheduleCaptureManifestFinalization();
    return true;
  }
  if (output.state !== "saving" || output.downloadId !== downloadId) {
    updateCaptureCleanupRetry(true);
    return true;
  }
  const mutation = await mutateCaptureManifestOutput({
    runId: run.runId,
    format: output.format,
    action: state === "complete"
      ? {
          type: "complete",
          format: output.format,
          expectedRevision: output.revision,
          attemptId: output.attemptId,
          downloadId,
          now: Math.max(Date.now(), output.updatedAt),
        }
      : {
          type: "fail",
          format: output.format,
          expectedRevision: output.revision,
          attemptId: output.attemptId,
          errorCode: missing ? "MANIFEST_SAVE_STATE_UNKNOWN" : "MANIFEST_SAVE_FAILED",
          retryable: true,
          now: Math.max(Date.now(), output.updatedAt),
        },
  });
  if (!mutation.ok) {
    const replay = await getCaptureManifestRecord(run.runId);
    const latest = replay.ok ? replay.record?.outputs[output.format] : undefined;
    const durablyTerminal = (latest?.state === "complete" || latest?.state === "failed") &&
      latest.attemptId === output.attemptId;
    if (!durablyTerminal) {
      updateCaptureCleanupRetry(true);
      return true;
    }
  }
  const latest = await getCaptureManifestRecord(run.runId);
  const terminal = latest.ok ? latest.record?.outputs[output.format] : undefined;
  if (terminal?.state === "complete" && terminal.downloadId === downloadId) {
    if (!await appendCaptureManifestDownloadId(run.runId, downloadId)) {
      updateCaptureCleanupRetry(true);
    }
  }
  const cleaned = await revokeCaptureManifestBlob(run.runId, output.attemptId);
  if (!cleaned) updateCaptureCleanupRetry(true);
  scheduleCaptureManifestFinalization();
  return true;
}

async function reconcileCaptureManifests(allowAutomatic: boolean): Promise<boolean> {
  for (let pass = 0; pass < 128; pass += 1) {
    const listed = await listCaptureRuns();
    if (!listed.ok) return false;
    const records: CaptureManifestRecordV1[] = [];
    const runsById = new Map(listed.runs.map((run) => [run.runId, run] as const));
    const jobsByRunId = new Map<string, CaptureJobV1[]>();

    for (const run of listed.runs) {
      const read = await getCaptureManifestRecord(run.runId);
      if (!read.ok) return false;
      if (run.planId.startsWith("capture-single-plan:")) {
        if (read.record) return false;
        continue;
      }
      if (!read.record) continue; // Pre-C5 retained run.
      let record = read.record;
      const runIsMediaTerminal = run.status === "complete" || run.status === "partial" ||
        run.status === "cancelled";
      if (!runIsMediaTerminal) {
        // Capture recovery immediately precedes this pass and owns the active
        // job graph. An active run cannot truthfully have started manifest
        // delivery; retaining its untouched pending record is enough for
        // complete orphan-Blob accounting without rereading every media job.
        if (
          record.finalizedAt !== undefined ||
          record.seed.formats.some((format) => record.outputs[format]?.state !== "pending")
        ) return false;
        records.push(record);
        continue;
      }

      const hasPendingOutput = record.seed.formats.some(
        (format) => record.outputs[format]?.state === "pending",
      );
      let jobsForManifest: CaptureJobV1[] | undefined;
      if (record.finalizedAt === undefined || hasPendingOutput) {
        const jobs = await captureJobsForRun(run);
        if (!jobs || !captureManifestMediaIsTerminal(jobs)) return false;
        jobsForManifest = jobs;
      }
      if (record.finalizedAt === undefined) {
        const frozenJobs = await freezeCaptureManifestJobResults(jobsForManifest!);
        if (!frozenJobs) return false;
        jobsForManifest = frozenJobs;
        const finalized = await finalizeStoredCaptureManifestRecord({
          runId: run.runId,
          finalizedAt: captureManifestMinimumFinalizedAt(record),
        });
        if (!finalized.ok) return false;
        record = finalized.record;
      }
      if (jobsForManifest) jobsByRunId.set(run.runId, jobsForManifest);
      for (const format of record.seed.formats) {
        const output = record.outputs[format];
        if (output?.state === "complete" &&
          !run.manifestDownloadIds?.includes(output.downloadId) &&
          !await appendCaptureManifestDownloadId(run.runId, output.downloadId)) {
          return false;
        }
      }
      records.push(record);
    }

    const offscreen = await activeCaptureManifestBlobs();
    const downloads: Array<{
      downloadId: number;
      state: "in_progress" | "complete" | "interrupted" | "missing" | "unknown";
    }> = [];
    for (const record of records) {
      for (const format of record.seed.formats) {
        const output = record.outputs[format];
        if (output?.state !== "saving" || output.downloadId === undefined) continue;
        const observed = await observedCaptureDownload(output.downloadId);
        downloads.push({
          downloadId: output.downloadId,
          state: observed?.state ?? "unknown",
        });
      }
    }
    const planned = planCaptureManifestRecovery({
      schemaVersion: 1,
      recordsComplete: true,
      records,
      offscreen,
      downloads,
    });
    if (!planned.ok) return false;

    let hasMonitor = false;
    for (const action of planned.actions) {
      if (action.type === "monitor_download") {
        hasMonitor = true;
        continue;
      }
      if (action.type === "revoke_blob") {
        if (!await revokeCaptureManifestBlob(action.runId, action.attemptId)) return false;
        continue;
      }
      const currentRead = await getCaptureManifestRecord(action.runId);
      const currentOutput = currentRead.ok
        ? currentRead.record?.outputs[action.format]
        : undefined;
      if (
        !currentRead.ok ||
        !currentRead.record ||
        currentOutput?.state !== "saving" ||
        currentOutput.attemptId !== action.attemptId ||
        currentOutput.revision !== action.expectedRevision
      ) return false;
      const mutationTime = Math.max(
        Date.now(),
        currentRead.record.finalizedAt ?? 0,
        currentOutput.updatedAt,
      );
      const result = await mutateCaptureManifestOutput({
        runId: action.runId,
        format: action.format,
        action: action.type === "complete_output"
          ? {
              type: "complete",
              format: action.format,
              expectedRevision: action.expectedRevision,
              attemptId: action.attemptId,
              downloadId: action.downloadId,
              now: mutationTime,
            }
          : {
              type: "fail",
              format: action.format,
              expectedRevision: action.expectedRevision,
              attemptId: action.attemptId,
              errorCode: action.errorCode,
              retryable: action.retryable,
              now: mutationTime,
            },
      });
      if (!result.ok) return false;
      if (action.type === "complete_output" &&
        !await appendCaptureManifestDownloadId(action.runId, action.downloadId)) {
        return false;
      }
    }
    if (planned.requiresReplan) continue;

    if (planned.blockers.some((blocker) => blocker.type !== "blob_capacity_limited")) {
      return false;
    }
    if (allowAutomatic && planned.eligibleAutomaticStarts.length > 0) {
      for (const start of planned.eligibleAutomaticStarts) {
        const run = runsById.get(start.runId);
        const jobs = jobsByRunId.get(start.runId);
        if (!run || !jobs || !captureManifestMediaIsTerminal(jobs)) return false;
        await startCaptureManifestOutput({
          run,
          jobs,
          format: start.format,
          attemptId: automaticCaptureManifestAttemptId(),
          trigger: "automatic",
        });
      }
      continue;
    }
    return !hasMonitor && planned.blockers.length === 0;
  }
  return false;
}

async function handleCaptureManifestRetry(
  request: CaptureManifestRetryRequest,
): Promise<unknown> {
  const listed = await listCaptureRuns();
  if (!listed.ok) return { ok: false, reason: "manifest_storage_unavailable" };
  let requested:
    | { run: CaptureRunV1; record: CaptureManifestRecordV1; output: CaptureManifestOutputV1 }
    | undefined;
  for (const run of listed.runs) {
    if (run.planId.startsWith("capture-single-plan:")) continue;
    const read = await getCaptureManifestRecord(run.runId);
    if (!read.ok) return { ok: false, reason: "manifest_storage_unavailable" };
    if (!read.record) continue;
    for (const format of read.record.seed.formats) {
      const output = read.record.outputs[format];
      if (output?.attemptIds.includes(request.commandId)) {
        if (run.runId !== request.runId || format !== request.format) {
          return { ok: false, reason: "manifest_retry_conflict" };
        }
        if (
          output.state !== "pending" &&
          output.attemptId === request.commandId &&
          (output.state === "saving" || output.state === "complete")
        ) {
          return { ok: true, runId: request.runId, format: request.format, replayed: true };
        }
        return { ok: false, reason: "manifest_attempt_failed" };
      }
    }
    if (run.runId === request.runId) {
      const output = read.record.outputs[request.format];
      if (output) requested = { run, record: read.record, output };
    }
  }
  if (!requested) return { ok: false, reason: "manifest_not_found" };
  if (requested.output.state !== "failed" || !requested.output.retryable) {
    return { ok: false, reason: "manifest_not_retryable" };
  }
  const jobs = await captureJobsForRun(requested.run);
  if (!jobs || !captureManifestMediaIsTerminal(jobs)) {
    return { ok: false, reason: "manifest_storage_unavailable" };
  }
  if (Object.values(requested.record.outputs).some((output) => output?.state === "saving")) {
    return { ok: false, reason: "manifest_retry_conflict" };
  }
  const blobState = await activeCaptureManifestBlobs();
  if (!blobState.known || !await revokeCaptureManifestBlob(
    request.runId,
    requested.output.attemptId,
  )) {
    return { ok: false, reason: "manifest_retry_conflict" };
  }
  const result = await startCaptureManifestOutput({
    run: requested.run,
    jobs,
    format: request.format,
    attemptId: request.commandId,
    trigger: "retry",
  });
  return result.ok
    ? { ok: true, runId: request.runId, format: request.format, replayed: result.replayed }
    : { ok: false, reason: result.reason };
}

async function refreshCaptureRunStatus(runId: string): Promise<void> {
  const listed = await listCaptureRuns();
  if (!listed.ok) return;
  const run = listed.runs.find((candidate) => candidate.runId === runId);
  if (!run) return;
  const jobs = await captureJobsForRun(run);
  if (!jobs || !captureManifestMediaIsTerminal(jobs)) {
    return;
  }
  if (run.status === "complete" || run.status === "partial" || run.status === "cancelled") {
    if (!run.planId.startsWith("capture-single-plan:")) {
      scheduleCaptureManifestFinalization();
    }
    return;
  }
  const status: CaptureRunV1["status"] = jobs.every((job) => job.state === "complete")
    ? "complete"
    : jobs.every((job) => job.state === "cancelled")
      ? "cancelled"
      : "partial";
  if (run.status === "queued" && status !== "cancelled") {
    const running = await updateCaptureRun({
      runId,
      expectedStatus: "queued",
      update: (current) => ({ ...current, status: "running" }),
    });
    if (!running.ok) return;
  }
  const terminalized = await updateCaptureRun({
    runId,
    expectedStatus: status === "cancelled" && run.status === "queued" ? "queued" : "running",
    update: (current) => ({ ...current, status }),
  });
  if (terminalized.ok && !run.planId.startsWith("capture-single-plan:")) {
    scheduleCaptureManifestFinalization();
  }
}

function captureRuleKey(job: Pick<CaptureJobV1, "jobId" | "attemptId">): string {
  return `capture:${job.jobId}:${job.attemptId}`;
}

function captureOffscreenPrefix(job: CaptureJobV1): "hls-download" | "dash-download" | "webm-transcode" {
  if (job.snapshot.media.kind === "hls") return "hls-download";
  if (job.snapshot.media.kind === "dash") return "dash-download";
  return "webm-transcode";
}

async function releaseCaptureAttemptAuthorization(job: CaptureJobV1): Promise<boolean> {
  const leaseId = job.snapshot.headerLeaseId;
  const ruleRemoved = leaseId
    ? await removeCaptureLeasedHeaderRule(captureRuleKey(job), leaseId)
    : await removeCaptureHeaderReplayRule(captureRuleKey(job));
  if (!ruleRemoved || !leaseId) return ruleRemoved;
  const released = await retireClaimedCaptureHeaderLease({
    leaseId,
    runId: job.runId,
    jobId: job.jobId,
    attemptId: job.attemptId,
    now: Date.now(),
  });
  return released.ok;
}

async function revokeCaptureOffscreenIdentity(
  prefix: "hls-download" | "dash-download" | "webm-transcode",
  jobId: string,
  attemptId: string,
): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: `${prefix}-revoke`,
      jobId,
      attemptId,
    }) as { ok?: boolean; jobId?: string; attemptId?: string } | undefined;
    if (
      response?.ok === true &&
      response.jobId === jobId &&
      response.attemptId === attemptId
    ) return true;
  } catch {
    // Confirm absence below. A missing receiver is safe only when the exact
    // offscreen document no longer exists (and therefore owns no Blob/worker).
  }
  try {
    const contexts = (await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
      documentUrls: [chrome.runtime.getURL("offscreen.html")],
    })) as chrome.runtime.ExtensionContext[] | undefined;
    return !contexts || contexts.length === 0;
  } catch {
    return false;
  }
}

function revokeCaptureOffscreenAttempt(job: CaptureJobV1): Promise<boolean> {
  return revokeCaptureOffscreenIdentity(
    captureOffscreenPrefix(job),
    job.jobId,
    job.attemptId,
  );
}

async function cleanupCaptureAttempt(job: CaptureJobV1): Promise<boolean> {
  if (job.resourceClass !== "heavy") {
    if (!job.snapshot.headerLeaseId) return true;
    const retired = await retireClaimedCaptureHeaderLease({
      leaseId: job.snapshot.headerLeaseId,
      runId: job.runId,
      jobId: job.jobId,
      attemptId: job.attemptId,
      now: Date.now(),
    });
    return retired.ok;
  }
  const authorizationReleased = await releaseCaptureAttemptAuthorization(job);
  const offscreenReleased = await revokeCaptureOffscreenAttempt(job);
  return authorizationReleased && offscreenReleased;
}

async function failCaptureJob(
  job: CaptureJobV1,
  code: string,
  customerMessage: string,
  retryable: boolean,
  scheduleNext = true,
): Promise<boolean> {
  const failed = await applyStoredCaptureJobEvent({
    jobId: job.jobId,
    attemptId: job.attemptId,
    event: { type: "fail", code, customerMessage, retryable },
  });
  if (!failed.ok) return false;
  await settleCaptureTerminalQuota(failed.job);
  const cleaned = await cleanupCaptureAttempt(job);
  await refreshCaptureRunStatus(job.runId);
  if (scheduleNext) void scheduleCaptureQueueDrain();
  return cleaned;
}

type CaptureStreamRevalidationResult =
  | {
      ok: true;
      sourceId: string;
      audioSourceId?: string;
      executionSnapshotId: string;
    }
  | {
      ok: false;
      code: "STREAM_REVALIDATION_FAILED" | "VARIANT_STALE" | "QUALITY_POLICY_NO_MATCH";
      customerMessage: string;
      retryable: boolean;
    };

async function revalidateCaptureStreamQuality(
  job: CaptureJobV1,
  quality: PersistentStreamQualityChoiceV1,
): Promise<CaptureStreamRevalidationResult> {
  const media = job.snapshot.media;
  if (
    (media.kind !== "hls" && media.kind !== "dash") ||
    quality.selector.kind !== media.kind
  ) {
    return {
      ok: false,
      code: "VARIANT_STALE",
      customerMessage: "The reviewed stream quality no longer matches this item. Review the pack again.",
      retryable: false,
    };
  }
  const inspection = await inspectNormalizedCaptureVariants({
    requestId: `execute:${job.jobId}:${job.attemptId}`,
    reviewId: `execute:${job.runId}:${job.attemptId}`,
    url: media.url,
    kind: media.kind,
    deadlineAt: Date.now() + CAPTURE_VARIANT_INSPECT_DEADLINE_MS,
    retainForExecution: true,
  });
  if (!inspection.ok) {
    const transient = inspection.code === "DEADLINE_EXCEEDED" ||
      inspection.code === "FETCH_FAILED" ||
      inspection.code === "REVIEW_LIMIT" ||
      inspection.code === "REVIEW_REQUEST_LIMIT" ||
      inspection.code === "EXECUTION_SNAPSHOT_LIMIT" ||
      inspection.code === "EXECUTION_SNAPSHOT_UNAVAILABLE";
    return transient
      ? {
          ok: false,
          code: "STREAM_REVALIDATION_FAILED",
          customerMessage: "ClipHutch could not recheck this stream right now. Retry while the source page remains available.",
          retryable: true,
        }
      : {
          ok: false,
          code: "VARIANT_STALE",
          customerMessage: "The reviewed stream manifest changed or is no longer supported. Review the pack again.",
          retryable: false,
        };
  }

  const executionSnapshotId = inspection.executionSnapshotId;
  if (executionSnapshotId === undefined) {
    return {
      ok: false,
      code: "STREAM_REVALIDATION_FAILED",
      customerMessage: "ClipHutch could not retain the inspected stream for local processing. Retry this item.",
      retryable: true,
    };
  }
  let transferred = false;
  try {
    const resolved = revalidatePersistentCaptureStreamQualityV1(
      quality,
      inspection.options,
    );
    if (resolved.ok) {
      const executionSource = inspection.executionSourceByStableId.get(
        resolved.selector.stableId,
      );
      if (executionSource !== undefined) {
        transferred = true;
        return {
          ok: true,
          ...executionSource,
          executionSnapshotId,
        };
      }
      return {
        ok: false,
        code: "QUALITY_POLICY_NO_MATCH",
        customerMessage: "ClipHutch could not bind the reviewed quality to the fresh manifest. Review the pack again.",
        retryable: false,
      };
    }
    return resolved.reason === "variant_stale"
      ? {
          ok: false,
          code: "VARIANT_STALE",
          customerMessage: "The exact quality you reviewed is no longer available. Review the pack and choose again.",
          retryable: false,
        }
      : {
          ok: false,
          code: "QUALITY_POLICY_NO_MATCH",
          customerMessage: "No current quality satisfies the reviewed rule. Review the pack before saving it.",
          retryable: false,
        };
  } finally {
    if (!transferred) {
      await discardCaptureExecutionSnapshot(executionSnapshotId);
    }
  }
}

async function startCaptureHeavyJob(job: CaptureJobV1): Promise<void> {
  let headerLease: CaptureHeaderLeaseV1 | null = null;
  let pendingExecutionSnapshotId: string | undefined;
  const startingRuleKey = captureRuleKey(job);
  activeCaptureStartingRuleKeys.add(startingRuleKey);
  try {
    try {
      await ensureOffscreenDocument();
    } catch {
      await failCaptureJob(job, "OFFSCREEN_INIT", "ClipHutch could not start its local media processor.", true);
      return;
    }

    // Offscreen creation can yield long enough for another surface to cancel
    // and terminalize this attempt. Never resurrect authorization from a cached
    // snapshot after that terminal cleanup boundary.
    const current = await getCaptureJob(job.jobId);
    if (
      !current.ok ||
      !current.job ||
      current.job.attemptId !== job.attemptId ||
      current.job.state !== "starting"
    ) {
      if (!current.ok) updateCaptureCleanupRetry(true);
      void scheduleCaptureQueueDrain();
      return;
    }
    if (job.snapshot.headerLeaseId) {
      const claimed = await getClaimedCaptureHeaderLease({
        leaseId: job.snapshot.headerLeaseId,
        runId: job.runId,
        jobId: job.jobId,
        attemptId: job.attemptId,
        now: Date.now(),
      });
      if (!claimed.ok || !claimed.lease) {
        const expired = claimed.ok || claimed.reason === "lease_expired" ||
          claimed.reason === "owner_conflict";
        const retryable = !claimed.ok && claimed.reason === "storage_unavailable";
        await failCaptureJob(
          job,
          expired ? "SOURCE_AUTH_EXPIRED" : "SOURCE_AUTH_UNAVAILABLE",
          expired
            ? job.itemId.startsWith("capture-single-item:")
              ? QUICK_CAPTURE_SOURCE_AUTH_EXPIRED_MESSAGE
              : "Source authorization expired. Reopen the source page and add this item again."
            : "ClipHutch could not safely read this item's selected authorization snapshot.",
          retryable,
        );
        return;
      }
      headerLease = claimed.lease;
    }

    const media = job.snapshot.media;
    let settings: UserSettings;
    try {
      const replayReady = headerLease
        ? await installCaptureLeasedHeaderRule({
            jobKey: captureRuleKey(job),
            ownerKind: "attempt",
            lease: headerLease,
            validateBeforeInstall: async () => {
              const latest = await getCaptureJob(job.jobId);
              return latest.ok &&
                latest.job?.attemptId === job.attemptId &&
                latest.job.state === "starting" &&
                latest.job.snapshot.headerLeaseId === headerLease?.leaseId;
            },
          })
        : true;
      if (!replayReady) throw new Error("Header replay setup failed.");
      settings = await getSettings();
    } catch {
      await failCaptureJob(
        job,
        "EXECUTOR_SETUP_FAILED",
        "ClipHutch could not prepare this local media job.",
        true,
      );
      return;
    }
    const quality = job.snapshot.quality;
    let revalidatedSourceId: string | undefined;
    let revalidatedAudioSourceId: string | undefined;
    if (isPersistentStreamQualityChoiceV1(quality)) {
      const revalidated = await revalidateCaptureStreamQuality(job, quality);
      if (!revalidated.ok) {
        await failCaptureJob(
          job,
          revalidated.code,
          revalidated.customerMessage,
          revalidated.retryable,
        );
        return;
      }
      revalidatedSourceId = revalidated.sourceId;
      revalidatedAudioSourceId = revalidated.audioSourceId;
      pendingExecutionSnapshotId = revalidated.executionSnapshotId;
    }
    const hlsVariantUrl = isPersistentStreamQualityChoiceV1(quality)
      ? quality.selector.kind === "hls" ? revalidatedSourceId : undefined
      : quality.mode === "stream"
        ? quality.variantKind === "hls"
          ? quality.variantUrl
          : quality.variantKind === undefined
            ? quality.fixedVariantId
            : undefined
        : undefined;
    const dashRepresentationId = isPersistentStreamQualityChoiceV1(quality)
      ? quality.selector.kind === "dash" ? revalidatedSourceId : undefined
      : quality.mode === "stream"
        ? quality.variantKind === "dash"
          ? quality.representationId
          : quality.variantKind === undefined
            ? quality.fixedVariantId
            : undefined
        : undefined;
    const streamSizeCapBytes = isPersistentStreamQualityChoiceV1(quality)
      ? quality.maxDownloadBytes
      : settings.hlsSizeCapBytes;
    const message = media.kind === "hls"
      ? {
          type: "hls-download-start",
          jobId: job.jobId,
          attemptId: job.attemptId,
          url: media.url,
          sizeCapBytes: streamSizeCapBytes,
          variantUrl: hlsVariantUrl,
          ...(isPersistentStreamQualityChoiceV1(quality)
            ? {
                audioUrl: revalidatedAudioSourceId,
                exactVariantSelection: true,
                executionSnapshotId: pendingExecutionSnapshotId,
              }
            : {}),
          ...(headerLease ? { authorizationExpiresAt: headerLease.expiresAt } : {}),
        }
      : media.kind === "dash"
        ? {
            type: "dash-download-start",
            jobId: job.jobId,
            attemptId: job.attemptId,
            url: media.url,
            sizeCapBytes: streamSizeCapBytes,
            videoRepresentationId: dashRepresentationId,
            ...(isPersistentStreamQualityChoiceV1(quality)
              ? { executionSnapshotId: pendingExecutionSnapshotId }
              : {}),
            ...(headerLease ? { authorizationExpiresAt: headerLease.expiresAt } : {}),
          }
        : {
            type: "webm-transcode-start",
            jobId: job.jobId,
            attemptId: job.attemptId,
            url: media.url,
            sizeCapBytes: WEBM_TRANSCODE_SIZE_CAP_BYTES,
            ...(headerLease ? { authorizationExpiresAt: headerLease.expiresAt } : {}),
          };

    let response:
      | { ok?: boolean; code?: string; jobId?: string; attemptId?: string }
      | undefined;
    try {
      response = await chrome.runtime.sendMessage(message) as
        | { ok?: boolean; code?: string; jobId?: string; attemptId?: string }
        | undefined;
    } catch {
      response = undefined;
    }
    if (
      !response?.ok ||
      response.jobId !== job.jobId ||
      response.attemptId !== job.attemptId
    ) {
      if (pendingExecutionSnapshotId !== undefined) {
        await discardCaptureExecutionSnapshot(pendingExecutionSnapshotId);
        pendingExecutionSnapshotId = undefined;
      }
      await failCaptureJob(
        job,
        response?.code ?? "EXECUTOR_START_FAILED",
        response?.code === "CONCURRENT_LIMIT"
          ? "Another media item is still being processed."
          : response?.code === "SOURCE_AUTH_EXPIRED"
            ? job.itemId.startsWith("capture-single-item:")
              ? QUICK_CAPTURE_SOURCE_AUTH_EXPIRED_MESSAGE
              : "Source authorization expired. Reopen the source page and add this item again."
            : response?.code === "EXECUTION_SNAPSHOT_INVALID"
              ? "The inspected stream changed before local processing could start. Retry this item to inspect it again."
            : "ClipHutch could not confirm that local processing started.",
        response?.code !== "SOURCE_AUTH_EXPIRED",
      );
      return;
    }
    // Exact ownership acknowledgement means offscreen atomically consumed the
    // handle before starting work. It must never be discarded after this point.
    pendingExecutionSnapshotId = undefined;

    const running = await applyStoredCaptureJobEvent({
      jobId: job.jobId,
      attemptId: job.attemptId,
      event: { type: "running" },
    });
    if (!running.ok) {
      // A very small stream can report its terminal Blob between the ownership
      // ACK and this write. That terminal handler is allowed to advance the same
      // attempt directly from `starting`; do not cancel work that already owns a
      // later valid state.
      const latest = await getCaptureJob(job.jobId);
      if (
        !latest.ok ||
        !latest.job ||
        latest.job.attemptId !== job.attemptId ||
        (latest.job.state !== "processing" &&
          latest.job.state !== "delivery_pending" &&
          latest.job.state !== "saving" &&
          !CAPTURE_TERMINAL_JOB_STATES.has(latest.job.state))
      ) {
        await chrome.runtime.sendMessage({
          type: `${captureOffscreenPrefix(job)}-cancel`,
          jobId: job.jobId,
          attemptId: job.attemptId,
        }).catch(() => undefined);
        await cleanupCaptureAttempt(job);
      }
    }
  } finally {
    if (pendingExecutionSnapshotId !== undefined) {
      await discardCaptureExecutionSnapshot(pendingExecutionSnapshotId);
      pendingExecutionSnapshotId = undefined;
    }
    activeCaptureStartingRuleKeys.delete(startingRuleKey);
    void scheduleCaptureQueueDrain();
  }
}

function startCaptureClaim(claim: CaptureJobClaim): Promise<void> {
  return withKeyLock(
    CAPTURE_ATTEMPT_SIDE_EFFECTS_LOCK_KEY,
    () => startCaptureClaimUnlocked(claim),
  );
}

async function startCaptureClaimUnlocked(claim: CaptureJobClaim): Promise<void> {
  const started = await applyStoredCaptureJobEvent({
    jobId: claim.jobId,
    attemptId: claim.attemptId,
    event: { type: "start" },
  });
  if (!started.ok) return;
  await markCaptureRunRunning(started.job.runId);

  if (started.job.resourceClass === "heavy") {
    await startCaptureHeavyJob(started.job);
    return;
  }
  const result = await executeNativeCaptureJob(
    { jobId: started.job.jobId, attemptId: started.job.attemptId },
    {
      applyEvent: (input) => applyStoredCaptureJobEvent(input),
      startDownload: (options) => chrome.downloads.download(options),
      cancelDownload: (downloadId) => chrome.downloads.cancel(downloadId),
      getDownloadObservation: async (downloadId) => {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (!item) return undefined;
        return {
          state: item.state,
          actualBasename: finalBasename(item.filename),
          sizeBytes: item.fileSize !== undefined && item.fileSize >= 0
            ? item.fileSize
            : undefined,
        };
      },
    },
  );
  if (!result.ok || result.state === "complete") {
    const latest = await getCaptureJob(started.job.jobId);
    if (latest.ok && latest.job) await settleCaptureTerminalQuota(latest.job);
    await refreshCaptureRunStatus(started.job.runId);
  }
  if (!result.ok || result.state === "complete") void scheduleCaptureQueueDrain();
}

async function captureHeavyCleanupPending(
  jobs: readonly CaptureJobV1[],
  offscreen: { known: boolean; attempts: ActiveOffscreenAttemptV1[] },
): Promise<boolean> {
  if (!offscreen.known) return true;
  const [leases, dnr] = await Promise.all([
    listCaptureHeaderLeases(Date.now()),
    listCaptureDnrOwners(),
  ]);
  if (!leases.ok || !dnr.ok) return true;
  // Header material is still physically present until the exact session write
  // that removes every expired record commits.
  if (leases.expiredLeaseIds.length > 0) return true;
  const jobsById = new Map(jobs.map((job) => [job.jobId, job] as const));
  const leasesById = new Map(leases.leases.map((lease) => [lease.leaseId, lease] as const));
  const activeAttempts = new Set(
    offscreen.attempts.map((attempt) => captureProgressKey(attempt.jobId, attempt.attemptId)),
  );

  for (const lease of leases.leases) {
    if (!lease.acceptedAttemptOwner) continue;
    const job = jobsById.get(lease.acceptedAttemptOwner.jobId);
    if (!captureJobOwnsLease(job, lease) || !CAPTURE_LEASE_REQUIRED_STATES.has(job!.state)) {
      return true;
    }
  }
  for (const owner of dnr.owners) {
    if (owner.ownerKind !== "attempt") return true;
    const lease = leasesById.get(owner.leaseId);
    const accepted = lease?.acceptedAttemptOwner;
    const job = accepted ? jobsById.get(accepted.jobId) : undefined;
    if (
      !lease || !accepted || !job ||
      !captureJobOwnsLease(job, lease) ||
      captureRuleKey(job) !== owner.jobKey ||
      !CAPTURE_RULE_REQUIRED_STATES.has(job.state) ||
      !activeAttempts.has(captureProgressKey(job.jobId, job.attemptId))
    ) return true;
  }
  for (const attempt of offscreen.attempts) {
    const job = jobsById.get(attempt.jobId);
    if (
      !job ||
      job.resourceClass !== "heavy" ||
      job.attemptId !== attempt.attemptId ||
      CAPTURE_TERMINAL_JOB_STATES.has(job.state)
    ) return true;
  }
  return false;
}

async function reconcileOrphanedOffscreenAttempts(
  offscreen: { known: boolean; attempts: ActiveOffscreenAttemptV1[] },
): Promise<void> {
  if (!offscreen.known) return;
  for (const attempt of offscreen.attempts) {
    const current = await getCaptureJob(attempt.jobId);
    if (!current.ok) continue;
    if (
      current.job &&
      current.job.attemptId === attempt.attemptId &&
      !CAPTURE_TERMINAL_JOB_STATES.has(current.job.state)
    ) continue;
    if (current.job) {
      if (current.job.attemptId === attempt.attemptId) {
        await cleanupCaptureAttempt(current.job);
      } else {
        const staleEventType = current.job.snapshot.media.kind === "hls"
          ? "hls-download-error"
          : current.job.snapshot.media.kind === "dash"
            ? "dash-download-error"
            : "webm-transcode-error";
        await cleanupCaptureIdentity(staleEventType, attempt.jobId, attempt.attemptId);
      }
      continue;
    }
    // A pruned/missing job no longer tells us which heavy executor owns the
    // identity. Try each strict control kind; only the exact active kind can
    // release work, while missing-kind controls are idempotent tombstones.
    for (const type of [
      "hls-download-error",
      "dash-download-error",
      "webm-transcode-error",
    ] as const) {
      if (await cleanupCaptureIdentity(type, attempt.jobId, attempt.attemptId)) break;
    }
  }
}

function updateCaptureCleanupRetry(pending: boolean): void {
  const plan = planCaptureCleanupRetry(pending, captureCleanupRetryAttempt);
  if (plan.kind === "clear") {
    captureCleanupRetryAttempt = plan.nextAttempt;
    if (captureCleanupRetryTimer !== undefined) clearTimeout(captureCleanupRetryTimer);
    captureCleanupRetryTimer = undefined;
    void chrome.alarms.clear(CAPTURE_CLEANUP_RETRY_ALARM_NAME).catch(() => undefined);
    return;
  }
  if (captureCleanupRetryTimer !== undefined) return;
  if (plan.kind === "alarm") {
    // Timers provide quick in-worker repair. A named alarm provides a durable
    // later wake when Chrome evicts the MV3 worker or the external cleanup
    // failure outlives that bounded burst.
    void chrome.alarms.get(CAPTURE_CLEANUP_RETRY_ALARM_NAME).then((existing) => {
      if (existing) return;
      return chrome.alarms.create(CAPTURE_CLEANUP_RETRY_ALARM_NAME, {
        when: Date.now() + plan.delayMs,
      });
    }).catch(() => undefined);
    return;
  }
  captureCleanupRetryAttempt = plan.nextAttempt;
  captureCleanupRetryTimer = setTimeout(() => {
    captureCleanupRetryTimer = undefined;
    void scheduleCaptureQueueDrain();
  }, plan.delayMs);
}

async function drainCaptureQueueOnce(): Promise<void> {
  const recovery = captureRecoveryBarrier;
  if (recovery) await recovery.catch(() => undefined);
  const recoveryComplete = await withKeyLock(
    CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY,
    recoverCaptureJobs,
  );
  if (!recoveryComplete) updateCaptureCleanupRetry(true);
  const listed = await listCaptureRuns();
  if (!listed.ok) {
    updateCaptureCleanupRetry(true);
    return;
  }
  let manifestRecoveryClean = true;
  await withKeyLock(CAPTURE_ATTEMPT_SIDE_EFFECTS_LOCK_KEY, async () => {
    manifestRecoveryClean = await reconcileCaptureManifests(true);
  });
  const runs = [...listed.runs]
    .filter((run) => run.status === "queued" || run.status === "running")
    .sort((left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId));
  const jobs: CaptureJobV1[] = [];
  for (const run of runs) {
    await reconcileCaptureRunQueue(run.runId);
    const runJobs = await captureJobsForRun(run);
    if (runJobs) jobs.push(...runJobs);
  }
  const initialOffscreen = await activeCaptureOffscreenAttempts();
  const cleanupState = await withKeyLock(
    CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY,
    async () => ({
      authorizationClean: await reconcileCaptureAuthorizationArtifacts({
        now: Date.now(),
        offscreen: initialOffscreen,
      }),
      reviewStateClean: await reconcileClearedCaptureReviewState(),
    }),
  );
  await reconcileOrphanedOffscreenAttempts(initialOffscreen);
  const offscreen = await activeCaptureOffscreenAttempts();
  const heavyCleanupPending = !recoveryComplete || !cleanupState.authorizationClean ||
    await captureHeavyCleanupPending(jobs, offscreen);
  updateCaptureCleanupRetry(
    heavyCleanupPending || !cleanupState.reviewStateClean || !manifestRecoveryClean,
  );
  let claims: CaptureJobClaim[];
  try {
    claims = claimCaptureJobsFifo(jobs).claims;
  } catch {
    updateCaptureCleanupRetry(true);
    return;
  }
  await Promise.all(
    claims
      .filter((claim) => claim.resourceClass !== "heavy" || !heavyCleanupPending)
      .map((claim) => startCaptureClaim(claim)),
  );
}

async function observedCaptureDownload(
  downloadId: number,
): Promise<ObservedChromeDownloadV1 | undefined> {
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) return { downloadId, state: "missing" };
    const state = item.state === "complete"
      ? "complete"
      : item.state === "interrupted"
        ? "interrupted"
        : "in_progress";
    return {
      downloadId,
      state,
      ...(typeof item.filename === "string" ? { filename: item.filename } : {}),
      ...(typeof item.fileSize === "number" && item.fileSize >= 0
        ? { fileSize: item.fileSize }
        : {}),
    };
  } catch {
    // A failed query is not evidence that Chrome lost the download. Recovery
    // for this item pauses until another wake instead of manufacturing a
    // `missing` observation.
    return undefined;
  }
}

async function activeCaptureOffscreenAttempts(): Promise<{
  known: boolean;
  attempts: ActiveOffscreenAttemptV1[];
}> {
  try {
    const contexts = (await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
      documentUrls: [chrome.runtime.getURL("offscreen.html")],
    })) as chrome.runtime.ExtensionContext[] | undefined;
    if (!contexts || contexts.length === 0) return { known: true, attempts: [] };
    const response = await chrome.runtime.sendMessage({ type: "capture-executor-status" }) as
      | { ok?: boolean; active?: unknown }
      | undefined;
    if (!response?.ok || !Array.isArray(response.active)) {
      return { known: false, attempts: [] };
    }
    return {
      known: true,
      attempts: response.active as ActiveOffscreenAttemptV1[],
    };
  } catch {
    return { known: false, attempts: [] };
  }
}

async function executeCaptureRecoveryAction(
  action: CaptureRecoveryAction,
): Promise<boolean> {
  const latest = await getCaptureJob(action.jobId);
  if (
    !latest.ok ||
    !latest.job ||
    latest.job.attemptId !== action.attemptId ||
    latest.job.revision !== action.expectedRevision
  ) {
    return false;
  }
  if (action.type === "schedule" || action.type === "monitor_download") return true;
  if (action.type === "reattach_offscreen") {
    if (latest.job.state === "starting") {
      const result = await applyStoredCaptureJobEvent({
        jobId: action.jobId,
        attemptId: action.attemptId,
        event: { type: "running" },
      });
      return result.ok;
    }
    return latest.job.state === "running" || latest.job.state === "processing";
  }
  if (action.type === "cancel_offscreen") {
    const prefix = action.executor === "hls"
      ? "hls-download"
      : action.executor === "dash"
        ? "dash-download"
        : "webm-transcode";
    try {
      const response = await chrome.runtime.sendMessage({
        type: `${prefix}-cancel`,
        jobId: action.jobId,
        attemptId: action.attemptId,
      }) as { ok?: boolean; jobId?: string; attemptId?: string } | undefined;
      return response?.ok === true &&
        response.jobId === action.jobId &&
        response.attemptId === action.attemptId;
    } catch {
      return false;
    }
  }
  if (action.type === "cancel_download") {
    try {
      await chrome.downloads.cancel(action.downloadId);
      return true;
    } catch {
      return false;
    }
  }
  if (action.type === "apply_event") {
    const { attemptId: _attemptId, expectedRevision: _revision, ...event } = action.event;
    const result = await applyStoredCaptureJobEvent({
      jobId: action.jobId,
      attemptId: action.attemptId,
      event,
    });
    return result.ok;
  }
  await settleCaptureTerminalQuota(latest.job);
  const cleaned = await cleanupCaptureAttempt(latest.job);
  await refreshCaptureRunStatus(latest.job.runId);
  return cleaned;
}

const CAPTURE_LEASE_REQUIRED_STATES = new Set<CaptureJobV1["state"]>([
  "prepared",
  "queued",
  "starting",
  "running",
  "processing",
]);

const CAPTURE_RULE_REQUIRED_STATES = new Set<CaptureJobV1["state"]>([
  "starting",
  "running",
  "processing",
]);

function captureJobOwnsLease(
  job: CaptureJobV1 | undefined,
  lease: Pick<CaptureHeaderLeaseSummaryV1, "leaseId" | "acceptedAttemptOwner">,
): boolean {
  const owner = lease.acceptedAttemptOwner;
  return Boolean(
    job &&
    owner &&
    job.runId === owner.runId &&
    job.jobId === owner.jobId &&
    job.attemptId === owner.attemptId &&
    job.snapshot.headerLeaseId === lease.leaseId,
  );
}

function activeDraftOwnsLease(
  draft: CaptureDraftV1 | null,
  lease: CaptureHeaderLeaseSummaryV1,
): boolean {
  if (!draft || draft.draftId !== lease.draftId) return false;
  const item = draft.items[lease.itemId];
  const binding = item ? captureLeaseBindingForItem(draft.draftId, item) : undefined;
  return Boolean(
    binding &&
    item.headerLeaseId === lease.leaseId &&
    binding.leaseId === lease.leaseId &&
    binding.mediaId === lease.mediaId &&
    binding.sourceTabId === lease.sourceTabId &&
    binding.pageUrl === lease.pageUrl &&
    binding.sourceUrl === lease.sourceUrl &&
    binding.replayKind === lease.replayKind,
  );
}

async function removeCaptureDnrOwnerRecord(owner: CaptureDnrOwnerV1): Promise<boolean> {
  return removeCaptureLeasedHeaderRule(owner.jobKey, owner.leaseId);
}

/**
 * Reconciles sensitive C2 state after the job graph has been recovered.
 * Unknown graph reads fail closed by retaining unexpired attempt ownership;
 * expired rules are always removed before their lease registry is swept.
 */
async function reconcileCaptureAuthorizationArtifacts(input: {
  now: number;
  offscreen: { known: boolean; attempts: ActiveOffscreenAttemptV1[] };
}): Promise<boolean> {
  const listed = await listCaptureHeaderLeases(input.now);
  let cleanupSucceeded = listed.ok;
  const leasesById = listed.ok
    ? new Map(listed.leases.map((lease) => [lease.leaseId, lease] as const))
    : undefined;
  const dnr = await listCaptureDnrOwners();
  if (!dnr.ok) cleanupSucceeded = false;
  let expiredRulesRemoved = dnr.ok;
  if (dnr.ok) {
    for (const owner of dnr.owners) {
      const lease = leasesById?.get(owner.leaseId);
      const accepted = lease?.acceptedAttemptOwner;
      const currentRead = accepted ? await getCaptureJob(accepted.jobId) : undefined;
      const currentKnown = currentRead?.ok === true;
      const job = currentRead?.ok ? currentRead.job ?? undefined : undefined;
      const exactAttemptOwner = Boolean(
        owner.ownerKind === "attempt" &&
        accepted &&
        job &&
        captureRuleKey(job) === owner.jobKey &&
        job.snapshot.headerLeaseId === owner.leaseId &&
        captureJobOwnsLease(job, lease!),
      );
      const shouldRemove = owner.ownerKind === "review"
        ? owner.expiresAt <= input.now ||
          (leasesById !== undefined && lease === undefined) ||
          !activeCaptureReviewRuleKeys.has(owner.jobKey)
        : owner.expiresAt <= input.now ||
          (leasesById !== undefined && lease === undefined) ||
          (lease !== undefined && accepted === null) ||
          (currentKnown &&
            (!exactAttemptOwner ||
              !CAPTURE_RULE_REQUIRED_STATES.has(job!.state)));
      if (!shouldRemove) continue;
      const removed = await removeCaptureDnrOwnerRecord(owner);
      if (!removed) {
        cleanupSucceeded = false;
        if (owner.expiresAt <= input.now) expiredRulesRemoved = false;
      }
    }
  }

  if (!listed.ok) {
    await scheduleCaptureLeaseExpiryAlarm(input.now);
    return false;
  }
  const activeDraftRead = await getActiveCaptureDraft();
  if (!activeDraftRead.ok) cleanupSucceeded = false;
  const activeDraft = activeDraftRead.ok ? activeDraftRead.draft : undefined;
  for (const lease of listed.leases) {
    if (
      lease.draftItemOwnerActive &&
      activeDraft !== undefined &&
      !activeDraftOwnsLease(activeDraft, lease)
    ) {
      const released = await releaseCaptureHeaderLease({
        leaseId: lease.leaseId,
        draftId: lease.draftId,
        itemId: lease.itemId,
        mediaId: lease.mediaId,
        sourceTabId: lease.sourceTabId,
        pageUrl: lease.pageUrl,
        sourceUrl: lease.sourceUrl,
        replayKind: lease.replayKind,
        owner: { kind: "draft_item" },
        now: input.now,
      });
      if (!released.ok) cleanupSucceeded = false;
    }
    if (!lease.acceptedAttemptOwner) continue;
    const currentRead = await getCaptureJob(lease.acceptedAttemptOwner.jobId);
    if (!currentRead.ok) {
      cleanupSucceeded = false;
      continue;
    }
    const job = currentRead.job ?? undefined;
    if (captureJobOwnsLease(job, lease) && CAPTURE_LEASE_REQUIRED_STATES.has(job!.state)) {
      continue;
    }
    const ruleRemoved = await removeCaptureLeasedHeaderRule(
      `capture:${lease.acceptedAttemptOwner.jobId}:${lease.acceptedAttemptOwner.attemptId}`,
      lease.leaseId,
    );
    if (!ruleRemoved) {
      cleanupSucceeded = false;
      continue;
    }
    const retired = await retireClaimedCaptureHeaderLease({
      leaseId: lease.leaseId,
      runId: lease.acceptedAttemptOwner.runId,
      jobId: lease.acceptedAttemptOwner.jobId,
      attemptId: lease.acceptedAttemptOwner.attemptId,
      now: input.now,
    });
    if (!retired.ok) cleanupSucceeded = false;
  }

  if (listed.expiredLeaseIds.length > 0) {
    if (!expiredRulesRemoved) {
      cleanupSucceeded = false;
    } else {
      const swept = await sweepExpiredCaptureHeaderLeases(input.now);
      if (!swept.ok) cleanupSucceeded = false;
    }
  }
  if (!await scheduleCaptureLeaseExpiryAlarm(input.now)) cleanupSucceeded = false;
  return cleanupSucceeded;
}

function recoverCaptureJobs(): Promise<boolean> {
  return withKeyLock(CAPTURE_ATTEMPT_SIDE_EFFECTS_LOCK_KEY, recoverCaptureJobsUnlocked);
}

async function recoverCaptureJobsUnlocked(): Promise<boolean> {
  const now = Date.now();
  const leaseSnapshot = await listCaptureHeaderLeases(now);
  let recoveryComplete = leaseSnapshot.ok;
  const expiredLeaseIds = new Set(
    leaseSnapshot.ok ? leaseSnapshot.expiredLeaseIds : [],
  );
  const listed = await listCaptureRuns();
  if (!listed.ok) {
    await reconcileCaptureAuthorizationArtifacts({
      now,
      offscreen: await activeCaptureOffscreenAttempts(),
    });
    return false;
  }
  try {
    const commands = await listCaptureCommandRecords();
    await reconcileDownloadBatchReservations(
      commands.ok
        ? commands.records.map((record) => record.commandId)
        : listed.runs.map((run) => run.commandId),
    );
  } catch {
    // Keep the session graph intact; quota ownership can retry next wake.
    recoveryComplete = false;
  }
  const offscreen = await activeCaptureOffscreenAttempts();
  const knownNonterminalAttempts = new Set<string>();
  const rulesStillNeeded = new Set<string>();
  const jobsByRunId = new Map<string, CaptureJobV1[]>();
  for (const run of listed.runs) {
    const jobs = await captureJobsForRun(run);
    if (!jobs) {
      recoveryComplete = false;
      continue;
    }
    jobsByRunId.set(run.runId, jobs);
  }
  for (const run of listed.runs) {
    const jobs = jobsByRunId.get(run.runId);
    if (!jobs) continue;
    for (const job of jobs) {
      if (
        job.snapshot.headerLeaseId &&
        expiredLeaseIds.has(job.snapshot.headerLeaseId) &&
        CAPTURE_LEASE_REQUIRED_STATES.has(job.state)
      ) {
        const failed = await failCaptureJob(
          job,
          "SOURCE_AUTH_EXPIRED",
          job.itemId.startsWith("capture-single-item:")
            ? QUICK_CAPTURE_SOURCE_AUTH_EXPIRED_MESSAGE
            : "Source authorization expired. Reopen the source page and add this item again.",
          false,
          false,
        );
        if (!failed) recoveryComplete = false;
        continue;
      }
      if (
        job.resourceClass === "heavy" &&
        (job.state === "starting" || job.state === "running" || job.state === "processing") &&
        activeCaptureStartingRuleKeys.has(captureRuleKey(job))
      ) {
        knownNonterminalAttempts.add(captureProgressKey(job.jobId, job.attemptId));
        rulesStillNeeded.add(captureRuleKey(job));
        continue;
      }
      if (!CAPTURE_TERMINAL_JOB_STATES.has(job.state)) {
        knownNonterminalAttempts.add(captureProgressKey(job.jobId, job.attemptId));
        if (
          job.resourceClass === "heavy" &&
          (job.state === "starting" || job.state === "running" || job.state === "processing")
        ) {
          rulesStillNeeded.add(captureRuleKey(job));
        }
      }
      if (
        !offscreen.known &&
        job.resourceClass === "heavy" &&
        (job.state === "starting" ||
          job.state === "running" ||
          job.state === "processing" ||
          job.state === "cancelling")
      ) {
        recoveryComplete = false;
        continue;
      }
      const observation = job.downloadId === undefined
        ? undefined
        : await observedCaptureDownload(job.downloadId);
      if (job.downloadId !== undefined && observation === undefined) {
        recoveryComplete = false;
        continue;
      }
      const planned = planCaptureRecovery({
        schemaVersion: 1,
        jobs: [job],
        activeOffscreenAttempts: offscreen.attempts,
        downloads: observation ? [observation] : [],
      });
      if (!planned.ok) {
        recoveryComplete = false;
        continue;
      }
      for (const action of planned.actions) {
        const executed = await executeCaptureRecoveryAction(action);
        if (!executed) {
          recoveryComplete = false;
          break;
        }
        if (action.type === "cancel_download" || action.type === "monitor_download") {
          // Chrome has not produced a terminal observation yet. Keep a durable
          // recovery wake armed in case its onChanged event is lost while the
          // MV3 worker is suspended.
          recoveryComplete = false;
        }
      }
    }
    await refreshCaptureRunStatus(run.runId);
  }

  if (offscreen.known) {
    for (const attempt of offscreen.attempts) {
      if (knownNonterminalAttempts.has(captureProgressKey(attempt.jobId, attempt.attemptId))) {
        continue;
      }
      for (const prefix of ["hls-download", "dash-download", "webm-transcode"] as const) {
        await chrome.runtime.sendMessage({
          type: `${prefix}-cancel`,
          jobId: attempt.jobId,
          attemptId: attempt.attemptId,
        }).catch(() => undefined);
      }
    }
  }

  try {
    const owners = await readCaptureRuleOwners();
    for (const jobKey of Object.keys(owners)) {
      if (!rulesStillNeeded.has(jobKey)) await removeCaptureHeaderReplayRule(jobKey);
    }
  } catch {
    // Retained owner records make cleanup retryable on the next wake.
    recoveryComplete = false;
  }
  const authorizationClean = await reconcileCaptureAuthorizationArtifacts({ now, offscreen });
  return recoveryComplete && authorizationClean;
}

async function recoverQuickCaptureStartIntents(): Promise<void> {
  const listed = await listQuickCaptureStartIntents();
  if (!listed.ok) return;
  for (const intent of listed.intents) {
    if (
      intent.status === "committed" &&
      intent.reconciliationDisposition === "accepted"
    ) {
      // A worker can stop after the Quick journal records accepted ownership
      // but before PersistentCommandGate writes its settled response. Repair
      // that narrow window without recreating already-pruned settled commands.
      const commandRecord = await downloadCommandStore.read(intent.commandId).catch(
        () => undefined,
      );
      if (commandRecord?.state !== "pending") continue;
    }
    // Re-enter through the original command gate. Reconciling only the Quick
    // intent can prove the run/job was accepted while leaving the matching
    // download-command tombstone pending forever. The gate settles both views
    // of the same customer intent after exact ownership is established, and
    // keeps both unresolved when reconciliation is still ambiguous.
    await downloadCommandGate.run(
      intent.commandId,
      () => reconcileQuickCaptureStartIntent(intent),
    ).catch(() => undefined);
  }
}

const captureQueueDrainScheduler = createTrailingTaskScheduler(drainCaptureQueueOnce);

function scheduleCaptureQueueDrain(): Promise<void> {
  return captureQueueDrainScheduler.request();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (
    alarm.name !== CAPTURE_LEASE_EXPIRY_ALARM_NAME &&
    alarm.name !== CAPTURE_CLEANUP_RETRY_ALARM_NAME
  ) return;
  if (alarm.name === CAPTURE_CLEANUP_RETRY_ALARM_NAME) {
    captureCleanupRetryAttempt = 0;
  }
  void scheduleCaptureQueueDrain().catch(() => {
    updateCaptureCleanupRetry(true);
  });
});

// Reconcile every externally owned side effect before claiming more work when
// the MV3 service worker wakes.
const bootCaptureRecovery = recoverQuickCaptureStartIntents()
  .then(() => withKeyLock(CAPTURE_DRAFT_ACCEPTANCE_LOCK_KEY, recoverCaptureJobs))
  .then(() => undefined);
captureRecoveryBarrier = bootCaptureRecovery;
void bootCaptureRecovery.finally(() => {
  if (captureRecoveryBarrier === bootCaptureRecovery) captureRecoveryBarrier = undefined;
  void scheduleCaptureQueueDrain();
}).catch(() => undefined);

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
  const plannedFilename = inferFilename(video, {
    forcedExtension: ".mp4",
    template: settings.filenameTemplate,
    variantLabel: req.variantLabel,
  });

  await setHlsJob({
    commandId: req.commandId,
    jobId,
    videoId: video.id,
    tabId: req.tabId,
    url: video.url,
    kind: "hls",
    startedAt: Date.now(),
    status: "running",
    progress: { done: 0, total: 0, bytes: 0 },
    variantLabel: req.variantLabel,
    plannedFilename,
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
  const { filenameTemplate } = await getSettings();
  const plannedFilename = inferFilename(video, {
    forcedExtension: ".mp4",
    template: filenameTemplate,
  });

  await setWebmTranscodeJob({
    commandId: req.commandId,
    jobId,
    videoId: video.id,
    tabId: req.tabId,
    url: video.url,
    kind: "direct",
    startedAt: Date.now(),
    status: "running",
    progress: { ratio: 0, message: "Starting WebM to MP4 transcode" },
    plannedFilename,
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

  let deliveryClaimed = false;
  await updateHlsJob(msg.jobId, (current) => {
    if (current.status !== "running") return false;
    current.status = "delivery_pending";
    deliveryClaimed = true;
  });
  if (!deliveryClaimed) {
    const current = (await getHlsJobs())[msg.jobId];
    if (!current || current.status === "error" || current.status === "cancelled") {
      void chrome.runtime.sendMessage({ type: "hls-download-revoke", jobId: msg.jobId }).catch(() => {});
    }
    return;
  }

  const legacyVideo = job.plannedFilename ? undefined : await findVideo(job.tabId, job.videoId);
  if (!job.plannedFilename && !legacyVideo) {
    let quotaReservationToRelease: string | undefined;
    await updateHlsJob(msg.jobId, (j) => {
      if (j.status !== "delivery_pending") return false;
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

  let acceptedDownloadId: number | undefined;
  try {
    const filename = job.plannedFilename
      ? replacePlannedExtension(job.plannedFilename, msg.containerExt)
      : inferFilename(legacyVideo as DetectedVideo, {
          forcedExtension: msg.containerExt,
          template: (await getSettings()).filenameTemplate,
          variantLabel: job.variantLabel,
        });
    const downloadId = await chrome.downloads.download({
      url: msg.blobUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    acceptedDownloadId = downloadId;
    let saveAccepted = false;
    await updateHlsJob(msg.jobId, (j) => {
      // The job could have been cancelled during the save-initiation window.
      if (j.status !== "delivery_pending") return false;
      j.downloadId = downloadId;
      j.containerExt = msg.containerExt;
      j.status = "saving";
      saveAccepted = true;
    });
    if (!saveAccepted) {
      await chrome.downloads.cancel(downloadId).catch(() => undefined);
      await removeHeaderReplayRule(`hls:${msg.jobId}`);
      void chrome.runtime.sendMessage({ type: "hls-download-revoke", jobId: msg.jobId }).catch(() => {});
      return;
    }
    await reconcileStreamSave(downloadId);
  } catch (err) {
    if (acceptedDownloadId !== undefined) {
      await chrome.downloads.cancel(acceptedDownloadId).catch(() => undefined);
    }
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

  let deliveryClaimed = false;
  await updateWebmTranscodeJob(msg.jobId, (current) => {
    if (current.status !== "running") return false;
    current.status = "delivery_pending";
    deliveryClaimed = true;
  });
  if (!deliveryClaimed) {
    const current = (await getWebmTranscodeJobs())[msg.jobId];
    if (!current || current.status === "error" || current.status === "cancelled") {
      void chrome.runtime.sendMessage({ type: "webm-transcode-revoke", jobId: msg.jobId }).catch(() => {});
    }
    return;
  }

  const legacyVideo = job.plannedFilename ? undefined : await findVideo(job.tabId, job.videoId);
  if (!job.plannedFilename && !legacyVideo) {
    let quotaReservationToRelease: string | undefined;
    await updateWebmTranscodeJob(msg.jobId, (j) => {
      if (j.status !== "delivery_pending") return false;
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

  let acceptedDownloadId: number | undefined;
  try {
    const downloadId = await chrome.downloads.download({
      url: msg.blobUrl,
      filename: job.plannedFilename ?? inferFilename(legacyVideo as DetectedVideo, {
        forcedExtension: ".mp4",
        template: (await getSettings()).filenameTemplate,
      }),
      conflictAction: "uniquify",
      saveAs: false,
    });
    acceptedDownloadId = downloadId;
    let saveAccepted = false;
    await updateWebmTranscodeJob(msg.jobId, (j) => {
      if (j.status !== "delivery_pending") return false;
      j.downloadId = downloadId;
      j.status = "saving";
      saveAccepted = true;
    });
    if (!saveAccepted) {
      await chrome.downloads.cancel(downloadId).catch(() => undefined);
      await removeHeaderReplayRule(`webm:${msg.jobId}`);
      void chrome.runtime.sendMessage({ type: "webm-transcode-revoke", jobId: msg.jobId }).catch(() => {});
      return;
    }
    await reconcileStreamSave(downloadId);
  } catch (err) {
    if (acceptedDownloadId !== undefined) {
      await chrome.downloads.cancel(acceptedDownloadId).catch(() => undefined);
    }
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

type CaptureOffscreenProgressMessage = {
  type:
    | "hls-download-progress"
    | "dash-download-progress"
    | "webm-transcode-progress";
  jobId: string;
  attemptId: string;
  done?: number;
  total?: number;
  bytes?: number;
  ratio?: number;
};

type CaptureOffscreenBlobMessage = {
  type:
    | "hls-download-blob-ready"
    | "dash-download-blob-ready"
    | "webm-transcode-blob-ready";
  jobId: string;
  attemptId: string;
  blobUrl: string;
  sizeBytes: number;
  containerExt?: ".mp4" | ".ts";
};

type CaptureOffscreenErrorMessage = {
  type:
    | "hls-download-error"
    | "dash-download-error"
    | "webm-transcode-error";
  jobId: string;
  attemptId: string;
  code: string;
  userMessage: string;
};

function isTrustedOffscreenSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.tab === undefined && sender.url === chrome.runtime.getURL("offscreen.html");
}

const CAPTURE_ATTEMPT_ID_PATTERN = /^[a-z0-9._:-]{1,256}$/i;

function captureAttemptIdentityIsValid(value: unknown): value is {
  jobId: string;
  attemptId: string;
} {
  if (!value || typeof value !== "object") return false;
  const record = value as { jobId?: unknown; attemptId?: unknown };
  return (
    typeof record.jobId === "string" &&
    CAPTURE_ATTEMPT_ID_PATTERN.test(record.jobId) &&
    typeof record.attemptId === "string" &&
    CAPTURE_ATTEMPT_ID_PATTERN.test(record.attemptId)
  );
}

function isBoundedCaptureNumber(
  value: unknown,
  options: { integer?: boolean; ratio?: boolean } = {},
): value is number | undefined {
  if (value === undefined) return true;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  if (options.integer && !Number.isSafeInteger(value)) return false;
  return !options.ratio || value <= 1;
}

function parseCaptureOffscreenEvent(
  value: unknown,
): CaptureOffscreenProgressMessage | CaptureOffscreenBlobMessage | CaptureOffscreenErrorMessage | undefined {
  try {
    if (!captureAttemptIdentityIsValid(value)) return undefined;
    const record = value as Record<string, unknown> & { jobId: string; attemptId: string };
    const type = record.type;
    if (
      type === "hls-download-progress" ||
      type === "dash-download-progress" ||
      type === "webm-transcode-progress"
    ) {
      if (
        !isBoundedCaptureNumber(record.done, { integer: true }) ||
        !isBoundedCaptureNumber(record.total, { integer: true }) ||
        !isBoundedCaptureNumber(record.bytes, { integer: true }) ||
        !isBoundedCaptureNumber(record.ratio, { ratio: true }) ||
        (typeof record.done === "number" &&
          typeof record.total === "number" &&
          record.done > record.total)
      ) {
        return undefined;
      }
      return {
        type,
        jobId: record.jobId,
        attemptId: record.attemptId,
        ...(record.done === undefined ? {} : { done: record.done as number }),
        ...(record.total === undefined ? {} : { total: record.total as number }),
        ...(record.bytes === undefined ? {} : { bytes: record.bytes as number }),
        ...(record.ratio === undefined ? {} : { ratio: record.ratio as number }),
      };
    }
    if (
      type === "hls-download-blob-ready" ||
      type === "dash-download-blob-ready" ||
      type === "webm-transcode-blob-ready"
    ) {
      if (
        typeof record.blobUrl !== "string" ||
        record.blobUrl.length > 2_048 ||
        !record.blobUrl.startsWith(`blob:${chrome.runtime.getURL("")}`) ||
        !isBoundedCaptureNumber(record.sizeBytes, { integer: true }) ||
        record.sizeBytes === undefined ||
        (record.containerExt !== undefined &&
          record.containerExt !== ".mp4" &&
          record.containerExt !== ".ts")
      ) {
        return undefined;
      }
      return {
        type,
        jobId: record.jobId,
        attemptId: record.attemptId,
        blobUrl: record.blobUrl,
        sizeBytes: record.sizeBytes,
        ...(record.containerExt === undefined
          ? {}
          : { containerExt: record.containerExt as ".mp4" | ".ts" }),
      };
    }
    if (
      type === "hls-download-error" ||
      type === "dash-download-error" ||
      type === "webm-transcode-error"
    ) {
      if (
        typeof record.code !== "string" ||
        record.code.trim().length === 0 ||
        record.code.length > 80 ||
        typeof record.userMessage !== "string" ||
        record.userMessage.trim().length === 0 ||
        record.userMessage.length > 500
      ) {
        return undefined;
      }
      return {
        type,
        jobId: record.jobId,
        attemptId: record.attemptId,
        code: record.code,
        userMessage: record.userMessage,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function offscreenPrefixForEventType(
  type: CaptureOffscreenBlobMessage["type"] | CaptureOffscreenErrorMessage["type"],
): "hls-download" | "dash-download" | "webm-transcode" {
  if (type.startsWith("hls-")) return "hls-download";
  if (type.startsWith("dash-")) return "dash-download";
  return "webm-transcode";
}

async function cleanupCaptureIdentity(
  type: CaptureOffscreenBlobMessage["type"] | CaptureOffscreenErrorMessage["type"],
  jobId: string,
  attemptId: string,
): Promise<boolean> {
  const jobKey = captureRuleKey({ jobId, attemptId });
  const dnr = await listCaptureDnrOwners();
  if (!dnr.ok) return false;
  const leasedOwner = dnr.owners.find((owner) => owner.jobKey === jobKey);
  const ruleRemoved = leasedOwner
    ? await removeCaptureLeasedHeaderRule(jobKey, leasedOwner.leaseId)
    : await removeCaptureHeaderReplayRule(jobKey);
  if (!ruleRemoved) return false;
  const now = Date.now();
  const leases = await listCaptureHeaderLeases(now);
  if (!leases.ok) return false;
  const lease = leases.leases.find((candidate) =>
    candidate.acceptedAttemptOwner?.jobId === jobId &&
    candidate.acceptedAttemptOwner.attemptId === attemptId &&
    (leasedOwner === undefined || candidate.leaseId === leasedOwner.leaseId));
  if (lease?.acceptedAttemptOwner) {
    const retired = await retireClaimedCaptureHeaderLease({
      leaseId: lease.leaseId,
      runId: lease.acceptedAttemptOwner.runId,
      jobId,
      attemptId,
      now,
    });
    if (!retired.ok) return false;
  }
  const revoked = await revokeCaptureOffscreenIdentity(
    offscreenPrefixForEventType(type),
    jobId,
    attemptId,
  );
  if (revoked) await sweepExpiredCaptureHeaderLeases(now);
  return revoked;
}

async function handleCaptureOffscreenProgress(
  message: CaptureOffscreenProgressMessage,
  webm: boolean,
): Promise<void> {
  const progress = webm
    ? { phase: "fetching" as const, ratio: message.ratio }
    : {
        phase: "fetching" as const,
        completed: message.done,
        total: message.total,
        bytes: message.bytes,
      };
  await applyStoredCaptureJobEvent({
    jobId: message.jobId,
    attemptId: message.attemptId,
    event: { type: "progress", progress },
  });
}

type PendingCaptureProgress = {
  message?: CaptureOffscreenProgressMessage;
  webm: boolean;
  timer?: number;
  flushing?: Promise<void>;
};

const pendingCaptureProgress = new Map<string, PendingCaptureProgress>();
const CAPTURE_PROGRESS_FLUSH_MS = 100;

function captureProgressKey(jobId: string, attemptId: string): string {
  return `${jobId}\u0000${attemptId}`;
}

async function flushCaptureProgress(jobId: string, attemptId: string): Promise<void> {
  const key = captureProgressKey(jobId, attemptId);
  const pending = pendingCaptureProgress.get(key);
  if (!pending) return;
  if (pending.timer !== undefined) {
    clearTimeout(pending.timer);
    delete pending.timer;
  }
  if (!pending.flushing) {
    pending.flushing = (async () => {
      while (pending.message) {
        const message = pending.message;
        const webm = pending.webm;
        delete pending.message;
        await handleCaptureOffscreenProgress(message, webm);
      }
    })().finally(() => {
      pendingCaptureProgress.delete(key);
    });
  }
  await pending.flushing;
}

function queueCaptureProgress(message: CaptureOffscreenProgressMessage, webm: boolean): void {
  const key = captureProgressKey(message.jobId, message.attemptId);
  const current = pendingCaptureProgress.get(key) ?? { webm };
  current.message = message;
  current.webm = webm;
  if (current.timer === undefined && !current.flushing) {
    current.timer = setTimeout(() => {
      void flushCaptureProgress(message.jobId, message.attemptId);
    }, CAPTURE_PROGRESS_FLUSH_MS);
  }
  pendingCaptureProgress.set(key, current);
}

async function captureJobForAttempt(
  jobId: string,
  attemptId: string,
): Promise<CaptureJobV1 | undefined> {
  const read = await getCaptureJob(jobId);
  return read.ok && read.job?.attemptId === attemptId ? read.job : undefined;
}

async function handleCaptureOffscreenBlob(
  message: CaptureOffscreenBlobMessage,
): Promise<boolean> {
  await flushCaptureProgress(message.jobId, message.attemptId);
  let job = await captureJobForAttempt(message.jobId, message.attemptId);
  if (!job) {
    const cleaned = await cleanupCaptureIdentity(message.type, message.jobId, message.attemptId);
    if (cleaned) void scheduleCaptureQueueDrain();
    return cleaned;
  }
  if (job.state === "saving") return true;
  if (job.state === "delivery_pending") {
    // A previous service-worker lifetime durably claimed delivery but may
    // also have crossed Chrome's external download boundary. Retrying the
    // Blob save could create a duplicate file, so preserve an explicit
    // ambiguity instead and clean every sensitive/Blob resource.
    const unknown = await applyStoredCaptureJobEvent({
      jobId: job.jobId,
      attemptId: job.attemptId,
      event: {
        type: "save-state-unknown",
        code: "SAVE_STATE_UNKNOWN",
        customerMessage: "Chrome may have accepted this file before ClipHutch restarted. Check Downloads before retrying.",
      },
    });
    if (!unknown.ok) return false;
    await settleCaptureTerminalQuota(unknown.job);
    const cleaned = await cleanupCaptureAttempt(unknown.job);
    await refreshCaptureRunStatus(unknown.job.runId);
    void scheduleCaptureQueueDrain();
    return cleaned;
  }
  if (CAPTURE_TERMINAL_JOB_STATES.has(job.state)) {
    const cleaned = await cleanupCaptureAttempt(job);
    await refreshCaptureRunStatus(job.runId);
    void scheduleCaptureQueueDrain();
    return cleaned;
  }
  if (job.state === "cancelling") {
    const cancelled = await applyStoredCaptureJobEvent({
      jobId: job.jobId,
      attemptId: job.attemptId,
      event: { type: "cancelled" },
    });
    if (!cancelled.ok) return false;
    await settleCaptureTerminalQuota(cancelled.job);
    const cleaned = await cleanupCaptureAttempt(cancelled.job);
    await refreshCaptureRunStatus(cancelled.job.runId);
    void scheduleCaptureQueueDrain();
    return cleaned;
  }

  if (job.state === "running") {
    const processing = await applyStoredCaptureJobEvent({
      jobId: job.jobId,
      attemptId: job.attemptId,
      event: { type: "processing" },
    });
    if (!processing.ok) return false;
    job = processing.job;
  }
  if (job.state !== "processing" && job.state !== "starting") {
    return cleanupCaptureAttempt(job);
  }

  const delivery = await applyStoredCaptureJobEvent({
    jobId: job.jobId,
    attemptId: job.attemptId,
    event: { type: "delivery-ready" },
  });
  if (!delivery.ok) {
    return false;
  }
  job = delivery.job;
  // Fetch/mux has finished. Blob delivery no longer needs replayable request
  // headers, so remove the exact rule and accepted lease owner before the
  // browser-native save begins. A cleanup failure must not leave credentials
  // active while reporting a successful save.
  if (!await releaseCaptureAttemptAuthorization(job)) {
    return failCaptureJob(
      job,
      "HEADER_CLEANUP_FAILED",
      "ClipHutch finished processing this item but could not safely clear its temporary source authorization. Retry after reopening the source page.",
      true,
    );
  }

  const outputExtension = message.type === "webm-transcode-blob-ready"
    ? ".mp4"
    : message.containerExt;
  const plannedPath = outputExtension
    ? replacePlannedExtension(job.snapshot.plannedRelativePath, outputExtension)
    : job.snapshot.plannedRelativePath;
  let downloadId: number | undefined;
  try {
    downloadId = await chrome.downloads.download({
      url: message.blobUrl,
      filename: plannedPath,
      conflictAction: "uniquify",
      saveAs: false,
    });
    const saving = await applyStoredCaptureJobEvent({
      jobId: job.jobId,
      attemptId: job.attemptId,
      event: { type: "saving", downloadId },
    });
    if (!saving.ok) {
      await chrome.downloads.cancel(downloadId).catch(() => undefined);
      const unknown = await applyStoredCaptureJobEvent({
        jobId: job.jobId,
        attemptId: job.attemptId,
        event: {
          type: "save-state-unknown",
          code: "SAVE_STATE_UNKNOWN",
          customerMessage: "Chrome accepted a save, but ClipHutch could not confirm its state.",
        },
      });
      if (!unknown.ok) return false;
      await settleCaptureTerminalQuota(unknown.job);
      const cleaned = await cleanupCaptureAttempt(unknown.job);
      await refreshCaptureRunStatus(unknown.job.runId);
      void scheduleCaptureQueueDrain();
      return cleaned;
    }
    const [item] = await chrome.downloads.search({ id: downloadId }).catch(
      () => [] as chrome.downloads.DownloadItem[],
    );
    if (item?.state === "complete" || item?.state === "interrupted") {
      await applyCaptureDownloadTerminal(downloadId, item.state);
    }
    return true;
  } catch {
    if (downloadId !== undefined) await chrome.downloads.cancel(downloadId).catch(() => undefined);
    return failCaptureJob(
      job,
      "SAVE_FAILED",
      "Chrome could not save the locally processed file.",
      true,
    );
  }
}

async function handleCaptureOffscreenError(
  message: CaptureOffscreenErrorMessage,
): Promise<boolean> {
  await flushCaptureProgress(message.jobId, message.attemptId);
  let job = await captureJobForAttempt(message.jobId, message.attemptId);
  if (!job) {
    const cleaned = await cleanupCaptureIdentity(message.type, message.jobId, message.attemptId);
    if (cleaned) void scheduleCaptureQueueDrain();
    return cleaned;
  }
  if (CAPTURE_TERMINAL_JOB_STATES.has(job.state)) {
    const cleaned = await cleanupCaptureAttempt(job);
    if (cleaned) {
      await refreshCaptureRunStatus(job.runId);
      void scheduleCaptureQueueDrain();
    }
    return cleaned;
  }
  if (message.code === "CANCELLED") {
    if (job.state !== "cancelling") {
      const requested = await applyStoredCaptureJobEvent({
        jobId: job.jobId,
        attemptId: job.attemptId,
        event: { type: "request-cancel" },
      });
      if (!requested.ok) return false;
      job = requested.job;
    }
    const cancelled = await applyStoredCaptureJobEvent({
      jobId: job.jobId,
      attemptId: job.attemptId,
      event: { type: "cancelled" },
    });
    if (!cancelled.ok) return false;
    await settleCaptureTerminalQuota(cancelled.job);
    const cleaned = await cleanupCaptureAttempt(cancelled.job);
    await refreshCaptureRunStatus(job.runId);
    void scheduleCaptureQueueDrain();
    return cleaned;
  }
  return failCaptureJob(
    job,
    String(message.code || "UNKNOWN").slice(0, 80),
    String(message.userMessage || "The media item could not be processed.").slice(0, 500),
    isCaptureExecutorErrorRetryable(message.code),
  );
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const parsedCaptureEvent = parseCaptureOffscreenEvent(message);
  if (parsedCaptureEvent) {
    if (!isTrustedOffscreenSender(sender)) return false;
    if (
      parsedCaptureEvent.type === "hls-download-progress" ||
      parsedCaptureEvent.type === "dash-download-progress"
    ) {
      queueCaptureProgress(parsedCaptureEvent, false);
    } else if (parsedCaptureEvent.type === "webm-transcode-progress") {
      queueCaptureProgress(parsedCaptureEvent, true);
    } else if (
      parsedCaptureEvent.type === "hls-download-blob-ready" ||
      parsedCaptureEvent.type === "dash-download-blob-ready" ||
      parsedCaptureEvent.type === "webm-transcode-blob-ready"
    ) {
      void withKeyLock(
        CAPTURE_ATTEMPT_SIDE_EFFECTS_LOCK_KEY,
        () => withKeyLock(
          `capture-blob-handler:${parsedCaptureEvent.jobId}:${parsedCaptureEvent.attemptId}`,
          () => handleCaptureOffscreenBlob(parsedCaptureEvent),
        ),
      ).then(
        (durablyHandled) => sendResponse({
          ok: durablyHandled,
          jobId: parsedCaptureEvent.jobId,
          attemptId: parsedCaptureEvent.attemptId,
        }),
        () => sendResponse({
          ok: false,
          jobId: parsedCaptureEvent.jobId,
          attemptId: parsedCaptureEvent.attemptId,
        }),
      );
      return true;
    } else if (
      parsedCaptureEvent.type === "hls-download-error" ||
      parsedCaptureEvent.type === "dash-download-error" ||
      parsedCaptureEvent.type === "webm-transcode-error"
    ) {
      void withKeyLock(
        CAPTURE_ATTEMPT_SIDE_EFFECTS_LOCK_KEY,
        () => withKeyLock(
          `capture-error-handler:${parsedCaptureEvent.jobId}:${parsedCaptureEvent.attemptId}`,
          () => handleCaptureOffscreenError(parsedCaptureEvent),
        ),
      ).then(
        (durablyHandled) => sendResponse({
          ok: durablyHandled,
          jobId: parsedCaptureEvent.jobId,
          attemptId: parsedCaptureEvent.attemptId,
        }),
        () => sendResponse({
          ok: false,
          jobId: parsedCaptureEvent.jobId,
          attemptId: parsedCaptureEvent.attemptId,
        }),
      );
      return true;
    }
    return false;
  }
  const m = message as { type?: string; attemptId?: unknown };
  // Attempt-scoped messages that fail the strict parser are never allowed to
  // fall through into the legacy handlers.
  if (m.attemptId !== undefined) return false;
  if (!isTrustedOffscreenSender(sender)) return false;
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
  const plannedFilename = inferFilename(video, {
    forcedExtension: ".mp4",
    template: settings.filenameTemplate,
    variantLabel: req.variantLabel,
  });

  await setDashJob({
    commandId: req.commandId,
    jobId,
    videoId: video.id,
    tabId: req.tabId,
    url: video.url,
    kind: "dash",
    startedAt: Date.now(),
    status: "running",
    progress: { done: 0, total: 0, bytes: 0 },
    variantLabel: req.variantLabel,
    plannedFilename,
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

  let deliveryClaimed = false;
  await updateDashJob(msg.jobId, (current) => {
    if (current.status !== "running") return false;
    current.status = "delivery_pending";
    deliveryClaimed = true;
  });
  if (!deliveryClaimed) {
    const current = (await getDashJobs())[msg.jobId];
    if (!current || current.status === "error" || current.status === "cancelled") {
      void chrome.runtime.sendMessage({ type: "dash-download-revoke", jobId: msg.jobId }).catch(() => {});
    }
    return;
  }

  const legacyVideo = job.plannedFilename ? undefined : await findVideo(job.tabId, job.videoId);
  if (!job.plannedFilename && !legacyVideo) {
    let quotaReservationToRelease: string | undefined;
    await updateDashJob(msg.jobId, (j) => {
      if (j.status !== "delivery_pending") return false;
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

  let acceptedDownloadId: number | undefined;
  try {
    const downloadId = await chrome.downloads.download({
      url: msg.blobUrl,
      filename: job.plannedFilename ?? inferFilename(legacyVideo as DetectedVideo, {
        forcedExtension: ".mp4",
        template: (await getSettings()).filenameTemplate,
        variantLabel: job.variantLabel,
      }),
      conflictAction: "uniquify",
      saveAs: false,
    });
    acceptedDownloadId = downloadId;
    let saveAccepted = false;
    await updateDashJob(msg.jobId, (j) => {
      if (j.status !== "delivery_pending") return false;
      j.downloadId = downloadId;
      j.status = "saving";
      saveAccepted = true;
    });
    if (!saveAccepted) {
      await chrome.downloads.cancel(downloadId).catch(() => undefined);
      await removeHeaderReplayRule(`dash:${msg.jobId}`);
      void chrome.runtime.sendMessage({ type: "dash-download-revoke", jobId: msg.jobId }).catch(() => {});
      return;
    }
    await reconcileStreamSave(downloadId);
  } catch (err) {
    if (acceptedDownloadId !== undefined) {
      await chrome.downloads.cancel(acceptedDownloadId).catch(() => undefined);
    }
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
