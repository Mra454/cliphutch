import { Parser } from "m3u8-parser";
import {
  type DashManifest,
  type DashRepresentation,
} from "./dash";
import { classifyHlsManifestForDrm } from "./drm";
import type { HlsVariant } from "./hls-variants";
import {
  MAX_VARIANT_BANDWIDTH,
  MAX_VARIANT_DIMENSION,
  MAX_VARIANT_DURATION_SEC,
  type RawVariantBandwidthV1,
  type RawVariantOptionV1,
  type VariantDisabledReasonV1,
} from "./variant-options";

// Keep parser work within the same manifest/segment envelope used by the
// current DASH planner. Network byte/time/concurrency limits remain the
// responsibility of the caller that fetches these manifest texts.
export const HLS_MEDIA_PLAYLIST_CHAR_LIMIT = 2_000_000;
export const HLS_MEDIA_PLAYLIST_SEGMENT_LIMIT = 20_000;

type ByteRange = { length?: number; offset?: number };

type ParsedHlsSegment = {
  uri?: string;
  duration?: number;
  key?: { method?: string };
  map?: { uri?: string; byterange?: ByteRange };
  discontinuity?: boolean;
};

type ParsedHlsMediaPlaylist = {
  endList?: boolean;
  segments?: ParsedHlsSegment[];
  discontinuityStarts?: number[];
};

export type HlsMediaContainerV1 = "video/mp4" | "video/mp2t";

export type HlsMediaPlaylistDisabledCodeV1 =
  | "manifest_too_large"
  | "drm"
  | "live"
  | "empty"
  | "segment_limit"
  | "encrypted"
  | "invalid_duration"
  | "discontinuity"
  | "init_map_change"
  | "raw_aac"
  | "separate_audio_requires_fmp4";

type HlsMediaPlaylistInspectionBaseV1 = {
  hasInitMap: boolean;
  durationSec?: number;
  container?: HlsMediaContainerV1;
};

export type HlsMediaPlaylistInspectionV1 =
  | (HlsMediaPlaylistInspectionBaseV1 & {
      supported: true;
      durationSec: number;
      container: HlsMediaContainerV1;
    })
  | (HlsMediaPlaylistInspectionBaseV1 & {
      supported: false;
      disabledReason: VariantDisabledReasonV1;
      code: HlsMediaPlaylistDisabledCodeV1;
    });

export type InspectHlsMediaPlaylistOptionsV1 = {
  /** Stage 1 can mux separate HLS audio only when video is fMP4. */
  requireFmp4VideoForSeparateAudio?: boolean;
};

function hlsFailure(
  code: HlsMediaPlaylistDisabledCodeV1,
  disabledReason: VariantDisabledReasonV1,
  facts: HlsMediaPlaylistInspectionBaseV1 = { hasInitMap: false },
): HlsMediaPlaylistInspectionV1 {
  return { supported: false, code, disabledReason, ...facts };
}

function parseHlsMediaPlaylist(text: string): ParsedHlsMediaPlaylist | undefined {
  const parser = new Parser();
  try {
    parser.push(text);
    parser.end();
    return parser.manifest as ParsedHlsMediaPlaylist;
  } catch {
    return undefined;
  }
}

function hasPlainHlsEncryption(text: string, segments: ParsedHlsSegment[]): boolean {
  if (
    segments.some((segment) => {
      const method = segment.key?.method?.trim().toUpperCase();
      return method !== undefined && method !== "" && method !== "NONE";
    })
  ) {
    return true;
  }
  // SESSION-KEY can apply before a segment key is attached by m3u8-parser.
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!/^#EXT-X-(?:SESSION-)?KEY\s*:/i.test(trimmed)) return false;
    const method = /(?:^|,)\s*METHOD\s*=\s*([^,\s]+)/i.exec(
      trimmed.slice(trimmed.indexOf(":") + 1),
    )?.[1]?.trim().toUpperCase();
    return method !== undefined && method !== "" && method !== "NONE";
  });
}

function mapSignature(segment: ParsedHlsSegment): string {
  if (!segment.map?.uri) return "none";
  const range = segment.map.byterange;
  return `${segment.map.uri}|${range?.offset ?? ""}|${range?.length ?? ""}`;
}

function isDeclaredRawAacSegment(uri: string | undefined): boolean {
  if (!uri) return false;
  const path = uri.split(/[?#]/, 1)[0].toLowerCase();
  return path.endsWith(".aac") || path.endsWith(".adts");
}

function declaredHlsDurations(text: string): number[] | undefined {
  const durations: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^#EXTINF\s*:/i.test(trimmed)) continue;
    const match = /^#EXTINF\s*:\s*((?:\d+(?:\.\d*)?)|(?:\.\d+))\s*,/i.exec(
      trimmed,
    );
    if (!match) return undefined;
    const duration = Number(match[1]);
    if (!Number.isFinite(duration) || duration <= 0) return undefined;
    durations.push(duration);
  }
  return durations;
}

