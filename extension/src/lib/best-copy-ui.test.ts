import { describe, expect, it } from "vitest";
import type { DetectedVideo } from "../types";
import type { CaptureJobV1 } from "./capture-pack-types";
import { WEBM_TRANSCODE_SIZE_CAP_BYTES } from "./constants";
import { createMediaSnapshotFromDetected } from "./capture-media-snapshot";
import { groupMedia } from "./media-identity";
import {
  bestCopySelectionChangeCanResetQuickState,
  bestCopyShelfSelectionIsUnavailable,
  captureSnapshotBelongsToMediaGroup,
  createCaptureCopyChoiceReviewPresentation,
  createBestCopyRecommendationPresentation,
  createBestCopyShelfModel,
  hasConservativeShelfDownloadSupport,
  resolveBestCopyQuickInteractionSelection,
} from "./best-copy-ui";

function image(overrides: Partial<DetectedVideo> = {}): DetectedVideo {
  return {
    id: "image-1",
    kind: "image",
    url: "https://img.example/photo-640.jpg",
    detectedAt: 100,
    pageUrl: "https://site.example/gallery",
    width: 640,
    height: 480,
    provenance: ["picture"],
    familyId: "picture-family-1",
    ...overrides,
  };
}

function family(items: DetectedVideo[]) {
  const groups = groupMedia(items);
  expect(groups).toHaveLength(1);
  return groups[0];
}

