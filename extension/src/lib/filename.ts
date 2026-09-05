import type { DetectedVideo, MediaKind } from "../types";
import type { FilenameTemplate } from "./storage-local";
import { sanitizeDownloadStem, validateCustomDownloadStem } from "./download-path";

const RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5",
  "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5",
  "LPT6", "LPT7", "LPT8", "LPT9",
]);

const MAX_LEN = 200;

// Playlist/manifest extensions are never the saved container.
const STREAM_EXTS = new Set([".m3u8", ".mpd"]);
const DIRECT_CONTENT_TYPE_EXTS = new Map<string, string>([
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"],
  ["video/x-m4v", ".m4v"],
  ["video/x-matroska", ".mkv"],
  ["audio/mpeg", ".mp3"],
  ["audio/mp4", ".m4a"],
]);
const IMAGE_CONTENT_TYPE_EXTS = new Map<string, string>([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
  ["image/svg+xml", ".svg"],
  ["image/bmp", ".bmp"],
]);

export type InferFilenameOptions = {
  forcedExtension?: string;
  // The user's naming preference. "auto" (default) applies machine-noise
  // demotion; the other values force a specific source.
  template?: FilenameTemplate;
  // A resolution/quality label for the picked stream variant (e.g. "1080p").
  // Appended to the stem when it is not already present.
  variantLabel?: string;
  // Customer-authored stem. The media kind still controls the extension.
  customStem?: string;
  // Count of different visible videos on this page with the same cleaned page
  // title. Used only to avoid repeating a brand/site label as every filename.
  sharedTitleCount?: number;
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
  const extensionPolicy = mediaExtensionPolicy(video, forcedExt);
  const targetExt =
    firstAllowedExtension([dispExt, usableBasenameExt], extensionPolicy.allowed) ??
    extensionPolicy.fallback;

  const customStem = opts.customStem === undefined
    ? undefined
    : validateCustomDownloadStem(opts.customStem);
  let stem = customStem?.ok
    ? customStem.stem
    : pickStem(video, {
        disp,
        basename,
        template: opts.template ?? "auto",
        sharedTitleCount: opts.sharedTitleCount,
      });
  stem = appendVariantLabel(stem, opts.variantLabel);
  stem = sanitizeDownloadStem(stem, {
    fallback: fallbackStem(video.pageUrl ?? video.url),
    maxLength: MAX_LEN,
  });

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
  ctx: {
    disp?: string;
    basename?: string;
    template: FilenameTemplate;
    sharedTitleCount?: number;
  },
): string {
  const cleanedTitle = cleanTitle(video.pageTitle);
  const brandLikeTitle = cleanedTitle && titleLooksBrandLike({
    cleanedTitle,
    rawTitle: video.pageTitle,
    pageUrl: video.pageUrl,
    sharedTitleCount: ctx.sharedTitleCount,
  });
  const title = brandLikeTitle ? fallbackStem(video.pageUrl ?? video.url) : cleanedTitle;
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

function titleLooksBrandLike(input: {
  cleanedTitle: string;
  rawTitle?: string;
  pageUrl?: string;
  sharedTitleCount?: number;
}): boolean {
  if ((input.sharedTitleCount ?? 0) >= 2) return true;
  if (!input.pageUrl) return false;
  try {
    const url = new URL(input.pageUrl);
    const titleKey = titleKeyForComparison(input.cleanedTitle);
    const registrable = registrableLabel(url.hostname);
    if (registrable && titleKey === titleKeyForComparison(registrable)) return true;
    const fullHostSansTld = hostnameSansTld(url.hostname);
    return Boolean(fullHostSansTld && titleKey === titleKeyForComparison(fullHostSansTld));
  } catch {
    return false;
  }
}

function titleKeyForComparison(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function registrableLabel(hostname: string): string | undefined {
  const labels = hostname.toLocaleLowerCase("en-US").replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length === 0) return undefined;
  if (labels.length === 1) return labels[0];
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const commonSecondLevel = new Set(["co", "com", "net", "org", "gov", "edu"]);
  if (last.length === 2 && commonSecondLevel.has(second) && labels.length >= 3) {
    return labels[labels.length - 3];
  }
  return second;
}

function hostnameSansTld(hostname: string): string | undefined {
  const labels = hostname.toLocaleLowerCase("en-US").replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length === 0) return undefined;
  if (labels.length === 1) return labels[0];
  return labels.slice(0, -1).join(".");
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
  // Long unbroken alphanumeric mixing letters and digits with NO readable word
  // run: a random token (b3f9c2a17k2mq0x8). A 4+ letter run means a real name
  // like "BigBuckBunny1080p", so that is kept.
  if (
    LONG_ALNUM_BLOB.test(t) &&
    /\d/.test(t) &&
    /[A-Za-z]/.test(t) &&
    !/[A-Za-z]{4,}/.test(t)
  ) {
    return true;
  }
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

// Generic manifest stems, optionally suffixed with a quality/resolution token:
// video, playlist_high, hls_720, master-1080p, stream_2. These carry no signal.
const GENERIC_MANIFEST_STEM =
  /^(video|audio|stream|hls|dash|playlist|master|index|manifest|chunklist|chunk|media|prog|out|output|rendition|variant)([-_. ]?(hd|sd|hi|lo|high|low|main|src|source|\d{1,4}p?|\d+k))*$/i;

function isManifestBasename(name: string, _kind: MediaKind): boolean {
  const lower = name.toLowerCase();
  if (GENERIC_MANIFEST_NAMES.has(lower)) return true;
  const ext = extensionOf(lower);
  if (ext && STREAM_EXTS.has(ext)) {
    return GENERIC_MANIFEST_STEM.test(stripExtension(name));
  }
  return false;
}

// Video platforms whose name commonly trails a page title after a dash.
const PLATFORM_SUFFIXES = new Set([
  "youtube", "vimeo", "dailymotion", "twitch", "facebook", "tiktok",
  "twitter", "x", "instagram", "reddit", "wistia", "streamable", "rumble",
  "bitchute", "odysee", "loom", "vidyard", "brightcove", "jwplayer",
]);

export function cleanTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const t = title.trim();
  if (!t) return undefined;

  // A pipe almost always separates the title from a site brand: "Clip | Site".
  // Strip when the left side keeps real content and the right side is short.
  const pipe = t.match(/^(.*\S)\s+\|\s+([^|]{1,40})$/);
  if (pipe && pipe[1].trim().length >= 3 && wordCount(pipe[2]) <= 5) {
    return pipe[1].trim();
  }

  // A dash is ambiguous ("Title - Subtitle" vs "Title - Site"), so only strip
  // it when the right side is a known video platform.
  const dash = t.match(/^(.*\S)\s+[-–—]\s+([^-–—]+)$/);
  if (
    dash &&
    dash[1].trim().length >= 3 &&
    PLATFORM_SUFFIXES.has(dash[2].trim().toLowerCase())
  ) {
    return dash[1].trim();
  }

  return t;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
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
  const time = new Date().toISOString().slice(11, 16).replace(":", "");
  const host = hostSlug(rawUrl);
  return host ? `${host}-${date}-${time}` : `download-${date}-${time}`;
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

function normalizeContentType(value?: string): string | undefined {
  const type = value?.split(";")[0]?.trim().toLocaleLowerCase("en-US");
  return type || undefined;
}

function mediaExtensionPolicy(
  video: DetectedVideo,
  forcedExt: string | undefined,
): { fallback: string; allowed: ReadonlySet<string> } {
  if (forcedExt) {
    return { fallback: forcedExt, allowed: new Set([forcedExt]) };
  }
  if (video.kind === "hls" || video.kind === "dash") {
    return { fallback: ".mp4", allowed: new Set([".mp4"]) };
  }
  const contentType = normalizeContentType(video.contentType);
  if (video.kind === "image") {
    const fallback = contentType ? IMAGE_CONTENT_TYPE_EXTS.get(contentType) ?? ".jpg" : ".jpg";
    const allowed = contentType === "image/jpeg" || contentType === "image/jpg"
      ? new Set([".jpg", ".jpeg"])
      : new Set([fallback]);
    return { fallback, allowed };
  }
  const fallback = contentType ? DIRECT_CONTENT_TYPE_EXTS.get(contentType) ?? ".mp4" : ".mp4";
  return { fallback, allowed: new Set([fallback]) };
}

function firstAllowedExtension(
  candidates: Array<string | undefined>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return candidates.find((candidate): candidate is string =>
    candidate !== undefined && allowed.has(candidate)
  );
}
