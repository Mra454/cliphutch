import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureVariantInspectMessageV1 } from "./offscreen-attempts";
import {
  StreamVariantFetchRuntimeV1,
  STREAM_VARIANT_HTTP_CONCURRENCY,
} from "./stream-variant-fetch";

const TS_VOD = `#EXTM3U
#EXTINF:1,
one.ts
#EXTINF:1,
two.ts
#EXT-X-ENDLIST
`;

const FMP4_VOD = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1,
one.m4s
#EXTINF:1,
two.m4s
#EXT-X-ENDLIST
`;

function request(
  overrides: Partial<CaptureVariantInspectMessageV1> = {},
): CaptureVariantInspectMessageV1 {
  return {
    type: "capture-variant-inspect",
    requestId: "request-1",
    reviewId: "review-1",
    url: "https://cdn.example.test/master.m3u8",
    kind: "hls",
    deadlineAt: Date.now() + 10_000,
    ...overrides,
  };
}

function response(text: string, init?: ResponseInit): Response {
  return new Response(text, { status: 200, ...init });
}

function executionSnapshotId(index: number): string {
  return `execution-snapshot-v1:123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`;
}

function dashMpd(options: {
  type?: "static" | "dynamic";
  mimeType?: string;
  protection?: string;
} = {}): string {
  const type = options.type ?? "static";
  const mimeType = options.mimeType ?? "video/mp4";
  return `<?xml version="1.0"?>
