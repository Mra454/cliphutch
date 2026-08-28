import {
  CAPTURE_PACK_SCHEMA_VERSION,
  MAX_CAPTURE_PLAN_ITEMS,
  isCaptureJobV1,
  isCaptureReviewPlanV1,
  type CaptureJobV1,
  type CaptureManifestFormatV1,
  type CaptureReviewPlanV1,
} from "./capture-pack-types";
import {
  canonicalCaptureManifestPackName,
  redactManifestUrl,
  sourceHostForManifest,
  type CaptureManifestMediaKind,
} from "./capture-manifest";
import { isSafeRelativeDownloadPath } from "./download-path";

export const MAX_CAPTURE_MANIFEST_SEED_BYTES = 512 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_PACK_NAME_LENGTH = 120;
const MAX_PAGE_URL_LENGTH = 2_048;
const MAX_HOST_LENGTH = 255;
const UNSAFE_TEXT_PATTERN = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export type CaptureManifestSeedItemV1 = {
  itemId: string;
  included: boolean;
  jobId?: string;
  plannedPath: string;
  kind: CaptureManifestMediaKind;
  pageUrl?: string;
  sourceHost?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  bitrate?: number;
  addedAt: number;
};

export type CaptureManifestSeedV1 = {
  schemaVersion: typeof CAPTURE_PACK_SCHEMA_VERSION;
  runId: string;
  planId: string;
  packName: string;
  relativeRoot: string;
  createdAt: number;
  formats: CaptureManifestFormatV1[];
  items: CaptureManifestSeedItemV1[];
};

export type CreateCaptureManifestSeedResult =
  | { ok: true; seed: CaptureManifestSeedV1 | null }
  | { ok: false; reason: "invalid_plan" | "invalid_jobs" | "serialized_byte_limit" };

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function exactKeys(record: UnknownRecord, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record);
  const allowedKeys = new Set(allowed);
  return keys.every((key) => {
    if (typeof key !== "string" || !allowedKeys.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return Boolean(descriptor && "value" in descriptor && descriptor.enumerable);
  });
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH &&
    value === value.trim() && !UNSAFE_TEXT_PATTERN.test(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function manifestTimestamp(value: unknown): value is number {
  return finiteNonNegative(value) && Number.isFinite(new Date(value).getTime());
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function optionalFiniteNonNegative(value: unknown): boolean {
  return value === undefined || finiteNonNegative(value);
}

function serializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return undefined;
  }
}

function canonicalItem(item: CaptureManifestSeedItemV1): CaptureManifestSeedItemV1 {
  return {
    itemId: item.itemId,
    included: item.included,
    ...(item.jobId === undefined ? {} : { jobId: item.jobId }),
    plannedPath: item.plannedPath,
    kind: item.kind,
    ...(item.pageUrl === undefined ? {} : { pageUrl: item.pageUrl }),
    ...(item.sourceHost === undefined ? {} : { sourceHost: item.sourceHost }),
    ...(item.width === undefined ? {} : { width: item.width }),
    ...(item.height === undefined ? {} : { height: item.height }),
    ...(item.durationSec === undefined ? {} : { durationSec: item.durationSec }),
    ...(item.bitrate === undefined ? {} : { bitrate: item.bitrate }),
    addedAt: item.addedAt,
  };
}

export function cloneCaptureManifestSeed(seed: CaptureManifestSeedV1): CaptureManifestSeedV1 {
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    runId: seed.runId,
    planId: seed.planId,
    packName: seed.packName,
    relativeRoot: seed.relativeRoot,
    createdAt: seed.createdAt,
    formats: [...seed.formats],
    items: seed.items.map(canonicalItem),
  };
}

function isCaptureManifestSeedItemV1(value: unknown): value is CaptureManifestSeedItemV1 {
  const record = asRecord(value);
  return Boolean(
    record &&
    exactKeys(record, [
      "itemId", "included", "jobId", "plannedPath", "kind", "pageUrl", "sourceHost",
      "width", "height", "durationSec", "bitrate", "addedAt",
    ]) &&
    safeId(record.itemId) &&
    typeof record.included === "boolean" &&
    (record.jobId === undefined || safeId(record.jobId)) &&
    (record.included ? record.jobId !== undefined : record.jobId === undefined) &&
    typeof record.plannedPath === "string" && isSafeRelativeDownloadPath(record.plannedPath) &&
    (record.kind === "direct" || record.kind === "hls" || record.kind === "dash" || record.kind === "image") &&
    (record.pageUrl === undefined || (
      typeof record.pageUrl === "string" && record.pageUrl.length <= MAX_PAGE_URL_LENGTH &&
      redactManifestUrl(record.pageUrl) === record.pageUrl
    )) &&
    (record.sourceHost === undefined || (
      typeof record.sourceHost === "string" && record.sourceHost.length <= MAX_HOST_LENGTH &&
      sourceHostForManifest(`https://${record.sourceHost}/`) === record.sourceHost
    )) &&
    optionalPositiveInteger(record.width) &&
    optionalPositiveInteger(record.height) &&
    optionalFiniteNonNegative(record.durationSec) &&
    optionalFiniteNonNegative(record.bitrate) &&
    manifestTimestamp(record.addedAt)
  );
}

