import { describe, expect, it } from "vitest";
import {
  OffscreenAttemptRegistry,
  parseCaptureExecutionSnapshotDiscardMessageV1,
  parseCaptureExecutionSnapshotDiscardResponseV1,
  parseCaptureVariantInspectMessageV1,
  parseCaptureVariantInspectResponseV1,
  parseOffscreenIncomingMessage,
  type AttemptIdentity,
} from "./offscreen-attempts";

const EXECUTION_SNAPSHOT_ID =
  "execution-snapshot-v1:123e4567-e89b-42d3-a456-426614174000";

describe("offscreen message parser", () => {
  it("accepts legacy and attempt-scoped starts", () => {
    expect(
      parseOffscreenIncomingMessage({
        type: "hls-download-start",
        jobId: "hls-job-1",
        url: "https://cdn.example/master.m3u8",
        sizeCapBytes: 1024,
        variantUrl: "https://cdn.example/1080.m3u8",
        audioUrl: "https://cdn.example/audio.m3u8",
        exactVariantSelection: true,
        executionSnapshotId: EXECUTION_SNAPSHOT_ID,
        authorizationExpiresAt: 9_999,
      }),
    ).toEqual({
      type: "hls-download-start",
      jobId: "hls-job-1",
      url: "https://cdn.example/master.m3u8",
      sizeCapBytes: 1024,
      variantUrl: "https://cdn.example/1080.m3u8",
      audioUrl: "https://cdn.example/audio.m3u8",
      exactVariantSelection: true,
      executionSnapshotId: EXECUTION_SNAPSHOT_ID,
      authorizationExpiresAt: 9_999,
    });

    expect(
      parseOffscreenIncomingMessage({
        type: "dash-download-start",
        jobId: "dash-job-1",
        attemptId: "attempt-1",
        url: "https://cdn.example/manifest.mpd",
        sizeCapBytes: 2048,
        videoRepresentationId: "video representation 1080p",
        executionSnapshotId: EXECUTION_SNAPSHOT_ID,
      }),
    ).toMatchObject({
      type: "dash-download-start",
      jobId: "dash-job-1",
      attemptId: "attempt-1",
    });

    expect(
      parseOffscreenIncomingMessage({
        type: "webm-transcode-start",
        jobId: "webm-job-1",
        attemptId: "attempt-2",
        url: "https://cdn.example/video.webm",
        sizeCapBytes: 4096,
      }),
    ).toMatchObject({ type: "webm-transcode-start", attemptId: "attempt-2" });
  });

  it("accepts exact cancel, revoke, status, and variant messages", () => {
    expect(
      parseOffscreenIncomingMessage({
        type: "hls-download-cancel",
        jobId: "hls-job-1",
        attemptId: "attempt-1",
      }),
    ).toEqual({ type: "hls-download-cancel", jobId: "hls-job-1", attemptId: "attempt-1" });
    expect(
      parseOffscreenIncomingMessage({ type: "dash-download-revoke", jobId: "dash-job-1" }),
    ).toEqual({ type: "dash-download-revoke", jobId: "dash-job-1" });
    expect(parseOffscreenIncomingMessage({ type: "capture-executor-status" })).toEqual({
      type: "capture-executor-status",
    });
    expect(
      parseOffscreenIncomingMessage({
        type: "list-variants-start",
        url: "https://cdn.example/master.m3u8",
        kind: "hls",
      }),
    ).toEqual({
      type: "list-variants-start",
      url: "https://cdn.example/master.m3u8",
      kind: "hls",
    });
    expect(
      parseOffscreenIncomingMessage({
        type: "capture-variant-inspect",
        requestId: "request-1",
        reviewId: "review-1",
        url: "https://cdn.example/master.m3u8?token=secret",
        kind: "hls",
        deadlineAt: 10_000,
        retainForExecution: true,
      }),
    ).toEqual({
      type: "capture-variant-inspect",
      requestId: "request-1",
      reviewId: "review-1",
      url: "https://cdn.example/master.m3u8?token=secret",
      kind: "hls",
      deadlineAt: 10_000,
      retainForExecution: true,
    });
    expect(
      parseCaptureVariantInspectMessageV1({
        type: "capture-variant-inspect",
        requestId: "request-1",
        reviewId: "review-1",
        url: "https://cdn.example/master.m3u8?token=secret",
        kind: "hls",
        deadlineAt: 10_000,
        retainForExecution: true,
      }),
    ).toMatchObject({ requestId: "request-1", reviewId: "review-1" });
    expect(
      parseCaptureVariantInspectMessageV1({ type: "capture-executor-status" }),
    ).toBeUndefined();
    expect(
      parseCaptureExecutionSnapshotDiscardMessageV1({
        type: "capture-execution-snapshot-discard",
        executionSnapshotId: EXECUTION_SNAPSHOT_ID,
      }),
    ).toEqual({
      type: "capture-execution-snapshot-discard",
      executionSnapshotId: EXECUTION_SNAPSHOT_ID,
    });
  });

  it("rejects malformed and overprivileged messages", () => {
    const start = {
      type: "hls-download-start",
      jobId: "hls-job-1",
      url: "https://cdn.example/master.m3u8",
      sizeCapBytes: 1024,
    };
    expect(parseOffscreenIncomingMessage({ ...start, url: "file:///tmp/video.m3u8" })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...start, sizeCapBytes: 0 })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...start, sizeCapBytes: 1.5 })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...start, authorizationExpiresAt: 0 })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...start, authorizationExpiresAt: 1.5 })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...start, jobId: "../../job" })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...start, attemptId: "attempt/escape" })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...start, headers: { Authorization: "secret" } })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...start, blobUrl: "blob:attacker" })).toBeUndefined();
    expect(
      parseOffscreenIncomingMessage({ ...start, executionSnapshotId: "snapshot-without-uuid" }),
    ).toBeUndefined();
    expect(
      parseOffscreenIncomingMessage({ ...start, executionSnapshotId: EXECUTION_SNAPSHOT_ID }),
    ).toBeUndefined();
    expect(
      parseOffscreenIncomingMessage({ ...start, exactVariantSelection: true }),
    ).toBeUndefined();
    expect(
      parseOffscreenIncomingMessage({
        type: "dash-download-start",
        jobId: "dash-job-1",
        url: "https://cdn.example/manifest.mpd",
        sizeCapBytes: 1024,
        executionSnapshotId: EXECUTION_SNAPSHOT_ID,
      }),
    ).toBeUndefined();
    expect(
      parseOffscreenIncomingMessage({
        type: "webm-transcode-start",
        jobId: "webm-job-1",
        url: "https://cdn.example/video.webm",
        sizeCapBytes: 1024,
        executionSnapshotId: EXECUTION_SNAPSHOT_ID,
      }),
    ).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ type: "capture-executor-status", jobId: "x" })).toBeUndefined();
    const inspect = {
      type: "capture-variant-inspect",
      requestId: "request-1",
      reviewId: "review-1",
      url: "https://cdn.example/master.m3u8",
      kind: "hls",
      deadlineAt: 10_000,
    };
    expect(parseOffscreenIncomingMessage({ ...inspect, requestId: "../request" })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...inspect, reviewId: "review/escape" })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...inspect, deadlineAt: 0 })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...inspect, kind: "webm" })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...inspect, url: "file:///manifest" })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...inspect, headers: {} })).toBeUndefined();
    expect(parseOffscreenIncomingMessage({ ...inspect, retainForExecution: false })).toBeUndefined();
    const discard = {
      type: "capture-execution-snapshot-discard",
      executionSnapshotId: EXECUTION_SNAPSHOT_ID,
    };
    expect(parseOffscreenIncomingMessage({ ...discard, url: inspect.url })).toBeUndefined();
    expect(
      parseOffscreenIncomingMessage({ ...discard, executionSnapshotId: "not-a-snapshot" }),
    ).toBeUndefined();
    expect(
      parseOffscreenIncomingMessage({ type: "capture-execution-snapshot-discard" }),
    ).toBeUndefined();
  });

  it("fails closed on accessors and hostile proxies", () => {
    let calls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "type", {
      enumerable: true,
      get() {
        calls += 1;
        return "capture-executor-status";
      },
    });
    expect(() => parseOffscreenIncomingMessage(accessor)).not.toThrow();
    expect(parseOffscreenIncomingMessage(accessor)).toBeUndefined();
    expect(calls).toBe(0);

    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("hostile proxy");
      },
    });
    expect(() => parseOffscreenIncomingMessage(hostile)).not.toThrow();
    expect(parseOffscreenIncomingMessage(hostile)).toBeUndefined();
  });
});

