import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFile, MP4BoxBuffer } from "mp4box";
import { transmuxTsAudioToFmp4, transmuxTsToMp4 } from "./ts-audio-to-fmp4";
import { UnsupportedTsCodecError } from "../lib/errors";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TS_SEGMENT = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "video-test-page",
  "hls-simple",
  "segment0.ts",
);

function parseTracks(bytes: Uint8Array): Array<{ type: string; codec: string; nb_samples: number }> {
  const iso = createFile() as unknown as {
    onReady: (info: { tracks: Array<{ type: string; codec: string; nb_samples: number }> }) => void;
    onError: (msg: string) => void;
    appendBuffer: (b: MP4BoxBuffer) => number;
    flush: () => void;
  };
  let tracks: Array<{ type: string; codec: string; nb_samples: number }> | null = null;
  iso.onReady = (info) => {
    tracks = info.tracks;
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
  return tracks ?? [];
}

describe("transmuxTsAudioToFmp4", () => {
  it("extracts AAC from an MPEG-TS segment and emits parseable audio fMP4", () => {
    const segment = new Uint8Array(readFileSync(TS_SEGMENT));
    const fmp4 = transmuxTsAudioToFmp4([segment]);

    expect(fmp4.byteLength).toBeGreaterThan(0);
    const tracks = parseTracks(fmp4);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].type).toBe("audio");
    expect(tracks[0].codec).toMatch(/^mp4a\./);
    expect(tracks[0].nb_samples).toBeGreaterThan(0);
  });

  it("throws a typed unsupported-codec error when no AAC audio is found", () => {
    expect(() => transmuxTsAudioToFmp4([new Uint8Array([1, 2, 3])])).toThrow(
      UnsupportedTsCodecError,
    );
  });
});

describe("transmuxTsToMp4", () => {
  it("transmuxes MPEG-TS audio/video into parseable MP4", () => {
    const segment = new Uint8Array(readFileSync(TS_SEGMENT));
    const mp4 = transmuxTsToMp4([segment]);

    expect(mp4.byteLength).toBeGreaterThan(0);
    const tracks = parseTracks(mp4);
    expect(tracks.map((t) => t.type).sort()).toEqual(["audio", "video"]);
    expect(tracks.every((t) => t.nb_samples > 0)).toBe(true);
  });

  it("throws a typed unsupported-codec error when MPEG-TS cannot be transmuxed", () => {
    expect(() => transmuxTsToMp4([new Uint8Array([1, 2, 3])])).toThrow(
      UnsupportedTsCodecError,
    );
  });
});
