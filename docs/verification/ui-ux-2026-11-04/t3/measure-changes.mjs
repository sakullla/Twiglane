
// T3 改动链路（改动 → 差异 → 暂存 → 提交）的界面度量脚本。
// 打开 mock 预览，把改动视图在三种状态下的工具条、文件列表、提交区几何与文本读出来，顺便截图：
//   single         选中一个文件
//   multi          Ctrl+A 全选后（多文件差异工具条）
//   empty-staging  全部取消暂存 + 写一条草稿（空暂存与字数提示同时成立）
//
// 用法（先在另一个终端 npm run preview:ui）：
//   node docs/verification/ui-ux-2026-11-04/t3/measure-changes.mjs --label after \
//     --out docs/verification/ui-ux-2026-11-04/t3 --shots docs/verification/ui-ux-2026-11-04/t3
//
// 边界：只证明 headless Chrome + mock 数据下的几何与文本，不代表真实 Git 行为，
// 也不代表 Windows/macOS 桌面 WebView 的实际观感（字体、缩放、自绘标题栏都未覆盖）。
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
const outDir = readArg("--out", null);
const shotDir = readArg("--shots", null);
const label = readArg("--label", "run");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];
const chrome = CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
if (!chrome) throw new Error("找不到 Chrome/Edge，请用 CHROME_PATH 指定浏览器可执行文件");

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });

const waitForJson = (port, urlPath, attempts = 80) =>
  new Promise((resolve, reject) => {
    const tick = (left) =>
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
    tick(attempts);
  });

/** 极简 CDP 客户端：单页 + flatten 会话，够用即可，不引入新依赖。 */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
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
        reject(new Error("CDP 超时: " + method));
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

async function waitFor(cdp, sessionId, expression, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, sessionId, expression)) return;
    await pause(120);
  }
  throw new Error("等待超时：" + what);
}

const clickSelector = (selector) =>
  "(() => { const element = document.querySelector(" +
  JSON.stringify(selector) +
  "); if (!element) return false; element.click(); return true; })()";

const pressKeyOnFileList = (key, extra = "") =>
  "(() => { const list = document.querySelector('.file-list'); if (!list) return false; list.focus();" +
  " list.dispatchEvent(new KeyboardEvent('keydown', { key: " +
  JSON.stringify(key) +
  extra +
  ", bubbles: true })); return true; })()";

/**
 * 在页面里跑：一次读齐改动视图的几何、文本与状态类。
 * 写成函数再 toString() 发过去，避免把表达式拼成一长串字符串。
 */
function measureChanges() {
  const round = (value) => Math.round(value * 10) / 10;
  const box = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) };
  };
  const text = (element) => (element ? element.textContent.trim().replace(/\s+/g, " ") : null);
  const clip = (element) =>
    element
      ? {
          scrollW: element.scrollWidth,
          clientW: element.clientWidth,
          truncated: element.scrollWidth > element.clientWidth + 1,
        }
      : null;
  const all = (selector) => [...document.querySelectorAll(selector)];
  const one = (selector) => document.querySelector(selector);
  const toolbar = one(".diff-toolbar");
  const meta = one(".composer-meta");
  const commit = one(".composer-commit");
  const field = one(".file-tools .field");
  const rows = all(".file-row");

  return {
    viewport: { w: innerWidth, h: innerHeight },
    theme: document.documentElement.dataset.theme,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    pane: { w: one(".pane.files")?.clientWidth ?? null },
    fileTools: { searchW: field ? field.clientWidth : null },
    fileList: {
      h: one(".file-list")?.clientHeight ?? null,
      rows: rows.length,
      rowH: rows.length ? round(rows[0].getBoundingClientRect().height) : null,
    },
    groups: all(".file-group").map((group) => ({
      text: text(group),
      first: group.classList.contains("first"),
      rule: group.classList.contains("first")
        ? "none"
        : getComputedStyle(group, "::before").height + " " + getComputedStyle(group, "::before").backgroundColor,
    })),
    composer: {
      h: round(one(".composer")?.getBoundingClientRect().height ?? 0),
      branch: text(one(".composer-branch")),
      scope: text(one(".composer-scope")),
      scopeCls: one(".composer-scope")?.className ?? null,
      meta: text(meta),
      metaCls: meta ? meta.className : null,
      metaOverflow: meta ? meta.scrollWidth > meta.clientWidth + 1 : null,
      metaIcon: meta ? getComputedStyle(meta.querySelector(".icon")).color : null,
      counter: text(one(".composer-count")),
      inline: text(one(".composer-inline-action")),
      commitDisabled: commit ? commit.disabled : null,
      commitTitle: commit ? commit.title : null,
      shortcutVisible: one(".composer-commit kbd")
        ? getComputedStyle(one(".composer-commit kbd")).display !== "none"
        : false,
      textareaH: round(one(".composer-box textarea")?.getBoundingClientRect().height ?? 0),
    },
    toolbar: toolbar
      ? {
          h: round(toolbar.getBoundingClientRect().height),
          overflow: toolbar.scrollWidth > toolbar.clientWidth + 1,
          groups: [...toolbar.children].map((group) => ({
            cls: String(group.className),
            w: round(group.getBoundingClientRect().width),
            divider: getComputedStyle(group).borderLeftWidth + " / " + getComputedStyle(group).paddingLeft,
            text: text(group)?.slice(0, 40),
          })),
          path: text(one(".diff-path")),
          pathW: one(".diff-path") ? round(one(".diff-path").getBoundingClientRect().width) : null,
          side: text(one(".diff-side")),
          navPosition: text(one(".file-nav-pos")),
          navPositionVisible: one(".file-nav-pos")
            ? getComputedStyle(one(".file-nav-pos")).display !== "none"
            : false,
          labels: all(".diff-toolbar .diff-hist-label").map((node) => ({
            text: text(node),
            visible: getComputedStyle(node).display !== "none",
          })),
          countClip: clip(one(".multi-stack-count")),
        }
      : null,
    diff: {
      scrollerW: one(".diff-scroll")?.clientWidth ?? null,
      scrollW: one(".diff-scroll")?.scrollWidth ?? null,
      lineH: all(".diff-line").length ? round(all(".diff-line")[0].getBoundingClientRect().height) : null,
      hunkBtn: text(one(".hunk-btn")),
      hunkBtnBox: box(one(".hunk-btn")),
    },
  };
}

