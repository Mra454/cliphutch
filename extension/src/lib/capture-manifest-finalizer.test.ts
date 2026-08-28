import { describe, expect, it } from "vitest";
import type { CaptureJobV1 } from "./capture-pack-types";
import {
  buildCaptureManifestInput,
  captureManifestDeliveryOrder,
  captureManifestDownloadPath,
  serializeCaptureManifestForFormat,
} from "./capture-manifest-finalizer";
import type { CaptureManifestSeedV1 } from "./capture-manifest-seed";

const SECRET = "signed-secret-canary";

function seed(): CaptureManifestSeedV1 {
  return {
    schemaVersion: 1,
    runId: "run-one",
    planId: "plan-one",
    packName: "Research",
    relativeRoot: "ClipHutch/Research",
    createdAt: 10,
    formats: ["json", "csv"],
    items: [
      {
        itemId: "saved",
        included: true,
        jobId: "job-saved",
        plannedPath: "ClipHutch/Research/example.test/video.mp4",
        kind: "direct",
        pageUrl: "https://example.test/article",
        sourceHost: "cdn.example.test",
        width: 1920,
        height: 1080,
        addedAt: 11,
      },
      {
        itemId: "failed",
        included: true,
        jobId: "job-failed",
        plannedPath: "ClipHutch/Research/example.test/stream.mp4",
        kind: "hls",
        pageUrl: "https://example.test/article",
        sourceHost: "media.example.test",
        addedAt: 12,
      },
      {
        itemId: "excluded",
        included: false,
        plannedPath: "ClipHutch/Research/example.test/poster.jpg",
        kind: "image",
        pageUrl: "https://example.test/article",
        sourceHost: "images.example.test",
        addedAt: 13,
      },
    ],
  };
}

function job(
  jobId: string,
  itemId: string,
  kind: "direct" | "hls",
  state: CaptureJobV1["state"],
): CaptureJobV1 {
  return {
    schemaVersion: 1,
    jobId,
    runId: "run-one",
    itemId,
    attemptId: `${jobId}-attempt`,
    attemptNo: 1,
    revision: 3,
    resourceClass: kind === "hls" ? "heavy" : "native",
    state,
    snapshot: {
      media: {
        mediaId: `${itemId}-media`,
        kind,
        url: `https://cdn.example.test/${itemId}?token=${SECRET}`,
        pageUrl: `https://example.test/article?token=${SECRET}`,
        detectedAt: 10,
        provenance: ["network"],
      },
      plannedRelativePath: `ClipHutch/Research/example.test/${itemId === "saved" ? "video" : "stream"}.mp4`,
      quality: kind === "hls"
        ? {
            mode: "stream",
            policy: { mode: "manual" },
            variantKind: "hls",
            variantUrl: "https://cdn.example.test/v.m3u8",
            estimateConfidence: "unknown",
          }
        : { mode: "direct" },
    },
    ...(state === "complete"
      ? { downloadId: 41, result: { actualBasename: "video (1).mp4", sizeBytes: 100 } }
      : {
          error: {
            code: `NETWORK_${SECRET}`,
            customerMessage: `raw ${SECRET}`,
            retryable: true,
          },
        }),
  };
}

