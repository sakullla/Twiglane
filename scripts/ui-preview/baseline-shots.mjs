// 优化前的界面基线截图：用 Chrome DevTools Protocol 驱动真实浏览器打开 mock 预览，
// 逐个流程截图并存下控制台 error、未捕获运行时异常（Runtime.exceptionThrown）
// 和网络失败（Network.loadingFailed / 4xx-5xx 响应）。产物只证明浏览器 + mock 数据下的界面外观，
// 不代表真实 Git 行为、也不代表桌面端（Windows/macOS 实机）结果。
//
// 用法：node scripts/ui-preview/baseline-shots.mjs [--base http://127.0.0.1:1430] [--out docs/verification/ui-ux-2026-11-04/baseline]
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const base = readArg("--base", "http://127.0.0.1:1430");
const outDir = path.resolve(readArg("--out", "docs/verification/ui-ux-markdown-2026-11-08/baseline"));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

const THEMES = ["dark", "light"];
const SIZES = [
  { label: "1280x840", width: 1280, height: 840 },
  { label: "900x600", width: 900, height: 600 },
];
const VIEWS = ["start", "changes", "history", "merge", "settings"];

function chromePath() {
  const found = CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error("找不到 Chrome/Edge，请用 CHROME_PATH 指定浏览器可执行文件");
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function waitForJson(port, urlPath, attempts = 60) {
  return new Promise((resolve, reject) => {
    const tick = (left) => {
      http
        .get({ host: "127.0.0.1", port, path: urlPath }, (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (error) {
              reject(error);
            }
          });
        })
        .on("error", (error) => {
          if (left <= 0) reject(error);
          else setTimeout(() => tick(left - 1), 150);
        });
    };
    tick(attempts);
  });
}

/** 极简 CDP 客户端：单页 + flatten 会话，够用即可，不引入新依赖。 */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, 30_000);
    });
  }

  close() {
    this.socket.close();
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "页面脚本异常");
  return result.result?.value;
}

async function waitFor(cdp, sessionId, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, sessionId, expression)) return;
    await pause(120);
  }
  throw new Error(`等待超时：${label}`);
}

