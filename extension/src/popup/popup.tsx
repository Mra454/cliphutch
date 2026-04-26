import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DetectedVideo } from "../types";
import { getDetectedVideos } from "../lib/storage-session";
import { DEFAULT_SETTINGS, getSettings, type UserSettings } from "../lib/storage-local";

const DIRECT_JOBS_KEY = "download-jobs";
const HLS_JOBS_KEY = "hls-download-jobs";

type DirectJob = {
  videoId: string;
  tabId: number;
  downloadId: number;
  kind: DetectedVideo["kind"];
  startedAt: number;
  status: "in_progress" | "complete" | "interrupted";
  errorMessage?: string;
};

type HlsJob = {
  jobId: string;
  videoId: string;
  tabId: number;
  url: string;
  kind: "hls";
  startedAt: number;
  status: "running" | "saving" | "complete" | "error" | "cancelled";
  progress: { done: number; total: number; bytes: number };
  downloadId?: number;
  errorCode?: string;
  errorMessage?: string;
};

type AnyJob =
  | ({ source: "direct" } & DirectJob)
  | ({ source: "hls" } & HlsJob);

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

function displayName(v: DetectedVideo): string {
  return dispositionFilename(v.contentDisposition) ?? basename(v.url);
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

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const result = await chrome.storage.session.get([DIRECT_JOBS_KEY, HLS_JOBS_KEY]);
      const directs = (result[DIRECT_JOBS_KEY] as Record<string, DirectJob>) ?? {};
      const hlses = (result[HLS_JOBS_KEY] as Record<string, HlsJob>) ?? {};
      const matches: AnyJob[] = [];
      for (const j of Object.values(directs)) {
        if (j.videoId === v.id && j.tabId === tabId) matches.push({ source: "direct", ...j });
      }
      for (const j of Object.values(hlses)) {
        if (j.videoId === v.id && j.tabId === tabId) matches.push({ source: "hls", ...j });
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
      if (changes[DIRECT_JOBS_KEY] || changes[HLS_JOBS_KEY]) void refresh();
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

  const onDownload = async () => {
    setImmediateError(null);
    const res = (await chrome.runtime.sendMessage({
      type: "download",
      tabId,
      videoId: v.id,
    })) as { ok: true; downloadId?: number; jobId?: string } | { ok: false; error: string };
    if (res && !res.ok) setImmediateError(res.error);
  };

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

  function renderAction() {
    if (v.kind === "dash") {
      return (
        <button
          disabled
          style={{ ...buttonStyle, marginTop: 6, width: "100%" }}
          title="Detection only — download not supported in v1"
        >
          DASH detection only
        </button>
      );
    }

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

    // HLS branch
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
    // error
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

  useEffect(() => {
    let active = true;
    (async () => {
      const [tabs, s] = await Promise.all([
        chrome.tabs.query({ active: true, currentWindow: true }),
        getSettings(),
      ]);
      if (!active) return;
      setSettingsState(s);
      const id = tabs[0]?.id;
      if (id !== undefined) {
        setTabId(id);
        setVideos(await getDetectedVideos(id));
      }
      setLoaded(true);
    })();
    return () => {
      active = false;
    };
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
    if (videos.length === 0) return <Empty />;
    return videos.map((v) => (
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
        <h2 style={{ margin: 0, fontSize: 14 }}>Video Archive</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#999", fontSize: 11 }}>
            {videos.length > 0 ? `${videos.length} detected` : ""}
          </span>
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
        v{version} ·{" "}
        <a
          href="https://github.com/mra454/video-archive"
          target="_blank"
          rel="noreferrer"
          style={{ color: "#999" }}
          title="Open source repository"
        >
          GitHub
        </a>
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
