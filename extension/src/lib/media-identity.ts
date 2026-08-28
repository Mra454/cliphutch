import type { DetectedVideo, MediaKind, MediaProvenance } from "../types";

export const MAX_MEDIA_PROVENANCE_ENTRIES = 5;

const MAX_ID_LENGTH = 256;
const MAX_URL_LENGTH = 16_384;
const MAX_TITLE_LENGTH = 1_024;
const MAX_CONTENT_TYPE_LENGTH = 256;
const MAX_CONTENT_DISPOSITION_LENGTH = 2_048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MEDIA_KINDS = new Set<MediaKind>(["direct", "hls", "dash", "image"]);
const PROVENANCE_ORDER: readonly MediaProvenance[] = [
  "network",
  "rendered-image",
  "picture",
  "metadata",
  "poster",
];
const PROVENANCE = new Set<MediaProvenance>(PROVENANCE_ORDER);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MediaGroupEvidence = "authoritative-family" | "exact-url" | "single";

export type MediaGroup = {
  groupId: string;
  evidence: MediaGroupEvidence;
  primary: DetectedVideo;
  alternates: DetectedVideo[];
  members: DetectedVideo[];
};

/** Creates an opaque record ID; storage still collision-checks before commit. */
export function createDetectedMediaRecordId(
  tabId: number,
  randomUuid: () => string = () => crypto.randomUUID(),
): string {
  if (!Number.isSafeInteger(tabId) || tabId < 0) {
    throw new TypeError("Detected-media record IDs require a valid tab scope.");
  }
  const uuid = randomUuid();
  if (!UUID.test(uuid)) throw new TypeError("Detected-media record IDs require a valid UUID.");
  return `detected-v1-t${tabId.toString(36)}-${uuid.toLowerCase()}`;
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
      return undefined;
    }
    const record = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if ("value" in descriptor) record[key] = descriptor.value;
    }
    return record;
  } catch {
    return undefined;
  }
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").slice(0, maxLength);
  return normalized.length > 0 ? normalized : undefined;
}

function boundedIdentifier(value: unknown): string | undefined {
  const identifier = boundedText(value, MAX_ID_LENGTH);
  return identifier && !CONTROL_CHARACTERS.test(identifier) ? identifier : undefined;
}

export function normalizeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    const normalized = parsed.href;
    return normalized.length <= MAX_URL_LENGTH ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function normalizePageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const normalized = parsed.href;
    return normalized.length <= MAX_URL_LENGTH ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveDimension(value: unknown): number | undefined {
  const dimension = safeNonNegativeInteger(value);
  return dimension !== undefined && dimension > 0 ? dimension : undefined;
}

function normalizeProvenance(value: unknown): MediaProvenance[] {
  if (!Array.isArray(value)) return [];
  const found = new Set<MediaProvenance>();
  const inspected = Math.min(value.length, MAX_MEDIA_PROVENANCE_ENTRIES);
  for (let index = 0; index < inspected; index += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) continue;
      const entry = descriptor.value;
      if (typeof entry === "string" && PROVENANCE.has(entry as MediaProvenance)) {
        found.add(entry as MediaProvenance);
      }
    } catch {
      return [];
    }
  }
  return PROVENANCE_ORDER.filter((entry) => found.has(entry));
}

function inferredProvenance(
  kind: MediaKind,
  contentType: string | undefined,
  contentDisposition: string | undefined,
  sizeBytes: number | undefined,
): MediaProvenance {
  if (kind !== "image") return "network";
  return contentType || contentDisposition || sizeBytes !== undefined
    ? "network"
    : "rendered-image";
}

/**
 * Produces a bounded allowlist clone of a shelf record. This is deliberately
 * tolerant of old records that predate first/last-seen metadata, while
 * rejecting records without a usable identity, kind, URL, or detection time.
 */
