import { describe, expect, it } from "vitest";
import { MAX_MEDIA_CHILD_URLS } from "./media-identity";
import { queryRedactedHlsChildUrls } from "./hls-child-urls";

describe("queryRedactedHlsChildUrls", () => {
  it("keeps the first 100 query-redacted unique child URLs", () => {
    const urls = Array.from(
      { length: MAX_MEDIA_CHILD_URLS + 10 },
      (_, index) => `https://cdn.example.test/v/${index}.m3u8?token=secret#frag`,
    );
    const result = queryRedactedHlsChildUrls([
      "https://cdn.example.test/v/0.m3u8?other=secret",
      ...urls,
    ]);
    expect(result).toHaveLength(MAX_MEDIA_CHILD_URLS);
    expect(result[0]).toBe("https://cdn.example.test/v/0.m3u8");
    expect(result.at(-1)).toBe("https://cdn.example.test/v/99.m3u8");
    expect(result).not.toContain("https://cdn.example.test/v/100.m3u8");
  });
});
