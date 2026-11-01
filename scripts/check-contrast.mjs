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
 *
 * 重要：令牌级通过 ≠ 含 opacity 的渲染通过。
 * 元素级的 opacity 会把前景与所在表面按 α 混合，令牌层算出的 5.10:1 在整行 0.75
 * 淡化后只剩 3.11:1（浅）/ 3.55:1（深）；同样位置上的 1px 控件边界也会掉到 3:1 以下。
 * 因此：
 * - 弱化文字一律走专门令牌（--fg-dimmed / --purple-dimmed），不用元素级 opacity；
 * - 任何仍然用 opacity 淡化文字的位置，必须登记进下面的 COMPOSITE_TEXT_PAIRS，
 *   按合成后的结果判定（弱化令牌的取值已按这些 α 标定，叠加后仍 ≥4.5:1）。
 * 只做「令牌 A 对令牌 B」的校验会漏掉这一整类回归——A4 之前就是这样漏的。
 *
 * 等效 alpha 同等对待：`color: color-mix(in srgb, var(--x) 75%, transparent)` 与元素级
 * opacity 0.75 是同一件事（前景按 75% 叠到所在表面），只是写法不同；半透明令牌直接当
 * color 用（`color: var(--accent-soft)`）也属同类。这类位点由下面的 DEFAULT-DENY 扫描
 * 逐个拦下：样式层（base/components/layout）里任何 `color:` 声明只要带 color-mix 的
 * transparent 混合或引用半透明令牌，就必须出现在 COLOR_MIX_ALPHA_SITES 里、写明淡化
 * 比例、所在表面与理由，并按合成结果达标（文字 4.5:1 / 非文本字形 3:1），否则失败。
 * 注意字面色（rgba(...) 字面量、#aabbcc80）不在这里审——tests/tokens.spec.ts 已禁止
 * 令牌层以外出现颜色字面量，因此上面这条是样式层唯一的 alpha 通道。
 *
 * 用法：node scripts/check-contrast.mjs [--verbose]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.resolve(here, "../src/styles/tokens.css");
const STYLES_DIR = path.resolve(here, "../src/styles");

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
  ["fg-dimmed", "bg"],
  ["fg-dimmed", "surface"],
  ["fg-dimmed", "surface-2"],
  ["fg-dimmed", "surface-3"],
  ["purple-dimmed", "surface"],
  ["purple-dimmed", "surface-2"],
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

/**
 * 显式合成对：文字所在元素带元素级 opacity 淡化时的渲染值，阈值 4.5:1。
 *
 * 每一对把「前景令牌 × 淡化系数」按所在表面合成后判定，也就是浏览器实际渲染的
 * 结果；不登记的淡化位点不受本层保护，所以新增任何用 opacity 淡化文字的地方，
 * 必须在这里补一行。清单里的 α 取自被取代的写法（整行淡化 0.75、来源路径淡化
 * 0.85）：弱化令牌的取值即按这些 α 标定，因此即使同类淡化重新出现也不会跌破 4.5:1；
 * 同时 tests/tokens.spec.ts 断言这两个弱化位点不再使用元素级 opacity。
 */
const COMPOSITE_TEXT_PAIRS = [
  { fg: "fg-dimmed", bg: "surface", opacity: 0.75 },
  { fg: "fg-dimmed", bg: "surface-2", opacity: 0.75 },
  { fg: "purple-dimmed", bg: "surface", opacity: 0.85 },
  { fg: "purple-dimmed", bg: "surface-2", opacity: 0.85 },
];

/** 被扫描的样式层文件：令牌层以外所有可能声明 `color:` 的地方。 */
const STYLE_LAYERS = ["base.css", "components.css", "layout.css"];

