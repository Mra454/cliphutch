const DEFAULT_SEGMENT_LIMIT = 96;
const DEFAULT_FILENAME_LIMIT = 140;
const DEFAULT_PATH_LIMIT = 240;
const PACK_ROOT = "ClipHutch";

const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const BIDI_CONTROL_TEST_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x1f\x7f-\x9f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_TEST_PATTERN = /[\x00-\x1f\x7f-\x9f]/;
const INVALID_SEGMENT_PATTERN = /[\\/:*?"<>|]/g;
const INVALID_SEGMENT_TEST_PATTERN = /[\\/:*?"<>|]/;
const WINDOWS_RESERVED_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const CUSTOM_DOWNLOAD_STEM_EDGE_REASON =
  "Titles cannot start with a dot or end with a dot or space.";

export const CUSTOM_DOWNLOAD_STEM_LIMIT = DEFAULT_FILENAME_LIMIT;

export type CustomDownloadStemValidation =
  | { ok: true; stem: string }
  | { ok: false; reason: string };

export type DownloadPathOptions = {
  packName: string;
  pageHost?: string;
  pageTitle?: string;
  filename: string;
  includePageFolder?: boolean;
  maxPathLength?: number;
};

function truncateCodePoints(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const points = Array.from(value);
  return points.length <= maxLength ? value : points.slice(0, maxLength).join("");
}

function validPathLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 80 && value <= 1024;
}

function cleanSegment(value: string): string {
  return value
    .normalize("NFC")
    .replace(BIDI_CONTROL_PATTERN, "")
    .replace(CONTROL_PATTERN, "_")
    .replace(INVALID_SEGMENT_PATTERN, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^\.+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
}

function normalizeSegmentLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function fitUsableSegment(value: string, fallback: string, maxLength: number): string {
  const candidates = [value, cleanSegment(fallback), "untitled", "item"];
  for (const candidate of candidates) {
    let next = truncateCodePoints(candidate, maxLength).replace(/[. ]+$/g, "");
    if (!next || next === "." || next === "..") continue;
    if (WINDOWS_RESERVED_PATTERN.test(next)) {
      next = maxLength === 1
        ? "_"
        : `_${truncateCodePoints(next, maxLength - 1)}`.replace(/[. ]+$/g, "");
    }
    if (next && next !== "." && next !== ".." && !WINDOWS_RESERVED_PATTERN.test(next)) {
      return next;
    }
  }
  return "_";
}

export function sanitizePathSegment(
  value: string,
  options: { fallback?: string; maxLength?: number } = {},
): string {
  const fallback = options.fallback ?? "untitled";
  const maxLength = normalizeSegmentLimit(options.maxLength, DEFAULT_SEGMENT_LIMIT);
  const raw = String(value ?? "");
  const traversalOnly = raw.trim() === "." || raw.trim() === "..";
  return fitUsableSegment(cleanSegment(traversalOnly ? "" : raw), fallback, maxLength);
}

export function sanitizeDownloadStem(
  value: string,
  options: { fallback?: string; maxLength?: number } = {},
): string {
  const fallback = options.fallback ?? "download";
  const maxLength = normalizeSegmentLimit(options.maxLength, DEFAULT_FILENAME_LIMIT);
  const raw = String(value ?? "")
    .normalize("NFC")
    .replace(BIDI_CONTROL_PATTERN, "")
    .replace(CONTROL_PATTERN, "_")
    .trim()
    .replace(/[. ]+$/g, "")
    .replace(/\.\.+[\\/]?/g, "_")
    .replace(INVALID_SEGMENT_PATTERN, "_")
    .replace(/^\.+/g, "_");
  return fitUsableSegment(raw, fallback, maxLength);
}

function splitFilename(filename: string): { stem: string; extension: string } {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return { stem: filename, extension: "" };
  }
  const extension = filename.slice(lastDot);
  if (!/^\.[a-z0-9]{1,12}$/i.test(extension)) {
    return { stem: filename, extension: "" };
  }
  return { stem: filename.slice(0, lastDot), extension };
}

export function sanitizeDownloadFilename(
  value: string,
  options: { fallback?: string; maxLength?: number } = {},
): string {
  const fallback = options.fallback ?? "download";
  const maxLength = Math.max(8, normalizeSegmentLimit(options.maxLength, DEFAULT_FILENAME_LIMIT));
  const cleaned = sanitizePathSegment(value, { fallback, maxLength: Math.max(maxLength, 256) });
  const { stem, extension } = splitFilename(cleaned);
  const stemLimit = Math.max(1, maxLength - Array.from(extension).length);
  const safeStem = sanitizeDownloadStem(stem, { fallback, maxLength: stemLimit });
  return `${safeStem}${extension}`;
}

export function validateCustomDownloadStem(value: string): CustomDownloadStemValidation {
  const raw = String(value ?? "").normalize("NFC");
  const trimmed = raw.trim();
  if (Array.from(trimmed).length > CUSTOM_DOWNLOAD_STEM_LIMIT) {
    return { ok: false, reason: "Titles must be 140 characters or fewer." };
  }
  if (BIDI_CONTROL_TEST_PATTERN.test(raw) || CONTROL_TEST_PATTERN.test(raw)) {
    return {
      ok: false,
      reason: "Remove control or direction-formatting characters from this title.",
    };
  }
  if (/[\\/]/.test(trimmed)) {
    return { ok: false, reason: "Titles cannot contain path separators." };
  }
  if (INVALID_SEGMENT_TEST_PATTERN.test(trimmed)) {
    return { ok: false, reason: "Titles cannot contain characters Chrome rejects in filenames." };
  }
  if (!/[\p{L}\p{N}]/u.test(trimmed) || trimmed === "." || trimmed === "..") {
    return { ok: false, reason: "Use at least one letter or number in this title." };
  }
  if (trimmed.startsWith(".") || raw.trimEnd() !== raw || trimmed.endsWith(".")) {
    return { ok: false, reason: CUSTOM_DOWNLOAD_STEM_EDGE_REASON };
  }
  if (trimmed.includes("..")) {
    return { ok: false, reason: "Titles cannot contain path traversal dots." };
  }
  if (WINDOWS_RESERVED_PATTERN.test(trimmed)) {
    return { ok: false, reason: "Choose a title that is not a reserved Windows filename." };
  }
  return { ok: true, stem: trimmed };
}

export function buildPackRoot(packName: string): string {
  return `${PACK_ROOT}/${sanitizePathSegment(packName, { fallback: "Capture Pack" })}`;
}

export function buildPageFolder(pageHost?: string, pageTitle?: string): string {
  const host = sanitizePathSegment(pageHost ?? "", { fallback: "source", maxLength: 48 });
  const title = sanitizePathSegment(pageTitle ?? "", { fallback: "Untitled page", maxLength: 72 });
  return sanitizePathSegment(`${host} - ${title}`, {
    fallback: host,
    maxLength: DEFAULT_SEGMENT_LIMIT,
  });
}

function fitPath(segments: string[], maxPathLength: number): string[] {
  const fitted = [...segments];
  const minimums = fitted.map((_, index) => (index === fitted.length - 1 ? 12 : 8));
  let path = fitted.join("/");

  while (path.length > maxPathLength) {
    let candidateIndex = -1;
    let candidateLength = -1;
    for (let index = 1; index < fitted.length; index++) {
      const length = Array.from(fitted[index]).length;
      if (length > minimums[index] && length > candidateLength) {
        candidateIndex = index;
        candidateLength = length;
      }
    }
    if (candidateIndex === -1) break;

    const overflow = path.length - maxPathLength;
    const currentLength = Array.from(fitted[candidateIndex]).length;
    const nextLength = Math.max(minimums[candidateIndex], currentLength - Math.max(1, overflow));
    fitted[candidateIndex] = candidateIndex === fitted.length - 1
      ? sanitizeDownloadFilename(fitted[candidateIndex], { maxLength: nextLength })
      : sanitizePathSegment(fitted[candidateIndex], { maxLength: nextLength });
    path = fitted.join("/");
  }

  if (path.length > maxPathLength) {
    throw new Error("The planned download path exceeds the safe length limit.");
  }
  return fitted;
}

function isCanonicalSegment(segment: string, maxLength: number): boolean {
  return (
    segment.length > 0 &&
    segment === segment.normalize("NFC") &&
    Array.from(segment).length <= maxLength &&
    segment === segment.trim() &&
    !segment.startsWith(".") &&
    !segment.endsWith(".") &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("..") &&
    !BIDI_CONTROL_TEST_PATTERN.test(segment) &&
    !CONTROL_TEST_PATTERN.test(segment) &&
    !INVALID_SEGMENT_TEST_PATTERN.test(segment) &&
    !WINDOWS_RESERVED_PATTERN.test(segment)
  );
}

export function isSafeRelativeDownloadPath(
  path: string,
  maxPathLength = DEFAULT_PATH_LIMIT,
): boolean {
  if (!validPathLimit(maxPathLength) || path.length > maxPathLength) return false;
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[a-z]:/i.test(path)) return false;
  if (BIDI_CONTROL_TEST_PATTERN.test(path) || CONTROL_TEST_PATTERN.test(path)) return false;
  const segments = path.split("/");
  if (segments.length < 3 || segments[0] !== PACK_ROOT) return false;
  return segments.every((segment, index) =>
    isCanonicalSegment(
      segment,
      index === segments.length - 1 ? DEFAULT_FILENAME_LIMIT : DEFAULT_SEGMENT_LIMIT,
    ));
}

