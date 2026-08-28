/**
 * Background-only orchestration for accepting one reviewed Capture Pack.
 *
 * The durable acceptance boundary is commitInitialCaptureRun: quota may be
 * compensated before that boundary, but an ambiguous or successful commit is
 * always reported as accepted so callers do not create a duplicate run.
 */
import {
  prepareCaptureJobs,
  reduceCaptureJob,
  type CaptureJobReductionResult,
} from "./capture-executor";
import {
  isCaptureJobV1,
  isCaptureReviewPlanV1,
  type CaptureJobV1,
  type CaptureReviewPlanV1,
  type CaptureRunV1,
} from "./capture-pack-types";
import {
  commitInitialCaptureRun,
  getCaptureCommandRecord,
  getCaptureJob,
  getCaptureRun,
  listCaptureRuns,
  mutateCaptureJob,
  type CaptureCommandRecordV1,
  type CaptureRunStorageFailure,
} from "./capture-run-storage";
import {
  FREE_DOWNLOAD_LIMIT,
  markDownloadBatchAccepted,
  releaseDownloadReservations,
  reserveDownloads,
  type DownloadBatchReservation,
} from "./rate-limit";
import {
  canonicalizeCaptureHeaderLeaseIdsByItemId,
  type CaptureHeaderLeaseIdsByItemId,
} from "./capture-plan-options";
import {
  createCaptureManifestSeed,
  type CaptureManifestSeedV1,
} from "./capture-manifest-seed";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RUN_ID_LENGTH = 128;
const ACTIVE_RUN_STATUSES = new Set<CaptureRunV1["status"]>(["queued", "running"]);

export type CaptureRunCoordinatorDependencies = {
  prepareCaptureJobs: typeof prepareCaptureJobs;
  reduceCaptureJob: typeof reduceCaptureJob;
  reserveDownloads: typeof reserveDownloads;
  releaseDownloadReservations: typeof releaseDownloadReservations;
  commitInitialCaptureRun: typeof commitInitialCaptureRun;
  getCaptureCommandRecord: typeof getCaptureCommandRecord;
  getCaptureRun: typeof getCaptureRun;
  listCaptureRuns: typeof listCaptureRuns;
  getCaptureJob: typeof getCaptureJob;
  mutateCaptureJob: typeof mutateCaptureJob;
  markDownloadBatchAccepted: typeof markDownloadBatchAccepted;
};

const DEFAULT_DEPENDENCIES: CaptureRunCoordinatorDependencies = {
  prepareCaptureJobs,
  reduceCaptureJob,
  reserveDownloads,
  releaseDownloadReservations,
  commitInitialCaptureRun,
  getCaptureCommandRecord,
  getCaptureRun,
  listCaptureRuns,
  getCaptureJob,
  mutateCaptureJob,
  markDownloadBatchAccepted,
};

export type EnqueueCaptureRunInput = {
  plan: CaptureReviewPlanV1;
  commandId: string;
  licensed: boolean;
  runId: string;
  now: number;
  /** Background-only lease bindings; omission is the canonical empty map. */
  headerLeaseIdsByItemId?: CaptureHeaderLeaseIdsByItemId;
};

export type CaptureRunQueueIssue = {
  stage: "read_run" | "read_job" | "queue_job" | "commit" | "quota";
  code: string;
  jobId?: string;
};

export type ReconcileCaptureRunResult =
  | {
      ok: true;
      run: CaptureRunV1;
      queuedJobIds: string[];
      advancedJobIds: string[];
      remainingPreparedJobIds: string[];
      issues: CaptureRunQueueIssue[];
      recoveryNeeded: boolean;
    }
  | {
      ok: false;
      runId: string;
      reason: "run_not_found" | "storage_failure";
      issues: CaptureRunQueueIssue[];
    };

