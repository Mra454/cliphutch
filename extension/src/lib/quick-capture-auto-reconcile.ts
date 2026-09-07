/**
 * Automatic reconcile re-enters the same idempotent enqueue/reconcile path with
 * frozen original IDs. Its safety depends on PersistentCommandGate blocking a
 * second command execution (guarded by "uses the real background dependency
 * shape with one reconcile action and frozen refs"), withKeyLock serializing
 * read/count/write/reconcile ("serializes concurrent triggers by reading,
 * counting, and persisting inside the lock"), deterministic run IDs
 * ("uses the original commandId for reconcile"), and quota reservation replay
 * ("classifies every known reconcile disposition and status explicitly").
 */
export const AUTO_RECONCILE_MIN_INTERVAL_MS = 10_000;
export const AUTO_RECONCILE_MAX_ATTEMPTS = 5;

export type AutoReconcileKind = "quick_start" | "pack_run" | "manifest_export";

export type AutoReconcileRef =
  | { kind: "quick_start"; commandId: string }
  | { kind: "pack_run"; commandId: string }
  | { kind: "manifest_export"; commandId: string; runId: string; format: "json" | "csv" };

export type AutoReconcileStateV1 = {
  autoReconcileAttemptCount: number;
  autoReconcileLastAttemptAt?: number;
  needsManualReconcile: boolean;
};

export type AutoReconcileIntent = AutoReconcileStateV1 & {
  commandId: string;
};

export const DEFAULT_AUTO_RECONCILE_STATE: AutoReconcileStateV1 = {
  autoReconcileAttemptCount: 0,
  needsManualReconcile: false,
};

export type AutoReconcilePlan =
  | {
      kind: "attempt";
      state: AutoReconcileStateV1;
      attemptsRemainingAfterAttempt: number;
    }
  | { kind: "rate_limited"; retryAt: number; attemptsRemaining: number }
  | { kind: "manual_required" };

export function isAutoReconcileAttemptCount(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= AUTO_RECONCILE_MAX_ATTEMPTS;
}

export function isAutoReconcileTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeAutoReconcileState(input: {
  autoReconcileAttemptCount?: unknown;
  autoReconcileLastAttemptAt?: unknown;
  needsManualReconcile?: unknown;
}): AutoReconcileStateV1 | undefined {
  const hasAny = input.autoReconcileAttemptCount !== undefined ||
    input.autoReconcileLastAttemptAt !== undefined ||
    input.needsManualReconcile !== undefined;
  if (!hasAny) return { ...DEFAULT_AUTO_RECONCILE_STATE };
  if (
    !isAutoReconcileAttemptCount(input.autoReconcileAttemptCount) ||
    typeof input.needsManualReconcile !== "boolean" ||
    (input.autoReconcileLastAttemptAt !== undefined &&
      !isAutoReconcileTimestamp(input.autoReconcileLastAttemptAt))
  ) {
    return undefined;
  }
  return {
    autoReconcileAttemptCount: input.autoReconcileAttemptCount,
    ...(input.autoReconcileLastAttemptAt === undefined
      ? {}
      : { autoReconcileLastAttemptAt: input.autoReconcileLastAttemptAt }),
    needsManualReconcile: input.needsManualReconcile,
  };
}

export function planAutoReconcileAttempt(
  intent: AutoReconcileIntent,
  now: number,
): AutoReconcilePlan {
  if (
    intent.needsManualReconcile ||
    intent.autoReconcileAttemptCount >= AUTO_RECONCILE_MAX_ATTEMPTS
  ) {
    return { kind: "manual_required" };
  }
  const lastAttemptAt = intent.autoReconcileLastAttemptAt;
  if (
    lastAttemptAt !== undefined &&
    now < lastAttemptAt + AUTO_RECONCILE_MIN_INTERVAL_MS
  ) {
    return {
      kind: "rate_limited",
      retryAt: lastAttemptAt + AUTO_RECONCILE_MIN_INTERVAL_MS,
      attemptsRemaining: AUTO_RECONCILE_MAX_ATTEMPTS - intent.autoReconcileAttemptCount,
    };
  }
  const nextAttemptCount = intent.autoReconcileAttemptCount + 1;
  return {
    kind: "attempt",
    state: {
      autoReconcileAttemptCount: nextAttemptCount,
      autoReconcileLastAttemptAt: now,
      needsManualReconcile: false,
    },
    attemptsRemainingAfterAttempt: AUTO_RECONCILE_MAX_ATTEMPTS - nextAttemptCount,
  };
}

export function autoReconcileAttemptsRemaining(intent: AutoReconcileIntent): number {
  return intent.needsManualReconcile
    ? 0
    : Math.max(0, AUTO_RECONCILE_MAX_ATTEMPTS - intent.autoReconcileAttemptCount);
}

export type AutoReconcileResolution = "resolved" | "unresolved";

