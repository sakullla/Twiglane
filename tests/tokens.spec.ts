import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const stylesDir = path.join(root, "src", "styles");
const layerFiles = ["tokens.css", "base.css", "components.css", "layout.css"] as const;

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 取出单条规则的声明体；selector 按字面量匹配，要求从行首或上一条规则后开始。 */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stripComments(css).match(new RegExp(`(?:^|[\\n;}])\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`未找到规则 ${selector}`);
  return match[1];
}

function tokensOf(body: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const raw of body.split(";")) {
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (!key.startsWith("--") || !value) continue;
    tokens.set(key, value);
  }
  return tokens;
}

function block(css: string, regex: RegExp): Map<string, string> {
  const match = css.replace(/\/\*[\s\S]*?\*\//g, "").match(regex);
  if (!match) throw new Error(`未找到匹配 ${String(regex)} 的令牌块`);
  return tokensOf(match[1]);
}

/** 一条 CSS 规则（不含 @ 前缀的 at-rule 本身）；selector 为未拆分的完整前导串。 */
type ParsedRule = { selector: string; body: string };

/**
 * 极简 CSS 规则扫描：只做本仓库需要的两件事——取到规则前导与声明体、进入 @media/@container
 * 继续扫描、跳过 @keyframes 里的关键帧块。规则体内不允许再嵌套花括号（本仓库无嵌套语法）。
 */
function parseRules(css: string): ParsedRule[] {
  const text = stripComments(css);
  const rules: ParsedRule[] = [];
  const atRules: string[] = [];
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
      if (end === -1) throw new Error(`规则未闭合：${head}`);
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
function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
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

/** 引用装饰发丝线的 var(--border) / var(--border-strong)（不会命中 --control-border）。 */
const HAIRLINE_REFERENCE = /var\(\s*--border(?:-strong)?\s*\)/;

/** 取出声明体内所有引用发丝线的 border / border-color / border-* 声明。 */
function hairlineBorderDeclarations(body: string): string[] {
  return body
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => /^border(?:-[a-z]+)*\s*:/.test(declaration) && HAIRLINE_REFERENCE.test(declaration));
}

const tokensCss = read(path.join(stylesDir, "tokens.css"));
const shared = block(tokensCss, /(?:^|\n)\s*:root\s*\{([^}]*)\}/);
const light = block(tokensCss, /:root,\s*\[data-theme="light"\]\s*\{([^}]*)\}/);
const dark = block(tokensCss, /\[data-theme="dark"\]\s*\{([^}]*)\}/);

describe("设计令牌", () => {
  it("浅色与深色定义的令牌键集合完全一致", () => {
    const lightKeys = [...light.keys()].sort();
    const darkKeys = [...dark.keys()].sort();
    const onlyLight = lightKeys.filter((key) => !dark.has(key));
    const onlyDark = darkKeys.filter((key) => !light.has(key));
    expect({ onlyLight, onlyDark }).toEqual({ onlyLight: [], onlyDark: [] });
    expect(darkKeys).toEqual(lightKeys);
  });

  it("两套主题的每个令牌都有非空取值", () => {
    for (const [theme, tokens] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const [key, value] of tokens) {
        expect(value, `${theme} ${key}`).not.toBe("");
        expect(value.trim(), `${theme} ${key}`).toBe(value);
      }
    }
  });

  it("补齐间距、字阶、动效时长与层级四类维度", () => {
    const groups: Record<string, string[]> = {
      间距: ["--space-2", "--space-4", "--space-6", "--space-8", "--space-12", "--space-16", "--space-24", "--space-32"],
      字阶: ["--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--weight-normal", "--weight-medium", "--weight-semibold", "--leading-tight", "--leading-normal", "--leading-relaxed"],
      动效: ["--duration-fast", "--duration-base", "--duration-slow", "--ease", "--ease-out"],
      层级: ["--z-sticky", "--z-resizer", "--z-titlebar", "--z-progress", "--z-menu", "--z-palette", "--z-modal", "--z-toast"],
    };
    for (const [group, keys] of Object.entries(groups)) {
      const missing = keys.filter((key) => !shared.has(key));
      expect(missing, `${group}缺失`).toEqual([]);
    }
  });

  it("起始页、命令面板、设置与任务弹窗的标题层级共用同一份字号与字距令牌", () => {
    expect(shared.get("--text-eyebrow"), "眉标字号只有一份").toBe("var(--text-xs)");
    expect(shared.get("--tracking-eyebrow"), "眉标字距只有一份").toBe("0.06em");
    expect(shared.get("--text-section-title"), "分区标题字号只有一份").toBe("var(--text-base)");
    const layout = read(path.join(stylesDir, "layout.css"));
    const components = read(path.join(stylesDir, "components.css"));
    for (const [css, selector] of [
      [layout, ".welcome-section-head h2"],
      [components, ".palette-group-title"],
    ] as const) {
      const body = ruleBody(css, selector);
      expect(body, `${selector} 用眉标字号`).toMatch(/font-size:\s*var\(--text-eyebrow\)/);
      expect(body, `${selector} 用眉标字距`).toMatch(/letter-spacing:\s*var\(--tracking-eyebrow\)/);
      expect(body, `${selector} 不再写死字距`).not.toMatch(/letter-spacing:\s*0\.06em/);
    }
    for (const selector of [
      ".settings-section h2",
      ".stash-section-head h2",
      ".card-head h2, .card-head h3",
      ".conflict-editor-titles h2",
    ]) {
      const body = ruleBody(components, selector);
      expect(body, `${selector} 用分区标题字号`).toMatch(/font-size:\s*var\(--text-section-title\)/);
    }
    // 任务弹窗标题是更高一档的面板标题，也要来自字阶令牌而不是字面值。
    expect(ruleBody(components, ".modal-titles h2")).toMatch(/font-size:\s*var\(--text-md\)/);
  });

  it("层级令牌按 resizer < 标题栏 < 菜单 < 面板 < modal < toast 递增", () => {
    const order = ["--z-resizer", "--z-titlebar", "--z-menu", "--z-palette", "--z-modal", "--z-toast"];
    const values = order.map((key) => Number.parseInt(shared.get(key) ?? "", 10));
    expect(values.every((value) => Number.isInteger(value))).toBe(true);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i], `${order[i]} 应大于 ${order[i - 1]}`).toBeGreaterThan(values[i - 1]);
    }
  });

  it("已删除的令牌不再出现", () => {
    for (const file of layerFiles) {
      expect(read(path.join(stylesDir, file)), file).not.toMatch(/--z-rail|--repo-current-shadow|--panel-shadow/);
    }
  });

  it("主题选择器只出现在令牌层", () => {
    for (const file of layerFiles.filter((name) => name !== "tokens.css")) {
      expect(read(path.join(stylesDir, file)), file).not.toMatch(/\[data-theme/);
    }
  });

  it("可交互控件的边界由 --control-border 提供，而不是装饰发丝线", () => {
    const components = read(path.join(stylesDir, "components.css"));
    const layout = read(path.join(stylesDir, "layout.css"));
    const expectControlBoundary = (css: string, selector: string) => {
      const body = ruleBody(css, selector);
      expect(body, selector).toMatch(/var\(--control-border(-hover)?\)/);
      expect(body, selector).not.toMatch(/var\(--border(-strong)?\)/);
    };
    for (const selector of [".field", ".input, .textarea, .select", ".checkbox", ".switch input", ".btn-secondary"]) {
      expectControlBoundary(components, selector);
    }
    for (const selector of [".branch-pill", ".action-card"]) {
      expectControlBoundary(layout, selector);
    }
    for (const [file, css, selector] of [
      ["components.css", components, ".field:hover"],
      ["components.css", components, ".btn-secondary:hover:not(:disabled)"],
      ["layout.css", layout, ".branch-pill:hover:not(:disabled)"],
      ["layout.css", layout, ".action-card:hover:not(:disabled)"],
    ] as const) {
      expect(ruleBody(css, selector), `${file} ${selector}`).toMatch(/var\(--control-border-hover\)/);
    }
  });

  it("控件边界令牌在两套主题中定义且对每个表面都不低于 3:1", () => {
    const surfaces = ["--surface", "--bg", "--surface-2", "--surface-3"];
    const parse = (value: string): number[] => {
      const hex = value.match(/^#([0-9a-fA-F]{6})$/);
      if (!hex) throw new Error(`不是 6 位十六进制色：${value}`);
      return [0, 2, 4].map((offset) => Number.parseInt(hex[1].slice(offset, offset + 2), 16));
    };
    const luminance = (rgb: number[]): number => {
      const channel = (c: number) => {
        const scaled = c / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    };
    const contrast = (a: number[], b: number[]): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const [theme, tokens] of [["light", light], ["dark", dark]] as const) {
      for (const token of ["--control-border", "--control-border-hover"]) {
        const value = tokens.get(token);
        expect(value, `${theme} ${token}`).toBeTruthy();
        for (const surface of surfaces) {
          const surfaceValue = tokens.get(surface);
          expect(surfaceValue, `${theme} ${surface}`).toBeTruthy();
          const measured = contrast(parse(value as string), parse(surfaceValue as string));
          expect(measured, `${theme} ${token} on ${surface}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });
});

