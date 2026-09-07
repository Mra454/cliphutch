import { describe, expect, it } from "vitest";
import {
  captureManifestBlobMimeType,
  type CaptureManifestBlobStatusEntry,
} from "./capture-manifest-blob";
import {
  createCaptureManifestRecord,
  finalizeCaptureManifestRecord,
  isCaptureManifestRecordV1,
  reduceCaptureManifestOutput,
  type CaptureManifestOutputActionV1,
  type CaptureManifestRecordV1,
} from "./capture-manifest-delivery";
import {
  CAPTURE_MANIFEST_RECOVERY_SCHEMA_VERSION,
  MAX_CAPTURE_MANIFEST_RECOVERY_RECORDS,
  planCaptureManifestRecovery,
  type CaptureManifestObservedDownloadV1,
  type CaptureManifestRecoveryInputV1,
} from "./capture-manifest-recovery";
import type { CaptureManifestSeedV1 } from "./capture-manifest-seed";
import type { CaptureManifestFormatV1 } from "./capture-pack-types";

function seed(
  runId = "run-one",
  formats: CaptureManifestFormatV1[] = ["json", "csv"],
): CaptureManifestSeedV1 {
  return {
    schemaVersion: 1,
    runId,
    planId: `plan-${runId}`,
    packName: "Pack",
    relativeRoot: "ClipHutch/Pack",
    createdAt: 10,
    formats,
    items: [{
      itemId: `excluded-${runId}`,
      included: false,
      plannedPath: "ClipHutch/Pack/example.test/poster.jpg",
      kind: "image",
      pageUrl: "https://example.test/article",
      sourceHost: "images.example.test",
      addedAt: 10,
    }],
  };
}

function pendingRecord(
  runId = "run-one",
  formats: CaptureManifestFormatV1[] = ["json", "csv"],
): CaptureManifestRecordV1 {
  const record = createCaptureManifestRecord(seed(runId, formats));
  if (!record) throw new Error("fixture record was invalid");
  return record;
}

function finalizedRecord(
  runId = "run-one",
  formats: CaptureManifestFormatV1[] = ["json", "csv"],
): CaptureManifestRecordV1 {
  const result = finalizeCaptureManifestRecord(pendingRecord(runId, formats), 20);
  if (!result.ok) throw new Error(`fixture finalization failed: ${result.reason}`);
  return result.record;
}

function mutate(
  record: CaptureManifestRecordV1,
  action: CaptureManifestOutputActionV1,
): CaptureManifestRecordV1 {
  const result = reduceCaptureManifestOutput(record, action);
  if (!result.ok) throw new Error(`fixture mutation failed: ${result.reason}`);
  return result.record;
}

function nextTime(record: CaptureManifestRecordV1): number {
  return Math.max(
    record.finalizedAt ?? 0,
    ...record.seed.formats.map((format) => record.outputs[format]!.updatedAt),
  ) + 1;
}

function saving(
  record: CaptureManifestRecordV1,
  format: CaptureManifestFormatV1,
  attemptId: string,
  downloadId?: number,
): CaptureManifestRecordV1 {
  let next = mutate(record, {
    type: "begin",
    format,
    expectedRevision: record.outputs[format]!.revision,
    attemptId,
    now: nextTime(record),
  });
  if (downloadId !== undefined) {
    const output = next.outputs[format]!;
    next = mutate(next, {
      type: "record_download",
      format,
      expectedRevision: output.revision,
      attemptId,
      downloadId,
      now: nextTime(next),
    });
  }
  return next;
}

function complete(
  record: CaptureManifestRecordV1,
  format: CaptureManifestFormatV1,
  attemptId: string,
  downloadId: number,
): CaptureManifestRecordV1 {
  const started = saving(record, format, attemptId, downloadId);
  return mutate(started, {
    type: "complete",
    format,
    expectedRevision: started.outputs[format]!.revision,
    attemptId,
    downloadId,
    now: nextTime(started),
  });
}

function failSaving(
  record: CaptureManifestRecordV1,
  format: CaptureManifestFormatV1,
  attemptId: string,
  downloadId?: number,
): CaptureManifestRecordV1 {
  const started = saving(record, format, attemptId, downloadId);
  return mutate(started, {
    type: "fail",
    format,
    expectedRevision: started.outputs[format]!.revision,
    attemptId,
    errorCode: "MANIFEST_SAVE_FAILED",
    retryable: true,
    now: nextTime(started),
  });
}

function blob(
  runId: string,
  attemptId: string,
  format: CaptureManifestFormatV1,
): CaptureManifestBlobStatusEntry {
  return {
    runId,
    attemptId,
    format,
    contentDigest: "a".repeat(64),
    sizeBytes: 12,
    mimeType: captureManifestBlobMimeType(format),
    expiresAt: 1_000,
  };
}

