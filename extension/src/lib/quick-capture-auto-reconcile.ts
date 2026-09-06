export const AUTO_RECONCILE_MIN_INTERVAL_MS = 10_000;
export const AUTO_RECONCILE_MAX_ATTEMPTS = 5;

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

export type AutoReconcileRunResult<R> =
  | { status: "attempted"; result: R; attemptsRemaining: number }
  | { status: "rate_limited"; retryAt: number; attemptsRemaining: number }
  | { status: "manual_required" }
  | { status: "state_unavailable" };

export async function runAutoReconcileAttempt<R extends { ok: boolean }>(input: {
  intent: AutoReconcileIntent;
  now: number;
  markAttempt(commandId: string, state: AutoReconcileStateV1): Promise<boolean>;
  markManualReconcileRequired(commandId: string): Promise<boolean>;
  markReconcileSucceeded(commandId: string): Promise<boolean>;
  reconcileExistingStart(commandId: string): Promise<R>;
  startNewDownload?: (commandId: string) => Promise<unknown>;
}): Promise<AutoReconcileRunResult<R>> {
  const plan = planAutoReconcileAttempt(input.intent, input.now);
  if (plan.kind === "rate_limited") {
    return {
      status: "rate_limited",
      retryAt: plan.retryAt,
      attemptsRemaining: plan.attemptsRemaining,
    };
  }
  if (plan.kind === "manual_required") {
    await input.markManualReconcileRequired(input.intent.commandId);
    return { status: "manual_required" };
  }

  if (!await input.markAttempt(input.intent.commandId, plan.state)) {
    return { status: "state_unavailable" };
  }
  const result = await input.reconcileExistingStart(input.intent.commandId);
  if (result.ok) {
    await input.markReconcileSucceeded(input.intent.commandId);
  } else if (plan.attemptsRemainingAfterAttempt === 0) {
    await input.markManualReconcileRequired(input.intent.commandId);
  }
  return {
    status: "attempted",
    result,
    attemptsRemaining: result.ok ? AUTO_RECONCILE_MAX_ATTEMPTS : plan.attemptsRemainingAfterAttempt,
  };
}
