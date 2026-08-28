import { describe, expect, it, vi } from "vitest";
import { executeNativeCaptureJob, type CaptureNativeRuntimeDependencies } from "./capture-native-runtime";
import type { CaptureJobControlResult, UnguardedCaptureJobEvent } from "./capture-job-controller";
import { CAPTURE_PACK_SCHEMA_VERSION, type CaptureJobV1 } from "./capture-pack-types";

function job(state: CaptureJobV1["state"], revision: number): CaptureJobV1 {
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    jobId: "job-1",
    runId: "run-1",
    itemId: "item-1",
    attemptId: "attempt-1",
    attemptNo: 1,
    revision,
    resourceClass: "native",
    state,
    snapshot: {
      media: {
        mediaId: "media-1",
        kind: "direct",
        url: "https://cdn.example/file.mp4?token=session",
        detectedAt: 1,
        provenance: ["network"],
      },
      plannedRelativePath: "ClipHutch/Pack/Page/file.mp4",
      quality: { mode: "direct" },
    },
    ...(state === "delivery_pending" ? {} : {}),
  };
}

function runtime(options: {
  failEvent?: UnguardedCaptureJobEvent["type"];
  downloadState?: "in_progress" | "complete" | "interrupted";
  actualBasename?: string;
  sizeBytes?: number;
  startError?: Error;
} = {}): CaptureNativeRuntimeDependencies & { order: string[] } {
  const order: string[] = [];
  let revision = 1;
  const applyEvent = vi.fn(async ({ event }: { event: UnguardedCaptureJobEvent }) => {
    order.push(`event:${event.type}`);
    if (event.type === options.failEvent) {
      return { ok: false, reason: "conflict", conflict: "revision_mismatch", id: "job-1" } as CaptureJobControlResult;
    }
    const state = event.type === "delivery-ready"
      ? "delivery_pending"
      : event.type === "saving"
        ? "saving"
        : event.type === "complete"
          ? "complete"
          : event.type === "save-state-unknown"
            ? "save_state_unknown"
            : "failed";
    const next = job(state, revision++);
    if (event.type === "saving") next.downloadId = event.downloadId;
    if (event.type === "complete") next.result = {
      ...(event.actualBasename === undefined ? {} : { actualBasename: event.actualBasename }),
      ...(event.sizeBytes === undefined ? {} : { sizeBytes: event.sizeBytes }),
    };
    if (event.type === "fail") next.error = {
      code: event.code,
      customerMessage: event.customerMessage,
      retryable: event.retryable,
    };
    if (event.type === "save-state-unknown") next.error = {
      code: event.code,
      customerMessage: event.customerMessage,
      retryable: false,
    };
    return { ok: true, changed: true, job: next } as CaptureJobControlResult;
  });
  return {
    order,
    applyEvent,
    startDownload: vi.fn(async (input) => {
      order.push(`download:${input.filename}`);
      if (options.startError) throw options.startError;
      return 42;
    }),
    cancelDownload: vi.fn(async () => {
      order.push("cancel");
    }),
    getDownloadObservation: vi.fn(async () => ({
      state: options.downloadState ?? "in_progress",
      ...(options.actualBasename === undefined ? {} : { actualBasename: options.actualBasename }),
      ...(options.sizeBytes === undefined ? {} : { sizeBytes: options.sizeBytes }),
    })),
  };
}

describe("native Capture Job execution", () => {
  it("persists delivery intent before using the reviewed URL and path", async () => {
    const deps = runtime();
    const result = await executeNativeCaptureJob({ jobId: "job-1", attemptId: "attempt-1" }, deps);
    expect(result).toMatchObject({ ok: true, state: "saving", downloadId: 42 });
    expect(deps.order).toEqual([
      "event:delivery-ready",
      "download:ClipHutch/Pack/Page/file.mp4",
      "event:saving",
    ]);
    expect(deps.startDownload).toHaveBeenCalledWith({
      url: "https://cdn.example/file.mp4?token=session",
      filename: "ClipHutch/Pack/Page/file.mp4",
      conflictAction: "uniquify",
      saveAs: false,
    });
  });

  it("does not call Chrome when the delivery claim is rejected", async () => {
    const deps = runtime({ failEvent: "delivery-ready" });
    await expect(executeNativeCaptureJob({ jobId: "job-1", attemptId: "attempt-1" }, deps))
      .resolves.toMatchObject({ ok: false, state: "not_started" });
    expect(deps.startDownload).not.toHaveBeenCalled();
  });

  it("records a typed retryable failure when Chrome rejects the start", async () => {
    const deps = runtime({ startError: new Error("browser rejected") });
    await expect(executeNativeCaptureJob({ jobId: "job-1", attemptId: "attempt-1" }, deps))
      .resolves.toMatchObject({ ok: false, state: "failed" });
    expect(deps.order).toEqual([
      "event:delivery-ready",
      "download:ClipHutch/Pack/Page/file.mp4",
      "event:fail",
    ]);
  });

  it("cancels an accepted download when its ID cannot be persisted", async () => {
    const deps = runtime({ failEvent: "saving" });
    await expect(executeNativeCaptureJob({ jobId: "job-1", attemptId: "attempt-1" }, deps))
      .resolves.toMatchObject({ ok: false, state: "save_state_unknown" });
    expect(deps.order).toEqual([
      "event:delivery-ready",
      "download:ClipHutch/Pack/Page/file.mp4",
      "event:saving",
      "cancel",
      "event:save-state-unknown",
    ]);
  });

  it("reconciles a Chrome completion that beats persistence observation", async () => {
    const deps = runtime({
      downloadState: "complete",
      actualBasename: "file (1).mp4",
      sizeBytes: 4_096,
    });
    const result = await executeNativeCaptureJob({ jobId: "job-1", attemptId: "attempt-1" }, deps);
    expect(result).toMatchObject({
      ok: true,
      state: "complete",
      job: {
        state: "complete",
        result: { actualBasename: "file (1).mp4", sizeBytes: 4_096 },
      },
    });
    expect(deps.order.at(-1)).toBe("event:complete");
  });

  it("maps an already interrupted Chrome save to a retryable failure", async () => {
    const deps = runtime({ downloadState: "interrupted" });
    await expect(executeNativeCaptureJob({ jobId: "job-1", attemptId: "attempt-1" }, deps))
      .resolves.toMatchObject({ ok: false, state: "failed" });
    expect(deps.order.at(-1)).toBe("event:fail");
  });
});
