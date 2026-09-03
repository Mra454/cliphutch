import { describe, expect, it, vi } from "vitest";
import {
  AccessDeniedError,
  CancelledError,
  DrmProtectedError,
  EncryptedStreamError,
  NetworkError,
  UnsupportedMediaShapeError,
} from "../lib/errors";
import {
  buildHlsCryptoPlan,
  createKeyCache,
  decryptAes128Cbc,
  ivForMap,
  ivForSegment,
  parseHexIv,
  type HlsSegmentCrypto,
} from "./hls-crypto-plan";

function hex(raw: string): Uint8Array {
  return Uint8Array.from(raw.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

async function importDecryptKey(raw: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    copiedArrayBuffer(raw),
    "AES-CBC",
    false,
    ["decrypt"],
  );
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function playlist(body: string): string {
  return `#EXTM3U\n${body}\n#EXT-X-ENDLIST\n`;
}

describe("HLS AES-128 golden vectors", () => {
  const keyBytes = hex("000102030405060708090a0b0c0d0e0f");

  it("decrypts a segment with its sequence-derived IV", async () => {
    const key = await importDecryptKey(keyBytes);
    const cipher = hex(
      "1e23540f5545ea67b465879db7a8d18e6b5a27ac3db35f3945d7fafa64bc607d" +
        "d584aa9679cec72d2e32d6ff9e32a930dac65bcfd0a5e3cf78b7bb56ce0432c1",
    );
    const plain = hex(
      "436c69704875746368204145532d31323820676f6c64656e20766563746f723a20" +
        "3437206279746573206f66207465787421",
    );
    const segment: HlsSegmentCrypto = { key: { method: "NONE" }, sequence: 7n };

    await expect(decryptAes128Cbc(key, ivForSegment(segment), cipher)).resolves.toEqual(plain);
  });

  it("decrypts an exact-block plaintext with an explicit IV", async () => {
    const key = await importDecryptKey(keyBytes);
    const cipher = hex(
      "bf87dd4d7a6fa22f43473eeeafe47fd27472f27d5b733d6b8f875706d546be77" +
        "13d9aa94a010817883a4144a9f62f89f",
    );
    const plain = hex("3031323334353637383961626364656630313233343536373839616263646566");
    const iv = parseHexIv("0x0102030405060708090a0b0c0d0e0f10");

    await expect(decryptAes128Cbc(key, iv, cipher)).resolves.toEqual(plain);
  });
});

describe("HLS AES-128 IV handling", () => {
  it("parses explicit IVs in big-endian byte order and rejects malformed values", () => {
    expect(Array.from(parseHexIv("0x000102030405060708090a0b0c0d0e0f"))).toEqual(
      Array.from({ length: 16 }, (_, index) => index),
    );
    expect(parseHexIv("0XABCDEF")).toEqual(parseHexIv("abcdef"));
    expect(Array.from(parseHexIv("0x1"))).toEqual([...new Array(15).fill(0), 1]);
    expect(() => parseHexIv("0x123456789012345678901234567890123")).toThrow(
      EncryptedStreamError,
    );
    expect(() => parseHexIv("0xzz")).toThrow(EncryptedStreamError);
  });

  it("preserves media sequences as BigInt and encodes them into segment IVs", () => {
    const plan = buildHlsCryptoPlan(
      playlist("#EXT-X-MEDIA-SEQUENCE:5\nzero.ts\none.ts\ntwo.ts"),
      "https://media.example.test/path/playlist.m3u8",
    );
    expect(Array.from(ivForSegment(plan.segments[2]))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7,
    ]);

    const wide = buildHlsCryptoPlan(
      playlist("#EXT-X-MEDIA-SEQUENCE:4294967296\nsegment.ts"),
      "https://media.example.test/playlist.m3u8",
    );
    expect(Array.from(ivForSegment(wide.segments[0]))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
    ]);

    const aboveSafeInteger = buildHlsCryptoPlan(
      playlist("#EXT-X-MEDIA-SEQUENCE:9007199254740993\nsegment.ts"),
      "https://media.example.test/playlist.m3u8",
    );
    expect(aboveSafeInteger.segments[0].sequence).toBe(9007199254740993n);
    expect(Array.from(ivForSegment(aboveSafeInteger.segments[0]))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0x20, 0, 0, 0, 0, 0, 1,
    ]);

    for (const raw of ["-1", "1.5"]) {
      expect(() =>
        buildHlsCryptoPlan(
          playlist(`#EXT-X-MEDIA-SEQUENCE:${raw}\nsegment.ts`),
          "https://media.example.test/playlist.m3u8",
        )
      ).toThrow(UnsupportedMediaShapeError);
    }
    expect(() =>
      ivForSegment({ key: { method: "NONE" }, sequence: 18446744073709551616n })
    ).toThrow(UnsupportedMediaShapeError);
  });
});

