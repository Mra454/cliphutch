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

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "..", "..", "fixtures", "dash-test");
const VIDEO_PATH = resolve(FIXTURES_DIR, "video.m4v");
const AUDIO_PATH = resolve(FIXTURES_DIR, "audio.m4a");

const fixturesPresent = existsSync(VIDEO_PATH) && existsSync(AUDIO_PATH);

type AnyBox = {
  type?: string;
  boxes?: AnyBox[];
  data?: Uint8Array;
  size?: number;
  hdr_size?: number;
};
type ParsedFile = {
  tracks: Array<{ id: number; codec: string; nb_samples: number; type: "video" | "audio" | string }>;
  // mp4box's traks shorthand on moov
  moov: { traks: Array<AnyTrak> };
};
type AnyTrak = {
  tkhd: { track_id: number; volume: number };
  mdia: {
    hdlr: { handler: string };
    minf: { stbl: { stsd: { entries: AnyBox[] } } };
  };
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
  const parsedInfo = info as ParsedFile | null;
  if (!parsedInfo) throw new Error("Parse produced no Movie info");
  // Splice in the moov reference for downstream avcC / esds inspection.
  return { info: { ...parsedInfo, moov: iso.moov }, sampleCount };
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
});
