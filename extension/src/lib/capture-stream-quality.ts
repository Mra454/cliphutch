import {
  isPersistentStreamQualityChoiceV1,
  type PersistentStreamQualityChoiceV1,
} from "./capture-pack-types";
import { selectBestUnderCapVariantV1 } from "./quality-policy";
import {
  parseNormalizedVariantOptionsV1,
  resolveNormalizedVariantSelectorV1,
  type NormalizedVariantSelectorV1,
} from "./variant-options";

export type CaptureStreamQualityRevalidationV1 =
  | {
      ok: true;
      selector: NormalizedVariantSelectorV1;
    }
  | {
      ok: false;
      reason: "invalid_input" | "variant_stale" | "quality_policy_no_match";
    };

function manualQualityFactsMatch(
  quality: PersistentStreamQualityChoiceV1,
  option: NonNullable<ReturnType<typeof resolveNormalizedVariantSelectorV1>>,
): boolean {
  return quality.width === option.width &&
    quality.height === option.height &&
    quality.videoBandwidth === option.videoBandwidth &&
    quality.audioBandwidth === option.audioBandwidth &&
    quality.combinedBandwidth === option.combinedBandwidth &&
    quality.durationSec === option.durationSec &&
    quality.estimatedBytes === option.estimatedBytes &&
    quality.estimateConfidence === option.estimateConfidence;
}

/**
 * Resolves a frozen Capture Pack selector/policy only against a freshly
 * normalized manifest. The caller binds the returned selector to the exact
 * fresh raw manifest locator; the normalized source ID may be redacted and is
 * never treated as an executable URL.
 */
export function revalidatePersistentCaptureStreamQualityV1(
  qualityValue: unknown,
  optionsValue: unknown,
): CaptureStreamQualityRevalidationV1 {
  const options = parseNormalizedVariantOptionsV1(optionsValue);
  if (!isPersistentStreamQualityChoiceV1(qualityValue) || !options) {
    return { ok: false, reason: "invalid_input" };
  }
  const quality: PersistentStreamQualityChoiceV1 = qualityValue;
  if (options.some((option) => option.kind !== quality.selector.kind)) {
    return { ok: false, reason: "invalid_input" };
  }

  if (quality.policy.mode === "manual") {
    const selected = resolveNormalizedVariantSelectorV1(options, quality.selector);
    if (!selected?.supported || !manualQualityFactsMatch(quality, selected)) {
      return { ok: false, reason: "variant_stale" };
    }
    if (
      selected.estimatedBytes !== undefined &&
      selected.estimatedBytes > quality.maxDownloadBytes
    ) {
      return { ok: false, reason: "quality_policy_no_match" };
    }
    return {
      ok: true,
      selector: { kind: selected.selector.kind, stableId: selected.selector.stableId },
    };
  }

  const decision = selectBestUnderCapVariantV1(quality.policy, options);
  if (decision.state !== "selected") {
    return { ok: false, reason: "quality_policy_no_match" };
  }
  const selected = resolveNormalizedVariantSelectorV1(options, decision.choice.selector);
  return selected?.supported
    ? {
        ok: true,
        selector: { kind: selected.selector.kind, stableId: selected.selector.stableId },
      }
    : { ok: false, reason: "quality_policy_no_match" };
}
