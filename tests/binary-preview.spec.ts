import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePreview, PreviewSources } from "../src/lib/types";

const filePreview = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/api", () => ({ api: { filePreview } }));
import BinaryPreview from "../src/lib/components/BinaryPreview.svelte";

const sources: PreviewSources = { repository: "/repo", old: { revision: "a".repeat(40), path: "old.png" }, new: { revision: "b".repeat(40), path: "new.png" } };
const preview: FilePreview = { generation: 1, kind: "image", dataUrl: "data:image/png;base64,new", size: 20, entries: [], truncated: false, message: "", lfsOid: null, canDownload: false };
const image = (side: "old" | "new", extra: Partial<FilePreview> = {}): FilePreview => ({ ...preview, dataUrl: "data:image/png;base64," + side, size: side === "old" ? 10 : 20, ...extra });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("文件内容预览", () => {
  // 必须写成语句块：mockReset() 返回 mock 本身，隐式返回会被 vitest 当作 beforeEach 的 teardown 调用。
  beforeEach(() => { filePreview.mockReset(); });

  it("并排读取图片，分别显示元数据并同步缩放和支持快捷键", async () => {
    filePreview.mockImplementation((_path, source) => Promise.resolve(image(source === sources.old ? "old" : "new")));
    render(BinaryPreview, { sources, generation: 1, disabled: false });
    const oldImage = await screen.findByAltText("改动前：old.png");
    const newImage = await screen.findByAltText("改动后：new.png");
    Object.defineProperties(oldImage, { naturalWidth: { value: 640 }, naturalHeight: { value: 480 } });
    Object.defineProperties(newImage, { naturalWidth: { value: 320 }, naturalHeight: { value: 200 } });
    await fireEvent.load(oldImage);
    await fireEvent.load(newImage);
    expect(screen.getByText("640 × 480")).toBeTruthy();
    expect(screen.getByText("320 × 200")).toBeTruthy();
    expect(screen.getByText("10 B")).toBeTruthy();
    expect(screen.getByText("20 B")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "原始大小" }));
    expect(oldImage.parentElement?.classList.contains("original")).toBe(true);
    expect(newImage.parentElement?.classList.contains("original")).toBe(true);
    const region = screen.getByRole("region", { name: "文件内容预览" });
    await fireEvent.keyDown(region, { key: "1" });
    expect(screen.queryByAltText("改动后：new.png")).toBeNull();
    await fireEvent.keyDown(region, { key: "3" });
    expect(screen.getByAltText("改动后：new.png")).toBeTruthy();
    await fireEvent.keyDown(region, { key: "0" });
    expect(screen.getByRole("button", { name: "原始大小" })).toBeTruthy();
  });

  it("generation 变化后立刻发出新的两侧读取并丢弃迟到响应", async () => {
    const requests: { source: { path: string }; generation: number; pending: ReturnType<typeof deferred<FilePreview>> }[] = [];
    filePreview.mockImplementation((_path, source, generation) => {
      const pending = deferred<FilePreview>();
      requests.push({ source, generation, pending });
      return pending.promise;
    });
    const view = render(BinaryPreview, { sources, generation: 1, disabled: false });
    await waitFor(() => expect(requests).toHaveLength(2));
    const nextSources = { ...sources, new: { revision: "c".repeat(40), path: "next.png" } };
    await view.rerender({ sources: nextSources, generation: 2, disabled: false });

    // 不结算 generation 1：旧读取一旦作废就要立刻让出 previewReads 槽位，新的两侧读取必须马上发出。
    await waitFor(() => expect(requests).toHaveLength(4));
    expect(requests.slice(2).map((item) => item.generation)).toEqual([2, 2]);
    expect(requests.slice(2).map((item) => item.source.path)).toEqual(["old.png", "next.png"]);

    // 迟到的 generation 1 结果不许覆盖新选择。
    for (const request of requests.filter((item) => item.generation === 1)) request.pending.resolve(image("old"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByAltText("改动后：new.png")).toBeNull();
    expect(screen.queryByAltText("改动后：next.png")).toBeNull();

    for (const request of requests.slice(2)) request.pending.resolve(image(request.source === nextSources.old ? "old" : "new", { generation: 2 }));
    const nextImage = await screen.findByAltText("改动后：next.png");
    expect(nextImage.getAttribute("src")).toContain("new");
    expect(screen.queryByAltText("改动后：new.png")).toBeNull();
  });

  it("卸载会取消排队中的读取，不再占用共享读取槽位", async () => {
    const requests: { source: { path: string }; generation: number; pending: ReturnType<typeof deferred<FilePreview>> }[] = [];
    filePreview.mockImplementation((_path, source, generation) => {
      const pending = deferred<FilePreview>();
      requests.push({ source, generation, pending });
      return pending.promise;
    });
    const view = render(BinaryPreview, { sources, generation: 1, disabled: false });
    await waitFor(() => expect(requests).toHaveLength(2));
    await view.rerender({ sources: { ...sources, new: { revision: "c".repeat(40), path: "next.png" } }, generation: 2, disabled: false });
    view.unmount();
    for (const request of requests) request.pending.resolve(image("old"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 被卸载组件的排队读取已随 cleanup 取消，槽位空出后不会再发出。
    expect(requests).toHaveLength(2);
  });

  it("旧实例释放槽位后，后挂载的预览不会被排队读取挡住", async () => {
    const requests: { source: { path: string }; generation: number; pending: ReturnType<typeof deferred<FilePreview>> }[] = [];
    filePreview.mockImplementation((_path, source, generation) => {
      const pending = deferred<FilePreview>();
      requests.push({ source, generation, pending });
      return pending.promise;
    });
    const first = render(BinaryPreview, { sources, generation: 1, disabled: false });
    await waitFor(() => expect(requests).toHaveLength(2));
    await first.rerender({ sources: { ...sources, new: { revision: "c".repeat(40), path: "next.png" } }, generation: 2, disabled: false });
    first.unmount();

    render(BinaryPreview, { sources, generation: 1, disabled: false });
    for (const request of requests.slice(0, 2)) request.pending.resolve(image("new", { generation: 1 }));
    await waitFor(() => expect(requests).toHaveLength(4));
    expect(requests.slice(2).map((item) => item.generation)).toEqual([1, 1]);
    expect(requests.slice(2).map((item) => item.source.path)).toEqual(["old.png", "new.png"]);

    for (const request of requests.slice(2)) request.pending.resolve(image(request.source.path === "old.png" ? "old" : "new"));
    expect(await screen.findByAltText("改动后：new.png")).toBeTruthy();
    expect(screen.queryByAltText("改动后：next.png")).toBeNull();
  });

  it("单侧读取失败不影响另一侧", async () => {
    filePreview.mockImplementation((_path, source) => source === sources.old ? Promise.reject(new Error("旧版本读取失败")) : Promise.resolve(image("new")));
    render(BinaryPreview, { sources, generation: 1, disabled: false });
    expect((await screen.findByRole("alert")).textContent).toContain("旧版本读取失败");
    expect(await screen.findByAltText("改动后：new.png")).toBeTruthy();
    expect(screen.queryByAltText("改动前：old.png")).toBeNull();
    const retries = screen.getAllByRole("button", { name: "重试" });
    expect(retries).toHaveLength(1);
    expect(retries[0].closest("[aria-label]")?.getAttribute("aria-label")).toBe("改动前预览");
  });

  it("单侧图片损坏只影响该侧", async () => {
    filePreview.mockImplementation((_path, source) => Promise.resolve(image(source === sources.old ? "old" : "new")));
    render(BinaryPreview, { sources, generation: 1, disabled: false });
    const newImage = await screen.findByAltText("改动后：new.png");
    await fireEvent.error(await screen.findByAltText("改动前：old.png"));
    expect((await screen.findByRole("alert")).textContent).toContain("图片损坏");
    expect(screen.getByAltText("改动后：new.png")).toBe(newImage);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("LFS 下载只作用于对应侧并传播 generation", async () => {
    filePreview.mockImplementation((_path, source) => Promise.resolve(source === sources.old ? image("old") : image("new", { kind: "lfs", dataUrl: null, lfsOid: "abc", canDownload: true, message: "LFS 内容尚未下载。" })));
    const onGeneration = vi.fn();
    render(BinaryPreview, { sources, generation: 1, disabled: false, onGeneration });
    const newPane = screen.getByRole("region", { name: "改动后预览" });
    const button = await within(newPane).findByRole("button", { name: "下载 LFS 内容并预览" });
    expect(filePreview).toHaveBeenCalledTimes(2);
    expect(filePreview).not.toHaveBeenCalledWith("/repo", sources.new, 1, true);
    filePreview.mockResolvedValueOnce(image("new", { generation: 2, lfsOid: "abc" }));
    await fireEvent.click(button);
    await within(newPane).findByRole("img");
    expect(filePreview).toHaveBeenLastCalledWith("/repo", sources.new, 1, true);
    expect(filePreview).toHaveBeenCalledTimes(3);
    expect(onGeneration).toHaveBeenCalledWith(2);
    expect(screen.getByAltText("改动前：old.png")).toBeTruthy();
  });

  it("单当前文件压缩包目录保持虚拟化并能筛选末尾文件，不出现版本比较", async () => {
    const single = { ...sources, old: null };
    filePreview.mockResolvedValueOnce({ ...preview, kind: "archive", dataUrl: null, entries: Array.from({ length: 2000 }, (_, i) => ({ name: "dir/file-" + i + ".txt", size: i, directory: false })) });
    render(BinaryPreview, { sources: single, generation: 1, disabled: false });
    await screen.findByRole("list", { name: "当前文件压缩包文件" });
    expect(screen.getAllByRole("listitem").length).toBeLessThan(40);
    await fireEvent.input(screen.getByRole("textbox", { name: "筛选当前文件压缩包文件" }), { target: { value: "file-1999" } });
    expect(await screen.findByText("dir/file-1999.txt")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "改动前" }), "没有改动前版本时不提供版本切换").toBeNull();
    expect(screen.queryByRole("button", { name: "并排比较" })).toBeNull();
    expect(screen.getByText("当前文件")).toBeTruthy();
  });

  it("只有当前文件时给出单文件语境，删除侧仍说明不可比较", async () => {
    filePreview.mockResolvedValue(image("new"));
    render(BinaryPreview, { sources: { ...sources, old: null }, generation: 1, disabled: false });
    expect(await screen.findByAltText("当前文件：new.png")).toBeTruthy();
    expect(screen.getByRole("region", { name: "当前文件预览" })).toBeTruthy();
    // 没有旧版本时不再提示「无法并排比较」这种对当前文件语境无意义的说明。
    expect(screen.queryByText(/无法并排比较/)).toBeNull();
    expect(screen.queryByRole("group", { name: "预览版本" })).toBeNull();

    filePreview.mockResolvedValue(image("old"));
    render(BinaryPreview, { sources: { ...sources, new: null }, generation: 1, disabled: false });
    expect(await screen.findByText("没有改动后版本，无法并排比较")).toBeTruthy();
    expect(screen.queryByText(/没有改动前版本/)).toBeNull();
  });
});
/* ------------------------------------------------------------------ *
 * R6：图片预览在刷新、缩放与视图切换时尺寸稳定。
 * 关键事实：同一版本的后台重读保留已解码的图片与已知尺寸，只有换了内容才重排；
 * 采纳新代次后不再多发一次请求，也就不存在「读 → 提版本 → 再读」的自激。
 * ------------------------------------------------------------------ */
describe("图片预览的刷新稳定性", () => {
  beforeEach(() => { filePreview.mockReset(); });

  it("同一版本的刷新保留图片节点、已知尺寸与缩放选择，只在不占布局的位置提示刷新", async () => {
    filePreview.mockImplementation((_path, source, generation) => Promise.resolve(image(source === sources.old ? "old" : "new", { generation })));
    const view = render(BinaryPreview, { sources, generation: 1, disabled: false });
    const newImage = await screen.findByAltText("改动后：new.png");
    Object.defineProperties(newImage, { naturalWidth: { value: 320 }, naturalHeight: { value: 200 } });
    await fireEvent.load(newImage);
    expect(screen.getByText("320 × 200")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "原始大小" }));
    expect(newImage.parentElement?.classList.contains("original")).toBe(true);

    // 后台刷新：同一份来源、新的代次，响应还没回来。
    const pending = deferred<FilePreview>();
    filePreview.mockImplementation((_path, source) => (source === sources.old ? Promise.resolve(image("old", { generation: 2 })) : pending.promise));
    await view.rerender({ sources, generation: 2, disabled: false });

    // 刷新期间：图片还在原位、尺寸没被清掉、缩放没被重置，状态提示不改变内容区高度。
    expect(screen.getByAltText("改动后：new.png")).toBe(newImage);
    expect(screen.getByText("320 × 200")).toBeTruthy();
    expect(newImage.parentElement?.classList.contains("original")).toBe(true);
    expect(screen.getAllByText(/正在刷新这个版本/).length).toBe(2);
    expect(document.querySelectorAll(".preview-message.inline")).toHaveLength(2);

    pending.resolve(image("new", { generation: 2 }));
    await waitFor(() => expect(screen.queryByText(/正在刷新这个版本/)).toBeNull());
    // 同一张图：节点没有重建，也就没有「闪一下再排回来」。
    expect(screen.getByAltText("改动后：new.png")).toBe(newImage);
    expect(screen.getByText("20 B")).toBeTruthy();
  });

  it("刷新失败保留上一次可读内容，并说明它不是刚验证过的结果", async () => {
    filePreview.mockResolvedValue(image("new", { generation: 1 }));
    const view = render(BinaryPreview, { sources, generation: 1, disabled: false });
    const first = await screen.findByAltText("改动后：new.png");
    filePreview.mockImplementation((_path, source) => (source === sources.old ? Promise.resolve(image("old", { generation: 2 })) : Promise.reject(new Error("网络读取失败"))));
    await view.rerender({ sources, generation: 2, disabled: false });
    expect((await screen.findByRole("alert")).textContent).toContain("刷新没有完成");
    // 旧图仍在：能继续读，但说明它已经不是刚核对过的版本。
    expect(screen.getByAltText("改动后：new.png")).toBe(first);
  });

  it("采纳新代次后不再重复读取同一代次，没有「读 → 提版本 → 再读」的自激", async () => {
    const calls: { side: string; generation: number }[] = [];
    let generation = 1;
    filePreview.mockImplementation((_path, source, current) => {
      calls.push({ side: source === sources.old ? "old" : "new", generation: current });
      // 后端在读取期间发现状态已推进：返回更高的代次，与真实 git 行为一致。
      return Promise.resolve(image(source === sources.old ? "old" : "new", { generation: current + 1 }));
    });
    const view = render(BinaryPreview, {
      sources, generation, disabled: false,
      onGeneration: (next: number) => { generation = Math.max(generation, next); },
    });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    // 宿主提升代次后重新渲染，组件不该为了同一个代次再发一次请求。
    await view.rerender({ sources: sources, generation, disabled: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await view.rerender({ sources, generation, disabled: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(generation).toBe(2);
    // 每侧最多两次：原本那一次，加上代次真的变化后的一次；没有继续增长。
    expect(calls.filter((call) => call.side === "old").length).toBeLessThanOrEqual(2);
    expect(calls.filter((call) => call.side === "new").length).toBeLessThanOrEqual(2);
    expect(calls.every((call) => call.generation <= 2)).toBe(true);
  });

  it("换了一份内容才重置缩放与比较方式", async () => {
    filePreview.mockResolvedValue(image("new", { generation: 1 }));
    const view = render(BinaryPreview, { sources, generation: 1, disabled: false });
    const newImage = await screen.findByAltText("改动后：new.png");
    await fireEvent.click(screen.getByRole("button", { name: "原始大小" }));
    expect(newImage.parentElement?.classList.contains("original")).toBe(true);

    // 只换代次：保留用户选择。
    await view.rerender({ sources, generation: 2, disabled: false });
    expect(screen.getByAltText("改动后：new.png").parentElement?.classList.contains("original")).toBe(true);

    // 换成另一份内容：回到适应窗口，并重新在两侧之间比较。
    const nextSources = { ...sources, new: { revision: "c".repeat(40), path: "next.png" } };
    await view.rerender({ sources: nextSources, generation: 2, disabled: false });
    const nextImage = await screen.findByAltText("改动后：next.png");
    expect(nextImage.parentElement?.classList.contains("original")).toBe(false);
  });
});
