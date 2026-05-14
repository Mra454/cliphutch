import mux from "mux.js";
import { UnsupportedTsCodecError } from "../lib/errors";

function concatBuffers(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function transmuxTsAudioToFmp4(segments: Uint8Array[]): Uint8Array {
  const transmuxer = new mux.mp4.Transmuxer({
    keepOriginalTimestamps: true,
    remux: false,
  });
  const audioParts: Uint8Array[] = [];
  let audioInit: Uint8Array | undefined;

  transmuxer.on("data", (segment) => {
    if (segment.type !== "audio") return;
    audioInit ??= segment.initSegment;
    audioParts.push(segment.data);
  });

  for (const seg of segments) {
    transmuxer.push(seg);
  }
  transmuxer.flush();

  if (!audioInit || audioParts.length === 0) {
    throw new UnsupportedTsCodecError();
  }

  return concatBuffers([audioInit, ...audioParts]);
}

export function transmuxTsToMp4(segments: Uint8Array[]): Uint8Array {
  const transmuxer = new mux.mp4.Transmuxer();
  const parts: Uint8Array[] = [];
  let init: Uint8Array | undefined;

  transmuxer.on("data", (segment) => {
    if (segment.type !== "combined") return;
    init ??= segment.initSegment;
    parts.push(segment.data);
  });

  for (const seg of segments) {
    transmuxer.push(seg);
  }
  transmuxer.flush();

  if (!init || parts.length === 0) {
    throw new UnsupportedTsCodecError();
  }

  return concatBuffers([init, ...parts]);
}
