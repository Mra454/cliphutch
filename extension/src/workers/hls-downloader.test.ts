import { describe, it, expect, vi } from "vitest";

// Synthetic byte fixtures aren't valid fMP4; stub the muxer with a
// deterministic concat-and-tag so the fMP4 test asserts on fetch +
// orchestration logic without depending on mp4box.js.
vi.mock("./dash-mux", () => ({
  inspectFmp4Init: (bytes: Uint8Array) => ({
    encrypted: bytes[0] === 0xee,
    trackCount: bytes[0] === 0x02 ? 2 : 1,
    trackTypes: [bytes[0] === 0x61 ? "audio" : "video"],
  }),
  muxFmp4: async (videoBytes: Uint8Array) => videoBytes,
}));

vi.mock("./ts-audio-to-fmp4", () => ({
  transmuxTsAudioToFmp4: vi.fn(() => new Uint8Array([0x61, 0x75, 0x64, 0x69, 0x6f])),
  transmuxTsToMp4: vi.fn((segments: Uint8Array[]) => {
    const total = segments.reduce((sum, seg) => sum + seg.length, 0);
    return new Uint8Array(total);
  }),
}));

import { downloadHls } from "./hls-downloader";
import { HLS_SEGMENT_FETCH_CONCURRENCY } from "../lib/constants";
import { transmuxTsAudioToFmp4, transmuxTsToMp4 } from "./ts-audio-to-fmp4";
import {
  AccessDeniedError,
  ByteRangeOutOfBoundsError,
  ByteRangeUnsupportedError,
  CancelledError,
  DrmProtectedError,
  EmptyManifestError,
  EncryptedStreamError,
  LiveStreamError,
  NetworkError,
  SizeCapError,
  UnsupportedMediaShapeError,
  VariantStaleError,
} from "../lib/errors";

type FetchEntry = {
  body: string | Uint8Array;
  status?: number;
  delayMs?: number;
  // When set, override how the mock responds to a Range request:
  //   "ignore-range": return full body with 200 (server ignored Range).
  //   "out-of-bounds": return 416.
  // Default: slice the body by the request's Range header and return 206.
  rangeBehavior?: "ignore-range" | "out-of-bounds";
};

function parseRange(header: string | null): { start: number; end: number } | null {
  if (!header) return null;
  const m = header.match(/bytes=(\d+)-(\d+)/);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]) };
}

function makeFetch(map: Record<string, FetchEntry>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const entry = map[url];
    if (!entry) {
      return new Response("", { status: 404 });
    }
    if (entry.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, entry.delayMs);
        if (init?.signal) {
          init.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }
      });
    }
    if (entry.status && entry.status >= 400) {
      return new Response("", { status: entry.status });
    }

    // Honor Range headers: if the caller sent Range and the entry body is
    // bytes, slice the body and return 206. The rangeBehavior flag overrides
    // this for testing server-side anomalies.
    const headers =
      init?.headers instanceof Headers
        ? init.headers
        : new Headers(init?.headers as Record<string, string> | undefined);
    const rangeHeader = headers.get("Range");
    if (rangeHeader && entry.body instanceof Uint8Array) {
      if (entry.rangeBehavior === "out-of-bounds") {
        return new Response("", { status: 416 });
      }
      if (entry.rangeBehavior === "ignore-range") {
        return new Response(entry.body as unknown as BodyInit, { status: 200 });
      }
      const range = parseRange(rangeHeader);
      if (range) {
        const slice = entry.body.slice(range.start, range.end + 1);
        return new Response(slice as unknown as BodyInit, { status: 206 });
      }
    }

    if (typeof entry.body === "string") {
      return new Response(entry.body, { status: entry.status ?? 200 });
    }
    return new Response(entry.body as unknown as BodyInit, { status: entry.status ?? 200 });
  }) as typeof fetch;
}

const SIMPLE_VOD = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXTINF:2.0,
seg0.ts
#EXTINF:2.0,
seg1.ts
#EXT-X-ENDLIST
`;

const LIVE_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXTINF:2.0,
seg0.ts
`;

const ENCRYPTED_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:2.0,
seg0.ts
#EXT-X-ENDLIST
`;

const FMP4_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2.0,
seg0.m4s
#EXT-X-ENDLIST
`;

