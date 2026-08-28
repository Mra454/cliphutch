import { describe, expect, it } from "vitest";
import type {
  DashManifest,
  DashRepresentation,
  DashRepresentationUnsupportedShape,
} from "./dash";
import { parseMasterVariants } from "./hls-variants";
import {
  dashManifestDisabledReasonV1,
  dashRawVariantOptionV1,
  dashRepresentationDisabledReasonV1,
  hlsRawVariantOptionV1,
  inspectHlsMediaPlaylistV1,
  selectDashDefaultAudioV1,
} from "./stream-variant-inspection";
import { normalizeVariantOptionsV1 } from "./variant-options";
import { selectBestUnderCapVariantV1 } from "./quality-policy";

const TS_VOD = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:6,
one.ts
#EXTINF:4.5,
two.ts
#EXT-X-ENDLIST
`;

const FMP4_VOD = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
one.m4s
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.5,
two.m4s
#EXT-X-ENDLIST
`;

describe("inspectHlsMediaPlaylistV1", () => {
  it("returns finite VOD duration and distinguishes MPEG-TS from fMP4", () => {
    expect(inspectHlsMediaPlaylistV1(TS_VOD)).toEqual({
      supported: true,
      hasInitMap: false,
      durationSec: 10.5,
      container: "video/mp2t",
    });
    expect(inspectHlsMediaPlaylistV1(FMP4_VOD)).toEqual({
      supported: true,
      hasInitMap: true,
      durationSec: 10.5,
      container: "video/mp4",
    });
  });

  it("rejects a live playlist even when it has media segments", () => {
    const result = inspectHlsMediaPlaylistV1(TS_VOD.replace("#EXT-X-ENDLIST", ""));
    expect(result).toMatchObject({
      supported: false,
      code: "live",
      disabledReason: "live",
    });
  });

  it("distinguishes DRM from plain transport encryption", () => {
    const drm = TS_VOD.replace(
      "#EXTINF:6,",
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:6,',
    );
    const encrypted = TS_VOD.replace(
      "#EXTINF:6,",
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.test/key"\n#EXTINF:6,',
    );
    expect(inspectHlsMediaPlaylistV1(drm)).toMatchObject({
      supported: false,
      code: "drm",
      disabledReason: "drm",
    });
    expect(inspectHlsMediaPlaylistV1(encrypted)).toMatchObject({
      supported: false,
      code: "encrypted",
      disabledReason: "unsupported_manifest_shape",
    });
  });

  it("rejects discontinuities and initialization-map changes", () => {
    const discontinuity = TS_VOD.replace(
      "#EXTINF:4.5,",
      "#EXT-X-DISCONTINUITY\n#EXTINF:4.5,",
    );
    const mapChange = FMP4_VOD.replace(
      '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.5,',
      '#EXT-X-MAP:URI="replacement-init.mp4"\n#EXTINF:4.5,',
    );
    expect(inspectHlsMediaPlaylistV1(discontinuity)).toMatchObject({
      supported: false,
      code: "discontinuity",
    });
    expect(inspectHlsMediaPlaylistV1(mapChange)).toMatchObject({
      supported: false,
      code: "init_map_change",
    });
  });

  it("requires fMP4 video when a separate audio rendition will be muxed", () => {
    expect(
      inspectHlsMediaPlaylistV1(TS_VOD, {
        requireFmp4VideoForSeparateAudio: true,
      }),
    ).toMatchObject({
      supported: false,
      code: "separate_audio_requires_fmp4",
      disabledReason: "unsupported_audio",
      durationSec: 10.5,
      container: "video/mp2t",
    });
    expect(
      inspectHlsMediaPlaylistV1(FMP4_VOD, {
        requireFmp4VideoForSeparateAudio: true,
      }),
    ).toMatchObject({ supported: true, container: "video/mp4" });
  });

  it("does not misclassify a declared raw AAC rendition as MPEG-TS", () => {
    const rawAac = TS_VOD
      .replace("one.ts", "one.aac?signature=one")
      .replace("two.ts", "two.adts#fragment");
    expect(inspectHlsMediaPlaylistV1(rawAac)).toMatchObject({
      supported: false,
      code: "raw_aac",
      disabledReason: "unsupported_audio",
      hasInitMap: false,
    });
  });

  it("rejects missing or non-positive segment duration", () => {
    expect(
      inspectHlsMediaPlaylistV1(TS_VOD.replace("#EXTINF:4.5,", "#EXTINF:0,")),
    ).toMatchObject({
      supported: false,
      code: "invalid_duration",
      disabledReason: "invalid_media",
    });
  });
});

