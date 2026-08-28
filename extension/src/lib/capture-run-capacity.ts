import { createCaptureManifestRecord } from "./capture-manifest-delivery";
import { createCaptureManifestSeed } from "./capture-manifest-seed";
import { prepareCaptureJobs } from "./capture-executor";
import {
  CAPTURE_PACK_SCHEMA_VERSION,
  captureReviewPlanTotalsForItems,
  isCaptureReviewPlanV1,
  type CaptureReviewPlanV1,
  type CaptureRunV1,
} from "./capture-pack-types";
import type { CaptureHeaderLeaseIdsByItemId } from "./capture-plan-options";
import { FREE_DOWNLOAD_LIMIT } from "./rate-limit";
import { MAX_CAPTURE_RUN_GRAPH_BYTES } from "./capture-run-storage";

const CAPACITY_RUN_ID = "capture-run:v1:00000000-0000-4000-8000-000000000000";
const CAPACITY_COMMAND_ID = "00000000-0000-4000-8000-000000000000";

export type CaptureRunCapacityResult =
  | { ok: true; bytes: number; maximumBytes: number }
  | {
      ok: false;
      reason: "invalid_plan" | "manifest_seed_too_large" | "graph_too_large";
      bytes?: number;
      maximumBytes: number;
    };

function serializedBytes(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : new TextEncoder().encode(json).byteLength;
  } catch {
    return undefined;
  }
}

function capacityReservationId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

/**
 * Measures the largest executable view of a reviewed plan before the customer
 * reaches Save. Unready rows remain in the redacted manifest seed but cannot
 * become jobs. Up to the free quota limit receives worst-case reservation IDs;
 * licensed execution is smaller.
 */
export function assessCaptureRunCapacity(input: {
  plan: CaptureReviewPlanV1;
  headerLeaseIdsByItemId?: CaptureHeaderLeaseIdsByItemId;
}): CaptureRunCapacityResult {
  try {
    if (!isCaptureReviewPlanV1(input.plan)) {
      return { ok: false, reason: "invalid_plan", maximumBytes: MAX_CAPTURE_RUN_GRAPH_BYTES };
    }
    const items = input.plan.items.map((item) => item.readiness === "ready"
      ? item
      : { ...item, include: false });
    const totals = captureReviewPlanTotalsForItems(items);
    if (!totals) {
      return { ok: false, reason: "invalid_plan", maximumBytes: MAX_CAPTURE_RUN_GRAPH_BYTES };
    }
    const plan: CaptureReviewPlanV1 = { ...input.plan, items, totals };
    if (!isCaptureReviewPlanV1(plan)) {
      return { ok: false, reason: "invalid_plan", maximumBytes: MAX_CAPTURE_RUN_GRAPH_BYTES };
    }

    const leaseMap = Object.create(null) as Record<string, string>;
    for (const item of plan.items) {
      if (
        item.include &&
        Object.prototype.hasOwnProperty.call(input.headerLeaseIdsByItemId ?? {}, item.itemId)
      ) {
        const leaseId = input.headerLeaseIdsByItemId?.[item.itemId];
        if (typeof leaseId === "string") leaseMap[item.itemId] = leaseId;
      }
    }
    let jobs = prepareCaptureJobs(plan, {
      runId: CAPACITY_RUN_ID,
      headerLeaseIdsByItemId: leaseMap,
    });
    let reservationIndex = 0;
    jobs = jobs.map((job) => {
      if (job.snapshot.media.kind === "image" || reservationIndex >= FREE_DOWNLOAD_LIMIT) {
        return job;
      }
      const quotaReservationId = capacityReservationId(reservationIndex);
      reservationIndex += 1;
      return { ...job, quotaReservationId };
    });
    const manifest = createCaptureManifestSeed({ runId: CAPACITY_RUN_ID, plan, jobs });
    if (!manifest.ok) {
      return {
        ok: false,
        reason: manifest.reason === "serialized_byte_limit"
          ? "manifest_seed_too_large"
          : "invalid_plan",
        maximumBytes: MAX_CAPTURE_RUN_GRAPH_BYTES,
      };
    }
    const manifestRecord = manifest.seed === null ? null : createCaptureManifestRecord(manifest.seed);
    if (manifest.seed !== null && !manifestRecord) {
      return { ok: false, reason: "invalid_plan", maximumBytes: MAX_CAPTURE_RUN_GRAPH_BYTES };
    }
    const run: CaptureRunV1 = {
      schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
      runId: CAPACITY_RUN_ID,
      planId: plan.planId,
      draftId: plan.draftId,
      draftRevision: plan.draftRevision,
      planDigest: "0".repeat(64),
      commandId: CAPACITY_COMMAND_ID,
      createdAt: plan.generatedAt,
      status: "queued",
      orderedJobIds: jobs.map((job) => job.jobId),
    };
    const bytes = serializedBytes({ run, jobs, manifestRecord });
    if (bytes === undefined) {
      return { ok: false, reason: "invalid_plan", maximumBytes: MAX_CAPTURE_RUN_GRAPH_BYTES };
    }
    return bytes <= MAX_CAPTURE_RUN_GRAPH_BYTES
      ? { ok: true, bytes, maximumBytes: MAX_CAPTURE_RUN_GRAPH_BYTES }
      : {
          ok: false,
          reason: "graph_too_large",
          bytes,
          maximumBytes: MAX_CAPTURE_RUN_GRAPH_BYTES,
        };
  } catch {
    return { ok: false, reason: "invalid_plan", maximumBytes: MAX_CAPTURE_RUN_GRAPH_BYTES };
  }
}