export type EnqueueCaptureRunAcceptedResult = {
  ok: true;
  accepted: true;
  runId: string;
  replayed: boolean;
  disposition: "accepted" | "recovery_needed" | "commit_state_unknown";
  queuedJobIds: string[];
  advancedJobIds: string[];
  remainingPreparedJobIds: string[];
  issues: CaptureRunQueueIssue[];
};

export type EnqueueCaptureRunRejectedResult = {
  ok: false;
  accepted: false;
  reason:
    | "invalid_input"
    | "invalid_plan"
    | "plan_not_ready"
    | "quota_unavailable"
    | "quota_failure"
    | "command_conflict"
    | "storage_failure"
    | "commit_failure";
  code: string;
  releaseFailed?: boolean;
};

export type EnqueueCaptureRunResult =
  | EnqueueCaptureRunAcceptedResult
  | EnqueueCaptureRunRejectedResult;

type PreparedInput = {
  planId: string;
  draftId: string;
  draftRevision: number;
  planDigest: string;
  commandId: string;
  licensed: boolean;
  runId: string;
  now: number;
  jobs: CaptureJobV1[];
  videoJobIndexes: number[];
  manifestSeed: CaptureManifestSeedV1 | null;
};

const commandQueues = new Map<string, Promise<unknown>>();