export function isCaptureManifestSeedV1(value: unknown): value is CaptureManifestSeedV1 {
  try {
    const record = asRecord(value);
    if (
      !record ||
      !exactKeys(record, [
        "schemaVersion", "runId", "planId", "packName", "relativeRoot", "createdAt", "formats", "items",
      ]) ||
      record.schemaVersion !== CAPTURE_PACK_SCHEMA_VERSION ||
      !safeId(record.runId) ||
      !safeId(record.planId) ||
      typeof record.packName !== "string" ||
      record.packName.length === 0 ||
      record.packName.length > MAX_PACK_NAME_LENGTH ||
      canonicalCaptureManifestPackName(record.packName) !== record.packName ||
      typeof record.relativeRoot !== "string" ||
      !record.relativeRoot.startsWith("ClipHutch/") ||
      record.relativeRoot.split("/").length !== 2 ||
      !isSafeRelativeDownloadPath(`${record.relativeRoot}/_cliphutch-manifest.json`) ||
      !manifestTimestamp(record.createdAt) ||
      !Array.isArray(record.formats) ||
      record.formats.length < 1 ||
      record.formats.length > 2 ||
      record.formats[0] !== "json" ||
      !record.formats.every((format) => format === "json" || format === "csv") ||
      new Set(record.formats).size !== record.formats.length ||
      !Array.isArray(record.items) ||
      record.items.length > MAX_CAPTURE_PLAN_ITEMS ||
      !record.items.every(isCaptureManifestSeedItemV1)
    ) {
      return false;
    }
    if (new Set(record.items.map((item) => item.itemId)).size !== record.items.length) return false;
    if (new Set(record.items.flatMap((item) => item.jobId ? [item.jobId] : [])).size !==
      record.items.filter((item) => item.jobId !== undefined).length) return false;
    if (record.items.some((item) => item.addedAt < (record.createdAt as number))) return false;
    if (record.items.some((item) => !item.plannedPath.startsWith(`${record.relativeRoot}/`))) return false;
    const bytes = serializedBytes(value);
    return bytes !== undefined && bytes <= MAX_CAPTURE_MANIFEST_SEED_BYTES;
  } catch {
    return false;
  }
}

/** Builds the only durable manifest input, dropping every non-allowlisted field. */
export function createCaptureManifestSeed(input: {
  runId: string;
  plan: CaptureReviewPlanV1;
  jobs: readonly CaptureJobV1[];
}): CreateCaptureManifestSeedResult {
  try {
    if (!safeId(input.runId) || !isCaptureReviewPlanV1(input.plan)) {
      return { ok: false, reason: "invalid_plan" };
    }
    if (input.plan.planId.startsWith("capture-single-plan:") && input.plan.manifestSpec !== undefined) {
      return { ok: false, reason: "invalid_plan" };
    }
    if (input.plan.manifestSpec === undefined) return { ok: true, seed: null };
    if (!Array.isArray(input.jobs) || !input.jobs.every(isCaptureJobV1)) {
      return { ok: false, reason: "invalid_jobs" };
    }
    const jobsByItemId = new Map<string, CaptureJobV1>();
    for (const job of input.jobs) {
      if (job.runId !== input.runId || jobsByItemId.has(job.itemId)) {
        return { ok: false, reason: "invalid_jobs" };
      }
      jobsByItemId.set(job.itemId, job);
    }
    const includedIds = input.plan.items.filter((item) => item.include).map((item) => item.itemId);
    if (
      input.jobs.length !== includedIds.length ||
      includedIds.some((itemId) => !jobsByItemId.has(itemId)) ||
      input.jobs.some((job) => !includedIds.includes(job.itemId))
    ) {
      return { ok: false, reason: "invalid_jobs" };
    }
    const items: CaptureManifestSeedItemV1[] = [];
    for (const item of input.plan.items) {
      const job = jobsByItemId.get(item.itemId);
      if (job && (
        job.snapshot.plannedRelativePath !== item.plannedRelativePath ||
        job.snapshot.media.kind !== item.media.kind
      )) {
        return { ok: false, reason: "invalid_jobs" };
      }
      const pageUrl = redactManifestUrl(item.media.pageUrl);
      const sourceHost = sourceHostForManifest(item.media.url);
      items.push(canonicalItem({
        itemId: item.itemId,
        included: item.include,
        ...(job === undefined ? {} : { jobId: job.jobId }),
        plannedPath: item.plannedRelativePath,
        kind: item.media.kind,
        ...(pageUrl === undefined ? {} : { pageUrl }),
        ...(sourceHost === undefined ? {} : { sourceHost }),
        ...(item.media.width === undefined ? {} : { width: item.media.width }),
        ...(item.media.height === undefined ? {} : { height: item.media.height }),
        ...(item.media.durationSec === undefined ? {} : { durationSec: item.media.durationSec }),
        ...(item.media.bitrate === undefined ? {} : { bitrate: item.media.bitrate }),
        addedAt: input.plan.manifestSpec.itemAddedAt[item.itemId],
      }));
    }
    const seed: CaptureManifestSeedV1 = {
      schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
      runId: input.runId,
      planId: input.plan.planId,
      packName: input.plan.manifestSpec.packName,
      relativeRoot: input.plan.relativeRoot,
      createdAt: input.plan.manifestSpec.createdAt,
      formats: [...input.plan.manifestSpec.formats],
      items,
    };
    if (!isCaptureManifestSeedV1(seed)) {
      const bytes = serializedBytes(seed);
      return {
        ok: false,
        reason: bytes !== undefined && bytes > MAX_CAPTURE_MANIFEST_SEED_BYTES
          ? "serialized_byte_limit"
          : "invalid_plan",
      };
    }
    return { ok: true, seed: cloneCaptureManifestSeed(seed) };
  } catch {
    return { ok: false, reason: "invalid_plan" };
  }
}
