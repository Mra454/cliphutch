// Mux a self-contained fMP4 video file (init + media segments concatenated)
// and an optional audio file into a single non-fragmented MP4 with both
// tracks. Codec-copy only — no transcoding. avc1+mp4a is the well-trodden
// path; hvc1 / eac3 are at higher edge-case risk.
//
// Two non-obvious things mp4box.js requires of us:
//   1. addTrack ignores the IsoFileOptions.description field. Codec config
//      must be passed via avcDecoderConfigRecord / hevcDecoderConfigRecord
//      (raw record bytes — *not* the avcC box itself; just its body).
//   2. addTrack's audio path doesn't accept an esds option at all. We have
//      to splice the source's esds child into the auto-created mp4a sample
//      entry after addTrack returns. Without esds, AAC won't decode.
//
// And one footgun:
//   3. ISOFile.save() (and DataStream.save() under it) triggers a real
//      <a download="..."> click that writes a file to disk in addition to
//      returning the Blob. Use ISOFile.getBuffer() instead.

import { createFile, MP4BoxBuffer, DataStream } from "mp4box";
// We rely on shorthand structural access (moov.traks, trak.mdia.minf.stbl.
// stsd.entries[0], box.boxes for children). The mp4box.d.ts surface for the
// exact box subclasses isn't worth fighting; narrow with `unknown`-ish casts.
type AnyBox = { type?: string; boxes?: AnyBox[]; write?: (s: DataStream) => void; addBox?: (b: AnyBox) => AnyBox };
type AnyTrak = { tkhd: { track_id: number }; mdia: { minf: { stbl: { stsd: { entries: AnyBox[] } } } } };
type AnyMoov = { traks: AnyTrak[] };
type AnyIso = { moov: AnyMoov; appendBuffer: (b: MP4BoxBuffer) => number; flush: () => void; onReady?: (info: unknown) => void; onSamples?: (id: number, user: unknown, batch: unknown[]) => void; onError?: (msg: string) => void; setExtractionOptions: (id: number, user: unknown, opts: { nbSamples: number }) => void; start: () => void; addTrack: (opts: unknown) => number; addSample: (id: number, data: Uint8Array, opts: unknown) => unknown; getBuffer: () => DataStream };

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

function findChildBox(parent: AnyBox | undefined, type: string): AnyBox | undefined {
  return parent?.boxes?.find((b) => b.type === type);
}

// Serialize an mp4box Box and strip the 8-byte ISO BMFF header to get just
// the box body. addTrack's avcDecoderConfigRecord / hevcDecoderConfigRecord
// expect the configuration record only, not the wrapping avcC/hvcC box.
function extractBoxBody(box: AnyBox | undefined): ArrayBuffer | undefined {
  if (!box?.write) return undefined;
  const stream = new DataStream();
  box.write(stream);
  const full = new Uint8Array((stream as unknown as { buffer: ArrayBuffer }).buffer);
  // First 4 bytes are size, next 4 are type ('avcC' / 'hvcC' / etc.)
  return full.slice(8).buffer;
}

function parseFmp4(bytes: Uint8Array): Parsed {
  const iso = createFile() as unknown as AnyIso;
  let track: ParsedTrack | null = null;
  const samples: ParsedSample[] = [];

  iso.onReady = (info: unknown) => {
    const tracks = (info as { tracks: ParsedTrack[] & { id: number }[] }).tracks;
    if (!tracks || tracks.length === 0) return;
    track = tracks[0];
    iso.setExtractionOptions(
      (tracks[0] as unknown as { id: number }).id,
      null,
      { nbSamples: 1_000_000 },
    );
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
  return { iso, track, samples };
}

function buildVideoTrackOptions(p: Parsed): Record<string, unknown> {
  const t = p.track;
  const codecRoot = (t.codec ?? "").split(".")[0] || "avc1";

  // Find the source avc1/hvc1 sample entry's codec config child box.
  const srcEntry = p.iso.moov.traks[0].mdia.minf.stbl.stsd.entries[0];
  const avcC = findChildBox(srcEntry, "avcC");
  const hvcC = findChildBox(srcEntry, "hvcC");

  const opts: Record<string, unknown> = {
    type: codecRoot,
    timescale: t.timescale,
    duration: t.samples_duration,
    width: t.video?.width,
    height: t.video?.height,
  };
  const avcRecord = extractBoxBody(avcC);
  if (avcRecord) opts.avcDecoderConfigRecord = avcRecord;
  const hvcRecord = extractBoxBody(hvcC);
  if (hvcRecord) opts.hevcDecoderConfigRecord = hvcRecord;
  return opts;
}

function buildAudioTrackOptions(p: Parsed): Record<string, unknown> {
  const t = p.track;
  const codecRoot = (t.codec ?? "").split(".")[0] || "mp4a";
  return {
    type: codecRoot,
    timescale: t.timescale,
    duration: t.samples_duration,
    channel_count: t.audio?.channel_count,
    samplerate: t.audio?.sample_rate,
    samplesize: t.audio?.sample_size,
  };
}

// addTrack's audio path doesn't add an esds child to the auto-created
// mp4a sample entry, so AAC won't decode. Splice the source's esds box
// into the output's mp4a entry post-creation.
function carryOverAudioCodecConfig(out: AnyIso, audioTrackId: number, src: Parsed): void {
  const outTrak = out.moov.traks.find((t) => t.tkhd.track_id === audioTrackId);
  if (!outTrak) return;
  const outEntry = outTrak.mdia.minf.stbl.stsd.entries[0];
  const srcEntry = src.iso.moov.traks[0].mdia.minf.stbl.stsd.entries[0];
  const srcEsds = findChildBox(srcEntry, "esds");
  if (srcEsds && outEntry.addBox) outEntry.addBox(srcEsds);
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

export async function muxFmp4(
  videoBytes: Uint8Array,
  audioBytes?: Uint8Array,
): Promise<Uint8Array> {
  const video = parseFmp4(videoBytes);
  const audio = audioBytes ? parseFmp4(audioBytes) : null;

  const out = createFile() as unknown as AnyIso;
  const videoTrackId = out.addTrack(buildVideoTrackOptions(video));
  copySamples(out, videoTrackId, video.samples);

  if (audio) {
    const audioTrackId = out.addTrack(buildAudioTrackOptions(audio));
    carryOverAudioCodecConfig(out, audioTrackId, audio);
    copySamples(out, audioTrackId, audio.samples);
  }

  // getBuffer() instead of save() — save() triggers an actual <a download>
  // click that writes a file to disk in addition to returning the Blob.
  const stream = out.getBuffer();
  const buf = (stream as unknown as { buffer: ArrayBuffer }).buffer;
  return new Uint8Array(buf);
}