function withCommandQueue<T>(commandId: string, task: () => Promise<T>): Promise<T> {
  const previous = commandQueues.get(commandId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  commandQueues.set(commandId, current);
  return current.finally(() => {
    if (commandQueues.get(commandId) === current) commandQueues.delete(commandId);
  });
}

function storageCode(failure: CaptureRunStorageFailure): string {
  return failure.reason === "conflict"
    ? `${failure.reason}:${failure.conflict}`
    : failure.reason;
}

function rejected(
  reason: EnqueueCaptureRunRejectedResult["reason"],
  code: string,
  releaseFailed = false,
): EnqueueCaptureRunRejectedResult {
  return {
    ok: false,
    accepted: false,
    reason,
    code,
    ...(releaseFailed ? { releaseFailed: true } : {}),
  };
}

type EnqueueEnvelopeRecord = Record<
  "plan" | "commandId" | "licensed" | "runId" | "now" | "headerLeaseIdsByItemId",
  unknown
>;

function readEnqueueEnvelope(value: unknown): EnqueueEnvelopeRecord | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const requiredKeys = ["plan", "commandId", "licensed", "runId", "now"] as const;
    const allowedKeys = new Set([...requiredKeys, "headerLeaseIdsByItemId"]);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    ) return undefined;
    const result = Object.create(null) as EnqueueEnvelopeRecord;
    for (const rawKey of ownKeys) {
      const key = rawKey as keyof EnqueueEnvelopeRecord;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      result[key] = descriptor.value;
    }
    if (!Object.prototype.hasOwnProperty.call(result, "headerLeaseIdsByItemId")) {
      result.headerLeaseIdsByItemId = {};
    } else if (result.headerLeaseIdsByItemId === undefined) {
      return undefined;
    }
    return result;
  } catch {
    return undefined;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function planDigestPayload(
  plan: CaptureReviewPlanV1,
  jobs: CaptureJobV1[],
  manifestSeed: CaptureManifestSeedV1 | null,
): string {
  return JSON.stringify({
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    draftId: plan.draftId,
    draftRevision: plan.draftRevision,
    manifestSpec: plan.manifestSpec ?? null,
    manifestSeed: manifestSeed === null
      ? null
      : {
          packName: manifestSeed.packName,
          relativeRoot: manifestSeed.relativeRoot,
          createdAt: manifestSeed.createdAt,
          formats: manifestSeed.formats,
          items: manifestSeed.items.map(({ jobId: _jobId, ...item }) => item),
        },
    jobs: jobs.map((job) => ({
      itemId: job.itemId,
      resourceClass: job.resourceClass,
      snapshot: job.snapshot,
    })),
  });
}

async function validateAndPrepare(
  input: EnqueueCaptureRunInput,
  dependencies: CaptureRunCoordinatorDependencies,
): Promise<PreparedInput | EnqueueCaptureRunRejectedResult> {
  const envelope = readEnqueueEnvelope(input);
  if (
    !envelope ||
    typeof envelope.commandId !== "string" ||
    !UUID_PATTERN.test(envelope.commandId) ||
    typeof envelope.licensed !== "boolean" ||
    typeof envelope.runId !== "string" ||
    envelope.runId.length === 0 ||
    envelope.runId.length > MAX_RUN_ID_LENGTH ||
    envelope.runId !== envelope.runId.trim() ||
    !Number.isSafeInteger(envelope.now) ||
    (envelope.now as number) < 0
  ) {
    return rejected("invalid_input", "invalid_enqueue_envelope");
  }
  if (!isCaptureReviewPlanV1(envelope.plan)) {
    return rejected("invalid_plan", "invalid_capture_review_plan");
  }
  const plan = envelope.plan;
  const commandId = envelope.commandId;
  const licensed = envelope.licensed;
  const runId = envelope.runId;
  const now = envelope.now as number;

  const headerLeaseIdsByItemId = canonicalizeCaptureHeaderLeaseIdsByItemId(
    plan,
    envelope.headerLeaseIdsByItemId,
  );
  if (!headerLeaseIdsByItemId) {
    return rejected("invalid_input", "invalid_header_lease_map");
  }

  const included = plan.items.filter((item) => item.include);
  if (included.length === 0 || included.some((item) => item.readiness !== "ready")) {
    return rejected("plan_not_ready", "included_items_not_ready");
  }

  let jobs: CaptureJobV1[];
  try {
    jobs = dependencies.prepareCaptureJobs(plan, {
      runId,
      headerLeaseIdsByItemId,
    });
  } catch {
    return rejected("plan_not_ready", "job_preparation_failed");
  }

  if (
    jobs.length !== included.length ||
    jobs.some(
      (job, index) =>
        !isCaptureJobV1(job) ||
        job.runId !== runId ||
        job.itemId !== included[index].itemId ||
        job.snapshot.headerLeaseId !== headerLeaseIdsByItemId[job.itemId] ||
        job.state !== "prepared" ||
        job.revision !== 0,
    )
  ) {
    return rejected("invalid_plan", "prepared_jobs_do_not_match_plan");
  }

  const videoJobIndexes = jobs.flatMap((job, index) =>
    job.snapshot.media.kind === "image" ? [] : [index],
  );
  if (
    videoJobIndexes.length !== plan.totals.videos ||
    videoJobIndexes.length !== plan.totals.requiredFreeVideoSlots
  ) {
    return rejected("invalid_plan", "video_slot_total_mismatch");
  }
  const manifest = createCaptureManifestSeed({ runId, plan, jobs });
  if (!manifest.ok) {
    return rejected("invalid_plan", `manifest_seed_${manifest.reason}`);
  }
  let planDigest: string;
  try {
    planDigest = await sha256Hex(planDigestPayload(plan, jobs, manifest.seed));
  } catch {
    return rejected("invalid_plan", "plan_digest_failed");
  }
  return {
    planId: plan.planId,
    draftId: plan.draftId,
    draftRevision: plan.draftRevision,
    planDigest,
    commandId,
    licensed,
    runId,
    now,
    jobs,
    videoJobIndexes,
    manifestSeed: manifest.seed,
  };
}

function validReservation(
  reservation: DownloadBatchReservation,
  commandId: string,
  count: number,
): boolean {
  try {
    return (
      reservation !== null &&
      typeof reservation === "object" &&
      reservation.batchId === commandId &&
      reservation.count === count &&
      Number.isSafeInteger(reservation.reservedAt) &&
      reservation.reservedAt >= 0 &&
      Array.isArray(reservation.reservations) &&
      reservation.reservations.length === count &&
      reservation.reservations.every(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          entry.id.length > 0 &&
          entry.id.length <= 256,
      ) &&
      new Set(reservation.reservations.map((entry) => entry.id)).size === count
    );
  } catch {
    return false;
  }
}

function attachReservations(
  jobs: CaptureJobV1[],
  videoJobIndexes: number[],
  reservation: DownloadBatchReservation,
): CaptureJobV1[] {
  const reservationByJobIndex = new Map(
    videoJobIndexes.map((jobIndex, reservationIndex) => [
      jobIndex,
      reservation.reservations[reservationIndex].id,
    ]),
  );
  return jobs.map((job, index) => {
    const quotaReservationId = reservationByJobIndex.get(index);
    return quotaReservationId === undefined ? job : { ...job, quotaReservationId };
  });
}

async function compensateReservation(
  reservation: DownloadBatchReservation | string | undefined,
  now: number,
  dependencies: CaptureRunCoordinatorDependencies,
): Promise<boolean> {
  if (reservation === undefined) return false;
  try {
    await dependencies.releaseDownloadReservations(reservation, now);
    return false;
  } catch {
    return true;
  }
}

function acceptedUnknown(
  runId: string,
  code: string,
  replayed = false,
): EnqueueCaptureRunAcceptedResult {
  return {
    ok: true,
    accepted: true,
    runId,
    replayed,
    disposition: "commit_state_unknown",
    queuedJobIds: [],
    advancedJobIds: [],
    remainingPreparedJobIds: [],
    issues: [{ stage: "commit", code }],
  };
}

function acceptedFromReconciliation(
  runId: string,
  replayed: boolean,
  reconciliation: ReconcileCaptureRunResult,
): EnqueueCaptureRunAcceptedResult {
  if (!reconciliation.ok) {
    return {
      ok: true,
      accepted: true,
      runId,
      replayed,
      disposition: "recovery_needed",
      queuedJobIds: [],
      advancedJobIds: [],
      remainingPreparedJobIds: [],
      issues: reconciliation.issues,
    };
  }
  return {
    ok: true,
    accepted: true,
    runId,
    replayed,
    disposition: reconciliation.recoveryNeeded ? "recovery_needed" : "accepted",
    queuedJobIds: reconciliation.queuedJobIds,
    advancedJobIds: reconciliation.advancedJobIds,
    remainingPreparedJobIds: reconciliation.remainingPreparedJobIds,
    issues: reconciliation.issues,
  };
}

async function acceptedExistingRun(
  run: CaptureRunV1,
  expected: Pick<PreparedInput, "planId" | "draftId" | "draftRevision" | "planDigest">,
  dependencies: CaptureRunCoordinatorDependencies,
): Promise<EnqueueCaptureRunResult> {
  if (
    run.planId !== expected.planId ||
    run.draftId !== expected.draftId ||
    run.draftRevision !== expected.draftRevision ||
    run.planDigest !== expected.planDigest
  ) {
    return rejected("command_conflict", "command_reused_for_another_plan");
  }
  const reconciliation = await reconcileCaptureRunQueue(run.runId, dependencies);
  return acceptedFromReconciliation(run.runId, true, reconciliation);
}

function commandRecordMatchesPrepared(
  record: CaptureCommandRecordV1,
  prepared: PreparedInput,
): boolean {
  return (
    record.planId === prepared.planId &&
    record.draftId === prepared.draftId &&
    record.draftRevision === prepared.draftRevision &&
    record.planDigest === prepared.planDigest
  );
}

async function acceptQuotaBatch(
  prepared: PreparedInput,
  dependencies: CaptureRunCoordinatorDependencies,
): Promise<CaptureRunQueueIssue | undefined> {
  if (prepared.licensed || prepared.videoJobIndexes.length === 0) return undefined;
  try {
    await dependencies.markDownloadBatchAccepted(prepared.commandId, prepared.now);
    return undefined;
  } catch {
    return { stage: "quota", code: "quota_acceptance_reconciliation_needed" };
  }
}

async function acceptedExistingCommand(
  record: CaptureCommandRecordV1,
  prepared: PreparedInput,
  dependencies: CaptureRunCoordinatorDependencies,
): Promise<EnqueueCaptureRunResult> {
  if (!commandRecordMatchesPrepared(record, prepared)) {
    return rejected("command_conflict", "command_reused_for_another_plan");
  }
  const quotaIssue = await acceptQuotaBatch(prepared, dependencies);
  const owner = await getConflictingRun(record.runId, dependencies);
  if (owner === undefined) return acceptedUnknown(record.runId, "command_owner_read_failed", true);
  if (owner === null) {
    if (record.state === "pending") {
      return acceptedUnknown(record.runId, "pending_command_owner_missing", true);
    }
    return {
      ok: true,
      accepted: true,
      runId: record.runId,
      replayed: true,
      disposition: quotaIssue ? "recovery_needed" : "accepted",
      queuedJobIds: [],
      advancedJobIds: [],
      remainingPreparedJobIds: [],
      issues: quotaIssue ? [quotaIssue] : [],
    };
  }
  const accepted = await acceptedExistingRun(owner, prepared, dependencies);
  if (quotaIssue && accepted.ok) {
    return {
      ...accepted,
      disposition: "recovery_needed",
      issues: [...accepted.issues, quotaIssue],
    };
  }
  return accepted;
}

async function getConflictingRun(
  runId: string,
  dependencies: CaptureRunCoordinatorDependencies,
): Promise<CaptureRunV1 | null | undefined> {
  try {
    const result = await dependencies.getCaptureRun(runId);
    return result.ok ? result.run : undefined;
  } catch {
    return undefined;
  }
}

async function readBackThrownCommit(
  run: CaptureRunV1,
  jobs: CaptureJobV1[],
  dependencies: CaptureRunCoordinatorDependencies,
): Promise<"absent" | "present" | "unknown"> {
  try {
    const command = await dependencies.getCaptureCommandRecord(run.commandId);
    if (!command.ok) return "unknown";
    if (command.record) return "present";
    const storedRun = await dependencies.getCaptureRun(run.runId);
    if (!storedRun.ok) return "unknown";
    if (storedRun.run) return "present";
    const storedJobs = await Promise.all(jobs.map((job) => dependencies.getCaptureJob(job.jobId)));
    if (storedJobs.some((read) => !read.ok)) return "unknown";
    return storedJobs.every((read) => read.ok && read.job === null) ? "absent" : "present";
  } catch {
    return "unknown";
  }
}

async function enqueuePreparedCaptureRun(
  prepared: PreparedInput,
  dependencies: CaptureRunCoordinatorDependencies,
): Promise<EnqueueCaptureRunResult> {
  let commandRead;
  try {
    commandRead = await dependencies.getCaptureCommandRecord(prepared.commandId);
  } catch {
    return rejected("storage_failure", "command_ledger_read_threw");
  }
  if (!commandRead.ok) return rejected("storage_failure", storageCode(commandRead));
  if (commandRead.record) {
    return acceptedExistingCommand(commandRead.record, prepared, dependencies);
  }

  let listed;
  try {
    listed = await dependencies.listCaptureRuns();
  } catch {
    return rejected("storage_failure", "run_index_read_threw");
  }
  if (!listed.ok) return rejected("storage_failure", storageCode(listed));

  const commandOwners = listed.runs.filter((run) => run.commandId === prepared.commandId);
  if (commandOwners.length > 1) {
    return rejected("storage_failure", "duplicate_command_owners");
  }
  if (commandOwners.length === 1) {
    return acceptedExistingRun(commandOwners[0], prepared, dependencies);
  }

  if (!prepared.licensed && prepared.videoJobIndexes.length > FREE_DOWNLOAD_LIMIT) {
    return rejected("quota_unavailable", "free_allocation_exceeds_limit");
  }

  let reservation: DownloadBatchReservation | undefined;
  if (!prepared.licensed && prepared.videoJobIndexes.length > 0) {
    try {
      const reserved = await dependencies.reserveDownloads(
        prepared.commandId,
        prepared.videoJobIndexes.length,
        prepared.now,
      );
      if (reserved === null) return rejected("quota_unavailable", "free_video_slots_unavailable");
      reservation = reserved;
    } catch {
      const releaseFailed = await compensateReservation(
        prepared.commandId,
        prepared.now,
        dependencies,
      );
      return rejected("quota_failure", "quota_reservation_failed", releaseFailed);
    }
    if (!validReservation(reservation, prepared.commandId, prepared.videoJobIndexes.length)) {
      const releaseFailed = await compensateReservation(
        prepared.commandId,
        prepared.now,
        dependencies,
      );
      return rejected("quota_failure", "invalid_quota_reservation", releaseFailed);
    }
  }

  const jobs = reservation
    ? attachReservations(prepared.jobs, prepared.videoJobIndexes, reservation)
    : prepared.jobs;
  const run: CaptureRunV1 = {
    schemaVersion: 1,
    runId: prepared.runId,
    planId: prepared.planId,
    draftId: prepared.draftId,
    draftRevision: prepared.draftRevision,
    planDigest: prepared.planDigest,
    commandId: prepared.commandId,
    createdAt: prepared.now,
    status: "queued",
    orderedJobIds: jobs.map((job) => job.jobId),
  };

  let committed;
  try {
    committed = await dependencies.commitInitialCaptureRun(run, jobs, prepared.manifestSeed);
  } catch {
    const readBack = await readBackThrownCommit(run, jobs, dependencies);
    if (readBack === "absent") {
      const releaseFailed = await compensateReservation(reservation, prepared.now, dependencies);
      return rejected("commit_failure", "commit_threw_but_absence_proved", releaseFailed);
    }
    if (readBack === "present") {
      const command = await dependencies.getCaptureCommandRecord(prepared.commandId).catch(() => undefined);
      if (command?.ok && command.record) {
        return acceptedExistingCommand(command.record, prepared, dependencies);
      }
    }
    return acceptedUnknown(run.runId, "commit_threw");
  }

  if (committed.ok) {
    const quotaIssue = await acceptQuotaBatch(prepared, dependencies);
    const reconciliation = await reconcileCaptureRunQueue(committed.run.runId, dependencies);
    const accepted = acceptedFromReconciliation(committed.run.runId, !committed.changed, reconciliation);
    return quotaIssue
      ? {
          ...accepted,
          disposition: "recovery_needed",
          issues: [...accepted.issues, quotaIssue],
        }
      : accepted;
  }

  if (committed.reason === "storage_unavailable" && committed.committed) {
    return acceptedUnknown(run.runId, `commit_${storageCode(committed)}`);
  }

  if (committed.reason === "conflict" && committed.conflict === "command_exists") {
    const command = await dependencies.getCaptureCommandRecord(prepared.commandId).catch(() => undefined);
    if (command?.ok && command.record) {
      return acceptedExistingCommand(command.record, prepared, dependencies);
    }
    const owner = await getConflictingRun(committed.id, dependencies);
    if (owner === undefined || owner === null) {
      return acceptedUnknown(committed.id, "command_owner_read_failed", true);
    }
    return acceptedExistingRun(owner, prepared, dependencies);
  }

  if (committed.reason === "conflict" && committed.conflict === "run_exists") {
    const owner = await getConflictingRun(committed.id, dependencies);
    if (owner?.commandId === prepared.commandId) {
      return acceptedExistingRun(owner, prepared, dependencies);
    }
  }

  const releaseFailed = await compensateReservation(reservation, prepared.now, dependencies);
  return rejected("commit_failure", storageCode(committed), releaseFailed);
}

function issueForFailure(
  stage: CaptureRunQueueIssue["stage"],
  failure: CaptureRunStorageFailure,
  jobId?: string,
): CaptureRunQueueIssue {
  return { stage, code: storageCode(failure), ...(jobId === undefined ? {} : { jobId }) };
}

async function readJobAfterConflict(
  jobId: string,
  dependencies: CaptureRunCoordinatorDependencies,
): Promise<CaptureJobV1 | CaptureRunQueueIssue> {
  try {
    const read = await dependencies.getCaptureJob(jobId);
    if (!read.ok) return issueForFailure("read_job", read, jobId);
    if (!read.job) return { stage: "read_job", code: "job_missing", jobId };
    return read.job;
  } catch {
    return { stage: "read_job", code: "job_read_threw", jobId };
  }
}

function isIssue(value: CaptureJobV1 | CaptureRunQueueIssue): value is CaptureRunQueueIssue {
  return "stage" in value;
}

async function queuePreparedJob(
  initial: CaptureJobV1,
  dependencies: CaptureRunCoordinatorDependencies,
): Promise<CaptureJobV1 | CaptureRunQueueIssue> {
  let current = initial;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (current.state !== "prepared") return current;
    let mutation;
    try {
      mutation = await dependencies.mutateCaptureJob({
        jobId: current.jobId,
        expectedAttemptId: current.attemptId,
        expectedRevision: current.revision,
        mutate: (stored) => {
          const reduced: CaptureJobReductionResult = dependencies.reduceCaptureJob(stored, {
            type: "queue",
            attemptId: stored.attemptId,
            expectedRevision: stored.revision,
          });
          if (!reduced.ok || !reduced.changed) {
            throw new Error(`Queue reduction failed: ${reduced.ok ? "unchanged" : reduced.reason}`);
          }
          return reduced.job;
        },
      });
    } catch {
      return { stage: "queue_job", code: "job_mutation_threw", jobId: current.jobId };
    }
    if (mutation.ok) return mutation.job;
    if (
      mutation.reason !== "conflict" ||
      (mutation.conflict !== "attempt_mismatch" && mutation.conflict !== "revision_mismatch")
    ) {
      return issueForFailure("queue_job", mutation, current.jobId);
    }
    const reread = await readJobAfterConflict(current.jobId, dependencies);
    if (isIssue(reread)) return reread;
    current = reread;
  }
  return current.state === "prepared"
    ? { stage: "queue_job", code: "job_changed_during_reconciliation", jobId: current.jobId }
    : current;
}

