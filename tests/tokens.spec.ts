// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const styles = path.join(root, "src/styles");
const read = (name: string) => readFileSync(path.join(styles, name), "utf8").replace(/\r\n/g, "\n");
const clean = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = read("tokens.css");
const base = read("base.css");
const components = read("components.css");

function theme(pattern: RegExp): Map<string, string> {
  const body = clean(tokens).match(pattern)?.[1];
  if (!body) throw new Error("缺少主题令牌");
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]*);/g)].map((match) => [match[1], match[2].trim()]));
}

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = clean(css).match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  if (!body) throw new Error(`缺少样式规则：${selector}`);
  return body;
}

describe("主题与无障碍契约", () => {
  it("两套主题覆盖同一组非空令牌", () => {
    const light = theme(/:root,\s*\[data-theme="light"\]\s*\{([^}]*)\}/);
    const dark = theme(/\[data-theme="dark"\]\s*\{([^}]*)\}/);
    expect(light.size).toBeGreaterThan(0);
    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
    for (const palette of [light, dark]) {
      expect([...palette].filter(([, value]) => !value)).toEqual([]);
    }
  });

  it("主题外的布局不写死颜色，保持切换主题的能力", () => {
    for (const name of ["base.css", "components.css", "layout.css"]) {
      const css = clean(read(name));
      const withoutUrls = css.replace(/url\((['"]?)[^)]*\1\)/g, "url()");
      expect(withoutUrls, name).not.toMatch(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/);
      expect(withoutUrls, name).not.toMatch(/\b(?:rgba?|hsla?)\((?!\s*var\()/);
      expect(css, name).not.toMatch(/%23[0-9a-fA-F]{6}/);
    }
  });

  it("真实主题叠层通过对比度检查", () => {
    const result = spawnSync(process.execPath, [path.join(root, "scripts/check-contrast.mjs")], { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("键盘可聚焦的菜单、列表、代码与编辑器保留焦点环", () => {
    for (const selector of [".menu-item:focus-visible", ".file-list:focus-visible", ".diff-scroll:focus-visible", ".history-list:focus-visible", ".three-way-pane.result textarea:focus-visible"]) {
      expect(rule(components, selector), selector).toMatch(/outline:\s*[^;]*var\(--focus\)/);
    }
  });

  it("减少动效不会隐藏控件或清除状态颜色", () => {
    const reduced = base.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(reduced).toMatch(/animation:\s*none !important/);
    expect(reduced).toMatch(/transition:\s*none !important/);
    expect(reduced).toMatch(/scroll-behavior:\s*auto !important/);
    expect(reduced).not.toMatch(/display\s*:|visibility\s*:|opacity\s*:|color\s*:/);
  });
});
