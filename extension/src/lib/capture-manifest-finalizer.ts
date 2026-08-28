import {
  isCaptureJobV1,
  type CaptureJobV1,
  type CaptureManifestFormatV1,
} from "./capture-pack-types";
import {
  serializeCaptureManifestCsv,
  serializeCaptureManifestJson,
  type CaptureManifestInputItemV1,
  type CaptureManifestInputV1,
} from "./capture-manifest";
import {
  isCaptureManifestSeedV1,
  type CaptureManifestSeedV1,
} from "./capture-manifest-seed";
import { isSafeRelativeDownloadPath } from "./download-path";

export const CAPTURE_MANIFEST_FILENAMES: Readonly<Record<CaptureManifestFormatV1, string>> = {
  json: "_cliphutch-manifest.json",
  csv: "_cliphutch-manifest.csv",
};

const TERMINAL_JOB_STATES = new Set<CaptureJobV1["state"]>([
  "complete",
  "failed",
  "cancelled",
  "save_state_unknown",
]);

export type BuildCaptureManifestInputResult =
  | { ok: true; input: CaptureManifestInputV1 }
  | {
      ok: false;
      reason:
        | "invalid_seed"
        | "invalid_jobs"
        | "jobs_not_terminal"
        | "invalid_finalized_at";
    };

function manifestErrorCode(job: CaptureJobV1): string {
  if (job.state === "cancelled") return "CANCELLED";
  const code = job.error?.code.toUpperCase() ?? "UNKNOWN";
  if (job.state === "save_state_unknown" || code.includes("SAVE_STATE_UNKNOWN")) {
    return "SAVE_STATE_UNKNOWN";
  }
  if (code.includes("CANCEL")) return "CANCELLED";
  if (code.includes("SIZE") || code.includes("CAP")) return "SIZE_LIMIT";
  if (
    code.includes("STALE") ||
    code.includes("AUTH_EXPIRED") ||
    code.includes("SOURCE_EXPIRED") ||
    code.includes("VIDEO_MISSING")
  ) return "STALE_SOURCE";
  if (
    code.includes("UNSUPPORTED") ||
    code.includes("DRM") ||
    code.includes("LIVE") ||
    code.includes("ENCRYPT") ||
    code.includes("CODEC") ||
    code.includes("BYTERANGE")
  ) return "UNSUPPORTED";
  if (
    code.includes("SAVE") ||
    code.includes("DOWNLOAD_ID") ||
    code.includes("INTERRUPT")
  ) return "SAVE_FAILED";
  if (
    code.includes("NETWORK") ||
    code.includes("FETCH") ||
    code.includes("HTTP") ||
    code.includes("TIMEOUT")
  ) return "NETWORK";
  return "UNKNOWN";
}

function terminalStatus(job: CaptureJobV1): CaptureManifestInputItemV1["status"] {
  if (job.state === "complete") return "complete";
  if (job.state === "cancelled") return "cancelled";
  if (job.state === "save_state_unknown") return "save_state_unknown";
  return "failed";
}

/** CSV is delivered first when selected so the required JSON closes the pack. */
export function captureManifestDeliveryOrder(
  seed: CaptureManifestSeedV1,
): CaptureManifestFormatV1[] {
  if (!isCaptureManifestSeedV1(seed)) return [];
  return seed.formats.includes("csv") ? ["csv", "json"] : ["json"];
}

export function captureManifestDownloadPath(
  seed: CaptureManifestSeedV1,
  format: CaptureManifestFormatV1,
): string | undefined {
  if (!isCaptureManifestSeedV1(seed) || !seed.formats.includes(format)) return undefined;
  const path = `${seed.relativeRoot}/${CAPTURE_MANIFEST_FILENAMES[format]}`;
  return isSafeRelativeDownloadPath(path) ? path : undefined;
}

/**
 * Converts the immutable redacted seed and terminal job graph into the only
 * serializer input accepted by C5. Raw media URLs, headers, command/quota
 * identifiers, absolute paths, and internal error text never enter this model.
 */
