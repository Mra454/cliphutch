import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFile, MP4BoxBuffer } from "mp4box";
import { downloadHls } from "./hls-downloader";
import {
  buildHlsCryptoPlan,
  createKeyCache,
  decryptAes128Cbc,
  ivForSegment,
} from "./hls-crypto-plan";
import { transmuxTsAudioToFmp4, transmuxTsVideoToFmp4 } from "./ts-audio-to-fmp4";

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

type AnyBox = {
  type?: string;
  boxes?: AnyBox[];
};

type AnyTrak = AnyBox & {
  tkhd: { track_id: number };
};

type EditListEntry = {
  segment_duration: number;
  media_time: number;
};

type ParsedOutputTrack = {
  type: string;
  codec: string;
  durationSec: number;
  mediaStartSec: number;
  presentationStartSec: number;
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

function mediaUris(playlistText: string): string[] {
  return playlistText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function playlistSegments(relativePlaylistPath: string): Promise<Uint8Array[]> {
  const playlistPath = resolve(FIXTURE_ROOT, relativePlaylistPath);
  const playlistText = readFileSync(playlistPath, "utf8");
  const playlistUrl = new URL(relativePlaylistPath, BASE_URL).toString();
  const segmentPlan = buildHlsCryptoPlan(playlistText, playlistUrl).segments;
  const keyCache = createKeyCache(fixtureFetch(), new AbortController().signal);
  const playlistDir = dirname(playlistPath);

  return Promise.all(mediaUris(playlistText).map(async (uri, index) => {
    const crypto = segmentPlan[index];
    const bytes = new Uint8Array(readFileSync(resolve(playlistDir, uri)));
    if (crypto.key.method !== "AES-128") return bytes;
    const key = await keyCache.getKey(crypto.key.keyUri);
    return decryptAes128Cbc(key, ivForSegment(crypto), bytes);
  }));
}

async function expectedSourceStartDifference(fixtureName: string): Promise<number> {
  const video = transmuxTsVideoToFmp4(
    await playlistSegments(`${fixtureName}/video/playlist.m3u8`),
  );
  const audio = transmuxTsAudioToFmp4(
    await playlistSegments(`${fixtureName}/audio/playlist.m3u8`),
  );
  const [videoTrack] = parseMp4Tracks(video);
  const [audioTrack] = parseMp4Tracks(audio);
  return audioTrack.mediaStartSec - videoTrack.mediaStartSec;
}

function findChild(parent: AnyBox | undefined, type: string): AnyBox | undefined {
  return parent?.boxes?.find((box) => box.type === type);
}

function editListEntries(trak: AnyTrak | undefined): EditListEntry[] | undefined {
  const edts = findChild(trak, "edts");
  const elst = findChild(edts, "elst") as (AnyBox & { entries?: EditListEntry[] }) | undefined;
  return elst?.entries;
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
    moov: { mvhd: { timescale: number }; traks: AnyTrak[] };
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
    const mediaStartSec = Math.min(...samples.map((sample) => sample.dts)) / track.timescale;
    const trak = iso.moov.traks.find((candidate) => candidate.tkhd.track_id === track.id);
    const emptyEdit = editListEntries(trak)?.find((entry) => entry.media_time === -1);
    const presentationStartSec = emptyEdit === undefined
      ? 0
      : emptyEdit.segment_duration / iso.moov.mvhd.timescale;
    return {
      type: track.type,
      codec: track.codec,
      durationSec: sampleDuration / track.timescale,
      mediaStartSec,
      presentationStartSec,
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

function expectSyncedAvcAndAacTracks(
  tracks: ParsedOutputTrack[],
  expectedStartDifferenceSec: number,
): {
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
  expect(
    Math.abs(
      (audio!.presentationStartSec - video!.presentationStartSec) -
        expectedStartDifferenceSec,
    ),
  ).toBeLessThanOrEqual(0.005);

  return { video: video!, audio: audio! };
}

describe("downloadHls integration — MPEG-TS video with separate MPEG-TS audio", () => {
  it("downloads a clear HLS master as one synced MP4 with video and audio tracks", async () => {
    const expectedStartDifferenceSec = await expectedSourceStartDifference(
      "hls-master-separate-audio-ts",
    );
    const tracks = await downloadAndParse("hls-master-separate-audio-ts/master.m3u8");
    const { video, audio } = expectSyncedAvcAndAacTracks(tracks, expectedStartDifferenceSec);
    console.info("clear separate TS metrics", {
      videoDurationSec: video.durationSec,
      audioDurationSec: audio.durationSec,
      sourceStartDifferenceSec: expectedStartDifferenceSec,
      muxedStartDifferenceSec: audio.presentationStartSec - video.presentationStartSec,
    });
  });

  it("decrypts AES-128 renditions and downloads one synced MP4 with video and audio tracks", async () => {
    const expectedStartDifferenceSec = await expectedSourceStartDifference(
      "hls-master-separate-audio-ts-aes",
    );
    const tracks = await downloadAndParse("hls-master-separate-audio-ts-aes/master.m3u8");
    const { video, audio } = expectSyncedAvcAndAacTracks(tracks, expectedStartDifferenceSec);
    console.info("aes separate TS metrics", {
      videoDurationSec: video.durationSec,
      audioDurationSec: audio.durationSec,
      sourceStartDifferenceSec: expectedStartDifferenceSec,
      muxedStartDifferenceSec: audio.presentationStartSec - video.presentationStartSec,
    });
  });

  it("downloads an offset HLS master with the source audio delay preserved", async () => {
    const expectedStartDifferenceSec = await expectedSourceStartDifference(
      "hls-master-separate-audio-ts-offset",
    );
    const tracks = await downloadAndParse("hls-master-separate-audio-ts-offset/master.m3u8");
    const { video, audio } = expectSyncedAvcAndAacTracks(tracks, expectedStartDifferenceSec);
    console.info("offset separate TS metrics", {
      videoDurationSec: video.durationSec,
      audioDurationSec: audio.durationSec,
      sourceStartDifferenceSec: expectedStartDifferenceSec,
      muxedStartDifferenceSec: audio.presentationStartSec - video.presentationStartSec,
    });
  });
});
