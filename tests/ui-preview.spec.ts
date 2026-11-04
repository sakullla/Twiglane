import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

/* ------------------------------------------------------------------ *
 * 浏览器预览（npm run preview:ui）的自检。
 * 这里不比对配置字符串，而是真的起一个 Vite dev server，看浏览器会拿到
 * 哪个模块：App 里的 ./lib/api 必须解析成 scripts/ui-preview/mock-api.ts，
 * 真实 src/lib/api.ts 不能出现在模块图里（否则页面必然报 Tauri invoke 错误）。
 * 覆盖范围：mock 替换、非 api 模块不被误换、健康端点自证、路径归一化比较。
 * 限制：只证明浏览器模拟预览；不代表真实 Git 或平台行为。
 * ------------------------------------------------------------------ */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(root, "scripts/ui-preview/vite.config.mjs");
const realApi = path.join(root, "src/lib/api.ts").replace(/\\/g, "/");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: urlPath }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    request.once("error", reject);
    request.setTimeout(15_000, () => request.destroy(new Error(`请求 ${urlPath} 超时`)));
  });
}

describe("浏览器预览的 mock 替换", () => {
  let server: ViteDevServer;
  let port = 0;

  beforeAll(async () => {
    port = await freePort();
    server = await createServer({
      configFile,
      logLevel: "silent",
      server: { host: "127.0.0.1", port, strictPort: false, hmr: false },
    });
    await server.listen();
  }, 90_000);

  afterAll(async () => {
    await server?.close();
  });

  it("把 api 路径的不同写法认成同一个文件，而不是只做一次字符串相等", async () => {
    const { sameFile, REAL_API_MODULE, MOCK_API_MODULE } = await import("../scripts/ui-preview/vite.config.mjs");
    expect(sameFile("C:\\work\\src\\lib\\api.ts?t=1", "c:/work/src/lib/api.ts")).toBe(true);
    expect(sameFile("C:/work/src/lib/api.ts", "C:/work/src/lib/api-extra.ts")).toBe(false);
    expect(sameFile(REAL_API_MODULE, MOCK_API_MODULE)).toBe(false);
    expect(sameFile("", REAL_API_MODULE)).toBe(false);
  });

  it("App 外壳的模块图里 api 指向 mock，真实 api.ts 一个都不剩", async () => {
    const app = await server.transformRequest("/src/App.svelte");
    expect(app?.code).toContain("/scripts/ui-preview/mock-api.ts");
    expect(app?.code).not.toContain("/src/lib/api.ts");
  });

  it("浏览器直接请求 /src/lib/api.ts 时拿到的是 mock 模块", async () => {
    const api = await get(port, "/src/lib/api.ts");
    expect(api.status).toBe(200);
    expect(api.body).toContain("UI_PREVIEW_MOCK");
    expect(api.body).toContain("preview-theme"); // mock 的 localStorage 主题键，真实 api 没有
    expect(api.body).not.toContain("@tauri-apps_api_core");
  });

  it("只替换 api，不误伤其它同目录模块", async () => {
    const diff = await server.transformRequest("/src/lib/diff.ts");
    expect(diff?.code).toBeTruthy();
    expect(diff?.code).not.toContain("mock-api.ts");
    const resolved = await server.pluginContainer.resolveId("./lib/errors", path.join(root, "src/App.svelte"));
    expect(resolved?.id.replace(/\\/g, "/")).toBe(path.join(root, "src/lib/errors.ts").replace(/\\/g, "/"));
  });

  it("健康端点能证明当前端口上的服务真的是 mock 预览", async () => {
    const health = await get(port, "/__ui-preview/health");
    expect(health.status).toBe(200);
    const payload = JSON.parse(health.body) as { mockApi: boolean; resolvedApi: string };
    expect(payload.mockApi).toBe(true);
    expect(payload.resolvedApi.replace(/\\/g, "/")).toBe(path.join(root, "scripts/ui-preview/mock-api.ts").replace(/\\/g, "/"));
  });
});
