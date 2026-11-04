/** 批量预览最多并发两项。替换选择或关闭面板后，旧批次的剩余项不再读取。
 * 运行位置由整个队列共享，因此连续切换也不会累积在途请求。
 */
export class LatestBatchReadQueue {
  private running = 0;
  private closed = false;
  private current: { pump: () => void; cancel: () => void } | null = null;

  run<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<R[]> {
    this.cancel();
    return new Promise<R[]>((resolve, reject) => {
      const results: R[] = [];
      const cancel = () => {
        results.length = 0;
        reject({ code: "cancelled", message: "读取已被新请求替代。" });
      };
      if (this.closed) return cancel();
      if (items.length === 0) return resolve(results);
      let next = 0;
      let completed = 0;
      const batch = {
        cancel,
        pump: () => {
          while (this.running < 2 && next < items.length) {
            const index = next++;
            this.running += 1;
            void Promise.resolve().then(() => {
              if (this.current !== batch) throw { code: "cancelled" };
              return task(items[index]);
            }).then((result) => {
              if (this.current !== batch) return;
              results[index] = result;
              completed += 1;
              if (completed === items.length) {
                this.current = null;
                resolve(results);
              }
            }, (error) => {
              if (this.current !== batch) return;
              this.current = null;
              results.length = 0;
              reject(error);
            }).finally(() => {
              this.running -= 1;
              this.current?.pump();
            });
          }
        },
      };
      this.current = batch;
      batch.pump();
    });
  }

  cancel(): void {
    this.current?.cancel();
    this.current = null;
  }

  close(): void {
    this.closed = true;
    this.cancel();
  }
}
