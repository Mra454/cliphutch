import type { DetectedVideo, MediaKind } from "../types";
import type { FilenameTemplate } from "./storage-local";

const RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5",
  "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5",
  "LPT6", "LPT7", "LPT8", "LPT9",
]);

const KIND_DEFAULT_EXT: Record<MediaKind, string> = {
  direct: ".mp4",
  // HLS is always assembled and muxed into an MP4 before saving now; the disk
  // save path forces ".mp4" via forcedExtension, but this default matters for
  // the display-name path in the popup, so it must not say ".ts".
  hls: ".mp4",
  dash: ".mp4",
  image: ".jpg",
};

const MAX_LEN = 200;

// Playlist/manifest extensions are never the saved container.
const STREAM_EXTS = new Set([".m3u8", ".mpd"]);

export type InferFilenameOptions = {
  forcedExtension?: string;
  // The user's naming preference. "auto" (default) applies machine-noise
  // demotion; the other values force a specific source.
  template?: FilenameTemplate;
  // A resolution/quality label for the picked stream variant (e.g. "1080p").
  // Appended to the stem when it is not already present.
  variantLabel?: string;
};

export function inferFilename(
  video: DetectedVideo,
  opts: InferFilenameOptions = {},
): string {
  const disp = parseContentDisposition(video.contentDisposition);
  const basename = urlBasename(video.url);

  // The extension comes from the most authoritative source available and is
  // independent of which stem we pick for readability, so a noisy basename
  // never costs us the correct file type. Manifest extensions (.m3u8/.mpd) are
  // never the container the file saves as, so they are excluded here.
  const forcedExt = normalizeExt(opts.forcedExtension);
  const dispExt = disp ? extensionOf(disp) : undefined;
  const basenameExt = basename ? extensionOf(basename) : undefined;
  const usableBasenameExt =
    basenameExt && !STREAM_EXTS.has(basenameExt) ? basenameExt : undefined;
  const targetExt =
    forcedExt ??
    dispExt ??
    usableBasenameExt ??
    KIND_DEFAULT_EXT[video.kind] ??
    ".mp4";

  let stem = pickStem(video, { disp, basename, template: opts.template ?? "auto" });
  stem = appendVariantLabel(stem, opts.variantLabel);
  stem = stem.replace(/[. ]+$/, "");
  stem = sanitize(stem);

  if (stem && RESERVED_NAMES.has(stem.toUpperCase())) {
    stem = "_" + stem;
  }

  if (!stem) stem = fallbackStem(video.url);

  const fullName = stem + targetExt;
  if (fullName.length > MAX_LEN) {
    stem = stem.slice(0, MAX_LEN - targetExt.length).replace(/[. ]+$/, "");
    if (!stem) stem = fallbackStem(video.url).slice(0, MAX_LEN - targetExt.length);
  }

  return stem + targetExt;
}

function pickStem(
  video: DetectedVideo,
  ctx: { disp?: string; basename?: string; template: FilenameTemplate },
): string {
  const title = cleanTitle(video.pageTitle);
  const dispStem = ctx.disp ? stripExtension(ctx.disp) : undefined;
  const basenameStem = ctx.basename ? stripExtension(ctx.basename) : undefined;
  const basenameIsManifest =
    ctx.basename !== undefined && isManifestBasename(ctx.basename, video.kind);

  switch (ctx.template) {
    case "timestamp":
      return fallbackStem(video.url);
    case "pageTitle":
      return title ?? basenameStem ?? dispStem ?? fallbackStem(video.url);
    case "urlBasename":
      if (basenameStem && !basenameIsManifest) return basenameStem;
      return dispStem ?? title ?? fallbackStem(video.url);
    case "auto":
    default: {
      // Content-Disposition is the server's explicit filename; trust it unless
      // the server itself sent a machine-generated stem.
      if (dispStem && !looksLikeMachineName(dispStem)) return dispStem;
      if (
        basenameStem !== undefined &&
        !basenameIsManifest &&
        !looksLikeMachineName(basenameStem)
      ) {
        return basenameStem;
      }
      if (title) return title;
      // Everything available is a hash, a bare manifest, or generic; a
      // host+date name beats "playlist" or "8f3a2b1c".
      return fallbackStem(video.url);
    }
  }
}