/**
 * 已标定的 alpha 淡化位点 —— 「默认拒绝」门禁的事实清单。
 *
 * 判据：样式层里任何 `color:` 声明，只要①用 `color-mix(..., transparent)` 把前景按
 * α 淡化，或②直接把半透明令牌当颜色用，就必须在下面登记一行。没有登记就失败。
 * 登记项同时承担校验与说明：
 * - `mix`：声明里保留前景的比例（0–1）。脚本会从声明中解析出实际比例并比对，
 *   所以改 CSS 里的百分比却不同步改这里会直接失败，不会静默漂移。
 * - `kind`：text（承载文字，≥4.5:1）或 glyph（纯字形指示，≥3:1）。
 * - `pairs`：前景令牌 × 所在表面令牌，逐个按合成结果判定；淡化位点在不同状态下有
 *   多个底色时（如强调卡 hover 变亮）必须逐个列出。
 * - `reason`：为什么这个位点的淡化可以接受（例如「它只是方向箭头，不是正文」）。
 *
 * 现状只有一条：主行动卡右上角的箭头图标。正文本行（.ac-copy > span）已改回不透明
 * --accent-fg，因此不再出现在本清单里——这正是本门禁想要的形状：淡化要么是证据，
 * 要么不存在。
 */
const COLOR_MIX_ALPHA_SITES = [
  {
    file: "layout.css",
    selector: ".action-card.primary > .icon",
    mix: 0.75,
    kind: "glyph",
    pairs: [
      ["accent-fg", "accent"],
      ["accent-fg", "accent-hover"],
    ],
    reason:
      "主行动卡右上角的方向箭头：纯字形指示、不承载文字信息（说明文字已改用不透明 --accent-fg），3:1 即可辨识",
  },
];

