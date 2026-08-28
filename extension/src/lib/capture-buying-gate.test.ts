import { describe, expect, it } from "vitest";
import type {
  CapturePlanItemV1,
  CaptureReviewPlanV1,
  MediaSnapshotV1,
} from "./capture-pack-types";
import { createCapturePackBuyingGateModel } from "./capture-buying-gate";

type ItemSpec = {
  id: string;
  kind: "direct" | "image" | "hls";
  include?: boolean;
  readiness?: "ready" | "needs_choice" | "unsupported" | "stale";
};

function media(id: string, kind: ItemSpec["kind"]): MediaSnapshotV1 {
  return {
    mediaId: `media-${id}`,
    kind,
    url: `https://cdn.example/${id}.${kind === "image" ? "jpg" : kind === "hls" ? "m3u8" : "mp4"}`,
    detectedAt: 1,
    provenance: ["network"],
  };
}

function item(spec: ItemSpec): CapturePlanItemV1 {
  const readiness = spec.readiness ?? "ready";
  const base = {
    itemId: spec.id,
    include: spec.include ?? true,
    media: media(spec.id, spec.kind),
    plannedRelativePath: `ClipHutch/Pack/example/${spec.id}.${spec.kind === "image" ? "jpg" : "mp4"}`,
    copyChoice: {
      candidateId: `media-${spec.id}`,
      confidence: "exact" as const,
      reason: "Exact source.",
    },
    warnings: [],
  };
  if (readiness === "ready") {
    return {
      ...base,
      readiness,
      qualityChoice: spec.kind === "hls"
        ? {
            mode: "stream",
            policy: { mode: "manual" },
            variantKind: "hls",
            variantUrl: `https://cdn.example/${spec.id}-720.m3u8`,
            estimateConfidence: "unknown",
          }
        : { mode: "direct" },
    };
  }
  return { ...base, readiness };
}

function plan(specs: ItemSpec[]): CaptureReviewPlanV1 {
  const items = specs.map(item);
  const included = items.filter((entry) => entry.include);
  const videos = included.filter((entry) => entry.media.kind !== "image").length;
  const stills = included.length - videos;
  return {
    schemaVersion: 1,
    planId: "plan-1",
    draftId: "draft-1",
    draftRevision: 1,
    generatedAt: 10,
    relativeRoot: "ClipHutch/Pack",
    items,
    totals: {
      included: included.length,
      videos,
      stills,
      ...(included.length === 0 ? { estimatedBytes: 0 } : {}),
      unknownSizeCount: included.length,
      requiredFreeVideoSlots: videos,
    },
  };
}

