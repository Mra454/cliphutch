import { describe, it, expect } from "vitest";
import { inferFilename, parseContentDisposition, looksLikeMachineName } from "./filename";
import type { DetectedVideo } from "../types";

const mk = (partial: Partial<DetectedVideo>): DetectedVideo => ({
  id: "x",
  url: "https://a.example/v.mp4",
  kind: "direct",
  detectedAt: 0,
  ...partial,
});

const DATE_TIME = /\d{4}-\d{2}-\d{2}-\d{4}/;

describe("inferFilename — priority chain (auto)", () => {
  it("uses Content-Disposition filename when present", () => {
    expect(
      inferFilename(mk({ contentDisposition: 'attachment; filename="server-named.mp4"' })),
    ).toBe("server-named.mp4");
  });

  it("falls back to URL basename when no Content-Disposition", () => {
    expect(inferFilename(mk({ url: "https://a/v/movie.mp4" }))).toBe("movie.mp4");
  });

  it("falls back to host+date when URL has no path", () => {
    const out = inferFilename(mk({ url: "https://a.example" }));
    expect(out).toMatch(new RegExp(`^a-example-${DATE_TIME.source}\\.mp4$`));
  });

  it("uses host+date and image extension for images with no basename", () => {
    const out = inferFilename(mk({ kind: "image", url: "https://a.example" }));
    expect(out).toMatch(new RegExp(`^a-example-${DATE_TIME.source}\\.jpg$`));
  });

  it("hls: prefers pageTitle over manifest-shaped basename, mp4 container", () => {
    expect(
      inferFilename(
        mk({
          kind: "hls",
          url: "https://cdn/v/abc/playlist.m3u8",
          pageTitle: "Michael Alexander Reel",
        }),
      ),
    ).toBe("Michael Alexander Reel.mp4");
  });

  it("hls: uses host date time fallback when a root page title is the site label", () => {
    const out = inferFilename(
      mk({
        kind: "hls",
        url: "https://video.squarespace-cdn.com/123e4567-e89b-42d3-a456-426614174000/playlist.m3u8",
        pageUrl: "https://ferret-buffalo-z6hz.squarespace.com/",
        pageTitle: "Squarespace",
      }),
    );
    expect(out).toMatch(/^ferret-buffalo-z6hz-squarespace-com-\d{4}-\d{2}-\d{2}-\d{4}\.mp4$/);
  });

  it("hls: treats a shared repeated title as brand-like when hinted by the popup", () => {
    const out = inferFilename(
      mk({
        kind: "hls",
        url: "https://cdn.example.test/123e4567-e89b-42d3-a456-426614174000/playlist.m3u8",
        pageUrl: "https://videos.example.test/gallery",
        pageTitle: "Gallery",
      }),
      { sharedTitleCount: 2 },
    );
    expect(out).toMatch(/^videos-example-test-\d{4}-\d{2}-\d{2}-\d{4}\.mp4$/);
  });

  it("hls: keeps a normal single-video page title", () => {
    expect(
      inferFilename(
        mk({
          kind: "hls",
          url: "https://cdn.example.test/123e4567-e89b-42d3-a456-426614174000/playlist.m3u8",
          pageUrl: "https://videos.example.test/gallery",
          pageTitle: "Slaying Trailer",
        }),
        { sharedTitleCount: 1 },
      ),
    ).toBe("Slaying Trailer.mp4");
  });

  it("dash: prefers pageTitle over manifest-shaped basename", () => {
    expect(
      inferFilename(
        mk({
          kind: "dash",
          url: "https://cdn/v/abc/manifest.mpd",
          pageTitle: "Behind the Scenes",
        }),
      ),
    ).toBe("Behind the Scenes.mp4");
  });

  it("hls: falls back to host+date when no pageTitle and basename is a manifest", () => {
    const out = inferFilename(mk({ kind: "hls", url: "https://cdn/v/abc/playlist.m3u8" }));
    expect(out).toMatch(new RegExp(`^cdn-${DATE_TIME.source}\\.mp4$`));
  });

  it("hls: keeps a named .m3u8 basename but saves as mp4", () => {
    expect(
      inferFilename(
        mk({
          kind: "hls",
          url: "https://cdn/v/movie-clip.m3u8",
          pageTitle: "Page Title",
        }),
      ),
    ).toBe("movie-clip.mp4");
  });

  it("hls: Cloudflare Stream video.m3u8 defers to pageTitle", () => {
    expect(
      inferFilename(
        mk({
          kind: "hls",
          url: "https://customer-x.cloudflarestream.com/abc/manifest/video.m3u8",
          pageTitle: "Cloudflare Demo",
        }),
      ),
    ).toBe("Cloudflare Demo.mp4");
  });
});

