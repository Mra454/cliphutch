/**
 * Background-owned plan-command journal retained with recent plans.
 * Public options are redacted; the exact immutable session plan is retained so
 * an ambiguous multi-key plan write can be repaired without another fetch.
 */
import type {
  CapturePlanChoiceSelectorV1,
  CaptureVariantOptionV1,
} from "./capture-review-messages";
import {
  isCaptureReviewPlanV1,
  type CaptureReviewPlanV1,
} from "./capture-pack-types";
import { cloneCaptureReviewPlan } from "./capture-plan";
import { withKeyLock } from "./session-jobs";

export const CAPTURE_PLAN_OPTIONS_STORAGE_KEY = "capture-plan-options-v1";
export const MAX_CAPTURE_PLAN_OPTION_RECORDS = 6;
export const MAX_CAPTURE_PLAN_OPTIONS_BYTES = 2 * 1024 * 1024;
export const MAX_CAPTURE_HEADER_LEASE_IDS = 200;

/** Background-only lease bindings. This map is never part of public variant options. */
export type CaptureHeaderLeaseIdsByItemId = Readonly<Record<string, string>>;

export type CapturePlanOptionsRecordV1 = {
  schemaVersion: 1;
  planId: string;
  commandId: string;
  draftId: string;
  draftRevision: number;
  choices: CapturePlanChoiceSelectorV1[];
  options: CaptureVariantOptionV1[];
  /**
   * Exact lease snapshot selected for this plan. Optional only so an in-flight
   * pre-C2 caller/storage record canonicalizes to the equivalent empty map.
   */
  headerLeaseIdsByItemId?: CaptureHeaderLeaseIdsByItemId;
  /** Exact immutable plan used to repair an ambiguous two-key plan commit. */
  plan: CaptureReviewPlanV1;
  state: "prepared" | "committed";
  createdAt: number;
};

type CapturePlanOptionsIndexV1 = {
  schemaVersion: 1;
  orderedPlanIds: string[];
  records: Record<string, CapturePlanOptionsRecordV1>;
};

export type CapturePlanOptionsResult =
  | { ok: true; record: CapturePlanOptionsRecordV1 | null }
  | { ok: false; reason: "invalid_input" | "storage_corrupt" | "storage_unavailable" | "size_limit" };

export type ClearCapturePlanOptionsResult =
  | { ok: true; removedPlanIds: string[]; preservedPlanIds: string[] }
  | { ok: false; reason: "invalid_input" | "storage_corrupt" | "storage_unavailable" };

const SAFE_ID = /^[a-z0-9._:-]+$/i;
const OPTION_ID = /^capture-option-v1-[0-9a-f]{40}$/;

function safeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && SAFE_ID.test(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Strictly clones a lease map in authoritative plan order. Only included,
 * ready items may own a lease, so excluded/stale/unknown keys cannot be
 * smuggled into a later execution request.
 */
export function canonicalizeCaptureHeaderLeaseIdsByItemId(
  plan: CaptureReviewPlanV1,
  value: unknown = {},
): CaptureHeaderLeaseIdsByItemId | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length > MAX_CAPTURE_HEADER_LEASE_IDS ||
      ownKeys.some((key) => typeof key !== "string" || !safeId(key))
    ) return undefined;

    const raw = value as Record<string, unknown>;
    const valuesByItemId = new Map<string, string>();
    const seenLeaseIds = new Set<string>();
    for (const rawKey of ownKeys) {
      const itemId = rawKey as string;
      const descriptor = Object.getOwnPropertyDescriptor(raw, itemId);
      if (
        !descriptor || !("value" in descriptor) || !descriptor.enumerable ||
        !safeId(descriptor.value) || seenLeaseIds.has(descriptor.value)
      ) return undefined;
      valuesByItemId.set(itemId, descriptor.value);
      seenLeaseIds.add(descriptor.value);
    }

    const eligibleItemIds = new Set(
      plan.items
        .filter((item) => item.include && item.readiness === "ready")
        .map((item) => item.itemId),
    );
    if ([...valuesByItemId.keys()].some((itemId) => !eligibleItemIds.has(itemId))) {
      return undefined;
    }

    const canonical = Object.create(null) as Record<string, string>;
    for (const item of plan.items) {
      const leaseId = valuesByItemId.get(item.itemId);
      if (leaseId !== undefined) canonical[item.itemId] = leaseId;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

function leaseMapsEqual(
  left: CaptureHeaderLeaseIdsByItemId | undefined,
  right: CaptureHeaderLeaseIdsByItemId | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  return leftEntries.length === rightEntries.length &&
    leftEntries.every(([itemId, leaseId], index) =>
      rightEntries[index]?.[0] === itemId && rightEntries[index]?.[1] === leaseId);
}

function cloneChoice(choice: CapturePlanChoiceSelectorV1): CapturePlanChoiceSelectorV1 {
  return { itemId: choice.itemId, optionId: choice.optionId };
}

function cloneOption(option: CaptureVariantOptionV1): CaptureVariantOptionV1 {
  return {
    itemId: option.itemId,
    optionId: option.optionId,
    kind: option.kind,
    label: option.label,
    ...(option.width === undefined ? {} : { width: option.width }),
    ...(option.height === undefined ? {} : { height: option.height }),
    ...(option.videoBandwidth === undefined ? {} : { videoBandwidth: option.videoBandwidth }),
    ...(option.audioBandwidth === undefined ? {} : { audioBandwidth: option.audioBandwidth }),
    ...(option.combinedBandwidth === undefined
      ? {}
      : { combinedBandwidth: option.combinedBandwidth }),
    ...(option.durationSec === undefined ? {} : { durationSec: option.durationSec }),
    ...(option.estimatedBytes === undefined ? {} : { estimatedBytes: option.estimatedBytes }),
    estimateConfidence: option.estimateConfidence,
    supported: option.supported,
    ...(option.disabledReason === undefined
      ? {}
      : { disabledReason: option.disabledReason }),
    ...(option.selectedByPolicy === true ? { selectedByPolicy: true as const } : {}),
    ...(option.suggestedForConfirmation === true
      ? { suggestedForConfirmation: true as const }
      : {}),
  };
}

function cloneRecord(record: CapturePlanOptionsRecordV1): CapturePlanOptionsRecordV1 {
  const headerLeaseIdsByItemId = canonicalizeCaptureHeaderLeaseIdsByItemId(
    record.plan,
    record.headerLeaseIdsByItemId,
  );
  if (!headerLeaseIdsByItemId) throw new Error("Invalid Capture Plan header lease map.");
  return {
    schemaVersion: 1,
    planId: record.planId,
    commandId: record.commandId,
    draftId: record.draftId,
    draftRevision: record.draftRevision,
    choices: record.choices.map(cloneChoice),
    options: record.options.map(cloneOption),
    headerLeaseIdsByItemId,
    plan: cloneCaptureReviewPlan(record.plan),
    state: record.state,
    createdAt: record.createdAt,
  };
}

function validChoice(value: unknown): value is CapturePlanChoiceSelectorV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 2 &&
      safeId(record.itemId) &&
      typeof record.optionId === "string" &&
      OPTION_ID.test(record.optionId);
  } catch {
    return false;
  }
}

function optionalPositive(value: unknown): boolean {
  return value === undefined || (safeInteger(value) && value > 0);
}

