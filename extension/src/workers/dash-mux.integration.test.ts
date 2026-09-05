// Integration test: run muxFmp4 against real fMP4 fixtures (a tiny slice of
// the Big Buck Bunny DASH-IF test stream — see extension/fixtures/dash-test/
// README.md for provenance) and prove the OUTPUT parses cleanly with both
// codec config records intact. This test exists because the unit test for
// dash-downloader mocks out muxFmp4, so without this the mp4box.js code
// paths have no automated coverage. The chain
//
//   f5f5039 → 7ce6153 → 0f1c8bd → d501b08
//
// shipped four "fixed" muxer commits while real bugs (extra disk download,
// black video, silent audio) survived because none of those commits actually
// ran the muxer end-to-end.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFile, MP4BoxBuffer } from "mp4box";
import { inspectFmp4Init, muxFmp4 } from "./dash-mux";
import { transmuxTsAudioToFmp4, transmuxTsVideoToFmp4 } from "./ts-audio-to-fmp4";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "..", "..", "fixtures", "dash-test");
const VIDEO_PATH = resolve(FIXTURES_DIR, "video.m4v");
const AUDIO_PATH = resolve(FIXTURES_DIR, "audio.m4a");
const HLS_FIXTURES_DIR = resolve(__dirname, "..", "..", "..", "fixtures", "video-test-page");
const OFFSET_FIXTURE_DIR = resolve(HLS_FIXTURES_DIR, "hls-master-separate-audio-ts-offset");

const fixturesPresent = existsSync(VIDEO_PATH) && existsSync(AUDIO_PATH);

type AnyBox = {
  type?: string;
  boxes?: AnyBox[];
  data?: Uint8Array;
  size?: number;
  hdr_size?: number;
};
type ParsedFile = {
  tracks: Array<{
    id: number;
    codec: string;
    nb_samples: number;
    type: "video" | "audio" | string;
    timescale: number;
  }>;
  // mp4box's traks shorthand on moov
  moov: { mvhd: { timescale: number; duration: number }; traks: Array<AnyTrak> };
};
type AnyTrak = {
  boxes?: AnyBox[];
  tkhd: { track_id: number; volume: number; duration: number };
  mdia: {
    hdlr: { handler: string };
    minf: { stbl: { stsd: { entries: AnyBox[] } } };
  };
};
type ParsedSample = {
  duration: number;
  dts: number;
};
type EditListEntry = {
  segment_duration: number;
  media_time: number;
  media_rate_integer: number;
  media_rate_fraction: number;
};

function findChild(parent: AnyBox | undefined, type: string): AnyBox | undefined {
  return parent?.boxes?.find((b) => b.type === type);
}

function editListEntries(trak: AnyTrak | undefined): EditListEntry[] | undefined {
  const edts = findChild(trak as AnyBox | undefined, "edts");
  const elst = findChild(edts, "elst") as (AnyBox & { entries?: EditListEntry[] }) | undefined;
  return elst?.entries;
}

function parseToFile(bytes: Uint8Array): {
  info: ParsedFile;
  sampleCount: number;
  samplesByTrack: Map<number, ParsedSample[]>;
} {
  // Cast the mp4box createFile result to a minimal shape we control.
  const iso = createFile() as unknown as {
    onReady: (info: ParsedFile) => void;
    onError: (msg: string) => void;
    onSamples: (id: number, _u: unknown, batch: ParsedSample[]) => void;
    setExtractionOptions: (id: number, u: unknown, opts: { nbSamples: number }) => void;
    start: () => void;
    appendBuffer: (b: MP4BoxBuffer) => number;
    flush: () => void;
    moov: { mvhd: { timescale: number; duration: number }; traks: AnyTrak[] };
  };
  let info: ParsedFile | null = null;
  let sampleCount = 0;
  const samplesByTrack = new Map<number, ParsedSample[]>();
  iso.onReady = (i) => {
    info = i;
    for (const t of i.tracks) {
      samplesByTrack.set(t.id, []);
      iso.setExtractionOptions(t.id, null, { nbSamples: 1_000_000 });
    }
    iso.start();
  };
  iso.onSamples = (id, _u, batch) => {
    sampleCount += batch.length;
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
  const parsedInfo = info as ParsedFile | null;
  if (!parsedInfo) throw new Error("Parse produced no Movie info");
  // Splice in the moov reference for downstream avcC / esds inspection.
  return { info: { ...parsedInfo, moov: iso.moov }, sampleCount, samplesByTrack };
}

function playlistSegments(directory: string, playlistName = "playlist.m3u8"): Uint8Array[] {
  const playlist = readFileSync(resolve(directory, playlistName), "utf8");
  return playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => new Uint8Array(readFileSync(resolve(directory, line))));
}

