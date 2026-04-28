// Mux a self-contained fMP4 video file (init + media segments concatenated)
// and an optional audio file into a single non-fragmented MP4 with both
// tracks. Uses mp4box.js's parser+writer; no transcoding (codec-copy only,
// avc1/hvc1+mp4a are the common live cases). Each track's source SampleEntry
// is reused so codec config (avcC/hvcC, esds) round-trips intact.

import { createFile, MP4BoxBuffer } from "mp4box";
// Some mp4box.js types reference Sample/Track shapes that aren't part of the
// extension's typecheck story. We narrow what we actually consume.
import type { ISOFile, Sample, Track, IsoFileOptions } from "mp4box";

type Parsed = { iso: ISOFile; track: Track; samples: Sample[] };

function parseFmp4(bytes: Uint8Array): Parsed {
  const iso = createFile() as ISOFile;
  let track: Track | null = null;
  const samples: Sample[] = [];

  iso.onReady = (info) => {
    if (info.tracks.length === 0) return;
    track = info.tracks[0];
    iso.setExtractionOptions(track.id, null, { nbSamples: 1_000_000 });
    iso.start();
  };

  iso.onSamples = (_id, _user, batch) => {
    samples.push(...batch);
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

function buildTrackOptions(p: Parsed): IsoFileOptions {
  const t = p.track;
  const codecRoot = (t.codec ?? "").split(".")[0] || "mp4a";
  const opts: IsoFileOptions = {
    type: codecRoot as IsoFileOptions["type"],
    timescale: t.timescale,
    duration: t.samples_duration,
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
  // Reuse the source SampleEntry box (carries avcC/hvcC/esds config).
  const entry = p.samples[0]?.description as IsoFileOptions["description"] | undefined;
  if (entry) opts.description = entry;
  return opts;
}

function copySamples(out: ISOFile, dstTrackId: number, samples: Sample[]): void {
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

  const out = createFile() as ISOFile;
  const videoTrackId = out.addTrack(buildTrackOptions(video));
  copySamples(out, videoTrackId, video.samples);

  if (audio) {
    const audioTrackId = out.addTrack(buildTrackOptions(audio));
    copySamples(out, audioTrackId, audio.samples);
  }

  const blob = out.save("muxed.mp4");
  return new Uint8Array(await blob.arrayBuffer());
}
