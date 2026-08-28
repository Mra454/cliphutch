import type { DetectedVideo } from "../types";
import {
  isMediaSnapshotV1,
  type MediaProvenanceV1,
  type MediaSnapshotV1,
} from "./capture-pack-types";
import { normalizeDetectedVideo } from "./media-identity";

const MAX_TITLE_LENGTH = 1_024;
const MAX_CONTENT_TYPE_LENGTH = 256;
const MAX_CONTENT_DISPOSITION_LENGTH = 2_048;

function boundedOptionalText(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").slice(0, maxLength);
  return normalized.length > 0 ? normalized : undefined;
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function safeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function defaultProvenance(media: DetectedVideo): MediaProvenanceV1 {
  if (media.kind !== "image") return "network";
  return media.contentType || media.contentDisposition || media.sizeBytes !== undefined
    ? "network"
    : "rendered-image";
}

/**
 * Freezes the customer-visible, non-header portion of an authoritative shelf
 * record. It deliberately ignores any undeclared runtime fields.
 */
export function createMediaSnapshotFromDetected(
  media: DetectedVideo,
  provenance?: MediaProvenanceV1,
): MediaSnapshotV1 {
  if (
    typeof media.id !== "string" ||
    media.id.trim().length === 0 ||
    media.id.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(media.id)
  ) {
    throw new TypeError("Capture Pack media must have a valid authoritative identifier.");
  }
  const url = httpUrl(media.url);
  if (!url) throw new TypeError("Capture Pack media must use an HTTP(S) URL.");
  if (!Number.isSafeInteger(media.detectedAt) || media.detectedAt < 0) {
    throw new TypeError("Capture Pack media must have a valid authoritative detection time.");
  }
  const normalized = normalizeDetectedVideo(media);
  if (!normalized) {
    throw new TypeError("Capture Pack media metadata is not a valid detected-media record.");
  }
  const detectedAt = normalized.detectedAt;
  const snapshot: MediaSnapshotV1 = {
    mediaId: normalized.id,
    kind: normalized.kind,
    url: normalized.url,
    detectedAt,
    firstSeenAt: normalized.firstSeenAt ?? detectedAt,
    lastSeenAt: normalized.lastSeenAt ?? detectedAt,
    pageUrl: httpUrl(normalized.pageUrl),
    pageTitle: boundedOptionalText(normalized.pageTitle, MAX_TITLE_LENGTH),
    contentType: boundedOptionalText(normalized.contentType, MAX_CONTENT_TYPE_LENGTH),
    contentDisposition: boundedOptionalText(
      normalized.contentDisposition,
      MAX_CONTENT_DISPOSITION_LENGTH,
    ),
    sizeBytes: safeInteger(normalized.sizeBytes),
    width: safeInteger(normalized.width),
    height: safeInteger(normalized.height),
    provenance: provenance
      ? [provenance]
      : normalized.provenance ?? [defaultProvenance(normalized)],
    familyId: normalized.familyId,
  };
  if (!isMediaSnapshotV1(snapshot)) {
    throw new TypeError("Detected media could not be converted to a safe Capture Pack snapshot.");
  }
  return snapshot;
}
