import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DetectedVideo } from "../types";
import { getDetectedVideos } from "../lib/storage-session";

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
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) return decodeURIComponent(star[1].trim());
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : undefined;
}

function displayName(v: DetectedVideo): string {
  return dispositionFilename(v.contentDisposition) ?? basename(v.url);
}

const KIND_BADGE: Record<string, string> = {
  direct: "VIDEO",
  hls: "HLS",
  dash: "DASH",
};

function badgeText(v: DetectedVideo): string {
  if (v.kind !== "direct") return KIND_BADGE[v.kind] ?? v.kind.toUpperCase();
  const ext = (() => {
    try {
      return new URL(v.url).pathname.split(".").pop()?.toUpperCase() ?? "VIDEO";
    } catch {
      return "VIDEO";
    }
  })();
  return ext.length <= 5 ? ext : "VIDEO";
}

function fmtBytes(n?: number): string | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
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

function VideoCard({ v }: { v: DetectedVideo }) {
  const [showFull, setShowFull] = useState(false);
  const size = fmtBytes(v.sizeBytes);
  const isDash = v.kind === "dash";

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
        <strong style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
      {size !== undefined && (
        <div style={{ color: "#888", fontSize: 11, marginTop: 2 }}>{size}</div>
      )}
      <div
        style={{
          color: "#666",
          fontSize: 10,
          wordBreak: "break-all",
          marginTop: 4,
        }}
      >
        {urlDisplay(v.url, showFull)}{" "}
        <button
          onClick={() => setShowFull((s) => !s)}
          style={{ marginLeft: 4, fontSize: 10, padding: "0 4px", cursor: "pointer" }}
        >
          {showFull ? "hide" : "show full URL"}
        </button>
      </div>
      {isDash ? (
        <button
          disabled
          style={{ marginTop: 6, fontSize: 11, padding: "3px 8px", width: "100%" }}
          title="Detection only — download not supported in v1"
        >
          DASH detection only
        </button>
      ) : (
        <button
          onClick={() => console.log("[video-archive] download requested:", v.id, v.kind)}
          style={{ marginTop: 6, fontSize: 11, padding: "3px 8px", cursor: "pointer" }}
        >
          Download
        </button>
      )}
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
    <div style={{ padding: 12, fontSize: 12, minWidth: 360, fontFamily: "-apple-system, system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>Video Archive</h2>
        <span style={{ color: "#999", fontSize: 11 }}>
          {videos.length > 0 ? `${videos.length} detected` : ""}
        </span>
      </div>
      <div style={{ marginTop: 10 }}>
        {videos.length === 0 ? <Empty /> : videos.map((v) => <VideoCard key={v.id} v={v} />)}
      </div>
      <footer style={{ marginTop: 12, color: "#999", fontSize: 10, borderTop: "1px solid #eee", paddingTop: 6 }}>
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
