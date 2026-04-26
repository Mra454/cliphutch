import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function copyManifest() {
  return {
    name: "copy-manifest",
    closeBundle() {
      copyFileSync(
        resolve(__dirname, "manifest.json"),
        resolve(__dirname, "dist/manifest.json"),
      );
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