describe("buildHlsCryptoPlan", () => {
  it("rejects a later AES-128 key declaration that omits its URI", () => {
    expect(() =>
      buildHlsCryptoPlan(
        playlist(
          '#EXT-X-KEY:METHOD=AES-128,URI="first.key"\none.ts\n' +
            "#EXT-X-KEY:METHOD=AES-128\ntwo.ts",
        ),
        "https://media.example.test/path/playlist.m3u8",
      )
    ).toThrowError(/malformed key declaration/);
  });

  it("tracks key rotation and METHOD=NONE by segment", () => {
    const plan = buildHlsCryptoPlan(
      playlist(
        '#EXT-X-KEY:METHOD=AES-128,URI="a.key"\na.ts\n' +
          '#EXT-X-KEY:METHOD=AES-128,URI="b.key"\nb.ts\n' +
          "#EXT-X-KEY:METHOD=NONE\nclear.ts",
      ),
      "https://media.example.test/path/playlist.m3u8",
    );
    expect(plan.segments.map((segment) => segment.key)).toEqual([
      { method: "AES-128", keyUri: "https://media.example.test/path/a.key" },
      { method: "AES-128", keyUri: "https://media.example.test/path/b.key" },
      { method: "NONE" },
    ]);
  });

  it("separates unsupported encryption from DRM key formats", () => {
    expect(() =>
      buildHlsCryptoPlan(
        playlist('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="sample.key"\nsegment.ts'),
        "https://media.example.test/playlist.m3u8",
      )
    ).toThrow(EncryptedStreamError);
    expect(() =>
      buildHlsCryptoPlan(
        playlist(
          '#EXT-X-KEY:METHOD=AES-128,URI="widevine.key",KEYFORMAT="com.widevine.alpha"\nsegment.ts',
        ),
        "https://media.example.test/playlist.m3u8",
      )
    ).toThrow(DrmProtectedError);
    expect(
      buildHlsCryptoPlan(
        playlist(
          '#EXT-X-KEY:METHOD=AES-128,URI="identity.key",KEYFORMAT="identity"\nsegment.ts',
        ),
        "https://media.example.test/playlist.m3u8",
      ).segments[0].key,
    ).toMatchObject({ method: "AES-128" });
  });

  it("freezes a map's key context separately from the media segment key", () => {
    const plan = buildHlsCryptoPlan(
      playlist(
        '#EXT-X-KEY:METHOD=AES-128,URI="a.key",IV=0x01\n' +
          '#EXT-X-MAP:URI="init.mp4"\n' +
          '#EXT-X-KEY:METHOD=AES-128,URI="b.key",IV=0x02\nsegment.m4s',
      ),
      "https://media.example.test/playlist.m3u8",
    );
    expect(plan.segments[0].mapKey).toMatchObject({
      method: "AES-128",
      keyUri: "https://media.example.test/a.key",
    });
    expect(plan.segments[0].key).toMatchObject({
      method: "AES-128",
      keyUri: "https://media.example.test/b.key",
    });
    expect(ivForMap(plan.segments[0])).toEqual(parseHexIv("0x01"));

    expect(() =>
      buildHlsCryptoPlan(
        playlist(
          '#EXT-X-KEY:METHOD=AES-128,URI="a.key"\n' +
            '#EXT-X-MAP:URI="init.mp4"\nsegment.m4s',
        ),
        "https://media.example.test/playlist.m3u8",
      )
    ).toThrowError(/encrypted initialization section without IV/);
  });

  it("marks I-frame-only playlists and ignores session keys", () => {
    const plan = buildHlsCryptoPlan(
      playlist(
        '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="never-fetch.key"\n' +
          "#EXT-X-I-FRAMES-ONLY\nsegment.ts",
      ),
      "https://media.example.test/playlist.m3u8",
    );
    expect(plan.iFramesOnly).toBe(true);
    expect(plan.segments[0].key).toEqual({ method: "NONE" });
  });

  it("resolves relative key URIs and preserves absolute signed URLs", () => {
    const plan = buildHlsCryptoPlan(
      playlist(
        '#EXT-X-KEY:METHOD=AES-128,URI="keys/a.key?token=one,two"\na.ts\n' +
          '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.test/b.key?token=three"\nb.ts',
      ),
      "https://media.example.test/path/playlist.m3u8?playlist=four",
    );
    expect(plan.segments.map((segment) =>
      segment.key.method === "AES-128" ? segment.key.keyUri : undefined
    )).toEqual([
      "https://media.example.test/path/keys/a.key?token=one,two",
      "https://keys.example.test/b.key?token=three",
    ]);
  });
});

describe("decryptAes128Cbc", () => {
  it("maps invalid lengths and bad padding to EncryptedStreamError", async () => {
    const key = await importDecryptKey(hex("000102030405060708090a0b0c0d0e0f"));
    const iv = ivForSegment({ key: { method: "NONE" }, sequence: 7n });
    await expect(decryptAes128Cbc(key, iv, new Uint8Array())).rejects.toBeInstanceOf(
      EncryptedStreamError,
    );
    await expect(decryptAes128Cbc(key, iv, new Uint8Array(20))).rejects.toBeInstanceOf(
      EncryptedStreamError,
    );

    const cipher = hex(
      "1e23540f5545ea67b465879db7a8d18e6b5a27ac3db35f3945d7fafa64bc607d" +
        "d584aa9679cec72d2e32d6ff9e32a930dac65bcfd0a5e3cf78b7bb56ce0432c1",
    );
    cipher[cipher.length - 1] ^= 0xff;
    await expect(decryptAes128Cbc(key, iv, cipher)).rejects.toBeInstanceOf(
      EncryptedStreamError,
    );
  });
});

