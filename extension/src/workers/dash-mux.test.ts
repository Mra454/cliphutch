import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  createCount: 0,
  extractionBatchSizes: [] as number[],
  copiedSamples: 0,
  inputs: [] as Array<{
    track: {
      id: number;
      codec: string;
      timescale: number;
      samples_duration: number;
      video?: { width: number; height: number };
      audio?: { sample_rate: number; channel_count: number; sample_size: number };
    };
    samples: Array<{
      data: Uint8Array;
      duration: number;
      cts: number;
      dts: number;
      is_sync: boolean;
    }>;
  }>,
  lastOutput: null as null | {
    moov: {
      mvhd: { timescale: number; duration: number };
      traks: Array<{
        boxes: unknown[];
        tkhd: { track_id: number; duration: number; volume: number };
        addBox: (box: unknown) => unknown;
      }>;
    };
  },
}));

vi.mock("mp4box", () => ({
  BoxParser: {
    box: {
      edts: class {
        type = "edts";
        boxes: unknown[] = [];
        addBox(box: unknown) {
          this.boxes.push(box);
          return box;
        }
      },
      elst: class {
        type = "elst";
        version = 0;
        flags = 0;
        entries: unknown[] = [];
      },
    },
  },
  DataStream: class {},
  MP4BoxBuffer: {
    fromArrayBuffer: (buffer: ArrayBuffer) => buffer,
  },
  createFile: () => {
    const call = mockState.createCount++;
    if (call < mockState.inputs.length) {
      const fixture = mockState.inputs[call];
      const input: Record<string, unknown> & {
        onReady?: (info: unknown) => void;
        onSamples?: (id: number, user: unknown, samples: unknown[]) => void;
      } = {
        moov: {
          traks: [
            {
              tkhd: { track_id: 1 },
              mdia: { minf: { stbl: { stsd: { entries: [{ boxes: [] }] } } } },
            },
          ],
        },
        appendBuffer: () => 0,
        setExtractionOptions: (_id: number, _user: unknown, opts: { nbSamples: number }) => {
          mockState.extractionBatchSizes.push(opts.nbSamples);
        },
        start: () => {
          // Deliberately simulate a misbehaving/changed parser that emits a
          // single long-track callback. The muxer must not spread this array
          // into push(), which exceeds the engine's argument limit.
          input.onSamples?.(fixture.track.id, null, fixture.samples);
        },
        flush: () => {
          input.onReady?.({
            tracks: [fixture.track],
          });
        },
      };
      return input;
    }

    const output = {
      moov: {
        mvhd: { timescale: 1_000, duration: 0 },
        traks: [] as Array<{
          boxes: unknown[];
          tkhd: { track_id: number; duration: number; volume: number };
          addBox: (box: unknown) => unknown;
        }>,
      },
      addTrack: (opts: Record<string, unknown>) => {
        const id = output.moov.traks.length + 1;
        const trak = {
          boxes: [] as unknown[],
          tkhd: { track_id: id, duration: Number(opts.duration ?? 0), volume: 1 },
          addBox(box: unknown) {
            trak.boxes.push(box);
            return box;
          },
        };
        output.moov.traks.push(trak);
        return id;
      },
      addSample: () => {
        mockState.copiedSamples++;
      },
      getBuffer: () => ({ buffer: new ArrayBuffer(1) }),
    };
    mockState.lastOutput = output;
    return output;
  },
}));

import { MP4BOX_SAMPLE_BATCH_SIZE, muxFmp4 } from "./dash-mux";

describe("dash-mux sample extraction bounds", () => {
  beforeEach(() => {
    mockState.createCount = 0;
    mockState.extractionBatchSizes = [];
    mockState.copiedSamples = 0;
    mockState.inputs = [
      {
        track: {
          id: 1,
          codec: "avc1.640028",
          timescale: 1_000,
          samples_duration: 200_000,
          video: { width: 16, height: 16 },
        },
        samples: new Array(200_000).fill({
          data: new Uint8Array([1]),
          duration: 1,
          cts: 0,
          dts: 0,
          is_sync: true,
        }),
      },
    ];
    mockState.lastOutput = null;
  });

  it("requests bounded extraction batches and iteratively accepts 200,000 samples", async () => {
    await expect(muxFmp4(new Uint8Array([1]))).resolves.toHaveLength(1);
    expect(mockState.extractionBatchSizes).toEqual([MP4BOX_SAMPLE_BATCH_SIZE]);
    expect(MP4BOX_SAMPLE_BATCH_SIZE).toBeLessThanOrEqual(4_096);
    expect(mockState.copiedSamples).toBe(200_000);
  });

  it("adds an empty edit to video when the audio rendition starts earlier", async () => {
    mockState.inputs = [
      {
        track: {
          id: 1,
          codec: "avc1.640028",
          timescale: 1_000,
          samples_duration: 2_000,
          video: { width: 16, height: 16 },
        },
        samples: [
          {
            data: new Uint8Array([1]),
            duration: 2_000,
            cts: 477,
            dts: 477,
            is_sync: true,
          },
        ],
      },
      {
        track: {
          id: 2,
          codec: "mp4a.40.2",
          timescale: 1_000,
          samples_duration: 2_000,
          audio: { sample_rate: 48_000, channel_count: 2, sample_size: 16 },
        },
        samples: [
          {
            data: new Uint8Array([2]),
            duration: 2_000,
            cts: 0,
            dts: 0,
            is_sync: true,
          },
        ],
      },
    ];

    await muxFmp4(new Uint8Array([1]), new Uint8Array([2]));

    const videoTrak = mockState.lastOutput?.moov.traks[0] as
      | { boxes: Array<{ type?: string; boxes?: Array<{ type?: string; entries?: Array<{ segment_duration: number; media_time: number }> }> }> }
      | undefined;
    const audioTrak = mockState.lastOutput?.moov.traks[1] as
      | { boxes: Array<{ type?: string }> }
      | undefined;
    const edts = videoTrak?.boxes.find((box) => box.type === "edts");
    const elst = edts?.boxes?.find((box) => box.type === "elst");
    expect(elst?.entries?.[0]).toMatchObject({
      segment_duration: 477,
      media_time: -1,
    });
    expect(audioTrak?.boxes.some((box) => box.type === "edts")).toBe(false);
  });
});