export function normalizeDetectedVideo(value: unknown): DetectedVideo | undefined {
  try {
    const record = dataRecord(value);
    if (!record) return undefined;
    const id = boundedIdentifier(record.id);
    const url = normalizeMediaUrl(record.url);
    const kind = MEDIA_KINDS.has(record.kind as MediaKind)
      ? record.kind as MediaKind
      : undefined;
    const detectedAt = finiteTimestamp(record.detectedAt);
    if (!id || !url || !kind || detectedAt === undefined) return undefined;

    const pageUrl = normalizePageUrl(record.pageUrl);
    const pageTitle = boundedText(record.pageTitle, MAX_TITLE_LENGTH);
    const sizeBytes = safeNonNegativeInteger(record.sizeBytes);
    const contentType = boundedText(record.contentType, MAX_CONTENT_TYPE_LENGTH);
    const contentDisposition = boundedText(
      record.contentDisposition,
      MAX_CONTENT_DISPOSITION_LENGTH,
    );
    const width = positiveDimension(record.width);
    const height = positiveDimension(record.height);
    const suppliedFirstSeenAt = finiteTimestamp(record.firstSeenAt);
    const suppliedLastSeenAt = finiteTimestamp(record.lastSeenAt);
    const firstSeenAt = Math.min(detectedAt, suppliedFirstSeenAt ?? detectedAt);
    const lastSeenAt = Math.max(detectedAt, suppliedLastSeenAt ?? detectedAt);
    const suppliedProvenance = normalizeProvenance(record.provenance);
    const provenance = suppliedProvenance.length > 0
      ? suppliedProvenance
      : [inferredProvenance(kind, contentType, contentDisposition, sizeBytes)];
    const familyId = boundedIdentifier(record.familyId);
    const hasCapturedReplayHeaders = record.hasCapturedReplayHeaders === true;

    return {
      id,
      url,
      kind,
      detectedAt,
      firstSeenAt,
      lastSeenAt,
      pageUrl,
      pageTitle,
      sizeBytes,
      contentType,
      contentDisposition,
      width,
      height,
      provenance,
      ...(hasCapturedReplayHeaders ? { hasCapturedReplayHeaders: true } : {}),
      familyId,
    };
  } catch {
    return undefined;
  }
}

function unionProvenance(
  left: readonly MediaProvenance[],
  right: readonly MediaProvenance[],
): MediaProvenance[] {
  const entries = new Set<MediaProvenance>([...left, ...right]);
  return PROVENANCE_ORDER.filter((entry) => entries.has(entry))
    .slice(0, MAX_MEDIA_PROVENANCE_ENTRIES);
}

function laterValue<T>(
  existing: T | undefined,
  incoming: T | undefined,
  preferIncoming: boolean,
): T | undefined {
  if (preferIncoming) return incoming ?? existing;
  return existing ?? incoming;
}

function chooseDimensions(
  existing: Pick<DetectedVideo, "width" | "height">,
  incoming: Pick<DetectedVideo, "width" | "height">,
): Pick<DetectedVideo, "width" | "height"> {
  const existingComplete = existing.width !== undefined && existing.height !== undefined;
  const incomingComplete = incoming.width !== undefined && incoming.height !== undefined;
  if (existingComplete && incomingComplete) {
    return incoming.width! * incoming.height! > existing.width! * existing.height!
      ? { width: incoming.width, height: incoming.height }
      : { width: existing.width, height: existing.height };
  }
  if (incomingComplete) return { width: incoming.width, height: incoming.height };
  if (existingComplete) return { width: existing.width, height: existing.height };
  if (incoming.width !== undefined || incoming.height !== undefined) {
    return { width: incoming.width, height: incoming.height };
  }
  return { width: existing.width, height: existing.height };
}

/** Merge two exact media identities without allowing late metadata to change identity. */
export function mergeDetectedVideo(
  existingValue: DetectedVideo,
  incomingValue: DetectedVideo,
): DetectedVideo {
  const existing = normalizeDetectedVideo(existingValue);
  const incoming = normalizeDetectedVideo(incomingValue);
  if (!existing || !incoming) throw new TypeError("Cannot merge an invalid detected-media record.");
  if (
    existing.kind !== incoming.kind ||
    existing.url !== incoming.url ||
    (existing.pageUrl !== undefined &&
      incoming.pageUrl !== undefined &&
      existing.pageUrl !== incoming.pageUrl)
  ) {
    throw new TypeError("Detected-media merges require an exact URL, compatible kind, and page scope.");
  }

  const firstSeenAt = Math.min(
    existing.firstSeenAt ?? existing.detectedAt,
    incoming.firstSeenAt ?? incoming.detectedAt,
    existing.detectedAt,
    incoming.detectedAt,
  );
  const lastSeenAt = Math.max(
    existing.lastSeenAt ?? existing.detectedAt,
    incoming.lastSeenAt ?? incoming.detectedAt,
    existing.detectedAt,
    incoming.detectedAt,
  );
  const preferIncoming = (incoming.lastSeenAt ?? incoming.detectedAt) >=
    (existing.lastSeenAt ?? existing.detectedAt);
  const dimensions = chooseDimensions(existing, incoming);
  const incomingDomFamilyObservation = incoming.kind === "image" &&
    (incoming.provenance ?? []).some((entry) =>
      entry === "rendered-image" || entry === "picture" || entry === "poster"
    );

  return {
    id: existing.id,
    url: existing.url,
    kind: existing.kind,
    detectedAt: Math.min(existing.detectedAt, incoming.detectedAt),
    firstSeenAt,
    lastSeenAt,
    pageUrl: laterValue(existing.pageUrl, incoming.pageUrl, preferIncoming),
    pageTitle: laterValue(existing.pageTitle, incoming.pageTitle, preferIncoming),
    sizeBytes: laterValue(existing.sizeBytes, incoming.sizeBytes, preferIncoming),
    contentType: laterValue(existing.contentType, incoming.contentType, preferIncoming),
    contentDisposition: laterValue(
      existing.contentDisposition,
      incoming.contentDisposition,
      preferIncoming,
    ),
    width: dimensions.width,
    height: dimensions.height,
    provenance: unionProvenance(existing.provenance ?? [], incoming.provenance ?? []),
    // Header capture is positive evidence. A later DOM/network observation
    // without the flag must not erase the obligation to create a lease.
    ...(
      existing.hasCapturedReplayHeaders === true || incoming.hasCapturedReplayHeaders === true
        ? { hasCapturedReplayHeaders: true }
        : {}
    ),
    // Once assigned, family identity is immutable. Conflicting later evidence
    // clears it rather than moving the customer's selected group to a false
    // family. Metadata/network observations without a family do not clear it.
    familyId: incomingDomFamilyObservation && !incoming.familyId
      ? undefined
      : existing.familyId ?? incoming.familyId,
  };
}

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(36);
}

