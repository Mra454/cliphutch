import { describe, expect, it } from "vitest";
import { reduceCaptureJob } from "./capture-executor";
import {
  CAPTURE_RECOVERY_SCHEMA_VERSION,
  MAX_CAPTURE_RECOVERY_RECORDS,
  planCaptureRecovery,
  type ActiveOffscreenAttemptV1,
  type CaptureRecoveryAction,
  type CaptureRecoveryInputV1,
  type ObservedChromeDownloadV1,
} from "./capture-recovery";
import { isCaptureJobV1, type CaptureJobStateV1, type CaptureJobV1 } from "./capture-pack-types";

function job(
  id: string,
  state: CaptureJobStateV1,
  options: {
    resourceClass?: "native" | "heavy";
    downloadId?: number | null;
    revision?: number;
  } = {},
): CaptureJobV1 {
  const resourceClass = options.resourceClass ?? "native";
  const downloadId = options.downloadId === null
    ? undefined
    : options.downloadId ?? (state === "saving" ? 100 : undefined);
  const progress = state === "queued"
    ? { phase: "queued" as const }
    : state === "running"
      ? { phase: "fetching" as const, ratio: 0.25 }
      : state === "processing"
        ? { phase: "processing" as const, ratio: 0.5 }
        : state === "saving"
          ? { phase: "saving" as const }
          : undefined;
  const terminalError = state === "failed" || state === "save_state_unknown"
    ? { code: "EXISTING_ERROR", customerMessage: "Existing failure.", retryable: false }
    : undefined;
  const candidate: CaptureJobV1 = {
    schemaVersion: 1,
    jobId: `job-${id}`,
    runId: "run-1",
    itemId: `item-${id}`,
    attemptId: `attempt-${id}`,
    attemptNo: 1,
    revision: options.revision ?? 4,
    resourceClass,
    state,
    snapshot: resourceClass === "heavy"
      ? {
          media: {
            mediaId: `media-${id}`,
            kind: "hls",
            url: `https://cdn.example/${id}.m3u8`,
            detectedAt: 1,
            provenance: ["network"],
          },
          plannedRelativePath: `ClipHutch/Recovery/${id}.mp4`,
          quality: {
            mode: "stream",
            policy: { mode: "manual" },
            fixedVariantId: `variant-${id}`,
            estimateConfidence: "unknown",
          },
        }
      : {
          media: {
            mediaId: `media-${id}`,
            kind: "direct",
            url: `https://cdn.example/${id}.mp4`,
            detectedAt: 1,
            provenance: ["network"],
          },
          plannedRelativePath: `ClipHutch/Recovery/${id}.mp4`,
          quality: { mode: "direct" },
        },
    ...(progress === undefined ? {} : { progress }),
    ...(downloadId === undefined ? {} : { downloadId }),
    ...(state === "complete" ? { result: {} } : {}),
    ...(terminalError === undefined ? {} : { error: terminalError }),
  };
  if (!isCaptureJobV1(candidate)) throw new Error(`Invalid test job: ${id}/${state}`);
  return candidate;
}

function input(
  jobs: CaptureJobV1[],
  activeOffscreenAttempts: ActiveOffscreenAttemptV1[] = [],
  downloads: ObservedChromeDownloadV1[] = [],
): CaptureRecoveryInputV1 {
  return {
    schemaVersion: CAPTURE_RECOVERY_SCHEMA_VERSION,
    jobs,
    activeOffscreenAttempts,
    downloads,
  };
}

