import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DashJob, DetectedVideo, DirectJob, HlsJob, WebmTranscodeJob } from "../types";
import { filterCoveredByManifests } from "../lib/manifest-coverage";
import { inferFilename } from "../lib/filename";

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

type BulkResult = {
  started: number;
  skipped: number;
  failed: number;
  message?: string;
};

type MediaGroup = {
  primary: DetectedVideo;
  alternates: DetectedVideo[];
};
import { getDetectedVideos } from "../lib/storage-session";
import { DEFAULT_SETTINGS, getSettings, setSettings, type UserSettings } from "../lib/storage-local";
import { isLicensed, revalidateIfStale } from "../lib/license";
import { FREE_DOWNLOAD_LIMIT, VIDEO_DOWNLOAD_HISTORY_KEY, getDownloadCount } from "../lib/rate-limit";
import { CHECKOUT_URL, MIN_STILL_IMAGE_SIZE_BYTES, PRICE_USD } from "../lib/constants";
import { isStillImage, isWebmDirectVideo } from "../lib/media-format";

const DIRECT_JOBS_KEY = "download-jobs";
const HLS_JOBS_KEY = "hls-download-jobs";
const DASH_JOBS_KEY = "dash-download-jobs";
const WEBM_TRANSCODE_JOBS_KEY = "webm-transcode-jobs";

type AnyJob =
  | ({ source: "direct" } & DirectJob)
  | ({ source: "hls" } & HlsJob)
  | ({ source: "dash" } & DashJob)
  | ({ source: "webm" } & WebmTranscodeJob);

// The name shown in the popup is the exact name the file will save under, so
// the shelf and the download match. Extension is stripped for display.
function displayName(v: DetectedVideo): string {
  const name = inferFilename(v);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
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

function pathBucket(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    return `${u.hostname}/${parts.slice(0, Math.max(0, parts.length - 1)).join("/")}`;
  } catch {
    return rawUrl;
  }
}

function normalizedStem(v: DetectedVideo): string {
  return displayName(v)
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/\b(2160|1440|1080|720|540|480|360|240)p\b/g, "")
    .replace(/\b(uhd|fhd|hd|sd|high|medium|low|source|main|video|audio)\b/g, "")
    .replace(/[_\-. ]+/g, " ")
    .trim();
}

function groupKey(v: DetectedVideo): string {
  const page = v.pageUrl ? pathBucket(v.pageUrl) : "no-page";
  const source = pathBucket(v.url);
  const stem = normalizedStem(v) || source;
  return [v.kind, page, source, stem].join("|");
}

