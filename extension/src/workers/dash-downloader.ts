// DASH downloader. Counterpart to hls-downloader: takes an MPD URL, parses
// the manifest, picks the highest-bandwidth (or caller-specified) video
// Representation and the first audio Representation (if any), fetches
// init + media segments concurrently, muxes the resulting fMP4 video and
// audio buffers into a single non-fragmented MP4 via mp4box.js, and
// returns a single Blob ready for chrome.downloads.download.

import {
  AccessDeniedError,
  ByteRangeError,
  CancelledError,
  DrmProtectedError,
  EmptyManifestError,
  LiveStreamError,
  NetworkError,
  ParseError,
  SizeCapError,
} from "../lib/errors";
import { HLS_SEGMENT_FETCH_CONCURRENCY } from "../lib/constants";
import { DashParseError, parseMpd, pickHighestBandwidth } from "../lib/dash";
import { muxFmp4 } from "./dash-mux";

export type DashProgress = {
  videoDone: number;
  videoTotal: number;
  audioDone: number;
  audioTotal: number;
  bytes: number;
};

export type DownloadDashOptions = {
  onProgress: (p: DashProgress) => void;
  signal: AbortSignal;
  sizeCapBytes: number;
  fetchImpl?: typeof fetch;
  // When set, look up the video Representation by this @id instead of
  // auto-picking the highest-bandwidth one.
  videoRepresentationId?: string;
};

const FALLBACK_BITRATE_BPS = 5_000_000;

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

async function fetchText(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<string> {
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

async function fetchSegmentsConcurrent(
  urls: string[],
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  onSegmentDone: (idx: number, bytes: number) => void,
): Promise<Uint8Array[]> {
  const total = urls.length;
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
        const bytes = await fetchBytes(urls[idx], pool.signal, fetchImpl);
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

function concat(buffers: Uint8Array[]): Uint8Array {
  const total = buffers.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

export async function downloadDash(
  manifestUrl: string,
  opts: DownloadDashOptions,
): Promise<Blob> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { signal, sizeCapBytes, onProgress } = opts;

  if (signal.aborted) throw new CancelledError();

  const manifestText = await fetchText(manifestUrl, signal, fetchImpl);
  let manifest: ReturnType<typeof parseMpd>;
  try {
    manifest = parseMpd(manifestText, manifestUrl);
  } catch (err) {
    if (err instanceof DashParseError) throw new ParseError();
    throw err;
  }

  if (manifest.drm.protected) throw new DrmProtectedError(manifest.drm.scheme);
  if (manifest.type === "dynamic") throw new LiveStreamError();
  if (manifest.unsupportedShape === "byterange") throw new ByteRangeError();
  if (manifest.video.length === 0) throw new EmptyManifestError();

  const videoRep = opts.videoRepresentationId
    ? manifest.video.find((r) => r.id === opts.videoRepresentationId) ??
      pickHighestBandwidth(manifest.video)
    : pickHighestBandwidth(manifest.video);
  if (!videoRep) throw new EmptyManifestError();
  const audioRep = manifest.audio[0];

  const videoBitrate = videoRep.bandwidth || FALLBACK_BITRATE_BPS;
  const audioBitrate = audioRep?.bandwidth ?? 0;
  const totalBitrate = videoBitrate + audioBitrate;
  const estimatedBytes = manifest.durationSec
    ? (manifest.durationSec * totalBitrate) / 8
    : 0;
  if (estimatedBytes > 0 && estimatedBytes > sizeCapBytes) {
    throw new SizeCapError(sizeCapBytes);
  }

  const videoTotal = videoRep.mediaSegmentUrls.length;
  const audioTotal = audioRep?.mediaSegmentUrls.length ?? 0;
  let videoDone = 0;
  let audioDone = 0;
  let runningBytes = 0;

  function emitProgress(): void {
    onProgress({ videoDone, videoTotal, audioDone, audioTotal, bytes: runningBytes });
  }

  function trackVideo(_idx: number, bytes: number): void {
    runningBytes += bytes;
    if (runningBytes > sizeCapBytes) throw new SizeCapError(sizeCapBytes);
    videoDone += 1;
    emitProgress();
  }

  function trackAudio(_idx: number, bytes: number): void {
    runningBytes += bytes;
    if (runningBytes > sizeCapBytes) throw new SizeCapError(sizeCapBytes);
    audioDone += 1;
    emitProgress();
  }

  const videoBuffers: Uint8Array[] = [];
  if (videoRep.initSegmentUrl) {
    const init = await fetchBytes(videoRep.initSegmentUrl, signal, fetchImpl);
    runningBytes += init.length;
    if (runningBytes > sizeCapBytes) throw new SizeCapError(sizeCapBytes);
    videoBuffers.push(init);
  }
  const videoMedia = await fetchSegmentsConcurrent(
    videoRep.mediaSegmentUrls,
    signal,
    fetchImpl,
    trackVideo,
  );
  videoBuffers.push(...videoMedia);

  let audioBuffers: Uint8Array[] | undefined;
  if (audioRep) {
    audioBuffers = [];
    if (audioRep.initSegmentUrl) {
      const init = await fetchBytes(audioRep.initSegmentUrl, signal, fetchImpl);
      runningBytes += init.length;
      if (runningBytes > sizeCapBytes) throw new SizeCapError(sizeCapBytes);
      audioBuffers.push(init);
    }
    const audioMedia = await fetchSegmentsConcurrent(
      audioRep.mediaSegmentUrls,
      signal,
      fetchImpl,
      trackAudio,
    );
    audioBuffers.push(...audioMedia);
  }

  const videoBytes = concat(videoBuffers);
  const audioBytes = audioBuffers ? concat(audioBuffers) : undefined;

  const muxed = await muxFmp4(videoBytes, audioBytes);
  return new Blob([muxed as BlobPart], { type: "video/mp4" });
}
