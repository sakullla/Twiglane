import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  resolve: process.env.VITEST ? { conditions: ["browser"] } : {},
  clearScreen: false,
  // 保留语法的动态 import，避免默认 IIFE 把全部语言内联进首个 Worker。
  worker: { format: "es" },
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    hmr: {
      protocol: "ws",
      host: "127.0.0.1",
      port: 1421,
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    pool: "threads",
    maxWorkers: 4,
    environment: "happy-dom",
    include: ["tests/*.spec.ts"],
  },
});