<MPD type="${type}" mediaPresentationDuration="PT2S">
  <Period duration="PT2S">
    <AdaptationSet contentType="video" mimeType="${mimeType}">
      <Representation id="video-main" bandwidth="1000000" width="1280" height="720">
        ${options.protection ?? ""}
        <SegmentTemplate timescale="1" duration="1" startNumber="1" initialization="init.mp4" media="seg-$Number$.m4s"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamVariantFetchRuntimeV1 HTTP bounds", () => {
  it("invokes a captured native-style fetch without a runtime receiver", async () => {
    const receivers: unknown[] = [];
    const fetchImpl = function (
      this: unknown,
      _input: RequestInfo | URL,
    ): Promise<Response> {
      receivers.push(this);
      if (this !== undefined) {
        return Promise.reject(new TypeError("Illegal invocation"));
      }
      return Promise.resolve(response(TS_VOD));
    } as typeof fetch;
    const runtime = new StreamVariantFetchRuntimeV1({ fetchImpl });

    await expect(runtime.inspect(request())).resolves.toMatchObject({ ok: true });
    expect(receivers).toEqual([undefined]);
  });

  it("enforces one global maximum of three HTTP requests", async () => {
    let active = 0;
    let maximum = 0;
    const pending: Array<() => void> = [];
    const fetchMock = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => pending.push(resolve));
      active -= 1;
      return response(TS_VOD);
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const runtime = new StreamVariantFetchRuntimeV1({ fetchImpl });
    const deadlineAt = Date.now() + 10_000;
    const inspections = Array.from({ length: 6 }, (_, index) =>
      runtime.inspect(request({
        requestId: `request-${index}`,
        reviewId: `review-${index}`,
        url: `https://cdn.example.test/${index}.m3u8`,
        deadlineAt,
      })),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(maximum).toBe(STREAM_VARIANT_HTTP_CONCURRENCY);
    while (pending.length > 0 || fetchMock.mock.calls.length < inspections.length) {
      pending.splice(0).forEach((resolve) => resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await expect(Promise.all(inspections)).resolves.toSatisfy(
      (results: Array<{ ok: boolean }>) => results.every((result) => result.ok),
    );
    expect(maximum).toBe(3);
  });

  it("uses the absolute review deadline while a fetch is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchImpl = vi.fn(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;
    const runtime = new StreamVariantFetchRuntimeV1({ fetchImpl });
    const inspection = runtime.inspect(request({ deadlineAt: 1_050 }));
    await vi.advanceTimersByTimeAsync(51);
    await expect(inspection).resolves.toEqual({
      ok: false,
      code: "DEADLINE_EXCEEDED",
    });
  });

  it("enforces per-response and shared aggregate review byte caps", async () => {
    const oversized = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async () => response("x".repeat(65))) as typeof fetch,
      limits: { responseBytes: 64, reviewBytes: 100 },
    });
    await expect(oversized.inspect(request())).resolves.toEqual({
      ok: false,
      code: "RESPONSE_TOO_LARGE",
    });

    const deadlineAt = Date.now() + 10_000;
    const aggregate = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async () => response(TS_VOD)) as typeof fetch,
      limits: { responseBytes: 64, reviewBytes: 128 },
    });
    const first = await aggregate.inspect(request({ requestId: "aggregate-1", deadlineAt }));
    const second = await aggregate.inspect(request({ requestId: "aggregate-2", deadlineAt }));
    const third = await aggregate.inspect(request({ requestId: "aggregate-3", deadlineAt }));
    const replay = await aggregate.inspect(request({ requestId: "aggregate-4", deadlineAt }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toEqual({ ok: false, code: "REVIEW_BUDGET_EXCEEDED" });
    expect(replay).toEqual({ ok: false, code: "REVIEW_BUDGET_EXCEEDED" });
  });

  it("binds a review to one deadline, bounds identities, and cleans expired state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async () => response(TS_VOD)) as typeof fetch,
      limits: { reviews: 1 },
    });
    const deadlineAt = 11_000;
    expect(await runtime.inspect(request({ deadlineAt }))).toMatchObject({ ok: true });
    await expect(runtime.inspect(request({ deadlineAt }))).resolves.toEqual({
      ok: false,
      code: "DUPLICATE_REQUEST",
    });
    await expect(
      runtime.inspect(request({ requestId: "request-2", deadlineAt: 11_001 })),
    ).resolves.toEqual({ ok: false, code: "DEADLINE_MISMATCH" });
    await expect(
      runtime.inspect(request({ requestId: "request-other", reviewId: "review-other", deadlineAt })),
    ).resolves.toEqual({ ok: false, code: "REVIEW_LIMIT" });

    await vi.advanceTimersByTimeAsync(1_001);
    await expect(
      runtime.inspect(request({
        deadlineAt: 12_000,
      })),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("StreamVariantFetchRuntimeV1 HLS inspection", () => {
  it("inspects every child, deduplicates shared audio, and supports fMP4 video plus TS audio", async () => {
    const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,URI="audio.m3u8?token=one"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,AVERAGE-BANDWIDTH=1500000,RESOLUTION=1280x720,AUDIO="aud"
video-720.m3u8?token=one
#EXT-X-STREAM-INF:BANDWIDTH=4000000,AVERAGE-BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="aud"
video-1080.m3u8?token=one
`;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("master.m3u8")) return response(master);
      if (url.includes("audio.m3u8")) return response(TS_VOD);
      return response(FMP4_VOD);
    }) as unknown as typeof fetch;
    const runtime = new StreamVariantFetchRuntimeV1({ fetchImpl });
    const result = await runtime.inspect(request());
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected inspection success");
    expect(result.variants).toHaveLength(2);
    expect(result.variants[0]).toMatchObject({
      sourceId: "https://cdn.example.test/video-720.m3u8?token=one",
      audioSourceId: "https://cdn.example.test/audio.m3u8?token=one",
      bandwidth: { scope: "combined", combinedBandwidth: 1_500_000 },
      durationSec: 2,
    });
    expect(result.variants.every((variant) => variant.disabledReason === undefined)).toBe(true);
    expect(calls.filter((url) => url.includes("audio.m3u8"))).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it("returns an implicit media playlist as one unknown-bandwidth option", async () => {
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async () => response(TS_VOD)) as typeof fetch,
    });
    const result = await runtime.inspect(request({
      url: "https://cdn.example.test/media.m3u8?signature=secret",
    }));
    expect(result).toEqual({
      ok: true,
      variants: [{
        sourceId: "https://cdn.example.test/media.m3u8?signature=secret",
        container: "video/mp2t",
        bandwidth: { scope: "unknown" },
        durationSec: 2,
      }],
    });
  });

  it("returns manifest-level DRM, live, and discontinuity reasons", async () => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000
drm.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000
live.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000
shape.m3u8
`;
    const drm = TS_VOD.replace(
      "#EXTINF:1,",
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:1,',
    );
    const shape = TS_VOD.replace(
      "#EXTINF:1,\ntwo.ts",
      "#EXT-X-DISCONTINUITY\n#EXTINF:1,\ntwo.ts",
    );
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("master.m3u8")) return response(master);
        if (url.endsWith("drm.m3u8")) return response(drm);
        if (url.endsWith("live.m3u8")) {
          return response(TS_VOD.replace("#EXT-X-ENDLIST", ""));
        }
        return response(shape);
      }) as typeof fetch,
    });
    const result = await runtime.inspect(request());
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.variants.map((variant) => variant.disabledReason)).toEqual([
        "drm",
        "live",
        "unsupported_manifest_shape",
      ]);
    }
  });

  it("allows identity AES-128 SESSION-KEY but still rejects SAMPLE-AES", async () => {
    const identityMaster = `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://keys.example.test/key",KEYFORMAT="identity"
#EXT-X-STREAM-INF:BANDWIDTH=1000000
video.m3u8
`;
    const identityRuntime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input).includes("master") ? response(identityMaster) : response(TS_VOD)
      ) as typeof fetch,
    });
    const identityResult = await identityRuntime.inspect(request());
    expect(identityResult).toMatchObject({ ok: true });
    if (!identityResult.ok) throw new Error("expected identity session key to be supported");
    expect(identityResult.variants[0].disabledReason).toBeUndefined();

    const sampleRuntime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input).includes("master")
          ? response(identityMaster.replace("METHOD=AES-128", "METHOD=SAMPLE-AES"))
          : response(TS_VOD)
      ) as typeof fetch,
    });
    await expect(sampleRuntime.inspect(request({
      requestId: "sample-request",
      reviewId: "sample-review",
    }))).resolves.toMatchObject({
      ok: true,
      variants: [{ disabledReason: "unsupported_manifest_shape" }],
    });
  });

  it("preserves current signed locators across query rotation", async () => {
    const inspectToken = async (token: string) => {
      const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000
video.m3u8?token=${token}
`;
      const runtime = new StreamVariantFetchRuntimeV1({
        fetchImpl: (async (input: RequestInfo | URL) =>
          String(input).includes("master") ? response(master) : response(TS_VOD)
        ) as typeof fetch,
      });
      return runtime.inspect(request({
        requestId: `request-${token}`,
        reviewId: `review-${token}`,
        url: `https://cdn.example.test/master.m3u8?token=${token}`,
      }));
    };
    const first = await inspectToken("one");
    const second = await inspectToken("two");
    expect(first).toMatchObject({
      ok: true,
      variants: [{ sourceId: "https://cdn.example.test/video.m3u8?token=one" }],
    });
    expect(second).toMatchObject({
      ok: true,
      variants: [{ sourceId: "https://cdn.example.test/video.m3u8?token=two" }],
    });
  });

  it("rejects more than 100 variants before fetching any child", async () => {
    const master = `#EXTM3U\n${Array.from(
      { length: 101 },
      (_, index) => `#EXT-X-STREAM-INF:BANDWIDTH=${index + 1}\n${index}.m3u8`,
    ).join("\n")}\n`;
    const fetchImpl = vi.fn(async () => response(master)) as unknown as typeof fetch;
    const runtime = new StreamVariantFetchRuntimeV1({ fetchImpl });
    await expect(runtime.inspect(request())).resolves.toEqual({
      ok: false,
      code: "TOO_MANY_VARIANTS",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails the whole ladder and never reflects a failing signed URL", async () => {
    const secretUrl = "https://cdn.example.test/fail.m3u8?token=do-not-reflect";
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000
ok.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000
${secretUrl}
`;
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("master.m3u8")) return response(master);
        if (url.includes("fail.m3u8")) throw new Error(`Failed ${secretUrl}`);
        return response(TS_VOD);
      }) as typeof fetch,
    });
    const result = await runtime.inspect(request());
    expect(result).toEqual({ ok: false, code: "FETCH_FAILED" });
    expect(JSON.stringify(result)).not.toContain("do-not-reflect");
    expect(JSON.stringify(result)).not.toContain("https://");
  });
});

