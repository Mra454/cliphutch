import { describe, expect, it } from "vitest";
import {
  createCaptureManifest,
  redactManifestUrl,
  serializeCaptureManifestCsv,
  serializeCaptureManifestJson,
  sourceHostForManifest,
  type CaptureManifestInputV1,
} from "./capture-manifest";

const SECRET = "do-not-export-secret";

function input(): CaptureManifestInputV1 {
  return {
    generatorVersion: "0.1.4",
    packName: "Research, \"August\"",
    createdAt: Date.UTC(2026, 7, 15, 12, 0, 0),
    completedAt: Date.UTC(2026, 7, 15, 12, 1, 0),
    status: "partial",
    licenseKey: SECRET,
    items: [
      {
        plannedPath: "ClipHutch/Research/example.com - Product/hero.jpg",
        actualFilename: `/Users/private/Downloads/ClipHutch/hero (1).jpg`,
        kind: "image",
        pageUrl: `https://user:${SECRET}@example.com/product?token=${SECRET}#private`,
        mediaUrl: `https://cdn.example.com/hero.jpg?signature=${SECRET}`,
        width: 1600,
        height: 900,
        capturedAt: Date.UTC(2026, 7, 15, 12, 0, 10),
        status: "complete",
        authorization: SECRET,
      },
      {
        plannedPath: "ClipHutch/Research/example.com - Product/video.mp4",
        kind: "hls",
        pageUrl: "https://example.com/product\nsecond line",
        mediaUrl: "https://video.example.com/master.m3u8",
        capturedAt: Date.UTC(2026, 7, 15, 12, 0, 20),
        status: "failed",
        errorCode: "SERVER_DUMP_WITH_SECRET",
        errorMessage: SECRET,
      },
    ],
  };
}

describe("Capture Pack manifest", () => {
  it("redacts URL credentials, query strings, and fragments", () => {
    expect(redactManifestUrl(`https://user:${SECRET}@example.com/path?q=${SECRET}#hash`)).toBe(
      "https://example.com/path",
    );
    expect(redactManifestUrl("data:text/plain,secret")).toBeUndefined();
  });

  it("omits an overlong host instead of truncating it into false provenance", () => {
    const hostname = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
    const actualHost = `${hostname}:65535`;
    expect(actualHost.length).toBeGreaterThan(255);
    expect(sourceHostForManifest(`https://${actualHost}/asset`)).toBeUndefined();
    const sample = input();
    sample.items[0].sourceHost = undefined;
    sample.items[0].mediaUrl = `https://${actualHost}/asset?token=${SECRET}`;
    const manifest = createCaptureManifest(sample);
    expect(manifest.items[0].sourceHost).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain(":6\"");
  });

  it("creates a bounded versioned manifest without absolute paths or raw errors", () => {
    const manifest = createCaptureManifest(input());
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.items[0].actualBasename).toBe("hero (1).jpg");
    expect(manifest.items[0].pageUrl).toBe("https://example.com/product");
    expect(manifest.items[0].sourceHost).toBe("cdn.example.com");
    expect(manifest.items[1].error).toEqual({
      category: "UNKNOWN",
      message: "The item could not be saved.",
    });
    expect(JSON.stringify(manifest)).not.toContain("/Users/private");
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });

  it("serializes deterministic JSON with a trailing newline", () => {
    const first = serializeCaptureManifestJson(input());
    expect(first).toBe(serializeCaptureManifestJson(input()));
    expect(first.endsWith("\n")).toBe(true);
    expect(first).not.toContain(SECRET);
  });

  it("serializes RFC-safe CSV including quotes, commas, and CRLF", () => {
    const csv = serializeCaptureManifestCsv(input());
    expect(csv).toContain('"ClipHutch/Research/example.com - Product/hero.jpg"'.replace(/^"|"$/g, ""));
    expect(csv).toContain("hero (1).jpg");
    expect(csv).toContain("\r\n");
    expect(csv).not.toContain(SECRET);
    expect(csv).not.toContain("/Users/private");
    expect(csv.split("\r\n")).toHaveLength(4);
  });

  it("quotes CSV fields containing commas", () => {
    const sample = input();
    sample.items[0].plannedPath = "ClipHutch/Research/example.com - Product/a,b.jpg";
    const csv = serializeCaptureManifestCsv(sample);
    expect(csv).toContain('"ClipHutch/Research/example.com - Product/a,b.jpg"');
  });

  it.each(["=2+2.csv", "+cmd.csv", "-1.csv", "@SUM.csv", "\t=cmd.csv"])(
    "neutralizes spreadsheet formulas in %s",
    (actualFilename) => {
      const sample = input();
      sample.items[0].actualFilename = actualFilename;
      const csv = serializeCaptureManifestCsv(sample);
      if (actualFilename.startsWith("\t")) {
        expect(csv).toContain("_=cmd.csv");
        expect(csv).not.toContain("\t=cmd.csv");
      } else {
        expect(csv).toContain(`'${actualFilename}`);
      }
    },
  );

  it("rejects invalid runtime enums and chronological timestamps", () => {
    const invalidKind = input();
    invalidKind.items[0].kind = "executable" as never;
    expect(() => createCaptureManifest(invalidKind)).toThrow(/media kind/i);

    const invalidStatus = input();
    invalidStatus.status = "unknown" as never;
    expect(() => createCaptureManifest(invalidStatus)).toThrow(/pack status/i);

    const reversed = input();
    reversed.completedAt = reversed.createdAt - 1;
    expect(() => createCaptureManifest(reversed)).toThrow(/cannot precede/i);

    const outOfRange = input();
    outOfRange.completedAt = Number.MAX_VALUE;
    expect(() => createCaptureManifest(outOfRange)).toThrow(/ISO date range/i);

    const negative = input();
    negative.createdAt = -1;
    expect(() => createCaptureManifest(negative)).toThrow(/non-negative/i);

    const contradictory = input();
    contradictory.status = "complete";
    expect(() => createCaptureManifest(contradictory)).toThrow(/complete.*failed or cancelled/i);

    const falsePartial = input();
    falsePartial.items = [falsePartial.items[0]];
    expect(() => createCaptureManifest(falsePartial)).toThrow(/partial.*incomplete/i);

    const falseCancelled = input();
    falseCancelled.status = "cancelled";
    expect(() => createCaptureManifest(falseCancelled)).toThrow(/only cancelled/i);
  });

  it("omits overlong redacted page URLs", () => {
    const sample = input();
    sample.items[0].pageUrl = `https://example.com/${"x".repeat(3000)}?secret=${SECRET}`;
    const manifest = createCaptureManifest(sample);
    expect(manifest.items[0].pageUrl).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });

  it("rejects unsafe paths and overlarge manifests", () => {
    const unsafe = input();
    unsafe.items[0].plannedPath = "../secret.jpg";
    expect(() => createCaptureManifest(unsafe)).toThrow(/unsafe planned path/i);

    const oversized = input();
    oversized.items = Array.from({ length: 201 }, () => input().items[0]);
    expect(() => createCaptureManifest(oversized)).toThrow(/at most 200/i);
  });
});
