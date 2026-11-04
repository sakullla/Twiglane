// T5 观察脚本：在 mock 预览上逐个打开任务弹窗，记录几何、可访问性状态与裁切情况，并截图。
// 只证明浏览器 + mock 数据下的界面尺寸与可达性，不代表真实 Git 行为或桌面端观感。
// 用法：node docs/verification/ui-ux-2026-11-04/t5/inspect-t5.mjs [--base http://127.0.0.1:1430] [--tag before]
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
const tag = readArg("--tag", "after");
const outDir = path.resolve(readArg("--out", here));

const THEMES = ["dark", "light"];
const SIZES = [
  { label: "1280x840", width: 1280, height: 840 },
  { label: "900x600", width: 900, height: 600 },
];

const clickSel = (selector) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return false;
  element.click();
  return true;
})()`;

const typeText = (selector, text) => `(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, ${JSON.stringify(text)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

const pressEscape = `(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return true;
})()`;

const pressEnterOnPalette = `(() => {
  const input = document.querySelector("#palette-input");
  if (!input) return false;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return true;
})()`;

/** 单个弹窗的几何与可达性快照。取最上层的 role=dialog（合并面板里可能叠着确认框）。 */
const measure = (label) => `(() => {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')];
  const card = dialogs[dialogs.length - 1] ?? null;
  if (!card) return { label: ${JSON.stringify(label)}, missing: true };
  const px = (value) => Math.round(value * 10) / 10;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height),
      right: px(r.right), bottom: px(r.bottom),
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" "),
      fontSize: cs.fontSize,
    };
  };
  const cardRect = card.getBoundingClientRect();
  const head = card.querySelector(":scope > .modal-head");
  const body = card.querySelector(":scope > .modal-body");
  const foot = card.querySelector(":scope > .modal-foot");
  const close = head ? head.querySelector('.icon-btn[aria-label="关闭对话框"]') : null;
  const bodyCs = body ? getComputedStyle(body) : null;
  /** 不在卡片里可见的按钮要能说明「可以滚动到达」还是「真的够不到」。 */
  const scrollerOf = (el) => {
    let node = el.parentElement;
    while (node && node !== card) {
      const style = getComputedStyle(node);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
        return (node.className || node.tagName).toString().split(" ")[0];
      }
      node = node.parentElement;
    }
    return null;
  };
  const allButtons = [...card.querySelectorAll("button, .btn")];
  const clipped = [];
  for (const el of allButtons) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.bottom > cardRect.bottom + 0.6 || r.right > cardRect.right + 0.6 || r.top < cardRect.top - 0.6 || r.left < cardRect.left - 0.6) {
      clipped.push({
        text: (el.textContent ?? "").trim().slice(0, 24) || el.getAttribute("aria-label"),
        rect: [px(r.x), px(r.y), px(r.width), px(r.height)],
        scroller: scrollerOf(el),
      });
    }
  }
  const footNodes = foot
    ? [...foot.children].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          node: (el.className || el.tagName).toString().slice(0, 28),
          text: (el.textContent ?? "").trim().slice(0, 30) || null,
          w: px(r.width),
          fromRight: px(cardRect.right - r.right),
          disabled: el.hasAttribute("disabled"),
          title: el.getAttribute("title"),
        };
      })
    : [];
  const active = document.activeElement;
  const styleOf = (selector) => {
    const el = card.querySelector(selector);
    return el ? box(el) : null;
  };
  return {
    label: ${JSON.stringify(label)},
    task: card.getAttribute("data-task-modal"),
    title: (card.querySelector(".modal-titles h2")?.textContent ?? "").trim(),
    description: (card.querySelector(".modal-desc")?.textContent ?? "").trim() || null,
    card: box(card),
    head: box(head),
    body: body
      ? {
          ...box(body),
          overflowY: bodyCs.overflowY,
          scrollHeight: body.scrollHeight,
          clientHeight: body.clientHeight,
          scrollable: body.scrollHeight > body.clientHeight + 1,
        }
      : null,
    foot: box(foot),
    footNodes,
    close: close
      ? { ...box(close), label: close.getAttribute("aria-label"), title: close.getAttribute("title"), disabled: close.hasAttribute("disabled") }
      : null,
    clippedButtons: clipped,
    focusInside: card.contains(active),
    focusNode: active ? active.tagName + (active.className ? "." + String(active.className).split(" ")[0] : "") : null,
    modalTitleBox: styleOf(".modal-titles h2"),
    sectionHeading: styleOf(".modal-body h2"),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    bodyHorizontalOverflow: body ? body.scrollWidth > body.clientWidth + 1 : null,
    merge:
      card.getAttribute("data-task-modal") === "merge"
        ? {
            sidebar: styleOf(".conflict-sidebar"),
            foot: styleOf(".mp-foot"),
            status: [...card.querySelectorAll(".mp-status")].map((el) => ({
              text: (el.textContent ?? "").trim().slice(0, 40),
              truncated: el.scrollWidth > el.clientWidth + 1,
            })),
            selectedFile: (card.querySelector('.conflict-file[aria-pressed="true"] strong')?.textContent ?? "").trim() || null,
            conflictRows: card.querySelectorAll(".conflict-file").length,
            primary: (card.querySelector(".mp-foot .btn-primary")?.textContent ?? "").trim() || null,
            primaryTitle: card.querySelector(".mp-foot .btn-primary")?.getAttribute("title") ?? null,
            conflictCards: card.querySelectorAll(".cr-node, .cr-card").length,
            footOverflow: (() => {
              const el = card.querySelector(".mp-foot");
              return el ? el.scrollWidth > el.clientWidth + 1 : null;
            })(),
            route: styleOf(".merge-route"),
            headActions: [...card.querySelectorAll(".mp-head .btn, .mp-head-slot .btn")].map((el) => {
              const r = el.getBoundingClientRect();
              return { text: (el.textContent ?? "").trim().slice(0, 16), right: px(r.right), bottom: px(r.bottom) };
            }),
            editorHead: styleOf(".conflict-editor-head"),
            crFoot: styleOf(".cr-foot"),
          }
        : null,
  };
})()`;

async function capture(cdp, sessionId, name, shots) {
  const image = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  const file = tag + "-" + name + ".png";
  fs.writeFileSync(path.join(outDir, file), Buffer.from(image.data, "base64"));
  shots.push(file);
}

async function openWorkspace(cdp, sessionId, query) {
  await cdp.send("Page.navigate", { url: base + "/" + (query ?? "") }, sessionId);
  await waitFor(cdp, sessionId, "Boolean(document.querySelector('.welcome-recent button, .action-card'))", "起始页");
  await pause(500);
  await evaluate(cdp, sessionId, clickSel(".welcome-recent button"));
  await waitFor(cdp, sessionId, "Boolean(document.querySelector('.view-switcher'))", "工作区");
  await pause(800);
}

async function openCommand(cdp, sessionId, text, readySelector) {
  await evaluate(cdp, sessionId, clickSel(".titlebar-brand"));
  await waitFor(cdp, sessionId, "Boolean(document.querySelector('#palette-input'))", "命令面板");
  await evaluate(cdp, sessionId, typeText("#palette-input", text));
  await pause(250);
  await evaluate(cdp, sessionId, pressEnterOnPalette);
  await waitFor(cdp, sessionId, "Boolean(document.querySelector(" + JSON.stringify(readySelector) + "))", text);
  await pause(450);
}

const focusProbe = `(() => {
  const el = document.activeElement;
  if (!el) return null;
  return {
    node: el.tagName + (el.className ? "." + String(el.className).split(" ")[0] : ""),
    label: (el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 16)) || null,
  };
})()`;

async function closeDialog(cdp, sessionId, onClosed) {
  await evaluate(cdp, sessionId, pressEscape);
  await pause(320);
  if (await evaluate(cdp, sessionId, "Boolean(document.querySelector('[role=dialog]'))")) {
    await evaluate(cdp, sessionId, pressEscape);
    await pause(320);
  }
  if (onClosed) onClosed(await evaluate(cdp, sessionId, focusProbe));
}

const DIALOGS = [
  { key: "settings", command: "设置", ready: '[data-task-modal="settings"]' },
  { key: "stash", command: "临时保存", ready: '[data-task-modal="stash"]' },
  { key: "branch", command: "分支与标签", ready: '[data-task-modal="branch"]' },
  { key: "scope", command: "本次提交范围", ready: '[data-task-modal="scope"]' },
  { key: "publish", command: "发布分支", ready: '[data-task-modal="publish"]' },
  { key: "merge", command: "分支合并", ready: '[data-task-modal="merge"]' },
  // 远程与克隆由 RepoDialogs 自己挂 Modal（不在任务槽位里），关闭后的焦点单独量一次。
  { key: "remote", command: "远程", ready: '[data-task-modal="remote"]' },
  { key: "clone", command: "克隆仓库", ready: "#clone-url" },
];

const report = { base, tag, generatedAt: new Date().toISOString(), targets: [], shots: [] };

await withBrowser(async (cdp) => {
  for (const theme of THEMES) {
    for (const size of SIZES) {
      const session = await openSession(cdp, { url: base + "/", theme, width: size.width, height: size.height });
      const entry = { theme, size: size.label, dialogs: [] };
      await openWorkspace(cdp, session.sessionId);
      for (const dialog of DIALOGS) {
        let measured = null;
        try {
          await openCommand(cdp, session.sessionId, dialog.command, dialog.ready);
          measured = await evaluate(cdp, session.sessionId, measure(dialog.key));
          await capture(cdp, session.sessionId, theme + "-" + size.label + "-" + dialog.key, report.shots);
        } catch (error) {
          measured = { label: dialog.key, error: error.message };
        }
        await closeDialog(cdp, session.sessionId, (focus) => {
          measured.afterCloseFocus = focus;
        });
        entry.dialogs.push(measured);
      }
      // 确认框（危险操作）：临时保存里删除一条记录，确认层叠在任务 modal 之上
      try {
        await openCommand(cdp, session.sessionId, "临时保存", '[data-task-modal="stash"]');
        await waitFor(cdp, session.sessionId, "Boolean(document.querySelector('.stash-record .btn-danger-soft'))", "临时保存记录");
        await evaluate(cdp, session.sessionId, clickSel(".stash-record .btn-danger-soft"));
        await waitFor(cdp, session.sessionId, "Boolean(document.querySelector('#stash-delete-title'))", "删除确认");
        await pause(400);
        entry.dialogs.push(await evaluate(cdp, session.sessionId, measure("confirm-delete-stash")));
        await capture(cdp, session.sessionId, theme + "-" + size.label + "-confirm-delete-stash", report.shots);
      } catch (error) {
        entry.dialogs.push({ label: "confirm-delete-stash", error: error.message });
      }
      await closeDialog(cdp, session.sessionId);
      await closeDialog(cdp, session.sessionId);

      // 详情弹窗：运行依赖说明
      try {
        await openCommand(cdp, session.sessionId, "运行依赖", "#detail-title");
        entry.dialogs.push(await evaluate(cdp, session.sessionId, measure("detail-dependencies")));
        await capture(cdp, session.sessionId, theme + "-" + size.label + "-detail-dependencies", report.shots);
      } catch (error) {
        entry.dialogs.push({ label: "detail-dependencies", error: error.message });
      }
      await closeDialog(cdp, session.sessionId);

      try {
        await openWorkspace(cdp, session.sessionId, "?merge=conflict");
        await openCommand(cdp, session.sessionId, "分支合并", '[data-task-modal="merge"]');
        await pause(700);
        entry.dialogs.push(await evaluate(cdp, session.sessionId, measure("merge-conflict")));
        await capture(cdp, session.sessionId, theme + "-" + size.label + "-merge-conflict", report.shots);
        // 冲突态里的「中止合并」：破坏性确认要列出受影响的路径
        await evaluate(cdp, session.sessionId, clickSel("button.btn-danger-soft"));
        await waitFor(cdp, session.sessionId, "Boolean(document.querySelector('#abort-merge-title'))", "中止合并确认");
        await pause(400);
        entry.dialogs.push(await evaluate(cdp, session.sessionId, measure("confirm-abort-merge")));
        await capture(cdp, session.sessionId, theme + "-" + size.label + "-confirm-abort-merge", report.shots);
      } catch (error) {
        entry.dialogs.push({ label: "merge-conflict", error: error.message });
      }
      await closeDialog(cdp, session.sessionId);
      await closeDialog(cdp, session.sessionId);

      // Git 缺失时设置弹窗的运行环境分区（失败/不可用状态）
      try {
        await openWorkspace(cdp, session.sessionId, "?git=missing");
        await openCommand(cdp, session.sessionId, "设置", '[data-task-modal="settings"]');
        await pause(300);
        entry.dialogs.push(await evaluate(cdp, session.sessionId, measure("settings-git-missing")));
        await capture(cdp, session.sessionId, theme + "-" + size.label + "-settings-git-missing", report.shots);
      } catch (error) {
        entry.dialogs.push({ label: "settings-git-missing", error: error.message });
      }
      report.targets.push(entry);
      await cdp.send("Target.closeTarget", { targetId: session.targetId });
    }
  }

  const session = await openSession(cdp, { url: base + "/", theme: "dark", width: 900, height: 600 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, session.sessionId);
  await openWorkspace(cdp, session.sessionId);
  await openCommand(cdp, session.sessionId, "设置", '[data-task-modal="settings"]');
  report.reducedMotion = await evaluate(
    cdp,
    session.sessionId,
    "(() => { const card = document.querySelector('[data-task-modal=\"settings\"]'); const cs = getComputedStyle(card); return { animations: document.getAnimations().length, animationName: cs.animationName, animationDuration: cs.animationDuration }; })()",
  );
  await capture(cdp, session.sessionId, "reduced-motion-dark-900x600-settings", report.shots);
  await cdp.send("Target.closeTarget", { targetId: session.targetId });
});

fs.writeFileSync(path.join(outDir, tag + ".json"), JSON.stringify(report, null, 2) + "\n");
console.log("完成：" + report.targets.length + " 组目标、" + report.shots.length + " 张截图 → " + outDir);
