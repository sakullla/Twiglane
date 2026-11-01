#!/usr/bin/env node
/**
 * R14 对比度门禁 — 解析 src/styles/tokens.css 的两套主题，按 WCAG 2.1 公式
 * 校验正文可读性与交互元素可辨识度，任一阈值不达标即非零退出。
 *
 * 判定口径（与需求 R14 对应）：
 * - 正文对（text）阈值 4.5:1：所有承载文字的令牌在两套主题的各级表面上。
 *   由 --hue 派生的首字母令牌（--avatar-*、--repo-badge-*）逐个色相校验
 *   （0–345°，步长 15），避免只测缺省色相 150 而漏掉最差情况（黄绿色相）；
 *   这些颜色由 --<名>-sat / --<名>-light 在元素上与 --hue 合成。
 * - 交互对（ui）阈值 3:1：既包含标示交互状态的语义色（焦点环、强调、危险/
 *   信息/警告），也包含可交互控件的自身边界令牌 --control-border /
 *   --control-border-hover——表单控件、次级按钮与可点击的 bordered 行只靠这条
 *   1px 边界与所在表面区分，因此它们是 R14「交互元素边界」的验收对象。
 *   --accent 同时承担「已选中/正在编辑」控件的状态边界（如冲突文件行的
 *   aria-pressed 态），所以它不只对 --surface/--bg 校验，也对 --surface-2 /
 *   --surface-3 校验，覆盖侧栏这类浅一档的底色。
 *   装饰性发丝线 --border / --border-strong 只做面板外框、分隔线与卡片框架，
 *   不承担控件边界，故不计入门禁；tests/tokens.spec.ts 用「默认拒绝 + 装饰白名单」
 *   的结构性断言保证没有任何 border 声明偷偷引用它们。
 *
 * 半透明令牌（如 --accent-soft）先按主题表面合成后再计算，避免把 alpha 当成颜色。
 * 不在解析范围的两类底色：渐变（--brand-grad，其上是品牌图标）与按需叠加的
 * 半透明徽标底（--push-count-bg，数字前景继承所在按钮，实测 6.24:1 / 7.82:1）。
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

/** 随 --hue 变化的正文对（仓库徽标与作者头像的首字母），逐色相校验，阈值 4.5:1。
 *  色相由每个实例的内联 --hue 提供，因此颜色在元素上合成：
 *  { token: "名" } 取 --名；{ recipe: "名" } 取 --名-sat / --名-light 合成 hsl(--hue …)。 */
const HUE_TEXT_PAIRS = [
  { fg: { token: "avatar-fg" }, bg: { recipe: "avatar-bg" } },
  { fg: { recipe: "repo-badge-fg" }, bg: { recipe: "repo-badge-bg" } },
];

/** 逐色相校验的取样点：0–345° 步长 15，覆盖 60°/240° 等最差色相。 */
const HUE_SAMPLES = Array.from({ length: 24 }, (_, index) => index * 15);

/** 交互对：状态色与控件边界 × 背景，阈值 3:1 */
const UI_PAIRS = [
  ["accent", "surface"],
  ["accent", "bg"],
  ["accent", "surface-2"],
  ["accent", "surface-3"],
  ["focus", "surface"],
  ["focus", "bg"],
  ["danger", "surface"],
  ["info", "surface"],
  ["warning", "surface"],
  ["control-border", "surface"],
  ["control-border", "bg"],
  ["control-border", "surface-2"],
  ["control-border", "surface-3"],
  ["control-border-hover", "surface"],
  ["control-border-hover", "bg"],
  ["control-border-hover", "surface-2"],
  ["control-border-hover", "surface-3"],
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

/** 把 var(--hue, <缺省>) 替换成具体色相；缺省色相用于非逐色相校验。 */
function substituteHue(text, hue) {
  return text.replace(/var\(\s*--hue\s*(?:,\s*([^)]*))?\)/g, (_all, fallback) => {
    if (hue !== undefined && hue !== null) return String(hue);
    const value = (fallback ?? "").trim();
    return value === "" ? "" : value;
  });
}

function hslToColor(hue, sat, light, alpha) {
  const s = sat / 100;
  const l = light / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((((hue % 360) + 360) % 360) / 60);
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return { r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255, a: alpha };
}

