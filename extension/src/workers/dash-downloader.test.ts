import { describe, expect, it, vi } from "vitest";
import { downloadDash } from "./dash-downloader";

// Synthetic byte fixtures aren't valid fMP4; stub the muxer with a
// deterministic concat-and-tag so the tests can assert on the fetch +
// orchestration logic without depending on mp4box.js.
vi.mock("./dash-mux", () => ({
  inspectFmp4Init: (bytes: Uint8Array) => ({
    encrypted: bytes[0] === 0xee,
    trackCount: bytes[0] === 0x02 ? 2 : 1,
    trackTypes: [bytes[0] >= 20 && bytes[0] !== 0xee ? "audio" : "video"],
  }),
  muxFmp4: async (videoBytes: Uint8Array, audioBytes?: Uint8Array) => {
    const total = videoBytes.length + (audioBytes?.length ?? 0);
    const out = new Uint8Array(total);
    out.set(videoBytes, 0);
    if (audioBytes) out.set(audioBytes, videoBytes.length);
    return out;
  },
}));
import {
  AccessDeniedError,
  ByteRangeError,
  DrmProtectedError,
  EmptyManifestError,
  LiveStreamError,
  SizeCapError,
  UnsupportedMediaShapeError,
  VariantStaleError,
} from "../lib/errors";

type FetchEntry = { body: string | Uint8Array; status?: number };

function makeFetch(map: Record<string, FetchEntry>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const entry = map[url];
    if (!entry) return new Response("", { status: 404 });
    if (entry.status && entry.status >= 400) {
      return new Response("", { status: entry.status });
    }
    if (typeof entry.body === "string") {
      return new Response(entry.body, { status: entry.status ?? 200 });
    }
    return new Response(entry.body as unknown as BodyInit, { status: entry.status ?? 200 });
  }) as typeof fetch;
}

const MPD_SIMPLE = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v" bandwidth="2000000">
        <SegmentTemplate initialization="vinit.m4s" media="v-$Number$.m4s" startNumber="1" duration="6000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="a" bandwidth="128000">
        <SegmentTemplate initialization="ainit.m4s" media="a-$Number$.m4s" startNumber="1" duration="6000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const MPD_DRM = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT6S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="v" bandwidth="1">
        <SegmentTemplate initialization="i.m4s" media="s-$Number$.m4s" startNumber="1" duration="1" timescale="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const MPD_DYNAMIC = `<?xml version="1.0"?>
<MPD type="dynamic">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v" bandwidth="1">
        <SegmentTemplate initialization="i.m4s" media="s-$Number$.m4s" startNumber="1" duration="1" timescale="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const MPD_BYTERANGE = `<?xml version="1.0"?>
