import {
  isCaptureJobV1,
  isCaptureReviewPlanV1,
  isPersistentStreamQualityChoiceV1,
  type CaptureJobStateV1,
  type CaptureJobV1,
  type CaptureReviewPlanV1,
  type MediaSnapshotV1,
  type QualityChoiceV1,
  type QualityPolicyV1,
} from "./capture-pack-types";
import { isSafeRelativeDownloadPath } from "./download-path";

export const MAX_ACTIVE_HEAVY_CAPTURE_JOBS = 1;
export const MAX_ACTIVE_NATIVE_CAPTURE_JOBS = 3;

const TERMINAL_STATES = new Set<CaptureJobStateV1>([
  "complete",
  "failed",
  "cancelled",
  "save_state_unknown",
]);

const SLOT_HOLDING_STATES = new Set<CaptureJobStateV1>([
  "starting",
  "running",
  "processing",
  "delivery_pending",
  "saving",
  "cancelling",
]);

const SHA_256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const SHA_256_ROUNDS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

export const LEGAL_CAPTURE_JOB_TRANSITIONS: Readonly<
  Record<CaptureJobStateV1, readonly CaptureJobStateV1[]>
> = {
  // A prepared job can become non-executable before the scheduler queues it
  // (for example, its bounded source-authorization lease can expire while the
  // browser is suspended). Preserve that typed failure instead of disguising
  // it as a user cancellation.
  prepared: ["queued", "failed", "cancelled"],
  queued: ["starting", "failed", "cancelled"],
  starting: [
    "running",
    "delivery_pending",
    "saving",
    "failed",
    "cancelling",
    "save_state_unknown",
  ],
  running: ["processing", "delivery_pending", "saving", "complete", "failed", "cancelling"],
  processing: ["delivery_pending", "failed", "cancelling"],
  delivery_pending: ["saving", "failed", "cancelling", "save_state_unknown"],
  saving: ["complete", "failed", "cancelling", "save_state_unknown"],
  cancelling: ["cancelled", "complete", "failed", "save_state_unknown"],
  complete: [],
  failed: [],
  cancelled: [],
  save_state_unknown: [],
};

export type CaptureExecutorErrorCode =
  | "invalid_plan"
  | "invalid_run_id"
  | "duplicate_item"
  | "duplicate_path"
  | "unready_item"
  | "invalid_path"
  | "invalid_quality"
  | "invalid_header_lease"
  | "identifier_collision"
  | "invalid_job"
  | "duplicate_job"
  | "lane_overcommitted";

export class CaptureExecutorError extends Error {
  readonly code: CaptureExecutorErrorCode;
  readonly itemId?: string;

  constructor(code: CaptureExecutorErrorCode, message: string, itemId?: string) {
    super(message);
    this.name = "CaptureExecutorError";
    this.code = code;
    this.itemId = itemId;
  }
}

export type PrepareCaptureJobsOptions = {
  runId: string;
  headerLeaseIdsByItemId?: Readonly<Record<string, string | undefined>>;
};

function copyPolicy(policy: QualityPolicyV1): QualityPolicyV1 {
  if (policy.mode === "manual") return { mode: "manual" };
  return {
    mode: "best_under_cap",
    maxEstimatedBytes: policy.maxEstimatedBytes,
    ...(policy.maxHeight === undefined ? {} : { maxHeight: policy.maxHeight }),
  };
}

