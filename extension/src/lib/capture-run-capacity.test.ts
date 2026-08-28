import { describe, expect, it } from "vitest";
import type { CaptureReviewPlanV1 } from "./capture-pack-types";
import { assessCaptureRunCapacity } from "./capture-run-capacity";

function plan(itemCount: number, pathLength: number): CaptureReviewPlanV1 {
  const items = Array.from({ length: itemCount }, (_, index) => {
    const suffix = `${index}-${"x".repeat(pathLength)}`;
    return {
      itemId: `item-${index}`,
      include: true,
      media: {
        mediaId: `media-${index}`,
        kind: "direct" as const,
        url: `https://cdn.example.test/${suffix}?signed=${"s".repeat(1_500)}`,
        pageUrl: `https://example.test/${suffix}`,
        detectedAt: 10,
        provenance: ["network" as const],
      },
      plannedRelativePath: `ClipHutch/Pack/example.test/${index}-${"p".repeat(120)}.mp4`,
      readiness: "ready" as const,
      qualityChoice: { mode: "direct" as const },
      copyChoice: { candidateId: `media-${index}`, confidence: "exact" as const, reason: "Exact URL" },
      warnings: [],
    };
  });
  return {
    schemaVersion: 1,
    planId: "capture-review-v1:00000000-0000-4000-8000-000000000000",
    draftId: "draft-one",
    draftRevision: 1,
    generatedAt: 10,
    relativeRoot: "ClipHutch/Pack",
    manifestSpec: {
      schemaVersion: 1,
      formats: ["json", "csv"],
      packName: "Pack",
      createdAt: 10,
      itemAddedAt: Object.fromEntries(items.map((item) => [item.itemId, 10])),
    },
    items,
    totals: {
      included: itemCount,
      videos: itemCount,
      stills: 0,
      unknownSizeCount: itemCount,
      requiredFreeVideoSlots: itemCount,
    },
  };
}

describe("Capture Run capacity preflight", () => {
  it("accepts an ordinary mixed-pack graph before Save", () => {
    expect(assessCaptureRunCapacity({ plan: plan(4, 40) })).toMatchObject({ ok: true });
  });

  it("rejects the reproduced contract-valid graph that exceeds durable run capacity", () => {
    const result = assessCaptureRunCapacity({ plan: plan(120, 2_000) });
    expect(result).toMatchObject({ ok: false, reason: "graph_too_large" });
    if (!result.ok) expect(result.bytes).toBeGreaterThan(result.maximumBytes);
  });

  it("rejects a valid 200-image review whose redacted manifest seed exceeds its bound", () => {
    const value = plan(200, 40);
    const longHost = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(55)}.test`;
    value.items = value.items.map((item, index) => {
      const itemId = `item-${index}-${"i".repeat(238)}`.slice(0, 250);
      const mediaId = `media-${index}-${"m".repeat(236)}`.slice(0, 250);
      return {
        ...item,
        itemId,
        media: {
          ...item.media,
          mediaId,
          kind: "image" as const,
          url: `https://${longHost}/image-${index}.jpg?token=${"s".repeat(100)}`,
          pageUrl: `https://example.test/${"p".repeat(2_000)}${index}`,
          width: 8_192,
          height: 8_192,
          durationSec: 0,
          bitrate: 0,
        },
        copyChoice: { ...item.copyChoice, candidateId: mediaId },
      };
    });
    value.manifestSpec = {
      ...value.manifestSpec!,
      itemAddedAt: Object.fromEntries(value.items.map((item) => [item.itemId, 10])),
    };
    value.totals = {
      included: 200,
      videos: 0,
      stills: 200,
      unknownSizeCount: 200,
      requiredFreeVideoSlots: 0,
    };
    expect(assessCaptureRunCapacity({ plan: value })).toMatchObject({
      ok: false,
      reason: "manifest_seed_too_large",
    });
  });

  it("measures unready rows in the manifest but never invents executable jobs", () => {
    const value = plan(8, 100);
    const { qualityChoice: _qualityChoice, ...staleItem } = value.items[0];
    value.items[0] = {
      ...staleItem,
      readiness: "stale",
      warnings: [{ code: "STALE_SOURCE", message: "Reopen the source." }],
    } as CaptureReviewPlanV1["items"][number];
    expect(assessCaptureRunCapacity({ plan: value })).toMatchObject({ ok: true });
  });
});
