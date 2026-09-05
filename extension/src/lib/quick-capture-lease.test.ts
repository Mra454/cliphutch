import { describe, expect, it, vi } from "vitest";
import type { DetectedVideo } from "../types";
import type {
  CaptureHeaderLeaseBindingV1,
  CaptureHeaderLeaseV1,
} from "./capture-header-leases";
import type { CaptureJobV1, CaptureReviewPlanV1 } from "./capture-pack-types";
import {
  QUICK_CAPTURE_SOURCE_AUTH_FREEZE_FAILED,
  QUICK_CAPTURE_SOURCE_AUTH_FREEZE_MESSAGE,
  prepareQuickCaptureHeaderLease,
  quickCaptureDownloadNeedsHeaderLease,
  retirePreparedQuickCaptureHeaderLease,
  type QuickCaptureLeaseDependencies,
} from "./quick-capture-lease";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const commandId = `download-${uuid}`;
const itemId = `capture-single-item:${uuid}`;
const draftId = `capture-single-draft:${uuid}`;
const planId = `capture-single-plan:${uuid}`;
const mediaId = "detected-v1-t1-source";
const sourceUrl = "https://cdn.example.test/video/master.m3u8";
const pageUrl = "https://page.example.test/watch";

function detected(overrides: Partial<DetectedVideo> = {}): DetectedVideo {
  return {
    id: mediaId,
    url: sourceUrl,
    kind: "hls",
    detectedAt: 1_000,
    pageUrl,
    hasCapturedReplayHeaders: true,
    ...overrides,
  };
}

