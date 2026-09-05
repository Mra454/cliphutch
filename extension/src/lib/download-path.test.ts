import { describe, expect, it } from "vitest";
import {
  buildPageFolder,
  buildRelativeDownloadPath,
  dedupePlannedPaths,
  isSafeRelativeDownloadPath,
  sanitizeDownloadFilename,
  sanitizePathSegment,
  validateCustomDownloadStem,
} from "./download-path";

describe("download path planning", () => {
  it("builds a safe nested Downloads-relative path", () => {
    const path = buildRelativeDownloadPath({
      packName: "Campaign Research",
      pageHost: "example.com",
      pageTitle: "Product launch",
      filename: "hero.mp4",
    });
    expect(path).toBe("ClipHutch/Campaign Research/example.com - Product launch/hero.mp4");
    expect(isSafeRelativeDownloadPath(path)).toBe(true);
  });

  it.each([
    ["..", "untitled"],
    ["../private", "__private"],
    ["C:\\secret", "C__secret"],
    ["/absolute/path", "_absolute_path"],
    ["CON", "_CON"],
    ["LPT9.txt", "_LPT9.txt"],
    ["name. ", "name"],
    ["safe\u202efile", "safefile"],
  ])("sanitizes an unsafe segment %s", (input, expected) => {
    expect(sanitizePathSegment(input)).toBe(expected);
  });

  it("normalizes Unicode and preserves a valid extension while truncating", () => {
    expect(sanitizePathSegment("Cafe\u0301")).toBe("Café");
    const filename = sanitizeDownloadFilename(`${"a".repeat(200)}.mp4`, { maxLength: 32 });
    expect(filename).toHaveLength(32);
    expect(filename.endsWith(".mp4")).toBe(true);
  });

  it("keeps sanitized segments within their advertised bound", () => {
    expect(sanitizePathSegment("CONSOLE", { maxLength: 3 })).toHaveLength(3);
    expect(sanitizePathSegment(".hidden", { maxLength: 1 })).toHaveLength(1);
    expect(sanitizePathSegment("\u061c\u200e\u200fmedia", { maxLength: 5 })).toBe("media");
  });

  it("constructs a bounded page folder from hostile input", () => {
    const folder = buildPageFolder("../../example.com", "A/B\\C\u0000D");
    expect(folder).not.toMatch(/[\\/\u0000]/);
    expect(folder).not.toContain("..");
  });

  it("bounds the complete relative path deterministically", () => {
    const input = {
      packName: "p".repeat(100),
      pageHost: "h".repeat(80),
      pageTitle: "t".repeat(120),
      filename: `${"f".repeat(180)}.webm`,
      maxPathLength: 120,
    };
    const first = buildRelativeDownloadPath(input);
    expect(first).toHaveLength(120);
    expect(buildRelativeDownloadPath(input)).toBe(first);
    expect(first.endsWith(".webm")).toBe(true);
  });

  it("deduplicates same-pack paths case-insensitively with stable suffixes", () => {
    const paths = [
      "ClipHutch/Pack/Page/image.jpg",
      "ClipHutch/Pack/Page/IMAGE.jpg",
      "ClipHutch/Pack/Page/image.jpg",
    ];
    expect(dedupePlannedPaths(paths)).toEqual([
      "ClipHutch/Pack/Page/image.jpg",
      "ClipHutch/Pack/Page/IMAGE (2).jpg",
      "ClipHutch/Pack/Page/image (3).jpg",
    ]);
  });

  it.each(["", "/tmp/file.mp4", "C:/tmp/file.mp4", "ClipHutch/../file.mp4", "ClipHutch/Page\\file.mp4"])(
    "rejects unsafe prebuilt path %s",
    (path) => expect(isSafeRelativeDownloadPath(path)).toBe(false),
  );

  it.each([
    "Other/Pack/file.mp4",
    "ClipHutch/CON/file.mp4",
    "ClipHutch/Pack./file.mp4",
    "ClipHutch/Pack/file?.mp4",
    `ClipHutch/${"p".repeat(97)}/file.mp4`,
  ])("rejects a non-canonical prebuilt path %s", (path) => {
    expect(isSafeRelativeDownloadPath(path)).toBe(false);
  });

  it("rejects non-finite path limits", () => {
    expect(() => buildRelativeDownloadPath({
      packName: "Pack",
      filename: "file.mp4",
      maxPathLength: Number.NaN,
    })).toThrow(/finite integer/i);
    expect(() => dedupePlannedPaths(["ClipHutch/Pack/file.mp4"], Infinity)).toThrow(
      /finite integer/i,
    );
  });

  it("never lets a collision suffix exceed the configured path limit", () => {
    const path = buildRelativeDownloadPath({
      packName: "p".repeat(80),
      pageHost: "example.com",
      pageTitle: "page",
      filename: "a.mp4",
      maxPathLength: 120,
    });
    const deduped = dedupePlannedPaths([path, path], 120);
    expect(deduped[1].length).toBeLessThanOrEqual(120);
    expect(deduped[1]).toMatch(/ \(2\)\.mp4$/);
  });
});

describe("validateCustomDownloadStem", () => {
  it("accepts a customer filename stem", () => {
    expect(validateCustomDownloadStem("Slaying Trailer")).toEqual({
      ok: true,
      stem: "Slaying Trailer",
    });
  });

  it("normalizes canonically equivalent customer stems consistently", () => {
    expect(validateCustomDownloadStem("Cafe\u0301")).toEqual({
      ok: true,
      stem: "Café",
    });
    expect(validateCustomDownloadStem("Café")).toEqual({
      ok: true,
      stem: "Café",
    });
  });

  it("rejects stems over the download basename limit", () => {
    expect(validateCustomDownloadStem("x".repeat(141))).toEqual({
      ok: false,
      reason: "Titles must be 140 characters or fewer.",
    });
  });

  it("rejects control and direction-formatting characters", () => {
    expect(validateCustomDownloadStem("unsafe\nname")).toEqual({
      ok: false,
      reason: "Remove control or direction-formatting characters from this title.",
    });
    expect(validateCustomDownloadStem("unsafe\u202ename")).toEqual({
      ok: false,
      reason: "Remove control or direction-formatting characters from this title.",
    });
  });

  it("rejects path separators", () => {
    expect(validateCustomDownloadStem("folder/name")).toEqual({
      ok: false,
      reason: "Titles cannot contain path separators.",
    });
  });

  it("rejects dots-only names", () => {
    expect(validateCustomDownloadStem("...")).toEqual({
      ok: false,
      reason: "Use at least one letter or number in this title.",
    });
  });

  it.each([".profile", "title.", "title "])(
    "rejects custom stems with leading dots or trailing dots/spaces: %s",
    (input) => {
      expect(validateCustomDownloadStem(input)).toEqual({
        ok: false,
        reason: "Titles cannot start with a dot or end with a dot or space.",
      });
    },
  );

  it.each(["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"])(
    "rejects reserved Windows custom stem %s",
    (input) => {
      expect(validateCustomDownloadStem(input)).toEqual({
        ok: false,
        reason: "Choose a title that is not a reserved Windows filename.",
      });
    },
  );

  it("keeps extension-like text only as part of the stem when it is valid", () => {
    expect(validateCustomDownloadStem("evil.exe")).toEqual({ ok: true, stem: "evil.exe" });
    expect(validateCustomDownloadStem("x.mp4.exe")).toEqual({ ok: true, stem: "x.mp4.exe" });
  });
});
