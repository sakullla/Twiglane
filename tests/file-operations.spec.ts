import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { FileEntryRequest, FileEntryResult } from "../src/lib/types";

import FileOperationDialog, {
  insideItself,
  joinRelative,
  parentDirectory,
  suggestCopyPath,
  validateEntryName,
  validateEntryPath,
} from "../src/lib/components/FileOperationDialog.svelte";

function ok(request: FileEntryRequest): FileEntryResult {
  return { ok: true, code: "ok", message: "完成", path: request.target };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    action: "createFile" as const,
    path: "src/lib",
    kind: "directory" as const,
    disabled: false,
    draftPaths: [] as string[],
    onClose: vi.fn(),
    onSubmit: vi.fn(async (request: FileEntryRequest) => ok(request)),
    ...overrides,
  };
}

function submitButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("[data-entry-submit]")!;
}

async function type(inputSelector: string, value: string) {
  await fireEvent.input(document.querySelector(inputSelector)!, { target: { value } });
}

describe("文件操作表单的纯校验", () => {
  it("名称不接受路径分隔符、相对层级与控制字符", () => {
    expect(validateEntryName("notes.md")).toBeNull();
    expect(validateEntryName("  ")).toContain("先填写名称");
    expect(validateEntryName("a/b")).toContain("路径分隔符");
    expect(validateEntryName("a\\b")).toContain("路径分隔符");
    expect(validateEntryName("..")).toContain("不能是 . 或 ..");
    expect(validateEntryName(".git")).toContain("不能新建 .git");
    expect(validateEntryName("a\u0007b")).toContain("控制字符");
  });

  it("目标路径只接受仓库内相对路径", () => {
    expect(validateEntryPath("src/lib/notes.md")).toBeNull();
    expect(validateEntryPath("/etc/passwd")).toContain("相对路径");
    expect(validateEntryPath("C:/work/demo/a.md")).toContain("相对路径");
    expect(validateEntryPath("src//a.md")).toContain("空层级");
    expect(validateEntryPath("src/../a.md")).toContain("..");
    expect(validateEntryPath("src/.git/config")).toContain(".git");
    expect(validateEntryPath("src\\a.md")).toContain("/");
  });

  it("父目录、拼接与复制默认目标按扩展名生成", () => {
    expect(parentDirectory("src/lib/a.ts")).toBe("src/lib");
    expect(parentDirectory("README.md")).toBe("");
    expect(joinRelative("src", "a.ts")).toBe("src/a.ts");
    expect(joinRelative("", "a.ts")).toBe("a.ts");
    expect(suggestCopyPath("src/lib/a.ts", "file")).toBe("src/lib/a-副本.ts");
    expect(suggestCopyPath("README.md", "file")).toBe("README-副本.md");
    expect(suggestCopyPath("src/lib", "directory")).toBe("src/lib-副本");
    expect(insideItself("src/lib", "src/lib/deep/a.ts")).toBe(true);
    expect(insideItself("src/lib", "src/lib2/a.ts")).toBe(false);
  });
});