describe("createBestCopyShelfModel", () => {
  it("uses a high-confidence recommendation only as the unselected default", () => {
    const group = family([
      image({ id: "small", url: "https://img.example/small.jpg" }),
      image({
        id: "large",
        url: "https://img.example/large.jpg",
        width: 1_920,
        height: 1_080,
      }),
    ]);

    expect(createBestCopyShelfModel({ group })).toMatchObject({
      selectedId: "large",
      selectionSource: "recommendation",
      recommendation: {
        candidateId: "large",
        confidence: "high",
      },
    });
  });

  it("keeps unsupported family members in the comparison without recommending them", () => {
    const group = family([
      image({
        id: "protected-large",
        url: "https://img.example/protected.jpg",
        width: 4_000,
        height: 3_000,
        hasCapturedReplayHeaders: true,
      }),
      image({
        id: "public-medium",
        url: "https://img.example/public.jpg",
        width: 1_280,
        height: 720,
      }),
    ]);

    expect(createBestCopyShelfModel({ group })).toMatchObject({
      selectedId: "public-medium",
      selectionSource: "recommendation",
      recommendation: { candidateId: "public-medium" },
    });
  });

  it("keeps an explicit local choice when metadata changes the recommendation", () => {
    const initial = family([
      image({ id: "copy-a", url: "https://img.example/a.jpg", width: 2_000, height: 1_000 }),
      image({ id: "chosen", url: "https://img.example/chosen.jpg", width: 1_000, height: 800 }),
      image({ id: "copy-z", url: "https://img.example/z.jpg", width: 500, height: 500 }),
    ]);
    const updated = family([
      image({ id: "copy-a", url: "https://img.example/a.jpg", width: 600, height: 400, detectedAt: 900 }),
      image({ id: "chosen", url: "https://img.example/chosen.jpg", width: 1_000, height: 800, pageTitle: "Updated" }),
      image({ id: "copy-z", url: "https://img.example/z.jpg", width: 3_000, height: 2_000 }),
    ]);
    expect(initial.groupId).toBe(updated.groupId);
    expect(createBestCopyShelfModel({ group: initial }).recommendation?.candidateId).toBe("copy-a");
    expect(createBestCopyShelfModel({
      group: updated,
      localSelection: { candidateId: "chosen" },
    })).toMatchObject({
      selectedId: "chosen",
      selectionSource: "customer-override",
      recommendation: { candidateId: "copy-z" },
    });
  });

  it("keeps the immutable draft copy ahead of both local choice and recommendation", () => {
    const initial = family([
      image({ id: "draft-copy", url: "https://img.example/draft.jpg", width: 800, height: 600 }),
      image({ id: "local-copy", url: "https://img.example/local.jpg", width: 1_200, height: 800 }),
      image({ id: "best-copy", url: "https://img.example/best.jpg", width: 2_400, height: 1_600 }),
    ]);
    const updated = family([
      image({ id: "draft-copy", url: "https://img.example/draft.jpg", width: 4_000, height: 3_000, detectedAt: 500 }),
      image({ id: "local-copy", url: "https://img.example/local.jpg", width: 3_000, height: 2_000 }),
      image({ id: "best-copy", url: "https://img.example/best.jpg", width: 1_000, height: 700 }),
    ]);

    for (const group of [initial, updated]) {
      expect(createBestCopyShelfModel({
        group,
        localSelection: { candidateId: "local-copy" },
        immutableDraftSelection: { candidateId: "draft-copy" },
      })).toMatchObject({
        selectedId: "draft-copy",
        selectionSource: "immutable-draft",
      });
    }
    expect(createBestCopyShelfModel({ group: initial }).recommendation?.candidateId).toBe(
      "best-copy",
    );
    expect(createBestCopyShelfModel({ group: updated }).recommendation?.candidateId).toBe(
      "draft-copy",
    );
    // Removing the draft authority reveals the earlier local choice; the
    // changing recommendation is never written over it.
    expect(createBestCopyShelfModel({
      group: updated,
      localSelection: { candidateId: "local-copy" },
    })).toMatchObject({
      selectedId: "local-copy",
      selectionSource: "customer-override",
    });
  });

  it("keeps surface-local choices independent until one shared draft becomes authoritative", () => {
    const group = family([
      image({ id: "popup-copy", url: "https://img.example/popup.jpg" }),
      image({ id: "panel-copy", url: "https://img.example/panel.jpg", width: 900, height: 700 }),
      image({ id: "draft-copy", url: "https://img.example/draft.jpg", width: 1_920, height: 1_080 }),
    ]);
    expect(createBestCopyShelfModel({
      group,
      localSelection: { candidateId: "popup-copy" },
    }).selectedId).toBe("popup-copy");
    expect(createBestCopyShelfModel({
      group,
      localSelection: { candidateId: "panel-copy" },
    }).selectedId).toBe("panel-copy");
    for (const localCandidateId of ["popup-copy", "panel-copy"]) {
      expect(createBestCopyShelfModel({
        group,
        localSelection: { candidateId: localCandidateId },
        immutableDraftSelection: { candidateId: "draft-copy" },
      })).toMatchObject({
        selectedId: "draft-copy",
        selectionSource: "immutable-draft",
      });
    }
  });

  it("freezes a Quick interaction across recommendation updates", () => {
    const initial = family([
      image({ id: "initial-best", url: "https://img.example/initial.jpg", width: 2_000, height: 1_000 }),
      image({ id: "quick-copy", url: "https://img.example/quick.jpg", width: 1_000, height: 800 }),
      image({ id: "later-best", url: "https://img.example/later.jpg", width: 500, height: 400 }),
    ]);
    const updated = family([
      image({ id: "initial-best", url: "https://img.example/initial.jpg", width: 600, height: 400 }),
      image({ id: "quick-copy", url: "https://img.example/quick.jpg", width: 1_000, height: 800 }),
      image({ id: "later-best", url: "https://img.example/later.jpg", width: 3_000, height: 2_000 }),
    ]);

    for (const group of [initial, updated]) {
      expect(createBestCopyShelfModel({
        group,
        quickInteractionSelection: { candidateId: "quick-copy" },
      })).toMatchObject({
        selectedId: "quick-copy",
        selectionSource: "quick-interaction",
      });
    }
    expect(createBestCopyShelfModel({ group: initial }).recommendation?.candidateId).toBe(
      "initial-best",
    );
    expect(createBestCopyShelfModel({ group: updated }).recommendation?.candidateId).toBe(
      "later-best",
    );
  });

  it("restores one exact background-owned Quick choice and fails closed on ambiguity", () => {
    const quickJob = {
      jobId: "capture-job:v1:quick-1",
      itemId: "capture-single-item:item-1",
      snapshot: { media: { mediaId: "quick-copy" } },
    } as CaptureJobV1;
    expect(resolveBestCopyQuickInteractionSelection(quickJob.jobId, [quickJob])).toEqual({
      candidateId: "quick-copy",
    });
    expect(resolveBestCopyQuickInteractionSelection(undefined, [quickJob])).toBeUndefined();
    expect(resolveBestCopyQuickInteractionSelection(null, [quickJob])).toEqual({
      candidateId: null,
    });
    expect(resolveBestCopyQuickInteractionSelection(quickJob.jobId, [quickJob, quickJob])).toEqual({
      candidateId: null,
    });
    expect(resolveBestCopyQuickInteractionSelection("capture-job:v1:missing", [quickJob])).toEqual({
      candidateId: null,
    });
  });

  it("fails closed when a local or interaction choice is no longer a member", () => {
    const group = family([
      image({ id: "primary", url: "https://img.example/primary.jpg" }),
      image({ id: "recommended", url: "https://img.example/recommended.jpg", width: 2_000, height: 1_000 }),
    ]);
    const local = createBestCopyShelfModel({
      group,
      localSelection: { candidateId: "evicted-local" },
    });
    expect(local).toMatchObject({
      selectedId: group.primary.id,
      selectionSource: "customer-override-unavailable",
      recommendation: { candidateId: "recommended" },
    });
    expect(bestCopyShelfSelectionIsUnavailable(local.selectionSource)).toBe(true);

    const returned = family([
      ...group.members,
      image({ id: "evicted-local", url: "https://img.example/returned.jpg" }),
    ]);
    expect(createBestCopyShelfModel({
      group: returned,
      localSelection: { candidateId: "evicted-local" },
    })).toMatchObject({
      selectedId: "evicted-local",
      selectionSource: "customer-override",
    });

    const interaction = createBestCopyShelfModel({
      group,
      quickInteractionSelection: { candidateId: "evicted-quick-copy" },
    });
    expect(interaction.selectionSource).toBe("quick-interaction-unavailable");
    expect(bestCopyShelfSelectionIsUnavailable(interaction.selectionSource)).toBe(true);
  });

  it("re-proves an evicted immutable draft copy without filename heuristics", () => {
    const evicted = image({
      id: "evicted-draft",
      url: "https://img.example/evicted.jpg",
      width: 900,
      height: 600,
    });
    const group = family([
      image({ id: "current-a", url: "https://img.example/current-a.jpg" }),
      image({ id: "current-b", url: "https://img.example/current-b.jpg", width: 2_000, height: 1_000 }),
    ]);
    const snapshot = createMediaSnapshotFromDetected(evicted);
    expect(captureSnapshotBelongsToMediaGroup(snapshot, group)).toBe(true);
    const model = createBestCopyShelfModel({
      group,
      immutableDraftSelection: { candidateId: snapshot.mediaId },
    });
    expect(model).toMatchObject({
      selectedId: group.primary.id,
      selectionSource: "immutable-draft-unavailable",
    });
    expect(bestCopyShelfSelectionIsUnavailable(model.selectionSource)).toBe(true);

    const returnedGroup = family([...group.members, evicted]);
    expect(createBestCopyShelfModel({
      group: returnedGroup,
      immutableDraftSelection: { candidateId: snapshot.mediaId },
    })).toMatchObject({
      selectedId: "evicted-draft",
      selectionSource: "immutable-draft",
    });

    const unrelated = createMediaSnapshotFromDetected(image({
      id: "unrelated",
      familyId: undefined,
      url: "https://img.example/another-folder/current-a.jpg",
    }));
    expect(captureSnapshotBelongsToMediaGroup(unrelated, group)).toBe(false);
  });

  it("emits no recommendation for an unproven or metadata-empty group", () => {
    const unrelated = groupMedia([
      image({ id: "one", familyId: undefined, url: "https://img.example/one.jpg" }),
      image({ id: "two", familyId: undefined, url: "https://img.example/two.jpg" }),
    ]);
    expect(unrelated).toHaveLength(2);
    expect(createBestCopyShelfModel({ group: unrelated[0] }).recommendation).toBeNull();

    const noQuality = family([
      image({ id: "one", url: "https://img.example/one.jpg", width: undefined, height: undefined }),
      image({ id: "two", url: "https://img.example/two.jpg", width: undefined, height: undefined }),
    ]);
    expect(createBestCopyShelfModel({ group: noQuality })).toMatchObject({
      selectedId: noQuality.primary.id,
      selectionSource: "group-primary",
      recommendation: null,
    });
  });
});