function validOption(value: unknown): value is CaptureVariantOptionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const record = value as Record<string, unknown>;
    const keys = new Set([
      "itemId", "optionId", "kind", "label", "width", "height",
      "videoBandwidth", "audioBandwidth", "estimatedBytes", "estimateConfidence",
      "combinedBandwidth", "durationSec", "supported", "disabledReason",
      "selectedByPolicy",
      "suggestedForConfirmation",
    ]);
    return Object.keys(record).every((key) => keys.has(key)) &&
      safeId(record.itemId) &&
      typeof record.optionId === "string" && OPTION_ID.test(record.optionId) &&
      (record.kind === "hls" || record.kind === "dash") &&
      typeof record.label === "string" && record.label.length > 0 && record.label.length <= 512 &&
      !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(record.label) &&
      optionalPositive(record.width) && optionalPositive(record.height) &&
      optionalPositive(record.videoBandwidth) && optionalPositive(record.audioBandwidth) &&
      optionalPositive(record.combinedBandwidth) &&
      (record.durationSec === undefined ||
        (typeof record.durationSec === "number" && Number.isFinite(record.durationSec) &&
          record.durationSec > 0)) &&
      optionalPositive(record.estimatedBytes) &&
      typeof record.supported === "boolean" &&
      (record.selectedByPolicy === undefined || record.selectedByPolicy === true) &&
      (record.suggestedForConfirmation === undefined ||
        record.suggestedForConfirmation === true) &&
      !(record.selectedByPolicy === true && record.supported !== true) &&
      !(record.suggestedForConfirmation === true && record.supported !== true) &&
      !(record.selectedByPolicy === true && record.suggestedForConfirmation === true) &&
      (record.disabledReason === undefined || [
        "drm", "live", "unsupported_codec", "unsupported_container",
        "unsupported_manifest_shape", "unsupported_audio", "permanent_download_failure",
        "invalid_media", "over_size_cap",
      ].includes(record.disabledReason as string)) &&
      (record.supported ? record.disabledReason === undefined : record.disabledReason !== undefined) &&
      (record.estimateConfidence === "exact" ||
        record.estimateConfidence === "estimated" ||
        record.estimateConfidence === "unknown");
  } catch {
    return false;
  }
}

function validRecord(value: unknown): value is CapturePlanOptionsRecordV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const allowedKeys = new Set([
      "schemaVersion", "planId", "commandId", "draftId", "draftRevision",
      "choices", "options", "headerLeaseIdsByItemId", "plan", "state", "createdAt",
    ]);
    const requiredKeys = [...allowedKeys].filter((key) => key !== "headerLeaseIdsByItemId");
    const ownKeys = Reflect.ownKeys(record);
    if (
      ownKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
      ownKeys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        return !descriptor || !("value" in descriptor) || !descriptor.enumerable;
      }) ||
      (Object.prototype.hasOwnProperty.call(record, "headerLeaseIdsByItemId") &&
        record.headerLeaseIdsByItemId === undefined)
    ) return false;
    if (
      record.schemaVersion !== 1 || !safeId(record.planId) || !safeId(record.commandId) ||
      !safeId(record.draftId) || !safeInteger(record.draftRevision) || !safeInteger(record.createdAt) ||
      !Array.isArray(record.choices) || record.choices.length > 200 ||
      !record.choices.every(validChoice) ||
      new Set(record.choices.map((choice) => choice.itemId)).size !== record.choices.length ||
      !Array.isArray(record.options) || record.options.length > 200 || !record.options.every(validOption) ||
      new Set(record.options.map((option) => option.optionId)).size !== record.options.length ||
      !isCaptureReviewPlanV1(record.plan) ||
      (record.state !== "prepared" && record.state !== "committed")
    ) return false;
    const selectedByItem = new Set<string>();
    const suggestedByItem = new Set<string>();
    for (const option of record.options) {
      if (option.selectedByPolicy === true) {
        if (selectedByItem.has(option.itemId)) return false;
        selectedByItem.add(option.itemId);
      }
      if (option.suggestedForConfirmation === true) {
        if (suggestedByItem.has(option.itemId)) return false;
        suggestedByItem.add(option.itemId);
      }
    }
    const headerLeaseIdsByItemId = canonicalizeCaptureHeaderLeaseIdsByItemId(
      record.plan,
      record.headerLeaseIdsByItemId,
    );
    if (!headerLeaseIdsByItemId) return false;
    if (
      record.plan.planId !== record.planId || record.plan.draftId !== record.draftId ||
      record.plan.draftRevision !== record.draftRevision || record.plan.generatedAt !== record.createdAt
    ) return false;
    const optionKeys = new Set(record.options.map((option) => `${option.itemId}\u0000${option.optionId}`));
    const planItemKinds = new Map(record.plan.items.map((item) => [item.itemId, item.media.kind]));
    return record.choices.every((choice) => optionKeys.has(`${choice.itemId}\u0000${choice.optionId}`)) &&
      record.options.every((option) => planItemKinds.get(option.itemId) === option.kind);
  } catch {
    return false;
  }
}