export function detectedMediaIdentityToken(value: unknown): string | undefined {
  const media = normalizeDetectedVideo(value);
  return media
    ? `media-v1-${stableHash(`${media.kind}|${pageScope(media)}|${media.url}`)}`
    : undefined;
}

function pageScope(media: DetectedVideo): string {
  return media.pageUrl ?? "no-page";
}

export function isSameDetectedMediaIdentity(
  leftValue: unknown,
  rightValue: unknown,
): boolean {
  const left = normalizeDetectedVideo(leftValue);
  const right = normalizeDetectedVideo(rightValue);
  return Boolean(
    left &&
    right &&
    left.kind === right.kind &&
    left.url === right.url &&
    (left.pageUrl === undefined || right.pageUrl === undefined || left.pageUrl === right.pageUrl),
  );
}

function groupingEvidence(media: DetectedVideo): {
  key: string;
  evidence: MediaGroupEvidence;
} {
  // Stream manifests continue to be explicit shelf entries. Rendition/family
  // relationships are established only after manifest validation.
  if (media.kind === "hls" || media.kind === "dash") {
    return {
      key: `single|${media.kind}|${media.id}|${media.url}`,
      evidence: "single",
    };
  }
  if (media.kind === "image" && media.familyId) {
    return {
      key: `family|${media.kind}|${pageScope(media)}|${media.familyId}`,
      evidence: "authoritative-family",
    };
  }
  return {
    key: `exact|${media.kind}|${pageScope(media)}|${media.url}`,
    evidence: "exact-url",
  };
}

function comparePrimary(left: DetectedVideo, right: DetectedVideo): number {
  const byteDifference = (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0);
  if (byteDifference !== 0) return byteDifference;
  const detectionDifference = right.detectedAt - left.detectedAt;
  if (detectionDifference !== 0) return detectionDifference;
  return left.id.localeCompare(right.id) || left.url.localeCompare(right.url);
}

/**
 * Conservatively groups shelf media using only exact identity or an
 * authoritative DOM family. Titles, filenames, directories, and stripped URL
 * tokens are intentionally never treated as duplicate evidence.
 */
export function groupMedia(items: readonly unknown[]): MediaGroup[] {
  const buckets = new Map<
    string,
    { evidence: MediaGroupEvidence; members: DetectedVideo[] }
  >();
  for (const item of items) {
    const media = normalizeDetectedVideo(item);
    if (!media) continue;
    const { key, evidence } = groupingEvidence(media);
    const bucket = buckets.get(key);
    if (bucket) bucket.members.push(media);
    else buckets.set(key, { evidence, members: [media] });
  }

  return [...buckets.entries()]
    .map(([key, bucket]) => {
      const members = [...bucket.members].sort(comparePrimary);
      return {
        groupId: `media-group-v1-${stableHash(key)}`,
        evidence: bucket.evidence,
        primary: members[0],
        alternates: members.slice(1),
        members,
      };
    })
    .sort((left, right) => {
      const detectionDifference = right.primary.detectedAt - left.primary.detectedAt;
      return detectionDifference || left.groupId.localeCompare(right.groupId);
    });
}
