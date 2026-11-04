// T4（历史浏览、仓库/分支导航、命令入口）的界面观察脚本。
// 打开 mock 预览，逐个主题 × 窗口读取历史列表/详情、提交右键菜单、分支弹层、命令面板
// 与仓库弹层（?recent=many 的 500 个最近仓库）的几何与可访问性状态，并截图。
//
// 用法（先在另一个终端 npm run preview:ui）：
//   node docs/verification/ui-ux-2026-11-04/t4/inspect-t4.mjs
//
// 边界：只证明 headless Chrome + mock 数据下的几何、文本与焦点状态，不代表真实 Git 行为，
// 也不代表 Windows/macOS 桌面 WebView 的实际观感（字体、缩放、自绘标题栏未覆盖）。
import fs from "node:fs";
import path from "node:path";
import { withBrowser, openSession, evaluate, waitFor, pause, consoleErrors, exceptions } from "./cdp.mjs";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const base = readArg("--base", "http://127.0.0.1:1430");
const outDir = path.resolve(readArg("--out", "docs/verification/ui-ux-2026-11-04/t4"));

const HELPERS = "const round = (value) => Math.round(value * 10) / 10; const box = (element) => { if (!element) return null; const rect = element.getBoundingClientRect(); return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) }; }; const text = (element) => element ? element.textContent.trim().replace(/\\s+/g, \" \").slice(0, 120) : null; const all = (selector) => [...document.querySelectorAll(selector)]; const one = (selector) => document.querySelector(selector); ";
const HISTORY = "const list = one(\".history-list\"); const rows = all(\".history-row\"); const selected = one('.history-row[aria-selected=\"true\"]'); const chip = one(\".read-only-chip\"); const id = list.getAttribute(\"aria-activedescendant\"); return { theme: document.documentElement.dataset.theme, viewport: { w: innerWidth, h: innerHeight }, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, pane: box(one(\".history-pane\")), tools: box(one(\".history-tools\")), searchField: box(one(\".history-search-row .field\")), list: { box: box(list), rendered: rows.length, rowHeight: rows.length ? round(rows[0].getBoundingClientRect().height) : null }, row: selected ? { id: selected.id, summary: text(selected.querySelector(\".hr-summary\")), summaryTruncated: selected.querySelector(\".hr-summary\").scrollWidth > selected.querySelector(\".hr-summary\").clientWidth + 1, hash: box(selected.querySelector(\".hr-hash\")), meta: text(selected.querySelector(\".hr-meta\")) } : null, listbox: { tabindex: list.getAttribute(\"tabindex\"), activedescendant: id, resolves: Boolean(document.getElementById(id || \"\")) }, pager: { text: text(one(\".history-pager\")), newestDisabled: one(\".history-pager button\").disabled, newestTitle: one(\".history-pager button\").title }, detail: { head: box(one(\".commit-head\")), title: box(one(\".commit-title\")), titleText: text(one(\".commit-title\")), byline: text(one(\".commit-byline\")) }, readOnly: chip ? { text: text(chip), title: chip.title, box: box(chip), inByline: Boolean(chip.closest(\".commit-byline\")) } : null, files: { head: text(one(\".commit-files-head\")), rows: all(\".history-files .file-row\").length, box: box(one(\".commit-files\")) }, diffToolbar: all(\".commit-diff .diff-toolbar button\").map((button) => button.title || text(button)), hashCopy: Boolean(one(\".oid-chip button\")), liveRegion: Boolean(one(\".commit-facts [aria-live]\")) };";
const KEYBOARD = "const list = one(\".history-list\"); const selected = one('.history-row[aria-selected=\"true\"]'); const id = list.getAttribute(\"aria-activedescendant\"); return { focus: document.activeElement ? document.activeElement.className : null, selectedId: selected ? selected.id : null, activedescendant: id, pointsAtSelected: Boolean(selected && id === selected.id), selectedOutline: selected ? getComputedStyle(selected).outlineStyle + \" \" + getComputedStyle(selected).outlineWidth : null, listOutline: getComputedStyle(list).outlineStyle + \" \" + getComputedStyle(list).outlineWidth };";
const PAGE_DOWN = "const list = document.querySelector(\".history-list\"); const before = list.getAttribute(\"aria-activedescendant\"); list.dispatchEvent(new KeyboardEvent(\"keydown\", { key: \"PageDown\", bubbles: true })); return { before: before };";
const PAGE_UP = "const list = document.querySelector(\".history-list\"); list.dispatchEvent(new KeyboardEvent(\"keydown\", { key: \"PageUp\", bubbles: true })); return true;";
const LIST_STATE = "const list = document.querySelector(\".history-list\"); const selected = document.querySelector('.history-row[aria-selected=\"true\"]'); return { active: list.getAttribute(\"aria-activedescendant\"), selected: selected ? selected.id : null, scrollTop: Math.round(list.scrollTop) };";
const ROUND = "const list = one(\".history-list\"); const selected = one('.history-row[aria-selected=\"true\"]'); return { scrollTop: Math.round(list.scrollTop), selected: selected ? selected.id : null, rows: all(\".history-row\").length, newestDisabled: one(\".history-pager button\").disabled };";
const MENU = "const menu = one(\".context-menu\"); return { open: Boolean(menu), box: box(menu), role: menu ? menu.getAttribute(\"role\") : null, inViewport: menu ? (menu.getBoundingClientRect().bottom <= innerHeight + 1 && menu.getBoundingClientRect().right <= innerWidth + 1) : null, focusInside: Boolean(menu && menu.contains(document.activeElement)), items: menu ? all(\".context-menu .context-item\").map((item) => ({ text: text(item), disabled: item.getAttribute(\"aria-disabled\"), title: item.title || null })) : [] };";
const BRANCH = "const popover = one(\".popover\"); const options = all(\".branch-option\"); const input = one(\".popover-search input\"); return { open: Boolean(popover), box: box(popover), headings: all(\".branch-popover-group\").map(text), groups: all(\".branch-group\").map((group) => ({ text: text(group), expanded: group.getAttribute(\"aria-expanded\") })), rendered: options.length, rowHeight: options[0] ? round(options[0].getBoundingClientRect().height) : null, selected: text(one('.branch-option[aria-selected=\"true\"]')), notes: all(\".branch-option-note\").map(text), disabled: all('.branch-option[aria-disabled=\"true\"]').length, activedescendant: input ? input.getAttribute(\"aria-activedescendant\") : null, empty: text(one(\".branch-popover-empty\")), foot: all(\".popover-foot .menu-item\").map((item) => ({ text: text(item), disabled: item.disabled, title: item.title || null })), horizontalOverflow: popover ? popover.scrollWidth > popover.clientWidth + 1 : null };";
const PALETTE = "const input = one(\"#palette-input\"); const active = input.getAttribute(\"aria-activedescendant\"); const body = one(\".palette-body\"); body.scrollTop = 300; const titles = all(\".palette-group-title\"); return { box: box(one(\".palette-card\")), groups: titles.map(text), stickyTitles: titles.filter((title) => getComputedStyle(title).position === \"sticky\").length, items: all(\".palette-item\").length, activedescendant: active, pointsAtItem: Boolean(active && document.getElementById(active)), activeText: text(document.getElementById(active || \"\")), kbdRightEdges: [...new Set(all(\".palette-item kbd\").map((kbd) => Math.round(kbd.getBoundingClientRect().right)))], reasons: all(\".palette-reason\").map(text), bodyScrolls: body.scrollHeight > body.clientHeight + 1, pinnedTitleTop: titles.map((title) => Math.round(title.getBoundingClientRect().top)).filter((top) => Math.abs(top - Math.round(body.getBoundingClientRect().top)) <= 1).length, bodyTop: Math.round(body.getBoundingClientRect().top) };";
const PALETTE_EMPTY = "const card = one(\".palette-card\"); return { empty: text(one(\".palette-empty\")), hint: text(one(\".palette-empty-hint\")), activedescendant: one(\"#palette-input\").getAttribute(\"aria-activedescendant\"), cardHeight: card ? box(card).h : null };";
const REPO = "const popover = one(\".popover\"); const rows = all(\".switcher-option\"); const space = one(\".switcher-space\"); const input = one(\".popover-search input\"); const active = input ? input.getAttribute(\"aria-activedescendant\") : null; return { open: Boolean(popover), box: box(popover), list: box(one(\".popover-list\")), rendered: rows.length, total: rows[0] ? rows[0].getAttribute(\"aria-setsize\") : null, trackHeight: space ? parseInt(space.style.height, 10) : null, rowHeights: rows.slice(0, 3).map((row) => round(row.getBoundingClientRect().height)), activedescendant: active, pointsAtRow: Boolean(active && document.getElementById(active)), current: text(one('.switcher-option[aria-selected=\"true\"]')), reasons: all(\".switcher-reason\").map(text), foot: all(\".popover-foot .menu-item\").map(text), horizontalOverflow: popover ? popover.scrollWidth > popover.clientWidth + 1 : null };";
const REPO_KEY_STEP = "const input = document.querySelector(\".popover-search input\"); input.dispatchEvent(new KeyboardEvent(\"keydown\", { key: \"ArrowDown\", bubbles: true })); return true;";
const REPO_STATE = "const input = document.querySelector(\".popover-search input\"); const id = input.getAttribute(\"aria-activedescendant\"); const row = document.getElementById(id || \"\"); return { activedescendant: id, resolved: Boolean(row), text: row ? row.textContent.trim().replace(/\\s+/g, \" \").slice(0, 60) : null };";

