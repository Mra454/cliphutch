import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  createCount: 0,
  extractionBatchSizes: [] as number[],
  copiedSamples: 0,
}));

vi.mock("mp4box", () => ({
  DataStream: class {},
  MP4BoxBuffer: {
    fromArrayBuffer: (buffer: ArrayBuffer) => buffer,
  },
  createFile: () => {
    const call = mockState.createCount++;
    if (call === 0) {
      const sample = {
        data: new Uint8Array([1]),
        duration: 1,
        cts: 0,
        dts: 0,
        is_sync: true,
      };
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
          input.onSamples?.(1, null, new Array(200_000).fill(sample));
        },
        flush: () => {
          input.onReady?.({
            tracks: [
              {
                id: 1,
                codec: "avc1.640028",
                timescale: 1_000,
                samples_duration: 200_000,
                video: { width: 16, height: 16 },
              },
            ],
          });
        },
      };
      return input;
    }

    const output = {
      moov: { traks: [] as Array<{ tkhd: { track_id: number; volume: number } }> },
      addTrack: () => {
        output.moov.traks.push({ tkhd: { track_id: 1, volume: 1 } });
        return 1;
      },
      addSample: () => {
        mockState.copiedSamples++;
      },
      getBuffer: () => ({ buffer: new ArrayBuffer(1) }),
    };
    return output;
  },
}));

import { MP4BOX_SAMPLE_BATCH_SIZE, muxFmp4 } from "./dash-mux";

describe("dash-mux sample extraction bounds", () => {
  beforeEach(() => {
    mockState.createCount = 0;
    mockState.extractionBatchSizes = [];
    mockState.copiedSamples = 0;
  });

  it("requests bounded extraction batches and iteratively accepts 200,000 samples", async () => {
    await expect(muxFmp4(new Uint8Array([1]))).resolves.toHaveLength(1);
    expect(mockState.extractionBatchSizes).toEqual([MP4BOX_SAMPLE_BATCH_SIZE]);
    expect(MP4BOX_SAMPLE_BATCH_SIZE).toBeLessThanOrEqual(4_096);
    expect(mockState.copiedSamples).toBe(200_000);
  });
});
