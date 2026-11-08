import type { MarkdownParseResult } from "./types";

export const MARKDOWN_PARSE_TIMEOUT_MS = 10_000;

/** 一份预览一个可终止任务；隐藏或换版本立即释放，旧消息不能更新新页面。 */
export function parseMarkdown(text: string, receive: (result: MarkdownParseResult) => void): () => void {
  let disposed = false;
  let worker: Worker | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (result: MarkdownParseResult) => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    worker?.terminate();
    receive(result);
  };
  if (typeof Worker !== "undefined") {
    try {
      worker = new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" });
      // Worker 消息同样是信任边界：无法识别时不把界面留在永久加载态。
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data as { ok?: unknown } | null;
        finish(data && typeof data === "object" && typeof data.ok === "boolean"
          ? (data as MarkdownParseResult)
          : { ok: false, message: "文档预览返回了无法识别的结果，可切换到源码阅读。" });
      };
      worker.onerror = () => finish({ ok: false, message: "文档预览加载失败，可切换到源码阅读。" });
      timer = setTimeout(() => finish({ ok: false, message: "文档解析超时，可切换到源码阅读。" }), MARKDOWN_PARSE_TIMEOUT_MS);
      worker.postMessage(text);
    } catch {
      finish({ ok: false, message: "当前环境无法启动文档预览，可切换到源码阅读。" });
    }
  } else {
    // 无 Worker 的测试/宿主仅解析小文档，避免在 UI 线程处理大输入。
    void import("./parser").then(({ parseMarkdownDocument, MARKDOWN_FALLBACK_CHARS }) => {
      if (disposed) return;
      finish(text.length > MARKDOWN_FALLBACK_CHARS
        ? { ok: false, message: "当前环境无法在后台解析长文，可切换到源码阅读。" }
        : parseMarkdownDocument(text));
    }).catch(() => finish({ ok: false, message: "文档预览加载失败，可切换到源码阅读。" }));
  }
  return () => {
    disposed = true;
    clearTimeout(timer);
    worker?.terminate();
  };
}