/**
 * Idempotently advances all revision-guarded prepared jobs in an active run to
 * queued. Jobs already claimed or terminal are left untouched.
 */
export async function reconcileCaptureRunQueue(
  runId: string,
  dependencies: CaptureRunCoordinatorDependencies = DEFAULT_DEPENDENCIES,
): Promise<ReconcileCaptureRunResult> {
  let runRead;
  try {
    runRead = await dependencies.getCaptureRun(runId);
  } catch {
    return {
      ok: false,
      runId,
      reason: "storage_failure",
      issues: [{ stage: "read_run", code: "run_read_threw" }],
    };
  }
  if (!runRead.ok) {
    return {
      ok: false,
      runId,
      reason: "storage_failure",
      issues: [issueForFailure("read_run", runRead)],
    };
  }
  if (!runRead.run) {
    return {
      ok: false,
      runId,
      reason: "run_not_found",
      issues: [{ stage: "read_run", code: "run_not_found" }],
    };
  }

  const run = runRead.run;
  const queuedJobIds: string[] = [];
  const advancedJobIds: string[] = [];
  const remainingPreparedJobIds: string[] = [];
  const issues: CaptureRunQueueIssue[] = [];

  for (const jobId of run.orderedJobIds) {
    const read = await readJobAfterConflict(jobId, dependencies);
    if (isIssue(read)) {
      issues.push(read);
      continue;
    }
    if (read.runId !== run.runId) {
      issues.push({ stage: "read_job", code: "job_run_mismatch", jobId });
      continue;
    }

    let current = read;
    if (current.state === "prepared") {
      if (!ACTIVE_RUN_STATUSES.has(run.status)) {
        remainingPreparedJobIds.push(jobId);
        issues.push({ stage: "queue_job", code: "terminal_run_has_prepared_job", jobId });
        continue;
      }
      const queued = await queuePreparedJob(current, dependencies);
      if (isIssue(queued)) {
        issues.push(queued);
        const reread = await readJobAfterConflict(jobId, dependencies);
        if (!isIssue(reread) && reread.runId === run.runId) current = reread;
        else {
          remainingPreparedJobIds.push(jobId);
          continue;
        }
      } else {
        current = queued;
      }
    }

    if (current.state === "prepared") remainingPreparedJobIds.push(jobId);
    else if (current.state === "queued") queuedJobIds.push(jobId);
    else advancedJobIds.push(jobId);
  }

  return {
    ok: true,
    run,
    queuedJobIds,
    advancedJobIds,
    remainingPreparedJobIds,
    issues,
    recoveryNeeded: issues.length > 0 || remainingPreparedJobIds.length > 0,
  };
}

