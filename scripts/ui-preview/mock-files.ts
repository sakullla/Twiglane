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
    // 可读目录里的非常规条目：文件树的右键菜单对它们只灰显并写明原因。
    entry("docs", "link", "symlink", { size: 0 }),
    entry("docs", "socket", "special", { size: 0 }),
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
  "README.md": [
    "# Twiglane",
    "",
    "只读文件视图的预览数据。**这一段**用来检查排版、目录与链接。",
    "",
    "## 目录与版本",
    "",
    "- 目录按需读取",
    "- 资源文件不自动下载",
    "- 链接与图片跟随同一版本",
    "",
    "### 中文重复标题",
    "",
    "### 中文重复标题",
    "",
    "| 元素 | 状态 |",
    "| --- | --- |",
    "| 表格 | 独立横向滚动 |",
    "| 任务列表 | 只读 |",
    "",
    "- [x] 预览默认打开",
    "- [ ] 保存位置",
    "",
    "> 引用：历史版本里的链接不能静默替换成当前工作区内容。",
    "",
    "[快速开始](docs/guide/getting-started.md) · [缺失链接](docs/missing.md) · [外部网页](https://example.com)",
    "",
    "![本地图片](assets/logo.png)",
    "",
    "![远程图片](https://example.com/remote.png)",
    "",
    "```ts",
    "export function openPanel(id: string): Panel {",
    "  return { id, title: id };",
    "}",
    "```",
    "",
  ].join("\n"),
  "docs/README.md": ["# 文档", "", "这里是 docs 下的说明文件。", "", "[回到根目录](../README.md)", ""].join("\n"),
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

/** mock 里算作「有未提交改动」的路径：changed-only 搜索与仅改动树都以它为准。 */
export const MOCK_CHANGED = ["src/app.ts", "README.md", "src/lib/legacy/old-panel.ts"];

function markChanged(relative: string): void {
  if (!MOCK_CHANGED.includes(relative)) MOCK_CHANGED.push(relative);
}

function unmarkChanged(relative: string): void {
  for (let index = MOCK_CHANGED.length - 1; index >= 0; index -= 1) {
    const path = MOCK_CHANGED[index];
    if (path === relative || path.startsWith(relative + "/")) MOCK_CHANGED.splice(index, 1);
  }
}

export function mockContentSearch(
  query: string,
  scope: { kind?: string; path?: string } | undefined,
  limit: number | undefined,
  generation: number,
) {
  const needle = query.trim();
  const cap = Math.max(1, Math.min(limit ?? 200, 200));
  const all = Object.keys(FILES);
  const paths =
    scope?.kind === "file" && scope.path
      ? [scope.path]
      : scope?.kind === "directory"
        ? all.filter((path) => (scope.path ? path.startsWith(scope.path + "/") || path === scope.path : true))
        : scope?.kind === "changed"
          ? all.filter((path) => MOCK_CHANGED.includes(path))
          : all;
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

/** 预览用的最小 PNG：远程/本地资源占位都返回它，界面仍走同样的类型校验。 */
const PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg"];

/**
 * 版本明确的文档正文：document 模式返回未拆分的完整 UTF-8 正文，
 * source 模式按页返回源码，与原生接口的两条路径一一对应。
 */
export function mockDocument(
  source: { revision: string; path: string },
  mode: "document" | "source",
  offset: number,
  limit: number | undefined,
  generation: number,
) {
  const base = {
    generation,
    source: { ...source, repository: "C:/Users/dev/project/twiglane" },
    size: 0,
    // 与原生 RepositoryDocument 字段一致：document 模式也带空的 lines 与 version，
    // 调用方（例如暂存区版本的改写）可以直接读 lines.length。
    version: null as string | null,
    text: null as string | null,
    complete: false,
    offset,
    lines: [] as string[],
    nextOffset: offset,
    hasMore: false,
    truncated: false,
    message: null as string | null,
  };
  const text = FILES[source.path];
  if (text === undefined) {
    return { ...base, kind: "missing", message: "该版本中没有这个文件。" };
  }
  if (RESOURCES.has(source.path)) {
    return { ...base, kind: "resource", size: 21870, message: "此文件使用只读资源预览。" };
  }
  if (mode === "source") {
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
      complete: offset === 0 && offset + lines.length >= all.length,
    };
  }
  return { ...base, kind: "text", size: text.length, text, complete: true };
}

