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
import { muxFmp4 } from "./dash-mux";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "..", "..", "fixtures", "dash-test");
const VIDEO_PATH = resolve(FIXTURES_DIR, "video.m4v");
const AUDIO_PATH = resolve(FIXTURES_DIR, "audio.m4a");

const fixturesPresent = existsSync(VIDEO_PATH) && existsSync(AUDIO_PATH);

type AnyBox = { type?: string; boxes?: AnyBox[]; data?: Uint8Array };
type ParsedFile = {
  tracks: Array<{ id: number; codec: string; nb_samples: number; type: "video" | "audio" | string }>;
  // mp4box's traks shorthand on moov
  moov: { traks: Array<AnyTrak> };
};
type AnyTrak = {
  tkhd: { track_id: number };
  mdia: { minf: { stbl: { stsd: { entries: AnyBox[] } } } };
};

function findChild(parent: AnyBox | undefined, type: string): AnyBox | undefined {
  return parent?.boxes?.find((b) => b.type === type);
}

function parseToFile(bytes: Uint8Array): {
  info: ParsedFile;
  sampleCount: number;
} {
  // Cast the mp4box createFile result to a minimal shape we control.
  const iso = createFile() as unknown as {
    onReady: (info: ParsedFile) => void;
    onError: (msg: string) => void;
    onSamples: (id: number, _u: unknown, batch: unknown[]) => void;
    setExtractionOptions: (id: number, u: unknown, opts: { nbSamples: number }) => void;
    start: () => void;
    appendBuffer: (b: MP4BoxBuffer) => number;
    flush: () => void;
    moov: { traks: AnyTrak[] };
  };
  let info: ParsedFile | null = null;
  let sampleCount = 0;
  iso.onReady = (i) => {
    info = i;
    for (const t of i.tracks) iso.setExtractionOptions(t.id, null, { nbSamples: 1_000_000 });
    iso.start();
  };
  iso.onSamples = (_id, _u, batch) => {
    sampleCount += batch.length;
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
  if (!info) throw new Error("Parse produced no Movie info");
  // Splice in the moov reference for downstream avcC / esds inspection.
  return { info: { ...info, moov: iso.moov }, sampleCount };
}

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

    // Video sample entry should have an avcC child with non-empty SPS+PPS
    const videoTrak = info.moov.traks.find((t) => t.tkhd.track_id === videoTrack!.id);
    expect(videoTrak).toBeDefined();
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
    const audioTrak = info.moov.traks.find((t) => t.tkhd.track_id === audioTrack!.id);
    expect(audioTrak).toBeDefined();
    const audioEntry = audioTrak!.mdia.minf.stbl.stsd.entries[0];
    const esds = findChild(audioEntry, "esds");
    expect(esds, "audio sample entry should carry an esds child").toBeDefined();
    // After the d501b08 patch, esds carries this.data; a zero-length body
    // here would mean the round-trip dropped the AAC config.
    expect(esds!.data?.byteLength ?? 0).toBeGreaterThan(0);

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
});
