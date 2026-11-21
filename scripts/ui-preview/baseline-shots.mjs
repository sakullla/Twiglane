// 界面证据截图：用 Chrome DevTools Protocol 驱动真实浏览器打开 mock 预览，
// 逐个流程截图；正常情况下按「起始页/改动/历史/合并/设置」× 深色/浅色 × 1280×840/900×600 截图，
// Markdown 阅读样例另存为 files-markdown / files-markdown-toc 两张（group: "markdown"），
// 再用同一套 mock 参数截关键失败状态（group: "failure"，见 FAILURE_STATES）。
//
// 产物命名与已提交证据一致：<theme>-<size>-<view>.png 写到 --out 目录，
// manifest.json 默认写到 --out 的上一级（可用 --manifest 覆盖），逐张记录 bytes 与 sha256，
// 因此提交后的证据可以由这个脚本原样重建与校验。
//
// 用法：node scripts/ui-preview/baseline-shots.mjs [--base http://127.0.0.1:1430] [--out docs/verification/ui-ux-markdown-2026-11-08/after] [--manifest <path>] [--workflow <id> --task <id>] [--failure-targets dark:1280x840,light:1280x840,dark:900x600,light:900x600] [--scale 2]
//
// manifest 的 workflow/task 身份不在本脚本里维护：由调用方（scripts/run-ui-verification.mjs）用
// --workflow/--task 传入，脚本自己不再保留「上一批的默认身份」。两个参数都不传时 manifest 写 null
// 并标注来源，只当图片用（README 截图）；只传一个视为调用错误。
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
const projectsOnly = args.includes("--projects");
const full = args.includes("--full");
/** 批次身份只能由调用方给：这里没有默认工作流，也不会替调用方猜。 */
const workflowId = readArg("--workflow", "").trim();
const taskId = readArg("--task", "").trim();
const identity = workflowId || taskId
  ? {
      source: "cli",
      note: "由调用方传入：身份只有一处来源（run-ui-verification.mjs），本脚本不维护默认工作流。",
      workflow: workflowId,
      task: taskId,
    }
  : {
      source: "unspecified",
      note: "未传 --workflow/--task：这份 manifest 只说明图片（README 截图用），不作为任何批次的交付证据。",
      workflow: null,
      task: null,
    };
const base = readArg("--base", "http://127.0.0.1:1430");
const outDir = path.resolve(readArg("--out", "") || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "twiglane-shots-")), "after"));
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

// README 截图用 --scale 2 取高清图；证据截图保持默认 1。
const SCALE = Number(readArg("--scale", "1"));
const THEMES = ["dark", "light"];
const SIZES = [
  { label: "1280x840", width: 1280, height: 840 },
  { label: "900x600", width: 900, height: 600 },
];
const representative = {
  "dark:1280x840": ["changes", "task", "worktree", "sync-stale", "commit-push-error"],
  "light:1280x840": ["history", "composer", "settings", "files-markdown-toc", "doc-large"],
  "dark:900x600": ["start", "task-error"],
  "light:900x600": ["merge", "search-error"],
};

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
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown" || (message.method === "Runtime.consoleAPICalled" && message.params.type === "error")) {
        this.events.push(message);
      }
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.socket.close();
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(cdp, sessionId, expression) {
  let result;
  try {
    result = await cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
  } catch (error) {
    // 失败时要能看出挂在哪一句上：否则「CDP 超时」无法区分是等待条件还是等待动画。
    throw new Error(`${error.message}｜表达式：${expression.replace(/\s+/g, " ").slice(0, 140)}`);
  }
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "页面脚本异常");
  return result.result?.value;
}

async function waitFor(cdp, sessionId, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, sessionId, expression)) return;
    await pause(60);
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

async function navigate(cdp, sessionId, url) {
  const expected = new URL(url).href;
  await cdp.send("Page.navigate", { url: expected }, sessionId);
  await waitFor(cdp, sessionId, `location.href === ${JSON.stringify(expected)} && document.readyState !== "loading"`, expected);
}

