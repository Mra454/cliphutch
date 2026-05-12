// Mux a self-contained fMP4 video file (init + media segments concatenated)
// and an optional audio file into a single non-fragmented MP4 with both
// tracks. Codec-copy only — no transcoding.
//
// mp4box's addTrack auto-creates a sample entry from `options.type` (avc1,
// hvc1, mp4a, etc.) but doesn't carry over codec config (avcC, hvcC, esds,
// dec3, dOps, …). To preserve config, we pass the source entry's children
// via `description_boxes: Box[]` — addTrack appends each to the new sample
// entry (mp4box.all.js:8075). This handles avc1+mp4a, hvc1, ec-3, opus,
// and any future codec uniformly without per-codec branches.
//
// Two footguns we work around:
//   - ISOFile.save() chains into DataStream.save() which triggers a real
//     <a download="..."> click in addition to returning the Blob. Use
//     ISOFile.getBuffer() instead.
//   - addTrack returns `undefined` for any codec string not in
//     BoxRegistry.sampleEntry (mp4box.all.js:8024). Without a null-check
//     the next call to addSample crashes with an opaque mp4box-internal
//     error. We surface it as a clean exception.

import { createFile, MP4BoxBuffer, DataStream } from "mp4box";

type AnyBox = {
  type?: string;
  boxes?: AnyBox[];
  // Populated by parsing scaffolding; available on parsed boxes:
  start?: number;
  size?: number;
  hdr_size?: number;
  data?: Uint8Array;
};
type AnyTrak = {
  tkhd: { track_id: number; volume?: number };
  mdia: { minf: { stbl: { stsd: { entries: AnyBox[] } } } };
};
type AnyMoov = { traks: AnyTrak[] };
type AnyIso = {
  moov: AnyMoov;
  appendBuffer: (b: MP4BoxBuffer) => number;
  flush: () => void;
  onReady?: (info: unknown) => void;
  onSamples?: (id: number, user: unknown, batch: unknown[]) => void;
  onError?: (msg: string) => void;
  setExtractionOptions: (id: number, user: unknown, opts: { nbSamples: number }) => void;
  start: () => void;
  addTrack: (opts: unknown) => number | undefined;
  addSample: (id: number, data: Uint8Array, opts: unknown) => unknown;
  getBuffer: () => DataStream;
};

type ParsedSample = {
  data?: Uint8Array;
  duration: number;
  cts: number;
  dts: number;
  is_sync: boolean;
};

type ParsedTrack = {
  codec: string;
  timescale: number;
  samples_duration: number;
  video?: { width: number; height: number };
  audio?: { sample_rate: number; channel_count: number; sample_size: number };
};

type Parsed = { iso: AnyIso; track: ParsedTrack; samples: ParsedSample[] };

// FullBox subclasses (esds, btrt, others) round-trip incorrectly through
// mp4box's default write path. Trace:
//
//   1. The box parser scaffold (mp4box.all.js:2718) sets
//      `box.hdr_size = 8` (the base Box header — version+flags not yet
//      read), then checks `box.write === Box.prototype.write`. If the
//      box class doesn't override write (esds doesn't), it calls
//      `parseDataAndRewind(stream)` BEFORE invoking `box.parse(stream)`.
//   2. `parseDataAndRewind` reads `(size - 8)` bytes — i.e. the
//      version+flags 4 bytes AND the actual body — into `this.data`.
//   3. `box.parse` then runs `parseFullHeader` which advances hdr_size
//      to 12 but reads version+flags from the rewound stream into
//      `this.version` / `this.flags`.
//
// Net: after parse, `this.data` is `(size - 8)` bytes starting with
// version+flags, while `this.version` / `this.flags` are also set.
// Default `Box.write` then emits `[FullBox header 12 bytes which include
// version+flags][this.data which ALSO starts with version+flags]` —
// version+flags duplicated, body shifted right by 4, ESD descriptor
// becomes garbage, AAC decoder fails silently.
//
// Fix: overwrite `this.data` with just the body bytes (after the FullBox
// header, length `size - 12`). Always replace — the existing data set by
// `parseDataAndRewind` is wrong, not absent.
function patchUnserializedBoxData(entryBoxes: AnyBox[], sourceBytes: Uint8Array): void {
  // Box types whose mp4box default round-trip is broken. esds is the
  // documented case; add others here if more emerge from field test.
  const NEEDS_PATCH = new Set(["esds"]);
  for (const child of entryBoxes) {
    if (
      child.type !== undefined &&
      NEEDS_PATCH.has(child.type) &&
      typeof child.start === "number" &&
      typeof child.size === "number" &&
      typeof child.hdr_size === "number"
    ) {
      // Use the post-parse hdr_size (12 for FullBox), not the value that
      // was current at parseDataAndRewind time (8).
      child.data = sourceBytes.slice(child.start + child.hdr_size, child.start + child.size);
    }
  }
}

