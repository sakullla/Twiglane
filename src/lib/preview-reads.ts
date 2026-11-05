/** All preview panels share two read slots. Unmounted panels remove queued work. */
class PreviewReads {
  private running = 0;
  private pending = new Set<() => void>();

  run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(start);
        reject({ code: "cancelled", message: "预览已关闭。" });
      };
      const start = () => {
        this.pending.delete(start);
        if (signal.aborted) return cancel();
        this.running++;
        void Promise.resolve().then(task).then(resolve, reject).finally(() => {
          signal.removeEventListener("abort", cancel);
          this.running--;
          this.pending.values().next().value?.();
        });
      };
      if (signal.aborted) return cancel();
      signal.addEventListener("abort", cancel, { once: true });
      if (this.running < 2) start();
      else this.pending.add(start);
    });
  }
}

export const previewReads = new PreviewReads();
