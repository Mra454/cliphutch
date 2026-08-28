import type { DetectedVideo } from "../types";
import {
  isMediaSnapshotV1,
  type MediaSnapshotV1,
} from "./capture-pack-types";
import { groupMedia, normalizeDetectedVideo } from "./media-identity";

export const MAX_BEST_COPY_CANDIDATES = 200;

/**
 * `supported` is a capability/eligibility fact supplied by the caller. The
 * engine deliberately does not infer it (or remote reachability) from a URL,
 * filename, or MIME-looking string.
 */
export type BestCopyCandidateV1 = {
  media: DetectedVideo | MediaSnapshotV1;
  supported: boolean;
};

export type BestCopyRecommendationV1 = {
  candidateId: string;
  confidence: "high";
  reason: string;
};

type CanonicalCandidate = {
  media: DetectedVideo;
  supported: boolean;
  bitrate?: number;
};

const CANDIDATE_KEYS = ["media", "supported"] as const;
const SNAPSHOT_KEYS = [
  "mediaId",
  "kind",
  "url",
  "detectedAt",
  "firstSeenAt",
  "lastSeenAt",
  "pageUrl",
  "pageTitle",
  "contentType",
  "contentDisposition",
  "sizeBytes",
  "width",
  "height",
  "durationSec",
  "bitrate",
  "codecs",
  "provenance",
  "familyId",
] as const;

function copyDataRecord(
  value: unknown,
  allowedKeys?: readonly string[],
  requiredKeys: readonly string[] = [],
): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) =>
        typeof key !== "string" || (allowedKeys !== undefined && !allowedKeys.includes(key))
      ) ||
      requiredKeys.some((key) => !ownKeys.includes(key))
    ) {
      return undefined;
    }
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return undefined;
  }
}

function copyDenseArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximum
    ) {
      return undefined;
    }
    const length = lengthDescriptor.value as number;
    const expectedKeys = new Set<string>(["length"]);
    for (let index = 0; index < length; index += 1) expectedKeys.add(String(index));
    if (Reflect.ownKeys(value).some((key) =>
      typeof key !== "string" || !expectedKeys.has(key)
    )) {
      return undefined;
    }
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      copy.push(descriptor.value);
    }
    return copy;
  } catch {
    return undefined;
  }
}

function copySnapshot(value: unknown): MediaSnapshotV1 | undefined {
  const record = copyDataRecord(value, SNAPSHOT_KEYS, [
    "mediaId",
    "kind",
    "url",
    "detectedAt",
    "provenance",
  ]);
  if (!record) return undefined;
  const provenance = copyDenseArray(record.provenance, 5);
  if (!provenance) return undefined;
  const copy = { ...record, provenance };
  return isMediaSnapshotV1(copy) ? copy : undefined;
}

function detectedFromSnapshot(snapshot: MediaSnapshotV1): DetectedVideo | undefined {
  const detected = normalizeDetectedVideo({
    id: snapshot.mediaId,
    kind: snapshot.kind,
    url: snapshot.url,
    detectedAt: snapshot.detectedAt,
    firstSeenAt: snapshot.firstSeenAt,
    lastSeenAt: snapshot.lastSeenAt,
    pageUrl: snapshot.pageUrl,
    pageTitle: snapshot.pageTitle,
    contentType: snapshot.contentType,
    contentDisposition: snapshot.contentDisposition,
    sizeBytes: snapshot.sizeBytes,
    width: snapshot.width,
    height: snapshot.height,
    provenance: snapshot.provenance,
    familyId: snapshot.familyId,
  });
  // A recommendation ID must address the caller's exact candidate, not a
  // truncated or Unicode-normalized approximation of it.
  return detected?.id === snapshot.mediaId ? detected : undefined;
}

function canonicalCandidate(value: unknown): CanonicalCandidate | undefined {
  const record = copyDataRecord(value, CANDIDATE_KEYS, CANDIDATE_KEYS);
  if (!record || typeof record.supported !== "boolean") return undefined;
  const mediaRecord = copyDataRecord(record.media);
  if (!mediaRecord) return undefined;

  if (Object.prototype.hasOwnProperty.call(mediaRecord, "mediaId")) {
    const snapshot = copySnapshot(record.media);
    if (!snapshot) return undefined;
    const media = detectedFromSnapshot(snapshot);
    if (!media) return undefined;
    return {
      media,
      supported: record.supported,
      ...(typeof snapshot.bitrate === "number" &&
        Number.isFinite(snapshot.bitrate) &&
        snapshot.bitrate > 0
        ? { bitrate: snapshot.bitrate }
        : {}),
    };
  }

  const media = normalizeDetectedVideo(record.media);
  if (!media || mediaRecord.id !== media.id) return undefined;
  return { media, supported: record.supported };
}

function pixelArea(candidate: CanonicalCandidate): bigint | undefined {
  const { width, height } = candidate.media;
  return width !== undefined && height !== undefined
    ? BigInt(width) * BigInt(height)
    : undefined;
}