/** 交互对：状态色与控件边界 × 背景，阈值 3:1 */
const UI_PAIRS = [
  ["accent", "surface"],
  ["accent", "bg"],
  ["accent", "surface-2"],
  ["accent", "surface-3"],
  // 焦点环不再只落在画布上：文件列表/差异面板/历史列表的环画在 --surface，
  // 合并分支下拉的环落在 --surface-2 与 --accent-softer 的卡片底色上。
  ["focus", "surface"],
  ["focus", "bg"],
  ["focus", "surface-2"],
  ["focus", "surface-3"],
  ["focus", "accent-softer"],
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

/** 登记项的阈值：承载文字按正文口径，纯字形按非文本口径。 */
const ALPHA_SITE_MIN = { text: MIN_TEXT, glyph: MIN_UI };

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

/**
 * 极简 CSS 规则扫描（与 tests/tokens.spec.ts 同一套最小实现）：取规则前导与声明体，
 * 进入 @media/@container 继续扫描，跳过 @keyframes 内的关键帧块。规则体内不嵌套花括号。
 */
function parseRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const atRules = [];
  let prelude = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "{") {
      const head = prelude.trim();
      prelude = "";
      if (head.startsWith("@")) {
        atRules.push(head);
        index += 1;
        continue;
      }
      const end = text.indexOf("}", index);
      if (end === -1) break;
      const inKeyframes = atRules.some((at) => at.startsWith("@keyframes"));
      if (head && !inKeyframes) rules.push({ selector: head, body: text.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (char === "}") {
      atRules.pop();
      prelude = "";
      index += 1;
      continue;
    }
    if (char === ";") {
      prelude = "";
      index += 1;
      continue;
    }
    prelude += char;
    index += 1;
  }
  return rules;
}

/** 拆选择器组：只在括号外（:not(...) 等）按逗号分割。 */
function splitSelectorList(selector) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** 取出顶层 color-mix(...) 的实参列表（第一项是插值方式，之后是颜色与比例）。 */
function colorMixArgs(value) {
  const start = value.toLowerCase().indexOf("color-mix(");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let index = start + "color-mix".length; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    else if (value[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) return null;
  return value
    .slice(start + "color-mix(".length, end)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 从 `color-mix(in srgb, var(--x) 75%, transparent)` 里解出保留下来的前景比例（0.75）。
 * 不是「与 transparent 混合」的 color-mix 返回 null（那种混合两个不透明色，结果不透明）。
 * CSS 缺省规则：只写一侧比例时另一侧为 100% − 该比例；两侧都不写则各占 50%。
 */
function colorMixTransparentShare(value) {
  const args = colorMixArgs(value);
  if (!args) return null;
  const colors = args.slice(1);
  const transparentIndex = colors.findIndex((part) => /\btransparent\b/i.test(part));
  if (transparentIndex === -1) return null;
  const shareOf = (part) => {
    const match = part.match(/([\d.]+)%/);
    return match ? Number(match[1]) / 100 : null;
  };
  for (const [index, part] of colors.entries()) {
    if (index === transparentIndex) continue;
    const share = shareOf(part);
    if (share !== null) return share;
  }
  const transparentShare = shareOf(colors[transparentIndex]);
  return transparentShare === null ? 0.5 : 1 - transparentShare;
}

/** 令牌里所有半透明色的 α（rgba/hsla 令牌与其字面量），用于识别「把淡色当 color 用」。 */
function alphaTokenSet(blocks) {
  const set = new Set();
  for (const tokens of Object.values(blocks)) {
    if (!tokens) continue;
    for (const [key, raw] of tokens) {
      const parsed = parseColor(raw);
      if (parsed && parsed.a < 1) set.add(key);
    }
  }
  return set;
}

/**
 * 扫描样式层里所有「承载 color 的 alpha 淡化位点」：
 * - `color: color-mix(..., transparent)` —— 等效于元素级 opacity 的整段淡化；
 * - `color: var(--<半透明令牌>)` —— 直接把淡色当文字色，合成结果同样是淡化。
 * 返回值里每项自带淡化比例，交由调用方按 COLOR_MIX_ALPHA_SITES 逐个核对。
 */
function scanAlphaColorSites(blocks, problems) {
  const alphaTokens = alphaTokenSet(blocks);
  const sites = [];
  for (const file of STYLE_LAYERS) {
    let css;
    try {
      css = readFileSync(path.join(STYLES_DIR, file), "utf8");
    } catch {
      problems.push(`样式层缺少 ${file}`);
      continue;
    }
    for (const rule of parseRules(css)) {
      for (const raw of rule.body.split(";")) {
        const declaration = raw.trim();
        const match = declaration.match(/^color\s*:/);
        if (!match) continue;
        const value = declaration.slice(match[0].length).trim();
        let share = colorMixTransparentShare(value);
        if (share === null) {
          const tokenOnly = value.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i);
          if (tokenOnly && alphaTokens.has(tokenOnly[1])) share = 1;
        }
        if (share === null) continue;
        for (const selector of splitSelectorList(rule.selector)) {
          sites.push({ file, selector, value, declaration, share });
        }
      }
    }
  }
  return sites;
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
        rows.push({ label, value, min, kind, pass });
        if (!pass) failures.push(`${label} = ${value.toFixed(2)}:1 (< ${min}:1)`);
      }
    };
    check(TEXT_PAIRS, MIN_TEXT, "text");
    check(UI_PAIRS, MIN_UI, "ui");
    for (const pair of COMPOSITE_TEXT_PAIRS) {
      const label = `${theme}/composite --${pair.fg}@${pair.opacity} on --${pair.bg}`;
      const bg = background(tokens, pair.bg, label, problems);
      if (!bg) continue;
      const fg = resolve(tokens, pair.fg, bg, label, problems);
      if (!fg) continue;
      // 元素级 opacity：前景与所在表面按 α 混合后的实际渲染色。
      const rendered = over({ ...fg, a: pair.opacity }, bg);
      const value = ratio(rendered, bg);
      const pass = value + 1e-9 >= MIN_TEXT;
      rows.push({ label, value, min: MIN_TEXT, kind: "composite", pass });
      if (!pass) failures.push(`${label} = ${value.toFixed(2)}:1 (< ${MIN_TEXT}:1)`);
    }
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

  // ---- 样式层 alpha 淡化位点（默认拒绝 + 显式标定） ----
  const alphaSites = scanAlphaColorSites(blocks, problems);
  const registered = new Map(COLOR_MIX_ALPHA_SITES.map((site) => [`${site.file} :: ${site.selector}`, site]));
  const seen = new Set();
  for (const site of alphaSites) {
    const key = `${site.file} :: ${site.selector}`;
    const entry = registered.get(key);
    if (!entry) {
      failures.push(
        `${key} 用「${site.declaration}」淡化了文字/图标颜色，却不在 check-contrast.mjs 的 COLOR_MIX_ALPHA_SITES 里登记` +
          `（color-mix 的 transparent 混合与半透明令牌都是等效 alpha，必须逐个标定，或改回不透明令牌）`,
      );
      continue;
    }
    seen.add(key);
    if (Math.abs(entry.mix - site.share) > 1e-9) {
      failures.push(
        `${key} 声明里的淡化比例是 ${(site.share * 100).toFixed(0)}%，登记值是 ${(entry.mix * 100).toFixed(0)}%：` +
          `改比例必须同步重新标定 COLOR_MIX_ALPHA_SITES`,
      );
      continue;
    }
    const min = ALPHA_SITE_MIN[entry.kind];
    if (!min) {
      failures.push(`${key} 的 kind=${entry.kind} 无效（只能是 text 或 glyph）`);
      continue;
    }
    for (const theme of ["light", "dark"]) {
      for (const [fgName, bgName] of entry.pairs) {
        const label = `${theme}/alpha --${fgName}@${entry.mix} on --${bgName}（${key}）`;
        const bg = background(blocks[theme], bgName, label, problems);
        if (!bg) continue;
        const fg = resolve(blocks[theme], fgName, bg, label, problems);
        if (!fg) continue;
        // color-mix 的 α 与令牌自身 α 相乘，结果再按所在表面合成：浏览器实际渲染的颜色。
        const rendered = over({ ...fg, a: fg.a * entry.mix }, bg);
        const value = ratio(rendered, bg);
        const pass = value + 1e-9 >= min;
        rows.push({ label, value, min, kind: "alpha", pass });
        if (!pass) {
          failures.push(`${label} = ${value.toFixed(2)}:1 (< ${min}:1，kind=${entry.kind})`);
        }
      }
    }
  }
  for (const [key, entry] of registered) {
    if (!seen.has(key)) {
      failures.push(`COLOR_MIX_ALPHA_SITES 的 ${key} 已没有对应的淡化声明：规则被删或改用了不透明色，请同步删除该条目`);
    }
    if (String(entry.reason ?? "").trim().length < 8) {
      failures.push(`COLOR_MIX_ALPHA_SITES 的 ${key} 必须写明为什么这个淡化位点可以接受`);
    }
  }

  if (verbose || failures.length > 0) {
    for (const row of rows) {
      const mark = row.pass ? "ok  " : "FAIL";
      console.log(`${mark} ${row.label} = ${row.value.toFixed(2)}:1 (≥ ${row.min}:1)`);
    }
  }

  const textRows = rows.filter((r) => r.min === MIN_TEXT && r.kind !== "composite");
  const uiRows = rows.filter((r) => r.min === MIN_UI && r.kind !== "alpha");
  const compositeRows = rows.filter((r) => r.kind === "composite");
  const alphaRows = rows.filter((r) => r.kind === "alpha");
  const worst = (list) => list.sort((a, b) => a.value - b.value)[0];
  const worstText = worst([...textRows]);
  const worstUi = worst([...uiRows]);
  const worstComposite = worst([...compositeRows]);
  const worstAlpha = worst([...alphaRows]);
  console.log(
    `对比度检查：${rows.length} 对（正文 ${textRows.length} / 交互 ${uiRows.length} / 含 opacity 合成 ${compositeRows.length} / ` +
      `color-mix 淡化 ${alphaRows.length}，覆盖 ${new Set(alphaSites.map((s) => `${s.file} :: ${s.selector}`)).size} 个位点），` +
      `正文最低 ${worstText ? `${worstText.value.toFixed(2)}:1（${worstText.label}）` : "n/a"}，` +
      `交互最低 ${worstUi ? `${worstUi.value.toFixed(2)}:1（${worstUi.label}）` : "n/a"}，` +
      `合成最低 ${worstComposite ? `${worstComposite.value.toFixed(2)}:1（${worstComposite.label}）` : "n/a"}，` +
      `淡化最低 ${worstAlpha ? `${worstAlpha.value.toFixed(2)}:1（${worstAlpha.label}）` : "n/a"}`,
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
  console.log(
    "对比度检查通过：两套主题正文 ≥ 4.5:1（含逐色相的徽标/头像首字母、已登记的 opacity 合成对与 color-mix 淡化位点），" +
      "交互元素边界与焦点环 ≥ 3:1",
  );
  process.exitCode = 0;
}

main();