const probe = (fragment) => "(() => {" + HELPERS + fragment + "})()";
const click = (selector) => "(() => { const element = document.querySelector(" + JSON.stringify(selector) + "); if (!element) return false; element.click(); return true; })()";
const pressEscapeOn = (selector) => "(() => { const element = document.querySelector(" + JSON.stringify(selector) + "); if (element) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return Boolean(element); })()";
const focusList = "(() => { const list = document.querySelector('.history-list'); list.focus(); return document.activeElement === list; })()";
const keyOnList = (key) => "(() => { const list = document.querySelector('.history-list'); list.dispatchEvent(new KeyboardEvent('keydown', { key: '" + key + "', bubbles: true })); return true; })()";
const contextOnFirstRow = "(() => { const row = document.querySelector('.history-row'); if (!row) return false; const rect = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 10 })); return true; })()";
const scrollListTo = (top) => "(() => { const list = document.querySelector('.history-list'); list.scrollTop = " + top + "; list.dispatchEvent(new Event('scroll')); return list.scrollTop; })()";

async function screenshot(cdp, sessionId, name) {
  const image = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(outDir, name), Buffer.from(image.data, "base64"));
  return name;
}

async function typeInto(cdp, sessionId, selector, value) {
  return evaluate(cdp, sessionId, "(() => { const input = document.querySelector(" + JSON.stringify(selector) + "); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, " + JSON.stringify(value) + "); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
}

async function openWorkspace(cdp, sessionId, url) {
  await cdp.send("Page.navigate", { url }, sessionId);
  await waitFor(cdp, sessionId, "Boolean(document.querySelector('.welcome-recent button, .action-card'))", "起始页");
  await pause(500);
  await evaluate(cdp, sessionId, "(() => { const recent = document.querySelector('.welcome-recent button'); if (recent) { recent.click(); return true; } const card = document.querySelector('.action-card'); if (card) { card.click(); return true; } return false; })()");
  await waitFor(cdp, sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
  await pause(800);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const report = { base, generatedAt: new Date().toISOString(), boundary: "浏览器 + mock 数据；不代表真实 Git 行为或桌面端观感", targets: [] };
  await withBrowser(async (cdp) => {
    for (const theme of ["light", "dark"]) {
      for (const size of [{ label: "1280x840", width: 1280, height: 840 }, { label: "900x600", width: 900, height: 600 }]) {
        const { targetId, sessionId } = await openSession(cdp, { url: base + "/", theme, width: size.width, height: size.height });
        const record = { theme, size: size.label, shots: [], history: null, keyboard: null, paging: null, roundTrip: null, menu: null, branch: null, palette: null, repo: null };
        const name = (suffix) => "after-" + theme + "-" + size.label + "-" + suffix + ".png";

        // 1. 历史：列表密度、详情层级、只读标记与分页状态
        await openWorkspace(cdp, sessionId, base + "/");
        await evaluate(cdp, sessionId, click('[data-view="history"]'));
        await pause(1300);
        record.history = await evaluate(cdp, sessionId, probe(HISTORY));
        record.shots.push(await screenshot(cdp, sessionId, name("history")));

        // 2. 键盘：焦点所在、aria-activedescendant、翻页
        await evaluate(cdp, sessionId, focusList);
        await evaluate(cdp, sessionId, keyOnList("ArrowDown"));
        await pause(300);
        record.keyboard = await evaluate(cdp, sessionId, probe(KEYBOARD));
        const pageDown = await evaluate(cdp, sessionId, probe(PAGE_DOWN));
        await pause(400);
        const afterDown = await evaluate(cdp, sessionId, probe(LIST_STATE));
        record.shots.push(await screenshot(cdp, sessionId, name("history-keyboard")));
        await evaluate(cdp, sessionId, probe(PAGE_UP));
        await pause(400);
        const afterUp = await evaluate(cdp, sessionId, probe(LIST_STATE));
        record.paging = { before: pageDown.before, afterDown, afterUp };

        // 3. 往返：改动 → 历史，滚动位置与选择是否保留
        await evaluate(cdp, sessionId, scrollListTo(300));
        await pause(400);
        const before = await evaluate(cdp, sessionId, probe(ROUND));
        await evaluate(cdp, sessionId, click('[data-view="changes"]'));
        await pause(700);
        await evaluate(cdp, sessionId, click('[data-view="history"]'));
        await pause(1400);
        const after = await evaluate(cdp, sessionId, probe(ROUND));
        record.roundTrip = { before, after, preserved: before.scrollTop === after.scrollTop && before.selected === after.selected };

        // 4. 提交右键菜单：定位、焦点与关闭后焦点
        await evaluate(cdp, sessionId, contextOnFirstRow);
        await pause(400);
        record.menu = await evaluate(cdp, sessionId, probe(MENU));
        record.shots.push(await screenshot(cdp, sessionId, name("menu")));
        await evaluate(cdp, sessionId, pressEscapeOn(".context-menu"));
        await pause(300);
        record.menu.closedAfterEscape = await evaluate(cdp, sessionId, "!document.querySelector('.context-menu')");
        record.menu.focusAfterEscape = await evaluate(cdp, sessionId, "document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null");

        // 5. 分支弹层：分组、当前项、禁用原因、键盘当前项
        await evaluate(cdp, sessionId, click(".branch-pill"));
        await pause(900);
        record.branch = await evaluate(cdp, sessionId, probe(BRANCH));
        record.shots.push(await screenshot(cdp, sessionId, name("branch")));
        await evaluate(cdp, sessionId, pressEscapeOn(".popover"));
        await pause(400);

        // 6. 命令面板：吸顶分组标题、快捷键列、当前项与空结果
        await evaluate(cdp, sessionId, click(".titlebar-brand"));
        await waitFor(cdp, sessionId, "Boolean(document.querySelector('#palette-input'))", "命令面板");
        await pause(400);
        record.palette = await evaluate(cdp, sessionId, probe(PALETTE));
        record.shots.push(await screenshot(cdp, sessionId, name("palette")));
        await typeInto(cdp, sessionId, "#palette-input", "没有这个命令");
        await pause(300);
        record.palette.empty = await evaluate(cdp, sessionId, probe(PALETTE_EMPTY));
        record.shots.push(await screenshot(cdp, sessionId, name("palette-empty")));
        await evaluate(cdp, sessionId, pressEscapeOn("#palette-input"));
        await pause(300);

        // 7. 仓库弹层：500 个最近仓库的虚拟列表与键盘
        await openWorkspace(cdp, sessionId, base + "/?recent=many");
        await evaluate(cdp, sessionId, click(".repo-switch"));
        await pause(900);
        record.repo = await evaluate(cdp, sessionId, probe(REPO));
        for (let step = 0; step < 5; step += 1) {
          await evaluate(cdp, sessionId, probe(REPO_KEY_STEP));
          await pause(120);
        }
        await pause(300);
        record.repo.keyboard = await evaluate(cdp, sessionId, probe(REPO_STATE));
        record.shots.push(await screenshot(cdp, sessionId, name("repo")));

        record.consoleErrors = consoleErrors(cdp, sessionId);
        record.exceptions = exceptions(cdp, sessionId);
        report.targets.push(record);
        await cdp.send("Target.closeTarget", { targetId });
        console.log("captured", theme, size.label, record.shots.length, "shots");
      }
    }
  });

  report.summary = {
    targets: report.targets.length,
    shots: report.targets.reduce((total, item) => total + item.shots.length, 0),
    consoleErrors: report.targets.reduce((total, item) => total + item.consoleErrors.length, 0),
    exceptions: report.targets.reduce((total, item) => total + item.exceptions.length, 0),
    roundTripPreserved: report.targets.map((item) => ({ theme: item.theme, size: item.size, preserved: item.roundTrip ? item.roundTrip.preserved : null })),
  };
  fs.writeFileSync(path.join(outDir, "after.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("完成：" + report.summary.shots + " 张截图，控制台错误 " + report.summary.consoleErrors + " 条，未捕获异常 " + report.summary.exceptions + " 条");
}

main().catch((error) => {
  console.error("T4 观察失败:", error.message);
  process.exit(1);
});
