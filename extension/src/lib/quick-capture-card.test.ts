import { describe, expect, it } from "vitest";
import type {
  CaptureDraftV1,
  CaptureJobStateV1,
  CaptureJobV1,
  CaptureReviewPlanV1,
  MediaSnapshotV1,
} from "./capture-pack-types";
import {
  captureJobBlocksQuickStart,
  captureReviewHasExpiringSourceAccess,
  createQuickCaptureCardModel,
  resolveQuickCaptureJobBinding,
} from "./quick-capture-card";

const MEDIA: MediaSnapshotV1 = {
  mediaId: "media-1",
  kind: "direct",
  url: "https://cdn.example/video.mp4",
  detectedAt: 1,
  provenance: ["network"],
};

function job(state: CaptureJobStateV1, overrides: Partial<CaptureJobV1> = {}): CaptureJobV1 {
  return {
    schemaVersion: 1,
    jobId: "capture-job:v1:job-1",
    runId: "capture-run:v1:run-1",
    itemId: "item-1",
    attemptId: "capture-attempt:v1:attempt-1",
    attemptNo: 1,
    revision: 0,
    resourceClass: "native",
    state,
    snapshot: {
      media: MEDIA,
      plannedRelativePath: "ClipHutch/Quick Capture/video.mp4",
      quality: { mode: "direct" },
    },
    ...overrides,
  };
}

function planWith(media: MediaSnapshotV1, include = true): CaptureReviewPlanV1 {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    draftId: "draft-1",
    draftRevision: 1,
    generatedAt: 1,
    relativeRoot: "ClipHutch/Pack",
    items: [{
      itemId: "item-1",
      include,
      media,
      plannedRelativePath: "ClipHutch/Pack/source/video.mp4",
      readiness: "ready",
      qualityChoice: media.kind === "hls"
        ? {
            mode: "stream",
            policy: { mode: "manual" },
            variantKind: "hls",
            variantUrl: "https://cdn.example/quality.m3u8",
            estimateConfidence: "unknown",
          }
        : { mode: "direct" },
      copyChoice: { candidateId: "copy-1", confidence: "exact", reason: "test" },
      warnings: [],
    }],
    totals: {
      included: include ? 1 : 0,
      videos: include ? 1 : 0,
      stills: 0,
      unknownSizeCount: 1,
      requiredFreeVideoSlots: include ? 1 : 0,
    },
  };
}

function draftWith(media: MediaSnapshotV1, headerLeaseId?: string): CaptureDraftV1 {
  return {
    schemaVersion: 1,
    draftId: "draft-1",
    revision: 1,
    name: "Pack",
    createdAt: 1,
    updatedAt: 1,
    orderedItemIds: ["item-1"],
    items: {
      "item-1": {
        itemId: "item-1",
        addedAt: 1,
        media,
        ...(headerLeaseId === undefined ? {} : { headerLeaseId }),
      },
    },
    preferences: {
      folderMode: "pack_page",
      manifestFormats: ["json"],
      qualityPolicy: { mode: "manual" },
    },
  };
}

