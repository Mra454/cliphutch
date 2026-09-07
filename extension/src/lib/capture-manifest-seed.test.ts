import { describe, expect, it } from "vitest";
import { prepareCaptureJobs } from "./capture-executor";
import type { CaptureReviewPlanV1 } from "./capture-pack-types";
import { createCaptureManifestSeed, isCaptureManifestSeedV1 } from "./capture-manifest-seed";

const SECRET = "manifest-seed-secret";

function plan(withManifest = true): CaptureReviewPlanV1 {
  const items: CaptureReviewPlanV1["items"] = [
    {
      itemId: "included",
      include: true,
      media: {
        mediaId: "media-included",
        kind: "direct",
        url: `https://cdn.example.test/video.mp4?token=${SECRET}`,
        pageUrl: `https://user:${SECRET}@example.test/article?token=${SECRET}#private`,
        detectedAt: 8,
        width: 1920,
        height: 1080,
        durationSec: 12,
        bitrate: 500_000,
        provenance: ["network"],
      },
      plannedRelativePath: "ClipHutch/Pack/example.test/video.mp4",
      readiness: "ready",
      copyChoice: { candidateId: "media-included", confidence: "exact", reason: "Exact." },
      qualityChoice: { mode: "direct" },
      warnings: [],
    },
    {
      itemId: "quota-excluded",
      include: false,
      media: {
        mediaId: "media-excluded",
        kind: "image",
        url: `https://images.example.test/poster.jpg?signature=${SECRET}`,
        pageUrl: `https://example.test/article?private=${SECRET}`,
        detectedAt: 9,
        provenance: ["rendered-image"],
      },
      plannedRelativePath: "ClipHutch/Pack/example.test/poster.jpg",
      readiness: "ready",
      copyChoice: { candidateId: "media-excluded", confidence: "exact", reason: "Exact." },
      qualityChoice: { mode: "direct" },
      warnings: [],
    },
  ];
  return {
    schemaVersion: 1,
    planId: withManifest ? "capture-plan:one" : "capture-single-plan:one",
    draftId: "draft-one",
    draftRevision: 1,
    generatedAt: 20,
    relativeRoot: "ClipHutch/Pack",
    ...(withManifest ? {
      manifestSpec: {
        schemaVersion: 1,
        formats: ["json", "csv"],
        packName: "Pack",
        createdAt: 5,
        itemAddedAt: { included: 10, "quota-excluded": 11 },
      },
    } : {}),
    items,
    totals: {
      included: 1,
      videos: 1,
      stills: 0,
      unknownSizeCount: 1,
      requiredFreeVideoSlots: 1,
    },
  };
}

describe("Capture Manifest durable seed", () => {
  it("keeps every plan row while persisting only redacted, bounded provenance", () => {
    const value = plan() as CaptureReviewPlanV1 & { licenseKey?: string; rawHeaders?: unknown };
    value.licenseKey = SECRET;
    value.rawHeaders = { authorization: SECRET };
    const jobs = prepareCaptureJobs(value, { runId: "run-one" });
    (jobs[0] as typeof jobs[number] & { quotaToken?: string }).quotaToken = SECRET;
    const created = createCaptureManifestSeed({ runId: "run-one", plan: value, jobs });
    expect(created.ok).toBe(true);
    if (!created.ok || !created.seed) return;
    expect(created.seed.items).toHaveLength(2);
    expect(created.seed.relativeRoot).toBe("ClipHutch/Pack");
    expect(created.seed.items[0]).toMatchObject({
      itemId: "included",
      included: true,
      jobId: jobs[0].jobId,
      pageUrl: "https://example.test/article",
      sourceHost: "cdn.example.test",
      addedAt: 10,
    });
    expect(created.seed.items[1]).toMatchObject({
      itemId: "quota-excluded",
      included: false,
      pageUrl: "https://example.test/article",
      sourceHost: "images.example.test",
      addedAt: 11,
    });
    expect(created.seed.items[1]).not.toHaveProperty("jobId");
    const serialized = JSON.stringify(created.seed);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("mediaUrl");
    expect(serialized).not.toContain("header");
    expect(serialized).not.toContain("license");
    expect(serialized).not.toContain("quotaToken");
  });

  it("returns no manifest seed for Quick Capture", () => {
    const value = plan(false);
    const jobs = prepareCaptureJobs(value, { runId: "run-quick" });
    expect(createCaptureManifestSeed({ runId: "run-quick", plan: value, jobs })).toEqual({
      ok: true,
      seed: null,
    });
  });

  it("fails closed if a Quick plan is forged with a Pack manifest spec", () => {
    const forged = {
      ...plan(),
      planId: "capture-single-plan:forged-manifest",
    } as CaptureReviewPlanV1;
    const jobs = prepareCaptureJobs(plan(false), { runId: "run-quick" });
    expect(createCaptureManifestSeed({ runId: "run-quick", plan: forged, jobs })).toEqual({
      ok: false,
      reason: "invalid_plan",
    });
  });

  it("rejects job mismatch and undeclared seed fields", () => {
    const value = plan();
    const jobs = prepareCaptureJobs(value, { runId: "run-one" });
    expect(createCaptureManifestSeed({ runId: "other-run", plan: value, jobs })).toMatchObject({
      ok: false,
      reason: "invalid_jobs",
    });
    const created = createCaptureManifestSeed({ runId: "run-one", plan: value, jobs });
    expect(created.ok && created.seed).toBeTruthy();
    const hostile = { ...(created.ok ? created.seed : {}), authorization: SECRET };
    expect(isCaptureManifestSeedV1(hostile)).toBe(false);
  });
});