describe("inferFilename — machine-noise demotion (auto)", () => {
  it("demotes a hash basename in favor of the page title", () => {
    expect(
      inferFilename(mk({ url: "https://cdn/8f3a2b1c.mp4", pageTitle: "Kitchen Tour" })),
    ).toBe("Kitchen Tour.mp4");
  });

  it("demotes hash_resolution CDN shape in favor of the page title", () => {
    expect(
      inferFilename(mk({ url: "https://cdn/b3f9c2a1_720.mp4", pageTitle: "Kitchen Tour" })),
    ).toBe("Kitchen Tour.mp4");
  });

  it("demotes bare-number basename", () => {
    expect(
      inferFilename(mk({ url: "https://cdn/4423897.mp4", pageTitle: "Kitchen Tour" })),
    ).toBe("Kitchen Tour.mp4");
  });

  it("demotes camera-default basename", () => {
    expect(
      inferFilename(mk({ kind: "image", url: "https://s/IMG_2039.jpg", pageTitle: "Beach Day" })),
    ).toBe("Beach Day.jpg");
  });

  it("keeps a real word-structured slug over the page title", () => {
    expect(
      inferFilename(mk({ url: "https://cdn/kitchen-tour-final.mp4", pageTitle: "Home Page" })),
    ).toBe("kitchen-tour-final.mp4");
  });

  it("keeps a slug that mixes words and a resolution token", () => {
    expect(
      inferFilename(mk({ url: "https://cdn/my-video-1080.mp4", pageTitle: "Home Page" })),
    ).toBe("my-video-1080.mp4");
  });

  it("demotes a noisy Content-Disposition stem to the page title", () => {
    expect(
      inferFilename(
        mk({
          url: "https://cdn/9a8b7c6d5e.mp4",
          contentDisposition: 'filename="a1b2c3d4e5.mp4"',
          pageTitle: "Real Title",
        }),
      ),
    ).toBe("Real Title.mp4");
  });
});

describe("looksLikeMachineName", () => {
  it.each([
    "8f3a2b1c",
    "b3f9c2a1_720",
    "4423897",
    "550e8400-e29b-41d4-a716-446655440000",
    "IMG_2039",
    "playlist",
    "chunk",
  ])("flags %s as machine-generated", (s) => {
    expect(looksLikeMachineName(s)).toBe(true);
  });

  it.each([
    "kitchen-tour",
    "kitchen-tour-final",
    "my-video-1080",
    "Behind the Scenes",
    "interview",
    "BigBuckBunny1080p", // CamelCase real name, not a random token
  ])("keeps %s as a human name", (s) => {
    expect(looksLikeMachineName(s)).toBe(false);
  });
});

describe("inferFilename — generic manifest variant stems (Codex #3)", () => {
  it.each([
    "https://cdn/video_1080p.m3u8",
    "https://cdn/hls_720.m3u8",
    "https://cdn/playlist_high.m3u8",
    "https://cdn/master-1080p.m3u8",
    "https://cdn/stream_2.mpd",
  ])("defers %s to the page title", (url) => {
    const kind = url.endsWith(".mpd") ? "dash" : "hls";
    expect(inferFilename(mk({ kind, url, pageTitle: "Company Launch" }))).toBe(
      "Company Launch.mp4",
    );
  });

  it("still keeps a descriptive manifest stem", () => {
    expect(
      inferFilename(mk({ kind: "hls", url: "https://cdn/kitchen-tour.m3u8", pageTitle: "Home" })),
    ).toBe("kitchen-tour.mp4");
  });
});

describe("inferFilename — CamelCase basename kept (Codex #4)", () => {
  it("keeps a long CamelCase basename over a generic page title", () => {
    expect(
      inferFilename(mk({ url: "https://cdn/BigBuckBunny1080p.mp4", pageTitle: "Home Page" })),
    ).toBe("BigBuckBunny1080p.mp4");
  });
});

