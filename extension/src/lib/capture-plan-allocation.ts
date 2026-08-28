import {
  captureReviewPlanTotalsForItems,
  isCaptureReviewPlanV1,
  type CaptureReviewPlanV1,
} from "./capture-pack-types";
import { cloneCaptureReviewPlan } from "./capture-plan";

export type CapturePlanAllocationResult =
  | { ok: true; plan: CaptureReviewPlanV1; allocatedVideoItemIds: string[] }
  | {
      ok: false;
      reason:
        | "invalid_plan"
        | "invalid_allocation"
        | "allocation_limit"
        | "no_ready_items"
        | "included_item_not_ready";
      itemId?: string;
    };

/**
 * Derives the exact executable view of a reviewed plan. Free customers may
 * explicitly allocate a subset of reviewed videos; all reviewed stills remain
 * included. Licensed customers execute the full reviewed plan.
 */
export function allocateCaptureReviewPlan(input: {
  plan: CaptureReviewPlanV1;
  licensed: boolean;
  freeVideoItemIds: readonly string[];
  maxFreeVideoSlots: number;
}): CapturePlanAllocationResult {
  if (
    !isCaptureReviewPlanV1(input.plan) ||
    typeof input.licensed !== "boolean" ||
    !Array.isArray(input.freeVideoItemIds) ||
    !Number.isSafeInteger(input.maxFreeVideoSlots) ||
    input.maxFreeVideoSlots < 0
  ) {
    return { ok: false, reason: "invalid_plan" };
  }
  const allocation = [...input.freeVideoItemIds];
  if (
    (!input.licensed && allocation.length > input.maxFreeVideoSlots) ||
    new Set(allocation).size !== allocation.length ||
    allocation.some((itemId) => typeof itemId !== "string" || itemId.length === 0)
  ) {
    return {
      ok: false,
      reason: !input.licensed && allocation.length > input.maxFreeVideoSlots
        ? "allocation_limit"
        : "invalid_allocation",
    };
  }
  const reviewedVideos = new Set(
    input.plan.items
      .filter((item) => item.include && item.media.kind !== "image")
      .map((item) => item.itemId),
  );
  if (allocation.some((itemId) => !reviewedVideos.has(itemId))) {
    return { ok: false, reason: "invalid_allocation" };
  }

  const allocated = new Set(allocation);
  const plan = cloneCaptureReviewPlan(input.plan);
  if (!input.licensed) {
    plan.items = plan.items.map((item) => ({
      ...item,
      include: item.include && (item.media.kind === "image" || allocated.has(item.itemId)),
    }));
  }
  const included = plan.items.filter((item) => item.include);
  if (included.length === 0) return { ok: false, reason: "no_ready_items" };
  const unready = included.find((item) => item.readiness !== "ready");
  if (unready) {
    return { ok: false, reason: "included_item_not_ready", itemId: unready.itemId };
  }
  const totals = captureReviewPlanTotalsForItems(plan.items);
  if (!totals) return { ok: false, reason: "invalid_plan" };
  plan.totals = totals;
  if (!isCaptureReviewPlanV1(plan)) return { ok: false, reason: "invalid_plan" };
  return {
    ok: true,
    plan,
    allocatedVideoItemIds: input.licensed
      ? plan.items.filter((item) => item.include && item.media.kind !== "image").map((item) => item.itemId)
      : allocation,
  };
}
