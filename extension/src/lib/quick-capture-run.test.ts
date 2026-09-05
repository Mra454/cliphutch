import { describe, expect, it, vi } from "vitest";
import type { CaptureHeaderLeaseV1 } from "./capture-header-leases";
import type { CaptureJobV1, CaptureReviewPlanV1 } from "./capture-pack-types";
import type { EnqueueCaptureRunInput, EnqueueCaptureRunResult } from "./capture-run-coordinator";
import {
  reconcileQuickCaptureRunStart,
  persistAndReconcileQuickCaptureRunStart,
  type QuickCaptureRunDependencies,
} from "./quick-capture-run";
import {
  deriveQuickCaptureStartIdentity,
  type QuickCaptureStartIntentV1,
} from "./quick-capture-start-intents";
import type { ClaimedQuickCaptureHeaderLease } from "./quick-capture-lease";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const commandId = `download-${uuid}`;
const identity = deriveQuickCaptureStartIdentity(commandId)!;

function plan(kind: "direct" | "hls" = "hls"): CaptureReviewPlanV1 {
  return {
    schemaVersion: 1,
    planId: identity.planId,
    draftId: identity.draftId,
    draftRevision: 1,
    generatedAt: 2_000,
    relativeRoot: "ClipHutch/Quick Capture",
    items: [{
      itemId: identity.itemId,
      include: true,
      media: {
        mediaId: "media-1",
        kind,
        url: kind === "hls"
          ? "https://cdn.example.test/video/master.m3u8"
          : "https://cdn.example.test/video.mp4",
        detectedAt: 1_000,
        pageUrl: "https://page.example.test/watch",
        provenance: ["network"],
      },
      plannedRelativePath: "ClipHutch/Quick Capture/video.mp4",
      copyChoice: {
        candidateId: "media-1",
        confidence: "exact",
        reason: "Exact media selected for Quick Capture.",
      },
      readiness: "ready",
      qualityChoice: kind === "hls"
        ? {
            mode: "stream",
            policy: { mode: "manual" },
            variantKind: "hls",
            variantUrl: "https://cdn.example.test/video/master.m3u8",
            estimateConfidence: "unknown",
          }
        : { mode: "direct" },
      warnings: [],
    }],
    totals: {
      included: 1,
      videos: 1,
      stills: 0,
      unknownSizeCount: 1,
      requiredFreeVideoSlots: 1,
    },
  };
}

function lease(): ClaimedQuickCaptureHeaderLease {
  return {
    binding: {
      leaseId: `capture-header-lease-v1:${uuid}`,
      draftId: identity.draftId,
      itemId: identity.itemId,
      mediaId: "media-1",
      sourceTabId: 7,
      pageUrl: "https://page.example.test/watch",
      sourceUrl: "https://cdn.example.test/video/master.m3u8",
      replayKind: "hls",
    },
    owner: {
      runId: identity.runId,
      jobId: "capture-job:v1:job",
      attemptId: "capture-attempt:v1:attempt",
    },
    headerLeaseIdsByItemId: {
      [identity.itemId]: `capture-header-lease-v1:${uuid}`,
    },
    expiresAt: 9_999,
  };
}

function intent(overrides: Partial<QuickCaptureStartIntentV1> = {}): QuickCaptureStartIntentV1 {
  return {
    schemaVersion: 1,
    commandId,
    coordinatorCommandId: identity.coordinatorCommandId,
    runId: identity.runId,
    licensed: false,
    plan: plan(),
    createdAt: 2_000,
    status: "pending",
    headerLease: lease(),
    ...overrides,
  } as QuickCaptureStartIntentV1;
}

function job(state: CaptureJobV1["state"] = "queued"): CaptureJobV1 {
  return {
    schemaVersion: 1,
    jobId: "capture-job:v1:job",
    runId: identity.runId,
    itemId: identity.itemId,
    attemptId: "capture-attempt:v1:attempt",
    attemptNo: 1,
    revision: 1,
    resourceClass: "heavy",
    state,
    snapshot: {
      media: plan().items[0]!.media,
      plannedRelativePath: "ClipHutch/Quick Capture/video.mp4",
      quality: plan().items[0]!.qualityChoice,
      headerLeaseId: `capture-header-lease-v1:${uuid}`,
    },
    ...(state === "failed"
      ? { error: { code: "MEDIA_UNSUPPORTED", customerMessage: "Unsupported.", retryable: false } }
      : {}),
  } as CaptureJobV1;
}

