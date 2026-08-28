import { describe, expect, it } from "vitest";
import type { DetectedVideo } from "../types";
import type { MediaSnapshotV1 } from "./capture-pack-types";
import {
  MAX_BEST_COPY_CANDIDATES,
  recommendBestCopy,
  type BestCopyCandidateV1,
} from "./best-copy";

function detected(overrides: Partial<DetectedVideo> = {}): DetectedVideo {
  return {
    id: "candidate-1",
    kind: "image",
    url: "https://img.example/photo-640.jpg",
    detectedAt: 100,
    pageUrl: "https://site.example/gallery",
    pageTitle: "Gallery",
    provenance: ["picture"],
    familyId: "picture-family-1",
    ...overrides,
  };
}

function snapshot(overrides: Partial<MediaSnapshotV1> = {}): MediaSnapshotV1 {
  return {
    mediaId: "candidate-1",
    kind: "image",
    url: "https://img.example/photo-640.jpg",
    detectedAt: 100,
    pageUrl: "https://site.example/gallery",
    pageTitle: "Gallery",
    provenance: ["picture"],
    familyId: "picture-family-1",
    ...overrides,
  };
}

function candidate(
  media: DetectedVideo | MediaSnapshotV1,
  supported = true,
): BestCopyCandidateV1 {
  return { media, supported };
}

