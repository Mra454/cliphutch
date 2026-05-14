import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function copyManifest() {
  return {
    name: "copy-static-extension-files",
    closeBundle() {
      copyFileSync(
        resolve(__dirname, "manifest.json"),
        resolve(__dirname, "dist/manifest.json"),
      );
      const ffmpegDir = resolve(__dirname, "dist/ffmpeg-core");
      mkdirSync(ffmpegDir, { recursive: true });
      copyFileSync(
        resolve(__dirname, "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js"),
        resolve(ffmpegDir, "ffmpeg-core.js"),
      );
      copyFileSync(
        resolve(__dirname, "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm"),
        resolve(ffmpegDir, "ffmpeg-core.wasm"),
      );
      const assetsDir = resolve(__dirname, "dist/assets");
      for (const file of readdirSync(assetsDir)) {
        if (/^worker-.*\.js(?:\.map)?$/.test(file)) {
          unlinkSync(resolve(assetsDir, file));
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), copyManifest()],
  publicDir: "public",
  esbuild: {
    drop: mode === "production" ? ["console", "debugger"] : [],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: mode !== "production",
    target: "es2022",
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        "content-script": resolve(__dirname, "src/content-script.ts"),
        popup: resolve(__dirname, "popup.html"),
        options: resolve(__dirname, "options.html"),
        firstrun: resolve(__dirname, "firstrun.html"),
        offscreen: resolve(__dirname, "offscreen.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
}));
