import type { DetectedVideo } from "../types";
import type {
  CaptureHeaderLeaseAttemptBindingV1,
  CaptureHeaderLeaseBindingV1,
  CaptureHeaderLeaseV1,
  ClaimCaptureHeaderLeaseResult,
  CreateCaptureHeaderLeaseResult,
  ReleaseCaptureHeaderLeaseResult,
} from "./capture-header-leases";
import type { CaptureJobV1, CaptureReviewPlanV1 } from "./capture-pack-types";
import type { CapturedHeaders } from "./header-capture";
import { isWebmDirectVideo } from "./media-format";
import { deriveQuickCaptureStartIdentity } from "./quick-capture-start-intents";

export const QUICK_CAPTURE_SOURCE_AUTH_FREEZE_FAILED = "SOURCE_AUTH_FREEZE_FAILED";
export const QUICK_CAPTURE_SOURCE_AUTH_FREEZE_MESSAGE =
  "ClipHutch could not freeze this page's access for the download. Reload the page and try again.";

type CapturedHeaderEntry = {
  tabId: number;
  headers: CapturedHeaders;
};

export type QuickCaptureLeaseDependencies = {
  now(): number;
  hasReplayableHeaders(headers: CapturedHeaders): boolean;
  getCapturedHeaderEntry(mediaId: string): Promise<CapturedHeaderEntry | undefined>;
  createCaptureHeaderLease(
    input: CaptureHeaderLeaseBindingV1 & {
      authoritativeHeaders: CapturedHeaders;
      now: number;
    },
  ): Promise<CreateCaptureHeaderLeaseResult>;
  claimCaptureHeaderLease(
    input: CaptureHeaderLeaseAttemptBindingV1 & { now: number },
  ): Promise<ClaimCaptureHeaderLeaseResult>;
  releaseCaptureHeaderLease(
    input: CaptureHeaderLeaseBindingV1 & {
      owner:
        | { kind: "draft_item" }
        | ({ kind: "accepted_attempt" } & Pick<CaptureJobV1, "runId" | "jobId" | "attemptId">);
      now: number;
    },
  ): Promise<ReleaseCaptureHeaderLeaseResult>;
  retireClaimedCaptureHeaderLease(
    input: Pick<CaptureHeaderLeaseAttemptBindingV1, "leaseId" | "runId" | "jobId" | "attemptId"> & {
      now: number;
    },
  ): Promise<ReleaseCaptureHeaderLeaseResult>;
  cleanupSweptCaptureLeaseDnrOwners(leaseIds: readonly string[]): Promise<boolean>;
  scheduleCaptureLeaseExpiryAlarm(): Promise<boolean>;
};

export type ClaimedQuickCaptureHeaderLease = {
  binding: CaptureHeaderLeaseBindingV1;
  owner: Pick<CaptureHeaderLeaseAttemptBindingV1, "runId" | "jobId" | "attemptId">;
  headerLeaseIdsByItemId: Record<string, string>;
  expiresAt: number;
};

export type PrepareQuickCaptureHeaderLeaseResult =
  | { ok: true; lease: ClaimedQuickCaptureHeaderLease | null }
  | {
      ok: false;
      code: typeof QUICK_CAPTURE_SOURCE_AUTH_FREEZE_FAILED;
      error: typeof QUICK_CAPTURE_SOURCE_AUTH_FREEZE_MESSAGE;
    };

export function quickCaptureDownloadNeedsHeaderLease(media: DetectedVideo): boolean {
  return Boolean(
    media.hasCapturedReplayHeaders &&
      (media.kind === "hls" || media.kind === "dash" || isWebmDirectVideo(media)),
  );
}

function replayKind(kind: DetectedVideo["kind"]): CaptureHeaderLeaseBindingV1["replayKind"] {
  return kind === "hls" || kind === "dash" ? kind : "direct";
}

function failure(): Extract<PrepareQuickCaptureHeaderLeaseResult, { ok: false }> {
  return {
    ok: false,
    code: QUICK_CAPTURE_SOURCE_AUTH_FREEZE_FAILED,
    error: QUICK_CAPTURE_SOURCE_AUTH_FREEZE_MESSAGE,
  };
}

