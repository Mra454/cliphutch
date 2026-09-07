import { beforeEach, describe, expect, it } from "vitest";
import { createCaptureManifestRecord } from "./capture-manifest-delivery";
import type { CaptureManifestSeedV1 } from "./capture-manifest-seed";
import {
  captureManifestRecordKey,
  finalizeStoredCaptureManifestRecord,
  getCaptureManifestRecord,
  mutateCaptureManifestOutput,
  parseStoredCaptureManifestRecord,
} from "./capture-manifest-storage";

let store: Record<string, unknown>;
let failSet: boolean;
let applyThenFailSet: boolean;

function seed(): CaptureManifestSeedV1 {
  return {
    schemaVersion: 1,
    runId: "run-one",
    planId: "plan-one",
    packName: "Pack",
    relativeRoot: "ClipHutch/Pack",
    createdAt: 10,
    formats: ["json"],
    items: [{
      itemId: "item-one",
      included: true,
      jobId: "job-one",
      plannedPath: "ClipHutch/Pack/example.test/video.mp4",
      kind: "direct",
      pageUrl: "https://example.test/article",
      sourceHost: "cdn.example.test",
      addedAt: 10,
    }],
  };
}

beforeEach(() => {
  store = {};
  failSet = false;
  applyThenFailSet = false;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        async get(keys: string | string[]) {
          const result: Record<string, unknown> = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (Object.prototype.hasOwnProperty.call(store, key)) {
              result[key] = structuredClone(store[key]);
            }
          }
          return result;
        },
        async set(values: Record<string, unknown>) {
          if (applyThenFailSet) {
            Object.assign(store, structuredClone(values));
            throw new Error("acknowledgement lost");
          }
          if (failSet) throw new Error("set unavailable");
          Object.assign(store, structuredClone(values));
        },
      },
    },
  };
});

describe("Capture Manifest session storage", () => {
  it("parses versioned records and treats failure-shaped corruption as corruption", () => {
    const record = createCaptureManifestRecord(seed())!;
    expect(parseStoredCaptureManifestRecord(undefined)).toEqual({ status: "empty" });
    expect(parseStoredCaptureManifestRecord(record)).toMatchObject({ status: "valid" });
    expect(parseStoredCaptureManifestRecord({ schemaVersion: 4 })).toEqual({
      status: "invalid", reason: "future_schema", schemaVersion: 4,
    });
    expect(parseStoredCaptureManifestRecord({ ok: false })).toEqual({
      status: "invalid", reason: "corrupt",
    });
  });

  it("reads isolated copies and persists one legal output transition", async () => {
    const key = captureManifestRecordKey("run-one");
    store[key] = createCaptureManifestRecord(seed());
    const read = await getCaptureManifestRecord("run-one");
    expect(read).toMatchObject({ ok: true, record: { seed: { relativeRoot: "ClipHutch/Pack" } } });
    if (read.ok && read.record) read.record.seed.items[0].sourceHost = "mutated.example";
    expect(await getCaptureManifestRecord("run-one")).toMatchObject({
      ok: true, record: { seed: { items: [{ sourceHost: "cdn.example.test" }] } },
    });
    expect(await finalizeStoredCaptureManifestRecord({ runId: "run-one", finalizedAt: 19 }))
      .toMatchObject({ ok: true, changed: true, record: { finalizedAt: 19 } });
    expect(await finalizeStoredCaptureManifestRecord({ runId: "run-one", finalizedAt: 19 }))
      .toMatchObject({ ok: true, changed: false });
    expect(await finalizeStoredCaptureManifestRecord({ runId: "run-one", finalizedAt: 20 }))
      .toMatchObject({ ok: false, reason: "already_finalized" });
    expect(await mutateCaptureManifestOutput({
      runId: "run-one",
      format: "json",
      action: {
        type: "begin", format: "json", expectedRevision: 0, attemptId: "attempt-one", now: 20,
      },
    })).toMatchObject({ ok: true, changed: true, record: { outputs: { json: { revision: 1 } } } });
    expect(await mutateCaptureManifestOutput({
      runId: "run-one",
      format: "json",
      action: {
        type: "begin", format: "json", expectedRevision: 0, attemptId: "attempt-two", now: 21,
      },
    })).toMatchObject({ ok: false, reason: "revision_mismatch", actualRevision: 1 });
  });

  it("proves applied writes after a lost acknowledgement and classifies absent writes", async () => {
    const key = captureManifestRecordKey("run-one");
    store[key] = createCaptureManifestRecord(seed());
    expect(await finalizeStoredCaptureManifestRecord({ runId: "run-one", finalizedAt: 19 }))
      .toMatchObject({ ok: true, changed: true });
    applyThenFailSet = true;
    expect(await mutateCaptureManifestOutput({
      runId: "run-one", format: "json",
      action: {
        type: "begin", format: "json", expectedRevision: 0, attemptId: "attempt-one", now: 20,
      },
    })).toMatchObject({ ok: true, changed: true });

    store[key] = createCaptureManifestRecord(seed());
    applyThenFailSet = false;
    failSet = true;
    // Freeze directly so this branch isolates an uncommitted output mutation.
    const frozen = structuredClone(store[key]) as Record<string, unknown>;
    frozen.finalizedAt = 19;
    store[key] = frozen;
    expect(await mutateCaptureManifestOutput({
      runId: "run-one", format: "json",
      action: {
        type: "begin", format: "json", expectedRevision: 0, attemptId: "attempt-one", now: 20,
      },
    })).toMatchObject({
      ok: false, reason: "storage_unavailable", operation: "set", committed: false,
    });
  });
});
