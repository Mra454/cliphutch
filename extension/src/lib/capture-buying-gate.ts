import {
  isCaptureReviewPlanV1,
  MAX_CAPTURE_PLAN_ITEMS,
  type CapturePlanItemV1,
  type CaptureReviewPlanV1,
} from "./capture-pack-types";

const MAX_ITEM_ID_LENGTH = 256;
const MAX_PASSIVE_NODES = 100_000;
const MAX_PASSIVE_ARRAY_LENGTH = 20_000;
const MAX_PASSIVE_OBJECT_KEYS = 1_000;
const MAX_PASSIVE_STRING_UNITS = 16 * 1024 * 1024;

export type CapturePackBuyingGateBlockingReason =
  | "unready_item"
  | "invalid_allocation"
  | "duplicate_allocation"
  | "non_video_allocation"
  | "over_allowance"
  | "no_items";

export type CapturePackBuyingGateInput = {
  plan: CaptureReviewPlanV1;
  licensed: boolean;
  remainingVideoSlots: number;
  selectedFreeVideoItemIds: readonly string[];
};

/**
 * Canonical, display-safe entitlement and allocation facts for Capture Review.
 * Every ID array follows plan order, regardless of selection click order.
 */
export type CapturePackBuyingGateModel = Readonly<{
  licensed: boolean;
  includedItemIds: readonly string[];
  videoItemIds: readonly string[];
  stillItemIds: readonly string[];
  readyVideoItemIds: readonly string[];
  unreadyItemIds: readonly string[];
  includedCount: number;
  videoCount: number;
  stillCount: number;
  readyVideoCount: number;
  unreadyCount: number;
  remainingVideoSlots: number;
  maxSelectableFreeVideoCount: number;
  completePackVideoShortfall: number;
  requestedFreeVideoSelectionCount: number;
  selectedFreeVideoItemIds: readonly string[];
  selectedFreeVideoCount: number;
  selectionIsAllowed: boolean;
  saveItemIds: readonly string[];
  saveItemCount: number;
  saveVideoCount: number;
  saveStillCount: number;
  omittedVideoCount: number;
  isCompleteAllocation: boolean;
  needsUpgradeGate: boolean;
  canSubmit: boolean;
  blockingReason: CapturePackBuyingGateBlockingReason | null;
}>;

export type CapturePackBuyingGateResult =
  | Readonly<{ ok: true; model: CapturePackBuyingGateModel }>
  | Readonly<{ ok: false; reason: "invalid_input" }>;

type DataRecord = Record<string, unknown>;

function exactDataRecord(value: unknown, keys: readonly string[]): DataRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
      return undefined;
    }
    const result = Object.create(null) as DataRecord;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

/** Reject active objects, cycles, sparse arrays, and oversized graphs before cloning. */
function clonePassive(value: unknown): unknown | undefined {
  const states = new WeakMap<object, "visiting" | "done">();
  let nodes = 0;
  let stringUnits = 0;

  const visit = (candidate: unknown): boolean => {
    if (typeof candidate === "string") {
      stringUnits += candidate.length;
      return stringUnits <= MAX_PASSIVE_STRING_UNITS;
    }
    if (
      candidate === null ||
      typeof candidate === "number" ||
      typeof candidate === "boolean" ||
      candidate === undefined
    ) {
      return true;
    }
    if (typeof candidate !== "object" || ++nodes > MAX_PASSIVE_NODES) return false;

    const object = candidate as object;
    const state = states.get(object);
    if (state === "visiting") return false;
    if (state === "done") return true;
    states.set(object, "visiting");

    const isArray = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (
      isArray
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) {
      return false;
    }

    const ownKeys = Reflect.ownKeys(object);
    if (ownKeys.some((key) => typeof key !== "string")) return false;
    if (isArray) {
      const array = object as unknown[];
      if (array.length > MAX_PASSIVE_ARRAY_LENGTH || ownKeys.length !== array.length + 1) {
        return false;
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(object, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.value !== array.length) {
        return false;
      }
      for (let index = 0; index < array.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
        if (!descriptor || !("value" in descriptor) || !visit(descriptor.value)) return false;
      }
      states.set(object, "done");
      return true;
    }

    if (ownKeys.length > MAX_PASSIVE_OBJECT_KEYS) return false;
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor) || !visit(descriptor.value)) return false;
    }
    states.set(object, "done");
    return true;
  };

  try {
    if (!visit(value)) return undefined;
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

function parseSelectedItemIds(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    if (value.length > MAX_CAPTURE_PLAN_ITEMS) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
      return undefined;
    }
    const result: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        descriptor.value.length === 0 ||
        descriptor.value.length > MAX_ITEM_ID_LENGTH
      ) {
        return undefined;
      }
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

function frozenIds(items: readonly CapturePlanItemV1[]): readonly string[] {
  return Object.freeze(items.map((item) => item.itemId));
}