function streamBitrate(candidate: CanonicalCandidate): number | undefined {
  return candidate.media.kind === "hls" || candidate.media.kind === "dash"
    ? candidate.bitrate
    : undefined;
}

function originalDeliveryRank(candidate: CanonicalCandidate): number {
  return candidate.media.kind === "direct" || candidate.media.kind === "image" ? 1 : 0;
}

function compareStableId(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareCandidates(
  left: CanonicalCandidate,
  right: CanonicalCandidate,
  useOriginalBytes: boolean,
): number {
  if (left.supported !== right.supported) return left.supported ? -1 : 1;

  const leftArea = pixelArea(left);
  const rightArea = pixelArea(right);
  if (leftArea !== undefined || rightArea !== undefined) {
    if (leftArea === undefined) return 1;
    if (rightArea === undefined) return -1;
    if (leftArea !== rightArea) return leftArea > rightArea ? -1 : 1;
  }

  const leftBitrate = streamBitrate(left);
  const rightBitrate = streamBitrate(right);
  if (leftBitrate !== undefined || rightBitrate !== undefined) {
    if (leftBitrate === undefined) return 1;
    if (rightBitrate === undefined) return -1;
    if (leftBitrate !== rightBitrate) return rightBitrate - leftBitrate;
  }

  const bytesHaveSupportingQuality =
    (leftArea !== undefined && rightArea !== undefined) ||
    (leftBitrate !== undefined && rightBitrate !== undefined);
  if (useOriginalBytes && bytesHaveSupportingQuality) {
    const leftBytes = left.media.sizeBytes;
    const rightBytes = right.media.sizeBytes;
    if (leftBytes !== undefined || rightBytes !== undefined) {
      if (leftBytes === undefined) return 1;
      if (rightBytes === undefined) return -1;
      if (leftBytes !== rightBytes) return rightBytes - leftBytes;
    }
  }

  const deliveryDifference = originalDeliveryRank(right) - originalDeliveryRank(left);
  if (deliveryDifference !== 0) return deliveryDifference;
  return compareStableId(left.media.id, right.media.id);
}

function responsiveReason(
  recommended: CanonicalCandidate,
  candidates: readonly CanonicalCandidate[],
): string {
  const supportedCandidates = candidates.filter((candidate) => candidate.supported);
  const area = pixelArea(recommended);
  const competingAreas = supportedCandidates
    .filter((candidate) => candidate.media.id !== recommended.media.id)
    .map(pixelArea);

  if (area !== undefined) {
    const dimensions = `${recommended.media.width} × ${recommended.media.height}`;
    const isStrictlyLargest = competingAreas.every((candidateArea) =>
      candidateArea !== undefined && area > candidateArea
    );
    if (isStrictlyLargest) {
      return `Recommended because it has the largest supported responsive-image resolution: ${dimensions}.`;
    }
    return `Recommended because this verified responsive-image copy uses a supported save path at ${dimensions}.`;
  }
  return "Recommended because it is the supported save-path copy in this verified responsive-image family.";
}

/**
 * Returns one bounded, deterministic recommendation only when every supplied
 * candidate belongs to the same relationship proven by `groupMedia`.
 *
 * The current identity model has no validated manifest-family evidence and
 * intentionally emits HLS/DASH entries as singletons, so this function cannot
 * recommend between stream manifests. C7 remains responsible for rendition
 * selection inside a validated stream object.
 */
export function recommendBestCopy(value: unknown): BestCopyRecommendationV1 | null {
  const entries = copyDenseArray(value, MAX_BEST_COPY_CANDIDATES);
  if (!entries || entries.length < 2) return null;

  const candidates: CanonicalCandidate[] = [];
  const candidateIds = new Set<string>();
  for (const entry of entries) {
    const candidate = canonicalCandidate(entry);
    if (!candidate || candidateIds.has(candidate.media.id)) return null;
    candidateIds.add(candidate.media.id);
    candidates.push(candidate);
  }
  if (!candidates.some((candidate) => candidate.supported)) return null;

  const groups = groupMedia(candidates.map((candidate) => candidate.media));
  if (
    groups.length !== 1 ||
    groups[0].members.length !== candidates.length ||
    groups[0].evidence === "single"
  ) {
    return null;
  }

  const hasQualityMetadata = candidates.some((candidate) =>
    pixelArea(candidate) !== undefined || streamBitrate(candidate) !== undefined
  );
  const supportDiffers = candidates.some((candidate) =>
    candidate.supported !== candidates[0].supported
  );
  // A family ID proves relationship, not relative quality. For responsive
  // images, byte count or stable-ID order alone cannot justify "best".
  if (
    groups[0].evidence === "authoritative-family" &&
    !hasQualityMetadata &&
    !supportDiffers
  ) {
    return null;
  }

  const ranked = [...candidates].sort((left, right) =>
    compareCandidates(left, right, hasQualityMetadata)
  );
  const recommended = ranked[0];
  return {
    candidateId: recommended.media.id,
    confidence: "high",
    reason: groups[0].evidence === "exact-url"
      ? "Recommended because these records resolve to the exact same media and this copy uses a supported save path."
      : responsiveReason(recommended, candidates),
  };
}