describe("Capture Manifest terminal finalizer", () => {
  it("builds one terminal redacted input for JSON and CSV", () => {
    const built = buildCaptureManifestInput({
      seed: seed(),
      jobs: [job("job-saved", "saved", "direct", "complete"), job("job-failed", "failed", "hls", "failed")],
      finalizedAt: 20,
      generatorVersion: "0.1.4",
    });
    expect(built).toMatchObject({
      ok: true,
      input: {
        status: "partial",
        items: [
          { status: "complete", actualFilename: "video (1).mp4" },
          { status: "failed", errorCode: "NETWORK" },
          { status: "excluded" },
        ],
      },
    });
    if (!built.ok) return;
    const json = serializeCaptureManifestForFormat(built.input, "json");
    const csv = serializeCaptureManifestForFormat(built.input, "csv");
    expect(json).toContain("video (1).mp4");
    expect(csv).toContain("video (1).mp4");
    for (const output of [json, csv]) {
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain("mediaId");
      expect(output).not.toContain("commandId");
      expect(output).not.toContain("customerMessage");
    }
  });

  it("requires exact terminal seed/job ownership and one frozen completion time", () => {
    const jobs = [
      {
        ...job("job-saved", "saved", "direct", "complete"),
        state: "running" as const,
        progress: { phase: "fetching" as const },
        downloadId: undefined,
        result: undefined,
      },
      job("job-failed", "failed", "hls", "failed"),
    ];
    expect(buildCaptureManifestInput({
      seed: seed(), jobs, finalizedAt: 20, generatorVersion: "0.1.4",
    })).toEqual({ ok: false, reason: "jobs_not_terminal" });
    jobs[0] = { ...jobs[0], state: "complete", result: { actualBasename: "video.mp4" } };
    expect(buildCaptureManifestInput({
      seed: seed(), jobs, finalizedAt: 12, generatorVersion: "0.1.4",
    })).toEqual({ ok: false, reason: "invalid_finalized_at" });
    expect(buildCaptureManifestInput({
      seed: seed(), jobs: jobs.slice(0, 1), finalizedAt: 20, generatorVersion: "0.1.4",
    })).toEqual({ ok: false, reason: "invalid_jobs" });
  });

  it("saves optional CSV before required JSON under the frozen pack root", () => {
    const value = seed();
    expect(captureManifestDeliveryOrder(value)).toEqual(["csv", "json"]);
    expect(captureManifestDownloadPath(value, "csv")).toBe(
      "ClipHutch/Research/_cliphutch-manifest.csv",
    );
    expect(captureManifestDownloadPath(value, "json")).toBe(
      "ClipHutch/Research/_cliphutch-manifest.json",
    );
  });

  it("preserves an ambiguous Chrome save instead of claiming a definitive failure", () => {
    const ambiguous = job("job-failed", "failed", "hls", "save_state_unknown");
    ambiguous.error = {
      code: "SAVE_STATE_UNKNOWN",
      customerMessage: "private diagnostic text",
      retryable: false,
    };
    const built = buildCaptureManifestInput({
      seed: seed(),
      jobs: [job("job-saved", "saved", "direct", "complete"), ambiguous],
      finalizedAt: 20,
      generatorVersion: "0.1.4",
    });
    expect(built).toMatchObject({
      ok: true,
      input: {
        status: "partial",
        items: [
          { status: "complete" },
          { status: "save_state_unknown", errorCode: "SAVE_STATE_UNKNOWN" },
          { status: "excluded" },
        ],
      },
    });
    if (!built.ok) return;
    const output = serializeCaptureManifestForFormat(built.input, "json");
    expect(output).toContain('"status": "save_state_unknown"');
    expect(output).toContain("Chrome may have accepted this item");
    expect(output).not.toContain("private diagnostic text");
  });

  it("labels ordinary cancellation and cancellation-save ambiguity truthfully", () => {
    const cancelled = job("job-failed", "failed", "hls", "cancelled");
    delete cancelled.error;
    const cancelledBuilt = buildCaptureManifestInput({
      seed: seed(),
      jobs: [job("job-saved", "saved", "direct", "complete"), cancelled],
      finalizedAt: 20,
      generatorVersion: "0.1.4",
    });
    expect(cancelledBuilt).toMatchObject({
      ok: true,
      input: {
        items: [
          { status: "complete" },
          { status: "cancelled", errorCode: "CANCELLED" },
          { status: "excluded" },
        ],
      },
    });

    const ambiguous = job("job-failed", "failed", "hls", "save_state_unknown");
    ambiguous.error = {
      code: "CANCEL_SAVE_STATE_UNKNOWN",
      customerMessage: "private cancellation diagnostic",
      retryable: false,
    };
    const ambiguousBuilt = buildCaptureManifestInput({
      seed: seed(),
      jobs: [job("job-saved", "saved", "direct", "complete"), ambiguous],
      finalizedAt: 20,
      generatorVersion: "0.1.4",
    });
    expect(ambiguousBuilt).toMatchObject({
      ok: true,
      input: {
        items: [
          { status: "complete" },
          { status: "save_state_unknown", errorCode: "SAVE_STATE_UNKNOWN" },
          { status: "excluded" },
        ],
      },
    });
  });
});
