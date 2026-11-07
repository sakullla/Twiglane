// 预览的异常 / 大规模参数自检：确认 mock 预览仍能进入异常与大数据场景，
// 而不是只有“正常起始页”能看。用法：node scripts/ui-preview/check-scenarios.mjs [--base ...]
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 && args[baseIndex + 1] ? args[baseIndex + 1] : "http://127.0.0.1:1430";
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

const SCENARIOS = [
  {
    name: "大规模最近仓库",
    url: "/?recent=many",
    ready: "Boolean(document.querySelector('.welcome-recent button'))",
    check: "document.body.textContent.includes('共 500 个')",
    detail: "document.querySelector('.welcome-recent-head, .welcome-head')?.textContent?.trim().slice(0, 60) || document.querySelectorAll('.welcome-recent button').length + ' 行渲染'",
  },
  {
    name: "空最近仓库",
    url: "/?recent=empty",
    ready: "Boolean(document.querySelector('.welcome-empty'))",
    check: "document.body.textContent.includes('还没有最近仓库')",
    detail: "document.querySelector('.welcome-empty').textContent.trim()",
  },
  {
    name: "Git 缺失",
    url: "/?git=missing",
    ready: "Boolean(document.querySelector('.welcome-diagnostic'))",
    check: "Boolean(document.querySelector('.welcome-diagnostic')) && document.body.textContent.includes('Git')",
    detail: "document.querySelector('.welcome-diagnostic')?.textContent?.trim().slice(0, 60) || ''",
  },
  {
    name: "文件视图：目录树与文件内容",
    url: "/",
    ready:
      "(() => { if (!window.__filesOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__filesOpened = true; recent.click(); return false; } } " +
      "if (!document.querySelector('.workbench-view[data-active=\"true\"] .files-view')) { const sw = document.querySelector('.workbench-view[data-active=\"true\"] [data-view=\"files\"]'); if (sw) { sw.click(); return false; } return false; } " +
      "const rows = [...document.querySelectorAll('.file-tree-row')]; if (rows.length > 0 && !document.querySelector('[data-file-line]')) { const readme = rows.find((row) => row.textContent.includes('README.md')); if (readme) { readme.click(); return false; } } " +
      "return Boolean(document.querySelector('[data-file-line]')); })()",
    check:
      "document.querySelectorAll('.file-tree-row').length >= 5 && document.body.textContent.includes('目录按需读取') && Boolean(document.querySelector('.file-tree-row[title]'))",
    detail:
      "document.querySelectorAll('.file-tree-row').length + ' 行；' + (document.querySelector('.file-tree-row[title]')?.getAttribute('title') ?? '')",
  },
  {
    name: "文件视图：资源预览是当前文件",
    url: "/",
    ready:
      "(() => { if (!window.__filesOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__filesOpened = true; recent.click(); return false; } } " +
      "if (!document.querySelector('.workbench-view[data-active=\"true\"] .files-view')) { const sw = document.querySelector('.workbench-view[data-active=\"true\"] [data-view=\"files\"]'); if (sw) { sw.click(); return false; } return false; } " +
      "if (!document.querySelector('.files-view .binary-preview')) { const row = [...document.querySelectorAll('.file-tree-row')].find((item) => item.textContent.includes('logo.png')); if (row) { row.click(); return false; } } " +
      "return Boolean(document.querySelector('.files-view .binary-preview img')); })()",
    check: "Boolean(document.querySelector('.files-view .binary-preview img')) && !document.querySelector('.files-view .binary-preview [aria-label=\"预览版本\"]')",
    detail: "document.querySelector('.files-view .preview-current')?.textContent?.trim() || ''",
  },
  {
    name: "文件视图：按路径打开未展开的文件",
    url: "/",
    ready:
      "(() => { if (!window.__filesOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__filesOpened = true; recent.click(); return false; } } " +
      "if (!document.querySelector('.workbench-view[data-active=\"true\"] .files-view')) { const sw = document.querySelector('.workbench-view[data-active=\"true\"] [data-view=\"files\"]'); if (sw) { sw.click(); return false; } return false; } " +
      "if (window.__quickPicked) return Boolean(document.querySelector('.files-view [data-file-line]')); " +
      "if (!window.__quickOpen) { const open = document.querySelector('.files-view [aria-label=\"按路径打开\"]'); if (open) { window.__quickOpen = true; open.click(); return false; } return false; } " +
      "const input = document.querySelector('#file-quick-open'); if (!input) return false; " +
      "if (input.value !== 'util') { input.value = 'util'; input.dispatchEvent(new Event('input', { bubbles: true })); return false; } " +
      "const option = [...document.querySelectorAll('.file-search-row.path')].find((item) => item.textContent.includes('util.rs')); if (!option) return false; " +
      "window.__quickPicked = true; option.click(); return false; })()",
    check:
      "(document.querySelector('.file-tree-row.active')?.textContent || '').includes('util.rs') && Boolean(document.querySelector('.files-view [data-file-line]'))",
    detail: "document.querySelector('.file-tree-row.active')?.getAttribute('title') || ''",
  },
  {
    name: "文件视图：全文搜索按文件分组",
    url: "/",
    ready:
      "(() => { if (!window.__filesOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__filesOpened = true; recent.click(); return false; } } " +
      "if (!document.querySelector('.workbench-view[data-active=\"true\"] .files-view')) { const sw = document.querySelector('.workbench-view[data-active=\"true\"] [data-view=\"files\"]'); if (sw) { sw.click(); return false; } return false; } " +
      "if (!window.__contentOpen) { const open = document.querySelector('.files-view [aria-label=\"全仓库搜索\"]'); if (open) { window.__contentOpen = true; open.click(); return false; } return false; } " +
      "const input = document.querySelector('#file-content-search'); if (!input) return false; " +
      "if (input.value !== 'import') { input.value = 'import'; input.dispatchEvent(new Event('input', { bubbles: true })); return false; } " +
      "return document.querySelectorAll('.file-search-group').length > 0; })()",
    check: "document.querySelectorAll('.file-search-group').length >= 1 && document.querySelectorAll('.file-search-row.hit').length >= 2",
    detail:
      "document.querySelectorAll('.file-search-group').length + ' 个文件 / ' + document.querySelectorAll('.file-search-row.hit').length + ' 处匹配'",
  },
  {
    name: "文件视图：仅改动树保留删除墓碑",
    url: "/",
    ready:
      "(() => { if (!window.__filesOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__filesOpened = true; recent.click(); return false; } } " +
      "if (!document.querySelector('.workbench-view[data-active=\"true\"] .files-view')) { const sw = document.querySelector('.workbench-view[data-active=\"true\"] [data-view=\"files\"]'); if (sw) { sw.click(); return false; } return false; } " +
      "if (!window.__changedOnly) { const toggle = document.querySelector('.files-view [aria-label=\"只看有改动的文件\"]'); if (toggle) { window.__changedOnly = true; toggle.click(); return false; } return false; } " +
      "return [...document.querySelectorAll('.file-tree-row')].some((row) => row.textContent.includes('old-panel.ts')); })()",
    check:
      "[...document.querySelectorAll('.file-tree-row')].some((row) => row.textContent.includes('old-panel.ts') && row.textContent.includes('已删除'))",
    detail:
      "[...document.querySelectorAll('.file-tree-row')].filter((row) => row.textContent.includes('已删除')).map((row) => row.textContent.trim()).join(' | ')",
  },
  {
    name: "文件视图：搜索局部失败给出原因",
    url: "/?search=error",
    ready:
      "(() => { if (!window.__filesOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__filesOpened = true; recent.click(); return false; } } " +
      "if (!document.querySelector('.workbench-view[data-active=\"true\"] .files-view')) { const sw = document.querySelector('.workbench-view[data-active=\"true\"] [data-view=\"files\"]'); if (sw) { sw.click(); return false; } return false; } " +
      "if (!window.__contentOpen) { const open = document.querySelector('.files-view [aria-label=\"全仓库搜索\"]'); if (open) { window.__contentOpen = true; open.click(); return false; } return false; } " +
      "const input = document.querySelector('#file-content-search'); if (!input) return false; " +
      "if (input.value !== 'import') { input.value = 'import'; input.dispatchEvent(new Event('input', { bubbles: true })); return false; } " +
      "return Boolean(document.querySelector('.file-search-note.danger')); })()",
    check:
      "(document.querySelector('.file-search-note.danger')?.textContent || '').includes('搜索时有一个目录读取失败') && document.querySelectorAll('.file-search-row').length === 0",
    detail: "document.querySelector('.file-search-note.danger')?.textContent?.trim() || ''",
  },
  {
    name: "文件视图：仅改动与树过滤叠加只留改动路径",
    url: "/",
    ready:
      '(() => { if (!window.__filesOpened) { const recent = document.querySelector(".welcome-recent button"); if (recent) { window.__filesOpened = true; recent.click(); return false; } } ' +
      'if (!document.querySelector(\'.workbench-view[data-active="true"] .files-view\')) { const sw = document.querySelector(\'.workbench-view[data-active="true"] [data-view="files"]\'); if (sw) { sw.click(); return false; } return false; } ' +
      'if (!window.__changedOnly) { const toggle = document.querySelector(\'.files-view [aria-label="只看有改动的文件"]\'); if (toggle) { window.__changedOnly = true; toggle.click(); return false; } return false; } ' +
      'const input = document.querySelector(\'.files-view [aria-label="过滤文件树"]\'); if (!input) return false; ' +
      'if (input.value !== "old") { input.value = "old"; input.dispatchEvent(new Event("input", { bubbles: true })); return false; } ' +
      'return [...document.querySelectorAll(".file-tree-row")].some((row) => row.textContent.includes("old-panel.ts")); })()',
    check:
      '![...document.querySelectorAll(".file-tree-row")].some((row) => row.textContent.includes("全仓库")) && [...document.querySelectorAll(".file-tree-row")].some((row) => row.textContent.includes("old-panel.ts")) && document.body.textContent.includes("仅在改动文件里匹配")',
    detail: '[...document.querySelectorAll(".file-tree-row")].map((row) => row.textContent.trim()).join(" | ")',
  },
  {
    name: "文件视图：树过滤补齐被截断时说明不完整",
    url: "/?filter=truncated",
    ready:
      '(() => { if (!window.__filesOpened) { const recent = document.querySelector(".welcome-recent button"); if (recent) { window.__filesOpened = true; recent.click(); return false; } } ' +
      'if (!document.querySelector(\'.workbench-view[data-active="true"] .files-view\')) { const sw = document.querySelector(\'.workbench-view[data-active="true"] [data-view="files"]\'); if (sw) { sw.click(); return false; } return false; } ' +
      'const input = document.querySelector(\'.files-view [aria-label="过滤文件树"]\'); if (!input) return false; ' +
      'if (input.value !== "part") { input.value = "part"; input.dispatchEvent(new Event("input", { bubbles: true })); return false; } ' +
      'return Boolean(document.querySelector(".files-view .file-tree-status")); })()',
    check:
      '(document.querySelector(".files-view .file-tree-status")?.textContent || "").includes("补齐结果不完整") && !document.body.textContent.includes("没有匹配的路径")',
    detail: 'document.querySelector(".files-view .file-tree-status")?.textContent?.trim() || ""',
  },
  {
    name: "改动视图：标记已审阅并隐藏已审阅",
    url: "/",
    ready:
      "(function () { if (!window.__reviewOpened) { const recent = document.querySelector('.welcome-recent button'); if (!recent) return false; window.__reviewOpened = true; recent.click(); return false; } " +
      "const list = document.querySelector('.file-list'); if (!list) return false; " +
      "if (!window.__reviewMarked) { const toggle = list.querySelector('.review-toggle'); if (!toggle) return false; window.__reviewMarked = true; toggle.click(); return false; } " +
      "if (!window.__reviewHidden) { const hide = document.querySelector('.review-hide'); if (!hide) return false; window.__reviewHidden = true; hide.click(); return false; } " +
      "return document.querySelectorAll('.review-toggle.on').length === 0; })()",
    check:
      "(function () { const count = document.querySelector('.review-count'); if (!count) return false; const shown = count.textContent.trim(); return shown.indexOf('1/') === 0 && document.querySelectorAll('.review-toggle.on').length === 0 && document.querySelectorAll('.file-row').length > 0; })()",
    detail: "document.querySelector('.review-count')?.textContent?.trim() || ''",
  },
  {
    name: "默认起始页",
    url: "/",
    ready: "Boolean(document.querySelector('.welcome-recent button'))",
    check: "document.querySelectorAll('.welcome-recent button').length === 5",
    detail: "document.querySelector('.welcome-recent-head, .welcome-head')?.textContent?.trim().slice(0, 60) || document.querySelectorAll('.welcome-recent button').length + ' 行渲染'",
  },
];

