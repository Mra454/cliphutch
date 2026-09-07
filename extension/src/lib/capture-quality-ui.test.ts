import { describe, expect, it } from "vitest";
import { captureStreamSizeCopy } from "./capture-quality-ui";

describe("Capture stream size presentation", () => {
  it("distinguishes exact, estimated, and unknown sizes", () => {
    expect(captureStreamSizeCopy(12 * 1024 * 1024, "exact")).toBe("exact 12.0 MB");
    expect(captureStreamSizeCopy(12 * 1024 * 1024, "estimated")).toBe(
      "estimated 12.0 MB",
    );
    expect(captureStreamSizeCopy(undefined, "unknown")).toBe("size unknown");
  });

  it("fails closed when confidence and bytes contradict", () => {
    expect(captureStreamSizeCopy(12 * 1024 * 1024, "unknown")).toBe("size unknown");
    expect(captureStreamSizeCopy(Number.MAX_SAFE_INTEGER + 1, "exact")).toBe(
      "size unknown",
    );
  });
});
