import { describe, expect, it } from "vitest";
import {
  claimCaptureJobsFifo,
  prepareCaptureJobs,
  reduceCaptureJob,
} from "./capture-executor";
import type { CaptureJobEvent } from "./capture-executor";
import type {
  CaptureJobV1,
  CapturePlanItemV1,
  CaptureReviewPlanV1,
  MediaSnapshotV1,
  QualityChoiceV1,
} from "./capture-pack-types";

function media(
  itemId: string,
  kind: MediaSnapshotV1["kind"] = "direct",
  partial: Partial<MediaSnapshotV1> = {},
): MediaSnapshotV1 {
  const extension = kind === "hls" ? "m3u8" : kind === "dash" ? "mpd" : kind === "image" ? "jpg" : "mp4";
  return {
    mediaId: `media-${itemId}`,
    kind,
    url: `https://cdn.example/${itemId}.${extension}`,
    detectedAt: 10,
    pageUrl: "https://example.test/article",
    pageTitle: "Article",
    provenance: ["network"],
    ...partial,
  };
}

function planItem(
  itemId: string,
  kind: MediaSnapshotV1["kind"] = "direct",
  partial: Partial<CapturePlanItemV1> = {},
): CapturePlanItemV1 {
  const qualityChoice: QualityChoiceV1 = kind === "hls"
    ? {
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "hls",
        variantUrl: `https://cdn.example/${itemId}-720p.m3u8`,
        fixedVariantId: `https://cdn.example/${itemId}-720p.m3u8`,
        estimateConfidence: "unknown",
      }
    : kind === "dash"
      ? {
          mode: "stream",
          policy: { mode: "manual" },
          variantKind: "dash",
          representationId: `representation-${itemId}`,
          fixedVariantId: `representation-${itemId}`,
          estimateConfidence: "unknown",
        }
    : { mode: "direct" };
  const result = {
    itemId,
    include: true,
    media: media(itemId, kind),
    plannedRelativePath: `ClipHutch/Research/example.test/${itemId}.mp4`,
    readiness: "ready",
    copyChoice: {
      candidateId: `media-${itemId}`,
      confidence: "exact",
      reason: "Exact source",
    },
    qualityChoice,
    warnings: [],
    ...partial,
  };
  if (result.readiness !== "ready") delete (result as { qualityChoice?: QualityChoiceV1 }).qualityChoice;
  return result as CapturePlanItemV1;
}

function reviewPlan(items: CapturePlanItemV1[]): CaptureReviewPlanV1 {
  const included = items.filter((item) => item.include);
  return {
    schemaVersion: 1,
    planId: "plan-1",
    draftId: "draft-1",
    draftRevision: 1,
    generatedAt: 20,
    relativeRoot: "ClipHutch/Research",
    items,
    totals: {
      included: included.length,
      videos: included.filter((item) => item.media.kind !== "image").length,
      stills: included.filter((item) => item.media.kind === "image").length,
      unknownSizeCount: included.filter((item) => item.media.sizeBytes === undefined).length,
      requiredFreeVideoSlots: included.filter((item) => item.media.kind !== "image").length,
    },
  };
}

function expectPrepared(items: CapturePlanItemV1[]): CaptureJobV1[] {
  return prepareCaptureJobs(reviewPlan(items), { runId: "run-1" });
}

type UnguardedEvent<T> = T extends unknown
  ? Omit<T, "attemptId" | "expectedRevision">
  : never;

