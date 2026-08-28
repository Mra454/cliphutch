import { describe, expect, it } from "vitest";
import {
  captureManifestFilename,
  captureManifestRetryFailureMessage,
  capturePackActivityStatus,
  createCaptureManifestOutputUiModel,
} from "./capture-manifest-ui";

describe("Capture manifest Activity copy", () => {
  it("uses fixed local filenames and honest terminal labels", () => {
    expect(captureManifestFilename("json")).toBe("_cliphutch-manifest.json");
    expect(createCaptureManifestOutputUiModel({
      format: "json",
      state: "complete",
      downloadId: 0,
    })).toMatchObject({ statusLabel: "Saved", tone: "success" });
  });

  it("derives customer-visible pack state without mutating terminal run storage", () => {
    const runId = "capture-run:v1:123e4567-e89b-42d3-a456-426614174000";
    expect(capturePackActivityStatus("running", {
      runId,
      outputs: [{ format: "json", state: "pending" }],
    })).toBe("running");
    expect(capturePackActivityStatus("complete", {
      runId,
      outputs: [{ format: "json", state: "saving", downloadId: 7 }],
    })).toBe("finalizing");
    expect(capturePackActivityStatus("complete", {
      runId,
      outputs: [{
        format: "json",
        state: "failed",
        errorCode: "MANIFEST_SAVE_FAILED",
        retryable: true,
      }],
    })).toBe("partial");
    expect(capturePackActivityStatus("complete", {
      runId,
      outputs: [{ format: "json", state: "complete", downloadId: 7 }],
    })).toBe("complete");
    expect(capturePackActivityStatus("cancelled", {
      runId,
      outputs: [{ format: "json", state: "pending" }],
    })).toBe("finalizing");
    expect(capturePackActivityStatus("cancelled", {
      runId,
      outputs: [{
        format: "json",
        state: "failed",
        errorCode: "MANIFEST_SAVE_FAILED",
        retryable: true,
      }],
    })).toBe("partial");
    expect(capturePackActivityStatus("cancelled", {
      runId,
      outputs: [{ format: "json", state: "complete", downloadId: 7 }],
    })).toBe("cancelled");
  });

  it("warns before an explicit retry when Chrome acceptance is unknown", () => {
    const model = createCaptureManifestOutputUiModel({
      format: "csv",
      state: "failed",
      errorCode: "MANIFEST_SAVE_STATE_UNKNOWN",
      retryable: true,
    });
    expect(model).toEqual({
      filename: "_cliphutch-manifest.csv",
      statusLabel: "Save state unknown",
      detail: "Chrome may already have accepted this manifest. Check Downloads before exporting it again.",
      tone: "warning",
      actionLabel: "Export CSV manifest again",
    });
  });

  it("offers no retry for a permanent failure and never reflects arbitrary error text", () => {
    const model = createCaptureManifestOutputUiModel({
      format: "json",
      state: "failed",
      errorCode: "MANIFEST_SERIALIZE_FAILED",
      retryable: false,
    });
    expect(model.actionLabel).toBeUndefined();
    expect(JSON.stringify(model)).not.toContain("https://");
    expect(JSON.stringify(model)).not.toContain("Authorization");
    expect(captureManifestRetryFailureMessage(
      "https://private.example/?token=secret Authorization: Bearer secret",
    )).toBe("ClipHutch could not export this manifest. Refresh Activity before trying again.");
  });
});