describe("execution snapshot discard response parser", () => {
  it("accepts only one uniform acknowledgement with no existence signal", () => {
    expect(parseCaptureExecutionSnapshotDiscardResponseV1({ ok: true })).toEqual({
      ok: true,
    });
    expect(
      parseCaptureExecutionSnapshotDiscardResponseV1({ ok: true, discarded: true }),
    ).toBeUndefined();
    expect(parseCaptureExecutionSnapshotDiscardResponseV1({ ok: false })).toBeUndefined();
    expect(parseCaptureExecutionSnapshotDiscardResponseV1(undefined)).toBeUndefined();
  });

  it("fails closed on accessors and hostile proxies", () => {
    let calls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "ok", {
      enumerable: true,
      get() {
        calls += 1;
        return true;
      },
    });
    expect(parseCaptureExecutionSnapshotDiscardResponseV1(accessor)).toBeUndefined();
    expect(calls).toBe(0);

    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("hostile");
      },
    });
    expect(() => parseCaptureExecutionSnapshotDiscardResponseV1(hostile)).not.toThrow();
    expect(parseCaptureExecutionSnapshotDiscardResponseV1(hostile)).toBeUndefined();
  });
});

describe("capture variant inspection response parser", () => {
  const rawVariant = {
    sourceId: "https://cdn.example/video.m3u8?token=raw-secret",
    audioSourceId: "https://cdn.example/audio.m3u8?token=raw-secret",
    width: 1280,
    height: 720,
    codecs: "avc1.4d401f,mp4a.40.2",
    container: "video/mp4",
    bandwidth: { scope: "combined", combinedBandwidth: 1_800_000 },
    durationSec: 60,
  } as const;

  it("copies an exact bounded success or fixed-code failure", () => {
    expect(
      parseCaptureVariantInspectResponseV1({ ok: true, variants: [rawVariant] }),
    ).toEqual({ ok: true, variants: [rawVariant] });
    expect(
      parseCaptureVariantInspectResponseV1({
        ok: true,
        variants: [rawVariant],
        executionSnapshotId: EXECUTION_SNAPSHOT_ID,
      }),
    ).toEqual({
      ok: true,
      variants: [rawVariant],
      executionSnapshotId: EXECUTION_SNAPSHOT_ID,
    });
    expect(
      parseCaptureVariantInspectResponseV1({ ok: false, code: "FETCH_FAILED" }),
    ).toEqual({ ok: false, code: "FETCH_FAILED" });
  });

  it("rejects partial, oversized, overprivileged, and reflective responses", () => {
    expect(
      parseCaptureVariantInspectResponseV1({
        ok: true,
        variants: Array.from({ length: 101 }, () => rawVariant),
      }),
    ).toBeUndefined();
    expect(
      parseCaptureVariantInspectResponseV1({
        ok: true,
        variants: [{ ...rawVariant, arbitrary: true }],
      }),
    ).toBeUndefined();
    expect(
      parseCaptureVariantInspectResponseV1({
        ok: false,
        code: "FETCH_FAILED",
        error: "https://cdn.example/private?token=secret",
      }),
    ).toBeUndefined();
    expect(
      parseCaptureVariantInspectResponseV1({
        ok: false,
        code: "https://cdn.example/private?token=secret",
      }),
    ).toBeUndefined();
    expect(
      parseCaptureVariantInspectResponseV1({
        ok: true,
        variants: [rawVariant],
        executionSnapshotId: "https://cdn.example/private?token=secret",
      }),
    ).toBeUndefined();
  });

  it("fails closed on sparse arrays and hostile values", () => {
    const sparse = new Array(1);
    expect(
      parseCaptureVariantInspectResponseV1({ ok: true, variants: sparse }),
    ).toBeUndefined();
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("hostile");
      },
    });
    expect(() => parseCaptureVariantInspectResponseV1(hostile)).not.toThrow();
    expect(parseCaptureVariantInspectResponseV1(hostile)).toBeUndefined();
  });
});