// Segment/manifest artifacts and placeholder stems that carry no signal about
// the media. Deliberately narrow: common English words like "video" are NOT
// here, so a URL ending in /video keeps its name.
const GENERIC_STEM_TOKENS = new Set([
  "index", "output", "master", "playlist", "chunklist", "manifest",
  "seg", "segment", "frag", "fragment", "chunk", "init",
  "default", "untitled", "temp", "tmp",
]);

const CAMERA_DEFAULT = /^(img|dsc|vid|mvi|dcim|pxl|mov|gopr|dji)[-_]?\d+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_BLOB = /^[0-9a-f]{8,}$/i;
const LONG_ALNUM_BLOB = /^[A-Za-z0-9]{16,}$/;

// A single token that reads as machine output rather than a word.
function isMachineToken(t: string): boolean {
  if (GENERIC_STEM_TOKENS.has(t.toLowerCase())) return true;
  if (CAMERA_DEFAULT.test(t)) return true;
  if (UUID_RE.test(t)) return true;
  if (/^\d{3,}$/.test(t)) return true; // bare number / resolution (720, 4423897)
  if (HEX_BLOB.test(t) && /\d/.test(t)) return true; // hex hash containing a digit
  // Long unbroken alphanumeric mixing letters and digits: random token.
  if (LONG_ALNUM_BLOB.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t)) return true;
  return false;
}

// A token a person would read as a word (a run of >=3 letters, not itself a
// machine token like a hex string that happens to contain letters).
function isWordToken(t: string): boolean {
  if (!/[A-Za-z]{3,}/.test(t)) return false;
  return !isMachineToken(t);
}

// True when a basename stem looks machine-generated (hashes, UUIDs, CDN ids,
// camera defaults, bare numbers, generic segment names) rather than a name a
// person would recognize. Conservative: any separator-delimited word keeps it.
export function looksLikeMachineName(stem: string): boolean {
  const s = stem.trim();
  if (!s) return true;
  if (isMachineToken(s)) return true;
  // Separator-split shapes like "b3f9c2a1_720" (hash + resolution) have no
  // human word among their parts.
  const tokens = s.split(/[-_. ]+/).filter(Boolean);
  if (tokens.length > 1 && !tokens.some(isWordToken)) return true;
  return false;
}

function appendVariantLabel(stem: string, label?: string): string {
  const clean = label?.trim();
  if (!clean) return stem;
  // Skip if the stem already carries the resolution (e.g. "clip-1080p").
  const normalized = clean.toLowerCase();
  if (stem.toLowerCase().includes(normalized)) return stem;
  return `${stem} ${clean}`;
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

function isManifestBasename(name: string, _kind: MediaKind): boolean {
  return GENERIC_MANIFEST_NAMES.has(name.toLowerCase());
}

function cleanTitle(title?: string): string | undefined {
  if (!title) return undefined;
  let t = title.trim();
  if (!t) return undefined;
  // Drop a trailing site-name suffix: "Clip Name | Site", "Clip Name - Site".
  // Only strip when the left side keeps real content, so "A - B" style titles
  // that are themselves the name are preserved.
  const m = t.match(/^(.*\S)\s+[|–—-]\s+[^|–—-]+$/);
  if (m && m[1].trim().length >= 3) t = m[1].trim();
  return t || undefined;
}

function hostSlug(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    const slug = host.replace(/[^A-Za-z0-9.-]/g, "").replace(/\./g, "-");
    return slug || undefined;
  } catch {
    return undefined;
  }
}

function fallbackStem(rawUrl?: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const host = hostSlug(rawUrl);
  return host ? `${host}-${date}` : `download-${date}`;
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
