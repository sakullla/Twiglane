import { describe, expect, it } from "vitest";
import {
  DOCUMENT_SESSION_LIMIT,
  clampSourceLine,
  createDocumentSession,
  documentSessionKey,
  initialDocumentMode,
  isMarkdownPath,
  resolveDocumentLink,
  resolveDocumentPath,
} from "../src/lib/document-session.svelte";

describe("Markdown 识别", () => {
  it("只按常用扩展名识别，不把文档图标类别当成 Markdown", () => {
    for (const path of ["README.md", "docs/引导.MD", "a.markdown", "b.mdown", "c.rmd"]) {
      expect(isMarkdownPath(path), path).toBe(true);
    }
    for (const path of ["src/app.ts", "notes.txt", "docs/manual.pdf", "README", "md"]) {
      expect(isMarkdownPath(path), path).toBe(false);
    }
  });
});

describe("文档内相对链接解析", () => {
  it("相对当前文档目录解析，保留中文、空格与锚点", () => {
    expect(resolveDocumentLink("docs/guide/start.md", "./install.md")).toEqual({
      kind: "local", path: "docs/guide/install.md", anchor: null, reason: "",
    });
    expect(resolveDocumentLink("docs/guide/start.md", "../规范/命名 约定.md#%E6%A0%87%E9%A2%98")).toEqual({
      kind: "local", path: "docs/规范/命名 约定.md", anchor: "标题", reason: "",
    });
    expect(resolveDocumentLink("README.md", "docs/%E8%AF%B4%E6%98%8E.md?a=1#top")).toEqual({
      kind: "local", path: "docs/说明.md", anchor: "top", reason: "",
    });
    expect(resolveDocumentLink("a/b.md", "../c.md")).toEqual({
      kind: "local", path: "c.md", anchor: null, reason: "",
    });
  });

  it("文内锚点不解成路径，外部网页单独分类", () => {
    expect(resolveDocumentLink("docs/a.md", "#%E4%B8%AD%E6%96%87")).toEqual({
      kind: "anchor", path: "docs/a.md", anchor: "中文", reason: "",
    });
    expect(resolveDocumentLink("docs/a.md", "https://example.com/x?y=1")).toMatchObject({
      kind: "remote", path: "", reason: "https://example.com/x?y=1",
    });
  });

  it("越界、元数据、绝对路径与危险协议一律拒绝", () => {
    for (const href of ["../../../etc/passwd", "/etc/passwd", "C:/Windows/win.ini", ".git/config", "sub/../.git/HEAD", "a\\b.md", "javascript:alert(1)", "file:///tmp/x.md", "data:text/html,x", ""]) {
      expect(resolveDocumentLink("docs/guide/start.md", href).kind, href).toBe("blocked");
    }
    // 编码后的分隔符与父目录分量仍会被拒绝：解码后再检查。
    expect(resolveDocumentLink("docs/a.md", "..%2F..%2Fout.md").kind).toBe("blocked");
    expect(resolveDocumentLink("docs/a.md", "%2E%2E/%2E%2E/out.md").kind).toBe("blocked");
    expect(resolveDocumentLink("docs/a.md", "sub%5Cfile.md").kind).toBe("blocked");
    expect(resolveDocumentLink("docs/a.md", "#%E0%A4%A").kind).toBe("blocked");
  });

  it("规范化路径不保留 ./ 与空段，但不允许跳出仓库根目录", () => {
    expect(resolveDocumentPath("docs/a.md", "./b/./c.md")).toBe("docs/b/c.md");
    expect(resolveDocumentPath("docs/a.md", "b/../c.md")).toBe("docs/c.md");
    expect(resolveDocumentPath("docs/a.md", "../a.md")).toBe("a.md");
    expect(resolveDocumentPath("docs/a.md", "../../a.md")).toBeNull();
  });
});

