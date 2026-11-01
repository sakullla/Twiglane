import { render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { createTextDiff } from "../src/lib/diff";
import { highlightLines, resetHighlightCache } from "../src/lib/syntax/client";
import { buildDiffDocuments } from "../src/lib/syntax/diffSyntax";
import { tokenizeInChunks, type SyntaxLine } from "../src/lib/syntax/engine";
import { canonicalLanguage, detectLanguage, LANGUAGE_OPTIONS } from "../src/lib/syntax/languages";
import {
  effectiveLanguage,
  PLAIN,
  resetSyntaxPrefs,
  setLanguageOverride,
  setSyntaxEnabled,
} from "../src/lib/syntax/prefs.svelte";
import { changedRange, lineSegments } from "../src/lib/syntax/segments";
import DiffView from "../src/lib/components/DiffView.svelte";
import { codeLine } from "./helpers/code";

describe("语言推断", () => {
  it("覆盖两百种以上语言，按扩展名、复合扩展名与完整文件名推断", () => {
    expect(LANGUAGE_OPTIONS.length).toBeGreaterThanOrEqual(200);
    const cases: [string, string | null][] = [
      ["src/App.svelte", "svelte"],
      ["src/main.ts", "typescript"],
      ["src/types.d.ts", "typescript"],
      ["src/View.tsx", "tsx"],
      ["scripts/build.mjs", "javascript"],
      ["app.py", "python"],
      ["src-tauri/src/lib.rs", "rust"],
      ["cmd/main.go", "go"],
      ["Main.java", "java"],
      ["Program.cs", "csharp"],
      ["engine/core.cpp", "cpp"],
      ["include/core.hpp", "cpp"],
      ["lib.c", "c"],
      ["App.kt", "kotlin"],
      ["View.swift", "swift"],
      ["index.php", "php"],
      ["Gemfile", "ruby"],
      ["Dockerfile", "docker"],
      ["Dockerfile.dev", "docker"],
      ["Makefile", "make"],
      ["CMakeLists.txt", "cmake"],
      ["README.MD", "markdown"],
      ["config.yaml", "yaml"],
      ["Cargo.toml", "toml"],
      ["tsconfig.json", "jsonc"],
      ["schema.graphql", "graphql"],
      ["query.sql", "sql"],
      ["deploy.sh", "shellscript"],
      ["build.ps1", "powershell"],
      ["main.tf", "terraform"],
      ["App.vue", "vue"],
      ["shader.wgsl", "wgsl"],
      ["main.zig", "zig"],
      ["init.lua", "lua"],
      ["notes.unknownext", null],
      ["LICENSE", "txt" === canonicalLanguage("txt") ? "txt" : null],
    ];
    for (const [path, expected] of cases) expect(detectLanguage(path), path).toBe(expected);
  });

  it("手动语言按扩展名记住；纯文本与总开关都能关掉高亮", () => {
    resetSyntaxPrefs();
    expect(effectiveLanguage("a/b.h")).toBe("c");
    setLanguageOverride("x/y.h", "cpp");
    expect(effectiveLanguage("other/z.h")).toBe("cpp");
    setLanguageOverride("x/y.h", PLAIN);
    expect(effectiveLanguage("x/y.h")).toBeNull();
    setLanguageOverride("x/y.h", null);
    expect(effectiveLanguage("x/y.h")).toBe("c");
    expect(JSON.parse(localStorage.getItem("twiglane.syntax") ?? "{}").overrides).toEqual({});
    setSyntaxEnabled(false);
    expect(effectiveLanguage("src/main.ts")).toBeNull();
    resetSyntaxPrefs();
    expect(effectiveLanguage("src/main.ts")).toBe("typescript");
  });
});

describe("分词引擎", () => {
  it("分块时延续语法状态：跨块的块注释仍被识别为注释", async () => {
    const lines = ["const a = 1;", "/* 开始", "  仍在注释里", "  结束 */", "const b = `x", "${a}`;"];
    const out: SyntaxLine[] = [];
    const ok = await tokenizeInChunks("typescript", lines, (start, chunk) => chunk.forEach((line, i) => (out[start + i] = line)), {
      chunkLines: 2,
    });
    expect(ok).toBe(true);
    expect(out).toHaveLength(lines.length);
    expect(out[0].some((token) => token.k.includes("tk-keyword") && token.t === "const")).toBe(true);
    // 第 3 行在第二块里，只有带着上一块的状态才知道它在注释中。
    expect(out[2].every((token) => token.k.includes("tk-comment"))).toBe(true);
    expect(out[3][0].k).toContain("tk-comment");
    // 每行的片段拼起来与原文一致
    out.forEach((line, index) => expect(line.map((token) => token.t).join("")).toBe(lines[index]));
  });

  it("未知语言不分词，超长行按纯文本显示", async () => {
    expect(await tokenizeInChunks("no-such-language", ["x"], () => {})).toBe(false);
    const long = `const s = "${"x".repeat(3000)}";`;
    const out: SyntaxLine[] = [];
    await tokenizeInChunks("typescript", ["const a = 1;", long], (start, chunk) => chunk.forEach((line, i) => (out[start + i] = line)));
    expect(out[1]).toEqual([{ t: long, k: "" }]);
    expect(out[0].length).toBeGreaterThan(1);
  });

  it("客户端缓存：同语言同内容第二次请求同步命中", async () => {
    resetHighlightCache();
    const lines = ["let x = 1;"];
    await new Promise<void>((resolve) => highlightLines("typescript", lines, () => {}, () => resolve()));
    let sync = false;
    highlightLines("typescript", lines, () => (sync = true));
    expect(sync).toBe(true);
  });
});

describe("差异行与行内改动", () => {
  it("旧侧与新侧分别成文档，行内改动只标真正不同的字符", () => {
    const diff = createTextDiff("a.ts", "const LIMIT = 20;\nkeep();\n", "const LIMIT = 50;\nkeep();\n", 1);
    const docs = buildDiffDocuments(diff.lines);
    expect(docs.oldLines).toEqual(["const LIMIT = 20;", "keep();"]);
    expect(docs.newLines).toEqual(["const LIMIT = 50;", "keep();"]);
    const del = diff.lines.findIndex((line) => line.kind === "del");
    const add = diff.lines.findIndex((line) => line.kind === "add");
    expect(docs.ranges.get(del)).toEqual([14, 15]);
    expect(docs.ranges.get(add)).toEqual([14, 15]);
    // 几乎完全不同的两行不标（整行标亮等于没标）
    expect(changedRange("return legacy();", "const view = render();")).toBeNull();
  });

  it("语法片段与改动区间叠加切分；片段与文本对不上时退回整行", () => {
    const tokens = [
      { t: "const ", k: "tk-keyword" },
      { t: "x = 20;", k: "" },
    ];
    const segments = lineSegments("const x = 20;", tokens, [10, 12]);
    expect(segments.map((segment) => segment.t).join("")).toBe("const x = 20;");
    expect(segments.filter((segment) => segment.m).map((segment) => segment.t).join("")).toBe("20");
    expect(segments[0]).toEqual({ t: "const ", k: "tk-keyword", m: false });
    expect(lineSegments("other", tokens)).toEqual([{ t: "other", k: "", m: false }]);
  });
});

describe("差异视图里的语法高亮", () => {
  beforeEach(() => {
    resetSyntaxPrefs();
    resetHighlightCache();
  });

  function renderDiff(path: string, before: string, after: string) {
    const diff = createTextDiff(path, before, after, 1);
    return render(DiffView, {
      props: {
        selection: { path, side: "unstaged" },
        diff,
        error: null,
        loading: false,
        disabled: false,
        onStageHunk: () => {},
        onLoadMore: () => {},
      },
    });
  }

  it("按文件语言着色并显示语言；再次打开同一内容命中缓存也不会反复渲染", async () => {
    const first = renderDiff("src/panel.ts", "export const LIMIT = 20;\n", "export const LIMIT = 50;\n");
    expect(screen.getByRole("button", { name: "语法高亮语言：TypeScript" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".diff .tk-keyword")).toBeTruthy(), { timeout: 5000 });
    expect(screen.getByText(codeLine("export const LIMIT = 50;"))).toBeTruthy();
    expect(document.querySelector(".diff-line.add .wd")?.textContent).toBe("5");
    first.unmount();
    // 缓存命中时结果在 effect 里同步送达：曾因版本号自增被追踪而无限重跑。
    renderDiff("src/panel.ts", "export const LIMIT = 20;\n", "export const LIMIT = 50;\n");
    await waitFor(() => expect(document.querySelector(".diff .tk-keyword")).toBeTruthy(), { timeout: 200 });
  });

  it("关闭语法高亮后按纯文本显示，行内改动标记仍在", async () => {
    setSyntaxEnabled(false);
    renderDiff("src/panel.ts", "export const LIMIT = 20;\n", "export const LIMIT = 50;\n");
    expect(screen.getByRole("button", { name: "语法高亮语言：高亮已关闭" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector(".diff [class*='tk-']")).toBeNull();
    expect(document.querySelector(".diff-line.del .wd")?.textContent).toBe("2");
  });
});