/**
 * Inspects only manifest-level facts that the current HLS downloader supports.
 * It deliberately does not claim codec/init-segment support before bytes are
 * fetched and inspected by the downloader.
 */
export function inspectHlsMediaPlaylistV1(
  text: string,
  options: InspectHlsMediaPlaylistOptionsV1 = {},
): HlsMediaPlaylistInspectionV1 {
  if (text.length > HLS_MEDIA_PLAYLIST_CHAR_LIMIT) {
    return hlsFailure("manifest_too_large", "unsupported_manifest_shape");
  }
  if (classifyHlsManifestForDrm(text).protected) {
    return hlsFailure("drm", "drm");
  }

  const parsed = parseHlsMediaPlaylist(text);
  if (!parsed) return hlsFailure("empty", "invalid_media");
  if (!parsed.endList) return hlsFailure("live", "live");

  const segments = parsed.segments ?? [];
  if (segments.length === 0) return hlsFailure("empty", "invalid_media");
  if (segments.length > HLS_MEDIA_PLAYLIST_SEGMENT_LIMIT) {
    return hlsFailure("segment_limit", "unsupported_manifest_shape");
  }
  if (hasPlainHlsEncryption(text, segments)) {
    return hlsFailure("encrypted", "unsupported_manifest_shape");
  }
  if (
    (parsed.discontinuityStarts?.length ?? 0) > 0 ||
    segments.some((segment) => segment.discontinuity)
  ) {
    return hlsFailure("discontinuity", "unsupported_manifest_shape");
  }

  const firstMapSignature = mapSignature(segments[0]);
  const hasInitMap = firstMapSignature !== "none";
  if (!hasInitMap && segments.every((segment) => isDeclaredRawAacSegment(segment.uri))) {
    return hlsFailure("raw_aac", "unsupported_audio", { hasInitMap: false });
  }
  const container: HlsMediaContainerV1 = hasInitMap ? "video/mp4" : "video/mp2t";
  const facts: HlsMediaPlaylistInspectionBaseV1 = { hasInitMap, container };
  if (segments.some((segment) => mapSignature(segment) !== firstMapSignature)) {
    return hlsFailure("init_map_change", "unsupported_manifest_shape", facts);
  }

  const durations = declaredHlsDurations(text);
  if (durations === undefined || durations.length !== segments.length) {
    return hlsFailure("invalid_duration", "invalid_media", facts);
  }
  let durationSec = 0;
  for (const duration of durations) {
    durationSec += duration;
    if (!Number.isFinite(durationSec) || durationSec > MAX_VARIANT_DURATION_SEC) {
      return hlsFailure("invalid_duration", "invalid_media", facts);
    }
  }
  if (durationSec <= 0) {
    return hlsFailure("invalid_duration", "invalid_media", facts);
  }
  if (options.requireFmp4VideoForSeparateAudio && !hasInitMap) {
    return hlsFailure("separate_audio_requires_fmp4", "unsupported_audio", {
      ...facts,
      durationSec,
    });
  }
  return { supported: true, hasInitMap, durationSec, container };
}

export type DashDefaultAudioSelectionV1 =
  | { state: "none" }
  | { state: "selected"; representation: DashRepresentation }
  | {
      state: "unsupported";
      disabledReason: "unsupported_audio";
      cause: VariantDisabledReasonV1;
    };

export function dashRepresentationDisabledReasonV1(
  representation: DashRepresentation,
  expectedMediaType?: "video" | "audio",
): VariantDisabledReasonV1 | undefined {
  if (representation.drm.protected) return "drm";
  if (representation.unsupportedShape === "unsupported-container") {
    return "unsupported_container";
  }
  if (representation.unsupportedShape !== undefined) {
    return "unsupported_manifest_shape";
  }
  if (
    representation.mediaType === "unknown" ||
    (expectedMediaType !== undefined && representation.mediaType !== expectedMediaType)
  ) {
    return "invalid_media";
  }
  if (representation.mediaSegmentUrls.length === 0) {
    return "unsupported_manifest_shape";
  }
  return undefined;
}

