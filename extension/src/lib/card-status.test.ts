import { describe, expect, it } from "vitest";
import { selectCardStatusLine } from "./card-status";

describe("selectCardStatusLine", () => {
  it("prioritizes active progress over errors, pending notices, and info", () => {
    expect(selectCardStatusLine({
      progress: "Downloading 2 of 4 segments (1 MB)",
      error: "Download failed.",
      pending: "Starting one download.",
      info: "HLS stream will be assembled locally.",
    })).toEqual({ kind: "progress", text: "Downloading 2 of 4 segments (1 MB)" });
  });

  it("prioritizes errors over pending notices and info", () => {
    expect(selectCardStatusLine({
      error: "This stream is DRM-protected and cannot be downloaded.",
      pending: "Starting one download.",
      info: "HLS stream will be assembled locally.",
    })).toEqual({
      kind: "error",
      text: "This stream is DRM-protected and cannot be downloaded.",
    });
  });

  it("shows pending before informational notes", () => {
    expect(selectCardStatusLine({
      pending: "Loading available qualities.",
      info: "HLS stream will be assembled locally.",
    })).toEqual({ kind: "pending", text: "Loading available qualities." });
  });

  it("shows informational notes only when no job exists", () => {
    expect(selectCardStatusLine({
      hasJob: true,
      info: "Separate audio/video merged into one MP4.",
    })).toBeNull();
    expect(selectCardStatusLine({
      hasJob: false,
      info: "Separate audio/video merged into one MP4.",
    })).toEqual({ kind: "info", text: "Separate audio/video merged into one MP4." });
  });
});
