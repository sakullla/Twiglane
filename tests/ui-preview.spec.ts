import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Logger, type ViteDevServer } from "vite";

/* ------------------------------------------------------------------ *
 * 浏览器预览（npm run preview:ui）的自检。
 * 这里不比对配置字符串，而是真的起一个 Vite dev server，看浏览器会拿到
 * 哪个模块：App 里的 ./lib/api 必须解析成 scripts/ui-preview/mock-api.ts，
 * 真实 src/lib/api.ts 不能出现在模块图里（否则页面必然报 Tauri invoke 错误）。
 * 覆盖范围：mock 替换、非 api 模块不被误换、健康端点自证、路径归一化比较、
 * 端口守卫（占用判定、--host 的布尔 host、占用时的诊断与退出决策）。
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
    // 预热：浏览器直接请求的 mock 模块与 App 外壳在这里先编译好（beforeAll 预算 90s）。
    // 全量 npm test 并行时冷编译可能超过单个请求的 15s 超时，结果取决于机器负载而不是 mock 替换本身。
    await server.transformRequest("/src/lib/api.ts");
    await server.transformRequest("/src/App.svelte");
  }, 90_000);

  afterAll(async () => {
    await server?.close();
  });

  it(
    "把 api 路径的不同写法认成同一个文件，而不是只做一次字符串相等",
    async () => {
      const { sameFile, REAL_API_MODULE, MOCK_API_MODULE } = await import("../scripts/ui-preview/vite.config.mjs");
      expect(sameFile("C:\\work\\src\\lib\\api.ts?t=1", "c:/work/src/lib/api.ts")).toBe(true);
      expect(sameFile("C:/work/src/lib/api.ts", "C:/work/src/lib/api-extra.ts")).toBe(false);
      expect(sameFile(REAL_API_MODULE, MOCK_API_MODULE)).toBe(false);
      expect(sameFile("", REAL_API_MODULE)).toBe(false);
    },
    30_000,
  );

  // 首次 transformRequest 要冷编译整个 Svelte 外壳，在全量 npm test 的并行负载下
  // 实测会超过默认 5s 而误判失败（单跑约 2.5s）。这里给这一个用例显式放宽，
  // 不改全局 testTimeout，其它用例的慢仍然会失败。
  it(
    "App 外壳的模块图里 api 指向 mock，真实 api.ts 一个都不剩",
    async () => {
      const app = await server.transformRequest("/src/App.svelte");
      expect(app?.code).toContain("/scripts/ui-preview/mock-api.ts");
      expect(app?.code).not.toContain("/src/lib/api.ts");
    },
    30_000,
  );

  it(
    "浏览器直接请求 /src/lib/api.ts 时拿到的是 mock 模块",
    async () => {
      const api = await get(port, "/src/lib/api.ts");
      expect(api.status).toBe(200);
      expect(api.body).toContain("UI_PREVIEW_MOCK");
      expect(api.body).toContain("preview-theme"); // mock 的 localStorage 主题键，真实 api 没有
      expect(api.body).not.toContain("@tauri-apps_api_core");
    },
    30_000,
  );

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

/* ------------------------------------------------------------------ *
 * 端口守卫：预览端口被旧服务占用时，必须报可执行原因而不是让 CLI 静默失败，
 * 也不能把 --host 得到的布尔 host 传进 net.connect 而崩在诊断之前。
 * 这里用真实占用的端口判定，而不是假设一个常量。
 * ------------------------------------------------------------------ */
describe("预览端口守卫", () => {
  // 与 vite.config.mjs 中的 BOUND_ENV 同名：配置热更新标记，测试里要清掉才能走探测分支。
  const boundEnv = "TWIGLANE_UI_PREVIEW_BOUND";

  function listenOn(server: net.Server): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  }

  function closeServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  it("端口真的被占用时判定为占用，释放后判定为空闲", async () => {
    const { portInUse } = await import("../scripts/ui-preview/vite.config.mjs");
    const blocker = net.createServer();
    const busy = await listenOn(blocker);
    try {
      await expect(portInUse(busy)).resolves.toBe(true);
      await expect(portInUse(busy, "127.0.0.1")).resolves.toBe(true);
    } finally {
      await closeServer(blocker);
    }
    await expect(portInUse(busy)).resolves.toBe(false);
  }, 30_000);

  it("--host 得到的布尔 host 不会被当成地址传给 net.connect", async () => {
    const { HOST, portInUse, probeHost } = await import("../scripts/ui-preview/vite.config.mjs");
    expect(probeHost(true)).toBe(HOST);
    expect(probeHost(undefined)).toBe(HOST);
    expect(probeHost("")).toBe(HOST);
    expect(probeHost("0.0.0.0")).toBe("0.0.0.0");

    const blocker = net.createServer();
    const busy = await listenOn(blocker);
    try {
      // 修复前这里会抛 ERR_INVALID_ARG_TYPE，占用诊断还没打印就崩了。
      await expect(portInUse(busy, true)).resolves.toBe(true);
    } finally {
      await closeServer(blocker);
    }
    await expect(portInUse(busy, true)).resolves.toBe(false);
  }, 30_000);

  it("占用时给出可执行诊断，并按 fatal 决定是否退出", async () => {
    const { reportPortInUse } = await import("../scripts/ui-preview/vite.config.mjs");
    const lines: string[] = [];
    const logger = { error: (message: string) => lines.push(message) };
    const exits: number[] = [];

    const quit = reportPortInUse({
      host: true,
      port: 1430,
      logger,
      fatal: true,
      exit: (code: number) => exits.push(code),
    });
    expect(quit).toBe(true);
    expect(exits).toEqual([1]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("127.0.0.1:1430 已被其他进程占用"); // 布尔 host 不会拼成 "true:1430"
    expect(lines.some((line) => line.includes("/__ui-preview/health"))).toBe(true);
    expect(lines.some((line) => line.includes("src/lib/api.ts"))).toBe(true);

    lines.length = 0;
    const skipped = reportPortInUse({
      host: "127.0.0.1",
      port: 1431,
      logger,
      fatal: false,
      exit: (code: number) => exits.push(code),
    });
    expect(skipped).toBe(false);
    expect(exits).toEqual([1]); // vitest 内不退出进程，但原因照报
    expect(lines).toHaveLength(3);
  });

  it("真起 dev server 时端口被占用会报原因，而不是静默或顶层崩溃", async () => {
    const blocker = net.createServer();
    const busy = await listenOn(blocker);
    const errors: string[] = [];
    const logger: Logger = {
      info: () => {},
      warn: () => {},
      warnOnce: () => {},
      error: (message) => errors.push(message),
      clearScreen: () => {},
      hasErrorLogged: () => false,
      hasWarned: false,
    };
    const previous = process.env[boundEnv];
    delete process.env[boundEnv];
    let guarded: ViteDevServer | undefined;
    try {
      guarded = await createServer({
        configFile,
        logLevel: "silent",
        customLogger: logger,
        server: { host: "127.0.0.1", port: busy, strictPort: true, hmr: false },
      });
    } finally {
      await guarded?.close();
      await closeServer(blocker);
      if (previous === undefined) delete process.env[boundEnv];
      else process.env[boundEnv] = previous;
    }
    // VITEST 下守卫不 process.exit（否则会把整个测试进程带走），但必须留下原因。
    expect(errors.join("\n")).toContain("已被其他进程占用");
  }, 60_000);
});
