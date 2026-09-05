import type { DetectedVideo } from "../types";

/**
 * A conservative presentation classifier for obvious stream parts.
 *
 * Directory co-location alone is never evidence that a direct file belongs to
 * a manifest: sites commonly keep a downloadable MP4 beside an HLS/DASH
 * manifest. Only extensions dedicated to segmented delivery and explicit init
 * segment names are collapsed by default, and callers must keep the covered
 * list available behind a visible “show stream parts” control.
 */

const DEDICATED_SEGMENT_EXTENSIONS = new Set(["ts", "m4s", "cmfv", "cmfa"]);
const INIT_SEGMENT_PATTERN = /^(?:init|initialization)(?:[-_.][^/]*)?\.(?:mp4|m4v)$/i;
const MASTER_LIKE_HLS_STEMS = new Set(["master", "index", "playlist", "manifest", "main"]);

export type ManifestCoveragePartition = {
  visible: DetectedVideo[];
  covered: DetectedVideo[];
};

export function manifestDirectoryPrefix(url: string): string | null {
  try {
    const parsed = new URL(url);
    const lastSlash = parsed.pathname.lastIndexOf("/");
    if (lastSlash < 0) return null;
    return parsed.origin + parsed.pathname.slice(0, lastSlash + 1);
  } catch {
    return null;
  }
}

function likelyStreamPart(url: string): boolean {
  try {
    const basename = new URL(url).pathname.split("/").pop() ?? "";
    const extension = basename.includes(".") ? basename.split(".").pop()?.toLowerCase() : undefined;
    return Boolean(
      (extension && DEDICATED_SEGMENT_EXTENSIONS.has(extension)) ||
      INIT_SEGMENT_PATTERN.test(basename),
    );
  } catch {
    return false;
  }
}

function queryRedactedUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function hasHlsChildren(video: DetectedVideo): boolean {
  return video.kind === "hls" && Array.isArray(video.childUrls) && video.childUrls.length > 0;
}

function isMasterLikeHlsRecord(video: DetectedVideo): boolean {
  if (video.kind !== "hls") return false;
  try {
    const basename = new URL(video.url).pathname.split("/").pop() ?? "";
    const stem = basename.includes(".")
      ? basename.slice(0, basename.lastIndexOf("."))
      : basename;
    return MASTER_LIKE_HLS_STEMS.has(stem.toLowerCase());
  } catch {
    return false;
  }
}

function isKnownHlsMaster(video: DetectedVideo): boolean {
  return video.kind === "hls" && (
    hasHlsChildren(video) ||
    video.parsedAsMaster === true ||
    isMasterLikeHlsRecord(video)
  );
}

function strictDirectoryPrefix(parent: string, child: string): boolean {
  return child.startsWith(parent) && child.length > parent.length;
}

export function partitionCoveredByManifests(
  videos: readonly DetectedVideo[],
): ManifestCoveragePartition {
  const prefixes = videos.flatMap((video) => {
    if (video.kind !== "hls" && video.kind !== "dash") return [];
    const prefix = manifestDirectoryPrefix(video.url);
    return prefix ? [prefix] : [];
  });
  const hlsDirectories = videos.flatMap((video) => {
    if (video.kind !== "hls") return [];
    const directory = manifestDirectoryPrefix(video.url);
    return directory ? [{ video, directory }] : [];
  });
  const exactHlsChildUrls = new Set(
    videos.flatMap((video) =>
      video.kind === "hls" && video.childUrls
        ? video.childUrls.flatMap((childUrl) => queryRedactedUrl(childUrl) ?? [])
        : []
    ),
  );
  if (prefixes.length === 0) return { visible: [...videos], covered: [] };

  const visible: DetectedVideo[] = [];
  const covered: DetectedVideo[] = [];
  for (const video of videos) {
    const candidateHlsDirectory = video.kind === "hls" ? manifestDirectoryPrefix(video.url) : null;
    const redactedCandidateUrl = video.kind === "hls" ? queryRedactedUrl(video.url) : null;
    const exactListedHlsChild = redactedCandidateUrl !== null &&
      exactHlsChildUrls.has(redactedCandidateUrl) &&
      !hasHlsChildren(video) &&
      video.parsedAsMaster !== true;
    const isCovered = video.kind === "direct" && likelyStreamPart(video.url) &&
      prefixes.some((prefix) => video.url.startsWith(prefix)) ||
      (
        video.kind === "hls" &&
        (
          exactListedHlsChild ||
          (
            !isKnownHlsMaster(video) &&
            candidateHlsDirectory !== null &&
            hlsDirectories.some((parent) =>
              parent.video !== video &&
              strictDirectoryPrefix(parent.directory, candidateHlsDirectory))
          )
        )
      );
    (isCovered ? covered : visible).push(video);
  }
  return { visible, covered };
}

/** Backward-compatible default shelf projection. */
export function filterCoveredByManifests(videos: DetectedVideo[]): DetectedVideo[] {
  return partitionCoveredByManifests(videos).visible;
}
