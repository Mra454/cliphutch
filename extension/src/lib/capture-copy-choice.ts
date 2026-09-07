import type { DetectedVideo } from "../types";
import { MAX_BEST_COPY_CANDIDATES, recommendBestCopy } from "./best-copy";
import { WEBM_TRANSCODE_SIZE_CAP_BYTES } from "./constants";
import { isWebmDirectVideo } from "./media-format";
import { groupMedia, normalizeDetectedVideo } from "./media-identity";
import type {
  CaptureCopyChoiceV1,
  MediaFamilyRefV1,
} from "./capture-pack-types";

const EXACT_SELECTION_REASON =
  "Exact media selected from the Capture Pack draft.";
const CUSTOMER_OVERRIDE_REASON =
  "You chose this verified related copy instead of ClipHutch's high-confidence recommendation.";

export type FrozenCaptureCopySelectionV1 = {
  selected: DetectedVideo;
  copyChoice: CaptureCopyChoiceV1;
  family?: MediaFamilyRefV1;
};

export type FreezeCaptureCopySelectionResult =
  | { ok: true; value: FrozenCaptureCopySelectionV1 }
  | { ok: false; reason: "media_not_found" | "invalid_detected_media" };

function denseEntries(value: unknown): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_BEST_COPY_CANDIDATES
    ) {
      return undefined;
    }
    const entries: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return undefined;
  }
}

/**
 * Conservative support facts used when the current media shelf recommends a
 * copy. This deliberately makes no reachability claim about a remote URL.
 */
export function hasConservativeCaptureDownloadSupport(media: DetectedVideo): boolean {
  if (media.hasCapturedReplayHeaders === true) return false;
  if (media.kind === "image") return true;
  if (media.kind !== "direct") return false;
  if (!isWebmDirectVideo(media)) return true;
  return media.sizeBytes !== undefined && media.sizeBytes <= WEBM_TRANSCODE_SIZE_CAP_BYTES;
}

/**
 * Resolves one customer-selected media ID against a single, authoritative tab
 * shelf snapshot and freezes only its recommendation status. Alternate media
 * records are used transiently for grouping/ranking and are never returned.
 */
export function freezeCaptureCopySelection(
  selectedMediaId: unknown,
  authoritativeShelf: unknown,
): FreezeCaptureCopySelectionResult {
  if (typeof selectedMediaId !== "string" || selectedMediaId.length === 0) {
    return { ok: false, reason: "invalid_detected_media" };
  }

  const entries = denseEntries(authoritativeShelf);
  if (!entries) return { ok: false, reason: "invalid_detected_media" };

  try {
    const normalizedEntries: DetectedVideo[] = [];
    for (const entry of entries) {
      const normalized = normalizeDetectedVideo(entry);
      const rawId = entry !== null && typeof entry === "object"
        ? Object.getOwnPropertyDescriptor(entry, "id")?.value
        : undefined;
      // Never let a truncated/normalized approximation of an attacker-owned
      // identifier address the customer's requested shelf record.
      if (!normalized || rawId !== normalized.id) {
        return { ok: false, reason: "invalid_detected_media" };
      }
      normalizedEntries.push(normalized);
    }
    if (new Set(normalizedEntries.map((entry) => entry.id)).size !== normalizedEntries.length) {
      return { ok: false, reason: "invalid_detected_media" };
    }

    const groups = groupMedia(normalizedEntries);
    const selectedMatches = groups.flatMap((group) =>
      group.members.filter((member) => member.id === selectedMediaId)
        .map((selected) => ({ group, selected })),
    );
    const normalizedMembers = groups.flatMap((group) => group.members);
    if (normalizedMembers.length !== normalizedEntries.length) {
      return { ok: false, reason: "invalid_detected_media" };
    }
    if (selectedMatches.length === 0) return { ok: false, reason: "media_not_found" };
    if (selectedMatches.length !== 1) return { ok: false, reason: "invalid_detected_media" };

    const { group, selected } = selectedMatches[0];
    const recommendation = recommendBestCopy(group.members.map((media) => ({
      media,
      supported: hasConservativeCaptureDownloadSupport(media),
    })));
    const copyChoice: CaptureCopyChoiceV1 = recommendation === null
      ? {
          candidateId: selected.id,
          confidence: "exact",
          reason: EXACT_SELECTION_REASON,
        }
      : recommendation.candidateId === selected.id
        ? {
            candidateId: selected.id,
            confidence: recommendation.confidence,
            reason: recommendation.reason,
          }
        : {
            candidateId: selected.id,
            confidence: "unproven",
            reason: CUSTOMER_OVERRIDE_REASON,
          };

    return {
      ok: true,
      value: {
        selected,
        copyChoice,
        ...(group.evidence === "authoritative-family" && selected.familyId !== undefined
          ? { family: { familyId: selected.familyId } }
          : {}),
      },
    };
  } catch {
    return { ok: false, reason: "invalid_detected_media" };
  }
}