function parseColor(value, hue) {
  const text = substituteHue(String(value).trim(), hue);
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
  const hsl = text.match(
    /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/,
  );
  if (hsl) {
    let a = 1;
    if (hsl[4] !== undefined) {
      a = hsl[4].endsWith("%") ? Number.parseFloat(hsl[4]) / 100 : Number.parseFloat(hsl[4]);
    }
    return hslToColor(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]), a);
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

function resolve(tokens, name, base, label, problems, hue) {
  const raw = tokens.get(`--${name}`);
  if (raw === undefined) {
    problems.push(`${label}: 缺失令牌 --${name}`);
    return null;
  }
  const parsed = parseColor(raw, hue);
  if (!parsed) {
    problems.push(`${label}: 令牌 --${name}=${raw} 不是可计算的实色`);
    return null;
  }
  return base ? over(parsed, base) : parsed;
}

/** 背景类令牌半透明时，按主题画布 --bg 合成（surface-2/3 本身不透明）。 */
function background(tokens, name, label, problems, hue) {
  const resolved = resolve(tokens, name, null, label, problems, hue);
  if (!resolved) return null;
  if (resolved.a >= 1) return resolved;
  const base = resolve(tokens, "bg", null, label, problems, hue);
  return base ? over(resolved, base) : null;
}

/** 读取 --名 的百分比配比（如 --avatar-bg-sat: 42%）。 */
function percent(tokens, name, label, problems) {
  const raw = tokens.get(`--${name}`);
  if (raw === undefined) {
    problems.push(`${label}: 缺失令牌 --${name}`);
    return null;
  }
  const match = String(raw).trim().match(/^([\d.]+)%$/);
  if (!match) {
    problems.push(`${label}: 令牌 --${name}=${raw} 不是百分比配比`);
    return null;
  }
  return Number(match[1]);
}

/** 解析逐色相校验的一侧：{ token } 为普通令牌，{ recipe } 为由配比合成的 hsl。 */
function sideColor(tokens, side, hue, label, problems) {
  if (!side.recipe) return resolve(tokens, side.token, null, label, problems, hue);
  const sat = percent(tokens, `${side.recipe}-sat`, label, problems);
  const light = percent(tokens, `${side.recipe}-light`, label, problems);
  if (sat === null || light === null) return null;
  return hslToColor(hue, sat, light, 1);
}

function sideLabel(side) {
  return side.recipe ? `hsl(--${side.recipe}-sat/light)` : `--${side.token}`;
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
    for (const hue of HUE_SAMPLES) {
      for (const pair of HUE_TEXT_PAIRS) {
        const label = `${theme}/text ${sideLabel(pair.fg)} on ${sideLabel(pair.bg)} @hue ${hue}`;
        const bg = sideColor(tokens, pair.bg, hue, label, problems);
        if (!bg) continue;
        const fg = sideColor(tokens, pair.fg, hue, label, problems);
        if (!fg) continue;
        const value = ratio(fg, bg);
        const pass = value + 1e-9 >= MIN_TEXT;
        rows.push({ label, value, min: MIN_TEXT, pass });
        if (!pass) failures.push(`${label} = ${value.toFixed(2)}:1 (< ${MIN_TEXT}:1)`);
      }
    }
  }

  if (verbose || failures.length > 0) {
    for (const row of rows) {
      const mark = row.pass ? "ok  " : "FAIL";
      console.log(`${mark} ${row.label} = ${row.value.toFixed(2)}:1 (≥ ${row.min}:1)`);
    }
  }

  const textRows = rows.filter((r) => r.min === MIN_TEXT);
  const uiRows = rows.filter((r) => r.min === MIN_UI);
  const worst = (list) => list.sort((a, b) => a.value - b.value)[0];
  const worstText = worst([...textRows]);
  const worstUi = worst([...uiRows]);
  console.log(
    `对比度检查：${rows.length} 对（正文 ${textRows.length} / 交互 ${uiRows.length}），` +
      `正文最低 ${worstText ? `${worstText.value.toFixed(2)}:1（${worstText.label}）` : "n/a"}，` +
      `交互最低 ${worstUi ? `${worstUi.value.toFixed(2)}:1（${worstUi.label}）` : "n/a"}`,
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
  console.log("对比度检查通过：两套主题正文 ≥ 4.5:1（含逐色相的徽标/头像首字母），交互元素边界 ≥ 3:1");
  process.exitCode = 0;
}

main();
