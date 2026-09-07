import { describe, expect, it } from "vitest";
import type { DetectedVideo } from "../types";
import {
  createDetectedMediaRecordId,
  groupMedia,
  mergeDetectedVideo,
  normalizeDetectedVideo,
  normalizeMediaUrl,
} from "./media-identity";

const FIXED_UUID = "123e4567-e89b-42d3-a456-426614174000";

function media(overrides: Partial<DetectedVideo> = {}): DetectedVideo {
  return {
    id: "media-1",
    url: "https://cdn.example/assets/video.mp4",
    kind: "direct",
    detectedAt: 100,
    pageUrl: "https://site.example/gallery",
    pageTitle: "Gallery",
    ...overrides,
  };
}

describe("normalizeDetectedVideo", () => {
  it("creates bounded opaque record IDs with an explicit tab scope", () => {
    expect(createDetectedMediaRecordId(1, () => FIXED_UUID)).toBe(
      `detected-v1-t1-${FIXED_UUID}`,
    );
    expect(createDetectedMediaRecordId(2, () => FIXED_UUID)).not.toBe(
      createDetectedMediaRecordId(1, () => FIXED_UUID),
    );
    expect(() => createDetectedMediaRecordId(-1, () => FIXED_UUID)).toThrow(/tab scope/i);
    expect(() => createDetectedMediaRecordId(1, () => "not-a-uuid")).toThrow(/UUID/i);
  });

  it("builds a bounded allowlist clone and fills legacy observation metadata", () => {
    const normalized = normalizeDetectedVideo({
      ...media(),
      width: 1_920,
      height: 1_080,
      provenance: ["poster", "network", "poster", "not-real"],
      secretRequestHeaders: { Cookie: "do-not-copy" },
    });

    expect(normalized).toEqual({
      ...media(),
      firstSeenAt: 100,
      lastSeenAt: 100,
      sizeBytes: undefined,
      contentType: undefined,
      contentDisposition: undefined,
      width: 1_920,
      height: 1_080,
      provenance: ["network", "poster"],
      familyId: undefined,
    });
    expect(JSON.stringify(normalized)).not.toContain("do-not-copy");
  });

  it("bounds text and repairs contradictory optional observations", () => {
    const normalized = normalizeDetectedVideo(media({
      firstSeenAt: 500,
      lastSeenAt: 2,
      pageTitle: "x".repeat(2_000),
      contentType: "y".repeat(500),
      contentDisposition: "z".repeat(3_000),
      width: -1,
      height: Number.NaN,
    }));

    expect(normalized?.firstSeenAt).toBe(100);
    expect(normalized?.lastSeenAt).toBe(100);
    expect(normalized?.pageTitle).toHaveLength(1_024);
    expect(normalized?.contentType).toHaveLength(256);
    expect(normalized?.contentDisposition).toHaveLength(2_048);
    expect(normalized?.width).toBeUndefined();
    expect(normalized?.height).toBeUndefined();
  });

  it("rejects malformed identities without invoking accessors", () => {
    let invoked = false;
    const accessor = { ...media() } as Record<string, unknown>;
    Object.defineProperty(accessor, "url", {
      enumerable: true,
      get() {
        invoked = true;
        return "https://cdn.example/secret.mp4";
      },
    });

    expect(normalizeDetectedVideo(accessor)).toBeUndefined();
    expect(invoked).toBe(false);
    expect(normalizeDetectedVideo(media({ url: "file:///private/video.mp4" }))).toBeUndefined();
    expect(normalizeDetectedVideo(media({ detectedAt: Number.NaN }))).toBeUndefined();
    expect(normalizeDetectedVideo(media({ detectedAt: 1.5 }))).toBeUndefined();
    expect(normalizeDetectedVideo(Object.create(media()))).toBeUndefined();
    expect(normalizeDetectedVideo(null)).toBeUndefined();
  });

  it("preserves URL tokens and query order while removing fragments", () => {
    expect(normalizeMediaUrl("HTTPS://CDN.EXAMPLE:443/a?token=one&x=2#frame")).toBe(
      "https://cdn.example/a?token=one&x=2",
    );
    expect(normalizeMediaUrl("https://cdn.example/a?x=2&token=one")).toBe(
      "https://cdn.example/a?x=2&token=one",
    );
  });

  it("preserves only positive captured-header evidence", () => {
    expect(normalizeDetectedVideo(media({ hasCapturedReplayHeaders: true })))
      .toMatchObject({ hasCapturedReplayHeaders: true });
    expect(normalizeDetectedVideo(media({ hasCapturedReplayHeaders: false })))
      .not.toHaveProperty("hasCapturedReplayHeaders");
    expect(mergeDetectedVideo(
      media({ hasCapturedReplayHeaders: true }),
      media({ detectedAt: 200 }),
    )).toMatchObject({ hasCapturedReplayHeaders: true });
  });
});

