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
      层级: ["--z-sticky", "--z-resizer", "--z-rail", "--z-titlebar", "--z-progress", "--z-menu", "--z-palette", "--z-modal", "--z-toast"],
    };
    for (const [group, keys] of Object.entries(groups)) {
      const missing = keys.filter((key) => !shared.has(key));
      expect(missing, `${group}缺失`).toEqual([]);
    }
  });

  it("层级令牌按 resizer < rail < 标题栏 < 菜单 < 面板 < modal < toast 递增", () => {
    const order = ["--z-resizer", "--z-rail", "--z-titlebar", "--z-menu", "--z-palette", "--z-modal", "--z-toast"];
    const values = order.map((key) => Number.parseInt(shared.get(key) ?? "", 10));
    expect(values.every((value) => Number.isInteger(value))).toBe(true);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i], `${order[i]} 应大于 ${order[i - 1]}`).toBeGreaterThan(values[i - 1]);
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
    for (const selector of [".field", ".input, .textarea, .select", ".checkbox", ".switch input", ".btn-secondary", ".conflict-file"]) {
      expectControlBoundary(components, selector);
    }
    for (const selector of [".branch-pill", ".action-card", ".sidebar-add"]) {
      expectControlBoundary(layout, selector);
    }
    for (const [file, css, selector] of [
      ["components.css", components, ".field:hover"],
      ["components.css", components, ".btn-secondary:hover:not(:disabled)"],
      ["components.css", components, ".conflict-file:hover:not(:disabled)"],
      ["layout.css", layout, ".branch-pill:hover:not(:disabled)"],
      ["layout.css", layout, ".action-card:hover:not(:disabled)"],
      ["layout.css", layout, ".sidebar-add:hover:not(:disabled)"],
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
      // 颜色函数只允许由 var() 组合（如 hsl(var(--hue, 150) var(--x-sat) var(--x-light))），
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
    expect(avatar).toMatch(/background:\s*hsl\(var\(--hue, 150\) var\(--avatar-bg-sat\) var\(--avatar-bg-light\)\)/);
    expect(badge).toMatch(/color:\s*hsl\(var\(--hue, 150\) var\(--repo-badge-fg-sat\) var\(--repo-badge-fg-light\)\)/);
    expect(badge).toMatch(/background:\s*hsl\(var\(--hue, 150\) var\(--repo-badge-bg-sat\) var\(--repo-badge-bg-light\)\)/);
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
