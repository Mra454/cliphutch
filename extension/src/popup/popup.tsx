import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DashJob, DetectedVideo, DirectJob, HlsJob } from "../types";
import { filterCoveredByManifests } from "../lib/manifest-coverage";

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
import { getDetectedVideos } from "../lib/storage-session";
import { DEFAULT_SETTINGS, getSettings, type UserSettings } from "../lib/storage-local";
import { isLicensed, revalidateIfStale } from "../lib/license";
import { FREE_DOWNLOAD_LIMIT, getDownloadCount } from "../lib/rate-limit";
import { CHECKOUT_URL, PRICE_USD } from "../lib/constants";

const DIRECT_JOBS_KEY = "download-jobs";
const HLS_JOBS_KEY = "hls-download-jobs";
const DASH_JOBS_KEY = "dash-download-jobs";

type AnyJob =
  | ({ source: "direct" } & DirectJob)
  | ({ source: "hls" } & HlsJob)
  | ({ source: "dash" } & DashJob);

function basename(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || u.hostname;
  } catch {
    return rawUrl.slice(0, 60);
  }
}

function dispositionFilename(cd?: string): string | undefined {
  if (!cd) return undefined;
  const star = cd.match(/filename\*\s*=\s*[A-Za-z0-9-]+'[A-Za-z-]*'([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through
    }
  }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : undefined;
}

const GENERIC_MANIFEST_NAMES = new Set([
  "playlist.m3u8",
  "master.m3u8",
  "index.m3u8",
  "chunklist.m3u8",
  "manifest.mpd",
]);

function displayName(v: DetectedVideo): string {
  const disp = dispositionFilename(v.contentDisposition);
  if (disp) return disp;
  const base = basename(v.url);
  const title = v.pageTitle?.trim();
  if (title && GENERIC_MANIFEST_NAMES.has(base.toLowerCase())) return title;
  return base;
}

const KIND_BADGE: Record<string, string> = {
  hls: "HLS",
  dash: "DASH",
};

function badgeText(v: DetectedVideo): string {
  if (v.kind !== "direct") return KIND_BADGE[v.kind] ?? v.kind.toUpperCase();
  try {
    const ext = new URL(v.url).pathname.split(".").pop()?.toUpperCase();
    return ext && ext.length <= 5 ? ext : "VIDEO";
  } catch {
    return "VIDEO";
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
    <p style={{ marginTop: 8, color: "#666" }}>
      No videos detected yet. Try playing a video, reloading the page, or
      interacting with the player. Some sites only request video URLs after
      interaction. Requests served from Chrome's memory cache may not be visible.
    </p>
  );
}

const errorBoxStyle: React.CSSProperties = {
  background: "#fdecea",
  color: "#7a1f1a",
  border: "1px solid #f3b6b0",
  borderRadius: 3,
  padding: "4px 6px",
  fontSize: 11,
  marginTop: 6,
};

const noteBoxStyle: React.CSSProperties = {
  background: "#eef5fb",
  color: "#234a6b",
  border: "1px solid #b9d4ea",
  borderRadius: 3,
  padding: "4px 6px",
  fontSize: 11,
  marginTop: 6,
};

const buttonStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "3px 8px",
  cursor: "pointer",
};