describe("StreamVariantFetchRuntimeV1 execution snapshots", () => {
  it("replays the exact HLS root, child, and audio texts once and delegates segments bare", async () => {
    const rootUrl = "https://cdn.example.test/master.m3u8?token=inspection-secret";
    const videoUrl = "https://cdn.example.test/video.m3u8?token=video-secret";
    const audioUrl = "https://cdn.example.test/audio.m3u8?token=audio-secret";
    const segmentUrl = "https://cdn.example.test/one.m4s?token=segment-secret";
    const videoKeyUrl = "https://cdn.example.test/keys/video.key?token=video-key-secret";
    const audioKeyUrl = "https://keys.example.test/audio.key?token=audio-key-secret";
    const sessionKeyUrl = "https://keys.example.test/session.key?token=session-secret";
    const videoText = FMP4_VOD
      .replace(
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="keys/video.key?token=video-key-secret"',
      )
      .replace("one.m4s", "one.m4s?token=segment-secret");
    const audioText = TS_VOD.replace(
      "#EXTINF:1,",
      `#EXT-X-KEY:METHOD=AES-128,URI="${audioKeyUrl}"\n#EXTINF:1,`,
    );
    const master = `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=AES-128,URI="${sessionKeyUrl}",KEYFORMAT="identity"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,URI="${audioUrl}"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
${videoUrl}
`;
    const inspectionFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === rootUrl) return response(master);
      if (url === videoUrl) return response(videoText);
      if (url === audioUrl) return response(audioText);
      throw new Error("unexpected inspection fetch");
    }) as unknown as typeof fetch;
    const snapshotId = executionSnapshotId(1);
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: inspectionFetch,
      createExecutionSnapshotId: () => snapshotId,
    });
    const inspected = await runtime.inspect(request({
      url: rootUrl,
      retainForExecution: true,
    }));
    expect(inspected).toMatchObject({
      ok: true,
      executionSnapshotId: snapshotId,
      variants: [{ sourceId: videoUrl, audioSourceId: audioUrl }],
    });
    if (!inspected.ok) throw new Error("expected retained inspection");
    expect(JSON.stringify(inspected.executionSnapshotId)).not.toContain("secret");

    const delegateReceivers: unknown[] = [];
    const delegateFetch = function (
      this: unknown,
      input: RequestInfo | URL,
    ): Promise<Response> {
      delegateReceivers.push(this);
      return Promise.resolve(response(`segment:${String(input)}`));
    } as typeof fetch;
    const consumed = runtime.consumeExecutionSnapshot(
      { executionSnapshotId: snapshotId, kind: "hls", url: rootUrl },
      delegateFetch,
    );
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) throw new Error("expected snapshot consumption");

    await expect(consumed.fetchImpl(rootUrl).then((value) => value.text())).resolves.toBe(master);
    await expect(consumed.fetchImpl(videoUrl).then((value) => value.text())).resolves.toBe(videoText);
    await expect(consumed.fetchImpl(audioUrl).then((value) => value.text())).resolves.toBe(audioText);
    await expect(consumed.fetchImpl(segmentUrl).then((value) => value.text())).resolves.toBe(
      `segment:${segmentUrl}`,
    );
    await expect(consumed.fetchImpl(videoKeyUrl).then((value) => value.text())).resolves.toBe(
      `segment:${videoKeyUrl}`,
    );
    await expect(consumed.fetchImpl(audioKeyUrl).then((value) => value.text())).resolves.toBe(
      `segment:${audioKeyUrl}`,
    );
    await expect(consumed.fetchImpl(sessionKeyUrl)).rejects.toThrow(
      "Execution URL is not authorized by the snapshot.",
    );
    await expect(
      consumed.fetchImpl("https://cdn.example.test/uninspected-audio.m3u8"),
    ).rejects.toThrow("Execution URL is not authorized by the snapshot.");
    expect(delegateReceivers).toEqual([undefined, undefined, undefined]);
    expect(
      runtime.consumeExecutionSnapshot({
        executionSnapshotId: snapshotId,
        kind: "hls",
        url: rootUrl,
      }),
    ).toEqual({ ok: false });
  });

  it("replays an exact DASH MPD while delegating its media segments", async () => {
    const rootUrl = "https://cdn.example.test/manifest.mpd?token=one";
    const xml = dashMpd();
    const snapshotId = executionSnapshotId(2);
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async () => response(xml)) as typeof fetch,
      createExecutionSnapshotId: () => snapshotId,
    });
    const inspected = await runtime.inspect(request({
      kind: "dash",
      url: rootUrl,
      retainForExecution: true,
    }));
    expect(inspected).toMatchObject({ ok: true, executionSnapshotId: snapshotId });

    const delegate = vi.fn(async () => response("segment")) as unknown as typeof fetch;
    const consumed = runtime.consumeExecutionSnapshot(
      { executionSnapshotId: snapshotId, kind: "dash", url: rootUrl },
      delegate,
    );
    if (!consumed.ok) throw new Error("expected snapshot consumption");
    await expect(consumed.fetchImpl(rootUrl).then((value) => value.text())).resolves.toBe(xml);
    await expect(
      consumed.fetchImpl("https://cdn.example.test/seg-1.m4s").then((value) => value.text()),
    ).resolves.toBe("segment");
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("fails closed on missing or mismatched handles and consumes a mismatched known handle", async () => {
    const rootUrl = "https://cdn.example.test/media.m3u8";
    const snapshotId = executionSnapshotId(3);
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async () => response(TS_VOD)) as typeof fetch,
      createExecutionSnapshotId: () => snapshotId,
    });
    await expect(runtime.inspect(request({
      url: rootUrl,
      retainForExecution: true,
    }))).resolves.toMatchObject({ ok: true, executionSnapshotId: snapshotId });

    expect(runtime.consumeExecutionSnapshot({
      executionSnapshotId: executionSnapshotId(999),
      kind: "hls",
      url: rootUrl,
    })).toEqual({ ok: false });
    expect(runtime.consumeExecutionSnapshot({
      executionSnapshotId: snapshotId,
      kind: "dash",
      url: rootUrl,
    })).toEqual({ ok: false });
    expect(runtime.consumeExecutionSnapshot({
      executionSnapshotId: snapshotId,
      kind: "hls",
      url: rootUrl,
    })).toEqual({ ok: false });
  });

  it("discards opaquely and idempotently without letting an unknown ID affect another handle", async () => {
    let id = 20;
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async () => response(TS_VOD)) as typeof fetch,
      createExecutionSnapshotId: () => executionSnapshotId(id++),
    });
    const rootUrl = "https://cdn.example.test/discard.m3u8";
    const retained = await runtime.inspect(request({
      requestId: "discard-request-1",
      reviewId: "discard-review-1",
      url: rootUrl,
      retainForExecution: true,
    }));
    if (!retained.ok || retained.executionSnapshotId === undefined) {
      throw new Error("expected retained snapshot");
    }

    expect(runtime.discardExecutionSnapshot(executionSnapshotId(999))).toEqual({ ok: true });
    expect(runtime.discardExecutionSnapshot("malformed-secret-url")).toEqual({ ok: true });
    const accepted = runtime.consumeExecutionSnapshot({
      executionSnapshotId: retained.executionSnapshotId,
      kind: "hls",
      url: rootUrl,
    });
    expect(accepted.ok).toBe(true);
    // A late/retried discard cannot revoke an already accepted execution.
    expect(runtime.discardExecutionSnapshot(retained.executionSnapshotId)).toEqual({ ok: true });
    if (!accepted.ok) throw new Error("expected accepted execution snapshot");
    await expect(accepted.fetchImpl(rootUrl).then((value) => value.text())).resolves.toBe(TS_VOD);

    const second = await runtime.inspect(request({
      requestId: "discard-request-2",
      reviewId: "discard-review-2",
      url: rootUrl,
      retainForExecution: true,
    }));
    if (!second.ok || second.executionSnapshotId === undefined) {
      throw new Error("expected second retained snapshot");
    }
    expect(runtime.discardExecutionSnapshot(second.executionSnapshotId)).toEqual({ ok: true });
    expect(runtime.discardExecutionSnapshot(second.executionSnapshotId)).toEqual({ ok: true });
    expect(runtime.consumeExecutionSnapshot({
      executionSnapshotId: second.executionSnapshotId,
      kind: "dash",
      url: "https://mismatch.example.test/manifest.mpd",
    })).toEqual({ ok: false });
  });

  it("recovers all eight slots after eight stale-policy discards before a valid retain", async () => {
    let id = 100;
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async () => response(TS_VOD)) as typeof fetch,
      createExecutionSnapshotId: () => executionSnapshotId(id++),
      limits: {
        executionSnapshots: 8,
        executionSnapshotBytes: new TextEncoder().encode(TS_VOD).byteLength,
      },
    });
    const deadlineAt = Date.now() + 10_000;
    for (let index = 0; index < 8; index += 1) {
      const stale = await runtime.inspect(request({
        requestId: `stale-request-${index}`,
        reviewId: `stale-review-${index}`,
        url: `https://cdn.example.test/stale-${index}.m3u8`,
        deadlineAt,
        retainForExecution: true,
      }));
      expect(stale).toMatchObject({ ok: true });
      if (!stale.ok || stale.executionSnapshotId === undefined) {
        throw new Error("expected stale retained snapshot");
      }
      // Models each post-inspection stale/policy exit in background.
      expect(runtime.discardExecutionSnapshot(stale.executionSnapshotId)).toEqual({ ok: true });
    }

    await expect(runtime.inspect(request({
      requestId: "valid-request",
      reviewId: "valid-review",
      url: "https://cdn.example.test/valid.m3u8",
      deadlineAt,
      retainForExecution: true,
    }))).resolves.toMatchObject({
      ok: true,
      executionSnapshotId: executionSnapshotId(108),
    });
  });

  it("expires retained texts at the review deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const snapshotId = executionSnapshotId(4);
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async () => response(TS_VOD)) as typeof fetch,
      createExecutionSnapshotId: () => snapshotId,
    });
    await expect(runtime.inspect(request({
      deadlineAt: 1_050,
      retainForExecution: true,
    }))).resolves.toMatchObject({ ok: true, executionSnapshotId: snapshotId });

    await vi.advanceTimersByTimeAsync(51);
    expect(runtime.consumeExecutionSnapshot({
      executionSnapshotId: snapshotId,
      kind: "hls",
      url: "https://cdn.example.test/master.m3u8",
    })).toEqual({ ok: false });
  });

  it("does not serve a consumed manifest after its retention deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const snapshotId = executionSnapshotId(5);
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async () => response(TS_VOD)) as typeof fetch,
      createExecutionSnapshotId: () => snapshotId,
    });
    await runtime.inspect(request({ deadlineAt: 2_050, retainForExecution: true }));
    const consumed = runtime.consumeExecutionSnapshot({
      executionSnapshotId: snapshotId,
      kind: "hls",
      url: "https://cdn.example.test/master.m3u8",
    });
    if (!consumed.ok) throw new Error("expected snapshot consumption");

    await vi.advanceTimersByTimeAsync(51);
    await expect(
      consumed.fetchImpl("https://cdn.example.test/master.m3u8"),
    ).rejects.toThrow("Execution snapshot expired.");
  });

  it("bounds live snapshot count and bytes, then reclaims capacity after consumption", async () => {
    let id = 10;
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async () => response(TS_VOD)) as typeof fetch,
      createExecutionSnapshotId: () => executionSnapshotId(id++),
      limits: {
        executionSnapshots: 1,
        executionSnapshotBytes: new TextEncoder().encode(TS_VOD).byteLength,
      },
    });
    const deadlineAt = Date.now() + 10_000;
    const first = await runtime.inspect(request({ deadlineAt, retainForExecution: true }));
    expect(first).toMatchObject({ ok: true, executionSnapshotId: executionSnapshotId(10) });
    await expect(runtime.inspect(request({
      requestId: "request-2",
      reviewId: "review-2",
      url: "https://cdn.example.test/two.m3u8",
      deadlineAt,
      retainForExecution: true,
    }))).resolves.toEqual({ ok: false, code: "EXECUTION_SNAPSHOT_LIMIT" });
    if (!first.ok || first.executionSnapshotId === undefined) {
      throw new Error("expected retained snapshot");
    }
    expect(runtime.consumeExecutionSnapshot({
      executionSnapshotId: first.executionSnapshotId,
      kind: "hls",
      url: "https://cdn.example.test/master.m3u8",
    }).ok).toBe(true);
    await expect(runtime.inspect(request({
      requestId: "request-3",
      reviewId: "review-3",
      url: "https://cdn.example.test/three.m3u8",
      deadlineAt,
      retainForExecution: true,
    }))).resolves.toMatchObject({ ok: true, executionSnapshotId: executionSnapshotId(11) });
  });
});

