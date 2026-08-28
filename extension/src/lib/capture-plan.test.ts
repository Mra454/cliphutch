import { describe, expect, it } from "vitest";
import { prepareCaptureJobs } from "./capture-executor";
import {
  isCaptureDraftV1,
  isCaptureReviewPlanV1,
  type CaptureDraftItemV1,
  type CaptureDraftV1,
  type MediaSnapshotV1,
  type QualityChoiceV1,
} from "./capture-pack-types";
import {
  cloneCaptureReviewPlan,
  generateCaptureReviewPlan,
  type CapturePlanItemChoiceV1,
} from "./capture-plan";

function media(
  id: string,
  kind: MediaSnapshotV1["kind"] = "direct",
  partial: Partial<MediaSnapshotV1> = {},
): MediaSnapshotV1 {
  const extension = kind === "hls" ? "m3u8" : kind === "dash" ? "mpd" : kind === "image" ? "jpg" : "mp4";
  return {
    mediaId: `media-${id}`,
    kind,
    url: `https://cdn.example.test/assets/${id}.${extension}`,
    detectedAt: 5,
    pageUrl: "https://www.example.test/research",
    pageTitle: "Research Page",
    provenance: ["network"],
    ...partial,
  };
}

function draft(items: Array<{ id: string; media: MediaSnapshotV1 }>, partial: Partial<CaptureDraftV1> = {}): CaptureDraftV1 {
  const draftItems = Object.fromEntries(
    items.map(({ id, media: snapshot }, index) => [
      id,
      {
        itemId: id,
        addedAt: 6 + index,
        media: snapshot,
      } satisfies CaptureDraftItemV1,
    ]),
  );
  return {
    schemaVersion: 1,
    draftId: "draft-1",
    revision: 3,
    name: "Research Pack",
    createdAt: 1,
    updatedAt: 10,
    orderedItemIds: items.map(({ id }) => id),
    items: draftItems,
    preferences: {
      folderMode: "pack_page",
      manifestFormats: ["json", "csv"],
      qualityPolicy: { mode: "manual" },
    },
    ...partial,
  };
}

function choices(
  value: CaptureDraftV1,
  qualityByItem: Record<string, QualityChoiceV1 | undefined> = {},
): CapturePlanItemChoiceV1[] {
  return value.orderedItemIds.map((itemId) => ({
    itemId,
    include: true,
    ...(qualityByItem[itemId] === undefined ? {} : { qualityChoice: qualityByItem[itemId] }),
  }));
}

function generate(
  value: CaptureDraftV1,
  itemChoices = choices(value),
  partial: Partial<Parameters<typeof generateCaptureReviewPlan>[0]> = {},
) {
  return generateCaptureReviewPlan({
    draft: value,
    expectedDraftRevision: value.revision,
    planId: "plan-1",
    generatedAt: 20,
    choices: itemChoices,
    ...partial,
  });
}

