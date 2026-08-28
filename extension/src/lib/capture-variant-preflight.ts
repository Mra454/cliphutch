import {
  isPersistentStreamQualityChoiceV1,
  type PersistentStreamQualityChoiceV1,
  type QualityPolicyV1,
} from "./capture-pack-types";
import type { CaptureVariantOptionV1 } from "./capture-review-messages";
import {
  parseNormalizedVariantOptionsV1,
  type NormalizedVariantKindV1,
  type NormalizedVariantV1,
} from "./variant-options";
import { selectBestUnderCapVariantV1 } from "./quality-policy";

export const MAX_CAPTURE_VARIANT_OPTIONS = 100;
export const MAX_CAPTURE_REVIEW_VARIANT_OPTIONS = 200;

export type CaptureVariantOptionBudgetResult<T> = {
  groups: T[][];
  overflowGroupIndexes: number[];
};

/** Deterministically keeps whole item groups within the review's global cap. */
export function applyCaptureVariantOptionBudget<T>(
  rawGroups: readonly (readonly T[])[],
): CaptureVariantOptionBudgetResult<T> {
  if (!Array.isArray(rawGroups) || rawGroups.length > 200) {
    throw new TypeError("Variant option groups are invalid.");
  }
  let remaining = MAX_CAPTURE_REVIEW_VARIANT_OPTIONS;
  const groups: T[][] = [];
  const overflowGroupIndexes: number[] = [];
  for (let index = 0; index < rawGroups.length; index += 1) {
    const group = rawGroups[index];
    if (!Array.isArray(group) || group.length > MAX_CAPTURE_VARIANT_OPTIONS) {
      throw new TypeError("A stream exposes too many variant options.");
    }
    if (group.length > remaining) {
      groups.push([]);
      overflowGroupIndexes.push(index);
      continue;
    }
    groups.push([...group]);
    remaining -= group.length;
  }
  return { groups, overflowGroupIndexes };
}

export type CaptureVariantPreflightEntryV1 = {
  /** Background-only normalized record. It is never returned to the UI. */
  normalizedOption: NormalizedVariantV1;
  publicOption: CaptureVariantOptionV1;
  /** Absent when the option is unsupported or exceeds the frozen hard cap. */
  manualQualityChoice?: PersistentStreamQualityChoiceV1;
};

export type CaptureVariantPreflightResultV1 =
  | { ok: true; entries: CaptureVariantPreflightEntryV1[] }
  | {
      ok: false;
      code: "invalid_input" | "no_variants" | "identifier_failure";
      customerMessage: string;
    };

const SAFE_ID = /^[a-z0-9._:-]+$/i;

function safeItemId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && SAFE_ID.test(value);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bitrateLabel(bitsPerSecond: number | undefined): string | undefined {
  if (bitsPerSecond === undefined) return undefined;
  const megabits = bitsPerSecond / 1_000_000;
  return `${megabits.toFixed(megabits >= 10 ? 0 : 1)} Mbps`;
}

function optionLabel(variant: NormalizedVariantV1, index: number): string {
  const dimensions = variant.width && variant.height
    ? `${variant.width}×${variant.height}`
    : variant.height
      ? `${variant.height}p`
      : undefined;
  return [dimensions, bitrateLabel(variant.combinedBandwidth)]
    .filter(Boolean)
    .join(" • ") || `Quality ${index + 1}`;
}