function emptyIndex(): CapturePlanOptionsIndexV1 {
  return { schemaVersion: 1, orderedPlanIds: [], records: {} };
}

function parseIndex(value: unknown): CapturePlanOptionsIndexV1 | undefined {
  if (value === undefined) return emptyIndex();
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const record = value as Record<string, unknown>;
    const records = record.records;
    if (
      record.schemaVersion !== 1 || !Array.isArray(record.orderedPlanIds) ||
      record.orderedPlanIds.length > MAX_CAPTURE_PLAN_OPTION_RECORDS ||
      !record.orderedPlanIds.every(safeId) ||
      new Set(record.orderedPlanIds).size !== record.orderedPlanIds.length ||
      !records || typeof records !== "object" || Array.isArray(records)
    ) return undefined;
    const typedRecords = records as Record<string, unknown>;
    if (
      Object.keys(typedRecords).length !== record.orderedPlanIds.length ||
      record.orderedPlanIds.some((planId) => !validRecord(typedRecords[planId]) ||
        (typedRecords[planId] as CapturePlanOptionsRecordV1).planId !== planId)
    ) return undefined;
    return {
      schemaVersion: 1,
      orderedPlanIds: [...record.orderedPlanIds],
      records: Object.fromEntries(record.orderedPlanIds.map((planId) => [
        planId,
        cloneRecord(typedRecords[planId] as CapturePlanOptionsRecordV1),
      ])),
    };
  } catch {
    return undefined;
  }
}

function serializedBytes(value: unknown): number | undefined {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : new TextEncoder().encode(encoded).byteLength;
  } catch {
    return undefined;
  }
}

export function capturePlanOptionRequestMatches(
  record: CapturePlanOptionsRecordV1,
  input: Pick<CapturePlanOptionsRecordV1, "commandId" | "draftId" | "draftRevision" | "choices">,
): boolean {
  return record.commandId === input.commandId &&
    record.draftId === input.draftId &&
    record.draftRevision === input.draftRevision &&
    JSON.stringify(record.choices) === JSON.stringify(input.choices);
}

export async function getCapturePlanOptions(planId: string): Promise<CapturePlanOptionsResult> {
  if (!safeId(planId)) return { ok: false, reason: "invalid_input" };
  try {
    const stored = await chrome.storage.session.get(CAPTURE_PLAN_OPTIONS_STORAGE_KEY);
    const index = parseIndex(stored[CAPTURE_PLAN_OPTIONS_STORAGE_KEY]);
    if (!index) return { ok: false, reason: "storage_corrupt" };
    const record = index.records[planId];
    return { ok: true, record: record ? cloneRecord(record) : null };
  } catch {
    return { ok: false, reason: "storage_unavailable" };
  }
}

