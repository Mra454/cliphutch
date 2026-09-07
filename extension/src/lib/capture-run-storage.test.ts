import { beforeEach, describe, expect, it } from "vitest";
import type { CaptureJobV1, CaptureRunStatusV1, CaptureRunV1 } from "./capture-pack-types";
import type { CaptureManifestSeedV1 } from "./capture-manifest-seed";
import {
  captureManifestRecordKey,
  finalizeStoredCaptureManifestRecord,
  mutateCaptureManifestOutput,
} from "./capture-manifest-storage";
import {
  CAPTURE_COMMANDS_STORAGE_KEY,
  CAPTURE_JOB_STORAGE_PREFIX,
  CAPTURE_RUNS_STORAGE_KEY,
  MAX_ACTIVE_CAPTURE_RUNS,
  MAX_CAPTURE_JOBS_PER_RUN,
  MAX_TERMINAL_CAPTURE_RUNS,
  commitInitialCaptureRun,
  enrichCompletedCaptureJobResult,
  getCaptureCommandRecord,
  getCaptureJob,
  getCaptureRun,
  listCaptureRuns,
  listCaptureCommandRecords,
  mutateCaptureJob,
  parseStoredCaptureJob,
  parseStoredCaptureRunIndex,
  updateCaptureRun,
} from "./capture-run-storage";

let store: Record<string, unknown>;
let setCalls: Record<string, unknown>[];
let removeCalls: string[][];
let failGet: boolean;
let failSet: boolean;
let applyThenFailSet: boolean;
let failRemove: boolean;

function jobKey(jobId: string): string {
  return `${CAPTURE_JOB_STORAGE_PREFIX}${jobId}`;
}

function runFixture(
  index: number,
  jobIds: string[] = [`job-${index}`],
  status: CaptureRunStatusV1 = "queued",
): CaptureRunV1 {
  return {
    schemaVersion: 1,
    runId: `run-${index}`,
    planId: `plan-${index}`,
    draftId: `draft-${index}`,
    draftRevision: index,
    planDigest: index.toString(16).padStart(64, "0"),
    commandId: `command-${index}`,
    createdAt: index,
    status,
    orderedJobIds: jobIds,
  };
}

function jobFixture(index: number, runId = `run-${index}`, jobId = `job-${index}`): CaptureJobV1 {
  return {
    schemaVersion: 1,
    jobId,
    runId,
    itemId: `item-${index}`,
    attemptId: `attempt-${index}`,
    attemptNo: 1,
    revision: 0,
    resourceClass: "native",
    state: "prepared",
    snapshot: {
      media: {
        mediaId: `media-${index}`,
        kind: "direct",
        url: `https://cdn.example.test/${index}.mp4`,
        detectedAt: index,
        pageUrl: `https://example.test/page-${index}`,
        provenance: ["network"],
      },
      plannedRelativePath: `ClipHutch/Pack ${index}/Page/video-${index}.mp4`,
      quality: { mode: "direct" },
    },
  };
}

function manifestSeedFixture(index: number): CaptureManifestSeedV1 {
  return {
    schemaVersion: 1,
    runId: `run-${index}`,
    planId: `plan-${index}`,
    packName: `Pack ${index}`,
    relativeRoot: `ClipHutch/Pack ${index}`,
    createdAt: index,
    formats: ["json"],
    items: [{
      itemId: `item-${index}`,
      included: true,
      jobId: `job-${index}`,
      plannedPath: `ClipHutch/Pack ${index}/Page/video-${index}.mp4`,
      kind: "direct",
      pageUrl: `https://example.test/page-${index}`,
      sourceHost: "cdn.example.test",
      addedAt: index,
    }],
  };
}

async function commitFixture(index: number, withManifest = false): Promise<void> {
  const result = await commitInitialCaptureRun(
    runFixture(index),
    [jobFixture(index)],
    withManifest ? manifestSeedFixture(index) : undefined,
  );
  expect(result).toMatchObject({ ok: true, changed: true });
}

