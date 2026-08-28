import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCaptureReviewPlan,
  enqueueCaptureReviewPlan,
  parseCaptureManifestRetryClientResult,
  parseCapturePlanClientResult,
  parseCaptureQuickReconcileClientResult,
  parseCaptureWorkspaceClientResult,
  reconcileQuickCaptureStart,
  retryCaptureManifest,
} from "./capture-review-client";
import {
  CAPTURE_PACK_SCHEMA_VERSION,
  type CaptureJobV1,
  type CaptureReviewPlanV1,
  type CaptureRunV1,
} from "./capture-pack-types";

const RUN_COMMAND_UUID = "123e4567-e89b-42d3-a456-426614174000";
const RUN_COMMAND_ID = `capture-run-${RUN_COMMAND_UUID}`;
const RUN_ID = `capture-run:v1:${RUN_COMMAND_UUID}`;
const QUICK_COMMAND_ID = `download-${RUN_COMMAND_UUID}`;
const QUICK_PLAN_ID = `capture-single-plan:${RUN_COMMAND_UUID}`;
const QUICK_DRAFT_ID = `capture-single-draft:${RUN_COMMAND_UUID}`;
const QUICK_ITEM_ID = `capture-single-item:${RUN_COMMAND_UUID}`;
const QUICK_JOB_ID = `capture-job:v1:${"b".repeat(64)}`;

const plan: CaptureReviewPlanV1 = {
  schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
  planId: "plan-1",
  draftId: "draft-1",
  draftRevision: 2,
  generatedAt: 10,
  relativeRoot: "ClipHutch/Pack",
  items: [{
    itemId: "item-1",
    include: true,
    media: {
      mediaId: "media-1",
      kind: "image",
      url: "https://cdn.example/image.jpg",
      detectedAt: 1,
      provenance: ["network"],
    },
    plannedRelativePath: "ClipHutch/Pack/example/image.jpg",
    readiness: "ready",
    copyChoice: { candidateId: "media-1", confidence: "exact", reason: "Exact selected item." },
    qualityChoice: { mode: "direct" },
    warnings: [],
  }],
  totals: {
    included: 1,
    videos: 0,
    stills: 1,
    unknownSizeCount: 1,
    requiredFreeVideoSlots: 0,
  },
};

const preparedRun: CaptureRunV1 = {
  schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
  runId: RUN_ID,
  planId: plan.planId,
  draftId: plan.draftId,
  draftRevision: plan.draftRevision,
  planDigest: "a".repeat(64),
  commandId: RUN_COMMAND_UUID,
  createdAt: 12,
  status: "queued",
  orderedJobIds: ["job-1"],
};

const preparedJob: CaptureJobV1 = {
  schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
  jobId: "job-1",
  runId: RUN_ID,
  itemId: "item-1",
  attemptId: "attempt-1",
  attemptNo: 1,
  revision: 0,
  resourceClass: "native",
  state: "prepared",
  snapshot: {
    media: { ...plan.items[0].media, provenance: [...plan.items[0].media.provenance] },
    plannedRelativePath: plan.items[0].plannedRelativePath,
    quality: { mode: "direct" },
  },
};

const quickRun: CaptureRunV1 = {
  ...preparedRun,
  planId: QUICK_PLAN_ID,
  draftId: QUICK_DRAFT_ID,
  draftRevision: 1,
  commandId: RUN_COMMAND_UUID,
  orderedJobIds: [QUICK_JOB_ID],
};