function oneReadyPlanItem(plan: CaptureReviewPlanV1) {
  const included = plan.items.filter((item) => item.include);
  return included.length === 1 && included[0].readiness === "ready" ? included[0] : undefined;
}

function quickCaptureLeaseBinding(input: {
  commandId: string;
  sourceTabId: number;
  media: DetectedVideo;
  plan: CaptureReviewPlanV1;
}): CaptureHeaderLeaseBindingV1 | undefined {
  const identity = deriveQuickCaptureStartIdentity(input.commandId);
  const item = oneReadyPlanItem(input.plan);
  if (
    !identity ||
    !item ||
    input.plan.planId !== identity.planId ||
    input.plan.draftId !== identity.draftId ||
    item.itemId !== identity.itemId ||
    item.media.mediaId !== input.media.id ||
    item.media.url !== input.media.url ||
    item.media.pageUrl === undefined ||
    item.media.kind !== input.media.kind
  ) {
    return undefined;
  }
  return {
    leaseId: `capture-header-lease-v1:${identity.coordinatorCommandId}`,
    draftId: input.plan.draftId,
    itemId: item.itemId,
    mediaId: item.media.mediaId,
    sourceTabId: input.sourceTabId,
    pageUrl: item.media.pageUrl,
    sourceUrl: item.media.url,
    replayKind: replayKind(input.media.kind),
  };
}

async function releaseDraftOwner(
  binding: CaptureHeaderLeaseBindingV1,
  dependencies: QuickCaptureLeaseDependencies,
): Promise<void> {
  await dependencies.releaseCaptureHeaderLease({
    ...binding,
    owner: { kind: "draft_item" },
    now: dependencies.now(),
  });
}

export async function prepareQuickCaptureHeaderLease(input: {
  commandId: string;
  sourceTabId: number;
  media: DetectedVideo;
  plan: CaptureReviewPlanV1;
  job: Pick<CaptureJobV1, "runId" | "jobId" | "attemptId" | "itemId">;
  dependencies: QuickCaptureLeaseDependencies;
}): Promise<PrepareQuickCaptureHeaderLeaseResult> {
  if (!quickCaptureDownloadNeedsHeaderLease(input.media)) {
    return { ok: true, lease: null };
  }
  const binding = quickCaptureLeaseBinding(input);
  if (!binding || input.job.itemId !== binding.itemId) return failure();
  const entry = await input.dependencies.getCapturedHeaderEntry(binding.mediaId);
  if (
    !entry ||
    entry.tabId !== input.sourceTabId ||
    !input.dependencies.hasReplayableHeaders(entry.headers)
  ) {
    return failure();
  }

  const created = await input.dependencies.createCaptureHeaderLease({
    ...binding,
    authoritativeHeaders: entry.headers,
    now: input.dependencies.now(),
  });
  if (!created.ok) return failure();
  if (
    !await input.dependencies.cleanupSweptCaptureLeaseDnrOwners(created.sweptExpiredLeaseIds) ||
    !await input.dependencies.scheduleCaptureLeaseExpiryAlarm()
  ) {
    await releaseDraftOwner(binding, input.dependencies);
    return failure();
  }

  const owner = {
    runId: input.job.runId,
    jobId: input.job.jobId,
    attemptId: input.job.attemptId,
  };
  const claimed = await input.dependencies.claimCaptureHeaderLease({
    ...binding,
    ...owner,
    now: input.dependencies.now(),
  });
  if (!claimed.ok) {
    await releaseDraftOwner(binding, input.dependencies);
    return failure();
  }

  return {
    ok: true,
    lease: {
      binding,
      owner,
      headerLeaseIdsByItemId: { [binding.itemId]: binding.leaseId },
      expiresAt: (claimed.lease as CaptureHeaderLeaseV1).expiresAt,
    },
  };
}

export async function retirePreparedQuickCaptureHeaderLease(
  lease: ClaimedQuickCaptureHeaderLease | null | undefined,
  dependencies: Pick<QuickCaptureLeaseDependencies, "now" | "retireClaimedCaptureHeaderLease">,
): Promise<boolean> {
  if (!lease) return true;
  const retired = await dependencies.retireClaimedCaptureHeaderLease({
    leaseId: lease.binding.leaseId,
    ...lease.owner,
    now: dependencies.now(),
  });
  return retired.ok;
}
