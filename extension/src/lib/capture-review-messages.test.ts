import { describe, expect, it } from "vitest";
import {
  createCaptureCancelCommandId,
  createCaptureManifestRetryCommandId,
  createCapturePlanCommandId,
  createCaptureRunCommandId,
  parseCaptureReviewUiRequest,
} from "./capture-review-messages";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("capture review message contracts", () => {
  it("parses only the bounded authoritative plan selector envelope", () => {
    const request = {
      type: "capture-plan-create",
      commandId: `capture-plan-${UUID}`,
      draftId: "capture-pack-1",
      expectedRevision: 3,
      choices: [{ itemId: "item-1", optionId: `capture-option-v1-${"a".repeat(40)}` }],
    };
    expect(parseCaptureReviewUiRequest(request)).toEqual(request);
    expect(parseCaptureReviewUiRequest({ ...request, url: "https://secret.example/a" })).toBeUndefined();
    expect(parseCaptureReviewUiRequest({ ...request, choices: [...request.choices, request.choices[0]] })).toBeUndefined();
    expect(parseCaptureReviewUiRequest({ ...request, choices: [{ ...request.choices[0], headers: {} }] })).toBeUndefined();
    expect(parseCaptureReviewUiRequest({
      ...request,
      choices: [{ itemId: "item-1", optionId: "variant.m3u8" }],
    })).toBeUndefined();
  });

  it("requires an explicit unique free allocation without accepting entitlement claims", () => {
    const request = {
      type: "capture-run-enqueue",
      commandId: `capture-run-${UUID}`,
      planId: "plan-1",
      draftId: "capture-pack-1",
      expectedRevision: 3,
      freeVideoItemIds: ["video-2", "video-1"],
    };
    expect(parseCaptureReviewUiRequest(request)).toEqual(request);
    expect(parseCaptureReviewUiRequest({ ...request, licensed: true })).toBeUndefined();
    expect(parseCaptureReviewUiRequest({ ...request, freeVideoItemIds: ["video-1", "video-1"] })).toBeUndefined();
    expect(parseCaptureReviewUiRequest({ ...request, runId: "chosen-by-ui" })).toBeUndefined();
    expect(parseCaptureReviewUiRequest({
      ...request,
      commandId: `capture-run-${UUID.toUpperCase()}`,
    })).toEqual(request);
  });

  it("parses exact cancellation and read requests", () => {
    expect(parseCaptureReviewUiRequest({
      type: "capture-job-cancel",
      commandId: `capture-cancel-${UUID}`,
      jobId: "job-1",
      attemptId: "attempt-1",
    })).toBeTruthy();
    expect(parseCaptureReviewUiRequest({ type: "capture-workspace-get" })).toEqual({
      type: "capture-workspace-get",
    });
    expect(parseCaptureReviewUiRequest({ type: "capture-workspace-get", includeUrls: true })).toBeUndefined();
  });

  it("allows Quick Capture reconciliation to carry only its canonical original command", () => {
    const request = {
      type: "capture-quick-reconcile",
      commandId: `download-${UUID}`,
    };
    expect(parseCaptureReviewUiRequest(request)).toEqual(request);
    expect(parseCaptureReviewUiRequest({
      ...request,
      commandId: `download-${UUID.toUpperCase()}`,
    })).toEqual(request);
    expect(parseCaptureReviewUiRequest({ ...request, videoId: "media-1" })).toBeUndefined();
    expect(parseCaptureReviewUiRequest({ ...request, licensed: true })).toBeUndefined();
    expect(parseCaptureReviewUiRequest({ ...request, commandId: `capture-run-${UUID}` })).toBeUndefined();
  });

  it("parses only a command-owned manifest retry for one run and format", () => {
    const request = {
      type: "capture-manifest-retry",
      commandId: `capture-manifest-retry-${UUID}`,
      runId: `capture-run:v1:${UUID}`,
      format: "json",
    };
    expect(parseCaptureReviewUiRequest(request)).toEqual(request);
    expect(parseCaptureReviewUiRequest({
      ...request,
      commandId: `capture-manifest-retry-${UUID.toUpperCase()}`,
    })).toEqual(request);
    expect(parseCaptureReviewUiRequest({ ...request, format: "xml" })).toBeUndefined();
    expect(parseCaptureReviewUiRequest({ ...request, runId: "../run" })).toBeUndefined();
    expect(parseCaptureReviewUiRequest({
      ...request,
      runId: `capture-run:v1:${UUID.toUpperCase()}`,
    })).toBeUndefined();
    expect(parseCaptureReviewUiRequest({ ...request, downloadId: 12 })).toBeUndefined();
    expect(parseCaptureReviewUiRequest({ ...request, retryable: true })).toBeUndefined();
  });

  it("fails closed for malformed, oversized, accessor, and proxy input", () => {
    const choices = Array.from({ length: 201 }, (_, index) => ({
      itemId: `item-${index}`,
      optionId: `option-${index}`,
    }));
    expect(parseCaptureReviewUiRequest({
      type: "capture-plan-create",
      commandId: `capture-plan-${UUID}`,
      draftId: "draft",
      expectedRevision: 0,
      choices,
    })).toBeUndefined();
    expect(parseCaptureReviewUiRequest(Object.defineProperty({}, "type", {
      enumerable: true,
      get: () => "capture-workspace-get",
    }))).toBeUndefined();
    expect(parseCaptureReviewUiRequest(new Proxy({}, { ownKeys: () => { throw new Error("no"); } }))).toBeUndefined();
  });

  it("creates namespaced UUID command IDs and rejects a broken UUID source", () => {
    expect(createCapturePlanCommandId(() => UUID)).toBe(`capture-plan-${UUID}`);
    expect(createCaptureRunCommandId(() => UUID)).toBe(`capture-run-${UUID}`);
    expect(createCaptureCancelCommandId(() => UUID)).toBe(`capture-cancel-${UUID}`);
    expect(createCaptureManifestRetryCommandId(() => UUID)).toBe(
      `capture-manifest-retry-${UUID}`,
    );
    expect(createCaptureRunCommandId(() => UUID.toUpperCase())).toBe(`capture-run-${UUID}`);
    expect(() => createCapturePlanCommandId(() => "not-a-uuid")).toThrow(TypeError);
  });
});