export function dashManifestDisabledReasonV1(
  manifest: DashManifest,
): VariantDisabledReasonV1 | undefined {
  if (manifest.type === "dynamic") return "live";
  if (manifest.unsupportedShape !== undefined) return "unsupported_manifest_shape";
  if (manifest.video.length === 0) return "invalid_media";
  if (
    manifest.durationSec !== undefined &&
    (!Number.isFinite(manifest.durationSec) ||
      manifest.durationSec <= 0 ||
      manifest.durationSec > MAX_VARIANT_DURATION_SEC)
  ) {
    return "invalid_media";
  }
  return undefined;
}

/** Mirrors the current downloader: preserve manifest order, skip only DRM or
 * unsupported-shape audio, and choose exactly the first remaining rendition. */
export function selectDashDefaultAudioV1(
  manifest: DashManifest,
): DashDefaultAudioSelectionV1 {
  if (manifest.audio.length === 0) return { state: "none" };
  const representation = manifest.audio.find(
    (candidate) =>
      dashRepresentationDisabledReasonV1(candidate, "audio") === undefined,
  );
  if (representation) return { state: "selected", representation };
  // Match downloader error precedence after selection fails: protected audio
  // is surfaced before an unsupported shape, regardless of their order.
  const protectedRepresentation = manifest.audio.find(
    (candidate) => candidate.drm.protected,
  );
  const unsupportedRepresentation = manifest.audio.find(
    (candidate) =>
      dashRepresentationDisabledReasonV1(candidate, "audio") !== undefined,
  );
  const cause = protectedRepresentation === undefined
    ? unsupportedRepresentation === undefined
      ? "invalid_media"
      : dashRepresentationDisabledReasonV1(unsupportedRepresentation, "audio") ??
        "invalid_media"
    : "drm";
  return { state: "unsupported", disabledReason: "unsupported_audio", cause };
}

function validBandwidth(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_VARIANT_BANDWIDTH
  );
}

export function dashRawBandwidthV1(
  video: DashRepresentation,
  audio: DashDefaultAudioSelectionV1,
): RawVariantBandwidthV1 {
  if (!validBandwidth(video.bandwidth)) return { scope: "unknown" };
  if (audio.state === "none") {
    return { scope: "video_only", videoBandwidth: video.bandwidth };
  }
  if (audio.state === "selected" && validBandwidth(audio.representation.bandwidth)) {
    if (video.bandwidth > MAX_VARIANT_BANDWIDTH - audio.representation.bandwidth) {
      return { scope: "unknown" };
    }
    return {
      scope: "video_with_default_audio",
      videoBandwidth: video.bandwidth,
      audioBandwidth: audio.representation.bandwidth,
    };
  }
  return {
    scope: "video_with_unknown_default_audio",
    videoBandwidth: video.bandwidth,
  };
}

/** Converts one parsed DASH video Representation into the strict C7 raw
 * quality-domain contract without guessing missing duration or audio bitrate. */
export function dashRawVariantOptionV1(
  manifest: DashManifest,
  video: DashRepresentation,
): RawVariantOptionV1 {
  const audio = selectDashDefaultAudioV1(manifest);
  const disabledReason =
    dashManifestDisabledReasonV1(manifest) ??
    dashRepresentationDisabledReasonV1(video, "video") ??
    (audio.state === "unsupported" ? audio.disabledReason : undefined);
  return {
    sourceId: video.id,
    ...(validPositiveInteger(video.width) ? { width: video.width } : {}),
    ...(validPositiveInteger(video.height) ? { height: video.height } : {}),
    ...(video.codecs ? { codecs: video.codecs } : {}),
    ...(video.mimeType ? { container: video.mimeType.toLowerCase() } : {}),
    bandwidth: dashRawBandwidthV1(video, audio),
    ...(validDuration(manifest.durationSec)
      ? { durationSec: manifest.durationSec }
      : {}),
    ...(disabledReason === undefined ? {} : { disabledReason }),
  };
}

function validPositiveInteger(value: number | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_VARIANT_DIMENSION
  );
}

function validDuration(value: number | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_VARIANT_DURATION_SEC
  );
}

