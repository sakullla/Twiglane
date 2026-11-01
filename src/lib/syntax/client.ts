/**
 * 语法高亮客户端：把「这一段代码按某语言分词」的请求交给 worker，逐块回调结果。
 *
 * - 有 Worker 时在后台线程分词；没有（测试环境、极端运行时）时在主线程分块分词并让出事件循环。
 * - 同语言同内容的结果走 LRU 缓存：来回切换文件、展开折叠、滚动重建行都不重复分词。
 * - 每个请求可取消：切走文件时旧请求立即停止，不和新结果抢渲染。
 */

import type { SyntaxLine } from "./engine";

export type { SyntaxLine, SyntaxToken } from "./engine";

/** 单次请求的行数上限：超过时只高亮前这么多行，其余按纯文本显示。 */
export const MAX_HIGHLIGHT_LINES = 60_000;

type Listener = (start: number, tokens: SyntaxLine[]) => void;

interface Pending {
  key: string;
  lines: SyntaxLine[];
  listeners: Set<{ onChunk: Listener; onDone: (ok: boolean) => void }>;
}

const CACHE_LIMIT = 48;
const cache = new Map<string, SyntaxLine[]>();
const inflight = new Map<string, { id: number; pending: Pending }>();
const byId = new Map<number, Pending>();
let worker: Worker | null | undefined;
let nextId = 1;

function cacheKey(lang: string, lines: string[]): string {
  // 内容本身作键：同一份文本重复请求时直接命中；长文本用长度 + 抽样，避免巨型键。
  const joined = lines.join("\n");
  if (joined.length <= 4096) return `${lang}\u0000${joined}`;
  let hash = 2166136261;
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${lang}\u0000${joined.length}\u0000${(hash >>> 0).toString(36)}`;
}

function remember(key: string, lines: SyntaxLine[]) {
  cache.delete(key);
  cache.set(key, lines);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined" || typeof window === "undefined") {
    worker = null;
    return worker;
  }
  try {
    worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number; start?: number; tokens?: SyntaxLine[]; done?: boolean; ok?: boolean }>) => {
      const data = event.data;
      const pending = byId.get(data.id);
      if (!pending) return;
      if (data.tokens && data.start !== undefined) deliver(pending, data.start, data.tokens);
      if (data.done) finish(data.id, pending, data.ok === true);
    };
    worker.onerror = () => {
      // worker 起不来（例如被宿主策略拦下）：退回主线程，进行中的请求按失败结束。
      for (const [id, pending] of byId) finish(id, pending, false);
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

function deliver(pending: Pending, start: number, tokens: SyntaxLine[]) {
  for (let index = 0; index < tokens.length; index += 1) pending.lines[start + index] = tokens[index];
  for (const listener of pending.listeners) listener.onChunk(start, tokens);
}

function finish(id: number, pending: Pending, ok: boolean) {
  byId.delete(id);
  inflight.delete(pending.key);
  if (ok) remember(pending.key, pending.lines);
  for (const listener of pending.listeners) listener.onDone(ok);
}

async function runInThread(id: number, lang: string, lines: string[], pending: Pending) {
  const { tokenizeInChunks } = await import("./engine");
  const ok = await tokenizeInChunks(lang, lines, (start, tokens) => deliver(pending, start, tokens), {
    chunkLines: 200,
    cancelled: () => !byId.has(id),
    yieldBetween: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }).catch(() => false);
  if (byId.has(id)) finish(id, pending, ok);
}

/**
 * 请求分词。命中缓存时同步回调一次整段结果。返回取消函数：取消后不再回调；
 * 同一内容的其他订阅者不受影响，全部取消时才真正停止分词。
 */
export function highlightLines(
  lang: string,
  lines: string[],
  onChunk: Listener,
  onDone: (ok: boolean) => void = () => {},
): () => void {
  const input = lines.length > MAX_HIGHLIGHT_LINES ? lines.slice(0, MAX_HIGHLIGHT_LINES) : lines;
  if (input.length === 0) {
    onDone(true);
    return () => {};
  }
  const key = cacheKey(lang, input);
  const hit = cache.get(key);
  if (hit) {
    remember(key, hit);
    onChunk(0, hit);
    onDone(true);
    return () => {};
  }
  const listener = { onChunk, onDone };
  let entry = inflight.get(key);
  if (entry) {
    // 已在分词：先补发已完成的部分，再订阅后续块。
    const done = entry.pending.lines;
    let start = 0;
    while (start < done.length) {
      if (!done[start]) {
        start += 1;
        continue;
      }
      let end = start;
      while (end < done.length && done[end]) end += 1;
      onChunk(start, done.slice(start, end));
      start = end;
    }
    entry.pending.listeners.add(listener);
  } else {
    const id = nextId++;
    const pending: Pending = { key, lines: [], listeners: new Set([listener]) };
    entry = { id, pending };
    inflight.set(key, entry);
    byId.set(id, pending);
    const target = getWorker();
    if (target) target.postMessage({ id, lang, lines: input });
    else void runInThread(id, lang, input, pending);
  }
  const current = entry;
  return () => {
    current.pending.listeners.delete(listener);
    if (current.pending.listeners.size === 0 && byId.has(current.id)) {
      byId.delete(current.id);
      inflight.delete(current.pending.key);
      worker?.postMessage({ cancel: current.id });
    }
  };
}

/** 测试用：清空缓存与进行中的请求。 */
export function resetHighlightCache(): void {
  cache.clear();
  inflight.clear();
  byId.clear();
}
