// 浏览器界面预览：把 src/lib/api.ts 换成 mock，便于不启动 Tauri 时调样式。
// 用法：npm run preview:ui，然后打开 http://127.0.0.1:1430
// 自检（判断当前端口上跑的到底是不是 mock 预览）：
//   curl http://127.0.0.1:1430/__ui-preview/health   → 期望 "mockApi": true
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const realApi = path.join(root, "src/lib/api.ts");
const mockApi = path.join(here, "mock-api.ts");
const HOST = "127.0.0.1";
const PORT = 1430;
const HEALTH_PATH = "/__ui-preview/health";
// 配置热更新会在同一进程里重建 dev server，此时旧监听还没关，不能再当成端口冲突。
// 用进程环境变量做标记：配置模块重新加载时它仍然有效。
const BOUND_ENV = "TWIGLANE_UI_PREVIEW_BOUND";

/** 规范化成可比较的片段：去掉 query/hash，统一分隔符与大小写。 */
function normalizePath(value) {
  return String(value ?? "")
    .split("?")[0]
    .split("#")[0]
    .replace(/\\/g, "/")
    .toLowerCase();
}

/**
 * 判断两个模块标识是否指向同一个文件。
 * 除了字符串比较，还处理软链接、Windows 短路径和大小写差异——
 * 只做一次字符串相等判断时，解析结果形态一变就会静默退回真实 api。
 */
function sameFile(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    return normalizePath(fs.realpathSync(left)) === normalizePath(fs.realpathSync(right));
  } catch {
    return false;
  }
}

/** 把一个 import 标识符映射到候选文件，用于和真实 api.ts 比对。 */
function candidateFiles(source, importer) {
  // 浏览器直接请求模块时是 URL 形式：/src/lib/api.ts
  if (source.startsWith("/") && !source.startsWith("//")) return [path.join(root, source)];
  if (path.isAbsolute(source)) return [source];
  if (!source.startsWith(".")) return [];
  const base = path.dirname(importer);
  return [path.resolve(base, source), path.resolve(base, source + ".ts"), path.resolve(base, source + ".js")];
}

/** 只替换解析结果等于真实 src/lib/api.ts 的模块，不做“看起来像 api”的猜测。 */
function mockApiPlugin() {
  return {
    name: "twiglane-mock-api",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer) return null; // index.html 入口没有 importer，不参与替换
      if (!source.toLowerCase().includes("api")) return null; // 便宜的预筛
      if (candidateFiles(source, importer).some((file) => sameFile(file, realApi))) return mockApi;
      let resolved = null;
      try {
        resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      } catch {
        resolved = null;
      }
      return resolved && sameFile(resolved.id, realApi) ? mockApi : null;
    },
  };
}

/** 端口是否已被别的进程监听。用于在 Vite 打印空错误之前给出可执行的提示。 */
function portInUse(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (busy) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(busy);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1500, () => done(false));
  });
}

function previewGuardPlugin() {
  return {
    name: "twiglane-preview-guard",
    apply: "serve",
    async configureServer(server) {
      const { logger, server: serverOptions } = server.config;
      const host = serverOptions.host || HOST;
      const port = serverOptions.port || PORT;
      // middlewareMode 不监听端口（测试与嵌入场景）；vitest 同在进程内，失败时交给测试报错而不是退出进程。
      const listens = !serverOptions.middlewareMode;
      const fatal = listens && !process.env.VITEST;

      if (listens && process.env[BOUND_ENV] !== "1" && (await portInUse(port, host))) {
        logger.error(host + ":" + port + " 已被其他进程占用，本次预览没有启动。");
        logger.error("浏览器仍会打开旧页面，而旧服务加载的是真实 src/lib/api.ts，会报 Tauri invoke/transformCallback 错误。");
        logger.error("处理：关闭占用该端口的旧 Vite/预览进程后重试；先用 curl " + HEALTH_PATH + " 确认当前端口是不是 mock 预览。");
        if (fatal) process.exit(1);
      }
      if (listens) process.env[BOUND_ENV] = "1";

      server.middlewares.use(HEALTH_PATH, async (_request, response) => {
        const resolved = await server.pluginContainer.resolveId("./lib/api", path.join(root, "src/App.svelte"));
        const resolvedId = resolved?.id ?? null;
        const mockActive = sameFile(resolvedId, mockApi);
        response.statusCode = mockActive ? 200 : 500;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(
          JSON.stringify({ mockApi: mockActive, resolvedApi: resolvedId, mockModule: mockApi, realModule: realApi }, null, 2),
        );
      });

      // 启动即自检：解析不生效时宁可停下，也不要把真实 api 当成预览结果。
      const probe = await server.pluginContainer.resolveId("./lib/api", path.join(root, "src/App.svelte"));
      const mockActive = sameFile(probe?.id, mockApi);
      if (!mockActive) {
        logger.error("mock API 未生效：./lib/api 解析成了 " + (probe?.id ?? "null") + "，期望 " + mockApi + "。");
        if (fatal) process.exit(1);
      }
      if (listens && mockActive) {
        logger.info("  UI preview  http://" + host + ":" + port);
        logger.info("  mock API    scripts/ui-preview/mock-api.ts（模拟数据，不代表真实 Git 行为）");
      }
    },
  };
}

export { HEALTH_PATH, HOST, PORT, realApi as REAL_API_MODULE, mockApi as MOCK_API_MODULE, sameFile, portInUse };

export default defineConfig({
  root,
  plugins: [previewGuardPlugin(), mockApiPlugin(), svelte({ configFile: path.join(root, "svelte.config.js") })],
  server: { port: PORT, strictPort: true, host: HOST },
});
