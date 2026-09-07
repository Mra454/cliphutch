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

  it("shows pending over errors while a retry is in flight", () => {
    expect(selectCardStatusLine({
      error: "This stream is DRM-protected and cannot be downloaded.",
      pending: "Starting one download.",
      info: "HLS stream will be assembled locally.",
    })).toEqual({
      kind: "pending",
      text: "Starting one download.",
    });
  });

  it("shows automatic checking between progress and errors", () => {
    expect(selectCardStatusLine({
      checking: "Checking a previous download…",
      error: "Start state unknown",
    })).toEqual({
      kind: "pending",
      text: "Checking a previous download…",
    });
    expect(selectCardStatusLine({
      progress: "Downloading 20%",
      checking: "Checking a previous download…",
    })).toEqual({ kind: "progress", text: "Downloading 20%" });
  });

  it("returns the error after the pending retry clears", () => {
    expect(selectCardStatusLine({
      error: "This stream is DRM-protected and cannot be downloaded.",
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

  it("shows completion instead of informational notes", () => {
    expect(selectCardStatusLine({
      complete: "Saved MP4.",
      info: "HLS stream will be assembled locally.",
    })).toEqual({ kind: "complete", text: "Saved MP4." });
  });
});
