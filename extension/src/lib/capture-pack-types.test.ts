import { describe, expect, it } from "vitest";
import {
  isCaptureDraftV1,
  isCaptureDraftItemV1,
  isCaptureDraftPreferencesV1,
  isCaptureJobV1,
  isCaptureReviewPlanV1,
  isCaptureRunV1,
  isMediaSnapshotV1,
  isMediaFamilyRefV1,
  isPersistentStreamQualityChoiceV1,
  isQualityChoiceV1,
  isQualityPolicyV1,
  type MediaSnapshotV1,
} from "./capture-pack-types";
import { createEmptyCaptureDraftV1 } from "./capture-pack-storage";

const media = (partial: Partial<MediaSnapshotV1> = {}): MediaSnapshotV1 => ({
  mediaId: "media-1",
  kind: "direct",
  url: "https://cdn.example/video.mp4",
  detectedAt: 10,
  pageUrl: "https://example.test/article",
  pageTitle: "Article",
  provenance: ["network"],
  ...partial,
});

describe("capture-pack runtime guards", () => {
  it("accepts a complete media snapshot and rejects malformed numeric fields", () => {
    expect(
      isMediaSnapshotV1(
        media({
          sizeBytes: 100,
          width: 1920,
          height: 1080,
          durationSec: 12.5,
          bitrate: 1_000_000,
          codecs: "avc1.640028",
          provenance: ["network", "metadata"],
        }),
      ),
    ).toBe(true);
    expect(isMediaSnapshotV1({ ...media(), width: -1 })).toBe(false);
    expect(isMediaSnapshotV1({ ...media(), provenance: [] })).toBe(false);
    expect(isMediaSnapshotV1({ ...media(), provenance: ["network", "network"] })).toBe(false);
    expect(isMediaSnapshotV1({ ...media(), firstSeenAt: 11 })).toBe(false);
    expect(isMediaSnapshotV1({ ...media(), lastSeenAt: 9 })).toBe(false);
  });

  it("accepts only bounded HTTP(S) media and page metadata", () => {
    expect(isMediaSnapshotV1({ ...media(), url: "ftp://cdn.example/video.mp4" })).toBe(false);
    expect(isMediaSnapshotV1({ ...media(), pageUrl: "javascript:alert(1)" })).toBe(false);
    expect(isMediaSnapshotV1({ ...media(), pageTitle: "x".repeat(1_025) })).toBe(false);
    expect(isMediaSnapshotV1({ ...media(), url: `https://example.test/${"x".repeat(17_000)}` })).toBe(
      false,
    );
  });

  it("makes every exported guard exception-safe for hostile accessors", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile getter");
      },
    });
    const guards: Array<(value: unknown) => boolean> = [
      isMediaSnapshotV1,
      isMediaFamilyRefV1,
      isQualityPolicyV1,
      isQualityChoiceV1,
      isCaptureDraftPreferencesV1,
      isCaptureDraftItemV1,
      isCaptureDraftV1,
      isCaptureReviewPlanV1,
      isCaptureRunV1,
      isCaptureJobV1,
    ];
    for (const guard of guards) expect(() => guard(hostile)).not.toThrow();
    for (const guard of guards) expect(guard(hostile)).toBe(false);
  });

  it("validates both quality-policy and quality-choice variants", () => {
    expect(isQualityPolicyV1({ mode: "manual" })).toBe(true);
    expect(
      isQualityPolicyV1({
        mode: "best_under_cap",
        maxEstimatedBytes: 512 * 1024 * 1024,
        maxHeight: 1080,
      }),
    ).toBe(true);
    expect(isQualityPolicyV1({ mode: "best_under_cap", maxEstimatedBytes: 0 })).toBe(false);
    expect(
      isQualityChoiceV1({
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "hls",
        variantUrl: "https://cdn.example/variant-1.m3u8",
        estimateConfidence: "unknown",
      }),
    ).toBe(true);
    expect(
      isQualityChoiceV1({
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "dash",
        representationId: "video-1080p",
        estimateConfidence: "unknown",
      }),
    ).toBe(true);
    expect(
      isQualityChoiceV1({
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "hls",
        variantUrl: "variant-1",
        estimateConfidence: "unknown",
      }),
    ).toBe(false);
    expect(
      isQualityChoiceV1({
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "hls",
        variantUrl: "https://cdn.example/variant-1.m3u8",
        fixedVariantId: "https://cdn.example/different.m3u8",
        estimateConfidence: "unknown",
      }),
    ).toBe(false);
    expect(
      isQualityChoiceV1({
        mode: "stream",
        policy: { mode: "manual" },
        estimateConfidence: "guess",
      }),
    ).toBe(false);
    expect(
      isQualityChoiceV1({
        mode: "stream",
        policy: { mode: "manual" },
        estimatedBytes: 100,
        estimateConfidence: "unknown",
      }),
    ).toBe(false);
    expect(
      isQualityChoiceV1({
        mode: "stream",
        policy: { mode: "manual" },
        estimateConfidence: "estimated",
      }),
    ).toBe(false);

    const persistent = {
      mode: "stream",
      policy: { mode: "manual" },
      selector: { kind: "hls", stableId: `variant-v1-hls-${"a".repeat(40)}` },
      maxDownloadBytes: 512 * 1024 * 1024,
      videoBandwidth: 4_000_000,
      audioBandwidth: 128_000,
      combinedBandwidth: 4_128_000,
      durationSec: 10,
      estimatedBytes: 5_160_000,
      estimateConfidence: "estimated",
    };
    expect(isPersistentStreamQualityChoiceV1(persistent)).toBe(true);
    expect(isQualityChoiceV1(persistent)).toBe(true);
    expect(isQualityChoiceV1({
      ...persistent,
      variantUrl: "https://cdn.example/child.m3u8?signature=secret",
    })).toBe(false);
    expect(isQualityChoiceV1({ ...persistent, maxDownloadBytes: 0 })).toBe(false);
    expect(isQualityChoiceV1({ ...persistent, estimatedBytes: 1 })).toBe(false);
    expect(isQualityChoiceV1({ ...persistent, maxDownloadBytes: 5_159_999 })).toBe(false);
    expect(isQualityChoiceV1({
      ...persistent,
      estimatedBytes: undefined,
      estimateConfidence: "unknown",
    })).toBe(false);

    const automatic = {
      ...persistent,
      policy: { mode: "best_under_cap", maxEstimatedBytes: 10_000_000, maxHeight: 720 },
      maxDownloadBytes: 10_000_000,
      width: 1_280,
      height: 720,
      estimatedBytes: 9_000_000,
      estimateConfidence: "exact",
    };
    expect(isQualityChoiceV1(automatic)).toBe(true);
    expect(isQualityChoiceV1({ ...automatic, maxDownloadBytes: 10_000_001 })).toBe(false);
    expect(isQualityChoiceV1({ ...automatic, height: 1_080 })).toBe(false);
    expect(isQualityChoiceV1({ ...automatic, estimateConfidence: "unknown", estimatedBytes: undefined }))
      .toBe(false);

    const revokedSelector = Proxy.revocable({}, {});
    revokedSelector.revoke();
    const hostilePersistent = { ...persistent, selector: revokedSelector.proxy };
    expect(() => isQualityChoiceV1(hostilePersistent)).not.toThrow();
    expect(isQualityChoiceV1(hostilePersistent)).toBe(false);
  });

  it("rejects a future or internally inconsistent draft", () => {
    const draft = createEmptyCaptureDraftV1({ draftId: "draft-1", name: "Research", now: 10 });
    expect(isCaptureDraftV1(draft)).toBe(true);
    expect(isCaptureDraftV1({ ...draft, schemaVersion: 2 })).toBe(false);
    expect(isCaptureDraftV1({ ...draft, orderedItemIds: ["missing"] })).toBe(false);
  });

  it("requires canonical mandatory JSON manifest preferences", () => {
    expect(isCaptureDraftPreferencesV1({
      folderMode: "pack_page",
      manifestFormats: ["json"],
      qualityPolicy: { mode: "manual" },
    })).toBe(true);
    expect(isCaptureDraftPreferencesV1({
      folderMode: "pack_page",
      manifestFormats: ["json", "csv"],
      qualityPolicy: { mode: "manual" },
    })).toBe(true);
    expect(isCaptureDraftPreferencesV1({
      folderMode: "pack_page",
      manifestFormats: ["csv"],
      qualityPolicy: { mode: "manual" },
    })).toBe(false);
    expect(isCaptureDraftPreferencesV1({
      folderMode: "pack_page",
      manifestFormats: ["csv", "json"],
      qualityPolicy: { mode: "manual" },
    })).toBe(false);
  });

  it("accepts only canonical bounded page-folder labels", () => {
    const base = {
      itemId: "item-1",
      addedAt: 10,
      media: media(),
    };
    expect(isCaptureDraftItemV1({ ...base, pageFolderLabel: "Interview selects" })).toBe(true);
    expect(isCaptureDraftItemV1({ ...base, pageFolderLabel: " Interview selects " })).toBe(false);
    expect(isCaptureDraftItemV1({ ...base, pageFolderLabel: "" })).toBe(false);
    expect(isCaptureDraftItemV1({ ...base, pageFolderLabel: " ".repeat(3) })).toBe(false);
    expect(isCaptureDraftItemV1({ ...base, pageFolderLabel: "x".repeat(121) })).toBe(false);
    expect(isCaptureDraftItemV1({ ...base, pageFolderLabel: "unsafe\nlabel" })).toBe(false);
    expect(isCaptureDraftItemV1({ ...base, pageFolderLabel: "unsafe\u202elabel" })).toBe(false);
    expect(isCaptureDraftItemV1({
      ...base,
      pageFolderLabel: "Orphan label",
      media: media({ pageUrl: undefined }),
    })).toBe(false);
  });

  it("accepts legacy draft items without a copy choice and strictly binds new choices to media", () => {
    const base = {
      itemId: "item-1",
      addedAt: 10,
      media: media(),
    };
    expect(isCaptureDraftItemV1(base)).toBe(true);
    expect(isCaptureDraftItemV1({
      ...base,
      copyChoice: {
        candidateId: base.media.mediaId,
        confidence: "high",
        reason: "Largest verified responsive image.",
      },
    })).toBe(true);
    expect(isCaptureDraftItemV1({
      ...base,
      copyChoice: {
        candidateId: "other-media",
        confidence: "high",
        reason: "Cross-item pointer.",
      },
    })).toBe(false);
    expect(isCaptureDraftItemV1({
      ...base,
      copyChoice: {
        candidateId: base.media.mediaId,
        confidence: "high",
        reason: "Unsafe\nreason",
      },
    })).toBe(false);
    expect(isCaptureDraftItemV1({
      ...base,
      copyChoice: {
        candidateId: base.media.mediaId,
        confidence: "invented",
        reason: "Unknown confidence.",
      },
    })).toBe(false);
  });

  it("rejects split labels for items from the same normalized page", () => {
    const base = createEmptyCaptureDraftV1({ draftId: "draft-1", name: "Research", now: 10 });
    const itemA = {
      itemId: "item-a",
      addedAt: 10,
      pageFolderLabel: "Page A",
      media: media({ mediaId: "media-a", pageUrl: "https://example.test/page" }),
    };
    const itemB = {
      itemId: "item-b",
      addedAt: 10,
      pageFolderLabel: "Different",
      media: media({ mediaId: "media-b", pageUrl: "https://example.test:443/page" }),
    };
    expect(isCaptureDraftV1({
      ...base,
      orderedItemIds: ["item-a", "item-b"],
      items: { "item-a": itemA, "item-b": itemB },
    })).toBe(false);
    expect(isCaptureDraftV1({
      ...base,
      orderedItemIds: ["item-a", "item-b"],
      items: {
        "item-a": itemA,
        "item-b": { ...itemB, pageFolderLabel: "Page A" },
      },
    })).toBe(true);
  });

  it("validates a review plan including its immutable media and quality choices", () => {
    const plan = {
      schemaVersion: 1,
      planId: "plan-1",
      draftId: "draft-1",
      draftRevision: 2,
      generatedAt: 20,
      relativeRoot: "ClipHutch/Research",
      items: [
        {
          itemId: "item-1",
          include: true,
          media: media(),
          plannedRelativePath: "ClipHutch/Research/example/video.mp4",
          readiness: "ready",
          copyChoice: {
            candidateId: "media-1",
            confidence: "exact",
            reason: "Exact detected source",
          },
          qualityChoice: { mode: "direct" },
          warnings: [],
        },
      ],
      totals: {
        included: 1,
        videos: 1,
        stills: 0,
        unknownSizeCount: 1,
        requiredFreeVideoSlots: 1,
      },
    };
    expect(isCaptureReviewPlanV1(plan)).toBe(true);
    expect(isCaptureReviewPlanV1({
      ...plan,
      items: [{
        ...plan.items[0],
        copyChoice: {
          candidateId: "media-1",
          confidence: "high",
          reason: "Largest verified responsive image.",
        },
      }],
    })).toBe(true);
    expect(isCaptureReviewPlanV1({
      ...plan,
      items: [{
        ...plan.items[0],
        copyChoice: { ...plan.items[0].copyChoice, candidateId: "other-media" },
      }],
    })).toBe(false);
    expect(isCaptureReviewPlanV1({
      ...plan,
      items: [{
        ...plan.items[0],
        copyChoice: { ...plan.items[0].copyChoice, reason: "Unsafe\nreason" },
      }],
    })).toBe(false);
    const manifested = {
      ...plan,
      manifestSpec: {
        schemaVersion: 1,
        formats: ["json", "csv"],
        packName: "Research",
        createdAt: 5,
        itemAddedAt: { "item-1": 10 },
      },
    };
    expect(isCaptureReviewPlanV1(manifested)).toBe(true);
    expect(isCaptureReviewPlanV1({
      ...manifested,
      planId: "capture-single-plan:forged-manifest",
    })).toBe(false);
    expect(isCaptureReviewPlanV1({
      ...manifested,
      manifestSpec: { ...manifested.manifestSpec, formats: ["csv"] },
    })).toBe(false);
    expect(isCaptureReviewPlanV1({
      ...manifested,
      manifestSpec: { ...manifested.manifestSpec, itemAddedAt: { other: 10 } },
    })).toBe(false);
    expect(isCaptureReviewPlanV1({
      ...plan,
      totals: { ...plan.totals, estimatedBytes: 0 },
    })).toBe(false);
    const knownPlan = {
      ...plan,
      items: [{ ...plan.items[0], media: media({ sizeBytes: 100 }) }],
      totals: {
        ...plan.totals,
        estimatedBytes: 100,
        unknownSizeCount: 0,
      },
    };
    expect(isCaptureReviewPlanV1(knownPlan)).toBe(true);
    expect(isCaptureReviewPlanV1({
      ...knownPlan,
      totals: { ...knownPlan.totals, estimatedBytes: undefined },
    })).toBe(false);
    expect(isCaptureReviewPlanV1({ ...plan, draftRevision: -1 })).toBe(false);
    expect(
      isCaptureReviewPlanV1({
        ...plan,
        items: [{ ...plan.items[0], plannedRelativePath: "../escape.mp4" }],
      }),
    ).toBe(false);
    expect(
      isCaptureReviewPlanV1({
        ...plan,
        items: [
          {
            ...plan.items[0],
            media: media({ kind: "hls", url: "https://cdn.example/master.m3u8" }),
            qualityChoice: {
              mode: "stream",
              policy: { mode: "manual" },
              estimateConfidence: "unknown",
            },
          },
        ],
      }),
    ).toBe(false);
    expect(isCaptureReviewPlanV1({ ...plan, totals: { ...plan.totals, included: 2 } })).toBe(
      false,
    );
    expect(isCaptureReviewPlanV1({ ...plan, items: [...plan.items, plan.items[0]] })).toBe(false);
    expect(
      isCaptureReviewPlanV1({
        ...plan,
        items: [
          {
            ...plan.items[0],
            media: media({ kind: "hls", url: "https://cdn.example/master.m3u8" }),
            qualityChoice: { mode: "direct" },
          },
        ],
      }),
    ).toBe(false);
    const legacyQuickItem = {
      ...plan.items[0],
      media: media({ kind: "hls", url: "https://cdn.example/master.m3u8" }),
      qualityChoice: {
        mode: "stream",
        policy: { mode: "manual" },
        fixedVariantId: "legacy-quick-variant",
        estimateConfidence: "unknown",
      },
    };
    expect(isCaptureReviewPlanV1({
      ...plan,
      planId: "capture-single-plan:legacy",
      items: [legacyQuickItem],
    })).toBe(true);
    expect(isCaptureReviewPlanV1({ ...plan, items: [legacyQuickItem] })).toBe(false);
  });

  it("validates run and attempt-scoped job records", () => {
    const run = {
        schemaVersion: 1,
        runId: "run-1",
        planId: "plan-1",
        draftId: "draft-1",
        draftRevision: 2,
        planDigest: "a".repeat(64),
        commandId: "command-1",
        createdAt: 30,
        status: "running",
        orderedJobIds: ["job-1"],
      };
    expect(isCaptureRunV1(run)).toBe(true);
    expect(isCaptureRunV1({ ...run, manifestDownloadIds: [1, 2] })).toBe(true);
    expect(isCaptureRunV1({ ...run, manifestDownloadIds: [1, 2, 3] })).toBe(false);

    const job = {
      schemaVersion: 1,
      jobId: "job-1",
      runId: "run-1",
      itemId: "item-1",
      attemptId: "attempt-1",
      attemptNo: 1,
      revision: 0,
      resourceClass: "heavy",
      state: "running",
      snapshot: {
        media: media({ kind: "hls", url: "https://cdn.example/master.m3u8" }),
        plannedRelativePath: "ClipHutch/Research/example/video.mp4",
        quality: {
          mode: "stream",
          policy: { mode: "manual" },
          variantKind: "hls",
          variantUrl: "https://cdn.example/variant-1.m3u8",
          estimateConfidence: "unknown",
        },
      },
      progress: { phase: "fetching", completed: 2, total: 10, ratio: 0.2 },
    };
    expect(isCaptureJobV1(job)).toBe(true);
    expect(isCaptureJobV1({ ...job, attemptNo: 0 })).toBe(false);
    expect(isCaptureJobV1({ ...job, progress: { phase: "fetching", ratio: 2 } })).toBe(false);
    expect(
      isCaptureJobV1({
        ...job,
        progress: { phase: "fetching", completed: 11, total: 10 },
      }),
    ).toBe(false);
    expect(isCaptureJobV1({ ...job, resourceClass: "native" })).toBe(false);
    expect(
      isCaptureJobV1({
        ...job,
        snapshot: {
          ...job.snapshot,
          quality: {
            mode: "stream",
            policy: { mode: "manual" },
            estimateConfidence: "unknown",
          },
        },
      }),
    ).toBe(false);
    expect(isCaptureJobV1({ ...job, state: "failed" })).toBe(false);
    expect(
      isCaptureJobV1({
        ...job,
        state: "failed",
        progress: undefined,
        error: { code: "FETCH_FAILED", customerMessage: "Download failed.", retryable: true },
      }),
    ).toBe(true);
    expect(isCaptureJobV1({ ...job, state: "save_state_unknown" })).toBe(false);
    expect(
      isCaptureJobV1({
        ...job,
        state: "save_state_unknown",
        progress: undefined,
        error: {
          code: "SAVE_STATE_UNKNOWN",
          customerMessage: "Chrome did not report the final save state.",
          retryable: false,
        },
      }),
    ).toBe(true);
    expect(isCaptureJobV1({ ...job, state: "complete" })).toBe(false);
    expect(isCaptureJobV1({ ...job, state: "complete", progress: undefined, result: {} })).toBe(true);
    expect(isCaptureJobV1({
      ...job,
      state: "complete",
      progress: undefined,
      result: { actualBasename: `${"a".repeat(251)}.mp4` },
    })).toBe(true);
    expect(isCaptureJobV1({
      ...job,
      state: "complete",
      progress: undefined,
      result: { actualBasename: `${"a".repeat(252)}.mp4` },
    })).toBe(false);
    expect(
      isCaptureJobV1({
        ...job,
        error: { code: "EARLY_ERROR", customerMessage: "Unexpected.", retryable: true },
      }),
    ).toBe(false);
  });
});
