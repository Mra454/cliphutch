import { describe, expect, it } from "vitest";
import {
  createCaptureManifestRecord,
  finalizeCaptureManifestRecord,
  isCaptureManifestRecordV1,
  MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS,
  reduceCaptureManifestOutput,
} from "./capture-manifest-delivery";
import type { CaptureManifestSeedV1 } from "./capture-manifest-seed";

function seed(): CaptureManifestSeedV1 {
  return {
    schemaVersion: 1,
    runId: "run-one",
    planId: "plan-one",
    packName: "Pack",
    relativeRoot: "ClipHutch/Pack",
    createdAt: 10,
    formats: ["json", "csv"],
    items: [{
      itemId: "excluded",
      included: false,
      plannedPath: "ClipHutch/Pack/example.test/poster.jpg",
      kind: "image",
      pageUrl: "https://example.test/article",
      sourceHost: "images.example.test",
      addedAt: 10,
    }],
  };
}

describe("Capture Manifest output state", () => {
  it("freezes one idempotent completion time before any output starts", () => {
    const initial = createCaptureManifestRecord(seed())!;
    expect(reduceCaptureManifestOutput(initial, {
      type: "begin", format: "json", expectedRevision: 0, attemptId: "attempt-one", now: 20,
    })).toMatchObject({ ok: false, reason: "illegal_transition" });
    const finalized = finalizeCaptureManifestRecord(initial, 20);
    expect(finalized).toMatchObject({ ok: true, changed: true, record: { finalizedAt: 20 } });
    if (!finalized.ok) return;
    expect(finalizeCaptureManifestRecord(finalized.record, 20)).toMatchObject({
      ok: true, changed: false,
    });
    expect(finalizeCaptureManifestRecord(finalized.record, 21)).toMatchObject({
      ok: false, reason: "already_finalized",
    });
  });

  it("enforces attempt-scoped saving and terminal completion", () => {
    const created = createCaptureManifestRecord(seed());
    expect(created).toBeDefined();
    if (!created) return;
    const frozen = finalizeCaptureManifestRecord(created, 19);
    if (!frozen.ok) return;
    const initial = frozen.record;
    const begun = reduceCaptureManifestOutput(initial, {
      type: "begin", format: "json", expectedRevision: 0, attemptId: "attempt-one", now: 20,
    });
    expect(begun).toMatchObject({
      ok: true,
      changed: true,
      record: { outputs: { json: { state: "saving", attemptNo: 1, revision: 1 } } },
    });
    if (!begun.ok) return;
    expect(reduceCaptureManifestOutput(begun.record, {
      type: "record_download", format: "json", expectedRevision: 1,
      attemptId: "stale-attempt", downloadId: 41, now: 21,
    })).toMatchObject({ ok: false, reason: "attempt_mismatch" });
    const recorded = reduceCaptureManifestOutput(begun.record, {
      type: "record_download", format: "json", expectedRevision: 1,
      attemptId: "attempt-one", downloadId: 41, now: 21,
    });
    expect(recorded).toMatchObject({ ok: true, record: { outputs: { json: { downloadId: 41 } } } });
    if (!recorded.ok) return;
    const completed = reduceCaptureManifestOutput(recorded.record, {
      type: "complete", format: "json", expectedRevision: 2,
      attemptId: "attempt-one", downloadId: 41, now: 22,
    });
    expect(completed).toMatchObject({
      ok: true,
      record: { outputs: { json: { state: "complete", revision: 3, downloadId: 41 } } },
    });
    expect(completed.ok && isCaptureManifestRecordV1(completed.record)).toBe(true);
    expect(completed.ok && reduceCaptureManifestOutput(completed.record, {
      type: "begin", format: "json", expectedRevision: 3, attemptId: "attempt-two", now: 23,
    })).toMatchObject({ ok: false, reason: "illegal_transition" });
  });

  it("allows only typed retryable failures to start a new attempt", () => {
    const frozen = finalizeCaptureManifestRecord(createCaptureManifestRecord(seed())!, 19);
    if (!frozen.ok) return;
    const initial = frozen.record;
    const begun = reduceCaptureManifestOutput(initial, {
      type: "begin", format: "json", expectedRevision: 0, attemptId: "attempt-one", now: 20,
    });
    if (!begun.ok) return;
    expect(reduceCaptureManifestOutput(begun.record, {
      type: "fail", format: "json", expectedRevision: 1, attemptId: "attempt-one",
      errorCode: "RAW_SERVER_SECRET" as never, retryable: true, now: 21,
    })).toMatchObject({ ok: false, reason: "invalid_action" });
    const failed = reduceCaptureManifestOutput(begun.record, {
      type: "fail", format: "json", expectedRevision: 1, attemptId: "attempt-one",
      errorCode: "MANIFEST_SAVE_FAILED", retryable: true, now: 21,
    });
    expect(failed).toMatchObject({ ok: true, record: { outputs: { json: { state: "failed" } } } });
    if (!failed.ok) return;
    expect(reduceCaptureManifestOutput(failed.record, {
      type: "begin", format: "json", expectedRevision: 2, attemptId: "attempt-one", now: 22,
    })).toMatchObject({ ok: false, reason: "attempt_mismatch" });
    expect(reduceCaptureManifestOutput(failed.record, {
      type: "begin", format: "json", expectedRevision: 2, attemptId: "attempt-two", now: 22,
    })).toMatchObject({
      ok: true,
      record: {
        outputs: {
          json: {
            state: "saving",
            attemptNo: 2,
            attemptIds: ["attempt-one", "attempt-two"],
            revision: 3,
          },
        },
      },
    });
  });

  it("retains every accepted attempt identity and never evicts one into reuse", () => {
    const frozen = finalizeCaptureManifestRecord(createCaptureManifestRecord(seed())!, 19);
    if (!frozen.ok) return;
    let record = frozen.record;
    for (let index = 0; index < MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS; index += 1) {
      const result = reduceCaptureManifestOutput(record, {
        type: "fail_before_delivery",
        format: "json",
        expectedRevision: index,
        attemptId: `attempt-${index}`,
        errorCode: "MANIFEST_BLOB_FAILED",
        retryable: true,
        now: 20 + index,
      });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      record = result.record;
    }
    expect(record.outputs.json?.attemptIds).toHaveLength(MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS);
    expect(reduceCaptureManifestOutput(record, {
      type: "begin",
      format: "json",
      expectedRevision: MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS,
      attemptId: "attempt-0",
      now: 20 + MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS,
    })).toMatchObject({ ok: false, reason: "attempt_mismatch" });
    expect(reduceCaptureManifestOutput(record, {
      type: "begin",
      format: "json",
      expectedRevision: MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS,
      attemptId: "attempt-over-limit",
      now: 20 + MAX_CAPTURE_MANIFEST_OUTPUT_ATTEMPTS,
    })).toMatchObject({ ok: false, reason: "retry_not_allowed" });
  });

  it("rejects an attempt identity already owned by the other output", () => {
    const frozen = finalizeCaptureManifestRecord(createCaptureManifestRecord(seed())!, 19);
    if (!frozen.ok) return;
    const csv = reduceCaptureManifestOutput(frozen.record, {
      type: "fail_before_delivery",
      format: "csv",
      expectedRevision: 0,
      attemptId: "shared-attempt",
      errorCode: "MANIFEST_BLOB_FAILED",
      retryable: true,
      now: 20,
    });
    if (!csv.ok) return;
    expect(reduceCaptureManifestOutput(csv.record, {
      type: "begin",
      format: "json",
      expectedRevision: 0,
      attemptId: "shared-attempt",
      now: 21,
    })).toMatchObject({ ok: false, reason: "attempt_mismatch" });
  });

  it("rejects a retry after a permanent failure and rejects state extras", () => {
    const frozen = finalizeCaptureManifestRecord(createCaptureManifestRecord(seed())!, 19);
    if (!frozen.ok) return;
    const initial = frozen.record;
    const begun = reduceCaptureManifestOutput(initial, {
      type: "begin", format: "csv", expectedRevision: 0, attemptId: "attempt-one", now: 20,
    });
    if (!begun.ok) return;
    const failed = reduceCaptureManifestOutput(begun.record, {
      type: "fail", format: "csv", expectedRevision: 1, attemptId: "attempt-one",
      errorCode: "MANIFEST_SERIALIZE_FAILED", retryable: false, now: 21,
    });
    if (!failed.ok) return;
    expect(reduceCaptureManifestOutput(failed.record, {
      type: "begin", format: "csv", expectedRevision: 2, attemptId: "attempt-two", now: 22,
    })).toMatchObject({ ok: false, reason: "retry_not_allowed" });
    expect(isCaptureManifestRecordV1({ ...failed.record, licenseKey: "secret" })).toBe(false);
  });

  it("records a typed pre-delivery failure without manufacturing a saving window", () => {
    const frozen = finalizeCaptureManifestRecord(createCaptureManifestRecord(seed())!, 19);
    if (!frozen.ok) return;
    const failed = reduceCaptureManifestOutput(frozen.record, {
      type: "fail_before_delivery",
      format: "json",
      expectedRevision: 0,
      attemptId: "attempt-pre-delivery",
      errorCode: "MANIFEST_BLOB_FAILED",
      retryable: true,
      now: 20,
    });
    expect(failed).toMatchObject({
      ok: true,
      record: {
        outputs: {
          json: {
            state: "failed",
            attemptNo: 1,
            revision: 1,
            attemptId: "attempt-pre-delivery",
          },
        },
      },
    });
  });
});
