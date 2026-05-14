import type { DetectedVideo } from "../types";

function normalizedContentType(v: DetectedVideo): string | undefined {
  return v.contentType?.split(";")[0].trim().toLowerCase();
}

function extensionFromUrl(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).pathname.split(".").pop()?.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isWebmDirectVideo(v: DetectedVideo): boolean {
  if (v.kind !== "direct") return false;
  if (normalizedContentType(v) === "video/webm") return true;
  return extensionFromUrl(v.url) === "webm";
}

export function isStillImage(v: DetectedVideo): boolean {
  return v.kind === "image";
}