function model(input: {
  plan: CaptureReviewPlanV1;
  licensed?: boolean;
  remainingVideoSlots?: number;
  selectedFreeVideoItemIds?: string[];
}) {
  const result = createCapturePackBuyingGateModel({
    plan: input.plan,
    licensed: input.licensed ?? false,
    remainingVideoSlots: input.remainingVideoSlots ?? 0,
    selectedFreeVideoItemIds: input.selectedFreeVideoItemIds ?? [],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.model;
}

describe("Capture Pack buying gate model", () => {
  it("requires an empty free allocation for licensed customers and saves the full plan", () => {
    const value = plan([
      { id: "video-a", kind: "direct" },
      { id: "still-a", kind: "image" },
      { id: "video-b", kind: "direct" },
    ]);
    const licensed = model({ plan: value, licensed: true, selectedFreeVideoItemIds: [] });
    expect(licensed).toMatchObject({
      videoCount: 2,
      stillCount: 1,
      maxSelectableFreeVideoCount: 0,
      selectedFreeVideoCount: 0,
      saveItemCount: 3,
      saveVideoCount: 2,
      saveStillCount: 1,
      omittedVideoCount: 0,
      isCompleteAllocation: true,
      needsUpgradeGate: false,
      canSubmit: true,
      blockingReason: null,
    });
    expect(licensed.saveItemIds).toEqual(["video-a", "still-a", "video-b"]);

    const invalid = model({
      plan: value,
      licensed: true,
      selectedFreeVideoItemIds: ["video-a"],
    });
    expect(invalid).toMatchObject({
      selectionIsAllowed: false,
      canSubmit: false,
      blockingReason: "invalid_allocation",
    });
  });

  it("saves every included still plus exactly the explicitly selected ready videos", () => {
    const value = model({
      plan: plan([
        { id: "video-a", kind: "direct" },
        { id: "still-a", kind: "image" },
        { id: "video-b", kind: "direct" },
        { id: "excluded", kind: "image", include: false },
      ]),
      remainingVideoSlots: 1,
      selectedFreeVideoItemIds: ["video-b"],
    });
    expect(value.selectedFreeVideoItemIds).toEqual(["video-b"]);
    expect(value.saveItemIds).toEqual(["still-a", "video-b"]);
    expect(value).toMatchObject({
      includedCount: 3,
      videoCount: 2,
      stillCount: 1,
      requestedFreeVideoSelectionCount: 1,
      selectedFreeVideoCount: 1,
      saveItemCount: 2,
      saveVideoCount: 1,
      saveStillCount: 1,
      omittedVideoCount: 1,
      isCompleteAllocation: false,
      needsUpgradeGate: true,
      canSubmit: true,
    });
  });

  it("never silently chooses the first videos and canonicalizes click order to plan order", () => {
    const value = plan([
      { id: "video-a", kind: "direct" },
      { id: "video-b", kind: "direct" },
      { id: "still-a", kind: "image" },
    ]);
    const none = model({ plan: value, remainingVideoSlots: 2 });
    expect(none.selectedFreeVideoItemIds).toEqual([]);
    expect(none.saveItemIds).toEqual(["still-a"]);

    const reversed = model({
      plan: value,
      remainingVideoSlots: 2,
      selectedFreeVideoItemIds: ["video-b", "video-a"],
    });
    expect(reversed.selectedFreeVideoItemIds).toEqual(["video-a", "video-b"]);
    expect(reversed.saveItemIds).toEqual(["video-a", "video-b", "still-a"]);
    expect(reversed.isCompleteAllocation).toBe(true);
  });

  it("returns exact buying-gate and customer-copy numbers", () => {
    const value = model({
      plan: plan([
        { id: "video-a", kind: "direct" },
        { id: "video-b", kind: "direct" },
        { id: "video-c", kind: "direct" },
        { id: "still-a", kind: "image" },
      ]),
      remainingVideoSlots: 1,
      selectedFreeVideoItemIds: ["video-c"],
    });
    expect(value).toMatchObject({
      remainingVideoSlots: 1,
      maxSelectableFreeVideoCount: 1,
      completePackVideoShortfall: 2,
      requestedFreeVideoSelectionCount: 1,
      selectedFreeVideoCount: 1,
      saveItemCount: 2,
      needsUpgradeGate: true,
    });
  });

  it.each([
    {
      name: "duplicate video IDs",
      selected: ["video-a", "video-a"],
      remaining: 2,
      reason: "duplicate_allocation",
    },
    {
      name: "an unknown ID",
      selected: ["missing"],
      remaining: 2,
      reason: "invalid_allocation",
    },
    {
      name: "an excluded video ID",
      selected: ["excluded-video"],
      remaining: 2,
      reason: "invalid_allocation",
    },
    {
      name: "an included still ID",
      selected: ["still-a"],
      remaining: 2,
      reason: "non_video_allocation",
    },
    {
      name: "more video IDs than the allowance",
      selected: ["video-a", "video-b"],
      remaining: 1,
      reason: "over_allowance",
    },
  ])("blocks $name with a typed reason", ({ selected, remaining, reason }) => {
    const value = model({
      plan: plan([
        { id: "video-a", kind: "direct" },
        { id: "video-b", kind: "direct" },
        { id: "still-a", kind: "image" },
        { id: "excluded-video", kind: "direct", include: false },
      ]),
      remainingVideoSlots: remaining,
      selectedFreeVideoItemIds: selected,
    });
    expect(value).toMatchObject({
      selectionIsAllowed: false,
      canSubmit: false,
      blockingReason: reason,
    });
  });

  it("blocks every included unready item while preserving useful review counts", () => {
    const value = model({
      plan: plan([
        { id: "video-ready", kind: "direct" },
        { id: "video-choice", kind: "hls", readiness: "needs_choice" },
        { id: "still-broken", kind: "image", readiness: "unsupported" },
      ]),
      remainingVideoSlots: 2,
      selectedFreeVideoItemIds: ["video-ready", "video-choice"],
    });
    expect(value).toMatchObject({
      includedCount: 3,
      videoCount: 2,
      stillCount: 1,
      readyVideoCount: 1,
      unreadyCount: 2,
      maxSelectableFreeVideoCount: 1,
      requestedFreeVideoSelectionCount: 2,
      selectedFreeVideoCount: 1,
      saveVideoCount: 1,
      saveStillCount: 1,
      isCompleteAllocation: false,
      selectionIsAllowed: false,
      canSubmit: false,
      blockingReason: "unready_item",
    });
    expect(value.unreadyItemIds).toEqual(["video-choice", "still-broken"]);
    expect(value.saveItemIds).toEqual(["video-ready", "still-broken"]);
  });

  it("blocks a zero-item save without inventing an allocation", () => {
    const emptyPlan = model({ plan: plan([]), remainingVideoSlots: 10 });
    expect(emptyPlan).toMatchObject({
      includedCount: 0,
      saveItemCount: 0,
      isCompleteAllocation: false,
      canSubmit: false,
      blockingReason: "no_items",
    });

    const videoOnly = model({
      plan: plan([{ id: "video-a", kind: "direct" }]),
      remainingVideoSlots: 1,
    });
    expect(videoOnly).toMatchObject({
      selectedFreeVideoCount: 0,
      saveItemCount: 0,
      canSubmit: false,
      blockingReason: "no_items",
    });
  });

  it("is total for hostile, active, sparse, oversized, and invalid input", () => {
    const hostile = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("hostile prototype");
      },
    });
    const getterInput = Object.defineProperty({}, "plan", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    const sparse = new Array(1) as string[];
    const validPlan = plan([{ id: "video-a", kind: "direct" }]);
    const cyclic = { ...validPlan, cycle: undefined as unknown };
    cyclic.cycle = cyclic;

    const values: unknown[] = [
      hostile,
      getterInput,
      {
        plan: hostile,
        licensed: false,
        remainingVideoSlots: 1,
        selectedFreeVideoItemIds: [],
      },
      {
        plan: validPlan,
        licensed: false,
        remainingVideoSlots: -1,
        selectedFreeVideoItemIds: [],
      },
      {
        plan: validPlan,
        licensed: false,
        remainingVideoSlots: Number.NaN,
        selectedFreeVideoItemIds: [],
      },
      {
        plan: validPlan,
        licensed: false,
        remainingVideoSlots: 1,
        selectedFreeVideoItemIds: sparse,
      },
      {
        plan: validPlan,
        licensed: false,
        remainingVideoSlots: 1,
        selectedFreeVideoItemIds: Array.from(
          { length: 201 },
          (_, index) => `video-${index}`,
        ),
      },
      {
        plan: cyclic,
        licensed: false,
        remainingVideoSlots: 1,
        selectedFreeVideoItemIds: [],
      },
      {
        plan: { ...validPlan, totals: { ...validPlan.totals, included: 9 } },
        licensed: false,
        remainingVideoSlots: 1,
        selectedFreeVideoItemIds: [],
      },
      {
        plan: validPlan,
        licensed: false,
        remainingVideoSlots: 1,
        selectedFreeVideoItemIds: [],
        unexpected: true,
      },
    ];

    for (const value of values) {
      expect(() => createCapturePackBuyingGateModel(value)).not.toThrow();
      expect(createCapturePackBuyingGateModel(value)).toEqual({
        ok: false,
        reason: "invalid_input",
      });
    }
  });

  it("accepts passive shared references without mistaking them for cycles", () => {
    const shared = plan([
      { id: "video-a", kind: "direct" },
      { id: "video-b", kind: "direct" },
    ]);
    // Share a semantically neutral passive node. Sharing the media object
    // would make item B's frozen copyChoice point at the wrong media ID.
    shared.items[1].warnings = shared.items[0].warnings;
    const result = createCapturePackBuyingGateModel({
      plan: shared,
      licensed: false,
      remainingVideoSlots: 2,
      selectedFreeVideoItemIds: ["video-a", "video-b"],
    });
    expect(result).toMatchObject({
      ok: true,
      model: { canSubmit: true, isCompleteAllocation: true },
    });
  });

  it("returns detached frozen arrays so callers cannot mutate plan state through the model", () => {
    const source = plan([
      { id: "video-a", kind: "direct" },
      { id: "still-a", kind: "image" },
    ]);
    const value = model({
      plan: source,
      remainingVideoSlots: 1,
      selectedFreeVideoItemIds: ["video-a"],
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.saveItemIds)).toBe(true);
    expect(value.saveItemIds).not.toBe(source.items);
    source.items[0].itemId = "mutated";
    expect(value.saveItemIds).toEqual(["video-a", "still-a"]);
  });
});
