// 浏览器界面预览：把 src/lib/api.ts 换成 mock，便于不启动 Tauri 时调样式。
// 用法：npm run preview:ui，然后打开 http://127.0.0.1:1430
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const realApi = path.join(root, "src/lib/api.ts").replace(/\\/g, "/");
const mockApi = path.join(here, "mock-api.ts");

export default defineConfig({
  root,
  configFile: false,
  plugins: [
    svelte({ configFile: path.join(root, "svelte.config.js") }),
    {
      name: "twiglane-mock-api",
      enforce: "pre",
      async resolveId(source, importer, options) {
        if (!importer || !/(^|\/)api(\.ts)?$/.test(source)) return null;
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (resolved && resolved.id.replace(/\\/g, "/") === realApi) return mockApi;
        return null;
      },
    },
  ],
  server: { port: 1430, strictPort: true, host: "127.0.0.1" },
});
