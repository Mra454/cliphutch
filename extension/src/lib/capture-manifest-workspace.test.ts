import { describe, expect, it } from "vitest";
import { createCaptureManifestRecord } from "./capture-manifest-delivery";
import type { CaptureManifestSeedV1 } from "./capture-manifest-seed";
import {
  createCaptureWorkspaceManifest,
  parseCaptureWorkspaceManifests,
} from "./capture-manifest-workspace";

const seed: CaptureManifestSeedV1 = {
  schemaVersion: 1,
  runId: "capture-run:v1:123e4567-e89b-42d3-a456-426614174000",
  planId: "capture-review-v1:123e4567-e89b-42d3-a456-426614174000",
  packName: "Research",
  relativeRoot: "ClipHutch/Research",
  createdAt: 10,
  formats: ["json", "csv"],
  items: [{
    itemId: "item-1",
    included: true,
    jobId: "job-1",
    plannedPath: "ClipHutch/Research/example/image.jpg",
    kind: "image",
    pageUrl: "https://private.example/research",
    sourceHost: "secret-cdn.example",
    addedAt: 11,
  }],
};

describe("Capture manifest workspace boundary", () => {
  it("projects a durable record to delivery state without seed metadata", () => {
    const record = createCaptureManifestRecord(seed);
    expect(record).toBeTruthy();
    const summary = createCaptureWorkspaceManifest(record);
    expect(summary).toEqual({
      runId: seed.runId,
      outputs: [
        { format: "json", state: "pending" },
        { format: "csv", state: "pending" },
      ],
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("secret-cdn.example");
    expect(serialized).not.toContain("plannedPath");
    expect(serialized).not.toContain("job-1");
  });

  it("accepts only ordered JSON-first, bounded, unique run summaries", () => {
    const value = [{
      runId: seed.runId,
      outputs: [
        { format: "json", state: "complete", downloadId: 7 },
        {
          format: "csv",
          state: "failed",
          errorCode: "MANIFEST_SAVE_FAILED",
          retryable: true,
        },
      ],
    }];
    expect(parseCaptureWorkspaceManifests(value)).toEqual(value);
    expect(parseCaptureWorkspaceManifests([value[0], value[0]])).toBeUndefined();
    expect(parseCaptureWorkspaceManifests([{ ...value[0], outputs: [value[0].outputs[1]] }]))
      .toBeUndefined();
    expect(parseCaptureWorkspaceManifests([{ ...value[0], seed }])).toBeUndefined();
    const outputsWithPrivateExtra = [...value[0].outputs] as typeof value[0]["outputs"] & {
      pageUrl?: string;
    };
    outputsWithPrivateExtra.pageUrl = "https://private.example";
    expect(parseCaptureWorkspaceManifests([{
      ...value[0],
      outputs: outputsWithPrivateExtra,
    }])).toBeUndefined();
  });

  it("rejects contradictory states, private extras, sparse arrays, and hostile input", () => {
    expect(parseCaptureWorkspaceManifests([{
      runId: seed.runId,
      outputs: [{ format: "json", state: "complete" }],
    }])).toBeUndefined();
    expect(parseCaptureWorkspaceManifests([{
      runId: seed.runId,
      outputs: [{
        format: "json",
        state: "failed",
        errorCode: "RAW_NETWORK_ERROR",
        retryable: true,
      }],
    }])).toBeUndefined();
    const sparse = new Array(1);
    expect(parseCaptureWorkspaceManifests(sparse)).toBeUndefined();
    expect(parseCaptureWorkspaceManifests(new Proxy([], {
      ownKeys() { throw new Error("hostile"); },
    }))).toBeUndefined();
    expect(parseCaptureWorkspaceManifests(new Proxy([], {
      getPrototypeOf() { throw new Error("hostile"); },
    }))).toBeUndefined();
  });
});
