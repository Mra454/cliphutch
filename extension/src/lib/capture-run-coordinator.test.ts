import { describe, expect, it, vi } from "vitest";
import { prepareCaptureJobs, reduceCaptureJob } from "./capture-executor";
import {
  isCaptureJobV1,
  type CaptureJobV1,
  type CapturePlanItemV1,
  type CaptureReviewPlanV1,
  type CaptureRunV1,
  type MediaSnapshotV1,
  type QualityChoiceV1,
} from "./capture-pack-types";
import {
  createCaptureRunCoordinator,
  enqueueCaptureRun,
  reconcileCaptureRunQueue,
  type CaptureRunCoordinatorDependencies,
  type EnqueueCaptureRunInput,
} from "./capture-run-coordinator";
import type {
  CaptureCommandRecordV1,
  CommitCaptureRunResult,
  ListCaptureRunsResult,
  MutateCaptureJobResult,
  ReadCaptureJobResult,
  ReadCaptureRunResult,
} from "./capture-run-storage";
import type { DownloadBatchReservation } from "./rate-limit";
import type { CaptureManifestSeedV1 } from "./capture-manifest-seed";

const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";

function media(itemId: string, kind: MediaSnapshotV1["kind"]): MediaSnapshotV1 {
  const extension = kind === "hls" ? "m3u8" : kind === "dash" ? "mpd" : kind === "image" ? "jpg" : "mp4";
  return {
    mediaId: `media-${itemId}`,
    kind,
    url: `https://cdn.example/${itemId}.${extension}`,
    detectedAt: 10,
    pageUrl: "https://example.test/article",
    provenance: ["network"],
  };
}

function planItem(
  itemId: string,
  kind: MediaSnapshotV1["kind"] = "direct",
  partial: Partial<CapturePlanItemV1> = {},
): CapturePlanItemV1 {
  const qualityChoice: QualityChoiceV1 = kind === "hls"
    ? {
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "hls",
        variantUrl: `https://cdn.example/${itemId}-variant.m3u8`,
        estimateConfidence: "unknown",
      }
    : kind === "dash"
      ? {
          mode: "stream",
          policy: { mode: "manual" },
          variantKind: "dash",
          representationId: `representation-${itemId}`,
          estimateConfidence: "unknown",
        }
    : { mode: "direct" };
  const result = {
    itemId,
    include: true,
    media: media(itemId, kind),
    plannedRelativePath: `ClipHutch/Research/example.test/${itemId}.${kind === "image" ? "jpg" : "mp4"}`,
    readiness: "ready",
    copyChoice: {
      candidateId: `media-${itemId}`,
      confidence: "exact",
      reason: "Exact source",
    },
    qualityChoice,
    warnings: [],
    ...partial,
  };
  if (result.readiness !== "ready") delete (result as { qualityChoice?: QualityChoiceV1 }).qualityChoice;
  return result as CapturePlanItemV1;
}

function reviewPlan(items: CapturePlanItemV1[], planId = "plan-1"): CaptureReviewPlanV1 {
  const included = items.filter((item) => item.include);
  const videos = included.filter((item) => item.media.kind !== "image").length;
  const stills = included.length - videos;
  return {
    schemaVersion: 1,
    planId,
    draftId: "draft-1",
    draftRevision: 3,
    generatedAt: 20,
    relativeRoot: "ClipHutch/Research",
    items,
    totals: {
      included: included.length,
      videos,
      stills,
      ...(included.length === 0 ? { estimatedBytes: 0 } : {}),
      unknownSizeCount: included.length,
      requiredFreeVideoSlots: videos,
    },
  };
}

function input(
  plan: CaptureReviewPlanV1,
  partial: Partial<EnqueueCaptureRunInput> = {},
): EnqueueCaptureRunInput {
  return {
    plan,
    commandId: COMMAND_ID,
    licensed: false,
    runId: "run-1",
    now: 1_000,
    ...partial,
  };
}

