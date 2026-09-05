import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFile, MP4BoxBuffer } from "mp4box";
import { downloadHls } from "./hls-downloader";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(__dirname, "..", "..", "..", "fixtures", "video-test-page");
const BASE_URL = "https://fixture.test/";

type ParsedSample = {
  duration: number;
  dts: number;
};

type ParsedTrack = {
  id: number;
  type: string;
  codec: string;
  timescale: number;
  duration: number;
};

type ParsedOutputTrack = {
  type: string;
  codec: string;
  durationSec: number;
  firstDecodeTime: number;
};

function fixtureFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const bytes = readFileSync(resolve(FIXTURE_ROOT, relativePath));
    return new Response(bytes as unknown as BodyInit, { status: 200 });
  }) as typeof fetch;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function parseMp4Tracks(bytes: Uint8Array): ParsedOutputTrack[] {
  const iso = createFile() as unknown as {
    onReady: (info: { tracks: ParsedTrack[] }) => void;
    onError: (msg: string) => void;
    onSamples: (id: number, _u: unknown, batch: ParsedSample[]) => void;
    setExtractionOptions: (id: number, u: unknown, opts: { nbSamples: number }) => void;
    start: () => void;
    appendBuffer: (b: MP4BoxBuffer) => number;
    flush: () => void;
  };
  let tracks: ParsedTrack[] | null = null;
  const samplesByTrack = new Map<number, ParsedSample[]>();

  iso.onReady = (info) => {
    tracks = info.tracks;
    for (const track of info.tracks) {
      samplesByTrack.set(track.id, []);
      iso.setExtractionOptions(track.id, null, { nbSamples: 1_000_000 });
    }
    iso.start();
  };
  iso.onSamples = (id, _u, batch) => {
    samplesByTrack.get(id)?.push(...batch);
  };
  iso.onError = (msg) => {
    throw new Error(`mp4box parse error: ${msg}`);
  };

  const buf = MP4BoxBuffer.fromArrayBuffer(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    0,
  );
  iso.appendBuffer(buf);
  iso.flush();

  const readyTracks = tracks as ParsedTrack[] | null;
  if (!readyTracks) throw new Error("Parse produced no Movie info");
  return readyTracks.map((track: ParsedTrack) => {
    const samples = samplesByTrack.get(track.id) ?? [];
    if (samples.length === 0) throw new Error(`Track ${track.id} has no samples`);
    const sampleDuration = samples.reduce((sum, sample) => sum + sample.duration, 0);
    return {
      type: track.type,
      codec: track.codec,
      durationSec: sampleDuration / track.timescale,
      firstDecodeTime: samples[0].dts,
    };
  });
}

async function downloadAndParse(path: string): Promise<ParsedOutputTrack[]> {
  const blob = await downloadHls(new URL(path, BASE_URL).toString(), {
    onProgress: () => {},
    signal: new AbortController().signal,
    sizeCapBytes: 20 * 1024 * 1024,
    fetchImpl: fixtureFetch(),
  });

  expect(blob.type).toBe("video/mp4");
  expect(blob.size).toBeGreaterThan(0);
  return parseMp4Tracks(await blobBytes(blob));
}

function expectSyncedAvcAndAacTracks(tracks: ParsedOutputTrack[]): {
  video: ParsedOutputTrack;
  audio: ParsedOutputTrack;
} {
  expect(tracks).toHaveLength(2);
  const video = tracks.find((track) => track.type === "video");
  const audio = tracks.find((track) => track.type === "audio");
  expect(video, "output should contain a video track").toBeDefined();
  expect(audio, "output should contain an audio track").toBeDefined();

  expect(video!.codec).toMatch(/^avc1\./);
  expect(audio!.codec).toMatch(/^mp4a\./);
  expect(video!.durationSec).toBeGreaterThanOrEqual(3.8);
  expect(video!.durationSec).toBeLessThanOrEqual(4.2);
  expect(audio!.durationSec).toBeGreaterThanOrEqual(3.8);
  expect(audio!.durationSec).toBeLessThanOrEqual(4.2);
  expect(Math.abs(video!.durationSec - audio!.durationSec)).toBeLessThanOrEqual(0.15);
  expect(video!.firstDecodeTime).toBe(audio!.firstDecodeTime);

  return { video: video!, audio: audio! };
}

describe("downloadHls integration — MPEG-TS video with separate MPEG-TS audio", () => {
  it("downloads a clear HLS master as one synced MP4 with video and audio tracks", async () => {
    const tracks = await downloadAndParse("hls-master-separate-audio-ts/master.m3u8");
    const { video, audio } = expectSyncedAvcAndAacTracks(tracks);
    console.info("clear separate TS metrics", {
      videoDurationSec: video.durationSec,
      audioDurationSec: audio.durationSec,
      videoFirstDecodeTime: video.firstDecodeTime,
      audioFirstDecodeTime: audio.firstDecodeTime,
    });
  });

  it("decrypts AES-128 renditions and downloads one synced MP4 with video and audio tracks", async () => {
    const tracks = await downloadAndParse("hls-master-separate-audio-ts-aes/master.m3u8");
    const { video, audio } = expectSyncedAvcAndAacTracks(tracks);
    console.info("aes separate TS metrics", {
      videoDurationSec: video.durationSec,
      audioDurationSec: audio.durationSec,
      videoFirstDecodeTime: video.firstDecodeTime,
      audioFirstDecodeTime: audio.firstDecodeTime,
    });
  });
});
