import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import type { FilePreview, PreviewSources } from "../src/lib/types";

const filePreview = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/api", () => ({ api: { filePreview } }));
import BinaryPreview from "../src/lib/components/BinaryPreview.svelte";

const sources: PreviewSources = { repository: "/repo", old: { revision: "a".repeat(40), path: "old.png" }, new: { revision: "b".repeat(40), path: "new.png" } };
const preview: FilePreview = { generation: 1, kind: "image", dataUrl: "data:image/png;base64,AA==", size: 1, entries: [], truncated: false, message: "", lfsOid: null, canDownload: false };

describe("文件内容预览", () => {
  it("切换前后版本会丢弃迟到响应", async () => {
    let finish!: (value: FilePreview) => void;
    filePreview.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    filePreview.mockResolvedValueOnce({ ...preview, dataUrl: "data:image/png;base64,old" });
    const component = render(BinaryPreview, { sources, generation: 1, disabled: false });
    await waitFor(() => expect(finish).toBeTruthy());
    await fireEvent.click(screen.getByRole("button", { name: "改动前" }));
    expect(await screen.findByAltText("改动前：old.png")).toBeTruthy();
    finish(preview);
    await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).toContain("old"));
    component.unmount();
  });

  it("压缩包目录虚拟化并能筛选末尾文件", async () => {
    filePreview.mockResolvedValueOnce({ ...preview, kind: "archive", dataUrl: null, entries: Array.from({ length: 2000 }, (_, i) => ({ name: `dir/file-${i}.txt`, size: i, directory: false })) });
    render(BinaryPreview, { sources, generation: 1, disabled: false });
    await screen.findByRole("list", { name: "压缩包文件" });
    expect(screen.getAllByRole("listitem").length).toBeLessThan(40);
    await fireEvent.input(screen.getByRole("textbox", { name: "筛选压缩包文件" }), { target: { value: "file-1999" } });
    expect(await screen.findByText("dir/file-1999.txt")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("LFS 不自动联网，点击后下载并传播 generation", async () => {
    filePreview.mockClear();
    filePreview.mockResolvedValueOnce({ ...preview, kind: "lfs", dataUrl: null, lfsOid: "abc", canDownload: true, message: "LFS 内容尚未下载。" });
    filePreview.mockResolvedValueOnce({ ...preview, generation: 2, lfsOid: "abc" });
    const onGeneration = vi.fn();
    render(BinaryPreview, { sources, generation: 1, disabled: false, onGeneration });
    const button = await screen.findByRole("button", { name: "下载 LFS 内容并预览" });
    expect(filePreview).toHaveBeenCalledTimes(1);
    expect(filePreview).toHaveBeenCalledWith("/repo", sources.new, 1);
    await fireEvent.click(button);
    await screen.findByRole("img");
    expect(filePreview).toHaveBeenLastCalledWith("/repo", sources.new, 1, true);
    expect(onGeneration).toHaveBeenCalledWith(2);
  });
});