const MASTER_EMBEDDED = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360
low.m3u8
`;

const HIGH_VARIANT = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXTINF:2.0,
hseg0.ts
#EXTINF:2.0,
hseg1.ts
#EXT-X-ENDLIST
`;

const SEG_BYTES = new Uint8Array([0x47, 0x40, 0x00, 0x10]);

const noProgress = () => undefined;
const noSignal = new AbortController().signal;
const cap = 100 * 1024 * 1024;

describe("downloadHls — failure aborts the segment pool", () => {
  it("stops fetching remaining segments once one fails", async () => {
    const SEG_COUNT = 12;
    let playlist =
      "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:2\n";
    const map: Record<string, FetchEntry> = {};
    for (let i = 0; i < SEG_COUNT; i++) {
      playlist += `#EXTINF:2.0,\nseg${i}.ts\n`;
      // seg0 fails immediately; the rest are slow so, without a pool abort,
      // sibling workers would keep pulling and fetching all of them.
      map[`https://a/seg${i}.ts`] =
        i === 0 ? { body: "", status: 500 } : { body: SEG_BYTES, delayMs: 20 };
    }
    playlist += "#EXT-X-ENDLIST\n";
    map["https://a/p.m3u8"] = { body: playlist };

    let started = 0;
    const base = makeFetch(map);
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (/seg\d+\.ts$/.test(url)) started++;
      return base(input, init);
    }) as typeof fetch;

    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: new AbortController().signal,
        sizeCapBytes: cap,
        fetchImpl: counting,
      }),
    ).rejects.toBeInstanceOf(NetworkError);

    // Let any un-aborted siblings keep pulling indices. With the pool abort
    // only the initial concurrent batch ever starts; without it this reaches
    // SEG_COUNT.
    await new Promise((r) => setTimeout(r, 150));
    expect(started).toBeLessThanOrEqual(HLS_SEGMENT_FETCH_CONCURRENCY);
  });
});

describe("downloadHls — happy path", () => {
  it("simple VOD: fetches segments, transmuxes MPEG-TS, returns MP4 Blob", async () => {
    const f = makeFetch({
      "https://a/p.m3u8": { body: SIMPLE_VOD },
      "https://a/seg0.ts": { body: SEG_BYTES },
      "https://a/seg1.ts": { body: SEG_BYTES },
    });
    const blob = await downloadHls("https://a/p.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
    });
    expect(blob.type).toBe("video/mp4");
    expect(blob.size).toBe(SEG_BYTES.length * 2);
    expect(transmuxTsToMp4).toHaveBeenCalledWith([SEG_BYTES, SEG_BYTES]);
  });

  it("fMP4 VOD: fetches init + segments, muxes, returns video/mp4 Blob", async () => {
    const INIT_BYTES = new Uint8Array([0x66, 0x74, 0x79, 0x70]);
    const SEG_M4S = new Uint8Array([0x6d, 0x6f, 0x6f, 0x66]);
    const f = makeFetch({
      "https://a/p.m3u8": { body: FMP4_PLAYLIST },
      "https://a/init.mp4": { body: INIT_BYTES },
      "https://a/seg0.m4s": { body: SEG_M4S },
    });
    const blob = await downloadHls("https://a/p.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
    });
    expect(blob.type).toBe("video/mp4");
    // Mocked muxFmp4 is identity → init + segments concatenated.
    expect(blob.size).toBe(INIT_BYTES.length + SEG_M4S.length);
  });

  it("calls onProgress for each segment", async () => {
    const f = makeFetch({
      "https://a/p.m3u8": { body: SIMPLE_VOD },
      "https://a/seg0.ts": { body: SEG_BYTES },
      "https://a/seg1.ts": { body: SEG_BYTES },
    });
    const progress = vi.fn();
    await downloadHls("https://a/p.m3u8", {
      onProgress: progress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
    });
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls[1][0]).toEqual({ done: 2, total: 2, bytes: 8 });
  });
});