function input(
  records: readonly CaptureManifestRecordV1[],
  options: {
    recordsComplete?: boolean;
    offscreenKnown?: boolean;
    active?: readonly CaptureManifestBlobStatusEntry[];
    downloads?: readonly CaptureManifestObservedDownloadV1[];
  } = {},
): CaptureManifestRecoveryInputV1 {
  return {
    schemaVersion: CAPTURE_MANIFEST_RECOVERY_SCHEMA_VERSION,
    recordsComplete: options.recordsComplete ?? true,
    records,
    offscreen: {
      known: options.offscreenKnown ?? true,
      active: options.active ?? [],
    },
    downloads: options.downloads ?? [],
  };
}

describe("Capture Manifest recovery sequencing", () => {
  it("does not start an unfinalized manifest and starts JSON for a JSON-only pack", () => {
    expect(planCaptureManifestRecovery(input([pendingRecord()]))).toMatchObject({
      ok: true,
      eligibleAutomaticStarts: [],
    });
    expect(planCaptureManifestRecovery(input([finalizedRecord("run-json", ["json"])])))
      .toMatchObject({
        ok: true,
        eligibleAutomaticStarts: [{ runId: "run-json", format: "json", expectedRevision: 0 }],
      });
  });

  it("selects CSV first and selects pending JSON only after CSV is terminal", () => {
    const initial = finalizedRecord();
    expect(planCaptureManifestRecovery(input([initial]))).toMatchObject({
      ok: true,
      eligibleAutomaticStarts: [{ runId: "run-one", format: "csv", expectedRevision: 0 }],
    });

    const csvComplete = complete(initial, "csv", "attempt-csv", 41);
    expect(planCaptureManifestRecovery(input([csvComplete]))).toMatchObject({
      ok: true,
      eligibleAutomaticStarts: [{ runId: "run-one", format: "json", expectedRevision: 0 }],
    });

    const csvFailed = failSaving(initial, "csv", "attempt-csv-failed");
    expect(planCaptureManifestRecovery(input([csvFailed]))).toMatchObject({
      ok: true,
      eligibleAutomaticStarts: [{ runId: "run-one", format: "json", expectedRevision: 0 }],
    });
  });

  it("never automatically retries a failed final output", () => {
    const record = failSaving(
      finalizedRecord("run-json-failed", ["json"]),
      "json",
      "attempt-json-failed",
    );
    expect(planCaptureManifestRecovery(input([record]))).toMatchObject({
      ok: true,
      actions: [],
      eligibleAutomaticStarts: [],
      requiresReplan: false,
    });
  });

  it("monitors an in-progress CSV and does not start JSON", () => {
    const record = saving(finalizedRecord(), "csv", "attempt-csv", 41);
    expect(planCaptureManifestRecovery(input([record], {
      active: [blob("run-one", "attempt-csv", "csv")],
      downloads: [{ downloadId: 41, state: "in_progress" }],
    }))).toEqual({
      ok: true,
      schemaVersion: 1,
      actions: [{
        type: "monitor_download",
        runId: "run-one",
        format: "csv",
        attemptId: "attempt-csv",
        expectedRevision: 2,
        downloadId: 41,
      }],
      blockers: [],
      eligibleAutomaticStarts: [],
      requiresReplan: false,
    });
  });

  it("rejects durable states that put CSV after a started JSON", () => {
    const record = saving(finalizedRecord(), "json", "attempt-json", 42);
    expect(planCaptureManifestRecovery(input([record]))).toMatchObject({
      ok: false,
      reason: "invalid_output_sequence",
      runId: "run-one",
    });
  });

  it("allows an explicit failed-CSV retry after JSON and never auto-retries it", () => {
    let record = failSaving(finalizedRecord(), "csv", "attempt-csv-first");
    record = complete(record, "json", "attempt-json", 42);
    record = saving(record, "csv", "attempt-csv-retry", 43);
    expect(planCaptureManifestRecovery(input([record], {
      downloads: [{ downloadId: 43, state: "in_progress" }],
    }))).toMatchObject({
      ok: true,
      actions: [{
        type: "monitor_download",
        format: "csv",
        attemptId: "attempt-csv-retry",
        downloadId: 43,
      }],
      eligibleAutomaticStarts: [],
    });
  });
});

