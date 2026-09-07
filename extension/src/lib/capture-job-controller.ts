import {
  reduceCaptureJob,
  type CaptureJobEvent,
  type CaptureJobReductionFailureReason,
} from "./capture-executor";
import {
  getCaptureJob,
  mutateCaptureJob,
  type CaptureRunStorageFailure,
  type MutateCaptureJobResult,
  type ReadCaptureJobResult,
} from "./capture-run-storage";
import type { CaptureJobV1 } from "./capture-pack-types";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type UnguardedCaptureJobEvent = DistributiveOmit<
  CaptureJobEvent,
  "attemptId" | "expectedRevision"
>;

export type CaptureJobControllerDependencies = {
  getJob(jobId: string): Promise<ReadCaptureJobResult>;
  mutateJob(input: {
    jobId: string;
    expectedAttemptId: string;
    expectedRevision: number;
    mutate: (current: CaptureJobV1) => unknown;
  }): Promise<MutateCaptureJobResult>;
};

export type CaptureJobControlResult =
  | { ok: true; changed: boolean; job: CaptureJobV1 }
  | CaptureRunStorageFailure
  | {
      ok: false;
      reason: "job_not_found" | "transition_rejected";
      jobId: string;
      transitionReason?: CaptureJobReductionFailureReason;
      job?: CaptureJobV1;
    };

const DEFAULT_DEPENDENCIES: CaptureJobControllerDependencies = {
  getJob: getCaptureJob,
  mutateJob: mutateCaptureJob,
};

const jobEventQueues = new Map<string, Promise<unknown>>();

function withJobEventQueue<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
  const previous = jobEventQueues.get(jobId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  jobEventQueues.set(jobId, current);
  return current.finally(() => {
    if (jobEventQueues.get(jobId) === current) jobEventQueues.delete(jobId);
  });
}

/**
 * Reads the latest job, scopes an event to its exact attempt/revision, reduces
 * it purely, then commits under the storage adapter's compare-and-swap guard.
 */
export async function applyStoredCaptureJobEvent(
  input: {
    jobId: string;
    attemptId: string;
    event: UnguardedCaptureJobEvent;
  },
  dependencies: CaptureJobControllerDependencies = DEFAULT_DEPENDENCIES,
): Promise<CaptureJobControlResult> {
  return withJobEventQueue(input.jobId, () => applyStoredCaptureJobEventSerialized(input, dependencies));
}

async function applyStoredCaptureJobEventSerialized(
  input: {
    jobId: string;
    attemptId: string;
    event: UnguardedCaptureJobEvent;
  },
  dependencies: CaptureJobControllerDependencies,
): Promise<CaptureJobControlResult> {
  // Progress and terminal events can arrive back-to-back from offscreen. A
  // per-job queue ensures those background-owned events commit in arrival
  // order. The bounded CAS retry remains for recovery/coordinator writes that
  // may have started outside this controller before entering the queue.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await dependencies.getJob(input.jobId);
    if (!read.ok) return read;
    if (!read.job) return { ok: false, reason: "job_not_found", jobId: input.jobId };

    const event = {
      ...input.event,
      attemptId: input.attemptId,
      expectedRevision: read.job.revision,
    } as CaptureJobEvent;
    const reduced = reduceCaptureJob(read.job, event);
    if (!reduced.ok) {
      return {
        ok: false,
        reason: "transition_rejected",
        transitionReason: reduced.reason,
        jobId: input.jobId,
        job: reduced.job,
      };
    }
    if (!reduced.changed) return reduced;

    const mutation = await dependencies.mutateJob({
      jobId: input.jobId,
      expectedAttemptId: input.attemptId,
      expectedRevision: read.job.revision,
      mutate: () => reduced.job,
    });
    if (
      mutation.ok ||
      mutation.reason !== "conflict" ||
      mutation.conflict !== "revision_mismatch"
    ) {
      return mutation;
    }
  }

  const latest = await dependencies.getJob(input.jobId);
  if (!latest.ok) return latest;
  return {
    ok: false,
    reason: "transition_rejected",
    transitionReason: "stale_revision",
    jobId: input.jobId,
    ...(latest.job ? { job: latest.job } : {}),
  };
}