function parseFmp4(bytes: Uint8Array): Parsed {
  const iso = createFile() as unknown as AnyIso;
  let track: ParsedTrack | null = null;
  const samples: ParsedSample[] = [];

  iso.onReady = (info: unknown) => {
    const tracks = (info as { tracks: (ParsedTrack & { id: number })[] }).tracks;
    if (!tracks || tracks.length === 0) return;
    // Guard against silently dropping tracks: this parser extracts only
    // tracks[0]. Single-track inputs (DASH adaptation sets, video-only fMP4
    // HLS) are fine. Multi-track input would lose audio (or video) without
    // notice — fail loudly instead. Lifting this requires the separate-audio
    // HLS work (Option C); see fmp4-hls-stream-labels review for details.
    if (tracks.length > 1) {
      throw new Error(
        `Multi-track fMP4 input not supported (got ${tracks.length} tracks). ` +
          `ClipHutch does not yet mux embedded multi-track fMP4 streams.`,
      );
    }
    track = tracks[0];
    iso.setExtractionOptions(tracks[0].id, null, { nbSamples: 1_000_000 });
    iso.start();
  };

  iso.onSamples = (_id, _user, batch) => {
    samples.push(...(batch as ParsedSample[]));
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

  if (!track) throw new Error("No track found in fMP4");
  if (samples.length === 0) throw new Error("No samples extracted from fMP4");

  const srcEntryBoxes = (iso.moov.traks[0]?.mdia.minf.stbl.stsd.entries[0]?.boxes ?? []) as AnyBox[];
  patchUnserializedBoxData(srcEntryBoxes, bytes);

  return { iso, track, samples };
}

function buildTrackOptions(p: Parsed): Record<string, unknown> {
  const t = p.track;
  const codecRoot = (t.codec ?? "").split(".")[0] || (t.video ? "avc1" : "mp4a");

  // Source sample entry (avc1 / hvc1 / mp4a / opus / ...). Its children
  // are the codec config boxes we need to carry over.
  const srcEntry = p.iso.moov.traks[0]?.mdia.minf.stbl.stsd.entries[0];
  const childBoxes = (srcEntry?.boxes ?? []).slice();

  const opts: Record<string, unknown> = {
    type: codecRoot,
    timescale: t.timescale,
    duration: t.samples_duration,
    description_boxes: childBoxes,
    // mp4box.all.js:7995 defaults `hdlr.handler` to "vide" for every track
    // unless explicitly overridden. Without this, audio tracks get a
    // "vide" handler — ffprobe and every decoder then read the track as
    // video-with-mp4a-codec ("Video: none (mp4a)") and ignore it. Set
    // the handler to match the actual media type.
    hdlr: t.video ? "vide" : "soun",
  };
  if (t.video) {
    opts.width = t.video.width;
    opts.height = t.video.height;
  }
  if (t.audio) {
    opts.channel_count = t.audio.channel_count;
    opts.samplerate = t.audio.sample_rate;
    opts.samplesize = t.audio.sample_size;
  }
  return opts;
}

function copySamples(out: AnyIso, dstTrackId: number, samples: ParsedSample[]): void {
  for (const s of samples) {
    if (!s.data) continue;
    out.addSample(dstTrackId, s.data, {
      duration: s.duration,
      cts: s.cts,
      dts: s.dts,
      is_sync: s.is_sync,
    });
  }
}

function addTrackOrThrow(out: AnyIso, opts: Record<string, unknown>, role: string): number {
  const id = out.addTrack(opts);
  if (typeof id !== "number") {
    throw new Error(
      `mp4box addTrack returned undefined for ${role} codec "${String(opts.type)}" — codec not registered in BoxRegistry.sampleEntry`,
    );
  }
  return id;
}

// mp4box.all.js:8006 hardcodes `tkhd.volume = 1` for every new track. ISO
// 14496-12 §8.3.2 requires volume = 0 (mute) for video tracks and 1.0
// (full) for audio. Strict decoders (Apple AVFoundation, iOS Safari)
// enforce this; permissive desktop players ignore it. Override on the
// video track only — audio's default of 1 is already correct.
function setTrackVolume(out: AnyIso, trackId: number, volume: number): void {
  const trak = out.moov.traks.find((t) => t.tkhd.track_id === trackId);
  if (trak) trak.tkhd.volume = volume;
}

export async function muxFmp4(
  videoBytes: Uint8Array,
  audioBytes?: Uint8Array,
): Promise<Uint8Array> {
  const video = parseFmp4(videoBytes);
  const audio = audioBytes ? parseFmp4(audioBytes) : null;

  const out = createFile() as unknown as AnyIso;
  const videoTrackId = addTrackOrThrow(out, buildTrackOptions(video), "video");
  setTrackVolume(out, videoTrackId, 0);
  copySamples(out, videoTrackId, video.samples);

  if (audio) {
    const audioTrackId = addTrackOrThrow(out, buildTrackOptions(audio), "audio");
    copySamples(out, audioTrackId, audio.samples);
  }

  // getBuffer() instead of save() — save() triggers an actual <a download>
  // click that writes a file to disk in addition to returning the Blob.
  const stream = out.getBuffer();
  const buf = (stream as unknown as { buffer: ArrayBuffer }).buffer;
  return new Uint8Array(buf);
}
