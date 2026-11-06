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

  it("generation 变化会丢弃两侧迟到响应", async () => {
    const requests: { source: unknown; generation: number; pending: ReturnType<typeof deferred<FilePreview>> }[] = [];
    filePreview.mockImplementation((_path, source, generation) => {
      const pending = deferred<FilePreview>();
      requests.push({ source, generation, pending });
      return pending.promise;
    });
    const view = render(BinaryPreview, { sources, generation: 1, disabled: false });
    await waitFor(() => expect(requests).toHaveLength(2));
    const nextSources = { ...sources, new: { revision: "c".repeat(40), path: "next.png" } };
    await view.rerender({ sources: nextSources, generation: 2, disabled: false });
    // 旧的两侧读取仍占用共享读取槽位；先结算它们，排队中的替代读取才会真正发出。
    for (const request of requests.filter((item) => item.generation === 1)) request.pending.resolve(image("old"));
    await waitFor(() => expect(requests).toHaveLength(4));
    for (const request of requests.filter((item) => item.generation === 2)) request.pending.resolve(image(request.source === nextSources.old ? "old" : "new", { generation: 2 }));
    const nextImage = await screen.findByAltText("改动后：next.png");
    expect(nextImage.getAttribute("src")).toContain("new");
    expect(screen.queryByAltText("改动后：new.png")).toBeNull();
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

  it("压缩包单版本目录保持虚拟化并能筛选末尾文件", async () => {
    const single = { ...sources, old: null };
    filePreview.mockResolvedValueOnce({ ...preview, kind: "archive", dataUrl: null, entries: Array.from({ length: 2000 }, (_, i) => ({ name: "dir/file-" + i + ".txt", size: i, directory: false })) });
    render(BinaryPreview, { sources: single, generation: 1, disabled: false });
    await screen.findByRole("list", { name: "改动后压缩包文件" });
    expect(screen.getAllByRole("listitem").length).toBeLessThan(40);
    await fireEvent.input(screen.getByRole("textbox", { name: "筛选改动后压缩包文件" }), { target: { value: "file-1999" } });
    expect(await screen.findByText("dir/file-1999.txt")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect((screen.getByRole("button", { name: "改动前" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "并排比较" })).toBeNull();
  });
});