describe("createQuickCaptureCardModel", () => {
  it("does not bind by media or run and stays locked until the exact job appears", () => {
    const other = job("running", { jobId: "capture-job:v1:other" });
    const model = createQuickCaptureCardModel("capture-job:v1:job-1", [other]);
    expect(model).toMatchObject({
      mode: "awaiting_workspace",
      job: null,
      locked: true,
      canCancel: false,
    });
  });

  it.each(["prepared", "queued", "starting", "running", "processing", "delivery_pending", "saving"] as const)(
    "locks and permits exact-attempt cancellation while %s",
    (state) => {
      const current = job(state);
      const model = createQuickCaptureCardModel(current.jobId, [current]);
      expect(model).toMatchObject({ mode: "active", job: current, locked: true, canCancel: true });
    },
  );

  it("keeps cancelling and unknown saves locked without a duplicate or second cancel", () => {
    expect(createQuickCaptureCardModel(job("cancelling").jobId, [job("cancelling")])).toMatchObject({
      mode: "active",
      locked: true,
      canCancel: false,
    });
    expect(createQuickCaptureCardModel(job("save_state_unknown").jobId, [job("save_state_unknown")])).toMatchObject({
      mode: "outcome_unknown",
      locked: true,
      canRetry: false,
      canStartAgain: false,
    });
  });

  it("classifies only definitive terminal jobs as safe for another Quick Capture", () => {
    expect(captureJobBlocksQuickStart(job("running"))).toBe(true);
    expect(captureJobBlocksQuickStart(job("cancelling"))).toBe(true);
    expect(captureJobBlocksQuickStart(job("save_state_unknown"))).toBe(true);
    expect(captureJobBlocksQuickStart(job("complete"))).toBe(false);
    expect(captureJobBlocksQuickStart(job("failed"))).toBe(false);
    expect(captureJobBlocksQuickStart(job("cancelled"))).toBe(false);
  });

  it("unlocks only terminal jobs and only offers retry for safe retryable outcomes", () => {
    expect(createQuickCaptureCardModel(job("complete").jobId, [job("complete")])).toMatchObject({
      mode: "complete",
      locked: false,
      canStartAgain: true,
    });
    expect(createQuickCaptureCardModel(job("cancelled").jobId, [job("cancelled")])).toMatchObject({
      mode: "cancelled",
      locked: false,
      canRetry: true,
    });
    expect(createQuickCaptureCardModel(job("failed").jobId, [job("failed")])).toMatchObject({
      mode: "failed",
      locked: false,
      canRetry: false,
    });
    const retryable = job("failed", {
      error: { code: "FETCH_FAILED", customerMessage: "Fetch failed.", retryable: true },
    });
    expect(createQuickCaptureCardModel(retryable.jobId, [retryable]).canRetry).toBe(true);
  });

  it("fails closed on malformed or duplicate job bindings and derives bounded progress", () => {
    expect(createQuickCaptureCardModel(null, [])).toMatchObject({
      mode: "outcome_unknown",
      locked: true,
    });
    const current = job("running", {
      progress: { phase: "fetching", completed: 3, total: 4 },
    });
    expect(createQuickCaptureCardModel(current.jobId, [current]).progressPercent).toBe(75);
    expect(createQuickCaptureCardModel(current.jobId, [current, { ...current }])).toMatchObject({
      mode: "awaiting_workspace",
      locked: true,
    });
    const future = { ...current, state: "future_state" } as unknown as CaptureJobV1;
    expect(createQuickCaptureCardModel(current.jobId, [future])).toMatchObject({
      mode: "outcome_unknown",
      locked: true,
    });
  });
});

describe("captureReviewHasExpiringSourceAccess", () => {
  it("flags only included items with a lease in the exact reviewed draft", () => {
    const hls: MediaSnapshotV1 = {
      ...MEDIA,
      kind: "hls",
      url: "https://cdn.example/master.m3u8",
    };
    expect(captureReviewHasExpiringSourceAccess(planWith(hls), draftWith(hls))).toBe(false);
    expect(captureReviewHasExpiringSourceAccess(
      planWith(hls, false),
      draftWith(hls, "lease-1"),
    )).toBe(false);
    expect(captureReviewHasExpiringSourceAccess(
      planWith(MEDIA),
      draftWith(MEDIA, "lease-1"),
    )).toBe(true);
    expect(captureReviewHasExpiringSourceAccess(planWith(MEDIA), draftWith(MEDIA))).toBe(false);
    expect(captureReviewHasExpiringSourceAccess(
      planWith(MEDIA),
      { ...draftWith(MEDIA, "lease-1"), revision: 2 },
    )).toBe(false);
  });
});

describe("resolveQuickCaptureJobBinding", () => {
  it("keeps a returned job exact while workspace visibility catches up", () => {
    expect(resolveQuickCaptureJobBinding({
      returnedJobId: "capture-job:v1:returned",
      mediaIds: ["media-1"],
      jobs: [job("running", { jobId: "capture-job:v1:other" })],
    })).toBe("capture-job:v1:returned");
  });

  it("restores one active Quick Capture after a card remount, but fails closed on ambiguity", () => {
    const active = job("running", { itemId: "capture-single-item:one" });
    expect(resolveQuickCaptureJobBinding({
      returnedJobId: undefined,
      mediaIds: ["media-1"],
      jobs: [active],
    })).toBe(active.jobId);
    expect(resolveQuickCaptureJobBinding({
      returnedJobId: undefined,
      mediaIds: ["media-1"],
      jobs: [active, { ...active, jobId: "capture-job:v1:second" }],
    })).toBeNull();
  });

  it("does not infer Pack jobs and lets a newer active Quick Capture supersede a terminal binding", () => {
    const terminal = job("complete");
    const active = job("queued", {
      jobId: "capture-job:v1:new",
      itemId: "capture-single-item:new",
    });
    expect(resolveQuickCaptureJobBinding({
      returnedJobId: terminal.jobId,
      mediaIds: ["media-1"],
      jobs: [terminal, active],
    })).toBe(active.jobId);
    expect(resolveQuickCaptureJobBinding({
      returnedJobId: undefined,
      mediaIds: ["media-1"],
      jobs: [job("running", { itemId: "pack-item" })],
    })).toBeUndefined();
  });
});
