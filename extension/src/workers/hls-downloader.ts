import { Parser } from "m3u8-parser";
import {
  AccessDeniedError,
  ByteRangeOutOfBoundsError,
  ByteRangeUnsupportedError,
  CancelledError,
  DrmProtectedError,
  EmptyManifestError,
  EncryptedStreamError,
  LiveStreamError,
  MixedContainerAudioError,
  NetworkError,
  ParseError,
  SizeCapError,
} from "../lib/errors";
import { classifyHlsManifestForDrm } from "../lib/drm";
import { HLS_SEGMENT_FETCH_CONCURRENCY } from "../lib/constants";
import { muxFmp4 } from "./dash-mux";
import { transmuxTsAudioToFmp4, transmuxTsToMp4 } from "./ts-audio-to-fmp4";

export type HlsProgress = {
  done: number;
  total: number;
  bytes: number;
};

export type DownloadHlsOptions = {
  onProgress: (p: HlsProgress) => void;
  signal: AbortSignal;
  sizeCapBytes: number;
  fetchImpl?: typeof fetch;
  // When set, skip pickVariant and use this resolved variant URL.
  // Takes precedence over the highest-bandwidth auto-pick.
  variantUrl?: string;
  // Resolved URI of a separate audio rendition to download in parallel and
  // mux into the output MP4. Required for separate-audio variants. Both the
  // video variant and the audio rendition must be fMP4 (Stage 1 limitation).
  audioUrl?: string;
};

type ByteRange = { length: number; offset: number };

type ParsedSegment = {
  uri: string;
  duration?: number;
  key?: { method?: string; uri?: string };
  map?: { uri?: string; byterange?: ByteRange };
  byterange?: ByteRange;
};

type ParsedVariant = {
  uri: string;
  attributes: {
    BANDWIDTH?: number;
    RESOLUTION?: { width: number; height: number };
    CODECS?: string;
    AUDIO?: string;
  };
};

type ParsedManifest = {
  endList?: boolean;
  segments?: ParsedSegment[];
  playlists?: ParsedVariant[];
  mediaGroups?: {
    AUDIO?: Record<string, Record<string, { uri?: string; default?: boolean; autoselect?: boolean; language?: string }>>;
  };
};

const FALLBACK_BITRATE_BPS = 5_000_000;

function parseManifest(text: string): ParsedManifest {
  const parser = new Parser();
  try {
    parser.push(text);
    parser.end();
  } catch {
    throw new ParseError();
  }
  return parser.manifest as ParsedManifest;
}

async function fetchText(url: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { credentials: "include", signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new CancelledError();
    throw new NetworkError(err instanceof Error ? err.message : undefined);
  }
  if (res.status === 401 || res.status === 403) throw new AccessDeniedError();
  if (!res.ok) throw new NetworkError(`Status ${res.status}`);
  return await res.text();
}

