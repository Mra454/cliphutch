import { StrictMode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DashJob, DetectedVideo, DirectJob, HlsJob, WebmTranscodeJob } from "../types";
import { partitionCoveredByManifests } from "../lib/manifest-coverage";
import { inferFilename } from "../lib/filename";
import {
  claimPendingIntent,
  clearPendingIntent,
  createDownloadCommandId,
} from "../lib/download-intent";
import { groupMedia, type MediaGroup } from "../lib/media-identity";
import type { BestCopyRecommendationV1 } from "../lib/best-copy";
import {
  bestCopySelectionChangeCanResetQuickState,
  bestCopyShelfSelectionIsUnavailable,
  captureSnapshotBelongsToMediaGroup,
  createCaptureCopyChoiceReviewPresentation,
  createBestCopyRecommendationPresentation,
  createBestCopyShelfModel,
  resolveBestCopyQuickInteractionSelection,
  type BestCopyShelfSelectionSource,
} from "../lib/best-copy-ui";
import {
  addDetectedMediaToCaptureDraft,
  clearCaptureDraft,
  getCaptureDraft,
  labelCaptureDraftPage,
  removeCaptureDraftItem,
  removeCaptureDraftPage,
  renameCaptureDraft,
  replaceCaptureDraftMedia,
  setCaptureDraftManifestCsv,
} from "../lib/capture-pack-client";
import { CAPTURE_DRAFT_STORAGE_KEY } from "../lib/capture-pack-storage";
import type {
  CaptureDraftV1,
  CaptureJobV1,
  CaptureReviewPlanV1,
  CaptureRunV1,
} from "../lib/capture-pack-types";
import {
  MAX_CAPTURE_PAGE_FOLDER_LABEL_LENGTH,
  normalizeCapturePageFolderLabel,
} from "../lib/capture-pack-types";
import {
  cancelCaptureJob,
  createCaptureReviewPlan,
  enqueueCaptureReviewPlan,
  getCaptureWorkspace,
  reconcileQuickCaptureStart,
  retryCaptureManifest,
  type CaptureVariantOptionV1,
  type CaptureWorkspaceManifestV1,
  type CaptureWorkspaceQuickCaptureContextV1,
  type CaptureWorkspaceClientResult,
  type CaptureWorkspaceQuotaV1,
} from "../lib/capture-review-client";
import {
  capturePackActivityStatus,
  captureManifestRetryFailureMessage,
  createCaptureManifestOutputUiModel,
} from "../lib/capture-manifest-ui";
import { captureStreamSizeCopy } from "../lib/capture-quality-ui";
import { CAPTURE_MANIFEST_RECORD_STORAGE_PREFIX } from "../lib/capture-manifest-storage";
import type { CapturePlanChoiceSelectorV1 } from "../lib/capture-review-messages";
import {
  createCapturePackBuyingGateModel,
  type CapturePackBuyingGateBlockingReason,
} from "../lib/capture-buying-gate";
import {
  CAPTURE_JOB_ID_PREFIX,
  captureReviewHasExpiringSourceAccess,
  createQuickCaptureCardModel,
  resolveQuickCaptureJobBinding,
} from "../lib/quick-capture-card";
import {
  WORKSPACE_ROUTES,
  WORKSPACE_ROUTE_LABELS,
  WORKSPACE_TAB_GAP_PX,
  WORKSPACE_TAB_MIN_TRACK_PX,
  activeTabLoadIsCurrent,
  binaryTabForKey,
  customerVisibleUrlTitle,
  groupCaptureDraftBySourcePage,
  hutchFocusItemAfterRemoval,
  sourcePageDisplayUrl,
  workspaceRouteForKey,
  type WorkspaceRoute,
  type WorkspaceSurface,
} from "../lib/workspace-ui";

type VariantOption = {
  id: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  audioRenditionUrl?: string;
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

type MediaFilter = "videos" | "stills";

type CaptureView = WorkspaceRoute;

type CaptureRunReconcileIntent = {
  planId: string;
  draftId: string;
  draftRevision: number;
  licensed: boolean;
  freeVideoItemIds: string[];
  selectionMustMatch: boolean;
};

function captureManifestRetryKey(runId: string, format: "json" | "csv"): string {
  return `${runId}\u0000${format}`;
}

type CaptureWorkspaceSuccess = Extract<CaptureWorkspaceClientResult, { ok: true }>;

type CapturePageFolderGroup = {
  pageUrl: string;
  pageTitle?: string;
  pageHost: string;
  itemCount: number;
  label: string | null;
};

type DownloadResponse =
  | { ok: true; downloadId?: number; jobId?: string }
  | { ok: false; error: string; code?: string };

type FrozenQuickDownloadRequest = {
  type: "download";
  commandId: string;
  tabId: number;
  videoId: string;
  variantId?: string;
  audioRenditionUrl?: string;
  variantLabel?: string;
  bypassSizeCap?: boolean;
};

type QuickStartOutcomeUnknownIntent = {
  /** The background journal owns the frozen media/variant selection. */
  commandId: string;
  errorCode: "START_STATE_UNKNOWN" | "COMMAND_STATE_UNAVAILABLE";
  errorMessage: string;
};

import {
  getDetectedVideos,
  getDetectionRetentionStats,
  type DetectionRetentionStats,
} from "../lib/storage-session";
import { DEFAULT_SETTINGS, getSettings, setSettings, type UserSettings, type FilenameTemplate } from "../lib/storage-local";
import {
  dismissLicenseNotice,
  getLicenseNotice,
  isLicensed,
} from "../lib/license";
import { revalidateIfStale } from "../lib/license-client";
import { FREE_DOWNLOAD_LIMIT, VIDEO_DOWNLOAD_HISTORY_KEY, getDownloadCount } from "../lib/rate-limit";
import { CHECKOUT_URL, MIN_STILL_IMAGE_SIZE_BYTES, PRICE_USD } from "../lib/constants";
import { isStillImage, isWebmDirectVideo } from "../lib/media-format";

const DIRECT_JOBS_KEY = "download-jobs";
const HLS_JOBS_KEY = "hls-download-jobs";
const DASH_JOBS_KEY = "dash-download-jobs";
const WEBM_TRANSCODE_JOBS_KEY = "webm-transcode-jobs";
const QUICK_CAPTURE_START_INTENTS_STORAGE_KEY = "quick-capture-start-intents-v1";

type AnyJob =
  | ({ source: "direct" } & DirectJob)
  | ({ source: "hls" } & HlsJob)
  | ({ source: "dash" } & DashJob)
  | ({ source: "webm" } & WebmTranscodeJob);

// The name shown in the popup is the exact name the file will save under, so
// the shelf and the download match. Extension is stripped for display.
function displayName(v: DetectedVideo, template?: FilenameTemplate): string {
  const name = inferFilename(v, { template });
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function hutchItemLabel(media: { url: string; kind: string; mediaId: string }): string {
  try {
    const basename = new URL(media.url).pathname.split("/").filter(Boolean).pop();
    if (basename) {
      try { return decodeURIComponent(basename); } catch { return basename; }
    }
  } catch {
    // The background snapshot guard already rejects invalid URLs; keep a
    // bounded fallback for forward compatibility.
  }
  return `${media.kind} item ${media.mediaId.slice(0, 12)}`;
}

function variantFilenameLabel(variant: VariantOption): string | undefined {
  if (variant.height && variant.height > 0) return `${variant.height}p`;
  if (variant.width && variant.width > 0) return `${variant.width}w`;
  return undefined;
}

const KIND_BADGE: Record<string, string> = {
  hls: "HLS",
  dash: "DASH",
  image: "STILL",
};

const PREVIEWABLE_DIRECT_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

function badgeText(v: DetectedVideo): string {
  if (v.kind !== "direct") {
    if (v.kind === "image") {
      try {
        const ext = new URL(v.url).pathname.split(".").pop()?.toUpperCase();
        return ext && ext.length <= 5 ? ext : "STILL";
      } catch {
        return "STILL";
      }
    }
    return KIND_BADGE[v.kind] ?? v.kind.toUpperCase();
  }
  try {
    const ext = new URL(v.url).pathname.split(".").pop()?.toUpperCase();
    return ext && ext.length <= 5 ? ext : "VIDEO";
  } catch {
    return "VIDEO";
  }
}

function hostname(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function normalizedHttpPageUrl(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
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

function sourceLabel(v: DetectedVideo): string {
  return hostname(v.url) ?? "unknown source";
}

function pageLabel(v: DetectedVideo): string | undefined {
  return hostname(v.pageUrl);
}

function isIgnoredBySettings(v: DetectedVideo, settings: UserSettings): boolean {
  const source = hostname(v.url);
  const page = hostname(v.pageUrl);
  return Boolean(
    (source && hostCoveredByFilters(source, settings.ignoredSourceHosts)) ||
      (page && hostCoveredByFilters(page, settings.ignoredPageHosts)),
  );
}

function canPreview(v: DetectedVideo): boolean {
  if (v.kind !== "direct") return false;
  const contentType = v.contentType?.split(";")[0].trim().toLowerCase();
  if (contentType?.startsWith("video/")) return true;
  try {
    const ext = new URL(v.url).pathname.split(".").pop()?.toLowerCase();
    return Boolean(ext && PREVIEWABLE_DIRECT_EXT.has(ext));
  } catch {
    return false;
  }
}

function fmtBytes(n?: number): string | undefined {
  if (n === undefined || !Number.isFinite(n) || n < 0) return undefined;
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (n >= GB) return (n / GB).toFixed(2) + " GB";
  if (n >= MB) return (n / MB).toFixed(1) + " MB";
  if (n >= KB) return (n / KB).toFixed(1) + " KB";
  return `${n} B`;
}

function fmtDuration(seconds?: number): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function captureVariantDisabledCopy(
  reason: CaptureVariantOptionV1["disabledReason"],
): string | undefined {
  switch (reason) {
    case "drm": return "DRM protected";
    case "live": return "live stream";
    case "unsupported_codec": return "unsupported codec";
    case "unsupported_container": return "unsupported container";
    case "unsupported_manifest_shape": return "unsupported stream layout";
    case "unsupported_audio": return "unsupported default audio";
    case "permanent_download_failure": return "not downloadable";
    case "invalid_media": return "invalid media";
    case "over_size_cap": return "over your hard size cap";
    default: return undefined;
  }
}

function captureVariantOptionCopy(option: CaptureVariantOptionV1): string {
  const details = [
    option.label,
    captureStreamSizeCopy(option.estimatedBytes, option.estimateConfidence),
    fmtDuration(option.durationSec),
    option.suggestedForConfirmation === true
      ? "suggested confirmation option; choose explicitly"
      : undefined,
    captureVariantDisabledCopy(option.disabledReason),
  ].filter((value): value is string => Boolean(value));
  return details.join(" · ");
}

function urlDisplay(rawUrl: string, showFull: boolean): string {
  if (showFull) return rawUrl;
  try {
    const u = new URL(rawUrl);
    return u.hostname + u.pathname;
  } catch {
    return rawUrl;
  }
}

function captureGateError(reason: CapturePackBuyingGateBlockingReason): string {
  switch (reason) {
    case "unready_item":
      return "Choose a quality or remove each blocked item before saving the pack.";
    case "invalid_allocation":
      return "The free-video selection no longer matches this review. Clear it and choose again.";
    case "duplicate_allocation":
      return "A video was selected more than once. Clear the selection and choose again.";
    case "non_video_allocation":
      return "Stills are included automatically and cannot use a free video slot.";
    case "over_allowance":
      return "The selected videos exceed the remaining free allowance. Deselect a video or unlock the complete pack.";
    case "no_items":
      return "Select at least one ready video, or include a still, before saving the pack.";
  }
}

function Empty() {
  return (
    <p style={{ margin: "10px 0", color: "#536156", fontSize: 10.5, lineHeight: 1.35 }}>
      Nothing on this shelf yet. Try reloading or interacting with the page.
    </p>
  );
}

const errorBoxStyle: React.CSSProperties = {
  background: "#fff1ed",
  color: "#7a1f1a",
  border: "1px solid #efb6aa",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 11,
  marginTop: 8,
};

const noteBoxStyle: React.CSSProperties = {
  background: "#f1f7f4",
  color: "#244f3a",
  border: "1px solid #bdd7c8",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 11,
  marginTop: 8,
};

const buttonStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "5px 10px",
  cursor: "pointer",
  border: "1px solid #b9c9bc",
  borderRadius: 6,
  background: "#ffffff",
  color: "#1f2a22",
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  border: "1px solid #2f5f3a",
  background: "#2f5f3a",
  color: "#fff",
  fontWeight: 650,
};

const disabledButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  cursor: "not-allowed",
  background: "#edf2ee",
  color: "#7a847d",
  border: "1px solid #cbd8cf",
};

const shelfLineStyle: React.CSSProperties = {
  height: 3,
  borderRadius: 999,
  background: "linear-gradient(90deg, #8a6a47, #b68a58 48%, #7b5a38)",
  opacity: 0.8,
};

const iconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid #c8d8cc",
  borderRadius: 6,
  background: "#ffffff",
  color: "#26352b",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
};

const visuallyHiddenStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

function VideoPreview({ v }: { v: DetectedVideo }) {
  const [failed, setFailed] = useState(false);
  if (!canPreview(v) || failed) return null;

  return (
    <div
      style={{
        width: "100%",
        height: 128,
        marginTop: 8,
        borderRadius: 6,
        background: "#161411",
        overflow: "hidden",
        border: "1px solid #26211c",
      }}
    >
      <video
        src={v.url}
        controls
        muted
        playsInline
        preload="metadata"
        onError={() => setFailed(true)}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          objectFit: "contain",
        }}
      />
    </div>
  );
}

function ImagePreview({ v }: { v: DetectedVideo }) {
  const [failed, setFailed] = useState(false);
  if (!isStillImage(v) || failed) return null;

  return (
    <div
      style={{
        width: "100%",
        height: 142,
        marginTop: 8,
        borderRadius: 6,
        background: "#eef5f1",
        overflow: "hidden",
        border: "1px solid #d7e4dc",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <img
        src={v.url}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          objectFit: "contain",
        }}
      />
    </div>
  );
}

function downloadFormat(v: DetectedVideo, job: AnyJob): string {
  if (job.source === "webm") return "MP4";
  if (job.source === "dash") return "MP4";
  if (job.source === "hls") return job.containerExt === ".ts" ? "TS" : "MP4";
  return badgeText(v);
}