async function completeJob(index: number): Promise<void> {
  const job = jobFixture(index);
  const transitions: Array<(current: CaptureJobV1) => CaptureJobV1> = [
    (current) => ({ ...current, revision: 1, state: "queued", progress: { phase: "queued" } }),
    (current) => ({ ...current, revision: 2, state: "starting", progress: undefined }),
    (current) => ({ ...current, revision: 3, state: "running", progress: { phase: "fetching" } }),
    (current) => ({
      ...current,
      revision: 4,
      state: "complete",
      progress: undefined,
      result: { actualBasename: `video-${index}.mp4` },
    }),
  ];
  for (let revision = 0; revision < transitions.length; revision += 1) {
    const result = await mutateCaptureJob({
      jobId: job.jobId,
      expectedAttemptId: job.attemptId,
      expectedRevision: revision,
      mutate: transitions[revision],
    });
    expect(result).toMatchObject({ ok: true, changed: true });
  }
}

async function completeManifest(index: number): Promise<void> {
  const finalizedAt = index + 1;
  expect(await finalizeStoredCaptureManifestRecord({
    runId: `run-${index}`,
    finalizedAt,
  })).toMatchObject({ ok: true });
  expect(await mutateCaptureManifestOutput({
    runId: `run-${index}`,
    format: "json",
    action: {
      type: "begin",
      format: "json",
      expectedRevision: 0,
      attemptId: `manifest-attempt-${index}`,
      now: finalizedAt,
    },
  })).toMatchObject({ ok: true });
  expect(await mutateCaptureManifestOutput({
    runId: `run-${index}`,
    format: "json",
    action: {
      type: "record_download",
      format: "json",
      expectedRevision: 1,
      attemptId: `manifest-attempt-${index}`,
      downloadId: 10_000 + index,
      now: finalizedAt + 1,
    },
  })).toMatchObject({ ok: true });
  expect(await mutateCaptureManifestOutput({
    runId: `run-${index}`,
    format: "json",
    action: {
      type: "complete",
      format: "json",
      expectedRevision: 2,
      attemptId: `manifest-attempt-${index}`,
      downloadId: 10_000 + index,
      now: finalizedAt + 2,
    },
  })).toMatchObject({ ok: true });
}

async function setRunStatus(
  index: number,
  expectedStatus: CaptureRunStatusV1,
  status: CaptureRunStatusV1,
) {
  return updateCaptureRun({
    runId: `run-${index}`,
    expectedStatus,
    update: (current) => ({ ...current, status }),
  });
}

beforeEach(() => {
  store = { unrelated: { keep: true } };
  setCalls = [];
  removeCalls = [];
  failGet = false;
  failSet = false;
  applyThenFailSet = false;
  failRemove = false;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get(keys: string | string[]) {
          if (failGet) return Promise.reject(new Error("get unavailable"));
          const requested = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of requested) {
            if (Object.prototype.hasOwnProperty.call(store, key)) {
              result[key] = structuredClone(store[key]);
            }
          }
          return Promise.resolve(result);
        },
        set(values: Record<string, unknown>) {
          const cloned = structuredClone(values);
          if (applyThenFailSet) {
            setCalls.push(cloned);
            Object.assign(store, cloned);
            return Promise.reject(new Error("set acknowledgement unavailable"));
          }
          if (failSet) return Promise.reject(new Error("set unavailable"));
          setCalls.push(cloned);
          Object.assign(store, cloned);
          return Promise.resolve();
        },
        remove(keys: string | string[]) {
          if (failRemove) return Promise.reject(new Error("remove unavailable"));
          const requested = Array.isArray(keys) ? keys : [keys];
          removeCalls.push([...requested]);
          for (const key of requested) delete store[key];
          return Promise.resolve();
        },
      },
    },
  };
});