function reservation(batchId: string, count: number, now: number): DownloadBatchReservation {
  return {
    batchId,
    count,
    reservedAt: now,
    reservations: Array.from({ length: count }, (_, index) => ({ id: `quota-${index + 1}` })),
  };
}

function harness() {
  const runs = new Map<string, CaptureRunV1>();
  const jobs = new Map<string, CaptureJobV1>();
  const commands = new Map<string, CaptureCommandRecordV1>();

  const reserve = vi.fn(async (batchId: string, count: number, now: number = Date.now()) =>
    reservation(batchId, count, now),
  );
  const release = vi.fn(async () => undefined);
  const list = vi.fn(async (): Promise<ListCaptureRunsResult> => ({
    ok: true,
    runs: [...runs.values()],
  }));
  const getRun = vi.fn(async (runId: string): Promise<ReadCaptureRunResult> => ({
    ok: true,
    run: runs.get(runId) ?? null,
  }));
  const getCommand = vi.fn(async (commandId: string) => ({
    ok: true as const,
    record: commands.get(commandId) ?? null,
  }));
  const markAccepted = vi.fn(async (): Promise<void> => undefined);
  const getJob = vi.fn(async (jobId: string): Promise<ReadCaptureJobResult> => ({
    ok: true,
    job: jobs.get(jobId) ?? null,
  }));
  const commit = vi.fn(
    async (
      run: CaptureRunV1,
      prepared: CaptureJobV1[],
      _manifestSeed?: CaptureManifestSeedV1 | null,
    ): Promise<CommitCaptureRunResult> => {
      const commandOwner = [...runs.values()].find((candidate) => candidate.commandId === run.commandId);
      if (commandOwner) {
        return {
          ok: false,
          reason: "conflict",
          conflict: "command_exists",
          id: commandOwner.runId,
        };
      }
      runs.set(run.runId, run);
      commands.set(run.commandId, {
        schemaVersion: 1,
        commandId: run.commandId,
        runId: run.runId,
        planId: run.planId,
        draftId: run.draftId,
        draftRevision: run.draftRevision,
        planDigest: run.planDigest,
        createdAt: run.createdAt,
        state: "pending",
        runStatus: run.status,
      });
      for (const job of prepared) jobs.set(job.jobId, job);
      return { ok: true, changed: true, run, jobs: prepared, prunedRunIds: [] };
    },
  );
  const mutate = vi.fn(
    async (mutation: Parameters<CaptureRunCoordinatorDependencies["mutateCaptureJob"]>[0]): Promise<MutateCaptureJobResult> => {
      const current = jobs.get(mutation.jobId);
      if (!current) return { ok: false, reason: "storage_corrupt", key: mutation.jobId };
      if (current.attemptId !== mutation.expectedAttemptId) {
        return {
          ok: false,
          reason: "conflict",
          conflict: "attempt_mismatch",
          id: current.jobId,
          expectedAttemptId: mutation.expectedAttemptId,
          actualAttemptId: current.attemptId,
        };
      }
      if (current.revision !== mutation.expectedRevision) {
        return {
          ok: false,
          reason: "conflict",
          conflict: "revision_mismatch",
          id: current.jobId,
          expectedRevision: mutation.expectedRevision,
          actualRevision: current.revision,
        };
      }
      const candidate = mutation.mutate(current);
      if (!isCaptureJobV1(candidate)) {
        return { ok: false, reason: "invalid_input", message: "invalid mutation" };
      }
      jobs.set(candidate.jobId, candidate);
      return { ok: true, changed: true, job: candidate };
    },
  );

  const dependencies: CaptureRunCoordinatorDependencies = {
    prepareCaptureJobs,
    reduceCaptureJob,
    reserveDownloads: reserve,
    releaseDownloadReservations: release,
    commitInitialCaptureRun: commit,
    getCaptureCommandRecord: getCommand,
    getCaptureRun: getRun,
    listCaptureRuns: list,
    getCaptureJob: getJob,
    mutateCaptureJob: mutate,
    markDownloadBatchAccepted: markAccepted,
  };
  return {
    dependencies,
    runs,
    jobs,
    commands,
    reserve,
    release,
    markAccepted,
    list,
    getCommand,
    getRun,
    getJob,
    commit,
    mutate,
  };
}

