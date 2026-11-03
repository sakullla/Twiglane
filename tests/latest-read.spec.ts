import { describe, expect, it, vi } from "vitest";
import { LatestReadQueue } from "../src/lib/latest-read";

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
