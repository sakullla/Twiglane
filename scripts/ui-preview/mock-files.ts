// 只读文件视图的预览数据：多层目录、忽略项、空目录、多语言、资源、错误与长文件。
// 仅用于 npm run preview:ui 的浏览器 mock，不代表真实 Git 或桌面行为。

type MockEntryKind = "file" | "directory" | "symlink" | "special" | "nestedRepository";

interface MockEntry {
  name: string;
  path: string;
  kind: MockEntryKind;
  ignored?: boolean;
  size?: number;
  error?: string;
}

function entry(dir: string, name: string, kind: MockEntryKind, extra: Partial<MockEntry> = {}): MockEntry {
  return { name, path: dir ? dir + "/" + name : name, kind, ...extra };
}

const DIRECTORIES: Record<string, MockEntry[]> = {
  "": [
    entry("", "src", "directory"),
    entry("", "docs", "directory"),
    entry("", "assets", "directory"),
    entry("", "empty", "directory"),
    entry("", "broken", "directory"),
    entry("", "node_modules", "directory", { ignored: true }),
    entry("", "README.md", "file", { size: 1284 }),
    entry("", "logo.png", "file", { size: 21870 }),
    entry("", "debug.log", "file", { ignored: true, size: 8192 }),
  ],
  src: [
    entry("src", "components", "directory"),
    entry("src", "utils", "directory"),
    entry("src", "app.ts", "file", { size: 4096 }),
    entry("src", "main.js", "file", { size: 2048 }),
    entry("src", "view.vue", "file", { size: 3200 }),
    entry("src", "App.svelte", "file", { size: 5120 }),
    entry("src", "Main.java", "file", { size: 3800 }),
    entry("src", "main.go", "file", { size: 2600 }),
    entry("src", "main.dart", "file", { size: 3100 }),
  ],
  "src/components": [
    entry("src/components", "Button.svelte", "file", { size: 2240 }),
    entry("src/components", "long.ts", "file", { size: 208000 }),
  ],
  "src/utils": [
    entry("src/utils", "format.ts", "file", { size: 1600 }),
    entry("src/utils", "util.rs", "file", { size: 2900 }),
  ],
  docs: [
    entry("docs", "guide", "directory"),
    entry("docs", "README.md", "file", { size: 900 }),
    entry("docs", "notes.txt", "file", { ignored: true, size: 120 }),
  ],
  "docs/guide": [
    entry("docs/guide", "getting-started.md", "file", { size: 2200 }),
    entry("docs/guide", "config.yaml", "file", { size: 640 }),
  ],
  assets: [
    entry("assets", "logo.png", "file", { size: 21870 }),
    entry("assets", "bundle.zip", "file", { size: 146752 }),
    entry("assets", "icon.svg", "file", { size: 780 }),
    entry("assets", "blob.bin", "file", { size: 4096 }),
    entry("assets", "permission.txt", "file", { size: 12, error: "无法读取：权限不足。" }),
  ],
  empty: [],
  broken: [
    entry("broken", "link", "symlink", { size: 0 }),
    entry("broken", "socket", "special", { size: 0 }),
    entry("broken", "vendor", "nestedRepository"),
    entry("broken", "permission.txt", "file", { size: 0 }),
  ],
  node_modules: [entry("node_modules", "dep", "directory"), entry("node_modules", "index.js", "file", { size: 100 })],
  "broken/vendor": [entry("broken/vendor", "inner.ts", "file", { size: 10 })],
};

const LONG_LINES: string[] = [];
for (let index = 0; index < 5000; index += 1) {
  LONG_LINES.push("  const row" + index + " = compute(" + index + "); // 第 " + (index + 1) + " 行");
}

const FILES: Record<string, string> = {
  "README.md": ["# Twiglane", "", "只读文件视图的预览数据。", "", "- 目录按需读取", "- 资源文件不自动下载", ""].join("\n"),
  "docs/README.md": ["# 文档", "", "这里是 docs 下的说明文件。", ""].join("\n"),
  "docs/guide/getting-started.md": ["# 快速开始", "", "1. 打开仓库", "2. 切到文件视图", "3. 展开目录", ""].join("\n"),
  "docs/guide/config.yaml": ["name: twiglane", "files:", "  includeIgnored: false", "  pageLines: 500", ""].join("\n"),
  "docs/notes.txt": "这条笔记被忽略规则排除，打开「忽略」后才看得到。\n",
  "debug.log": "ignored log line\n",
  "src/app.ts": [
    'import { api } from "./api";',
    "",
    "export interface Panel {",
    "  id: string;",
    "  title: string;",
    "}",
    "",
    "/** 打开一个面板 */",
    "export function openPanel(id: string): Panel {",
    "  return { id, title: id };",
    "}",
    "",
  ].join("\n"),
  "src/main.js": ['import { openPanel } from "./app";', "", 'const panel = openPanel("files");', "console.log(panel.title);", ""].join("\n"),
  "src/view.vue": ['<script setup lang="ts">', 'const files = ["a.ts", "b.ts"];', "</script>", "", "<template>", "  <ul>", '    <li v-for="file in files" :key="file">{{ file }}</li>', "  </ul>", "</template>", ""].join("\n"),
  "src/App.svelte": ["<script lang=\"ts\">", "  let count = $state(0);", "</script>", "", "<button onclick={() => count += 1}>点击 {count} 次</button>", ""].join("\n"),
  "src/Main.java": ["package app;", "", "public final class Main {", "    public static void main(String[] args) {", '        System.out.println("hello");', "    }", "}", ""].join("\n"),
  "src/main.go": ["package main", "", 'import "fmt"', "", "func main() {", '\tfmt.Println("hello")', "}", ""].join("\n"),
  "src/main.dart": ["void main() {", '  final files = <String>["a.ts"];', "  print(files);", "}", ""].join("\n"),
  "src/components/Button.svelte": ["<script lang=\"ts\">", '  let { label = "按钮" } = $props();', "</script>", "", '<button type="button">{label}</button>', ""].join("\n"),
  "src/components/long.ts": LONG_LINES.join("\n"),
  "src/utils/format.ts": ["export function formatBytes(bytes: number): string {", '  return bytes + " B";', "}", ""].join("\n"),
  "src/utils/util.rs": ["pub fn util(value: usize) -> usize {", "    value + 1", "}", ""].join("\n"),
  "assets/icon.svg": ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">', '  <path d="M4 4h16v16H4z" fill="none" stroke="currentColor" />', "</svg>", ""].join("\n"),
};