describe("石墨靛蓝配色（R1）", () => {
  type Rgb = { r: number; g: number; b: number };

  const toRgb = (value: string): Rgb => {
    const hex = value.match(/^#([0-9a-fA-F]{6})$/);
    if (hex) {
      const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(hex[1].slice(offset, offset + 2), 16));
      return { r, g, b };
    }
    const rgba = value.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    if (!rgba) throw new Error(`无法解析颜色：${value}`);
    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]) };
  };

  const hueOf = ({ r, g, b }: Rgb): number => {
    const max = Math.max(r, g, b);
    const chroma = max - Math.min(r, g, b);
    if (chroma === 0) return 0;
    if (max === r) return (((g - b) / chroma + 6) % 6) * 60;
    if (max === g) return ((b - r) / chroma + 2) * 60;
    return ((r - g) / chroma + 4) * 60;
  };

  const tokenHue = (tokens: Map<string, string>, name: string): number => hueOf(toRgb(tokens.get(name) as string));

  it("目标色值按需求落地，且默认文档主题是深色", () => {
    const targets: Record<"dark" | "light", Record<string, string>> = {
      dark: {
        "--bg": "#0d0e11",
        "--surface": "#16171b",
        "--surface-2": "#111215",
        "--border": "#23252b",
        "--fg": "#ebecf0",
        "--fg-muted": "#a2a5af",
        "--accent": "#7e85fa",
      },
      light: { "--bg": "#f4f4f6", "--surface": "#ffffff", "--surface-2": "#f7f7f9", "--accent": "#4f56e0" },
    };
    for (const [name, expected] of Object.entries(targets.dark)) expect(dark.get(name), `dark ${name}`).toBe(expected);
    for (const [name, expected] of Object.entries(targets.light)) expect(light.get(name), `light ${name}`).toBe(expected);
    expect(read(path.join(root, "index.html"))).toMatch(/<html[^>]*data-theme="dark"/);
  });

  it("强调色、焦点环和品牌渐变都是靛蓝", () => {
    for (const [theme, tokens] of [["light", light], ["dark", dark]] as const) {
      for (const name of ["--accent", "--accent-hover", "--accent-text", "--accent-soft", "--accent-softer", "--focus"]) {
        const hue = tokenHue(tokens, name);
        expect(hue, `${theme} ${name}`).toBeGreaterThanOrEqual(225);
        expect(hue, `${theme} ${name}`).toBeLessThanOrEqual(250);
      }
      const stops = (tokens.get("--brand-grad") ?? "").match(/#[0-9a-fA-F]{6}/g) ?? [];
      expect(stops.length, `${theme} --brand-grad 色标`).toBeGreaterThanOrEqual(2);
      for (const stop of stops) {
        expect(hueOf(toRgb(stop)), `${theme} --brand-grad ${stop}`).toBeGreaterThanOrEqual(225);
        expect(hueOf(toRgb(stop)), `${theme} --brand-grad ${stop}`).toBeLessThanOrEqual(250);
      }
    }
  });

  it("新增行仍是语义绿，并与强调色明显不同", () => {
    for (const [theme, tokens] of [["light", light], ["dark", dark]] as const) {
      for (const name of ["--add-fg", "--add-bg", "--add-strong"]) {
        const hue = tokenHue(tokens, name);
        expect(hue, `${theme} ${name}`).toBeGreaterThanOrEqual(100);
        expect(hue, `${theme} ${name}`).toBeLessThanOrEqual(170);
        expect(tokenHue(tokens, "--accent") - hue, `${theme} ${name} 与强调色的色相差`).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it("成功语义令牌是语义绿，且与强调色明显不同", () => {
    for (const [theme, tokens] of [["light", light], ["dark", dark]] as const) {
      for (const name of ["--success", "--success-soft", "--success-softer", "--success-text"]) {
        const hue = tokenHue(tokens, name);
        expect(hue, `${theme} ${name}`).toBeGreaterThanOrEqual(100);
        expect(hue, `${theme} ${name}`).toBeLessThanOrEqual(170);
        expect(tokenHue(tokens, "--accent") - hue, `${theme} ${name} 与强调色的色相差`).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it("表示成功、完成、通过的位置走语义绿，不借用靛蓝强调色", () => {
    const components = read(path.join(stylesDir, "components.css"));
    const layout = read(path.join(stylesDir, "layout.css"));
    const componentSelectors = [
      ".composer-meta:has(.composer-ready) > .icon",
      ".empty-icon.ok",
      ".toast.ok .toast-icon",
      ".callout.ok",
      ".merge-verdict.ok",
      ".merge-verdict.ok .merge-verdict-icon",
      ".merge-done-icon",
      ".mp-status.ok",
      ".merge-progress > span",
      ".conflict-file-progress.ok",
      ".conflict-file.resolved .conflict-file-icon",
      ".conflict-file.resolved .conflict-file-icon .icon",
      ".conflict-file.resolved .chip",
      ".cr-line.res",
      ".cr-line.res .ln",
      ".cr-dot.ok",
      '.chip.current[data-hunk-state="resolved"]',
      ".chip.ok",
      ".cr-ruler-mark.ok",
      ".cr-progress > span",
    ];
    for (const selector of componentSelectors) {
      const body = ruleBody(components, selector);
      expect(body, selector).toMatch(/var\(--(success|on-success)/);
      expect(body, selector).not.toMatch(/var\(--accent/);
    }
    expect(ruleBody(layout, ".sb-dot"), ".sb-dot 常态").toMatch(/background:\s*var\(--success\)/);
  });

  it("样式层没有旧绿色强调色残留", () => {
    const retired = [
      "#0e7c55",
      "#0a6b49",
      "#0b6b4a",
      "#12976a",
      "#35c98c",
      "#43d69a",
      "#5ce0aa",
      "#6fe0b2",
      "#4bd89f",
      "#4ade9d",
      "#1d9d6d",
      "rgba(14, 124, 85",
      "rgba(67, 214, 154",
      "--hue, 150",
    ];
    for (const file of layerFiles) {
      const css = stripComments(read(path.join(stylesDir, file))).toLowerCase();
      for (const value of retired) expect(css.includes(value), `${file} 残留 ${value}`).toBe(false);
    }
  });
});

describe("对比度门禁按实际渲染层合成", () => {
  const run = () =>
    spawnSync(process.execPath, [path.join(root, "scripts", "check-contrast.mjs"), "--verbose"], { encoding: "utf8" });

  it("门禁通过，且半透明底和选中行逐个表面判定", () => {
    const result = run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    for (const theme of ["light", "dark"]) {
      for (const base of ["surface", "surface-2"]) {
        for (const label of [
          `${theme}/text --accent-text on --accent-soft over --${base} =`,
          `${theme}/selected --fg-subtle over --${base} =`,
          `${theme}/selected --warning-text on --warning-soft over --${base} + --accent-soft =`,
          `${theme}/selected --success-text on --success-soft over --${base} + --accent-soft =`,
        ]) {
          expect(result.stdout, label).toContain(label);
        }
      }
      // 代码文字逐一覆盖真实叠层：行内差异是双层，语法色要叠完再判定。
      for (const [site, top, under] of [
        [".diff-line.add .wd、.side-cell.add .wd", "--add-strong", "--surface + --add-bg"],
        [".diff-line.del .wd、.side-cell.del .wd", "--del-strong", "--surface + --del-bg"],
        [".cr-half.ours .mk", "--info@--mark-mix", "--surface + --info-soft"],
        [".cr-half.theirs .mk", "--purple@--mark-mix", "--surface + --purple-soft"],
        [".cr-line.res（已解决行）", "--success-softer", "--surface"],
        [".cr-line.warn（未解决上下文）", "--warning-soft", "--surface"],
        [".three-way-mark.ours", "--info-soft", "--surface"],
        [".three-way-mark.theirs", "--purple-soft", "--surface"],
        [".three-way-mark.manual", "--add-bg", "--surface"],
        [".three-way-mark.marker", "--warning-soft", "--surface"],
      ]) {
        for (const fg of ["--syn-keyword", "--syn-comment", "--fg", "--add-fg"]) {
          const label = `${theme}/code ${site} ${fg} on ${top} over ${under} =`;
          expect(result.stdout, label).toContain(label);
        }
      }
    }
  });

  it("结果栏来源标记与两侧语义一致，手动编辑不用靛蓝强调色", () => {
    const components = read(path.join(stylesDir, "components.css"));
    expect(ruleBody(components, ".three-way-mark.ours")).toContain("var(--info-soft)");
    expect(ruleBody(components, ".three-way-mark.theirs")).toContain("var(--purple-soft)");
    expect(ruleBody(components, ".three-way-gutter-row.ours")).toContain("var(--info)");
    expect(ruleBody(components, ".three-way-gutter-row.theirs")).toContain("var(--purple)");
    for (const selector of [".three-way-mark.manual", ".three-way-gutter-row.manual", ".three-way-key.manual i"]) {
      expect(ruleBody(components, selector), selector).not.toMatch(/--accent|--focus|--info|--purple/);
    }
    expect(ruleBody(components, ".three-way-editor textarea"), "标记层从 textarea 下方透出").toMatch(/background:\s*transparent/);
    expect(components).toMatch(/\.three-way-marks, \.three-way-gutter \{[^}]*pointer-events:\s*none/);
  });

  it("叠层比例由令牌声明，样式层不写死", () => {
    const components = read(path.join(stylesDir, "components.css"));
    expect(ruleBody(components, ".cr-half.ours .mk")).toMatch(/color-mix\(in srgb, var\(--info\) var\(--mark-mix\), transparent\)/);
    expect(ruleBody(components, ".cr-half.theirs .mk")).toMatch(/color-mix\(in srgb, var\(--purple\) var\(--mark-mix\), transparent\)/);
    expect(ruleBody(read(path.join(stylesDir, "base.css")), "::selection")).toMatch(
      /color-mix\(in srgb, var\(--accent\) var\(--selection-mix\), transparent\)/,
    );
    expect(ruleBody(components, ".code ::selection, .code::selection"), "代码选区统一用 --fg").toMatch(/color:\s*var\(--fg\)/);
    for (const [theme, tokens] of [["light", light], ["dark", dark]] as const) {
      for (const name of ["--mark-mix", "--selection-mix"]) expect(tokens.get(name), `${theme} ${name}`).toMatch(/^\d+%$/);
    }
  });
});

describe("行静止时没有描边卡片（R2）", () => {
  const components = read(path.join(stylesDir, "components.css"));
  const declares = (body: string, property: string) => new RegExp(`(?:^|;)\\s*${property}\\s*:`).test(body);

  it("文件行、提交行和冲突文件行静止时只有透明边界，没有填充和阴影", () => {
    for (const selector of [".file-row", ".history-row", ".conflict-file"]) {
      const body = ruleBody(components, selector);
      expect(body, `${selector} 边界`).toMatch(/border:\s*1px solid transparent/);
      expect(declares(body, "box-shadow"), `${selector} 阴影`).toBe(false);
      expect(body, `${selector} 填充`).not.toMatch(/(?:^|;)\s*background\s*:(?!\s*transparent)/);
    }
  });

  it("分支行不再带行分隔线", () => {
    expect(ruleBody(components, ".branch-row"), ".branch-row").toMatch(/border-bottom:\s*0/);
  });

  it("悬停和选中才出现状态底色，选中不再叠描边和阴影", () => {
    for (const selector of [".file-row:hover", ".history-row:hover", ".conflict-file:hover:not(:disabled)"]) {
      expect(ruleBody(components, selector), selector).toMatch(/background:\s*var\(--hover\)/);
    }
    for (const selector of [
      '.file-row[aria-selected="true"]',
      '.history-row[aria-selected="true"]',
      '.conflict-sidebar .conflict-file[aria-pressed="true"]',
    ]) {
      const body = ruleBody(components, selector);
      expect(body, selector).toMatch(/background:\s*var\(--accent-soft\)/);
      expect(declares(body, "border-color"), `${selector} 描边`).toBe(false);
      expect(declares(body, "box-shadow"), `${selector} 阴影`).toBe(false);
    }
  });
});

describe("冲突卡靠明度分层（R2、R9）", () => {
  const components = read(path.join(stylesDir, "components.css"));

  it("冲突卡没有描边和渐变，当前一处靠 --accent 竖条", () => {
    for (const rule of parseRules(components)) {
      if (!/\.cr-(card|head|cols|pair|half|row|main|ruler)\b/.test(rule.selector)) continue;
      expect(rule.body, rule.selector).not.toMatch(/(?:^|;)\s*border(?!-radius)(-[a-z]+)*\s*:(?!\s*0)/);
      expect(rule.body, rule.selector).not.toMatch(/gradient/);
    }
    expect(ruleBody(components, ".cr-card.current::before")).toMatch(/background:\s*var\(--accent\)/);
  });

  it("当前/来源两侧用 --info/--purple 语义，常用动作保留控件边界", () => {
    expect(ruleBody(components, ".cr-col.ours")).toMatch(/var\(--info-soft\)/);
    expect(ruleBody(components, ".cr-col.theirs")).toMatch(/var\(--purple-soft\)/);
    expect(ruleBody(components, ".cr-act.ours")).toMatch(/var\(--info-text\)/);
    expect(ruleBody(components, ".cr-act.theirs")).toMatch(/var\(--purple\)/);
    expect(ruleBody(components, ".cr-act")).toMatch(/border:\s*1px solid var\(--control-border\)/);
    expect(ruleBody(components, ".cr-act.quiet")).toMatch(/border-color:\s*transparent/);
    expect(ruleBody(components, ".cr-act.quiet:hover:not(:disabled)")).toMatch(/background:\s*var\(--hover\)/);
  });

  it("路由并入 modal 标题行，底部一条靠明度与正文分层", () => {
    const slot = ruleBody(components, ".mp-head-slot");
    expect(slot, "落点排在标题之后并占满余下宽度").toMatch(/flex:\s*1/);
    expect(stripComments(components), "不靠绝对定位和写死的标题宽度").not.toMatch(/\.mp-head[^{]*\{[^}]*position:\s*absolute/);
    expect(ruleBody(components, ".merge-route"), "路由不让位，只收缩 note").toMatch(/flex:\s*none/);
    expect(ruleBody(components, ".mp-note")).toMatch(/flex:\s*0 1 auto/);
    expect(ruleBody(components, ".mp-foot")).not.toMatch(/border-top/);
  });
});

describe("状态与动效统一（R2、R12）", () => {
  const components = read(path.join(stylesDir, "components.css"));
  const layout = read(path.join(stylesDir, "layout.css"));
  const base = read(path.join(stylesDir, "base.css"));

  it("弹窗、弹层和菜单使用同一组入场动画", () => {
    for (const selector of [".modal-card", ".popover", ".menu"]) {
      expect(ruleBody(components, selector), selector).toMatch(/animation:\s*pop\s/);
    }
    expect(stripComments(base), "没有第二套弹窗入场动画").not.toMatch(/@keyframes (modal-in|rise)\b/);
  });

  it("减少动效时取消全部动画和过渡，弹层弹窗没有位移", () => {
    const reduced = base.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(reduced).toMatch(/animation:\s*none !important/);
    expect(reduced).toMatch(/transition:\s*none !important/);
  });

  it("状态栏长文本收缩到上限，菜单禁用原因在文字区内折行", () => {
    const sync = ruleBody(layout, ".statusbar .sb-sync");
    expect(sync, "同步结论不许把刷新挤掉").toMatch(/max-width:\s*min\([^)]*vw/);
    expect(sync).toMatch(/overflow:\s*hidden/);
    // 同步结论、忙碌和警告的文字都收在可收缩的节点里，省略号才真画在文字上。
    const shrink = ruleBody(layout, ".statusbar .sb-sync > span:last-child,\n.statusbar .sb-text");
    expect(shrink).toMatch(/text-overflow:\s*ellipsis/);
    expect(shrink).toMatch(/min-width:\s*0/);
    expect(ruleBody(layout, ".statusbar .sb-busy, .statusbar .sb-warn")).toMatch(/max-width:\s*min\([^)]*vw[^)]*\)/);
    // sb-update 有两条规则（配色、上限），直接按整段规则匹配带上限的那条。
    expect(stripComments(layout), "忙碌与警告").toMatch(/\.statusbar \.sb-busy, \.statusbar \.sb-warn \{[^}]*max-width: min\([^)]*vw[^)]*\)/);
    expect(stripComments(layout), "新版本入口").toMatch(/\.statusbar \.sb-update \{[^}]*max-width: min\([^)]*vw[^)]*\)/);
    expect(stripComments(layout), "新版本文字自己省略").toMatch(/\.statusbar \.sb-update > span \{[^}]*text-overflow: ellipsis/);
    const label = ruleBody(components, ".context-item .context-label");
    expect(label).toMatch(/min-width:\s*0/);
    expect(label).toMatch(/text-overflow:\s*ellipsis/);
    expect(ruleBody(components, ".context-item .context-copy small")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("不可用控件的淡化比例只有一个来源", () => {
    expect(shared.get("--opacity-disabled")).toBe("0.45");
    for (const [file, css] of [["components.css", components], ["layout.css", layout]] as const) {
      for (const rule of parseRules(css)) {
        if (!/:disabled|aria-disabled/.test(rule.selector)) continue;
        expect(rule.body, `${file} ${rule.selector}`).not.toMatch(/(?:^|;)\s*opacity\s*:\s*[\d.]/);
      }
    }
  });

  it("输入类控件聚焦时画和全局一样的 --focus 环", () => {
    for (const selector of [
      ".field:focus-within",
      ".input:focus, .textarea:focus, .select:focus",
      ".composer-box:focus-within",
      "textarea.full-value.editable:focus",
    ]) {
      expect(ruleBody(components, selector), selector).toMatch(/outline:\s*2px solid var\(--focus\)/);
    }
  });

  it("历史列表的键盘当前项自带焦点环，命令面板分组标题吸顶", () => {
    expect(ruleBody(components, '.history-list:focus-visible .history-row[aria-selected="true"]')).toMatch(/outline:\s*2px solid var\(--focus\)/);
    const title = ruleBody(components, ".palette-group-title");
    expect(title).toMatch(/position:\s*sticky/);
    expect(title, "吸顶标题必须有实底，否则会透出下面的条目").toMatch(/background:\s*var\(--surface\)/);
  });

  it("主工作区的面板不再是圆角描边卡片", () => {
    for (const selector of [".span-main", ".diff", ".card"]) {
      const body = ruleBody(components, selector);
      expect(body, selector).not.toMatch(/(?:^|;)\s*border\s*:/);
      expect(body, selector).not.toMatch(/box-shadow/);
    }
    expect(ruleBody(components, ".span-main"), ".span-main 不留外边距").not.toMatch(/margin/);
    expect(stripComments(layout), "断点里也不再收 .span-main 的外边距").not.toMatch(/\.span-main/);
  });

  it("长分支名和标签名在确认区折行，不撑出横向滚动", () => {
    expect(ruleBody(components, ".callout")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("合并工具条只有文件名收缩，收文字断点在默认窗口之下", () => {
    const toggle = ruleBody(components, ".cr-toggle");
    expect(toggle).toMatch(/flex:\s*none/);
    expect(toggle).toMatch(/white-space:\s*nowrap/);
    const wide = components.match(/@media \(max-width: 1240px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(wide).toMatch(/\.cr-toggle-wide/);
    expect(wide).toMatch(/\.cr-seg-label/);
  });

  it("全屏弹窗的紧凑样式只管自己的头和正文，叠在合并面板里的确认框不被改掉内边距", () => {
    expect(stripComments(components), "不能用后代选择器：嵌套的 .modal-card 会被一起匹配").not.toMatch(/\.modal-fill\s+\.modal-(head|body|icon|titles)/);
    expect(ruleBody(components, ".modal-card.modal-fill > .modal-body")).toMatch(/padding:\s*0/);
    expect(ruleBody(components, ".modal-card.modal-fill > .modal-head > .modal-titles")).toMatch(/flex:\s*none/);
  });

  it("任务弹窗的分区标题同一档字号与字重，设置分区之间用分区线分开", () => {
    for (const selector of [".settings-section h2", ".stash-section-head h2"]) {
      const body = ruleBody(components, selector);
      expect(body, `${selector} 用共用分区标题字号`).toMatch(/font-size:\s*var\(--text-section-title\)/);
      expect(body, selector).toMatch(/font-weight:\s*var\(--weight-semibold\)/);
    }
    // 设置在小窗口里要滚动，分区线只在两个分区之间出现（第一段不画），风格上与 .commit-head 同类。
    expect(ruleBody(components, ".settings-section + .settings-section")).toMatch(/box-shadow:\s*inset 0 1px 0 var\(--border\)/);
    expect(ruleBody(components, ".settings-section + .settings-section")).toMatch(/padding-top:\s*var\(--space-12\)/);
  });

  it("弹窗打开时通知不盖住底部操作条", () => {
    expect(ruleBody(components, ":root:has(.modal-fill) .toasts")).toMatch(/bottom:\s*calc\(var\(--space-16\) \* 2 \+ var\(--mp-foot-height\)\)/);
    expect(ruleBody(components, ":root:has([data-modal-backdrop]) .toasts")).toMatch(/top:\s*var\(--space-8\)/);
    expect(ruleBody(components, ".mp-foot.strip")).toMatch(/var\(--mp-foot-height\)/);
  });

  it("窄详情改成上下布局，文件列表可收起", () => {
    const narrow = components.match(/@container history-detail \(max-width: 720px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(narrow).toMatch(/\.commit-split\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(narrow).toMatch(/\.commit-files\.collapsed \.history-files/);
    expect(ruleBody(components, ".commit-files-toggle"), "宽详情没有这个开关").toMatch(/display:\s*none/);
    expect(ruleBody(components, ".commit-body.clamped"), "长说明默认折叠到一行").toMatch(/white-space:\s*nowrap/);
    expect(narrow, "文件列表按详情高度分配，文件多时至少 3 行").toMatch(/\.commit-split:has\(\.commit-files-filter\)\s*\{[^}]*fit-content\(min\(max\(50%, 222px\), calc\(100% - 140px\)\)\)/);
  });

  it("合并说明窄窗也不被压缩", () => {
    expect(ruleBody(components, ".mp-foot.strip .mp-message")).toMatch(/min-width:\s*240px/);
  });

  it("行内改动除了底色还有底线", () => {
    expect(ruleBody(components, ".diff-line.add .wd, .side-cell.add .wd")).toMatch(/box-shadow:\s*inset 0 -1px 0 var\(--add-fg\)/);
    expect(ruleBody(components, ".diff-line.del .wd, .side-cell.del .wd")).toMatch(/box-shadow:\s*inset 0 -1px 0 var\(--del-fg\)/);
  });

  it("起始页的 Git 诊断和通知条同一语义色", () => {
    expect(ruleBody(layout, ".welcome-diagnostic")).toMatch(/var\(--danger-text\)/);
    expect(ruleBody(layout, ".welcome-diagnostic")).not.toMatch(/--warning/);
  });
});

describe("共享控件状态语义（T3）", () => {
  const components = read(path.join(stylesDir, "components.css"));
  const base = read(path.join(stylesDir, "base.css"));
  const selectedDisabled = [
    '.segmented button[aria-pressed="true"]:disabled',
    '.segmented button[aria-selected="true"]:disabled',
    '.segmented button[aria-pressed="true"][aria-disabled="true"]',
    '.segmented button[aria-selected="true"][aria-disabled="true"]',
    '.merge-mode button[aria-checked="true"]:disabled',
  ].join(",\n");

  it("禁用态走弱化令牌而不是整体 opacity，且不改变控件尺寸", () => {
    for (const [selector, expected] of [
      [".btn:disabled", /background:\s*var\(--surface-3\)/],
      [".menu-item:disabled", /color:\s*var\(--fg-subtle\)/],
      [".composer-inline-action:disabled", /color:\s*var\(--fg-subtle\)/],
      ['.segmented button:disabled, .segmented button[aria-disabled="true"]', /color:\s*var\(--fg-subtle\)/],
    ] as const) {
      const body = ruleBody(components, selector);
      expect(body, selector).not.toMatch(/(?:^|;)\s*opacity\s*:/);
      expect(body, selector).toMatch(expected);
    }
    for (const selector of [
      ".icon-btn:disabled",
      ".menu-item:disabled",
      ".composer-inline-action:disabled",
      '.segmented button:disabled, .segmented button[aria-disabled="true"]',
    ]) {
      const body = ruleBody(components, selector);
      for (const property of ["width", "height", "padding", "font-size", "gap", "border-width"]) {
        expect(body, `${selector} 不应改动 ${property}`).not.toMatch(new RegExp(`(?:^|;)\\s*${property}\\s*:`));
      }
    }
  });

  it("勾选框与开关禁用时保留可辨状态，不靠整体淡化", () => {
    expect(ruleBody(components, ".checkbox:disabled")).toMatch(/border-color:\s*var\(--control-border\)/);
    expect(ruleBody(components, ".checkbox:checked:disabled")).toMatch(/background:\s*var\(--control-border\)/);
    const toggle = ruleBody(components, ".switch input:disabled");
    expect(toggle).not.toMatch(/(?:^|;)\s*opacity\s*:/);
    expect(toggle).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--control-border\)/);
    expect(ruleBody(components, ".switch input:checked:disabled")).toMatch(/background:\s*var\(--control-border\)/);
    expect(ruleBody(components, ".switch:has(input:disabled)")).toMatch(/cursor:\s*not-allowed/);
  });

  it("选中/开启态至少有两重线索，不只靠细微明度差", () => {
    const flat = components.replace(/\r\n/g, "\n");
    const pressed = ruleBody(
      flat,
      '.btn-ghost[aria-pressed="true"]:not(:disabled),\n.btn-secondary[aria-pressed="true"]:not(:disabled),\n.diff-toolbar .diff-ws-btn[aria-pressed="true"]:not(:disabled)',
    );
    expect(pressed).toMatch(/background:\s*var\(--accent-soft\)/);
    expect(pressed).toMatch(/border-color:\s*var\(--accent\)/);
    expect(pressed).toMatch(/color:\s*var\(--accent-text\)/);
    expect(pressed, "空白开关不再单用 segmented 选中底色").not.toMatch(/--segmented-active/);
    const icon = ruleBody(components, '.icon-btn[aria-expanded="true"], .icon-btn[aria-pressed="true"]');
    expect(icon).toMatch(/background:\s*var\(--accent-soft\)/);
    expect(icon).toMatch(/color:\s*var\(--accent-text\)/);
    const segmented = ruleBody(
      components,
      '.segmented button[aria-pressed="true"], .segmented button[aria-selected="true"], .view-switcher button[aria-current="page"]',
    );
    expect(segmented).toMatch(/background:\s*var\(--segmented-active-bg\)/);
    expect(segmented).toMatch(/box-shadow:\s*var\(--segmented-active-shadow\)/);
    // 选中底由基础规则提供；禁用规则不覆盖 background，只换文字、光标并叠加边界。
    const disabled = ruleBody(flat, selectedDisabled);
    expect(disabled).toMatch(/color:\s*var\(--fg-muted\)/);
    expect(disabled, "选中禁用保留 active 阴影并叠加可辨边界").toMatch(
      /box-shadow:\s*var\(--segmented-active-shadow\), inset 0 0 0 1px var\(--fg-muted\)/,
    );
    expect(disabled).not.toMatch(/background/);
    expect(ruleBody(components, '.file-row[aria-selected="true"]::before')).toMatch(/background:\s*var\(--accent\)/);
  });

  it("选中禁用边界在深浅两主题都达到 3:1，且合并方式使用同一条规则", () => {
    const rule = ruleBody(components.replace(/\r\n/g, "\n"), selectedDisabled);
    expect(rule, "保留 segmented 的 active 阴影").toMatch(/var\(--segmented-active-shadow\)/);
    expect(rule, "边界取 --fg-muted，而不是深色下不足 3:1 的 --control-border").toMatch(
      /inset 0 0 0 1px var\(--fg-muted\)/,
    );
    expect(rule, "选中禁用不能覆盖选中底色").not.toMatch(/background/);

    const parse = (value: string): number[] => {
      const hex = value.match(/^#([0-9a-fA-F]{6})$/);
      if (!hex) throw new Error(`不是 6 位十六进制色：${value}`);
      return [0, 2, 4].map((offset) => Number.parseInt(hex[1].slice(offset, offset + 2), 16));
    };
    const luminance = (rgb: number[]): number => {
      const channel = (c: number) => {
        const scaled = c / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    };
    const contrast = (a: number[], b: number[]): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const [theme, tokens] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const boundary = tokens.get("--fg-muted");
      const activeBg = tokens.get("--segmented-active-bg");
      expect(boundary, `${theme} --fg-muted`).toBeTruthy();
      expect(activeBg, `${theme} --segmented-active-bg`).toBeTruthy();
      expect(contrast(parse(boundary as string), parse(activeBg as string)), `${theme} 选中禁用边界`).toBeGreaterThanOrEqual(3);
    }
  });

  it("命令面板的禁用项仍是键盘当前项时保留游标", () => {
    const rule = ruleBody(components, '.palette-item[aria-disabled="true"].active');
    expect(rule, "当前项保留 accent 底色").toMatch(/background:\s*var\(--accent-soft\)/);
    expect(rule, "左沿游标与禁用描边同时存在").toMatch(/box-shadow:\s*inset 2px 0 0 var\(--accent\), inset 0 0 0 1px var\(--control-border\)/);
    expect(rule, "禁用描边不能覆盖游标").not.toMatch(/background:\s*var\(--surface-2\)/);
  });

  it("幽灵按钮禁用时保持无框无底的同一形状，只用共享比例淡化", () => {
    // 静止时没有框和底色的按钮，禁用后补上框/底会比可用的那个更像按钮，可用性读反。
    for (const selector of [".icon-btn:disabled", ".btn-ghost:disabled"]) {
      const body = ruleBody(components, selector);
      expect(body, `${selector} 只用共享淡化比例`).toMatch(/opacity:\s*var\(--opacity-disabled\)/);
      expect(body, `${selector} 不加底色`).toMatch(/background:\s*transparent/);
      expect(body, `${selector} 不加内描边`).not.toMatch(/box-shadow:\s*inset/);
      for (const property of ["width", "height", "padding", "font-size", "gap", "border-width"]) {
        expect(body, `${selector} 不应改动 ${property}`).not.toMatch(new RegExp(`(?:^|;)\\s*${property}\\s*:`));
      }
    }
    expect(ruleBody(components, ".btn-ghost:disabled"), "ghost 的 1px 透明边界位保持透明").toMatch(/border-color:\s*transparent/);
    expect(ruleBody(components, ".icon-btn:disabled")).toMatch(/box-shadow:\s*none/);
  });

  it("禁用态除文字色外还有中性填充或控件边界，且不改变尺寸", () => {
    expect(ruleBody(components, ".btn:disabled"), "常规按钮").toMatch(/border-color:\s*var\(--control-border\)/);
    const soft = ruleBody(components, ".btn-danger-soft:disabled");
    expect(soft, "软色按钮禁用回到中性填充").toMatch(/background:\s*var\(--surface-3\)/);
    expect(soft, "软色按钮禁用不能把 .btn:disabled 的边界改回透明").not.toMatch(/border(-color)?:\s*[^;]*transparent/);
    for (const selector of [
      ".menu-item:disabled",
      '.context-item[aria-disabled="true"]',
      '.palette-item[aria-disabled="true"]',
      '.segmented button:disabled, .segmented button[aria-disabled="true"]',
      ".composer-inline-action:disabled",
      ".switch input:disabled",
    ]) {
      const body = ruleBody(components, selector);
      expect(body, `${selector} 需要中性填充或内描边`).toMatch(
        /background:\s*var\(--surface-2\)|background:\s*var\(--surface-3\)|box-shadow:\s*inset 0 0 0 1px var\(--control-border\)/,
      );
    }
    expect(ruleBody(components, ".checkbox:disabled")).toMatch(/border-color:\s*var\(--control-border\)/);
    // 边界令牌本身已由对比度门禁按四个表面断言 ≥ 3:1（见上方「控件边界令牌…」用例）。
    for (const selector of [
      ".menu-item:disabled",
      '.context-item[aria-disabled="true"]',
      '.palette-item[aria-disabled="true"]',
      '.segmented button:disabled, .segmented button[aria-disabled="true"]',
      ".composer-inline-action:disabled",
    ]) {
      const body = ruleBody(components, selector);
      for (const property of ["width", "height", "padding", "font-size", "gap", "border-width"]) {
        expect(body, `${selector} 不应改动 ${property}`).not.toMatch(new RegExp(`(?:^|;)\\s*${property}\\s*:`));
      }
    }
  });

  it("紧边距控件与菜单容器都有可见焦点环", () => {
    expect(ruleBody(base, ":focus-visible"), "全局焦点环是共同底座").toMatch(/outline:\s*2px solid var\(--focus\)/);
    for (const selector of [".icon-btn:focus-visible", ".segmented button:focus-visible"]) {
      expect(ruleBody(components, selector), selector).toMatch(/outline-offset:\s*-2px/);
    }
    for (const selector of [".context-menu:focus-visible", ".context-item:focus-visible"]) {
      const body = ruleBody(components, selector);
      expect(body, selector).toMatch(/outline:\s*2px solid var\(--focus\)/);
      expect(body, selector).not.toMatch(/var\(--accent-soft/);
    }
  });

  it("加载态有固定尺寸与进行中光标，减少动效后仍保留静态加载形状", () => {
    const spinner = ruleBody(components, ".spinner");
    expect(spinner).toMatch(/width:\s*14px/);
    expect(spinner).toMatch(/height:\s*14px/);
    expect(spinner).toMatch(/flex:\s*none/);
    expect(spinner).toMatch(/border-top-color:\s*currentColor/);
    expect(spinner).toMatch(/animation:\s*spin/);
    expect(
      ruleBody(
        components,
        '.btn:has(> .spinner), .icon-btn:has(> .spinner), .segmented button:has(> .spinner), .btn[aria-busy="true"]',
      ),
    ).toMatch(/cursor:\s*progress/);
    const reduced = components.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(reduced, "加载环停转后仍有两道高亮弧").toMatch(/\.spinner \{[^}]*border-right-color:\s*currentColor/);
    expect(reduced, "减少动效不能把加载指示藏起来").not.toMatch(/display:\s*none|visibility:\s*hidden/);
    expect(reduced, "按压反馈不再位移或缩放").toMatch(
      /\.btn:active:not\(:disabled\), \.icon-btn:active:not\(:disabled\) \{ transform: none; \}/,
    );
    expect(reduced, "交换按钮的悬停旋转是装饰").toMatch(/\.merge-swap:hover:not\(:disabled\) \{ transform: none; \}/);
  });

  it("错误状态在行内提示、提示框与通知里共用危险语义", () => {
    for (const selector of [".inline-error", ".callout.error"]) {
      const body = ruleBody(components, selector);
      expect(body, selector).toMatch(/var\(--danger-soft\)/);
      expect(body, selector).toMatch(/var\(--danger-text\)/);
    }
    expect(ruleBody(components, ".toast.error .toast-icon")).toMatch(/var\(--danger\)/);
    expect(ruleBody(components, ".composer-meta .composer-error")).toMatch(/var\(--danger-text\)/);
  });

  it("减少动效只关闭动效，不覆盖任何状态外观", () => {
    const reduced = base.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(reduced).toMatch(/animation:\s*none !important/);
    expect(reduced).toMatch(/transition:\s*none !important/);
    expect(reduced).toMatch(/scroll-behavior:\s*auto !important/);
    expect(reduced, "状态外观由静态形状、语义色和文字承担，不能靠隐藏或淡化").not.toMatch(
      /display\s*:|visibility\s*:|opacity\s*:|color\s*:/,
    );
  });

  it("写入锁定原因留在标题行，不占主操作位置", () => {
    const lock = ruleBody(components, ".modal-lock");
    expect(lock).toMatch(/color:\s*var\(--fg-muted\)/);
    expect(lock).toMatch(/font-size:\s*var\(--text-xs\)/);
    expect(lock, "状态标记只占标题行，不能改变底部操作条布局").toMatch(/flex:\s*none/);
    expect(ruleBody(components, ".modal-lock .spinner")).toMatch(/width:\s*11px/);
  });
});

describe("样式分层结构", () => {
  it("四层文件齐备", () => {
    for (const file of layerFiles) {
      expect(read(path.join(stylesDir, file)).trim().length, file).toBeGreaterThan(0);
    }
  });

  it("颜色字面值只出现在令牌层，组件与布局不内联主题外颜色", () => {
    for (const file of layerFiles.filter((name) => name !== "tokens.css")) {
      const css = stripComments(read(path.join(stylesDir, file)));
      const withoutUrls = css.replace(/url\((['"]?)[^)]*\1\)/g, "url()");
      expect(withoutUrls, file).not.toMatch(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/);
      // 颜色函数只允许由 var() 组合（如 hsl(var(--hue, 238) var(--x-sat) var(--x-light))），
      // 首参是数值或十六进制即属写死的颜色。
      expect(withoutUrls, file).not.toMatch(/\b(?:rgba?|hsla?)\((?!\s*var\()/);
      // data URI 里的 %23abcdef 同样是写死的颜色，无法随主题切换
      expect(css, file).not.toMatch(/%23[0-9a-fA-F]{6}/);
    }
    expect(stripComments(read(path.join(stylesDir, "tokens.css")))).toMatch(/#[0-9a-fA-F]{6}/);
  });

  it("头像与仓库徽标的色相在实例元素上合成，不在 :root 提前解析", () => {
    const components = read(path.join(stylesDir, "components.css"));
    const layout = read(path.join(stylesDir, "layout.css"));
    const avatar = ruleBody(components, ".avatar");
    const badge = ruleBody(layout, ".repo-badge");
    expect(avatar).toMatch(/background:\s*hsl\(var\(--hue, 238\) var\(--avatar-bg-sat\) var\(--avatar-bg-light\)\)/);
    expect(badge).toMatch(/color:\s*hsl\(var\(--hue, 238\) var\(--repo-badge-fg-sat\) var\(--repo-badge-fg-light\)\)/);
    expect(badge).toMatch(/background:\s*hsl\(var\(--hue, 238\) var\(--repo-badge-bg-sat\) var\(--repo-badge-bg-light\)\)/);
    // 派生颜色不能再以 :root 令牌的形式出现（那样 var(--hue) 会在根元素上取缺省值）
    const tokensCss = stripComments(read(path.join(stylesDir, "tokens.css")));
    for (const name of ["--avatar-bg", "--repo-badge-fg", "--repo-badge-bg"]) {
      expect(tokensCss).not.toMatch(new RegExp(`${name}\\s*:`));
    }
    for (const [theme, tokens] of [["light", light], ["dark", dark]] as const) {
      for (const name of ["--avatar-bg-sat", "--avatar-bg-light", "--repo-badge-fg-sat", "--repo-badge-fg-light", "--repo-badge-bg-sat", "--repo-badge-bg-light"]) {
        expect(tokens.get(name), `${theme} ${name}`).toMatch(/^[\d.]+%$/);
      }
    }
  });

  it("下拉箭头跟随主题变量而不是内联 SVG 颜色", () => {
    const body = ruleBody(read(path.join(stylesDir, "components.css")), ".select");
    expect(body).toMatch(/var\(--fg-subtle\)/);
    expect(body).not.toMatch(/data:image/);
  });

  it("src/app.css 只做 @import 聚合且顺序固定", () => {
    const entry = read(path.join(root, "src", "app.css")).replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const imports = [...entry.matchAll(/@import\s+"([^"]+)";/g)].map((match) => match[1]);
    expect(imports).toEqual(["./styles/tokens.css", "./styles/base.css", "./styles/components.css", "./styles/layout.css"]);
    const withoutImports = entry.replace(/@import\s+"[^"]+";/g, "").trim();
    expect(withoutImports, "入口文件不应包含规则").toBe("");
  });
});

/**
 * 装饰性发丝线白名单 —— 「默认拒绝」门禁的事实清单
 * ---------------------------------------------------------------------------
 * 为什么是白名单而不是逐条列举控件：`--border` / `--border-strong` 是发丝线，
 * 在白底上只有 1.3:1，只允许出现在「没有交互态、不承担控件边界」的轮廓与分隔线上。
 * 反过来（枚举所有控件）每加一个控件就漏一次，因此改成：任何在 border 族声明里
 * 引用发丝线的规则，只要选择器不在下表，测试就红。新增控件必须显式改用
 * `--control-border` / `--control-border-hover`（或可测的 `--accent` 状态边界），
 * 否则唯一的合法出路是带着理由进这张表。
 *
 * 每条的理由都要回答「为什么这里不需要 ≥3:1 的可辨识边界」：通常是因为
 * (a) 元素本身不可交互、没有 hover/focus/pressed 态；或
 * (b) 它是容器/表格轮廓，容器内的可交互控件各自带控件边界；
 * 或 (c) 它只做分区（标题栏底部、卡片头部底部这类横向分隔线）。
 *
 * 本门禁扫描 base.css / components.css / layout.css 三层（比要求的组件层+布局层多含基础层，
 * 因为 kbd、滚动条这些基础规则的边界同样不该冒充控件边界）。覆盖边界（明说不含糊）：
 * - 只审 `border` / `border-color` / `border-*` 声明。用 `background` 或 `box-shadow`
 *   画出来的线不在内（`.resizer`、`.menu-sep`、`.merge-step-line`、
 *   `.empty-icon`、`.context-separator` 的 `color`）：
 *   它们同样只做分区/描边，且没有哪一处是某个控件唯一的可见边界。
 * - 以 `transparent` 为常态的控件不会被命中：它们的可辨识度由其它手段承担，属另一套判据，
 *   不在本门禁内。现存六处，逐个说明为何可接受：
 *   `.btn`（文字按钮/实心按钮由标签与填充识别，ghost 有 hover 背景）、
 *   `.cr-act.quiet`（冲突卡的次要动作，文字按钮，由标签与 hover 底色识别；主路径两个按钮仍带控件边界）、
 *   `.file-row`、`.history-row` 与 `.conflict-file`（列表行由 hover 背景 + 选中态 accent-soft 填充与 accent 竖条识别）、
 *   `.action-card.primary`（强调卡是实心 accent 填充，边界本就无意义）。
 *   注意 `.file-tools .field` 曾经也是 transparent，填充差只有 1.04:1，已被改为继承
 *   `.field` 的 --control-border（见下方「被点名过的控件」用例）。
 */
const DECORATIVE_HAIRLINE_RULES: Record<string, string> = {
  // --- base.css ---
  kbd: "键位提示标签，纯展示文本；按钮内的 kbd 不承载点击态",

  // --- components.css：容器与浮层外框（容器内的控件各自带边界） ---
  ".menu": "浮层外框；菜单项自身用 hover 背景与文字色标示，外框不充当控件边界",
  ".toast": "通知卡外框，卡体不可交互（关闭按钮自带 hover 背景）",
  ".modal-card": "modal 卡片外框；层次由遮罩与阴影表达，卡内输入/按钮各自带边界",
  ".modal-foot": "modal 底部横向分隔线，分隔正文与操作区",
  ".callout": "提示框外框，静态说明块，无交互态",
  ".card-head": "卡片头部横向分隔线",
  ".card-foot": "卡片底部横向分隔线",
  ".list-box": "列表容器外框，行结构由行分隔线与 hover 背景表达",
  ".list-row": "列表行底部分隔线；行 hover 用背景色、选中用 accent 竖条",
  ".list-section": "分组标题底部分隔线，纯分区",
  ".list-empty": "空状态底部分隔线，纯分区",
  ".scope-list": "提交范围路径清单容器轮廓，清单项是只读文本",
  ".composer": "提交区与上方差异面板之间的顶部分区线",
  ".diff-toolbar": "差异工具条底部分隔线",
  ".diff-toolbar-group + .diff-toolbar-group": "工具条内部的分段竖线，只把位置/动作/视图三类控件分区，本身不可交互",
  ".diff-more": "差异面板底部横向分隔线",
  ".full-value": "详情弹窗的只读展示框（readonly textarea），只区分文本块；可编辑态 textarea.full-value.editable 用控件边界",
  ".multi-file": "多文件卡外框，卡内文件行自带交互反馈",
  ".switcher-hint": "仓库弹层底部键位提示的虚线分隔，纯说明文字",
  ".merge-review-side": "合并审阅左栏与明细之间的竖向分栏线；条目行自带 hover/选中反馈",
  ".merge-review-keys": "合并审阅左栏底部键位提示的分隔线，纯说明文字",
  ".merge-detail-head": "合并明细头部底部横向分隔线，纯分区",
  ".chip.ignore": "忽略标记 chip 的虚线描边，是状态标记而非可点击控件",
  // --- components.css：文件视图的分区线 ---
  ".file-findbar": "文件内搜索/跳行条与代码区之间的分区线，内部输入框与按钮自带控件边界",
  ".file-head .file-nav + .file-title": "文件头部里后退/前进与文件路径之间的分段竖线，纯分区",
  ".file-status": "文件底部状态条与代码区之间的顶部分区线，状态文字不可交互，语言按钮自带悬停反馈",
  ".file-search-results": "文件内匹配结果与代码区之间的分区线，命中行自带 hover/选中背景",
  ".file-note": "文件顶部的续读/截断说明条，纯状态文字分区",
  ".file-more": "续读按钮区与代码区之间的分区线，按钮自身带控件边界",
  ".file-tree-status": "树过滤补齐状态（失败/截断/显示上限）与树之间的只读说明分区线，说明文字不可交互",
  ".doc-reader-head": "文档阅读头部与正文之间的分区线，来源与路径是只读文字，内部按钮自带控件边界",
  ".doc-notice": "文档阅读的就地说明条（位置调整/截断）与正文的分区线，纯状态文字",
  ".doc-more": "文档源码续读按钮区与源码之间的分区线，按钮自身带控件边界",

  // --- components.css：表格/列分隔线与分区线 ---
  ".panel-toolbar": "面板工具条底部横向分隔线",
  ".commit-head": "提交信息区底部横向分隔线，纯分区",
  ".commit-files": "提交文件栏与差异之间的竖向分栏线；文件行自带 hover/选中反馈",
  ".history-multi-head": "多选头部底部横向分隔线",
  ".multi-file.expanded .multi-file-head": "展开的文件卡头部底部横向分隔线",
  ".stash-record": "临时保存记录底部横向分隔线",
  ".diff-line .ln + .ln": "差异视图行号列的表格竖线",
  ".side-cell + .side-cell": "双栏差异的列分隔竖线",
  ".split-hbar-cell + .split-hbar-cell": "双栏差异底部两条横向滚动条之间的列分隔竖线，与上方 .side-cell 竖线对齐",
  ".union-commits": "多选提交清单底部横向分区线，清单行自带 hover 反馈",
  ".union-diff-head": "多选差异区文件标题条底部横向分隔线",
  ".union-block": "多选差异里每个提交块的卡片外框，块内是只读差异",
  ".union-block-head": "提交块吸顶标题底部横向分隔线",

  // --- components.css：语义色混合的容器描边（不是控件边界） ---

  // --- layout.css ---
  ".infobar": "通知条底部横向分区线",
  ".statusbar": "状态栏顶部横向分区线",
};

describe("控件边界策略（默认拒绝）", () => {
  const layerFilesToScan = ["base.css", "components.css", "layout.css"] as const;

  it("引用装饰发丝线的 border 声明必须落在显式白名单内", () => {
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const file of layerFilesToScan) {
      const css = read(path.join(stylesDir, file));
      for (const rule of parseRules(css)) {
        const declarations = hairlineBorderDeclarations(rule.body);
        if (declarations.length === 0) continue;
        for (const selector of splitSelectorList(rule.selector)) {
          used.add(selector);
          if (!Object.prototype.hasOwnProperty.call(DECORATIVE_HAIRLINE_RULES, selector)) {
            offenders.push(`${file} :: ${selector} { ${declarations.join("; ")} }`);
          }
        }
      }
    }
    expect(
      offenders,
      "以下规则的边界引用了装饰发丝线 --border/--border-strong，却不在 tests/tokens.spec.ts 的装饰白名单内：" +
        "请在 components.css/layout.css 里改用 --control-border / --control-border-hover（或可测的 --accent 状态边界），" +
        "或把选择器连同「为什么它是纯装饰」的理由加进 DECORATIVE_HAIRLINE_RULES",
    ).toEqual([]);
  });

  it("白名单没有过期条目，且每条都写了理由", () => {
    const used = new Set<string>();
    for (const file of layerFilesToScan) {
      for (const rule of parseRules(read(path.join(stylesDir, file)))) {
        if (hairlineBorderDeclarations(rule.body).length === 0) continue;
        for (const selector of splitSelectorList(rule.selector)) used.add(selector);
      }
    }
    const stale = Object.keys(DECORATIVE_HAIRLINE_RULES).filter((selector) => !used.has(selector));
    expect(stale, "白名单条目已不再引用发丝线（规则被删或改用了控件边界），请同步删除").toEqual([]);
    const unexplained = Object.entries(DECORATIVE_HAIRLINE_RULES)
      .filter(([, reason]) => reason.trim().length < 8)
      .map(([selector]) => selector);
    expect(unexplained, "白名单条目必须写明为什么是纯装饰").toEqual([]);
  });

  it("被点名过的控件不再借装饰发丝线做边界", () => {
    const components = read(path.join(stylesDir, "components.css"));
    const fileToolsField = ruleBody(components, ".file-tools .field");
    expect(fileToolsField, ".file-tools .field 不能把边界覆盖成透明").not.toMatch(/border(-color)?:\s*[^;]*transparent/);
    for (const selector of [
      ".composer-box",
      ".composer-box:hover",
      ".composer-box:focus-within",
      "textarea.full-value.editable",
      "textarea.full-value.editable:hover",
      "textarea.full-value.editable:focus",
      ".conflict-file",
      ".conflict-file:hover:not(:disabled)",
      '.conflict-sidebar .conflict-file[aria-pressed="true"]',
      ".three-way-pane.result",
      ".three-way-pane.result:focus-within",
    ]) {
      expect(ruleBody(components, selector), selector).not.toMatch(/var\(--border(-strong)?\)/);
    }
    expect(ruleBody(components, ".composer-box"), ".composer-box 常态").toMatch(/var\(--control-border\)/);
    expect(ruleBody(components, ".composer-box:hover"), ".composer-box hover").toMatch(/var\(--control-border-hover\)/);
    expect(ruleBody(components, "textarea.full-value.editable"), ".full-value.editable 常态").toMatch(/var\(--control-border\)/);
    expect(ruleBody(components, "textarea.full-value.editable:hover"), ".full-value.editable hover").toMatch(
      /var\(--control-border-hover\)/,
    );
    // 冲突文件行按列表行判定（见下方「行静止时没有描边卡片」），当前编辑对象仍靠 --accent 竖条标示，
    // 不能退回只有浅底的选中态：--accent 对 --surface-2 的 ≥3:1 由 check-contrast 校验。
    expect(ruleBody(components, '.conflict-sidebar .conflict-file[aria-pressed="true"]::before'), "冲突文件行选中竖条").toMatch(
      /background:\s*var\(--accent\)/,
    );
    expect(ruleBody(components, ".three-way-pane.result"), ".three-way-pane.result 常态").toMatch(
      /border-(right|left):\s*1px solid var\(--control-border\)/,
    );
    expect(ruleBody(components, ".three-way-pane.result:focus-within"), ".three-way-pane.result 焦点态").toMatch(
      /var\(--accent\)/,
    );
    // 栏内 textarea 铺满整栏，栏上的内描边会被它盖住，因此焦点环必须落在 textarea 自身上。
    expect(ruleBody(components, ".three-way-pane.result textarea:focus-visible"), "合并结果编辑框焦点环").toMatch(
      /outline:\s*2px solid var\(--focus\)/,
    );
  });

  /**
   * 弱化位点的判据：不用元素级 opacity，改用弱化令牌。
   * 整行/文字 opacity 会把前景与所在表面按 α 合成，令牌层通过的值渲染后可能掉到
   * 4.5:1 以下（整行 0.75 会把 --fg-subtle 的 6.55:1 压到 3.64:1，同时把该行的
   * --control-border 压到 2.57:1）。scripts/check-contrast.mjs 的 COMPOSITE_TEXT_PAIRS
   * 按合成值兜底，这里挡住「重新加回 opacity」这一步。
   */
  it("弱化文字走弱化令牌，不用元素级 opacity", () => {
    const components = read(path.join(stylesDir, "components.css"));
    const layout = read(path.join(stylesDir, "layout.css"));
    const opacityDecl = /(?:^|;)\s*opacity\s*:\s*([\d.]+)\s*(?:;|$)/;

    const resolvedRow = ruleBody(components, ".conflict-sidebar .conflict-file.resolved");
    expect(opacityDecl.test(resolvedRow), ".conflict-file.resolved 不能用整行 opacity 弱化").toBe(false);
    expect(ruleBody(components, ".conflict-file.resolved .conflict-file-copy strong"), "已标记行名字").toMatch(
      /color:\s*var\(--fg-dimmed\)/,
    );

    const fromPath = ruleBody(components, ".file-name .fd.from");
    expect(opacityDecl.test(fromPath), ".fd.from 不能用文字 opacity 弱化").toBe(false);
    expect(fromPath, "来源路径弱化色").toMatch(/color:\s*var\(--purple-dimmed\)/);

    // 键位提示是正文信息：不能用 opacity 弱化（0.75 会把 --fg-subtle 压到 3.64:1）。
    expect(opacityDecl.test(ruleBody(components, ".composer-commit kbd")), "提交按钮键位提示").toBe(false);

    // 弱化令牌两套主题都要定义，且不得与基础正文色同值（否则「弱化」没有语义）。
    for (const [theme, tokens] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const [dim, base] of [
        ["--fg-dimmed", "--fg-subtle"],
        ["--purple-dimmed", "--purple"],
      ] as const) {
        expect(tokens.get(dim), `${theme} ${dim}`).toBeTruthy();
        expect(tokens.get(dim), `${theme} ${dim} 不应等于 ${base}`).not.toBe(tokens.get(base));
      }
    }
  });

  /**
   * 主行动卡（起始页第一入口）的说明文字是正文：必须取不透明的 --accent-fg
   * （--accent-fg 对 --accent 与 --accent-hover 的 4.5:1 由 check-contrast 校验）。
   * 75% 的 color-mix 淡化合成后低于正文 4.5:1，所以这张卡上任何文字和图标都不淡化；
   * 真要淡化必须先进 scripts/check-contrast.mjs 的 COLOR_MIX_ALPHA_SITES。
   */
  it("主行动卡的正文和图标都不淡化", () => {
    const layout = read(path.join(stylesDir, "layout.css"));
    const copy = ruleBody(layout, ".action-card.primary .ac-copy > span");
    expect(copy, "主行动卡正文取不透明 --accent-fg").toMatch(/color:\s*var\(--accent-fg\)/);
    expect(copy, "主行动卡正文不能再用 alpha 淡化").not.toMatch(/color-mix|transparent/);
    const glyph = ruleBody(layout, ".action-card.primary > .icon");
    expect(glyph, "主行动卡图标取不透明 --accent-fg").toMatch(/color:\s*var\(--accent-fg\)/);
    expect(glyph, "主行动卡图标不能再用 alpha 淡化").not.toMatch(/color-mix|transparent/);
  });

  it("起始页和设置的禁用态不用元素级 opacity，控件边界走 --control-border", () => {
    const layout = read(path.join(stylesDir, "layout.css"));
    const disabled = parseRules(layout).filter((rule) => splitSelectorList(rule.selector).includes(".action-card:disabled"));
    expect(disabled.length, ".action-card:disabled 规则").toBeGreaterThan(0);
    for (const rule of disabled) {
      expect(rule.body, ".action-card:disabled").not.toMatch(/(?:^|;)\s*opacity\s*:/);
    }
    expect(disabled.map((rule) => rule.body).join(";"), "禁用卡片仍有控件边界").toMatch(/border-color:\s*var\(--control-border\)/);
  });

  it("起始页的画布和最近仓库没有彩色光斑、描边和阴影", () => {
    const layout = read(path.join(stylesDir, "layout.css"));
    const welcome = ruleBody(layout, ".welcome");
    expect(welcome, "画布只取 --bg").toMatch(/background:\s*var\(--bg\)/);
    expect(welcome, "画布不用渐变光斑").not.toMatch(/gradient/);
    const list = ruleBody(layout, ".welcome-recent");
    expect(list, "最近仓库靠 --surface 明度分层").toMatch(/background:\s*var\(--surface\)/);
    expect(list, "最近仓库没有外框").not.toMatch(/(?:^|;)\s*border\s*:/);
    expect(list, "最近仓库没有阴影").not.toMatch(/box-shadow/);
  });

  /**
   * 焦点可见性：被清零 outline 的可聚焦元素/容器必须补回 ≥3:1 的可见焦点环。
   * 判据是「环本身的颜色」而不是它旁边有什么：--accent-soft 只是 9.5%（深 13%）alpha 的
   * tint，对 --surface 合成后约 1.15:1，画出来的环等于不可见；--focus 对 --surface 浅
   * 5.62:1 / 深 6.99:1、对 --surface-2 浅 5.07:1 / 深 6.54:1，也已在 check-contrast 的
   * 交互对里。R15 的验收归 T5，这里只挡住样式层把洞开回去。
   */
  it("被清零 outline 的可聚焦元素都补回可见焦点环", () => {
    const components = read(path.join(stylesDir, "components.css"));
    for (const selector of [
      ".menu-item:focus-visible",
      ".file-list:focus-visible",
      ".diff-scroll:focus-visible",
      ".history-list:focus-visible",
      ".three-way-pane.result textarea:focus-visible",
    ]) {
      const body = ruleBody(components, selector);
      expect(body, `${selector} 必须有可见焦点环`).toMatch(/outline:\s*2px solid var\(--focus\)/);
      expect(body, `${selector} 不能再用低透明度色块冒充焦点环`).not.toMatch(/var\(--accent-soft(?:er)?\)/);
    }
  });
});

describe("代码窗口横向滚动（R21）", () => {
  const components = read("src/styles/components.css");

  it("代码区不再省略，裁切用 clip：选区拖动时不会把 .code 自己滚走", () => {
    for (const selector of [".diff-line .code", ".side-cell .code", ".cr-line .code, .cr-half .code"]) {
      const body = ruleBody(components, selector);
      expect(body, selector).not.toMatch(/text-overflow/);
      expect(body, selector).toMatch(/overflow:\s*clip/);
    }
  });

  it("滚动容器原生可滚，横滑不触发后退，滚动条常驻", () => {
    const body = ruleBody(components, ".diff-scroll, .cr-scroll, .three-way-pane, .three-way-pane textarea, .cr-edit textarea");
    expect(body).toMatch(/overscroll-behavior-x:\s*contain/);
    expect(body).toMatch(/scrollbar-width:\s*auto/);
    expect(body).toMatch(/tab-size:\s*4/);
    expect(ruleBody(components, ".diff-scroll")).toMatch(/overflow:\s*auto/);
    expect(components).toMatch(/\.cr-scroll \{[^}]*overflow:\s*auto/);
    expect(ruleBody(components, ".three-way-pane")).toMatch(/overflow:\s*auto/);
  });

  it("所有代码滚动容器都用同一档粗滚动条", () => {
    for (const selector of [".diff-scroll", ".cr-scroll", ".three-way-pane", ".three-way-pane textarea", ".cr-edit textarea"]) {
      expect(components).toContain(`${selector}::-webkit-scrollbar,`.replace(/,$/, ""));
      expect(components).toContain(`${selector}::-webkit-scrollbar-thumb`);
    }
  });

  it("行钉在视口内，代码按 --code-x 平移，标尺不占高度也不可见", () => {
    const stage = ruleBody(components, ".code-stage");
    expect(stage).toMatch(/position:\s*sticky/);
    expect(stage).toMatch(/left:\s*0/);
    expect(stage).toMatch(/width:\s*var\(--code-view\)/);
    expect(ruleBody(components, ".code-in")).toMatch(/translateX\(calc\(var\(--code-x, 0px\) \* -1\)\)/);
    const ruler = ruleBody(components, ".code-ruler");
    expect(ruler).toMatch(/height:\s*0/);
    expect(ruler).toMatch(/visibility:\s*hidden/);
    expect(ruleBody(components, ".code-ruler::after")).toMatch(/width:\s*var\(--code-floor, 0\)/);
    expect(ruleBody(components, ".virtual-space, .cr-space")).toMatch(/width:\s*max-content/);
  });
});

describe("改动链路的扫描顺序与状态语义（T3）", () => {
  const components = read("src/styles/components.css");

  it("差异工具条的分段竖线是装饰，段内段外间距分得开", () => {
    expect(ruleBody(components, ".diff-toolbar-group")).toMatch(/gap:\s*var\(--space-8\)/);
    // 只有「位置/身份」那一段吃掉剩余宽度：路径该收缩，动作与布局不该被挤扁。
    expect(ruleBody(components, ".diff-toolbar-group.context")).toMatch(/flex:\s*1 1 auto/);
    const separator = ruleBody(components, ".diff-toolbar-group + .diff-toolbar-group");
    expect(separator, "竖线只做分区，走 --border").toMatch(/border-left:\s*1px solid var\(--border\)/);
    expect(separator).toMatch(/padding-left:\s*var\(--space-8\)/);
  });

  it("多文件工具条控件更多：段内间距再收一档，计数可以省略但不能溢出", () => {
    expect(ruleBody(components, ".multi-stack .diff-toolbar")).toMatch(/gap:\s*var\(--space-6\)/);
    expect(ruleBody(components, ".multi-stack .diff-file")).toMatch(/overflow:\s*hidden/);
    expect(ruleBody(components, ".multi-stack-count")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("文件列表的分区线画在表头上，不占行高、不改虚拟化", () => {
    const line = ruleBody(components, ".file-group::before");
    expect(line).toMatch(/position:\s*absolute/);
    expect(line).toMatch(/height:\s*1px/);
    expect(line).toMatch(/background:\s*var\(--border\)/);
    expect(ruleBody(components, ".file-group.first::before")).toMatch(/display:\s*none/);
  });

  it("暂存区为空取警告语义，与范围标签同一档；字数提示不挤掉「全部暂存」", () => {
    expect(ruleBody(components, ".composer-meta.warn > .icon")).toMatch(/color:\s*var\(--warning-text\)/);
    expect(ruleBody(components, ".composer-count + .composer-inline-action")).toMatch(/margin-left:\s*0/);
  });

  it("空状态里的恢复按钮与说明文字拉开一档", () => {
    expect(ruleBody(components, ".empty > .btn")).toMatch(/margin-top:\s*var\(--space-8\)/);
  });
});