function choiceMetadata(variant: NormalizedVariantV1) {
  return {
    ...(variant.width === undefined ? {} : { width: variant.width }),
    ...(variant.height === undefined ? {} : { height: variant.height }),
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

/**
 * Freezes one freshly normalized option as a persistence-safe plan choice.
 * It intentionally copies no source URL or raw DASH Representation identifier.
 */
export function buildPersistentCaptureStreamChoice(input: {
  option: NormalizedVariantV1;
  policy: QualityPolicyV1;
  maxDownloadBytes: number;
  label?: string;
}): PersistentStreamQualityChoiceV1 | undefined {
  const choice: PersistentStreamQualityChoiceV1 = {
    mode: "stream",
    policy: input.policy.mode === "manual"
      ? { mode: "manual" }
      : {
          mode: "best_under_cap",
          maxEstimatedBytes: input.policy.maxEstimatedBytes,
          ...(input.policy.maxHeight === undefined
            ? {}
            : { maxHeight: input.policy.maxHeight }),
        },
    selector: {
      kind: input.option.selector.kind,
      stableId: input.option.selector.stableId,
    },
    maxDownloadBytes: input.maxDownloadBytes,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...choiceMetadata(input.option),
  };
  return input.option.supported && isPersistentStreamQualityChoiceV1(choice)
    ? choice
    : undefined;
}

/**
 * Converts normalized manifest results into redacted UI options and manual
 * persistent choices. Signed locators remain only in the background-owned
 * normalized record and are never copied into a plan, job, or UI response.
 */
export async function buildCaptureVariantPreflight(input: {
  itemId: string;
  kind: NormalizedVariantKindV1;
  variants: unknown;
  maxDownloadBytes: number;
}): Promise<CaptureVariantPreflightResultV1> {
  const variants = parseNormalizedVariantOptionsV1(input.variants);
  if (
    !safeItemId(input.itemId) ||
    (input.kind !== "hls" && input.kind !== "dash") ||
    !variants ||
    variants.length > MAX_CAPTURE_VARIANT_OPTIONS ||
    !Number.isSafeInteger(input.maxDownloadBytes) ||
    input.maxDownloadBytes <= 0 ||
    variants.some((variant) => variant.kind !== input.kind)
  ) {
    return {
      ok: false,
      code: "invalid_input",
      customerMessage: "ClipHutch received invalid stream quality information.",
    };
  }
  if (variants.length === 0) {
    return {
      ok: false,
      code: "no_variants",
      customerMessage: "No downloadable quality was found for this stream.",
    };
  }

  try {
    const entries = await Promise.all(variants.map(async (variant, index) => {
      const digest = await sha256Hex(
        `${input.itemId}\u0000${input.kind}\u0000${variant.stableId}`,
      );
      const optionId = `capture-option-v1-${digest.slice(0, 40)}`;
      const knownOverCap = variant.estimatedBytes !== undefined &&
        variant.estimatedBytes > input.maxDownloadBytes;
      const supported = variant.supported && !knownOverCap;
      const label = optionLabel(variant, index);
      const publicOption: CaptureVariantOptionV1 = {
        itemId: input.itemId,
        optionId,
        kind: input.kind,
        label,
        ...choiceMetadata(variant),
        supported,
        ...(supported
          ? {}
          : { disabledReason: knownOverCap ? "over_size_cap" as const : variant.disabledReason! }),
      };
      const manualQualityChoice = supported
        ? buildPersistentCaptureStreamChoice({
            option: variant,
            policy: { mode: "manual" },
            maxDownloadBytes: input.maxDownloadBytes,
            label,
          })
        : undefined;
      return {
        normalizedOption: variant,
        publicOption,
        ...(manualQualityChoice === undefined ? {} : { manualQualityChoice }),
      };
    }));
    if (new Set(entries.map((entry) => entry.publicOption.optionId)).size !== entries.length) {
      return {
        ok: false,
        code: "identifier_failure" as const,
        customerMessage: "ClipHutch could not safely identify the available qualities.",
      };
    }
    return { ok: true, entries };
  } catch {
    return {
      ok: false,
      code: "identifier_failure",
      customerMessage: "ClipHutch could not safely identify the available qualities.",
    };
  }
}

export function resolveCaptureVariantOption(
  entries: readonly CaptureVariantPreflightEntryV1[],
  optionId: string | undefined,
): CaptureVariantPreflightEntryV1 | undefined {
  if (typeof optionId !== "string") return undefined;
  return entries.find((entry) => entry.publicOption.optionId === optionId);
}

export type CaptureReviewVariantSelectionV1 =
  | {
      state: "selected";
      qualityChoice: PersistentStreamQualityChoiceV1;
      selectedStableId: string;
      automatic: boolean;
    }
  | {
      state: "needs_choice";
      reason:
        | "manual_selection_required"
        | "all_estimates_unknown"
        | "unresolved_estimate"
        | "unknown_height"
        | "unknown_dimensions"
        | "unknown_bitrate"
        | "confirmation_required";
      /** Redacted stable identity; the background maps it to its own public option. */
      suggestedStableId?: string;
      suggestionScope?: "smallest" | "smallest_within_height" | "smallest_exceeds_height";
    }
  | { state: "unsupported" }
  | { state: "stale_choice" }
  | { state: "invalid_input" };

/** Applies an explicit manual override or the frozen automatic Review rule. */
export function selectCaptureReviewVariantV1(input: {
  entries: readonly CaptureVariantPreflightEntryV1[];
  requestedOptionId?: string;
  policy: QualityPolicyV1;
  maxDownloadBytes: number;
}): CaptureReviewVariantSelectionV1 {
  if (
    !Array.isArray(input.entries) ||
    !Number.isSafeInteger(input.maxDownloadBytes) ||
    input.maxDownloadBytes <= 0
  ) return { state: "invalid_input" };
  if (input.requestedOptionId !== undefined) {
    const requested = resolveCaptureVariantOption(input.entries, input.requestedOptionId);
    return requested?.manualQualityChoice
      ? {
          state: "selected",
          qualityChoice: requested.manualQualityChoice,
          selectedStableId: requested.normalizedOption.stableId,
          automatic: false,
        }
      : { state: "stale_choice" };
  }
  if (input.policy.mode === "manual") {
    return { state: "needs_choice", reason: "manual_selection_required" };
  }
  const decision = selectBestUnderCapVariantV1(
    input.policy,
    // An option above the immutable runtime hard cap has no executable manual
    // choice and must not become the policy engine's confirmation suggestion.
    input.entries.flatMap((entry) =>
      entry.manualQualityChoice === undefined ? [] : [entry.normalizedOption]
    ),
  );
  if (decision.state === "unsupported") return { state: "unsupported" };
  if (decision.state === "confirmation_required") {
    return {
      state: "needs_choice",
      reason: "confirmation_required",
      suggestedStableId: decision.suggestedChoice.stableId,
      suggestionScope: input.policy.maxHeight === undefined
        ? "smallest"
        : decision.violatedConstraints.includes("max_height")
          ? "smallest_exceeds_height"
          : "smallest_within_height",
    };
  }
  if (decision.state === "needs_choice") {
    return { state: "needs_choice", reason: decision.reason };
  }
  if (decision.state !== "selected") return { state: "invalid_input" };
  const selected = input.entries.find(
    (entry) => entry.normalizedOption.stableId === decision.choice.stableId,
  );
  if (!selected) return { state: "invalid_input" };
  const qualityChoice = buildPersistentCaptureStreamChoice({
    option: selected.normalizedOption,
    policy: input.policy,
    maxDownloadBytes: input.maxDownloadBytes,
  });
  return qualityChoice
    ? {
        state: "selected",
        qualityChoice,
        selectedStableId: selected.normalizedOption.stableId,
        automatic: true,
      }
    : { state: "invalid_input" };
}