describe("downloadHls — rejection rules", () => {
  it("rejects live stream (no EXT-X-ENDLIST)", async () => {
    const f = makeFetch({ "https://a/p.m3u8": { body: LIVE_PLAYLIST } });
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(LiveStreamError);
  });

  it("rejects encrypted stream (EXT-X-KEY METHOD=AES-128)", async () => {
    const f = makeFetch({ "https://a/p.m3u8": { body: ENCRYPTED_PLAYLIST } });
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(EncryptedStreamError);
  });

  it("rejects an empty VOD before muxing", async () => {
    const empty = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-ENDLIST
`;
    const f = makeFetch({ "https://a/p.m3u8": { body: empty } });
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(EmptyManifestError);
  });

  it("rejects HLS discontinuities before requesting init or media", async () => {
    const playlist = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2,
s0.m4s
#EXT-X-DISCONTINUITY
#EXTINF:2,
s1.m4s
#EXT-X-ENDLIST
`;
    let binaryRequests = 0;
    const base = makeFetch({ "https://a/p.m3u8": { body: playlist } });
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== "https://a/p.m3u8") binaryRequests++;
      return base(input, init);
    }) as typeof fetch;
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaShapeError);
    expect(binaryRequests).toBe(0);
  });

  it("rejects changed HLS init maps before requesting init or media", async () => {
    const playlist = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init-1.mp4"
#EXTINF:2,
s0.m4s
#EXT-X-MAP:URI="init-2.mp4"
#EXTINF:2,
s1.m4s
#EXT-X-ENDLIST
`;
    let binaryRequests = 0;
    const base = makeFetch({ "https://a/p.m3u8": { body: playlist } });
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== "https://a/p.m3u8") binaryRequests++;
      return base(input, init);
    }) as typeof fetch;
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaShapeError);
    expect(binaryRequests).toBe(0);
  });

  it("rejects encrypted fMP4 init before requesting media", async () => {
    let mediaRequests = 0;
    const base = makeFetch({
      "https://a/p.m3u8": { body: FMP4_PLAYLIST },
      "https://a/init.mp4": { body: new Uint8Array([0xee]) },
      "https://a/seg0.m4s": { body: new Uint8Array([1]) },
    });
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("seg0.m4s")) mediaRequests++;
      return base(input, init);
    }) as typeof fetch;
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(DrmProtectedError);
    expect(mediaRequests).toBe(0);
  });

  it("rejects embedded multi-track fMP4 init before requesting media", async () => {
    let mediaRequests = 0;
    const base = makeFetch({
      "https://a/p.m3u8": { body: FMP4_PLAYLIST },
      "https://a/init.mp4": { body: new Uint8Array([0x02]) },
      "https://a/seg0.m4s": { body: new Uint8Array([1]) },
    });
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("seg0.m4s")) mediaRequests++;
      return base(input, init);
    }) as typeof fetch;
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaShapeError);
    expect(mediaRequests).toBe(0);
  });

  it("transmuxes MPEG-TS separate audio before muxing with fMP4 video", async () => {
    const INIT = new Uint8Array([0x66, 0x74, 0x79, 0x70]);
    const SEG = new Uint8Array([0x6d, 0x6f, 0x6f, 0x66]);
    // Video is fMP4, audio rendition is MPEG-TS (no EXT-X-MAP).
    const SEPARATE_AUDIO_MIXED = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,AUDIO="aac"
video.m3u8
`;
    const VIDEO_FMP4 = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-MAP:URI="vinit.mp4"
#EXTINF:2.0,
v0.m4s
#EXT-X-ENDLIST
`;
    const AUDIO_TS = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXTINF:2.0,
a0.ts
#EXT-X-ENDLIST
`;
    const f = makeFetch({
      "https://a/master.m3u8": { body: SEPARATE_AUDIO_MIXED },
      "https://a/video.m3u8": { body: VIDEO_FMP4 },
      "https://a/audio.m3u8": { body: AUDIO_TS },
      "https://a/vinit.mp4": { body: INIT },
      "https://a/v0.m4s": { body: SEG },
      "https://a/a0.ts": { body: SEG },
    });
    const blob = await downloadHls("https://a/master.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
    });

    expect(blob.type).toBe("video/mp4");
    expect(transmuxTsAudioToFmp4).toHaveBeenCalledWith([SEG]);
  });
});