/** 文档内图片资源：只按图片扩展名与已知资源返回图片，其余如实说明缺失。 */
export function mockDocumentResource(source: { revision: string; path: string }, generation: number) {
  const lower = source.path.toLowerCase();
  const resource = RESOURCES.has(source.path) || IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
  if (!resource) {
    return { generation, kind: "missing", size: null, dataUrl: null, entries: [], truncated: false, message: "该版本中没有这个资源。", lfsOid: null, canDownload: false };
  }
  return { generation, kind: "image", size: 68, dataUrl: PIXEL_PNG, entries: [], truncated: false, message: "", lfsOid: null, canDownload: false };
}


/**
 * 轻量编辑的 mock：完整快照与保存都按内存里的 FILES 计算，保存会改写这份内存数据。
 * 摘要只是可比较的指纹（不是真实 SHA-256），用来演示「基线没变才写入」。
 * 只用于浏览器预览，不代表真实文件写入、原子替换或 Git 行为。
 */
function mockDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(8);
}

export function mockEditSnapshot(relative: string, generation: number, mode: string | null) {
  const base = { generation, path: relative, bom: false, finalNewline: false, message: "" };
  const text = FILES[relative];
  if (text === undefined) {
    const state = RESOURCES.has(relative) ? "resource" : relative === "assets/blob.bin" ? "binary" : "missing";
    const message = state === "resource" ? "资源文件保持只读预览。" : state === "binary" ? "二进制内容不能作为文本编辑。" : "文件不存在。";
    return { ...base, state, editable: false, size: 0, digest: null, text: null, lineEnding: "none", message };
  }
  if (mode === "mixed") {
    return {
      ...base,
      state: "mixedLineEndings",
      editable: false,
      size: text.length,
      digest: mockDigest(text),
      text: null,
      lineEnding: "mixed",
      message: "文件混用 LF 与 CRLF 行尾，保持只读，避免保存时整份改写行尾。",
    };
  }
  return {
    ...base,
    state: "editable",
    editable: true,
    size: text.length,
    digest: mockDigest(text),
    text,
    lineEnding: text.includes("\n") ? "lf" : "none",
    finalNewline: text.endsWith("\n"),
  };
}

export function mockEditSave(relative: string, expectedDigest: string, content: string, generation: number, mode: string | null) {
  const current = FILES[relative];
  if (current === undefined || mode === "mixed") {
    return { error: { code: "edit_conflict", message: "文件已不再处于可编辑状态，保存未写入，未覆盖外部内容。" } };
  }
  if (mode === "fail") {
    return { error: { code: "edit_write_failed", message: "文件是只读的，保存未写入任何内容。" } };
  }
  if (mode === "conflict" || mockDigest(current) !== expectedDigest) {
    return { error: { code: "edit_conflict", message: "文件在编辑期间已被外部修改，保存未写入，未覆盖外部内容。" } };
  }
  FILES[relative] = content;
  return { snapshot: mockEditSnapshot(relative, generation, null) };
}

/**
 * 文件操作（新建、复制、移动、删除）的 mock：只改写上面这份内存里的目录与文件内容，
 * 用来预览界面接线与失败分支。它不是真实磁盘写入，也不是系统回收站：
 * 删除只是把条目从 mock 内存里移走，浏览器刷新后一切都回到初始数据。
 * ?entry=duplicate / special / trash 让对应失败分支可复现；stale 由 mock-api 在代次层面处理。
 */
export type MockEntryMode = "duplicate" | "special" | "trash" | "stale" | null;

type MockEntryResult = { path: string } | { error: { code: string; message: string } };

function parentOf(relative: string): string {
  const at = relative.lastIndexOf("/");
  return at < 0 ? "" : relative.slice(0, at);
}

