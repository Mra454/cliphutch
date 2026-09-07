import { describe, expect, it } from "vitest";
import type { DetectedVideo } from "../types";
import {
  freezeCaptureCopySelection,
  type FreezeCaptureCopySelectionResult,
} from "./capture-copy-choice";
import { MAX_BEST_COPY_CANDIDATES } from "./best-copy";

function image(overrides: Partial<DetectedVideo> = {}): DetectedVideo {
  return {
    id: "image-small",
    kind: "image",
    url: "https://img.example/small.jpg",
    detectedAt: 10,
    pageUrl: "https://site.example/gallery",
    familyId: "picture-family-1",
    provenance: ["picture"],
    width: 640,
    height: 480,
    ...overrides,
  };
}

function successful(result: FreezeCaptureCopySelectionResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected a frozen copy selection");
  return result.value;
}

describe("freezeCaptureCopySelection", () => {
  it("freezes a high-confidence responsive-image recommendation without alternate URLs", () => {
    const small = image();
    const large = image({
      id: "image-large",
      url: "https://img.example/private/large.jpg?secret=alternate",
      width: 1_920,
      height: 1_080,
    });

    const frozen = successful(freezeCaptureCopySelection("image-large", [small, large]));
    expect(frozen).toEqual({
      selected: expect.objectContaining({ id: "image-large" }),
      family: { familyId: "picture-family-1" },
      copyChoice: {
        candidateId: "image-large",
        confidence: "high",
        reason: "Recommended because it has the largest supported responsive-image resolution: 1920 × 1080.",
      },
    });
    expect(JSON.stringify({ family: frozen.family, copyChoice: frozen.copyChoice }))
      .not.toContain("img.example");
    expect(JSON.stringify(frozen.copyChoice)).not.toContain("secret=alternate");
  });

  it("freezes an explicit non-recommended group member as an unproven customer override", () => {
    const frozen = successful(freezeCaptureCopySelection("image-small", [
      image(),
      image({
        id: "image-large",
        url: "https://img.example/large.jpg",
        width: 1_920,
        height: 1_080,
      }),
    ]));

    expect(frozen.copyChoice).toEqual({
      candidateId: "image-small",
      confidence: "unproven",
      reason: "You chose this verified related copy instead of ClipHutch's high-confidence recommendation.",
    });
  });

  it("uses an exact fallback when current group evidence cannot justify a recommendation", () => {
    const singleton = image({ familyId: undefined });
    const frozen = successful(freezeCaptureCopySelection(singleton.id, [singleton]));
    expect(frozen).toMatchObject({
      copyChoice: {
        candidateId: "image-small",
        confidence: "exact",
        reason: "Exact media selected from the Capture Pack draft.",
      },
    });
    expect(frozen.family).toBeUndefined();
  });

  it("uses conservative support facts before relative size", () => {
    const inaccessibleLarge = image({
      id: "large-header-backed",
      url: "https://img.example/header-large.jpg",
      width: 4_000,
      height: 3_000,
      hasCapturedReplayHeaders: true,
    });
    const downloadable = image({
      id: "downloadable",
      url: "https://img.example/downloadable.jpg",
      width: 1_280,
      height: 720,
    });
    const frozen = successful(freezeCaptureCopySelection("downloadable", [
      inaccessibleLarge,
      downloadable,
    ]));
    expect(frozen.copyChoice).toMatchObject({
      candidateId: "downloadable",
      confidence: "high",
    });
  });

  it("honors exact page-scoped MediaGroup semantics instead of family ID alone", () => {
    const pageOne = image();
    const pageTwo = image({
      id: "other-page-large",
      pageUrl: "https://site.example/other",
      url: "https://img.example/other-large.jpg",
      width: 4_000,
      height: 3_000,
    });
    const frozen = successful(freezeCaptureCopySelection(pageOne.id, [pageOne, pageTwo]));
    expect(frozen.copyChoice.confidence).toBe("exact");
  });

  it("fails closed for missing, malformed, duplicated, accessor, and oversized shelf input", () => {
    expect(freezeCaptureCopySelection("missing", [image()])).toEqual({
      ok: false,
      reason: "media_not_found",
    });
    expect(freezeCaptureCopySelection("image-small", [image(), null])).toEqual({
      ok: false,
      reason: "invalid_detected_media",
    });
    expect(freezeCaptureCopySelection("image-small", [
      image(),
      image({ url: "https://img.example/duplicate-id.jpg" }),
    ])).toEqual({ ok: false, reason: "invalid_detected_media" });
    const overlongId = "x".repeat(257);
    expect(freezeCaptureCopySelection("x".repeat(256), [
      image({ id: overlongId }),
    ])).toEqual({ ok: false, reason: "invalid_detected_media" });

    const accessorShelf: unknown[] = [];
    Object.defineProperty(accessorShelf, "0", {
      enumerable: true,
      get: () => image(),
    });
    Object.defineProperty(accessorShelf, "length", { value: 1 });
    expect(freezeCaptureCopySelection("image-small", accessorShelf)).toEqual({
      ok: false,
      reason: "invalid_detected_media",
    });

    expect(freezeCaptureCopySelection("image-small", Array.from(
      { length: MAX_BEST_COPY_CANDIDATES + 1 },
      () => image(),
    ))).toEqual({ ok: false, reason: "invalid_detected_media" });
  });
});