describe("Capture Run session parsing", () => {
  it("distinguishes empty, corrupt, future, and valid versioned values", () => {
    expect(parseStoredCaptureRunIndex(undefined)).toEqual({ status: "empty" });
    expect(parseStoredCaptureRunIndex({ schemaVersion: 1, orderedRunIds: ["missing"], runs: {} }))
      .toEqual({ status: "invalid", reason: "corrupt" });
    expect(parseStoredCaptureRunIndex({ schemaVersion: 2, data: true })).toEqual({
      status: "invalid",
      reason: "future_schema",
      schemaVersion: 2,
    });
    const run = runFixture(1);
    expect(
      parseStoredCaptureRunIndex({
        schemaVersion: 1,
        orderedRunIds: [run.runId],
        runs: { [run.runId]: run },
      }),
    ).toMatchObject({ status: "valid" });

    expect(parseStoredCaptureJob(undefined)).toEqual({ status: "empty" });
    expect(parseStoredCaptureJob({ schemaVersion: 1, jobId: "broken" })).toEqual({
      status: "invalid",
      reason: "corrupt",
    });
    expect(parseStoredCaptureJob({ schemaVersion: 7 })).toEqual({
      status: "invalid",
      reason: "future_schema",
      schemaVersion: 7,
    });
    expect(parseStoredCaptureJob(jobFixture(1))).toMatchObject({ status: "valid" });
  });

  it("treats prototype-like run ids as owned data without prototype pollution", async () => {
    const run = {
      ...runFixture(1, ["constructor-job"]),
      runId: "__proto__",
    };
    const job = jobFixture(1, run.runId, "constructor-job");
    expect(await commitInitialCaptureRun(run, [job])).toMatchObject({ ok: true, changed: true });
    expect(await getCaptureRun("__proto__")).toMatchObject({
      ok: true,
      run: { runId: "__proto__" },
    });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("rejects duplicate global job ownership and an over-bound terminal index", () => {
    const first = runFixture(1, ["shared"], "complete");
    const second = runFixture(2, ["shared"], "complete");
    expect(
      parseStoredCaptureRunIndex({
        schemaVersion: 1,
        orderedRunIds: [first.runId, second.runId],
        runs: { [first.runId]: first, [second.runId]: second },
      }),
    ).toEqual({ status: "invalid", reason: "corrupt" });

    const runs = Object.fromEntries(
      Array.from({
        length: MAX_ACTIVE_CAPTURE_RUNS + MAX_TERMINAL_CAPTURE_RUNS + 1,
      }, (_, index) => {
        const run = runFixture(index, [`job-${index}`], "complete");
        return [run.runId, run];
      }),
    );
    expect(
      parseStoredCaptureRunIndex({
        schemaVersion: 1,
        orderedRunIds: Object.keys(runs),
        runs,
      }),
    ).toEqual({ status: "invalid", reason: "corrupt" });
  });
});

describe("initial Capture Run commit", () => {
  it("commits one run and all prepared jobs in one atomic set and preserves unrelated keys", async () => {
    const run = runFixture(1, ["job-1", "job-2"]);
    const first = jobFixture(1, run.runId, "job-1");
    const second = jobFixture(2, run.runId, "job-2");
    const result = await commitInitialCaptureRun(run, [second, first]);

    expect(result).toMatchObject({ ok: true, changed: true, prunedRunIds: [] });
    expect(setCalls).toHaveLength(1);
    expect(Object.keys(setCalls[0]).sort()).toEqual(
      [CAPTURE_COMMANDS_STORAGE_KEY, CAPTURE_RUNS_STORAGE_KEY, jobKey("job-1"), jobKey("job-2")].sort(),
    );
    expect(store.unrelated).toEqual({ keep: true });
    expect(removeCalls).toEqual([]);
    expect((result.ok && result.jobs.map((job) => job.jobId))).toEqual(["job-1", "job-2"]);
  });

  it("canonicalizes allowlisted fields so extra secrets are never persisted", async () => {
    const run = Object.assign(runFixture(1), { licenseKey: "secret-license" });
    const job = jobFixture(1) as CaptureJobV1 & {
      authorization?: string;
      snapshot: CaptureJobV1["snapshot"] & { cookie?: string };
    };
    job.authorization = "Bearer secret";
    job.snapshot.cookie = "session=secret";
    (job.snapshot.media as CaptureJobV1["snapshot"]["media"] & { rawHeaders?: string }).rawHeaders = "secret";

    const result = await commitInitialCaptureRun(run, [job]);
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(setCalls[0]);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("rawHeaders");
  });

  it("persists a detached opaque stream selector and frozen download cap", async () => {
    const stableId = `variant-v1-hls-${"c".repeat(40)}`;
    const job = jobFixture(1);
    job.resourceClass = "heavy";
    job.snapshot.media = {
      ...job.snapshot.media,
      kind: "hls",
      url: "https://cdn.example.test/master.m3u8",
    };
    job.snapshot.quality = {
      mode: "stream",
      policy: { mode: "manual" },
      selector: { kind: "hls", stableId },
      maxDownloadBytes: 512 * 1024 * 1024,
      combinedBandwidth: 4_000_000,
      durationSec: 10,
      estimatedBytes: 5_000_000,
      estimateConfidence: "estimated",
    };

    expect(await commitInitialCaptureRun(runFixture(1), [job])).toMatchObject({ ok: true });
    expect(JSON.stringify(setCalls[0])).not.toContain("variantUrl");
    expect(JSON.stringify(setCalls[0])).not.toContain("representationId");
    expect(store[jobKey(job.jobId)]).toMatchObject({
      snapshot: {
        quality: {
          selector: { kind: "hls", stableId },
          maxDownloadBytes: 512 * 1024 * 1024,
          combinedBandwidth: 4_000_000,
          durationSec: 10,
        },
      },
    });

    if (job.snapshot.quality.mode !== "stream" || job.snapshot.quality.selector === undefined) {
      throw new Error("Expected persistent stream choice");
    }
    job.snapshot.quality.selector.stableId = `variant-v1-hls-${"d".repeat(40)}`;
    job.snapshot.quality.maxDownloadBytes = 1;
    expect((await getCaptureJob(job.jobId))).toMatchObject({
      ok: true,
      job: {
        snapshot: {
          quality: {
            selector: { stableId },
            maxDownloadBytes: 512 * 1024 * 1024,
          },
        },
      },
    });
  });

  it("atomically commits and read-back-proves the redacted manifest record", async () => {
    const run = runFixture(1);
    const job = jobFixture(1);
    const seed = manifestSeedFixture(1) as CaptureManifestSeedV1 & {
      authorization?: string;
      commandId?: string;
    };
    seed.authorization = "Bearer secret";
    seed.commandId = "must-not-persist";
    expect(await commitInitialCaptureRun(run, [job], seed)).toMatchObject({
      ok: false,
      reason: "invalid_input",
    });
    delete seed.authorization;
    delete seed.commandId;
    applyThenFailSet = true;
    const result = await commitInitialCaptureRun(run, [job], seed);
    expect(result).toMatchObject({ ok: true, changed: true });
    const record = store[captureManifestRecordKey(run.runId)];
    expect(record).toMatchObject({
      seed: { runId: run.runId, planId: run.planId, relativeRoot: "ClipHutch/Pack 1" },
      outputs: { json: { state: "pending", revision: 0 } },
    });
    expect(JSON.stringify(record)).not.toContain("must-not-persist");
  });

  it("replays an existing initial commit without writing or replacing advanced jobs", async () => {
    const run = runFixture(1);
    const job = jobFixture(1);
    await commitInitialCaptureRun(run, [job]);
    await mutateCaptureJob({
      jobId: job.jobId,
      expectedAttemptId: job.attemptId,
      expectedRevision: 0,
      mutate: (current) => ({ ...current, revision: 1, state: "queued", progress: { phase: "queued" } }),
    });
    const writesBeforeReplay = setCalls.length;
    const replay = await commitInitialCaptureRun(run, [job]);
    expect(replay).toMatchObject({ ok: true, changed: false });
    expect(replay.ok && replay.jobs[0]).toMatchObject({ revision: 1, state: "queued" });
    expect(setCalls).toHaveLength(writesBeforeReplay);
  });

  it("reads back an acknowledged-as-failed atomic commit without compensating it", async () => {
    applyThenFailSet = true;
    const result = await commitInitialCaptureRun(runFixture(1), [jobFixture(1)]);
    expect(result).toMatchObject({ ok: true, changed: true, run: { runId: "run-1" } });
    expect(await getCaptureCommandRecord("command-1")).toMatchObject({
      ok: true,
      record: { runId: "run-1", state: "pending" },
    });
  });

  it("rejects invalid graphs, oversized runs, and existing run/command/job identities", async () => {
    const badState = jobFixture(1);
    badState.state = "queued";
    expect(await commitInitialCaptureRun(runFixture(1), [badState])).toMatchObject({
      ok: false,
      reason: "invalid_input",
    });

    const tooManyIds = Array.from({ length: MAX_CAPTURE_JOBS_PER_RUN + 1 }, (_, index) => `j-${index}`);
    expect(await commitInitialCaptureRun(runFixture(9, tooManyIds), [])).toMatchObject({
      ok: false,
      reason: "invalid_input",
    });

    await commitFixture(1);
    expect(await commitInitialCaptureRun({ ...runFixture(1), planId: "different" }, [jobFixture(1)]))
      .toMatchObject({ ok: false, reason: "conflict", conflict: "run_exists" });
    expect(
      await commitInitialCaptureRun(
        { ...runFixture(2), commandId: runFixture(1).commandId },
        [jobFixture(2)],
      ),
    ).toMatchObject({ ok: false, reason: "conflict", conflict: "command_exists" });

    store[jobKey("job-3")] = jobFixture(30, "other-run", "job-3");
    expect(await commitInitialCaptureRun(runFixture(3), [jobFixture(3)])).toMatchObject({
      ok: false,
      reason: "conflict",
      conflict: "job_exists",
    });
  });
});

describe("Capture Run and job reads/mutations", () => {
  it("reads isolated run/job copies and lists newest-first", async () => {
    await commitFixture(1);
    await commitFixture(2);
    const list = await listCaptureRuns();
    expect(list.ok && list.runs.map((run) => run.runId)).toEqual(["run-2", "run-1"]);
    const run = await getCaptureRun("run-1");
    const job = await getCaptureJob("job-1");
    expect(run).toMatchObject({ ok: true, run: { runId: "run-1" } });
    expect(job).toMatchObject({ ok: true, job: { jobId: "job-1" } });
    if (run.ok && run.run) run.run.orderedJobIds.push("mutated");
    if (job.ok && job.job) job.job.snapshot.media.provenance.push("metadata");
    const rereadRun = await getCaptureRun("run-1");
    const rereadJob = await getCaptureJob("job-1");
    expect(rereadRun.ok && rereadRun.run?.orderedJobIds).toEqual(["job-1"]);
    expect(rereadJob.ok && rereadJob.job?.snapshot.media.provenance).toEqual(["network"]);
    expect(await getCaptureRun("missing")).toEqual({ ok: true, run: null });
    expect(await getCaptureJob("missing")).toEqual({ ok: true, job: null });
    expect(await getCaptureRun("")).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await getCaptureJob("")).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("guards job mutation with attempt and revision conflicts under concurrency", async () => {
    await commitFixture(1);
    const attemptConflict = await mutateCaptureJob({
      jobId: "job-1",
      expectedAttemptId: "wrong",
      expectedRevision: 0,
      mutate: (current) => current,
    });
    expect(attemptConflict).toMatchObject({
      ok: false,
      reason: "conflict",
      conflict: "attempt_mismatch",
      actualAttemptId: "attempt-1",
    });

    const mutation = () => mutateCaptureJob({
      jobId: "job-1",
      expectedAttemptId: "attempt-1",
      expectedRevision: 0,
      mutate: (current) => ({ ...current, revision: 1, state: "queued", progress: { phase: "queued" } }),
    });
    const [first, second] = await Promise.all([mutation(), mutation()]);
    expect(first).toMatchObject({ ok: true, changed: true });
    expect(second).toMatchObject({
      ok: false,
      reason: "conflict",
      conflict: "revision_mismatch",
      actualRevision: 1,
    });
  });

  it("rejects invalid/identity-changing mutations and strips extra runtime fields", async () => {
    await commitFixture(1);
    expect(
      await mutateCaptureJob({
        jobId: "job-1",
        expectedAttemptId: "attempt-1",
        expectedRevision: 0,
        mutate: (current) => ({ ...current, revision: 1, jobId: "other" }),
      }),
    ).toMatchObject({ ok: false, reason: "invalid_input" });

    const updated = await mutateCaptureJob({
      jobId: "job-1",
      expectedAttemptId: "attempt-1",
      expectedRevision: 0,
      mutate: (current) => Object.assign(
        { ...current, revision: 1, state: "queued", progress: { phase: "queued" } },
        { rawAuthorization: "secret-token" },
      ),
    });
    expect(updated).toMatchObject({ ok: true, changed: true });
    expect(JSON.stringify(store[jobKey("job-1")])).not.toContain("secret-token");
    expect(JSON.stringify(store[jobKey("job-1")])).not.toContain("rawAuthorization");

    await commitFixture(2);
    expect(
      await mutateCaptureJob({
        jobId: "job-2",
        expectedAttemptId: "attempt-2",
        expectedRevision: 0,
        mutate: (current) => ({
          ...current,
          revision: 1,
          state: "complete",
          result: {},
        }),
      }),
    ).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("does not rewrite terminal jobs on late mutation", async () => {
    await commitFixture(1);
    await completeJob(1);
    const writes = setCalls.length;
    const late = await mutateCaptureJob({
      jobId: "job-1",
      expectedAttemptId: "attempt-1",
      expectedRevision: 4,
      mutate: (current) => ({ ...current, revision: 2, state: "failed" }),
    });
    expect(late).toMatchObject({ ok: true, changed: false, job: { state: "complete", revision: 4 } });
    expect(setCalls).toHaveLength(writes);
  });

  it("one-way freezes a missing final basename without reopening terminal state", async () => {
    await commitFixture(1);
    await completeJob(1);
    const completed = store[jobKey("job-1")] as CaptureJobV1;
    store[jobKey("job-1")] = { ...completed, result: {} };

    const enriched = await enrichCompletedCaptureJobResult({
      jobId: "job-1",
      expectedAttemptId: "attempt-1",
      expectedRevision: 4,
      result: { actualBasename: "video (1).mp4", sizeBytes: 4_096 },
    });
    expect(enriched).toMatchObject({
      ok: true,
      changed: true,
      job: {
        state: "complete",
        revision: 5,
        result: { actualBasename: "video (1).mp4", sizeBytes: 4_096 },
      },
    });

    const replay = await enrichCompletedCaptureJobResult({
      jobId: "job-1",
      expectedAttemptId: "attempt-1",
      expectedRevision: 5,
      result: { actualBasename: "later-name.mp4", sizeBytes: 8_192 },
    });
    expect(replay).toMatchObject({
      ok: true,
      changed: false,
      job: {
        state: "complete",
        revision: 5,
        result: { actualBasename: "video (1).mp4", sizeBytes: 4_096 },
      },
    });
  });

  it("treats an ambiguous save state as terminal and immutable", async () => {
    await commitFixture(1);
    for (const [revision, state, progress] of [
      [0, "queued", { phase: "queued" }],
      [1, "starting", undefined],
    ] as const) {
      const advanced = await mutateCaptureJob({
        jobId: "job-1",
        expectedAttemptId: "attempt-1",
        expectedRevision: revision,
        mutate: (current) => ({
          ...current,
          revision: revision + 1,
          state,
          progress,
        }),
      });
      expect(advanced).toMatchObject({ ok: true, changed: true });
    }
    const ambiguous = await mutateCaptureJob({
      jobId: "job-1",
      expectedAttemptId: "attempt-1",
      expectedRevision: 2,
      mutate: (current) => ({
        ...current,
        revision: 3,
        state: "save_state_unknown",
        progress: undefined,
        error: {
          code: "SAVE_STATE_UNKNOWN",
          customerMessage: "The save could not be reconciled.",
          retryable: false,
        },
      }),
    });
    expect(ambiguous).toMatchObject({ ok: true, job: { state: "save_state_unknown" } });
    const writes = setCalls.length;
    const late = await mutateCaptureJob({
      jobId: "job-1",
      expectedAttemptId: "attempt-1",
      expectedRevision: 3,
      mutate: (current) => ({ ...current, revision: 4, state: "queued" }),
    });
    expect(late).toMatchObject({ ok: true, changed: false, job: { state: "save_state_unknown" } });
    expect(setCalls).toHaveLength(writes);
  });
});

describe("terminal retention", () => {
  it("retains a media-terminal run while its manifest output is still active", async () => {
    for (let index = 0; index < MAX_TERMINAL_CAPTURE_RUNS + 1; index++) {
      await commitFixture(index, index === 0);
      await completeJob(index);
      expect(await setRunStatus(index, "queued", "running")).toMatchObject({ ok: true });
      expect(await setRunStatus(index, "running", "complete")).toMatchObject({ ok: true });
      if (index === 0) {
        expect(await finalizeStoredCaptureManifestRecord({
          runId: "run-0",
          finalizedAt: 1,
        })).toMatchObject({ ok: true });
        expect(await mutateCaptureManifestOutput({
          runId: "run-0",
          format: "json",
          action: {
            type: "begin",
            format: "json",
            expectedRevision: 0,
            attemptId: "manifest-attempt-zero",
            now: 1,
          },
        })).toMatchObject({ ok: true });
      }
    }

    const listed = await listCaptureRuns();
    expect(listed.ok && listed.runs.map((run) => run.runId)).toContain("run-0");
    expect(store[jobKey("job-0")]).toBeDefined();
    expect(store[captureManifestRecordKey("run-0")]).toMatchObject({
      outputs: { json: { state: "saving", attemptId: "manifest-attempt-zero" } },
    });
  });

  it("retains the latest ten terminal summaries and removes only their terminal job keys", async () => {
    for (let index = 0; index < MAX_TERMINAL_CAPTURE_RUNS + 1; index++) {
      await commitFixture(index, true);
      await completeJob(index);
      await completeManifest(index);
      expect(await setRunStatus(index, "queued", "running")).toMatchObject({ ok: true });
      expect(await setRunStatus(index, "running", "complete")).toMatchObject({ ok: true });
    }

    const listed = await listCaptureRuns();
    expect(listed.ok && listed.runs).toHaveLength(MAX_TERMINAL_CAPTURE_RUNS);
    expect(listed.ok && listed.runs.map((run) => run.runId)).toEqual(
      Array.from({ length: MAX_TERMINAL_CAPTURE_RUNS }, (_, offset) => `run-${10 - offset}`),
    );
    expect(store[jobKey("job-0")]).toBeUndefined();
    expect(store[jobKey("job-1")]).toBeDefined();
    expect(store[captureManifestRecordKey("run-0")]).toBeUndefined();
    expect(store[captureManifestRecordKey("run-1")]).toBeDefined();
    expect(await getCaptureRun("run-0")).toEqual({ ok: true, run: null });
    expect(await getCaptureCommandRecord("command-0")).toMatchObject({
      ok: true,
      record: { runId: "run-0", state: "settled", runStatus: "complete" },
    });
    const commands = await listCaptureCommandRecords();
    expect(commands.ok && commands.records.some((record) => record.commandId === "command-0"))
      .toBe(true);
    expect(store.unrelated).toEqual({ keep: true });
  });

  it("rejects changes to durable plan identity and removal of recorded manifests", async () => {
    await commitFixture(0);
    expect(
      await updateCaptureRun({
        runId: "run-0",
        expectedStatus: "queued",
        update: (current) => ({ ...current, draftRevision: current.draftRevision + 1 }),
      }),
    ).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(
      await updateCaptureRun({
        runId: "run-0",
        expectedStatus: "queued",
        update: (current) => ({ ...current, manifestDownloadIds: [41, 42] }),
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      await updateCaptureRun({
        runId: "run-0",
        expectedStatus: "queued",
        update: (current) => ({ ...current, manifestDownloadIds: [42] }),
      }),
    ).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("refuses to mark a run terminal while any owned job is still active", async () => {
    await commitFixture(0);
    await setRunStatus(0, "queued", "running");
    await expect(setRunStatus(0, "running", "complete")).resolves.toMatchObject({
      ok: false,
      reason: "invalid_input",
    });
    const run = await getCaptureRun("run-0");
    expect(run).toMatchObject({ ok: true, run: { status: "running" } });
    expect(store[jobKey("job-0")]).toBeDefined();
    expect((store[jobKey("job-0")] as CaptureJobV1).state).toBe("prepared");
  });

  it("reports cleanup failure as committed and leaves the terminal job recoverable", async () => {
    for (let index = 0; index < MAX_TERMINAL_CAPTURE_RUNS + 1; index++) {
      await commitFixture(index);
      await completeJob(index);
      await setRunStatus(index, "queued", "running");
      if (index < MAX_TERMINAL_CAPTURE_RUNS) {
        await setRunStatus(index, "running", "complete");
      }
    }
    failRemove = true;
    const result = await setRunStatus(MAX_TERMINAL_CAPTURE_RUNS, "running", "complete");
    expect(result).toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "remove",
      committed: true,
    });
    const listed = await listCaptureRuns();
    expect(listed.ok && listed.runs).toHaveLength(MAX_TERMINAL_CAPTURE_RUNS);
    expect(store[jobKey("job-0")]).toBeDefined();
  });
});

describe("typed storage failures", () => {
  it("reports unavailable get/set and corrupt/future values without overwriting them", async () => {
    failGet = true;
    expect(await listCaptureRuns()).toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "get",
      committed: false,
    });
    failGet = false;
    failSet = true;
    expect(await commitInitialCaptureRun(runFixture(1), [jobFixture(1)])).toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "set",
      committed: false,
    });
    expect(store[CAPTURE_RUNS_STORAGE_KEY]).toBeUndefined();

    failSet = false;
    store[CAPTURE_RUNS_STORAGE_KEY] = { schemaVersion: 8, future: true };
    expect(await listCaptureRuns()).toEqual({
      ok: false,
      reason: "storage_future_schema",
      key: CAPTURE_RUNS_STORAGE_KEY,
      schemaVersion: 8,
    });
    store[CAPTURE_RUNS_STORAGE_KEY] = { schemaVersion: 1, orderedRunIds: ["missing"], runs: {} };
    expect(await listCaptureRuns()).toEqual({
      ok: false,
      reason: "storage_corrupt",
      key: CAPTURE_RUNS_STORAGE_KEY,
    });
  });
});