function groupMedia(items: DetectedVideo[]): MediaGroup[] {
  const buckets = new Map<string, DetectedVideo[]>();
  for (const item of items) {
    const key = item.kind === "hls" || item.kind === "dash" ? item.id : groupKey(item);
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }
  return [...buckets.values()]
    .map((group) => {
      const sorted = [...group].sort((a, b) => {
        const sizeDelta = (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
        if (sizeDelta !== 0) return sizeDelta;
        return b.detectedAt - a.detectedAt;
      });
      return { primary: sorted[0], alternates: sorted.slice(1) };
    })
    .sort((a, b) => b.primary.detectedAt - a.primary.detectedAt);
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

function urlDisplay(rawUrl: string, showFull: boolean): string {
  if (showFull) return rawUrl;
  try {
    const u = new URL(rawUrl);
    return u.hostname + u.pathname;
  } catch {
    return rawUrl;
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
      <div style={{ minWidth: 0 }}>
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
        <button onClick={() => chrome.downloads.show(downloadId)} style={buttonStyle}>
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
    notes.push("This stream is encrypted; keys are not fetched.");
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

function bulkResultText(result: BulkResult): string {
  const parts = [
    `Started ${result.started}`,
    `skipped ${result.skipped}`,
    `failed ${result.failed}`,
  ];
  return result.message ? `${parts.join(" · ")} · ${result.message}` : parts.join(" · ");
}

function ShelfTab({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
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
  v,
  alternates,
  selectedId,
  tabId,
  settings,
  onSelect,
  onIgnoreSource,
  onIgnorePage,
}: {
  v: DetectedVideo;
  alternates: DetectedVideo[];
  selectedId: string;
  tabId: number;
  settings: UserSettings;
  onSelect: (id: string) => void;
  onIgnoreSource: (host: string) => void;
  onIgnorePage: (host: string) => void;
}) {
  const [showFull, setShowFull] = useState(settings.showFullUrlsByDefault);
  const [showAlternates, setShowAlternates] = useState(false);
  const [job, setJob] = useState<AnyJob | null>(null);
  const [directProgress, setDirectProgress] = useState<{ received: number; total?: number } | null>(null);
  const [immediateError, setImmediateError] = useState<string | null>(null);
  const [picker, setPicker] = useState<
    | { state: "loading" }
    | { state: "ready"; variants: VariantOption[]; durationSec?: number; sizeCapBytes: number }
    | null
  >(null);
  const groupedAssets = [v, ...alternates];
  const selected = groupedAssets.find((item) => item.id === selectedId) ?? v;

  useEffect(() => {
    setJob(null);
    setPicker(null);
    setImmediateError(null);
  }, [v.id]);

  useEffect(() => {
    setJob(null);
    setDirectProgress(null);
  }, [selected.id]);

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

  const sendDownload = async (variant?: VariantOption, bypassSizeCap?: boolean) => {
    setPicker(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "download",
        tabId,
        videoId: selected.id,
        variantId: variant?.id,
        audioRenditionUrl: variant?.audioRenditionUrl,
        variantLabel: variant ? variantFilenameLabel(variant) : undefined,
        bypassSizeCap,
      })) as { ok: true; downloadId?: number; jobId?: string } | { ok: false; error: string };
      if (res && !res.ok) setImmediateError(res.error);
    } catch (err) {
      setImmediateError(err instanceof Error ? err.message : "Could not start download.");
    }
  };

  const onDownload = async () => {
    setImmediateError(null);
    if (selected.kind !== "hls" && selected.kind !== "dash") {
      void sendDownload();
      return;
    }
    setPicker({ state: "loading" });
    let lr: ListVariantsResponse;
    try {
      lr = (await chrome.runtime.sendMessage({
        type: "list-variants",
        tabId,
        videoId: selected.id,
      })) as ListVariantsResponse;
    } catch (err) {
      setPicker(null);
      setImmediateError(err instanceof Error ? err.message : "Could not load manifest.");
      return;
    }
    if (!lr || lr.ok === false) {
      setPicker(null);
      setImmediateError(lr && "error" in lr ? lr.error : "Could not load manifest.");
      return;
    }
    if (lr.variants.length === 0) {
      setPicker(null);
      setImmediateError("Manifest contained no usable video tracks.");
      return;
    }
    if (lr.variants.length === 1) {
      void sendDownload(lr.variants[0]);
      return;
    }
    const sortedVariants = [...lr.variants].sort((a, b) => b.bandwidth - a.bandwidth);
    setPicker({
      state: "ready",
      variants: sortedVariants,
      durationSec: lr.durationSec,
      sizeCapBytes: lr.sizeCapBytes,
    });
  };

  const onCancelPicker = () => setPicker(null);

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
    if (picker.state === "loading") {
      return (
        <div style={{ marginTop: 6, fontSize: 11, color: "#444" }}>
          Loading variants…
        </div>
      );
    }
    return (
      <div style={{ marginTop: 6 }}>
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
                onClick={() => void sendDownload(variant, overCap)}
                style={{
                  ...(overCap ? buttonStyle : primaryButtonStyle),
                  borderColor: overCap ? "#a05" : undefined,
                  color: overCap ? "#a05" : undefined,
                }}
              >
                {overCap ? "Continue anyway" : "Download"}
              </button>
            </div>
          );
        })}
        <button onClick={onCancelPicker} style={{ ...buttonStyle, marginTop: 6 }}>
          Cancel
        </button>
      </div>
    );
  }

  function renderAction() {
    if (picker) return renderPicker();
    if (immediateError) {
      return (
        <>
          <div style={errorBoxStyle}>{immediateError}</div>
          <button onClick={onDownload} style={{ ...buttonStyle, marginTop: 6 }}>
            Retry
          </button>
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
            <button onClick={onDownload} style={{ ...primaryButtonStyle, marginTop: 8 }}>
              Convert to MP4
            </button>
          </>
        );
      }
      return (
        <button onClick={onDownload} style={{ ...primaryButtonStyle, marginTop: 8 }}>
          Download
        </button>
      );
    }

    if (job.source === "direct") {
      if (job.status === "in_progress") {
        const total = directProgress?.total;
        const received = directProgress?.received ?? 0;
        const pct = total ? Math.round((received / total) * 100) : null;
        return (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 11, color: "#444" }}>
              {pct !== null
                ? `Downloading ${pct}% - ${fmtBytes(received)} / ${fmtBytes(total)}`
                : received > 0
                  ? `Downloading… ${fmtBytes(received)}`
                  : "Starting…"}
            </div>
            {total ? (
              <progress value={received} max={total} style={{ width: "100%", marginTop: 3 }} />
            ) : null}
          </div>
        );
      }
      if (job.status === "complete") {
        return <DownloadSuccessRow v={selected} job={job} />;
      }
      return (
        <>
          <div style={errorBoxStyle}>{job.errorMessage ?? "Download interrupted."}</div>
          <button onClick={onDownload} style={{ ...buttonStyle, marginTop: 6 }}>
            Retry
          </button>
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
            <div style={{ fontSize: 11, color: "#444" }}>{text}</div>
            {pct !== null ? (
              <progress value={done} max={total} style={{ width: "100%", marginTop: 3 }} />
            ) : null}
            <button onClick={onCancelHls} style={{ ...buttonStyle, marginTop: 4 }}>
              Cancel
            </button>
          </div>
        );
      }
      if (job.status === "saving") {
        return (
          <div style={{ marginTop: 6, fontSize: 11, color: "#444" }}>
            Saving file…
          </div>
        );
      }
      if (job.status === "complete") {
        return <DownloadSuccessRow v={selected} job={job} />;
      }
      if (job.status === "cancelled") {
        return (
          <>
            <div style={noteBoxStyle}>Download cancelled.</div>
            <button onClick={onDownload} style={{ ...buttonStyle, marginTop: 6 }}>
              Try again
            </button>
          </>
        );
      }
      return (
        <>
          <div style={errorBoxStyle}>
            {job.errorMessage ?? "Download failed."}
            {job.errorCode ? <span style={{ opacity: 0.6 }}> [{job.errorCode}]</span> : null}
          </div>
          <button onClick={onDownload} style={{ ...buttonStyle, marginTop: 6 }}>
            Retry
          </button>
        </>
      );
    }

    if (job.source === "webm") {
      if (job.status === "running") {
        const pct = Math.round(job.progress.ratio * 100);
        return (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 11, color: "#444" }}>
              {job.progress.message ?? "Transcoding WebM to MP4"} {pct > 0 ? `${pct}%` : ""}
            </div>
            <progress value={job.progress.ratio} max={1} style={{ width: "100%", marginTop: 3 }} />
            <button onClick={onCancelWebm} style={{ ...buttonStyle, marginTop: 4 }}>
              Cancel
            </button>
          </div>
        );
      }
      if (job.status === "saving") {
        return (
          <div style={{ marginTop: 6, fontSize: 11, color: "#444" }}>
            Saving MP4…
          </div>
        );
      }
      if (job.status === "complete") {
        return <DownloadSuccessRow v={selected} job={job} />;
      }
      if (job.status === "cancelled") {
        return (
          <>
            <div style={noteBoxStyle}>Transcode cancelled.</div>
            <button onClick={onDownload} style={{ ...buttonStyle, marginTop: 6 }}>
              Try again
            </button>
          </>
        );
      }
      return (
        <>
          <div style={errorBoxStyle}>
            {job.errorMessage ?? "WebM transcode failed."}
            {job.errorCode ? <span style={{ opacity: 0.6 }}> [{job.errorCode}]</span> : null}
          </div>
          <button onClick={onDownload} style={{ ...buttonStyle, marginTop: 6 }}>
            Retry
          </button>
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
          <div style={{ fontSize: 11, color: "#444" }}>{text}</div>
          {pct !== null ? (
            <progress value={done} max={total} style={{ width: "100%", marginTop: 3 }} />
          ) : null}
          <button onClick={onCancelDash} style={{ ...buttonStyle, marginTop: 4 }}>
            Cancel
          </button>
        </div>
      );
    }
    if (job.status === "saving") {
      return (
        <div style={{ marginTop: 6, fontSize: 11, color: "#444" }}>
          Muxing video + audio into one MP4…
        </div>
      );
    }
    if (job.status === "complete") {
      return <DownloadSuccessRow v={selected} job={job} />;
    }
    if (job.status === "cancelled") {
      return (
        <>
          <div style={noteBoxStyle}>Download cancelled.</div>
          <button onClick={onDownload} style={{ ...buttonStyle, marginTop: 6 }}>
            Try again
          </button>
        </>
      );
    }
    return (
      <>
        <div style={errorBoxStyle}>
          {job.errorMessage ?? "Download failed."}
          {job.errorCode ? <span style={{ opacity: 0.6 }}> [{job.errorCode}]</span> : null}
        </div>
        <button onClick={onDownload} style={{ ...buttonStyle, marginTop: 6 }}>
          Retry
        </button>
      </>
    );
  }

  const sourceHost = hostname(selected.url);
  const pageHost = pageLabel(selected);
  const alternateOptions = groupedAssets.filter((item) => item.id !== selected.id);

  return (
    <div
      style={{
        border: "1px solid #cbd8cf",
        borderRadius: 8,
        padding: 10,
        marginBottom: 10,
        background: "#ffffff",
        boxShadow: "0 1px 1px rgba(62, 48, 30, 0.06)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <strong
          style={{
            fontSize: 13,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "#172018",
          }}
        >
          {displayName(selected)}
        </strong>
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
        <span title={selected.url}>source: {sourceLabel(selected)}</span>
        {pageHost ? <span>page: {pageHost}</span> : null}
        {sourceHost ? (
          <button
            onClick={() => onIgnoreSource(sourceHost)}
            title={`Hide media loaded from ${sourceHost}`}
            style={{ ...buttonStyle, padding: "1px 5px", fontSize: 10 }}
          >
            Hide source
          </button>
        ) : null}
        {pageHost ? (
          <button
            onClick={() => onIgnorePage(pageHost)}
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
            onClick={() => setShowAlternates((s) => !s)}
            style={{ ...buttonStyle, padding: "2px 6px", fontSize: 10, marginRight: 6 }}
          >
            {showAlternates ? "Hide" : "Show"} {alternateOptions.length} alternate
            {alternateOptions.length === 1 ? "" : "s"}
          </button>
          <span>
            Similar assets from this source are grouped to keep the shelf tidy.
          </span>
          {showAlternates ? (
            <div style={{ marginTop: 5 }}>
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
                  <span
                    title={alt.url}
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {displayName(alt)}
                  </span>
                  <span style={{ color: "#758277" }}>{fmtBytes(alt.sizeBytes) ?? badgeText(alt)}</span>
                  <button
                    onClick={() => {
                      onSelect(alt.id);
                      setPicker(null);
                      setImmediateError(null);
                      setShowAlternates(false);
                    }}
                    style={{ ...buttonStyle, padding: "2px 6px", fontSize: 10 }}
                  >
                    Select
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <Diagnostics v={selected} job={job} />
      <VideoPreview v={selected} />
      <ImagePreview v={selected} />
      <div style={{ color: "#59675d", fontSize: 10, wordBreak: "break-all", marginTop: 7 }}>
        {urlDisplay(selected.url, showFull)}{" "}
        <button
          onClick={() => setShowFull((s) => !s)}
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
    </div>
  );
}

function Popup() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [videos, setVideos] = useState<DetectedVideo[]>([]);
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("videos");
  const [settings, setSettingsState] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [licensed, setLicensed] = useState(false);
  const [downloadCount, setDownloadCount] = useState(0);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, string>>({});

  async function refreshUsage() {
    const [lic, count] = await Promise.all([isLicensed(), getDownloadCount()]);
    setLicensed(lic);
    setDownloadCount(count);
  }

  useEffect(() => {
    let active = true;
    (async () => {
      const [tabs, s, lic, count] = await Promise.all([
        chrome.tabs.query({ active: true, currentWindow: true }),
        getSettings(),
        isLicensed(),
        getDownloadCount(),
      ]);
      if (!active) return;
      setSettingsState(s);
      setLicensed(lic);
      setDownloadCount(count);
      const id = tabs[0]?.id;
      if (id !== undefined) {
        setTabId(id);
        setVideos(await getDetectedVideos(id));
      }
      setLoaded(true);

      // Background re-validation: if the cached license is stale (>7 days
      // since last server check), call /validate. Definitive negatives
      // (REFUNDED / REVOKED / NOT_FOUND) deactivate the local license, which
      // bumps storage.local and triggers refreshUsage via the listener above.
      if (lic) {
        void revalidateIfStale().catch(() => undefined);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== "local") return;
      if (changes[VIDEO_DOWNLOAD_HISTORY_KEY] || changes["license"]) void refreshUsage();
      if (changes["settings"]) {
        void getSettings().then(setSettingsState);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    if (tabId === null) return;
    const key = `tab:${tabId}`;
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== "session" || !changes[key]) return;
      const next = changes[key].newValue;
      setVideos(Array.isArray(next) ? (next as DetectedVideo[]) : []);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [tabId]);

  const version = chrome.runtime.getManifest().version;
  const remaining = Math.max(0, FREE_DOWNLOAD_LIMIT - downloadCount);
  const atLimit = !licensed && remaining === 0;

  function onUpgrade() {
    if (CHECKOUT_URL.startsWith("http")) {
      window.open(CHECKOUT_URL, "_blank");
    } else {
      window.alert(
        "Checkout link not configured yet. Set CHECKOUT_URL in extension/src/lib/constants.ts to your Stripe checkout URL.",
      );
    }
  }

  // Direct video segments that are covered by a detected manifest are
  // hidden from the popup; see lib/manifest-coverage.ts. Domain filters
  // are also applied here so the user-facing shelf matches badge behavior.
  const manifestFilteredMedia = filterCoveredByManifests(videos);
  const visibleMedia = manifestFilteredMedia.filter((v) => !isIgnoredBySettings(v, settings));
  const hiddenByDomainCount = manifestFilteredMedia.length - visibleMedia.length;
  const visibleVideos = visibleMedia.filter((v) => !isStillImage(v));
  const visibleStills = visibleMedia.filter(isStillImage);
  const videoGroups = groupMedia(visibleVideos);
  const stillGroups = groupMedia(visibleStills);
  const activeGroups = mediaFilter === "videos" ? videoGroups : stillGroups;

  function selectedForGroup(group: MediaGroup): DetectedVideo {
    const selectedId = selectedByGroup[group.primary.id];
    return [group.primary, ...group.alternates].find((item) => item.id === selectedId) ?? group.primary;
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

  async function downloadAll() {
    if (tabId === null) return;
    const resultSummary: BulkResult = { started: 0, skipped: 0, failed: 0 };
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

    const isActive = (status: string) =>
      status === "in_progress" || status === "running" || status === "saving";
    let streamJobQueued = [...Object.values(hlses), ...Object.values(dashes), ...Object.values(webms)].some(
      (j) => j.tabId === tabId && isActive(j.status),
    );

    for (const v of activeGroups.map(selectedForGroup)) {
      const matches = [
        ...Object.values(directs).filter((j) => j.videoId === v.id && j.tabId === tabId),
        ...Object.values(hlses).filter((j) => j.videoId === v.id && j.tabId === tabId),
        ...Object.values(dashes).filter((j) => j.videoId === v.id && j.tabId === tabId),
        ...Object.values(webms).filter((j) => j.videoId === v.id && j.tabId === tabId),
      ];
      const eligible = !matches.some(
        (j) => isActive(j.status) || j.status === "complete",
      );
      if (!eligible) {
        resultSummary.skipped++;
        continue;
      }
      const usesOffscreenJob = v.kind === "hls" || v.kind === "dash" || isWebmDirectVideo(v);
      if (usesOffscreenJob && streamJobQueued) {
        resultSummary.skipped++;
        continue;
      }

      try {
        const res = (await chrome.runtime.sendMessage({
          type: "download",
          tabId,
          videoId: v.id,
        })) as { ok: true; downloadId?: number; jobId?: string } | { ok: false; error: string } | undefined;
        if (res?.ok) {
          resultSummary.started++;
          if (usesOffscreenJob) streamJobQueued = true;
        } else {
          resultSummary.failed++;
          if (!resultSummary.message && res && "error" in res) resultSummary.message = res.error;
        }
      } catch {
        resultSummary.failed++;
        if (!resultSummary.message) resultSummary.message = "Could not start one download.";
      }
    }
    setBulkResult(resultSummary);
  }

  function renderBody() {
    if (!loaded) {
      return (
        <p style={{ marginTop: 8, color: "#888" }}>Loading detected media…</p>
      );
    }
    if (tabId === null) {
      return (
        <p style={{ margin: "12px 0", color: "#536156", fontSize: 11 }}>
          No active tab. Open this popup from a regular browser tab.
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
    return activeGroups.map((group) => (
      <VideoCard
        key={group.primary.id}
        v={group.primary}
        alternates={group.alternates}
        selectedId={selectedForGroup(group).id}
        tabId={tabId}
        settings={settings}
        onSelect={(id) => {
          setSelectedByGroup((prev) => ({ ...prev, [group.primary.id]: id }));
          setBulkResult(null);
        }}
        onIgnoreSource={(host) => void ignoreSourceHost(host)}
        onIgnorePage={(host) => void ignorePageHost(host)}
      />
    ));
  }

  return (
    <div
      style={{
        padding: 12,
        fontSize: 12,
        minWidth: 340,
        maxWidth: 370,
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
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 18, letterSpacing: 0, lineHeight: 1 }}>ClipHutch</h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
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
          {activeGroups.length > 0 && (
            <button
              onClick={() => void downloadAll()}
              title={`Download each visible ${mediaFilter === "videos" ? "video" : "still"} group's top pick. Grouped alternates are skipped in bulk.`}
              style={primaryButtonStyle}
            >
              Download picks
            </button>
          )}
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
      {atLimit && (
        <div
          style={{
            marginTop: 8,
            padding: activeGroups.length > 0 ? "8px 10px" : "6px 8px",
            background: "#fff1ed",
            border: "1px solid #efb6aa",
            borderRadius: 6,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div style={{ fontSize: activeGroups.length > 0 ? 11 : 10.5, color: "#7a1f1a", lineHeight: 1.25 }}>
            <strong>Daily limit reached.</strong>{" "}
            {activeGroups.length > 0
              ? `You've used all ${FREE_DOWNLOAD_LIMIT} free video downloads in the last 24 hours. Get unlimited video downloads with a one-time payment of $${PRICE_USD}.`
              : `Free video downloads reset within 24 hours.`}
          </div>
          <button
            onClick={onUpgrade}
            title={`One-time payment of $${PRICE_USD}, no subscription`}
            style={{
              border: "1px solid #2c5e2c",
              background: "#2c5e2c",
              color: "#fff",
              borderRadius: 6,
              padding: activeGroups.length > 0 ? "4px 10px" : "3px 8px",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            ${PRICE_USD} one-time
          </button>
        </div>
      )}
      <div style={{ margin: "9px 0 7px", display: "flex", alignItems: "center", gap: 6 }}>
        <ShelfTab
          active={mediaFilter === "videos"}
          count={videoGroups.length}
          label="Videos"
          onClick={() => {
            setMediaFilter("videos");
            setBulkResult(null);
          }}
        />
        <ShelfTab
          active={mediaFilter === "stills"}
          count={stillGroups.length}
          label="Stills"
          onClick={() => {
            setMediaFilter("stills");
            setBulkResult(null);
          }}
        />
      </div>
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
      {bulkResult ? (
        <div
          style={{
            marginTop: 8,
            padding: "6px 8px",
            borderRadius: 6,
            border: bulkResult.failed > 0 ? "1px solid #efb6aa" : "1px solid #bdd7c8",
            background: bulkResult.failed > 0 ? "#fff1ed" : "#f1f7f4",
            color: bulkResult.failed > 0 ? "#7a1f1a" : "#244f3a",
            fontSize: 11,
          }}
        >
          {bulkResultText(bulkResult)}
        </div>
      ) : null}
      <div style={{ marginTop: 10 }}>{renderBody()}</div>
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
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Popup />
    </StrictMode>,
  );
}
