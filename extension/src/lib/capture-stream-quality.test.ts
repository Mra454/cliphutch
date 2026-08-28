import { describe, expect, it } from "vitest";
import { buildPersistentCaptureStreamChoice } from "./capture-variant-preflight";
import { revalidatePersistentCaptureStreamQualityV1 } from "./capture-stream-quality";
import { normalizeVariantOptionsV1, type RawVariantOptionV1 } from "./variant-options";

async function options(kind: "hls" | "dash", variants: RawVariantOptionV1[]) {
  const result = await normalizeVariantOptionsV1({ kind, variants });
  if (!result.ok) throw new Error(result.code);
  return result.options;
}

describe("Capture Pack execution-time stream quality", () => {
  it("resolves a manual HLS selector after signed-query rotation", async () => {
    const reviewed = await options("hls", [{
      sourceId: "https://cdn.example/720.m3u8?token=first",
      width: 1280,
      height: 720,
      bandwidth: { scope: "combined", combinedBandwidth: 2_000_000 },
      durationSec: 100,
    }]);
    const quality = buildPersistentCaptureStreamChoice({
      option: reviewed[0],
      policy: { mode: "manual" },
      maxDownloadBytes: 100_000_000,
      label: "720p",
    });
    const refreshed = await options("hls", [{
      sourceId: "https://cdn.example/720.m3u8?token=second",
      width: 1280,
      height: 720,
      bandwidth: { scope: "combined", combinedBandwidth: 2_000_000 },
      durationSec: 100,
    }]);
    const resolved = revalidatePersistentCaptureStreamQualityV1(quality, refreshed);
    expect(resolved).toMatchObject({ ok: true, selector: refreshed[0].selector });
    expect(refreshed[0].sourceId).toBe("https://cdn.example/720.m3u8");
  });

  it("fails visibly when an exact manual variant disappears", async () => {
    const reviewed = await options("dash", [{
      sourceId: "video-720",
      width: 1280,
      height: 720,
      bandwidth: { scope: "video_only", videoBandwidth: 2_000_000 },
      durationSec: 100,
    }]);
    const quality = buildPersistentCaptureStreamChoice({
      option: reviewed[0],
      policy: { mode: "manual" },
      maxDownloadBytes: 100_000_000,
    });
    const refreshed = await options("dash", [{
      sourceId: "video-1080",
      width: 1920,
      height: 1080,
      bandwidth: { scope: "video_only", videoBandwidth: 4_000_000 },
      durationSec: 100,
    }]);
    expect(revalidatePersistentCaptureStreamQualityV1(quality, refreshed)).toEqual({
      ok: false,
      reason: "variant_stale",
    });
  });

  it("fails visibly when DASH reuses a Representation ID for different quality facts", async () => {
    const reviewed = await options("dash", [{
      sourceId: "video-main",
      width: 640,
      height: 360,
      codecs: "avc1.4d401e",
      bandwidth: {
        scope: "video_with_default_audio",
        videoBandwidth: 500_000,
        audioBandwidth: 64_000,
      },
      durationSec: 100,
    }]);
    const quality = buildPersistentCaptureStreamChoice({
      option: reviewed[0],
      policy: { mode: "manual" },
      maxDownloadBytes: 100_000_000,
    });
    const refreshed = await options("dash", [{
      sourceId: "video-main",
      width: 1920,
      height: 1080,
      codecs: "avc1.640028",
      bandwidth: {
        scope: "video_with_default_audio",
        videoBandwidth: 2_500_000,
        audioBandwidth: 256_000,
      },
      durationSec: 100,
    }]);

    expect(revalidatePersistentCaptureStreamQualityV1(quality, refreshed)).toEqual({
      ok: false,
      reason: "variant_stale",
    });
  });

  it("fails visibly when a manual HLS choice keeps its path but changes duration", async () => {
    const reviewed = await options("hls", [{
      sourceId: "https://cdn.example/720.m3u8?token=first",
      width: 1280,
      height: 720,
      bandwidth: { scope: "combined", combinedBandwidth: 2_000_000 },
      durationSec: 100,
    }]);
    const quality = buildPersistentCaptureStreamChoice({
      option: reviewed[0],
      policy: { mode: "manual" },
      maxDownloadBytes: 100_000_000,
    });
    const refreshed = await options("hls", [{
      sourceId: "https://cdn.example/720.m3u8?token=second",
      width: 1280,
      height: 720,
      bandwidth: { scope: "combined", combinedBandwidth: 2_000_000 },
      durationSec: 120,
    }]);

    expect(revalidatePersistentCaptureStreamQualityV1(quality, refreshed)).toEqual({
      ok: false,
      reason: "variant_stale",
    });
  });

  it("recomputes an automatic choice inside the exact frozen rule", async () => {
    const reviewed = await options("dash", [{
      sourceId: "video-720-old",
      width: 1280,
      height: 720,
      bandwidth: { scope: "video_with_default_audio", videoBandwidth: 2_000_000, audioBandwidth: 128_000 },
      durationSec: 100,
    }]);
    const quality = buildPersistentCaptureStreamChoice({
      option: reviewed[0],
      policy: { mode: "best_under_cap", maxEstimatedBytes: 60_000_000, maxHeight: 1080 },
      maxDownloadBytes: 60_000_000,
    });
    const refreshed = await options("dash", [
      {
        sourceId: "video-720-new",
        width: 1280,
        height: 720,
        bandwidth: { scope: "video_with_default_audio", videoBandwidth: 2_200_000, audioBandwidth: 128_000 },
        durationSec: 100,
      },
      {
        sourceId: "video-1080-new",
        width: 1920,
        height: 1080,
        bandwidth: { scope: "video_with_default_audio", videoBandwidth: 3_800_000, audioBandwidth: 128_000 },
        durationSec: 100,
      },
    ]);
    expect(revalidatePersistentCaptureStreamQualityV1(quality, refreshed)).toMatchObject({
      ok: true,
      selector: refreshed[1].selector,
    });
  });

  it("never treats a newly Unknown estimate as fitting the automatic rule", async () => {
    const reviewed = await options("hls", [{
      sourceId: "https://cdn.example/720.m3u8",
      width: 1280,
      height: 720,
      bandwidth: { scope: "combined", combinedBandwidth: 2_000_000 },
      durationSec: 100,
    }]);
    const quality = buildPersistentCaptureStreamChoice({
      option: reviewed[0],
      policy: { mode: "best_under_cap", maxEstimatedBytes: 50_000_000 },
      maxDownloadBytes: 50_000_000,
    });
    const refreshed = await options("hls", [{
      sourceId: "https://cdn.example/720.m3u8?new=1",
      width: 1280,
      height: 720,
      bandwidth: { scope: "combined", combinedBandwidth: 2_000_000 },
    }]);
    expect(revalidatePersistentCaptureStreamQualityV1(quality, refreshed)).toEqual({
      ok: false,
      reason: "quality_policy_no_match",
    });
  });
});