export type AutoReconcileRunResult<R> =
  | { status: "attempted"; result: R; attemptsRemaining: number }
  | { status: "rate_limited"; retryAt: number; attemptsRemaining: number }
  | { status: "manual_required" }
  | { status: "state_unavailable" };

type ResponseRecord = {
  ok?: unknown;
  jobId?: unknown;
  runId?: unknown;
  disposition?: unknown;
  status?: unknown;
  code?: unknown;
  reason?: unknown;
  pending?: unknown;
};

function responseRecord(value: unknown): ResponseRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ResponseRecord
    : undefined;
}

/**
 * Explicit response map:
 * - handleCaptureRunEnqueue dispositions: accepted + runId => RESOLVED;
 *   recovery_needed, commit_state_unknown, missing/unknown => UNRESOLVED.
 * - reconcileQuickCaptureRunStart: ok + jobId => RESOLVED;
 *   pending/START_STATE_UNKNOWN/outcome_unknown => UNRESOLVED; responses
 *   tagged failed/cancelled/abandoned by the background are RESOLVED.
 * - run-context recovery statuses: completed/complete, failed, cancelled,
 *   abandoned => RESOLVED; pending, queued, running, partial, and unknown/new
 *   statuses => UNRESOLVED.
 */
export function classifyAutoReconcileResponse(value: unknown): AutoReconcileResolution {
  const response = responseRecord(value);
  if (!response) return "unresolved";
  const terminalStatuses = new Set(["completed", "complete", "failed", "cancelled", "abandoned"]);
  if (typeof response.status === "string") {
    return terminalStatuses.has(response.status) ? "resolved" : "unresolved";
  }
  if (response.ok === true) {
    if (response.disposition !== undefined) {
      return response.disposition === "accepted" && typeof response.runId === "string"
        ? "resolved"
        : "unresolved";
    }
    if (typeof response.jobId === "string") return "resolved";
    return "unresolved";
  }
  if (response.ok === false) {
    if (response.pending === true) return "unresolved";
    if (response.code === "START_STATE_UNKNOWN") return "unresolved";
    if (
      response.reason === "outcome_unknown" ||
      response.reason === "manifest_attempt_failed"
    ) return "unresolved";
    return response.code === "CANCELLED" ||
        response.code === "RATE_LIMITED" ||
        response.code === "SOURCE_AUTH_EXPIRED"
      ? "resolved"
      : "unresolved";
  }
  return "unresolved";
}

export type AutoReconcileDependencies<R> = {
  lockKey: string;
  withLock<T>(key: string, task: () => Promise<T>): Promise<T>;
  now(): number;
  readIntent(ref: AutoReconcileRef): Promise<AutoReconcileIntent | null>;
  markAttempt(ref: AutoReconcileRef, state: AutoReconcileStateV1): Promise<boolean>;
  markManualReconcileRequired(ref: AutoReconcileRef): Promise<boolean>;
  markReconcileSucceeded(ref: AutoReconcileRef): Promise<boolean>;
  actions: {
    reconcile(ref: AutoReconcileRef): Promise<R>;
  };
};

export async function runAutoReconcileAttempt<R>(input: {
  ref: AutoReconcileRef;
  now: number;
  lockKey: string;
} & Omit<AutoReconcileDependencies<R>, "now">): Promise<AutoReconcileRunResult<R>> {
  return input.withLock(input.lockKey, async () => {
    const intent = await input.readIntent(input.ref);
    if (!intent) return { status: "state_unavailable" };
    const plan = planAutoReconcileAttempt(intent, input.now);
    if (plan.kind === "rate_limited") {
      return {
        status: "rate_limited",
        retryAt: plan.retryAt,
        attemptsRemaining: plan.attemptsRemaining,
      };
    }
    if (plan.kind === "manual_required") {
      await input.markManualReconcileRequired(input.ref);
      return { status: "manual_required" };
    }

    if (!await input.markAttempt(input.ref, plan.state)) {
      return { status: "state_unavailable" };
    }
    const result = await input.actions.reconcile(input.ref);
    const resolution = classifyAutoReconcileResponse(result);
    if (resolution === "resolved") {
      await input.markReconcileSucceeded(input.ref);
    } else if (plan.attemptsRemainingAfterAttempt === 0) {
      await input.markManualReconcileRequired(input.ref);
    }
    return {
      status: "attempted",
      result,
      attemptsRemaining: resolution === "resolved"
        ? AUTO_RECONCILE_MAX_ATTEMPTS
        : plan.attemptsRemainingAfterAttempt,
    };
  });
}

export function autoReconcileLockKey(ref: AutoReconcileRef): string {
  return ref.kind === "manifest_export"
    ? `auto-reconcile:${ref.kind}:${ref.runId}:${ref.format}:${ref.commandId}`
    : `auto-reconcile:${ref.kind}:${ref.commandId}`;
}

export function createAutoReconcileDependencies<R>(
  dependencies: AutoReconcileDependencies<R>,
): AutoReconcileDependencies<R> {
  return dependencies;
}
