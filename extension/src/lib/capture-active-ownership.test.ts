import { describe, expect, it } from "vitest";
import { prepareCaptureJobs } from "./capture-executor";
import { createSingleCapturePlan } from "./capture-single-plan";
import {
  activeJobOwnsQuickPlan,
  activeRunOwnsReviewPlan,
} from "./capture-active-ownership";

const COMMAND = "download-123e4567-e89b-42d3-a456-426614174000";

function quickPlan(commandId = COMMAND) {
  const result = createSingleCapturePlan({
    commandId,
    tabId: 7,
    generatedAt: 10,
    media: {
      id: "media-1",
      url: "https://cdn.example/video.mp4?token=signed",
      kind: "direct",
      detectedAt: 5,
      pageUrl: "https://example.test/watch",
      contentType: "video/mp4",
    },
    qualityChoice: { mode: "direct" },
    filenameTemplate: "pageTitle",
  });
  if (!result.ok) throw new Error("Expected quick plan");
  return result.plan;
}

describe("active capture ownership", () => {
  it("binds one active run to one reviewed draft revision", () => {
    const plan = quickPlan();
    const run = {
      schemaVersion: 1 as const,
      runId: "run-1",
      planId: plan.planId,
      draftId: plan.draftId,
      draftRevision: plan.draftRevision,
      planDigest: "a".repeat(64),
      commandId: "123e4567-e89b-42d3-a456-426614174000",
      createdAt: 10,
      status: "queued" as const,
      orderedJobIds: ["job-1"],
    };
    expect(activeRunOwnsReviewPlan(run, plan)).toBe(true);
    expect(activeRunOwnsReviewPlan({ ...run, status: "complete" }, plan)).toBe(false);
    expect(activeRunOwnsReviewPlan({ ...run, draftRevision: plan.draftRevision + 1 }, plan))
      .toBe(false);
  });

  it("coalesces command-distinct active Quick jobs by immutable execution snapshot", () => {
    const firstPlan = quickPlan();
    const secondPlan = quickPlan("download-223e4567-e89b-42d3-a456-426614174000");
    const [job] = prepareCaptureJobs(firstPlan, { runId: "run-1" });
    expect(activeJobOwnsQuickPlan(job, secondPlan)).toBe(true);
    expect(activeJobOwnsQuickPlan({ ...job, state: "complete" }, secondPlan)).toBe(false);
    expect(activeJobOwnsQuickPlan({
      ...job,
      snapshot: { ...job.snapshot, plannedRelativePath: "ClipHutch/Other/file.mp4" },
    }, secondPlan)).toBe(false);
  });

  it("ignores refreshed observation/display metadata but not source identity", () => {
    const firstPlan = quickPlan();
    const secondPlan = quickPlan("download-223e4567-e89b-42d3-a456-426614174000");
    const [job] = prepareCaptureJobs(firstPlan, { runId: "run-1" });
    const refreshedJob = {
      ...job,
      snapshot: {
        ...job.snapshot,
        media: {
          ...job.snapshot.media,
          lastSeenAt: 99,
          pageTitle: "A refreshed title",
          sizeBytes: 8_000,
          width: 1_920,
          height: 1_080,
          provenance: ["metadata" as const],
        },
      },
    };
    expect(activeJobOwnsQuickPlan(refreshedJob, secondPlan)).toBe(true);

    const otherSource = quickPlan("download-323e4567-e89b-42d3-a456-426614174000");
    otherSource.items[0].media.url = "https://cdn.example/other.mp4?token=signed";
    expect(activeJobOwnsQuickPlan(job, otherSource)).toBe(false);

    const otherMediaId = structuredClone(secondPlan);
    otherMediaId.items[0].media.mediaId = "media-2";
    expect(activeJobOwnsQuickPlan(job, otherMediaId)).toBe(false);

    const changedResourceClass = structuredClone(secondPlan);
    changedResourceClass.items[0].media.contentType = "video/webm";
    expect(activeJobOwnsQuickPlan(job, changedResourceClass)).toBe(false);
  });

  it("binds Quick ownership to lease context and executable stream selector", () => {
    const plan = quickPlan();
    const itemId = plan.items[0].itemId;
    const [leasedJob] = prepareCaptureJobs(plan, {
      runId: "run-lease",
      headerLeaseIdsByItemId: { [itemId]: "lease-1" },
    });
    expect(activeJobOwnsQuickPlan(leasedJob, plan)).toBe(false);
    expect(activeJobOwnsQuickPlan(leasedJob, plan, "lease-1")).toBe(true);
    expect(activeJobOwnsQuickPlan(leasedJob, plan, "lease-2")).toBe(false);

    const stream = createSingleCapturePlan({
      commandId: COMMAND,
      tabId: 7,
      generatedAt: 10,
      media: {
        id: "stream-1",
        url: "https://cdn.example/master.m3u8",
        kind: "hls",
        detectedAt: 5,
        pageUrl: "https://example.test/watch",
        contentType: "application/vnd.apple.mpegurl",
      },
      qualityChoice: {
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "hls",
        variantUrl: "https://cdn.example/720.m3u8",
        estimateConfidence: "unknown",
      },
      filenameTemplate: "pageTitle",
    });
    if (!stream.ok) throw new Error("Expected stream plan");
    const [streamJob] = prepareCaptureJobs(stream.plan, { runId: "run-stream" });
    const changedSelector = structuredClone(stream.plan);
    const changedItem = changedSelector.items[0];
    const quality = changedItem?.qualityChoice;
    if (!quality || quality.mode !== "stream" || quality.variantKind !== "hls") {
      throw new Error("Expected HLS choice");
    }
    quality.variantUrl = "https://cdn.example/1080.m3u8";
    quality.fixedVariantId = quality.variantUrl;
    expect(activeJobOwnsQuickPlan(streamJob, changedSelector)).toBe(false);
  });

  it("compares persistent selector/policy/cap while ignoring display metadata", () => {
    const stableId = `variant-v1-hls-${"e".repeat(40)}`;
    const stream = createSingleCapturePlan({
      commandId: COMMAND,
      tabId: 7,
      generatedAt: 10,
      media: {
        id: "safe-stream-1",
        url: "https://cdn.example/master.m3u8",
        kind: "hls",
        detectedAt: 5,
        pageUrl: "https://example.test/watch",
      },
      qualityChoice: {
        mode: "stream",
        policy: { mode: "manual" },
        selector: { kind: "hls", stableId },
        maxDownloadBytes: 512 * 1024 * 1024,
        label: "720p",
        width: 1_280,
        height: 720,
        videoBandwidth: 4_000_000,
        audioBandwidth: 128_000,
        combinedBandwidth: 4_128_000,
        durationSec: 10,
        estimatedBytes: 100,
        estimateConfidence: "exact",
      },
      filenameTemplate: "pageTitle",
    });
    if (!stream.ok) throw new Error("Expected persistent stream plan");
    const [job] = prepareCaptureJobs(stream.plan, { runId: "run-safe-stream" });

    const displayChanged = structuredClone(stream.plan);
    const displayQuality = displayChanged.items[0].qualityChoice;
    if (!displayQuality || displayQuality.mode !== "stream") throw new Error("Expected stream");
    displayQuality.label = "Reviewed quality";
    displayQuality.width = 1_279;
    displayQuality.height = 719;
    displayQuality.videoBandwidth = 5_000_000;
    displayQuality.audioBandwidth = 128_000;
    displayQuality.combinedBandwidth = 5_128_000;
    displayQuality.durationSec = 12;
    expect(activeJobOwnsQuickPlan(job, displayChanged)).toBe(true);

    const selectorChanged = structuredClone(stream.plan);
    const selectorQuality = selectorChanged.items[0].qualityChoice;
    if (!selectorQuality || selectorQuality.mode !== "stream" || !selectorQuality.selector) {
      throw new Error("Expected selector");
    }
    selectorQuality.selector.stableId = `variant-v1-hls-${"f".repeat(40)}`;
    expect(activeJobOwnsQuickPlan(job, selectorChanged)).toBe(false);

    const capChanged = structuredClone(stream.plan);
    const capQuality = capChanged.items[0].qualityChoice;
    if (!capQuality || capQuality.mode !== "stream") throw new Error("Expected stream");
    capQuality.maxDownloadBytes = 256 * 1024 * 1024;
    expect(activeJobOwnsQuickPlan(job, capChanged)).toBe(false);

    const policyChanged = structuredClone(stream.plan);
    const policyQuality = policyChanged.items[0].qualityChoice;
    if (!policyQuality || policyQuality.mode !== "stream") throw new Error("Expected stream");
    policyQuality.policy = {
      mode: "best_under_cap",
      maxEstimatedBytes: 512 * 1024 * 1024,
    };
    expect(activeJobOwnsQuickPlan(job, policyChanged)).toBe(false);
  });
});
