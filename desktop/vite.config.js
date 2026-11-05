// Plain JavaScript on purpose: the repository's root type check covers every
// .ts file, and this config must not depend on packages only installed here.
import { fileURLToPath } from "node:url";
import process from "node:process";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;
const page = (name) => fileURLToPath(new URL(`./${name}.html`, import.meta.url));

export default defineConfig({
  // Rust errors stay visible in `tauri dev`.
  clearScreen: false,
  server: {
    // Tauri expects the port in tauri.conf.json (build.devUrl).
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Safari 14 is the WebKit of macOS 11, the oldest supported system.
    target: ["es2020", "safari14"],
    // Readable output: the assets ship inside the app, size hardly matters.
    minify: false,
    rolldownOptions: {
      input: { settings: page("settings"), panel: page("panel"), badge: page("badge") },
    },
  },
});
