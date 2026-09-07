import { describe, expect, it, vi } from "vitest";
import {
  applyStoredCaptureJobEvent,
  type CaptureJobControllerDependencies,
} from "./capture-job-controller";
import { CAPTURE_PACK_SCHEMA_VERSION, type CaptureJobV1 } from "./capture-pack-types";

function job(overrides: Partial<CaptureJobV1> = {}): CaptureJobV1 {
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    jobId: "job-1",
    runId: "run-1",
    itemId: "item-1",
    attemptId: "attempt-1",
    attemptNo: 1,
    revision: 0,
    resourceClass: "native",
    state: "prepared",
    snapshot: {
      media: {
        mediaId: "media-1",
        kind: "direct",
        url: "https://cdn.example/file.mp4",
        detectedAt: 1,
        provenance: ["network"],
      },
      plannedRelativePath: "ClipHutch/Pack/file.mp4",
      quality: { mode: "direct" },
    },
    ...overrides,
  };
}

function dependencies(current: CaptureJobV1 | null): CaptureJobControllerDependencies & {
  mutateJob: ReturnType<typeof vi.fn>;
} {
  const mutateJob = vi.fn(async (input: Parameters<CaptureJobControllerDependencies["mutateJob"]>[0]) => ({
    ok: true as const,
    changed: true,
    job: input.mutate(current as CaptureJobV1) as CaptureJobV1,
  }));
  return {
    getJob: async () => ({ ok: true, job: current }),
    mutateJob,
  };
}

describe("stored Capture Job event controller", () => {
  it("scopes and commits a legal event to the latest revision", async () => {
    const deps = dependencies(job());
    const result = await applyStoredCaptureJobEvent({
      jobId: "job-1",
      attemptId: "attempt-1",
      event: { type: "queue" },
    }, deps);
    expect(result).toMatchObject({ ok: true, changed: true, job: { state: "queued", revision: 1 } });
    expect(deps.mutateJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      expectedAttemptId: "attempt-1",
      expectedRevision: 0,
    }));
  });

  it("returns missing without invoking mutation", async () => {
    const deps = dependencies(null);
    await expect(applyStoredCaptureJobEvent({
      jobId: "missing",
      attemptId: "attempt-1",
      event: { type: "queue" },
    }, deps)).resolves.toEqual({ ok: false, reason: "job_not_found", jobId: "missing" });
    expect(deps.mutateJob).not.toHaveBeenCalled();
  });

  it("rejects a stale attempt and an illegal transition before storage mutation", async () => {
    const deps = dependencies(job());
    await expect(applyStoredCaptureJobEvent({
      jobId: "job-1",
      attemptId: "old-attempt",
      event: { type: "queue" },
    }, deps)).resolves.toMatchObject({
      ok: false,
      reason: "transition_rejected",
      transitionReason: "stale_attempt",
    });
    await expect(applyStoredCaptureJobEvent({
      jobId: "job-1",
      attemptId: "attempt-1",
      event: { type: "complete" },
    }, deps)).resolves.toMatchObject({
      ok: false,
      reason: "transition_rejected",
      transitionReason: "illegal_transition",
    });
    expect(deps.mutateJob).not.toHaveBeenCalled();
  });

  it("bounds persistent compare-and-swap contention", async () => {
    const deps = dependencies(job());
    deps.mutateJob.mockResolvedValue({
      ok: false,
      reason: "conflict",
      conflict: "revision_mismatch",
      id: "job-1",
      expectedRevision: 0,
      actualRevision: 1,
    });
    await expect(applyStoredCaptureJobEvent({
      jobId: "job-1",
      attemptId: "attempt-1",
      event: { type: "queue" },
    }, deps)).resolves.toMatchObject({
      ok: false,
      reason: "transition_rejected",
      transitionReason: "stale_revision",
    });
    expect(deps.mutateJob).toHaveBeenCalledTimes(4);
  });

  it("rereads and commits after progress wins the first compare-and-swap", async () => {
    let current = job({
      state: "running",
      revision: 3,
      progress: { phase: "fetching", bytes: 20 },
    });
    const getJob = vi.fn(async () => ({ ok: true as const, job: current }));
    const mutateJob = vi.fn(async (
      input: Parameters<CaptureJobControllerDependencies["mutateJob"]>[0],
    ) => {
      if (mutateJob.mock.calls.length === 1) {
        current = job({
          state: "running",
          revision: 4,
          progress: { phase: "fetching", bytes: 30 },
        });
        return {
          ok: false as const,
          reason: "conflict" as const,
          conflict: "revision_mismatch" as const,
          id: "job-1",
          expectedRevision: 3,
          actualRevision: 4,
        };
      }
      current = input.mutate(current) as CaptureJobV1;
      return { ok: true as const, changed: true, job: current };
    });

    const result = await applyStoredCaptureJobEvent({
      jobId: "job-1",
      attemptId: "attempt-1",
      event: { type: "processing" },
    }, { getJob, mutateJob });

    expect(result).toMatchObject({ ok: true, job: { state: "processing", revision: 5 } });
    expect(mutateJob).toHaveBeenCalledTimes(2);
  });

  it("serializes fire-and-forget progress ahead of a terminal-phase event", async () => {
    let current = job({
      state: "running",
      revision: 3,
      progress: { phase: "fetching", bytes: 20 },
    });
    const committedRevisions: number[] = [];
    const deps: CaptureJobControllerDependencies = {
      getJob: async () => ({ ok: true, job: current }),
      mutateJob: async (input) => {
        await Promise.resolve();
        if (input.expectedRevision !== current.revision) {
          return {
            ok: false,
            reason: "conflict",
            conflict: "revision_mismatch",
            id: input.jobId,
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
          };
        }
        current = input.mutate(current) as CaptureJobV1;
        committedRevisions.push(current.revision);
        return { ok: true, changed: true, job: current };
      },
    };

    const progress = applyStoredCaptureJobEvent({
      jobId: "job-1",
      attemptId: "attempt-1",
      event: { type: "progress", progress: { phase: "fetching", bytes: 30 } },
    }, deps);
    const processing = applyStoredCaptureJobEvent({
      jobId: "job-1",
      attemptId: "attempt-1",
      event: { type: "processing" },
    }, deps);

    await expect(Promise.all([progress, processing])).resolves.toMatchObject([
      { ok: true, job: { revision: 4 } },
      { ok: true, job: { state: "processing", revision: 5 } },
    ]);
    expect(committedRevisions).toEqual([4, 5]);
  });

  it("does not write identical progress", async () => {
    const current = job({
      state: "running",
      revision: 3,
      progress: { phase: "fetching", bytes: 20 },
    });
    const deps = dependencies(current);
    const result = await applyStoredCaptureJobEvent({
      jobId: "job-1",
      attemptId: "attempt-1",
      event: { type: "progress", progress: { phase: "fetching", bytes: 20 } },
    }, deps);
    expect(result).toMatchObject({ ok: true, changed: false, job: { revision: 3 } });
    expect(deps.mutateJob).not.toHaveBeenCalled();
  });
});
