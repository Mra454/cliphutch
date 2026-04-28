// When an HLS or DASH manifest is detected on a tab, the page's player
// typically also fetches every individual segment / variant Representation
// from the same directory. webRequest sees those segment fetches and the
// detector surfaces each as a standalone "direct" video. With multi-bitrate
// streams the popup explodes into dozens of segment entries, and users
// click them thinking they're full videos — but each segment is just a
// chunk (or a video-only Representation, in single-file-profile DASH),
// not the full content.
//
// Heuristic: when a manifest URL is detected on the same tab, hide direct
// video entries whose URL shares the manifest's directory prefix. The
// .mpd / .m3u8 entry remains visible so the user can route through our
// proper download flow (which fetches manifest, picks variant, muxes).
//
// Trade-off: a legitimate direct video in the same directory as a
// manifest gets suppressed too. Rare in practice on real DASH/HLS pages
// (segments and unrelated assets typically don't co-exist), and the cost
// of a false positive (one missing entry) is much smaller than the cost
// of a false negative (popup with 25+ confusing entries).

import type { DetectedVideo } from "../types";

export function manifestDirectoryPrefix(url: string): string | null {
  try {
    const u = new URL(url);
    const lastSlash = u.pathname.lastIndexOf("/");
    if (lastSlash < 0) return null;
    return u.origin + u.pathname.slice(0, lastSlash + 1);
  } catch {
    return null;
  }
}

export function filterCoveredByManifests(videos: DetectedVideo[]): DetectedVideo[] {
  const prefixes: string[] = [];
  for (const v of videos) {
    if (v.kind !== "hls" && v.kind !== "dash") continue;
    const prefix = manifestDirectoryPrefix(v.url);
    if (prefix) prefixes.push(prefix);
  }
  if (prefixes.length === 0) return videos;

  return videos.filter((v) => {
    // Always keep manifests visible — they're the entry point we want users
    // to click.
    if (v.kind !== "direct") return true;
    return !prefixes.some((prefix) => v.url.startsWith(prefix));
  });
}