function firstSampleStartSec(bytes: Uint8Array): {
  type: string;
  startSec: number;
  mediaDurationSec: number;
} {
  const { info, samplesByTrack } = parseToFile(bytes);
  expect(info.tracks).toHaveLength(1);
  const track = info.tracks[0];
  const samples = samplesByTrack.get(track.id) ?? [];
  if (samples.length === 0) throw new Error(`Track ${track.id} has no samples`);
  const firstDts = Math.min(...samples.map((sample) => sample.dts));
  const sampleDuration = samples.reduce((sum, sample) => sum + sample.duration, 0);
  return {
    type: track.type,
    startSec: firstDts / track.timescale,
    mediaDurationSec: sampleDuration / track.timescale,
  };
}

function outputTrackTiming(
  parsed: ReturnType<typeof parseToFile>,
  type: "video" | "audio",
): {
  trak: AnyTrak;
  presentationStartSec: number;
  mediaDurationSec: number;
  presentationLengthSec: number;
} {
  const track = parsed.info.tracks.find((candidate) => candidate.type === type);
  expect(track, `output should contain a ${type} track`).toBeDefined();
  const trak = parsed.info.moov.traks.find((candidate) => candidate.tkhd.track_id === track!.id);
  expect(trak, `output should contain a ${type} trak`).toBeDefined();
  const entries = editListEntries(trak);
  const emptyEdit = entries?.find((entry) => entry.media_time === -1);
  const presentationStartSec = emptyEdit === undefined
    ? 0
    : emptyEdit.segment_duration / parsed.info.moov.mvhd.timescale;
  const samples = parsed.samplesByTrack.get(track!.id) ?? [];
  const sampleDuration = samples.reduce((sum, sample) => sum + sample.duration, 0);
  const mediaDurationSec = sampleDuration / track!.timescale;
  return {
    trak: trak!,
    presentationStartSec,
    mediaDurationSec,
    presentationLengthSec: presentationStartSec + mediaDurationSec,
  };
}

function expectNoPositiveEmptyEdit(trak: AnyTrak | undefined, movieTimescale: number): void {
  const entries = editListEntries(trak);
  const emptyEdit = entries?.find((entry) => entry.media_time === -1);
  expect(
    emptyEdit === undefined || emptyEdit.segment_duration / movieTimescale <= 0.001,
  ).toBe(true);
}

function makeSyntheticInit(types: Array<"avc1" | "mp4a" | "encv">): Uint8Array {
  const iso = createFile() as unknown as {
    addTrack: (opts: Record<string, unknown>) => number | undefined;
    getBuffer: () => { buffer: ArrayBuffer };
  };
  for (const [index, type] of types.entries()) {
    const isAudio = type === "mp4a";
    const id = iso.addTrack({
      id: index + 1,
      type,
      timescale: 48_000,
      duration: 0,
      hdlr: isAudio ? "soun" : "vide",
      width: isAudio ? undefined : 16,
      height: isAudio ? undefined : 16,
      channel_count: isAudio ? 2 : undefined,
      samplerate: isAudio ? 48_000 : undefined,
      samplesize: isAudio ? 16 : undefined,
    });
    if (id === undefined) throw new Error(`Could not synthesize ${type} track`);
  }
  return new Uint8Array(iso.getBuffer().buffer);
}

