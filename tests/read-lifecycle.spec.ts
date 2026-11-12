// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { LatestReadQueue } from "../src/lib/latest-read";
import { LatestBatchReadQueue } from "../src/lib/latest-batch-read";
import { previewReads } from "../src/lib/preview-reads";
import { TerminalRouter } from "../src/lib/terminal";

describe("连续选择的读取队列", () => {
  it("已启动的读取保持有界，过时的排队项不会执行", async () => {
    const queue = new LatestReadQueue();
    let finish!: (value: number) => void;
    const first = queue.run(() => new Promise<number>((resolve) => (finish = resolve)));
    const second = queue.run(() => new Promise<number>(() => {}));
    void second;
    const obsolete = vi.fn(async () => 3);
    const dropped = queue.run(obsolete).catch((error) => error.code);
    const newest = vi.fn(async () => 4);
    const last = queue.run(newest);
    await Promise.resolve();
    expect(obsolete).not.toHaveBeenCalled();
    expect(newest).not.toHaveBeenCalled();
    expect(await dropped).toBe("cancelled");
    finish(1);
    expect(await first).toBe(1);
    expect(await last).toBe(4);
    expect(obsolete).not.toHaveBeenCalled();
    queue.close();
  });

  it("组件销毁后不启动排队读取，失败也释放运行位置", async () => {
    const queue = new LatestReadQueue();
    let fail!: (reason: unknown) => void;
    const first = queue.run(() => new Promise((_, reject) => (fail = reject))).catch(() => {});
    void queue.run(() => new Promise(() => {}));
    const task = vi.fn(async () => 1);
    const pending = queue.run(task).catch((error) => error.code);
    await Promise.resolve();
    queue.close();
    fail(new Error("read failed"));
    await first;
    expect(await pending).toBe("cancelled");
    await expect(queue.run(task)).rejects.toMatchObject({ code: "cancelled" });
    expect(task).not.toHaveBeenCalled();
  });
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("历史批量读取", () => {
  it("逐项交付已完成结果，取消后迟到结果不再上报", async () => {
    const queue = new LatestBatchReadQueue();
    const pending = [deferred<number>(), deferred<number>()];
    const progress = vi.fn();
    const result = queue.run([0, 1], (index) => pending[index].promise, progress).catch((error) => error.code);
    await Promise.resolve();
    pending[1].resolve(10);
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(10, 1));
    queue.cancel();
    pending[0].resolve(0);
    expect(await result).toBe("cancelled");
    await Promise.resolve();
    expect(progress).toHaveBeenCalledOnce();
  });

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

  it("连续替换时新批次立刻开始，旧批次剩余项不发出、旧结果不混入新结果", async () => {
    const queue = new LatestBatchReadQueue();
    const pending = [deferred<number>(), deferred<number>()];
    const oldTask = vi.fn((index: number) => pending[index].promise);
    const old = queue.run(Array.from({ length: 20_000 }, (_, i) => i), oldTask).catch((error) => error.code);
    await vi.waitFor(() => expect(oldTask).toHaveBeenCalledTimes(2));
    const skipped = vi.fn(async () => 99);
    const middle = queue.run([99], skipped).catch((error) => error.code);
    const newest = vi.fn(async (id: number) => id);
    const result = queue.run([5, 6, 7], newest);
    // 旧批次的两个在途读取还挂着，新批次也必须立刻读完。
    expect(await result).toEqual([5, 6, 7]);
    expect(await old).toBe("cancelled");
    expect(await middle).toBe("cancelled");
    pending[0].resolve(0);
    pending[1].resolve(1);
    await Promise.resolve();
    expect(skipped).not.toHaveBeenCalled();
    expect(oldTask).toHaveBeenCalledTimes(2);
    expect(newest).toHaveBeenCalledTimes(3);
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

  it("旧批次在途请求永不结束也不会占住新批次的并发位置", async () => {
    const queue = new LatestBatchReadQueue();
    const stuck = vi.fn(() => new Promise<number>(() => {}));
    const old = queue.run([1, 2, 3], stuck).catch((error) => error.code);
    await vi.waitFor(() => expect(stuck).toHaveBeenCalledTimes(2));
    // 两个在途请求永不 settle：新批次必须仍然开始并完成，而不是无限排队。
    const fresh = vi.fn(async (id: number) => id * 10);
    const result = queue.run([4, 5, 6], fresh);
    expect(await result).toEqual([40, 50, 60]);
    expect(await old).toBe("cancelled");
    expect(stuck).toHaveBeenCalledTimes(2);
    // 旧批次的迟到结果永不落地。
    expect(fresh).toHaveBeenCalledTimes(3);
  });

  it("被新批次替代的旧批次只以 cancelled 结束，从不解析成空结果", async () => {
    const queue = new LatestBatchReadQueue();
    const first = deferred<number>();
    const progress = vi.fn();
    const stale = queue.run([1], () => first.promise, progress);
    const settled = vi.fn();
    void stale.then(settled, settled);
    await Promise.resolve();
    const newest = await queue.run([9], async (id) => id);
    expect(newest).toEqual([9]);
    first.resolve(1);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    await expect(stale).rejects.toMatchObject({ code: "cancelled" });
    expect(progress).not.toHaveBeenCalled();
  });

  it("取消与关闭后立即结算，不等旧的在途请求", async () => {
    const queue = new LatestBatchReadQueue();
    const stuck = vi.fn(() => new Promise<number>(() => {}));
    const running = queue.run([1, 2], stuck).catch((error) => error.code);
    await vi.waitFor(() => expect(stuck).toHaveBeenCalledTimes(2));
    queue.cancel();
    expect(await running).toBe("cancelled");
    const again = queue.run([3], stuck).catch((error) => error.code);
    await Promise.resolve();
    queue.close();
    expect(await again).toBe("cancelled");
    await expect(queue.run([4], stuck)).rejects.toMatchObject({ code: "cancelled" });
  });
});


it("快速浏览 50 个预览仍只有两个在途请求，关闭的排队项不再启动", async () => {
  const releases: (() => void)[] = [];
  const task = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
  const controllers = Array.from({ length: 50 }, () => new AbortController());
  const requests = controllers.map((controller) => previewReads.run(task, controller.signal).catch(() => {}));
  await Promise.resolve();
  expect(task).toHaveBeenCalledTimes(2);
  controllers.forEach((controller) => controller.abort());
  releases.forEach((release) => release());
  await Promise.all(requests);
  await Promise.resolve();
  expect(task).toHaveBeenCalledTimes(2);
  expect(await previewReads.run(async () => "fresh", new AbortController().signal)).toBe("fresh");
});


describe("终端订阅资源", () => {
  it("第二个订阅失败时释放第一个，重试与销毁没有残留", async () => {
    const stopOutput = vi.fn();
    const stops = [vi.fn(), vi.fn()];
    const listen = vi.fn()
      .mockResolvedValueOnce(stopOutput)
      .mockRejectedValueOnce(new Error("listen failed"))
      .mockResolvedValueOnce(stops[0])
      .mockResolvedValueOnce(stops[1]);
    const router = new TerminalRouter(listen);
    await expect(router.start()).rejects.toThrow("listen failed");
    expect(stopOutput).toHaveBeenCalledTimes(1);
    await router.start();
    router.dispose();
    stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
    await router.start();
    expect(listen).toHaveBeenCalledTimes(4);
  });

  it("订阅还没完成就卸载，迟到的监听器立即释放", async () => {
    let finish!: (stop: () => void) => void;
    const stop = vi.fn();
    const listen = vi.fn(() => new Promise<() => void>((resolve) => { finish = resolve; }));
    const router = new TerminalRouter(listen);
    const ready = router.start();
    router.dispose();
    finish(stop);
    await ready;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