export function buildCaptureManifestInput(input: {
  seed: CaptureManifestSeedV1;
  jobs: readonly CaptureJobV1[];
  finalizedAt: number;
  generatorVersion: string;
}): BuildCaptureManifestInputResult {
  try {
    if (!isCaptureManifestSeedV1(input.seed)) return { ok: false, reason: "invalid_seed" };
    if (
      !Number.isFinite(input.finalizedAt) ||
      input.finalizedAt < input.seed.createdAt ||
      input.seed.items.some((item) => item.addedAt > input.finalizedAt)
    ) {
      return { ok: false, reason: "invalid_finalized_at" };
    }
    if (!Array.isArray(input.jobs) || !input.jobs.every(isCaptureJobV1)) {
      return { ok: false, reason: "invalid_jobs" };
    }
    const jobsById = new Map(input.jobs.map((job) => [job.jobId, job] as const));
    const included = input.seed.items.filter((item) => item.included);
    if (
      input.jobs.length !== included.length ||
      jobsById.size !== input.jobs.length ||
      included.some((item) => !item.jobId)
    ) {
      return { ok: false, reason: "invalid_jobs" };
    }

    const manifestItems: CaptureManifestInputItemV1[] = [];
    const includedJobs: CaptureJobV1[] = [];
    for (const item of input.seed.items) {
      if (!item.included) {
        manifestItems.push({
          plannedPath: item.plannedPath,
          kind: item.kind,
          ...(item.pageUrl === undefined ? {} : { pageUrl: item.pageUrl }),
          ...(item.sourceHost === undefined ? {} : { sourceHost: item.sourceHost }),
          ...(item.width === undefined ? {} : { width: item.width }),
          ...(item.height === undefined ? {} : { height: item.height }),
          ...(item.durationSec === undefined ? {} : { durationSec: item.durationSec }),
          ...(item.bitrate === undefined ? {} : { bitrate: item.bitrate }),
          capturedAt: item.addedAt,
          status: "excluded",
        });
        continue;
      }
      const job = item.jobId ? jobsById.get(item.jobId) : undefined;
      if (
        !job ||
        job.runId !== input.seed.runId ||
        job.itemId !== item.itemId ||
        job.snapshot.plannedRelativePath !== item.plannedPath ||
        job.snapshot.media.kind !== item.kind
      ) {
        return { ok: false, reason: "invalid_jobs" };
      }
      if (!TERMINAL_JOB_STATES.has(job.state)) {
        return { ok: false, reason: "jobs_not_terminal" };
      }
      includedJobs.push(job);
      const status = terminalStatus(job);
      manifestItems.push({
        plannedPath: item.plannedPath,
        ...(job.result?.actualBasename === undefined
          ? {}
          : { actualFilename: job.result.actualBasename }),
        kind: item.kind,
        ...(item.pageUrl === undefined ? {} : { pageUrl: item.pageUrl }),
        ...(item.sourceHost === undefined ? {} : { sourceHost: item.sourceHost }),
        ...(item.width === undefined ? {} : { width: item.width }),
        ...(item.height === undefined ? {} : { height: item.height }),
        ...(item.durationSec === undefined ? {} : { durationSec: item.durationSec }),
        ...(item.bitrate === undefined ? {} : { bitrate: item.bitrate }),
        capturedAt: item.addedAt,
        status,
        ...(status === "complete" ? {} : { errorCode: manifestErrorCode(job) }),
      });
    }
    if (includedJobs.length === 0) return { ok: false, reason: "invalid_jobs" };
    const status: CaptureManifestInputV1["status"] = includedJobs.every(
      (job) => job.state === "complete",
    )
      ? "complete"
      : includedJobs.every((job) => job.state === "cancelled")
        ? "cancelled"
        : "partial";
    return {
      ok: true,
      input: {
        generatorVersion: input.generatorVersion,
        packName: input.seed.packName,
        createdAt: input.seed.createdAt,
        completedAt: input.finalizedAt,
        status,
        items: manifestItems,
      },
    };
  } catch {
    return { ok: false, reason: "invalid_jobs" };
  }
}

export function serializeCaptureManifestForFormat(
  input: CaptureManifestInputV1,
  format: CaptureManifestFormatV1,
): string {
  return format === "json"
    ? serializeCaptureManifestJson(input)
    : serializeCaptureManifestCsv(input);
}