function copyQuality(quality: QualityChoiceV1): QualityChoiceV1 {
  if (quality.mode === "direct") return { mode: "direct" };
  const common = {
    mode: "stream",
    policy: copyPolicy(quality.policy),
    ...(quality.label === undefined ? {} : { label: quality.label }),
    ...(quality.width === undefined ? {} : { width: quality.width }),
    ...(quality.height === undefined ? {} : { height: quality.height }),
    ...(quality.videoBandwidth === undefined ? {} : { videoBandwidth: quality.videoBandwidth }),
    ...(quality.audioBandwidth === undefined ? {} : { audioBandwidth: quality.audioBandwidth }),
    ...(quality.combinedBandwidth === undefined
      ? {}
      : { combinedBandwidth: quality.combinedBandwidth }),
    ...(quality.durationSec === undefined ? {} : { durationSec: quality.durationSec }),
    ...(quality.estimatedBytes === undefined ? {} : { estimatedBytes: quality.estimatedBytes }),
    estimateConfidence: quality.estimateConfidence,
  } as const;
  if (isPersistentStreamQualityChoiceV1(quality)) {
    return {
      ...common,
      selector: {
        kind: quality.selector.kind,
        stableId: quality.selector.stableId,
      },
      maxDownloadBytes: quality.maxDownloadBytes,
    };
  }
  if (quality.variantKind === "hls") {
    return {
      ...common,
      variantKind: "hls",
      variantUrl: quality.variantUrl,
      // Keep the execution alias during the background migration. The runtime
      // guard guarantees a caller-supplied alias cannot disagree with the URL.
      fixedVariantId: quality.variantUrl,
    };
  }
  if (quality.variantKind === "dash") {
    return {
      ...common,
      variantKind: "dash",
      representationId: quality.representationId,
      fixedVariantId: quality.representationId,
    };
  }
  return { ...common, fixedVariantId: quality.fixedVariantId };
}

function copyMedia(media: MediaSnapshotV1): MediaSnapshotV1 {
  return {
    mediaId: media.mediaId,
    kind: media.kind,
    url: media.url,
    detectedAt: media.detectedAt,
    ...(media.firstSeenAt === undefined ? {} : { firstSeenAt: media.firstSeenAt }),
    ...(media.lastSeenAt === undefined ? {} : { lastSeenAt: media.lastSeenAt }),
    ...(media.pageUrl === undefined ? {} : { pageUrl: media.pageUrl }),
    ...(media.pageTitle === undefined ? {} : { pageTitle: media.pageTitle }),
    ...(media.contentType === undefined ? {} : { contentType: media.contentType }),
    ...(media.contentDisposition === undefined
      ? {}
      : { contentDisposition: media.contentDisposition }),
    ...(media.sizeBytes === undefined ? {} : { sizeBytes: media.sizeBytes }),
    ...(media.width === undefined ? {} : { width: media.width }),
    ...(media.height === undefined ? {} : { height: media.height }),
    ...(media.durationSec === undefined ? {} : { durationSec: media.durationSec }),
    ...(media.bitrate === undefined ? {} : { bitrate: media.bitrate }),
    ...(media.codecs === undefined ? {} : { codecs: media.codecs }),
    provenance: [...media.provenance],
    ...(media.familyId === undefined ? {} : { familyId: media.familyId }),
  };
}

function copyJob(job: CaptureJobV1): CaptureJobV1 {
  return {
    schemaVersion: job.schemaVersion,
    jobId: job.jobId,
    runId: job.runId,
    itemId: job.itemId,
    attemptId: job.attemptId,
    attemptNo: job.attemptNo,
    revision: job.revision,
    resourceClass: job.resourceClass,
    state: job.state,
    snapshot: {
      media: copyMedia(job.snapshot.media),
      plannedRelativePath: job.snapshot.plannedRelativePath,
      quality: copyQuality(job.snapshot.quality),
      ...(job.snapshot.headerLeaseId === undefined
        ? {}
        : { headerLeaseId: job.snapshot.headerLeaseId }),
    },
    ...(job.progress === undefined ? {} : { progress: { ...job.progress } }),
    ...(job.quotaReservationId === undefined
      ? {}
      : { quotaReservationId: job.quotaReservationId }),
    ...(job.downloadId === undefined ? {} : { downloadId: job.downloadId }),
    ...(job.result === undefined ? {} : { result: { ...job.result } }),
    ...(job.error === undefined ? {} : { error: { ...job.error } }),
  };
}

function isWebmSnapshot(media: MediaSnapshotV1): boolean {
  if (media.kind !== "direct") return false;
  if (media.contentType?.split(";")[0].trim().toLowerCase() === "video/webm") return true;
  try {
    return new URL(media.url).pathname.split(".").pop()?.toLowerCase() === "webm";
  } catch {
    return false;
  }
}