export function buildRelativeDownloadPath(options: DownloadPathOptions): string {
  const maxPathLength = options.maxPathLength ?? DEFAULT_PATH_LIMIT;
  if (!validPathLimit(maxPathLength)) {
    throw new TypeError("The download path limit must be a finite integer between 80 and 1024.");
  }
  const segments = [
    PACK_ROOT,
    sanitizePathSegment(options.packName, { fallback: "Capture Pack" }),
  ];
  if (options.includePageFolder !== false) {
    segments.push(buildPageFolder(options.pageHost, options.pageTitle));
  }
  segments.push(sanitizeDownloadFilename(options.filename));

  const path = fitPath(segments, maxPathLength).join("/");
  if (!isSafeRelativeDownloadPath(path)) {
    throw new Error("Could not create a safe Downloads-relative path.");
  }
  return path;
}

function appendCollisionSuffix(path: string, counter: number, maxPathLength: number): string {
  const segments = path.split("/");
  const filename = segments.pop() ?? "download";
  const { stem, extension } = splitFilename(filename);
  const suffix = ` (${counter})`;
  const parentLength = segments.join("/").length + 1;
  const filenameLimit = maxPathLength - parentLength;
  const minimumFilenameLength = suffix.length + extension.length + 1;
  if (filenameLimit < minimumFilenameLength) {
    throw new Error("The planned path has no room for a collision suffix.");
  }
  const stemLimit = Math.max(1, filenameLimit - suffix.length - extension.length);
  const nextFilename = `${truncateCodePoints(stem, stemLimit).replace(/[. ]+$/g, "")}${suffix}${extension}`;
  const candidate = [...segments, sanitizeDownloadFilename(nextFilename, { maxLength: filenameLimit })].join("/");
  if (!isSafeRelativeDownloadPath(candidate, maxPathLength)) {
    throw new Error("Could not create a safe collision-free download path.");
  }
  return candidate;
}

export function dedupePlannedPaths(paths: string[], maxPathLength = DEFAULT_PATH_LIMIT): string[] {
  if (!validPathLimit(maxPathLength)) {
    throw new TypeError("The download path limit must be a finite integer between 80 and 1024.");
  }
  const seen = new Set<string>();
  return paths.map((path) => {
    if (!isSafeRelativeDownloadPath(path, maxPathLength)) {
      throw new Error(`Unsafe planned download path: ${path}`);
    }
    let candidate = path;
    let counter = 2;
    while (seen.has(candidate.normalize("NFC").toLocaleLowerCase("en-US"))) {
      candidate = appendCollisionSuffix(path, counter, maxPathLength);
      counter += 1;
    }
    seen.add(candidate.normalize("NFC").toLocaleLowerCase("en-US"));
    return candidate;
  });
}
