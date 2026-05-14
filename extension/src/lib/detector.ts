import type { MediaKind } from "../types";

export type Classification = {
  kind: MediaKind | "segment" | "unknown";
  confidence: "high" | "low";
};

const DIRECT_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ogv"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);
const HLS_EXT = new Set([".m3u8"]);
const DASH_EXT = new Set([".mpd"]);
const SEGMENT_EXT = new Set([".ts", ".m4s", ".cmfv", ".cmfa"]);

const HLS_MIMES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
]);
const DASH_MIMES = new Set(["application/dash+xml"]);
const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
]);

function pathExtension(rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return null;
  }
  const lastSegment = pathname.split("/").pop() ?? "";
  const dot = lastSegment.lastIndexOf(".");
  if (dot <= 0) return null;
  return lastSegment.slice(dot).toLowerCase();
}

function normalizeContentType(ct?: string): string | undefined {
  if (!ct) return undefined;
  return ct.split(";")[0].trim().toLowerCase();
}

export function classifyUrl(url: string, contentType?: string): Classification {
  const ext = pathExtension(url);
  const ct = normalizeContentType(contentType);

  if (ct) {
    if (HLS_MIMES.has(ct)) return { kind: "hls", confidence: "high" };
    if (DASH_MIMES.has(ct)) return { kind: "dash", confidence: "high" };
    if (IMAGE_MIMES.has(ct)) return { kind: "image", confidence: "high" };
    if (ct.startsWith("video/")) {
      if (ext && SEGMENT_EXT.has(ext)) return { kind: "segment", confidence: "high" };
      return { kind: "direct", confidence: "high" };
    }
    if (ext && (DIRECT_EXT.has(ext) || IMAGE_EXT.has(ext) || HLS_EXT.has(ext) || DASH_EXT.has(ext))) {
      return { kind: "unknown", confidence: "low" };
    }
  }

  if (ext) {
    if (SEGMENT_EXT.has(ext)) return { kind: "segment", confidence: "high" };
    if (DIRECT_EXT.has(ext)) return { kind: "direct", confidence: "high" };
    if (IMAGE_EXT.has(ext)) return { kind: "image", confidence: "high" };
    if (HLS_EXT.has(ext)) return { kind: "hls", confidence: "high" };
    if (DASH_EXT.has(ext)) return { kind: "dash", confidence: "high" };
  }

  return { kind: "unknown", confidence: "low" };
}
