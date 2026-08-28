import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "fixtures/dash-test/video.m4v",
  "fixtures/dash-test/audio.m4a",
  "../fixtures/video-test-page/hls-simple/segment0.ts",
];

for (const path of required) {
  const absolute = resolve(extensionDirectory, path);
  const info = statSync(absolute);
  if (!info.isFile() || info.size === 0) throw new Error(`Required fixture is empty: ${path}`);
  console.log(`[fixture] ${path}: ${info.size} bytes`);
}
