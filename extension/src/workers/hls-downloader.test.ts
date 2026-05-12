import { describe, it, expect, vi } from "vitest";

// Synthetic byte fixtures aren't valid fMP4; stub the muxer with a
// deterministic concat-and-tag so the fMP4 test asserts on fetch +
// orchestration logic without depending on mp4box.js.
vi.mock("./dash-mux", () => ({
  muxFmp4: async (videoBytes: Uint8Array) => videoBytes,
}));

import { downloadHls } from "./hls-downloader";
import {
  AccessDeniedError,
  ByteRangeError,
  CancelledError,
  EncryptedStreamError,
  LiveStreamError,
  NetworkError,
  SeparateAudioError,
  SizeCapError,
} from "../lib/errors";

type FetchEntry = {
  body: string | Uint8Array;
  status?: number;
  delayMs?: number;
};

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

const BYTERANGE_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:2
#EXTINF:2.0,
#EXT-X-BYTERANGE:1000@0
seg0.ts
#EXT-X-ENDLIST
`;

const MASTER_EMBEDDED = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360
low.m3u8
`;

const MASTER_SEPARATE_AUDIO = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,URI="audio/playlist.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,AUDIO="audio"
video/playlist.m3u8
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

describe("downloadHls — happy path", () => {
  it("simple VOD: fetches segments, returns Blob with concatenated bytes", async () => {
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
    expect(blob.type).toBe("video/mp2t");
    expect(blob.size).toBe(SEG_BYTES.length * 2);
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

  it("rejects byte-range segments", async () => {
    const f = makeFetch({ "https://a/p.m3u8": { body: BYTERANGE_PLAYLIST } });
    await expect(
      downloadHls("https://a/p.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(ByteRangeError);
  });

  it("rejects master with only separate-audio variants", async () => {
    const f = makeFetch({
      "https://a/master.m3u8": { body: MASTER_SEPARATE_AUDIO },
    });
    await expect(
      downloadHls("https://a/master.m3u8", {
        onProgress: noProgress,
        signal: noSignal,
        sizeCapBytes: cap,
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(SeparateAudioError);
  });
});

describe("downloadHls — master variant selection", () => {
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