describe("inferFilename — title suffix stripping (Codex #5)", () => {
  it("keeps a dash-separated subtitle that is not a platform", () => {
    expect(
      inferFilename(mk({ url: "https://cdn/8f3a2b1c.mp4", pageTitle: "Summer Recap - Behind the Scenes" })),
    ).toBe("Summer Recap - Behind the Scenes.mp4");
  });

  it("strips a dash-separated known platform suffix", () => {
    expect(
      inferFilename(mk({ url: "https://cdn/8f3a2b1c.mp4", pageTitle: "Kitchen Tour - YouTube" })),
    ).toBe("Kitchen Tour.mp4");
  });

  it("strips a pipe-separated site brand", () => {
    expect(
      inferFilename(mk({ url: "https://cdn/8f3a2b1c.mp4", pageTitle: "Kitchen Tour | Some Site" })),
    ).toBe("Kitchen Tour.mp4");
  });
});

describe("inferFilename — page-title cleanup", () => {
  it("strips a trailing site-name suffix separated by a pipe", () => {
    expect(
      inferFilename(mk({ url: "https://cdn/8f3a2b1c.mp4", pageTitle: "Kitchen Tour | Vimeo" })),
    ).toBe("Kitchen Tour.mp4");
  });

  it("strips a trailing site-name suffix separated by a dash", () => {
    expect(
      inferFilename(mk({ url: "https://cdn/8f3a2b1c.mp4", pageTitle: "Kitchen Tour - YouTube" })),
    ).toBe("Kitchen Tour.mp4");
  });
});

describe("inferFilename — variant label", () => {
  it("appends a resolution label to the stem", () => {
    expect(
      inferFilename(
        mk({ kind: "hls", url: "https://cdn/master.m3u8", pageTitle: "Demo Reel" }),
        { forcedExtension: ".mp4", variantLabel: "1080p" },
      ),
    ).toBe("Demo Reel 1080p.mp4");
  });

  it("does not duplicate a label already present in the stem", () => {
    expect(
      inferFilename(mk({ url: "https://cdn/clip-1080p.mp4" }), { variantLabel: "1080p" }),
    ).toBe("clip-1080p.mp4");
  });
});

describe("inferFilename — template overrides", () => {
  const v = mk({
    url: "https://cdn/v/movie.mp4",
    pageTitle: "Page Title",
    contentDisposition: 'filename="server-named.mp4"',
  });

  it("pageTitle forces the page title source", () => {
    expect(inferFilename(v, { template: "pageTitle" })).toBe("Page Title.mp4");
  });

  it("urlBasename forces the basename source", () => {
    expect(inferFilename(v, { template: "urlBasename" })).toBe("movie.mp4");
  });

  it("timestamp forces a host+date name", () => {
    expect(inferFilename(v, { template: "timestamp" })).toMatch(
      new RegExp(`^cdn-${DATE_TIME.source}\\.mp4$`),
    );
  });

  it("auto trusts the server Content-Disposition name", () => {
    expect(inferFilename(v, { template: "auto" })).toBe("server-named.mp4");
  });

  it("customStem wins over template, URL, and title", () => {
    expect(inferFilename(v, { template: "urlBasename", customStem: "Slaying Trailer" })).toBe(
      "Slaying Trailer.mp4",
    );
  });
});

describe("inferFilename — sanitization", () => {
  it("replaces illegal chars / \\ : * ? \" < > | with underscore", () => {
    expect(
      inferFilename(mk({ contentDisposition: 'filename="bad/name\\with:weird*chars?.mp4"' })),
    ).toBe("bad_name_with_weird_chars_.mp4");
  });

  it("replaces control chars (0x00-0x1f)", () => {
    expect(
      inferFilename(mk({ contentDisposition: 'filename="name\x00\x1f.mp4"' })),
    ).toBe("name__.mp4");
  });

  it("replaces .. sequences", () => {
    expect(inferFilename(mk({ contentDisposition: 'filename="../escape.mp4"' }))).toBe(
      "_escape.mp4",
    );
  });

  it("does not produce a leading slash", () => {
    const out = inferFilename(mk({ contentDisposition: 'filename="/abs/path.mp4"' }));
    expect(out.startsWith("/")).toBe(false);
  });

  it("trims trailing dots", () => {
    expect(inferFilename(mk({ contentDisposition: 'filename="trail..."' }))).toBe(
      "trail.mp4",
    );
  });

  it("trims trailing spaces", () => {
    expect(inferFilename(mk({ contentDisposition: 'filename="trail   "' }))).toBe(
      "trail.mp4",
    );
  });
});