function chromePath() {
  const found = CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error("找不到 Chrome/Edge，请用 CHROME_PATH 指定");
  return found;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
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
      .on("error", reject);
  });
}

async function main() {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "twiglane-scenarios-"));
  const browser = spawn(
    chromePath(),
    ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore" },
  );
  let socket;
  try {
    let version;
    for (let attempt = 0; attempt < 60 && !version; attempt += 1) {
      try {
        version = await getJson(port, "/json/version");
      } catch {
        await pause(200);
      }
    }
    if (!version) throw new Error("无法连接 Chrome 调试端口");

    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
    });
    let nextId = 1;
    const pending = new Map();
    const events = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else {
        events.push(message);
      }
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    const evaluate = async (expression, sessionId) => {
      const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.text);
      return reply.result.result.value;
    };

    const results = [];
    for (const scenario of SCENARIOS) {
      const { result: created } = await send("Target.createTarget", { url: "about:blank" });
      const { result: attached } = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
      const sessionId = attached.sessionId;
      await send("Page.enable", {}, sessionId);
      await send("Runtime.enable", {}, sessionId);
      await send("Page.navigate", { url: base + scenario.url }, sessionId);

      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
        try {
          ready = await evaluate(scenario.ready, sessionId);
        } catch {
          ready = false;
        }
        if (!ready) await pause(120);
      }
      const passed = ready ? Boolean(await evaluate(scenario.check, sessionId)) : false;
      const detail = ready ? await evaluate(scenario.detail, sessionId) : "(未就绪)";
      const errors = events
        .filter((event) => event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
        .map((event) => event.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
      results.push({ name: scenario.name, url: scenario.url, passed, detail, errors });
      console.log((passed ? "PASS" : "FAIL") + "  " + scenario.name + "  " + JSON.stringify(detail));
      events.length = 0;
      await send("Target.closeTarget", { targetId: created.targetId });
    }

    const failed = results.filter((item) => !item.passed);
    console.log("场景自检：" + (results.length - failed.length) + "/" + results.length + " 通过");
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    socket?.close();
    browser.kill();
    await pause(400);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      console.warn("临时 profile 未清理:", error.message);
    }
  }
}

main().catch((error) => {
  console.error("场景自检失败:", error.message);
  process.exit(1);
});