describe("shelf support and accessible recommendation copy", () => {
  it("never lets live selection changes reset a pending or ambiguous Quick intent", () => {
    const idle = {
      quickCaptureLocked: false,
      pending: false,
      hasCommand: false,
      pickerOpen: false,
      accepted: false,
    };
    expect(bestCopySelectionChangeCanResetQuickState(idle)).toBe(true);
    for (const field of Object.keys(idle) as Array<keyof typeof idle>) {
      expect(bestCopySelectionChangeCanResetQuickState({
        ...idle,
        [field]: true,
      })).toBe(false);
    }
  });

  it("uses only current native capability facts and leaves streams to C7", () => {
    expect(hasConservativeShelfDownloadSupport(image())).toBe(true);
    expect(hasConservativeShelfDownloadSupport(image({
      hasCapturedReplayHeaders: true,
    }))).toBe(false);
    expect(hasConservativeShelfDownloadSupport(image({
      kind: "direct",
      familyId: undefined,
      url: "https://cdn.example/video.mp4",
    }))).toBe(true);
    expect(hasConservativeShelfDownloadSupport(image({
      kind: "direct",
      familyId: undefined,
      url: "https://cdn.example/video.webm",
      sizeBytes: undefined,
    }))).toBe(false);
    expect(hasConservativeShelfDownloadSupport(image({
      kind: "direct",
      familyId: undefined,
      url: "https://cdn.example/video.webm",
      sizeBytes: WEBM_TRANSCODE_SIZE_CAP_BYTES,
    }))).toBe(true);
    expect(hasConservativeShelfDownloadSupport(image({
      kind: "direct",
      familyId: undefined,
      url: "https://cdn.example/video.webm",
      sizeBytes: WEBM_TRANSCODE_SIZE_CAP_BYTES + 1,
    }))).toBe(false);
    expect(hasConservativeShelfDownloadSupport(image({ kind: "hls", familyId: undefined }))).toBe(false);
    expect(hasConservativeShelfDownloadSupport(image({ kind: "dash", familyId: undefined }))).toBe(false);
  });

  it("provides a visible label, accessible name, and unchanged evidence reason", () => {
    const reason = "Recommended because it has the largest supported responsive-image resolution: 1920 × 1080.";
    expect(createBestCopyRecommendationPresentation("hero-1920", {
      candidateId: "large",
      confidence: "high",
      reason,
    })).toEqual({
      label: "Recommended",
      ariaLabel: "Recommended copy: hero-1920",
      reason,
      availabilityNote: "Source availability is checked when you review or start saving.",
    });
  });

  it.each([
    ["high", "Best Copy · high confidence"],
    ["exact", "Selected copy · exact identity"],
    ["unproven", "Your selected alternate"],
  ] as const)("renders every frozen %s Review choice truthfully", (confidence, label) => {
    expect(createCaptureCopyChoiceReviewPresentation({
      candidateId: "chosen-copy",
      confidence,
      reason: "Frozen evidence for this exact choice.",
    })).toEqual({
      label,
      reason: "Frozen evidence for this exact choice.",
    });
  });
});
