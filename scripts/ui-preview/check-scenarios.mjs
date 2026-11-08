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

/**
 * 进入文件视图并打开 README.md 的公共前缀（Markdown 阅读场景共用）。
 * 普通打开 Markdown 默认进排版预览，所以这里等的是 .document-reader。
 * 但「README 已打开」有两种形态：排版预览（.document-reader）与源码（[data-file-line]）——
 * 预览/源码往返之后只剩源码形态，只认 .document-reader 会把已打开当成没打开（ready 永远不成立）。
 */
const OPEN_README_VIEW =
  "(function () { " +
  'if (!window.__filesOpened) { const recent = document.querySelector(".welcome-recent button"); if (recent) { window.__filesOpened = true; recent.click(); return false; } } ' +
  'if (!document.querySelector(\'.workbench-view[data-active="true"] .files-view\')) { const sw = document.querySelector(\'.workbench-view[data-active="true"] [data-view="files"]\'); if (sw) { sw.click(); return false; } return false; } ' +
  'if (window.__readmeOpened) return true; ' +
  'if (document.querySelector(".files-view .document-reader") || document.querySelectorAll(".files-view [data-file-line]").length > 0) { window.__readmeOpened = true; return true; } ' +
  'if (!window.__readmeClicked) { const row = [...document.querySelectorAll(".file-tree-row")].find((item) => item.textContent.includes("README.md")); if (row) { window.__readmeClicked = true; row.click(); } return false; } ' +
  "return false; })()";