describe("enqueueCaptureRun", () => {
  it("rejects malformed envelopes, invalid plans, empty plans, and included unready entries before effects", async () => {
    const state = harness();
    const ready = reviewPlan([planItem("one")]);
    await expect(
      enqueueCaptureRun(input(ready, { commandId: "not-a-uuid" }), state.dependencies),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_input" });

    await expect(
      enqueueCaptureRun(input({ ...ready, schemaVersion: 2 } as unknown as CaptureReviewPlanV1), state.dependencies),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_plan" });

    const empty = reviewPlan([planItem("excluded", "image", { include: false, readiness: "stale" })]);
    await expect(enqueueCaptureRun(input(empty), state.dependencies)).resolves.toMatchObject({
      ok: false,
      reason: "plan_not_ready",
    });

    const stale = reviewPlan([planItem("stale", "direct", { readiness: "stale" })]);
    await expect(enqueueCaptureRun(input(stale), state.dependencies)).resolves.toMatchObject({
      ok: false,
      reason: "plan_not_ready",
    });
    expect(state.list).not.toHaveBeenCalled();
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.commit).not.toHaveBeenCalled();
  });

  it("strictly validates bounded lease maps before any quota or storage effect", async () => {
    const state = harness();
    const plan = reviewPlan([
      planItem("one"),
      planItem("two"),
      planItem("excluded", "direct", { include: false, readiness: "stale" }),
    ]);
    const invalidMaps: unknown[] = [
      { unknown: "lease-unknown" },
      { excluded: "lease-excluded" },
      { one: "https://evil.test/lease" },
      { one: "lease-same", two: "lease-same" },
      Object.fromEntries(Array.from(
        { length: 201 },
        (_, index) => [`item-${index}`, `lease-${index}`],
      )),
    ];
    const accessor = {} as Record<string, string>;
    Object.defineProperty(accessor, "one", { enumerable: true, get: () => "lease-one" });
    invalidMaps.push(accessor);

    for (const headerLeaseIdsByItemId of invalidMaps) {
      await expect(enqueueCaptureRun(input(plan, {
        headerLeaseIdsByItemId: headerLeaseIdsByItemId as Record<string, string>,
      }), state.dependencies)).resolves.toMatchObject({
        ok: false,
        reason: "invalid_input",
        code: "invalid_header_lease_map",
      });
    }
    await expect(enqueueCaptureRun({
      ...input(plan),
      extra: true,
    } as EnqueueCaptureRunInput, state.dependencies)).resolves.toMatchObject({
      ok: false,
      reason: "invalid_input",
      code: "invalid_enqueue_envelope",
    });
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.list).not.toHaveBeenCalled();
    expect(state.commit).not.toHaveBeenCalled();
  });

  it("passes a canonical defensive lease map into preparation and binds it to job snapshots", async () => {
    const state = harness();
    const plan = reviewPlan([planItem("two"), planItem("one")]);
    const prepare = vi.fn(prepareCaptureJobs);
    state.dependencies.prepareCaptureJobs = prepare;
    const mutableMap = { one: "lease-one", two: "lease-two" };
    const operation = enqueueCaptureRun(input(plan, {
      licensed: true,
      headerLeaseIdsByItemId: mutableMap,
    }), state.dependencies);
    mutableMap.one = "lease-mutated";
    const result = await operation;

    expect(result).toMatchObject({ ok: true, disposition: "accepted" });
    expect(prepare).toHaveBeenCalledWith(plan, {
      runId: "run-1",
      headerLeaseIdsByItemId: { two: "lease-two", one: "lease-one" },
    });
    expect([...state.jobs.values()].map((job) => [job.itemId, job.snapshot.headerLeaseId]))
      .toEqual([["two", "lease-two"], ["one", "lease-one"]]);
  });

  it("binds the redacted manifest seed to the run commit and digest", async () => {
    const state = harness();
    const value = reviewPlan([planItem("one"), planItem("excluded", "image", { include: false })]);
    value.manifestSpec = {
      schemaVersion: 1,
      formats: ["json", "csv"],
      packName: "Research",
      createdAt: 5,
      itemAddedAt: { one: 11, excluded: 12 },
    };
    const result = await enqueueCaptureRun(input(value, { licensed: true }), state.dependencies);
    expect(result).toMatchObject({ ok: true });
    const seed = state.commit.mock.calls[0]?.[2];
    expect(seed).toMatchObject({
      runId: "run-1",
      planId: value.planId,
      relativeRoot: value.relativeRoot,
      formats: ["json", "csv"],
      items: [
        { itemId: "one", included: true, jobId: expect.any(String) },
        { itemId: "excluded", included: false },
      ],
    });
    expect(seed?.items[1]).not.toHaveProperty("jobId");
    expect(state.runs.get("run-1")?.planDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a preparer that drops or changes an authoritative lease binding", async () => {
    const state = harness();
    state.dependencies.prepareCaptureJobs = (plan, options) =>
      prepareCaptureJobs(plan, { runId: options.runId });
    await expect(enqueueCaptureRun(input(reviewPlan([planItem("one")]), {
      headerLeaseIdsByItemId: { one: "lease-one" },
    }), state.dependencies)).resolves.toMatchObject({
      ok: false,
      reason: "invalid_plan",
      code: "prepared_jobs_do_not_match_plan",
    });
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.commit).not.toHaveBeenCalled();

    const injected = harness();
    injected.dependencies.prepareCaptureJobs = (plan, options) =>
      prepareCaptureJobs(plan, {
        ...options,
        headerLeaseIdsByItemId: { one: "lease-injected" },
      });
    await expect(enqueueCaptureRun(
      input(reviewPlan([planItem("one")]), { headerLeaseIdsByItemId: {} }),
      injected.dependencies,
    )).resolves.toMatchObject({
      ok: false,
      reason: "invalid_plan",
      code: "prepared_jobs_do_not_match_plan",
    });
    expect(injected.reserve).not.toHaveBeenCalled();
    expect(injected.commit).not.toHaveBeenCalled();
  });

  it("replays an equivalent lease map and conflicts a changed map on the same command", async () => {
    const state = harness();
    const plan = reviewPlan([planItem("one"), planItem("two")]);
    const first = await enqueueCaptureRun(input(plan, {
      headerLeaseIdsByItemId: { two: "lease-two", one: "lease-one" },
    }), state.dependencies);
    const replay = await enqueueCaptureRun(input(plan, {
      headerLeaseIdsByItemId: { one: "lease-one", two: "lease-two" },
      now: 2_000,
    }), state.dependencies);
    const conflict = await enqueueCaptureRun(input(plan, {
      headerLeaseIdsByItemId: { one: "lease-changed", two: "lease-two" },
      now: 3_000,
    }), state.dependencies);

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(conflict).toMatchObject({ ok: false, reason: "command_conflict" });
    expect(state.reserve).toHaveBeenCalledTimes(1);
    expect(state.commit).toHaveBeenCalledTimes(1);
  });

  it("changes the durable coordinator digest when a lease binding changes", async () => {
    const first = harness();
    const second = harness();
    const plan = reviewPlan([planItem("one")]);
    await enqueueCaptureRun(input(plan, {
      licensed: true,
      headerLeaseIdsByItemId: { one: "lease-one" },
    }), first.dependencies);
    await enqueueCaptureRun(input(plan, {
      licensed: true,
      headerLeaseIdsByItemId: { one: "lease-two" },
    }), second.dependencies);
    expect(first.runs.get("run-1")?.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.runs.get("run-1")?.planDigest)
      .not.toBe(first.runs.get("run-1")?.planDigest);
  });

  it("treats omitted and explicit empty maps identically and safely handles prototype-shaped item ids", async () => {
    const state = harness();
    const prototypeId = "__proto__";
    const plan = reviewPlan([planItem(prototypeId)]);
    const first = await enqueueCaptureRun(input(plan, {
      licensed: true,
      headerLeaseIdsByItemId: Object.fromEntries([[prototypeId, "lease-prototype"]]),
    }), state.dependencies);
    expect(first).toMatchObject({ ok: true });
    expect([...state.jobs.values()][0]?.snapshot.headerLeaseId).toBe("lease-prototype");

    const empty = harness();
    const ordinaryPlan = reviewPlan([planItem("one")]);
    await expect(enqueueCaptureRun(input(ordinaryPlan, { licensed: true }), empty.dependencies))
      .resolves.toMatchObject({ ok: true, replayed: false });
    await expect(enqueueCaptureRun(input(ordinaryPlan, {
      licensed: true,
      headerLeaseIdsByItemId: {},
      now: 2_000,
    }), empty.dependencies)).resolves.toMatchObject({ ok: true, replayed: true });
    expect(empty.commit).toHaveBeenCalledTimes(1);
  });

  it("reserves every included video atomically and assigns reservation ids only to video jobs", async () => {
    const state = harness();
    const plan = reviewPlan([
      planItem("still", "image"),
      planItem("direct", "direct"),
      planItem("stream", "hls"),
      planItem("excluded", "direct", { include: false, readiness: "stale" }),
    ]);

    const result = await enqueueCaptureRun(input(plan), state.dependencies);

    expect(result).toMatchObject({
      ok: true,
      accepted: true,
      replayed: false,
      disposition: "accepted",
    });
    expect(state.reserve).toHaveBeenCalledWith(COMMAND_ID, 2, 1_000);
    expect(state.commit).toHaveBeenCalledTimes(1);
    const committedJobs = state.commit.mock.calls[0][1];
    expect(committedJobs.map((job) => [job.itemId, job.quotaReservationId])).toEqual([
      ["still", undefined],
      ["direct", "quota-1"],
      ["stream", "quota-2"],
    ]);
    expect([...state.jobs.values()].map((job) => [job.state, job.revision])).toEqual([
      ["queued", 1],
      ["queued", 1],
      ["queued", 1],
    ]);
    expect(state.release).not.toHaveBeenCalled();
  });

  it("skips quota for licensed packs and unlicensed still-only packs", async () => {
    const licensed = harness();
    const licensedResult = await enqueueCaptureRun(
      input(reviewPlan([planItem("video")]), { licensed: true }),
      licensed.dependencies,
    );
    expect(licensedResult.ok).toBe(true);
    expect(licensed.reserve).not.toHaveBeenCalled();
    expect(licensed.commit.mock.calls[0][1][0].quotaReservationId).toBeUndefined();

    const stillOnly = harness();
    const stillResult = await enqueueCaptureRun(
      input(reviewPlan([planItem("still", "image")])),
      stillOnly.dependencies,
    );
    expect(stillResult.ok).toBe(true);
    expect(stillOnly.reserve).not.toHaveBeenCalled();
  });

  it("rejects an all-or-none quota miss without committing any job", async () => {
    const state = harness();
    state.dependencies.reserveDownloads = vi.fn(async () => null);

    const result = await enqueueCaptureRun(
      input(reviewPlan([planItem("one"), planItem("two")])),
      state.dependencies,
    );

    expect(result).toMatchObject({ ok: false, accepted: false, reason: "quota_unavailable" });
    expect(state.commit).not.toHaveBeenCalled();
    expect(state.jobs.size).toBe(0);
    expect(state.release).not.toHaveBeenCalled();
  });

  it("releases the exact batch after a definitively uncommitted write failure", async () => {
    const state = harness();
    state.dependencies.commitInitialCaptureRun = vi.fn(async (): Promise<CommitCaptureRunResult> => ({
      ok: false,
      reason: "storage_unavailable",
      operation: "set",
      message: "quota exceeded",
      committed: false,
    }));

    const result = await enqueueCaptureRun(input(reviewPlan([planItem("one")])), state.dependencies);

    expect(result).toMatchObject({ ok: false, accepted: false, reason: "commit_failure" });
    expect(state.release).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: COMMAND_ID, count: 1 }),
      1_000,
    );
  });

  it("releases only after exact absence is proved and preserves ambiguous quota", async () => {
    const reported = harness();
    reported.dependencies.commitInitialCaptureRun = vi.fn(async (): Promise<CommitCaptureRunResult> => ({
      ok: false,
      reason: "storage_unavailable",
      operation: "remove",
      message: "cleanup unknown",
      committed: true,
    }));
    await expect(
      enqueueCaptureRun(input(reviewPlan([planItem("one")])), reported.dependencies),
    ).resolves.toMatchObject({
      ok: true,
      accepted: true,
      disposition: "commit_state_unknown",
    });
    expect(reported.release).not.toHaveBeenCalled();

    const thrown = harness();
    thrown.dependencies.commitInitialCaptureRun = vi.fn(async () => {
      throw new Error("port closed after set");
    });
    await expect(
      enqueueCaptureRun(input(reviewPlan([planItem("one")])), thrown.dependencies),
    ).resolves.toMatchObject({
      ok: false,
      accepted: false,
      reason: "commit_failure",
    });
    expect(thrown.release).toHaveBeenCalledTimes(1);

    const ambiguous = harness();
    ambiguous.dependencies.commitInitialCaptureRun = vi.fn(async () => {
      throw new Error("port closed after set");
    });
    ambiguous.dependencies.getCaptureCommandRecord = vi.fn()
      .mockResolvedValueOnce({ ok: true, record: null })
      .mockResolvedValue({
        ok: false,
        reason: "storage_unavailable",
        operation: "get",
        message: "worker restarted",
        committed: false,
      });
    await expect(
      enqueueCaptureRun(input(reviewPlan([planItem("one")])), ambiguous.dependencies),
    ).resolves.toMatchObject({
      ok: true,
      accepted: true,
      disposition: "commit_state_unknown",
    });
    expect(ambiguous.release).not.toHaveBeenCalled();
  });

  it("serializes concurrent same-command submissions into one run and one quota effect", async () => {
    const state = harness();
    const plan = reviewPlan([planItem("one")]);
    const coordinator = createCaptureRunCoordinator(state.dependencies);

    const [first, replay] = await Promise.all([
      coordinator.enqueueCaptureRun(input(plan)),
      coordinator.enqueueCaptureRun(input(plan, { runId: "run-2", now: 2_000 })),
    ]);

    expect(first).toMatchObject({ ok: true, runId: "run-1", replayed: false });
    expect(replay).toMatchObject({ ok: true, runId: "run-1", replayed: true });
    expect(state.reserve).toHaveBeenCalledTimes(1);
    expect(state.commit).toHaveBeenCalledTimes(1);
    expect(state.runs.size).toBe(1);
    expect(state.release).not.toHaveBeenCalled();
  });

  it("replays an accepted licensed command even if the current license state no longer bypasses quota", async () => {
    const state = harness();
    const plan = reviewPlan(
      Array.from({ length: 5 }, (_, index) => planItem(`video-${index + 1}`)),
    );

    const first = await enqueueCaptureRun(input(plan, { licensed: true }), state.dependencies);
    const replay = await enqueueCaptureRun(
      input(plan, { licensed: false, runId: "replacement-run", now: 2_000 }),
      state.dependencies,
    );

    expect(first).toMatchObject({ ok: true, runId: "run-1", replayed: false });
    expect(replay).toMatchObject({ ok: true, runId: "run-1", replayed: true });
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.commit).toHaveBeenCalledTimes(1);
  });

  it("replays the independent settled command ledger after terminal UI pruning", async () => {
    const state = harness();
    const plan = reviewPlan([planItem("one")]);
    const first = await enqueueCaptureRun(input(plan), state.dependencies);
    expect(first).toMatchObject({ ok: true, replayed: false });
    const command = state.commands.get(COMMAND_ID);
    if (!command) throw new Error("Expected the committed command record");
    state.commands.set(COMMAND_ID, { ...command, state: "settled", runStatus: "complete" });
    state.runs.delete(command.runId);
    state.jobs.clear();

    const replay = await enqueueCaptureRun(
      input(plan, { runId: "replacement-run", now: 2_000 }),
      state.dependencies,
    );
    expect(replay).toMatchObject({
      ok: true,
      accepted: true,
      replayed: true,
      runId: "run-1",
      disposition: "accepted",
    });
    expect(state.reserve).toHaveBeenCalledTimes(1);
    expect(state.commit).toHaveBeenCalledTimes(1);

    const conflictingPlan = reviewPlan([planItem("different")], plan.planId);
    await expect(
      enqueueCaptureRun(input(conflictingPlan, { runId: "other-run", now: 3_000 }), state.dependencies),
    ).resolves.toMatchObject({
      ok: false,
      accepted: false,
      reason: "command_conflict",
    });
  });

  it("treats a same-command commit race as replay and does not release its shared quota", async () => {
    const state = harness();
    const plan = reviewPlan([planItem("one")]);
    const ownerJobs = prepareCaptureJobs(plan, { runId: "original-run" }).map((job) => {
      const reduced = reduceCaptureJob(job, {
        type: "queue",
        attemptId: job.attemptId,
        expectedRevision: job.revision,
      });
      if (!reduced.ok) throw new Error("fixture transition failed");
      return { ...reduced.job, quotaReservationId: "quota-1" };
    });
    const owner: CaptureRunV1 = {
      schemaVersion: 1,
      runId: "original-run",
      planId: plan.planId,
      draftId: plan.draftId,
      draftRevision: plan.draftRevision,
      planDigest: "0".repeat(64),
      commandId: COMMAND_ID,
      createdAt: 900,
      status: "queued",
      orderedJobIds: ownerJobs.map((job) => job.jobId),
    };
    state.runs.set(owner.runId, owner);
    for (const job of ownerJobs) state.jobs.set(job.jobId, job);
    state.dependencies.listCaptureRuns = vi.fn(async (): Promise<ListCaptureRunsResult> => ({ ok: true, runs: [] }));
    state.dependencies.commitInitialCaptureRun = vi.fn(
      async (incomingRun: CaptureRunV1): Promise<CommitCaptureRunResult> => {
        owner.draftId = incomingRun.draftId;
        owner.draftRevision = incomingRun.draftRevision;
        owner.planDigest = incomingRun.planDigest;
        state.commands.set(COMMAND_ID, {
          schemaVersion: 1,
          commandId: COMMAND_ID,
          runId: owner.runId,
          planId: owner.planId,
          draftId: owner.draftId,
          draftRevision: owner.draftRevision,
          planDigest: owner.planDigest,
          createdAt: owner.createdAt,
          state: "pending",
          runStatus: owner.status,
        });
        return {
          ok: false,
          reason: "conflict",
          conflict: "command_exists",
          id: owner.runId,
        };
      },
    );

    const result = await enqueueCaptureRun(
      input(plan, { runId: "racing-run" }),
      state.dependencies,
    );

    expect(result).toMatchObject({ ok: true, runId: owner.runId, replayed: true });
    expect(state.release).not.toHaveBeenCalled();
  });

  it("returns accepted recovery when post-commit queueing is partial", async () => {
    const state = harness();
    const originalMutate = state.dependencies.mutateCaptureJob;
    state.dependencies.mutateCaptureJob = vi.fn(async (
      mutation: Parameters<CaptureRunCoordinatorDependencies["mutateCaptureJob"]>[0],
    ): Promise<MutateCaptureJobResult> => {
      if (state.jobs.get(mutation.jobId)?.itemId === "two") {
        return {
          ok: false,
          reason: "storage_unavailable",
          operation: "set",
          message: "session write failed",
          committed: false,
        };
      }
      return originalMutate(mutation);
    });

    const result = await enqueueCaptureRun(
      input(reviewPlan([planItem("one"), planItem("two")])),
      state.dependencies,
    );

    expect(result).toMatchObject({
      ok: true,
      accepted: true,
      disposition: "recovery_needed",
    });
    expect(result.ok && result.remainingPreparedJobIds).toHaveLength(1);
    expect(state.release).not.toHaveBeenCalled();
    expect(state.commit).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileCaptureRunQueue", () => {
  it("queues only remaining prepared jobs and is idempotent on replay", async () => {
    const state = harness();
    const plan = reviewPlan([planItem("prepared"), planItem("queued"), planItem("running")]);
    const prepared = prepareCaptureJobs(plan, { runId: "run-reconcile" });
    const queue = (job: CaptureJobV1): CaptureJobV1 => {
      const result = reduceCaptureJob(job, {
        type: "queue",
        attemptId: job.attemptId,
        expectedRevision: job.revision,
      });
      if (!result.ok) throw new Error("fixture transition failed");
      return result.job;
    };
    const start = (job: CaptureJobV1): CaptureJobV1 => {
      const result = reduceCaptureJob(job, {
        type: "start",
        attemptId: job.attemptId,
        expectedRevision: job.revision,
      });
      if (!result.ok) throw new Error("fixture transition failed");
      return result.job;
    };
    const stored = [prepared[0], queue(prepared[1]), start(queue(prepared[2]))];
    const run: CaptureRunV1 = {
      schemaVersion: 1,
      runId: "run-reconcile",
      planId: plan.planId,
      draftId: plan.draftId,
      draftRevision: plan.draftRevision,
      planDigest: "a".repeat(64),
      commandId: COMMAND_ID,
      createdAt: 1_000,
      status: "running",
      orderedJobIds: stored.map((job) => job.jobId),
    };
    state.runs.set(run.runId, run);
    for (const job of stored) state.jobs.set(job.jobId, job);

    const first = await reconcileCaptureRunQueue(run.runId, state.dependencies);
    const mutationCount = state.mutate.mock.calls.length;
    const second = await reconcileCaptureRunQueue(run.runId, state.dependencies);

    expect(first).toMatchObject({
      ok: true,
      queuedJobIds: [prepared[0].jobId, prepared[1].jobId],
      advancedJobIds: [prepared[2].jobId],
      remainingPreparedJobIds: [],
      recoveryNeeded: false,
    });
    expect(second).toMatchObject({ ok: true, recoveryNeeded: false });
    expect(mutationCount).toBe(1);
    expect(state.mutate).toHaveBeenCalledTimes(1);
  });

  it("does not revive a prepared job beneath a terminal run", async () => {
    const state = harness();
    const plan = reviewPlan([planItem("one")]);
    const [job] = prepareCaptureJobs(plan, { runId: "terminal-run" });
    const run: CaptureRunV1 = {
      schemaVersion: 1,
      runId: "terminal-run",
      planId: plan.planId,
      draftId: plan.draftId,
      draftRevision: plan.draftRevision,
      planDigest: "b".repeat(64),
      commandId: COMMAND_ID,
      createdAt: 1_000,
      status: "cancelled",
      orderedJobIds: [job.jobId],
    };
    state.runs.set(run.runId, run);
    state.jobs.set(job.jobId, job);

    const result = await reconcileCaptureRunQueue(run.runId, state.dependencies);

    expect(result).toMatchObject({
      ok: true,
      recoveryNeeded: true,
      remainingPreparedJobIds: [job.jobId],
    });
    expect(state.mutate).not.toHaveBeenCalled();
  });
});