describe("新建文件与目录", () => {
  it("打开时不先报错；填好名称后提交到所在目录", async () => {
    const p = props({ action: "createDirectory", path: "src/lib", kind: "directory" });
    render(FileOperationDialog, { props: p as never });
    expect(document.querySelector("[data-entry-form='createDirectory']")).toBeTruthy();
    expect(document.querySelector("[data-entry-problem]")).toBeNull();
    expect(document.querySelector("[data-entry-preview]")).toBeNull();

    await type("[data-entry-input='name']", "components");
    expect(document.querySelector("[data-entry-preview]")?.textContent).toContain("src/lib/components");
    await fireEvent.click(submitButton());
    await waitFor(() => expect(p.onSubmit).toHaveBeenCalledTimes(1));
    expect(p.onSubmit).toHaveBeenCalledWith({
      action: "createDirectory",
      source: "",
      target: "src/lib/components",
      kind: "directory",
    });
    await waitFor(() => expect(p.onClose).toHaveBeenCalled());
  });

  it("名称非法时就地说明并保留输入，不调用命令", async () => {
    const p = props({ action: "createFile", path: "src/lib", kind: "directory" });
    render(FileOperationDialog, { props: p as never });
    await type("[data-entry-input='name']", "a/b");
    await fireEvent.click(submitButton());
    expect(document.querySelector("[data-entry-problem]")?.textContent).toContain("路径分隔符");
    expect(p.onSubmit).not.toHaveBeenCalled();
    expect(p.onClose).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("[data-entry-input='name']")!.value).toBe("a/b");
  });

  it("提交失败保留原因与已填内容，改一处后可以再次提交", async () => {
    const onSubmit = vi
      .fn<(request: FileEntryRequest) => Promise<FileEntryResult>>()
      .mockResolvedValueOnce({ ok: false, code: "target_exists", message: "目标已存在：src/lib/a.md", path: "src/lib/a.md" })
      .mockImplementation(async (request) => ok(request));
    const p = props({ action: "createFile", path: "src/lib", kind: "directory", onSubmit });
    render(FileOperationDialog, { props: p as never });
    await type("[data-entry-input='name']", "a.md");
    await fireEvent.click(submitButton());
    await waitFor(() => expect(document.querySelector("[data-entry-error]")?.textContent).toContain("目标已存在"));
    expect(p.onClose).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("[data-entry-input='name']")!.value).toBe("a.md");

    await type("[data-entry-input='name']", "b.md");
    expect(document.querySelector("[data-entry-error]")).toBeNull();
    await fireEvent.click(submitButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ target: "src/lib/b.md" }));
    await waitFor(() => expect(p.onClose).toHaveBeenCalled());
  });

  it("写入在途时提交与取消都锁住，同一次操作不会被发送两次", async () => {
    let finish!: (result: FileEntryResult) => void;
    const onSubmit = vi.fn(() => new Promise<FileEntryResult>((resolve) => (finish = resolve)));
    const p = props({ action: "createFile", path: "src/lib", kind: "directory", onSubmit });
    render(FileOperationDialog, { props: p as never });
    await type("[data-entry-input='name']", "a.md");
    await fireEvent.click(submitButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const button = submitButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await fireEvent.click(button);
    await fireEvent.click(document.querySelector<HTMLButtonElement>(".create-form-actions .btn-secondary")!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(p.onClose).not.toHaveBeenCalled();

    finish({ ok: true, code: "ok", message: "", path: "src/lib/a.md" });
    await waitFor(() => expect(p.onClose).toHaveBeenCalledTimes(1));
  });
});

describe("复制与移动", () => {
  it("复制默认给出同目录副本名，提交时带上源与目标", async () => {
    const p = props({ action: "copy", path: "src/lib/a.ts", kind: "file" });
    render(FileOperationDialog, { props: p as never });
    const input = document.querySelector<HTMLInputElement>("[data-entry-input='target']")!;
    expect(input.value).toBe("src/lib/a-副本.ts");
    expect(screen.getByText(/源路径/).textContent).toContain("src/lib/a.ts");
    await fireEvent.click(submitButton());
    await waitFor(() => expect(p.onSubmit).toHaveBeenCalledWith({
      action: "copy",
      source: "src/lib/a.ts",
      target: "src/lib/a-副本.ts",
      kind: "file",
    }));
  });

  it("移动沿用原路径作默认值；改成相同路径或把目录挪进自己都要先拦住", async () => {
    const p = props({ action: "move", path: "src/lib", kind: "directory" });
    render(FileOperationDialog, { props: p as never });
    const input = document.querySelector<HTMLInputElement>("[data-entry-input='target']")!;
    expect(input.value).toBe("src/lib");
    await fireEvent.click(submitButton());
    expect(document.querySelector("[data-entry-problem]")?.textContent).toContain("不能与源路径相同");
    expect(p.onSubmit).not.toHaveBeenCalled();

    await type("[data-entry-input='target']", "src/lib/deep");
    await fireEvent.click(submitButton());
    expect(document.querySelector("[data-entry-problem]")?.textContent).toContain("子目录");
    expect(p.onSubmit).not.toHaveBeenCalled();

    await type("[data-entry-input='target']", "src/lib2");
    await fireEvent.click(submitButton());
    await waitFor(() => expect(p.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ target: "src/lib2" })));
  });

  it("有未保存草稿的文件在移动表单里提前提示，但命令仍由外壳决定是否执行", async () => {
    const p = props({ action: "move", path: "src/lib/a.ts", kind: "file", draftPaths: ["src/lib/a.ts", "src/lib/b.ts"] });
    render(FileOperationDialog, { props: p as never });
    expect(document.querySelector("[data-entry-drafts]")?.textContent).toContain("src/lib/a.ts");
    expect(document.querySelector("[data-entry-drafts]")?.textContent).not.toContain("b.ts");
  });
});