/** 前缀 + 「排版预览已经解析出正文」：只看预览形态的场景用它（解析在工作线程里，元素出现不等于正文已经上屏）。 */
const OPEN_README =
  "(" +
  OPEN_README_VIEW +
  " && Boolean(document.querySelector('.files-view .markdown-preview .md-body [data-markdown-anchor]')))";

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
    // 目录树按需读取：根目录先出现，再打开 README，右侧是阅读器（默认排版预览）或源码，两种都算打开。
    ready:
      "(() => { if (!window.__filesOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__filesOpened = true; recent.click(); return false; } } " +
      "if (!document.querySelector('.workbench-view[data-active=\"true\"] .files-view')) { const sw = document.querySelector('.workbench-view[data-active=\"true\"] [data-view=\"files\"]'); if (sw) { sw.click(); return false; } return false; } " +
      "if (document.querySelectorAll('.file-tree-row').length === 0) return false; " +
      "if (!window.__treeFile) { const row = [...document.querySelectorAll('.file-tree-row')].find((item) => item.textContent.includes('README.md')); if (row) { window.__treeFile = true; row.click(); } return false; } " +
      "return Boolean(document.querySelector('.files-view .document-reader, .files-view [data-file-line], .files-view .markdown-preview')); })()",
    check:
      "document.querySelectorAll('.file-tree-row').length >= 5 && Boolean(document.querySelector('.file-tree-row[title]')) && Boolean(document.querySelector('.files-view .doc-path, .files-view .markdown-preview, .files-view [data-file-line]'))",
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
      // 按路径打开是低频入口，收在文件树的「更多」菜单里（工具条只常驻筛选/全仓库搜索/只看改动）。
      "if (!window.__quickOpen) { const more = document.querySelector('.files-view [aria-label=\"更多文件树选项\"]'); if (!more) return false; more.click(); window.__quickOpen = true; return false; } " +
      "if (!document.querySelector('#file-quick-open')) { const item = [...document.querySelectorAll('[role=\"menuitem\"]')].find((node) => node.textContent.includes('按路径打开')); if (!item) return false; item.click(); return false; } " +
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
    name: "文件视图：搜索局部失败给出原因与就地恢复入口",
    url: "/?search=error",
    ready:
      "(() => { if (!window.__filesOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__filesOpened = true; recent.click(); return false; } } " +
      "if (!document.querySelector('.workbench-view[data-active=\"true\"] .files-view')) { const sw = document.querySelector('.workbench-view[data-active=\"true\"] [data-view=\"files\"]'); if (sw) { sw.click(); return false; } return false; } " +
      "if (!window.__contentOpen) { const open = document.querySelector('.files-view [aria-label=\"全仓库搜索\"]'); if (open) { window.__contentOpen = true; open.click(); return false; } return false; } " +
      "const input = document.querySelector('#file-content-search'); if (!input) return false; " +
      "if (input.value !== 'import') { input.value = 'import'; input.dispatchEvent(new Event('input', { bubbles: true })); return false; } " +
      "return Boolean(document.querySelector('.file-search-note.danger')); })()",
    // 失败块里必须同时有原因和可执行的恢复动作；再真的点一次「重试搜索」，
    // 核对按钮确实重发了请求（同一条失败原因重新出现），而不是只是画了一个按钮。
    check:
      "(async () => { " +
      "const note = () => document.querySelector('.file-search-note.danger'); " +
      "const area = note(); if (!area) return false; " +
      "if (!(area.textContent || '').includes('搜索时有一个目录读取失败')) return false; " +
      "if (document.querySelectorAll('.file-search-row').length !== 0) return false; " +
      "const labels = [...area.querySelectorAll('button')].map((button) => button.textContent.trim()); " +
      "if (!labels.includes('重试搜索') || !labels.includes('重新读取目录')) return false; " +
      "const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); " +
      "const retry = [...area.querySelectorAll('button')].find((button) => button.textContent.trim() === '重试搜索'); " +
      "retry.click(); await wait(900); " +
      "const again = note(); " +
      "return Boolean(again) && (again.textContent || '').includes('目录读取失败'); })()",
    detail:
      "(() => { const area = document.querySelector('.file-search-note.danger'); if (!area) return ''; return (area.textContent || '').trim().slice(0, 60) + ' ｜ 按钮：' + [...area.querySelectorAll('button')].map((button) => button.textContent.trim()).join(' / '); })()",
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
    name: "文件视图：树过滤补齐失败就地重试",
    url: "/?filter=error",
    ready:
      '(() => { if (!window.__filesOpened) { const recent = document.querySelector(".welcome-recent button"); if (recent) { window.__filesOpened = true; recent.click(); return false; } } ' +
      'if (!document.querySelector(\'.workbench-view[data-active="true"] .files-view\')) { const sw = document.querySelector(\'.workbench-view[data-active="true"] [data-view="files"]\'); if (sw) { sw.click(); return false; } return false; } ' +
      'const input = document.querySelector(\'.files-view [aria-label="过滤文件树"]\'); if (!input) return false; ' +
      'if (input.value !== "part") { input.value = "part"; input.dispatchEvent(new Event("input", { bubbles: true })); return false; } ' +
      // 没有可显示的行时失败说明与「重试补齐」由树体空态承担（状态行不重复一遍）；有行时在状态行上。
      'return Boolean(document.querySelector(\'.files-view .empty.compact[role="alert"] [data-search-retry="tree"], .files-view .file-tree-status.danger [data-search-retry="tree"]\')); })()',
    // 补齐失败的说明里要带可点的「重试补齐」；点下去必须真的重发一次（同一条失败原因再出现）。
    // 空态标题必须是「全仓库补齐失败」，不能落回「没有匹配的路径」——失败不能说成没匹配。
    check:
      "(async () => { " +
      'const status = () => document.querySelector(".files-view .empty.compact[role=\\"alert\\"], .files-view .file-tree-status.danger"); ' +
      "const area = status(); if (!area) return false; " +
      "if (!(area.textContent || '').includes('无法遍历 vendor 目录')) return false; " +
      "const heading = document.querySelector('.files-view .empty.compact strong')?.textContent.trim() || ''; " +
      "if (heading === '没有匹配的路径') return false; " +
      "const retry = area.querySelector('[data-search-retry=\"tree\"]'); if (!retry) return false; " +
      "const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); " +
      "retry.click(); await wait(900); " +
      "const again = status(); " +
      "return Boolean(again) && (again.textContent || '').includes('无法遍历 vendor 目录'); })()",
    detail:
      "(() => { const area = document.querySelector('.files-view .empty.compact[role=\"alert\"], .files-view .file-tree-status.danger'); return area ? (area.textContent || '').trim().slice(0, 60) : ''; })()",
  },
  {
    name: "文件视图：文件内查找失败给出重试与重读入口",
    url: "/?search=error",
    // 打开文件内查找会从排版预览切到源码；源码渲染出来之前输入框会被重建，所以先等源码行出现再输入。
    ready:
      "(() => { if (!window.__filesOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__filesOpened = true; recent.click(); return false; } } " +
      "if (!document.querySelector('.workbench-view[data-active=\"true\"] .files-view')) { const sw = document.querySelector('.workbench-view[data-active=\"true\"] [data-view=\"files\"]'); if (sw) { sw.click(); return false; } return false; } " +
      "if (!window.__findOpen) { if (!document.querySelector('.files-view .markdown-preview .md-body')) { const row = [...document.querySelectorAll('.file-tree-row')].find((item) => item.textContent.includes('README.md')); if (row) { row.click(); return false; } return false; } const open = document.querySelector('.files-view [aria-label=\"在文件内搜索\"]'); if (!open) return false; window.__findOpen = true; open.click(); return false; } " +
      "if (document.querySelectorAll('.files-view [data-file-line]').length === 0) return false; " +
      "const input = document.querySelector('.files-view [data-search-scope=\"file\"]'); if (!input) return false; " +
      "if (input.value !== 'import') { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'import'); input.dispatchEvent(new Event('input', { bubbles: true })); return false; } " +
      "return Boolean(document.querySelector('.files-view .file-note.danger [data-search-retry=\"file\"]')); })()",
    check:
      "(async () => { " +
      'const note = () => document.querySelector(".files-view .file-note.danger"); ' +
      "const area = note(); if (!area) return false; " +
      "if (!(area.textContent || '').includes('目录读取失败')) return false; " +
      "const labels = [...area.querySelectorAll('button')].map((button) => button.textContent.trim()); " +
      "if (!labels.includes('重试查找') || !labels.includes('重新读取文件')) return false; " +
      "const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); " +
      "const retry = [...area.querySelectorAll('button')].find((button) => button.textContent.trim() === '重试查找'); " +
      "retry.click(); await wait(900); " +
      "const again = note(); " +
      "return Boolean(again) && (again.textContent || '').includes('目录读取失败'); })()",
    detail:
      "(() => { const area = document.querySelector('.files-view .file-note.danger'); if (!area) return ''; return (area.textContent || '').trim().slice(0, 60) + ' ｜ 按钮：' + [...area.querySelectorAll('button')].map((button) => button.textContent.trim()).join(' / '); })()",
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
    name: "文档阅读：Markdown 默认排版预览",
    url: "/",
    ready: OPEN_README,
    check:
      "(() => { const body = document.querySelector('.files-view .markdown-preview .md-body'); return Boolean(body) && (body.textContent || '').includes('目录与版本') && Boolean(document.querySelector('.files-view .doc-source, .files-view .doc-path')); })()",
    detail:
      "(document.querySelector('.files-view .doc-source')?.textContent || '') + ' · ' + (document.querySelector('.files-view .md-note')?.textContent || '')",
  },
  {
    name: "文档阅读：目录列出中文重复标题且各自可辨",
    url: "/",
    ready:
      "(() => { if (!" +
      OPEN_README +
      ") return false; " +
      "const nav = document.querySelector('.files-view .md-outline'); " +
      "if (!nav) { const toggle = [...document.querySelectorAll('.files-view .md-small-button')].find((item) => item.textContent.includes('目录')); if (toggle) toggle.click(); return false; } " +
      "const duplicated = [...nav.querySelectorAll('button')].filter((item) => item.textContent.includes('中文重复标题')); return duplicated.length >= 2; })()",
    // 不只数条目：真的点击两个同名项，核对锚点 id 不同、aria-current 落在各自条目上、滚动位置也不同。
    // 若回归把两个重复标题合并到同一 heading id，这里会失败，而不是靠顺序蒙混过关。
    check:
      "(async () => { " +
      "const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); " +
      "const nav = document.querySelector('.files-view .md-outline'); " +
      "const scroller = document.querySelector('.files-view .md-scroll'); " +
      "if (!nav || !scroller) return false; " +
      "const buttons = [...nav.querySelectorAll('button')]; " +
      "const duplicated = buttons.map((button, index) => (button.textContent.includes('中文重复标题') ? index : -1)).filter((index) => index >= 0); " +
      "if (duplicated.length < 2) return false; " +
      "const read = () => ({ scrollTop: scroller.scrollTop, current: buttons.findIndex((button) => button.getAttribute('aria-current') === 'location') }); " +
      "buttons[duplicated[0]].click(); await wait(700); const first = read(); " +
      "buttons[duplicated[1]].click(); await wait(700); const second = read(); " +
      "const anchors = [...document.querySelectorAll('.files-view .md-body [data-markdown-anchor]')] " +
      ".map((node) => node.dataset.markdownAnchor).filter((value) => value.includes('中文重复标题')); " +
      "window.__dupHrefs = { duplicated, first, second, anchors }; " +
      "return anchors.length >= 2 && new Set(anchors).size === anchors.length && " +
      "first.current === duplicated[0] && second.current === duplicated[1] && first.scrollTop !== second.scrollTop; })()",
    detail:
      "(() => { const result = window.__dupHrefs; if (!result) return '(未记录)'; return JSON.stringify({ anchors: result.anchors, first: Math.round(result.first.scrollTop), second: Math.round(result.second.scrollTop) }); })()",
  },
  {
    name: "文档阅读：目录收起后正文仍可读",
    url: "/",
    ready:
      "(() => { if (!" +
      OPEN_README +
      ") return false; " +
      "const open = [...document.querySelectorAll('.files-view .md-small-button')].find((item) => item.textContent.includes('收起目录')); " +
      "if (open) { if (!window.__outlineClosing) { window.__outlineClosing = true; open.click(); } return false; } " +
      "return Boolean(document.querySelector('.files-view .markdown-preview .md-body')); })()",
    check:
      "!document.querySelector('.files-view .md-outline') && Boolean(document.querySelector('.files-view .markdown-preview .md-body'))",
    detail:
      "[...document.querySelectorAll('.files-view .md-small-button')].map((item) => item.textContent.trim()).join(' / ')",
  },
  {
    name: "文档阅读：预览与源码往返不离开这个文件",
    url: "/",
    // 切到源码后 markdown-preview 就没了，所以「已打开过一次预览」要记在标志上，
    // 不能每次重算 OPEN_README：否则切完源码那一步永远不成立。
    ready:
      "(() => { if (!window.__readerReady) { if (!" +
      OPEN_README +
      ") return false; window.__readerReady = true; } " +
      "if (!window.__toSource) { const button = document.querySelector('.files-view [aria-label=\"查看这个 Markdown 的源码\"]'); if (!button) return false; window.__toSource = true; button.click(); return false; } " +
      // 源码可能是文档阅读器里的分页源码（.doc-source-scroll），也可能是文件视图自己的分页源码（[data-file-line]）。
      "return Boolean(document.querySelector('.files-view .doc-source-scroll')) || document.querySelectorAll('.files-view [data-file-line]').length > 0; })()",
    check:
      // 源码形态下阅读器不在，路径要从文件视图自己的标题里读；点「预览」后再看它是否还是同一个文件。
      "(() => { const title = document.querySelector('.files-view .file-title')?.getAttribute('title') || ''; const back = document.querySelector('.files-view [aria-label=\"预览这个 Markdown 文档\"]'); if (!back) return false; back.click(); return title.endsWith('README.md'); })()",
    detail: "document.querySelector('.files-view .file-title')?.getAttribute('title') || document.querySelector('.files-view .doc-path')?.getAttribute('title') || ''",
  },
  {
    name: "文档阅读：相对链接留在同一阅读器里打开目标",
    url: "/",
    ready:
      "(() => { if (!" +
      OPEN_README +
      ") return false; " +
      "if (!window.__linkClicked) { const link = [...document.querySelectorAll('.files-view .md-body a')].find((item) => item.textContent.includes('快速开始')); if (!link) return false; window.__linkClicked = true; link.click(); return false; } " +
      "return (document.querySelector('.files-view .doc-path')?.getAttribute('title') || '').includes('getting-started.md'); })()",
    check:
      // 目标文档同样要等工作线程解析完：阅读器与路径先到位，正文才逐段上屏。
      "(async () => { const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); " +
      "for (let attempt = 0; attempt < 40; attempt += 1) { " +
      "const body = document.querySelector('.files-view .markdown-preview .md-body'); const reader = document.querySelector('.files-view .document-reader'); " +
      "if (body && (body.textContent || '').includes('快速开始') && reader) return true; " +
      "await wait(150); } return false; })()",
    detail: "document.querySelector('.files-view .doc-path')?.getAttribute('title') || ''",
  },
  {
    name: "文档阅读：超出排版预算时说明并给出源码",
    url: "/?doc=large",
    ready:
      "(() => { if (!" +
      OPEN_README_VIEW +
      ") return false; " +
      "if (!window.__limitSeen) { window.__limitSeen = document.querySelector('.files-view .doc-state, .files-view .doc-notice')?.textContent?.trim() || ''; } " +
      "if (!window.__limitSeen) return false; " +
      "if (document.querySelector('.files-view .doc-source-scroll') || document.querySelectorAll('.files-view [data-file-line]').length > 0) return true; " +
      "if (!window.__limitClicked) { const button = [...document.querySelectorAll('.files-view button')].find((item) => item.textContent.trim() === '查看源码'); if (!button) return false; window.__limitClicked = true; button.click(); } " +
      "return false; })()",
    check:
      "(() => { const seen = window.__limitSeen || ''; const readable = Boolean(document.querySelector('.files-view .doc-source-scroll')) || document.querySelectorAll('.files-view [data-file-line]').length > 0; return seen.includes('排版预览上限') && readable; })()",
    detail: "(window.__limitSeen || '').slice(0, 80)",
  },
  {
    name: "文档阅读：读取失败就地说明，仍能看源码",
    url: "/?doc=error",
    ready:
      "(() => { if (!window.__filesOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__filesOpened = true; recent.click(); return false; } } " +
      "if (!document.querySelector('.workbench-view[data-active=\"true\"] .files-view')) { const sw = document.querySelector('.workbench-view[data-active=\"true\"] [data-view=\"files\"]'); if (sw) { sw.click(); return false; } return false; } " +
      "if (!window.__errorFile) { const row = [...document.querySelectorAll('.file-tree-row')].find((item) => item.textContent.includes('README.md')); if (row) { window.__errorFile = true; row.click(); } return false; } " +
      "return Boolean(document.querySelector('.files-view .doc-state[role=\"alert\"]')); })()",
    check:
      "(() => { const state = document.querySelector('.files-view .doc-state[role=\"alert\"]'); if (!state) return false; const labels = [...state.querySelectorAll('button')].map((item) => item.textContent.trim()); return labels.includes('重新读取') && labels.includes('查看源码'); })()",
    detail: "document.querySelector('.files-view .doc-state[role=\"alert\"]')?.textContent?.trim().slice(0, 80) || ''",
  },
  {
    name: "历史：提交里的 Markdown 按这个提交的版本显示差异",
    url: "/?commitdoc=1",
    ready:
      "(() => { if (!window.__historyOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__historyOpened = true; recent.click(); return false; } } " +
      "const view = document.querySelector('.workbench-view[data-active=\"true\"] .history-view'); if (!view) { const sw = document.querySelector('.workbench-view[data-active=\"true\"] [data-view=\"history\"]'); if (sw) { sw.click(); return false; } return false; } " +
      "const rows = [...view.querySelectorAll('.history-row')]; if (!rows.length) return false; " +
      "if (!window.__commitPicked) { window.__commitPicked = true; rows[0].click(); return false; } " +
      "const file = [...view.querySelectorAll('.commit-files .file-row')].find((item) => item.textContent.includes('README.md')); if (!file) return false; " +
      "if (!window.__filePicked) { window.__filePicked = true; file.click(); return false; } " +
      "const path = view.querySelector('.diff-path')?.textContent?.trim() || ''; " +
      "return path === 'README.md' && view.querySelectorAll('.diff [data-line]').length > 0; })()",
    check:
      "(() => { const view = document.querySelector('.workbench-view[data-active=\"true\"] .history-view'); if (!view) return false; const selected = [...view.querySelectorAll('.commit-files .file-row')].filter((row) => row.getAttribute('aria-selected') === 'true'); const path = view.querySelector('.diff-path')?.textContent?.trim() || ''; return path === 'README.md' && selected.length === 1 && selected[0].textContent.includes('README.md'); })()",
    detail: "document.querySelector('.workbench-view[data-active=\"true\"] .history-view .diff-path')?.textContent?.trim() || ''",
  },
  {
    name: "同步：远程未核对时按钮自述，不把缓存计数当刚验证",
    url: "/?remote=unchecked",
    ready:
      "(() => { if (!window.__syncOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__syncOpened = true; recent.click(); return false; } return false; } return Boolean(document.querySelector('.sync-pill')); })()",
    check:
      "(() => { const marker = document.querySelector('.sync-pill [data-sync-remote]'); const label = document.querySelector('.sync-pill')?.getAttribute('aria-label') || ''; return Boolean(marker) && marker.getAttribute('data-sync-remote') === 'off' && (marker.textContent || '').includes('未核') && label.includes('未核对远程'); })()",
    detail: "document.querySelector('.sync-pill')?.getAttribute('title') || ''",
  },
  {
    name: "同步：远程过期时按钮直接标出过期与上次核对",
    url: "/?remote=stale",
    ready:
      "(() => { if (!window.__staleOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__staleOpened = true; recent.click(); return false; } return false; } return Boolean(document.querySelector('.sync-pill')); })()",
    check:
      "(() => { const marker = document.querySelector('.sync-pill [data-sync-remote]'); const label = document.querySelector('.sync-pill')?.getAttribute('aria-label') || ''; return Boolean(marker) && marker.getAttribute('data-sync-remote') === 'stale' && (marker.textContent || '').includes('过期') && label.includes('远程状态已过期'); })()",
    detail: "document.querySelector('.sync-pill')?.getAttribute('aria-label') || ''",
  },
  {
    name: "提交：钩子拒绝的长原因可展开读全，草稿保留",
    url: "/?commit=error",
    ready:
      "(() => { if (!window.__commitOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__commitOpened = true; recent.click(); return false; } return false; } " +
      "if (!window.__commitTyped) { const area = document.querySelector('.composer textarea'); if (!area) return false; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(area, '修复同步标记与提交失败说明'); area.dispatchEvent(new Event('input', { bubbles: true })); window.__commitTyped = true; return false; } " +
      "if (!window.__commitClicked) { const button = document.querySelector('.composer-commit'); if (!button || button.disabled) return false; window.__commitClicked = true; button.click(); return false; } " +
      "return Boolean(document.querySelector('[data-commit-error]')); })()",
    check:
      "(async () => { const error = document.querySelector('[data-commit-error]'); if (!error) return false; const toggle = document.querySelector('.composer-meta .composer-expand'); if (!toggle) return false; toggle.click(); await new Promise((resolve) => setTimeout(resolve, 500)); const expanded = document.querySelector('[data-commit-error].expanded'); const draft = document.querySelector('.composer textarea')?.value || ''; return Boolean(expanded) && (expanded.textContent || '').includes('pre-commit') && draft.length > 0; })()",
    detail: "(document.querySelector('[data-commit-error]')?.textContent || '').trim().slice(0, 80)",
  },
  {
    name: "提交：本地成功、推送失败分开说明，长原因可展开且只重试推送",
    url: "/?commit=push",
    ready:
      "(() => { if (!window.__pushOpened) { const recent = document.querySelector('.welcome-recent button'); if (recent) { window.__pushOpened = true; recent.click(); return false; } return false; } " +
      "if (!window.__pushTyped) { const area = document.querySelector('.composer textarea'); if (!area) return false; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(area, '修复同步标记与提交失败说明'); area.dispatchEvent(new Event('input', { bubbles: true })); window.__pushTyped = true; return false; } " +
      "if (!window.__pushClicked) { const button = document.querySelector('.composer-push'); if (!button || button.disabled) return false; window.__pushClicked = true; button.click(); return false; } " +
      "return Boolean(document.querySelector('[data-push-error]')); })()",
    check:
      "(async () => { const area = document.querySelector('[data-push-error]'); if (!area) return false; const toggle = area.querySelector('.composer-expand'); if (!toggle) return false; toggle.click(); await new Promise((resolve) => setTimeout(resolve, 500)); const status = area.querySelector('[role=status]'); const retry = [...area.querySelectorAll('button')].some((button) => button.textContent.includes('重试推送')); return Boolean(status) && status.className.includes('expanded') && (status.textContent || '').includes('本地提交') && retry; })()",
    detail: "(document.querySelector('[data-push-error] [role=status]')?.textContent || '').trim().slice(0, 80)",
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