describe("downloadHls — byte-range segments (Apple single-file CMAF shape)", () => {
  // Apple's advanced fMP4 stream uses a single main.mp4 file with the init
  // box at the head (delimited by EXT-X-MAP BYTERANGE) and media samples
  // spread across the rest of the file (each segment is a slice).
  //
  // Synthetic file: 64 bytes total. Init = bytes 0..7 (8). Seg0 = bytes
  // 8..23 (16). Seg1 = bytes 24..39 (16, implicit offset). Seg2 = bytes
  // 40..55 (16, implicit offset).
  const MAIN_BYTES = new Uint8Array(64);
  for (let i = 0; i < 64; i++) MAIN_BYTES[i] = i;

  const SINGLE_FILE_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-MAP:URI="main.mp4",BYTERANGE="8@0"
#EXTINF:2.0,
#EXT-X-BYTERANGE:16@8
main.mp4
#EXTINF:2.0,
#EXT-X-BYTERANGE:16
main.mp4
#EXTINF:2.0,
#EXT-X-BYTERANGE:16
main.mp4
#EXT-X-ENDLIST
`;

  it("downloads init + range-sliced segments, muxes to video/mp4", async () => {
    const f = makeFetch({
      "https://a/p.m3u8": { body: SINGLE_FILE_PLAYLIST },
      "https://a/main.mp4": { body: MAIN_BYTES },
    });
    const blob = await downloadHls("https://a/p.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
    });
    expect(blob.type).toBe("video/mp4");
    // Mocked muxFmp4 is identity: blob bytes = init(8) + 3 segs (16 each).
    expect(blob.size).toBe(8 + 16 * 3);
  });

  it("implicit offsets resolve to consecutive ranges", async () => {
    // Capture every Range header the implementation sends.
    const ranges: string[] = [];
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers(init?.headers as Record<string, string> | undefined);
      const r = headers.get("Range");
      if (r) ranges.push(r);
      return (makeFetch({
        "https://a/p.m3u8": { body: SINGLE_FILE_PLAYLIST },
        "https://a/main.mp4": { body: MAIN_BYTES },
      }) as typeof fetch)(input, init);
    }) as typeof fetch;
    await downloadHls("https://a/p.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: wrapped,
    });
    // Init (8@0) + seg0 (16@8) + seg1 (16@24, implicit) + seg2 (16@40, implicit)
    expect(ranges).toEqual([
      "bytes=0-7",
      "bytes=8-23",
      "bytes=24-39",
      "bytes=40-55",
    ]);
  });

  it("server returns 200 to Range request → ByteRangeUnsupportedError", async () => {
    const f = makeFetch({
      "https://a/p.m3u8": { body: SINGLE_FILE_PLAYLIST },
      "https://a/main.mp4": { body: MAIN_BYTES, rangeBehavior: "ignore-range" },
    });
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(ByteRangeUnsupportedError);
  });

  it("server returns 416 → ByteRangeOutOfBoundsError", async () => {
    const f = makeFetch({
      "https://a/p.m3u8": { body: SINGLE_FILE_PLAYLIST },
      "https://a/main.mp4": { body: MAIN_BYTES, rangeBehavior: "out-of-bounds" },
    });
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(ByteRangeOutOfBoundsError);
  });
});

describe("downloadHls — separate-audio fMP4 + fMP4", () => {
  const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,AUDIO="aac"
video.m3u8
`;
  const VIDEO = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-MAP:URI="vinit.mp4"
#EXTINF:2.0,
v0.m4s
#EXTINF:2.0,
v1.m4s
#EXT-X-ENDLIST
`;
  const AUDIO = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXT-X-MAP:URI="ainit.mp4"
#EXTINF:2.0,
a0.m4s
#EXTINF:2.0,
a1.m4s
#EXT-X-ENDLIST
`;
  const V_INIT = new Uint8Array([0x76, 0x69, 0x76, 0x69]); // 4 B
  const V_SEG = new Uint8Array([0x76, 0x73, 0x76, 0x73, 0x76, 0x73]); // 6 B
  const A_INIT = new Uint8Array([0x61, 0x69]); // 2 B
  const A_SEG = new Uint8Array([0x61, 0x73, 0x61, 0x73]); // 4 B

  const f = makeFetch({
    "https://a/master.m3u8": { body: MASTER },
    "https://a/video.m3u8": { body: VIDEO },
    "https://a/audio.m3u8": { body: AUDIO },
    "https://a/vinit.mp4": { body: V_INIT },
    "https://a/v0.m4s": { body: V_SEG },
    "https://a/v1.m4s": { body: V_SEG },
    "https://a/ainit.mp4": { body: A_INIT },
    "https://a/a0.m4s": { body: A_SEG },
    "https://a/a1.m4s": { body: A_SEG },
  });

  it("fetches video + audio in parallel, mux returns video/mp4", async () => {
    const blob = await downloadHls("https://a/master.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
    });
    expect(blob.type).toBe("video/mp4");
    // Mocked muxFmp4 is identity on the first arg; video bytes = V_INIT + 2×V_SEG.
    expect(blob.size).toBe(V_INIT.length + V_SEG.length * 2);
  });

  it("emits combined progress for video + audio segments", async () => {
    const progress = vi.fn();
    await downloadHls("https://a/master.m3u8", {
      onProgress: progress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
    });
    // Last call should report all 4 media segments done.
    const last = progress.mock.calls[progress.mock.calls.length - 1][0];
    expect(last.done).toBe(4);
    expect(last.total).toBe(4);
    expect(last.bytes).toBe(
      V_INIT.length + A_INIT.length + V_SEG.length * 2 + A_SEG.length * 2,
    );
  });

  it("honors caller-supplied audioUrl (overrides DEFAULT rendition)", async () => {
    const blob = await downloadHls("https://a/master.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
      audioUrl: "https://a/audio.m3u8",
    });
    expect(blob.type).toBe("video/mp4");
  });
});