describe("Capture Manifest recovery state and Blob reconciliation", () => {
  it("revokes a Blob whose durable output is still pending, then requires a replan", () => {
    expect(planCaptureManifestRecovery(input([finalizedRecord()], {
      active: [blob("run-one", "orphan-before-begin", "csv")],
    }))).toEqual({
      ok: true,
      schemaVersion: 1,
      actions: [{
        type: "revoke_blob",
        runId: "run-one",
        format: "csv",
        attemptId: "orphan-before-begin",
        reason: "orphan",
      }],
      blockers: [],
      eligibleAutomaticStarts: [],
      requiresReplan: true,
    });
  });

  it("fails saving-without-ID as ambiguous before revoking its exact Blob", () => {
    const record = saving(finalizedRecord(), "csv", "attempt-no-id");
    expect(planCaptureManifestRecovery(input([record], {
      active: [blob("run-one", "attempt-no-id", "csv")],
    }))).toMatchObject({
      ok: true,
      actions: [
        {
          type: "fail_output",
          runId: "run-one",
          format: "csv",
          attemptId: "attempt-no-id",
          expectedRevision: 1,
          errorCode: "MANIFEST_SAVE_STATE_UNKNOWN",
          retryable: true,
        },
        {
          type: "revoke_blob",
          attemptId: "attempt-no-id",
          reason: "saving_without_download_id",
        },
      ],
      eligibleAutomaticStarts: [],
      requiresReplan: true,
    });
  });

  it.each([
    ["complete", "complete_output", undefined, "download_complete"],
    ["interrupted", "fail_output", "MANIFEST_SAVE_FAILED", "download_interrupted"],
    ["missing", "fail_output", "MANIFEST_SAVE_STATE_UNKNOWN", "download_missing"],
  ] as const)(
    "reconciles a persisted Chrome download observed as %s before Blob cleanup",
    (state, actionType, errorCode, revokeReason) => {
      const record = saving(finalizedRecord(), "csv", "attempt-csv", 41);
      const result = planCaptureManifestRecovery(input([record], {
        active: [blob("run-one", "attempt-csv", "csv")],
        downloads: [{ downloadId: 41, state }],
      }));
      expect(result).toMatchObject({
        ok: true,
        actions: [
          {
            type: actionType,
            runId: "run-one",
            format: "csv",
            attemptId: "attempt-csv",
            expectedRevision: 2,
            ...(errorCode === undefined ? { downloadId: 41 } : { errorCode }),
          },
          { type: "revoke_blob", attemptId: "attempt-csv", reason: revokeReason },
        ],
        eligibleAutomaticStarts: [],
        requiresReplan: true,
      });
    },
  );

  it("retains the exact Blob and fails closed when a download query is unknown", () => {
    const record = saving(finalizedRecord(), "csv", "attempt-csv", 41);
    expect(planCaptureManifestRecovery(input([record], {
      active: [blob("run-one", "attempt-csv", "csv")],
      downloads: [{ downloadId: 41, state: "unknown" }],
    }))).toEqual({
      ok: true,
      schemaVersion: 1,
      actions: [],
      blockers: [{
        type: "download_state_unknown",
        runId: "run-one",
        format: "csv",
        attemptId: "attempt-csv",
        expectedRevision: 2,
        downloadId: 41,
      }],
      eligibleAutomaticStarts: [],
      requiresReplan: false,
    });
  });

  it("cleans exact terminal and unrelated orphan Blobs deterministically", () => {
    const record = complete(finalizedRecord(), "csv", "attempt-complete", 41);
    expect(planCaptureManifestRecovery(input([record], {
      active: [
        blob("run-one", "attempt-complete", "csv"),
        blob("orphan-run", "orphan-attempt", "json"),
      ],
    }))).toMatchObject({
      ok: true,
      actions: [
        { type: "revoke_blob", attemptId: "attempt-complete", reason: "terminal_output" },
        { type: "revoke_blob", attemptId: "orphan-attempt", reason: "orphan" },
      ],
      eligibleAutomaticStarts: [],
      requiresReplan: true,
    });
  });

  it("treats a same-identity wrong-format Blob as an orphan", () => {
    const record = saving(finalizedRecord(), "csv", "attempt-csv");
    expect(planCaptureManifestRecovery(input([record], {
      active: [blob("run-one", "attempt-csv", "json")],
    }))).toMatchObject({
      ok: true,
      actions: [
        { type: "fail_output", errorCode: "MANIFEST_SAVE_STATE_UNKNOWN" },
        { type: "revoke_blob", format: "json", reason: "orphan" },
      ],
    });
  });

  it("does not infer orphan ownership or start work from incomplete observations", () => {
    const orphan = blob("unknown-run", "unknown-attempt", "json");
    expect(planCaptureManifestRecovery(input([finalizedRecord()], {
      recordsComplete: false,
      active: [orphan],
    }))).toEqual({
      ok: true,
      schemaVersion: 1,
      actions: [],
      blockers: [{ type: "manifest_records_unknown" }],
      eligibleAutomaticStarts: [],
      requiresReplan: false,
    });
    expect(planCaptureManifestRecovery(input([finalizedRecord()], {
      offscreenKnown: false,
    }))).toMatchObject({
      ok: true,
      actions: [],
      blockers: [{ type: "offscreen_status_unknown" }],
      eligibleAutomaticStarts: [],
    });
  });
});

