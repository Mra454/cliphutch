import { describe, expect, it, vi } from "vitest";
import {
  AUTO_RECONCILE_MAX_ATTEMPTS,
  AUTO_RECONCILE_MIN_INTERVAL_MS,
  DEFAULT_AUTO_RECONCILE_STATE,
  autoReconcileAttemptsRemaining,
  classifyAutoReconcileResponse,
  createAutoReconcileDependencies,
  normalizeAutoReconcileState,
  planAutoReconcileAttempt,
  runAutoReconcileAttempt,
  type AutoReconcileRef,
  type AutoReconcileIntent,
  type AutoReconcileStateV1,
} from "./quick-capture-auto-reconcile";

function intent(
  overrides: Partial<AutoReconcileIntent> = {},
): AutoReconcileIntent {
  return {
    commandId: "download-00000000-0000-4000-8000-000000000001",
    ...DEFAULT_AUTO_RECONCILE_STATE,
    ...overrides,
  };
}

function createSerialLock(calls: string[] = []) {
  let queue: Promise<unknown> = Promise.resolve();
  return async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    calls.push(`enter:${key}`);
    try {
      return await task();
    } finally {
      release();
    }
  };
}

describe("Quick Capture automatic reconcile policy", () => {
  it("defaults old-shape intent records to automatic reconciliation allowed", () => {
    expect(normalizeAutoReconcileState({})).toEqual(DEFAULT_AUTO_RECONCILE_STATE);
    expect(autoReconcileAttemptsRemaining(intent())).toBe(AUTO_RECONCILE_MAX_ATTEMPTS);
  });

  it("counts attempts and rate-limits one intent for ten seconds", () => {
    const first = planAutoReconcileAttempt(intent(), 1_000);
    expect(first).toMatchObject({
      kind: "attempt",
      state: {
        autoReconcileAttemptCount: 1,
        autoReconcileLastAttemptAt: 1_000,
      },
    });
    const blocked = planAutoReconcileAttempt(intent({
      autoReconcileAttemptCount: 1,
      autoReconcileLastAttemptAt: 1_000,
    }), 1_000 + AUTO_RECONCILE_MIN_INTERVAL_MS - 1);
    expect(blocked).toEqual({
      kind: "rate_limited",
      retryAt: 1_000 + AUTO_RECONCILE_MIN_INTERVAL_MS,
      attemptsRemaining: AUTO_RECONCILE_MAX_ATTEMPTS - 1,
    });
  });

  it("classifies every known reconcile disposition and status explicitly", () => {
    const cases: Array<readonly [unknown, "resolved" | "unresolved"]> = [
      [{ ok: true, jobId: "job-one" }, "resolved"],
      [{ ok: true, disposition: "accepted", runId: "run-one" }, "resolved"],
      [{ ok: true, disposition: "recovery_needed", runId: "run-one" }, "unresolved"],
      [{ ok: true, disposition: "commit_state_unknown", runId: "run-one" }, "unresolved"],
      [{ ok: true, disposition: "future_disposition", runId: "run-one" }, "unresolved"],
      [{ ok: true, status: "completed" }, "resolved"],
      [{ ok: true, status: "complete" }, "resolved"],
      [{ ok: true, status: "failed" }, "resolved"],
      [{ ok: true, status: "cancelled" }, "resolved"],
      [{ ok: true, status: "abandoned" }, "resolved"],
      [{ ok: true, status: "pending" }, "unresolved"],
      [{ ok: true, status: "queued" }, "unresolved"],
      [{ ok: true, status: "running" }, "unresolved"],
      [{ ok: true, status: "partial" }, "unresolved"],
      [{ ok: true, status: "future_status" }, "unresolved"],
      [{ ok: false, pending: true, code: "START_STATE_UNKNOWN" }, "unresolved"],
      [{ ok: false, code: "START_STATE_UNKNOWN" }, "unresolved"],
      [{ ok: false, reason: "outcome_unknown" }, "unresolved"],
      [{ ok: false, reason: "manifest_attempt_failed" }, "unresolved"],
      [{ ok: false, status: "failed", code: "FETCH_FAILED" }, "resolved"],
      [{ ok: false, code: "FUTURE_FAILED_CODE" }, "unresolved"],
      [{ ok: false, code: "CANCELLED" }, "resolved"],
      [{ ok: false, code: "SOURCE_AUTH_EXPIRED" }, "resolved"],
      [{ ok: true }, "unresolved"],
      [{ ok: false }, "unresolved"],
      [{ ok: true, disposition: "accepted" }, "unresolved"],
      [null, "unresolved"],
    ];
    for (const [response, expected] of cases) {
      expect(classifyAutoReconcileResponse(response)).toBe(expected);
    }
  });

  it("stops after five unresolved automatic attempts and marks manual reconcile", async () => {
    let persisted = intent({
      autoReconcileAttemptCount: AUTO_RECONCILE_MAX_ATTEMPTS - 1,
      autoReconcileLastAttemptAt: 1,
    });
    const markAttempt = vi.fn(async () => true);
    const markManual = vi.fn(async () => true);
    const result = await runAutoReconcileAttempt({
      ref: { kind: "quick_start", commandId: persisted.commandId },
      now: AUTO_RECONCILE_MIN_INTERVAL_MS + 2,
      lockKey: "auto:test",
      withLock: async (_key, task) => task(),
      readIntent: vi.fn(async () => persisted),
      markAttempt,
      markManualReconcileRequired: markManual,
      markReconcileSucceeded: vi.fn(async () => true),
      actions: { reconcile: vi.fn(async () => ({ ok: false, reason: "outcome_unknown" })) },
    });
    expect(result).toMatchObject({ status: "attempted", attemptsRemaining: 0 });
    expect(markAttempt).toHaveBeenCalledWith(
      { kind: "quick_start", commandId: intent().commandId },
      {
        autoReconcileAttemptCount: AUTO_RECONCILE_MAX_ATTEMPTS,
        autoReconcileLastAttemptAt: AUTO_RECONCILE_MIN_INTERVAL_MS + 2,
        needsManualReconcile: false,
      } satisfies AutoReconcileStateV1,
    );
    expect(markManual).toHaveBeenCalledWith({ kind: "quick_start", commandId: intent().commandId });
  });

  it("resets the attempt policy after a successful reconcile", async () => {
    const persisted = intent({ autoReconcileAttemptCount: 3, autoReconcileLastAttemptAt: 1 });
    const markSucceeded = vi.fn(async () => true);
    const result = await runAutoReconcileAttempt({
      ref: { kind: "quick_start", commandId: persisted.commandId },
      now: AUTO_RECONCILE_MIN_INTERVAL_MS + 1,
      lockKey: "auto:test",
      withLock: async (_key, task) => task(),
      readIntent: vi.fn(async () => persisted),
      markAttempt: vi.fn(async () => true),
      markManualReconcileRequired: vi.fn(async () => true),
      markReconcileSucceeded: markSucceeded,
      actions: { reconcile: vi.fn(async () => ({ ok: true, jobId: "job-one" })) },
    });
    expect(result).toMatchObject({
      status: "attempted",
      attemptsRemaining: AUTO_RECONCILE_MAX_ATTEMPTS,
    });
    expect(markSucceeded).toHaveBeenCalledWith({ kind: "quick_start", commandId: intent().commandId });
  });

  it("serializes concurrent triggers by reading, counting, and persisting inside the lock", async () => {
    let persisted = intent();
    const calls: string[] = [];
    const withLock = createSerialLock(calls);
    const markAttempt = vi.fn(async (_ref: AutoReconcileRef, state: AutoReconcileStateV1) => {
      persisted = { ...persisted, ...state };
      return true;
    });
    const result = await Promise.all([
      runAutoReconcileAttempt({
        ref: { kind: "quick_start", commandId: persisted.commandId },
        now: 5_000,
        lockKey: "auto:test",
        withLock,
        readIntent: vi.fn(async () => persisted),
        markAttempt,
        markManualReconcileRequired: vi.fn(async () => true),
        markReconcileSucceeded: vi.fn(async () => true),
        actions: { reconcile: vi.fn(async () => ({ ok: false, reason: "outcome_unknown" })) },
      }),
      runAutoReconcileAttempt({
        ref: { kind: "quick_start", commandId: persisted.commandId },
        now: 5_000,
        lockKey: "auto:test",
        withLock,
        readIntent: vi.fn(async () => persisted),
        markAttempt,
        markManualReconcileRequired: vi.fn(async () => true),
        markReconcileSucceeded: vi.fn(async () => true),
        actions: { reconcile: vi.fn(async () => ({ ok: false, reason: "outcome_unknown" })) },
      }),
    ]);
    expect(result.map((entry) => entry.status).sort()).toEqual(["attempted", "rate_limited"]);
    expect(markAttempt).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["enter:auto:test", "enter:auto:test"]);
  });

  it("does not run an already exhausted intent inside the lock", async () => {
    const persisted = intent({ autoReconcileAttemptCount: 5, needsManualReconcile: true });
    const reconcile = vi.fn(async () => ({ ok: false, reason: "outcome_unknown" }));
    await expect(runAutoReconcileAttempt({
      ref: { kind: "quick_start", commandId: persisted.commandId },
      now: 50_000,
      lockKey: "auto:test",
      withLock: async (_key, task) => task(),
      readIntent: vi.fn(async () => persisted),
      markAttempt: vi.fn(async () => true),
      markManualReconcileRequired: vi.fn(async () => true),
      markReconcileSucceeded: vi.fn(async () => true),
      actions: { reconcile },
    })).resolves.toEqual({ status: "manual_required" });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("uses the real background dependency shape with one reconcile action and frozen refs", async () => {
    const refs: AutoReconcileRef[] = [
      { kind: "quick_start", commandId: "download-00000000-0000-4000-8000-000000000042" },
      { kind: "pack_run", commandId: "capture-run-00000000-0000-4000-8000-000000000043" },
      {
        kind: "manifest_export",
        commandId: "manifest-retry-00000000-0000-4000-8000-000000000044",
        runId: "capture-run:v1:00000000-0000-4000-8000-000000000043",
        format: "csv",
      },
    ];
    for (const ref of refs) {
      const reconcile = vi.fn(async () => ({ ok: false, reason: "outcome_unknown" }));
      const actions = new Proxy({ reconcile }, {
        get(target, prop, receiver) {
          if (prop !== "reconcile") throw new Error(`Unexpected action ${String(prop)}`);
          return Reflect.get(target, prop, receiver);
        },
      });
      const dependencies = createAutoReconcileDependencies({
        lockKey: `auto:${ref.kind}:${ref.commandId}`,
        withLock: async (_key, task) => task(),
        now: () => 100,
        readIntent: vi.fn(async () => intent({ commandId: ref.commandId })),
        markAttempt: vi.fn(async () => true),
        markManualReconcileRequired: vi.fn(async () => true),
        markReconcileSucceeded: vi.fn(async () => true),
        actions,
      });
      await runAutoReconcileAttempt({
        ...dependencies,
        ref,
        now: 100,
      });
      expect(reconcile).toHaveBeenCalledWith(ref);
    }
  });

  it("uses the original commandId for reconcile", async () => {
    const originalCommandId = "download-00000000-0000-4000-8000-000000000042";
    const reconcile = vi.fn(async () => ({ ok: false, reason: "outcome_unknown" }));
    await runAutoReconcileAttempt({
      ref: { kind: "quick_start", commandId: originalCommandId },
      now: 100,
      lockKey: "auto:test",
      withLock: async (_key, task) => task(),
      readIntent: vi.fn(async () => intent({ commandId: originalCommandId })),
      markAttempt: vi.fn(async () => true),
      markManualReconcileRequired: vi.fn(async () => true),
      markReconcileSucceeded: vi.fn(async () => true),
      actions: { reconcile },
    });
    expect(reconcile).toHaveBeenCalledWith({ kind: "quick_start", commandId: originalCommandId });
  });
});
