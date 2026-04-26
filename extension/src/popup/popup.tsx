import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DetectedVideo } from "../types";
import { getDetectedVideos } from "../lib/storage-session";

const DOWNLOAD_JOBS_KEY = "download-jobs";

type DownloadStatus = "in_progress" | "complete" | "interrupted";

type DownloadJob = {
  videoId: string;
  tabId: number;
  downloadId: number;
  kind: DetectedVideo["kind"];
  startedAt: number;
  status: DownloadStatus;
  errorMessage?: string;
};

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

const buttonStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "3px 8px",
  cursor: "pointer",
};

function VideoCard({ v, tabId }: { v: DetectedVideo; tabId: number }) {
  const [showFull, setShowFull] = useState(false);
  const [job, setJob] = useState<DownloadJob | null>(null);
  const [progress, setProgress] = useState<{ received: number; total?: number } | null>(null);
  const [immediateError, setImmediateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const result = await chrome.storage.session.get(DOWNLOAD_JOBS_KEY);
      const jobs = (result[DOWNLOAD_JOBS_KEY] as Record<string, DownloadJob>) ?? {};
      const matches = Object.values(jobs)
        .filter((j) => j.videoId === v.id && j.tabId === tabId)
        .sort((a, b) => b.startedAt - a.startedAt);
      if (!cancelled) setJob(matches[0] ?? null);
    };

    void refresh();

    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === "session" && changes[DOWNLOAD_JOBS_KEY]) void refresh();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [v.id, tabId]);

  useEffect(() => {
    if (!job || job.status !== "in_progress") {
      setProgress(null);
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
          setProgress({
            received: item.bytesReceived,
            total: item.totalBytes > 0 ? item.totalBytes : undefined,
          });
          timer = setTimeout(tick, 750);
        }
      } catch {
        // ignore polling errors
      }
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [job?.status, job?.downloadId]);

  const onDownload = async () => {
    setImmediateError(null);
    const res = (await chrome.runtime.sendMessage({
      type: "download",
      tabId,
      videoId: v.id,
    })) as { ok: true; downloadId: number } | { ok: false; error: string };
    if (res && !res.ok) setImmediateError(res.error);
  };

  const onShowInFolder = () => {
    if (job) chrome.downloads.show(job.downloadId);
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
      const isUnsupportedHls = v.kind === "hls";
      return (
        <button
          onClick={onDownload}
          style={{ ...buttonStyle, marginTop: 6 }}
          title={isUnsupportedHls ? "HLS download arrives in Session 5" : undefined}
        >
          Download
        </button>
      );
    }

    if (job.status === "in_progress") {
      const total = progress?.total;
      const received = progress?.received ?? 0;
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

  useEffect(() => {
    let active = true;
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const id = tabs[0]?.id;
      if (!active || id === undefined) return;
      setTabId(id);
      setVideos(await getDetectedVideos(id));
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

  return (
    <div
      style={{
        padding: 12,
        fontSize: 12,
        minWidth: 360,
        fontFamily: "-apple-system, system-ui, sans-serif",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>Video Archive</h2>
        <span style={{ color: "#999", fontSize: 11 }}>
          {videos.length > 0 ? `${videos.length} detected` : ""}
        </span>
      </div>
      <div style={{ marginTop: 10 }}>
        {videos.length === 0 || tabId === null ? (
          <Empty />
        ) : (
          videos.map((v) => <VideoCard key={v.id} v={v} tabId={tabId} />)
        )}
      </div>
      <footer
        style={{
          marginTop: 12,
          color: "#999",
          fontSize: 10,
          borderTop: "1px solid #eee",
          paddingTop: 6,
        }}
      >
        v0.1.0 ·{" "}
        <a
          href="#"
          onClick={(e) => e.preventDefault()}
          style={{ color: "#999" }}
          title="TODO_LINK — set in a later session"
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
