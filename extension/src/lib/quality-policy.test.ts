import { describe, expect, it } from "vitest";
import {
  bestUnderCapEffectiveMaximumBytesV1,
  parseBestUnderCapQualityPolicyV1,
  selectBestUnderCapVariantV1,
} from "./quality-policy";
import {
  normalizeVariantOptionsV1,
  type NormalizedVariantV1,
  type RawVariantOptionV1,
  type VariantDisabledReasonV1,
} from "./variant-options";

type OptionSpec = {
  id: string;
  width?: number;
  height?: number;
  bitrate?: number;
  bytes?: number;
  unknown?: boolean;
  disabledReason?: VariantDisabledReasonV1;
};

async function options(specs: OptionSpec[]): Promise<NormalizedVariantV1[]> {
  const variants: RawVariantOptionV1[] = specs.map((spec) => ({
    sourceId: spec.id,
    ...(spec.width === undefined ? {} : { width: spec.width }),
    ...(spec.height === undefined ? {} : { height: spec.height }),
    bandwidth: spec.unknown
      ? { scope: "unknown" as const }
      : { scope: "video_only" as const, videoBandwidth: spec.bitrate ?? 1_000_000 },
    ...(spec.unknown ? {} : { durationSec: 8 }),
    ...(spec.bytes === undefined ? {} : { exactBytes: spec.bytes }),
    ...(spec.disabledReason === undefined ? {} : { disabledReason: spec.disabledReason }),
  }));
  const result = await normalizeVariantOptionsV1({ kind: "dash", variants });
  if (!result.ok) throw new Error(`${result.code}: ${result.customerMessage}`);
  return result.options;
}