describe("mergeDetectedVideo", () => {
  it("merges late dimensions, provenance, and observation bounds without moving identity", () => {
    const existing = media({
      id: "stable-id",
      detectedAt: 100,
      firstSeenAt: 90,
      lastSeenAt: 100,
      width: 640,
      height: 360,
      provenance: ["rendered-image"],
      familyId: "family-original",
    });
    const incoming = media({
      id: "replacement-id",
      detectedAt: 200,
      firstSeenAt: 80,
      lastSeenAt: 220,
      pageTitle: "Late title",
      sizeBytes: 50_000,
      width: 1_920,
      height: 1_080,
      provenance: ["network", "picture"],
      familyId: "conflicting-family",
    });

    expect(mergeDetectedVideo(existing, incoming)).toMatchObject({
      id: "stable-id",
      detectedAt: 100,
      firstSeenAt: 80,
      lastSeenAt: 220,
      pageTitle: "Late title",
      sizeBytes: 50_000,
      width: 1_920,
      height: 1_080,
      provenance: ["network", "rendered-image", "picture"],
      familyId: "family-original",
    });
  });

  it("refuses incompatible kinds and token-distinct URLs", () => {
    expect(() => mergeDetectedVideo(
      media({ url: "https://cdn.example/a.jpg?token=one", kind: "image" }),
      media({ url: "https://cdn.example/a.jpg?token=two", kind: "image" }),
    )).toThrow(/exact URL/i);
    expect(() => mergeDetectedVideo(media(), media({ kind: "image" }))).toThrow(/compatible kind/i);
    expect(() => mergeDetectedVideo(
      media({ pageUrl: "https://site.example/app#one" }),
      media({ pageUrl: "https://site.example/app#two" }),
    )).toThrow(/page scope/i);
  });

  it("keeps dimensions as one observed pair and clears ambiguous DOM family evidence", () => {
    const merged = mergeDetectedVideo(
      media({
        kind: "image",
        width: 640,
        height: 360,
        provenance: ["rendered-image"],
        familyId: "family-1",
      }),
      media({
        kind: "image",
        detectedAt: 200,
        width: 1_920,
        height: undefined,
        provenance: ["rendered-image", "picture"],
        familyId: undefined,
      }),
    );
    expect({ width: merged.width, height: merged.height }).toEqual({ width: 640, height: 360 });
    expect(merged.familyId).toBeUndefined();
  });
});

describe("groupMedia", () => {
  it("does not merge same-title fallback assets from one CDN directory", () => {
    const groups = groupMedia([
      media({ id: "one", kind: "image", url: "https://cdn.example/gallery/one.jpg" }),
      media({ id: "two", kind: "image", url: "https://cdn.example/gallery/two.jpg" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.alternates.length === 0)).toBe(true);
  });

  it("keeps signed and reordered query variants independent", () => {
    const groups = groupMedia([
      media({ id: "one", url: "https://cdn.example/a.mp4?token=one&x=2" }),
      media({ id: "two", url: "https://cdn.example/a.mp4?token=two&x=2" }),
      media({ id: "three", url: "https://cdn.example/a.mp4?x=2&token=one" }),
    ]);
    expect(groups).toHaveLength(3);
  });

  it("groups only exact normalized URL duplicates when no family exists", () => {
    const groups = groupMedia([
      media({ id: "one", url: "https://cdn.example:443/a.mp4#first" }),
      media({ id: "two", url: "https://CDN.EXAMPLE/a.mp4#second", detectedAt: 200 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].evidence).toBe("exact-url");
    expect(groups[0].primary.id).toBe("two");
  });

  it("keeps exact media observations on distinct page routes in distinct groups", () => {
    const groups = groupMedia([
      media({ id: "one", pageUrl: "https://site.example/app#one" }),
      media({ id: "two", pageUrl: "https://site.example/app#two" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("groups an authoritative responsive family and keeps its ID when primary changes", () => {
    const small = media({
      id: "small",
      kind: "image",
      url: "https://img.example/photo-640.jpg",
      familyId: "dom-family-1",
      width: 640,
      height: 360,
      sizeBytes: 10,
    });
    const medium = media({
      id: "medium",
      kind: "image",
      url: "https://img.example/photo-1280.jpg",
      familyId: "dom-family-1",
      width: 1_280,
      height: 720,
      sizeBytes: 20,
    });
    const large = media({
      id: "large",
      kind: "image",
      url: "https://img.example/photo-2400.jpg",
      familyId: "dom-family-1",
      width: 2_400,
      height: 1_600,
      sizeBytes: 30,
      detectedAt: 300,
    });

    const initial = groupMedia([small, medium])[0];
    const updated = groupMedia([large, medium, small])[0];
    expect(initial.evidence).toBe("authoritative-family");
    expect(initial.primary.id).toBe("medium");
    expect(updated.primary.id).toBe("large");
    expect(updated.groupId).toBe(initial.groupId);
  });

  it("scopes a supplied family to its page and keeps stream manifests singleton", () => {
    const groups = groupMedia([
      media({
        id: "page-one",
        kind: "image",
        url: "https://img.example/one.jpg",
        pageUrl: "https://site.example/one",
        familyId: "reused-family",
      }),
      media({
        id: "page-two",
        kind: "image",
        url: "https://img.example/two.jpg",
        pageUrl: "https://site.example/two",
        familyId: "reused-family",
      }),
      media({ id: "hls-one", kind: "hls", url: "https://cdn.example/master.m3u8" }),
      media({ id: "hls-two", kind: "hls", url: "https://cdn.example/master.m3u8" }),
    ]);
    expect(groups).toHaveLength(4);
    expect(groups.filter((group) => group.evidence === "single")).toHaveLength(2);
  });

  it("skips corrupt entries and is deterministic across input ordering", () => {
    const validOne = media({ id: "one", url: "https://cdn.example/one.mp4" });
    const validTwo = media({ id: "two", url: "https://cdn.example/two.mp4" });
    const corrupt = { ...media(), url: "javascript:alert(1)" };

    const forward = groupMedia([validOne, corrupt, null, validTwo]);
    const reverse = groupMedia([validTwo, validOne]);
    expect(forward.map((group) => group.groupId)).toEqual(reverse.map((group) => group.groupId));
    expect(forward).toHaveLength(2);
  });
});
