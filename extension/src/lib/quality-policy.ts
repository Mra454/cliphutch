import {
  MAX_VARIANT_DIMENSION,
  parseNormalizedVariantOptionsV1,
  type NormalizedVariantSelectorV1,
  type NormalizedVariantV1,
} from "./variant-options";

export const BEST_UNDER_CAP_SAFETY_PERCENT = 10;

export type BestUnderCapQualityPolicyV1 = {
  mode: "best_under_cap";
  maxEstimatedBytes: number;
  maxHeight?: number;
};

/** A persistence/UI-safe choice summary. It intentionally has no source URL. */
export type QualityPolicyVariantChoiceV1 = {
  selector: NormalizedVariantSelectorV1;
  stableId: string;
  width?: number;
  height?: number;
  codecs?: string;
  container?: string;
  videoBandwidth?: number;
  audioBandwidth?: number;
  combinedBandwidth?: number;
  durationSec?: number;
  estimatedBytes?: number;
  estimateConfidence: "exact" | "estimated" | "unknown";
};

type DecisionContextV1 = {
  policy: BestUnderCapQualityPolicyV1;
  /** floor(configured cap * 0.9), computed without an overflowing multiply. */
  effectiveMaxEstimatedBytes: number;
};

export type BestUnderCapDecisionV1 =
  | (DecisionContextV1 & {
      state: "selected";
      choice: QualityPolicyVariantChoiceV1;
    })
  | (DecisionContextV1 & {
      state: "needs_choice";
      reason:
        | "all_estimates_unknown"
        | "unresolved_estimate"
        | "unknown_height"
        | "unknown_dimensions"
        | "unknown_bitrate";
    })
  | (DecisionContextV1 & {
      state: "confirmation_required";
      reason: "no_supported_variant_fits";
      suggestedChoice: QualityPolicyVariantChoiceV1;
      violatedConstraints: Array<"size_cap" | "max_height">;
    })
  | (DecisionContextV1 & {
      state: "unsupported";
      reason: "no_supported_variants";
    })
  | {
      state: "invalid_input";
      reason: "invalid_policy" | "invalid_variants";
    };

type DataRecord = Record<string, unknown>;

function exactDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): DataRecord | undefined {
  if (value === null || typeof value !== "object") return undefined;
  try {
    if (Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
      requiredKeys.some((key) => !keys.includes(key))
    ) {
      return undefined;
    }
    const copy = Object.create(null) as DataRecord;
    for (const key of keys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return undefined;
  }
}

/** Strict policy guard that also returns a detached canonical clone. */
export function parseBestUnderCapQualityPolicyV1(
  value: unknown,
): BestUnderCapQualityPolicyV1 | undefined {
  const record = exactDataRecord(
    value,
    ["mode", "maxEstimatedBytes", "maxHeight"],
    ["mode", "maxEstimatedBytes"],
  );
  if (
    !record ||
    record.mode !== "best_under_cap" ||
    typeof record.maxEstimatedBytes !== "number" ||
    !Number.isSafeInteger(record.maxEstimatedBytes) ||
    record.maxEstimatedBytes <= 0 ||
    (record.maxHeight !== undefined &&
      (typeof record.maxHeight !== "number" ||
        !Number.isSafeInteger(record.maxHeight) ||
        record.maxHeight <= 0 ||
        record.maxHeight > MAX_VARIANT_DIMENSION))
  ) {
    return undefined;
  }
  return {
    mode: "best_under_cap",
    maxEstimatedBytes: record.maxEstimatedBytes,
    ...(record.maxHeight === undefined ? {} : { maxHeight: record.maxHeight }),
  };
}

/** Exactly 10% headroom. For integer byte caps this is floor(cap * 0.9). */
export function bestUnderCapEffectiveMaximumBytesV1(maxEstimatedBytes: number): number {
  if (!Number.isSafeInteger(maxEstimatedBytes) || maxEstimatedBytes <= 0) {
    throw new TypeError("A positive safe-integer byte cap is required.");
  }
  // max - ceil(max / 10) is floor(max * 9 / 10), without a potentially
  // unsafe `max * 9` intermediate near Number.MAX_SAFE_INTEGER.
  return maxEstimatedBytes - Math.ceil(maxEstimatedBytes / 10);
}

function choiceFor(variant: NormalizedVariantV1): QualityPolicyVariantChoiceV1 {
  const selector: NormalizedVariantSelectorV1 = variant.kind === "hls"
    ? { kind: "hls", stableId: variant.stableId }
    : { kind: "dash", stableId: variant.stableId };
  return {
    selector,
    stableId: variant.stableId,
    ...(variant.width === undefined ? {} : { width: variant.width }),
    ...(variant.height === undefined ? {} : { height: variant.height }),
    ...(variant.codecs === undefined ? {} : { codecs: variant.codecs }),
    ...(variant.container === undefined ? {} : { container: variant.container }),
    ...(variant.videoBandwidth === undefined
      ? {}
      : { videoBandwidth: variant.videoBandwidth }),
    ...(variant.audioBandwidth === undefined
      ? {}
      : { audioBandwidth: variant.audioBandwidth }),
    ...(variant.combinedBandwidth === undefined
      ? {}
      : { combinedBandwidth: variant.combinedBandwidth }),
    ...(variant.durationSec === undefined ? {} : { durationSec: variant.durationSec }),
    ...(variant.estimatedBytes === undefined
      ? {}
      : { estimatedBytes: variant.estimatedBytes }),
    estimateConfidence: variant.estimateConfidence,
  };
}

function pixelArea(variant: NormalizedVariantV1): number {
  return variant.width !== undefined && variant.height !== undefined
    ? variant.width * variant.height
    : 0;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Highest pixel area, then combined bitrate, then ASCII-stable ID. */
function compareBest(left: NormalizedVariantV1, right: NormalizedVariantV1): number {
  const areaDifference = pixelArea(right) - pixelArea(left);
  if (areaDifference !== 0) return areaDifference;
  const bitrateDifference =
    (right.combinedBandwidth ?? 0) - (left.combinedBandwidth ?? 0);
  return bitrateDifference !== 0
    ? bitrateDifference
    : lexicalCompare(left.stableId, right.stableId);
}

/** Smallest known bytes, then inverse quality, for the confirmation hint. */
function compareSmallest(left: NormalizedVariantV1, right: NormalizedVariantV1): number {
  const byteDifference =
    (left.estimatedBytes ?? Number.MAX_SAFE_INTEGER) -
    (right.estimatedBytes ?? Number.MAX_SAFE_INTEGER);
  if (byteDifference !== 0) return byteDifference;
  const areaDifference = pixelArea(left) - pixelArea(right);
  if (areaDifference !== 0) return areaDifference;
  const bitrateDifference =
    (left.combinedBandwidth ?? 0) - (right.combinedBandwidth ?? 0);
  return bitrateDifference !== 0
    ? bitrateDifference
    : lexicalCompare(left.stableId, right.stableId);
}

/**
 * Applies the disclosed automatic rule. Unknown estimates are never treated
 * as fitting; no flag or parameter exists for the legacy 10x bypass.
 */
export function selectBestUnderCapVariantV1(
  policyValue: unknown,
  variantsValue: unknown,
): BestUnderCapDecisionV1 {
  const policy = parseBestUnderCapQualityPolicyV1(policyValue);
  if (!policy) return { state: "invalid_input", reason: "invalid_policy" };
  const variants = parseNormalizedVariantOptionsV1(variantsValue);
  if (!variants) return { state: "invalid_input", reason: "invalid_variants" };

  const effectiveMaxEstimatedBytes = bestUnderCapEffectiveMaximumBytesV1(
    policy.maxEstimatedBytes,
  );
  const context: DecisionContextV1 = { policy, effectiveMaxEstimatedBytes };
  const supported = variants.filter((variant) => variant.supported);
  if (supported.length === 0) {
    return { ...context, state: "unsupported", reason: "no_supported_variants" };
  }
  if (supported.every((variant) => variant.estimateConfidence === "unknown")) {
    return { ...context, state: "needs_choice", reason: "all_estimates_unknown" };
  }

  const heightEligible = supported.filter((variant) => (
    policy.maxHeight === undefined ||
    (variant.height !== undefined && variant.height <= policy.maxHeight)
  ));
  const unknownHeight = policy.maxHeight === undefined
    ? []
    : supported.filter((variant) => variant.height === undefined);
  const heightUnknownCouldFit = policy.maxHeight === undefined
    ? []
    : supported.filter((variant) => (
        variant.height === undefined &&
        (variant.estimateConfidence === "unknown" ||
          (variant.estimatedBytes !== undefined &&
            variant.estimatedBytes <= effectiveMaxEstimatedBytes))
      ));
  const fitting = heightEligible.filter((variant) => (
    variant.estimateConfidence !== "unknown" &&
    variant.estimatedBytes !== undefined &&
    variant.estimatedBytes <= effectiveMaxEstimatedBytes
  ));
  if (fitting.length > 0) {
    if (heightUnknownCouldFit.length > 0) {
      return { ...context, state: "needs_choice", reason: "unknown_height" };
    }
    if (fitting.some((variant) => pixelArea(variant) === 0)) {
      return { ...context, state: "needs_choice", reason: "unknown_dimensions" };
    }
    const greatestArea = Math.max(...fitting.map(pixelArea));
    const greatestAreaGroup = fitting.filter((variant) => pixelArea(variant) === greatestArea);
    if (
      greatestAreaGroup.length > 1 &&
      greatestAreaGroup.some((variant) => variant.combinedBandwidth === undefined)
    ) {
      return { ...context, state: "needs_choice", reason: "unknown_bitrate" };
    }
    const selected = [...fitting].sort(compareBest)[0];
    for (const unresolved of heightEligible.filter(
      (variant) => variant.estimateConfidence === "unknown",
    )) {
      const area = pixelArea(unresolved);
      const selectedArea = pixelArea(selected);
      if (area === 0) {
        return { ...context, state: "needs_choice", reason: "unknown_dimensions" };
      }
      if (area > selectedArea) {
        return { ...context, state: "needs_choice", reason: "unresolved_estimate" };
      }
      if (area === selectedArea) {
        if (
          unresolved.combinedBandwidth === undefined ||
          selected.combinedBandwidth === undefined
        ) {
          return { ...context, state: "needs_choice", reason: "unknown_bitrate" };
        }
        if (
          unresolved.combinedBandwidth > selected.combinedBandwidth ||
          (unresolved.combinedBandwidth === selected.combinedBandwidth &&
            unresolved.stableId < selected.stableId)
        ) {
          return { ...context, state: "needs_choice", reason: "unresolved_estimate" };
        }
      }
    }
    return { ...context, state: "selected", choice: choiceFor(selected) };
  }

  if (heightUnknownCouldFit.length > 0) {
    return { ...context, state: "needs_choice", reason: "unknown_height" };
  }
  if (heightEligible.some((variant) => variant.estimateConfidence === "unknown")) {
    return { ...context, state: "needs_choice", reason: "unresolved_estimate" };
  }
  if (heightEligible.length === 0 && unknownHeight.length > 0) {
    return { ...context, state: "needs_choice", reason: "unknown_height" };
  }

  // Prefer a suggestion that honors maxHeight. Only when every supported
  // option is known to exceed it do we disclose that explicit override.
  const suggestionPool = heightEligible.length > 0 ? heightEligible : supported;
  const suggested = [...suggestionPool].sort(compareSmallest)[0];
  const violatedConstraints: Array<"size_cap" | "max_height"> = [];
  if (
    suggested.estimatedBytes !== undefined &&
    suggested.estimatedBytes > effectiveMaxEstimatedBytes
  ) {
    violatedConstraints.push("size_cap");
  }
  if (
    policy.maxHeight !== undefined &&
    suggested.height !== undefined &&
    suggested.height > policy.maxHeight
  ) {
    violatedConstraints.push("max_height");
  }
  return {
    ...context,
    state: "confirmation_required",
    reason: "no_supported_variant_fits",
    suggestedChoice: choiceFor(suggested),
    violatedConstraints,
  };
}
