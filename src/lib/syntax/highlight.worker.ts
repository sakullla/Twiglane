/// <reference lib="webworker" />
/**
 * 语法高亮 worker：分词放在后台线程，几万行的文件也不会卡住界面。
 * 协议：{ id, lang, lines } → 逐块回 { id, start, tokens }，结束回 { id, done, ok }；{ cancel: id } 取消。
 */
import { tokenizeInChunks } from "./engine";

type Request = { id: number; lang: string; lines: string[] } | { cancel: number };

const cancelled = new Set<number>();
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<Request>) => {
  const data = event.data;
  if ("cancel" in data) {
    cancelled.add(data.cancel);
    return;
  }
  const { id, lang, lines } = data;
  void tokenizeInChunks(
    lang,
    lines,
    (start, tokens) => scope.postMessage({ id, start, tokens }),
    {
      chunkLines: 300,
      cancelled: () => cancelled.has(id),
      // 每块之间让出事件循环，保证取消消息能及时处理。
      yieldBetween: () => new Promise((resolve) => setTimeout(resolve, 0)),
    },
  ).then((ok) => {
    cancelled.delete(id);
    scope.postMessage({ id, done: true, ok });
  });
};