function representation(
  id: string,
  mediaType: "video" | "audio",
  overrides: Partial<DashRepresentation> = {},
): DashRepresentation {
  return {
    id,
    mediaType,
    mimeType: `${mediaType}/mp4`,
    bandwidth: mediaType === "video" ? 2_000_000 : 128_000,
    initSegmentUrl: `https://cdn.example.test/${id}/init.mp4`,
    mediaSegmentUrls: [`https://cdn.example.test/${id}/one.m4s`],
    drm: { protected: false },
    ...overrides,
  };
}

function manifest(overrides: Partial<DashManifest> = {}): DashManifest {
  return {
    type: "static",
    durationSec: 60,
    video: [representation("video", "video", { width: 1920, height: 1080 })],
    audio: [],
    other: [],
    drm: { protected: false },
    ...overrides,
  };
}

describe("DASH stream variant adapters", () => {
  it("chooses exactly the first clear/supported audio in manifest order", () => {
    const protectedAudio = representation("protected", "audio", {
      drm: { protected: true, scheme: "widevine" },
    });
    const unsupportedAudio = representation("unsupported", "audio", {
      unsupportedShape: "unsupported-container",
    });
    const firstSupported = representation("first-supported", "audio", {
      bandwidth: 96_000,
    });
    const laterSupported = representation("later-supported", "audio", {
      bandwidth: 256_000,
    });
    const selection = selectDashDefaultAudioV1(
      manifest({
        audio: [
          protectedAudio,
          unsupportedAudio,
          firstSupported,
          laterSupported,
        ],
      }),
    );
    expect(selection.state).toBe("selected");
    if (selection.state === "selected") {
      expect(selection.representation.id).toBe("first-supported");
    }
  });

  it("maps live, DRM, unsupported containers, and every parser shape", () => {
    expect(dashManifestDisabledReasonV1(manifest({ type: "dynamic" }))).toBe("live");
    expect(
      dashRepresentationDisabledReasonV1(
        representation("protected", "video", {
          drm: { protected: true, scheme: "playready" },
        }),
        "video",
      ),
    ).toBe("drm");
    const unsupportedShapes: readonly DashRepresentationUnsupportedShape[] = [
      "segment-base",
      "segment-list-range",
      "negative-repeat",
      "invalid-segment-template",
      "segment-limit",
      "no-segments",
      "ambiguous-media-type",
      "unsupported-container",
    ];
    for (const shape of unsupportedShapes) {
      expect(
        dashRepresentationDisabledReasonV1(
          representation(shape, "video", { unsupportedShape: shape }),
          "video",
        ),
      ).toBe(
        shape === "unsupported-container"
          ? "unsupported_container"
          : "unsupported_manifest_shape",
      );
    }
  });

  it("maps declared video + selected-audio bandwidth without guessing", () => {
    const video = representation("video-720", "video", {
      bandwidth: 1_800_000,
      width: 1280,
      height: 720,
      codecs: "avc1.4d401f",
    });
    const audio = representation("audio-main", "audio", { bandwidth: 128_000 });
    expect(dashRawVariantOptionV1(manifest({ video: [video], audio: [audio] }), video)).toEqual({
      sourceId: "video-720",
      width: 1280,
      height: 720,
      codecs: "avc1.4d401f",
      container: "video/mp4",
      bandwidth: {
        scope: "video_with_default_audio",
        videoBandwidth: 1_800_000,
        audioBandwidth: 128_000,
      },
      durationSec: 60,
    });
    expect(
      dashRawVariantOptionV1(manifest({ video: [video], audio: [] }), video)
        .bandwidth,
    ).toEqual({ scope: "video_only", videoBandwidth: 1_800_000 });
  });

  it("disables video when DASH has audio but none is downloadable", () => {
    const video = representation("video", "video");
    const protectedAudio = representation("audio", "audio", {
      drm: { protected: true, scheme: "widevine" },
    });
    expect(
      dashRawVariantOptionV1(
        manifest({ video: [video], audio: [protectedAudio] }),
        video,
      ),
    ).toMatchObject({
      disabledReason: "unsupported_audio",
      bandwidth: {
        scope: "video_with_unknown_default_audio",
        videoBandwidth: 2_000_000,
      },
    });
  });
});

