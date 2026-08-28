import { describe, expect, it } from "vitest";
import {
  MAX_NORMALIZED_VARIANT_OPTIONS,
  MAX_VARIANT_BANDWIDTH,
  MAX_VARIANT_DURATION_SEC,
  normalizeVariantOptionsV1,
  parseNormalizedVariantOptionsV1,
  parseNormalizedVariantSelectorV1,
  resolveNormalizedVariantSelectorV1,
  type RawVariantOptionV1,
} from "./variant-options";

function hlsVariant(
  sourceId: string,
  overrides: Partial<RawVariantOptionV1> = {},
): RawVariantOptionV1 {
  return {
    sourceId,
    bandwidth: { scope: "combined", combinedBandwidth: 2_000_000 },
    durationSec: 80,
    width: 1280,
    height: 720,
    ...overrides,
  };
}

describe("normalized variant options", () => {
  it("issues an opaque HLS selector and resolves it only by fresh membership", async () => {
    const first = await normalizeVariantOptionsV1({
      kind: "hls",
      variants: [hlsVariant("https://cdn.example.test/v.m3u8?sig=secret#ignored")],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const option = first.options[0];
    expect(option.sourceId).toBe("https://cdn.example.test/v.m3u8");
    expect(option.selector).toEqual({ kind: "hls", stableId: option.stableId });
    expect(JSON.stringify(option.selector)).not.toContain("cdn.example");
    expect(JSON.stringify(option.selector)).not.toContain("secret");
    expect(resolveNormalizedVariantSelectorV1(first.options, option.selector)).toEqual(option);
    expect(resolveNormalizedVariantSelectorV1(first.options, {
      kind: "hls",
      stableId: option.stableId,
      url: option.sourceId,
    })).toBeUndefined();
    expect(resolveNormalizedVariantSelectorV1(first.options, option.sourceId)).toBeUndefined();

    const refreshed = await normalizeVariantOptionsV1({
      kind: "hls",
      variants: [hlsVariant("https://cdn.example.test/v.m3u8?sig=reissued")],
    });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.options[0].selector).toEqual(option.selector);
    expect(resolveNormalizedVariantSelectorV1(refreshed.options, option.selector)).toEqual(
      refreshed.options[0],
    );
  });

  it("keeps DASH and HLS selectors discriminated even for similar source IDs", async () => {
    const dash = await normalizeVariantOptionsV1({
      kind: "dash",
      variants: [{
        sourceId: "video-720",
        bandwidth: { scope: "video_only", videoBandwidth: 1_000_000 },
        durationSec: 8,
      }],
    });
    expect(dash.ok).toBe(true);
    if (!dash.ok) return;
    expect(dash.options[0]).toMatchObject({
      kind: "dash",
      selector: { kind: "dash" },
      sourceId: "video-720",
    });
    expect(parseNormalizedVariantSelectorV1({
      kind: "hls",
      stableId: dash.options[0].stableId,
    })).toBeUndefined();
  });

  it("changes a DASH selector when a reused Representation ID changes quality facts", async () => {
    const reviewed = await normalizeVariantOptionsV1({
      kind: "dash",
      variants: [{
        sourceId: "video-main",
        width: 640,
        height: 360,
        codecs: "avc1.4d401e",
        bandwidth: { scope: "video_only", videoBandwidth: 500_000 },
        durationSec: 100,
      }],
    });
    const changed = await normalizeVariantOptionsV1({
      kind: "dash",
      variants: [{
        sourceId: "video-main",
        width: 1920,
        height: 1080,
        codecs: "avc1.640028",
        bandwidth: { scope: "video_only", videoBandwidth: 2_500_000 },
        durationSec: 100,
      }],
    });
    expect(reviewed.ok && changed.ok && reviewed.options[0].stableId)
      .not.toBe(changed.ok ? changed.options[0].stableId : "bad");
  });

  it("adds video and selected-default-audio bandwidth before estimating", async () => {
    const result = await normalizeVariantOptionsV1({
      kind: "dash",
      variants: [{
        sourceId: "video-main",
        bandwidth: {
          scope: "video_with_default_audio",
          videoBandwidth: 7_000_000,
          audioBandwidth: 1_000_000,
        },
        durationSec: 10,
      }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options[0]).toMatchObject({
      videoBandwidth: 7_000_000,
      audioBandwidth: 1_000_000,
      combinedBandwidth: 8_000_000,
      durationSec: 10,
      estimatedBytes: 10_000_000,
      estimateConfidence: "estimated",
    });
  });

  it("never interprets unknown default audio as zero", async () => {
    const result = await normalizeVariantOptionsV1({
      kind: "dash",
      variants: [{
        sourceId: "video-main",
        bandwidth: {
          scope: "video_with_unknown_default_audio",
          videoBandwidth: 7_000_000,
        },
        durationSec: 10,
      }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options[0]).toMatchObject({
      videoBandwidth: 7_000_000,
      estimateConfidence: "unknown",
    });
    expect(result.options[0]).not.toHaveProperty("combinedBandwidth");
    expect(result.options[0]).not.toHaveProperty("estimatedBytes");
  });

  it("distinguishes exact measured bytes from conservative bitrate estimates", async () => {
    const result = await normalizeVariantOptionsV1({
      kind: "hls",
      variants: [
        hlsVariant("https://example.test/exact.m3u8", { exactBytes: 123 }),
        hlsVariant("https://example.test/rounded.m3u8", {
          bandwidth: { scope: "combined", combinedBandwidth: 9 },
          durationSec: 1,
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options[0]).toMatchObject({ estimatedBytes: 123, estimateConfidence: "exact" });
    expect(result.options[1]).toMatchObject({ estimatedBytes: 2, estimateConfidence: "estimated" });
  });

  it.each(["drm", "live", "unsupported_codec", "unsupported_container",
    "unsupported_manifest_shape", "unsupported_audio", "permanent_download_failure",
    "invalid_media"] as const)("carries the typed disabled reason %s", async (disabledReason) => {
    const result = await normalizeVariantOptionsV1({
      kind: "hls",
      variants: [hlsVariant(`https://example.test/${disabledReason}.m3u8`, { disabledReason })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options[0]).toMatchObject({ supported: false, disabledReason });
  });

  it("marks an option supported only when no typed disabled reason exists", async () => {
    const result = await normalizeVariantOptionsV1({
      kind: "hls",
      variants: [hlsVariant("https://example.test/clear.m3u8")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options[0]).toMatchObject({ supported: true });
    expect(result.options[0]).not.toHaveProperty("disabledReason");
  });

  it("deduplicates identical canonical sources but rejects conflicting duplicates", async () => {
    const identical = await normalizeVariantOptionsV1({
      kind: "hls",
      variants: [
        hlsVariant("https://example.test/a.m3u8#one", { container: " Video/MP4 " }),
        hlsVariant("https://example.test/a.m3u8#two", { container: "video/mp4" }),
      ],
    });
    expect(identical.ok && identical.options).toHaveLength(1);
    if (identical.ok) expect(identical.options[0].container).toBe("video/mp4");

    await expect(normalizeVariantOptionsV1({
      kind: "dash",
      variants: [
        { sourceId: "same", bandwidth: { scope: "video_only", videoBandwidth: 1 } },
        { sourceId: "same", bandwidth: { scope: "video_only", videoBandwidth: 2 } },
      ],
    })).resolves.toMatchObject({ ok: false, code: "duplicate_source" });
    await expect(normalizeVariantOptionsV1({
      kind: "hls",
      variants: [
        hlsVariant("https://example.test/same.m3u8?token=one"),
        hlsVariant("https://example.test/same.m3u8?token=two"),
      ],
    })).resolves.toMatchObject({ ok: false, code: "duplicate_source" });
  });

  it("uses query-free default-audio structure in stable HLS identity", async () => {
    const make = (audioSourceId: string) => normalizeVariantOptionsV1({
      kind: "hls",
      variants: [hlsVariant("https://example.test/video.m3u8?video-token=a", {
        audioSourceId,
      })],
    });
    const first = await make("https://audio.example.test/default.m3u8?token=one");
    const renewed = await make("https://audio.example.test/default.m3u8?token=two");
    const otherAudio = await make("https://audio.example.test/commentary.m3u8?token=two");
    expect(first.ok && renewed.ok && first.options[0].stableId)
      .toBe(renewed.ok ? renewed.options[0].stableId : "bad");
    expect(first.ok && otherAudio.ok && first.options[0].stableId)
      .not.toBe(otherAudio.ok ? otherAudio.options[0].stableId : "bad");
    if (first.ok) expect(JSON.stringify(first.options)).not.toContain("audio.example");
  });

  it("returns detached canonical clones at the normalized trust boundary", async () => {
    const result = await normalizeVariantOptionsV1({
      kind: "hls",
      variants: [hlsVariant("https://example.test/a.m3u8")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clones = parseNormalizedVariantOptionsV1(result.options);
    expect(clones).toEqual(result.options);
    expect(clones).not.toBe(result.options);
    expect(clones?.[0]).not.toBe(result.options[0]);
    expect(clones?.[0].selector).not.toBe(result.options[0].selector);
    if (clones) clones[0].selector.stableId = clones[0].selector.stableId.replace(/[0-9a-f]$/, "0");
    expect(result.options[0].selector.stableId).toBe(result.options[0].stableId);
  });

  it("fails closed on accessors and hostile proxies", async () => {
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "sourceId", {
      enumerable: true,
      get: () => "https://example.test/a.m3u8",
    });
    Object.defineProperty(accessor, "bandwidth", {
      enumerable: true,
      value: { scope: "unknown" },
    });
    await expect(normalizeVariantOptionsV1({ kind: "hls", variants: [accessor] }))
      .resolves.toMatchObject({ ok: false, code: "invalid_input" });

    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error("trap"); } });
    await expect(normalizeVariantOptionsV1(hostile)).resolves.toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(parseNormalizedVariantOptionsV1(new Proxy([], {
      getOwnPropertyDescriptor: () => { throw new Error("trap"); },
    }))).toBeUndefined();
    const revokedRecord = Proxy.revocable({}, {});
    revokedRecord.revoke();
    await expect(normalizeVariantOptionsV1(revokedRecord.proxy)).resolves.toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    const revokedArray = Proxy.revocable([], {});
    revokedArray.revoke();
    expect(parseNormalizedVariantOptionsV1(revokedArray.proxy)).toBeUndefined();
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1.5,
    MAX_VARIANT_BANDWIDTH + 1,
  ])("rejects a hostile bandwidth value %s", async (videoBandwidth) => {
    await expect(normalizeVariantOptionsV1({
      kind: "dash",
      variants: [{
        sourceId: "video",
        bandwidth: { scope: "video_only", videoBandwidth },
      }],
    })).resolves.toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("turns an unrepresentable projection into Unknown instead of overflowing", async () => {
    const result = await normalizeVariantOptionsV1({
      kind: "hls",
      variants: [hlsVariant("https://example.test/huge.m3u8", {
        bandwidth: { scope: "combined", combinedBandwidth: MAX_VARIANT_BANDWIDTH },
        durationSec: MAX_VARIANT_DURATION_SEC,
      })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options[0].estimateConfidence).toBe("unknown");
    expect(result.options[0]).not.toHaveProperty("estimatedBytes");
  });

  it("rejects unsafe source identifiers and overlarge variant sets", async () => {
    await expect(normalizeVariantOptionsV1({
      kind: "hls",
      variants: [hlsVariant("javascript:alert(1)")],
    })).resolves.toMatchObject({ ok: false, code: "invalid_input" });
    const userinfo = await normalizeVariantOptionsV1({
      kind: "hls",
      variants: [hlsVariant("https://user:pass@example.test/a.m3u8?token=secret")],
    });
    expect(userinfo.ok && userinfo.options[0].sourceId).toBe("https://example.test/a.m3u8");
    await expect(normalizeVariantOptionsV1({
      kind: "dash",
      variants: [{ sourceId: "bad\u202ename", bandwidth: { scope: "unknown" } }],
    })).resolves.toMatchObject({ ok: false, code: "invalid_input" });
    await expect(normalizeVariantOptionsV1({
      kind: "dash",
      variants: Array.from({ length: MAX_NORMALIZED_VARIANT_OPTIONS + 1 }, (_, index) => ({
        sourceId: `v-${index}`,
        bandwidth: { scope: "unknown" },
      })),
    })).resolves.toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("rejects inconsistent normalized records instead of repairing them", async () => {
    const result = await normalizeVariantOptionsV1({
      kind: "dash",
      variants: [{
        sourceId: "video",
        bandwidth: {
          scope: "video_with_default_audio",
          videoBandwidth: 8,
          audioBandwidth: 8,
        },
        durationSec: 1,
      }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const forged = structuredClone(result.options) as Array<Record<string, unknown>>;
    forged[0].combinedBandwidth = 8;
    expect(parseNormalizedVariantOptionsV1(forged)).toBeUndefined();
  });

  it("recomputes estimated bytes at the normalized trust boundary", async () => {
    const result = await normalizeVariantOptionsV1({
      kind: "dash",
      variants: [{
        sourceId: "video",
        bandwidth: { scope: "video_only", videoBandwidth: 8_000_000 },
        durationSec: 10,
      }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const understated = structuredClone(result.options) as Array<Record<string, unknown>>;
    understated[0].estimatedBytes = 1;
    expect(parseNormalizedVariantOptionsV1(understated)).toBeUndefined();
  });
});
