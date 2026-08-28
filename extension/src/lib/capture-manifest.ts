import { isSafeRelativeDownloadPath, sanitizeDownloadFilename } from "./download-path";

export type CaptureManifestItemStatus =
  | "complete"
  | "failed"
  | "cancelled"
  | "save_state_unknown"
  | "excluded";
export type CaptureManifestMediaKind = "direct" | "hls" | "dash" | "image";

export type CaptureManifestInputItemV1 = {
  plannedPath: string;
  actualFilename?: string;
  kind: CaptureManifestMediaKind;
  pageUrl?: string;
  mediaUrl?: string;
  /** Pre-redacted host from the durable manifest seed. */
  sourceHost?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  bitrate?: number;
  capturedAt: number;
  status: CaptureManifestItemStatus;
  errorCode?: string;
  // Extra runtime properties are deliberately ignored by the serializer.
  [key: string]: unknown;
};

export type CaptureManifestInputV1 = {
  generatorVersion: string;
  packName: string;
  createdAt: number;
  completedAt: number;
  status: "complete" | "partial" | "cancelled";
  items: CaptureManifestInputItemV1[];
  [key: string]: unknown;
};

export type CaptureManifestV1 = {
  schemaVersion: 1;
  generator: { name: "ClipHutch"; version: string };
  pack: {
    name: string;
    createdAt: string;
    completedAt: string;
    status: "complete" | "partial" | "cancelled";
  };
  items: Array<{
    plannedPath: string;
    actualBasename?: string;
    kind: CaptureManifestMediaKind;
    pageUrl?: string;
    sourceHost?: string;
    width?: number;
    height?: number;
    durationSec?: number;
    bitrate?: number;
    capturedAt: string;
    status: CaptureManifestItemStatus;
    error?: { category: string; message: string };
  }>;
};

const MAX_MANIFEST_ITEMS = 200;
const MAX_MANIFEST_OUTPUT_BYTES = 1024 * 1024;
const MAX_PAGE_URL_LENGTH = 2048;
const PACK_STATUSES = new Set(["complete", "partial", "cancelled"]);
const ITEM_STATUSES = new Set([
  "complete",
  "failed",
  "cancelled",
  "save_state_unknown",
  "excluded",
]);
const MEDIA_KINDS = new Set(["direct", "hls", "dash", "image"]);
const BIDI_AND_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const BIDI_AND_CONTROL_TEST_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

const ERROR_MESSAGES: Record<string, string> = {
  NETWORK: "The source could not be reached.",
  UNSUPPORTED: "This media shape is not supported.",
  STALE_SOURCE: "The source changed or expired before it could be saved.",
  SIZE_LIMIT: "The media exceeded the configured size limit.",
  CANCELLED: "The item was cancelled.",
  SAVE_FAILED: "Chrome could not save the completed item.",
  SAVE_STATE_UNKNOWN: "Chrome may have accepted this item. Check Downloads before saving it again.",
  UNKNOWN: "The item could not be saved.",
};

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isoTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Manifest timestamps must be non-negative finite numbers.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Manifest timestamp is outside the ISO date range.");
  return date.toISOString();
}

export function redactManifestUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const redacted = url.toString();
    return redacted.length <= MAX_PAGE_URL_LENGTH ? redacted : undefined;
  } catch {
    return undefined;
  }
}

export function sourceHostForManifest(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.host.length <= 255 ? url.host : undefined;
  } catch {
    return undefined;
  }
}

function canonicalSourceHost(raw: string | undefined): string | undefined {
  if (!raw || raw.length > 255 || BIDI_AND_CONTROL_TEST_PATTERN.test(raw)) return undefined;
  try {
    const url = new URL(`https://${raw}/`);
    return url.host === raw && url.username === "" && url.password === "" ? raw : undefined;
  } catch {
    return undefined;
  }
}

function basenameOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const basename = value.split(/[\\/]/).filter(Boolean).at(-1);
  return basename ? sanitizeDownloadFilename(basename, { maxLength: 180 }) : undefined;
}

function publicError(code: string | undefined): { category: string; message: string } | undefined {
  if (!code) return undefined;
  const category = Object.hasOwn(ERROR_MESSAGES, code) ? code : "UNKNOWN";
  return { category, message: ERROR_MESSAGES[category] };
}

function boundedText(value: unknown, maxLength: number, fallback: string): string {
  const text = typeof value === "string"
    ? value.normalize("NFC").replace(BIDI_AND_CONTROL_PATTERN, " ").trim()
    : "";
  return (text || fallback).slice(0, maxLength);
}

export function canonicalCaptureManifestPackName(value: unknown): string {
  return boundedText(value, 160, "Capture Pack");
}