const quickJob: CaptureJobV1 = {
  ...preparedJob,
  jobId: QUICK_JOB_ID,
  runId: RUN_ID,
  itemId: QUICK_ITEM_ID,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("capture review client", () => {
  it("accepts guarded plan responses and rejects options for absent items", () => {
    expect(parseCapturePlanClientResult({ ok: true, plan, options: [] })).toEqual({
      ok: true,
      plan,
      options: [],
    });
    expect(parseCapturePlanClientResult({
      ok: true,
      plan,
      options: [{
        itemId: "absent",
        optionId: `capture-option-v1-${"a".repeat(40)}`,
        kind: "hls",
        label: "1080p",
        estimateConfidence: "unknown",
        supported: true,
      }],
    })).toBeUndefined();
    expect(parseCapturePlanClientResult({ ok: true, plan, options: [], extra: true })).toBeUndefined();
    expect(parseCapturePlanClientResult({
      ok: true,
      plan,
      options: [{
        itemId: "item-1",
        optionId: `capture-option-v1-${"b".repeat(40)}`,
        kind: "hls",
        label: "1080p",
        estimateConfidence: "unknown",
        supported: true,
      }],
    })).toBeUndefined();
  });

  it("parses bounded disabled and audio-inclusive quality rows without locators", () => {
    const { qualityChoice: _directQuality, ...streamItemBase } = plan.items[0];
    const streamPlan: CaptureReviewPlanV1 = {
      ...plan,
      items: [{
        ...streamItemBase,
        media: { ...plan.items[0].media, kind: "hls", url: "https://cdn.example/master.m3u8" },
        readiness: "needs_choice",
        warnings: [{ code: "QUALITY_SELECTION_REQUIRED", message: "Choose a quality." }],
      }],
      totals: { ...plan.totals, videos: 1, stills: 0, requiredFreeVideoSlots: 1 },
    };
    const row = {
      itemId: "item-1",
      optionId: `capture-option-v1-${"c".repeat(40)}`,
      kind: "hls" as const,
      label: "1920×1080 • 4.1 Mbps",
      width: 1920,
      height: 1080,
      videoBandwidth: 4_000_000,
      audioBandwidth: 128_000,
      combinedBandwidth: 4_128_000,
      durationSec: 120,
      estimatedBytes: 61_920_000,
      estimateConfidence: "estimated" as const,
      supported: false,
      disabledReason: "drm" as const,
    };
    const result = parseCapturePlanClientResult({ ok: true, plan: streamPlan, options: [row] });
    expect(result).toMatchObject({
      ok: true,
      options: [{ disabledReason: "drm", combinedBandwidth: 4_128_000 }],
    });
    expect(JSON.stringify(result)).not.toContain("master.m3u8?token");
    expect(parseCapturePlanClientResult({
      ok: true,
      plan: streamPlan,
      options: [{ ...row, selectedByPolicy: true }],
    })).toBeUndefined();
    const supportedRow = {
      ...row,
      supported: true,
      disabledReason: undefined,
      suggestedForConfirmation: true as const,
    };
    const suggested = parseCapturePlanClientResult({
      ok: true,
      plan: streamPlan,
      options: [supportedRow],
    });
    expect(suggested).toMatchObject({
      ok: true,
      options: [{ suggestedForConfirmation: true, supported: true }],
    });
    expect(parseCapturePlanClientResult({
      ok: true,
      plan: streamPlan,
      options: [
        supportedRow,
        {
          ...supportedRow,
          optionId: `capture-option-v1-${"d".repeat(40)}`,
        },
      ],
    })).toBeUndefined();
  });

  it("does not invoke hostile response accessors or coercion hooks", () => {
    const toString = vi.fn(() => "forged");
    expect(parseCapturePlanClientResult({
      ok: false,
      reason: { toString },
      draft: null,
    })).toBeUndefined();
    expect(toString).not.toHaveBeenCalled();

    const hostileOptions = new Proxy([{}], {
      getOwnPropertyDescriptor() { throw new Error("hostile"); },
    });
    expect(parseCapturePlanClientResult({ ok: true, plan, options: hostileOptions })).toBeUndefined();
    expect(parseCaptureQuickReconcileClientResult({
      ok: true,
      jobId: QUICK_JOB_ID,
      [Symbol("hidden")]: "forged",
    })).toBeUndefined();
  });

  it("rejects workspace jobs that do not belong to a returned run", () => {
    const value = {
      ok: true,
      draft: null,
      plans: [],
      runs: [],
      jobs: [{ unexpected: true }],
      manifests: [],
      quota: { licensed: false, limit: 4, used: 1, remaining: 3 },
      reviewContext: null,
      runContext: null,
      quickCaptureContext: null,
    };
    expect(parseCaptureWorkspaceClientResult(value)).toBeUndefined();
  });

  it("restores only a review context owned by a returned plan", () => {
    const value = {
      ok: true,
      draft: null,
      plans: [plan],
      runs: [],
      jobs: [],
      manifests: [],
      quota: { licensed: false, limit: 4, used: 1, remaining: 3 },
      reviewContext: {
        planId: plan.planId,
        commandId: "capture-plan-123e4567-e89b-42d3-a456-426614174000",
        choices: [],
        options: [],
      },
      runContext: null,
      quickCaptureContext: null,
    };
    expect(parseCaptureWorkspaceClientResult(value)).toMatchObject({
      ok: true,
      reviewContext: { planId: "plan-1", choices: [], options: [] },
    });
    expect(parseCaptureWorkspaceClientResult({
      ...value,
      reviewContext: { ...value.reviewContext, planId: "absent" },
    })).toBeUndefined();
  });

  it("restores a pending run command only for its exact returned plan", () => {
    const value = {
      ok: true,
      draft: null,
      plans: [plan],
      runs: [],
      jobs: [],
      manifests: [],
      quota: { licensed: false, limit: 4, used: 1, remaining: 3 },
      reviewContext: null,
      runContext: {
        commandId: RUN_COMMAND_ID,
        planId: plan.planId,
        draftId: plan.draftId,
        draftRevision: plan.draftRevision,
        requestedFreeVideoItemIds: [],
        licensed: false,
        status: "pending",
        reconciliationState: "pending",
      },
      quickCaptureContext: null,
    };
    expect(parseCaptureWorkspaceClientResult(value)).toMatchObject({
      ok: true,
      runContext: {
        commandId: RUN_COMMAND_ID,
        status: "pending",
      },
    });
    expect(parseCaptureWorkspaceClientResult({
      ...value,
      runContext: { ...value.runContext, planId: "other-plan" },
    })).toBeUndefined();
    expect(parseCaptureWorkspaceClientResult({
      ...value,
      runContext: { ...value.runContext, runId: "unexpected" },
    })).toBeUndefined();
  });

  it("restores committed missing-run recovery against a superseded historical plan", () => {
    const activePlan = { ...plan, planId: "plan-active", generatedAt: 20 };
    const value = {
      ok: true,
      draft: null,
      plans: [activePlan, plan],
      runs: [],
      jobs: [],
      manifests: [],
      quota: { licensed: false, limit: 4, used: 1, remaining: 3 },
      reviewContext: null,
      runContext: {
        commandId: RUN_COMMAND_ID,
        planId: plan.planId,
        draftId: plan.draftId,
        draftRevision: plan.draftRevision,
        requestedFreeVideoItemIds: [],
        licensed: false,
        status: "committed",
        reconciliationState: "committed_missing_run",
        runId: RUN_ID,
      },
      quickCaptureContext: null,
    };
    expect(parseCaptureWorkspaceClientResult(value)).toMatchObject({
      ok: true,
      plans: [{ planId: "plan-active" }, { planId: plan.planId }],
      runContext: {
        planId: plan.planId,
        reconciliationState: "committed_missing_run",
      },
    });
    expect(parseCaptureWorkspaceClientResult({
      ...value,
      runs: [preparedRun],
      jobs: [preparedJob],
      manifests: [],
    })).toBeUndefined();
  });

  it("restores a committed recoverable run with prepared jobs, then accepts a settled replay", () => {
    const recoveryWorkspace = {
      ok: true,
      draft: null,
      plans: [plan],
      runs: [preparedRun],
      jobs: [preparedJob],
      manifests: [],
      quota: { licensed: false, limit: 4, used: 1, remaining: 3 },
      reviewContext: null,
      runContext: {
        commandId: RUN_COMMAND_ID,
        planId: plan.planId,
        draftId: plan.draftId,
        draftRevision: plan.draftRevision,
        requestedFreeVideoItemIds: [],
        licensed: false,
        status: "committed",
        reconciliationState: "committed_recovery_needed",
        runId: RUN_ID,
      },
      quickCaptureContext: null,
    };
    expect(parseCaptureWorkspaceClientResult(recoveryWorkspace)).toMatchObject({
      ok: true,
      jobs: [{ state: "prepared" }],
      runContext: { reconciliationState: "committed_recovery_needed" },
    });
    expect(parseCaptureWorkspaceClientResult({
      ...recoveryWorkspace,
      runContext: null,
    })).toMatchObject({
      ok: true,
      runs: [{ runId: RUN_ID }],
      runContext: null,
    });
    expect(parseCaptureWorkspaceClientResult({
      ...recoveryWorkspace,
      runContext: {
        ...recoveryWorkspace.runContext,
        reconciliationState: "accepted",
      },
    })).toBeUndefined();
  });

  it("accepts only deterministic unresolved Quick Capture ownership", () => {
    const pending = {
      ok: true,
      draft: null,
      plans: [],
      runs: [],
      jobs: [],
      manifests: [],
      quota: { licensed: false, limit: 4, used: 1, remaining: 3 },
      reviewContext: null,
      runContext: null,
      quickCaptureContext: {
        commandId: QUICK_COMMAND_ID,
        runId: RUN_ID,
        planId: QUICK_PLAN_ID,
        itemId: QUICK_ITEM_ID,
        reconciliationState: "pending",
      },
    };
    expect(parseCaptureWorkspaceClientResult(pending)).toMatchObject({
      ok: true,
      quickCaptureContext: {
        commandId: QUICK_COMMAND_ID,
        reconciliationState: "pending",
      },
    });
    expect(parseCaptureWorkspaceClientResult({
      ...pending,
      quickCaptureContext: { ...pending.quickCaptureContext, planId: "forged-plan" },
    })).toBeUndefined();
    expect(parseCaptureWorkspaceClientResult({
      ...pending,
      quickCaptureContext: {
        ...pending.quickCaptureContext,
        commandId: `download-${RUN_COMMAND_UUID.toUpperCase()}`,
      },
    })).toBeUndefined();
    expect(parseCaptureWorkspaceClientResult({
      ...pending,
      runContext: {
        commandId: RUN_COMMAND_ID,
        planId: plan.planId,
        draftId: plan.draftId,
        draftRevision: plan.draftRevision,
        requestedFreeVideoItemIds: [],
        licensed: false,
        status: "pending",
        reconciliationState: "pending",
      },
    })).toBeUndefined();
  });

  it("binds an optional Quick Capture job only to its deterministic returned run and item", () => {
    const workspace = {
      ok: true,
      draft: null,
      plans: [],
      runs: [quickRun],
      jobs: [quickJob],
      manifests: [],
      quota: { licensed: false, limit: 4, used: 1, remaining: 3 },
      reviewContext: null,
      runContext: null,
      quickCaptureContext: {
        commandId: QUICK_COMMAND_ID,
        runId: RUN_ID,
        planId: QUICK_PLAN_ID,
        itemId: QUICK_ITEM_ID,
        reconciliationState: "recovery_needed",
        jobId: QUICK_JOB_ID,
      },
    };
    expect(parseCaptureWorkspaceClientResult(workspace)).toMatchObject({
      ok: true,
      quickCaptureContext: { jobId: QUICK_JOB_ID },
    });
    expect(parseCaptureWorkspaceClientResult({
      ...workspace,
      quickCaptureContext: { ...workspace.quickCaptureContext, itemId: `${QUICK_ITEM_ID}-other` },
    })).toBeUndefined();
    expect(parseCaptureWorkspaceClientResult({
      ...workspace,
      quickCaptureContext: {
        ...workspace.quickCaptureContext,
        jobId: `capture-job:v1:${"c".repeat(64)}`,
      },
    })).toBeUndefined();
    expect(parseCaptureWorkspaceClientResult({
      ...workspace,
      quickCaptureContext: {
        commandId: QUICK_COMMAND_ID,
        runId: RUN_ID,
        planId: QUICK_PLAN_ID,
        itemId: QUICK_ITEM_ID,
        reconciliationState: "recovery_needed",
      },
    })).toBeUndefined();
    expect(parseCaptureWorkspaceClientResult({
      ...workspace,
      jobs: [{ ...quickJob, itemId: `${QUICK_ITEM_ID}-wrong` }],
    })).toBeUndefined();
  });

  it("accepts only privacy-safe manifest summaries owned by normal returned runs", () => {
    const workspace = {
      ok: true,
      draft: null,
      plans: [],
      runs: [preparedRun],
      jobs: [preparedJob],
      manifests: [{
        runId: RUN_ID,
        outputs: [{ format: "json", state: "complete", downloadId: 7 }],
      }],
      quota: { licensed: false, limit: 4, used: 1, remaining: 3 },
      reviewContext: null,
      runContext: null,
      quickCaptureContext: null,
    };
    expect(parseCaptureWorkspaceClientResult(workspace)).toMatchObject({
      ok: true,
      manifests: [{ runId: RUN_ID, outputs: [{ state: "complete" }] }],
    });
    expect(parseCaptureWorkspaceClientResult({
      ...workspace,
      manifests: [{ ...workspace.manifests[0], runId: "run-not-returned" }],
    })).toBeUndefined();
    expect(parseCaptureWorkspaceClientResult({
      ...workspace,
      runs: [quickRun],
      jobs: [quickJob],
    })).toBeUndefined();
    expect(parseCaptureWorkspaceClientResult({
      ...workspace,
      manifests: [{ ...workspace.manifests[0], pageUrl: "https://private.example" }],
    })).toBeUndefined();
  });

  it("binds a manifest retry response to its requested run, format, and canonical command", async () => {
    expect(parseCaptureManifestRetryClientResult({
      ok: true,
      runId: RUN_ID,
      format: "json",
      replayed: false,
    })).toEqual({ ok: true, runId: RUN_ID, format: "json", replayed: false });
    expect(parseCaptureManifestRetryClientResult({
      ok: true,
      runId: RUN_ID,
      format: "json",
      replayed: false,
      downloadId: 7,
    })).toBeUndefined();
    expect(parseCaptureManifestRetryClientResult({
      ok: false,
      reason: "manifest_not_retryable",
      draft: null,
    })).toBeUndefined();

    const commandId = `capture-manifest-retry-${RUN_COMMAND_UUID}`;
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      runId: RUN_ID,
      format: "json",
      replayed: false,
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    await expect(retryCaptureManifest({
      runId: RUN_ID,
      format: "json",
      commandId: `capture-manifest-retry-${RUN_COMMAND_UUID.toUpperCase()}`,
    })).resolves.toEqual({
      ok: true,
      runId: RUN_ID,
      format: "json",
      replayed: false,
      commandId,
    });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "capture-manifest-retry",
      commandId,
      runId: RUN_ID,
      format: "json",
    });

    sendMessage.mockResolvedValueOnce({
      ok: true,
      runId: RUN_ID,
      format: "csv",
      replayed: false,
    });
    await expect(retryCaptureManifest({ runId: RUN_ID, format: "json", commandId }))
      .resolves.toMatchObject({ ok: false, reason: "mismatched_background_response", commandId });

    sendMessage.mockRejectedValueOnce(new Error("worker stopped after acceptance"));
    await expect(retryCaptureManifest({ runId: RUN_ID, format: "json", commandId }))
      .resolves.toEqual({ ok: false, reason: "outcome_unknown", commandId });
  });

  it("strictly parses and sends command-only Quick Capture reconciliation", async () => {
    expect(parseCaptureQuickReconcileClientResult({ ok: true, jobId: QUICK_JOB_ID })).toEqual({
      ok: true,
      jobId: QUICK_JOB_ID,
    });
    expect(parseCaptureQuickReconcileClientResult({
      ok: false,
      code: "PREVIOUS_START_UNRESOLVED",
      error: "Open Activity.",
    })).toEqual({
      ok: false,
      reason: "PREVIOUS_START_UNRESOLVED",
      code: "PREVIOUS_START_UNRESOLVED",
      customerMessage: "Open Activity.",
    });
    expect(parseCaptureQuickReconcileClientResult({
      ok: true,
      jobId: QUICK_JOB_ID,
      runId: "chosen-by-background",
    })).toBeUndefined();

    const sendMessage = vi.fn().mockResolvedValue({ ok: true, jobId: QUICK_JOB_ID });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    await expect(reconcileQuickCaptureStart(`download-${RUN_COMMAND_UUID.toUpperCase()}`)).resolves.toEqual({
      ok: true,
      commandId: QUICK_COMMAND_ID,
      runId: RUN_ID,
      planId: QUICK_PLAN_ID,
      itemId: QUICK_ITEM_ID,
      jobId: QUICK_JOB_ID,
    });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "capture-quick-reconcile",
      commandId: QUICK_COMMAND_ID,
    });
  });

  it("sends only the strict plan envelope and maps an unavailable background", async () => {
    const commandId = "capture-plan-123e4567-e89b-42d3-a456-426614174000";
    const commandPlan = {
      ...plan,
      planId: "capture-review-v1:123e4567-e89b-42d3-a456-426614174000",
    };
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, plan: commandPlan, options: [] });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const result = await createCaptureReviewPlan({
      draftId: "draft-1",
      expectedRevision: 2,
      commandId,
    });
    expect(result.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "capture-plan-create",
      commandId,
      draftId: "draft-1",
      expectedRevision: 2,
      choices: [],
    });

    sendMessage.mockResolvedValueOnce({ ok: true, plan, options: [] });
    await expect(createCaptureReviewPlan({
      draftId: "draft-1",
      expectedRevision: 2,
      commandId,
    })).resolves.toEqual({
      ok: false,
      reason: "mismatched_background_response",
      draft: null,
      commandId,
    });

    sendMessage.mockRejectedValueOnce(new Error("asleep"));
    await expect(createCaptureReviewPlan({
      draftId: "draft-1",
      expectedRevision: 2,
      commandId,
    })).resolves.toEqual({
      ok: false,
      reason: "outcome_unknown",
      draft: null,
      commandId,
    });
  });

  it("does not let the caller assert licensing, quota time, or a run ID", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      runId: "capture-run:v1:123e4567-e89b-42d3-a456-426614174000",
      replayed: false,
      disposition: "accepted",
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const result = await enqueueCaptureReviewPlan({
      planId: "plan-1",
      draftId: "draft-1",
      expectedRevision: 2,
      freeVideoItemIds: ["video-1"],
      commandId: "capture-run-123e4567-e89b-42d3-a456-426614174000",
    });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "capture-run-enqueue",
      commandId: "capture-run-123e4567-e89b-42d3-a456-426614174000",
      planId: "plan-1",
      draftId: "draft-1",
      expectedRevision: 2,
      freeVideoItemIds: ["video-1"],
    });
    expect(result).toMatchObject({ ok: true });

    sendMessage.mockResolvedValueOnce({
      ok: true,
      runId: RUN_ID,
      replayed: true,
      disposition: "accepted",
    });
    const uppercase = await enqueueCaptureReviewPlan({
      planId: "plan-1",
      draftId: "draft-1",
      expectedRevision: 2,
      freeVideoItemIds: ["video-1"],
      commandId: `capture-run-${RUN_COMMAND_UUID.toUpperCase()}`,
    });
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: "capture-run-enqueue",
      commandId: RUN_COMMAND_ID,
      planId: "plan-1",
      draftId: "draft-1",
      expectedRevision: 2,
      freeVideoItemIds: ["video-1"],
    });
    expect(uppercase).toMatchObject({ ok: true, commandId: RUN_COMMAND_ID });

    sendMessage.mockResolvedValueOnce({
      ok: true,
      runId: "capture-run:v1:different",
      replayed: false,
      disposition: "accepted",
    });
    await expect(enqueueCaptureReviewPlan({
      planId: "plan-1",
      draftId: "draft-1",
      expectedRevision: 2,
      freeVideoItemIds: ["video-1"],
      commandId: "capture-run-123e4567-e89b-42d3-a456-426614174000",
    })).resolves.toMatchObject({ ok: false, reason: "mismatched_background_response" });
  });
});
