import { describe, expect, it } from "vitest";
import type { DetectedVideo } from "../types";
import { createMediaSnapshotFromDetected } from "./capture-media-snapshot";
import { isMediaSnapshotV1 } from "./capture-pack-types";

function detected(overrides: Partial<DetectedVideo> = {}): DetectedVideo {
  return {
    id: "media-1",
    kind: "direct",
    url: "https://cdn.example/video.mp4?signature=session-only",
    detectedAt: 100,
    pageUrl: "https://example.com/watch?id=1",
    pageTitle: "Example",
    sizeBytes: 42,
    contentType: "video/mp4",
    ...overrides,
  };
}

describe("Capture Pack media snapshots", () => {
  it("copies only allowlisted authoritative fields", () => {
    const source = {
      ...detected(),
      authorization: "Bearer do-not-copy",
      requestHeaders: { Cookie: "secret" },
      licenseKey: "secret",
    } as DetectedVideo;
    const snapshot = createMediaSnapshotFromDetected(source);
    expect(isMediaSnapshotV1(snapshot)).toBe(true);
    expect(snapshot).toMatchObject({
      mediaId: "media-1",
      kind: "direct",
      firstSeenAt: 100,
      lastSeenAt: 100,
      provenance: ["network"],
    });
    expect(JSON.stringify(snapshot)).not.toContain("do-not-copy");
    expect(JSON.stringify(snapshot)).not.toContain("licenseKey");
  });

  it("classifies DOM-only stills separately from network detections", () => {
    const snapshot = createMediaSnapshotFromDetected(
      detected({ kind: "image", contentType: undefined, sizeBytes: undefined }),
    );
    expect(snapshot.provenance).toEqual(["rendered-image"]);
    expect(createMediaSnapshotFromDetected(detected({ kind: "image" })).provenance).toEqual([
      "network",
    ]);
  });

  it("preserves bounded observations, dimensions, provenance, and family identity", () => {
    const snapshot = createMediaSnapshotFromDetected(detected({
      kind: "image",
      detectedAt: 100,
      firstSeenAt: 80,
      lastSeenAt: 140,
      width: 2_400,
      height: 1_600,
      provenance: ["rendered-image", "picture", "metadata"],
      familyId: "dom-image-v1:document:item",
    }));

    expect(snapshot).toMatchObject({
      detectedAt: 100,
      firstSeenAt: 80,
      lastSeenAt: 140,
      width: 2_400,
      height: 1_600,
      provenance: ["rendered-image", "picture", "metadata"],
      familyId: "dom-image-v1:document:item",
    });
    expect(isMediaSnapshotV1(snapshot)).toBe(true);
  });

  it("omits unsupported page URLs and rejects unsupported media URLs", () => {
    expect(
      createMediaSnapshotFromDetected(detected({ pageUrl: "chrome://settings" })).pageUrl,
    ).toBeUndefined();
    expect(() => createMediaSnapshotFromDetected(detected({ url: "file:///private/video.mp4" })))
      .toThrow(/HTTP\(S\)/i);
  });

  it("bounds text and drops invalid numeric metadata", () => {
    const snapshot = createMediaSnapshotFromDetected(detected({
      pageTitle: "x".repeat(2_000),
      contentType: "y".repeat(500),
      contentDisposition: "z".repeat(3_000),
      sizeBytes: Number.POSITIVE_INFINITY,
    }));
    expect(snapshot.pageTitle).toHaveLength(1_024);
    expect(snapshot.contentType).toHaveLength(256);
    expect(snapshot.contentDisposition).toHaveLength(2_048);
    expect(snapshot.sizeBytes).toBeUndefined();
  });

  it("rejects corrupt authoritative identity and timestamps", () => {
    expect(() => createMediaSnapshotFromDetected(detected({ detectedAt: Number.NaN })))
      .toThrow(/detection time/i);
    expect(() => createMediaSnapshotFromDetected(detected({ id: "" }))).toThrow(/identifier/i);
    expect(() => createMediaSnapshotFromDetected(detected({ id: undefined as unknown as string })))
      .toThrow(/identifier/i);
  });
});