async function openCommand(cdp, sessionId, text, readySelector) {
  await evaluate(cdp, sessionId, click(".titlebar-brand"));
  await waitFor(cdp, sessionId, "Boolean(document.querySelector('#palette-input'))", "命令面板");
  await evaluate(cdp, sessionId, typeInto("#palette-input", text));
  await waitFor(cdp, sessionId, `document.querySelector('.palette-item[aria-selected="true"][aria-disabled="false"] > span')?.textContent.trim() === ${JSON.stringify(text)}`, "命令可用：" + text);
  await evaluate(cdp, sessionId, pressEnter);
  await waitFor(cdp, sessionId, `Boolean(document.querySelector(${JSON.stringify(readySelector)}))`, text);
}

/** 打开起始页第一条最近仓库，等到调用方给的就绪条件。 */
async function openRepository(cdp, sessionId, ready, label) {
  await waitFor(cdp, sessionId, "Boolean(document.querySelector('.welcome-recent button'))", "起始页");
  await evaluate(cdp, sessionId, click(".welcome-recent button"));
  await waitFor(cdp, sessionId, ready, label);
}

/** 打开 README.md 后按调用方指定的预览、失败或超限状态判断完成。 */
async function openReadme(cdp, sessionId, ready, label) {
  const row = `[...document.querySelectorAll('.workbench-view[data-active="true"] .files-view .file-tree-row')]
    .find((item) => item.textContent.includes("README.md"))`;
  await waitFor(cdp, sessionId, `Boolean(${row})`, "README.md 目录树项");
  if (!(await evaluate(cdp, sessionId, ready))) await evaluate(cdp, sessionId, `(${row})?.click()`);
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
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.composer-commit:not(:disabled)'))", "提交可用");
      await evaluate(cdp, sessionId, click(".composer-commit"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('[data-commit-error]'))", "提交失败原因");
      await evaluate(cdp, sessionId, click(".composer-meta .composer-expand"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('[data-commit-error].expanded'))", "展开的失败原因");
    },
  },
  {
    view: "commit-push-error",
    query: "commit=push",
    state: "本地提交成功、推送失败：两个阶段分开说明，长原因展开且只重试推送",
    run: async (cdp, sessionId) => {
      await openRepository(cdp, sessionId, "Boolean(document.querySelector('.composer textarea'))", "提交区");
      await evaluate(cdp, sessionId, typeIntoArea(".composer textarea", "修复同步标记与提交失败说明"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.composer-push:not(:disabled)'))", "提交并推送可用");
      await evaluate(cdp, sessionId, click(".composer-push"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('[data-push-error]'))", "推送失败原因");
      await evaluate(cdp, sessionId, click("[data-push-error] .composer-expand"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('[data-push-error] [role=status].expanded'))", "展开的推送失败原因");
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
      await openCommand(cdp, sessionId, "全仓库搜索", "#file-content-search");
      await evaluate(cdp, sessionId, typeInto("#file-content-search", "import"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.file-search-note.danger'))", "搜索失败原因");
      await waitFor(
        cdp,
        sessionId,
        "Boolean(document.querySelector('.file-search-note.danger [data-search-retry=\"content\"]'))",
        "搜索失败的就地重试入口",
      );
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
      await evaluate(cdp, sessionId, typeInto('.files-view [aria-label="过滤文件树"]', "part"));
      // 没有可显示的行时，失败说明与「重试补齐」在树体空态里（状态行不重复一遍）。
      await waitFor(
        cdp,
        sessionId,
        "Boolean(document.querySelector('.files-view .empty.compact[role=\"alert\"] [data-search-retry=\"tree\"]'))",
        "补齐失败的就地重试入口",
      );
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
      await openReadme(cdp, sessionId, "Boolean(document.querySelector('.files-view .markdown-preview .md-body'))", "README 打开");
      await evaluate(cdp, sessionId, click('.files-view [aria-label="在文件内搜索"]'));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view [data-search-scope=\"file\"]'))", "文件内查找输入");
      await evaluate(cdp, sessionId, typeInto('.files-view [data-search-scope="file"]', "import"));
      await waitFor(cdp, sessionId, "Boolean(document.querySelector('.file-note.danger [data-search-retry=\"file\"]'))", "文件内查找的失败原因与重试入口");
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
const customFailureTargets = args.includes("--failure-targets");
const failureTargets = new Set(
  readArg("--failure-targets", DEFAULT_FAILURE_TARGETS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
/** 拼错的组合不能安静地少采：明确列出可选值，避免「跑完了但少了一组」被当成脚本行为。 */
const KNOWN_TARGETS = new Set(THEMES.flatMap((theme) => SIZES.map((size) => `${theme}:${size.label}`)));
for (const target of failureTargets) {
  if (target !== "none" && !KNOWN_TARGETS.has(target)) {
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
  // 身份只许成套给：只有一半的 workflow/task 说明调用方拼错了参数，不能拿它生成一份半新半空的 manifest。
  if (identity.source === "cli" && (!identity.workflow || !identity.task)) {
    throw new Error("--workflow 与 --task 必须同时提供（当前 " + JSON.stringify({ workflow: identity.workflow, task: identity.task }) + "）");
  }
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

  const browserClosed = new Promise((resolve) => browser.once("close", resolve));

  const manifest = {
    // 当前批次身份：来自调用方（--workflow/--task），这里不存默认值，也不沿用上一批证据的 ID。
    workflow: identity.workflow,
    task: identity.task,
    identity,
    capturedAt: new Date().toISOString(),
    environment: {
      browser: "",
      userAgent: "",
      devicePixelRatio: SCALE,
      platform: os.platform(),
      node: process.version,
    },
    page: {
      url: base,
      build: "scripts/ui-preview/vite.config.mjs（mock API）",
      data: projectsOnly ? "?projects=1/missing：60 个项目成员、长名称、同名路径、收藏、外机/缺源快照与项目外仓库" : "scripts/ui-preview/mock-api.ts + mock-files.ts + samples.ts（与 01 基线同一组数据）",
      worker: "预览页的 Markdown 解析在工作线程里进行；失败态由 ?remote= / ?commit= / ?doc= / ?search= 参数进入",
    },
    groups: {
      ...(projectsOnly || !full ? { projects: "桌面展示项目管理和项目外仓库，窄窗口展示候选选择和来源失效；每个状态采集一次" } : {}),
      baseline: "start/changes/history/task/worktree/composer/merge/settings：与 01 基线同数据、同主题、同尺寸",
      markdown: "files-markdown/files-markdown-toc：Markdown 排版预览与目录工具行，单独成组，不参与优化前后对照",
      failure:
        "关键失败/未知状态：sync-unchecked/sync-stale/commit-error/commit-push-error/doc-error/doc-large/" +
        "search-error/filter-error/find-error/task-error/history-final-error，逐张对应需求",
    },
    profile: full && !projectsOnly ? "full" : "curated",
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
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width: size.width, height: size.height, deviceScaleFactor: SCALE, mobile: false },
          sessionId,
        );
        await cdp.send(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: `try { localStorage.setItem("preview-theme", ${JSON.stringify(theme)}); } catch (error) {}` },
          sessionId,
        );
        const target = `${theme}:${size.label}`;
        const wants = (view) => full || representative[target].includes(view);
        const shouldCaptureFailure = (view) => full || customFailureTargets ? failureTargets.has(target) : wants(view);
        const skipped = manifest.skipped;
        const shot = async (view, group = "baseline", state = "normal") => {
          await waitFor(cdp, sessionId, `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, "实际主题已应用");
          // Capture the settled state. The frame-by-frame scenario exercises real transitions separately.
          await evaluate(cdp, sessionId, `(async () => {
            await document.fonts.ready;
            for (const animation of document.getAnimations()) {
              if (animation.playState === 'running' && animation.playbackRate !== 0 &&
                  Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
            }
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          })()`);
          const paint = await evaluate(cdp, sessionId, `({ theme:document.documentElement.dataset.theme, surface:getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(), modalOpacity:document.querySelector('.modal-card') ? getComputedStyle(document.querySelector('.modal-card')).opacity : null, backdropOpacity:document.querySelector('.modal-backdrop') ? getComputedStyle(document.querySelector('.modal-backdrop')).opacity : null })`);
          if (paint.theme !== theme || [paint.modalOpacity, paint.backdropOpacity].some((opacity) => opacity !== null && opacity !== "1")) {
            throw new Error(`${view}: paint not ready ${JSON.stringify(paint)}`);
          }
          const overflow = await evaluate(cdp, sessionId, "Math.max(0, document.documentElement.scrollWidth - innerWidth)");
          if ((projectsOnly || !full) && overflow > 1) throw new Error(`${view}: horizontal overflow ${overflow}px`);
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
            ...(projectsOnly ? { paint, horizontalOverflow: overflow } : {}),
            bytes: buffer.length,
            sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
          });
          const errors = [...consoleErrors(cdp, sessionId), ...runtimeExceptions(cdp, sessionId)];
          if (projectsOnly && errors.length) throw new Error(`${view}: ${JSON.stringify(errors)}`);
          console.log("captured", file, `group=${group}`, errors.length > 0 ? `控制台错误 ${errors.length} 条` : "");
        };

        const captureProjects = async () => {
          const selectProjectMenu = async (index = 1) => {
            await waitFor(cdp, sessionId, 'Boolean(document.querySelector(\'[aria-label="业务项目"]\'))', "项目菜单入口");
            await evaluate(cdp, sessionId, click('[aria-label="业务项目"]'));
            await waitFor(cdp, sessionId, `document.querySelectorAll('.popover[aria-label="业务项目"] [role="option"]').length > ${index}`, "项目名单");
            await evaluate(cdp, sessionId, click(`.popover[aria-label="业务项目"] [role="option"][data-index="${index}"]`));
            await waitFor(cdp, sessionId, '!document.querySelector(\'.popover[aria-label="业务项目"]\')', "项目已选中");
          };
          const openManageProjects = async () => {
            await evaluate(cdp, sessionId, click('[aria-label="业务项目"]'));
            await waitFor(cdp, sessionId, 'Boolean(document.querySelector(\'.popover[aria-label="业务项目"] .select-menu-action\'))', "管理项目动作");
            await evaluate(cdp, sessionId, click('.popover[aria-label="业务项目"] .select-menu-action'));
            await waitFor(cdp, sessionId, "Boolean(document.querySelector('[data-workspace-manager]'))", "项目管理");
          };
          const narrow = size.width === 900;
          const missing = narrow && theme === "dark";
          if (!narrow && theme === "dark") {
            await navigate(cdp, sessionId, base + "/?projects=1");
            await waitFor(
              cdp,
              sessionId,
              'Boolean(document.querySelector(\'.welcome-recent button[title="C:/Users/dev/work/design-system"]\'))',
              "项目外仓库入口",
            );
            await evaluate(cdp, sessionId, click('.welcome-recent button[title="C:/Users/dev/work/design-system"]'));
            await waitFor(cdp, sessionId, "Boolean(document.querySelector('.file-list'))", "项目外仓库打开");
            await selectProjectMenu(1);
            await waitFor(
              cdp,
              sessionId,
              "document.querySelector('.project-chip-tag')?.textContent.includes('项目外')",
              "标题栏项目外标记",
            );
            await evaluate(cdp, sessionId, click('[aria-label^="当前仓库"]'));
            await waitFor(
              cdp,
              sessionId,
              "Boolean(document.querySelector('.popover [data-project-scope=\"outside\"]'))",
              "仓库弹层里的范围说明",
            );
            await shot("project-outside", "projects", "当前仓库不属于所选项目：标题栏「项目外」标签与仓库弹层顶部的范围说明、改看全部仓库入口");
          } else {
            await navigate(cdp, sessionId, base + (missing ? "/?projects=missing" : "/?projects=1"));
            await selectProjectMenu(1);
            await openManageProjects();
            if (missing) {
              await shot("project-source-missing", "projects", "来源失效仍显示快照与修复入口");
            } else if (narrow) {
              await evaluate(cdp, sessionId, "[...document.querySelectorAll('[data-workspace-manager] button')].find((button) => button.textContent === '从目录发现').click()");
              await waitFor(cdp, sessionId, "document.querySelectorAll('.candidate-results input').length === 60", "60 个发现候选");
              await evaluate(cdp, sessionId, typeInto('[aria-label="搜索候选仓库"]', "service-48"));
              await waitFor(cdp, sessionId, "document.querySelectorAll('.candidate-results input').length === 1", "候选搜索结果");
              await evaluate(cdp, sessionId, click('.candidate-results input'));
              await evaluate(cdp, sessionId, "document.querySelector('[aria-label=搜索候选仓库]').closest('section').scrollIntoView({ block: 'center' })");
              await shot("project-candidates", "projects", "60 个发现候选名称/完整路径搜索，取消匹配项后仍保留筛选外的 59 项选择");
            } else {
              await shot("project-manager", "projects", "60 仓名单、批量纳入与目录修复入口");
            }
          }
        };
        if (projectsOnly) {
          await captureProjects();
          await cdp.send("Target.closeTarget", { targetId });
          continue;
        }

        // A requested normal view only opens the surfaces needed for its own capture.
        const openWorkspace = full || ["changes", "history", "merge", "settings", "files-markdown-toc"].some(wants);
        if (openWorkspace || wants("start")) {
          await navigate(cdp, sessionId, base + "/");
          await waitFor(cdp, sessionId, "Boolean(document.querySelector('.welcome-recent button'))", "起始页");
          if (wants("start")) await shot("start", "baseline", "起始页");
          if (openWorkspace) {
            await evaluate(cdp, sessionId, click(".welcome-recent button"));
            await waitFor(cdp, sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
          }
        }

        if (wants("changes")) {
          await waitFor(cdp, sessionId, "Boolean(document.querySelector('.file-list .file-row'))", "改动文件列表");
          await shot("changes", "baseline", "改动视图");
        }
        if (wants("history")) {
          await evaluate(cdp, sessionId, click('[data-view="history"]'));
          await waitFor(cdp, sessionId, "Boolean(document.querySelector('.history-view[aria-busy=false] .history-row[role=option]'))", "提交历史");
          await evaluate(cdp, sessionId, click('.history-view .history-row'));
          await waitFor(cdp, sessionId, "Boolean(document.querySelector('.commit-files .file-row'))", "提交文件列表");
          await shot("history", "baseline", "历史列表与选中提交的文件");
        }

        if (["task", "worktree", "composer"].some(wants)) {
          await navigate(cdp, sessionId, base + "/?cliora=1");
          await waitFor(cdp, sessionId, "Boolean(document.querySelector('.history-task-row[aria-pressed=true]'))", "历史里的任务净差异");
          await waitFor(cdp, sessionId, "document.querySelectorAll('.task-detail .file-list .file-row').length > 0", "任务文件队列");
          if (wants("task")) {
            await evaluate(cdp, sessionId, click('.task-detail .file-list .file-row'));
            await waitFor(cdp, sessionId, "Boolean(document.querySelector('.task-detail [data-diff-row]'))", "任务净差异正文");
            await shot("task", "baseline", "历史里的任务净差异");
          }
          if (wants("worktree")) {
            await evaluate(cdp, sessionId, click('[aria-label^="当前仓库"]'));
            await waitFor(cdp, sessionId, "Boolean(document.querySelector('.rs-option[data-worktree-path]'))", "工作区总览");
            await shot("worktree", "baseline", "按主仓库分组的工作区总览");
            await evaluate(cdp, sessionId, pressEscape);
            await waitFor(cdp, sessionId, "!document.querySelector('[role=dialog]')", "关闭工作区总览");
          }
          if (wants("composer")) {
            await evaluate(cdp, sessionId, click('[data-view="changes"]'));
            await waitFor(cdp, sessionId, "Boolean(document.querySelector('.composer textarea'))", "提交区");
            await evaluate(cdp, sessionId, typeIntoArea(".composer textarea", "审阅任务范围并提交\n\n- 起点 main~2\n- 净差异只读，提交只按真实暂存范围"));
            await waitFor(cdp, sessionId, "Boolean(document.querySelector('[data-view-scope=changes] .file-row'))", "待提交文件");
            await shot("composer", "baseline", "真实暂存范围与提交草稿");
          }
        }

        if (wants("merge")) {
          await openCommand(cdp, sessionId, "分支合并", "#merge-modal-title");
          await waitFor(cdp, sessionId, "Boolean(document.querySelector('.merge-check[aria-busy=false] .merge-verdict:not(.idle)'))", "合并检查完成");
          await shot("merge", "baseline", "合并弹窗");
          await evaluate(cdp, sessionId, pressEscape);
          await waitFor(cdp, sessionId, "!document.querySelector('[role=dialog]')", "关闭合并弹窗");
        }
        if (wants("settings")) {
          await openCommand(cdp, sessionId, "设置", '[role="dialog"]');
          await shot("settings", "baseline", "设置弹窗");
          await evaluate(cdp, sessionId, pressEscape);
          await waitFor(cdp, sessionId, "!document.querySelector('[role=dialog]')", "关闭设置弹窗");
        }
        if (wants("files-markdown-toc")) {
          await evaluate(cdp, sessionId, click('[data-view="files"]'));
          await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view'))", "文件视图");
          await openReadme(cdp, sessionId, "Boolean(document.querySelector('.files-view .markdown-preview .md-body [data-markdown-anchor]'))", "Markdown 正文");
          if (full) await shot("files-markdown", "markdown", "Markdown 默认排版预览");
          const toggle = '.files-view button[aria-label="文档目录"]';
          try {
            await waitFor(cdp, sessionId, `Boolean(document.querySelector(${JSON.stringify(toggle)}))`, "文档目录开关");
            await evaluate(cdp, sessionId, click(toggle));
            await waitFor(cdp, sessionId, "Boolean(document.querySelector('.files-view .md-outline button'))", "文档目录");
            await shot("files-markdown-toc", "markdown", "Markdown 正文与展开的标题目录");
          } catch (error) {
            if (!full) throw error;
            skipped.push({ view: "files-markdown-toc", group: "markdown", reason: error.message });
            console.log("跳过 files-markdown-toc：", error.message);
          }
        }

        for (const failure of FAILURE_STATES) {
          if (!shouldCaptureFailure(failure.view)) continue;
          await navigate(cdp, sessionId, `${base}/?${failure.query}`);
          await failure.run(cdp, sessionId);
          await shot(failure.view, "failure", failure.state);
        }
        if (!full) await captureProjects();

        await cdp.send("Target.closeTarget", { targetId });
      }
    }
  } finally {
    cdp?.close();
    const killTimer = setTimeout(() => browser.kill("SIGKILL"), 2000);
    browser.kill();
    await browserClosed;
    clearTimeout(killTimer);
    // 浏览器退出后再清理 profile。
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      console.warn("临时 profile 未清理:", error.message);
    }
  }

  const counts = (group) => manifest.shots.filter((item) => item.group === group).length;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const figures = manifest.shots.map(({ file, view, theme, size }) => {
    const href = file.split("/").map(encodeURIComponent).join("/");
    const label = `${view} · ${theme} · ${size}`;
    return `<figure><a href="${href}"><img loading="lazy" src="${href}" alt="${label}"></a><figcaption>${label}</figcaption></figure>`;
  });
  fs.writeFileSync(path.join(path.dirname(manifestPath), "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Twiglane UI 捕获</title><style>body{font:14px system-ui;margin:2rem;background:#16181c;color:#eee}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:1rem}figure{margin:0}img{display:block;width:100%;height:auto}</style><h1>Twiglane UI 捕获</h1><p>${manifest.shots.length} 张 · 浏览器合成数据</p><main>${figures.join("")}</main>`);

  console.log(
    `完成：${manifest.shots.length} 张截图（对照 ${counts("baseline")} / Markdown ${counts("markdown")} / 失败态 ${counts("failure")}），` +
      `输出目录 ${outDir}，manifest ${manifestPath}`,
  );
}

main().catch((error) => {
  console.error("基线截图失败:", error.message);
  process.exit(1);
});
