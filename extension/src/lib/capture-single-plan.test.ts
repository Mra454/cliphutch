import { describe, expect, it } from "vitest";
import { createSingleCapturePlan } from "./capture-single-plan";

const commandId = "download-123e4567-e89b-42d3-a456-426614174000";

describe("createSingleCapturePlan", () => {
  it("creates an isolated direct-media plan without mutating a Hutch draft", () => {
    const result = createSingleCapturePlan({
      commandId,
      tabId: 9,
      generatedAt: 20,
      filenameTemplate: "auto",
      media: {
        id: "media-1",
        kind: "direct",
        url: "https://cdn.example/video.mp4",
        pageUrl: "https://example.test/lesson",
        pageTitle: "Lesson One",
        detectedAt: 10,
        contentType: "video/mp4",
        provenance: ["network"],
      },
      qualityChoice: { mode: "direct" },
    });
    expect(result).toMatchObject({
      ok: true,
      commandUuid: "123e4567-e89b-42d3-a456-426614174000",
      itemId: "capture-single-item:123e4567-e89b-42d3-a456-426614174000",
      plan: {
        draftId: "capture-single-draft:123e4567-e89b-42d3-a456-426614174000",
        planId: "capture-single-plan:123e4567-e89b-42d3-a456-426614174000",
        totals: { included: 1, videos: 1 },
      },
    });
    if (!result.ok) throw new Error("expected plan");
    expect(result.plan.items[0]?.plannedRelativePath).toMatch(
      /^ClipHutch\/Quick Capture\/example\.test - Lesson One\//,
    );
  });

  it("requires a kind-correct explicit stream selector", () => {
    const media = {
      id: "stream-1",
      kind: "hls" as const,
      url: "https://cdn.example/master.m3u8",
      detectedAt: 10,
      provenance: ["network" as const],
    };
    expect(createSingleCapturePlan({
      commandId,
      tabId: 9,
      generatedAt: 20,
      filenameTemplate: "auto",
      media,
    })).toEqual({
      ok: false,
      reason: "invalid_quality",
    });
    expect(createSingleCapturePlan({
      commandId,
      tabId: 9,
      generatedAt: 20,
      filenameTemplate: "auto",
      media,
      qualityChoice: {
        mode: "stream",
        variantKind: "dash",
        representationId: "wrong-kind",
        policy: { mode: "manual" },
        estimateConfidence: "unknown",
      },
    })).toEqual({ ok: false, reason: "plan_generation_failed" });
    expect(createSingleCapturePlan({
      commandId,
      tabId: 9,
      generatedAt: 20,
      filenameTemplate: "auto",
      media,
      qualityChoice: {
        mode: "stream",
        variantKind: "hls",
        variantUrl: "https://cdn.example/1080.m3u8",
        policy: { mode: "manual" },
        estimateConfidence: "unknown",
      },
    })).toMatchObject({ ok: true });
  });

  it("rejects malformed command, media, and timestamps", () => {
    expect(createSingleCapturePlan({
      commandId: "download-not-a-uuid",
      tabId: 1,
      generatedAt: 2,
      filenameTemplate: "auto",
      media: {
        id: "media",
        kind: "image",
        url: "https://cdn.example/image.jpg",
        detectedAt: 1,
        provenance: ["network"],
      },
    })).toEqual({ ok: false, reason: "invalid_input" });
    expect(createSingleCapturePlan({
      commandId,
      tabId: 1,
      generatedAt: 2,
      filenameTemplate: "auto",
      media: {
        id: "media",
        kind: "image",
        url: "javascript:alert(1)",
        detectedAt: 1,
        provenance: ["network"],
      },
    })).toEqual({ ok: false, reason: "invalid_media" });
  });

  it("freezes the configured filename template into the planned path", () => {
    const base = {
      commandId,
      tabId: 9,
      generatedAt: 20,
      media: {
        id: "media-name",
        kind: "direct" as const,
        url: "https://cdn.example/source-name.mp4",
        pageUrl: "https://example.test/lesson",
        pageTitle: "Customer Lesson",
        detectedAt: 10,
        contentType: "video/mp4",
        provenance: ["network" as const],
      },
      qualityChoice: { mode: "direct" as const },
    };
    const pageTitle = createSingleCapturePlan({ ...base, filenameTemplate: "pageTitle" });
    const urlBasename = createSingleCapturePlan({ ...base, filenameTemplate: "urlBasename" });
    if (!pageTitle.ok || !urlBasename.ok) throw new Error("expected plans");
    expect(pageTitle.plan.items[0]?.plannedRelativePath).toMatch(/\/Customer Lesson\.mp4$/);
    expect(urlBasename.plan.items[0]?.plannedRelativePath).toMatch(/\/source-name\.mp4$/);
  });
});
