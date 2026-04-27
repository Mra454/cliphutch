import { describe, expect, it } from "vitest";
import { downloadDash } from "./dash-downloader";
import {
  AccessDeniedError,
  ByteRangeError,
  DrmProtectedError,
  EmptyManifestError,
  LiveStreamError,
  SizeCapError,
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
    expect(result.video.size).toBe(12);
    expect(result.audio?.size).toBe(6);
    expect(result.videoMimeType).toBe("video/mp4");
    expect(result.audioMimeType).toBe("audio/mp4");
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
    expect(result.video.size).toBe(2);
    expect(result.audio).toBeUndefined();
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
});
