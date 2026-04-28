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
  tkhd: { track_id: number };
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

// `esdsBox.parse` reads the body bytes into a local variable but doesn't
// store them on `this.data`, and there's no custom `write` (mp4box.all.js
// :4353-4361). When the default Box.write later serializes the output, it
// emits only the 12-byte FullBox header — AAC config gone, audio silent.
// Workaround: re-read the body bytes from the original source buffer and
// populate `this.data` so the default writer round-trips.
function patchUnserializedBoxData(entryBoxes: AnyBox[], sourceBytes: Uint8Array): void {
  // Box types that mp4box parses without persisting raw bytes on this.data.
  // esds is the documented case; add others here if more emerge.
  const NEEDS_PATCH = new Set(["esds"]);
  for (const child of entryBoxes) {
    if (
      child.type !== undefined &&
      NEEDS_PATCH.has(child.type) &&
      child.data === undefined &&
      typeof child.start === "number" &&
      typeof child.size === "number" &&
      typeof child.hdr_size === "number"
    ) {
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

export async function muxFmp4(
  videoBytes: Uint8Array,
  audioBytes?: Uint8Array,
): Promise<Uint8Array> {
  const video = parseFmp4(videoBytes);
  const audio = audioBytes ? parseFmp4(audioBytes) : null;

  const out = createFile() as unknown as AnyIso;
  const videoTrackId = addTrackOrThrow(out, buildTrackOptions(video), "video");
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
