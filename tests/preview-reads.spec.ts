import { expect, it, vi } from "vitest";
import { previewReads } from "../src/lib/preview-reads";

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
