// 优化前的界面基线截图：用 Chrome DevTools Protocol 驱动真实浏览器打开 mock 预览，
// 逐个流程截图并存下控制台错误。产物只证明浏览器 + mock 数据下的界面外观，
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
const outDir = path.resolve(readArg("--out", "docs/verification/ui-ux-2026-11-04/baseline"));

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

function consoleErrors(cdp) {
  return cdp.events
    .filter((event) => event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
    .map((event) => event.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" "));
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

  const manifest = { base, generatedAt: new Date().toISOString(), shots: [] };
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

        const shot = async (view) => {
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
              };
            })()`,
          );
          manifest.shots.push({ file, theme, size: size.label, view, state, errors: consoleErrors(cdp) });
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

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const errorCount = manifest.shots.reduce((total, item) => total + item.errors.length, 0);
  console.log(`完成：${manifest.shots.length} 张截图，控制台错误 ${errorCount} 条，输出目录 ${outDir}`);
}

main().catch((error) => {
  console.error("基线截图失败:", error.message);
  process.exit(1);
});
