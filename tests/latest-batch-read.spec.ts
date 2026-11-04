import { describe, expect, it, vi } from "vitest";
import { LatestBatchReadQueue } from "../src/lib/latest-batch-read";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("历史批量读取", () => {
  it("大选择最多并发两项，乱序完成仍按输入顺序返回", async () => {
    const queue = new LatestBatchReadQueue();
    const pending = Array.from({ length: 5 }, () => deferred<number>());
    const task = vi.fn((index: number) => pending[index].promise);
    const result = queue.run([0, 1, 2, 3, 4], task);
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    pending[1].resolve(10);
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(3));
    pending[2].resolve(20);
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(4));
    pending[3].resolve(30);
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(5));
    pending[4].resolve(40);
    pending[0].resolve(0);
    expect(await result).toEqual([0, 10, 20, 30, 40]);
  });

  it("连续替换也共享运行位置，旧批次剩余项不发出，旧结果不混入新结果", async () => {
    const queue = new LatestBatchReadQueue();
    const pending = [deferred<number>(), deferred<number>()];
    const oldTask = vi.fn((index: number) => pending[index].promise);
    const old = queue.run(Array.from({ length: 20_000 }, (_, i) => i), oldTask).catch((error) => error.code);
    await vi.waitFor(() => expect(oldTask).toHaveBeenCalledTimes(2));
    const skipped = vi.fn(async () => 99);
    const middle = queue.run([99], skipped).catch((error) => error.code);
    const newest = vi.fn(async (id: number) => id);
    const result = queue.run([5, 6, 7], newest);
    expect(await old).toBe("cancelled");
    expect(await middle).toBe("cancelled");
    expect(newest).not.toHaveBeenCalled();
    pending[1].resolve(1);
    expect(await result).toEqual([5, 6, 7]);
    pending[0].resolve(0);
    expect(skipped).not.toHaveBeenCalled();
    expect(oldTask).toHaveBeenCalledTimes(2);
  });

  it("失败释放位置，取消和关闭清除尚未开始的读取", async () => {
    const queue = new LatestBatchReadQueue();
    const failure = deferred<number>();
    const task = vi.fn(() => failure.promise);
    const failed = queue.run([1, 2, 3], task).catch((error) => error.message);
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    failure.reject(new Error("read failed"));
    expect(await failed).toBe("read failed");
    expect(await queue.run([4], async (id) => id)).toEqual([4]);
    expect(task).toHaveBeenCalledTimes(2);
    const skipped = vi.fn(async () => 5);
    const cancelled = queue.run([5], skipped).catch((error) => error.code);
    queue.cancel();
    expect(await cancelled).toBe("cancelled");
    const closed = queue.run([6], skipped).catch((error) => error.code);
    queue.close();
    expect(await closed).toBe("cancelled");
    await expect(queue.run([7], skipped)).rejects.toMatchObject({ code: "cancelled" });
    expect(skipped).not.toHaveBeenCalled();
  });
});