describe("downloadHls — master variant selection", () => {
  it("never auto-picks when an exact selection omits its child identity", async () => {
    const f = vi.fn(makeFetch({
      "https://a/master.m3u8": { body: MASTER_EMBEDDED },
    }));
    await expect(downloadHls("https://a/master.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
      exactVariantSelection: true,
    })).rejects.toBeInstanceOf(VariantStaleError);
    expect(f).not.toHaveBeenCalled();
  });

  it("picks highest-bandwidth embedded-audio variant", async () => {
    const f = makeFetch({
      "https://a/master.m3u8": { body: MASTER_EMBEDDED },
      "https://a/high.m3u8": { body: HIGH_VARIANT },
      "https://a/hseg0.ts": { body: SEG_BYTES },
      "https://a/hseg1.ts": { body: SEG_BYTES },
    });
    const blob = await downloadHls("https://a/master.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
    });
    expect(blob.size).toBe(SEG_BYTES.length * 2);
  });

  it("rejects a supplied child URL that the fresh master does not name", async () => {
    const f = vi.fn(makeFetch({
      "https://a/master.m3u8": { body: MASTER_EMBEDDED },
      "https://attacker.example/forged.m3u8": { body: HIGH_VARIANT },
    }));
    await expect(downloadHls("https://a/master.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
      variantUrl: "https://attacker.example/forged.m3u8",
    })).rejects.toBeInstanceOf(VariantStaleError);
    expect(f).not.toHaveBeenCalledWith(
      "https://attacker.example/forged.m3u8",
      expect.anything(),
    );
  });

  it("rejects a selected master child when the root drifts to an implicit media playlist", async () => {
    const f = vi.fn(makeFetch({
      "https://a/master.m3u8": { body: SIMPLE_VOD },
      "https://a/seg0.ts": { body: SEG_BYTES },
      "https://a/seg1.ts": { body: SEG_BYTES },
    }));
    await expect(downloadHls("https://a/master.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
      variantUrl: "https://a/selected-child.m3u8",
      exactVariantSelection: true,
    })).rejects.toBeInstanceOf(VariantStaleError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("binds the exact default-audio rendition when entries share one video URL", async () => {
    const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="A",DEFAULT=YES,URI="audio-a/audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="b",NAME="B",DEFAULT=YES,URI="audio-b/audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="a"
video/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="b"
video/video.m3u8
`;
    const f = vi.fn(makeFetch({
      "https://a/master.m3u8": { body: master },
      "https://a/video/video.m3u8": { body: FMP4_PLAYLIST },
      "https://a/video/init.mp4": { body: new Uint8Array([0x76]) },
      "https://a/video/seg0.m4s": { body: SEG_BYTES },
      "https://a/audio-b/audio.m3u8": { body: FMP4_PLAYLIST },
      "https://a/audio-b/init.mp4": { body: new Uint8Array([0x61]) },
      "https://a/audio-b/seg0.m4s": { body: SEG_BYTES },
    }));

    await expect(downloadHls("https://a/master.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
      variantUrl: "https://a/video/video.m3u8",
      audioUrl: "https://a/audio-b/audio.m3u8",
      exactVariantSelection: true,
    })).resolves.toMatchObject({ type: "video/mp4" });
    expect(f).toHaveBeenCalledWith(
      "https://a/audio-b/audio.m3u8",
      expect.anything(),
    );
    expect(f).not.toHaveBeenCalledWith(
      "https://a/audio-a/audio.m3u8",
      expect.anything(),
    );
  });
});

describe("downloadHls — size cap", () => {
  it("rejects pre-flight when bandwidth-based estimate exceeds cap", async () => {
    const f = makeFetch({ "https://a/p.m3u8": { body: SIMPLE_VOD } });
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: 1,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(SizeCapError);
  });

  it("rejects mid-fetch when running bytes exceed cap", async () => {
    const big = new Uint8Array(1024);
    const f = makeFetch({
      "https://a/p.m3u8": { body: SIMPLE_VOD },
      "https://a/seg0.ts": { body: big },
      "https://a/seg1.ts": { body: big },
    });
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: 1500,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(SizeCapError);
  });
});

describe("downloadHls — network errors", () => {
  it("401 → AccessDeniedError", async () => {
    const f = makeFetch({
      "https://a/p.m3u8": { body: "", status: 401 },
    });
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("403 on segment → AccessDeniedError", async () => {
    const f = makeFetch({
      "https://a/p.m3u8": { body: SIMPLE_VOD },
      "https://a/seg0.ts": { body: "", status: 403 },
      "https://a/seg1.ts": { body: SEG_BYTES },
    });
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("500 on playlist → NetworkError", async () => {
    const f = makeFetch({ "https://a/p.m3u8": { body: "", status: 500 } });
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("downloadHls — cancellation", () => {
  it("AbortController cancels in-flight fetch with CancelledError", async () => {
    const ctrl = new AbortController();
    const f = makeFetch({
      "https://a/p.m3u8": { body: SIMPLE_VOD },
      "https://a/seg0.ts": { body: SEG_BYTES, delayMs: 100 },
      "https://a/seg1.ts": { body: SEG_BYTES, delayMs: 100 },
    });
    const promise = downloadHls("https://a/p.m3u8", {
      onProgress: noProgress,
      signal: ctrl.signal,
      sizeCapBytes: cap,
      fetchImpl: f,
    });
    setTimeout(() => ctrl.abort(), 20);
    await expect(promise).rejects.toBeInstanceOf(CancelledError);
  });

  it("aborts before first fetch returns CancelledError", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const f = makeFetch({ "https://a/p.m3u8": { body: SIMPLE_VOD } });
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: ctrl.signal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
  });
});

describe("downloadHls — URL resolution", () => {
  it("resolves relative segment URLs against playlist URL", async () => {
    const f = makeFetch({
      "https://a/path/p.m3u8": { body: SIMPLE_VOD },
      "https://a/path/seg0.ts": { body: SEG_BYTES },
      "https://a/path/seg1.ts": { body: SEG_BYTES },
    });
    const blob = await downloadHls("https://a/path/p.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
    });
    expect(blob.size).toBe(SEG_BYTES.length * 2);
  });

  it("preserves absolute segment URLs", async () => {
    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXTINF:2.0,
https://other/seg0.ts
#EXT-X-ENDLIST
`;
    const f = makeFetch({
      "https://a/p.m3u8": { body: playlist },
      "https://other/seg0.ts": { body: SEG_BYTES },
    });
    const blob = await downloadHls("https://a/p.m3u8", {
      onProgress: noProgress,
      signal: noSignal,
      sizeCapBytes: cap,
      fetchImpl: f,
    });
    expect(blob.size).toBe(SEG_BYTES.length);
  });
});