function resolveHttpUrl(uri: string, baseUrl: string): string | undefined {
  try {
    const parsed = new URL(uri, baseUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function hlsAggregateBandwidth(variant: HlsVariant): RawVariantBandwidthV1 {
  const aggregate = validBandwidth(variant.averageBandwidth ?? 0)
    ? variant.averageBandwidth
    : validBandwidth(variant.bandwidth)
      ? variant.bandwidth
      : undefined;
  return aggregate === undefined
    ? { scope: "unknown" }
    : { scope: "combined", combinedBandwidth: aggregate };
}

const KNOWN_NON_AVC_VIDEO_CODEC_ROOTS = new Set([
  "av01",
  "dvav",
  "dva1",
  "dvhe",
  "dvh1",
  "hev1",
  "hvc1",
  "mp2v",
  "mp4v",
  "theora",
  "vp08",
  "vp09",
  "vp8",
  "vp9",
]);

const KNOWN_NON_AAC_AUDIO_CODEC_ROOTS = new Set([
  "ac-3",
  "ac-4",
  "alac",
  "ec-3",
  "flac",
  "mp3",
  "opus",
  "vorbis",
]);

function declaredCodecTokens(codecs: string | undefined): string[] {
  return codecs === undefined
    ? []
    : codecs
        .split(",")
        .map((codec) => codec.trim().toLowerCase())
        .filter((codec) => codec.length > 0);
}

function codecRoot(codec: string): string {
  return codec.split(".", 1)[0];
}

/**
 * The MPEG-TS repackager supports only H.264 video and AAC audio. We reject
 * only codec families whose declaration proves that path cannot work. Missing
 * or unfamiliar declarations remain unknown and are still verified from the
 * fetched media bytes by the downloader.
 */
function hlsDeclaredTransportCodecUnsupported(
  codecs: string | undefined,
  videoContainer: HlsMediaContainerV1 | undefined,
  audioContainer: HlsMediaContainerV1 | undefined,
  hasSeparateAudio: boolean,
): boolean {
  const tokens = declaredCodecTokens(codecs);
  const videoUsesTransportStream = videoContainer === "video/mp2t";
  const audioUsesTransportStream = hasSeparateAudio
    ? audioContainer === "video/mp2t"
    : videoUsesTransportStream;

  return tokens.some((codec) => {
    const root = codecRoot(codec);
    if (videoUsesTransportStream && KNOWN_NON_AVC_VIDEO_CODEC_ROOTS.has(root)) {
      return true;
    }
    if (!audioUsesTransportStream) return false;
    if (KNOWN_NON_AAC_AUDIO_CODEC_ROOTS.has(root)) return true;
    // RFC 6381 uses object type 0x40 for MPEG-4 AAC. 0x69/0x6b are MPEG
    // audio declarations and cannot use the AAC-only transport repackager.
    return /^mp4a\.(?:69|6b)(?:\.|$)/i.test(codec);
  });
}

/**
 * Converts resolved HLS child inspections into the strict C7 raw contract.
 * The signed URLs intentionally remain ephemeral raw inputs; normalization
 * redacts them when deriving the stable structural selector.
 */
export function hlsRawVariantOptionV1(
  variant: HlsVariant,
  masterUrl: string,
  video: HlsMediaPlaylistInspectionV1,
  audio?: HlsMediaPlaylistInspectionV1,
): RawVariantOptionV1 | undefined {
  const sourceId = resolveHttpUrl(variant.uri, masterUrl);
  if (!sourceId) return undefined;
  const audioSourceId = variant.audioRenditionUri === undefined
    ? undefined
    : resolveHttpUrl(variant.audioRenditionUri, masterUrl);
  if (variant.audioRenditionUri !== undefined && audioSourceId === undefined) {
    return undefined;
  }

  const separateAudioFailure = variant.audioRenditionUri === undefined
    ? undefined
    : !video.hasInitMap || audio === undefined
      ? "unsupported_audio"
      : !audio.supported
        ? audio.disabledReason === "drm" || audio.disabledReason === "live"
          ? audio.disabledReason
          : "unsupported_audio"
        : undefined;
  const disabledReason =
    (video.supported ? undefined : video.disabledReason) ??
    separateAudioFailure ??
    (hlsDeclaredTransportCodecUnsupported(
      variant.codecs,
      video.container,
      audio?.container,
      variant.audioRenditionUri !== undefined,
    )
      ? "unsupported_codec"
      : undefined);
  const durationSec = video.durationSec === undefined
    ? audio?.durationSec
    : audio?.durationSec === undefined
      ? video.durationSec
      : Math.max(video.durationSec, audio.durationSec);

  return {
    sourceId,
    ...(audioSourceId === undefined ? {} : { audioSourceId }),
    ...(validPositiveInteger(variant.width) ? { width: variant.width } : {}),
    ...(validPositiveInteger(variant.height) ? { height: variant.height } : {}),
    ...(variant.codecs ? { codecs: variant.codecs } : {}),
    ...(video.container === undefined ? {} : { container: video.container }),
    bandwidth: hlsAggregateBandwidth(variant),
    ...(validDuration(durationSec) ? { durationSec } : {}),
    ...(disabledReason === undefined ? {} : { disabledReason }),
  };
}
