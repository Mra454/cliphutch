import { describe, it, expect } from "vitest";
import { classifyUrl } from "./detector";

describe("classifyUrl — extension matching", () => {
  it.each([
    ["https://a.example/v.mp4", "direct"],
    ["https://a.example/v.webm", "direct"],
    ["https://a.example/v.mov", "direct"],
    ["https://a.example/v.m4v", "direct"],
    ["https://a.example/v.mkv", "direct"],
    ["https://a.example/v.ogv", "direct"],
    ["https://a.example/v.MP4", "direct"],
    ["https://a.example/playlist.m3u8", "hls"],
    ["https://a.example/playlist.M3U8", "hls"],
    ["https://a.example/manifest.mpd", "dash"],
    ["https://a.example/segment.ts", "segment"],
    ["https://a.example/segment.m4s", "segment"],
    ["https://a.example/segment.cmfv", "segment"],
    ["https://a.example/segment.cmfa", "segment"],
    ["https://a.example/photo.jpg", "image"],
    ["https://a.example/photo.jpeg", "image"],
    ["https://a.example/photo.png", "image"],
    ["https://a.example/photo.webp", "image"],
    ["https://a.example/photo.avif", "image"],
    ["https://a.example/photo.gif", "image"],
  ])("%s → %s", (url, expected) => {
    expect(classifyUrl(url).kind).toBe(expected);
  });
});

describe("classifyUrl — query and fragment stripping", () => {
  it.each([
    "https://a.example/v.mp4?token=abc&signed=xyz",
    "https://a.example/v.mp4#t=10",
    "https://a.example/v.mp4?token=abc#t=10",
    "https://a.example/v.mp4?",
  ])("%s → direct", (url) => {
    expect(classifyUrl(url).kind).toBe("direct");
  });

  it("hls with query string", () => {
    expect(classifyUrl("https://a.example/p.m3u8?signed=xyz").kind).toBe("hls");
  });

  it("segment with query string", () => {
    expect(classifyUrl("https://a.example/seg.ts?bytes=0-1000").kind).toBe("segment");
  });
});

describe("classifyUrl — content-type fallback", () => {
  it("no extension + video/mp4 → direct", () => {
    expect(classifyUrl("https://a.example/stream", "video/mp4").kind).toBe("direct");
  });

  it("no extension + video/webm → direct", () => {
    expect(classifyUrl("https://a.example/stream", "video/webm").kind).toBe("direct");
  });

  it("no extension + application/vnd.apple.mpegurl → hls", () => {
    expect(classifyUrl("https://a.example/stream", "application/vnd.apple.mpegurl").kind).toBe("hls");
  });

  it("no extension + application/x-mpegurl → hls", () => {
    expect(classifyUrl("https://a.example/stream", "application/x-mpegurl").kind).toBe("hls");
  });

  it("no extension + application/dash+xml → dash", () => {
    expect(classifyUrl("https://a.example/stream", "application/dash+xml").kind).toBe("dash");
  });

  it("no extension + text/html → unknown", () => {
    expect(classifyUrl("https://a.example/page", "text/html").kind).toBe("unknown");
  });

  it("no extension + image/jpeg → image", () => {
    expect(classifyUrl("https://a.example/photo", "image/jpeg").kind).toBe("image");
  });

  it("image contentType with parameters is parsed", () => {
    expect(classifyUrl("https://a.example/photo", "image/webp; charset=binary").kind).toBe("image");
  });

  it("contentType with parameters is parsed", () => {
    expect(classifyUrl("https://a.example/x", "video/mp4; codecs=avc1.4d401f").kind).toBe("direct");
  });

  it("URL .mp4 + contentType text/html → unknown (contentType wins)", () => {
    expect(classifyUrl("https://a.example/v.mp4", "text/html").kind).toBe("unknown");
  });

  it("URL .mp4 + contentType video/mp4 stays direct", () => {
    expect(classifyUrl("https://a.example/v.mp4", "video/mp4").kind).toBe("direct");
  });

  it("URL .ts + contentType video/mp2t stays segment", () => {
    expect(classifyUrl("https://a.example/seg.ts", "video/mp2t").kind).toBe("segment");
  });

  it("known extension wins over generic binary MIME", () => {
    expect(classifyUrl("https://a.example/v.mp4?sig=abc", "application/octet-stream").kind).toBe(
      "direct",
    );
    expect(classifyUrl("https://a.example/p.m3u8?sig=abc", "binary/octet-stream").kind).toBe(
      "hls",
    );
  });

  it("text/plain is accepted only for a known manifest extension", () => {
    expect(classifyUrl("https://a.example/p.m3u8", "text/plain").kind).toBe("hls");
    expect(classifyUrl("https://a.example/manifest.mpd", "text/plain").kind).toBe("dash");
    expect(classifyUrl("https://a.example/v.mp4", "text/plain").kind).toBe("unknown");
  });

  it.each(["video/mp2t", "audio/mp2t", "video/iso.segment", "audio/iso.segment"])(
    "extensionless segment MIME %s → segment",
    (mime) => {
      expect(classifyUrl("https://a.example/chunk?token=signed", mime).kind).toBe("segment");
    },
  );

  it("HTML remains authoritative over a signed media-looking URL", () => {
    expect(classifyUrl("https://a.example/v.mp4?token=expired", "text/html").kind).toBe(
      "unknown",
    );
  });
});

describe("classifyUrl — non-video and edge cases", () => {
  it.each([
    "https://a.example/script.js",
    "https://a.example/page.html",
    "https://a.example/data.json",
    "https://a.example/style.css",
  ])("%s → unknown", (url) => {
    expect(classifyUrl(url).kind).toBe("unknown");
  });

  it("path with .mp4 mid-path is not direct", () => {
    expect(classifyUrl("https://a.example/api/v1/get.mp4/data").kind).toBe("unknown");
  });

  it("empty url → unknown low confidence", () => {
    const c = classifyUrl("");
    expect(c.kind).toBe("unknown");
    expect(c.confidence).toBe("low");
  });

  it("invalid url → unknown", () => {
    expect(classifyUrl("not a url").kind).toBe("unknown");
  });

  it("url with no path component → unknown", () => {
    expect(classifyUrl("https://a.example").kind).toBe("unknown");
  });

  it("dot-only filename treated as no extension", () => {
    expect(classifyUrl("https://a.example/.hidden").kind).toBe("unknown");
  });
});