describe("best-under-cap quality policy", () => {
  it("computes exactly 10% headroom without overflow", () => {
    expect(bestUnderCapEffectiveMaximumBytesV1(100)).toBe(90);
    expect(bestUnderCapEffectiveMaximumBytesV1(101)).toBe(90);
    expect(bestUnderCapEffectiveMaximumBytesV1(1)).toBe(0);
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(BigInt(bestUnderCapEffectiveMaximumBytesV1(maximum)))
      .toBe((BigInt(maximum) * 9n) / 10n);
  });

  it("accepts the exact 90% boundary and rejects the next byte", async () => {
    const variants = await options([
      { id: "fits", width: 1280, height: 720, bytes: 90 },
      { id: "over", width: 1920, height: 1080, bytes: 91 },
    ]);
    const result = selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 100 },
      variants,
    );
    expect(result).toMatchObject({
      state: "selected",
      effectiveMaxEstimatedBytes: 90,
      choice: { height: 720, estimatedBytes: 90 },
    });
  });

  it("chooses greatest pixel area, then combined bitrate", async () => {
    const variants = await options([
      { id: "small-fast", width: 640, height: 360, bitrate: 9_000_000, bytes: 100 },
      { id: "large-slow", width: 1280, height: 720, bitrate: 1_000_000, bytes: 100 },
      { id: "large-fast", width: 1280, height: 720, bitrate: 2_000_000, bytes: 100 },
    ]);
    const result = selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000 },
      variants,
    );
    expect(result).toMatchObject({
      state: "selected",
      choice: { width: 1280, height: 720, combinedBandwidth: 2_000_000 },
    });
  });

  it("uses stable ID as the final deterministic tie-break independent of order", async () => {
    const variants = await options([
      { id: "tie-b", width: 1280, height: 720, bitrate: 1_000_000, bytes: 100 },
      { id: "tie-a", width: 1280, height: 720, bitrate: 1_000_000, bytes: 100 },
    ]);
    const expected = [...variants].sort((left, right) => (
      left.stableId < right.stableId ? -1 : left.stableId > right.stableId ? 1 : 0
    ))[0].stableId;
    const policy = { mode: "best_under_cap", maxEstimatedBytes: 1_000 };
    const first = selectBestUnderCapVariantV1(policy, variants);
    const reversed = selectBestUnderCapVariantV1(policy, [...variants].reverse());
    expect(first.state === "selected" && first.choice.stableId).toBe(expected);
    expect(reversed).toEqual(first);
  });

  it("applies maxHeight before quality ranking", async () => {
    const variants = await options([
      { id: "720", width: 1280, height: 720, bytes: 100 },
      { id: "1080", width: 1920, height: 1080, bytes: 100 },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000, maxHeight: 720 },
      variants,
    )).toMatchObject({ state: "selected", choice: { height: 720 } });
  });

  it("returns needs_choice when every supported estimate is unknown", async () => {
    const variants = await options([
      { id: "360", width: 640, height: 360, unknown: true },
      { id: "720", width: 1280, height: 720, unknown: true },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000 },
      variants,
    )).toMatchObject({ state: "needs_choice", reason: "all_estimates_unknown" });
  });

  it("does not claim no-fit when a mixed unknown estimate remains unresolved", async () => {
    const variants = await options([
      { id: "known-over", width: 640, height: 360, bytes: 901 },
      { id: "unknown", width: 1280, height: 720, unknown: true },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000 },
      variants,
    )).toMatchObject({ state: "needs_choice", reason: "unresolved_estimate" });
  });

  it("can choose a known fitting option without classifying an unknown as under cap", async () => {
    const variants = await options([
      { id: "known", width: 1280, height: 720, bytes: 100 },
      { id: "unknown-lower-quality", width: 640, height: 360, unknown: true },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000 },
      variants,
    )).toMatchObject({ state: "selected", choice: { height: 720 } });
  });

  it("requires a choice when an unknown estimate could outrank the known fit", async () => {
    const variants = await options([
      { id: "known", width: 1280, height: 720, bytes: 100 },
      { id: "unknown-higher-quality", width: 1920, height: 1080, unknown: true },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000 },
      variants,
    )).toMatchObject({ state: "needs_choice", reason: "unresolved_estimate" });
  });

  it("requires a choice when a potentially fitting height is unknown", async () => {
    const variants = await options([
      { id: "known", width: 1280, height: 720, bytes: 100 },
      { id: "unknown-height", width: 1920, bytes: 100 },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000, maxHeight: 1080 },
      variants,
    )).toMatchObject({ state: "needs_choice", reason: "unknown_height" });
  });

  it("never invents a pixel-area fallback when a fitting dimension is missing", async () => {
    const variants = await options([
      { id: "known", width: 1280, height: 720, bytes: 100 },
      { id: "unknown-width", height: 720, bitrate: 9_000_000, bytes: 100 },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000 },
      variants,
    )).toMatchObject({ state: "needs_choice", reason: "unknown_dimensions" });
  });

  it("does not invent a bitrate tie-break when the top area has unknown bitrate", async () => {
    const variants = await options([
      { id: "known", width: 1280, height: 720, bytes: 100 },
      { id: "unknown-bitrate", width: 1280, height: 720, unknown: true, bytes: 100 },
    ]);
    // exactBytes makes the second option cap-known while its bandwidth remains
    // unknown, exercising the bitrate-ranking boundary rather than size.
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000 },
      variants,
    )).toMatchObject({ state: "needs_choice", reason: "unknown_bitrate" });
  });

  it("excludes DRM, live, unsupported, and permanent-failure options", async () => {
    const variants = await options([
      { id: "clear", width: 640, height: 360, bytes: 100 },
      { id: "drm", width: 3840, height: 2160, bytes: 100, disabledReason: "drm" },
      { id: "live", width: 3840, height: 2160, bytes: 100, disabledReason: "live" },
      {
        id: "codec",
        width: 3840,
        height: 2160,
        bytes: 100,
        disabledReason: "unsupported_codec",
      },
      {
        id: "failed",
        width: 3840,
        height: 2160,
        bytes: 100,
        disabledReason: "permanent_download_failure",
      },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000 },
      variants,
    )).toMatchObject({ state: "selected", choice: { height: 360 } });
  });

  it("returns unsupported when no supported option remains", async () => {
    const variants = await options([
      { id: "drm", width: 1280, height: 720, bytes: 100, disabledReason: "drm" },
      { id: "live", width: 640, height: 360, bytes: 100, disabledReason: "live" },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000 },
      variants,
    )).toMatchObject({ state: "unsupported", reason: "no_supported_variants" });
  });

  it("suggests the smallest supported height-eligible option for confirmation", async () => {
    const variants = await options([
      { id: "360", width: 640, height: 360, bitrate: 500_000, bytes: 901 },
      { id: "720", width: 1280, height: 720, bitrate: 1_000_000, bytes: 902 },
      { id: "1080", width: 1920, height: 1080, bitrate: 2_000_000, bytes: 100 },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000, maxHeight: 720 },
      variants,
    )).toMatchObject({
      state: "confirmation_required",
      reason: "no_supported_variant_fits",
      suggestedChoice: { height: 360 },
      violatedConstraints: ["size_cap"],
    });
  });

  it("defines smallest confirmation option by known bytes before resolution", async () => {
    const variants = await options([
      { id: "low-resolution-large", width: 640, height: 360, bytes: 950 },
      { id: "high-resolution-small", width: 1280, height: 720, bytes: 901 },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000 },
      variants,
    )).toMatchObject({
      state: "confirmation_required",
      suggestedChoice: { height: 720, estimatedBytes: 901 },
    });
  });

  it("does not suggest an over-cap option whose height is also unknown", async () => {
    const variants = await options([
      { id: "unknown-height", width: 1280, bytes: 901 },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000, maxHeight: 720 },
      variants,
    )).toMatchObject({ state: "needs_choice", reason: "unknown_height" });
  });

  it("discloses max-height override only when every supported option exceeds it", async () => {
    const variants = await options([
      { id: "1080", width: 1920, height: 1080, bytes: 100 },
      { id: "2160", width: 3840, height: 2160, bytes: 100 },
    ]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000, maxHeight: 720 },
      variants,
    )).toMatchObject({
      state: "confirmation_required",
      suggestedChoice: { height: 1080 },
      violatedConstraints: ["max_height"],
    });
  });

  it("has no 10x bypass path for a 512 MiB cap", async () => {
    const cap = 512 * 1024 * 1024;
    const variants = await options([{
      id: "large",
      width: 1920,
      height: 1080,
      bytes: cap + 1,
    }]);
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: cap },
      variants,
    )).toMatchObject({
      state: "confirmation_required",
      suggestedChoice: { estimatedBytes: cap + 1 },
    });
    expect(parseBestUnderCapQualityPolicyV1({
      mode: "best_under_cap",
      maxEstimatedBytes: cap,
      bypassSizeCap: true,
    })).toBeUndefined();
  });

  it("does not expose an HLS source URL in a policy decision", async () => {
    const normalized = await normalizeVariantOptionsV1({
      kind: "hls",
      variants: [{
        sourceId: "https://cdn.example.test/v.m3u8?signature=secret",
        width: 1280,
        height: 720,
        bandwidth: { scope: "combined", combinedBandwidth: 1_000_000 },
        exactBytes: 100,
      }],
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const decision = selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000 },
      normalized.options,
    );
    expect(decision.state).toBe("selected");
    expect(JSON.stringify(decision)).not.toContain("cdn.example");
    expect(JSON.stringify(decision)).not.toContain("secret");
  });

  it("rejects NaN, overflow-like values, accessors, and extra policy flags", () => {
    for (const maxEstimatedBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(parseBestUnderCapQualityPolicyV1({
        mode: "best_under_cap",
        maxEstimatedBytes,
      })).toBeUndefined();
    }
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "mode", { value: "best_under_cap", enumerable: true });
    Object.defineProperty(accessor, "maxEstimatedBytes", {
      enumerable: true,
      get: () => 100,
    });
    expect(parseBestUnderCapQualityPolicyV1(accessor)).toBeUndefined();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(parseBestUnderCapQualityPolicyV1(revoked.proxy)).toBeUndefined();
    expect(() => bestUnderCapEffectiveMaximumBytesV1(Number.MAX_VALUE)).toThrow(TypeError);
  });

  it("returns invalid_input for a forged normalized option", async () => {
    const variants = await options([{ id: "valid", width: 1280, height: 720, bytes: 100 }]);
    const forged = structuredClone(variants) as Array<Record<string, unknown>>;
    forged[0].estimatedBytes = Number.NaN;
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 1_000 },
      forged,
    )).toEqual({ state: "invalid_input", reason: "invalid_variants" });
  });
});