describe("recommendBestCopy", () => {
  it("ranks a supported candidate ahead of a larger unsupported copy", () => {
    const recommendation = recommendBestCopy([
      candidate(detected({
        id: "unsupported-large",
        url: "https://img.example/photo-4000.jpg",
        width: 4_000,
        height: 3_000,
        sizeBytes: 20_000_000,
      }), false),
      candidate(detected({
        id: "supported-medium",
        url: "https://img.example/photo-1280.jpg",
        width: 1_280,
        height: 720,
        sizeBytes: 500_000,
      })),
    ]);

    expect(recommendation).toEqual({
      candidateId: "supported-medium",
      confidence: "high",
      reason: "Recommended because it has the largest supported responsive-image resolution: 1280 × 720.",
    });
  });

  it("ranks known pixel area before bytes and uses bytes only with quality metadata", () => {
    const largestPixels = recommendBestCopy([
      candidate(detected({
        id: "large-file",
        url: "https://img.example/photo-1000.jpg",
        width: 1_000,
        height: 1_000,
        sizeBytes: 20_000_000,
      })),
      candidate(detected({
        id: "large-area",
        url: "https://img.example/photo-1600.jpg",
        width: 1_600,
        height: 900,
        sizeBytes: 500_000,
      })),
    ]);
    expect(largestPixels?.candidateId).toBe("large-area");

    const supportingBytes = recommendBestCopy([
      candidate(detected({
        id: "smaller-original",
        url: "https://img.example/photo-a.jpg",
        width: 1_280,
        height: 720,
        sizeBytes: 400_000,
      })),
      candidate(detected({
        id: "larger-original",
        url: "https://img.example/photo-b.jpg",
        width: 1_280,
        height: 720,
        sizeBytes: 900_000,
      })),
    ]);
    expect(supportingBytes?.candidateId).toBe("larger-original");

    expect(recommendBestCopy([
      candidate(detected({
        id: "bytes-a",
        url: "https://img.example/photo-a.jpg",
        sizeBytes: 100,
      })),
      candidate(detected({
        id: "bytes-b",
        url: "https://img.example/photo-b.jpg",
        sizeBytes: 1_000_000,
      })),
    ])).toBeNull();

    const unrelatedQualityDoesNotEnableByteOnlyRanking = recommendBestCopy([
      candidate(detected({
        id: "supported-a",
        url: "https://img.example/supported-a.jpg",
        sizeBytes: 100,
      })),
      candidate(detected({
        id: "supported-z",
        url: "https://img.example/supported-z.jpg",
        sizeBytes: 1_000_000,
      })),
      candidate(detected({
        id: "unsupported-with-dimensions",
        url: "https://img.example/unsupported.jpg",
        width: 4_000,
        height: 3_000,
      }), false),
    ]);
    expect(unrelatedQualityDoesNotEnableByteOnlyRanking?.candidateId).toBe("supported-a");
  });

  it("does not call a known-resolution candidate largest when a supported peer is unknown", () => {
    const recommendation = recommendBestCopy([
      candidate(detected({
        id: "known",
        url: "https://img.example/known.jpg",
        width: 640,
        height: 480,
      })),
      candidate(detected({
        id: "unknown",
        url: "https://img.example/unknown.jpg",
      })),
    ]);
    expect(recommendation?.candidateId).toBe("known");
    expect(recommendation?.reason).not.toContain("largest");
  });

  it("uses exact normalized identity and a stable ID for deterministic ties", () => {
    const copyA = detected({
      id: "copy-a",
      kind: "direct",
      familyId: undefined,
      url: "https://CDN.EXAMPLE:443/video.mp4#first",
    });
    const copyZ = detected({
      id: "copy-z",
      kind: "direct",
      familyId: undefined,
      url: "https://cdn.example/video.mp4#second",
    });

    const forward = recommendBestCopy([candidate(copyZ), candidate(copyA)]);
    const reverse = recommendBestCopy([candidate(copyA), candidate(copyZ)]);
    expect(forward).toEqual(reverse);
    expect(forward).toEqual({
      candidateId: "copy-a",
      confidence: "high",
      reason: "Recommended because these records resolve to the exact same media and this copy uses a supported save path.",
    });
    expect(JSON.stringify(forward)).not.toContain("cdn.example");
  });

  it("accepts immutable media snapshots without letting observation metadata drive rank", () => {
    const small = snapshot({
      mediaId: "small",
      url: "https://img.example/small.jpg",
      width: 640,
      height: 480,
      detectedAt: 900,
      sizeBytes: 9_000_000,
    });
    const large = snapshot({
      mediaId: "large",
      url: "https://img.example/large.jpg",
      width: 1_920,
      height: 1_080,
      detectedAt: 10,
      sizeBytes: 500_000,
    });

    expect(recommendBestCopy([candidate(small), candidate(large)])?.candidateId).toBe("large");
  });

  it("is stable across ordering and non-ranking metadata updates", () => {
    const small = detected({
      id: "small",
      url: "https://img.example/small.jpg",
      width: 640,
      height: 480,
      sizeBytes: 50_000_000,
    });
    const large = detected({
      id: "large",
      url: "https://img.example/large.jpg",
      width: 1_920,
      height: 1_080,
      sizeBytes: 500_000,
    });
    const updatedSmall = detected({
      ...small,
      detectedAt: 5_000,
      firstSeenAt: 1,
      lastSeenAt: 9_000,
      pageTitle: "A newer title",
      provenance: ["network", "metadata", "picture"],
    });

    expect(recommendBestCopy([candidate(small), candidate(large)])?.candidateId).toBe("large");
    expect(recommendBestCopy([candidate(large), candidate(updatedSmall)])?.candidateId).toBe(
      "large",
    );
  });

  it.each([
    {
      name: "same title and directory",
      media: [
        detected({ id: "one", kind: "direct", familyId: undefined, url: "https://cdn.example/gallery/one.mp4" }),
        detected({ id: "two", kind: "direct", familyId: undefined, url: "https://cdn.example/gallery/two.mp4" }),
      ],
    },
    {
      name: "same filename in different directories",
      media: [
        detected({ id: "one", kind: "direct", familyId: undefined, url: "https://cdn.example/a/video.mp4" }),
        detected({ id: "two", kind: "direct", familyId: undefined, url: "https://cdn.example/b/video.mp4" }),
      ],
    },
    {
      name: "signed or reordered query strings",
      media: [
        detected({ id: "one", kind: "direct", familyId: undefined, url: "https://cdn.example/video.mp4?token=one&x=2" }),
        detected({ id: "two", kind: "direct", familyId: undefined, url: "https://cdn.example/video.mp4?x=2&token=one" }),
      ],
    },
    {
      name: "an image family ID reused on another page",
      media: [
        detected({ id: "one", pageUrl: "https://site.example/one" }),
        detected({ id: "two", pageUrl: "https://site.example/two", url: "https://img.example/photo-1280.jpg" }),
      ],
    },
    {
      name: "the same URL with incompatible kinds",
      media: [
        detected({ id: "one", kind: "direct", familyId: undefined, url: "https://cdn.example/media" }),
        detected({ id: "two", kind: "image", familyId: undefined, url: "https://cdn.example/media" }),
      ],
    },
  ])("does not recommend a false merge for $name", ({ media }) => {
    expect(recommendBestCopy(media.map((entry) => candidate(entry)))).toBeNull();
  });

  it("keeps stream manifests independent because no validated family exists in the model", () => {
    for (const kind of ["hls", "dash"] as const) {
      const first = snapshot({
        mediaId: `${kind}-one`,
        kind,
        familyId: "claimed-manifest-family",
        url: `https://cdn.example/master.${kind === "hls" ? "m3u8" : "mpd"}`,
        width: 1_280,
        height: 720,
        bitrate: 2_000_000,
      });
      const second = snapshot({
        ...first,
        mediaId: `${kind}-two`,
        width: 1_920,
        height: 1_080,
        bitrate: 6_000_000,
      });
      expect(recommendBestCopy([candidate(first), candidate(second)])).toBeNull();
    }
  });

  it("returns no recommendation for singletons, all-unsupported sets, or duplicate IDs", () => {
    const one = detected({ id: "one", width: 640, height: 480 });
    const two = detected({ id: "two", url: "https://img.example/two.jpg", width: 1_280, height: 720 });
    expect(recommendBestCopy([candidate(one)])).toBeNull();
    expect(recommendBestCopy([candidate(one, false), candidate(two, false)])).toBeNull();
    expect(recommendBestCopy([
      candidate(one),
      candidate(detected({ ...one, url: "https://img.example/duplicate.jpg" })),
    ])).toBeNull();
  });

  it("does not overflow when comparing maximum safe dimensions", () => {
    const recommendation = recommendBestCopy([
      candidate(detected({
        id: "max-width",
        url: "https://img.example/max-width.jpg",
        width: Number.MAX_SAFE_INTEGER,
        height: 2,
      })),
      candidate(detected({
        id: "max-height",
        url: "https://img.example/max-height.jpg",
        width: Number.MAX_SAFE_INTEGER - 1,
        height: 3,
      })),
    ]);
    expect(recommendation?.candidateId).toBe("max-height");
  });

  it("fails closed on sparse, oversized, accessor-backed, and trapped inputs", () => {
    const valid = candidate(detected({ id: "valid", width: 640, height: 480 }));
    const sparse = new Array(2);
    sparse[0] = valid;
    expect(recommendBestCopy(sparse)).toBeNull();

    expect(recommendBestCopy(new Array(MAX_BEST_COPY_CANDIDATES + 1).fill(valid))).toBeNull();
    expect(recommendBestCopy([
      { ...valid, unexpected: "not part of the contract" },
      candidate(detected({ id: "other", url: "https://img.example/other.jpg" })),
    ])).toBeNull();

    let accessorInvoked = false;
    const accessorMedia = { ...detected({ id: "accessor" }) } as Record<string, unknown>;
    Object.defineProperty(accessorMedia, "url", {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return "https://img.example/private.jpg";
      },
    });
    expect(recommendBestCopy([
      { media: accessorMedia, supported: true },
      valid,
    ])).toBeNull();
    expect(accessorInvoked).toBe(false);

    const trapped = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile trap");
      },
    });
    expect(() => recommendBestCopy([
      { media: trapped, supported: true },
      valid,
    ])).not.toThrow();
    expect(recommendBestCopy([
      { media: trapped, supported: true },
      valid,
    ])).toBeNull();
  });
});
