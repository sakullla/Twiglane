/** 用户连续切换选择时，只保留最新的待执行读取；已启动的读取由调用方的序号丢弃旧结果。 */
export class LatestReadQueue {
  private running = 0;
  private closed = false;
  private pending: { start: () => void; cancel: () => void } | null = null;

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject({ code: "cancelled", message: "读取已被新请求替代。" });
      const start = () => {
        this.running += 1;
        const execute = async () => task();
        void execute().then(resolve, reject).finally(() => {
          this.running -= 1;
          const next = this.pending;
          this.pending = null;
          if (next && !this.closed) next.start();
        });
      };
      if (this.closed) cancel();
      else if (this.running < 2) start();
      else {
        this.pending?.cancel();
        this.pending = { start, cancel };
      }
    });
  }

  close(): void {
    this.closed = true;
    this.pending?.cancel();
    this.pending = null;
  }
}