<MPD type="static"><Period><AdaptationSet contentType="video" mimeType="video/mp4">
<Representation id="v" bandwidth="1"><SegmentBase indexRange="0-1000"/></Representation>
</AdaptationSet></Period></MPD>`;

const MPD_VIDEO_ONLY = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT6S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v" bandwidth="1000000">
        <SegmentTemplate initialization="vinit.m4s" media="v-$Number$.m4s" startNumber="1" duration="6000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const MANIFEST_URL = "https://cdn.example.com/v/manifest.mpd";

describe("downloadDash", () => {
  it("downloads video + audio when both adaptation sets exist", async () => {
    const fetchImpl = makeFetch({
      [MANIFEST_URL]: { body: MPD_SIMPLE },
      "https://cdn.example.com/v/vinit.m4s": { body: new Uint8Array([1, 2, 3, 4]) },
      "https://cdn.example.com/v/v-1.m4s": { body: new Uint8Array([5, 6, 7, 8]) },
      "https://cdn.example.com/v/v-2.m4s": { body: new Uint8Array([9, 10, 11, 12]) },
      "https://cdn.example.com/v/ainit.m4s": { body: new Uint8Array([20, 21]) },
      "https://cdn.example.com/v/a-1.m4s": { body: new Uint8Array([22, 23]) },
      "https://cdn.example.com/v/a-2.m4s": { body: new Uint8Array([24, 25]) },
    });
    const progress: { videoDone: number; audioDone: number; bytes: number }[] = [];
    const result = await downloadDash(MANIFEST_URL, {
      signal: new AbortController().signal,
      sizeCapBytes: 100_000_000,
      fetchImpl,
      onProgress: (p) =>
        progress.push({ videoDone: p.videoDone, audioDone: p.audioDone, bytes: p.bytes }),
    });
    // Stubbed muxer concats video then audio: 12 + 6 = 18 bytes
    expect(result.size).toBe(18);
    expect(result.type).toBe("video/mp4");
    expect(progress.at(-1)?.videoDone).toBe(2);
    expect(progress.at(-1)?.audioDone).toBe(2);
  });

  it("downloads video only when manifest has no audio adaptation set", async () => {
    const fetchImpl = makeFetch({
      [MANIFEST_URL]: { body: MPD_VIDEO_ONLY },
      "https://cdn.example.com/v/vinit.m4s": { body: new Uint8Array([1]) },
      "https://cdn.example.com/v/v-1.m4s": { body: new Uint8Array([2]) },
    });
    const result = await downloadDash(MANIFEST_URL, {
      signal: new AbortController().signal,
      sizeCapBytes: 1_000_000,
      fetchImpl,
      onProgress: () => {},
    });
    expect(result.size).toBe(2);
    expect(result.type).toBe("video/mp4");
  });

  it("throws DrmProtectedError for Widevine-protected manifest", async () => {
    const fetchImpl = makeFetch({ [MANIFEST_URL]: { body: MPD_DRM } });
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toThrow(DrmProtectedError);
  });

  it("throws LiveStreamError for dynamic MPD", async () => {
    const fetchImpl = makeFetch({ [MANIFEST_URL]: { body: MPD_DYNAMIC } });
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toThrow(LiveStreamError);
  });

  it("throws ByteRangeError for SegmentBase-only manifest", async () => {
    const fetchImpl = makeFetch({ [MANIFEST_URL]: { body: MPD_BYTERANGE } });
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toThrow(ByteRangeError);
  });

  it("throws EmptyManifestError when no representations remain", async () => {
    const empty = `<?xml version="1.0"?><MPD type="static"><Period/></MPD>`;
    const fetchImpl = makeFetch({ [MANIFEST_URL]: { body: empty } });
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toThrow(EmptyManifestError);
  });

  it("throws AccessDeniedError on 403 fetching the manifest", async () => {
    const fetchImpl = makeFetch({ [MANIFEST_URL]: { body: "", status: 403 } });
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("throws SizeCapError when an actual segment pushes total over cap", async () => {
    const big = new Uint8Array(2000);
    const fetchImpl = makeFetch({
      [MANIFEST_URL]: { body: MPD_VIDEO_ONLY },
      "https://cdn.example.com/v/vinit.m4s": { body: new Uint8Array([1]) },
      "https://cdn.example.com/v/v-1.m4s": { body: big },
    });
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1000,
        fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toThrow(SizeCapError);
  });

  it("does not let an unrelated unsupported Representation block a supported one", async () => {
    const mpd = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT1S"><Period>
  <AdaptationSet contentType="video" mimeType="video/mp4">
    <Representation id="unsupported-high" bandwidth="9000000"><SegmentBase indexRange="0-99"/></Representation>
    <Representation id="supported" bandwidth="1000000">
      <SegmentTemplate initialization="i.m4s" media="s-$Number$.m4s" duration="1" timescale="1"/>
    </Representation>
  </AdaptationSet>
</Period></MPD>`;
    const requested: string[] = [];
    const base = makeFetch({
      [MANIFEST_URL]: { body: mpd },
      "https://cdn.example.com/v/i.m4s": { body: new Uint8Array([1]) },
      "https://cdn.example.com/v/s-1.m4s": { body: new Uint8Array([2]) },
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(typeof input === "string" ? input : input.toString());
      return base(input, init);
    }) as typeof fetch;

    const result = await downloadDash(MANIFEST_URL, {
      signal: new AbortController().signal,
      sizeCapBytes: 1_000_000,
      fetchImpl,
      onProgress: () => {},
    });
    expect(result.size).toBe(2);
    expect(requested).not.toContain("https://cdn.example.com/v/unsupported-high");
  });

  it("does not let a protected alternative block a clear Representation", async () => {
    const mpd = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT1S"><Period>
  <AdaptationSet contentType="video" mimeType="video/mp4">
    <SegmentTemplate initialization="i-$RepresentationID$.m4s" media="s-$RepresentationID$-$Number$.m4s" duration="1" timescale="1"/>
    <Representation id="protected" bandwidth="9000000">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
    </Representation>
    <Representation id="clear" bandwidth="1000000"/>
  </AdaptationSet>
</Period></MPD>`;
    const requested: string[] = [];
    const base = makeFetch({
      [MANIFEST_URL]: { body: mpd },
      "https://cdn.example.com/v/i-clear.m4s": { body: new Uint8Array([1]) },
      "https://cdn.example.com/v/s-clear-1.m4s": { body: new Uint8Array([2]) },
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(typeof input === "string" ? input : input.toString());
      return base(input, init);
    }) as typeof fetch;

    const result = await downloadDash(MANIFEST_URL, {
      signal: new AbortController().signal,
      sizeCapBytes: 1_000_000,
      fetchImpl,
      onProgress: () => {},
    });
    expect(result.size).toBe(2);
    expect(requested.some((url) => url.includes("protected"))).toBe(false);
  });

  it("returns VARIANT_STALE instead of silently replacing a missing selected quality", async () => {
    const fetchImpl = makeFetch({ [MANIFEST_URL]: { body: MPD_VIDEO_ONLY } });
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        videoRepresentationId: "gone",
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ code: "VARIANT_STALE" });
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        videoRepresentationId: "gone",
        onProgress: () => {},
      }),
    ).rejects.toBeInstanceOf(VariantStaleError);
  });

  it("rejects multiple DASH periods before requesting any segment", async () => {
    const multiPeriod = `<?xml version="1.0"?><MPD type="static"><Period/><Period/></MPD>`;
    let mediaRequests = 0;
    const base = makeFetch({ [MANIFEST_URL]: { body: multiPeriod } });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== MANIFEST_URL) mediaRequests++;
      return base(input, init);
    }) as typeof fetch;
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaShapeError);
    expect(mediaRequests).toBe(0);
  });

  it("rejects SegmentList ranges before requesting init or media bytes", async () => {
    const ranged = `<?xml version="1.0"?>
<MPD type="static"><Period><AdaptationSet contentType="video" mimeType="video/mp4">
  <Representation id="v" bandwidth="1"><SegmentList>
    <Initialization sourceURL="all.mp4" range="0-99"/>
    <SegmentURL media="all.mp4" mediaRange="100-199"/>
  </SegmentList></Representation>
</AdaptationSet></Period></MPD>`;
    let binaryRequests = 0;
    const base = makeFetch({ [MANIFEST_URL]: { body: ranged } });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== MANIFEST_URL) binaryRequests++;
      return base(input, init);
    }) as typeof fetch;
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toBeInstanceOf(ByteRangeError);
    expect(binaryRequests).toBe(0);
  });

  it("rejects open-ended DASH timeline repeats before requesting init or media bytes", async () => {
    const negativeRepeat = `<?xml version="1.0"?>
<MPD type="static"><Period><AdaptationSet contentType="video" mimeType="video/mp4">
  <Representation id="v" bandwidth="1"><SegmentTemplate initialization="i.m4s" media="s-$Time$.m4s">
    <SegmentTimeline><S t="0" d="1" r="-1"/></SegmentTimeline>
  </SegmentTemplate></Representation>
</AdaptationSet></Period></MPD>`;
    let binaryRequests = 0;
    const base = makeFetch({ [MANIFEST_URL]: { body: negativeRepeat } });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== MANIFEST_URL) binaryRequests++;
      return base(input, init);
    }) as typeof fetch;
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaShapeError);
    expect(binaryRequests).toBe(0);
  });

  it("rejects bare mp4protection CENC before requesting init or media bytes", async () => {
    const bareCenc = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT1S"><Period>
  <AdaptationSet contentType="video" mimeType="video/mp4">
    <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
    <Representation id="v" bandwidth="1">
      <SegmentTemplate initialization="i.m4s" media="s-$Number$.m4s" duration="1" timescale="1"/>
    </Representation>
  </AdaptationSet>
</Period></MPD>`;
    let binaryRequests = 0;
    const base = makeFetch({ [MANIFEST_URL]: { body: bareCenc } });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== MANIFEST_URL) binaryRequests++;
      return base(input, init);
    }) as typeof fetch;
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toBeInstanceOf(DrmProtectedError);
    expect(binaryRequests).toBe(0);
  });

  it("rejects CENC found in init before requesting media segments", async () => {
    let mediaRequests = 0;
    const base = makeFetch({
      [MANIFEST_URL]: { body: MPD_VIDEO_ONLY },
      "https://cdn.example.com/v/vinit.m4s": { body: new Uint8Array([0xee]) },
      "https://cdn.example.com/v/v-1.m4s": { body: new Uint8Array([2]) },
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("v-1.m4s")) mediaRequests++;
      return base(input, init);
    }) as typeof fetch;
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toBeInstanceOf(DrmProtectedError);
    expect(mediaRequests).toBe(0);
  });

  it("rejects a multi-track DASH init before requesting media segments", async () => {
    let mediaRequests = 0;
    const base = makeFetch({
      [MANIFEST_URL]: { body: MPD_VIDEO_ONLY },
      "https://cdn.example.com/v/vinit.m4s": { body: new Uint8Array([0x02]) },
      "https://cdn.example.com/v/v-1.m4s": { body: new Uint8Array([3]) },
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("v-1.m4s")) mediaRequests++;
      return base(input, init);
    }) as typeof fetch;
    await expect(
      downloadDash(MANIFEST_URL, {
        signal: new AbortController().signal,
        sizeCapBytes: 1_000_000,
        fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaShapeError);
    expect(mediaRequests).toBe(0);
  });
});