const RESOURCES = new Set(["assets/logo.png", "logo.png", "assets/bundle.zip"]);

export interface MockDirectoryEntry {
  name: string;
  path: string;
  kind: MockEntryKind;
  ignored: boolean;
  size: number | null;
  error: string | null;
}

export function mockDirectory(relative: string, includeIgnored: boolean, generation: number) {
  const entries: MockDirectoryEntry[] = (DIRECTORIES[relative] ?? [])
    .filter((item) => includeIgnored || !item.ignored)
    .map((item) => ({
      name: item.name,
      path: item.path,
      kind: item.kind,
      ignored: Boolean(item.ignored),
      size: item.kind === "file" ? (item.size ?? 0) : null,
      error: item.error ?? null,
    }));
  return { generation, path: relative, entries, errors: [] as string[] };
}

export function mockFilePage(relative: string, offset: number, limit: number | undefined, generation: number) {
  const base = { generation, path: relative, offset, nextOffset: offset, hasMore: false, truncated: false };
  if (relative === "broken/socket") {
    return { ...base, kind: "special", size: 0, lines: [] as string[], message: "特殊文件不作为文本读取。" };
  }
  if (relative === "assets/blob.bin") {
    return { ...base, kind: "binary", size: 4096, lines: [] as string[], message: "二进制内容不作为文本读取。" };
  }
  if (RESOURCES.has(relative)) {
    return { ...base, kind: "resource", size: 21870, lines: [] as string[], message: "此文件使用只读资源预览。" };
  }
  const text = FILES[relative];
  if (text === undefined) {
    return { ...base, kind: "missing", size: 0, lines: [] as string[], message: "文件不存在。" };
  }
  const all = text.split("\n");
  const pageSize = Math.min(limit ?? 500, 1000);
  const lines = all.slice(offset, offset + pageSize);
  return {
    ...base,
    kind: "text",
    size: text.length,
    lines,
    nextOffset: offset + lines.length,
    hasMore: offset + lines.length < all.length,
    message: null,
  };
}

export function mockContentSearch(
  query: string,
  scope: { kind?: string; path?: string } | undefined,
  limit: number | undefined,
  generation: number,
) {
  const needle = query.trim();
  const cap = Math.max(1, Math.min(limit ?? 200, 200));
  const paths = scope?.kind === "file" && scope.path ? [scope.path] : Object.keys(FILES);
  const matches: { path: string; line: number; column: number; text: string }[] = [];
  let truncated = false;
  for (const path of paths) {
    const lines = (FILES[path] ?? "").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!needle) break;
      let from = 0;
      while (matches.length < cap) {
        const at = lines[index].indexOf(needle, from);
        if (at < 0) break;
        matches.push({ path, line: index + 1, column: at + 1, text: lines[index].trim().slice(0, 200) });
        from = at + needle.length;
      }
      if (matches.length >= cap) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  return {
    generation,
    query,
    scope: scope?.kind ?? "repository",
    scopePath: scope?.path ?? null,
    matches,
    filesScanned: paths.length,
    skipped: [] as { path: string; reason: string }[],
    skippedFiles: 0,
    truncated,
    textTruncated: false,
    message: truncated ? "结果达到上限，请缩小范围或改用更精确的查询。" : null,
  };
}

/** 路径搜索的 mock：只用于预览提示，T3 不接界面。 */
export function mockPathSearch(query: string, directory: string | null, includeIgnored: boolean, generation: number) {
  const needle = query.trim().toLowerCase();
  const entries: { path: string; kind: "file" | "directory"; ignored: boolean }[] = [];
  for (const [dir, items] of Object.entries(DIRECTORIES)) {
    if (dir && directory && dir !== directory && !dir.startsWith(directory + "/")) continue;
    for (const item of items) {
      if (item.ignored && !includeIgnored) continue;
      if (needle && !item.path.toLowerCase().includes(needle)) continue;
      entries.push({ path: item.path, kind: item.kind === "file" ? "file" : "directory", ignored: Boolean(item.ignored) });
    }
  }
  return { generation, query, directory, includeIgnored, scanned: entries.length, entries: entries.slice(0, 200), truncated: entries.length > 200, message: null };
}
