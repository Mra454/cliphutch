import mux from "mux.js";
import { RawAacAudioError, UnsupportedTsCodecError } from "../lib/errors";

// Identify the audio container from its leading bytes. MPEG-TS packets begin
// with the 0x47 sync byte; a raw ADTS AAC frame begins with the 12-bit
// syncword 0xFFF (first byte 0xFF, top 4 bits of the second byte set).
function sniffAudioContainer(seg: Uint8Array | undefined): "ts" | "adts" | "unknown" {
  if (!seg || seg.length < 2) return "unknown";
  if (seg[0] === 0x47) return "ts";
  if (seg[0] === 0xff && (seg[1] & 0xf0) === 0xf0) return "adts";
  return "unknown";
}

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
  // Raw ADTS audio would silently produce no audio events from the MPEG-TS
  // transmuxer below and surface as a misleading "MPEG-TS codec" error. Detect
  // it up front and report the real reason.
  const firstSegment = segments.find((s) => s.length > 0);
  if (sniffAudioContainer(firstSegment) === "adts") {
    throw new RawAacAudioError();
  }

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