function resourceClassFor(media: MediaSnapshotV1): CaptureJobV1["resourceClass"] {
  return media.kind === "hls" || media.kind === "dash" || isWebmSnapshot(media)
    ? "heavy"
    : "native";
}

function assertExecutableQuality(media: MediaSnapshotV1, quality: QualityChoiceV1, itemId: string): void {
  if (isPersistentStreamQualityChoiceV1(quality)) {
    if (
      (media.kind !== "hls" && media.kind !== "dash") ||
      quality.selector.kind !== media.kind
    ) {
      throw new CaptureExecutorError(
        "invalid_quality",
        "A stream item must freeze an opaque selector for the same manifest kind.",
        itemId,
      );
    }
    return;
  }
  if (media.kind === "hls") {
    let validVariantUrl = false;
    if (quality.mode === "stream" && quality.variantKind === "hls") {
      try {
        const parsed = new URL(quality.variantUrl);
        validVariantUrl = parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        validVariantUrl = false;
      }
    }
    if (!validVariantUrl) {
      throw new CaptureExecutorError(
        "invalid_quality",
        "A ready HLS item must freeze one concrete HTTP(S) variant URL.",
        itemId,
      );
    }
    return;
  }
  if (media.kind === "dash") {
    if (
      quality.mode !== "stream" ||
      quality.variantKind !== "dash" ||
      quality.representationId.trim().length === 0
    ) {
      throw new CaptureExecutorError(
        "invalid_quality",
        "A ready DASH item must freeze one concrete representation id.",
        itemId,
      );
    }
    return;
  }
  if (quality.mode !== "direct") {
    throw new CaptureExecutorError(
      "invalid_quality",
      "A direct file or image cannot carry a stream variant choice.",
      itemId,
    );
  }
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/** Synchronous SHA-256 keeps persisted identifiers bounded without a runtime API dependency. */
function sha256Hex(value: string): string {
  const source = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(source);
  padded[source.length] = 0x80;

  const view = new DataView(padded.buffer);
  const bitLength = source.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array(SHA_256_INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 =
        rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 =
        rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];
    for (let index = 0; index < 64; index += 1) {
      const upperE = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + upperE + choose + SHA_256_ROUNDS[index] + words[index]) >>> 0;
      const upperA = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (upperA + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

function deterministicAttemptIds(runId: string, itemId: string): { jobId: string; attemptId: string } {
  const jobDigest = sha256Hex(JSON.stringify(["cliphutch-capture-job-v1", runId, itemId]));
  const attemptDigest = sha256Hex(
    JSON.stringify(["cliphutch-capture-attempt-v1", runId, itemId, 1]),
  );
  return {
    jobId: `capture-job:v1:${jobDigest}`,
    attemptId: `capture-attempt:v1:${attemptDigest}`,
  };
}

/**
 * Freezes every included, ready review entry into a first-attempt prepared job.
 * Input order is retained and only contract-approved snapshot fields are copied.
 */
export function prepareCaptureJobs(
  plan: CaptureReviewPlanV1,
  options: PrepareCaptureJobsOptions,
): CaptureJobV1[] {
  // Diagnose the executor-specific failures before the broader persisted-plan
  // guard collapses them into `invalid_plan`. The full guard still runs before
  // any job is created, so this preflight never weakens the trust boundary.
  const rawItems = (plan as unknown as { items?: unknown })?.items;
  if (Array.isArray(rawItems)) {
    const preflightItems = new Set<string>();
    const preflightPaths = new Set<string>();
    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const item = rawItem as Partial<CaptureReviewPlanV1["items"][number]>;
      if (item.include !== true) continue;
      const itemId = typeof item.itemId === "string" ? item.itemId : undefined;
      if (itemId) {
        if (preflightItems.has(itemId)) {
          throw new CaptureExecutorError(
            "duplicate_item",
            "The review contains a duplicate item.",
            itemId,
          );
        }
        preflightItems.add(itemId);
      }
      if (item.readiness !== "ready") {
        throw new CaptureExecutorError(
          "unready_item",
          "Every included item must be ready before job preparation.",
          itemId,
        );
      }
      if (typeof item.plannedRelativePath === "string") {
        if (!isSafeRelativeDownloadPath(item.plannedRelativePath)) {
          throw new CaptureExecutorError(
            "invalid_path",
            "The reviewed output path is not Downloads-relative and safe.",
            itemId,
          );
        }
        const pathKey = item.plannedRelativePath.normalize("NFC").toLocaleLowerCase("en-US");
        if (preflightPaths.has(pathKey)) {
          throw new CaptureExecutorError(
            "duplicate_path",
            "Two included items resolve to the same reviewed output path.",
            itemId,
          );
        }
        preflightPaths.add(pathKey);
      }
      if (itemId && item.media && item.qualityChoice) {
        assertExecutableQuality(item.media, item.qualityChoice, itemId);
      }
    }
  }
  if (!isCaptureReviewPlanV1(plan)) {
    throw new CaptureExecutorError("invalid_plan", "The capture review plan is invalid.");
  }
  if (typeof options.runId !== "string" || options.runId.trim().length === 0) {
    throw new CaptureExecutorError("invalid_run_id", "A non-empty run identifier is required.");
  }

  const seenItems = new Set<string>();
  const seenPaths = new Set<string>();
  const seenJobIds = new Set<string>();
  const seenAttemptIds = new Set<string>();
  const jobs: CaptureJobV1[] = [];

  for (const item of plan.items) {
    if (!item.include) continue;
    if (seenItems.has(item.itemId)) {
      throw new CaptureExecutorError("duplicate_item", "The review contains a duplicate item.", item.itemId);
    }
    seenItems.add(item.itemId);

    if (item.readiness !== "ready") {
      throw new CaptureExecutorError(
        "unready_item",
        "Every included item must be ready before job preparation.",
        item.itemId,
      );
    }
    if (!isSafeRelativeDownloadPath(item.plannedRelativePath)) {
      throw new CaptureExecutorError(
        "invalid_path",
        "The reviewed output path is not Downloads-relative and safe.",
        item.itemId,
      );
    }
    const pathKey = item.plannedRelativePath.normalize("NFC").toLocaleLowerCase("en-US");
    if (seenPaths.has(pathKey)) {
      throw new CaptureExecutorError(
        "duplicate_path",
        "Two included items resolve to the same reviewed output path.",
        item.itemId,
      );
    }
    seenPaths.add(pathKey);
    assertExecutableQuality(item.media, item.qualityChoice, item.itemId);

    const headerLeaseId = options.headerLeaseIdsByItemId?.[item.itemId];
    if (headerLeaseId !== undefined && headerLeaseId.trim().length === 0) {
      throw new CaptureExecutorError(
        "invalid_header_lease",
        "Header lease identifiers must be non-empty.",
        item.itemId,
      );
    }
    const ids = deterministicAttemptIds(options.runId, item.itemId);
    if (seenJobIds.has(ids.jobId) || seenAttemptIds.has(ids.attemptId)) {
      throw new CaptureExecutorError(
        "identifier_collision",
        "Two reviewed items produced the same bounded execution identifier.",
        item.itemId,
      );
    }
    seenJobIds.add(ids.jobId);
    seenAttemptIds.add(ids.attemptId);
    const job: CaptureJobV1 = {
      schemaVersion: 1,
      jobId: ids.jobId,
      runId: options.runId,
      itemId: item.itemId,
      attemptId: ids.attemptId,
      attemptNo: 1,
      revision: 0,
      resourceClass: resourceClassFor(item.media),
      state: "prepared",
      snapshot: {
        media: copyMedia(item.media),
        plannedRelativePath: item.plannedRelativePath,
        quality: copyQuality(item.qualityChoice),
        ...(headerLeaseId === undefined ? {} : { headerLeaseId }),
      },
    };
    if (!isCaptureJobV1(job)) {
      throw new CaptureExecutorError(
        "invalid_job",
        "The reviewed item could not produce a valid prepared job.",
        item.itemId,
      );
    }
    jobs.push(job);
  }

  return jobs;
}

type GuardedEvent = { attemptId: string; expectedRevision: number };

export type CaptureJobEvent = GuardedEvent &
  (
    | { type: "queue" }
    | { type: "start" }
    | { type: "running"; downloadId?: number }
    | { type: "processing" }
    | { type: "delivery-ready" }
    | { type: "saving"; downloadId: number }
    | { type: "complete"; actualBasename?: string; sizeBytes?: number }
    | { type: "fail"; code: string; customerMessage: string; retryable: boolean }
    | { type: "request-cancel" }
    | { type: "cancelled" }
    | { type: "save-state-unknown"; code: string; customerMessage: string }
    | {
        type: "progress";
        progress: {
          phase: "fetching" | "processing" | "saving";
          completed?: number;
          total?: number;
          bytes?: number;
          ratio?: number;
        };
      }
  );

export type CaptureJobReductionFailureReason =
  | "invalid_job"
  | "invalid_event"
  | "stale_attempt"
  | "stale_revision"
  | "revision_exhausted"
  | "terminal_immutable"
  | "illegal_transition"
  | "progress_regression";

export type CaptureJobReductionResult =
  | { ok: true; changed: boolean; job: CaptureJobV1 }
  | {
      ok: false;
      reason: CaptureJobReductionFailureReason;
      job: CaptureJobV1;
      currentRevision: number;
      currentAttemptId: string;
    };

function reductionFailure(
  reason: CaptureJobReductionFailureReason,
  job: CaptureJobV1,
): CaptureJobReductionResult {
  return {
    ok: false,
    reason,
    job: copyJob(job),
    currentRevision: job.revision,
    currentAttemptId: job.attemptId,
  };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedNonEmptyText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function validProgressNumber(value: unknown, ratio = false): value is number | undefined {
  if (value === undefined) return true;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  return ratio ? value <= 1 : Number.isSafeInteger(value);
}

function eventIsValid(event: CaptureJobEvent): boolean {
  if (
    !event ||
    typeof event !== "object" ||
    !isBoundedNonEmptyText(event.attemptId, 512) ||
    !isSafeInteger(event.expectedRevision)
  ) {
    return false;
  }
  switch (event.type) {
    case "queue":
    case "start":
    case "processing":
    case "delivery-ready":
    case "request-cancel":
    case "cancelled":
      return true;
    case "running":
      return event.downloadId === undefined || isSafeInteger(event.downloadId);
    case "saving":
      return isSafeInteger(event.downloadId);
    case "complete":
      return (
        (event.actualBasename === undefined ||
          (isBoundedNonEmptyText(event.actualBasename, 255) &&
            !/[\\/]/.test(event.actualBasename))) &&
        (event.sizeBytes === undefined || isSafeInteger(event.sizeBytes))
      );
    case "fail":
      return (
        isBoundedNonEmptyText(event.code, 80) &&
        isBoundedNonEmptyText(event.customerMessage, 500) &&
        typeof event.retryable === "boolean"
      );
    case "save-state-unknown":
      return (
        isBoundedNonEmptyText(event.code, 80) &&
        isBoundedNonEmptyText(event.customerMessage, 500)
      );
    case "progress": {
      const progress = event.progress;
      if (!progress || typeof progress !== "object") return false;
      if (progress.phase !== "fetching" && progress.phase !== "processing" && progress.phase !== "saving") {
        return false;
      }
      if (
        !validProgressNumber(progress.completed) ||
        !validProgressNumber(progress.total) ||
        !validProgressNumber(progress.bytes) ||
        !validProgressNumber(progress.ratio, true)
      ) {
        return false;
      }
      return (
        progress.completed === undefined ||
        progress.total === undefined ||
        progress.completed <= progress.total
      );
    }
    default:
      return false;
  }
}

function targetForEvent(job: CaptureJobV1, event: CaptureJobEvent): CaptureJobStateV1 | undefined {
  switch (event.type) {
    case "queue":
      return "queued";
    case "start":
      return "starting";
    case "running":
      return "running";
    case "processing":
      return "processing";
    case "delivery-ready":
      return "delivery_pending";
    case "saving":
      return "saving";
    case "complete":
      return "complete";
    case "fail":
      return "failed";
    case "request-cancel":
      return job.state === "prepared" || job.state === "queued" ? "cancelled" : "cancelling";
    case "cancelled":
      return "cancelled";
    case "save-state-unknown":
      return "save_state_unknown";
    case "progress":
      return job.state;
  }
}

function eventProgressPhaseForState(
  state: CaptureJobStateV1,
): "fetching" | "processing" | "saving" | undefined {
  if (state === "running") return "fetching";
  if (state === "processing") return "processing";
  if (state === "saving") return "saving";
  return undefined;
}

function sameProgress(
  left: CaptureJobV1["progress"],
  right: CaptureJobV1["progress"],
): boolean {
  return (
    left?.phase === right?.phase &&
    left?.completed === right?.completed &&
    left?.total === right?.total &&
    left?.bytes === right?.bytes &&
    left?.ratio === right?.ratio
  );
}

function mergeProgress(
  current: CaptureJobV1["progress"],
  incoming: Extract<CaptureJobEvent, { type: "progress" }>["progress"],
): CaptureJobV1["progress"] | undefined {
  if (current?.phase !== incoming.phase) return undefined;
  const merged = {
    phase: incoming.phase,
    completed: incoming.completed ?? current.completed,
    total: incoming.total ?? current.total,
    bytes: incoming.bytes ?? current.bytes,
    ratio: incoming.ratio ?? current.ratio,
  };
  for (const field of ["completed", "total", "bytes", "ratio"] as const) {
    const before = current[field];
    const after = merged[field];
    if (before !== undefined && after !== undefined && after < before) return undefined;
  }
  if (
    merged.completed !== undefined &&
    merged.total !== undefined &&
    merged.completed > merged.total
  ) {
    return undefined;
  }
  return merged;
}

function nextRevision(job: CaptureJobV1): number | undefined {
  return job.revision < Number.MAX_SAFE_INTEGER ? job.revision + 1 : undefined;
}

function applyStatePayload(
  job: CaptureJobV1,
  target: CaptureJobStateV1,
  event: Exclude<CaptureJobEvent, { type: "progress" }>,
): CaptureJobV1 {
  const next = copyJob(job);
  next.state = target;
  delete next.error;
  delete next.result;

  if (target === "queued") {
    next.progress = { phase: "queued" };
    delete next.downloadId;
  } else if (target === "starting") {
    delete next.progress;
    delete next.downloadId;
  } else if (target === "running") {
    next.progress = { phase: "fetching" };
    if (event.type === "running" && event.downloadId !== undefined) {
      next.downloadId = event.downloadId;
    } else {
      delete next.downloadId;
    }
  } else if (target === "processing") {
    next.progress = { phase: "processing" };
    delete next.downloadId;
  } else if (target === "delivery_pending") {
    delete next.progress;
    delete next.downloadId;
  } else if (target === "saving") {
    next.progress = { phase: "saving" };
    if (event.type === "saving") next.downloadId = event.downloadId;
  } else if (target === "complete") {
    delete next.progress;
    if (event.type === "complete") {
      next.result = {
        ...(event.actualBasename === undefined ? {} : { actualBasename: event.actualBasename }),
        ...(event.sizeBytes === undefined ? {} : { sizeBytes: event.sizeBytes }),
      };
    }
  } else if (target === "failed") {
    delete next.progress;
    if (event.type === "fail") {
      next.error = {
        code: event.code,
        customerMessage: event.customerMessage,
        retryable: event.retryable,
      };
    }
  } else if (target === "cancelling") {
    // Preserve current progress and downloadId while the exact execution aborts.
  } else if (target === "cancelled") {
    delete next.progress;
  } else if (target === "save_state_unknown") {
    delete next.progress;
    if (event.type === "save-state-unknown") {
      next.error = {
        code: event.code,
        customerMessage: event.customerMessage,
        retryable: false,
      };
    }
  }
  return next;
}

/**
 * Applies one attempt-scoped event without mutating either input object.
 * `job` is a storage-decoded CaptureJobV1; the event still passes a runtime
 * allowlist before any transition is attempted.
 */
export function reduceCaptureJob(
  job: CaptureJobV1,
  event: CaptureJobEvent,
): CaptureJobReductionResult {
  if (!isCaptureJobV1(job)) return reductionFailure("invalid_job", job);
  if (!eventIsValid(event)) return reductionFailure("invalid_event", job);
  if (event.attemptId !== job.attemptId) return reductionFailure("stale_attempt", job);
  if (event.expectedRevision !== job.revision) return reductionFailure("stale_revision", job);
  if (TERMINAL_STATES.has(job.state)) return reductionFailure("terminal_immutable", job);

  const revision = nextRevision(job);
  if (revision === undefined) return reductionFailure("revision_exhausted", job);

  if (event.type === "progress") {
    const expectedPhase = eventProgressPhaseForState(job.state);
    if (expectedPhase === undefined || event.progress.phase !== expectedPhase) {
      return reductionFailure("illegal_transition", job);
    }
    const progress = mergeProgress(job.progress, event.progress);
    if (!progress) return reductionFailure("progress_regression", job);
    if (sameProgress(job.progress, progress)) {
      return { ok: true, changed: false, job: copyJob(job) };
    }
    const next = copyJob(job);
    next.revision = revision;
    next.progress = progress;
    return { ok: true, changed: true, job: next };
  }

  const target = targetForEvent(job, event);
  if (!target || !LEGAL_CAPTURE_JOB_TRANSITIONS[job.state].includes(target)) {
    return reductionFailure("illegal_transition", job);
  }
  const next = applyStatePayload(job, target, event);
  next.revision = revision;
  if (!isCaptureJobV1(next)) return reductionFailure("invalid_event", job);
  return { ok: true, changed: true, job: next };
}

export type CaptureJobClaim = {
  jobId: string;
  attemptId: string;
  expectedRevision: number;
  resourceClass: CaptureJobV1["resourceClass"];
};

export type CaptureFifoClaimResult = {
  claims: CaptureJobClaim[];
  occupiedBeforeClaim: { heavy: number; native: number };
  occupiedAfterClaim: { heavy: number; native: number };
};

/**
 * Claims queued work in caller-supplied FIFO order. The result is intentionally
 * side-effect free; callers persist each claim through a guarded `start` event.
 */
export function claimCaptureJobsFifo(jobs: readonly CaptureJobV1[]): CaptureFifoClaimResult {
  const seenJobIds = new Set<string>();
  let heavy = 0;
  let native = 0;

  for (const job of jobs) {
    if (!isCaptureJobV1(job)) {
      throw new CaptureExecutorError("invalid_job", "The FIFO contains an invalid job.");
    }
    if (seenJobIds.has(job.jobId)) {
      throw new CaptureExecutorError("duplicate_job", "The FIFO contains a duplicate job identifier.");
    }
    seenJobIds.add(job.jobId);
    if (!SLOT_HOLDING_STATES.has(job.state)) continue;
    if (job.resourceClass === "heavy") heavy += 1;
    else native += 1;
  }

  if (heavy > MAX_ACTIVE_HEAVY_CAPTURE_JOBS || native > MAX_ACTIVE_NATIVE_CAPTURE_JOBS) {
    throw new CaptureExecutorError(
      "lane_overcommitted",
      "The FIFO already exceeds a capture executor lane limit.",
    );
  }

  const occupiedBeforeClaim = { heavy, native };
  const claims: CaptureJobClaim[] = [];
  for (const job of jobs) {
    if (job.state !== "queued") continue;
    if (job.resourceClass === "heavy") {
      if (heavy >= MAX_ACTIVE_HEAVY_CAPTURE_JOBS) continue;
      heavy += 1;
    } else {
      if (native >= MAX_ACTIVE_NATIVE_CAPTURE_JOBS) continue;
      native += 1;
    }
    claims.push({
      jobId: job.jobId,
      attemptId: job.attemptId,
      expectedRevision: job.revision,
      resourceClass: job.resourceClass,
    });
  }

  return {
    claims,
    occupiedBeforeClaim,
    occupiedAfterClaim: { heavy, native },
  };
}