function nameOf(relative: string): string {
  const at = relative.lastIndexOf("/");
  return at < 0 ? relative : relative.slice(at + 1);
}

function findEntry(relative: string): MockEntry | undefined {
  return (DIRECTORIES[parentOf(relative)] ?? []).find((item) => item.path === relative);
}

function pathExists(relative: string): boolean {
  return relative === "" || findEntry(relative) !== undefined;
}

function removeEntry(relative: string): MockEntry | undefined {
  const list = DIRECTORIES[parentOf(relative)];
  if (!list) return undefined;
  const at = list.findIndex((item) => item.path === relative);
  return at < 0 ? undefined : list.splice(at, 1)[0];
}

/** 一个路径连同它的目录后代：复制、移动与删除都按整棵子树处理。 */
function subtreePaths(relative: string): string[] {
  const paths = [relative];
  for (const [dir, items] of Object.entries(DIRECTORIES)) {
    if (dir === relative || dir.startsWith(relative + "/")) {
      paths.push(dir);
      for (const item of items) paths.push(item.path);
    }
  }
  return paths;
}

function cloneSubtree(source: string, target: string): void {
  for (const path of subtreePaths(source)) {
    const original = findEntry(path);
    const next = target + path.slice(source.length);
    const parent = parentOf(next);
    if (!DIRECTORIES[parent]) DIRECTORIES[parent] = [];
    DIRECTORIES[parent].push({
      name: nameOf(next),
      path: next,
      kind: original?.kind ?? "directory",
      ...(original?.ignored ? { ignored: true } : {}),
      ...(original?.size === undefined ? {} : { size: original.size }),
    });
    if (!DIRECTORIES[next]) DIRECTORIES[next] = [];
  }
  for (const path of Object.keys(FILES)) {
    if (path === source || path.startsWith(source + "/")) FILES[target + path.slice(source.length)] = FILES[path];
  }
}

function dropSubtree(relative: string): void {
  for (const path of subtreePaths(relative)) {
    if (path !== relative) delete DIRECTORIES[path];
  }
  for (const path of Object.keys(FILES)) {
    if (path === relative || path.startsWith(relative + "/")) delete FILES[path];
  }
  removeEntry(relative);
  unmarkChanged(relative);
}

