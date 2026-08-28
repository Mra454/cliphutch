import type { DetectedVideo } from "../types";
import type {
  CaptureCopyChoiceV1,
  CaptureJobV1,
  MediaSnapshotV1,
} from "./capture-pack-types";
import {
  recommendBestCopy,
  type BestCopyRecommendationV1,
} from "./best-copy";
import { hasConservativeCaptureDownloadSupport } from "./capture-copy-choice";
import {
  groupMedia,
  normalizeDetectedVideo,
  type MediaGroup,
} from "./media-identity";

export type BestCopyShelfSelectionSource =
  | "immutable-draft"
  | "customer-override"
  | "quick-interaction"
  | "immutable-draft-unavailable"
  | "customer-override-unavailable"
  | "quick-interaction-unavailable"
  | "recommendation"
  | "group-primary";

export type BestCopyShelfModel = {
  selectedId: string;
  selectionSource: BestCopyShelfSelectionSource;
  recommendation: BestCopyRecommendationV1 | null;
};

export type BestCopyRecommendationPresentation = {
  label: "Recommended";
  ariaLabel: string;
  reason: string;
  availabilityNote: "Source availability is checked when you review or start saving.";
};

export type CaptureCopyChoiceReviewPresentation = {
  label:
    | "Best Copy · high confidence"
    | "Selected copy · exact identity"
    | "Your selected alternate";
  reason: string;
};

export type BestCopyShelfSelectionIntent = {
  /** Null means a background-owned Quick selection exists but is ambiguous. */
  candidateId: string | null;
};

/** Restores one background-owned Quick choice without writing UI state. */
export function resolveBestCopyQuickInteractionSelection(
  boundJobId: string | null | undefined,
  jobs: readonly CaptureJobV1[],
): BestCopyShelfSelectionIntent | undefined {
  if (boundJobId === undefined) return undefined;
  if (boundJobId === null) return { candidateId: null };
  const matches = jobs.filter((job) =>
    job.jobId === boundJobId && job.itemId.startsWith("capture-single-item:")
  );
  return matches.length === 1
    ? { candidateId: matches[0].snapshot.media.mediaId }
    : { candidateId: null };
}

/**
 * Current shelf capability only; this does not claim that a remote URL is
 * reachable. Native direct/image shapes match the Capture Pack planner.
 * Header-backed native records are excluded because the current saver cannot
 * safely replay those credentials.
 * Streams remain unsupported here until C7 preflight proves a rendition.
 * Unknown-size WebM is deliberately not used to justify a recommendation.
 */
export const hasConservativeShelfDownloadSupport =
  hasConservativeCaptureDownloadSupport;

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
  return detected?.id === snapshot.mediaId ? detected : undefined;
}

/** Re-proves an evicted draft snapshot against the current conservative group. */
export function captureSnapshotBelongsToMediaGroup(
  snapshot: MediaSnapshotV1,
  group: MediaGroup,
): boolean {
  if (group.members.some((member) => member.id === snapshot.mediaId)) return true;
  const detected = detectedFromSnapshot(snapshot);
  if (!detected || group.evidence === "single") return false;
  const regrouped = groupMedia([...group.members, detected]);
  return (
    regrouped.length === 1 &&
    regrouped[0].evidence === group.evidence &&
    regrouped[0].members.length === group.members.length + 1
  );
}

export function bestCopyShelfSelectionIsUnavailable(
  source: BestCopyShelfSelectionSource,
): boolean {
  return source.endsWith("-unavailable");
}

/** Selection cleanup is allowed only when no Quick intent can still exist. */
export function bestCopySelectionChangeCanResetQuickState(input: {
  quickCaptureLocked: boolean;
  pending: boolean;
  hasCommand: boolean;
  pickerOpen: boolean;
  accepted: boolean;
}): boolean {
  return !(
    input.quickCaptureLocked || input.pending || input.hasCommand ||
    input.pickerOpen || input.accepted
  );
}

/**
 * Computes a recommendation without writing it into selection state. Existing
 * customer and background-owned draft choices therefore remain authoritative
 * if later metadata changes which candidate is recommended.
 */
export function createBestCopyShelfModel(input: {
  group: MediaGroup;
  localSelection?: BestCopyShelfSelectionIntent;
  immutableDraftSelection?: BestCopyShelfSelectionIntent;
  quickInteractionSelection?: BestCopyShelfSelectionIntent;
}): BestCopyShelfModel {
  const membersById = new Map(input.group.members.map((member) => [member.id, member]));
  const recommendation = recommendBestCopy(input.group.members.map((media) => ({
    media,
    supported: hasConservativeShelfDownloadSupport(media),
  })));

  if (input.immutableDraftSelection) {
    const selectedId = input.immutableDraftSelection.candidateId;
    if (selectedId === null || !membersById.has(selectedId)) {
      return {
        selectedId: input.group.primary.id,
        selectionSource: "immutable-draft-unavailable",
        recommendation,
      };
    }
    return {
      selectedId,
      selectionSource: "immutable-draft",
      recommendation,
    };
  }
  if (input.localSelection) {
    const selectedId = input.localSelection.candidateId;
    if (selectedId === null || !membersById.has(selectedId)) {
      return {
        selectedId: input.group.primary.id,
        selectionSource: "customer-override-unavailable",
        recommendation,
      };
    }
    return {
      selectedId,
      selectionSource: "customer-override",
      recommendation,
    };
  }
  if (input.quickInteractionSelection) {
    const selectedId = input.quickInteractionSelection.candidateId;
    if (selectedId === null || !membersById.has(selectedId)) {
      return {
        selectedId: input.group.primary.id,
        selectionSource: "quick-interaction-unavailable",
        recommendation,
      };
    }
    return {
      selectedId,
      selectionSource: "quick-interaction",
      recommendation,
    };
  }
  if (recommendation && membersById.has(recommendation.candidateId)) {
    return {
      selectedId: recommendation.candidateId,
      selectionSource: "recommendation",
      recommendation,
    };
  }
  return {
    selectedId: input.group.primary.id,
    selectionSource: "group-primary",
    recommendation,
  };
}

export function createBestCopyRecommendationPresentation(
  candidateDisplayName: string,
  recommendation: BestCopyRecommendationV1,
): BestCopyRecommendationPresentation {
  return {
    label: "Recommended",
    ariaLabel: `Recommended copy: ${candidateDisplayName}`,
    reason: recommendation.reason,
    availabilityNote: "Source availability is checked when you review or start saving.",
  };
}

export function createCaptureCopyChoiceReviewPresentation(
  copyChoice: CaptureCopyChoiceV1,
): CaptureCopyChoiceReviewPresentation {
  return {
    label: copyChoice.confidence === "high"
      ? "Best Copy · high confidence"
      : copyChoice.confidence === "exact"
        ? "Selected copy · exact identity"
        : "Your selected alternate",
    reason: copyChoice.reason,
  };
}