function DownloadSuccessRow({ v, job }: { v: DetectedVideo; job: AnyJob }) {
  const [filename, setFilename] = useState<string | null>(null);
  const downloadId = job.downloadId;

  useEffect(() => {
    let cancelled = false;
    if (downloadId === undefined) {
      setFilename(null);
      return;
    }
    void chrome.downloads.search({ id: downloadId }).then((items) => {
      if (cancelled) return;
      const path = items[0]?.filename;
      setFilename(path ? path.split(/[\\/]/).pop() ?? path : null);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [downloadId]);

  return (
    <div
      style={{
        marginTop: 6,
        padding: "6px 8px",
        border: "1px solid #bdd7c8",
        borderRadius: 6,
        background: "#f1f7f4",
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 6,
        alignItems: "center",
      }}
    >
      <div role="status" aria-live="polite" style={{ minWidth: 0 }}>
        <div style={{ color: "#244f3a", fontSize: 11, fontWeight: 650 }}>
          Saved {downloadFormat(v, job)}
        </div>
        <div
          title={filename ?? displayName(v)}
          style={{
            color: "#536156",
            fontSize: 10,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {filename ?? displayName(v)}
        </div>
      </div>
      {downloadId !== undefined ? (
        <button
          onClick={() => chrome.downloads.show(downloadId)}
          aria-label={`Show ${filename ?? displayName(v)} in folder`}
          style={buttonStyle}
        >
          Show in folder
        </button>
      ) : null}
    </div>
  );
}

function Diagnostics({ v, job }: { v: DetectedVideo; job: AnyJob | null }) {
  const notes: string[] = [];
  if (isWebmDirectVideo(v)) {
    notes.push(job?.source === "webm" && job.status === "complete" ? "WebM converted locally to MP4." : "WebM will be converted locally to MP4.");
  }
  if (v.kind === "dash") {
    notes.push(job?.source === "dash" && job.status === "complete" ? "Separate audio/video merged into one MP4." : "DASH may use separate audio/video tracks.");
  }
  if (v.kind === "hls") {
    if (job?.source === "hls" && job.status === "complete" && job.containerExt === ".mp4") {
      notes.push("HLS segments merged into MP4.");
    } else if (job?.source === "hls" && job.status === "complete" && job.containerExt === ".ts") {
      notes.push("Saved as transport stream because this HLS layout cannot be remuxed to MP4.");
    } else {
      notes.push("HLS stream will be assembled locally.");
    }
  }
  if (job && "errorCode" in job && job.errorCode === "ENCRYPTED") {
    notes.push("This stream's encryption method is not supported.");
  }
  if (job && "errorCode" in job && job.errorCode === "DRM_PROTECTED") {
    notes.push("This stream is DRM-protected and cannot be downloaded.");
  }
  if (job && "errorCode" in job && job.errorCode === "MIXED_CONTAINER_AUDIO") {
    notes.push("This stream pairs fMP4 video with non-fMP4 audio.");
  }
  if (notes.length === 0) return null;
  return (
    <div style={{ ...noteBoxStyle, background: "#f7fbf8" }}>
      {notes.map((note) => (
        <div key={note}>{note}</div>
      ))}
    </div>
  );
}

function ShelfTab({
  active,
  buttonRef,
  count,
  controls,
  id,
  label,
  onClick,
  onKeyDown,
}: {
  active: boolean;
  buttonRef: (element: HTMLButtonElement | null) => void;
  count: number;
  controls: string;
  id: string;
  label: string;
  onClick: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      ref={buttonRef}
      id={id}
      role="tab"
      aria-controls={controls}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
      style={{
        flex: 1,
        border: active ? "1px solid #315f42" : "1px solid #cbd8cf",
        borderBottomColor: active ? "#315f42" : "#a8b8ae",
        background: active ? "#ffffff" : "#eef4ef",
        color: active ? "#1d261f" : "#59675c",
        borderRadius: 6,
        padding: "5px 8px",
        cursor: "pointer",
        fontSize: 10.5,
        fontWeight: active ? 700 : 600,
      }}
    >
      {label} <span style={{ color: active ? "#2f5f3a" : "#758277" }}>{count}</span>
    </button>
  );
}

function VideoCard({
  groupId,
  v,
  alternates,
  selectedId,
  selectionSource,
  recommendation,
  included,
  inclusionPending,
  alternatePendingId,
  alternateError,
  tabId,
  settings,
  videoLimitReached,
  captureJobs,
  captureWorkspaceError,
  captureCancelPendingId,
  acceptedCaptureJobId,
  unresolvedQuickStart,
  quickCaptureStartBlocked,
  quickCaptureReconcilePending,
  deferPreview,
  onSelect,
  onIncludedChange,
  onIgnoreSource,
  onIgnorePage,
  onCaptureAccepted,
  onClearCaptureBinding,
  onFreezeQuickSelection,
  onReleaseQuickSelection,
  onQuickStartOutcomeUnknown,
  onClearQuickStartOutcomeUnknown,
  onPreviousStartUnresolved,
  onReconcileQuickStart,
  onCancelCaptureJob,
  onViewHutch,
  onViewActivity,
}: {
  groupId: string;
  v: DetectedVideo;
  alternates: DetectedVideo[];
  selectedId: string;
  selectionSource: BestCopyShelfSelectionSource;
  recommendation: BestCopyRecommendationV1 | null;
  included: boolean;
  inclusionPending: boolean;
  alternatePendingId: string | null;
  alternateError?: string;
  tabId: number;
  settings: UserSettings;
  videoLimitReached: boolean;
  captureJobs: readonly CaptureJobV1[];
  captureWorkspaceError: string | null;
  captureCancelPendingId: string | null;
  acceptedCaptureJobId: string | null | undefined;
  unresolvedQuickStart: QuickStartOutcomeUnknownIntent | undefined;
  quickCaptureStartBlocked: boolean;
  quickCaptureReconcilePending: boolean;
  deferPreview: boolean;
  onSelect: (id: string) => Promise<boolean>;
  onIncludedChange: (included: boolean) => void;
  onIgnoreSource: (host: string) => void;
  onIgnorePage: (host: string) => void;
  onCaptureAccepted: (jobId: string) => void;
  onClearCaptureBinding: () => void;
  onFreezeQuickSelection: (mediaId: string) => void;
  onReleaseQuickSelection: () => void;
  onQuickStartOutcomeUnknown: (intent: QuickStartOutcomeUnknownIntent) => void;
  onClearQuickStartOutcomeUnknown: () => void;
  onPreviousStartUnresolved: () => void;
  onReconcileQuickStart: (commandId: string) => void;
  onCancelCaptureJob: (job: CaptureJobV1) => Promise<void>;
  onViewHutch: () => void;
  onViewActivity: () => void;
}) {
  const [showFull, setShowFull] = useState(settings.showFullUrlsByDefault);
  const [showAlternates, setShowAlternates] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [job, setJob] = useState<AnyJob | null>(null);
  const [directProgress, setDirectProgress] = useState<{ received: number; total?: number } | null>(null);
  const [immediateError, setImmediateError] = useState<string | null>(
    unresolvedQuickStart?.errorMessage ?? null,
  );
  const [immediateErrorCode, setImmediateErrorCode] = useState<string | null>(
    unresolvedQuickStart?.errorCode ?? null,
  );
  const [picker, setPicker] = useState<
    | { state: "ready"; variants: VariantOption[]; durationSec?: number; sizeCapBytes: number }
    | null
  >(null);
  const [pendingPhase, setPendingPhase] = useState<"variants" | "download" | null>(null);
  const [pendingVariantId, setPendingVariantId] = useState<string | null>(null);
  const [acceptedStart, setAcceptedStart] = useState<
    { downloadId?: number; jobId?: string } | null
  >(null);
  const pendingRef = useRef(false);
  const commandIdRef = useRef<string | null>(
    unresolvedQuickStart?.commandId ?? null,
  );
  const frozenQuickMediaIdRef = useRef<string | null>(null);
  const restoredUnknownRef = useRef(Boolean(unresolvedQuickStart));
  const previousSelectedIdRef = useRef(selectedId);
  const downloadButtonRef = useRef<HTMLButtonElement | null>(null);
  const immediateErrorRef = useRef<HTMLDivElement | null>(null);
  // The variant last handed to sendDownload, so a SIZE_CAP failure can be
  // retried with the cap bypassed without re-picking. HLS size estimates are
  // unknown up front, so the cap is only hit mid-fetch.
  const [lastVariant, setLastVariant] = useState<VariantOption | undefined>(undefined);
  const groupedAssets = [v, ...alternates];
  const selected = groupedAssets.find((item) => item.id === selectedId) ?? v;
  const recommendedCandidate = recommendation
    ? groupedAssets.find((item) => item.id === recommendation.candidateId)
    : undefined;
  const recommendationUi = recommendation && recommendedCandidate
    ? (() => {
        const candidateName = displayName(recommendedCandidate, settings.filenameTemplate);
        return {
          candidateName,
          presentation: createBestCopyRecommendationPresentation(candidateName, recommendation),
        };
      })()
    : null;
  const selectionUnavailable = bestCopyShelfSelectionIsUnavailable(selectionSource);
  const unavailableDraftSelection = selectionSource === "immutable-draft-unavailable";
  const unavailableQuickSelection = selectionSource === "quick-interaction-unavailable";
  const limitBlocked = videoLimitReached && !isStillImage(selected);
  const selectedName = displayName(selected, settings.filenameTemplate);
  const cardDomId = groupId.replace(/[^a-z0-9_-]/gi, "-");
  const includeControlId = `capture-include-${cardDomId}`;
  const recommendationReasonId = `best-copy-reason-${cardDomId}`;
  const alternativesId = `best-copy-alternatives-${cardDomId}`;
  const quickStartOutcomeUnknown =
    immediateErrorCode === "START_STATE_UNKNOWN" ||
    immediateErrorCode === "COMMAND_STATE_UNAVAILABLE";
  const previousStartUnresolved = immediateErrorCode === "PREVIOUS_START_UNRESOLVED";
  const locallyAcceptedCaptureJobId = acceptedStart
    ? acceptedStart.jobId?.startsWith(CAPTURE_JOB_ID_PREFIX)
      ? acceptedStart.jobId
      : acceptedStart.downloadId === undefined && acceptedStart.jobId === undefined
        ? null
        : undefined
    : undefined;
  const boundCaptureJobId = locallyAcceptedCaptureJobId !== undefined
    ? locallyAcceptedCaptureJobId
    : acceptedCaptureJobId;
  const quickCapture = createQuickCaptureCardModel(boundCaptureJobId, captureJobs);
  const quickCaptureLocked =
    quickStartOutcomeUnknown || previousStartUnresolved ||
    quickCaptureStartBlocked || quickCapture.locked;
  const legacyQuickStartStillActive = acceptedStart !== null && quickCapture.mode === "none" && (
    !job || !["complete", "interrupted", "error", "cancelled"].includes(job.status)
  );
  const quickInteractionInFlight =
    pendingPhase !== null || picker !== null || pendingRef.current ||
    quickCaptureLocked || legacyQuickStartStillActive;
  const unavailableSelectionMessage = unavailableDraftSelection
    ? "The copy already in Hutch is no longer on this page's shelf. ClipHutch will not replace it automatically."
    : unavailableQuickSelection
      ? quickInteractionInFlight
        ? "The copy used by this Quick Capture is no longer on the shelf. Actions remain locked while the frozen request may still be active."
        : "The copy used by this completed Quick Capture is no longer on the shelf. Choose an available copy to continue."
      : "Your selected copy is no longer on this shelf. ClipHutch will not switch to a recommendation automatically.";

  useEffect(() => {
    setShowFull(settings.showFullUrlsByDefault);
  }, [settings.showFullUrlsByDefault]);

  useEffect(() => {
    if (unresolvedQuickStart) {
      restoredUnknownRef.current = true;
      commandIdRef.current = unresolvedQuickStart.commandId;
      setImmediateErrorCode(unresolvedQuickStart.errorCode);
      setImmediateError(unresolvedQuickStart.errorMessage);
      return;
    }
    if (!restoredUnknownRef.current) return;
    // A local ambiguous start is cleared only after the parent observes a
    // successful, authoritative workspace response with no unresolved Quick
    // context. Remove the card-local copy at the same point.
    restoredUnknownRef.current = false;
    commandIdRef.current = null;
    setImmediateErrorCode(null);
    setImmediateError(null);
    setPendingPhase(null);
    setPendingVariantId(null);
  }, [unresolvedQuickStart]);

  useEffect(() => {
    if (previousSelectedIdRef.current === selected.id) return;
    if (!bestCopySelectionChangeCanResetQuickState({
      quickCaptureLocked,
      pending: pendingRef.current,
      hasCommand: commandIdRef.current !== null,
      pickerOpen: picker !== null,
      accepted: acceptedStart !== null,
    })) return;
    previousSelectedIdRef.current = selected.id;
    setJob(null);
    setDirectProgress(null);
    setPicker(null);
    setImmediateError(null);
    setImmediateErrorCode(null);
    setPendingPhase(null);
    setPendingVariantId(null);
    setAcceptedStart(null);
    setPreviewExpanded(false);
    pendingRef.current = false;
    commandIdRef.current = null;
    frozenQuickMediaIdRef.current = null;
    onReleaseQuickSelection();
    if (acceptedCaptureJobId !== undefined) onClearCaptureBinding();
    onClearQuickStartOutcomeUnknown();
  }, [selected.id]);

  useEffect(() => {
    if (!immediateError) return;
    immediateErrorRef.current?.focus();
  }, [immediateError]);

  useEffect(() => {
    if (!job || quickStartOutcomeUnknown || quickCapture.mode !== "none") return;
    setPicker(null);
    setAcceptedStart(null);
    setPendingPhase(null);
    setPendingVariantId(null);
    pendingRef.current = false;
    commandIdRef.current = null;
  }, [job?.startedAt]);

  useEffect(() => {
    if (!acceptedStart) return;
    // Release only after React has committed the accepted-state UI, so the old
    // enabled initiator cannot receive another event between response and paint.
    pendingRef.current = false;
    commandIdRef.current = null;
  }, [acceptedStart]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const result = await chrome.storage.session.get([
        DIRECT_JOBS_KEY,
        HLS_JOBS_KEY,
        DASH_JOBS_KEY,
        WEBM_TRANSCODE_JOBS_KEY,
      ]);
      const directs = (result[DIRECT_JOBS_KEY] as Record<string, DirectJob>) ?? {};
      const hlses = (result[HLS_JOBS_KEY] as Record<string, HlsJob>) ?? {};
      const dashes = (result[DASH_JOBS_KEY] as Record<string, DashJob>) ?? {};
      const webms = (result[WEBM_TRANSCODE_JOBS_KEY] as Record<string, WebmTranscodeJob>) ?? {};
      const matches: AnyJob[] = [];
      for (const j of Object.values(directs)) {
        if (j.videoId === selected.id && j.tabId === tabId) matches.push({ source: "direct", ...j });
      }
      for (const j of Object.values(hlses)) {
        if (j.videoId === selected.id && j.tabId === tabId) matches.push({ source: "hls", ...j });
      }
      for (const j of Object.values(dashes)) {
        if (j.videoId === selected.id && j.tabId === tabId) matches.push({ source: "dash", ...j });
      }
      for (const j of Object.values(webms)) {
        if (j.videoId === selected.id && j.tabId === tabId) matches.push({ source: "webm", ...j });
      }
      matches.sort((a, b) => b.startedAt - a.startedAt);
      if (!cancelled) setJob(matches[0] ?? null);
    };

    void refresh();

    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== "session") return;
      if (
        changes[DIRECT_JOBS_KEY] ||
        changes[HLS_JOBS_KEY] ||
        changes[DASH_JOBS_KEY] ||
        changes[WEBM_TRANSCODE_JOBS_KEY]
      ) {
        void refresh();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [selected.id, tabId]);

  useEffect(() => {
    if (!job || job.source !== "direct" || job.status !== "in_progress") {
      setDirectProgress(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const items = await chrome.downloads.search({ id: job.downloadId });
        if (cancelled) return;
        const item = items[0];
        if (item && item.state === "in_progress") {
          setDirectProgress({
            received: item.bytesReceived,
            total: item.totalBytes > 0 ? item.totalBytes : undefined,
          });
          timer = setTimeout(tick, 750);
        }
      } catch {
        // ignore
      }
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [job?.source === "direct" ? job.status : null, job?.source === "direct" ? job.downloadId : null]);

  function releasePending(options: { keepCommand?: boolean; keepSelection?: boolean } = {}) {
    clearPendingIntent(pendingRef);
    setPendingPhase(null);
    setPendingVariantId(null);
    if (!(options.keepSelection ?? options.keepCommand ?? false)) {
      frozenQuickMediaIdRef.current = null;
      setAcceptedStart(null);
      onReleaseQuickSelection();
      if (acceptedStart !== null || acceptedCaptureJobId !== undefined) {
        onClearCaptureBinding();
      }
    }
    if (!options.keepCommand) {
      commandIdRef.current = null;
      onClearQuickStartOutcomeUnknown();
    }
  }

  function beginPending(
    phase: "variants" | "download",
    existingCommandId?: string | null,
  ): string | null {
    if (
      limitBlocked || selectionUnavailable || quickCaptureLocked ||
      !claimPendingIntent(pendingRef)
    ) return null;
    const commandId = existingCommandId ?? createDownloadCommandId();
    if (acceptedCaptureJobId !== undefined) onClearCaptureBinding();
    frozenQuickMediaIdRef.current = selected.id;
    onFreezeQuickSelection(selected.id);
    commandIdRef.current = commandId;
    setPendingPhase(phase);
    setAcceptedStart(null);
    return commandId;
  }

  const sendDownload = async (
    commandId: string,
    variant?: VariantOption,
    bypassSizeCap?: boolean,
  ) => {
    const request: FrozenQuickDownloadRequest = {
      type: "download",
      commandId,
      tabId,
      videoId: frozenQuickMediaIdRef.current ?? selected.id,
      variantId: variant?.id,
      audioRenditionUrl: variant?.audioRenditionUrl,
      variantLabel: variant ? variantFilenameLabel(variant) : undefined,
      bypassSizeCap,
    };
    commandIdRef.current = request.commandId;
    setLastVariant(variant);
    setPendingVariantId(request.variantId ?? null);

    const markOutcomeUnknown = (
      message: string,
      code: QuickStartOutcomeUnknownIntent["errorCode"] = "START_STATE_UNKNOWN",
    ) => {
      setPicker(null);
      setAcceptedStart(null);
      setImmediateErrorCode(code);
      setImmediateError(message);
      onQuickStartOutcomeUnknown({ commandId: request.commandId, errorCode: code, errorMessage: message });
      releasePending({ keepCommand: true });
    };
    try {
      const res = (await chrome.runtime.sendMessage(request)) as DownloadResponse | undefined;
      if (!res) {
        markOutcomeUnknown(
          "ClipHutch did not confirm this start. Reconcile the same request before starting anything else.",
        );
        return;
      }
      if (!res.ok) {
        if (res.code === "START_STATE_UNKNOWN" || res.code === "COMMAND_STATE_UNAVAILABLE") {
          markOutcomeUnknown(res.error, res.code);
          return;
        }
        setPicker(null);
        setImmediateErrorCode(res.code ?? null);
        setImmediateError(res.error);
        releasePending();
        if (res.code === "PREVIOUS_START_UNRESOLVED") onPreviousStartUnresolved();
        return;
      }
      if (res.downloadId === undefined && res.jobId === undefined) {
        markOutcomeUnknown(
          "ClipHutch accepted this start, but its Activity job is not available yet. Reconcile the same request.",
        );
        return;
      }
      setImmediateError(null);
      setImmediateErrorCode(null);
      setPicker(null);
      setAcceptedStart({ downloadId: res.downloadId, jobId: res.jobId });
      setPendingPhase(null);
      setPendingVariantId(null);
      onClearQuickStartOutcomeUnknown();
      if (res.jobId?.startsWith(CAPTURE_JOB_ID_PREFIX)) onCaptureAccepted(res.jobId);
    } catch (err) {
      markOutcomeUnknown(
        err instanceof Error && err.message
          ? `${err.message} Reconcile the same request before starting anything else.`
          : "ClipHutch could not confirm this start. Reconcile the same request before starting anything else.",
      );
    }
  };

  function reconcileQuickStart() {
    const commandId = commandIdRef.current ?? unresolvedQuickStart?.commandId;
    if (!commandId || quickCaptureReconcilePending) return;
    onReconcileQuickStart(commandId);
  }

  const onDownload = async () => {
    if (limitBlocked) return;
    const needsVariants = selected.kind === "hls" || selected.kind === "dash";
    const commandId = beginPending(needsVariants ? "variants" : "download");
    if (!commandId) return;

    if (!needsVariants) {
      await sendDownload(commandId);
      return;
    }

    let lr: ListVariantsResponse;
    try {
      lr = (await chrome.runtime.sendMessage({
        type: "list-variants",
        tabId,
        videoId: selected.id,
      })) as ListVariantsResponse;
    } catch (err) {
      setPicker(null);
      setImmediateErrorCode(null);
      setImmediateError(err instanceof Error ? err.message : "Could not load manifest.");
      releasePending();
      return;
    }
    if (!lr || lr.ok === false) {
      setPicker(null);
      setImmediateErrorCode(null);
      setImmediateError(lr && "error" in lr ? lr.error : "Could not load manifest.");
      releasePending();
      return;
    }
    if (lr.variants.length === 0) {
      setPicker(null);
      setImmediateErrorCode(null);
      setImmediateError("Manifest contained no usable video tracks.");
      releasePending();
      return;
    }
    if (lr.variants.length === 1) {
      setPendingPhase("download");
      await sendDownload(commandId, lr.variants[0]);
      return;
    }
    const sortedVariants = [...lr.variants].sort((a, b) => b.bandwidth - a.bandwidth);
    setImmediateError(null);
    setImmediateErrorCode(null);
    setPicker({
      state: "ready",
      variants: sortedVariants,
      durationSec: lr.durationSec,
      sizeCapBytes: lr.sizeCapBytes,
    });
    releasePending({ keepCommand: true });
  };

  function startPickedVariant(variant: VariantOption, bypassSizeCap?: boolean) {
    const commandId = beginPending("download", commandIdRef.current);
    if (commandId) void sendDownload(commandId, variant, bypassSizeCap);
  }

  function retryOverSizeCap() {
    const commandId = beginPending("download");
    if (commandId) void sendDownload(commandId, lastVariant, true);
  }

  const onCancelPicker = () => {
    setPicker(null);
    releasePending();
    setTimeout(() => downloadButtonRef.current?.focus(), 0);
  };

  // Shared error UI for HLS/DASH jobs. On a SIZE_CAP failure, offer a one-click
  // retry that bypasses the cap with the same variant, since the size is only
  // known once the download exceeds it mid-fetch.
  const renderStreamError = (
    failed: { errorMessage?: string; errorCode?: string },
    fallbackMsg: string,
  ) => (
    <>
      <div role="alert" style={errorBoxStyle}>
        {failed.errorMessage ?? fallbackMsg}
        {failed.errorCode ? <span style={{ opacity: 0.6 }}> [{failed.errorCode}]</span> : null}
      </div>
      {failed.errorCode === "SIZE_CAP" ? (
        <button
          onClick={retryOverSizeCap}
          disabled={pendingPhase !== null || limitBlocked}
          style={{ ...(pendingPhase !== null || limitBlocked ? disabledButtonStyle : primaryButtonStyle), marginTop: 6 }}
        >
          {pendingPhase ? "Starting…" : "Download anyway (over the size cap)"}
        </button>
      ) : null}
      <button
        onClick={() => void onDownload()}
        disabled={pendingPhase !== null || limitBlocked}
        style={{ ...(pendingPhase !== null || limitBlocked ? disabledButtonStyle : buttonStyle), marginTop: 6 }}
      >
        {pendingPhase ? "Retrying…" : "Retry"}
      </button>
      {pendingPhase ? (
        <div role="status" aria-live="polite" style={{ marginTop: 5, fontSize: 11, color: "#444" }}>
          Starting one download. Other actions are temporarily disabled.
        </div>
      ) : null}
    </>
  );

  const onCancelHls = () => {
    if (job?.source !== "hls") return;
    void chrome.runtime.sendMessage({ type: "hls-download-cancel", jobId: job.jobId }).catch(() => {});
  };

  const onCancelDash = () => {
    if (job?.source !== "dash") return;
    void chrome.runtime.sendMessage({ type: "dash-download-cancel", jobId: job.jobId }).catch(() => {});
  };

  const onCancelWebm = () => {
    if (job?.source !== "webm") return;
    void chrome.runtime.sendMessage({ type: "webm-transcode-cancel", jobId: job.jobId }).catch(() => {});
  };

  function renderPicker() {
    if (!picker) return null;
    return (
      <div style={{ marginTop: 6 }} aria-busy={pendingPhase === "download"}>
        {quickCaptureLocked ? (
          <>
            <div role="alert" style={errorBoxStyle}>
              Resolve the previous start in Activity before choosing a quality.
            </div>
            <button type="button" onClick={onViewActivity} style={{ ...buttonStyle, marginTop: 6 }}>
              View Activity
            </button>
          </>
        ) : null}
        <div style={{ fontSize: 11, color: "#444", marginBottom: 4 }}>
          Choose quality:
        </div>
        {picker.variants.map((variant) => {
          const sizeBytes =
            picker.durationSec !== undefined && variant.bandwidth > 0
              ? (variant.bandwidth * picker.durationSec) / 8
              : null;
          const overCap = sizeBytes !== null && sizeBytes > picker.sizeCapBytes;
          const resLabel =
            variant.width && variant.height
              ? `${variant.width}×${variant.height}`
              : "?";
          const mbpsLabel =
            variant.bandwidth > 0
              ? `${(variant.bandwidth / 1_000_000).toFixed(1)} Mbps`
              : "bandwidth unknown";
          const sizeLabel =
            sizeBytes !== null ? ` · ${fmtBytes(sizeBytes) ?? ""}` : "";
          return (
            <div
              key={variant.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 6,
                padding: "4px 0",
                borderTop: "1px solid #eee",
              }}
            >
              <div style={{ fontSize: 11 }}>
                <div>{resLabel} · {mbpsLabel}{sizeLabel}</div>
                {overCap ? (
                  <div style={{ color: "#a05", fontSize: 10 }}>
                    over {fmtBytes(picker.sizeCapBytes)} cap
                  </div>
                ) : null}
              </div>
              <button
                onClick={() => startPickedVariant(variant)}
                disabled={pendingPhase !== null || limitBlocked || overCap || quickCaptureLocked}
                aria-label={`${overCap ? "Over the configured size cap for" : "Download"} ${resLabel} ${selectedName}`}
                style={{
                  ...(pendingPhase !== null || limitBlocked || overCap || quickCaptureLocked
                    ? disabledButtonStyle
                    : primaryButtonStyle),
                }}
              >
                {pendingVariantId === variant.id
                  ? "Starting…"
                  : overCap
                    ? "Over size cap"
                    : "Download"}
              </button>
            </div>
          );
        })}
        <button
          onClick={onCancelPicker}
          disabled={pendingPhase !== null}
          style={{ ...(pendingPhase !== null ? disabledButtonStyle : buttonStyle), marginTop: 6 }}
        >
          Cancel
        </button>
        {pendingPhase ? (
          <div role="status" aria-live="polite" style={{ marginTop: 5, fontSize: 11, color: "#444" }}>
            Starting the selected quality. Other actions are temporarily disabled.
          </div>
        ) : null}
      </div>
    );
  }

  function renderAction() {
    if (picker) return renderPicker();

    const actionDisabled =
      pendingPhase !== null || limitBlocked || selectionUnavailable || quickCaptureLocked;
    const pendingNotice = pendingPhase ? (
      <div role="status" aria-live="polite" style={{ marginTop: 5, fontSize: 11, color: "#444" }}>
        {pendingPhase === "variants"
          ? "Loading available qualities…"
          : "Starting one download. Other actions are temporarily disabled."}
      </div>
    ) : null;
    const limitNotice = limitBlocked ? (
      <div role="status" style={{ ...noteBoxStyle, background: "#fffaf0", color: "#6b5428" }}>
        Free video limit reached. Video actions are disabled; still-image downloads remain available.
      </div>
    ) : null;
    const downloadAgain = (
      <>
        <button
          ref={downloadButtonRef}
          onClick={() => void onDownload()}
          disabled={actionDisabled}
          aria-label={`Download ${selectedName} again`}
          style={{ ...(actionDisabled ? disabledButtonStyle : buttonStyle), marginTop: 6 }}
        >
          {pendingPhase ? "Starting again…" : "Download again"}
        </button>
        {pendingNotice}
        {limitNotice}
      </>
    );

    if (quickCapture.mode !== "none") {
      const captureJob = quickCapture.job;
      const progress = captureJob?.progress;
      const progressDetails = [
        progress?.completed !== undefined && progress.total !== undefined
          ? `${progress.completed}/${progress.total}`
          : undefined,
        progress?.bytes !== undefined ? fmtBytes(progress.bytes) : undefined,
      ].filter((detail): detail is string => Boolean(detail));
      const status = (
        <div role="status" aria-live="polite" style={{ ...noteBoxStyle, marginTop: 6 }}>
          <strong>{quickCapture.statusLabel}</strong>
          {quickCapture.progressPercent !== null
            ? ` · ${quickCapture.progressPercent}%`
            : progressDetails.length > 0
              ? ` · ${progressDetails.join(" · ")}`
              : null}
          {quickCapture.progressPercent !== null ? (
            <progress
              value={quickCapture.progressPercent}
              max={100}
              aria-label={`${quickCapture.statusLabel ?? "Quick Capture"} ${selectedName}`}
              style={{ display: "block", width: "100%", marginTop: 4 }}
            />
          ) : null}
        </div>
      );
      const activityButton = (
        <button
          type="button"
          onClick={onViewActivity}
          style={{ ...buttonStyle, marginTop: 6 }}
        >
          View Activity
        </button>
      );

      if (quickCapture.mode === "failed") {
        return (
          <>
            <div role="alert" style={errorBoxStyle}>
              {captureJob?.error?.customerMessage ?? "Quick Capture failed."}
              {captureJob?.error?.code ? <span style={{ opacity: 0.6 }}> [{captureJob.error.code}]</span> : null}
            </div>
            {activityButton}
            {quickCapture.canRetry ? (
              <button
                ref={downloadButtonRef}
                type="button"
                onClick={() => void onDownload()}
                disabled={actionDisabled}
                aria-label={`Retry downloading ${selectedName}`}
                style={{ ...(actionDisabled ? disabledButtonStyle : buttonStyle), marginTop: 6 }}
              >
                {pendingPhase ? "Retrying…" : "Retry"}
              </button>
            ) : null}
            {limitNotice}
          </>
        );
      }

      if (quickCapture.mode === "cancelled") {
        return (
          <>
            {status}
            {activityButton}
            <button
              ref={downloadButtonRef}
              type="button"
              onClick={() => void onDownload()}
              disabled={actionDisabled}
              aria-label={`Retry downloading ${selectedName}`}
              style={{ ...(actionDisabled ? disabledButtonStyle : buttonStyle), marginTop: 6 }}
            >
              {pendingPhase ? "Starting…" : "Try again"}
            </button>
            {limitNotice}
          </>
        );
      }

      if (quickCapture.mode === "complete") {
        return (
          <>
            {status}
            {activityButton}
            {downloadAgain}
          </>
        );
      }

      return (
        <>
          {quickCapture.mode === "outcome_unknown" ? (
            <div role="alert" style={errorBoxStyle}>
              {captureJob?.error?.customerMessage ??
                "Chrome may already have accepted this file. Check Activity before starting it again."}
            </div>
          ) : status}
          {captureWorkspaceError ? (
            <div role="alert" style={{ ...errorBoxStyle, marginTop: 6 }}>
              {captureWorkspaceError}
            </div>
          ) : null}
          {activityButton}
          {quickCapture.canCancel && captureJob ? (
            <button
              type="button"
              disabled={captureCancelPendingId !== null}
              onClick={() => void onCancelCaptureJob(captureJob)}
              style={{ ...(captureCancelPendingId !== null ? disabledButtonStyle : buttonStyle), marginTop: 6 }}
            >
              {captureCancelPendingId === captureJob.jobId ? "Cancelling…" : "Cancel"}
            </button>
          ) : null}
        </>
      );
    }

    if (quickCaptureStartBlocked || previousStartUnresolved) {
      return (
        <>
          <div role="alert" style={errorBoxStyle}>
            {previousStartUnresolved && immediateError
              ? immediateError
              : "A previous start must be reconciled before another Quick Capture can begin."}
          </div>
          <button
            type="button"
            onClick={onViewActivity}
            style={{ ...buttonStyle, marginTop: 6 }}
          >
            View Activity
          </button>
        </>
      );
    }

    if (acceptedStart && !job) {
      return (
        <>
          <div role="status" aria-live="polite" style={noteBoxStyle}>
            ClipHutch accepted this download start.
          </div>
          {downloadAgain}
        </>
      );
    }

    if (immediateError) {
      if (quickStartOutcomeUnknown) {
        return (
          <>
            <div
              ref={immediateErrorRef}
              role="alert"
              tabIndex={-1}
              style={errorBoxStyle}
            >
              {immediateError}
            </div>
            <button
              ref={downloadButtonRef}
              type="button"
              onClick={reconcileQuickStart}
              disabled={quickCaptureReconcilePending || commandIdRef.current === null}
              aria-label={`Reconcile the previous download start for ${selectedName}`}
              style={{ ...(quickCaptureReconcilePending || commandIdRef.current === null ? disabledButtonStyle : primaryButtonStyle), marginTop: 6 }}
            >
              {quickCaptureReconcilePending ? "Reconciling…" : "Reconcile start"}
            </button>
          </>
        );
      }
      return (
        <>
          <div
            ref={immediateErrorRef}
            role="alert"
            tabIndex={-1}
            style={errorBoxStyle}
          >
            {immediateError}
          </div>
          <button
            ref={downloadButtonRef}
            onClick={() => void onDownload()}
            disabled={actionDisabled}
            aria-label={`Retry downloading ${selectedName}`}
            style={{ ...(actionDisabled ? disabledButtonStyle : buttonStyle), marginTop: 6 }}
          >
            {pendingPhase ? "Retrying…" : "Retry"}
          </button>
          {pendingNotice}
          {limitNotice}
        </>
      );
    }

    if (!job) {
      if (isWebmDirectVideo(selected)) {
        return (
          <>
            <div style={noteBoxStyle}>
              WebM will be transcoded to MP4 before saving. This can take a while.
            </div>
            <button
              ref={downloadButtonRef}
              onClick={() => void onDownload()}
              disabled={actionDisabled}
              aria-label={`Convert ${selectedName} to MP4`}
              style={{ ...(actionDisabled ? disabledButtonStyle : primaryButtonStyle), marginTop: 8 }}
            >
              {pendingPhase === "variants" ? "Loading qualities…" : pendingPhase ? "Starting…" : "Convert to MP4"}
            </button>
            {pendingNotice}
            {limitNotice}
          </>
        );
      }
      return (
        <>
          <button
            ref={downloadButtonRef}
            onClick={() => void onDownload()}
            disabled={actionDisabled}
            aria-label={`Download ${selectedName}`}
            style={{ ...(actionDisabled ? disabledButtonStyle : primaryButtonStyle), marginTop: 8 }}
          >
            {pendingPhase === "variants" ? "Loading qualities…" : pendingPhase ? "Starting…" : "Download"}
          </button>
          {pendingNotice}
          {limitNotice}
        </>
      );
    }

    if (job.source === "direct") {
      if (job.status === "in_progress") {
        const total = directProgress?.total;
        const received = directProgress?.received ?? 0;
        const pct = total ? Math.round((received / total) * 100) : null;
        return (
          <div style={{ marginTop: 6 }}>
            <span role="status" aria-live="polite" style={visuallyHiddenStyle}>
              Download in progress for {selectedName}.
            </span>
            <div style={{ fontSize: 11, color: "#444" }}>
              {pct !== null
                ? `Downloading ${pct}% - ${fmtBytes(received)} / ${fmtBytes(total)}`
                : received > 0
                  ? `Downloading… ${fmtBytes(received)}`
                  : "Starting…"}
            </div>
            {total ? (
              <progress
                value={received}
                max={total}
                aria-label={`Downloading ${selectedName}`}
                style={{ width: "100%", marginTop: 3 }}
              />
            ) : null}
          </div>
        );
      }
      if (job.status === "complete") {
        return (
          <>
            <DownloadSuccessRow v={selected} job={job} />
            {downloadAgain}
          </>
        );
      }
      return (
        <>
          <div role="alert" style={errorBoxStyle}>{job.errorMessage ?? "Download interrupted."}</div>
          <button
            ref={downloadButtonRef}
            onClick={() => void onDownload()}
            disabled={actionDisabled}
            style={{ ...(actionDisabled ? disabledButtonStyle : buttonStyle), marginTop: 6 }}
          >
            {pendingPhase ? "Retrying…" : "Retry"}
          </button>
          {pendingNotice}
          {limitNotice}
        </>
      );
    }

    if (job.source === "hls") {
      if (job.status === "running") {
        const { done, total, bytes } = job.progress;
        const text =
          total > 0
            ? `Downloading ${done} of ${total} segments… (${fmtBytes(bytes) ?? "0 B"})`
            : "Starting HLS download…";
        const pct = total > 0 ? done / total : null;
        return (
          <div style={{ marginTop: 6 }}>
            <span role="status" aria-live="polite" style={visuallyHiddenStyle}>
              HLS download in progress for {selectedName}.
            </span>
            <div style={{ fontSize: 11, color: "#444" }}>{text}</div>
            {pct !== null ? (
              <progress value={done} max={total} aria-label={`Downloading ${selectedName}`} style={{ width: "100%", marginTop: 3 }} />
            ) : null}
            <button onClick={onCancelHls} style={{ ...buttonStyle, marginTop: 4 }}>
              Cancel
            </button>
          </div>
        );
      }
      if (job.status === "delivery_pending" || job.status === "saving") {
        return (
          <div role="status" aria-live="polite" style={{ marginTop: 6, fontSize: 11, color: "#444" }}>
            Saving file…
          </div>
        );
      }
      if (job.status === "complete") {
        return (
          <>
            <DownloadSuccessRow v={selected} job={job} />
            {downloadAgain}
          </>
        );
      }
      if (job.status === "cancelled") {
        return (
          <>
            <div role="status" style={noteBoxStyle}>Download cancelled.</div>
            <button
              ref={downloadButtonRef}
              onClick={() => void onDownload()}
              disabled={actionDisabled}
              style={{ ...(actionDisabled ? disabledButtonStyle : buttonStyle), marginTop: 6 }}
            >
              {pendingPhase ? "Starting…" : "Try again"}
            </button>
            {pendingNotice}
            {limitNotice}
          </>
        );
      }
      return renderStreamError(job, "Download failed.");
    }

    if (job.source === "webm") {
      if (job.status === "running") {
        const pct = Math.round(job.progress.ratio * 100);
        return (
          <div style={{ marginTop: 6 }}>
            <span role="status" aria-live="polite" style={visuallyHiddenStyle}>
              WebM conversion in progress for {selectedName}.
            </span>
            <div style={{ fontSize: 11, color: "#444" }}>
              {job.progress.message ?? "Transcoding WebM to MP4"} {pct > 0 ? `${pct}%` : ""}
            </div>
            <progress value={job.progress.ratio} max={1} aria-label={`Converting ${selectedName} to MP4`} style={{ width: "100%", marginTop: 3 }} />
            <button onClick={onCancelWebm} style={{ ...buttonStyle, marginTop: 4 }}>
              Cancel
            </button>
          </div>
        );
      }
      if (job.status === "delivery_pending" || job.status === "saving") {
        return (
          <div role="status" aria-live="polite" style={{ marginTop: 6, fontSize: 11, color: "#444" }}>
            Saving MP4…
          </div>
        );
      }
      if (job.status === "complete") {
        return (
          <>
            <DownloadSuccessRow v={selected} job={job} />
            {downloadAgain}
          </>
        );
      }
      if (job.status === "cancelled") {
        return (
          <>
            <div role="status" style={noteBoxStyle}>Transcode cancelled.</div>
            <button
              ref={downloadButtonRef}
              onClick={() => void onDownload()}
              disabled={actionDisabled}
              style={{ ...(actionDisabled ? disabledButtonStyle : buttonStyle), marginTop: 6 }}
            >
              {pendingPhase ? "Starting…" : "Try again"}
            </button>
            {pendingNotice}
            {limitNotice}
          </>
        );
      }
      return (
        <>
          <div role="alert" style={errorBoxStyle}>
            {job.errorMessage ?? "WebM transcode failed."}
            {job.errorCode ? <span style={{ opacity: 0.6 }}> [{job.errorCode}]</span> : null}
          </div>
          <button
            ref={downloadButtonRef}
            onClick={() => void onDownload()}
            disabled={actionDisabled}
            style={{ ...(actionDisabled ? disabledButtonStyle : buttonStyle), marginTop: 6 }}
          >
            {pendingPhase ? "Retrying…" : "Retry"}
          </button>
          {pendingNotice}
          {limitNotice}
        </>
      );
    }

    // DASH branch
    if (job.status === "running") {
      const { done, total, bytes } = job.progress;
      const text =
        total > 0
          ? `Downloading ${done} of ${total} segments… (${fmtBytes(bytes) ?? "0 B"})`
          : "Starting DASH download…";
      const pct = total > 0 ? done / total : null;
      return (
        <div style={{ marginTop: 6 }}>
          <span role="status" aria-live="polite" style={visuallyHiddenStyle}>
            DASH download in progress for {selectedName}.
          </span>
          <div style={{ fontSize: 11, color: "#444" }}>{text}</div>
          {pct !== null ? (
            <progress value={done} max={total} aria-label={`Downloading ${selectedName}`} style={{ width: "100%", marginTop: 3 }} />
          ) : null}
          <button onClick={onCancelDash} style={{ ...buttonStyle, marginTop: 4 }}>
            Cancel
          </button>
        </div>
      );
    }
    if (job.status === "delivery_pending" || job.status === "saving") {
      return (
        <div role="status" aria-live="polite" style={{ marginTop: 6, fontSize: 11, color: "#444" }}>
          Muxing video + audio into one MP4…
        </div>
      );
    }
    if (job.status === "complete") {
      return (
        <>
          <DownloadSuccessRow v={selected} job={job} />
          {downloadAgain}
        </>
      );
    }
    if (job.status === "cancelled") {
      return (
        <>
          <div role="status" style={noteBoxStyle}>Download cancelled.</div>
          <button
            ref={downloadButtonRef}
            onClick={() => void onDownload()}
            disabled={actionDisabled}
            style={{ ...(actionDisabled ? disabledButtonStyle : buttonStyle), marginTop: 6 }}
          >
            {pendingPhase ? "Starting…" : "Try again"}
          </button>
          {pendingNotice}
          {limitNotice}
        </>
      );
    }
    return renderStreamError(job, "Download failed.");
  }

  const sourceHost = hostname(selected.url);
  const pageHost = pageLabel(selected);
  const alternateOptions = groupedAssets.filter((item) => item.id !== selected.id);

  return (
    <article
      aria-labelledby={`media-${selected.id}-heading`}
      aria-busy={pendingPhase !== null || alternatePendingId !== null || quickInteractionInFlight}
      style={{
        border: "1px solid #cbd8cf",
        borderRadius: 8,
        padding: 10,
        marginBottom: 10,
        minWidth: 0,
        boxSizing: "border-box",
        background: "#ffffff",
        boxShadow: "0 1px 1px rgba(62, 48, 30, 0.06)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <h3
          id={`media-${selected.id}-heading`}
          style={{
            margin: 0,
            minWidth: 0,
            fontSize: 13,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "#172018",
          }}
        >
          {displayName(selected, settings.filenameTemplate)}
        </h3>
        <span
          style={{
            fontSize: 10,
            padding: "2px 7px",
            background: "#e7f0e9",
            borderRadius: 999,
            color: "#2f4f3a",
            whiteSpace: "nowrap",
            border: "1px solid #d3e0d7",
          }}
        >
          {badgeText(selected)}
        </span>
      </div>
      {recommendationUi ? (
        <div
          role="note"
          aria-label={recommendationUi.presentation.ariaLabel}
          aria-describedby={recommendationReasonId}
          aria-current={
            !selectionUnavailable && recommendation?.candidateId === selected.id
              ? "true"
              : undefined
          }
          style={{
            ...noteBoxStyle,
            marginTop: 7,
            borderColor: "#9dbba5",
            background: "#edf7f0",
            color: "#244f3a",
          }}
        >
          <div>
            <strong>{recommendationUi.presentation.label}</strong>
            {" · "}
            {recommendationUi.candidateName}
          </div>
          <div id={recommendationReasonId} style={{ marginTop: 2 }}>
            <div>{recommendationUi.presentation.reason}</div>
            <div style={{ marginTop: 2, color: "#476653" }}>
              {recommendationUi.presentation.availabilityNote}
            </div>
          </div>
          {selectionUnavailable ? (
            <div style={{ marginTop: 2 }}>
              This recommendation has not replaced your unavailable choice.
            </div>
          ) : null}
        </div>
      ) : null}
      {selectionUnavailable ? (
        <div role="alert" style={{ ...errorBoxStyle, marginTop: 7 }}>
          <div>{unavailableSelectionMessage}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
            {unavailableDraftSelection ? (
              <button type="button" onClick={onViewHutch} style={buttonStyle}>
                View Hutch
              </button>
            ) : null}
            {unavailableQuickSelection ? (
              <button type="button" onClick={onViewActivity} style={buttonStyle}>
                View Activity
              </button>
            ) : null}
            {!unavailableQuickSelection || !quickInteractionInFlight ? (
              <button
                type="button"
                disabled={
                  inclusionPending || alternatePendingId !== null || pendingPhase !== null ||
                  picker !== null || quickCaptureLocked ||
                  (unavailableQuickSelection && quickInteractionInFlight)
                }
                onClick={() => {
                  void onSelect(selected.id).then((selectedCopy) => {
                    if (!selectedCopy) return;
                    setPicker(null);
                    setImmediateError(null);
                    setImmediateErrorCode(null);
                    releasePending();
                  });
                }}
                style={
                  inclusionPending || alternatePendingId !== null
                    || pendingPhase !== null || picker !== null || quickCaptureLocked
                    || (unavailableQuickSelection && quickInteractionInFlight)
                    ? disabledButtonStyle
                    : buttonStyle
                }
              >
                {unavailableDraftSelection ? "Replace with displayed copy" : "Use displayed copy"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <label
        htmlFor={includeControlId}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 7,
          padding: "5px 7px",
          borderRadius: 6,
          border: included ? "1px solid #6d9979" : "1px solid #d5e0d8",
          background: included ? "#edf7f0" : "#f8fbf9",
          color: included ? "#244f3a" : "#4d5c51",
          fontSize: 11,
          fontWeight: 600,
          cursor:
            inclusionPending ? "wait" :
              quickCaptureLocked || (selectionUnavailable && !included) ? "not-allowed" :
                "pointer",
        }}
      >
        <input
          id={includeControlId}
          type="checkbox"
          checked={included}
          disabled={
            inclusionPending || alternatePendingId !== null || pendingPhase !== null || picker !== null ||
            quickCaptureLocked || (selectionUnavailable && !included)
          }
          onChange={(event) => onIncludedChange(event.currentTarget.checked)}
          aria-label={
            selectionUnavailable && included
              ? "Remove the unavailable selected copy from Capture Pack"
              : `${included ? "Remove" : "Add"} ${selectedName} ${included ? "from" : "to"} Capture Pack`
          }
        />
        {inclusionPending
          ? "Updating Capture Pack…"
          : selectionUnavailable && included
            ? "Included copy is unavailable on this shelf"
            : selectionUnavailable
              ? "Choose an available copy before adding"
              : included
                ? "Included in Capture Pack"
                : "Add to Capture Pack"}
      </label>
      {fmtBytes(selected.sizeBytes) !== undefined && (
        <div style={{ color: "#6f7c72", fontSize: 11, marginTop: 2 }}>{fmtBytes(selected.sizeBytes)}</div>
      )}
      <div
        style={{
          display: "flex",
          gap: 5,
          flexWrap: "wrap",
          alignItems: "center",
          marginTop: 5,
          color: "#6f7c72",
          fontSize: 10,
        }}
      >
        <span title={customerVisibleUrlTitle(selected.url, settings.showFullUrlsByDefault)}>
          source: {sourceLabel(selected)}
        </span>
        {pageHost ? <span>page: {pageHost}</span> : null}
        {sourceHost ? (
          <button
            onClick={() => onIgnoreSource(sourceHost)}
            disabled={pendingPhase !== null || inclusionPending || alternatePendingId !== null || quickCaptureLocked}
            title={`Hide media loaded from ${sourceHost}`}
            style={{ ...buttonStyle, padding: "1px 5px", fontSize: 10 }}
          >
            Hide source
          </button>
        ) : null}
        {pageHost ? (
          <button
            onClick={() => onIgnorePage(pageHost)}
            disabled={pendingPhase !== null || quickCaptureLocked}
            title={`Ignore pages on ${pageHost}`}
            style={{ ...buttonStyle, padding: "1px 5px", fontSize: 10 }}
          >
            Ignore site
          </button>
        ) : null}
      </div>
      {alternateOptions.length > 0 ? (
        <div style={{ ...noteBoxStyle, background: "#f7fbf8" }}>
          <button
            type="button"
            aria-expanded={showAlternates}
            aria-controls={alternativesId}
            onClick={() => setShowAlternates((s) => !s)}
            disabled={pendingPhase !== null || quickCaptureLocked}
            style={{ ...buttonStyle, padding: "2px 6px", fontSize: 10, marginRight: 6 }}
          >
            {showAlternates ? "Hide" : "Show all"} {alternateOptions.length} alternative
            {alternateOptions.length === 1 ? "" : "s"}
          </button>
          <span>
            All verified related copies remain available for you to choose.
          </span>
          <div id={alternativesId} hidden={!showAlternates} style={{ marginTop: 5 }}>
            {alternateOptions.map((alt) => (
              <div
                key={alt.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto auto",
                  gap: 5,
                  alignItems: "center",
                  padding: "3px 0",
                  borderTop: "1px solid #dfeae3",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                  <span
                    title={customerVisibleUrlTitle(alt.url, settings.showFullUrlsByDefault)}
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {displayName(alt, settings.filenameTemplate)}
                  </span>
                  {alt.id === recommendation?.candidateId ? (
                    <span
                      style={{
                        color: "#2f5f3a",
                        fontWeight: 700,
                        fontSize: 9,
                        textTransform: "uppercase",
                        flexShrink: 0,
                      }}
                    >
                      Recommended
                    </span>
                  ) : null}
                </div>
                <span style={{ color: "#758277" }}>
                  {[
                    alt.width !== undefined && alt.height !== undefined
                      ? `${alt.width}×${alt.height}`
                      : undefined,
                    fmtBytes(alt.sizeBytes) ?? badgeText(alt),
                  ].filter((detail): detail is string => detail !== undefined).join(" · ")}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void onSelect(alt.id).then((selectedAlternate) => {
                      if (!selectedAlternate) return;
                      setPicker(null);
                      setImmediateError(null);
                      setImmediateErrorCode(null);
                      releasePending();
                      setShowAlternates(false);
                    });
                  }}
                  disabled={
                    pendingPhase !== null || picker !== null || inclusionPending ||
                    alternatePendingId !== null || quickCaptureLocked ||
                    (unavailableQuickSelection && quickInteractionInFlight)
                  }
                  aria-label={
                    included
                      ? `Replace ${selectedName} in Capture Pack with ${displayName(alt, settings.filenameTemplate)}${alt.id === recommendation?.candidateId ? " (recommended)" : ""}`
                      : `Select ${displayName(alt, settings.filenameTemplate)}${alt.id === recommendation?.candidateId ? " (recommended)" : ""}`
                  }
                  aria-describedby={
                    alt.id === recommendation?.candidateId ? recommendationReasonId : undefined
                  }
                  style={{ ...buttonStyle, padding: "2px 6px", fontSize: 10 }}
                >
                  {alternatePendingId === alt.id ? "Replacing…" : included ? "Replace" : "Select"}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {alternateError ? (
        <div role="alert" aria-live="assertive" style={{ ...errorBoxStyle, marginTop: 6 }}>
          {alternateError}
        </div>
      ) : null}
      <Diagnostics v={selected} job={job} />
      {deferPreview && (canPreview(selected) || isStillImage(selected)) ? (
        <button
          type="button"
          aria-expanded={previewExpanded}
          onClick={() => setPreviewExpanded((current) => !current)}
          style={{ ...buttonStyle, marginTop: 7 }}
        >
          {previewExpanded ? "Hide preview" : "Preview"}
        </button>
      ) : null}
      {!deferPreview || previewExpanded ? (
        <>
          <VideoPreview v={selected} />
          <ImagePreview v={selected} />
        </>
      ) : null}
      <div style={{ color: "#59675d", fontSize: 10, wordBreak: "break-all", marginTop: 7 }}>
        {urlDisplay(selected.url, showFull)}{" "}
        <button
          onClick={() => setShowFull((s) => !s)}
          disabled={pendingPhase !== null}
          style={{
            marginLeft: 4,
            fontSize: 10,
            padding: "1px 5px",
            cursor: "pointer",
            border: "1px solid #c8d6cc",
            borderRadius: 4,
            background: "#f7fbf8",
          }}
        >
          {showFull ? "hide" : "show full URL"}
        </button>
      </div>
      {renderAction()}
      <div style={{ ...shelfLineStyle, marginTop: 10 }} />
    </article>
  );
}

export function WorkspaceShell({ surface }: { surface: WorkspaceSurface }) {
  const [tabId, setTabId] = useState<number | null>(null);
  const [workspaceWindowId, setWorkspaceWindowId] = useState<number | null>(null);
  const [activePageUrl, setActivePageUrl] = useState<string | null>(null);
  const [videos, setVideos] = useState<DetectedVideo[]>([]);
  const [detectionStats, setDetectionStats] = useState<DetectionRetentionStats | null>(null);
  const [showStreamParts, setShowStreamParts] = useState(false);
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("videos");
  const [settings, setSettingsState] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [workspaceBootstrapped, setWorkspaceBootstrapped] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sidePanelOpenError, setSidePanelOpenError] = useState<string | null>(null);
  const [licensed, setLicensed] = useState(false);
  const [licenseNotice, setLicenseNotice] = useState<string | null>(null);
  const [downloadCount, setDownloadCount] = useState(0);
  const [captureDraft, setCaptureDraft] = useState<CaptureDraftV1 | null>(null);
  const [captureDraftError, setCaptureDraftError] = useState<string | null>(null);
  const [captureName, setCaptureName] = useState("New Capture Pack");
  const [captureRenamePending, setCaptureRenamePending] = useState(false);
  const [capturePageLabelInputs, setCapturePageLabelInputs] = useState<Record<string, string>>({});
  const [capturePageLabelPendingUrl, setCapturePageLabelPendingUrl] = useState<string | null>(null);
  const [pendingCaptureGroupId, setPendingCaptureGroupId] = useState<string | null>(null);
  const [pendingCaptureAlternateId, setPendingCaptureAlternateId] = useState<string | null>(null);
  const [captureAlternateErrors, setCaptureAlternateErrors] = useState<Record<string, string>>({});
  const [captureView, setCaptureView] = useState<CaptureView>(
    surface === "sidepanel" ? "hutch" : "shelf",
  );
  const [capturePlan, setCapturePlan] = useState<CaptureReviewPlanV1 | null>(null);
  const [captureOptions, setCaptureOptions] = useState<CaptureVariantOptionV1[]>([]);
  const [captureChoices, setCaptureChoices] = useState<CapturePlanChoiceSelectorV1[]>([]);
  const [captureReviewPending, setCaptureReviewPending] = useState(false);
  const [captureReviewError, setCaptureReviewError] = useState<string | null>(null);
  const [selectedFreeVideoIds, setSelectedFreeVideoIds] = useState<string[]>([]);
  const [captureRuns, setCaptureRuns] = useState<CaptureRunV1[]>([]);
  const [captureJobs, setCaptureJobs] = useState<CaptureJobV1[]>([]);
  const [captureManifests, setCaptureManifests] = useState<CaptureWorkspaceManifestV1[]>([]);
  const [quickCaptureJobIdsByGroup, setQuickCaptureJobIdsByGroup] =
    useState<Record<string, string>>({});
  const [quickSelectionByGroup, setQuickSelectionByGroup] =
    useState<Record<string, string>>({});
  const [quickStartOutcomeUnknownByGroup, setQuickStartOutcomeUnknownByGroup] =
    useState<Record<string, QuickStartOutcomeUnknownIntent>>({});
  const [workspaceQuota, setWorkspaceQuota] = useState<CaptureWorkspaceQuotaV1 | null>(null);
  const [captureWorkspaceError, setCaptureWorkspaceError] = useState<string | null>(null);
  const [quickCaptureContext, setQuickCaptureContext] =
    useState<CaptureWorkspaceQuickCaptureContextV1 | null>(null);
  const [quickCaptureReconcilePending, setQuickCaptureReconcilePending] = useState(false);
  const [quickCaptureReconcileError, setQuickCaptureReconcileError] = useState<string | null>(null);
  const [previousStartUnresolved, setPreviousStartUnresolved] = useState(false);
  const [captureRunPending, setCaptureRunPending] = useState(false);
  const [captureRunOutcomeUnknown, setCaptureRunOutcomeUnknown] = useState(false);
  const [captureCancelPendingId, setCaptureCancelPendingId] = useState<string | null>(null);
  const [captureManifestCsvPending, setCaptureManifestCsvPending] = useState(false);
  const [captureManifestRetryPendingKey, setCaptureManifestRetryPendingKey] =
    useState<string | null>(null);
  const [captureManifestRetryErrors, setCaptureManifestRetryErrors] =
    useState<Record<string, string>>({});
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, string>>({});
  const capturePlanCommandRef = useRef<string | null>(null);
  const captureRunCommandRef = useRef<string | null>(null);
  const captureCancelCommandRefs = useRef<Record<string, string>>({});
  const captureManifestRetryCommandRefs = useRef<Record<string, string>>({});
  const workspaceRefreshPendingRef = useRef(false);
  const workspaceRefreshQueuedRef = useRef(false);
  const workspaceRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const quickStartUiRevisionRef = useRef(0);
  const captureDraftMutationPendingRef = useRef(false);
  const captureReviewPendingRef = useRef(false);
  const captureRunPendingRef = useRef(false);
  const captureCancelPendingRef = useRef(false);
  const captureManifestRetryPendingRef = useRef(false);
  const quickCaptureReconcilePendingRef = useRef(false);
  const captureRenamePendingRef = useRef(false);
  const captureRunAllocationKeyRef = useRef<string | null>(null);
  const captureRunReconcileRef = useRef<CaptureRunReconcileIntent | null>(null);
  const workspaceWindowIdRef = useRef<number | null>(null);
  const activeTabIdRef = useRef<number | null>(null);
  const activeTabPageUrlRef = useRef<string | null>(null);
  const activeTabLoadGenerationRef = useRef(0);
  const workspaceTabRefs = useRef<Partial<Record<CaptureView, HTMLButtonElement | null>>>({});
  const shelfTabRefs = useRef<Partial<Record<MediaFilter, HTMLButtonElement | null>>>({});
  const hutchHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const hutchRemoveButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingHutchFocusRef = useRef<{
    removedItemId: string;
    targetItemId: string | null;
  } | null>(null);

  useLayoutEffect(() => {
    const pending = pendingHutchFocusRef.current;
    if (!pending) return;
    if (captureView !== "hutch") {
      pendingHutchFocusRef.current = null;
      return;
    }
    if (captureDraft?.items[pending.removedItemId]) return;
    const target = pending.targetItemId
      ? hutchRemoveButtonRefs.current.get(pending.targetItemId)
      : undefined;
    (target ?? hutchHeadingRef.current)?.focus();
    pendingHutchFocusRef.current = null;
  }, [captureDraft, captureView]);

  function clearCaptureRunIntent(): void {
    captureRunCommandRef.current = null;
    captureRunReconcileRef.current = null;
    setCaptureRunOutcomeUnknown(false);
  }

  function applyCaptureManifestWorkspace(
    manifests: CaptureWorkspaceManifestV1[],
    runs: readonly CaptureRunV1[],
  ): void {
    setCaptureManifests(manifests);
    const runIds = new Set(runs.map((run) => run.runId));
    const outputByKey = new Map(manifests.flatMap((manifest) =>
      manifest.outputs.map((output) => [
        captureManifestRetryKey(manifest.runId, output.format),
        output,
      ] as const)));
    const settledKeys = Object.keys(captureManifestRetryCommandRefs.current).filter((key) => {
      const output = outputByKey.get(key);
      const separator = key.indexOf("\u0000");
      const runId = separator < 0 ? "" : key.slice(0, separator);
      return !runIds.has(runId) || (output !== undefined && output.state !== "failed");
    });
    if (settledKeys.length === 0) return;
    for (const key of settledKeys) delete captureManifestRetryCommandRefs.current[key];
    setCaptureManifestRetryErrors((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => !settledKeys.includes(key)),
    ));
  }

  function applyWorkspaceRunContext(workspace: CaptureWorkspaceSuccess): void {
    const context = workspace.runContext;
    if (!context) {
      // The background journal is authoritative. A missing unresolved context
      // is the only workspace observation that can clear a locally ambiguous
      // reconciliation command without an accepted enqueue response.
      if (captureRunCommandRef.current || captureRunReconcileRef.current) {
        clearCaptureRunIntent();
      }
      return;
    }
    const contextPlan = workspace.plans.find((plan) => plan.planId === context.planId);
    if (contextPlan) {
      const review = workspace.reviewContext?.planId === context.planId
        ? workspace.reviewContext
        : null;
      setCapturePlan(contextPlan);
      setCaptureOptions(review?.options ?? []);
      setCaptureChoices(review?.choices ?? []);
      setSelectedFreeVideoIds([]);
      capturePlanCommandRef.current = review?.commandId ?? null;
      captureRunCommandRef.current = context.commandId;
      captureRunReconcileRef.current = {
        planId: context.planId,
        draftId: context.draftId,
        draftRevision: context.draftRevision,
        licensed: context.licensed,
        freeVideoItemIds: [...context.requestedFreeVideoItemIds],
        selectionMustMatch: false,
      };
      setCaptureRunOutcomeUnknown(true);
      const message = context.status === "pending"
        ? "A previous pack start was not confirmed. No videos were auto-selected; reconcile to check only that frozen request."
        : context.reconciliationState === "committed_missing_run"
          ? "The previous pack was accepted, but its run record is missing. Reconcile the frozen request so ClipHutch can recover it without creating another run."
          : "The previous pack was accepted, but its queue still needs recovery. Reconcile the frozen request without creating another run.";
      setCaptureReviewError(message);
      setCaptureView("review");
    }
  }

  async function refreshUsage() {
    const [lic, count] = await Promise.all([isLicensed(), getDownloadCount()]);
    setLicensed(lic);
    setDownloadCount(count);
    setWorkspaceQuota((current) => current ? {
      ...current,
      licensed: lic,
      used: count,
      remaining: lic ? current.limit : Math.max(0, current.limit - count),
    } : current);
  }

  async function loadActiveTabMedia(tab: chrome.tabs.Tab | undefined): Promise<void> {
    const loadGeneration = activeTabLoadGenerationRef.current + 1;
    activeTabLoadGenerationRef.current = loadGeneration;
    const nextTabId = tab?.id ?? null;
    const nextPageUrl = normalizedHttpPageUrl(tab?.url);
    activeTabIdRef.current = nextTabId;
    activeTabPageUrlRef.current = nextPageUrl;
    setTabId(nextTabId);
    setActivePageUrl(nextPageUrl);
    setVideos([]);
    setDetectionStats(null);
    setShowStreamParts(false);
    setLoadError(null);
    setLoaded(false);
    if (nextTabId === null || nextPageUrl === null) {
      setLoaded(true);
      return;
    }
    try {
      const [detected, stats] = await Promise.all([
        getDetectedVideos(nextTabId),
        getDetectionRetentionStats(nextTabId),
      ]);
      if (!activeTabLoadIsCurrent({
        currentGeneration: activeTabLoadGenerationRef.current,
        loadGeneration,
        currentTabId: activeTabIdRef.current,
        loadTabId: nextTabId,
      })) return;
      setVideos(detected);
      setDetectionStats(stats);
      setLoaded(true);
    } catch {
      if (!activeTabLoadIsCurrent({
        currentGeneration: activeTabLoadGenerationRef.current,
        loadGeneration,
        currentTabId: activeTabIdRef.current,
        loadTabId: nextTabId,
      })) return;
      setLoadError(
        surface === "sidepanel"
          ? "ClipHutch could not load media for the selected tab. Switch tabs or retry by reopening the panel."
          : "ClipHutch could not load media for this tab. Close and reopen the popup to try again.",
      );
      setLoaded(true);
    }
  }

  async function refreshCaptureWorkspace(): Promise<void> {
    if (workspaceRefreshPendingRef.current) {
      workspaceRefreshQueuedRef.current = true;
      await workspaceRefreshPromiseRef.current;
      return;
    }
    workspaceRefreshPendingRef.current = true;
    const refreshPromise = (async () => {
      do {
        workspaceRefreshQueuedRef.current = false;
        const quickStartUiRevision = quickStartUiRevisionRef.current;
        const result = await getCaptureWorkspace();
        if (!result.ok) {
          setCaptureWorkspaceError("Activity is unavailable right now; downloads may still be running.");
          continue;
        }
        setCaptureWorkspaceError(null);
        setCaptureRuns(result.runs);
        setCaptureJobs(result.jobs);
        applyCaptureManifestWorkspace(result.manifests, result.runs);
        setQuickCaptureContext(result.quickCaptureContext);
        if (result.quickCaptureContext !== null) {
          setPreviousStartUnresolved(false);
        } else if (quickStartUiRevisionRef.current === quickStartUiRevision) {
          setQuickStartOutcomeUnknownByGroup({});
          setPreviousStartUnresolved(false);
          setQuickCaptureReconcileError(null);
        }
        setWorkspaceQuota(result.quota);
        setLicensed(result.quota.licensed);
        setDownloadCount(result.quota.used);
        applyWorkspaceRunContext(result);
      } while (workspaceRefreshQueuedRef.current);
    })();
    workspaceRefreshPromiseRef.current = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      workspaceRefreshPendingRef.current = false;
      workspaceRefreshPromiseRef.current = null;
    }
  }

  useEffect(() => {
    let active = true;
    const quickStartUiRevision = quickStartUiRevisionRef.current;
    void (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active) return;
      const activeTab = tabs[0];
      const nextWindowId = activeTab?.windowId ?? null;
      workspaceWindowIdRef.current = nextWindowId;
      setWorkspaceWindowId(nextWindowId);
      const activeTabMediaLoad = loadActiveTabMedia(activeTab);
      const [s, lic, count, notice, draftResult, workspaceResult] = await Promise.all([
        getSettings(),
        isLicensed(),
        getDownloadCount(),
        getLicenseNotice(),
        getCaptureDraft(),
        getCaptureWorkspace(),
      ]);
      if (!active) return;
      setSettingsState(s);
      setLicensed(lic);
      setLicenseNotice(notice?.message ?? null);
      setDownloadCount(count);
      if (draftResult.ok) {
        setCaptureDraft(draftResult.draft);
      } else {
        setCaptureDraftError("ClipHutch could not load the current Capture Pack.");
      }
      if (workspaceResult.ok) {
        setCaptureWorkspaceError(null);
        setCaptureRuns(workspaceResult.runs);
        setCaptureJobs(workspaceResult.jobs);
        applyCaptureManifestWorkspace(workspaceResult.manifests, workspaceResult.runs);
        setQuickCaptureContext(workspaceResult.quickCaptureContext);
        if (workspaceResult.quickCaptureContext !== null) {
          setPreviousStartUnresolved(false);
        } else if (quickStartUiRevisionRef.current === quickStartUiRevision) {
          setQuickStartOutcomeUnknownByGroup({});
          setPreviousStartUnresolved(false);
        }
        setWorkspaceQuota(workspaceResult.quota);
        setLicensed(workspaceResult.quota.licensed);
        setDownloadCount(workspaceResult.quota.used);
        const context = workspaceResult.reviewContext;
        const restoredPlan = context
          ? workspaceResult.plans.find((plan) => plan.planId === context.planId)
          : undefined;
        if (
          restoredPlan && draftResult.ok && draftResult.draft &&
          restoredPlan.draftId === draftResult.draft.draftId &&
          restoredPlan.draftRevision === draftResult.draft.revision
        ) {
          setCapturePlan(restoredPlan);
          setCaptureOptions(context?.options ?? []);
          setCaptureChoices(context?.choices ?? []);
          capturePlanCommandRef.current = context?.commandId ?? null;
          // A restored review must never spend quota on videos the customer
          // did not explicitly select in this popup activation.
          setSelectedFreeVideoIds([]);
        }
        applyWorkspaceRunContext(workspaceResult);
      } else {
        setCaptureWorkspaceError("Activity is unavailable right now; downloads may still be running.");
      }
      await activeTabMediaLoad;
      if (surface === "sidepanel" && nextWindowId !== null && active) {
        const currentTabs = await chrome.tabs.query({ active: true, windowId: nextWindowId });
        const currentTab = currentTabs[0];
        const currentPageUrl = normalizedHttpPageUrl(currentTab?.url);
        if (
          currentTab?.id !== activeTabIdRef.current ||
          currentPageUrl !== activeTabPageUrlRef.current
        ) {
          await loadActiveTabMedia(currentTab);
        }
      }
      if (active) setWorkspaceBootstrapped(true);

      // Background re-validation refreshes only this existing activation. It
      // cannot silently consume a new server device slot.
      if (lic) {
        void revalidateIfStale()
          .then((result) => {
            if (result.status === "deactivated") {
              setLicenseNotice(result.message);
            }
          })
          .catch(() => undefined);
      }
    })().catch(() => {
      if (!active) return;
      setLoadError(
        surface === "sidepanel"
          ? "ClipHutch could not finish loading this workspace. Close and reopen the side panel to try again."
          : "ClipHutch could not finish loading this workspace. Close and reopen the popup to try again.",
      );
      setLoaded(true);
      setWorkspaceBootstrapped(true);
    });
    return () => {
      active = false;
      activeTabLoadGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (surface !== "sidepanel" || workspaceWindowId === null) return;
    let disposed = false;

    const followTabId = async (nextTabId: number) => {
      const followGeneration = activeTabLoadGenerationRef.current + 1;
      activeTabLoadGenerationRef.current = followGeneration;
      activeTabIdRef.current = nextTabId;
      activeTabPageUrlRef.current = null;
      setTabId(nextTabId);
      setActivePageUrl(null);
      setVideos([]);
      setDetectionStats(null);
      setLoaded(false);
      try {
        const tab = await chrome.tabs.get(nextTabId);
        if (
          disposed || activeTabLoadGenerationRef.current !== followGeneration ||
          activeTabIdRef.current !== nextTabId || tab.windowId !== workspaceWindowId ||
          !tab.active
        ) return;
        await loadActiveTabMedia(tab);
      } catch {
        if (!disposed && activeTabLoadGenerationRef.current === followGeneration) {
          await followCurrentTab();
        }
      }
    };
    const followCurrentTab = async () => {
      const followGeneration = activeTabLoadGenerationRef.current + 1;
      activeTabLoadGenerationRef.current = followGeneration;
      activeTabIdRef.current = null;
      activeTabPageUrlRef.current = null;
      setTabId(null);
      setActivePageUrl(null);
      setVideos([]);
      setDetectionStats(null);
      setLoaded(false);
      try {
        const tabs = await chrome.tabs.query({ active: true, windowId: workspaceWindowId });
        if (!disposed && activeTabLoadGenerationRef.current === followGeneration) {
          await loadActiveTabMedia(tabs[0]);
        }
      } catch {
        if (!disposed && activeTabLoadGenerationRef.current === followGeneration) {
          await loadActiveTabMedia(undefined);
        }
      }
    };
    const onActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
      if (activeInfo.windowId === workspaceWindowId) void followTabId(activeInfo.tabId);
    };
    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (
        updatedTabId === activeTabIdRef.current && tab.windowId === workspaceWindowId &&
        tab.active && (changeInfo.url !== undefined || changeInfo.status === "loading")
      ) {
        void loadActiveTabMedia(tab);
      }
    };
    const onRemoved = (removedTabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => {
      if (removedTabId === activeTabIdRef.current && removeInfo.windowId === workspaceWindowId) {
        void followCurrentTab();
      }
    };
    const onReplaced = (addedTabId: number, removedTabId: number) => {
      if (removedTabId === activeTabIdRef.current) void followTabId(addedTabId);
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onReplaced.addListener(onReplaced);
    return () => {
      disposed = true;
      activeTabLoadGenerationRef.current += 1;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onReplaced.removeListener(onReplaced);
    };
  }, [surface, workspaceWindowId]);

  useEffect(() => {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== "local") return;
      if (changes[VIDEO_DOWNLOAD_HISTORY_KEY] || changes["license"]) void refreshUsage();
      if (changes["license-notice"]) {
        void getLicenseNotice().then((notice) =>
          setLicenseNotice(notice?.message ?? null),
        );
      }
      if (changes["settings"]) {
        void getSettings().then(setSettingsState);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (
        area !== "session" ||
        !Object.keys(changes).some((key) =>
          key === "capture-runs-v1" || key.startsWith("capture-job-v1:")
          || key.startsWith(CAPTURE_MANIFEST_RECORD_STORAGE_PREFIX)
          || key === QUICK_CAPTURE_START_INTENTS_STORAGE_KEY
        )
      ) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refreshCaptureWorkspace(), 150);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  useEffect(() => {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== "session" || !changes[CAPTURE_DRAFT_STORAGE_KEY]) return;
      void getCaptureDraft().then((result) => {
        if (result.ok) {
          setCaptureDraft(result.draft);
          setCaptureDraftError(null);
        }
      });
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    if (tabId === null || activePageUrl === null) return;
    const key = `tab:${tabId}`;
    const statsKey = `tab:${tabId}:detection-stats-v1`;
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (
        area !== "session" || activeTabIdRef.current !== tabId ||
        (!changes[key] && !changes[statsKey])
      ) return;
      if (changes[key]) {
        const next = changes[key].newValue;
        setVideos(Array.isArray(next) ? (next as DetectedVideo[]) : []);
      }
      const statsLoadGeneration = activeTabLoadGenerationRef.current;
      void getDetectionRetentionStats(tabId).then((stats) => {
        if (!activeTabLoadIsCurrent({
          currentGeneration: activeTabLoadGenerationRef.current,
          loadGeneration: statsLoadGeneration,
          currentTabId: activeTabIdRef.current,
          loadTabId: tabId,
        })) return;
        setDetectionStats(stats);
      }).catch(() => undefined);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [tabId, activePageUrl]);

  useEffect(() => {
    if (
      !captureRunOutcomeUnknown &&
      capturePlan &&
      (!captureDraft ||
        capturePlan.draftId !== captureDraft.draftId ||
        capturePlan.draftRevision !== captureDraft.revision)
    ) {
      setCapturePlan(null);
      setCaptureOptions([]);
      setCaptureChoices([]);
      setSelectedFreeVideoIds([]);
      setCaptureReviewError("The Capture Pack changed. Review the refreshed selection before saving.");
      capturePlanCommandRef.current = null;
      clearCaptureRunIntent();
    }
  }, [captureDraft?.draftId, captureDraft?.revision, capturePlan, captureRunOutcomeUnknown]);

  useEffect(() => {
    setCaptureName(captureDraft?.name ?? "New Capture Pack");
  }, [captureDraft?.draftId, captureDraft?.name]);

  useEffect(() => {
    const inputs: Record<string, string> = {};
    if (captureDraft) {
      for (const itemId of captureDraft.orderedItemIds) {
        const item = captureDraft.items[itemId];
        const pageUrl = normalizedHttpPageUrl(item.media.pageUrl);
        if (pageUrl !== null && !Object.prototype.hasOwnProperty.call(inputs, pageUrl)) {
          inputs[pageUrl] = item.pageFolderLabel ?? "";
        }
      }
    }
    setCapturePageLabelInputs(inputs);
  }, [captureDraft?.draftId, captureDraft?.revision]);

  const version = chrome.runtime.getManifest().version;
  const remaining = Math.max(0, FREE_DOWNLOAD_LIMIT - downloadCount);
  const atLimit = !licensed && remaining === 0;
  const captureRemainingVideoSlots = workspaceQuota?.remaining ?? remaining;
  const unresolvedQuickStartEntries = Object.entries(quickStartOutcomeUnknownByGroup);
  const quickCaptureRecoveryActive =
    quickCaptureReconcilePending || quickCaptureContext !== null || previousStartUnresolved ||
    unresolvedQuickStartEntries.length > 0;
  const anyStartReconciliationActive = quickCaptureRecoveryActive || captureRunOutcomeUnknown;
  const captureBuyingGateResult = useMemo(
    () => capturePlan
      ? createCapturePackBuyingGateModel({
          plan: capturePlan,
          licensed,
          remainingVideoSlots: captureRemainingVideoSlots,
          selectedFreeVideoItemIds: selectedFreeVideoIds,
        })
      : null,
    [capturePlan, licensed, captureRemainingVideoSlots, selectedFreeVideoIds],
  );
  const captureBuyingGate = captureBuyingGateResult?.ok
    ? captureBuyingGateResult.model
    : null;
  const captureReviewHasTemporaryAccess = useMemo(
    () => capturePlan ? captureReviewHasExpiringSourceAccess(capturePlan, captureDraft) : false,
    [capturePlan, captureDraft],
  );
  const captureRunAllocationKey = JSON.stringify([
    capturePlan?.planId ?? null,
    captureDraft?.draftId ?? null,
    captureDraft?.revision ?? null,
    [...selectedFreeVideoIds].sort(),
  ]);

  useEffect(() => {
    const previous = captureRunAllocationKeyRef.current;
    captureRunAllocationKeyRef.current = captureRunAllocationKey;
    if (
      !captureRunOutcomeUnknown && previous !== null && previous !== captureRunAllocationKey
    ) {
      clearCaptureRunIntent();
    }
  }, [captureRunAllocationKey, captureRunOutcomeUnknown]);

  useEffect(() => {
    if (licensed && selectedFreeVideoIds.length > 0) {
      setSelectedFreeVideoIds([]);
    }
  }, [licensed, selectedFreeVideoIds.length]);

  function onUpgrade() {
    if (CHECKOUT_URL.startsWith("http")) {
      window.open(CHECKOUT_URL, "_blank");
    } else {
      window.alert(
        "Checkout link not configured yet. Set CHECKOUT_URL in extension/src/lib/constants.ts to your Stripe checkout URL.",
      );
    }
  }

  function openHutchSidePanel(): void {
    const windowId = workspaceWindowIdRef.current;
    if (windowId === null) {
      setSidePanelOpenError("ClipHutch could not identify this browser window. Reopen the popup and try again.");
      return;
    }
    try {
      // Chrome requires sidePanel.open() to run directly in the user gesture.
      // The cached window ID avoids inserting an async lookup before this call.
      const opening = chrome.sidePanel.open({ windowId });
      void opening.then(
        () => setSidePanelOpenError(null),
        () => setSidePanelOpenError("ClipHutch could not open Hutch in the side panel."),
      );
    } catch {
      setSidePanelOpenError("ClipHutch could not open Hutch in the side panel.");
    }
  }

  function activateWorkspaceView(view: CaptureView): void {
    setCaptureView(view);
    if (view === "review" && !capturePlan && draftItems.length > 0) {
      void requestCaptureReview(captureChoices);
    }
    if (view === "activity") void refreshCaptureWorkspace();
  }

  function onWorkspaceTabKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: CaptureView,
  ): void {
    const next = workspaceRouteForKey(current, event.key);
    if (next === null) return;
    event.preventDefault();
    activateWorkspaceView(next);
    workspaceTabRefs.current[next]?.focus();
  }

  function onShelfTabKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: MediaFilter,
  ): void {
    const next = binaryTabForKey(current, event.key, "videos", "stills");
    if (next === null) return;
    event.preventDefault();
    setMediaFilter(next);
    shelfTabRefs.current[next]?.focus();
  }

  // Only dedicated stream parts associated with a manifest are tucked behind
  // an explicit disclosure. Ordinary files remain visible, and domain filters
  // still apply after the customer chooses whether to show stream parts.
  const manifestPartition = partitionCoveredByManifests(videos);
  const manifestFilteredMedia = showStreamParts ? videos : manifestPartition.visible;
  const visibleMedia = manifestFilteredMedia.filter((v) => !isIgnoredBySettings(v, settings));
  const hiddenByDomainCount = manifestFilteredMedia.length - visibleMedia.length;
  const visibleVideos = visibleMedia.filter((v) => !isStillImage(v));
  const visibleStills = visibleMedia.filter(isStillImage);
  const videoGroups = groupMedia(visibleVideos);
  const stillGroups = groupMedia(visibleStills);
  const activeGroups = mediaFilter === "videos" ? videoGroups : stillGroups;
  const draftItems = captureDraft
    ? captureDraft.orderedItemIds.map((itemId) => captureDraft.items[itemId])
    : [];
  const hutchSourceGroups = groupCaptureDraftBySourcePage(captureDraft);
  const capturePageFolderGroups = (() => {
    const groups = new Map<string, CapturePageFolderGroup>();
    for (const item of draftItems) {
      const pageUrl = normalizedHttpPageUrl(item.media.pageUrl);
      if (pageUrl === null) continue;
      const existing = groups.get(pageUrl);
      if (existing) {
        existing.itemCount += 1;
        continue;
      }
      groups.set(pageUrl, {
        pageUrl,
        pageTitle: item.media.pageTitle,
        pageHost: hostname(pageUrl) ?? pageUrl,
        itemCount: 1,
        label: item.pageFolderLabel ?? null,
      });
    }
    return [...groups.values()];
  })();
  const draftVideoCount = draftItems.filter((item) => item.media.kind !== "image").length;
  const draftStillCount = draftItems.length - draftVideoCount;
  const currentPageDraftCount = activePageUrl === null
    ? 0
    : draftItems.filter((item) => normalizedHttpPageUrl(item.media.pageUrl) === activePageUrl).length;

  function draftItemsForGroup(group: MediaGroup) {
    return draftItems.filter((item) => captureSnapshotBelongsToMediaGroup(item.media, group));
  }

  function bestCopyModelForGroup(group: MediaGroup) {
    const includedItems = draftItemsForGroup(group);
    const quickInteractionSelection = Object.prototype.hasOwnProperty.call(
      quickSelectionByGroup,
      group.groupId,
    )
      ? { candidateId: quickSelectionByGroup[group.groupId] }
      : resolveBestCopyQuickInteractionSelection(
          quickCaptureJobBindingForGroup(group),
          captureJobs,
        );
    return createBestCopyShelfModel({
      group,
      ...(includedItems[0]
        ? { immutableDraftSelection: { candidateId: includedItems[0].media.mediaId } }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(selectedByGroup, group.groupId)
        ? { localSelection: { candidateId: selectedByGroup[group.groupId] } }
        : {}),
      ...(quickInteractionSelection ? { quickInteractionSelection } : {}),
    });
  }

  function selectedForGroup(group: MediaGroup): DetectedVideo {
    // Once included, the background-owned immutable draft is authoritative.
    // A local or Quick interaction choice is never overwritten by live ranking.
    const model = bestCopyModelForGroup(group);
    return group.members.find((item) => item.id === model.selectedId) ?? group.primary;
  }

  function clearCaptureAlternateError(groupId: string): void {
    setCaptureAlternateErrors((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, groupId)) return current;
      const next = { ...current };
      delete next[groupId];
      return next;
    });
  }

  async function selectGroupMedia(group: MediaGroup, mediaId: string): Promise<boolean> {
    const includedItems = draftItemsForGroup(group);
    if (includedItems.length === 0) {
      setSelectedByGroup((current) => ({ ...current, [group.groupId]: mediaId }));
      clearCaptureAlternateError(group.groupId);
      return true;
    }
    if (
      tabId === null || !captureDraft || pendingCaptureGroupId !== null ||
      captureRunPendingRef.current || captureRunOutcomeUnknown
    ) return false;
    if (!claimPendingIntent(captureDraftMutationPendingRef)) return false;

    const displayedMediaId = selectedForGroup(group).id;
    const currentItem = includedItems.find((item) => item.media.mediaId === displayedMediaId) ??
      includedItems[0];
    setPendingCaptureGroupId(group.groupId);
    setPendingCaptureAlternateId(mediaId);
    clearCaptureAlternateError(group.groupId);
    try {
      const result = await replaceCaptureDraftMedia({
        itemId: currentItem.itemId,
        tabId,
        mediaId,
        expectedRevision: captureDraft.revision,
      });
      setSelectedByGroup((current) => {
        if (!Object.prototype.hasOwnProperty.call(current, group.groupId)) return current;
        const next = { ...current };
        delete next[group.groupId];
        return next;
      });
      if (result.ok) {
        setCaptureDraft(result.draft);
        return true;
      }
      if (result.draft) setCaptureDraft(result.draft);
      const message = result.reason === "revision_conflict"
        ? "This Capture Pack changed in another ClipHutch window. The current included copy is shown; choose the alternate again if you still want it."
        : result.reason === "duplicate_page_media"
          ? "That alternate is already included from this page. Remove the duplicate before replacing this copy."
          : result.reason === "media_not_found"
            ? "That alternate is no longer available on this page. Reload or interact with the page and try again."
            : "ClipHutch could not replace this included copy.";
      setCaptureAlternateErrors((current) => ({ ...current, [group.groupId]: message }));
      return false;
    } finally {
      setPendingCaptureAlternateId(null);
      setPendingCaptureGroupId(null);
      clearPendingIntent(captureDraftMutationPendingRef);
    }
  }

  async function setGroupIncluded(group: MediaGroup, include: boolean): Promise<void> {
    if (
      tabId === null || pendingCaptureGroupId !== null || captureRunPendingRef.current ||
      captureRunOutcomeUnknown
    ) return;
    if (
      include &&
      bestCopyShelfSelectionIsUnavailable(bestCopyModelForGroup(group).selectionSource)
    ) {
      setCaptureDraftError(
        "That selected copy is no longer available. Choose an available copy before adding it to the Capture Pack.",
      );
      return;
    }
    if (!claimPendingIntent(captureDraftMutationPendingRef)) return;
    setPendingCaptureGroupId(group.groupId);
    setCaptureDraftError(null);
    try {
      if (include) {
        const result = await addDetectedMediaToCaptureDraft({
          tabId,
          mediaId: selectedForGroup(group).id,
          expectedRevision: captureDraft?.revision ?? 0,
        });
        if (result.ok) {
          setCaptureDraft(result.draft);
        } else {
          if (result.draft !== null) setCaptureDraft(result.draft);
          setCaptureDraftError(
            result.reason === "revision_conflict"
              ? "The Capture Pack changed in another ClipHutch window. Review the updated selection and try again."
              : "ClipHutch could not add this item to the Capture Pack.",
          );
        }
        return;
      }

      let currentDraft = captureDraft;
      for (const item of draftItemsForGroup(group)) {
        if (!currentDraft) break;
        const result = await removeCaptureDraftItem({
          itemId: item.itemId,
          expectedRevision: currentDraft.revision,
        });
        if (!result.ok) {
          if (result.draft !== null) setCaptureDraft(result.draft);
          setCaptureDraftError(
            result.reason === "revision_conflict"
              ? "The Capture Pack changed in another ClipHutch window. Review the updated selection and try again."
              : "ClipHutch could not remove this item from the Capture Pack.",
          );
          return;
        }
        currentDraft = result.draft;
        setCaptureDraft(currentDraft);
      }
    } finally {
      setPendingCaptureGroupId(null);
      clearPendingIntent(captureDraftMutationPendingRef);
    }
  }

  async function addVisibleGroupsToPack(): Promise<void> {
    if (
      tabId === null || pendingCaptureGroupId !== null || captureRunPendingRef.current ||
      captureRunOutcomeUnknown
    ) return;
    if (!claimPendingIntent(captureDraftMutationPendingRef)) return;
    setPendingCaptureGroupId("visible-selection");
    setCaptureDraftError(null);
    let currentDraft = captureDraft;
    try {
      for (const group of activeGroups) {
        const alreadyIncluded = currentDraft?.orderedItemIds.some((itemId) =>
          captureSnapshotBelongsToMediaGroup(currentDraft!.items[itemId].media, group)
        );
        if (alreadyIncluded) continue;
        const bestCopyModel = bestCopyModelForGroup(group);
        if (bestCopyShelfSelectionIsUnavailable(bestCopyModel.selectionSource)) {
          setCaptureDraftError(
            "A selected copy is no longer available on this shelf. Choose an available copy before selecting everything visible.",
          );
          return;
        }
        const result = await addDetectedMediaToCaptureDraft({
          tabId,
          mediaId: bestCopyModel.selectedId,
          expectedRevision: currentDraft?.revision ?? 0,
        });
        if (!result.ok) {
          if (result.draft !== null) setCaptureDraft(result.draft);
          setCaptureDraftError(
            result.reason === "revision_conflict"
              ? "The Capture Pack changed while ClipHutch was selecting this shelf. Review the updated pack and try again."
              : "ClipHutch stopped before every visible item was selected.",
          );
          return;
        }
        currentDraft = result.draft;
        setCaptureDraft(currentDraft);
      }
    } finally {
      setPendingCaptureGroupId(null);
      clearPendingIntent(captureDraftMutationPendingRef);
    }
  }

  async function clearPageFromPack(pageUrl: string, pendingKey: string): Promise<void> {
    const canonicalPageUrl = normalizedHttpPageUrl(pageUrl);
    if (
      canonicalPageUrl === null || pendingCaptureGroupId !== null || !captureDraft ||
      captureRunPendingRef.current || captureRunOutcomeUnknown
    ) return;
    if (!claimPendingIntent(captureDraftMutationPendingRef)) return;
    setPendingCaptureGroupId(pendingKey);
    setCaptureDraftError(null);
    try {
      const result = await removeCaptureDraftPage({
        pageUrl: canonicalPageUrl,
        expectedRevision: captureDraft.revision,
      });
      if (result.ok) {
        setCaptureDraft(result.draft);
      } else {
        if (result.draft !== null) setCaptureDraft(result.draft);
        setCaptureDraftError(
          result.reason === "revision_conflict"
            ? "The Capture Pack changed while ClipHutch was clearing this page. Review the updated pack and try again."
            : "ClipHutch could not clear the items captured from this exact page.",
        );
      }
    } finally {
      setPendingCaptureGroupId(null);
      clearPendingIntent(captureDraftMutationPendingRef);
    }
  }

  async function clearCurrentPageFromPack(): Promise<void> {
    if (activePageUrl === null) return;
    await clearPageFromPack(activePageUrl, "visible-selection");
  }

  async function clearEntireHutch(): Promise<void> {
    if (
      !captureDraft || captureDraft.orderedItemIds.length === 0 ||
      pendingCaptureGroupId !== null || captureRunPendingRef.current ||
      captureRunOutcomeUnknown || quickCaptureRecoveryActive
    ) return;
    const confirmed = window.confirm(
      `Remove all ${captureDraft.orderedItemIds.length} items from Hutch? This clears the current session pack.`,
    );
    if (!confirmed || !claimPendingIntent(captureDraftMutationPendingRef)) return;
    setPendingCaptureGroupId("hutch-all");
    setCaptureDraftError(null);
    setCaptureReviewError(null);
    try {
      const result = await clearCaptureDraft({ expectedRevision: captureDraft.revision });
      if (result.ok) {
        setCaptureDraft(result.draft);
        setCapturePlan(null);
        setCaptureOptions([]);
        setCaptureChoices([]);
        setSelectedFreeVideoIds([]);
        capturePlanCommandRef.current = null;
        clearCaptureRunIntent();
      } else {
        if (result.draft) setCaptureDraft(result.draft);
        setCaptureDraftError(
          result.reason === "revision_conflict"
            ? "Hutch changed in another ClipHutch view. Check the current items and try Clear Hutch again."
            : "ClipHutch could not clear Hutch.",
        );
      }
    } finally {
      setPendingCaptureGroupId(null);
      clearPendingIntent(captureDraftMutationPendingRef);
    }
  }

  async function saveCaptureName(): Promise<void> {
    const name = captureName.trim();
    if (
      !captureDraft || !name || name === captureDraft.name || captureRenamePending ||
      captureRunPendingRef.current || captureRunOutcomeUnknown
    ) return;
    if (!claimPendingIntent(captureRenamePendingRef)) return;
    setCaptureRenamePending(true);
    setCaptureDraftError(null);
    try {
      const result = await renameCaptureDraft({
        name,
        expectedRevision: captureDraft.revision,
      });
      if (result.ok) {
        setCaptureDraft(result.draft);
      } else {
        if (result.draft) setCaptureDraft(result.draft);
        setCaptureDraftError(
          result.reason === "revision_conflict"
            ? "The Capture Pack changed elsewhere. Check its current name and try again."
            : "ClipHutch could not rename this pack.",
        );
      }
    } finally {
      setCaptureRenamePending(false);
      clearPendingIntent(captureRenamePendingRef);
    }
  }

  async function saveCapturePageLabel(
    pageUrl: string,
    explicitLabel?: string | null,
  ): Promise<void> {
    if (
      !captureDraft || capturePageLabelPendingUrl !== null ||
      captureRunPendingRef.current || captureRunOutcomeUnknown
    ) return;
    const canonicalPageUrl = normalizedHttpPageUrl(pageUrl);
    const requestedLabel = explicitLabel === undefined
      ? (capturePageLabelInputs[pageUrl] ?? "")
      : explicitLabel;
    const label = normalizeCapturePageFolderLabel(requestedLabel);
    if (canonicalPageUrl === null || label === undefined) {
      setCaptureReviewError(
        `Folder labels must be ${MAX_CAPTURE_PAGE_FOLDER_LABEL_LENGTH} characters or fewer and cannot contain control or direction-formatting characters.`,
      );
      return;
    }
    if (!claimPendingIntent(captureDraftMutationPendingRef)) return;
    const choicesToRebuild = [...captureChoices];
    const rebuildReview = capturePlan !== null;
    setCapturePageLabelPendingUrl(canonicalPageUrl);
    setCaptureReviewError(null);
    try {
      const result = await labelCaptureDraftPage({
        pageUrl: canonicalPageUrl,
        label,
        expectedRevision: captureDraft.revision,
      });
      if (!result.ok) {
        if (result.draft) setCaptureDraft(result.draft);
        setCaptureReviewError(
          result.reason === "revision_conflict"
            ? "The Capture Pack changed elsewhere. Check the current page labels and try again."
            : "ClipHutch could not update this page folder label.",
        );
        return;
      }

      setCapturePageLabelInputs((current) => ({
        ...current,
        [canonicalPageUrl]: label ?? "",
      }));
      setCaptureDraft(result.draft);
      const reviewNeedsRebuild = Boolean(
        rebuildReview && capturePlan && result.draft &&
        (capturePlan.draftId !== result.draft.draftId ||
          capturePlan.draftRevision !== result.draft.revision),
      );
      if (!result.changed && !reviewNeedsRebuild) return;

      // Folder paths are immutable review output, so a committed label edit
      // immediately invalidates the old plan and rebuilds it against the new
      // draft revision. No prior free-video allocation is carried forward.
      setCapturePlan(null);
      setCaptureOptions([]);
      setCaptureChoices([]);
      setSelectedFreeVideoIds([]);
      capturePlanCommandRef.current = null;
      clearCaptureRunIntent();
      if (rebuildReview && result.draft) {
        const retainedChoices = choicesToRebuild.filter((choice) =>
          Object.prototype.hasOwnProperty.call(result.draft!.items, choice.itemId)
        );
        await requestCaptureReview(retainedChoices, true, result.draft);
      }
    } finally {
      setCapturePageLabelPendingUrl(null);
      clearPendingIntent(captureDraftMutationPendingRef);
    }
  }

  async function setCaptureManifestCsvPreference(enabled: boolean): Promise<void> {
    if (
      !captureDraft || captureManifestCsvPending || capturePageLabelPendingUrl !== null ||
      captureRunPendingRef.current || captureRunOutcomeUnknown
    ) return;
    if (!claimPendingIntent(captureDraftMutationPendingRef)) return;
    const choicesToRebuild = [...captureChoices];
    const rebuildReview = capturePlan !== null;
    setCaptureManifestCsvPending(true);
    setCaptureReviewError(null);
    try {
      const result = await setCaptureDraftManifestCsv({
        enabled,
        expectedRevision: captureDraft.revision,
      });
      if (!result.ok) {
        if (result.draft) setCaptureDraft(result.draft);
        setCaptureReviewError(
          result.reason === "revision_conflict"
            ? "The Capture Pack changed elsewhere. Review its current manifest options and try again."
            : "ClipHutch could not update the optional CSV manifest.",
        );
        return;
      }

      setCaptureDraft(result.draft);
      const reviewedCsv = capturePlan?.manifestSpec?.formats.includes("csv") ?? false;
      const reviewNeedsRebuild = Boolean(
        rebuildReview && capturePlan && result.draft &&
        (capturePlan.draftId !== result.draft.draftId ||
          capturePlan.draftRevision !== result.draft.revision ||
          reviewedCsv !== enabled),
      );
      if (!result.changed && !reviewNeedsRebuild) return;

      // The format list is part of the immutable review. Never start a run
      // with a plan that predates this preference revision.
      setCapturePlan(null);
      setCaptureOptions([]);
      setCaptureChoices([]);
      setSelectedFreeVideoIds([]);
      capturePlanCommandRef.current = null;
      clearCaptureRunIntent();
      if (rebuildReview && result.draft) {
        const retainedChoices = choicesToRebuild.filter((choice) =>
          Object.prototype.hasOwnProperty.call(result.draft!.items, choice.itemId)
        );
        await requestCaptureReview(retainedChoices, true, result.draft);
      }
    } finally {
      setCaptureManifestCsvPending(false);
      clearPendingIntent(captureDraftMutationPendingRef);
    }
  }

  async function requestCaptureReview(
    choices: CapturePlanChoiceSelectorV1[] = captureChoices,
    newIntent = false,
    draftOverride?: CaptureDraftV1,
  ): Promise<void> {
    if (!workspaceBootstrapped) return;
    if (quickCaptureRecoveryActive) {
      setCaptureReviewError(
        "Resolve the previous Quick Capture start in Activity before reviewing or starting a pack.",
      );
      setCaptureView("activity");
      await refreshCaptureWorkspace();
      return;
    }
    const reviewDraft = draftOverride ?? captureDraft;
    if (
      !reviewDraft || reviewDraft.orderedItemIds.length === 0 || captureReviewPending ||
      captureRunPendingRef.current || captureRunOutcomeUnknown
    ) return;
    if (!claimPendingIntent(captureReviewPendingRef)) return;
    if (newIntent) capturePlanCommandRef.current = null;
    setCaptureReviewPending(true);
    setCaptureReviewError(null);
    setCaptureView("review");
    try {
      const result = await createCaptureReviewPlan({
        draftId: reviewDraft.draftId,
        expectedRevision: reviewDraft.revision,
        choices,
        ...(capturePlanCommandRef.current === null
          ? {}
          : { commandId: capturePlanCommandRef.current }),
      });
      if (result.commandId) capturePlanCommandRef.current = result.commandId;
      if (result.ok) {
        const planChanged = capturePlan?.planId !== result.plan.planId;
        setCapturePlan(result.plan);
        setCaptureOptions(result.options);
        setCaptureChoices(choices);
        if (planChanged) {
          // Every immutable review starts with no free videos selected. Stills
          // remain automatically allocated by the buying-gate model.
          setSelectedFreeVideoIds([]);
          clearCaptureRunIntent();
        }
        return;
      }
      if (result.draft) setCaptureDraft(result.draft);
      if (result.reason !== "outcome_unknown") capturePlanCommandRef.current = null;
      const message = result.reason === "outcome_unknown"
        ? "The review response was interrupted. Retry Review pack; ClipHutch will reuse the same command without creating a second plan."
        : result.reason === "revision_conflict"
          ? "The Capture Pack changed while ClipHutch was reviewing it. Check the refreshed selection and try again."
          : result.reason === "variant_choice_stale"
            ? "That stream quality is no longer available. Refresh the review to inspect the latest choices."
            : result.reason === "pack_storage_limit"
              ? "This Hutch is too large for one reliable Capture Pack. Remove some items and review again."
            : result.reason === "plan_replay_unavailable"
              ? "This older review can no longer be reconstructed safely. Refresh the review with a new command."
              : `ClipHutch could not prepare this review (${result.reason}).`;
      setCaptureReviewError(message);
    } finally {
      setCaptureReviewPending(false);
      clearPendingIntent(captureReviewPendingRef);
    }
  }

  async function chooseCaptureVariant(itemId: string, optionId: string): Promise<void> {
    const choices = captureChoices.filter((choice) => choice.itemId !== itemId);
    if (optionId) choices.push({ itemId, optionId });
    await requestCaptureReview(choices, true);
  }

  async function removeCaptureReviewItem(itemId: string): Promise<void> {
    if (
      !captureDraft || pendingCaptureGroupId !== null || captureRunPendingRef.current ||
      captureRunOutcomeUnknown
    ) return;
    if (!claimPendingIntent(captureDraftMutationPendingRef)) return;
    const restoreHutchFocus = captureView === "hutch";
    const hutchFocusTarget = restoreHutchFocus
      ? hutchFocusItemAfterRemoval(captureDraft.orderedItemIds, itemId)
      : null;
    setPendingCaptureGroupId(itemId);
    setCaptureReviewError(null);
    try {
      const result = await removeCaptureDraftItem({
        itemId,
        expectedRevision: captureDraft.revision,
      });
      if (result.ok) {
        if (restoreHutchFocus) {
          pendingHutchFocusRef.current = {
            removedItemId: itemId,
            targetItemId: hutchFocusTarget,
          };
        }
        setCaptureDraft(result.draft);
        setCapturePlan(null);
        setCaptureOptions([]);
        setCaptureChoices([]);
        setSelectedFreeVideoIds([]);
        capturePlanCommandRef.current = null;
        clearCaptureRunIntent();
      } else {
        if (result.draft) setCaptureDraft(result.draft);
        setCaptureReviewError(
          result.reason === "revision_conflict"
            ? "The Capture Pack changed elsewhere. Review the refreshed selection and try again."
            : "ClipHutch could not remove this item from the pack.",
        );
      }
    } finally {
      setPendingCaptureGroupId(null);
      clearPendingIntent(captureDraftMutationPendingRef);
    }
  }

  function toggleFreeVideo(itemId: string): void {
    if (
      !capturePlan || licensed || captureDraftMutationPendingRef.current ||
      captureRunPendingRef.current || captureRunOutcomeUnknown
    ) return;
    const displayedGate = captureBuyingGate;
    const currentlySelected = selectedFreeVideoIds.includes(itemId);
    if (
      !displayedGate ||
      (!currentlySelected &&
        (!displayedGate.readyVideoItemIds.includes(itemId) ||
          displayedGate.selectedFreeVideoCount >= displayedGate.maxSelectableFreeVideoCount))
    ) return;
    setSelectedFreeVideoIds((current) => {
      if (current.includes(itemId)) return current.filter((id) => id !== itemId);
      const currentGate = createCapturePackBuyingGateModel({
        plan: capturePlan,
        licensed: false,
        remainingVideoSlots: captureRemainingVideoSlots,
        selectedFreeVideoItemIds: current,
      });
      if (
        !currentGate.ok ||
        !currentGate.model.readyVideoItemIds.includes(itemId) ||
        currentGate.model.selectedFreeVideoCount >=
          currentGate.model.maxSelectableFreeVideoCount
      ) {
        return current;
      }
      return [...current, itemId];
    });
    clearCaptureRunIntent();
    setCaptureReviewError(null);
  }

  async function enqueueReviewedCapture(): Promise<void> {
    if (!workspaceBootstrapped) return;
    if (quickCaptureRecoveryActive) {
      setCaptureReviewError(
        "Resolve the previous Quick Capture start in Activity before starting this pack.",
      );
      setCaptureView("activity");
      await refreshCaptureWorkspace();
      return;
    }
    if (!capturePlan || captureRunPending || captureDraftMutationPendingRef.current) return;
    const gateResult = createCapturePackBuyingGateModel({
      plan: capturePlan,
      licensed,
      remainingVideoSlots: captureRemainingVideoSlots,
      selectedFreeVideoItemIds: selectedFreeVideoIds,
    });
    if (!gateResult.ok) {
      setCaptureReviewError("This review is no longer valid. Refresh it before saving the pack.");
      if (captureRunOutcomeUnknown) await refreshCaptureWorkspace();
      else clearCaptureRunIntent();
      return;
    }

    const priorIntent = captureRunOutcomeUnknown ? captureRunReconcileRef.current : null;
    const currentFreeVideoItemIds = licensed
      ? []
      : [...gateResult.model.selectedFreeVideoItemIds];
    const priorSelectionGate = priorIntent && !priorIntent.licensed
      ? createCapturePackBuyingGateModel({
          plan: capturePlan,
          licensed: false,
          remainingVideoSlots: captureRemainingVideoSlots,
          selectedFreeVideoItemIds: selectedFreeVideoIds,
        })
      : null;
    const visiblePriorSelection = priorIntent?.licensed
      ? []
      : priorSelectionGate?.ok
        ? [...priorSelectionGate.model.selectedFreeVideoItemIds]
        : [];
    const priorSelectionMatches = priorIntent !== null &&
      (!priorIntent.selectionMustMatch || (
      priorIntent.freeVideoItemIds.length === visiblePriorSelection.length &&
      priorIntent.freeVideoItemIds.every(
        (itemId, index) => itemId === visiblePriorSelection[index],
      )));
    const reconciling = Boolean(
      priorIntent &&
      captureRunCommandRef.current &&
      priorIntent.planId === capturePlan.planId &&
      priorIntent.draftId === capturePlan.draftId &&
      priorIntent.draftRevision === capturePlan.draftRevision &&
      priorSelectionMatches,
    );
    if (captureRunOutcomeUnknown && !reconciling) {
      setCaptureReviewError(
        "The frozen previous start is not available in this view. Refreshing its authoritative reconciliation state…",
      );
      await refreshCaptureWorkspace();
      return;
    }
    if (!reconciling && !gateResult.model.canSubmit) {
      setCaptureReviewError(captureGateError(gateResult.model.blockingReason!));
      return;
    }
    if (!claimPendingIntent(captureRunPendingRef)) return;
    const intent: CaptureRunReconcileIntent = reconciling
      ? priorIntent!
      : {
          planId: capturePlan.planId,
          draftId: capturePlan.draftId,
          draftRevision: capturePlan.draftRevision,
          licensed,
          freeVideoItemIds: currentFreeVideoItemIds,
          selectionMustMatch: true,
        };
    const intentAllocationKey = captureRunAllocationKey;
    captureRunAllocationKeyRef.current = intentAllocationKey;
    setCaptureRunPending(true);
    setCaptureReviewError(null);
    try {
      const result = await enqueueCaptureReviewPlan({
        planId: intent.planId,
        draftId: intent.draftId,
        expectedRevision: intent.draftRevision,
        freeVideoItemIds: intent.freeVideoItemIds,
        ...(captureRunCommandRef.current === null
          ? {}
          : { commandId: captureRunCommandRef.current }),
      });
      if (result.commandId) captureRunCommandRef.current = result.commandId;
      if (result.ok) {
        if (result.disposition === "accepted") {
          clearCaptureRunIntent();
          setCaptureView("activity");
          await refreshCaptureWorkspace();
          return;
        }
        captureRunReconcileRef.current = intent;
        setCaptureRunOutcomeUnknown(true);
        setCaptureReviewError(
          result.disposition === "recovery_needed"
            ? "The pack was accepted, but its queue needs recovery. Reconcile the previous start to retry recovery without creating another run."
            : "The pack was accepted, but ClipHutch could not confirm the committed run state. Reconcile the previous start before doing anything else.",
        );
        await refreshCaptureWorkspace();
        if (!captureRunReconcileRef.current) {
          setCaptureReviewError(null);
          setCaptureView("activity");
        }
        return;
      }
      if (result.reason === "outcome_unknown") {
        if (captureRunAllocationKeyRef.current === intentAllocationKey) {
          captureRunReconcileRef.current = intent;
          setCaptureRunOutcomeUnknown(true);
        } else {
          setCaptureReviewError(
            "The visible pack changed while reconciliation was in flight. Refreshing the frozen previous start…",
          );
          await refreshCaptureWorkspace();
          return;
        }
        setCaptureReviewError(
          "The start response was interrupted. Reconcile the previous start to check the same command before ClipHutch does anything twice.",
        );
        await refreshCaptureWorkspace();
        if (!captureRunReconcileRef.current) {
          setCaptureReviewError(
            "ClipHutch found no unresolved previous start. Review the current pack before starting it again.",
          );
        }
        return;
      }

      if (result.reason === "pack_already_active") {
        clearCaptureRunIntent();
        setCaptureView("activity");
        await refreshCaptureWorkspace();
        return;
      }

      if (reconciling) {
        // Do not discard a frozen historical command merely because this
        // replay failed. Refreshing the journal either restores its exact
        // unresolved context or authoritatively proves none remains.
        await refreshCaptureWorkspace();
        if (captureRunReconcileRef.current) return;
      } else {
        clearCaptureRunIntent();
      }
      setCaptureReviewError(
        result.reason === "allocation_limit"
          ? "Your free allowance changed before the pack started. Review the available video choices and try again."
          : `ClipHutch could not start this pack (${result.reason}).`,
      );
    } finally {
      setCaptureRunPending(false);
      clearPendingIntent(captureRunPendingRef);
    }
  }

  async function cancelReviewedJob(job: CaptureJobV1): Promise<void> {
    if (captureCancelPendingId) return;
    if (!claimPendingIntent(captureCancelPendingRef)) return;
    setCaptureCancelPendingId(job.jobId);
    setCaptureReviewError(null);
    try {
      const result = await cancelCaptureJob({
        jobId: job.jobId,
        attemptId: job.attemptId,
        ...(captureCancelCommandRefs.current[job.jobId]
          ? { commandId: captureCancelCommandRefs.current[job.jobId] }
          : {}),
      });
      if (result.commandId) captureCancelCommandRefs.current[job.jobId] = result.commandId;
      if (result.ok) {
        delete captureCancelCommandRefs.current[job.jobId];
        await refreshCaptureWorkspace();
      } else {
        if (result.reason !== "outcome_unknown") {
          delete captureCancelCommandRefs.current[job.jobId];
        }
        setCaptureReviewError(
          result.reason === "outcome_unknown"
            ? "Cancellation may still be completing. Retry Cancel to reconcile the same request."
            : `ClipHutch could not cancel this item (${result.reason}).`,
        );
      }
    } finally {
      setCaptureCancelPendingId(null);
      clearPendingIntent(captureCancelPendingRef);
    }
  }

  async function retryManifestOutput(
    runId: string,
    format: "json" | "csv",
  ): Promise<void> {
    const key = captureManifestRetryKey(runId, format);
    if (!claimPendingIntent(captureManifestRetryPendingRef)) return;
    setCaptureManifestRetryPendingKey(key);
    setCaptureManifestRetryErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      const result = await retryCaptureManifest({
        runId,
        format,
        ...(captureManifestRetryCommandRefs.current[key]
          ? { commandId: captureManifestRetryCommandRefs.current[key] }
          : {}),
      });
      if (result.commandId) captureManifestRetryCommandRefs.current[key] = result.commandId;
      if (result.ok) {
        // Keep the command until Activity proves the old failed state moved.
        // A response-lost or rapidly failed export can then be reconciled by
        // replaying this exact ID instead of issuing a duplicate save.
        await refreshCaptureWorkspace();
        return;
      }
      if (result.reason !== "outcome_unknown") {
        delete captureManifestRetryCommandRefs.current[key];
      }
      setCaptureManifestRetryErrors((current) => ({
        ...current,
        [key]: result.reason === "outcome_unknown"
          ? "The export response was interrupted. Reconcile this exact export before starting another."
          : captureManifestRetryFailureMessage(result.reason),
      }));
      await refreshCaptureWorkspace();
    } finally {
      setCaptureManifestRetryPendingKey(null);
      clearPendingIntent(captureManifestRetryPendingRef);
    }
  }

  async function reconcileWorkspaceQuickCapture(commandId?: string): Promise<void> {
    const canonicalCommandId = commandId ?? quickCaptureContext?.commandId;
    if (!canonicalCommandId || !claimPendingIntent(quickCaptureReconcilePendingRef)) return;
    setQuickCaptureReconcilePending(true);
    setQuickCaptureReconcileError(null);
    try {
      const result = await reconcileQuickCaptureStart(canonicalCommandId);
      if (!result.ok) {
        setQuickCaptureReconcileError(
          result.customerMessage ?? (
            result.reason === "outcome_unknown"
              ? "ClipHutch could not confirm reconciliation. The original start remains locked; try Reconcile again."
              : result.reason === "invalid_background_response"
                ? "Activity returned an invalid reconciliation result. The original start remains locked."
                : `ClipHutch could not reconcile this Quick Capture (${result.reason}).`
          ),
        );
      }
    } catch (error) {
      setQuickCaptureReconcileError(
        error instanceof Error && error.message
          ? `ClipHutch could not reconcile this Quick Capture: ${error.message}`
          : "ClipHutch could not reconcile this Quick Capture. The original start remains locked.",
      );
    } finally {
      // The response itself is never enough to unlock the UI: a fresh strict
      // workspace snapshot must prove the unresolved context is gone.
      try {
        await refreshCaptureWorkspace();
      } finally {
        setQuickCaptureReconcilePending(false);
        clearPendingIntent(quickCaptureReconcilePendingRef);
      }
    }
  }

  function bindQuickCaptureJob(groupId: string, jobId: string): void {
    setQuickCaptureJobIdsByGroup((current) =>
      current[groupId] === jobId ? current : { ...current, [groupId]: jobId }
    );
  }

  function clearQuickCaptureJobBinding(groupId: string): void {
    setQuickCaptureJobIdsByGroup((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, groupId)) return current;
      const next = { ...current };
      delete next[groupId];
      return next;
    });
  }

  function freezeQuickSelection(groupId: string, mediaId: string): void {
    setQuickSelectionByGroup((current) =>
      current[groupId] === mediaId ? current : { ...current, [groupId]: mediaId }
    );
  }

  function clearQuickSelection(groupId: string): void {
    setQuickSelectionByGroup((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, groupId)) return current;
      const next = { ...current };
      delete next[groupId];
      return next;
    });
  }

  function rememberUnknownQuickStart(
    groupId: string,
    intent: QuickStartOutcomeUnknownIntent,
  ): void {
    quickStartUiRevisionRef.current += 1;
    setQuickStartOutcomeUnknownByGroup((current) => ({ ...current, [groupId]: intent }));
  }

  function clearUnknownQuickStart(groupId: string): void {
    quickStartUiRevisionRef.current += 1;
    setQuickStartOutcomeUnknownByGroup((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, groupId)) return current;
      const next = { ...current };
      delete next[groupId];
      return next;
    });
  }

  function quickCaptureJobBindingForGroup(group: MediaGroup): string | null | undefined {
    const conservativelyRelatedEvictedIds = captureJobs
      .filter((job) =>
        job.itemId.startsWith("capture-single-item:") &&
        captureSnapshotBelongsToMediaGroup(job.snapshot.media, group)
      )
      .map((job) => job.snapshot.media.mediaId);
    return resolveQuickCaptureJobBinding({
      returnedJobId: quickCaptureJobIdsByGroup[group.groupId],
      mediaIds: [
        group.primary.id,
        ...group.alternates.map((item) => item.id),
        ...conservativelyRelatedEvictedIds,
      ],
      jobs: captureJobs,
    });
  }

  async function ignoreSourceHost(host: string) {
    if (hostCoveredByFilters(host, settings.ignoredSourceHosts)) return;
    await setSettings({
      ignoredSourceHosts: [...settings.ignoredSourceHosts, host].sort(),
    });
  }

  async function ignorePageHost(host: string) {
    if (hostCoveredByFilters(host, settings.ignoredPageHosts)) return;
    await setSettings({
      ignoredPageHosts: [...settings.ignoredPageHosts, host].sort(),
    });
  }

  async function clearDomainFilters() {
    await setSettings({ ignoredSourceHosts: [], ignoredPageHosts: [] });
  }

  function renderBody() {
    if (loadError) {
      return <p role="alert" style={errorBoxStyle}>{loadError}</p>;
    }
    if (!workspaceBootstrapped || !loaded) {
      return (
        <p role="status" aria-live="polite" style={{ marginTop: 8, color: "#888" }}>Loading workspace and detected media…</p>
      );
    }
    if (tabId === null) {
      return (
        <p style={{ margin: "12px 0", color: "#536156", fontSize: 11 }}>
          {surface === "sidepanel"
            ? "No active tab is available in this window. Select a regular browser tab; Hutch remains available."
            : "No active tab. Open this popup from a regular browser tab."}
        </p>
      );
    }
    if (activePageUrl === null) {
      return (
        <p role="status" style={{ margin: "12px 0", color: "#536156", fontSize: 11 }}>
          This browser page does not allow ClipHutch detection. Open a regular HTTP or HTTPS page;
          items already saved in Hutch remain available.
        </p>
      );
    }
    if (activeGroups.length === 0) {
      if (mediaFilter === "stills") {
        return (
          <p style={{ margin: "10px 0", color: "#536156", fontSize: 10.5, lineHeight: 1.35 }}>
            Nothing on this shelf yet. Tiny page assets under {fmtBytes(MIN_STILL_IMAGE_SIZE_BYTES)} are tucked away.
          </p>
        );
      }
      return <Empty />;
    }
    const cards = activeGroups.map((group) => {
      const boundQuickCaptureJobId = quickCaptureJobBindingForGroup(group);
      const includedItems = draftItemsForGroup(group);
      const bestCopyModel = bestCopyModelForGroup(group);
      return (
        <VideoCard
          key={group.groupId}
          groupId={group.groupId}
          v={group.primary}
          alternates={group.alternates}
          selectedId={bestCopyModel.selectedId}
          selectionSource={bestCopyModel.selectionSource}
          recommendation={bestCopyModel.recommendation}
          included={includedItems.length > 0}
          inclusionPending={pendingCaptureGroupId === group.groupId}
          alternatePendingId={
            pendingCaptureGroupId === group.groupId ? pendingCaptureAlternateId : null
          }
          alternateError={captureAlternateErrors[group.groupId]}
          tabId={tabId}
          settings={settings}
          videoLimitReached={atLimit}
          captureJobs={captureJobs}
          captureWorkspaceError={captureWorkspaceError}
          captureCancelPendingId={captureCancelPendingId}
          acceptedCaptureJobId={boundQuickCaptureJobId}
          unresolvedQuickStart={quickStartOutcomeUnknownByGroup[group.groupId]}
          quickCaptureStartBlocked={
            captureRunOutcomeUnknown || quickCaptureContext !== null || previousStartUnresolved ||
            unresolvedQuickStartEntries.some(([otherGroupId]) => otherGroupId !== group.groupId)
          }
          quickCaptureReconcilePending={quickCaptureReconcilePending}
          deferPreview={surface === "sidepanel"}
          onSelect={(id) => selectGroupMedia(group, id)}
          onIncludedChange={(included) => void setGroupIncluded(group, included)}
          onIgnoreSource={(host) => void ignoreSourceHost(host)}
          onIgnorePage={(host) => void ignorePageHost(host)}
          onCaptureAccepted={(jobId) => {
            bindQuickCaptureJob(group.groupId, jobId);
            void refreshCaptureWorkspace();
          }}
          onClearCaptureBinding={() => {
            clearQuickCaptureJobBinding(group.groupId);
            clearQuickSelection(group.groupId);
          }}
          onFreezeQuickSelection={(mediaId) => freezeQuickSelection(group.groupId, mediaId)}
          onReleaseQuickSelection={() => clearQuickSelection(group.groupId)}
          onQuickStartOutcomeUnknown={(intent) => rememberUnknownQuickStart(group.groupId, intent)}
          onClearQuickStartOutcomeUnknown={() => clearUnknownQuickStart(group.groupId)}
          onPreviousStartUnresolved={() => {
            quickStartUiRevisionRef.current += 1;
            setPreviousStartUnresolved(true);
            void refreshCaptureWorkspace();
          }}
          onReconcileQuickStart={(commandId) => {
            void reconcileWorkspaceQuickCapture(commandId);
          }}
          onCancelCaptureJob={cancelReviewedJob}
          onViewHutch={() => setCaptureView("hutch")}
          onViewActivity={() => {
            setCaptureView("activity");
            void refreshCaptureWorkspace();
          }}
        />
      );
    });
    return surface === "sidepanel" ? (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))",
          gap: 10,
          alignItems: "start",
        }}
      >
        {cards}
      </div>
    ) : cards;
  }

  function renderHutch() {
    const hutchBusy = !workspaceBootstrapped || pendingCaptureGroupId !== null || captureRenamePending ||
      captureManifestCsvPending ||
      capturePageLabelPendingUrl !== null || captureReviewPending || captureRunPending ||
      captureRunOutcomeUnknown;
    return (
      <section aria-label="Hutch" style={{ marginTop: 10 }}>
        <div style={{ ...noteBoxStyle, marginTop: 0 }}>
          <h2
            ref={hutchHeadingRef}
            tabIndex={-1}
            style={{ font: "inherit", fontWeight: 700, margin: 0, outlineOffset: 3 }}
          >
            Hutch · {draftItems.length} item{draftItems.length === 1 ? "" : "s"}
          </h2>
          <div style={{ marginTop: 3 }}>
            Selected items stay here if you navigate or close their source tabs. Hutch is session-only and clears on browser restart, extension update, or Clear Hutch.
          </div>
          {draftItems.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
              <button
                type="button"
                disabled={!workspaceBootstrapped || captureReviewPending || anyStartReconciliationActive}
                onClick={() => void requestCaptureReview(captureChoices)}
                style={!workspaceBootstrapped || captureReviewPending || anyStartReconciliationActive
                  ? disabledButtonStyle
                  : primaryButtonStyle}
              >
                {captureReviewPending ? "Reviewing…" : `Review pack (${draftItems.length})`}
              </button>
              <button
                type="button"
                disabled={hutchBusy || quickCaptureRecoveryActive}
                onClick={() => void clearEntireHutch()}
                style={hutchBusy || quickCaptureRecoveryActive ? disabledButtonStyle : buttonStyle}
              >
                {pendingCaptureGroupId === "hutch-all" ? "Clearing Hutch…" : "Clear Hutch"}
              </button>
            </div>
          ) : null}
        </div>
        {draftItems.length === 0 ? (
          <p style={{ color: "#536156", fontSize: 11 }}>
            Hutch is empty. Add videos or stills from This Page to keep them across tab changes for this browsing session.
          </p>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))",
              gap: 8,
              alignItems: "start",
            }}
          >
            {hutchSourceGroups.map((group) => {
              const descriptor = group.pageTitle?.trim() || group.pageHost;
              const pendingKey = `hutch-page:${group.key}`;
              const displayedPageUrl = settings.showFullUrlsByDefault && group.pageUrl
                ? group.pageUrl
                : sourcePageDisplayUrl(group.pageUrl);
              return (
                <article
                  key={group.key}
                  style={{ ...noteBoxStyle, marginTop: 0, background: "#fff", minWidth: 0 }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ overflowWrap: "anywhere" }}>{descriptor}</strong>
                    <span style={{ whiteSpace: "nowrap" }}>
                      {group.itemIds.length} item{group.itemIds.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div
                    title={settings.showFullUrlsByDefault ? group.pageUrl ?? undefined : undefined}
                    style={{
                      color: "#667269",
                      fontSize: 9.5,
                      marginTop: 3,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {displayedPageUrl}
                  </div>
                  <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
                    {group.itemIds.map((itemId) => {
                      const item = captureDraft?.items[itemId];
                      if (!item) return null;
                      const name = hutchItemLabel(item.media);
                      return (
                        <li key={itemId} style={{ borderTop: "1px solid #e1ebe3", padding: "6px 0" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{name}</span>
                            <span style={{ textTransform: "uppercase", fontSize: 9.5 }}>
                              {item.media.kind}
                            </span>
                          </div>
                          <button
                            ref={(element) => {
                              if (element) hutchRemoveButtonRefs.current.set(itemId, element);
                              else hutchRemoveButtonRefs.current.delete(itemId);
                            }}
                            type="button"
                            disabled={hutchBusy}
                            onClick={() => void removeCaptureReviewItem(itemId)}
                            aria-label={`Remove ${name} from Hutch`}
                            style={{ ...buttonStyle, padding: "2px 6px", fontSize: 10, marginTop: 4 }}
                          >
                            {pendingCaptureGroupId === itemId ? "Removing…" : "Remove"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {group.pageUrl ? (
                    <button
                      type="button"
                      disabled={hutchBusy}
                      onClick={() => void clearPageFromPack(group.pageUrl!, pendingKey)}
                      aria-label={`Clear all Hutch items from ${descriptor}`}
                      style={{ ...buttonStyle, marginTop: 5 }}
                    >
                      {pendingCaptureGroupId === pendingKey ? "Clearing page…" : "Clear page"}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  function renderCaptureReview() {
    if (captureReviewPending && !capturePlan) {
      return <p role="status" aria-live="polite" style={noteBoxStyle}>Inspecting selected media and stream qualities…</p>;
    }
    if (!capturePlan) {
      return (
        <section aria-label="Capture Pack review" style={{ marginTop: 10 }}>
          <p style={{ color: "#536156", fontSize: 11 }}>
            {draftItems.length === 0
              ? "Select at least one video or still before reviewing a pack."
              : "Create a fresh review to verify every item, quality, path, and quota effect before saving."}
          </p>
          <button
            type="button"
            disabled={draftItems.length === 0 || captureReviewPending || quickCaptureRecoveryActive}
            onClick={() => void requestCaptureReview([], true)}
            style={draftItems.length === 0 || captureReviewPending || quickCaptureRecoveryActive ? disabledButtonStyle : primaryButtonStyle}
          >
            {captureReviewPending ? "Reviewing…" : "Refresh review"}
          </button>
        </section>
      );
    }

    if (!captureBuyingGate) {
      return (
        <section aria-label="Capture Pack review" style={{ marginTop: 10 }}>
          <div role="alert" style={errorBoxStyle}>
            This review could not be validated. Refresh it before choosing an allocation.
          </div>
          <button
            type="button"
            disabled={captureReviewPending || quickCaptureRecoveryActive}
            onClick={() => void requestCaptureReview(captureChoices, true)}
            style={{ ...(captureReviewPending || quickCaptureRecoveryActive ? disabledButtonStyle : primaryButtonStyle), marginTop: 7 }}
          >
            {captureReviewPending ? "Reviewing…" : "Refresh review"}
          </button>
        </section>
      );
    }
    const gate = captureBuyingGate;
    const isNormalCapturePack = !capturePlan.planId.startsWith("capture-single-plan:");
    const hasRequiredManifest = Boolean(
      capturePlan.manifestSpec?.formats[0] === "json",
    );
    const submitDisabled = captureReviewPending || captureRunPending ||
      capturePageLabelPendingUrl !== null || quickCaptureRecoveryActive ||
      captureManifestCsvPending || (isNormalCapturePack && !hasRequiredManifest) ||
      (!captureRunOutcomeUnknown && !gate.canSubmit);

    return (
      <section aria-label="Capture Pack review" style={{ marginTop: 10 }}>
        {quickCaptureRecoveryActive ? (
          <div role="alert" style={errorBoxStyle}>
            Resolve the previous Quick Capture start in Activity before reviewing or starting this pack.
          </div>
        ) : null}
        <div style={{ ...noteBoxStyle, marginTop: 0 }}>
          <strong>{gate.includedCount} media item{gate.includedCount === 1 ? "" : "s"} in this review</strong>
          <div style={{ marginTop: 2 }}>
            {gate.videoCount} video{gate.videoCount === 1 ? "" : "s"} · {gate.stillCount} still{gate.stillCount === 1 ? "" : "s"}
            {capturePlan.totals.estimatedBytes === undefined
              ? ` · ${capturePlan.totals.unknownSizeCount} size${capturePlan.totals.unknownSizeCount === 1 ? "" : "s"} unknown`
              : ` · ${fmtBytes(capturePlan.totals.estimatedBytes)}`}
            {gate.unreadyCount > 0 ? ` · ${gate.unreadyCount} need${gate.unreadyCount === 1 ? "s" : ""} attention` : ""}
          </div>
          <div style={{ marginTop: 2 }}>Folder: <code>{capturePlan.relativeRoot}/</code></div>
        </div>

        {isNormalCapturePack && capturePlan.manifestSpec ? (
          <fieldset
            style={{
              border: "1px solid #c8d8cc",
              borderRadius: 7,
              background: "#fff",
              margin: "8px 0 0",
              padding: "7px 8px",
              minWidth: 0,
            }}
          >
            <legend style={{ fontSize: 11, fontWeight: 700, padding: "0 3px" }}>
              Source manifest
            </legend>
            <div id="capture-manifest-disclosure" style={{ color: "#536156", fontSize: 10.5 }}>
              Required JSON source manifest (requested name: <code>_cliphutch-manifest.json</code>),
              saved after the media files finish. Chrome may add a collision suffix. It records
              planned paths, final basenames, item outcomes, timestamps, redacted source pages, and
              source hosts. It excludes media URLs, URL credentials/query/fragment, captured request
              headers, license data, and absolute local paths.
            </div>
            <label style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 7, fontSize: 10.5 }}>
              <input
                type="checkbox"
                checked={capturePlan.manifestSpec.formats.includes("csv")}
                disabled={
                  captureManifestCsvPending || captureReviewPending || captureRunPending ||
                  capturePageLabelPendingUrl !== null || captureRunOutcomeUnknown
                }
                aria-describedby="capture-manifest-disclosure"
                onChange={(event) => void setCaptureManifestCsvPreference(event.currentTarget.checked)}
              />
              <span>
                {captureManifestCsvPending ? "Updating CSV option…" : "Also save a CSV manifest"}
              </span>
            </label>
          </fieldset>
        ) : isNormalCapturePack ? (
          <div role="alert" style={{ ...errorBoxStyle, marginTop: 8 }}>
            This older review does not include the required JSON source manifest. Refresh the review
            before saving this pack.
          </div>
        ) : null}

        {captureReviewHasTemporaryAccess ? (
          <div role="note" style={{ ...noteBoxStyle, background: "#fffaf0", color: "#60491f" }}>
            You may close the source tabs. Temporary access for selected items expires after 60 minutes; an expired item will ask you to reopen its page and add it again.
          </div>
        ) : null}

        {capturePageFolderGroups.length > 0 ? (
          <div aria-label="Source page folder labels" style={{ marginTop: 8 }}>
            <strong style={{ fontSize: 11 }}>Page folders</strong>
            <div style={{ color: "#59675c", fontSize: 10, marginTop: 2 }}>
              Set an optional label for each source page. Saving or resetting a label rebuilds the reviewed paths.
            </div>
            {capturePageFolderGroups.map((group, index) => {
              const input = capturePageLabelInputs[group.pageUrl] ?? group.label ?? "";
              const normalizedInput = normalizeCapturePageFolderLabel(input);
              const changed = normalizedInput !== undefined && normalizedInput !== group.label;
              const pending = capturePageLabelPendingUrl === group.pageUrl;
              const descriptor = group.pageTitle?.trim() || group.pageHost;
              const displayedPageUrl = settings.showFullUrlsByDefault
                ? group.pageUrl
                : sourcePageDisplayUrl(group.pageUrl);
              const inputId = `capture-page-folder-${index}`;
              return (
                <fieldset
                  key={group.pageUrl}
                  style={{
                    border: "1px solid #c8d8cc",
                    borderRadius: 7,
                    background: "#fff",
                    margin: "6px 0 0",
                    padding: "7px 8px",
                    minWidth: 0,
                  }}
                >
                  <legend style={{ fontSize: 10.5, fontWeight: 600, padding: "0 3px" }}>
                    {descriptor} · {group.itemCount} item{group.itemCount === 1 ? "" : "s"}
                  </legend>
                  <label htmlFor={inputId} style={{ display: "block", fontSize: 10.5 }}>
                    Folder label for {group.pageHost}
                  </label>
                  <input
                    id={inputId}
                    value={input}
                    maxLength={MAX_CAPTURE_PAGE_FOLDER_LABEL_LENGTH}
                    disabled={
                      capturePageLabelPendingUrl !== null || captureRunPending ||
                      captureRunOutcomeUnknown
                    }
                    aria-describedby={`${inputId}-source`}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setCapturePageLabelInputs((current) => ({
                        ...current,
                        [group.pageUrl]: value,
                      }));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && changed) {
                        event.preventDefault();
                        void saveCapturePageLabel(group.pageUrl);
                      }
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      boxSizing: "border-box",
                      marginTop: 3,
                      padding: 4,
                      fontSize: 11,
                    }}
                  />
                  {normalizedInput === undefined ? (
                    <div role="alert" style={{ color: "#7a1f1a", fontSize: 9.5, marginTop: 3 }}>
                      Remove control or direction-formatting characters from this label.
                    </div>
                  ) : null}
                  <div
                    id={`${inputId}-source`}
                    title={settings.showFullUrlsByDefault ? group.pageUrl : undefined}
                    style={{
                      color: "#667269",
                      fontSize: 9.5,
                      marginTop: 3,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {displayedPageUrl}
                  </div>
                  <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                    <button
                      type="button"
                      disabled={
                        !changed || pending || capturePageLabelPendingUrl !== null ||
                        captureRunPending || captureRunOutcomeUnknown || normalizedInput === undefined
                      }
                      onClick={() => void saveCapturePageLabel(group.pageUrl)}
                      aria-label={`Save folder label for ${descriptor}`}
                      style={
                        !changed || pending || capturePageLabelPendingUrl !== null ||
                        captureRunPending || captureRunOutcomeUnknown || normalizedInput === undefined
                          ? disabledButtonStyle
                          : buttonStyle
                      }
                    >
                      {pending ? "Saving…" : "Save label"}
                    </button>
                    <button
                      type="button"
                      disabled={
                        pending || capturePageLabelPendingUrl !== null || captureRunPending ||
                        captureRunOutcomeUnknown || (group.label === null && input.length === 0)
                      }
                      onClick={() => void saveCapturePageLabel(group.pageUrl, null)}
                      aria-label={`Reset folder label for ${descriptor}`}
                      style={
                        pending || capturePageLabelPendingUrl !== null || captureRunPending ||
                        captureRunOutcomeUnknown || (group.label === null && input.length === 0)
                          ? disabledButtonStyle
                          : buttonStyle
                      }
                    >
                      Reset
                    </button>
                  </div>
                </fieldset>
              );
            })}
          </div>
        ) : null}

        <ol style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
          {capturePlan.items.map((item) => {
            const itemOptions = captureOptions.filter((option) => option.itemId === item.itemId);
            const selectedOptionId = captureChoices.find((choice) => choice.itemId === item.itemId)?.optionId ??
              itemOptions.find((option) => option.selectedByPolicy)?.optionId ??
              (item.readiness === "ready" && itemOptions.length === 1 && itemOptions[0].supported
                ? itemOptions[0].optionId
                : "");
            const basename = item.plannedRelativePath.split("/").pop() ?? item.plannedRelativePath;
            const directWebm = item.media.kind === "direct" && (
              item.media.contentType?.split(";")[0].trim().toLowerCase() === "video/webm" ||
              (() => {
                try { return new URL(item.media.url).pathname.toLowerCase().endsWith(".webm"); }
                catch { return false; }
              })()
            );
            const plannedSizeCopy = item.readiness === "ready" && item.qualityChoice.mode === "stream"
              ? captureStreamSizeCopy(
                  item.qualityChoice.estimatedBytes,
                  item.qualityChoice.estimateConfidence,
                )
              : directWebm
                ? "size unknown"
                : item.media.sizeBytes === undefined
                  ? "size unknown"
                  : fmtBytes(item.media.sizeBytes) ?? "size unknown";
            const isFreeVideoChoice = !gate.licensed && gate.readyVideoItemIds.includes(item.itemId);
            const isSelectedFreeVideo = gate.selectedFreeVideoItemIds.includes(item.itemId);
            const copyChoiceUi = createCaptureCopyChoiceReviewPresentation(item.copyChoice);
            return (
              <li
                key={item.itemId}
                style={{
                  padding: "8px",
                  marginBottom: 7,
                  border: item.readiness === "ready" ? "1px solid #c8d8cc" : "1px solid #e1ba78",
                  borderRadius: 7,
                  background: "#fff",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <strong style={{ overflowWrap: "anywhere" }}>{basename}</strong>
                  <span style={{ color: item.readiness === "ready" ? "#2f5f3a" : "#8a5b17", fontSize: 10, textTransform: "uppercase" }}>
                    {item.readiness === "ready" ? item.media.kind : item.readiness.replace("_", " ")}
                  </span>
                </div>
                <div style={{ color: "#59675c", fontSize: 10.5, marginTop: 3, overflowWrap: "anywhere" }}>
                  <code>{item.plannedRelativePath}</code>
                  {` · ${plannedSizeCopy}`}
                </div>
                <div
                  role="note"
                  aria-label={`Copy choice for ${basename}`}
                  style={{
                    marginTop: 5,
                    padding: "5px 6px",
                    borderRadius: 5,
                    border: "1px solid #c8d8cc",
                    background: "#f4f9f5",
                    color: "#31553d",
                    fontSize: 10.5,
                  }}
                >
                  <strong>
                    {copyChoiceUi.label}
                  </strong>
                  <div style={{ marginTop: 2 }}>{copyChoiceUi.reason}</div>
                </div>
                {(item.media.kind === "hls" || item.media.kind === "dash") && itemOptions.length > 0 ? (
                  <label style={{ display: "block", marginTop: 6, fontSize: 10.5 }}>
                    Quality
                    <select
                      value={selectedOptionId}
                      disabled={
                        captureReviewPending || capturePageLabelPendingUrl !== null ||
                        captureRunOutcomeUnknown
                      }
                      aria-label={`Quality for ${basename}`}
                      onChange={(event) => void chooseCaptureVariant(item.itemId, event.currentTarget.value)}
                      style={{ display: "block", width: "100%", marginTop: 3, fontSize: 11, padding: 4 }}
                    >
                      <option value="">Choose a quality…</option>
                      {itemOptions.map((option) => (
                        <option
                          key={option.optionId}
                          value={option.optionId}
                          disabled={!option.supported}
                        >
                          {captureVariantOptionCopy(option)}
                        </option>
                      ))}
                    </select>
                    {item.readiness === "ready" && item.qualityChoice.mode === "stream" ? (
                      <span style={{ display: "block", color: "#59675c", marginTop: 3 }}>
                        {item.qualityChoice.policy.mode === "best_under_cap"
                          ? `Automatic: best supported quality at or below 90% of ${fmtBytes(item.qualityChoice.maxDownloadBytes) ?? "the saved cap"}${item.qualityChoice.policy.maxHeight === undefined ? "" : ` and at most ${item.qualityChoice.policy.maxHeight}p`}. The full saved cap remains a hard runtime limit. Rechecked before download.`
                          : "Manual choice. ClipHutch rechecks that exact quality before download."}
                      </span>
                    ) : null}
                  </label>
                ) : null}
                {isFreeVideoChoice ? (
                  <label style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 7, fontSize: 10.5 }}>
                    <input
                      type="checkbox"
                      checked={isSelectedFreeVideo}
                      disabled={
                        captureRunPending || capturePageLabelPendingUrl !== null ||
                        captureRunOutcomeUnknown ||
                        (!isSelectedFreeVideo &&
                          gate.selectedFreeVideoCount >= gate.maxSelectableFreeVideoCount)
                      }
                      onChange={() => toggleFreeVideo(item.itemId)}
                      aria-label={`Use one free video slot for ${basename}`}
                    />
                    Use one free video slot for this item
                  </label>
                ) : null}
                {item.warnings.map((warning) => (
                  <div key={`${warning.code}:${warning.message}`} role="note" style={{ color: "#7a4d14", fontSize: 10.5, marginTop: 5 }}>
                    {warning.message}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => void removeCaptureReviewItem(item.itemId)}
                  disabled={
                    pendingCaptureGroupId !== null || capturePageLabelPendingUrl !== null ||
                    captureRunOutcomeUnknown
                  }
                  aria-label={`Remove ${basename} from Capture Pack`}
                  style={{ ...buttonStyle, marginTop: 6, padding: "3px 7px", fontSize: 10 }}
                >
                  Remove from pack
                </button>
              </li>
            );
          })}
        </ol>

        {gate.needsUpgradeGate ? (
          <div style={{ ...noteBoxStyle, background: "#fffaf0", borderColor: "#d7c8a7", color: "#60491f" }}>
            <strong>The complete pack is visible.</strong>
            <div style={{ marginTop: 3 }}>
              This review has {gate.videoCount} video{gate.videoCount === 1 ? "" : "s"} and {gate.stillCount} still{gate.stillCount === 1 ? "" : "s"}. You can save all {gate.stillCount} still{gate.stillCount === 1 ? "" : "s"} and up to {gate.maxSelectableFreeVideoCount} selected ready video{gate.maxSelectableFreeVideoCount === 1 ? "" : "s"} free now. A ${PRICE_USD} one-time license unlocks all {gate.videoCount} videos once every item is ready.
            </div>
            <button type="button" onClick={onUpgrade} style={{ ...primaryButtonStyle, marginTop: 7 }}>
              Unlock complete pack · ${PRICE_USD}
            </button>
          </div>
        ) : null}
        {!gate.licensed && gate.videoCount > 0 ? (
          <div role="status" aria-live="polite" style={{ color: "#536156", fontSize: 10.5, marginTop: 7 }}>
            {gate.selectedFreeVideoCount}/{gate.maxSelectableFreeVideoCount} free video slots selected; stills never use a video slot.
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          <button
            type="button"
            disabled={submitDisabled}
            onClick={() => void enqueueReviewedCapture()}
            style={submitDisabled ? disabledButtonStyle : primaryButtonStyle}
          >
            {captureRunPending
              ? captureRunOutcomeUnknown ? "Reconciling previous start…" : "Starting pack…"
              : captureRunOutcomeUnknown
                ? "Reconcile previous start"
                : gate.isCompleteAllocation
                  ? `Save complete pack (${gate.saveItemCount} media)`
                  : `Save free pack (${gate.saveItemCount} media)`}
          </button>
          <button
            type="button"
            disabled={
              captureReviewPending || capturePageLabelPendingUrl !== null ||
              captureRunOutcomeUnknown || quickCaptureRecoveryActive
            }
            onClick={() => void requestCaptureReview(captureChoices, true)}
            style={
              captureReviewPending || capturePageLabelPendingUrl !== null || captureRunOutcomeUnknown ||
              quickCaptureRecoveryActive
                ? disabledButtonStyle
                : buttonStyle
            }
          >
            Refresh review
          </button>
        </div>
      </section>
    );
  }

  function renderCaptureActivity() {
    const jobsByRun = new Map<string, CaptureJobV1[]>();
    for (const job of captureJobs) {
      const list = jobsByRun.get(job.runId) ?? [];
      list.push(job);
      jobsByRun.set(job.runId, list);
    }
    const manifestsByRun = new Map(captureManifests.map((manifest) => [manifest.runId, manifest]));
    const fallbackQuickIntent = [...unresolvedQuickStartEntries]
      .sort(([left], [right]) => left.localeCompare(right))[0]?.[1];
    const quickRecoveryCommandId = quickCaptureContext?.commandId ??
      fallbackQuickIntent?.commandId;
    const hasQuickRecovery = Boolean(
      quickCaptureReconcilePending || quickCaptureContext || fallbackQuickIntent ||
      previousStartUnresolved,
    );
    const quickRecoveryJob = quickCaptureContext?.jobId
      ? captureJobs.find((job) => job.jobId === quickCaptureContext.jobId)
      : undefined;
    const quickRecoveryCopy = quickCaptureReconcilePending && !quickCaptureContext && !fallbackQuickIntent
      ? "ClipHutch is checking the original Quick Capture command against authoritative Activity state."
      : quickCaptureContext?.reconciliationState === "commit_state_unknown"
      ? "ClipHutch could not confirm whether this Quick Capture reached the queue. Reconcile the original command before starting another."
      : quickCaptureContext?.reconciliationState === "recovery_needed"
        ? "This Quick Capture was accepted, but its queue record needs recovery. Reconcile the original command."
        : "This Quick Capture start is not confirmed yet. Reconcile the original command before starting another.";
    const cancellable = new Set(["prepared", "queued", "starting", "running", "processing", "delivery_pending", "saving", "cancelling"]);
    return (
      <section aria-label="Capture activity" style={{ marginTop: 10 }}>
        {captureWorkspaceError ? (
          <>
            <div role="alert" style={errorBoxStyle}>{captureWorkspaceError}</div>
            <button
              type="button"
              onClick={() => void refreshCaptureWorkspace()}
              style={{ ...buttonStyle, marginTop: 7, marginBottom: 8 }}
            >
              Retry Activity
            </button>
          </>
        ) : null}
        {hasQuickRecovery ? (
          <article style={{ ...noteBoxStyle, marginTop: 0, marginBottom: 8, background: "#fffaf0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong>Quick Capture</strong>
              <span>Needs reconciliation</span>
            </div>
            <div style={{ marginTop: 5 }}>{quickRecoveryCopy}</div>
            {quickRecoveryJob ? (
              <div role="status" aria-live="polite" style={{ marginTop: 5 }}>
                {quickRecoveryJob.state.replaceAll("_", " ")}
                {quickRecoveryJob.progress?.ratio === undefined
                  ? null
                  : ` · ${Math.round(quickRecoveryJob.progress.ratio * 100)}%`}
              </div>
            ) : null}
            {quickCaptureReconcileError ? (
              <div role="alert" style={{ ...errorBoxStyle, marginTop: 6 }}>
                {quickCaptureReconcileError}
              </div>
            ) : null}
            {quickRecoveryCommandId ? (
              <button
                type="button"
                disabled={quickCaptureReconcilePending}
                onClick={() => void reconcileWorkspaceQuickCapture(quickRecoveryCommandId)}
                style={{ ...(quickCaptureReconcilePending ? disabledButtonStyle : primaryButtonStyle), marginTop: 7 }}
              >
                {quickCaptureReconcilePending ? "Reconciling…" : "Reconcile start"}
              </button>
            ) : (
              <div role="status" style={{ marginTop: 5 }}>
                {quickCaptureReconcilePending
                  ? "Reconciling the previous start…"
                  : "Refresh Activity to load the authoritative reconciliation command."}
              </div>
            )}
          </article>
        ) : null}
        {!hasQuickRecovery && captureRuns.length === 0 ? (
          <p style={{ color: "#536156", fontSize: 11, marginTop: 10 }}>
            No Capture activity in this browsing session yet.
          </p>
        ) : null}
        {captureRuns.map((run) => (
          <article key={run.runId} style={{ ...noteBoxStyle, marginTop: 0, marginBottom: 8, background: "#fff" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong>{run.planId.startsWith("capture-single-plan:") ? "Quick Capture" : "Capture Pack"}</strong>
              <span style={{ textTransform: "capitalize" }}>
                {capturePackActivityStatus(run.status, manifestsByRun.get(run.runId))}
              </span>
            </div>
            <ul style={{ listStyle: "none", margin: "7px 0 0", padding: 0 }}>
              {(jobsByRun.get(run.runId) ?? []).map((job) => {
                const name = job.snapshot.plannedRelativePath.split("/").pop() ?? job.itemId;
                const progress = job.progress?.ratio === undefined
                  ? undefined
                  : `${Math.round(job.progress.ratio * 100)}%`;
                return (
                  <li key={job.jobId} style={{ borderTop: "1px solid #e1ebe3", padding: "6px 0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ overflowWrap: "anywhere" }}>{name}</span>
                      <span style={{ whiteSpace: "nowrap", textTransform: "capitalize" }}>{progress ?? job.state.replace("_", " ")}</span>
                    </div>
                    {job.error ? <div role="alert" style={{ color: "#7a1f1a", marginTop: 3 }}>{job.error.customerMessage}</div> : null}
                    {cancellable.has(job.state) ? (
                      <button
                        type="button"
                        disabled={captureCancelPendingId !== null || job.state === "cancelling"}
                        onClick={() => void cancelReviewedJob(job)}
                        style={{ ...buttonStyle, padding: "2px 6px", fontSize: 10, marginTop: 4 }}
                      >
                        {captureCancelPendingId === job.jobId || job.state === "cancelling" ? "Cancelling…" : "Cancel"}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {!run.planId.startsWith("capture-single-plan:") && manifestsByRun.has(run.runId) ? (
              <div style={{ borderTop: "1px solid #cddacf", marginTop: 6, paddingTop: 7 }}>
                <strong style={{ fontSize: 10.5 }}>Source manifest</strong>
                <ul
                  aria-label="Source manifest exports"
                  style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}
                >
                  {manifestsByRun.get(run.runId)!.outputs.map((output) => {
                    const model = createCaptureManifestOutputUiModel(output);
                    const key = captureManifestRetryKey(run.runId, output.format);
                    const pending = captureManifestRetryPendingKey === key;
                    const reconciling = Boolean(captureManifestRetryCommandRefs.current[key]);
                    const color = model.tone === "success"
                      ? "#2f5f3a"
                      : model.tone === "warning"
                        ? "#7a4d14"
                        : model.tone === "error"
                          ? "#7a1f1a"
                          : "#536156";
                    return (
                      <li key={output.format} style={{ padding: "5px 0" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <code style={{ overflowWrap: "anywhere" }}>{model.filename}</code>
                          <span style={{ color, whiteSpace: "nowrap" }}>{model.statusLabel}</span>
                        </div>
                        <div
                          role={model.tone === "error" || model.tone === "warning" ? "alert" : "status"}
                          style={{ color, fontSize: 10, marginTop: 2 }}
                        >
                          {model.detail}
                        </div>
                        {captureManifestRetryErrors[key] ? (
                          <div role="alert" style={{ color: "#7a1f1a", fontSize: 10, marginTop: 3 }}>
                            {captureManifestRetryErrors[key]}
                          </div>
                        ) : null}
                        {model.actionLabel ? (
                          <button
                            type="button"
                            disabled={captureManifestRetryPendingKey !== null}
                            onClick={() => void retryManifestOutput(run.runId, output.format)}
                            aria-label={reconciling
                              ? `Reconcile ${output.format.toUpperCase()} manifest export`
                              : model.actionLabel}
                            style={{
                              ...(
                                captureManifestRetryPendingKey !== null
                                  ? disabledButtonStyle
                                  : buttonStyle
                              ),
                              padding: "2px 6px",
                              fontSize: 10,
                              marginTop: 4,
                            }}
                          >
                            {pending
                              ? reconciling ? "Reconciling export…" : "Exporting…"
                              : reconciling
                                ? `Reconcile ${output.format.toUpperCase()} export`
                                : model.actionLabel}
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </article>
        ))}
      </section>
    );
  }

  return (
    <div
      data-cliphutch-side-panel-shell={surface === "sidepanel" ? "v1" : undefined}
      style={{
        padding: surface === "sidepanel" ? 16 : 12,
        fontSize: 12,
        minWidth: surface === "sidepanel" ? 0 : 320,
        maxWidth: surface === "sidepanel" ? "none" : 370,
        width: surface === "sidepanel" ? "100%" : undefined,
        boxSizing: "border-box",
        fontFamily: "-apple-system, system-ui, sans-serif",
        background: "#f4f8f5",
        color: "#1d261f",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2
            data-cliphutch-side-panel-ready={surface === "sidepanel" ? "true" : undefined}
            tabIndex={surface === "sidepanel" ? 0 : undefined}
            style={{ margin: 0, fontSize: 18, letterSpacing: 0, lineHeight: 1 }}
          >
            ClipHutch
          </h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
          <span
            role="status"
            aria-label={
              licensed
                ? "Licensed: unlimited video downloads"
                : `Free tier: ${remaining} of ${FREE_DOWNLOAD_LIMIT} video downloads left in the next 24 hours`
            }
            style={{
              color: licensed ? "#2f5f3a" : atLimit ? "#a02a1f" : "#59675c",
              fontSize: 11,
              fontWeight: licensed || atLimit ? 600 : 400,
              border: "1px solid #cbd8cf",
              background: "#ffffff",
              borderRadius: 999,
              padding: "4px 8px",
            }}
            title={licensed ? "Unlimited downloads (licensed)" : `Free tier: ${remaining} of ${FREE_DOWNLOAD_LIMIT} video downloads left in the next 24h`}
          >
            {licensed ? "Licensed" : `${remaining}/${FREE_DOWNLOAD_LIMIT} left`}
          </span>
          {draftItems.length > 0 && (
            <button
              onClick={() => void requestCaptureReview(captureChoices)}
              disabled={!workspaceBootstrapped || captureReviewPending || anyStartReconciliationActive}
              style={!workspaceBootstrapped || captureReviewPending || anyStartReconciliationActive ? disabledButtonStyle : primaryButtonStyle}
            >
              {captureReviewPending ? "Reviewing…" : `Review pack (${draftItems.length})`}
            </button>
          )}
          {surface === "popup" ? (
            <button
              type="button"
              data-cliphutch-open-side-panel
              onClick={openHutchSidePanel}
              disabled={workspaceWindowId === null}
              style={workspaceWindowId === null ? disabledButtonStyle : buttonStyle}
            >
              Open Hutch
            </button>
          ) : null}
          <button
            onClick={() => chrome.runtime.openOptionsPage()}
            title="Settings"
            aria-label="Settings"
            style={iconButtonStyle}
          >
            ⚙
          </button>
        </div>
      </div>
      <div style={{ ...shelfLineStyle, marginTop: 9 }} />
      {sidePanelOpenError ? <div role="alert" style={errorBoxStyle}>{sidePanelOpenError}</div> : null}
      {licenseNotice && (
        <div
          role="alert"
          style={{
            marginTop: 8,
            padding: "8px 10px",
            color: "#7a1f1a",
            background: "#fff1ed",
            border: "1px solid #efb6aa",
            borderRadius: 6,
            fontSize: 11,
            lineHeight: 1.35,
          }}
        >
          {licenseNotice}{" "}
          <button
            type="button"
            onClick={() => chrome.runtime.openOptionsPage()}
            style={{ fontSize: "inherit" }}
          >
            Open Options
          </button>
          {" "}
          <button
            type="button"
            onClick={() => {
              void dismissLicenseNotice().then(() => setLicenseNotice(null));
            }}
            style={{ fontSize: "inherit" }}
          >
            Dismiss
          </button>
        </div>
      )}
      <div
        role="tablist"
        aria-orientation="horizontal"
        aria-label="Capture Pack workspace"
        style={{
          margin: "9px 0 7px",
          display: "grid",
          gridTemplateColumns: `repeat(auto-fit, minmax(min(${WORKSPACE_TAB_MIN_TRACK_PX}px, 100%), 1fr))`,
          gap: WORKSPACE_TAB_GAP_PX,
          minWidth: 0,
          maxWidth: "100%",
        }}
      >
        {WORKSPACE_ROUTES.map((view) => (
          <button
            key={view}
            id={`workspace-tab-${view}`}
            ref={(element) => { workspaceTabRefs.current[view] = element; }}
            type="button"
            role="tab"
            tabIndex={captureView === view ? 0 : -1}
            aria-controls={`workspace-panel-${view}`}
            aria-selected={captureView === view}
            onClick={() => activateWorkspaceView(view)}
            onKeyDown={(event) => onWorkspaceTabKeyDown(event, view)}
            style={{
              ...buttonStyle,
              minWidth: 0,
              padding: "5px 4px",
              overflowWrap: "anywhere",
              background: captureView === view ? "#2f5f3a" : "#fff",
              color: captureView === view ? "#fff" : "#1f2a22",
            }}
          >
            {WORKSPACE_ROUTE_LABELS[view]}
          </button>
        ))}
      </div>
      {quickCaptureRecoveryActive && captureView !== "activity" ? (
        <div role="alert" style={errorBoxStyle}>
          A previous Quick Capture start must be resolved before another Quick Capture or pack can begin.
          <button
            type="button"
            onClick={() => {
              setCaptureView("activity");
              void refreshCaptureWorkspace();
            }}
            style={{ ...buttonStyle, display: "block", marginTop: 6 }}
          >
            View Activity
          </button>
        </div>
      ) : null}
      {captureReviewError ? <div role="alert" style={errorBoxStyle}>{captureReviewError}</div> : null}
      {WORKSPACE_ROUTES.filter((view) => view !== captureView).map((view) => (
        <div
          key={view}
          id={`workspace-panel-${view}`}
          role="tabpanel"
          aria-labelledby={`workspace-tab-${view}`}
          hidden
        />
      ))}
      <div
        id={`workspace-panel-${captureView}`}
        role="tabpanel"
        aria-labelledby={`workspace-tab-${captureView}`}
        tabIndex={0}
        style={{ minWidth: 0, maxWidth: "100%" }}
      >
      {captureView === "shelf" ? (<>
      <div
        role="tablist"
        aria-orientation="horizontal"
        aria-label="Detected media shelves"
        style={{ margin: "9px 0 7px", display: "flex", alignItems: "center", gap: 6 }}
      >
        <ShelfTab
          active={mediaFilter === "videos"}
          buttonRef={(element) => { shelfTabRefs.current.videos = element; }}
          count={videoGroups.length}
          controls="media-shelf-panel"
          id="videos-shelf-tab"
          label="Videos"
          onClick={() => {
            setMediaFilter("videos");
          }}
          onKeyDown={(event) => onShelfTabKeyDown(event, "videos")}
        />
        <ShelfTab
          active={mediaFilter === "stills"}
          buttonRef={(element) => { shelfTabRefs.current.stills = element; }}
          count={stillGroups.length}
          controls="media-shelf-panel"
          id="stills-shelf-tab"
          label="Stills"
          onClick={() => {
            setMediaFilter("stills");
          }}
          onKeyDown={(event) => onShelfTabKeyDown(event, "stills")}
        />
      </div>
      {captureDraftError ? (
        <div role="alert" style={errorBoxStyle}>{captureDraftError}</div>
      ) : null}
      <section
        aria-label="Capture Pack selection"
        style={{
          margin: "8px 0",
          padding: "8px 9px",
          border: "1px solid #bdd7c8",
          borderRadius: 7,
          background: "#f1f7f4",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <div>
            <strong style={{ color: "#244f3a" }}>Capture Pack</strong>
            <div role="status" aria-live="polite" style={{ color: "#536156", fontSize: 10.5, marginTop: 2 }}>
              {draftItems.length === 0
                ? "Nothing selected yet. Choose videos and stills from either shelf."
                : `${draftItems.length} selected: ${draftVideoCount} video${draftVideoCount === 1 ? "" : "s"}, ${draftStillCount} still${draftStillCount === 1 ? "" : "s"}. Saved for this browsing session.`}
            </div>
          </div>
        </div>
        {captureDraft ? (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 5, marginTop: 7 }}>
            <label style={{ flex: 1, fontSize: 10.5 }}>
              Pack name
              <input
                value={captureName}
                maxLength={120}
                onChange={(event) => setCaptureName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveCaptureName();
                  }
                }}
                style={{ display: "block", width: "100%", boxSizing: "border-box", marginTop: 2, padding: 4, fontSize: 11 }}
              />
            </label>
            <button
              type="button"
              disabled={captureRenamePending || captureRunOutcomeUnknown || !captureName.trim() || captureName.trim() === captureDraft.name}
              onClick={() => void saveCaptureName()}
              style={captureRenamePending || captureRunOutcomeUnknown || !captureName.trim() || captureName.trim() === captureDraft.name ? disabledButtonStyle : buttonStyle}
            >
              {captureRenamePending ? "Saving…" : "Rename"}
            </button>
          </div>
        ) : null}
        {activeGroups.length > 0 || currentPageDraftCount > 0 ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 }}>
            {activeGroups.length > 0 ? (
              <button
                type="button"
                onClick={() => void addVisibleGroupsToPack()}
                disabled={pendingCaptureGroupId !== null || captureRunOutcomeUnknown}
                style={pendingCaptureGroupId !== null || captureRunOutcomeUnknown ? disabledButtonStyle : buttonStyle}
              >
                {pendingCaptureGroupId === "visible-selection" ? "Updating…" : "Select visible"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void clearCurrentPageFromPack()}
              disabled={pendingCaptureGroupId !== null || captureRunOutcomeUnknown || currentPageDraftCount === 0}
              style={pendingCaptureGroupId !== null || captureRunOutcomeUnknown || currentPageDraftCount === 0 ? disabledButtonStyle : buttonStyle}
            >
              Clear page selection
            </button>
          </div>
        ) : null}
      </section>
      {manifestPartition.covered.length > 0 ? (
        <div
          style={{
            marginTop: 8,
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid #d7c8a7",
            background: "#fffaf0",
            color: "#6b5428",
            fontSize: 10.5,
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            alignItems: "center",
          }}
        >
          <span role="status">
            {manifestPartition.covered.length} stream part{manifestPartition.covered.length === 1 ? "" : "s"} {showStreamParts ? "shown" : "hidden"}.
          </span>
          <button
            type="button"
            onClick={() => setShowStreamParts((current) => !current)}
            style={{ ...buttonStyle, padding: "2px 6px", fontSize: 10 }}
          >
            {showStreamParts ? "Hide" : "Show"}
          </button>
        </div>
      ) : null}
      {detectionStats?.truncated ? (
        <div role="status" style={{ ...noteBoxStyle, background: "#fffaf0", borderColor: "#d7c8a7", color: "#60491f" }}>
          Showing {detectionStats.retainedCount} retained items. {detectionStats.droppedCountIsLowerBound || detectionStats.evictedCountIsLowerBound ? "At least " : ""}
          {detectionStats.droppedCount + detectionStats.evictedCount} additional detection{detectionStats.droppedCount + detectionStats.evictedCount === 1 ? " was" : "s were"} not retained after the {detectionStats.limit}-item shelf limit.
        </div>
      ) : null}
      {hiddenByDomainCount > 0 ? (
        <div
          style={{
            marginTop: 8,
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid #d7c8a7",
            background: "#fffaf0",
            color: "#6b5428",
            fontSize: 10.5,
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            alignItems: "center",
          }}
        >
          <span>{hiddenByDomainCount} item{hiddenByDomainCount === 1 ? "" : "s"} hidden by domain filters.</span>
          <button onClick={() => void clearDomainFilters()} style={{ ...buttonStyle, padding: "2px 6px", fontSize: 10 }}>
            Show all
          </button>
        </div>
      ) : null}
      <div
        id="media-shelf-panel"
        role="tabpanel"
        aria-labelledby={mediaFilter === "videos" ? "videos-shelf-tab" : "stills-shelf-tab"}
        style={{ marginTop: 10 }}
      >
        {renderBody()}
      </div>
      </>) : captureView === "hutch"
        ? renderHutch()
        : captureView === "review"
          ? renderCaptureReview()
          : renderCaptureActivity()}
      </div>
      <footer
        style={{
          marginTop: 12,
          color: "#758277",
          fontSize: 10,
          borderTop: "1px solid #cbd8cf",
          paddingTop: 6,
        }}
      >
        v{version}
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root && window.location.pathname.endsWith("/popup.html")) {
  createRoot(root).render(
    <StrictMode>
      <WorkspaceShell surface="popup" />
    </StrictMode>,
  );
}