describe("createKeyCache", () => {
  it("deduplicates an in-flight key request by exact URL", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array(16) as unknown as BodyInit)
    );
    const cache = createKeyCache(fetchMock as unknown as typeof fetch, new AbortController().signal);

    const [first, second] = await Promise.all([
      cache.getKey("https://keys.example.test/key?token=one"),
      cache.getKey("https://keys.example.test/key?token=one"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledWith("https://keys.example.test/key?token=one", {
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects a declared oversized key before reading its body", async () => {
    let bodyRead = false;
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "32" }),
      get body() {
        bodyRead = true;
        return null;
      },
      arrayBuffer: async () => new Uint8Array(32).buffer,
    } as unknown as Response;
    const cache = createKeyCache((async () => response) as typeof fetch, noSignal());

    await expect(cache.getKey("https://keys.example.test/key")).rejects.toBeInstanceOf(
      EncryptedStreamError,
    );
    expect(bodyRead).toBe(false);
  });

  it("caps streamed bodies at 17 bytes and requires exactly 16", async () => {
    let cancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(17));
      },
      cancel() {
        cancelled = true;
      },
    });
    const oversized = createKeyCache(
      (async () => new Response(oversizedBody)) as typeof fetch,
      noSignal(),
    );
    await expect(oversized.getKey("https://keys.example.test/large")).rejects.toBeInstanceOf(
      EncryptedStreamError,
    );
    expect(cancelled).toBe(true);

    const short = createKeyCache(
      (async () =>
        new Response(new Uint8Array(15) as unknown as BodyInit)) as typeof fetch,
      noSignal(),
    );
    await expect(short.getKey("https://keys.example.test/short")).rejects.toBeInstanceOf(
      EncryptedStreamError,
    );
  });

  it("maps key HTTP failures", async () => {
    const forbidden = createKeyCache(
      (async () => new Response("", { status: 403 })) as typeof fetch,
      noSignal(),
    );
    await expect(forbidden.getKey("https://keys.example.test/forbidden")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );

    const failed = createKeyCache(
      (async () => new Response("", { status: 500 })) as typeof fetch,
      noSignal(),
    );
    await expect(failed.getKey("https://keys.example.test/failed")).rejects.toBeInstanceOf(
      EncryptedStreamError,
    );

  });

  it("normalizes thrown fetch errors and handles an unobserved cached rejection", async () => {
    const controller = new AbortController();
    const abortFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      })
    );
    const aborted = createKeyCache(
      abortFetch as unknown as typeof fetch,
      controller.signal,
    ).getKey("https://keys.example.test/abort");
    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(CancelledError);
    expect(abortFetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    const failed = createKeyCache(
      (async () => { throw new TypeError("socket failed"); }) as typeof fetch,
      noSignal(),
    );
    await expect(failed.getKey("https://keys.example.test/network")).rejects.toBeInstanceOf(
      NetworkError,
    );

    let unhandled = false;
    const onUnhandled = () => { unhandled = true; };
    process.once("unhandledRejection", onUnhandled);
    try {
      void createKeyCache(
        (async () => new Response("", { status: 403 })) as typeof fetch,
        noSignal(),
      ).getKey("https://keys.example.test/unobserved");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toBe(false);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("normalizes body-phase cancellation without remapping key response errors", async () => {
    const controller = new AbortController();
    const stalledBody = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller.signal.addEventListener(
          "abort",
          () => streamController.error(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      },
    });
    const stalled = createKeyCache(
      (async () => new Response(stalledBody)) as typeof fetch,
      controller.signal,
    ).getKey("https://keys.example.test/stalled");
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(stalled).rejects.toBeInstanceOf(CancelledError);

    const oversized = createKeyCache(
      (async () => new Response(new Uint8Array(17) as unknown as BodyInit)) as typeof fetch,
      noSignal(),
    );
    await expect(oversized.getKey("https://keys.example.test/oversized")).rejects.toThrow(
      /unexpected key size/,
    );
    await expect(oversized.getKey("https://keys.example.test/oversized")).rejects.toBeInstanceOf(
      EncryptedStreamError,
    );

    const forbidden = createKeyCache(
      (async () => new Response("", { status: 403 })) as typeof fetch,
      noSignal(),
    );
    await expect(forbidden.getKey("https://keys.example.test/forbidden-body-test")).rejects
      .toBeInstanceOf(AccessDeniedError);
  });
});

describe("EncryptedStreamError", () => {
  it("uses the generic unsupported-method message and appends optional detail", () => {
    expect(new EncryptedStreamError().userMessage).toBe(
      "This stream uses an encryption method ClipHutch does not support.",
    );
    expect(new EncryptedStreamError("malformed IV").userMessage).toBe(
      "This stream uses an encryption method ClipHutch does not support (malformed IV).",
    );
  });
});

function noSignal(): AbortSignal {
  return new AbortController().signal;
}
