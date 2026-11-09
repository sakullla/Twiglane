/** 批量预览最多并发两项。
 *
 * 并发位置属于批次本身，不属于整个队列：取消（被新选择替代、切仓库、切视图、关闭面板）时，
 * 旧批次的在途读取即使永不 settle 也不会占住新批次的位置，新批次立刻按自己的两项并发开始。
 * 旧批次的迟到结果与迟到错误同样不再落地（既不 resolve 成空结果，也不覆盖新批次）。
 * 代价是被放弃的读取仍会跑完，但它只可能由用户的连续操作产生，不会自己累积。
 */
export class LatestBatchReadQueue {
  private current: Batch | null = null;
  private closed = false;

  run<T, R>(items: readonly T[], task: (item: T) => Promise<R>, onResult?: (result: R, index: number) => void): Promise<R[]> {
    this.cancel();
    return new Promise<R[]>((resolve, reject) => {
      let settled = false;
      let next = 0;
      let running = 0;
      let completed = 0;
      const results: R[] = [];

      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (this.current === batch) this.current = null;
        if (error === undefined) resolve(results);
        else {
          results.length = 0;
          reject(error);
        }
      };

      const batch: Batch = {
        cancel: () => finish({ code: "cancelled", message: "读取已被新请求替代。" }),
        pump: () => {
          if (settled) return;
          while (running < MAX_PARALLEL && next < items.length) {
            const index = next++;
            running += 1;
            void Promise.resolve()
              .then(() => {
                if (settled) throw CANCELLED;
                return task(items[index]);
              })
              .then((result) => {
                if (settled) return;
                results[index] = result;
                completed += 1;
                onResult?.(result, index);
                if (settled) return;
                if (completed === items.length) finish();
              })
              .catch((error) => {
                if (settled) return;
                finish(error);
              })
              .finally(() => {
                running -= 1;
                batch.pump();
              });
          }
        },
      };

      if (this.closed) {
        this.current = null;
        settled = true;
        reject({ code: "cancelled", message: "读取已被关闭。" });
        return;
      }
      if (items.length === 0) {
        settled = true;
        resolve(results);
        return;
      }
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

interface Batch {
  /** 取消只以 cancelled 结算一次；之后旧批次的迟到结果不再落地。 */
  cancel: () => void;
  pump: () => void;
}

const MAX_PARALLEL = 2;
const CANCELLED = { code: "cancelled" };
