// 命令面板空结果的实际尺寸：修正 T4 记录里「卡片高度不变（167.3px）」的说法。
// 用法：node docs/verification/ui-ux-2026-11-04/t5/measure-palette.mjs [--base http://127.0.0.1:1430]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, openSession, pause, withBrowser, waitFor } from "./cdp.mjs";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const base = readArg("--base", "http://127.0.0.1:1430");
const outFile = path.join(here, "palette-measure.json");

const expression = `(() => {
  const px = (value) => Math.round(value * 100) / 100;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height), bottom: px(r.bottom) };
  };
  const styles = (el) =>
    el ? { padding: getComputedStyle(el).padding, margin: getComputedStyle(el).margin, display: getComputedStyle(el).display } : null;
  const card = document.querySelector(".palette-card");
  const body = document.querySelector(".palette-body");
  const empty = document.querySelector(".palette-empty");
  const hint = document.querySelector(".palette-empty-hint");
  const status = document.querySelector('.palette-body [role="status"]');
  return {
    card: box(card),
    body: body ? { ...box(body), rowGap: getComputedStyle(body).rowGap } : null,
    status: status ? { ...box(status), ...styles(status) } : null,
    empty: empty ? { ...box(empty), ...styles(empty) } : null,
    hint: hint ? { ...box(hint), ...styles(hint) } : null,
    gapBetweenParagraphs: empty && hint ? px(hint.getBoundingClientRect().top - empty.getBoundingClientRect().bottom) : null,
    items: document.querySelectorAll(".palette-item").length,
    groups: document.querySelectorAll(".palette-group").length,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`;

const typeText = (text) => `(() => {
  const input = document.querySelector("#palette-input");
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, ${JSON.stringify(text)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

const results = [];
await withBrowser(async (cdp) => {
  for (const theme of ["dark", "light"]) {
    const session = await openSession(cdp, { url: base + "/", theme, width: 1280, height: 840 });
    await waitFor(cdp, session.sessionId, "Boolean(document.querySelector('.welcome-recent button'))", "起始页");
    await pause(400);
    await evaluate(cdp, session.sessionId, "document.querySelector('.welcome-recent button').click()");
    await waitFor(cdp, session.sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
    await pause(600);
    await evaluate(cdp, session.sessionId, "document.querySelector('.titlebar-brand').click()");
    await waitFor(cdp, session.sessionId, "Boolean(document.querySelector('#palette-input'))", "命令面板");
    await pause(300);
    results.push({ theme, state: "open", ...(await evaluate(cdp, session.sessionId, expression)) });
    await evaluate(cdp, session.sessionId, typeText("zzzz-no-match"));
    await pause(400);
    results.push({ theme, state: "no-match", ...(await evaluate(cdp, session.sessionId, expression)) });
    await cdp.send("Target.closeTarget", { targetId: session.targetId });
  }
});

fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), base, results }, null, 2) + "\n");
console.log(JSON.stringify(results.filter((item) => item.state === "no-match"), null, 1));
