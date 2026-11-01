import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const stylesDir = path.join(root, "src", "styles");
const layerFiles = ["tokens.css", "base.css", "components.css", "layout.css"] as const;

function read(file: string): string {
  return readFileSync(file, "utf8");
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
});

describe("样式分层结构", () => {
  it("四层文件齐备", () => {
    for (const file of layerFiles) {
      expect(read(path.join(stylesDir, file)).trim().length, file).toBeGreaterThan(0);
    }
  });

  it("src/app.css 只做 @import 聚合且顺序固定", () => {
    const entry = read(path.join(root, "src", "app.css")).replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const imports = [...entry.matchAll(/@import\s+"([^"]+)";/g)].map((match) => match[1]);
    expect(imports).toEqual(["./styles/tokens.css", "./styles/base.css", "./styles/components.css", "./styles/layout.css"]);
    const withoutImports = entry.replace(/@import\s+"[^"]+";/g, "").trim();
    expect(withoutImports, "入口文件不应包含规则").toBe("");
  });
});