describe("OffscreenAttemptRegistry", () => {
  const legacy: AttemptIdentity = { jobId: "hls-job-1" };
  const attempted: AttemptIdentity = { jobId: "hls-job-1", attemptId: "attempt-1" };

  it("claims synchronously, rejects duplicates, and keeps one global lane", () => {
    const registry = new OffscreenAttemptRegistry<string>();
    expect(registry.claim(legacy, "legacy-resource")).toMatchObject({ ok: true });
    expect(registry.claim(legacy, "duplicate")).toEqual({
      ok: false,
      code: "DUPLICATE_ATTEMPT",
    });
    expect(registry.claim({ jobId: "dash-job-2", attemptId: "attempt-2" }, "other")).toEqual({
      ok: false,
      code: "CONCURRENT_LIMIT",
    });
  });

  it("treats a missing attempt ID as a legacy identity, never as a wildcard", () => {
    const registry = new OffscreenAttemptRegistry<string>();
    registry.claim(attempted, "attempt-resource");
    expect(registry.get(legacy)).toBeUndefined();
    expect(registry.release(legacy)).toBeUndefined();
    expect(registry.owns(attempted)).toBe(true);
    expect(registry.status()).toEqual([attempted]);
  });

  it("retains blob ownership until exact release and makes release idempotent", () => {
    const registry = new OffscreenAttemptRegistry<string>();
    registry.claim(attempted, "resource");
    expect(registry.attachBlob(attempted, "blob:cliphutch-1")).toBe(true);
    expect(registry.attachBlob(attempted, "blob:cliphutch-2")).toBe(false);
    expect(registry.get(attempted)?.blobUrl).toBe("blob:cliphutch-1");
    expect(registry.claim({ jobId: "next-job", attemptId: "next-attempt" }, "next")).toEqual({
      ok: false,
      code: "CONCURRENT_LIMIT",
    });

    expect(registry.release(attempted)).toMatchObject({
      jobId: "hls-job-1",
      attemptId: "attempt-1",
      blobUrl: "blob:cliphutch-1",
    });
    expect(registry.release(attempted)).toBeUndefined();
    expect(registry.status()).toEqual([]);
  });

  it("tombstones released attempts so a delayed start replay cannot rerun", () => {
    const registry = new OffscreenAttemptRegistry<string>();
    registry.claim(attempted, "resource");
    registry.release(attempted);
    expect(registry.claim(attempted, "replay")).toEqual({
      ok: false,
      code: "DUPLICATE_ATTEMPT",
    });

    const cancelledBeforeStart = { jobId: "job-late", attemptId: "attempt-late" };
    expect(registry.release(cancelledBeforeStart)).toBeUndefined();
    expect(registry.claim(cancelledBeforeStart, "late-start")).toEqual({
      ok: false,
      code: "DUPLICATE_ATTEMPT",
    });
  });

  it("bounds tombstones and active status output", () => {
    const tombstones = new OffscreenAttemptRegistry<string>(1, 2, 1);
    for (const suffix of ["a", "b", "c"]) {
      const identity = { jobId: `job-${suffix}`, attemptId: `attempt-${suffix}` };
      tombstones.claim(identity, suffix);
      tombstones.release(identity);
    }
    expect(tombstones.claim({ jobId: "job-a", attemptId: "attempt-a" }, "reused")).toMatchObject({
      ok: true,
    });

    const active = new OffscreenAttemptRegistry<string>(3, 10, 2);
    active.claim({ jobId: "job-1" }, "1");
    active.claim({ jobId: "job-2", attemptId: "attempt-2" }, "2");
    active.claim({ jobId: "job-3", attemptId: "attempt-3" }, "3");
    expect(active.status()).toEqual([
      { jobId: "job-1" },
      { jobId: "job-2", attemptId: "attempt-2" },
    ]);
  });

  it("rejects invalid registry bounds", () => {
    expect(() => new OffscreenAttemptRegistry(0)).toThrow(TypeError);
    expect(() => new OffscreenAttemptRegistry(1, 0)).toThrow(TypeError);
    expect(() => new OffscreenAttemptRegistry(1, 1, 0)).toThrow(TypeError);
  });
});