export async function saveCapturePlanOptions(
  rawRecord: CapturePlanOptionsRecordV1,
): Promise<CapturePlanOptionsResult> {
  if (!validRecord(rawRecord)) return { ok: false, reason: "invalid_input" };
  const incoming = cloneRecord(rawRecord);
  return withKeyLock(CAPTURE_PLAN_OPTIONS_STORAGE_KEY, async () => {
    try {
      const stored = await chrome.storage.session.get(CAPTURE_PLAN_OPTIONS_STORAGE_KEY);
      const index = parseIndex(stored[CAPTURE_PLAN_OPTIONS_STORAGE_KEY]);
      if (!index) return { ok: false, reason: "storage_corrupt" };
      const existing = index.records[incoming.planId];
      if (existing) {
        const comparableExisting = { ...cloneRecord(existing), state: "prepared" as const };
        const comparableIncoming = { ...cloneRecord(incoming), state: "prepared" as const };
        if (
          !leaseMapsEqual(
            comparableExisting.headerLeaseIdsByItemId,
            comparableIncoming.headerLeaseIdsByItemId,
          ) ||
          JSON.stringify(comparableExisting) !== JSON.stringify(comparableIncoming)
        ) {
          return { ok: false, reason: "invalid_input" };
        }
        if (existing.state === "committed" && incoming.state === "prepared") {
          return { ok: true, record: cloneRecord(existing) };
        }
      }
      let orderedPlanIds = [
        incoming.planId,
        ...index.orderedPlanIds.filter((planId) => planId !== incoming.planId),
      ].slice(0, MAX_CAPTURE_PLAN_OPTION_RECORDS);
      let next: CapturePlanOptionsIndexV1;
      let bytes: number | undefined;
      do {
        const records = Object.fromEntries(orderedPlanIds.map((planId) => [
          planId,
          planId === incoming.planId ? incoming : index.records[planId],
        ]));
        next = { schemaVersion: 1, orderedPlanIds, records };
        bytes = serializedBytes(next);
        if (bytes !== undefined && bytes <= MAX_CAPTURE_PLAN_OPTIONS_BYTES) break;
        if (orderedPlanIds.length === 1) break;
        orderedPlanIds = orderedPlanIds.slice(0, -1);
      } while (true);
      if (bytes === undefined || bytes > MAX_CAPTURE_PLAN_OPTIONS_BYTES) {
        return { ok: false, reason: "size_limit" };
      }
      await chrome.storage.session.set({ [CAPTURE_PLAN_OPTIONS_STORAGE_KEY]: next });
      return { ok: true, record: cloneRecord(incoming) };
    } catch {
      return { ok: false, reason: "storage_unavailable" };
    }
  });
}

/** Removes Review-only option/preflight records that no retained plan needs. */
export async function clearUnreferencedCapturePlanOptions(
  rawPreservePlanIds: readonly string[],
): Promise<ClearCapturePlanOptionsResult> {
  if (
    !Array.isArray(rawPreservePlanIds) ||
    rawPreservePlanIds.length > 200 ||
    !rawPreservePlanIds.every(safeId) ||
    new Set(rawPreservePlanIds).size !== rawPreservePlanIds.length
  ) return { ok: false, reason: "invalid_input" };
  const preserved = new Set(rawPreservePlanIds);
  return withKeyLock(CAPTURE_PLAN_OPTIONS_STORAGE_KEY, async () => {
    try {
      const stored = await chrome.storage.session.get(CAPTURE_PLAN_OPTIONS_STORAGE_KEY);
      const index = parseIndex(stored[CAPTURE_PLAN_OPTIONS_STORAGE_KEY]);
      if (!index) return { ok: false, reason: "storage_corrupt" };
      const preservedPlanIds = index.orderedPlanIds.filter((planId) => preserved.has(planId));
      const removedPlanIds = index.orderedPlanIds.filter((planId) => !preserved.has(planId));
      const next: CapturePlanOptionsIndexV1 = {
        schemaVersion: 1,
        orderedPlanIds: preservedPlanIds,
        records: Object.fromEntries(preservedPlanIds.map((planId) => [
          planId,
          cloneRecord(index.records[planId]),
        ])),
      };
      await chrome.storage.session.set({ [CAPTURE_PLAN_OPTIONS_STORAGE_KEY]: next });
      return { ok: true, removedPlanIds, preservedPlanIds };
    } catch {
      return { ok: false, reason: "storage_unavailable" };
    }
  });
}