describe("阅读会话", () => {
  it("按仓库、版本与路径分别保存模式、位置和锚点", () => {
    const session = createDocumentSession({ repository: () => "C:/repo" });
    session.remember({ revision: "worktree", path: "README.md" }, { mode: "source", source: { line: 12, top: 220 }, version: "v1" });
    session.remember({ revision: "index", path: "README.md" }, { mode: "preview", preview: { top: 40, anchor: "安装" }, version: "v2" });

    expect(session.recall({ revision: "worktree", path: "README.md" }, "v1")?.reading).toMatchObject({
      mode: "source", source: { line: 12, top: 220 }, version: "v1",
    });
    expect(session.recall({ revision: "index", path: "README.md" }, "v2")?.reading.preview).toEqual({ top: 40, anchor: "安装" });
    // 另一个版本、另一个仓库、另一条路径都不是同一个身份。
    expect(session.recall({ revision: "HEAD", path: "README.md" })).toBeNull();
    expect(session.recall({ revision: "worktree", path: "docs/README.md" })).toBeNull();
    const other = createDocumentSession({ repository: () => "C:/other" });
    expect(other.recall({ revision: "worktree", path: "README.md" })).toBeNull();
  });

  it("合并写入只更新给了的字段，版本变化会被标出来", () => {
    const session = createDocumentSession({ repository: () => "C:/repo" });
    const source = { revision: "HEAD", path: "guide.md" };
    session.remember(source, { mode: "preview", preview: { top: 120, anchor: "标题" }, version: "abc" });
    session.remember(source, { mode: "source" });
    const kept = session.recall(source, "abc")!;
    expect(kept.reading.mode).toBe("source");
    expect(kept.reading.preview).toEqual({ top: 120, anchor: "标题" });
    expect(kept.moved).toBe(false);
    expect(session.recall(source, "def")?.moved).toBe(true);
  });

  it("标题为同一身份时不重复占位，缓存有界且可清空", () => {
    const session = createDocumentSession({ repository: () => "C:/repo", limit: 3 });
    for (let index = 0; index < 5; index += 1) {
      session.remember({ revision: "worktree", path: `f${index}.md` }, { mode: "source" });
    }
    expect(session.size).toBe(3);
    expect(session.recall({ revision: "worktree", path: "f0.md" })).toBeNull();
    expect(session.recall({ revision: "worktree", path: "f4.md" })).not.toBeNull();
    expect(DOCUMENT_SESSION_LIMIT).toBeGreaterThan(3);
    session.remember({ revision: "worktree", path: "f4.md" }, { source: { line: 3, top: 40 } });
    expect(session.size).toBe(3);
    session.clear();
    expect(session.size).toBe(0);
  });

  it("会话身份包含仓库与版本：同一个路径在不同来源里互不覆盖", () => {
    expect(documentSessionKey("C:/a", { revision: "worktree", path: "x.md" }))
      .not.toBe(documentSessionKey("C:/b", { revision: "worktree", path: "x.md" }));
    expect(documentSessionKey("C:/a", { revision: "worktree", path: "x.md" }))
      .not.toBe(documentSessionKey("C:/a", { revision: "index", path: "x.md" }));
  });
});

describe("打开模式与位置夹取", () => {
  it("显式行定位进入源码，其余沿用上次模式，没有记录时默认预览", () => {
    expect(initialDocumentMode(42, null)).toBe("source");
    expect(initialDocumentMode(null, null)).toBe("preview");
    expect(initialDocumentMode(null, { mode: "source", source: { line: 1, top: 0 }, preview: { top: 0, anchor: null }, version: null })).toBe("source");
    expect(initialDocumentMode(0, null)).toBe("preview");
    expect(initialDocumentMode(12, { mode: "preview", source: { line: 1, top: 0 }, preview: { top: 0, anchor: null }, version: null })).toBe("source");
  });

  it("保存的行号按当前页夹到有效范围", () => {
    expect(clampSourceLine(12, 1, 100)).toBe(12);
    expect(clampSourceLine(120, 1, 100)).toBe(100);
    // 行号小于 1 不是可恢复的位置：调用方按「从头显示」处理。
    expect(clampSourceLine(0, 1, 100)).toBeNull();
    expect(clampSourceLine(5, 101, 20)).toBe(101);
    expect(clampSourceLine(5, 1, 0)).toBeNull();
    expect(clampSourceLine(Number.NaN, 1, 10)).toBeNull();
  });
});