function failure(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function mockCreateEntry(relative: string, kind: "file" | "directory", mode: MockEntryMode): MockEntryResult {
  const target = relative.trim();
  if (!target) return failure("entry_invalid", "请填写名称，没有写入任何内容。");
  if (mode === "special") return failure("unsupported_entry", "符号链接与特殊文件不参与文件操作，没有写入任何内容。");
  if (mode === "duplicate" || pathExists(target)) {
    return failure("entry_exists", `目标已存在：${target}，没有写入任何内容。请换一个名称。`);
  }
  const parent = parentOf(target);
  if (!pathExists(parent)) return failure("entry_missing", `父目录不存在：${parent}，没有写入任何内容。`);
  if (!DIRECTORIES[parent]) DIRECTORIES[parent] = [];
  DIRECTORIES[parent].push({ name: nameOf(target), path: target, kind, ...(kind === "file" ? { size: 0 } : {}) });
  if (kind === "directory") {
    DIRECTORIES[target] = DIRECTORIES[target] ?? [];
  } else {
    FILES[target] = FILES[target] ?? "";
    markChanged(target);
  }
  return { path: target };
}

export function mockCopyEntry(source: string, relative: string, mode: MockEntryMode): MockEntryResult {
  const target = relative.trim();
  if (mode === "special") return failure("unsupported_entry", "符号链接与特殊文件不参与文件操作，没有写入任何内容。");
  if (!target) return failure("entry_invalid", "请填写目标路径，没有写入任何内容。");
  if (!pathExists(source)) return failure("entry_missing", `源路径不存在：${source}，没有复制任何内容。`);
  if (mode === "duplicate" || pathExists(target)) {
    return failure("entry_exists", `目标已存在：${target}，没有复制任何内容。请换一个路径。`);
  }
  if (target === source || target.startsWith(source + "/")) {
    return failure("entry_invalid", "不能把目录复制到它自己或它的子目录里。");
  }
  const parent = parentOf(target);
  if (!pathExists(parent)) return failure("entry_missing", `父目录不存在：${parent}，没有复制任何内容。`);
  cloneSubtree(source, target);
  for (const path of subtreePaths(target)) {
    if (FILES[path] !== undefined) markChanged(path);
  }
  return { path: target };
}

export function mockMoveEntry(source: string, relative: string, mode: MockEntryMode): MockEntryResult {
  const target = relative.trim();
  if (mode === "special") return failure("unsupported_entry", "符号链接与特殊文件不参与文件操作，没有写入任何内容。");
  if (!target) return failure("entry_invalid", "请填写目标路径，没有写入任何内容。");
  if (!pathExists(source)) return failure("entry_missing", `源路径不存在：${source}，没有移动任何内容。`);
  if (mode === "duplicate" || pathExists(target)) {
    return failure("entry_exists", `目标已存在：${target}，没有移动任何内容。请换一个路径。`);
  }
  if (target === source) return failure("entry_invalid", "移动目标不能与源路径相同。");
  if (target.startsWith(source + "/")) return failure("entry_invalid", "不能把目录移动到它自己或它的子目录里。");
  const parent = parentOf(target);
  if (!pathExists(parent)) return failure("entry_missing", `父目录不存在：${parent}，没有移动任何内容。`);
  cloneSubtree(source, target);
  for (const path of subtreePaths(target)) {
    if (FILES[path] !== undefined) markChanged(path);
  }
  dropSubtree(source);
  return { path: target };
}

export function mockDeleteEntry(relative: string, mode: MockEntryMode): MockEntryResult {
  if (mode === "trash") {
    return failure("trash_unavailable", `无法把 ${relative} 移入系统回收站：系统回收站不可用，文件仍在原处。`);
  }
  if (mode === "special") return failure("unsupported_entry", "符号链接与特殊文件不参与文件操作，没有写入任何内容。");
  if (!relative) return failure("entry_invalid", "根目录不能删除。");
  if (!pathExists(relative)) return failure("entry_missing", `目标不存在：${relative}，没有删除任何内容。`);
  dropSubtree(relative);
  return { path: relative };
}

/** 逐行追溯的 mock：按固定节奏把行分给几个提交，最后一段算作「尚未提交」。只用于看界面。 */
export function mockFileBlame(relative: string, generation: number) {
  const text = FILES[relative];
  if (text === undefined) return null;
  const total = text.split("\n").length;
  const day = 86_400;
  const now = Math.floor(Date.now() / 1000);
  const commits = [
    { oid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", author: "林晓", authorTime: now - 400 * day, summary: "feat: 初始化文件视图", uncommitted: false, boundary: false, previousPath: null },
    { oid: "b2c3d4e5f60718293a4b5c6d7e8f901234567890", author: "Chen Wei", authorTime: now - 40 * day, summary: "fix: 修复目录树展开后滚动位置丢失", uncommitted: false, boundary: false, previousPath: null },
    { oid: "c3d4e5f60718293a4b5c6d7e8f90123456789012", author: "王一", authorTime: now - 3 * day, summary: "refactor: 抽出读取逻辑", uncommitted: false, boundary: false, previousPath: null },
    { oid: "0".repeat(40), author: "尚未提交", authorTime: 0, summary: "工作区里还没有提交的修改", uncommitted: true, boundary: false, previousPath: null },
  ];
  const pattern = [0, 0, 1, 2, 2, 0, 3];
  const ranges: { start: number; count: number; commit: number; origStart: number }[] = [];
  let line = 1;
  let step = 0;
  while (line <= total) {
    const count = Math.min(total - line + 1, 2 + (step % 4));
    ranges.push({ start: line, count, commit: pattern[step % pattern.length], origStart: line });
    line += count;
    step += 1;
  }
  return { generation, path: relative, lines: total, commits, ranges };
}
