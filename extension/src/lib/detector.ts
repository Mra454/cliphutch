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
const SEGMENT_MIMES = new Set([
  "video/mp2t",
  "audio/mp2t",
  "video/iso.segment",
  "audio/iso.segment",
]);
const GENERIC_BINARY_MIMES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/force-download",
]);
const HTML_MIMES = new Set(["text/html", "application/xhtml+xml"]);
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

function classifyExtension(ext: string | null): Classification | undefined {
  if (!ext) return undefined;
  if (SEGMENT_EXT.has(ext)) return { kind: "segment", confidence: "high" };
  if (DIRECT_EXT.has(ext)) return { kind: "direct", confidence: "high" };
  if (IMAGE_EXT.has(ext)) return { kind: "image", confidence: "high" };
  if (HLS_EXT.has(ext)) return { kind: "hls", confidence: "high" };
  if (DASH_EXT.has(ext)) return { kind: "dash", confidence: "high" };
  return undefined;
}

export function classifyUrl(url: string, contentType?: string): Classification {
  const ext = pathExtension(url);
  const ct = normalizeContentType(contentType);
  const extensionClassification = classifyExtension(ext);

  if (ct) {
    if (HLS_MIMES.has(ct)) return { kind: "hls", confidence: "high" };
    if (DASH_MIMES.has(ct)) return { kind: "dash", confidence: "high" };
    if (IMAGE_MIMES.has(ct)) return { kind: "image", confidence: "high" };
    if (SEGMENT_MIMES.has(ct)) return { kind: "segment", confidence: "high" };
    if (ct.startsWith("video/")) {
      if (ext && SEGMENT_EXT.has(ext)) return { kind: "segment", confidence: "high" };
      return { kind: "direct", confidence: "high" };
    }

    // HTML is commonly an auth/error document served from a media-looking
    // URL. It must remain authoritative so an .mp4 error page is never
    // offered as a video. Generic binary types carry no such information,
    // so a known URL extension is the stronger signal.
    if (HTML_MIMES.has(ct)) return { kind: "unknown", confidence: "low" };
    if (GENERIC_BINARY_MIMES.has(ct) && extensionClassification) {
      return extensionClassification;
    }

    // CDNs frequently serve manifest files as text/plain. Restrict this
    // fallback to manifest extensions; text/plain must not make an arbitrary
    // .mp4 URL look like a valid media response.
    if (ct === "text/plain" && extensionClassification) {
      if (extensionClassification.kind === "hls" || extensionClassification.kind === "dash") {
        return extensionClassification;
      }
      return { kind: "unknown", confidence: "low" };
    }

    if (extensionClassification) return { kind: "unknown", confidence: "low" };
  }

  if (extensionClassification) return extensionClassification;

  return { kind: "unknown", confidence: "low" };
}
