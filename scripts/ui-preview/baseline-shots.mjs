// 界面证据截图：用 Chrome DevTools Protocol 驱动真实浏览器打开 mock 预览，
// 逐个流程截图；正常情况下按「起始页/改动/历史/合并/设置」× 深色/浅色 × 1280×840/900×600 截图，
// Markdown 阅读样例另存为 files-markdown / files-markdown-toc 两张（group: "markdown"），
// 再用同一套 mock 参数截关键失败状态（group: "failure"，见 FAILURE_STATES）。
//
// 产物命名与已提交证据一致：<theme>-<size>-<view>.png 写到 --out 目录，
// manifest.json 默认写到 --out 的上一级（可用 --manifest 覆盖），逐张记录 bytes 与 sha256，
// 因此提交后的证据可以由这个脚本原样重建与校验。
//
// 用法：node scripts/ui-preview/baseline-shots.mjs [--base http://127.0.0.1:1430] [--out docs/verification/ui-ux-markdown-2026-11-08/after] [--manifest <path>] [--failure-targets dark:1280x840,light:1280x840,dark:900x600,light:900x600]
import { spawn } from "node:child_process";
import crypto from "node:crypto";
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
const outDir = path.resolve(readArg("--out", "docs/verification/ui-ux-markdown-2026-11-08/after"));
// 与已提交证据一致：图片在 after/，manifest 在验证目录根部，file 字段相对 manifest。
const manifestPath = path.resolve(readArg("--manifest", path.join(path.dirname(outDir), "manifest.json")));

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

