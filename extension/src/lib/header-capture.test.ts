import { describe, expect, it } from "vitest";
import {
  buildHeaderOps,
  buildSessionRule,
  buildUrlFilter,
  extractCapturedHeaders,
  hasReplayableHeaders,
  hasDirectCredentialHeaders,
} from "./header-capture";

const h = (name: string, value: string) => ({ name, value });

describe("extractCapturedHeaders", () => {
  it("returns empty object when no headers", () => {
    expect(extractCapturedHeaders(undefined)).toEqual({});
    expect(extractCapturedHeaders([])).toEqual({});
  });

  it("extracts named headers case-insensitively", () => {
    const out = extractCapturedHeaders([
      h("Referer", "https://site.example/play"),
      h("ORIGIN", "https://site.example"),
      h("user-agent", "Mozilla/5.0"),
      h("Authorization", "Bearer abc.def"),
    ]);
    expect(out).toEqual({
      referer: "https://site.example/play",
      origin: "https://site.example",
      userAgent: "Mozilla/5.0",
      authorization: "Bearer abc.def",
    });
  });

  it("captures only x-* custom headers", () => {
    const out = extractCapturedHeaders([
      h("X-Auth-Token", "tok123"),
      h("X-Player-Session", "sess456"),
      h("Custom-Header", "should-skip"),
    ]);
    expect(out.custom).toEqual({
      "x-auth-token": "tok123",
      "x-player-session": "sess456",
    });
  });

  it("ignores browser-managed and forbidden headers", () => {
    const out = extractCapturedHeaders([
      h("Cookie", "session=abc"),
      h("Sec-Fetch-Site", "same-origin"),
      h("Host", "site.example"),
      h("Accept-Encoding", "gzip"),
      h("Connection", "keep-alive"),
      h("Referer", "https://site.example/play"),
    ]);
    expect(out).toEqual({ referer: "https://site.example/play" });
  });

  it("returns empty when all headers are ignored", () => {
    const out = extractCapturedHeaders([
      h("Cookie", "x=y"),
      h("Accept", "*/*"),
    ]);
    expect(out).toEqual({});
  });
});

describe("buildUrlFilter", () => {
  it("uses directory prefix for HLS manifests", () => {
    expect(
      buildUrlFilter("https://cdn.example.com/v/abc/playlist.m3u8", "hls"),
    ).toBe("||cdn.example.com/v/abc/");
  });

  it("uses directory prefix for DASH manifests", () => {
    expect(
      buildUrlFilter("https://cdn.example.com/v/manifest.mpd", "dash"),
    ).toBe("||cdn.example.com/v/");
  });

  it("uses exact URL for direct downloads", () => {
    const url = "https://files.example.com/video.mp4?token=abc";
    expect(buildUrlFilter(url, "direct")).toBe(url);
  });

  it("falls back to raw input on bad URL", () => {
    expect(buildUrlFilter("not a url", "hls")).toBe("not a url");
  });
});

describe("buildHeaderOps", () => {
  it("emits one set op per captured header", () => {
    const ops = buildHeaderOps({
      referer: "https://site.example/play",
      authorization: "Bearer abc",
      custom: { "x-auth-token": "tok" },
    });
    expect(ops).toEqual([
      { header: "referer", operation: "set", value: "https://site.example/play" },
      { header: "authorization", operation: "set", value: "Bearer abc" },
      { header: "x-auth-token", operation: "set", value: "tok" },
    ]);
  });

  it("returns empty array for empty captured headers", () => {
    expect(buildHeaderOps({})).toEqual([]);
  });
});

describe("buildSessionRule", () => {
  it("scopes initiator to extension and uses prefix filter for HLS", () => {
    const rule = buildSessionRule({
      ruleId: 42,
      url: "https://cdn.example.com/v/abc/playlist.m3u8",
      kind: "hls",
      captured: { referer: "https://site.example/play" },
      extensionId: "ABCDEF",
    });
    expect(rule.id).toBe(42);
    expect(rule.condition.urlFilter).toBe("||cdn.example.com/v/abc/");
    expect(rule.condition.initiatorDomains).toEqual(["ABCDEF"]);
    expect(rule.condition.resourceTypes).toEqual(["xmlhttprequest", "other"]);
    expect(rule.condition.resourceTypes).not.toContain("media");
    expect(rule.action.type).toBe("modifyHeaders");
    expect(rule.action.requestHeaders).toHaveLength(1);
  });

  it("uses exact URL filter for direct downloads", () => {
    const rule = buildSessionRule({
      ruleId: 7,
      url: "https://files.example.com/v.mp4",
      kind: "direct",
      captured: { referer: "https://site.example" },
      extensionId: "X",
    });
    expect(rule.condition.urlFilter).toBe("https://files.example.com/v.mp4");
  });
});

describe("hasReplayableHeaders", () => {
  it("returns false for empty captured", () => {
    expect(hasReplayableHeaders({})).toBe(false);
    expect(hasReplayableHeaders({ custom: {} })).toBe(false);
  });

  it("returns true for any named or custom header", () => {
    expect(hasReplayableHeaders({ referer: "x" })).toBe(true);
    expect(hasReplayableHeaders({ custom: { "x-a": "b" } })).toBe(true);
  });
});

describe("hasDirectCredentialHeaders", () => {
  it("distinguishes browser context from credentials native Downloads cannot replay", () => {
    expect(hasDirectCredentialHeaders({ userAgent: "Chrome", referer: "https://page.test/" }))
      .toBe(false);
    expect(hasDirectCredentialHeaders({ origin: "https://page.test" })).toBe(false);
    expect(hasDirectCredentialHeaders({ authorization: "Bearer secret" })).toBe(true);
    expect(hasDirectCredentialHeaders({ custom: { "x-media-token": "secret" } })).toBe(true);
  });
});