function buildModel(input: unknown): CapturePackBuyingGateResult {
  const record = exactDataRecord(input, [
    "plan",
    "licensed",
    "remainingVideoSlots",
    "selectedFreeVideoItemIds",
  ]);
  if (
    !record ||
    typeof record.licensed !== "boolean" ||
    typeof record.remainingVideoSlots !== "number" ||
    !Number.isSafeInteger(record.remainingVideoSlots) ||
    record.remainingVideoSlots < 0
  ) {
    return Object.freeze({ ok: false, reason: "invalid_input" });
  }

  const requestedIds = parseSelectedItemIds(record.selectedFreeVideoItemIds);
  const clonedPlan = clonePassive(record.plan);
  if (!requestedIds || !isCaptureReviewPlanV1(clonedPlan)) {
    return Object.freeze({ ok: false, reason: "invalid_input" });
  }

  const plan = clonedPlan;
  const licensed = record.licensed;
  const remainingVideoSlots = record.remainingVideoSlots;
  const includedItems = plan.items.filter((item) => item.include);
  const videoItems = includedItems.filter((item) => item.media.kind !== "image");
  const stillItems = includedItems.filter((item) => item.media.kind === "image");
  const readyVideoItems = videoItems.filter((item) => item.readiness === "ready");
  const unreadyItems = includedItems.filter((item) => item.readiness !== "ready");
  const includedById = new Map(includedItems.map((item) => [item.itemId, item]));
  const requestedSet = new Set(requestedIds);

  const duplicateAllocation = requestedSet.size !== requestedIds.length;
  const nonVideoAllocation = requestedIds.some(
    (itemId) => includedById.get(itemId)?.media.kind === "image",
  );
  const invalidAllocation = licensed
    ? requestedIds.length > 0
    : requestedIds.some((itemId) => !includedById.has(itemId));
  const overAllowance = !licensed && requestedIds.length > remainingVideoSlots;
  const selectedUnreadyVideo = !licensed && requestedIds.some((itemId) => {
    const item = includedById.get(itemId);
    return Boolean(item && item.media.kind !== "image" && item.readiness !== "ready");
  });

  const selectedVideoItems = licensed
    ? []
    : readyVideoItems.filter((item) => requestedSet.has(item.itemId));
  const selectedReadyVideoIds = new Set(selectedVideoItems.map((item) => item.itemId));
  const saveItems = licensed
    ? includedItems
    : includedItems.filter(
        (item) => item.media.kind === "image" || selectedReadyVideoIds.has(item.itemId),
      );
  const saveVideoCount = saveItems.filter((item) => item.media.kind !== "image").length;
  const saveStillCount = saveItems.length - saveVideoCount;

  let selectionIssue: CapturePackBuyingGateBlockingReason | null = null;
  if (duplicateAllocation) selectionIssue = "duplicate_allocation";
  else if (invalidAllocation) selectionIssue = "invalid_allocation";
  else if (nonVideoAllocation) selectionIssue = "non_video_allocation";
  else if (overAllowance) selectionIssue = "over_allowance";

  const blockingReason = selectionIssue ??
    (unreadyItems.length > 0
      ? "unready_item"
      : saveItems.length === 0
        ? "no_items"
        : null);
  const completePackVideoShortfall = licensed
    ? 0
    : Math.max(0, videoItems.length - remainingVideoSlots);

  const model: CapturePackBuyingGateModel = Object.freeze({
    licensed,
    includedItemIds: frozenIds(includedItems),
    videoItemIds: frozenIds(videoItems),
    stillItemIds: frozenIds(stillItems),
    readyVideoItemIds: frozenIds(readyVideoItems),
    unreadyItemIds: frozenIds(unreadyItems),
    includedCount: includedItems.length,
    videoCount: videoItems.length,
    stillCount: stillItems.length,
    readyVideoCount: readyVideoItems.length,
    unreadyCount: unreadyItems.length,
    remainingVideoSlots,
    maxSelectableFreeVideoCount: licensed
      ? 0
      : Math.min(readyVideoItems.length, remainingVideoSlots),
    completePackVideoShortfall,
    requestedFreeVideoSelectionCount: requestedIds.length,
    selectedFreeVideoItemIds: frozenIds(selectedVideoItems),
    selectedFreeVideoCount: selectedVideoItems.length,
    selectionIsAllowed: selectionIssue === null && !selectedUnreadyVideo,
    saveItemIds: frozenIds(saveItems),
    saveItemCount: saveItems.length,
    saveVideoCount,
    saveStillCount,
    omittedVideoCount: videoItems.length - saveVideoCount,
    isCompleteAllocation: includedItems.length > 0 && saveItems.length === includedItems.length,
    needsUpgradeGate: !licensed && completePackVideoShortfall > 0,
    canSubmit: blockingReason === null,
    blockingReason,
  });
  return Object.freeze({ ok: true, model });
}

/**
 * Returns allocation/customer-copy facts without mutating or trusting the plan.
 * Hostile or structurally invalid input always becomes `invalid_input`.
 */
export function createCapturePackBuyingGateModel(
  input: CapturePackBuyingGateInput,
): CapturePackBuyingGateResult;
export function createCapturePackBuyingGateModel(input: unknown): CapturePackBuyingGateResult;
export function createCapturePackBuyingGateModel(input: unknown): CapturePackBuyingGateResult {
  try {
    return buildModel(input);
  } catch {
    return Object.freeze({ ok: false, reason: "invalid_input" });
  }
}
