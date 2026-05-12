import type { DetectedVideo, VideoKind } from "../types";

const RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5",
  "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5",
  "LPT6", "LPT7", "LPT8", "LPT9",
]);

const KIND_DEFAULT_EXT: Record<VideoKind, string> = {
  direct: ".mp4",
  hls: ".ts",
  dash: ".mp4",
};

const MAX_LEN = 200;

export type InferFilenameOptions = {
  forcedExtension?: string;
};

export function inferFilename(
  video: DetectedVideo,
  opts: InferFilenameOptions = {},
): string {
  const raw = pickRawName(video);

  const forcedExt = normalizeExt(opts.forcedExtension);
  const targetExt =
    forcedExt ?? extensionOf(raw) ?? KIND_DEFAULT_EXT[video.kind] ?? ".mp4";

  let stem = stripExtension(raw);
  stem = stem.replace(/[. ]+$/, "");
  stem = sanitize(stem);

  if (stem && RESERVED_NAMES.has(stem.toUpperCase())) {
    stem = "_" + stem;
  }

  if (!stem) stem = fallbackStem();

  const fullName = stem + targetExt;
  if (fullName.length > MAX_LEN) {
    stem = stem.slice(0, MAX_LEN - targetExt.length).replace(/[. ]+$/, "");
    if (!stem) stem = fallbackStem().slice(0, MAX_LEN - targetExt.length);
  }

  return stem + targetExt;
}

function pickRawName(video: DetectedVideo): string {
  const fromDisposition = parseContentDisposition(video.contentDisposition);
  if (fromDisposition) return fromDisposition;

  const basename = urlBasename(video.url);
  // For stream manifests the URL basename is almost always a generic
  // playlist/master/index.m3u8 or manifest.mpd that tells the user nothing
  // about the video. Prefer the page title when one is available.
  const basenameIsManifest = basename !== undefined && isManifestBasename(basename, video.kind);
  if (basename && !basenameIsManifest) return basename;

  const fromTitle = cleanTitle(video.pageTitle);
  if (fromTitle) return fromTitle;

  return basename ?? fallbackStem();
}

// Generic CDN manifest filenames that carry no signal about the video.
// Named manifests (e.g. "movie-clip.m3u8") still win over pageTitle.
const GENERIC_MANIFEST_NAMES = new Set([
  "playlist.m3u8",
  "master.m3u8",
  "index.m3u8",
  "chunklist.m3u8",
  "video.m3u8",
  "manifest.mpd",
]);

function isManifestBasename(name: string, _kind: VideoKind): boolean {
  return GENERIC_MANIFEST_NAMES.has(name.toLowerCase());
}

export function parseContentDisposition(cd?: string): string | undefined {
  if (!cd) return undefined;
  const star = cd.match(/filename\*\s*=\s*([^;]+)/i);
  if (star) {
    const raw = star[1].trim();
    const m = raw.match(/^([A-Za-z0-9-]+)'([A-Za-z-]*)'(.+)$/);
    if (m) {
      try {
        return decodeURIComponent(m[3]);
      } catch {
        // fall through to plain
      }
    }
  }
  const plain = cd.match(/filename\s*=\s*"?([^";\r\n]+)"?/i);
  if (plain) return plain[1].trim();
  return undefined;
}

function urlBasename(rawUrl: string): string | undefined {
  try {
    const u = new URL(rawUrl);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (!last) return undefined;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return undefined;
  }
}

function cleanTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const trimmed = title.trim();
  return trimmed || undefined;
}

function fallbackStem(): string {
  return `video-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function extensionOf(name: string): string | undefined {
  const m = name.match(/(\.[A-Za-z0-9]{1,5})$/);
  return m ? m[1].toLowerCase() : undefined;
}

function stripExtension(name: string): string {
  const ext = extensionOf(name);
  if (!ext) return name;
  return name.slice(0, name.length - ext.length);
}

function normalizeExt(ext?: string): string | undefined {
  if (!ext) return undefined;
  return ext.startsWith(".") ? ext.toLowerCase() : "." + ext.toLowerCase();
}

function sanitize(s: string): string {
  let out = s.normalize("NFC");
  out = out.replace(/\.\.+[\\/]?/g, "_");
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
  return out.trim();
}