const MEASURE = "(" + measureChanges.toString() + ")()";

const SIZES = [
  { label: "1280x840", width: 1280, height: 840 },
  { label: "900x600", width: 900, height: 600 },
];

async function main() {
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "twiglane-t3-"));
  const browser = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--force-device-scale-factor=1",
      "--remote-debugging-port=" + port,
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const report = { label, base, capturedAt: new Date().toISOString(), cases: [], summary: null };
  let cdp;
  try {
    const version = await waitForJson(port, "/json/version");
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    for (const theme of ["dark", "light"]) {
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
          { source: "try { localStorage.setItem('preview-theme', " + JSON.stringify(theme) + "); } catch (error) {}" },
          sessionId,
        );
        await cdp.send("Page.navigate", { url: base + "/" }, sessionId);
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('.welcome-recent button'))", "起始页");
        await pause(500);
        await evaluate(cdp, sessionId, clickSelector(".welcome-recent button"));
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
        await pause(1200);

        const capture = async (state) => {
          const data = await evaluate(cdp, sessionId, MEASURE);
          data.theme = theme;
          data.size = size.label;
          data.state = state;
          if (shotDir) {
            const image = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
            const file = label + "-" + theme + "-" + size.label + "-" + state + ".png";
            fs.writeFileSync(path.join(shotDir, file), Buffer.from(image.data, "base64"));
            data.shot = file;
          }
          report.cases.push(data);
          console.log("captured", theme, size.label, state);
        };

        await capture("single");
        await evaluate(cdp, sessionId, pressKeyOnFileList("a", ", ctrlKey: true"));
        await pause(1400);
        await capture("multi");
        await evaluate(cdp, sessionId, pressKeyOnFileList("Escape"));
        await pause(600);
        // 全部取消暂存 → 暂存区为空
        await evaluate(
          cdp,
          sessionId,
          "(() => { const button = [...document.querySelectorAll('.file-group button')].find((item) =>" +
            " /全部取消暂存/.test(item.getAttribute('aria-label') || '')); if (!button) return false; button.click(); return true; })()",
        );
        await pause(2000);
        // 再写一条草稿：字数提示与「全部暂存」应当同时在
        await evaluate(
          cdp,
          sessionId,
          "(() => { const area = document.querySelector('.composer-box textarea'); if (!area) return false;" +
            " const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;" +
            " setter.call(area, '收拢改动链路的重复提示并补齐就地反馈');" +
            " area.dispatchEvent(new Event('input', { bubbles: true })); return true; })()",
        );
        await pause(600);
        await capture("empty-staging");
        await cdp.send("Target.closeTarget", { targetId });
      }
    }
  } finally {
    cdp?.close();
    browser.kill();
    await pause(400);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      console.warn("临时 profile 未清理:", error.message);
    }
  }
  report.summary = {
    cases: report.cases.length,
    horizontalOverflow: report.cases.filter((item) => item.horizontalOverflow).length,
    toolbarOverflow: report.cases.filter((item) => item.toolbar?.overflow).length,
    composerOverflow: report.cases.filter((item) => item.composer.metaOverflow).length,
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (outDir) fs.writeFileSync(path.join(outDir, label + ".json"), json);
  console.log(JSON.stringify(report.summary));
}

main().catch((error) => {
  console.error("度量失败:", error.message);
  process.exit(1);
});
