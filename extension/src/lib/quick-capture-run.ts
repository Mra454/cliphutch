import type { CaptureJobV1, CaptureReviewPlanV1 } from "./capture-pack-types";
import type {
  EnqueueCaptureRunInput,
  EnqueueCaptureRunResult,
} from "./capture-run-coordinator";
import type { GetClaimedCaptureHeaderLeaseResult } from "./capture-header-leases";
import type {
  AbandonQuickCaptureStartIntentResult,
  CreateQuickCaptureStartIntentResult,
  QuickCaptureStartDisposition,
  QuickCaptureStartHeaderLeaseV1,
  QuickCaptureStartIntentV1,
  UpdateQuickCaptureStartIntentResult,
} from "./quick-capture-start-intents";
import {
  QUICK_CAPTURE_SOURCE_AUTH_EXPIRED_MESSAGE,
  QUICK_CAPTURE_START_PENDING_MESSAGE,
} from "./quick-capture-run-messages";

export type QuickCaptureRunResponse =
  | { ok: true; jobId: string }
  | { ok: false; code: string; error: string; pending?: true; cleanupPending?: true };

export type QuickCaptureRunDependencies = {
  now(): number;
  freeDownloadLimit: number;
  createQuickCaptureStartIntent(input: {
    commandId: string;
    plan: CaptureReviewPlanV1;
    licensed: boolean;
    headerLease: QuickCaptureStartHeaderLeaseV1 | null;
  }): Promise<CreateQuickCaptureStartIntentResult>;
  abandonQuickCaptureStartIntent(input: {
    commandId: string;
    plan: CaptureReviewPlanV1;
  }): Promise<AbandonQuickCaptureStartIntentResult>;
  updateQuickCaptureStartIntentDisposition(input: {
    commandId: string;
    runId: string;
    disposition: QuickCaptureStartDisposition;
  }): Promise<UpdateQuickCaptureStartIntentResult>;
  enqueueCaptureRun(input: EnqueueCaptureRunInput): Promise<EnqueueCaptureRunResult>;
  readOwnedQuickCaptureJob(intent: QuickCaptureStartIntentV1): Promise<CaptureJobV1 | null>;
  getClaimedCaptureHeaderLease(input: {
    leaseId: string;
    runId: string;
    jobId: string;
    attemptId: string;
    now: number;
  }): Promise<GetClaimedCaptureHeaderLeaseResult>;
  retireQuickCaptureHeaderLease(lease: QuickCaptureStartHeaderLeaseV1): Promise<boolean>;
  scheduleCaptureLeaseExpiryAlarm(): unknown;
  scheduleCaptureQueueDrain(): void | Promise<void>;
};

function sourceAuthExpired(cleanupPending = false): QuickCaptureRunResponse {
  return {
    ok: false,
    code: "SOURCE_AUTH_EXPIRED",
    error: QUICK_CAPTURE_SOURCE_AUTH_EXPIRED_MESSAGE,
    ...(cleanupPending ? { cleanupPending: true } : {}),
  };
}

function outcomeUnknown(error = QUICK_CAPTURE_START_PENDING_MESSAGE): QuickCaptureRunResponse {
  return { ok: false, code: "START_STATE_UNKNOWN", error, pending: true };
}

function quickCaptureJobResponse(job: CaptureJobV1): QuickCaptureRunResponse {
  if (job.state === "failed" || job.state === "cancelled") {
    return {
      ok: false,
      code: job.error?.code ?? job.state.toUpperCase(),
      error: job.error?.customerMessage ??
        (job.state === "cancelled" ? "Download cancelled." : "Download failed."),
    };
  }
  if (job.state === "save_state_unknown") {
    return {
      ok: false,
      code: "START_STATE_UNKNOWN",
      error: "Chrome may already have accepted this file. Check Activity and Chrome downloads before trying again.",
    };
  }
  return { ok: true, jobId: job.jobId };
}

async function abandonPendingIntent(
  intent: QuickCaptureStartIntentV1,
  dependencies: QuickCaptureRunDependencies,
): Promise<boolean> {
  if (intent.status !== "pending") return true;
  const abandoned = await dependencies.abandonQuickCaptureStartIntent({
    commandId: intent.commandId,
    plan: intent.plan,
  });
  return abandoned.ok;
}

async function failClosedSourceAuthExpired(
  intent: QuickCaptureStartIntentV1,
  dependencies: QuickCaptureRunDependencies,
  lease?: QuickCaptureStartHeaderLeaseV1,
): Promise<QuickCaptureRunResponse> {
  let cleanupPending = false;
  if (lease && !await dependencies.retireQuickCaptureHeaderLease(lease)) {
    cleanupPending = true;
    await dependencies.scheduleCaptureLeaseExpiryAlarm();
  }
  if (!await abandonPendingIntent(intent, dependencies)) return outcomeUnknown();
  return sourceAuthExpired(cleanupPending);
}