const click = (selector) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return false;
  element.click();
  return true;
})()`;

const typeInto = (selector, text) => `(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, ${JSON.stringify(text)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

const pressEnter = `(() => {
  const input = document.querySelector("#palette-input");
  if (!input) return false;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return true;
})()`;

const pressEscape = `(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return true;
})()`;

async function openCommand(cdp, sessionId, text, readySelector) {
  await evaluate(cdp, sessionId, click(".titlebar-brand"));
  await waitFor(cdp, sessionId, "Boolean(document.querySelector('#palette-input'))", "命令面板");
  await evaluate(cdp, sessionId, typeInto("#palette-input", text));
  await pause(200);
  await evaluate(cdp, sessionId, pressEnter);
  await waitFor(cdp, sessionId, `Boolean(document.querySelector(${JSON.stringify(readySelector)}))`, text);
  await pause(500);
}

/** flatten 会话下每个 target 的事件都带 sessionId；只统计本次截图所属 target。 */
function targetEvents(cdp, sessionId) {
  return cdp.events.filter((event) => event.sessionId === sessionId);
}

function consoleErrors(cdp, sessionId) {
  return targetEvents(cdp, sessionId)
    .filter((event) => event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
    .map((event) => event.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" "));
}

/**
 * 未捕获的运行时异常。只收集 console.error 会把「没有打印错误」误当成「没有运行时错误」，
 * 而 Promise rejection、事件回调抛错往往只在这里出现。
 */
function runtimeExceptions(cdp, sessionId) {
  return targetEvents(cdp, sessionId)
    .filter((event) => event.method === "Runtime.exceptionThrown")
    .map((event) => {
      const details = event.params.exceptionDetails ?? {};
      const description = details.exception?.description ?? details.text ?? "未描述的异常";
      const where = details.url ? ` @ ${details.url}:${(details.lineNumber ?? 0) + 1}` : "";
      return String(description).split("\n")[0] + where;
    });
}

/** 网络失败：请求本身失败（取消的导航排除）与 4xx/5xx 响应分开记录。 */
function networkFailures(cdp, sessionId) {
  const events = targetEvents(cdp, sessionId);
  const failed = events
    .filter((event) => event.method === "Network.loadingFailed" && !event.params.canceled)
    .map((event) => `${event.params.type ?? "请求"} ${event.params.errorText ?? "失败"}`);
  const badStatus = events
    .filter((event) => event.method === "Network.responseReceived" && event.params.response?.status >= 400)
    .map((event) => `HTTP ${event.params.response.status} ${event.params.response.url}`);
  return [...failed, ...badStatus];
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "twiglane-ui-preview-"));
  const browser = spawn(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--force-device-scale-factor=1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const manifest = { base, generatedAt: new Date().toISOString(), summary: null, shots: [] };
  let cdp;
  try {
    const version = await waitForJson(port, "/json/version");
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    for (const theme of THEMES) {
      for (const size of SIZES) {
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Runtime.enable", {}, sessionId);
        await cdp.send("Network.enable", {}, sessionId);
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false },
          sessionId,
        );
        await cdp.send(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: `try { localStorage.setItem("preview-theme", ${JSON.stringify(theme)}); } catch (error) {}` },
          sessionId,
        );
        await cdp.send("Page.navigate", { url: base + "/" }, sessionId);
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('.welcome-recent button, .action-card'))", "起始页");
        await pause(600);

        const shot = async (view, group = "baseline") => {
          const image = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
          const file = `${theme}-${size.label}-${view}.png`;
          fs.writeFileSync(path.join(outDir, file), Buffer.from(image.data, "base64"));
          const state = await evaluate(
            cdp,
            sessionId,
            `(() => {
              const dialog = document.querySelector("[role=dialog]");
              const title = dialog ? dialog.querySelector(".modal-titles") : null;
              return {
                dataTheme: document.documentElement.dataset.theme ?? null,
                bodyBackground: getComputedStyle(document.body).backgroundColor,
                appBackground: getComputedStyle(document.querySelector(".app") ?? document.body).backgroundColor,
                dialogTitle: title ? title.textContent.trim().slice(0, 30) : null,
                fileRows: document.querySelectorAll(".pane.files .file-row, .pane.files li").length,
                historyRows: document.querySelectorAll(".history-row, .commit-row").length,
                horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
                documentSource: document.querySelector(".document-reader .doc-source")?.textContent?.trim() ?? null,
                outlineItems: document.querySelectorAll(".md-outline a").length,
              };
            })()`,
          );
          manifest.shots.push({
            file,
            theme,
            size: size.label,
            view,
            group,
            state,
            errors: consoleErrors(cdp, sessionId),
            exceptions: runtimeExceptions(cdp, sessionId),
            networkFailures: networkFailures(cdp, sessionId),
          });
          console.log("captured", file);
        };

        await shot("start");

        await evaluate(cdp, sessionId, click(".welcome-recent button"));
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
        await pause(900);
        await shot("changes");

        await evaluate(cdp, sessionId, click('[data-view="history"]'));
        await pause(900);
        await shot("history");

        await openCommand(cdp, sessionId, "分支合并", "#merge-modal-title");
        await shot("merge");
        await evaluate(cdp, sessionId, pressEscape);
        await waitFor(cdp, sessionId, "!document.querySelector('[role=dialog]')", "关闭合并弹窗");

        await openCommand(cdp, sessionId, "设置", '[role="dialog"]');
        await shot("settings");
        await evaluate(cdp, sessionId, pressEscape);
        await waitFor(cdp, sessionId, "!document.querySelector('[role=dialog]')", "关闭设置弹窗");

        // Markdown 阅读是这一轮新增的样例，单独成组（group: "markdown"）：
        // 它与「同一数据前后对照」不是一回事，manifest 里分开记录，统计时不能混在一起。
        await evaluate(cdp, sessionId, click('[data-view="files"]'));
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view'))", "文件视图");
        await pause(600);
        // 目录树刚渲染完时点行会被随后的刷新覆盖，这里按「行还在就再点一次」重试。
        const openReadme = `(() => {
          const row = [...document.querySelectorAll(".files-view .file-tree-row")]
            .find((item) => item.textContent.includes("README.md"));
          if (!row) return false;
          row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return true;
        })()`;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await evaluate(cdp, sessionId, openReadme);
          try {
            await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view .markdown-preview .md-body'))", "Markdown 预览", 4_000);
            break;
          } catch {
            await pause(400);
          }
        }
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view .markdown-preview .md-body'))", "Markdown 预览");
        await pause(400);
        await shot("markdown-readme", "markdown");
        await evaluate(
          cdp,
          sessionId,
          `(() => {
            const toggle = [...document.querySelectorAll(".files-view .md-small-button")]
              .find((item) => item.textContent.includes("目录"));
            if (!toggle) return false;
            toggle.click();
            return true;
          })()`,
        );
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view .md-outline button'))", "文档目录");
        await pause(300);
        await shot("markdown-toc", "markdown");

        await cdp.send("Target.closeTarget", { targetId });
      }
    }
  } finally {
    cdp?.close();
    browser.kill();
    // 浏览器进程退出前仍占着 profile 目录，清理失败不应掩盖真正的报错。
    await pause(400);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      console.warn("临时 profile 未清理:", error.message);
    }
  }

  const count = (key) => manifest.shots.reduce((total, item) => total + (item[key]?.length ?? 0), 0);
  manifest.summary = {
    shots: manifest.shots.length,
    baselineShots: manifest.shots.filter((item) => (item.group ?? "baseline") === "baseline").length,
    markdownShots: manifest.shots.filter((item) => item.group === "markdown").length,
    targets: THEMES.length * SIZES.length,
    consoleErrors: count("errors"),
    exceptions: count("exceptions"),
    networkFailures: count("networkFailures"),
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `完成：${manifest.summary.shots} 张截图，控制台错误 ${manifest.summary.consoleErrors} 条，` +
      `未捕获异常 ${manifest.summary.exceptions} 条，网络失败 ${manifest.summary.networkFailures} 条，输出目录 ${outDir}`,
  );
}

main().catch((error) => {
  console.error("基线截图失败:", error.message);
  process.exit(1);
});