describe("inferFilename — Windows reserved names", () => {
  it.each(["CON", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9"])(
    "%s is prefixed with underscore",
    (name) => {
      expect(inferFilename(mk({ contentDisposition: `filename="${name}.mp4"` }))).toBe(
        `_${name}.mp4`,
      );
    },
  );

  it("reserved name is case-insensitive", () => {
    expect(inferFilename(mk({ contentDisposition: 'filename="con.mp4"' }))).toBe(
      "_con.mp4",
    );
  });

  it("non-reserved name beginning with COM is not prefixed", () => {
    expect(inferFilename(mk({ contentDisposition: 'filename="COMET.mp4"' }))).toBe(
      "COMET.mp4",
    );
  });
});

describe("inferFilename — Unicode", () => {
  it("normalizes NFC form", () => {
    const decomposed = "café.mp4";
    const composed = "café.mp4";
    expect(
      inferFilename(mk({ contentDisposition: `filename="${decomposed}"` })),
    ).toBe(composed);
  });

  it("preserves emoji", () => {
    expect(inferFilename(mk({ contentDisposition: 'filename="party 🎉.mp4"' }))).toBe(
      "party 🎉.mp4",
    );
  });
});

describe("inferFilename — extension handling", () => {
  it("forcedExtension replaces existing extension (foo.mp4 → foo.ts)", () => {
    expect(
      inferFilename(mk({ contentDisposition: 'filename="foo.mp4"' }), { forcedExtension: ".ts" }),
    ).toBe("foo.ts");
  });

  it("forcedExtension without leading dot is normalized", () => {
    expect(
      inferFilename(mk({ contentDisposition: 'filename="foo.mp4"' }), { forcedExtension: "ts" }),
    ).toBe("foo.ts");
  });

  it("forcedExtension applies even when input has no extension", () => {
    expect(
      inferFilename(mk({ url: "https://a/stream" }), { forcedExtension: ".ts" }),
    ).toBe("stream.ts");
  });

  it("kind-default extension when neither Content-Disposition nor URL has one", () => {
    expect(inferFilename(mk({ url: "https://a/stream" }))).toBe("stream.mp4");
  });

  it("hls kind defaults to .mp4 (muxed container) when no extension elsewhere", () => {
    expect(inferFilename(mk({ kind: "hls", url: "https://a/stream" }))).toBe("stream.mp4");
  });

  it("ignores a manifest extension when choosing the container", () => {
    expect(
      inferFilename(mk({ kind: "hls", url: "https://cdn/named-clip.m3u8" })),
    ).toBe("named-clip.mp4");
  });
});

describe("inferFilename — length truncation", () => {
  it("truncates to 200 chars total preserving extension", () => {
    const long = "a".repeat(300) + ".mp4";
    const out = inferFilename(mk({ contentDisposition: `filename="${long}"` }));
    expect(out.length).toBe(200);
    expect(out.endsWith(".mp4")).toBe(true);
  });

  it("truncated stem with trailing dots removed", () => {
    const long = "a".repeat(196) + "....mp4";
    const out = inferFilename(mk({ contentDisposition: `filename="${long}"` }));
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toMatch(/\.+\.mp4$/);
  });
});

describe("inferFilename — empty / fallback", () => {
  it("empty Content-Disposition + no URL path → host+date fallback", () => {
    const out = inferFilename(mk({ contentDisposition: 'filename=""', url: "https://a" }));
    expect(out).toMatch(new RegExp(`^a-${DATE_TIME.source}\\.mp4$`));
  });

  it("fallback name uses kind default extension", () => {
    const out = inferFilename(mk({ kind: "hls", url: "https://a" }));
    expect(out).toMatch(new RegExp(`^a-${DATE_TIME.source}\\.mp4$`));
  });
});

describe("parseContentDisposition", () => {
  it("plain filename=foo.mp4", () => {
    expect(parseContentDisposition("attachment; filename=foo.mp4")).toBe("foo.mp4");
  });

  it("quoted filename", () => {
    expect(parseContentDisposition('attachment; filename="foo bar.mp4"')).toBe("foo bar.mp4");
  });

  it("RFC 5987 UTF-8 percent-encoded filename*", () => {
    expect(
      parseContentDisposition("attachment; filename*=UTF-8''na%C3%AFve.mp4"),
    ).toBe("naïve.mp4");
  });

  it("RFC 5987 with language tag", () => {
    expect(
      parseContentDisposition("attachment; filename*=UTF-8'en'hello%20world.mp4"),
    ).toBe("hello world.mp4");
  });

  it("returns undefined for missing CD", () => {
    expect(parseContentDisposition(undefined)).toBeUndefined();
  });

  it("returns undefined for inline-only CD", () => {
    expect(parseContentDisposition("inline")).toBeUndefined();
  });
});