/** Accepts one exact reviewed plan, or deterministically replays its command. */
export async function enqueueCaptureRun(
  input: EnqueueCaptureRunInput,
  dependencies: CaptureRunCoordinatorDependencies = DEFAULT_DEPENDENCIES,
): Promise<EnqueueCaptureRunResult> {
  // Claim the command lane before any asynchronous plan hashing. Otherwise a
  // later same-command call with a faster digest can overtake the first call
  // and become the authoritative run. UI requests are already strictly
  // parsed, but keep invalid envelopes out of the shared map.
  const envelope = readEnqueueEnvelope(input);
  if (!envelope || typeof envelope.commandId !== "string" || !UUID_PATTERN.test(envelope.commandId)) {
    return validateAndPrepare(input, dependencies) as Promise<EnqueueCaptureRunRejectedResult>;
  }
  const capturedLeaseIds = isCaptureReviewPlanV1(envelope.plan)
    ? canonicalizeCaptureHeaderLeaseIdsByItemId(
        envelope.plan,
        envelope.headerLeaseIdsByItemId,
      )
    : undefined;
  const capturedInput: EnqueueCaptureRunInput =
    isCaptureReviewPlanV1(envelope.plan) && capturedLeaseIds
      ? {
        plan: envelope.plan,
        commandId: envelope.commandId,
        licensed: envelope.licensed as boolean,
        runId: envelope.runId as string,
        now: envelope.now as number,
        headerLeaseIdsByItemId: capturedLeaseIds,
      }
      : input;
  return withCommandQueue(envelope.commandId, async () => {
    const prepared = await validateAndPrepare(capturedInput, dependencies);
    if ("accepted" in prepared) return prepared;
    return enqueuePreparedCaptureRun(prepared, dependencies);
  });
}

export function createCaptureRunCoordinator(
  dependencies: CaptureRunCoordinatorDependencies = DEFAULT_DEPENDENCIES,
): {
  enqueueCaptureRun: (input: EnqueueCaptureRunInput) => Promise<EnqueueCaptureRunResult>;
  reconcileCaptureRunQueue: (runId: string) => Promise<ReconcileCaptureRunResult>;
} {
  return {
    enqueueCaptureRun: (input) => enqueueCaptureRun(input, dependencies),
    reconcileCaptureRunQueue: (runId) => reconcileCaptureRunQueue(runId, dependencies),
  };
}
