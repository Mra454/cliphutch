import { describe, expect, it } from "vitest";
import type { CaptureReviewPlanV1 } from "./capture-pack-types";
import { allocateCaptureReviewPlan } from "./capture-plan-allocation";

function plan(): CaptureReviewPlanV1 {
  const base = {
    schemaVersion: 1 as const,
    planId: "plan-1",
    draftId: "draft-1",
    draftRevision: 1,
    generatedAt: 10,
    relativeRoot: "ClipHutch/Pack",
  };
  const media = (id: string, kind: "direct" | "image") => ({
    mediaId: `media-${id}`,
    kind,
    url: `https://cdn.example/${id}.${kind === "image" ? "jpg" : "mp4"}`,
    detectedAt: 1,
    provenance: ["network" as const],
  });
  const item = (id: string, kind: "direct" | "image") => ({
    itemId: id,
    include: true,
    media: media(id, kind),
    plannedRelativePath: `ClipHutch/Pack/example/${id}.${kind === "image" ? "jpg" : "mp4"}`,
    readiness: "ready" as const,
    copyChoice: { candidateId: `media-${id}`, confidence: "exact" as const, reason: "Exact." },
    qualityChoice: { mode: "direct" as const },
    warnings: [],
  });
  return {
    ...base,
    items: [item("video-a", "direct"), item("video-b", "direct"), item("still", "image")],
    totals: {
      included: 3,
      videos: 2,
      stills: 1,
      unknownSizeCount: 3,
      requiredFreeVideoSlots: 2,
    },
  };
}

describe("Capture Review free allocation", () => {
  it("keeps every still and only the explicitly allocated free video", () => {
    const value = plan();
    value.manifestSpec = {
      schemaVersion: 1,
      formats: ["json", "csv"],
      packName: "Pack",
      createdAt: 0,
      itemAddedAt: { "video-a": 1, "video-b": 2, still: 3 },
    };
    const result = allocateCaptureReviewPlan({
      plan: value,
      licensed: false,
      freeVideoItemIds: ["video-b"],
      maxFreeVideoSlots: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.items.filter((item) => item.include).map((item) => item.itemId)).toEqual([
      "video-b",
      "still",
    ]);
    expect(result.plan.totals).toMatchObject({ videos: 1, stills: 1, requiredFreeVideoSlots: 1 });
    expect(result.plan.manifestSpec).toEqual(value.manifestSpec);
    expect(result.plan.manifestSpec).not.toBe(value.manifestSpec);
  });

  it("executes the full reviewed plan after licensing even if checkout raced the free action", () => {
    const result = allocateCaptureReviewPlan({
      plan: plan(),
      licensed: true,
      freeVideoItemIds: ["video-a"],
      maxFreeVideoSlots: 4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.totals.videos).toBe(2);
    expect(result.allocatedVideoItemIds).toEqual(["video-a", "video-b"]);
  });

  it("keeps transcoded WebM output bytes unknown during allocation", () => {
    const value = plan();
    const webmPlan: CaptureReviewPlanV1 = {
      ...value,
      items: [{
        ...value.items[0],
        media: {
          ...value.items[0].media,
          url: "https://cdn.example/source.webm",
          contentType: "video/webm",
          sizeBytes: 12_345,
        },
        plannedRelativePath: "ClipHutch/Pack/example/source.mp4",
      }],
      totals: {
        included: 1,
        videos: 1,
        stills: 0,
        unknownSizeCount: 1,
        requiredFreeVideoSlots: 1,
      },
    };
    const result = allocateCaptureReviewPlan({
      plan: webmPlan,
      licensed: true,
      freeVideoItemIds: [],
      maxFreeVideoSlots: 0,
    });
    expect(result).toMatchObject({
      ok: true,
      plan: { totals: { unknownSizeCount: 1 } },
    });
    expect(result.ok && result.plan.totals).not.toHaveProperty("estimatedBytes");
  });

  it("rejects allocations that exceed the bound or name a non-video", () => {
    expect(allocateCaptureReviewPlan({
      plan: plan(),
      licensed: false,
      freeVideoItemIds: ["video-a", "video-b"],
      maxFreeVideoSlots: 1,
    })).toMatchObject({ ok: false, reason: "allocation_limit" });
    expect(allocateCaptureReviewPlan({
      plan: plan(),
      licensed: false,
      freeVideoItemIds: ["still"],
      maxFreeVideoSlots: 4,
    })).toMatchObject({ ok: false, reason: "invalid_allocation" });
  });
});
