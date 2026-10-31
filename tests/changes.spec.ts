import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import CommitDraft from "../src/lib/components/CommitDraft.svelte";
import DiffView from "../src/lib/components/DiffView.svelte";
import FileList from "../src/lib/components/FileList.svelte";
import type { DiffLine, DiffResponse, FileChange, FileSelection } from "../src/lib/types";

const selection: FileSelection = { path: "demo.txt", side: "unstaged" };

const diff: DiffResponse = {
  generation: 1,
  path: "demo.txt",
  staged: false,
  binary: false,
  text: null,
  summary: "新增 1 行，删除 1 行。",
  additions: 1,
  deletions: 1,
  complete: true,
  truncated: false,
  snapshot: "abc",
  offset: 0,
  totalLines: 2,
  hunks: [
    { index: 0, header: "@@ -1 +1 @@", complete: true, stageable: true, startLine: 0, lineCount: 2 },
    { index: 1, header: "@@ -8 +8 @@", complete: false, stageable: false, startLine: 2, lineCount: 1 },
  ],
  lines: [
    { kind: "hunk", text: "@@ -1 +1 @@", oldNo: null, newNo: null, hunkIndex: 0 },
    { kind: "add", text: "+kept", oldNo: null, newNo: 1, hunkIndex: 0 },
    { kind: "hunk", text: "@@ -8 +8 @@", oldNo: null, newNo: null, hunkIndex: 1 },
  ],
};

function changedFile(path: string): FileChange {
  return {
    path,
    originalPath: null,
    staged: "none",
    unstaged: "modified",
    untracked: false,
    unmerged: false,
  };
}

describe("差异与提交", () => {
  it("键盘移动后把选中文件滚进虚拟窗口", async () => {
    const files = Array.from({ length: 80 }, (_, index) => changedFile(`item-${index}.txt`));
    let selected: FileSelection = { path: "item-0.txt", side: "unstaged" };
    const props = () => ({
      files,
      selected,
      query: "",
      disabled: false,
      onQuery: () => {},
      onSelect: (next: FileSelection) => {
        selected = next;
      },
      onStage: () => {},
      onUnstage: () => {},
    });
    const view = render(FileList, { props: props() });
    const list = screen.getByRole("listbox", { name: "改动文件" });
    await fireEvent.keyDown(list, { key: "End" });
    expect(selected.path).toBe("item-79.txt");
    expect(list.scrollTop).toBe(79 * 40);
    await view.rerender(props());
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("item-79.txt");
    expect(screen.queryByText("item-0.txt")).toBeNull();
  });

  it("差异区域可聚焦并用键盘按行滚动", async () => {
    const lines: DiffLine[] = Array.from({ length: 80 }, (_, index) => ({
      kind: "context",
      text: `row-${index}`,
      oldNo: index + 1,
      newNo: index + 1,
      hunkIndex: 0,
    }));
    const longDiff: DiffResponse = {
      ...diff,
      summary: "长差异",
      totalLines: lines.length,
      lines,
      hunks: [],
    };
    render(DiffView, {
      props: {
        selection,
        diff: longDiff,
        error: null,
        loading: false,
        disabled: false,
        onStageHunk: () => {},
        onLoadMore: () => {},
      },
    });
    const region = screen.getByRole("textbox", { name: "差异文本" });
    expect(region.getAttribute("tabindex")).toBe("0");
    region.focus();
    await fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(region.scrollTop).toBe(22);
    await fireEvent.keyDown(region, { key: "End" });
    expect(region.scrollTop).toBe(80 * 22);
    expect(screen.getByText("row-79")).toBeTruthy();
    expect(screen.queryByText("row-0")).toBeNull();
    await fireEvent.keyDown(region, { key: "Home" });
    expect(region.scrollTop).toBe(0);
    expect(screen.getByText("row-0")).toBeTruthy();
  });

  it("切换并排时保留文件，并拒绝截断代码块", async () => {
    render(DiffView, {
      props: {
        selection,
        diff,
        error: null,
        loading: false,
        disabled: false,
        onStageHunk: () => {},
        onLoadMore: () => {},
      },
    });
    expect(screen.getByRole("button", { name: "并排" }).getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(screen.getByRole("button", { name: "并排" }));
    expect(screen.getByRole("button", { name: "并排" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/\+kept/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "暂存此块" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "已截断" }).hasAttribute("disabled")).toBe(true);
  });

  it("本地提交展示目标和范围，空暂存不能提交", () => {
    render(CommitDraft, {
      props: {
        branch: "main（尚无提交）",
        scope: "提交到 main（尚无提交） · 暂存区是空的",
        paths: [],
        value: "保留说明",
        disabled: false,
        onInput: () => {},
        onBlur: () => {},
        onCommit: () => {},
      },
    });
    expect(screen.getByText("提交到 main（尚无提交） · 暂存区是空的")).toBeTruthy();
    expect(screen.getByText(/只创建本地提交，不会推送。/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交到本地" }).hasAttribute("disabled")).toBe(true);
  });
});