async function validateRestartLease(
  lease: QuickCaptureStartHeaderLeaseV1,
  dependencies: QuickCaptureRunDependencies,
): Promise<boolean> {
  const claimed = await dependencies.getClaimedCaptureHeaderLease({
    leaseId: lease.binding.leaseId,
    ...lease.owner,
    now: dependencies.now(),
  });
  return Boolean(claimed.ok && claimed.lease);
}

function intentLease(
  intent: QuickCaptureStartIntentV1,
  preparedLease: QuickCaptureStartHeaderLeaseV1 | null | undefined,
): QuickCaptureStartHeaderLeaseV1 | null | undefined {
  // Persisted absence is legacy-only and predates header-dependent Quick starts;
  // explicit null is the new non-header marker, while objects must validate.
  return preparedLease === undefined ? intent.headerLease : preparedLease;
}

export async function reconcileQuickCaptureRunStart(input: {
  intent: QuickCaptureStartIntentV1;
  preparedLease?: QuickCaptureStartHeaderLeaseV1 | null;
  dependencies: QuickCaptureRunDependencies;
}): Promise<QuickCaptureRunResponse> {
  const lease = intentLease(input.intent, input.preparedLease);
  if (lease && input.preparedLease === undefined) {
    const valid = await validateRestartLease(lease, input.dependencies);
    if (!valid) {
      return failClosedSourceAuthExpired(input.intent, input.dependencies, lease);
    }
  }

  const result = await input.dependencies.enqueueCaptureRun({
    plan: input.intent.plan,
    commandId: input.intent.coordinatorCommandId,
    licensed: input.intent.licensed,
    runId: input.intent.runId,
    now: input.intent.createdAt,
    headerLeaseIdsByItemId: lease ? lease.headerLeaseIdsByItemId : {},
  });
  if (!result.ok) {
    if (lease && !await input.dependencies.retireQuickCaptureHeaderLease(lease)) {
      return outcomeUnknown();
    }
    if (input.intent.status === "pending" && !result.releaseFailed) {
      if (!await abandonPendingIntent(input.intent, input.dependencies)) return outcomeUnknown();
      const quotaBlocked = result.reason === "quota_unavailable";
      return {
        ok: false,
        code: quotaBlocked ? "RATE_LIMITED" : result.code,
        error: quotaBlocked
          ? `You've used all ${input.dependencies.freeDownloadLimit} free video downloads in the last 24 hours. Upgrade for unlimited video downloads.`
          : "ClipHutch could not queue this download safely.",
      };
    }
    return outcomeUnknown();
  }

  void input.dependencies.scheduleCaptureQueueDrain();
  const ownedJob = await input.dependencies.readOwnedQuickCaptureJob(input.intent);
  const observedDisposition = result.disposition === "accepted" && ownedJob
    ? "accepted"
    : result.disposition === "commit_state_unknown"
      ? "commit_state_unknown"
      : "recovery_needed";
  const updated = await input.dependencies.updateQuickCaptureStartIntentDisposition({
    commandId: input.intent.commandId,
    runId: input.intent.runId,
    disposition: observedDisposition,
  });
  if (
    !updated.ok ||
    updated.intent.reconciliationDisposition !== "accepted" ||
    !ownedJob
  ) {
    return outcomeUnknown();
  }
  return quickCaptureJobResponse(ownedJob);
}

export async function persistAndReconcileQuickCaptureRunStart(input: {
  commandId: string;
  plan: CaptureReviewPlanV1;
  licensed: boolean;
  preparedLease: QuickCaptureStartHeaderLeaseV1 | null;
  dependencies: QuickCaptureRunDependencies;
}): Promise<QuickCaptureRunResponse> {
  const created = await input.dependencies.createQuickCaptureStartIntent({
    commandId: input.commandId,
    plan: input.plan,
    licensed: input.licensed,
    headerLease: input.preparedLease,
  });
  if (!created.ok) {
    if (
      input.preparedLease &&
      !await input.dependencies.retireQuickCaptureHeaderLease(input.preparedLease)
    ) {
      return outcomeUnknown();
    }
    if (created.reason === "unresolved_intent") {
      return {
        ok: false,
        code: "PREVIOUS_START_UNRESOLVED",
        error: "ClipHutch is still checking an earlier download. Try again in a moment.",
      };
    }
    if (created.reason === "command_conflict" || created.reason === "invalid_input") {
      return {
        ok: false,
        code: "INVALID_COMMAND",
        error: "This download command no longer matches its original media selection.",
      };
    }
    return outcomeUnknown();
  }
  return reconcileQuickCaptureRunStart({
    intent: created.intent,
    preparedLease: input.preparedLease,
    dependencies: input.dependencies,
  });
}