function plan(kind: "hls" | "dash" | "direct" = "hls"): CaptureReviewPlanV1 {
  return {
    schemaVersion: 1,
    planId,
    draftId,
    draftRevision: 1,
    generatedAt: 2_000,
    relativeRoot: "ClipHutch/Quick Capture",
    items: [{
      itemId,
      include: true,
      media: {
        mediaId,
        kind,
        url: sourceUrl,
        detectedAt: 1_000,
        firstSeenAt: 1_000,
        lastSeenAt: 1_000,
        pageUrl,
        provenance: ["network"],
      },
      plannedRelativePath: "ClipHutch/Quick Capture/video.mp4",
      copyChoice: {
        candidateId: mediaId,
        confidence: "exact",
        reason: "Exact media selected for Quick Capture.",
      },
      readiness: "ready",
      qualityChoice: kind === "direct"
        ? { mode: "direct" }
        : kind === "hls"
          ? {
            mode: "stream",
            policy: { mode: "manual" },
            variantKind: "hls",
            variantUrl: sourceUrl,
            estimateConfidence: "unknown",
          }
          : {
              mode: "stream",
              policy: { mode: "manual" },
              variantKind: "dash",
              representationId: "video",
              estimateConfidence: "unknown",
            },
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

function job(): Pick<CaptureJobV1, "runId" | "jobId" | "attemptId" | "itemId"> {
  return {
    runId: `capture-run:v1:${uuid}`,
    jobId: "capture-job:v1:job",
    attemptId: "capture-attempt:v1:attempt",
    itemId,
  };
}

function lease(binding: CaptureHeaderLeaseBindingV1, expiresAt = 3_602_000): CaptureHeaderLeaseV1 {
  return {
    schemaVersion: 1,
    ...binding,
    createdAt: 2_000,
    expiresAt,
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
    acceptedAttemptOwner: null,
  };
}

function deps(): QuickCaptureLeaseDependencies & {
  createdBindings: CaptureHeaderLeaseBindingV1[];
} {
  const createdBindings: CaptureHeaderLeaseBindingV1[] = [];
  return {
    createdBindings,
    now: vi.fn(() => 2_000),
    hasReplayableHeaders: vi.fn((headers) => Boolean(headers.authorization)),
    getCapturedHeaderEntry: vi.fn(async () => ({
      tabId: 7,
      headers: { authorization: "Bearer token" },
    })),
    createCaptureHeaderLease: vi.fn(async (input) => {
      const binding = {
        leaseId: input.leaseId,
        draftId: input.draftId,
        itemId: input.itemId,
        mediaId: input.mediaId,
        sourceTabId: input.sourceTabId,
        pageUrl: input.pageUrl,
        sourceUrl: input.sourceUrl,
        replayKind: input.replayKind,
      };
      createdBindings.push(binding);
      return {
        ok: true as const,
        changed: true,
        replayed: false,
        commitState: "committed" as const,
        lease: lease(binding),
        sweptExpiredLeaseIds: [],
      };
    }),
    claimCaptureHeaderLease: vi.fn(async (input) => ({
      ok: true as const,
      changed: true,
      replayed: false,
      commitState: "committed" as const,
      lease: lease(input, 9_999),
    })),
    releaseCaptureHeaderLease: vi.fn(async () => ({
      ok: true as const,
      changed: true,
      replayed: false,
      commitState: "committed" as const,
      lease: null,
      expired: false,
    })),
    retireClaimedCaptureHeaderLease: vi.fn(async () => ({
      ok: true as const,
      changed: true,
      replayed: false,
      commitState: "committed" as const,
      lease: null,
      expired: false,
    })),
    cleanupSweptCaptureLeaseDnrOwners: vi.fn(async () => true),
    scheduleCaptureLeaseExpiryAlarm: vi.fn(async () => true),
  };
}

describe("quickCaptureDownloadNeedsHeaderLease", () => {
  it("requires a lease for header-captured HLS, DASH, and WebM sources only", () => {
    expect(quickCaptureDownloadNeedsHeaderLease(detected({ kind: "hls" }))).toBe(true);
    expect(quickCaptureDownloadNeedsHeaderLease(detected({ kind: "dash", url: "https://cdn.example.test/v.mpd" }))).toBe(true);
    expect(quickCaptureDownloadNeedsHeaderLease(detected({
      kind: "direct",
      url: "https://cdn.example.test/v.webm",
      contentType: "video/webm",
    }))).toBe(true);
    expect(quickCaptureDownloadNeedsHeaderLease(detected({
      kind: "direct",
      url: "https://cdn.example.test/v.mp4",
      contentType: "video/mp4",
    }))).toBe(false);
    expect(quickCaptureDownloadNeedsHeaderLease(detected({ hasCapturedReplayHeaders: false }))).toBe(false);
  });
});

describe("prepareQuickCaptureHeaderLease", () => {
  it("creates and claims a bounded lease for the hidden single-item draft", async () => {
    const d = deps();
    const result = await prepareQuickCaptureHeaderLease({
      commandId,
      sourceTabId: 7,
      media: detected(),
      plan: plan(),
      job: job(),
      dependencies: d,
    });

    expect(result).toMatchObject({
      ok: true,
      lease: {
        expiresAt: 9_999,
        headerLeaseIdsByItemId: { [itemId]: `capture-header-lease-v1:${uuid}` },
      },
    });
    expect(d.createCaptureHeaderLease).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: `capture-header-lease-v1:${uuid}`,
      draftId,
      itemId,
      mediaId,
      sourceTabId: 7,
      pageUrl,
      sourceUrl,
      replayKind: "hls",
      authoritativeHeaders: { authorization: "Bearer token" },
    }));
    expect(d.claimCaptureHeaderLease).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: `capture-header-lease-v1:${uuid}`,
      runId: `capture-run:v1:${uuid}`,
      jobId: "capture-job:v1:job",
      attemptId: "capture-attempt:v1:attempt",
    }));
  });

  it("returns a typed error and releases the draft owner when claiming fails", async () => {
    const d = deps();
    d.claimCaptureHeaderLease = vi.fn(async () => ({
      ok: false as const,
      reason: "lease_conflict" as const,
      leaseId: `capture-header-lease-v1:${uuid}`,
    }));

    await expect(prepareQuickCaptureHeaderLease({
      commandId,
      sourceTabId: 7,
      media: detected(),
      plan: plan(),
      job: job(),
      dependencies: d,
    })).resolves.toEqual({
      ok: false,
      code: QUICK_CAPTURE_SOURCE_AUTH_FREEZE_FAILED,
      error: QUICK_CAPTURE_SOURCE_AUTH_FREEZE_MESSAGE,
    });
    expect(d.releaseCaptureHeaderLease).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: `capture-header-lease-v1:${uuid}`,
      owner: { kind: "draft_item" },
    }));
  });

  it("does not create or claim a lease for non-header sources", async () => {
    const d = deps();
    const result = await prepareQuickCaptureHeaderLease({
      commandId,
      sourceTabId: 7,
      media: detected({ hasCapturedReplayHeaders: false }),
      plan: plan(),
      job: job(),
      dependencies: d,
    });

    expect(result).toEqual({ ok: true, lease: null });
    expect(d.createCaptureHeaderLease).not.toHaveBeenCalled();
    expect(d.claimCaptureHeaderLease).not.toHaveBeenCalled();
  });

  it("retires a prepared claim when the accepted start is rejected", async () => {
    const d = deps();
    const prepared = await prepareQuickCaptureHeaderLease({
      commandId,
      sourceTabId: 7,
      media: detected(),
      plan: plan(),
      job: job(),
      dependencies: d,
    });
    expect(prepared.ok).toBe(true);
    const released = await retirePreparedQuickCaptureHeaderLease(
      prepared.ok ? prepared.lease : null,
      d,
    );

    expect(released).toBe(true);
    expect(d.retireClaimedCaptureHeaderLease).toHaveBeenCalledWith({
      leaseId: `capture-header-lease-v1:${uuid}`,
      runId: `capture-run:v1:${uuid}`,
      jobId: "capture-job:v1:job",
      attemptId: "capture-attempt:v1:attempt",
      now: 2_000,
    });
  });
});