describe("generateCaptureReviewPlan", () => {
  it("copies a frozen draft recommendation into Review and preserves the legacy exact fallback", () => {
    const value = draft([
      { id: "recommended", media: media("recommended", "image") },
      { id: "legacy", media: media("legacy") },
    ]);
    value.items.recommended.copyChoice = {
      candidateId: "media-recommended",
      confidence: "high",
      reason: "Largest verified responsive image.",
    };
    const result = generate(value);
    expect(result).toMatchObject({
      ok: true,
      plan: {
        items: [
          {
            itemId: "recommended",
            copyChoice: {
              candidateId: "media-recommended",
              confidence: "high",
              reason: "Largest verified responsive image.",
            },
          },
          {
            itemId: "legacy",
            copyChoice: {
              candidateId: "media-legacy",
              confidence: "exact",
              reason: "Exact media selected from the Capture Pack draft.",
            },
          },
        ],
      },
    });
    if (!result.ok) return;
    value.items.recommended.copyChoice.reason = "Mutated after plan generation.";
    expect(result.plan.items[0].copyChoice.reason).toBe("Largest verified responsive image.");
  });

  it("freezes mandatory JSON, optional CSV, and every draft addedAt for normal plans", () => {
    const value = draft([
      { id: "one", media: media("one") },
      { id: "two", media: media("two", "image") },
    ]);
    const result = generate(value);
    expect(result).toMatchObject({
      ok: true,
      plan: {
        manifestSpec: {
          schemaVersion: 1,
          formats: ["json", "csv"],
          packName: "Research Pack",
          createdAt: 1,
          itemAddedAt: { one: 6, two: 7 },
        },
      },
    });
    if (!result.ok) return;
    value.preferences.manifestFormats = ["json"];
    value.items.one.addedAt = 99;
    expect(result.plan.manifestSpec).toMatchObject({
      formats: ["json", "csv"],
      itemAddedAt: { one: 6 },
    });
  });

  it("freezes no manifest contract for Quick Capture plans", () => {
    const value = draft([{ id: "one", media: media("one") }]);
    const result = generate(value, choices(value), { planId: "capture-single-plan:quick" });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.plan.manifestSpec).toBeUndefined();
  });

  it("authoritatively plans direct files, stills, and WebM-to-MP4 with exact totals", () => {
    const value = draft([
      { id: "direct", media: media("movie", "direct", { sizeBytes: 100 }) },
      { id: "still", media: media("poster", "image", { sizeBytes: 25 }) },
      {
        id: "webm",
        media: media("source", "direct", {
          url: "https://cdn.example.test/assets/source.webm",
          contentType: "video/webm; charset=binary",
          sizeBytes: 75,
        }),
      },
    ]);
    const result = generate(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.items.map((item) => [item.itemId, item.readiness])).toEqual([
      ["direct", "ready"],
      ["still", "ready"],
      ["webm", "ready"],
    ]);
    expect(result.plan.items[2].plannedRelativePath).toMatch(/source\.mp4$/);
    expect(result.plan.items[2].warnings.map((warning) => warning.code)).toContain(
      "WEBM_CONVERTS_TO_MP4",
    );
    expect(result.plan.items.every((item) => item.plannedRelativePath.startsWith(
      "ClipHutch/Research Pack/example.test - Research Page/",
    ))).toBe(true);
    expect(result.plan.totals).toEqual({
      included: 3,
      videos: 2,
      stills: 1,
      unknownSizeCount: 1,
      requiredFreeVideoSlots: 2,
    });
    expect(isCaptureReviewPlanV1(result.plan)).toBe(true);
    expect(prepareCaptureJobs(result.plan, { runId: "run-1" }).map((job) => job.resourceClass))
      .toEqual(["native", "native", "heavy"]);
  });

  it("blocks known oversize WebM and discloses the cap when source size is unknown", () => {
    const value = draft([
      {
        id: "oversize",
        media: media("oversize", "direct", {
          url: "https://cdn.example.test/oversize.webm",
          contentType: "video/webm",
          sizeBytes: 128 * 1024 * 1024 + 1,
        }),
      },
      {
        id: "unknown",
        media: media("unknown", "direct", {
          url: "https://cdn.example.test/unknown.webm",
          contentType: "video/webm",
        }),
      },
    ]);
    const result = generate(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.items[0]).toMatchObject({
      readiness: "unsupported",
      warnings: [{ code: "WEBM_SOURCE_TOO_LARGE" }],
    });
    expect(result.plan.items[1]).toMatchObject({ readiness: "ready" });
    expect(result.plan.items[1].warnings.map((warning) => warning.code)).toEqual([
      "WEBM_CONVERTS_TO_MP4",
      "WEBM_SOURCE_SIZE_UNKNOWN",
    ]);
    expect(result.plan.totals.unknownSizeCount).toBe(2);
    expect(result.plan.totals.estimatedBytes).toBeUndefined();
  });

  it("keeps unknown pack size explicit while retaining exact item and quota counts", () => {
    const value = draft([
      { id: "known", media: media("known", "direct", { sizeBytes: 100 }) },
      { id: "unknown", media: media("unknown", "image") },
      { id: "excluded", media: media("excluded", "direct", { sizeBytes: 50 }) },
    ]);
    const itemChoices = choices(value);
    itemChoices[2] = { ...itemChoices[2], include: false };
    const result = generate(value, itemChoices);
    expect(result.ok && result.plan.totals).toEqual({
      included: 2,
      videos: 1,
      stills: 1,
      unknownSizeCount: 1,
      requiredFreeVideoSlots: 1,
    });
  });

  it("marks unresolved HLS/DASH choices and makes exact discriminated choices executable", () => {
    const value = draft([
      { id: "hls", media: media("master", "hls") },
      { id: "dash", media: media("manifest", "dash") },
    ]);
    const unresolved = generate(value);
    expect(unresolved.ok && unresolved.plan.items.map((item) => item.readiness)).toEqual([
      "needs_choice",
      "needs_choice",
    ]);
    expect(unresolved.ok && unresolved.plan.items[0]).not.toHaveProperty("qualityChoice");
    expect(unresolved.ok && unresolved.plan.items[1]).not.toHaveProperty("qualityChoice");
    if (unresolved.ok) {
      expect(() => prepareCaptureJobs(unresolved.plan, { runId: "run-unresolved" })).toThrowError(
        expect.objectContaining({ code: "unready_item" }),
      );
    }

    const exact = generate(value, choices(value, {
      hls: {
        mode: "stream",
        policy: { mode: "manual" },
        selector: { kind: "hls", stableId: `variant-v1-hls-${"a".repeat(40)}` },
        maxDownloadBytes: 10_000,
        estimatedBytes: 1_000,
        estimateConfidence: "exact",
      },
      dash: {
        mode: "stream",
        policy: { mode: "manual" },
        selector: { kind: "dash", stableId: `variant-v1-dash-${"b".repeat(40)}` },
        maxDownloadBytes: 10_000,
        combinedBandwidth: 8_000,
        durationSec: 2,
        estimatedBytes: 2_000,
        estimateConfidence: "estimated",
      },
    }));
    expect(exact.ok && exact.plan.items.map((item) => item.readiness)).toEqual(["ready", "ready"]);
    expect(exact.ok && exact.plan.totals.estimatedBytes).toBe(3_000);
    if (!exact.ok) return;
    expect(prepareCaptureJobs(exact.plan, { runId: "run-streams" }).map((job) =>
      job.snapshot.quality.mode === "stream" ? job.snapshot.quality.selector : undefined))
      .toEqual([
        { kind: "hls", stableId: `variant-v1-hls-${"a".repeat(40)}` },
        { kind: "dash", stableId: `variant-v1-dash-${"b".repeat(40)}` },
      ]);
    expect(JSON.stringify(exact.plan)).not.toContain("variantUrl");
    expect(JSON.stringify(exact.plan)).not.toContain("representationId");
    const detached = cloneCaptureReviewPlan(exact.plan);
    const originalQuality = exact.plan.items[0].qualityChoice;
    if (!originalQuality || originalQuality.mode !== "stream" || !originalQuality.selector) {
      throw new Error("Expected persistent stream quality");
    }
    originalQuality.selector.stableId = `variant-v1-hls-${"f".repeat(40)}`;
    originalQuality.maxDownloadBytes = 1;
    expect(detached.items[0].qualityChoice).toMatchObject({
      selector: { stableId: `variant-v1-hls-${"a".repeat(40)}` },
      maxDownloadBytes: 10_000,
    });
  });

  it("freezes automatic policy/cap exactly while allowing an explicit manual override", () => {
    const value = draft(
      [{ id: "hls", media: media("master", "hls") }],
      {
        preferences: {
          folderMode: "pack_page",
          manifestFormats: ["json"],
          qualityPolicy: {
            mode: "best_under_cap",
            maxEstimatedBytes: 1_000,
            maxHeight: 720,
          },
        },
      },
    );
    const automatic = generate(value, choices(value, {
      hls: {
        mode: "stream",
        policy: { mode: "best_under_cap", maxEstimatedBytes: 1_000, maxHeight: 720 },
        selector: { kind: "hls", stableId: `variant-v1-hls-${"1".repeat(40)}` },
        maxDownloadBytes: 1_000,
        label: "720p",
        width: 1_280,
        height: 720,
        estimatedBytes: 900,
        estimateConfidence: "exact",
      },
    }));
    expect(automatic.ok).toBe(true);
    if (automatic.ok) {
      expect(automatic.plan.items[0].qualityChoice).toMatchObject({
        policy: { mode: "best_under_cap", maxEstimatedBytes: 1_000, maxHeight: 720 },
        maxDownloadBytes: 1_000,
      });
      expect(automatic.plan.items[0].plannedRelativePath).not.toContain("720p");
    }

    const manualOverride = generate(value, choices(value, {
      hls: {
        mode: "stream",
        policy: { mode: "manual" },
        selector: { kind: "hls", stableId: `variant-v1-hls-${"2".repeat(40)}` },
        maxDownloadBytes: 1_000,
        label: "720p",
        estimateConfidence: "unknown",
      },
    }));
    expect(manualOverride.ok).toBe(true);
    expect(manualOverride.ok && manualOverride.plan.items[0].plannedRelativePath).toContain("720p");

    const defaultMismatch = generate(value, choices(value, {
      hls: {
        mode: "stream",
        policy: { mode: "best_under_cap", maxEstimatedBytes: 2_000, maxHeight: 720 },
        selector: { kind: "hls", stableId: `variant-v1-hls-${"3".repeat(40)}` },
        maxDownloadBytes: 2_000,
        width: 1_280,
        height: 720,
        estimatedBytes: 900,
        estimateConfidence: "exact",
      },
    }));
    expect(defaultMismatch).toMatchObject({
      ok: false,
      reason: "unsupported_choice",
      itemId: "hls",
    });

    const capMismatch = generate(value, choices(value, {
      hls: {
        mode: "stream",
        policy: { mode: "best_under_cap", maxEstimatedBytes: 1_000, maxHeight: 720 },
        selector: { kind: "hls", stableId: `variant-v1-hls-${"4".repeat(40)}` },
        maxDownloadBytes: 2_000,
        width: 1_280,
        height: 720,
        estimatedBytes: 900,
        estimateConfidence: "exact",
      },
    } as Record<string, QualityChoiceV1>));
    expect(capMismatch).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("rejects crossed, legacy, unsafe, and direct-media stream choices", () => {
    const value = draft([
      { id: "hls", media: media("master", "hls") },
      { id: "direct", media: media("movie", "direct") },
    ]);
    const crossed = generate(value, choices(value, {
      hls: {
        mode: "stream",
        policy: { mode: "manual" },
        selector: { kind: "dash", stableId: `variant-v1-dash-${"c".repeat(40)}` },
        maxDownloadBytes: 10_000,
        estimateConfidence: "unknown",
      },
    }));
    expect(crossed).toMatchObject({ ok: false, reason: "unsupported_choice", itemId: "hls" });

    const directStream = generate(value, choices(value, {
      direct: {
        mode: "stream",
        policy: { mode: "manual" },
        selector: { kind: "hls", stableId: `variant-v1-hls-${"d".repeat(40)}` },
        maxDownloadBytes: 10_000,
        estimateConfidence: "unknown",
      },
    }));
    expect(directStream).toMatchObject({
      ok: false,
      reason: "unsupported_choice",
      itemId: "direct",
    });

    const legacy = generate(value, choices(value, {
      hls: {
        mode: "stream",
        policy: { mode: "manual" },
        fixedVariantId: "legacy-variant",
        estimateConfidence: "unknown",
      },
    }));
    expect(legacy).toMatchObject({ ok: false, reason: "unsupported_choice", itemId: "hls" });

    const unsafe = generate(value, [{
      itemId: "hls",
      include: true,
      qualityChoice: {
        mode: "stream",
        policy: { mode: "manual" },
        selector: { kind: "hls", stableId: `variant-v1-hls-${"e".repeat(40)}` },
        maxDownloadBytes: 10_000,
        variantUrl: "https://signed.example.test/child.m3u8?secret=canary",
        estimateConfidence: "unknown",
      } as unknown as QualityChoiceV1,
    }, { itemId: "direct", include: true }]);
    expect(unsafe).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("deduplicates basename/case collisions deterministically and reserves manifest names", () => {
    const value = draft([
      {
        id: "first",
        media: media("first", "direct", { url: "https://cdn.example.test/a/clip.mp4" }),
      },
      {
        id: "second",
        media: media("second", "direct", { url: "https://cdn.example.test/b/CLIP.mp4" }),
      },
      {
        id: "manifest-name",
        media: media("manifest-name", "direct", {
          url: "https://cdn.example.test/_cliphutch-manifest.json",
        }),
      },
    ]);
    const first = generate(value);
    const second = generate(value);
    expect(first).toEqual(second);
    expect(first.ok && first.plan.items.map((item) => item.plannedRelativePath)).toEqual([
      "ClipHutch/Research Pack/example.test - Research Page/clip.mp4",
      "ClipHutch/Research Pack/example.test - Research Page/CLIP (2).mp4",
      "ClipHutch/Research Pack/example.test - Research Page/_cliphutch-manifest.json",
    ]);
    expect(first.ok && first.plan.items.some((item) =>
      item.plannedRelativePath === "ClipHutch/Research Pack/_cliphutch-manifest.json"))
      .toBe(false);
  });

  it("keeps distinct same-host/title source pages in stable disambiguated folders", () => {
    const value = draft([
      {
        id: "page-a",
        media: media("a", "direct", {
          pageUrl: "https://example.test/a",
          pageTitle: "Same Title",
          url: "https://cdn.example.test/a/video.mp4",
        }),
      },
      {
        id: "page-b",
        media: media("b", "direct", {
          pageUrl: "https://example.test/b",
          pageTitle: "Same Title",
          url: "https://cdn.example.test/b/video.mp4",
        }),
      },
      {
        id: "page-b-second",
        media: media("b-second", "image", {
          pageUrl: "https://example.test/b",
          pageTitle: "Same Title",
          url: "https://cdn.example.test/b/poster.jpg",
        }),
      },
    ]);
    const result = generate(value);
    expect(result.ok && result.plan.items.map((item) => item.plannedRelativePath)).toEqual([
      "ClipHutch/Research Pack/example.test - Same Title/video.mp4",
      "ClipHutch/Research Pack/example.test - (2) Same Title/video.mp4",
      "ClipHutch/Research Pack/example.test - (2) Same Title/poster.jpg",
    ]);
  });

  it("uses per-page folder labels and collision-safely separates equal labels", () => {
    const value = draft([
      {
        id: "page-a",
        media: media("a", "direct", {
          pageUrl: "https://example.test/a",
          pageTitle: "Original A",
          url: "https://cdn.example.test/a/video.mp4",
        }),
      },
      {
        id: "page-b",
        media: media("b", "direct", {
          pageUrl: "https://example.test/b",
          pageTitle: "Original B",
          url: "https://cdn.example.test/b/video.mp4",
        }),
      },
      {
        id: "page-b-still",
        media: media("b-still", "image", {
          pageUrl: "https://example.test/b",
          pageTitle: "Original B",
          url: "https://cdn.example.test/b/poster.jpg",
        }),
      },
    ]);
    value.items["page-a"].pageFolderLabel = "Final selects";
    value.items["page-b"].pageFolderLabel = "Final selects";
    value.items["page-b-still"].pageFolderLabel = "Final selects";

    const result = generate(value);
    expect(result.ok && result.plan.items.map((item) => item.plannedRelativePath)).toEqual([
      "ClipHutch/Research Pack/example.test - Final selects/video.mp4",
      "ClipHutch/Research Pack/example.test - (2) Final selects/video.mp4",
      "ClipHutch/Research Pack/example.test - (2) Final selects/poster.jpg",
    ]);

    delete value.items["page-a"].pageFolderLabel;
    const resetResult = generate(value);
    expect(resetResult.ok && resetResult.plan.items[0].plannedRelativePath).toBe(
      "ClipHutch/Research Pack/example.test - Original A/video.mp4",
    );
  });

  it("reports stale revisions, duplicate/missing/unknown choices, and malformed drafts", () => {
    const value = draft([{ id: "one", media: media("one") }]);
    expect(generate(value, choices(value), { expectedDraftRevision: 2 })).toMatchObject({
      ok: false,
      reason: "stale_draft_revision",
      expectedDraftRevision: 2,
      actualDraftRevision: 3,
    });
    expect(generate(value, [{ itemId: "one", include: true }, { itemId: "one", include: false }]))
      .toMatchObject({ ok: false, reason: "duplicate_choice", itemId: "one" });
    expect(generate(value, [])).toMatchObject({ ok: false, reason: "missing_choice", itemId: "one" });
    expect(generate(value, [{ itemId: "other", include: true }])).toMatchObject({
      ok: false,
      reason: "unknown_item",
      itemId: "other",
    });

    const duplicateDraft = {
      ...value,
      orderedItemIds: ["one", "one"],
    };
    expect(isCaptureDraftV1(duplicateDraft)).toBe(false);
    expect(generate(duplicateDraft as CaptureDraftV1, choices(value))).toMatchObject({
      ok: false,
      reason: "invalid_draft",
    });
  });

  it("fails closed for hostile values and rejects choice fields that could bypass authority", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(() => generateCaptureReviewPlan(hostile as Parameters<typeof generateCaptureReviewPlan>[0]))
      .not.toThrow();
    expect(generateCaptureReviewPlan(hostile as Parameters<typeof generateCaptureReviewPlan>[0]))
      .toMatchObject({ ok: false });

    const value = draft([{ id: "one", media: media("one") }]);
    expect(generate(value, [{
      itemId: "one",
      include: true,
      url: "https://attacker.invalid/replacement.mp4",
    } as CapturePlanItemChoiceV1])).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});
