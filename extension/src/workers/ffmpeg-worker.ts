/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

type LoadConfig = { coreURL: string; wasmURL: string };
type RequestMessage = { id: number; type: string; data: unknown };

declare const self: DedicatedWorkerGlobalScope & {
  createFFmpegCore?: (opts: { mainScriptUrlOrBlob: string }) => Promise<FFmpegCore>;
};

type FFmpegCore = {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string, opts?: { encoding?: string }): Uint8Array | string;
    unlink(path: string): void;
  };
  exec(...args: string[]): void;
  ret: number;
  reset(): void;
  setTimeout(timeout: number): void;
  setLogger(cb: (data: unknown) => void): void;
  setProgress(cb: (data: unknown) => void): void;
};

let ffmpeg: FFmpegCore | null = null;

function send(id: number, type: string, data: unknown, transfer: Transferable[] = []): void {
  self.postMessage({ id, type, data }, transfer);
}

async function load(config: LoadConfig): Promise<boolean> {
  const first = !ffmpeg;
  const mod = await import(/* @vite-ignore */ config.coreURL);
  self.createFFmpegCore = mod.default;
  if (!self.createFFmpegCore) throw new Error("Could not load ffmpeg core");

  ffmpeg = await self.createFFmpegCore({
    mainScriptUrlOrBlob: `${config.coreURL}#${btoa(JSON.stringify({
      wasmURL: config.wasmURL,
      workerURL: config.coreURL.replace(/.js$/g, ".worker.js"),
    }))}`,
  });
  ffmpeg.setLogger((data) => self.postMessage({ type: "LOG", data }));
  ffmpeg.setProgress((data) => self.postMessage({ type: "PROGRESS", data }));
  return first;
}

self.onmessage = async ({ data: { id, type, data } }: MessageEvent<RequestMessage>) => {
  try {
    if (type === "LOAD") {
      send(id, type, await load(data as LoadConfig));
      return;
    }
    if (!ffmpeg) throw new Error("ffmpeg is not loaded");

    if (type === "WRITE_FILE") {
      const { path, data: bytes } = data as { path: string; data: Uint8Array };
      ffmpeg.FS.writeFile(path, bytes);
      send(id, type, true);
      return;
    }
    if (type === "READ_FILE") {
      const { path, encoding } = data as { path: string; encoding?: string };
      const out = ffmpeg.FS.readFile(path, { encoding });
      const transfer = out instanceof Uint8Array ? [out.buffer] : [];
      send(id, type, out, transfer);
      return;
    }
    if (type === "DELETE_FILE") {
      const { path } = data as { path: string };
      ffmpeg.FS.unlink(path);
      send(id, type, true);
      return;
    }
    if (type === "EXEC") {
      const { args, timeout = -1 } = data as { args: string[]; timeout?: number };
      ffmpeg.setTimeout(timeout);
      ffmpeg.exec(...args);
      const ret = ffmpeg.ret;
      ffmpeg.reset();
      send(id, type, ret);
      return;
    }
    throw new Error(`Unknown ffmpeg message type: ${type}`);
  } catch (err) {
    send(id, "ERROR", err instanceof Error ? err.message : String(err));
  }
};
