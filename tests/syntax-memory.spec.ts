import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { highlightLines, HIGHLIGHT_CACHE_BYTES, HIGHLIGHT_WORKER_IDLE_MS, MAX_HIGHLIGHT_CHARS, resetHighlightCache } from "../src/lib/syntax/client";
import { lineSegments } from "../src/lib/syntax/segments";

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
    const lines = ["x"];
    const rendered = vi.fn();
    highlightLines("typescript", lines, rendered);
    const worker = HighlightWorker.instances[0];
    const { id } = worker.postMessage.mock.calls[0][0];
    worker.onmessage?.({ data: { id, start: 0, tokens: [[{ t: "x".repeat(HIGHLIGHT_CACHE_BYTES / 2 + 1), k: "" }]] } } as MessageEvent);
    worker.onmessage?.({ data: { id, done: true, ok: true } } as MessageEvent);
    expect(rendered).toHaveBeenCalledOnce();
    highlightLines("typescript", lines, () => {});
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
  });

  it("只向 Worker 发送预算内的完整行，超长行仍按原文显示", () => {
    const huge = "x".repeat(MAX_HIGHLIGHT_CHARS);
    const chunk = vi.fn();
    highlightLines("typescript", ["const x = 1;", huge, "tail"], chunk);
    const worker = HighlightWorker.instances[0];
    expect(worker.postMessage.mock.calls[0][0].lines).toEqual(["const x = 1;"]);
    worker.complete();
    expect(chunk.mock.calls[0][1]).toHaveLength(1);
    expect(lineSegments(huge, undefined)[0].t).toBe(huge);
    const done = vi.fn();
    highlightLines("typescript", [huge], chunk, done);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledOnce();
  });

  it("响应式代理数组先拷成普通数组再发给 Worker，代理不能被结构化克隆", () => {
    // 文件视图把 $state 数组直接交给高亮：原样 postMessage 会抛 DataCloneError。
    const lines = new Proxy(["fn main() {}", "let x = 1;"], {});
    highlightLines("rust", lines, () => {});
    const sent = HighlightWorker.instances[0].postMessage.mock.calls[0][0].lines;
    expect(sent).not.toBe(lines);
    expect(() => structuredClone(sent)).not.toThrow();
    expect(sent).toEqual(["fn main() {}", "let x = 1;"]);
  });

  it("发送失败时改在主线程分词，不占着并发名额堵住后续文件", async () => {
    vi.useRealTimers();
    const failing = [vi.fn(), vi.fn()];
    highlightLines("typescript", ["const a = 1;"], () => {}, failing[0]);
    const worker = HighlightWorker.instances[0];
    worker.postMessage.mockImplementation(() => {
      throw new DOMException("could not be cloned", "DataCloneError");
    });
    highlightLines("typescript", ["const b = 2;"], () => {}, failing[1]);
    await vi.waitFor(() => expect(failing[1]).toHaveBeenCalledWith(true));
    worker.postMessage.mockReset();
    highlightLines("typescript", ["const c = 3;"], () => {});
    expect(worker.postMessage, "名额已释放，后续请求照常发送").toHaveBeenCalledOnce();
  });

  it("快速切换只复制两个在途文档，取消的排队文档不发送，等待 Worker 确认才复用槽位", () => {
    const cancels = Array.from({ length: 50 }, (_, i) => highlightLines("typescript", [`doc-${i}`], vi.fn()));
    const worker = HighlightWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    cancels.forEach((cancel) => cancel());
    // 只给正在运行的两个任务发送取消消息。
    expect(worker.postMessage).toHaveBeenCalledTimes(4);
    const fresh = vi.fn();
    highlightLines("typescript", ["fresh"], fresh);
    expect(worker.postMessage).toHaveBeenCalledTimes(4);
    worker.complete(0);
    expect(worker.postMessage).toHaveBeenCalledTimes(5);
    expect(worker.postMessage.mock.calls[4][0].lines).toEqual(["fresh"]);
    worker.complete(1);
    worker.complete(4);
    expect(fresh).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledTimes(5);
  });

  it("同内容共享排队任务，取消一个订阅不会移除另一个", () => {
    highlightLines("typescript", ["first"], vi.fn());
    highlightLines("typescript", ["second"], vi.fn());
    const removed = vi.fn();
    const kept = vi.fn();
    const cancel = highlightLines("typescript", ["shared"], removed);
    highlightLines("typescript", ["shared"], kept);
    cancel();
    const worker = HighlightWorker.instances[0];
    worker.complete(0);
    worker.complete(2);
    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledOnce();
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