function deps(): QuickCaptureRunDependencies & {
  enqueued: EnqueueCaptureRunInput[];
  retired: ClaimedQuickCaptureHeaderLease[];
} {
  const enqueued: EnqueueCaptureRunInput[] = [];
  const retired: ClaimedQuickCaptureHeaderLease[] = [];
  return {
    enqueued,
    retired,
    now: vi.fn(() => 3_000),
    freeDownloadLimit: 3,
    enqueueCaptureRun: vi.fn(async (input: EnqueueCaptureRunInput): Promise<EnqueueCaptureRunResult> => {
      enqueued.push(input);
      return {
        ok: true,
        accepted: true,
        runId: input.runId,
        replayed: false,
        disposition: "accepted",
        queuedJobIds: ["capture-job:v1:job"],
        advancedJobIds: [],
        remainingPreparedJobIds: [],
        issues: [],
      };
    }),
    readOwnedQuickCaptureJob: vi.fn(async () => job()),
    updateQuickCaptureStartIntentDisposition: vi.fn(async ({ disposition }) => ({
      ok: true as const,
      changed: true,
      commitState: "committed" as const,
      intent: { ...intent(), status: "committed" as const, reconciliationDisposition: disposition },
      prunedCommandIds: [],
    })),
    abandonQuickCaptureStartIntent: vi.fn(async () => ({
      ok: true as const,
      changed: true,
      commitState: "committed" as const,
    })),
    createQuickCaptureStartIntent: vi.fn(async () => ({
      ok: true as const,
      changed: true,
      replayed: false,
      commitState: "committed" as const,
      intent: intent(),
      prunedCommandIds: [],
    })),
    getClaimedCaptureHeaderLease: vi.fn(async () => ({
      ok: true as const,
      lease: {
        schemaVersion: 1,
        ...lease().binding,
        createdAt: 2_000,
        expiresAt: 9_999,
        replayScope: {
          mode: "directory_prefix",
          origin: "https://cdn.example.test",
          requestDomain: "cdn.example.test",
          scopeUrl: "https://cdn.example.test/video/",
          urlFilter: "|https://cdn.example.test/video/",
          isUrlFilterCaseSensitive: true,
        },
        headers: { authorization: "Bearer token" },
        draftItemOwnerActive: true,
        acceptedAttemptOwner: lease().owner,
      } satisfies CaptureHeaderLeaseV1,
    })),
    retireQuickCaptureHeaderLease: vi.fn(async (input) => {
      retired.push(input);
      return true;
    }),
    scheduleCaptureQueueDrain: vi.fn(async () => undefined),
  };
}