function plannedActions(value: CaptureRecoveryInputV1): CaptureRecoveryAction[] {
  const result = planCaptureRecovery(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.actions;
}

describe("planCaptureRecovery", () => {
  it("leaves prepared and queued jobs schedulable in stable job order", () => {
    const actions = plannedActions(input([job("prepared", "prepared"), job("queued", "queued")]));
    expect(actions).toEqual([
      {
        type: "schedule",
        state: "prepared",
        jobId: "job-prepared",
        attemptId: "attempt-prepared",
        expectedRevision: 4,
      },
      {
        type: "schedule",
        state: "queued",
        jobId: "job-queued",
        attemptId: "attempt-queued",
        expectedRevision: 4,
      },
    ]);
  });

  it("reattaches heavy execution states only to their exact active attempts", () => {
    const jobs = (["starting", "running", "processing"] as const).map((state) =>
      job(state, state, { resourceClass: "heavy" })
    );
    const active = jobs.map(({ jobId, attemptId }) => ({ jobId, attemptId }));
    const actions = plannedActions(input(jobs, active));
    expect(actions.map((action) => action.type)).toEqual([
      "reattach_offscreen",
      "reattach_offscreen",
      "reattach_offscreen",
    ]);
    expect(actions.every((action) => action.attemptId === `attempt-${action.jobId.slice(4)}`))
      .toBe(true);
  });

  it("never matches a stale offscreen attempt and fails the current heavy attempt retryably", () => {
    const running = job("heavy", "running", { resourceClass: "heavy" });
    const [action] = plannedActions(input([running], [
      { jobId: running.jobId, attemptId: "attempt-from-an-old-run" },
    ]));
    expect(action).toMatchObject({
      type: "apply_event",
      jobId: running.jobId,
      attemptId: running.attemptId,
      expectedRevision: running.revision,
      event: {
        type: "fail",
        attemptId: running.attemptId,
        expectedRevision: running.revision,
        code: "RECOVERY_OFFSCREEN_ATTEMPT_MISSING",
        retryable: true,
      },
    });
  });

  it("fails an unconfirmed native start retryably without inventing delivery intent", () => {
    const starting = job("native", "starting");
    const [action] = plannedActions(input([starting]));
    expect(action).toMatchObject({
      type: "apply_event",
      event: {
        type: "fail",
        code: "RECOVERY_NATIVE_START_UNCONFIRMED",
        retryable: true,
      },
    });
  });

  it("makes delivery intent without a persisted download ID non-retryably ambiguous", () => {
    const pending = job("pending", "delivery_pending");
    const [action] = plannedActions(input([pending]));
    expect(action).toMatchObject({
      type: "apply_event",
      event: {
        type: "save-state-unknown",
        code: "RECOVERY_DOWNLOAD_ID_UNKNOWN",
        attemptId: pending.attemptId,
        expectedRevision: pending.revision,
      },
    });
    expect(JSON.stringify(action)).not.toContain("retryable\":true");
    if (action.type !== "apply_event") throw new Error("Expected a recovery event.");
    const reduced = reduceCaptureJob(pending, action.event);
    expect(reduced).toMatchObject({
      ok: true,
      job: {
        state: "save_state_unknown",
        error: { code: "RECOVERY_DOWNLOAD_ID_UNKNOWN", retryable: false },
      },
    });
  });

  it("reconciles complete, interrupted, in-progress, and missing Chrome saves", () => {
    const complete = job("complete-save", "saving", { downloadId: 11 });
    const interrupted = job("interrupted-save", "saving", { downloadId: 12 });
    const inProgress = job("active-save", "saving", { downloadId: 13 });
    const missing = job("missing-save", "saving", { downloadId: 14 });
    const actions = plannedActions(input(
      [complete, interrupted, inProgress, missing],
      [],
      [
        {
          downloadId: 11,
          state: "complete",
          filename: "C:\\Users\\private-name\\movie.mp4",
          fileSize: 123,
        },
        { downloadId: 12, state: "interrupted" },
        { downloadId: 13, state: "in_progress" },
        { downloadId: 14, state: "missing" },
      ],
    ));

    const completedActions = actions.filter((action) => action.jobId === complete.jobId);
    const interruptedActions = actions.filter((action) => action.jobId === interrupted.jobId);
    const activeActions = actions.filter((action) => action.jobId === inProgress.jobId);
    const missingActions = actions.filter((action) => action.jobId === missing.jobId);
    expect(completedActions[0]).toMatchObject({
      type: "apply_event",
      event: { type: "complete", actualBasename: "movie.mp4", sizeBytes: 123 },
    });
    expect(completedActions[1]).toMatchObject({
      type: "cleanup_terminal",
      terminalState: "complete",
    });
    expect(JSON.stringify(completedActions)).not.toContain("private-name");
    expect(interruptedActions[0]).toMatchObject({
      type: "apply_event",
      event: { type: "fail", code: "RECOVERY_SAVE_INTERRUPTED", retryable: true },
    });
    expect(interruptedActions[1]).toMatchObject({
      type: "cleanup_terminal",
      terminalState: "failed",
    });
    expect(activeActions).toEqual([
      expect.objectContaining({ type: "monitor_download", downloadId: 13 }),
    ]);
    expect(missingActions[0]).toMatchObject({
      type: "apply_event",
      event: { type: "save-state-unknown", code: "RECOVERY_DOWNLOAD_MISSING" },
    });
    expect(missingActions[1]).toMatchObject({
      type: "cleanup_terminal",
      terminalState: "save_state_unknown",
    });
  });

  it("promotes persisted delivery intent before applying a known completion", () => {
    const pending = job("persisted-pending", "delivery_pending", { downloadId: 22 });
    const actions = plannedActions(input([pending], [], [
      { downloadId: 22, state: "complete", filename: "/Downloads/capture.mp4" },
    ]));
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({
      type: "apply_event",
      expectedRevision: 4,
      event: { type: "saving", downloadId: 22, expectedRevision: 4 },
    });
    expect(actions[1]).toMatchObject({
      type: "apply_event",
      expectedRevision: 5,
      event: { type: "complete", actualBasename: "capture.mp4", expectedRevision: 5 },
    });
    expect(actions[2]).toMatchObject({
      type: "cleanup_terminal",
      expectedRevision: 6,
      terminalState: "complete",
    });
  });

  it("requires an explicit missing observation instead of guessing after a search failure", () => {
    const saving = job("unobserved", "saving", { downloadId: 31 });
    expect(planCaptureRecovery(input([saving]))).toEqual({
      ok: false,
      schemaVersion: 1,
      reason: "download_observation_required",
      message: "Recovery requires an explicit Chrome state or missing observation for this download.",
      jobId: saving.jobId,
      downloadId: 31,
    });
  });

  it("cancels exact active effects and waits for known cancellation outcomes", () => {
    const cancelling = job("cancelling", "cancelling", {
      resourceClass: "heavy",
      downloadId: 41,
    });
    const activeActions = plannedActions(input(
      [cancelling],
      [{ jobId: cancelling.jobId, attemptId: cancelling.attemptId }],
      [{ downloadId: 41, state: "in_progress" }],
    ));
    expect(activeActions.map((action) => action.type)).toEqual([
      "cancel_offscreen",
      "cancel_download",
    ]);
    expect(activeActions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "apply_event" }),
    ]));

    const interruptedAfterExecutorCancel = plannedActions(input(
      [cancelling],
      [{ jobId: cancelling.jobId, attemptId: cancelling.attemptId }],
      [{ downloadId: 41, state: "interrupted" }],
    ));
    expect(interruptedAfterExecutorCancel.map((action) => action.type)).toEqual([
      "cancel_offscreen",
      "apply_event",
      "cleanup_terminal",
    ]);
    expect(interruptedAfterExecutorCancel[1]).toMatchObject({
      type: "apply_event",
      event: { type: "cancelled" },
    });

    const beforeDelivery = job("active-before-delivery", "cancelling", {
      resourceClass: "heavy",
    });
    const beforeDeliveryActions = plannedActions(input(
      [beforeDelivery],
      [{ jobId: beforeDelivery.jobId, attemptId: beforeDelivery.attemptId }],
    ));
    expect(beforeDeliveryActions.map((action) => action.type)).toEqual([
      "cancel_offscreen",
      "apply_event",
      "cleanup_terminal",
    ]);

    const [known] = plannedActions(input(
      [cancelling],
      [],
      [{ downloadId: 41, state: "interrupted" }],
    ));
    expect(known).toMatchObject({ type: "apply_event", event: { type: "cancelled" } });
  });

  it("marks cancellation without effects complete but preserves missing-save ambiguity", () => {
    const beforeDelivery = job("before-delivery", "cancelling");
    const missingSave = job("cancel-missing", "cancelling", { downloadId: 52 });
    const actions = plannedActions(input(
      [beforeDelivery, missingSave],
      [],
      [{ downloadId: 52, state: "missing" }],
    ));
    const beforeDeliveryActions = actions.filter((action) => action.jobId === beforeDelivery.jobId);
    const missingSaveActions = actions.filter((action) => action.jobId === missingSave.jobId);
    expect(beforeDeliveryActions[0]).toMatchObject({
      type: "apply_event",
      event: { type: "cancelled" },
    });
    expect(beforeDeliveryActions[1]).toMatchObject({
      type: "cleanup_terminal",
      terminalState: "cancelled",
    });
    expect(missingSaveActions[0]).toMatchObject({
      type: "apply_event",
      event: { type: "save-state-unknown", code: "RECOVERY_CANCEL_OUTCOME_UNKNOWN" },
    });
    expect(missingSaveActions[1]).toMatchObject({
      type: "cleanup_terminal",
      terminalState: "save_state_unknown",
    });
  });

  it("emits exact idempotent cleanup actions for every terminal state", () => {
    const terminal = (["complete", "failed", "cancelled", "save_state_unknown"] as const)
      .map((state) => job(state, state, { resourceClass: state === "failed" ? "heavy" : "native" }));
    const actions = plannedActions(input(terminal));
    expect(actions.map((action) => action.type)).toEqual([
      "cleanup_terminal",
      "cleanup_terminal",
      "cleanup_terminal",
      "cleanup_terminal",
    ]);
    expect(actions.map((action) => action.attemptId)).toEqual(
      terminal.map((candidate) => candidate.attemptId),
    );
  });

  it("bounds and validates every external observation before planning", () => {
    const running = job("bounded", "running", { resourceClass: "heavy" });
    const duplicateActive = input([running], [
      { jobId: running.jobId, attemptId: running.attemptId },
      { jobId: running.jobId, attemptId: "other-attempt" },
    ]);
    expect(planCaptureRecovery(duplicateActive)).toMatchObject({
      ok: false,
      reason: "duplicate_active_job",
    });

    const invalidState = input([], [], [
      { downloadId: 1, state: "paused" as ObservedChromeDownloadV1["state"] },
    ]);
    expect(planCaptureRecovery(invalidState)).toMatchObject({
      ok: false,
      reason: "invalid_download_observation",
    });

    const tooMany = input([], Array.from(
      { length: MAX_CAPTURE_RECOVERY_RECORDS + 1 },
      (_, index) => ({ jobId: `job-${index}`, attemptId: `attempt-${index}` }),
    ));
    expect(planCaptureRecovery(tooMany)).toMatchObject({ ok: false, reason: "too_many_records" });
  });

  it("fails closed without throwing when a hostile runtime record cannot be inspected", () => {
    const hostile = Object.create(null) as CaptureRecoveryInputV1;
    Object.defineProperty(hostile, "schemaVersion", {
      enumerable: true,
      get(): never {
        throw new Error("hostile getter");
      },
    });
    Object.defineProperty(hostile, "jobs", { enumerable: true, value: [] });
    Object.defineProperty(hostile, "activeOffscreenAttempts", { enumerable: true, value: [] });
    Object.defineProperty(hostile, "downloads", { enumerable: true, value: [] });
    expect(() => planCaptureRecovery(hostile)).not.toThrow();
    expect(planCaptureRecovery(hostile)).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});