describe("Capture Manifest recovery validation and bounds", () => {
  it("defensively rejects a forged Quick Capture manifest record", () => {
    const quickSeed = seed("run-quick", ["json"]);
    quickSeed.planId = "capture-single-plan:forged";
    const quick = createCaptureManifestRecord(quickSeed);
    expect(quick).toBeDefined();
    expect(planCaptureManifestRecovery(input([quick!]))).toMatchObject({
      ok: false,
      reason: "quick_manifest_forbidden",
      runId: "run-quick",
    });
  });

  it("requires exactly one observation for every unresolved durable download", () => {
    const record = saving(finalizedRecord(), "csv", "attempt-csv", 41);
    expect(planCaptureManifestRecovery(input([record]))).toMatchObject({
      ok: false,
      reason: "download_observation_required",
      downloadId: 41,
    });
    expect(planCaptureManifestRecovery(input([finalizedRecord()], {
      downloads: [{ downloadId: 41, state: "complete" }],
    }))).toMatchObject({
      ok: false,
      reason: "unowned_download_observation",
      downloadId: 41,
    });
  });

  it("rejects duplicate download ownership", () => {
    const first = saving(finalizedRecord("run-one"), "csv", "attempt-one", 41);
    const second = saving(finalizedRecord("run-two"), "csv", "attempt-two", 41);
    expect(planCaptureManifestRecovery(input([first, second]))).toMatchObject({
      ok: false,
      reason: "duplicate_download_owner",
      downloadId: 41,
    });
  });

  it("rejects malformed offscreen claims and unsafe revision advancement", () => {
    expect(planCaptureManifestRecovery(input([finalizedRecord()], {
      offscreenKnown: false,
      active: [blob("run-one", "untrusted", "csv")],
    }))).toMatchObject({ ok: false, reason: "invalid_offscreen_observation" });

    const record = saving(finalizedRecord(), "csv", "attempt-csv", 41);
    const csv = record.outputs.csv;
    if (csv?.state !== "saving") throw new Error("fixture CSV was not saving");
    const exhausted: CaptureManifestRecordV1 = {
      ...record,
      outputs: {
        ...record.outputs,
        csv: { ...csv, revision: Number.MAX_SAFE_INTEGER },
      },
    };
    expect(isCaptureManifestRecordV1(exhausted)).toBe(true);
    expect(planCaptureManifestRecovery(input([exhausted], {
      downloads: [{ downloadId: 41, state: "complete" }],
    }))).toMatchObject({ ok: false, reason: "revision_exhausted" });
  });

  it("enforces collection bounds and never invokes hostile accessors", () => {
    const tooMany = Array.from(
      { length: MAX_CAPTURE_MANIFEST_RECOVERY_RECORDS + 1 },
      (_, index) => finalizedRecord(`run-${index}`),
    );
    expect(planCaptureManifestRecovery(input(tooMany))).toMatchObject({
      ok: false,
      reason: "too_many_records",
    });

    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "schemaVersion", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    for (const [key, value] of Object.entries({
      recordsComplete: true,
      records: [],
      offscreen: { known: true, active: [] },
      downloads: [],
    })) {
      Object.defineProperty(hostile, key, { enumerable: true, value });
    }
    expect(() => planCaptureManifestRecovery(hostile as never)).not.toThrow();
    expect(planCaptureManifestRecovery(hostile as never)).toMatchObject({
      ok: false,
      reason: "invalid_input",
    });
  });

  it("caps simultaneous automatic starts at the offscreen Blob capacity", () => {
    const records: CaptureManifestRecordV1[] = [];
    const active: CaptureManifestBlobStatusEntry[] = [];
    const downloads: CaptureManifestObservedDownloadV1[] = [];
    for (let index = 0; index < 8; index += 1) {
      const runId = `active-run-${index}`;
      const attemptId = `active-attempt-${index}`;
      records.push(saving(finalizedRecord(runId, ["json"]), "json", attemptId, index));
      active.push(blob(runId, attemptId, "json"));
      downloads.push({ downloadId: index, state: "in_progress" });
    }
    records.push(finalizedRecord("pending-run", ["json"]));
    expect(planCaptureManifestRecovery(input(records, { active, downloads }))).toMatchObject({
      ok: true,
      blockers: [{ type: "blob_capacity_limited", deferredCount: 1 }],
      eligibleAutomaticStarts: [],
      requiresReplan: false,
    });
  });
});
