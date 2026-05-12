import { Parser } from "m3u8-parser";
import {
  AccessDeniedError,
  ByteRangeError,
  CancelledError,
  DrmProtectedError,
  EncryptedStreamError,
  LiveStreamError,
  NetworkError,
  ParseError,
  SeparateAudioError,
  SizeCapError,
} from "../lib/errors";
import { classifyHlsManifestForDrm } from "../lib/drm";
import { HLS_SEGMENT_FETCH_CONCURRENCY } from "../lib/constants";
import { muxFmp4 } from "./dash-mux";

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
  // When set, skip pickEmbeddedVariant and use this resolved variant URL.
  // Takes precedence over the highest-bandwidth auto-pick.
  variantUrl?: string;
};

type ParsedSegment = {
  uri: string;
  duration?: number;
  key?: { method?: string; uri?: string };
  map?: { uri?: string };
  byterange?: { length: number; offset: number };
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

function variantHasSeparateAudio(
  v: ParsedVariant,
  groups: ParsedManifest["mediaGroups"],
): boolean {
  const audioGroupId = v.attributes.AUDIO;
  if (!audioGroupId) return false;
  const group = groups?.AUDIO?.[audioGroupId];
  if (!group) return false;
  return Object.values(group).some((rendition) => Boolean(rendition.uri));
}

function pickEmbeddedVariant(
  parsed: ParsedManifest,
): { variant: ParsedVariant; bandwidth: number } {
  const variants = parsed.playlists ?? [];
  const candidates = variants
    .filter((v) => !variantHasSeparateAudio(v, parsed.mediaGroups))
    .sort((a, b) => (b.attributes.BANDWIDTH ?? 0) - (a.attributes.BANDWIDTH ?? 0));
  if (candidates.length === 0) throw new SeparateAudioError();
  const v = candidates[0];
  return { variant: v, bandwidth: v.attributes.BANDWIDTH ?? 0 };
}

function validateVariant(parsed: ParsedManifest): void {
  if (!parsed.endList) throw new LiveStreamError();
  const segments = parsed.segments ?? [];
  for (const seg of segments) {
    if (seg.byterange) throw new ByteRangeError();
    if (seg.key && seg.key.method && seg.key.method.toUpperCase() !== "NONE") {
      throw new EncryptedStreamError();
    }
  }
}

// First segment's EXT-X-MAP URI, if present. Assumes uniform map across the
// variant (true for VOD without mid-stream discontinuities — the common case).
function detectFmp4InitUri(segments: ParsedSegment[]): string | undefined {
  return segments[0]?.map?.uri;
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

async function fetchSegmentsConcurrent(
  segments: ParsedSegment[],
  baseUrl: string,
  sizeCapBytes: number,
  onProgress: (p: HlsProgress) => void,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<Uint8Array[]> {
  const total = segments.length;
  const buffers: Uint8Array[] = new Array(total);
  let runningBytes = 0;
  let done = 0;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (signal.aborted) throw new CancelledError();
      const idx = nextIndex++;
      if (idx >= total) return;
      const seg = segments[idx];
      const url = resolveUrl(seg.uri, baseUrl);
      const bytes = await fetchBytes(url, signal, fetchImpl);
      runningBytes += bytes.length;
      if (runningBytes > sizeCapBytes) throw new SizeCapError(sizeCapBytes);
      buffers[idx] = bytes;
      done += 1;
      onProgress({ done, total, bytes: runningBytes });
    }
  }

  const concurrency = Math.min(HLS_SEGMENT_FETCH_CONCURRENCY, Math.max(total, 1));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return buffers;
}

export async function downloadHls(
  playlistUrl: string,
  opts: DownloadHlsOptions,
): Promise<Blob> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { signal, sizeCapBytes, onProgress } = opts;

  if (signal.aborted) throw new CancelledError();

  const playlistText = await fetchText(playlistUrl, signal, fetchImpl);
  const masterDrm = classifyHlsManifestForDrm(playlistText);
  if (masterDrm.protected) throw new DrmProtectedError(masterDrm.scheme);
  let parsed = parseManifest(playlistText);

  let bandwidthBps = 0;
  let variantUrl = playlistUrl;

  if (parsed.playlists && parsed.playlists.length > 0) {
    if (opts.variantUrl) {
      // Caller picked a specific variant — skip pickEmbeddedVariant and use it.
      variantUrl = opts.variantUrl;
      const matched = parsed.playlists.find(
        (p) => resolveUrl(p.uri, playlistUrl) === opts.variantUrl,
      );
      bandwidthBps = matched?.attributes.BANDWIDTH ?? 0;
    } else {
      const { variant, bandwidth } = pickEmbeddedVariant(parsed);
      bandwidthBps = bandwidth;
      variantUrl = resolveUrl(variant.uri, playlistUrl);
    }
    const variantText = await fetchText(variantUrl, signal, fetchImpl);
    const variantDrm = classifyHlsManifestForDrm(variantText);
    if (variantDrm.protected) throw new DrmProtectedError(variantDrm.scheme);
    parsed = parseManifest(variantText);
  }

  validateVariant(parsed);

  const estimatedBytes = estimateSize(parsed, bandwidthBps);
  if (estimatedBytes > sizeCapBytes) throw new SizeCapError(sizeCapBytes);

  const segments = parsed.segments ?? [];
  const fmp4InitUri = detectFmp4InitUri(segments);

  let initBytes: Uint8Array | undefined;
  if (fmp4InitUri) {
    initBytes = await fetchBytes(resolveUrl(fmp4InitUri, variantUrl), signal, fetchImpl);
    if (initBytes.length > sizeCapBytes) throw new SizeCapError(sizeCapBytes);
  }

  const buffers = await fetchSegmentsConcurrent(
    segments,
    variantUrl,
    sizeCapBytes - (initBytes?.length ?? 0),
    onProgress,
    signal,
    fetchImpl,
  );

  if (fmp4InitUri && initBytes) {
    const mediaLength = buffers.reduce((sum, b) => sum + b.length, 0);
    const combined = new Uint8Array(initBytes.length + mediaLength);
    combined.set(initBytes, 0);
    let offset = initBytes.length;
    for (const b of buffers) {
      combined.set(b, offset);
      offset += b.length;
    }
    const muxed = await muxFmp4(combined);
    return new Blob([muxed as BlobPart], { type: "video/mp4" });
  }

  const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);
  const concat = new Uint8Array(totalLength);
  let offset = 0;
  for (const b of buffers) {
    concat.set(b, offset);
    offset += b.length;
  }

  return new Blob([concat], { type: "video/mp2t" });
}