const typeIntoArea = (selector, text) => `(() => {
  const area = document.querySelector(${JSON.stringify(selector)});
  if (!area) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(area, ${JSON.stringify(text)});
  area.dispatchEvent(new Event("input", { bubbles: true }));
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

/** 打开起始页第一条最近仓库，等到调用方给的就绪条件。 */
async function openRepository(cdp, sessionId, ready, label) {
  await waitFor(cdp, sessionId, "Boolean(document.querySelector('.welcome-recent button'))", "起始页");
  await evaluate(cdp, sessionId, click(".welcome-recent button"));
  await waitFor(cdp, sessionId, ready, label);
  await pause(700);
}

/** 文件视图 + 打开 README.md：目录树刚渲染时点击可能被随后的刷新覆盖，所以按「行还在就再点一次」重试。 */
async function openReadme(cdp, sessionId, ready, label) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await evaluate(cdp, sessionId, ready)) return;
    await evaluate(
      cdp,
      sessionId,
      `(() => {
        const row = [...document.querySelectorAll(".files-view .file-tree-row")]
          .find((item) => item.textContent.includes("README.md"));
        if (!row) return false;
        row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      })()`,
    );
    await pause(600);
  }
  await waitFor(cdp, sessionId, ready, label);
}

/**
 * 同一 mock 数据上的关键失败/未知状态（R3、R4、R6）：每一项都通过 mock 的查询参数进入，
 * 界面证据因此能和具体参数一一对应，不再只靠合成断言。
 */
const FAILURE_STATES = [
  {
    view: "sync-unchecked",
    query: "remote=unchecked",
    state: "远程未核对：折叠的同步按钮显示「未核」，计数只是记录的对比",
    run: async (cdp, sessionId) => {
      await openRepository(cdp, sessionId, "Boolean(document.querySelector('.sync-pill'))", "同步按钮");
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.sync-pill [data-sync-remote=\"off\"]'))", "未核标记");
    },
  },
  {
    view: "sync-stale",
    query: "remote=stale",
    state: "远程已过期：折叠的同步按钮显示「过期」并带上次核对时间",
    run: async (cdp, sessionId) => {
      await openRepository(cdp, sessionId, "Boolean(document.querySelector('.sync-pill'))", "同步按钮");
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.sync-pill [data-sync-remote=\"stale\"]'))", "过期标记");
    },
  },
  {
    view: "commit-error",
    query: "commit=error",
    state: "本地提交失败：长原因展开换行读全，草稿与暂存保留",
    run: async (cdp, sessionId) => {
      await openRepository(cdp, sessionId, "Boolean(document.querySelector('.composer textarea'))", "提交区");
      await evaluate(cdp, sessionId, typeIntoArea(".composer textarea", "修复同步标记与提交失败说明"));
      await pause(250);
      await evaluate(cdp, sessionId, click(".composer-commit"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('[data-commit-error]'))", "提交失败原因");
      await evaluate(cdp, sessionId, click(".composer-meta .composer-expand"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('[data-commit-error].expanded'))", "展开的失败原因");
      await pause(350);
    },
  },
  {
    view: "commit-push-error",
    query: "commit=push",
    state: "本地提交成功、推送失败：两个阶段分开说明，长原因展开且只重试推送",
    run: async (cdp, sessionId) => {
      await openRepository(cdp, sessionId, "Boolean(document.querySelector('.composer textarea'))", "提交区");
      await evaluate(cdp, sessionId, typeIntoArea(".composer textarea", "修复同步标记与提交失败说明"));
      await pause(250);
      await evaluate(cdp, sessionId, click(".composer-push"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('[data-push-error]'))", "推送失败原因");
      await evaluate(cdp, sessionId, click("[data-push-error] .composer-expand"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('[data-push-error] [role=status].expanded'))", "展开的推送失败原因");
      await pause(350);
    },
  },
  {
    view: "doc-error",
    query: "doc=error",
    state: "文档读取失败：就地说明原因，仍给出重新读取与源码退路",
    run: async (cdp, sessionId) => {
      await openRepository(cdp, sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
      await evaluate(cdp, sessionId, click('[data-view="files"]'));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view'))", "文件视图");
      await pause(600);
      await openReadme(cdp, sessionId, "Boolean(document.querySelector('.files-view .doc-state[role=\"alert\"]'))", "文档读取失败");
    },
  },
  {
    view: "doc-large",
    query: "doc=large",
    state: "文档超过排版预览上限：给出真实状态与查看源码的退路",
    run: async (cdp, sessionId) => {
      await openRepository(cdp, sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
      await evaluate(cdp, sessionId, click('[data-view="files"]'));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view'))", "文件视图");
      await pause(600);
      await openReadme(
        cdp,
        sessionId,
        "(() => [...document.querySelectorAll('.files-view .doc-state')].some((node) => node.textContent.includes('排版预览上限')))()",
        "排版预览上限",
      );
    },
  },
  {
    view: "search-error",
    query: "search=error",
    state: "搜索局部失败：显示失败原因而不是「没有匹配」，原因旁就地给出「重试搜索 / 重新读取目录」",
    run: async (cdp, sessionId) => {
      await openRepository(cdp, sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
      await evaluate(cdp, sessionId, click('[data-view="files"]'));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view'))", "文件视图");
      await pause(600);
      await evaluate(cdp, sessionId, click('.files-view [aria-label="全仓库搜索"]'));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('#file-content-search'))", "全文搜索输入");
      await evaluate(cdp, sessionId, typeInto("#file-content-search", "import"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.file-search-note.danger'))", "搜索失败原因");
      await waitFor(
        cdp,
        sessionId,
        "Boolean(document.querySelector('.file-search-note.danger [data-search-retry=\"content\"]'))",
        "搜索失败的就地重试入口",
      );
      await pause(350);
    },
  },
  {
    view: "filter-error",
    query: "filter=error",
    state: "树过滤补齐失败：说明补齐失败而不是「没有匹配」，并给「重试补齐」",
    run: async (cdp, sessionId) => {
      await openRepository(cdp, sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
      await evaluate(cdp, sessionId, click('[data-view="files"]'));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view'))", "文件视图");
      await pause(600);
      await evaluate(cdp, sessionId, typeInto('.files-view [aria-label="过滤文件树"]', "part"));
      // 没有可显示的行时，失败说明与「重试补齐」在树体空态里（状态行不重复一遍）。
      await waitFor(
        cdp,
        sessionId,
        "Boolean(document.querySelector('.files-view .empty.compact[role=\"alert\"] [data-search-retry=\"tree\"]'))",
        "补齐失败的就地重试入口",
      );
      await pause(350);
    },
  },
  {
    view: "find-error",
    query: "search=error",
    state: "文件内查找失败：原因旁就地给出「重试查找 / 重新读取文件」",
    run: async (cdp, sessionId) => {
      await openRepository(cdp, sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
      await evaluate(cdp, sessionId, click('[data-view="files"]'));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view'))", "文件视图");
      await pause(600);
      await openReadme(cdp, sessionId, "Boolean(document.querySelector('.files-view .markdown-preview .md-body'))", "README 打开");
      await evaluate(cdp, sessionId, click('.files-view [aria-label="在文件内搜索"]'));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view [data-search-scope=\"file\"]'))", "文件内查找输入");
      await evaluate(cdp, sessionId, typeInto('.files-view [data-search-scope="file"]', "import"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.file-note.danger [data-search-retry=\"file\"]'))", "文件内查找的失败原因与重试入口");
      await pause(350);
    },
  },
  {
    // T5：cliora 任务起点不可用时的失败态（历史里任务行标出失败，详情就地说明并给出重新读取，不摆出旧结果）。
    view: "task-error",
    query: "cliora=1&task=error",
    state: "任务起点不可用：历史任务行标出失败，详情就地说明并给出重新读取",
    run: async (cdp, sessionId) => {
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.history-task-row'))", "任务净差异行");
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.task-failure'))", "任务读取失败");
      await pause(500);
    },
  },
  {
    // 多选只看最终结果：两端之间的净文件清单读取失败时不冒充「没有文件变化」，就地给出重新读取。
    view: "history-final-error",
    query: "history=compare-error",
    state: "历史多选：最终结果读取失败时说明原因并给出重新读取",
    run: async (cdp, sessionId) => {
      await openRepository(cdp, sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
      await evaluate(cdp, sessionId, click('[data-view="history"]'));
      await waitFor(cdp, sessionId, "document.querySelectorAll('.history-list [role=option]').length > 0", "提交列表");
      const pick = (index, shift) => `(() => {
        const rows = [...document.querySelectorAll(".history-list [role=option]")];
        const row = rows[${index}];
        if (!row) return false;
        row.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: ${shift} }));
        return true;
      })()`;
      await evaluate(cdp, sessionId, pick(0, false));
      await evaluate(cdp, sessionId, pick(3, true));
      await waitFor(cdp, sessionId, "document.body.textContent.includes('最终变更没有读取成功')", "失败说明");
      await pause(500);
    },
  },
];

/**
 * 失败态采集组合：默认与已提交证据一致（两主题 1280×840 + 深色 900×600）。
 * 用 --failure-targets 显式指定（逗号分隔的 `<theme>:<size>`），四种组合都采是：
 * --failure-targets dark:1280x840,light:1280x840,dark:900x600,light:900x600
 * 正常视图仍覆盖两主题 × 两尺寸；失败态在 README 里逐张对应需求，不混进同数据对照。
 */
const DEFAULT_FAILURE_TARGETS = ["dark:1280x840", "light:1280x840", "dark:900x600"];
const failureTargets = new Set(
  readArg("--failure-targets", DEFAULT_FAILURE_TARGETS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
/** 拼错的组合不能安静地少采：明确列出可选值，避免「跑完了但少了一组」被当成脚本行为。 */
const KNOWN_TARGETS = new Set(THEMES.flatMap((theme) => SIZES.map((size) => `${theme}:${size.label}`)));
for (const target of failureTargets) {
  if (!KNOWN_TARGETS.has(target)) {
    console.warn(`忽略未知的失败态组合 ${target}；可选：${[...KNOWN_TARGETS].join(", ")}`);
  }
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

/** 未捕获的运行时异常。只收集 console.error 会把「没有打印错误」误当成「没有运行时错误」。 */
function runtimeExceptions(cdp, sessionId) {
  return targetEvents(cdp, sessionId)
    .filter((event) => event.method === "Runtime.exceptionThrown")
    .map((event) => {
      const details = event.params.exceptionDetails ?? {};
      const description = details.exception?.description ?? details.text ?? "未描述的异常";
      return String(description).split("\n")[0];
    });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
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

  const manifest = {
    // 当前工作流标识：runner 会核对它，不能沿用上一批证据的 ID。
    workflow: "2026-11-13-modern-ui-ux-redesign",
    task: "T6",
    capturedAt: new Date().toISOString(),
    environment: {
      browser: "",
      userAgent: "",
      devicePixelRatio: 1,
      platform: os.platform(),
      node: process.version,
    },
    page: {
      url: base,
      build: "npm run preview:ui（scripts/ui-preview/vite.config.mjs，mock API，127.0.0.1:1430）",
      data: "scripts/ui-preview/mock-api.ts + mock-files.ts + samples.ts（与 01 基线同一组数据）",
      worker: "预览页的 Markdown 解析在工作线程里进行；失败态由 ?remote= / ?commit= / ?doc= / ?search= 参数进入",
    },
    groups: {
      baseline: "start/changes/history/task/worktree/composer/merge/settings：与 01 基线同数据、同主题、同尺寸",
      markdown: "files-markdown/files-markdown-toc：Markdown 排版预览与目录工具行，单独成组，不参与优化前后对照",
      failure:
        "关键失败/未知状态：sync-unchecked/sync-stale/commit-error/commit-push-error/doc-error/doc-large/" +
        "search-error/filter-error/find-error/task-error/history-cancel-recovered，逐张对应需求",
    },
    shots: [],
    // 没有采集到的视图与原因：证据清单必须能解释「为什么少了一张」，不能安静跳过。
    skipped: [],
  };
  let cdp;
  try {
    const version = await waitForJson(port, "/json/version");
    const browserLabel = String(version.Browser ?? "").replace(/^Chrome\//, "").trim() || "未知版本";
    manifest.environment.browser = `Chrome ${browserLabel}（DevTools 协议驱动）`;
    manifest.environment.userAgent = version["User-Agent"] ?? "";
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

        const skipped = manifest.skipped;
        const shot = async (view, group = "baseline", state = "normal") => {
          const image = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
          const buffer = Buffer.from(image.data, "base64");
          const file = `${theme}-${size.label}-${view}.png`;
          fs.writeFileSync(path.join(outDir, file), buffer);
          manifest.shots.push({
            file: path.relative(path.dirname(manifestPath), path.join(outDir, file)).split(path.sep).join("/"),
            theme,
            size: size.label,
            view,
            // group 逐张写进 manifest：尾部的 counts() 与文档的「对照 / Markdown / 失败态」都按它统计，
            // 只写 state 文字时分组无法逐条校验。
            group,
            state,
            bytes: buffer.length,
            sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
          });
          const errors = [...consoleErrors(cdp, sessionId), ...runtimeExceptions(cdp, sessionId)];
          console.log("captured", file, `group=${group}`, errors.length > 0 ? `控制台错误 ${errors.length} 条` : "");
        };

        await shot("start", "baseline", "起始页");

        await evaluate(cdp, sessionId, click(".welcome-recent button"));
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
        await pause(900);
        await shot("changes", "baseline", "改动视图（同数据对照）");

        await evaluate(cdp, sessionId, click('[data-view="history"]'));
        await pause(900);
        await shot("history", "baseline", "历史视图（同数据对照）");

        // T5：任务净差异、工作区总览与提交区各留一张同数据对照（同一 mock 数据、同一主题与尺寸）。
        // 任务范围只来自 cliora 链接：预览用 ?cliora=1 模拟一次跳转，历史按起点过滤并选中任务净差异。
        await cdp.send("Page.navigate", { url: base + "/?cliora=1" }, sessionId);
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('.history-task-row[aria-pressed=true]'))", "历史里的任务净差异");
        await waitFor(cdp, sessionId, "document.querySelectorAll('.task-detail .file-list .file-row').length > 0", "任务文件队列");
        await pause(800);
        await shot("task", "baseline", "历史里的任务净差异：起点范围、任务文件队列与净差异");

        await evaluate(cdp, sessionId, click('[aria-label^="当前仓库"]'));
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('.switcher-group-name'))", "工作区总览");
        await pause(700);
        await shot("worktree", "baseline", "工作区总览：按主仓库分组与逐项状态");
        await evaluate(cdp, sessionId, pressEscape);
        await waitFor(cdp, sessionId, "!document.querySelector('[role=dialog]')", "关闭工作区总览");

        await evaluate(cdp, sessionId, click('[data-view="changes"]'));
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('.composer textarea'))", "提交区");
        await evaluate(cdp, sessionId, typeIntoArea(".composer textarea", "审阅任务范围并提交\n\n- 起点 main~2\n- 净差异只读，提交只按真实暂存范围"));
        await pause(500);
        await shot("composer", "baseline", "提交区：真实暂存范围与提交草稿");

        await openCommand(cdp, sessionId, "分支合并", "#merge-modal-title");
        await shot("merge", "baseline", "合并弹窗（同数据对照）");
        await evaluate(cdp, sessionId, pressEscape);
        await waitFor(cdp, sessionId, "!document.querySelector('[role=dialog]')", "关闭合并弹窗");

        await openCommand(cdp, sessionId, "设置", '[role="dialog"]');
        await shot("settings", "baseline", "设置弹窗（同数据对照）");
        await evaluate(cdp, sessionId, pressEscape);
        await waitFor(cdp, sessionId, "!document.querySelector('[role=dialog]')", "关闭设置弹窗");

        // Markdown 阅读是这一轮新增的样例，单独成组（group: "markdown"）：
        // 它与「同一数据前后对照」不是一回事，manifest 里分开记录，统计时不能混在一起。
        await evaluate(cdp, sessionId, click('[data-view="files"]'));
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view'))", "文件视图");
        await pause(600);
        await openReadme(cdp, sessionId, "Boolean(document.querySelector('.files-view .markdown-preview .md-body'))", "Markdown 预览");
        // 解析在工作线程里：预览容器出现不等于正文已经上屏，截图要等标题锚点渲染出来。
        await waitFor(
          cdp,
          sessionId,
          "Boolean(document.querySelector('.files-view .markdown-preview .md-body [data-markdown-anchor]'))",
          "Markdown 正文",
        );
        await pause(400);
        await shot("files-markdown", "markdown", "Markdown 默认排版预览");
        // 文件视图的预览有标题时在工具条上给出目录图标开关（aria-label「文档目录」）；
        // 仍然按「开关真的存在」决定是否截图，缺失时把原因写进 manifest，不伪造一张目录图。
        const toggled = await evaluate(
          cdp,
          sessionId,
          `(() => {
            const toggle = document.querySelector('.files-view button[aria-label="文档目录"]');
            if (!toggle) return false;
            toggle.click();
            return true;
          })()`,
        );
        if (toggled) {
          try {
            await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view .md-outline button'))", "文档目录");
            await pause(300);
            await shot("files-markdown-toc", "markdown", "Markdown 标题目录展开");
          } catch (error) {
            skipped.push({ view: "files-markdown-toc", group: "markdown", reason: error.message });
            console.log("跳过 files-markdown-toc：", error.message);
          }
        } else {
          skipped.push({
            view: "files-markdown-toc",
            group: "markdown",
            reason: "文件视图的 Markdown 预览没有目录开关：文档没有标题，或目录入口没有随预览出现。",
          });
          console.log("跳过 files-markdown-toc：文件视图的预览没有目录开关");
        }

        // 关键失败/未知状态：同一 mock 数据上的参数化场景，逐项对应 R3/R4/R6。
        // 组合固定为两主题 1280×840 + 深色 900×600，与 README 的证据表一致。
        if (failureTargets.has(`${theme}:${size.label}`)) {
          for (const failure of FAILURE_STATES) {
            await cdp.send("Page.navigate", { url: `${base}/?${failure.query}` }, sessionId);
            await waitFor(cdp, sessionId, "Boolean(document.querySelector('.welcome-recent button'))", `${failure.view} 起始页`);
            await failure.run(cdp, sessionId);
            await shot(failure.view, "failure", failure.state);
          }
        }

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

  const counts = (group) => manifest.shots.filter((item) => item.group === group).length;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `完成：${manifest.shots.length} 张截图（对照 ${counts("baseline")} / Markdown ${counts("markdown")} / 失败态 ${counts("failure")}），` +
      `输出目录 ${outDir}，manifest ${manifestPath}`,
  );
}

main().catch((error) => {
  console.error("基线截图失败:", error.message);
  process.exit(1);
});