async function fetchBytes(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchImpl(url, { credentials: "include", signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new CancelledError();
    throw new NetworkError(err instanceof Error ? err.message : undefined);
  }
  if (res.status === 401 || res.status === 403) throw new AccessDeniedError();
  if (!res.ok) throw new NetworkError(`Status ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchByteRange(
  url: string,
  offset: number,
  length: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const end = offset + length - 1;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      credentials: "include",
      signal,
      headers: { Range: `bytes=${offset}-${end}` },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new CancelledError();
    throw new NetworkError(err instanceof Error ? err.message : undefined);
  }
  if (res.status === 401 || res.status === 403) throw new AccessDeniedError();
  if (res.status === 416) throw new ByteRangeOutOfBoundsError();
  // 200 means the server ignored the Range header and sent the full resource.
  // Using the full body would silently produce huge / wrong segments, so
  // surface this rather than fall through.
  if (res.status === 200) throw new ByteRangeUnsupportedError();
  if (res.status !== 206 && !res.ok) throw new NetworkError(`Status ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Some servers honor 206 but return the full body anyway. Trim defensively
  // so callers get exactly the requested range length.
  if (bytes.length > length) return bytes.slice(0, length);
  return bytes;
}

async function fetchSegmentBytes(
  seg: ParsedSegment,
  baseUrl: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const url = resolveUrl(seg.uri, baseUrl);
  if (seg.byterange) {
    return fetchByteRange(url, seg.byterange.offset, seg.byterange.length, signal, fetchImpl);
  }
  return fetchBytes(url, signal, fetchImpl);
}

function resolveDefaultAudioRenditionUri(
  audioGroupId: string | undefined,
  groups: ParsedManifest["mediaGroups"],
): string | undefined {
  if (!audioGroupId) return undefined;
  const group = groups?.AUDIO?.[audioGroupId];
  if (!group) return undefined;
  const withUri = Object.values(group).filter((r) => Boolean(r.uri));
  if (withUri.length === 0) return undefined;
  const def = withUri.find((r) => r.default === true);
  return (def ?? withUri[0]).uri;
}

function pickVariant(
  parsed: ParsedManifest,
): { variant: ParsedVariant; bandwidth: number; audioRenditionUri?: string } {
  const variants = parsed.playlists ?? [];
  if (variants.length === 0) throw new EmptyManifestError();
  const sorted = [...variants].sort(
    (a, b) => (b.attributes.BANDWIDTH ?? 0) - (a.attributes.BANDWIDTH ?? 0),
  );
  const v = sorted[0];
  return {
    variant: v,
    bandwidth: v.attributes.BANDWIDTH ?? 0,
    audioRenditionUri: resolveDefaultAudioRenditionUri(v.attributes.AUDIO, parsed.mediaGroups),
  };
}

function validateVariant(parsed: ParsedManifest): void {
  if (!parsed.endList) throw new LiveStreamError();
  const segments = parsed.segments ?? [];
  for (const seg of segments) {
    if (seg.key && seg.key.method && seg.key.method.toUpperCase() !== "NONE") {
      throw new EncryptedStreamError();
    }
  }
}

// First segment's EXT-X-MAP info, if present. Carries the optional byterange
// (Apple-style single-file CMAF uses BYTERANGE on EXT-X-MAP to delimit the
// init box at the head of main.mp4). Assumes uniform map across the variant
// (true for VOD without mid-stream discontinuities — the common case).
function detectFmp4Init(segments: ParsedSegment[]): { uri: string; byterange?: ByteRange } | undefined {
  const map = segments[0]?.map;
  if (!map?.uri) return undefined;
  return { uri: map.uri, byterange: map.byterange };
}

function estimateSize(parsed: ParsedManifest, bandwidthBps: number): number {
  const segments = parsed.segments ?? [];
  const totalDuration = segments.reduce((sum, s) => sum + (s.duration ?? 0), 0);
  const bps = bandwidthBps > 0 ? bandwidthBps : FALLBACK_BITRATE_BPS;
  return (totalDuration * bps) / 8;
}

function resolveUrl(uri: string, base: string): string {
  return new URL(uri, base).href;
}

// Caller owns size-cap + progress accounting via onSegmentDone, so multiple
// concurrent streams (video + audio) can share a single running-bytes
// counter without re-implementing the worker pool per call.
async function fetchSegmentsConcurrent(
  segments: ParsedSegment[],
  baseUrl: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  onSegmentDone: (idx: number, bytes: number) => void,
): Promise<Uint8Array[]> {
  const total = segments.length;
  const buffers: Uint8Array[] = new Array(total);
  let nextIndex = 0;

  // Abort every worker the instant one fails, so a mid-stream error stops the
  // whole fetch instead of downloading every remaining segment into memory.
  const pool = new AbortController();
  const relayAbort = () => pool.abort();
  if (signal.aborted) pool.abort();
  else signal.addEventListener("abort", relayAbort, { once: true });

  async function worker(): Promise<void> {
    while (true) {
      if (pool.signal.aborted) throw new CancelledError();
      const idx = nextIndex++;
      if (idx >= total) return;
      try {
        const bytes = await fetchSegmentBytes(segments[idx], baseUrl, pool.signal, fetchImpl);
        buffers[idx] = bytes;
        onSegmentDone(idx, bytes.length);
      } catch (err) {
        pool.abort();
        throw err;
      }
    }
  }

  try {
    const concurrency = Math.min(HLS_SEGMENT_FETCH_CONCURRENCY, Math.max(total, 1));
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return buffers;
  } finally {
    signal.removeEventListener("abort", relayAbort);
  }
}

function concatBuffers(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export async function downloadHls(
  playlistUrl: string,
  opts: DownloadHlsOptions,
): Promise<Blob> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { signal, sizeCapBytes, onProgress } = opts;

  if (signal.aborted) throw new CancelledError();

  // === Step 1: resolve video variant + (optionally) audio rendition ===

  const playlistText = await fetchText(playlistUrl, signal, fetchImpl);
  const masterDrm = classifyHlsManifestForDrm(playlistText);
  if (masterDrm.protected) throw new DrmProtectedError(masterDrm.scheme);
  let parsed = parseManifest(playlistText);

  let bandwidthBps = 0;
  let variantUrl = playlistUrl;
  let audioRenditionUrl: string | undefined = opts.audioUrl;

  if (parsed.playlists && parsed.playlists.length > 0) {
    if (opts.variantUrl) {
      // Caller picked a specific variant — locate it to read AUDIO group when
      // opts.audioUrl wasn't pre-resolved.
      variantUrl = opts.variantUrl;
      const matched = parsed.playlists.find(
        (p) => resolveUrl(p.uri, playlistUrl) === opts.variantUrl,
      );
      bandwidthBps = matched?.attributes.BANDWIDTH ?? 0;
      if (!audioRenditionUrl && matched) {
        const renditionUri = resolveDefaultAudioRenditionUri(
          matched.attributes.AUDIO,
          parsed.mediaGroups,
        );
        if (renditionUri) audioRenditionUrl = resolveUrl(renditionUri, playlistUrl);
      }
    } else {
      const { variant, bandwidth, audioRenditionUri } = pickVariant(parsed);
      bandwidthBps = bandwidth;
      variantUrl = resolveUrl(variant.uri, playlistUrl);
      if (!audioRenditionUrl && audioRenditionUri) {
        audioRenditionUrl = resolveUrl(audioRenditionUri, playlistUrl);
      }
    }
    const variantText = await fetchText(variantUrl, signal, fetchImpl);
    const variantDrm = classifyHlsManifestForDrm(variantText);
    if (variantDrm.protected) throw new DrmProtectedError(variantDrm.scheme);
    parsed = parseManifest(variantText);
  }

  validateVariant(parsed);

  const videoSegments = parsed.segments ?? [];
  const videoInit = detectFmp4Init(videoSegments);

  // === Step 2: parse + validate audio rendition (if any) ===

  let audioSegments: ParsedSegment[] = [];
  let audioInit: { uri: string; byterange?: ByteRange } | undefined;
  let audioBaseUrl = "";

  if (audioRenditionUrl) {
    const audioText = await fetchText(audioRenditionUrl, signal, fetchImpl);
    const audioDrm = classifyHlsManifestForDrm(audioText);
    if (audioDrm.protected) throw new DrmProtectedError(audioDrm.scheme);
    const audioParsed = parseManifest(audioText);
    validateVariant(audioParsed);
    audioSegments = audioParsed.segments ?? [];
    audioInit = detectFmp4Init(audioSegments);
    audioBaseUrl = audioRenditionUrl;

    // Separate MPEG-TS audio can be transmuxed to fMP4 before muxing. The
    // selected video variant still needs to be fMP4 for the final MP4 muxer.
    if (!videoInit) {
      throw new MixedContainerAudioError();
    }
  }

  // === Step 3: size cap estimate ===

  const estimatedBytes = estimateSize(parsed, bandwidthBps);
  if (estimatedBytes > sizeCapBytes) throw new SizeCapError(sizeCapBytes);

  // === Step 4: fetch init segments (video + optional audio) ===

  let runningBytes = 0;
  const checkCap = () => {
    if (runningBytes > sizeCapBytes) throw new SizeCapError(sizeCapBytes);
  };

  const fetchInit = async (
    init: { uri: string; byterange?: ByteRange },
    baseUrl: string,
  ): Promise<Uint8Array> => {
    const url = resolveUrl(init.uri, baseUrl);
    if (init.byterange) {
      return fetchByteRange(url, init.byterange.offset, init.byterange.length, signal, fetchImpl);
    }
    return fetchBytes(url, signal, fetchImpl);
  };

  let videoInitBytes: Uint8Array | undefined;
  let audioInitBytes: Uint8Array | undefined;

  if (videoInit) {
    videoInitBytes = await fetchInit(videoInit, variantUrl);
    runningBytes += videoInitBytes.length;
    checkCap();
  }
  if (audioInit && audioRenditionUrl) {
    audioInitBytes = await fetchInit(audioInit, audioBaseUrl);
    runningBytes += audioInitBytes.length;
    checkCap();
  }

  // === Step 5: fetch media segments — parallel video + audio when both present ===

  const videoTotal = videoSegments.length;
  const audioTotal = audioSegments.length;
  let videoDone = 0;
  let audioDone = 0;
  const emitProgress = () => {
    onProgress({
      done: videoDone + audioDone,
      total: videoTotal + audioTotal,
      bytes: runningBytes,
    });
  };

  const videoFetch = fetchSegmentsConcurrent(
    videoSegments,
    variantUrl,
    signal,
    fetchImpl,
    (_idx, bytes) => {
      runningBytes += bytes;
      checkCap();
      videoDone += 1;
      emitProgress();
    },
  );

  const audioFetch = audioRenditionUrl
    ? fetchSegmentsConcurrent(
        audioSegments,
        audioBaseUrl,
        signal,
        fetchImpl,
        (_idx, bytes) => {
          runningBytes += bytes;
          checkCap();
          audioDone += 1;
          emitProgress();
        },
      )
    : Promise.resolve([] as Uint8Array[]);

  const [videoBuffers, audioBuffers] = await Promise.all([videoFetch, audioFetch]);

  // === Step 6: assemble output blob ===

  // Branch A: separate-audio fMP4 video + fMP4 or MPEG-TS AAC audio — mux
  // into a single MP4.
  if (audioRenditionUrl && videoInitBytes) {
    const videoBytes = concatBuffers([videoInitBytes, ...videoBuffers]);
    const audioBytes = audioInitBytes
      ? concatBuffers([audioInitBytes, ...audioBuffers])
      : transmuxTsAudioToFmp4(audioBuffers);
    const muxed = await muxFmp4(videoBytes, audioBytes);
    return new Blob([muxed as BlobPart], { type: "video/mp4" });
  }

  // Branch B: embedded-audio fMP4 (Cloudflare-shape) — pass single concatenated
  // stream through muxFmp4 to produce a non-fragmented MP4.
  if (videoInit && videoInitBytes) {
    const combined = concatBuffers([videoInitBytes, ...videoBuffers]);
    const muxed = await muxFmp4(combined);
    return new Blob([muxed as BlobPart], { type: "video/mp4" });
  }

  // Branch C: MPEG-TS embedded — transmux to MP4 so users do not need a
  // transport-stream-specific player.
  const muxed = transmuxTsToMp4(videoBuffers);
  return new Blob([muxed as BlobPart], { type: "video/mp4" });
}