describe("删除确认", () => {
  it("明确说明进入系统回收站，取消不提交", async () => {
    const p = props({ action: "delete", path: "src/lib/old", kind: "directory" });
    render(FileOperationDialog, { props: p as never });
    const dialog = screen.getByRole("dialog", { name: "移到回收站" });
    expect(dialog.textContent).toContain("系统回收站");
    expect(dialog.textContent).toContain("不会暂存、提交或推送");
    expect(dialog.textContent).toContain("目录及其内容会一起移入回收站");
    expect(dialog.textContent).toContain("本应用不提供永久删除");

    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(p.onSubmit).not.toHaveBeenCalled();
  });

  it("确认后只提交删除动作，失败时说明保留在确认框里", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: false, code: "trash_failed", message: "系统回收站不可用。", path: "src/lib/old" });
    const p = props({ action: "delete", path: "src/lib/old", kind: "file", onSubmit });
    render(FileOperationDialog, { props: p as never });
    await fireEvent.click(screen.getByRole("button", { name: "移到回收站" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      action: "delete",
      source: "src/lib/old",
      target: "",
      kind: "file",
    }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "移到回收站" }).textContent).toContain("系统回收站不可用"));
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it("目标或其后代有草稿时确认按钮不可用，并说明涉及的路径", () => {
    const p = props({
      action: "delete",
      path: "src/lib",
      kind: "directory",
      draftPaths: ["src/lib/a.ts", "src/lib/deep/b.ts", "src/other.ts"],
    });
    render(FileOperationDialog, { props: p as never });
    const confirm = screen.getByRole("button", { name: "移到回收站" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute("title")).toContain("src/lib/a.ts");
    const dialog = screen.getByRole("dialog", { name: "移到回收站" });
    expect(dialog.textContent).toContain("src/lib/a.ts");
    expect(dialog.textContent).toContain("src/lib/deep/b.ts");
    expect(dialog.textContent).not.toContain("src/other.ts");
    expect(p.onSubmit).not.toHaveBeenCalled();
  });

  it("写入在途时确认框锁住，不会重复发送删除", async () => {
    let finish!: (result: FileEntryResult) => void;
    const onSubmit = vi.fn(() => new Promise<FileEntryResult>((resolve) => (finish = resolve)));
    const p = props({ action: "delete", path: "src/lib/old", kind: "file", onSubmit });
    render(FileOperationDialog, { props: p as never });
    await fireEvent.click(screen.getByRole("button", { name: "移到回收站" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await fireEvent.click(screen.getByRole("button", { name: /正在移入回收站|移到回收站/ }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    finish({ ok: true, code: "ok", message: "", path: "src/lib/old" });
    await waitFor(() => expect(p.onClose).toHaveBeenCalledTimes(1));
  });
});