function apply(job: CaptureJobV1, event: UnguardedEvent<CaptureJobEvent>): CaptureJobV1 {
  const result = reduceCaptureJob(job, {
    ...event,
    attemptId: job.attemptId,
    expectedRevision: job.revision,
  } as Parameters<typeof reduceCaptureJob>[1]);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Transition failed: ${result.reason}`);
  return result.job;
}

describe("prepareCaptureJobs", () => {
  it("creates deterministic, ordered, allowlisted immutable first attempts", () => {
    const direct = planItem("direct");
    const hls = planItem("stream", "hls");
    const excluded = planItem("excluded", "image", { include: false, readiness: "stale" });
    const secret = "must-not-cross-the-plan-boundary";
    (direct.media as MediaSnapshotV1 & { authorization?: string }).authorization = secret;
    (direct.qualityChoice as QualityChoiceV1 & { rawManifest?: string }).rawManifest = secret;

    const first = prepareCaptureJobs(reviewPlan([direct, hls, excluded]), {
      runId: "run-1",
      headerLeaseIdsByItemId: { direct: "lease-1" },
    });
    const second = prepareCaptureJobs(reviewPlan([direct, hls, excluded]), {
      runId: "run-1",
      headerLeaseIdsByItemId: { direct: "lease-1" },
    });

    expect(first).toEqual(second);
    expect(first.map((job) => job.itemId)).toEqual(["direct", "stream"]);
    expect(first.map((job) => job.state)).toEqual(["prepared", "prepared"]);
    expect(first.map((job) => job.resourceClass)).toEqual(["native", "heavy"]);
    expect(first[0].snapshot.headerLeaseId).toBe("lease-1");
    expect(JSON.stringify(first)).not.toContain(secret);

    direct.media.url = "https://mutated.invalid";
    direct.media.provenance.push("metadata");
    expect(first[0].snapshot.media.url).toBe("https://cdn.example/direct.mp4");
    expect(first[0].snapshot.media.provenance).toEqual(["network"]);
  });

  it("routes current WebM conversion work through the heavy lane", () => {
    const byMime = planItem("webm-mime", "direct", {
      media: media("webm-mime", "direct", { contentType: "video/webm" }),
    });
    const byExtension = planItem("webm-ext", "direct", {
      media: media("webm-ext", "direct", { url: "https://cdn.example/file.webm" }),
    });
    expect(expectPrepared([byMime, byExtension]).map((job) => job.resourceClass)).toEqual([
      "heavy",
      "heavy",
    ]);
  });

  it("freezes HLS URLs and DASH representation ids into safe executor aliases", () => {
    const [hls, dash] = expectPrepared([
      planItem("hls", "hls"),
      planItem("dash", "dash"),
    ]);
    expect(hls.snapshot.quality).toMatchObject({
      mode: "stream",
      variantKind: "hls",
      variantUrl: "https://cdn.example/hls-720p.m3u8",
      fixedVariantId: "https://cdn.example/hls-720p.m3u8",
    });
    expect(dash.snapshot.quality).toMatchObject({
      mode: "stream",
      variantKind: "dash",
      representationId: "representation-dash",
      fixedVariantId: "representation-dash",
    });
  });

  it("freezes opaque selector, policy, and cap without a signed child locator", () => {
    const signedChild = "https://cdn.example/720.m3u8?signature=must-not-persist";
    const stableId = `variant-v1-hls-${"a".repeat(40)}`;
    const item = planItem("safe-hls", "hls", {
      qualityChoice: {
        mode: "stream",
        policy: { mode: "manual" },
        selector: { kind: "hls", stableId },
        maxDownloadBytes: 512 * 1024 * 1024,
        combinedBandwidth: 4_000_000,
        durationSec: 10,
        estimatedBytes: 5_000_000,
        estimateConfidence: "estimated",
      },
    });
    const plan = reviewPlan([item]);
    plan.totals = {
      ...plan.totals,
      estimatedBytes: 5_000_000,
      unknownSizeCount: 0,
    };
    const [job] = prepareCaptureJobs(plan, { runId: "run-1" });
    expect(job.snapshot.quality).toEqual({
      mode: "stream",
      policy: { mode: "manual" },
      selector: { kind: "hls", stableId },
      maxDownloadBytes: 512 * 1024 * 1024,
      combinedBandwidth: 4_000_000,
      durationSec: 10,
      estimatedBytes: 5_000_000,
      estimateConfidence: "estimated",
    });
    expect(JSON.stringify(job)).not.toContain(signedChild);
    expect(job.snapshot.quality).not.toHaveProperty("variantUrl");
    expect(job.snapshot.quality).not.toHaveProperty("fixedVariantId");

    if (item.readiness !== "ready" || item.qualityChoice.mode !== "stream" ||
      item.qualityChoice.selector === undefined) throw new Error("Expected safe stream choice");
    item.qualityChoice.selector.stableId = `variant-v1-hls-${"b".repeat(40)}`;
    item.qualityChoice.maxDownloadBytes = 1;
    expect(job.snapshot.quality).toMatchObject({
      selector: { stableId },
      maxDownloadBytes: 512 * 1024 * 1024,
    });
  });

  it("rejects crossed or unsafe frozen stream selections", () => {
    const crossedHls = planItem("crossed-hls", "hls", {
      qualityChoice: {
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "dash",
        representationId: "video-720p",
        estimateConfidence: "unknown",
      },
    });
    const unsafeHls = planItem("unsafe-hls", "hls", {
      qualityChoice: {
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "hls",
        variantUrl: "file:///tmp/playlist.m3u8",
        estimateConfidence: "unknown",
      },
    });
    expect(() => expectPrepared([crossedHls])).toThrowError(
      expect.objectContaining({ code: "invalid_quality" }),
    );
    expect(() => expectPrepared([unsafeHls])).toThrowError(
      expect.objectContaining({ code: "invalid_quality" }),
    );
  });

  it("bounds deterministic identifiers for maximum-length Unicode contract IDs", () => {
    const runId = "界".repeat(256);
    const itemId = "🧪".repeat(128);
    expect(runId).toHaveLength(256);
    expect(itemId).toHaveLength(256);
    const longItem = planItem(itemId, "direct", {
      media: media("bounded-unicode"),
      plannedRelativePath: "ClipHutch/Research/example.test/unicode.mp4",
      copyChoice: {
        candidateId: "media-bounded-unicode",
        confidence: "exact",
        reason: "Exact source",
      },
    });

    const first = prepareCaptureJobs(reviewPlan([longItem]), { runId })[0];
    const second = prepareCaptureJobs(reviewPlan([longItem]), { runId })[0];

    expect(first).toEqual(second);
    expect(first.jobId).toBe(
      "capture-job:v1:e27ca0d5ac6a1a76fd5a7d426c3d00c4080a198233dd30182752f71683f659ca",
    );
    expect(first.attemptId).toBe(
      "capture-attempt:v1:3166c6083537f000f4d7e09ce8f6696fe7aabb24ca0d8be535ba36dce012468b",
    );
    expect(first.jobId.length).toBeLessThanOrEqual(256);
    expect(first.attemptId.length).toBeLessThanOrEqual(256);
    expect(first.runId).toBe(runId);
    expect(first.itemId).toBe(itemId);
  });

  it("rejects included unready items, duplicate identities/paths, and unresolved stream choices", () => {
    expect(() => expectPrepared([planItem("stale", "direct", { readiness: "stale" })])).toThrowError(
      expect.objectContaining({ code: "unready_item" }),
    );

    const duplicate = planItem("same");
    expect(() => expectPrepared([duplicate, { ...duplicate }])).toThrowError(
      expect.objectContaining({ code: "duplicate_item" }),
    );

    const firstPath = planItem("one");
    const secondPath = planItem("two", "image", {
      plannedRelativePath: firstPath.plannedRelativePath.replace("one.mp4", "ONE.mp4"),
    });
    expect(() => expectPrepared([firstPath, secondPath])).toThrowError(
      expect.objectContaining({ code: "duplicate_path" }),
    );

    const unresolved = planItem("unresolved", "hls", {
      qualityChoice: {
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "hls",
        variantUrl: "",
        estimateConfidence: "unknown",
      },
    });
    expect(() => expectPrepared([unresolved])).toThrowError(
      expect.objectContaining({ code: "invalid_quality" }),
    );
  });

  it("rejects stream quality on direct media and an empty header lease", () => {
    const direct = planItem("direct", "direct", {
      qualityChoice: {
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "hls",
        variantUrl: "https://cdn.example/variant.m3u8",
        estimateConfidence: "unknown",
      },
    });
    expect(() => expectPrepared([direct])).toThrowError(
      expect.objectContaining({ code: "invalid_quality" }),
    );
    expect(() =>
      prepareCaptureJobs(reviewPlan([planItem("valid")]), {
        runId: "run",
        headerLeaseIdsByItemId: { valid: " " },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_header_lease" }));
  });
});

describe("reduceCaptureJob", () => {
  it("applies the explicit heavy execution graph without mutating prior revisions", () => {
    const prepared = expectPrepared([planItem("stream", "hls")])[0];
    const queued = apply(prepared, { type: "queue" });
    const starting = apply(queued, { type: "start" });
    const running = apply(starting, { type: "running" });
    const progressed = apply(running, {
      type: "progress",
      progress: { phase: "fetching", completed: 2, total: 10, bytes: 100, ratio: 0.2 },
    });
    const processing = apply(progressed, { type: "processing" });
    const processed = apply(processing, {
      type: "progress",
      progress: { phase: "processing", ratio: 0.8 },
    });
    const delivery = apply(processed, { type: "delivery-ready" });
    const saving = apply(delivery, { type: "saving", downloadId: 42 });
    const complete = apply(saving, {
      type: "complete",
      actualBasename: "video.mp4",
      sizeBytes: 1234,
    });

    expect(prepared).toMatchObject({ state: "prepared", revision: 0 });
    expect(complete).toMatchObject({
      state: "complete",
      revision: 9,
      downloadId: 42,
      result: { actualBasename: "video.mp4", sizeBytes: 1234 },
    });
    expect(complete.progress).toBeUndefined();
    expect(complete.error).toBeUndefined();
  });

  it("durably enters native delivery intent and records ambiguous save acknowledgement", () => {
    const prepared = expectPrepared([planItem("native")])[0];
    const queued = apply(prepared, { type: "queue" });
    const starting = apply(queued, { type: "start" });
    const deliveryPending = apply(starting, { type: "delivery-ready" });
    expect(deliveryPending.state).toBe("delivery_pending");

    const unknown = apply(deliveryPending, {
      type: "save-state-unknown",
      code: "download_ack_unknown",
      customerMessage: "Chrome may have accepted the save.",
    });
    expect(unknown.state).toBe("save_state_unknown");
    expect(unknown.error).toEqual({
      code: "download_ack_unknown",
      customerMessage: "Chrome may have accepted the save.",
      retryable: false,
    });
  });

  it("rejects stale attempts, stale revisions, illegal edges, and late terminal events", () => {
    const prepared = expectPrepared([planItem("one")])[0];
    expect(
      reduceCaptureJob(prepared, {
        type: "queue",
        attemptId: "old-attempt",
        expectedRevision: 0,
      }),
    ).toMatchObject({ ok: false, reason: "stale_attempt" });
    expect(
      reduceCaptureJob(prepared, {
        type: "queue",
        attemptId: prepared.attemptId,
        expectedRevision: 1,
      }),
    ).toMatchObject({ ok: false, reason: "stale_revision" });
    expect(
      reduceCaptureJob(prepared, {
        type: "complete",
        attemptId: prepared.attemptId,
        expectedRevision: 0,
      }),
    ).toMatchObject({ ok: false, reason: "illegal_transition" });

    let job = apply(prepared, { type: "queue" });
    job = apply(job, { type: "start" });
    job = apply(job, { type: "running", downloadId: 7 });
    job = apply(job, { type: "complete", actualBasename: "one.mp4" });
    expect(
      reduceCaptureJob(job, {
        type: "progress",
        progress: { phase: "fetching", bytes: 999 },
        attemptId: job.attemptId,
        expectedRevision: job.revision,
      }),
    ).toMatchObject({ ok: false, reason: "terminal_immutable" });
  });

  it("accepts monotonic bounded progress, no-ops duplicates, and rejects regressions", () => {
    let job = expectPrepared([planItem("stream", "hls")])[0];
    job = apply(job, { type: "queue" });
    job = apply(job, { type: "start" });
    job = apply(job, { type: "running" });
    job = apply(job, {
      type: "progress",
      progress: { phase: "fetching", completed: 2, total: 10, bytes: 100, ratio: 0.2 },
    });

    const duplicate = reduceCaptureJob(job, {
      type: "progress",
      progress: { phase: "fetching", completed: 2, total: 10, bytes: 100, ratio: 0.2 },
      attemptId: job.attemptId,
      expectedRevision: job.revision,
    });
    expect(duplicate).toMatchObject({ ok: true, changed: false });

    const regression = reduceCaptureJob(job, {
      type: "progress",
      progress: { phase: "fetching", bytes: 99 },
      attemptId: job.attemptId,
      expectedRevision: job.revision,
    });
    expect(regression).toMatchObject({ ok: false, reason: "progress_regression" });

    const overflow = reduceCaptureJob(job, {
      type: "progress",
      progress: { phase: "fetching", completed: 11, total: 10 },
      attemptId: job.attemptId,
      expectedRevision: job.revision,
    });
    expect(overflow).toMatchObject({ ok: false, reason: "invalid_event" });
  });

  it("cleans state-specific payloads on failure and cancellation", () => {
    let failed = expectPrepared([planItem("failed", "hls")])[0];
    failed = apply(failed, { type: "queue" });
    failed = apply(failed, { type: "start" });
    failed = apply(failed, { type: "running" });
    failed = apply(failed, {
      type: "progress",
      progress: { phase: "fetching", bytes: 50 },
    });
    failed = apply(failed, {
      type: "fail",
      code: "NETWORK",
      customerMessage: "The source could not be reached.",
      retryable: true,
    });
    expect(failed).toMatchObject({ state: "failed", error: { code: "NETWORK" } });
    expect(failed.progress).toBeUndefined();
    expect(failed.result).toBeUndefined();

    const prepared = expectPrepared([planItem("cancel")])[0];
    const queued = apply(prepared, { type: "queue" });
    const cancelled = apply(queued, { type: "request-cancel" });
    expect(cancelled).toMatchObject({ state: "cancelled" });
    expect(cancelled.progress).toBeUndefined();
    expect(cancelled.error).toBeUndefined();
  });
});

describe("claimCaptureJobsFifo", () => {
  function queuedJobs(items: CapturePlanItemV1[]): CaptureJobV1[] {
    return expectPrepared(items).map((job) => apply(job, { type: "queue" }));
  }

  it("claims one heavy and three native jobs while preserving FIFO lane order", () => {
    const jobs = queuedJobs([
      planItem("heavy-1", "hls"),
      planItem("heavy-2", "dash"),
      planItem("native-1"),
      planItem("native-2", "image"),
      planItem("native-3"),
      planItem("native-4"),
    ]);
    const claimed = claimCaptureJobsFifo(jobs);
    expect(claimed.claims.map((claim) => claim.jobId)).toEqual([
      jobs[0].jobId,
      jobs[2].jobId,
      jobs[3].jobId,
      jobs[4].jobId,
    ]);
    expect(claimed.occupiedAfterClaim).toEqual({ heavy: 1, native: 3 });
  });

  it("counts every slot-holding state before claiming more work", () => {
    const [heavy, nativeOne, nativeTwo, nativeThree] = queuedJobs([
      planItem("heavy", "hls"),
      planItem("native-1"),
      planItem("native-2"),
      planItem("native-3"),
    ]);
    const activeHeavy = apply(heavy, { type: "start" });
    const activeNative = apply(nativeOne, { type: "start" });
    const result = claimCaptureJobsFifo([activeHeavy, activeNative, nativeTwo, nativeThree]);
    expect(result.claims.map((claim) => claim.jobId)).toEqual([nativeTwo.jobId, nativeThree.jobId]);
    expect(result.occupiedBeforeClaim).toEqual({ heavy: 1, native: 1 });
    expect(result.occupiedAfterClaim).toEqual({ heavy: 1, native: 3 });
  });

  it("rejects duplicate jobs and a pre-existing lane overcommit", () => {
    const [job] = queuedJobs([planItem("one")]);
    expect(() => claimCaptureJobsFifo([job, job])).toThrowError(
      expect.objectContaining({ code: "duplicate_job" }),
    );

    const active = queuedJobs([
      planItem("one"),
      planItem("two"),
      planItem("three"),
      planItem("four"),
    ]).map((queued) => apply(queued, { type: "start" }));
    expect(() => claimCaptureJobsFifo(active)).toThrowError(
      expect.objectContaining({ code: "lane_overcommitted" }),
    );
  });
});
