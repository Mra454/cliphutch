import { FFmpeg } from "@ffmpeg/ffmpeg";
import { CancelledError, SizeCapError } from "../lib/errors";
import ffmpegWorkerUrl from "./ffmpeg-worker.ts?worker&url";

let ffmpegPromise: Promise<FFmpeg> | null = null;
type FfmpegProgressEvent = { progress: number };

function ffmpegAssetUrl(path: string): string {
  return chrome.runtime.getURL(`ffmpeg-core/${path}`);
}

async function getFfmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        classWorkerURL: ffmpegWorkerUrl,
        coreURL: ffmpegAssetUrl("ffmpeg-core.js"),
        wasmURL: ffmpegAssetUrl("ffmpeg-core.wasm"),
      });
      return ffmpeg;
    })().catch((err) => {
      ffmpegPromise = null;
      throw err;
    });
  }
  return ffmpegPromise;
}

export function terminateWebmTranscoder(): void {
  const pending = ffmpegPromise;
  ffmpegPromise = null;
  void pending?.then((ffmpeg) => {
    ffmpeg.terminate();
  }).catch(() => undefined);
}

async function fetchBytes(url: string, sizeCapBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: "include", signal });
  if (!res.ok) throw new Error(`WebM fetch failed with status ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > sizeCapBytes) throw new SizeCapError(sizeCapBytes);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > sizeCapBytes) throw new SizeCapError(sizeCapBytes);
  return bytes;
}

export async function transcodeWebmToMp4(
  url: string,
  opts: {
    sizeCapBytes: number;
    signal: AbortSignal;
    onProgress: (ratio: number, message?: string) => void;
  },
): Promise<Blob> {
  const abortTranscode = () => terminateWebmTranscoder();
  opts.signal.addEventListener("abort", abortTranscode, { once: true });
  opts.onProgress(0, "Fetching WebM");
  let ffmpeg: FFmpeg | null = null;
  let progressHandler: ((event: FfmpegProgressEvent) => void) | null = null;
  let inputName = "";
  let outputName = "";

  try {
    const input = await fetchBytes(url, opts.sizeCapBytes, opts.signal);
    if (opts.signal.aborted) throw new CancelledError();

    ffmpeg = await getFfmpeg();
    if (opts.signal.aborted) throw new CancelledError();
    progressHandler = ({ progress }) => {
      if (Number.isFinite(progress)) opts.onProgress(Math.max(0, Math.min(1, progress)));
    };
    ffmpeg.on("progress", progressHandler);

    inputName = `input-${crypto.randomUUID()}.webm`;
    outputName = `output-${crypto.randomUUID()}.mp4`;

    opts.onProgress(0, "Preparing transcode");
    await ffmpeg.writeFile(inputName, input, { signal: opts.signal });
    const code = await ffmpeg.exec([
      "-y",
      "-i",
      inputName,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputName,
    ], -1, { signal: opts.signal });
    if (opts.signal.aborted) throw new CancelledError();
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    const out = await ffmpeg.readFile(outputName, "binary", { signal: opts.signal });
    const data = typeof out === "string" ? new TextEncoder().encode(out) : out;
    return new Blob([data as BlobPart], { type: "video/mp4" });
  } catch (err) {
    if (opts.signal.aborted) throw new CancelledError();
    throw err;
  } finally {
    opts.signal.removeEventListener("abort", abortTranscode);
    if (ffmpeg && progressHandler) ffmpeg.off("progress", progressHandler);
    if (ffmpeg && inputName) await ffmpeg.deleteFile(inputName).catch(() => undefined);
    if (ffmpeg && outputName) await ffmpeg.deleteFile(outputName).catch(() => undefined);
  }
}
