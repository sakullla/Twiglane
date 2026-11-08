import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const componentsDir = path.join(root, "src/lib/components");
const sources = [
  ...readdirSync(componentsDir)
    .filter((name) => name.endsWith(".svelte"))
    .map((name) => path.join(componentsDir, name)),
  path.join(root, "src/App.svelte"),
].map((file) => ({ name: path.basename(file), text: readFileSync(file, "utf8") }));

/** 从 start 起找到标签结束的 >：跳过 {} 表达式和引号里的 >。 */
function tagEnd(text: string, start: number): number {
  let depth = 0;
  let quote = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) quote = char !== '"';
    else if (depth > 0) depth += char === "{" ? 1 : char === "}" ? -1 : 0;
    else if (char === "{") depth += 1;
    else if (char === '"') quote = true;
    else if (char === ">") return index;
  }
  throw new Error("标签未闭合");
}

describe("README 与实现一致", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");

  it("超时和关闭窗口的进程局限写清范围", () => {
    expect(readme).toContain("超时或关闭窗口只结束 git 进程本身，传输子进程可能短暂残留");
    expect(readme).not.toContain("超时只结束 `git ls-remote` 本身");
  });
});

describe("组件源码约束", () => {
  it("每个可禁用的控件都写明不可用的原因（R12）", () => {
    const missing: string[] = [];
    for (const { name, text } of sources) {
      for (const match of text.matchAll(/<(button|input|select|textarea)\b/g)) {
        const tag = text.slice(match.index, tagEnd(text, match.index) + 1);
        if (!/(?<![-\w])disabled=|\{disabled\}/.test(tag) || /(?<![-\w])title=/.test(tag)) continue;
        missing.push(`${name}:${text.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("共用组件把关键原因和状态接入可访问语义", () => {
    const menu = sources.find(({ name }) => name === "ContextMenu.svelte")!.text;
    const modal = sources.find(({ name }) => name === "Modal.svelte")!.text;
    const status = sources.find(({ name }) => name === "StatusBar.svelte")!.text;
    expect(menu).toContain("aria-describedby={entry.disabledReason");
    expect(menu).toContain("context-reason-");
    expect(menu, "快捷键提示不能只有视觉一层").toContain("aria-keyshortcuts={entry.shortcut");
    expect(modal).toContain("aria-describedby={description");
    // 只有忙碌是实时状态；警告再播一遍会和已有的 toast 重复。
    expect(status.match(/role="status" aria-live="polite"/g)).toHaveLength(1);
    expect(status, "刷新原因要能被不可聚焦的按钮问到").toContain("aria-describedby=\"statusbar-refresh-reason\"");
    expect(status).toContain('id="statusbar-refresh-reason"');
  });

  /**
   * 目录树筛选、按路径打开、全仓库全文搜索、文件内查找是四种范围（R2）。
   * 判据不是「有四个输入框」，而是每个输入自己写明作用范围，且四处互不相同。
   */
  it("四处查找各自标明范围，不靠上下文猜是哪种搜索", () => {
    const sourceOf = (name: string) => sources.find((source) => source.name === name)!.text;
    const tree = sourceOf("FileTree.svelte");
    const search = sourceOf("FileSearch.svelte");
    const content = sourceOf("FileContent.svelte");

    expect(tree, "目录树筛选").toContain('data-search-scope="tree"');
    expect(tree).toMatch(/不读文件内容/);
    expect(search, "按路径打开").toContain('data-search-scope="path"');
    expect(search).toMatch(/只查路径/);
    expect(search, "全仓库全文搜索").toContain('data-search-scope="content"');
    expect(search).toMatch(/工作区文本/);
    expect(content, "文件内查找").toContain('data-search-scope="file"');
    expect(content).toMatch(/只在这个文件的当前内容里查找/);

    const markers = [...`${tree}${search}${content}`.matchAll(/data-search-scope="(\w+)"/g)].map((match) => match[1]);
    // 四种范围四个键：一个输入框不能兼任两种搜索。
    expect(new Set(markers).size).toBeGreaterThanOrEqual(4);
  });

  /**
   * Svelte 销毁 {#if}/{#each} 分支时从分支首节点沿 nextSibling 走到末节点，
   * 首尾节点被 portal 搬走后遍历中断，分支里其余节点残留在页面上。
   */
  it("use:portal 不用在控制块分支的首尾节点上", () => {
    const opensBranch = /^\s*\{(#if|:else|#each|#key)\b/;
    const closesBranch = /^\s*\{(:else|\/if|\/each|\/key)\b/;
    const offenders: string[] = [];
    for (const { name, text } of sources) {
      const lines = text
        .replace(/<!--[\s\S]*?-->/g, "")
        .split("\n")
        .filter((line) => line.trim() !== "");
      lines.forEach((line, index) => {
        if (!line.includes("use:portal")) return;
        if (opensBranch.test(lines[index - 1] ?? "")) offenders.push(`${name} 分支首节点：${line.trim()}`);
        const indent = line.match(/^\s*/)![0];
        const closeAt = lines.findIndex((next, at) => at > index && next.startsWith(`${indent}</`));
        if (closesBranch.test(lines[closeAt + 1] ?? "")) offenders.push(`${name} 分支尾节点：${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
