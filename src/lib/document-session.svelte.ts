/**
 * 阅读会话：按「仓库 + 版本 + 路径」保存阅读模式、源码位置、预览位置与锚点，
 * 并把 Markdown 里的相对链接解析成同版本目标。
 *
 * 这里不读文件、不写文件，也不持有 DOM：读取由 DocumentReader 负责，
 * 位置在会话内保存，切文件、后退/前进、关闭再打开都能按同一份身份恢复。
 * 缓存有界且只在内存里，切仓库不会把旧仓库的位置套到新仓库上。
 */
import { markdownLinkKind } from "./markdown/links";

export type DocumentMode = "preview" | "source";

/** 源码位置：行号用于恢复，top 保留精确滚动偏移。 */
export interface SourcePosition {
  line: number;
  top: number;
}

/** 预览位置：滚动偏移加最近的标题锚点。 */
export interface PreviewPosition {
  top: number;
  anchor: string | null;
}

export interface DocumentReading {
  mode: DocumentMode;
  source: SourcePosition;
  preview: PreviewPosition;
  /** 保存这份位置时读到的内容版本；与当前版本不同时只能夹到有效范围。 */
  version: string | null;
}

export interface DocumentRestore {
  reading: DocumentReading;
  /** 保存时的版本与当前版本不同：旧位置不代表现在的内容。 */
  moved: boolean;
}

export interface DocumentSourceKey {
  revision: string;
  path: string;
}

/** 阅读会话的默认上限：再多就不是「回来接着读」而是列表。 */
export const DOCUMENT_SESSION_LIMIT = 48;

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".rmd"];

/** 与原生 is_markdown 同一口径：只按扩展名判断，不把文档图标类别当成 Markdown。 */
export function isMarkdownPath(path: string): boolean {
  const value = path.trim().toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => value.endsWith(extension));
}

/** 会话身份的字符串形式：仓库不同、版本不同、路径不同都是不同条目。 */
export function documentSessionKey(repository: string | null, source: DocumentSourceKey): string {
  return JSON.stringify([repository ?? "", source.revision, source.path]);
}

export function emptyReading(): DocumentReading {
  return { mode: "preview", source: { line: 1, top: 0 }, preview: { top: 0, anchor: null }, version: null };
}

/**
 * 打开文档时的模式：显式行定位（搜索命中、跳到行）优先于任何已保存的位置，
 * 其余情况沿用上一次同身份的阅读模式，没有记录时默认预览。
 */
export function initialDocumentMode(
  line: number | null | undefined,
  stored: DocumentRestore | DocumentReading | null,
): DocumentMode {
  if (line !== null && line !== undefined && Number.isFinite(line) && line > 0) return "source";
  if (!stored) return "preview";
  return "reading" in stored ? stored.reading.mode : stored.mode;
}

/** 把保存的行号夹进当前内容的有效范围；返回 null 表示没有可恢复的行。 */
export function clampSourceLine(line: number, firstLine: number, lineCount: number): number | null {
  if (!Number.isFinite(line) || line < 1 || lineCount <= 0) return null;
  const first = Math.max(1, firstLine);
  return Math.min(Math.max(first, Math.trunc(line)), first + lineCount - 1);
}

export interface DocumentLinkTarget {
  /** anchor 是文内标题，local 是同版本仓库路径，remote 是外部网页，blocked 不可打开。 */
  kind: "anchor" | "local" | "remote" | "blocked";
  /** local 时是规范化后的仓库相对路径；其它情况为空串。 */
  path: string;
  /** 解码后的标题锚点或链接片段。 */
  anchor: string | null;
  /** remote 时是原地址，blocked 时是原因。 */
  reason: string;
}

function decodePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function forbiddenComponent(part: string): boolean {
  const trimmed = part.trimEnd().replace(/\.+$/, "");
  return trimmed.toLowerCase() === ".git";
}

/**
 * 规范化相对路径：相对当前文档所在目录解析 `./` 与 `../`，只允许留在仓库内。
 * 越界、`.git` 元数据、绝对路径、盘符与反斜杠一律拒绝，不做「尽量猜」。
 */
export function resolveDocumentPath(currentPath: string, raw: string): string | null {
  const decoded = decodePart(raw);
  if (decoded === null) return null;
  if (/[\\\u0000-\u001f\u007f:]/.test(decoded)) return null;
  if (decoded.startsWith("/")) return null;
  const segments = currentPath.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    if (forbiddenComponent(part)) return null;
    segments.push(part);
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}