describe("inspectFmp4Init", () => {
  it("reports embedded multi-track init metadata without extracting samples", () => {
    const result = inspectFmp4Init(makeSyntheticInit(["avc1", "mp4a"]));
    expect(result.trackCount).toBe(2);
    expect(result.trackTypes).toEqual(["video", "audio"]);
    expect(result.encrypted).toBe(false);
  });

  it("detects an encrypted video sample entry", () => {
    const result = inspectFmp4Init(makeSyntheticInit(["encv"]));
    expect(result.trackCount).toBe(1);
    expect(result.encrypted).toBe(true);
  });
});

describe("dash-mux integration (real fMP4 fixtures)", () => {
  if (!fixturesPresent) {
    it.skip(`fixtures missing — see ${FIXTURES_DIR}/README.md`, () => {});
    return;
  }

  const videoBytes = new Uint8Array(readFileSync(VIDEO_PATH));
  const audioBytes = new Uint8Array(readFileSync(AUDIO_PATH));

  it("muxes a video + audio fMP4 pair into a single MP4 with both codec configs", async () => {
    const muxed = await muxFmp4(videoBytes, audioBytes);
    expect(muxed.byteLength).toBeGreaterThan(0);

    const { info, sampleCount } = parseToFile(muxed);

    // 2 tracks
    expect(info.tracks.length).toBe(2);

    const videoTrack = info.tracks.find((t) => t.type === "video");
    const audioTrack = info.tracks.find((t) => t.type === "audio");
    expect(videoTrack, "output should contain a video track").toBeDefined();
    expect(audioTrack, "output should contain an audio track").toBeDefined();

    // Track type: hdlr.handler must be "vide" / "soun". mp4box defaults to
    // "vide" for every track unless overridden — without our fix, audio
    // tracks ship with "vide" handler, ffprobe reads them as
    // "Video: none (mp4a)", every decoder silently ignores audio.
    const videoTrak = info.moov.traks.find((t) => t.tkhd.track_id === videoTrack!.id);
    const audioTrak = info.moov.traks.find((t) => t.tkhd.track_id === audioTrack!.id);
    expect(videoTrak).toBeDefined();
    expect(audioTrak).toBeDefined();
    expect(videoTrak!.mdia.hdlr.handler).toBe("vide");
    expect(audioTrak!.mdia.hdlr.handler).toBe("soun");

    // tkhd.volume: ISO 14496-12 §8.3.2 — video = 0 (mute), audio = 1 (full).
    // mp4box's addTrack hardcodes volume = 1 for everything; we override
    // for video. Strict decoders (Apple AVFoundation) enforce this.
    expect(videoTrak!.tkhd.volume).toBe(0);
    expect(audioTrak!.tkhd.volume).toBe(1);

    // Video sample entry should have an avcC child with non-empty SPS+PPS
    const videoEntry = videoTrak!.mdia.minf.stbl.stsd.entries[0];
    const avcC = findChild(videoEntry, "avcC") as
      | (AnyBox & { SPS?: Array<{ length: number; data: Uint8Array }>; PPS?: Array<{ length: number; data: Uint8Array }> })
      | undefined;
    expect(avcC, "video sample entry should carry an avcC child").toBeDefined();
    expect(avcC!.SPS?.length ?? 0).toBeGreaterThan(0);
    expect(avcC!.PPS?.length ?? 0).toBeGreaterThan(0);
    expect(avcC!.SPS![0].data.byteLength).toBeGreaterThan(0);
    expect(avcC!.PPS![0].data.byteLength).toBeGreaterThan(0);

    // Audio sample entry should have an esds child with a non-empty body
    // AND the body length should match the FullBox-aware (size - 12)
    // expectation. mp4box's default round-trip captures (size - 8) bytes
    // into this.data — including the 4-byte version+flags prefix — and
    // the writer then emits version+flags TWICE, corrupting the
    // descriptor by 4 bytes. The d501b08 patch had to be made
    // unconditional in ce90562 to actually fix it; this test catches
    // the off-by-4 if the patch ever regresses.
    const audioEntry = audioTrak!.mdia.minf.stbl.stsd.entries[0];
    const muxedEsds = findChild(audioEntry, "esds");
    expect(muxedEsds, "audio sample entry should carry an esds child").toBeDefined();
    expect(muxedEsds!.data?.byteLength ?? 0).toBeGreaterThan(0);

    // Source's esds bytes should round-trip identically into the muxed
    // output (codec-copy mux preserves the descriptor). If the muxer
    // injects the 4 spurious version+flags bytes, this comparison fails.
    const srcAudioParsed = parseToFile(audioBytes);
    const srcAudioTrak = srcAudioParsed.info.moov.traks[0];
    const srcEsds = findChild(srcAudioTrak.mdia.minf.stbl.stsd.entries[0], "esds");
    expect(srcEsds, "source audio should have an esds to compare against").toBeDefined();
    // Both should have the same body length (size - 12 for FullBox)
    expect(muxedEsds!.data?.byteLength).toBe(srcEsds!.data?.byteLength);
    // And byte-for-byte content
    expect(Array.from(muxedEsds!.data!)).toEqual(Array.from(srcEsds!.data!));

    // Sample counts: parseToFile counts every sample emitted via onSamples
    // across all tracks. That should equal video samples + audio samples
    // copied into the muxed output.
    const { sampleCount: videoSourceSamples } = parseToFile(videoBytes);
    const { sampleCount: audioSourceSamples } = parseToFile(audioBytes);
    expect(sampleCount).toBe(videoSourceSamples + audioSourceSamples);
  });

  it("muxes video-only when no audio is provided", async () => {
    const muxed = await muxFmp4(videoBytes);
    expect(muxed.byteLength).toBeGreaterThan(0);
    const { info } = parseToFile(muxed);
    expect(info.tracks.length).toBe(1);
    expect(info.tracks[0].type).toBe("video");
  });

  it("preserves cross-rendition start offsets with an edit list", async () => {
    const offsetVideo = transmuxTsVideoToFmp4(playlistSegments(resolve(OFFSET_FIXTURE_DIR, "video")));
    const offsetAudio = transmuxTsAudioToFmp4(playlistSegments(resolve(OFFSET_FIXTURE_DIR, "audio")));
    const sourceVideo = firstSampleStartSec(offsetVideo);
    const sourceAudio = firstSampleStartSec(offsetAudio);
    const expectedDelay = sourceAudio.startSec - sourceVideo.startSec;
    expect(expectedDelay).toBeGreaterThan(0.4);

    const parsed = parseToFile(await muxFmp4(offsetVideo, offsetAudio));
    const movieTimescale = parsed.info.moov.mvhd.timescale;
    const video = outputTrackTiming(parsed, "video");
    const audio = outputTrackTiming(parsed, "audio");
    const audioEntries = editListEntries(audio.trak);

    expect(audioEntries?.[0]).toMatchObject({
      media_time: -1,
      media_rate_integer: 1,
      media_rate_fraction: 0,
    });
    expect(audioEntries![0].segment_duration / movieTimescale).toBeCloseTo(
      expectedDelay,
      2,
    );
    expectNoPositiveEmptyEdit(video.trak, movieTimescale);
    expect(Math.abs((audio.presentationStartSec - video.presentationStartSec) - expectedDelay))
      .toBeLessThanOrEqual(0.005);
    expect(parsed.info.moov.mvhd.duration / movieTimescale).toBeGreaterThanOrEqual(
      video.presentationLengthSec,
    );
    expect(parsed.info.moov.mvhd.duration / movieTimescale).toBeGreaterThanOrEqual(
      audio.presentationLengthSec,
    );
  });
});