describe("StreamVariantFetchRuntimeV1 DASH inspection", () => {
  it("maps all video representations and default audio through the shared adapter", async () => {
    const xml = dashMpd().replace(
      "</Period>",
      `<AdaptationSet contentType="audio" mimeType="audio/mp4">
        <Representation id="audio-main" bandwidth="128000">
          <SegmentTemplate timescale="1" duration="1" startNumber="1" initialization="audio-init.mp4" media="audio-$Number$.m4s"/>
        </Representation>
      </AdaptationSet></Period>`,
    );
    const runtime = new StreamVariantFetchRuntimeV1({
      fetchImpl: (async () => response(xml)) as typeof fetch,
    });
    const result = await runtime.inspect(request({
      kind: "dash",
      url: "https://cdn.example.test/manifest.mpd",
    }));
    expect(result).toMatchObject({
      ok: true,
      variants: [{
        sourceId: "video-main",
        bandwidth: {
          scope: "video_with_default_audio",
          videoBandwidth: 1_000_000,
          audioBandwidth: 128_000,
        },
        durationSec: 2,
      }],
    });
  });

  it("returns typed live, DRM, and unsupported-container reasons", async () => {
    const cases = [
      [dashMpd({ type: "dynamic" }), "live"],
      [dashMpd({
        protection: '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>',
      }), "drm"],
      [dashMpd({ mimeType: "video/webm" }), "unsupported_container"],
    ] as const;
    for (const [xml, disabledReason] of cases) {
      const runtime = new StreamVariantFetchRuntimeV1({
        fetchImpl: (async () => response(xml)) as typeof fetch,
      });
      const result = await runtime.inspect(request({
        requestId: `request-${disabledReason}`,
        reviewId: `review-${disabledReason}`,
        kind: "dash",
        url: "https://cdn.example.test/manifest.mpd",
      }));
      expect(result).toMatchObject({
        ok: true,
        variants: [{ disabledReason }],
      });
    }
  });
});