function VideoCard({
  v,
  tabId,
  settings,
}: {
  v: DetectedVideo;
  tabId: number;
  settings: UserSettings;
}) {
  const [showFull, setShowFull] = useState(settings.showFullUrlsByDefault);
  const [job, setJob] = useState<AnyJob | null>(null);
  const [directProgress, setDirectProgress] = useState<{ received: number; total?: number } | null>(null);
  const [immediateError, setImmediateError] = useState<string | null>(null);
  const [picker, setPicker] = useState<
    | { state: "loading" }
    | { state: "ready"; variants: VariantOption[]; durationSec?: number; sizeCapBytes: number }
    | null
  >(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const result = await chrome.storage.session.get([DIRECT_JOBS_KEY, HLS_JOBS_KEY, DASH_JOBS_KEY]);
      const directs = (result[DIRECT_JOBS_KEY] as Record<string, DirectJob>) ?? {};
      const hlses = (result[HLS_JOBS_KEY] as Record<string, HlsJob>) ?? {};
      const dashes = (result[DASH_JOBS_KEY] as Record<string, DashJob>) ?? {};
      const matches: AnyJob[] = [];
      for (const j of Object.values(directs)) {
        if (j.videoId === v.id && j.tabId === tabId) matches.push({ source: "direct", ...j });
      }
      for (const j of Object.values(hlses)) {
        if (j.videoId === v.id && j.tabId === tabId) matches.push({ source: "hls", ...j });
      }
      for (const j of Object.values(dashes)) {
        if (j.videoId === v.id && j.tabId === tabId) matches.push({ source: "dash", ...j });
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
      if (changes[DIRECT_JOBS_KEY] || changes[HLS_JOBS_KEY] || changes[DASH_JOBS_KEY]) void refresh();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [v.id, tabId]);

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

  const sendDownload = async (variantId?: string, bypassSizeCap?: boolean) => {
    setPicker(null);
    const res = (await chrome.runtime.sendMessage({
      type: "download",
      tabId,
      videoId: v.id,
      variantId,
      bypassSizeCap,
    })) as { ok: true; downloadId?: number; jobId?: string } | { ok: false; error: string };
    if (res && !res.ok) setImmediateError(res.error);
  };

  const onDownload = async () => {
    setImmediateError(null);
    if (v.kind !== "hls" && v.kind !== "dash") {
      void sendDownload();
      return;
    }
    setPicker({ state: "loading" });
    const lr = (await chrome.runtime.sendMessage({
      type: "list-variants",
      tabId,
      videoId: v.id,
    })) as ListVariantsResponse;
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
      void sendDownload(lr.variants[0].id);
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

  const onShowInFolder = () => {
    if (!job) return;
    const id =
      job.source === "direct"
        ? job.downloadId
        : job.downloadId;
    if (id !== undefined) chrome.downloads.show(id);
  };

  const onCancelHls = () => {
    if (job?.source !== "hls") return;
    void chrome.runtime.sendMessage({ type: "hls-download-cancel", jobId: job.jobId }).catch(() => {});
  };

  const onCancelDash = () => {
    if (job?.source !== "dash") return;
    void chrome.runtime.sendMessage({ type: "dash-download-cancel", jobId: job.jobId }).catch(() => {});
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
                onClick={() => void sendDownload(variant.id, overCap)}
                style={{
                  ...buttonStyle,
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
      return (
        <button onClick={onDownload} style={{ ...buttonStyle, marginTop: 6 }}>
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
                ? `Downloading ${pct}% — ${fmtBytes(received)} / ${fmtBytes(total)}`
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
        return (
          <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#2c5e2c", fontSize: 11 }}>Saved</span>
            <button onClick={onShowInFolder} style={buttonStyle}>
              Show in folder
            </button>
          </div>
        );
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
        return (
          <div style={{ marginTop: 6 }}>
            <div style={noteBoxStyle}>
              Saved as .ts file. Plays in VLC. MP4 conversion may come in a future version.
            </div>
            <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "#2c5e2c", fontSize: 11 }}>Saved</span>
              <button onClick={onShowInFolder} style={buttonStyle}>
                Show in folder
              </button>
            </div>
          </div>
        );
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
      return (
        <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
          <span style={{ color: "#2c5e2c", fontSize: 11 }}>Saved</span>
          <button
            onClick={() => job.downloadId !== undefined && chrome.downloads.show(job.downloadId)}
            style={buttonStyle}
          >
            Show in folder
          </button>
        </div>
      );
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

  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 4,
        padding: 8,
        marginBottom: 6,
        background: "#fff",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <strong
          style={{
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {displayName(v)}
        </strong>
        <span
          style={{
            fontSize: 10,
            padding: "1px 6px",
            background: "#eee",
            borderRadius: 3,
            whiteSpace: "nowrap",
          }}
        >
          {badgeText(v)}
        </span>
      </div>
      {fmtBytes(v.sizeBytes) !== undefined && (
        <div style={{ color: "#888", fontSize: 11, marginTop: 2 }}>{fmtBytes(v.sizeBytes)}</div>
      )}
      <div style={{ color: "#666", fontSize: 10, wordBreak: "break-all", marginTop: 4 }}>
        {urlDisplay(v.url, showFull)}{" "}
        <button
          onClick={() => setShowFull((s) => !s)}
          style={{ marginLeft: 4, fontSize: 10, padding: "0 4px", cursor: "pointer" }}
        >
          {showFull ? "hide" : "show full URL"}
        </button>
      </div>
      {renderAction()}
    </div>
  );
}

function Popup() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [videos, setVideos] = useState<DetectedVideo[]>([]);
  const [settings, setSettingsState] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [licensed, setLicensed] = useState(false);
  const [downloadCount, setDownloadCount] = useState(0);

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
      if (changes["download-history"] || changes["license"]) void refreshUsage();
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
  // hidden from the popup — see lib/manifest-coverage.ts. The full
  // detection list stays in storage so badge counts stay accurate; only
  // the user-facing list is filtered.
  const visibleVideos = filterCoveredByManifests(videos);

  async function downloadAll() {
    if (tabId === null) return;
    const result = await chrome.storage.session.get([DIRECT_JOBS_KEY, HLS_JOBS_KEY, DASH_JOBS_KEY]);
    const directs = (result[DIRECT_JOBS_KEY] as Record<string, DirectJob>) ?? {};
    const hlses = (result[HLS_JOBS_KEY] as Record<string, HlsJob>) ?? {};
    const dashes = (result[DASH_JOBS_KEY] as Record<string, DashJob>) ?? {};

    const isActive = (status: string) =>
      status === "in_progress" || status === "running" || status === "saving";

    for (const v of visibleVideos) {
      const matches = [
        ...Object.values(directs).filter((j) => j.videoId === v.id && j.tabId === tabId),
        ...Object.values(hlses).filter((j) => j.videoId === v.id && j.tabId === tabId),
        ...Object.values(dashes).filter((j) => j.videoId === v.id && j.tabId === tabId),
      ];
      const eligible = !matches.some(
        (j) => isActive(j.status) || j.status === "complete",
      );
      if (!eligible) continue;

      void chrome.runtime
        .sendMessage({ type: "download", tabId, videoId: v.id })
        .catch(() => {});
    }
  }

  function renderBody() {
    if (!loaded) {
      return (
        <p style={{ marginTop: 8, color: "#888" }}>Loading detected videos…</p>
      );
    }
    if (tabId === null) {
      return (
        <p style={{ marginTop: 8, color: "#888" }}>
          No active tab. Open this popup from a regular browser tab.
        </p>
      );
    }
    if (visibleVideos.length === 0) return <Empty />;
    return visibleVideos.map((v) => (
      <VideoCard key={v.id} v={v} tabId={tabId} settings={settings} />
    ));
  }

  return (
    <div
      style={{
        padding: 12,
        fontSize: 12,
        minWidth: 360,
        fontFamily: "-apple-system, system-ui, sans-serif",
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
        <h2 style={{ margin: 0, fontSize: 14 }}>ClipHutch</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              color: licensed ? "#2c5e2c" : atLimit ? "#a02a1f" : "#999",
              fontSize: 11,
              fontWeight: licensed || atLimit ? 600 : 400,
            }}
            title={licensed ? "Unlimited downloads (licensed)" : `Free tier: ${remaining} of ${FREE_DOWNLOAD_LIMIT} downloads left in the next 24h`}
          >
            {licensed ? "Licensed" : `${remaining}/${FREE_DOWNLOAD_LIMIT} left`}
          </span>
          <span style={{ color: "#ddd", fontSize: 11 }}>·</span>
          <span style={{ color: "#999", fontSize: 11 }}>
            {visibleVideos.length > 0 ? `${visibleVideos.length} detected` : ""}
          </span>
          {visibleVideos.length > 0 && (
            <button
              onClick={() => void downloadAll()}
              title="Download all detected videos (skips in-flight and already-saved)"
              style={{
                border: "1px solid #2c5e2c",
                background: "#fff",
                color: "#2c5e2c",
                borderRadius: 4,
                padding: "2px 8px",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              Download all
            </button>
          )}
          <button
            onClick={() => chrome.runtime.openOptionsPage()}
            title="Settings"
            aria-label="Settings"
            style={{
              border: "1px solid #ddd",
              background: "#fff",
              borderRadius: 4,
              padding: "2px 6px",
              cursor: "pointer",
              fontSize: 13,
              lineHeight: 1,
            }}
          >
            ⚙
          </button>
        </div>
      </div>
      {atLimit && (
        <div
          style={{
            marginTop: 10,
            padding: "8px 10px",
            background: "#fdecea",
            border: "1px solid #f3b6b0",
            borderRadius: 4,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 11, color: "#7a1f1a" }}>
            <strong>Daily limit reached.</strong> You've used all {FREE_DOWNLOAD_LIMIT} free downloads in the last 24 hours. Unlock unlimited downloads with a one-time payment of ${PRICE_USD}.
          </div>
          <button
            onClick={onUpgrade}
            title={`One-time payment of $${PRICE_USD} — no subscription`}
            style={{
              border: "1px solid #2c5e2c",
              background: "#2c5e2c",
              color: "#fff",
              borderRadius: 4,
              padding: "4px 10px",
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
      <div style={{ marginTop: 10 }}>{renderBody()}</div>
      <footer
        style={{
          marginTop: 12,
          color: "#999",
          fontSize: 10,
          borderTop: "1px solid #eee",
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