describe("hlsRawVariantOptionV1", () => {
  it("excludes a declared unsupported MPEG-TS codec from automatic selection", async () => {
    const variants = parseMasterVariants(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L93.B0,mp4a.40.2"
hevc.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
avc.m3u8
`);
    const inspected = inspectHlsMediaPlaylistV1(TS_VOD);
    const raw = variants.map((variant) => hlsRawVariantOptionV1(
      variant,
      "https://cdn.example.test/master.m3u8",
      inspected,
    ));
    expect(raw[0]).toMatchObject({
      codecs: "hvc1.1.6.L93.B0,mp4a.40.2",
      disabledReason: "unsupported_codec",
    });
    expect(raw[1]?.disabledReason).toBeUndefined();

    const normalized = await normalizeVariantOptionsV1({ kind: "hls", variants: raw });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw new Error("expected normalized HLS options");
    expect(selectBestUnderCapVariantV1(
      { mode: "best_under_cap", maxEstimatedBytes: 10_000_000 },
      normalized.options,
    )).toMatchObject({ state: "selected", choice: { height: 720 } });
  });

  it("does not guess when a TS codec declaration is absent or unfamiliar", () => {
    const [absent, unfamiliar] = parseMasterVariants(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000
absent.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="future-codec"
unfamiliar.m3u8
`);
    const inspection = inspectHlsMediaPlaylistV1(TS_VOD);
    expect(hlsRawVariantOptionV1(
      absent,
      "https://cdn.example.test/master.m3u8",
      inspection,
    )?.disabledReason).toBeUndefined();
    expect(hlsRawVariantOptionV1(
      unfamiliar,
      "https://cdn.example.test/master.m3u8",
      inspection,
    )?.disabledReason).toBeUndefined();
  });

  it("uses aggregate average bandwidth and includes the longer default audio duration", () => {
    const [variant] = parseMasterVariants(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,URI="audio.m3u8?token=one"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,AVERAGE-BANDWIDTH=1800000,RESOLUTION=1280x720,AUDIO="aud"
video.m3u8?token=one
`);
    const video = inspectHlsMediaPlaylistV1(FMP4_VOD, {
      requireFmp4VideoForSeparateAudio: true,
    });
    const audio = inspectHlsMediaPlaylistV1(
      FMP4_VOD.replace("#EXTINF:4.5,", "#EXTINF:6,"),
    );
    expect(
      hlsRawVariantOptionV1(
        variant,
        "https://cdn.example.test/master.m3u8?master=one",
        video,
        audio,
      ),
    ).toEqual({
      sourceId: "https://cdn.example.test/video.m3u8?token=one",
      audioSourceId: "https://cdn.example.test/audio.m3u8?token=one",
      width: 1280,
      height: 720,
      container: "video/mp4",
      bandwidth: { scope: "combined", combinedBandwidth: 1_800_000 },
      durationSec: 12,
    });
  });

  it("keeps signed fetch URLs ephemeral while normalization survives query rotation", async () => {
    const makeRaw = (token: string) => {
      const [variant] = parseMasterVariants(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,URI="audio.m3u8?token=${token}"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=800000,AUDIO="aud"
video.m3u8?token=${token}
`);
      return hlsRawVariantOptionV1(
        variant,
        `https://cdn.example.test/master.m3u8?master=${token}`,
        inspectHlsMediaPlaylistV1(FMP4_VOD, {
          requireFmp4VideoForSeparateAudio: true,
        }),
        inspectHlsMediaPlaylistV1(FMP4_VOD),
      );
    };
    const firstRaw = makeRaw("one");
    const secondRaw = makeRaw("two");
    expect(firstRaw?.sourceId).toContain("token=one");
    expect(secondRaw?.sourceId).toContain("token=two");
    const first = await normalizeVariantOptionsV1({
      kind: "hls",
      variants: [firstRaw],
    });
    const second = await normalizeVariantOptionsV1({
      kind: "hls",
      variants: [secondRaw],
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.options[0].stableId).toBe(second.options[0].stableId);
      expect(first.options[0].sourceId).not.toContain("token=");
      expect(JSON.stringify(first.options[0])).not.toContain("token=");
    }
  });

  it("supports TS separate audio with fMP4 video but rejects separate audio with TS video", () => {
    const [variant] = parseMasterVariants(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="aud"
video.m3u8
`);
    const tsAudio = inspectHlsMediaPlaylistV1(TS_VOD);
    const supported = hlsRawVariantOptionV1(
      variant,
      "https://cdn.example.test/master.m3u8",
      inspectHlsMediaPlaylistV1(FMP4_VOD),
      tsAudio,
    );
    expect(supported?.disabledReason).toBeUndefined();
    expect(supported).toMatchObject({
      container: "video/mp4",
      durationSec: 10.5,
    });

    expect(
      hlsRawVariantOptionV1(
        variant,
        "https://cdn.example.test/master.m3u8",
        inspectHlsMediaPlaylistV1(TS_VOD),
        tsAudio,
      ),
    ).toMatchObject({ disabledReason: "unsupported_audio" });
  });
});
