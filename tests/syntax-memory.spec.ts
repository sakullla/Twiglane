import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { highlightLines, HIGHLIGHT_CACHE_BYTES, HIGHLIGHT_WORKER_IDLE_MS, resetHighlightCache } from "../src/lib/syntax/client";

class HighlightWorker {
  static instances: HighlightWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { HighlightWorker.instances.push(this); }
  complete(index = this.postMessage.mock.calls.length - 1) {
    const { id, lines } = this.postMessage.mock.calls[index][0] as { id: number; lines: string[] };
    this.onmessage?.({ data: { id, start: 0, tokens: lines.map((t) => [{ t, k: "" }]) } } as MessageEvent);
    this.onmessage?.({ data: { id, done: true, ok: true } } as MessageEvent);
  }
}

beforeEach(() => {
  resetHighlightCache();
  HighlightWorker.instances = [];
  vi.stubGlobal("Worker", HighlightWorker);
  vi.useFakeTimers();
});

afterEach(() => {
  resetHighlightCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("高亮缓存内存与后台线程", () => {
  it("按内存预算淘汰最旧文档，而不等到 48 个大文档都驻留", () => {
    const documents = ["a", "b", "c"].map((prefix) => Array.from({ length: 5000 }, (_, i) => `${prefix}${i}`.padEnd(300, "x")));
    for (const document of documents) {
      highlightLines("typescript", document, () => {});
      HighlightWorker.instances[0].complete();
    }
    const worker = HighlightWorker.instances[0];
    const recent = vi.fn();
    highlightLines("typescript", documents[2], recent);
    expect(recent).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledTimes(3);
    highlightLines("typescript", documents[0], () => {});
    expect(worker.postMessage).toHaveBeenCalledTimes(4);
  });

  it("超过预算的单个文档仍会显示，但不会永久缓存", () => {
    const lines = ["x".repeat(HIGHLIGHT_CACHE_BYTES / 2 + 1)];
    const rendered = vi.fn();
    highlightLines("typescript", lines, rendered);
    const worker = HighlightWorker.instances[0];
    worker.complete();
    expect(rendered).toHaveBeenCalledOnce();
    highlightLines("typescript", lines, () => {});
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
  });

  it("缓存命中提升 LRU 顺序，常看的文档不会先被淘汰", () => {
    for (let i = 0; i < 48; i += 1) {
      highlightLines("typescript", [`document-${i}`], () => {});
      HighlightWorker.instances[0].complete();
    }
    const worker = HighlightWorker.instances[0];
    highlightLines("typescript", ["document-0"], () => {});
    highlightLines("typescript", ["new-document"], () => {});
    worker.complete();
    highlightLines("typescript", ["document-0"], () => {});
    expect(worker.postMessage).toHaveBeenCalledTimes(49);
    highlightLines("typescript", ["document-1"], () => {});
    expect(worker.postMessage).toHaveBeenCalledTimes(50);
  });

  it("空闲后释放 Worker，缓存仍可命中，新文档重新创建线程", () => {
    highlightLines("typescript", ["cached"], () => {});
    const worker = HighlightWorker.instances[0];
    worker.complete();
    vi.advanceTimersByTime(HIGHLIGHT_WORKER_IDLE_MS);
    expect(worker.terminate).toHaveBeenCalledOnce();
    const cached = vi.fn();
    highlightLines("typescript", ["cached"], cached);
    expect(cached).toHaveBeenCalledOnce();
    expect(HighlightWorker.instances).toHaveLength(1);
    highlightLines("typescript", ["new"], () => {});
    expect(HighlightWorker.instances).toHaveLength(2);
  });

  it("有新任务时取消空闲释放；取消最后一个订阅后恢复释放", () => {
    highlightLines("typescript", ["first"], () => {});
    const worker = HighlightWorker.instances[0];
    worker.complete();
    vi.advanceTimersByTime(HIGHLIGHT_WORKER_IDLE_MS - 1);
    const cancel = highlightLines("typescript", ["second"], () => {});
    vi.advanceTimersByTime(HIGHLIGHT_WORKER_IDLE_MS);
    expect(worker.terminate).not.toHaveBeenCalled();
    cancel();
    vi.advanceTimersByTime(HIGHLIGHT_WORKER_IDLE_MS);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