describe("reconcileQuickCaptureRunStart", () => {
  it("validates a persisted restart lease and passes its item map into enqueue", async () => {
    const d = deps();
    await expect(reconcileQuickCaptureRunStart({ intent: intent(), dependencies: d }))
      .resolves.toEqual({ ok: true, jobId: "capture-job:v1:job" });
    expect(d.getClaimedCaptureHeaderLease).toHaveBeenCalledWith({
      leaseId: `capture-header-lease-v1:${uuid}`,
      runId: identity.runId,
      jobId: "capture-job:v1:job",
      attemptId: "capture-attempt:v1:attempt",
      now: 3_000,
    });
    expect(d.enqueued[0]!.headerLeaseIdsByItemId).toEqual({
      [identity.itemId]: `capture-header-lease-v1:${uuid}`,
    });
  });

  it.each([
    ["missing", { ok: true as const, lease: null }],
    ["expired", {
      ok: false as const,
      reason: "lease_expired" as const,
      leaseId: `capture-header-lease-v1:${uuid}`,
    }],
  ])("fails closed and retires when a restart lease is %s", async (_name, claimed) => {
    const d = deps();
    d.getClaimedCaptureHeaderLease = vi.fn(async () => claimed);
    await expect(reconcileQuickCaptureRunStart({ intent: intent(), dependencies: d }))
      .resolves.toMatchObject({
        ok: false,
        code: "SOURCE_AUTH_EXPIRED",
        error: "Source authorization expired. Reopen the source page and choose Download again.",
      });
    expect(d.enqueueCaptureRun).not.toHaveBeenCalled();
    expect(d.retired).toHaveLength(1);
    expect(d.abandonQuickCaptureStartIntent).toHaveBeenCalledWith({
      commandId,
      plan: plan(),
    });
  });

  it("retire calls are required when enqueue rejects a leased start", async () => {
    const d = deps();
    d.enqueueCaptureRun = vi.fn(async () => ({
      ok: false as const,
      accepted: false as const,
      reason: "invalid_plan" as const,
      code: "invalid_plan",
    }));
    await expect(reconcileQuickCaptureRunStart({
      intent: intent(),
      preparedLease: lease(),
      dependencies: d,
    })).resolves.toMatchObject({ ok: false, code: "invalid_plan" });
    expect(d.retired).toHaveLength(1);
  });

  it("old-shape non-header intents still reconcile", async () => {
    const d = deps();
    const oldIntent = intent({ plan: plan("direct") });
    delete (oldIntent as Partial<QuickCaptureStartIntentV1>).headerLease;
    await expect(reconcileQuickCaptureRunStart({ intent: oldIntent, dependencies: d }))
      .resolves.toEqual({ ok: true, jobId: "capture-job:v1:job" });
    expect(d.getClaimedCaptureHeaderLease).not.toHaveBeenCalled();
  });
});

describe("persistAndReconcileQuickCaptureRunStart", () => {
  it("persists the prepared lease on the intent input before enqueueing", async () => {
    const d = deps();
    await persistAndReconcileQuickCaptureRunStart({
      commandId,
      plan: plan(),
      licensed: false,
      preparedLease: lease(),
      dependencies: d,
    });
    expect(d.createQuickCaptureStartIntent).toHaveBeenCalledWith({
      commandId,
      plan: plan(),
      licensed: false,
      headerLease: lease(),
    });
  });

  it("retires the prepared lease when intent creation fails", async () => {
    const d = deps();
    d.createQuickCaptureStartIntent = vi.fn(async () => ({
      ok: false as const,
      reason: "invalid_input" as const,
      message: "bad",
    }));
    await expect(persistAndReconcileQuickCaptureRunStart({
      commandId,
      plan: plan(),
      licensed: false,
      preparedLease: lease(),
      dependencies: d,
    })).resolves.toMatchObject({ ok: false, code: "INVALID_COMMAND" });
    expect(d.retired).toHaveLength(1);
  });

  it.each([
    ["complete" as const, { ok: true, jobId: "capture-job:v1:job" }],
    ["cancelled" as const, { ok: false, code: "CANCELLED", error: "Download cancelled." }],
    ["failed" as const, { ok: false, code: "MEDIA_UNSUPPORTED", error: "Unsupported." }],
  ])("maps %s owned jobs at the orchestration layer", async (state, expected) => {
    const d = deps();
    d.readOwnedQuickCaptureJob = vi.fn(async () => job(state));
    await expect(reconcileQuickCaptureRunStart({
      intent: intent({ status: "committed", reconciliationDisposition: "accepted" } as Partial<QuickCaptureStartIntentV1>),
      preparedLease: lease(),
      dependencies: d,
    })).resolves.toEqual(expected);
  });

  it("returns outcome unknown when enqueue acceptance cannot be tied to the owned job", async () => {
    const d = deps();
    d.readOwnedQuickCaptureJob = vi.fn(async () => null);
    await expect(reconcileQuickCaptureRunStart({
      intent: intent(),
      preparedLease: lease(),
      dependencies: d,
    })).resolves.toMatchObject({ ok: false, code: "START_STATE_UNKNOWN", pending: true });
  });
});
