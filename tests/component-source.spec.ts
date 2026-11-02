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
