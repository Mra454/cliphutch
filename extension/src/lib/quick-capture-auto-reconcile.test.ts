import { describe, expect, it, vi } from "vitest";
import {
  AUTO_RECONCILE_MAX_ATTEMPTS,
  AUTO_RECONCILE_MIN_INTERVAL_MS,
  DEFAULT_AUTO_RECONCILE_STATE,
  autoReconcileAttemptsRemaining,
  normalizeAutoReconcileState,
  planAutoReconcileAttempt,
  runAutoReconcileAttempt,
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

  it("stops after five automatic attempts and marks manual reconcile", async () => {
    const markAttempt = vi.fn(async () => true);
    const markManual = vi.fn(async () => true);
    const result = await runAutoReconcileAttempt({
      intent: intent({
        autoReconcileAttemptCount: AUTO_RECONCILE_MAX_ATTEMPTS - 1,
        autoReconcileLastAttemptAt: 1,
      }),
      now: AUTO_RECONCILE_MIN_INTERVAL_MS + 2,
      markAttempt,
      markManualReconcileRequired: markManual,
      markReconcileSucceeded: vi.fn(async () => true),
      reconcileExistingStart: vi.fn(async () => ({ ok: false })),
    });
    expect(result).toMatchObject({ status: "attempted", attemptsRemaining: 0 });
    expect(markAttempt).toHaveBeenCalledWith(
      intent().commandId,
      {
        autoReconcileAttemptCount: AUTO_RECONCILE_MAX_ATTEMPTS,
        autoReconcileLastAttemptAt: AUTO_RECONCILE_MIN_INTERVAL_MS + 2,
        needsManualReconcile: false,
      } satisfies AutoReconcileStateV1,
    );
    expect(markManual).toHaveBeenCalledWith(intent().commandId);
  });

  it("resets the attempt policy after a successful reconcile", async () => {
    const markSucceeded = vi.fn(async () => true);
    const result = await runAutoReconcileAttempt({
      intent: intent({ autoReconcileAttemptCount: 3, autoReconcileLastAttemptAt: 1 }),
      now: AUTO_RECONCILE_MIN_INTERVAL_MS + 1,
      markAttempt: vi.fn(async () => true),
      markManualReconcileRequired: vi.fn(async () => true),
      markReconcileSucceeded: markSucceeded,
      reconcileExistingStart: vi.fn(async () => ({ ok: true })),
    });
    expect(result).toMatchObject({
      status: "attempted",
      attemptsRemaining: AUTO_RECONCILE_MAX_ATTEMPTS,
    });
    expect(markSucceeded).toHaveBeenCalledWith(intent().commandId);
  });

  it("uses the original commandId for reconcile and never starts a new download", async () => {
    const originalCommandId = "download-00000000-0000-4000-8000-000000000042";
    const reconcileExistingStart = vi.fn(async () => ({ ok: false }));
    const startNewDownload = vi.fn(async () => undefined);
    await runAutoReconcileAttempt({
      intent: intent({ commandId: originalCommandId }),
      now: 100,
      markAttempt: vi.fn(async () => true),
      markManualReconcileRequired: vi.fn(async () => true),
      markReconcileSucceeded: vi.fn(async () => true),
      reconcileExistingStart,
      startNewDownload,
    });
    expect(reconcileExistingStart).toHaveBeenCalledWith(originalCommandId);
    expect(startNewDownload).not.toHaveBeenCalled();
  });
});
