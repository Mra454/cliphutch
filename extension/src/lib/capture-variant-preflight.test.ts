import { describe, expect, it } from "vitest";
import {
  applyCaptureVariantOptionBudget,
  buildCaptureVariantPreflight,
  buildPersistentCaptureStreamChoice,
  resolveCaptureVariantOption,
  selectCaptureReviewVariantV1,
} from "./capture-variant-preflight";
import { normalizeVariantOptionsV1, type RawVariantOptionV1 } from "./variant-options";

async function normalized(kind: "hls" | "dash", variants: RawVariantOptionV1[]) {
  const result = await normalizeVariantOptionsV1({ kind, variants });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.options;
}

describe("capture variant preflight", () => {
  it("redacts signed locators and exposes truthful combined estimates", async () => {
    const variants = await normalized("hls", [{
      sourceId: "https://cdn.example/video/1080.m3u8?signature=secret#fragment",
      width: 1920,
      height: 1080,
      bandwidth: { scope: "combined", combinedBandwidth: 4_000_000 },
      durationSec: 120,
    }]);
    const first = await buildCaptureVariantPreflight({
      itemId: "item-1",
      kind: "hls",
      variants,
      maxDownloadBytes: 100_000_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(JSON.stringify(first.entries[0].publicOption)).not.toContain("signature");
    expect(JSON.stringify(first.entries[0].manualQualityChoice)).not.toContain("cdn.example");
    expect(first.entries[0].publicOption).toMatchObject({
      itemId: "item-1",
      kind: "hls",
      label: "1920×1080 • 4.0 Mbps",
      combinedBandwidth: 4_000_000,
      estimatedBytes: 60_000_000,
      estimateConfidence: "estimated",
      supported: true,
    });
    expect(first.entries[0].manualQualityChoice).toMatchObject({
      mode: "stream",
      policy: { mode: "manual" },
      maxDownloadBytes: 100_000_000,
      selector: { kind: "hls" },
    });
  });

  it("keeps disabled variants visible but non-executable", async () => {
    const variants = await normalized("dash", [{
      sourceId: "video-drm",
      bandwidth: { scope: "video_only", videoBandwidth: 2_000_000 },
      disabledReason: "drm",
    }]);
    const result = await buildCaptureVariantPreflight({
      itemId: "item-2",
      kind: "dash",
      variants,
      maxDownloadBytes: 100_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0].publicOption).toMatchObject({
      supported: false,
      disabledReason: "drm",
    });
    expect(result.entries[0].manualQualityChoice).toBeUndefined();
  });

  it("disables a known option above the frozen hard cap", async () => {
    const variants = await normalized("dash", [{
      sourceId: "video-large",
      bandwidth: { scope: "video_only", videoBandwidth: 8_000_000 },
      durationSec: 100,
    }]);
    const result = await buildCaptureVariantPreflight({
      itemId: "item-3",
      kind: "dash",
      variants,
      maxDownloadBytes: 50_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0].publicOption).toMatchObject({
      supported: false,
      disabledReason: "over_size_cap",
      estimatedBytes: 100_000_000,
    });
    expect(result.entries[0].manualQualityChoice).toBeUndefined();
  });

  it("resolves only an issued opaque ID and rejects raw source identifiers", async () => {
    const variants = await normalized("hls", [{
      sourceId: "https://cdn.example/v.m3u8",
      bandwidth: { scope: "unknown" },
    }]);
    const result = await buildCaptureVariantPreflight({
      itemId: "item-4",
      kind: "hls",
      variants,
      maxDownloadBytes: 1_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const issued = result.entries[0].publicOption.optionId;
    expect(resolveCaptureVariantOption(result.entries, issued)).toBe(result.entries[0]);
    expect(resolveCaptureVariantOption(result.entries, "https://cdn.example/v.m3u8")).toBeUndefined();
  });

  it("builds automatic choices only when the frozen policy contract is met", async () => {
    const options = await normalized("dash", [{
      sourceId: "video-720",
      width: 1280,
      height: 720,
      bandwidth: { scope: "video_only", videoBandwidth: 2_000_000 },
      durationSec: 100,
    }]);
    expect(buildPersistentCaptureStreamChoice({
      option: options[0],
      policy: { mode: "best_under_cap", maxEstimatedBytes: 50_000_000, maxHeight: 720 },
      maxDownloadBytes: 50_000_000,
    })).toMatchObject({
      selector: { kind: "dash" },
      estimatedBytes: 25_000_000,
    });
    expect(buildPersistentCaptureStreamChoice({
      option: options[0],
      policy: { mode: "best_under_cap", maxEstimatedBytes: 20_000_000 },
      maxDownloadBytes: 20_000_000,
    })).toBeUndefined();
  });

  it("applies an automatic policy while keeping an explicit override manual", async () => {
    const variants = await normalized("dash", [
      {
        sourceId: "video-720",
        width: 1280,
        height: 720,
        bandwidth: { scope: "video_only", videoBandwidth: 2_000_000 },
        durationSec: 100,
      },
      {
        sourceId: "video-1080",
        width: 1920,
        height: 1080,
        bandwidth: { scope: "video_only", videoBandwidth: 4_000_000 },
        durationSec: 100,
      },
    ]);
    const preflight = await buildCaptureVariantPreflight({
      itemId: "item-policy",
      kind: "dash",
      variants,
      maxDownloadBytes: 100_000_000,
    });
    if (!preflight.ok) throw new Error(preflight.code);
    expect(selectCaptureReviewVariantV1({
      entries: preflight.entries,
      policy: { mode: "best_under_cap", maxEstimatedBytes: 100_000_000 },
      maxDownloadBytes: 100_000_000,
    })).toMatchObject({ state: "selected", automatic: true });
    expect(selectCaptureReviewVariantV1({
      entries: preflight.entries,
      requestedOptionId: preflight.entries[0].publicOption.optionId,
      policy: { mode: "best_under_cap", maxEstimatedBytes: 100_000_000 },
      maxDownloadBytes: 100_000_000,
    })).toMatchObject({
      state: "selected",
      automatic: false,
      qualityChoice: { policy: { mode: "manual" } },
    });
  });

  it("never silently picks an Unknown automatic option", async () => {
    const variants = await normalized("hls", [{
      sourceId: "https://cdn.example/unknown.m3u8",
      width: 1920,
      height: 1080,
      bandwidth: { scope: "combined", combinedBandwidth: 4_000_000 },
    }]);
    const preflight = await buildCaptureVariantPreflight({
      itemId: "item-unknown",
      kind: "hls",
      variants,
      maxDownloadBytes: 100_000_000,
    });
    if (!preflight.ok) throw new Error(preflight.code);
    expect(selectCaptureReviewVariantV1({
      entries: preflight.entries,
      policy: { mode: "best_under_cap", maxEstimatedBytes: 100_000_000 },
      maxDownloadBytes: 100_000_000,
    })).toEqual({ state: "needs_choice", reason: "all_estimates_unknown" });
  });

  it("suggests only a hard-cap-safe option when automatic limits need confirmation", async () => {
    const variants = await normalized("dash", [
      {
        sourceId: "video-over-hard-cap",
        width: 640,
        height: 360,
        bandwidth: { scope: "video_only", videoBandwidth: 8_800_000 },
        durationSec: 100,
      },
      {
        sourceId: "video-confirmable",
        width: 1280,
        height: 720,
        bandwidth: { scope: "video_only", videoBandwidth: 7_600_000 },
        durationSec: 100,
      },
    ]);
    const preflight = await buildCaptureVariantPreflight({
      itemId: "item-confirm",
      kind: "dash",
      variants,
      maxDownloadBytes: 100_000_000,
    });
    if (!preflight.ok) throw new Error(preflight.code);
    expect(preflight.entries[0].manualQualityChoice).toBeUndefined();
    expect(selectCaptureReviewVariantV1({
      entries: preflight.entries,
      policy: { mode: "best_under_cap", maxEstimatedBytes: 100_000_000 },
      maxDownloadBytes: 100_000_000,
    })).toMatchObject({
      state: "needs_choice",
      reason: "confirmation_required",
      suggestedStableId: preflight.entries[1].normalizedOption.stableId,
      suggestionScope: "smallest",
    });
  });

  it("reports when its confirmation suggestion is scoped by max height", async () => {
    const variants = await normalized("dash", [
      {
        sourceId: "video-720",
        width: 1280,
        height: 720,
        bandwidth: { scope: "video_only", videoBandwidth: 7_600_000 },
        durationSec: 100,
      },
      {
        sourceId: "video-1080",
        width: 1920,
        height: 1080,
        bandwidth: { scope: "video_only", videoBandwidth: 7_280_000 },
        durationSec: 100,
      },
    ]);
    const preflight = await buildCaptureVariantPreflight({
      itemId: "item-height-confirm",
      kind: "dash",
      variants,
      maxDownloadBytes: 100_000_000,
    });
    if (!preflight.ok) throw new Error(preflight.code);
    expect(selectCaptureReviewVariantV1({
      entries: preflight.entries,
      policy: {
        mode: "best_under_cap",
        maxEstimatedBytes: 100_000_000,
        maxHeight: 720,
      },
      maxDownloadBytes: 100_000_000,
    })).toMatchObject({
      state: "needs_choice",
      reason: "confirmation_required",
      suggestedStableId: preflight.entries[0].normalizedOption.stableId,
      suggestionScope: "smallest_within_height",
    });
  });

  it("keeps whole stream option groups within the shared 200-option review cap", () => {
    const result = applyCaptureVariantOptionBudget([
      Array.from({ length: 100 }, (_, index) => `a-${index}`),
      Array.from({ length: 100 }, (_, index) => `b-${index}`),
      ["c-1"],
    ]);
    expect(result.groups.map((group) => group.length)).toEqual([100, 100, 0]);
    expect(result.overflowGroupIndexes).toEqual([2]);
  });
});