function assertManifestEnums(input: CaptureManifestInputV1): void {
  if (!PACK_STATUSES.has(input.status)) throw new TypeError("Invalid Capture Pack status.");
  for (const item of input.items) {
    if (!item || typeof item !== "object") throw new TypeError("Invalid Capture Pack item.");
    if (!MEDIA_KINDS.has(item.kind)) throw new TypeError("Invalid Capture Pack media kind.");
    if (!ITEM_STATUSES.has(item.status)) throw new TypeError("Invalid Capture Pack item status.");
  }
  const includedItems = input.items.filter((item) => item.status !== "excluded");
  const hasIncompleteItem = includedItems.some((item) =>
    item.status === "failed" || item.status === "cancelled" || item.status === "save_state_unknown"
  );
  if (input.status === "complete" && (
    hasIncompleteItem || includedItems.some((item) => item.status !== "complete")
  )) {
    throw new TypeError("A complete Capture Pack cannot contain failed or cancelled items.");
  }
  if (
    input.status === "cancelled" &&
    (includedItems.length === 0 || includedItems.some((item) => item.status !== "cancelled"))
  ) {
    throw new TypeError("A cancelled Capture Pack must contain only cancelled included items.");
  }
  if (input.status === "partial" && !hasIncompleteItem) {
    throw new TypeError("A partial Capture Pack must contain an incomplete included item.");
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertOutputBound(value: string): string {
  if (utf8Bytes(value) > MAX_MANIFEST_OUTPUT_BYTES) {
    throw new Error("Capture Pack manifest exceeds the 1 MiB output limit.");
  }
  return value;
}

export function createCaptureManifest(input: CaptureManifestInputV1): CaptureManifestV1 {
  if (!input || typeof input !== "object" || !Array.isArray(input.items) || input.items.length > MAX_MANIFEST_ITEMS) {
    throw new Error("A Capture Pack manifest may contain at most 200 items.");
  }
  assertManifestEnums(input);
  if (input.completedAt < input.createdAt) {
    throw new Error("Capture Pack completion time cannot precede its creation time.");
  }
  // Validate the range before mapping individual items.
  isoTime(input.createdAt);
  isoTime(input.completedAt);

  return {
    schemaVersion: 1,
    generator: {
      name: "ClipHutch",
      version: boundedText(input.generatorVersion, 32, "unknown"),
    },
    pack: {
      name: canonicalCaptureManifestPackName(input.packName),
      createdAt: isoTime(input.createdAt),
      completedAt: isoTime(input.completedAt),
      status: input.status,
    },
    items: input.items.map((item) => {
      if (typeof item.plannedPath !== "string" || !isSafeRelativeDownloadPath(item.plannedPath)) {
        throw new Error("Manifest item contains an unsafe planned path.");
      }
      if (
        typeof item.capturedAt !== "number" ||
        item.capturedAt < input.createdAt ||
        item.capturedAt > input.completedAt
      ) {
        throw new Error("Manifest item capture time falls outside the pack interval.");
      }
      const error = item.status === "failed" || item.status === "cancelled" ||
        item.status === "save_state_unknown"
        ? publicError(item.errorCode ?? (
            item.status === "cancelled"
              ? "CANCELLED"
              : item.status === "save_state_unknown"
                ? "SAVE_STATE_UNKNOWN"
                : "UNKNOWN"
          ))
        : undefined;
      return {
        plannedPath: item.plannedPath,
        actualBasename: basenameOnly(item.actualFilename),
        kind: item.kind,
        pageUrl: redactManifestUrl(item.pageUrl),
        sourceHost: canonicalSourceHost(item.sourceHost) ?? sourceHostForManifest(item.mediaUrl),
        width: positiveInteger(item.width),
        height: positiveInteger(item.height),
        durationSec: finiteNonNegative(item.durationSec),
        bitrate: finiteNonNegative(item.bitrate),
        capturedAt: isoTime(item.capturedAt),
        status: item.status,
        error,
      };
    }),
  };
}

export function serializeCaptureManifestJson(input: CaptureManifestInputV1): string {
  return assertOutputBound(`${JSON.stringify(createCaptureManifest(input), null, 2)}\n`);
}

function neutralizeSpreadsheetFormula(text: string): string {
  return /^(?:[\uFEFF\t\r\n]|[\uFEFF\s]*[=+\-@])/u.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = neutralizeSpreadsheetFormula(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeCaptureManifestCsv(input: CaptureManifestInputV1): string {
  const manifest = createCaptureManifest(input);
  const headers = [
    "plannedPath",
    "actualBasename",
    "kind",
    "pageUrl",
    "sourceHost",
    "width",
    "height",
    "durationSec",
    "bitrate",
    "capturedAt",
    "status",
    "errorCategory",
    "errorMessage",
  ];
  const rows = manifest.items.map((item) => [
    item.plannedPath,
    item.actualBasename,
    item.kind,
    item.pageUrl,
    item.sourceHost,
    item.width,
    item.height,
    item.durationSec,
    item.bitrate,
    item.capturedAt,
    item.status,
    item.error?.category,
    item.error?.message,
  ]);
  return assertOutputBound(
    `${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`,
  );
}
