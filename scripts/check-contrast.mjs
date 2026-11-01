#!/usr/bin/env node
/**
 * R14 对比度门禁 — 解析 src/styles/tokens.css 的两套主题，按 WCAG 2.1 公式
 * 校验正文可读性与交互元素可辨识度，任一阈值不达标即非零退出。
 *
 * 判定口径（与需求 R14 对应）：
 * - 正文对（text）阈值 4.5:1：所有承载文字的令牌在两套主题的各级表面上。
 * - 交互对（ui）阈值 3:1：用于标示可交互状态与边界的令牌（焦点环、强调、
 *   危险/信息/警告语义色）在表面上。装饰性发丝线 --border / --border-strong
 *   只是分隔线而非交互边界，按 WCAG 1.4.11 的适用对象不计入门禁。
 *
 * 半透明令牌（如 --accent-soft）先按主题表面合成后再计算，避免把 alpha 当成颜色。
 * 用法：node scripts/check-contrast.mjs [--verbose]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.resolve(here, "../src/styles/tokens.css");

/** 正文对：前景 × 背景，阈值 4.5:1 */
const TEXT_PAIRS = [
  ["fg", "bg"],
  ["fg", "surface"],
  ["fg", "surface-2"],
  ["fg", "surface-3"],
  ["fg-muted", "bg"],
  ["fg-muted", "surface"],
  ["fg-muted", "surface-2"],
  ["fg-muted", "surface-3"],
  ["fg-subtle", "surface"],
  ["fg-subtle", "surface-2"],
  ["fg-subtle", "surface-3"],
  ["accent-text", "surface"],
  ["accent-text", "accent-soft"],
  ["accent-text", "accent-softer"],
  ["accent-fg", "accent"],
  ["accent-fg", "accent-hover"],
  ["on-danger", "danger"],
  ["on-danger", "danger-hover"],
  ["danger-text", "surface"],
  ["danger-text", "danger-soft"],
  ["warning-text", "surface"],
  ["warning-text", "warning-soft"],
  ["info-text", "surface"],
  ["info-text", "info-soft"],
  ["purple", "surface"],
  ["purple", "purple-soft"],
  ["add-fg", "add-bg"],
  ["add-fg", "add-strong"],
  ["del-fg", "del-bg"],
  ["del-fg", "del-strong"],
  ["hunk-fg", "hunk-bg"],
];

/** 交互对：状态色 × 背景，阈值 3:1 */
const UI_PAIRS = [
  ["accent", "surface"],
  ["accent", "bg"],
  ["focus", "surface"],
  ["focus", "bg"],
  ["danger", "surface"],
  ["info", "surface"],
  ["warning", "surface"],
];

const MIN_TEXT = 4.5;
const MIN_UI = 3;

function parseThemeBlocks(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const readBlock = (regex) => {
    const match = stripped.match(regex);
    if (!match) return null;
    const body = match[1];
    const tokens = new Map();
    for (const raw of body.split(";")) {
      const idx = raw.indexOf(":");
      if (idx === -1) continue;
      const key = raw.slice(0, idx).trim();
      const value = raw.slice(idx + 1).trim();
      if (!key.startsWith("--") || !value) continue;
      tokens.set(key, value);
    }
    return tokens;
  };
  return {
    light: readBlock(/:root,\s*\[data-theme="light"\]\s*\{([^}]*)\}/),
    dark: readBlock(/\[data-theme="dark"\]\s*\{([^}]*)\}/),
    shared: readBlock(/(?:^|\n)\s*:root\s*\{([^}]*)\}/),
  };
}

function parseColor(value) {
  const text = String(value).trim();
  const hex = text.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    const digits = hex[1];
    const expand = digits.length === 3 || digits.length === 4 ? digits.split("").map((d) => d + d).join("") : digits;
    if (expand.length !== 6 && expand.length !== 8) return null;
    return {
      r: parseInt(expand.slice(0, 2), 16),
      g: parseInt(expand.slice(2, 4), 16),
      b: parseInt(expand.slice(4, 6), 16),
      a: expand.length === 8 ? parseInt(expand.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (rgb) {
    let a = 1;
    if (rgb[4] !== undefined) {
      a = rgb[4].endsWith("%") ? Number.parseFloat(rgb[4]) / 100 : Number.parseFloat(rgb[4]);
    }
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a };
  }
  return null;
}

function over(fg, bg) {
  if (fg.a >= 1) return fg;
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function luminance(color) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function resolve(tokens, name, base, label, problems) {
  const raw = tokens.get(`--${name}`);
  if (raw === undefined) {
    problems.push(`${label}: 缺失令牌 --${name}`);
    return null;
  }
  const parsed = parseColor(raw);
  if (!parsed) {
    problems.push(`${label}: 令牌 --${name}=${raw} 不是可计算的实色`);
    return null;
  }
  return base ? over(parsed, base) : parsed;
}

/** 背景类令牌半透明时，按主题画布 --bg 合成（surface-2/3 本身不透明）。 */
function background(tokens, name, label, problems) {
  const resolved = resolve(tokens, name, null, label, problems);
  if (!resolved) return null;
  if (resolved.a >= 1) return resolved;
  const base = resolve(tokens, "bg", null, label, problems);
  return base ? over(resolved, base) : null;
}

function main() {
  const verbose = process.argv.includes("--verbose");
  const css = readFileSync(TOKENS_PATH, "utf8");
  const blocks = parseThemeBlocks(css);
  const problems = [];

  for (const [name, tokens] of Object.entries(blocks)) {
    if (!tokens) problems.push(`tokens.css 缺少 ${name} 主题块`);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exitCode = 1;
    return;
  }

  const failures = [];
  const rows = [];

  for (const theme of ["light", "dark"]) {
    const tokens = blocks[theme];
    const check = (pairs, min, kind) => {
      for (const [fgName, bgName] of pairs) {
        const label = `${theme}/${kind} --${fgName} on --${bgName}`;
        const bg = background(tokens, bgName, label, problems);
        if (!bg) continue;
        const fg = resolve(tokens, fgName, bg, label, problems);
        if (!fg) continue;
        const value = ratio(fg, bg);
        const pass = value + 1e-9 >= min;
        rows.push({ label, value, min, pass });
        if (!pass) failures.push(`${label} = ${value.toFixed(2)}:1 (< ${min}:1)`);
      }
    };
    check(TEXT_PAIRS, MIN_TEXT, "text");
    check(UI_PAIRS, MIN_UI, "ui");
  }

  if (verbose || failures.length > 0) {
    for (const row of rows) {
      const mark = row.pass ? "ok  " : "FAIL";
      console.log(`${mark} ${row.label} = ${row.value.toFixed(2)}:1 (≥ ${row.min}:1)`);
    }
  }

  const worstText = rows.filter((r) => r.min === MIN_TEXT).sort((a, b) => a.value - b.value)[0];
  const worstUi = rows.filter((r) => r.min === MIN_UI).sort((a, b) => a.value - b.value)[0];
  console.log(
    `对比度检查：${rows.length} 对（正文 ${rows.filter((r) => r.min === MIN_TEXT).length} / 交互 ${rows.filter((r) => r.min === MIN_UI).length}），` +
      `正文最低 ${worstText ? worstText.value.toFixed(2) : "n/a"}:1，交互最低 ${worstUi ? worstUi.value.toFixed(2) : "n/a"}:1`,
  );

  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL ${p}`);
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`);
  }
  if (problems.length > 0 || failures.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("对比度检查通过：两套主题正文 ≥ 4.5:1，交互边界 ≥ 3:1");
  process.exitCode = 0;
}

main();