/**
 * 文档里的链接按「当前文档目录 + 同一版本」解析。
 * 这里只做展示层判定；仓库内路径与版本授权由读取层再次校验。
 */
export function resolveDocumentLink(currentPath: string, href: string): DocumentLinkTarget {
  const kind = markdownLinkKind(href);
  const value = href.trim();
  if (kind === "anchor") {
    const anchor = decodePart(value.replace(/^#/, ""));
    return anchor === null || anchor === ""
      ? { kind: "blocked", path: "", anchor: null, reason: "这个标题锚点无法识别。" }
      : { kind: "anchor", path: currentPath, anchor, reason: "" };
  }
  if (kind === "remote") {
    return { kind: "remote", path: "", anchor: null, reason: value };
  }
  if (kind === "blocked") {
    return { kind: "blocked", path: "", anchor: null, reason: "这个链接地址不能打开。" };
  }
  const hashAt = value.indexOf("#");
  const fragment = hashAt >= 0 ? value.slice(hashAt + 1) : "";
  const withoutFragment = hashAt >= 0 ? value.slice(0, hashAt) : value;
  const queryAt = withoutFragment.indexOf("?");
  const pathPart = queryAt >= 0 ? withoutFragment.slice(0, queryAt) : withoutFragment;
  const anchor = fragment === "" ? null : decodePart(fragment);
  if (fragment !== "" && anchor === null) {
    return { kind: "blocked", path: "", anchor: null, reason: "这个标题锚点无法识别。" };
  }
  const path = resolveDocumentPath(currentPath, pathPart);
  if (!path) {
    return { kind: "blocked", path: "", anchor: null, reason: "这个链接指向仓库之外，无法打开。" };
  }
  return { kind: "local", path, anchor, reason: "" };
}

export interface DocumentSessionDeps {
  /** 当前仓库根目录；会话按它区分条目，切仓库后旧位置不会被套用。 */
  repository: () => string | null;
  limit?: number;
}

/**
 * 一个阅读会话。`remember` 合并同一身份的局部更新并按最近使用排序，
 * `recall` 返回保存的阅读状态与「是否换过版本」，由读取层决定夹到哪一行。
 */
export function createDocumentSession(deps: DocumentSessionDeps) {
  const limit = Math.max(1, deps.limit ?? DOCUMENT_SESSION_LIMIT);
  let entries = $state<Record<string, DocumentReading>>({});
  let order: string[] = [];

  function keyOf(source: DocumentSourceKey): string {
    return documentSessionKey(deps.repository(), source);
  }

  function recall(source: DocumentSourceKey, version: string | null = null): DocumentRestore | null {
    const entry = entries[keyOf(source)];
    if (!entry) return null;
    return { reading: entry, moved: entry.version !== null && version !== null && entry.version !== version };
  }

  /** 合并写入：只更新给了的字段，其余保持原值；版本为 null 时不覆盖已知版本。 */
  function remember(source: DocumentSourceKey, patch: Partial<DocumentReading>): void {
    const key = keyOf(source);
    const previous = entries[key] ?? emptyReading();
    const next: DocumentReading = {
      mode: patch.mode ?? previous.mode,
      source: patch.source ? { ...previous.source, ...patch.source } : previous.source,
      preview: patch.preview ? { ...previous.preview, ...patch.preview } : previous.preview,
      version: patch.version === undefined ? previous.version : patch.version ?? previous.version,
    };
    const rest = order.filter((item) => item !== key);
    rest.push(key);
    // 有界缓存：只保留最近用过的条目，旧位置不再无限增长。
    while (rest.length > limit) {
      const dropped = rest.shift();
      if (dropped !== undefined) {
        delete entries[dropped];
      }
    }
    order = rest;
    entries = { ...entries, [key]: next };
  }

  function forget(source: DocumentSourceKey): void {
    const key = keyOf(source);
    if (!(key in entries)) return;
    const next = { ...entries };
    delete next[key];
    entries = next;
    order = order.filter((item) => item !== key);
  }

  function clear(): void {
    entries = {};
    order = [];
  }

  return {
    get size() {
      return order.length;
    },
    /** 当前会话里保存的身份顺序（最旧的在前），仅用于诊断与测试。 */
    get keys(): readonly string[] {
      return order;
    },
    keyOf,
    recall,
    remember,
    forget,
    clear,
  };
}

export type DocumentSession = ReturnType<typeof createDocumentSession>;
