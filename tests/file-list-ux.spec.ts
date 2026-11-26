import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import FileList from "../src/lib/components/FileList.svelte";
import type { FileChange, FileSelection } from "../src/lib/types";

function makeFile(overrides: Partial<FileChange> & { path: string }): FileChange {
  return {
    path: overrides.path,
    originalPath: overrides.originalPath ?? null,
    staged: overrides.staged ?? "none",
    unstaged: overrides.unstaged ?? "none",
    untracked: overrides.untracked ?? false,
    unmerged: overrides.unmerged ?? false,
    stagedLines: overrides.stagedLines ?? null,
    unstagedLines: overrides.unstagedLines ?? null,
  };
}

const SAMPLE_FILES: FileChange[] = [
  makeFile({ path: "src/conflict.ts", unmerged: true, unstaged: "unmerged" }),
  makeFile({ path: "src/app.ts", unstaged: "modified" }),
  makeFile({ path: "src/new-untracked.ts", untracked: true }),
  makeFile({ path: "src/old.ts", unstaged: "deleted" }),
  makeFile({ path: "docs/added.md", staged: "added" }),
  makeFile({ path: "src/renamed.ts", originalPath: "src/before.ts", staged: "renamed" }),
];

function renderList(extra: Record<string, unknown> = {}) {
  const onQuery = vi.fn();
  const onSelect = vi.fn();
  const onMultiSelect = vi.fn();
  const onStage = vi.fn();
  const onUnstage = vi.fn();
  const onStageAll = vi.fn();
  const onUnstageAll = vi.fn();
  const onResolve = vi.fn();
  const onBatchStage = vi.fn();
  const onBatchUnstage = vi.fn();
  const onBatchDiscard = vi.fn();
  const onBatchCopyPaths = vi.fn();
  const onClearMultiSelect = vi.fn();

  const view = render(FileList, {
    props: {
      files: SAMPLE_FILES,
      selected: { path: "src/app.ts", side: "unstaged" } as FileSelection,
      selectedSet: [],
      query: "",
      disabled: false,
      onQuery,
      onSelect,
      onMultiSelect,
      onStage,
      onUnstage,
      onStageAll,
      onUnstageAll,
      onResolve,
      onBatchStage,
      onBatchUnstage,
      onBatchDiscard,
      onBatchCopyPaths,
      onClearMultiSelect,
      ...extra,
    },
  });

  return {
    ...view,
    onQuery,
    onSelect,
    onMultiSelect,
    onStage,
    onUnstage,
    onStageAll,
    onUnstageAll,
    onResolve,
    onBatchStage,
    onBatchUnstage,
    onBatchDiscard,
    onBatchCopyPaths,
    onClearMultiSelect,
  };
}

describe("FileList 分组折叠、状态筛选与多选批量操作条", () => {
  it("冲突/未暂存/已暂存三个分组头支持折叠与展开，保留真实计数与组级快捷动作", async () => {
    const { onStageAll, onUnstageAll, onResolve } = renderList();

    const conflictToggle = screen.getByRole("button", { name: "冲突（1）" });
    const unstagedToggle = screen.getByRole("button", { name: "未暂存的改动（3）" });
    const stagedToggle = screen.getByRole("button", { name: "已暂存（2）" });

    expect(conflictToggle.getAttribute("aria-expanded")).toBe("true");
    expect(unstagedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(stagedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("option")).toHaveLength(6);

    // 折叠未暂存分组：隐藏其下 3 条文件，但表头计数与「全部暂存」动作仍完整可用。
    await fireEvent.click(unstagedToggle);
    expect(unstagedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByRole("option", { name: "src/app.ts" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "全部暂存" }));
    expect(onStageAll).toHaveBeenCalledWith(["src/app.ts", "src/new-untracked.ts", "src/old.ts"]);

    // 折叠剩余两个分组：不落入空状态，所有分组头与组级按钮保持可操作。
    await fireEvent.click(conflictToggle);
    await fireEvent.click(stagedToggle);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.queryByText("工作区很干净")).toBeNull();
    expect(screen.getByRole("button", { name: "冲突（1）" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "已暂存（2）" }).getAttribute("aria-expanded")).toBe("false");

    await fireEvent.click(screen.getByRole("button", { name: "去处理" }));
    expect(onResolve).toHaveBeenCalledWith(null);
    await fireEvent.click(screen.getByRole("button", { name: "全部取消暂存" }));
    expect(onUnstageAll).toHaveBeenCalledWith(["docs/added.md", "src/renamed.ts"]);

    // 再次点击展开未暂存分组
    await fireEvent.click(unstagedToggle);
    expect(unstagedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("option", { name: "src/app.ts" })).toBeTruthy();
  });

  it("变更状态筛选覆盖全部/修改/新增与未跟踪/删除/重命名，不改分组真实计数并支持清除", async () => {
    const { onStageAll } = renderList();
    const filterBtn = screen.getByRole("button", { name: "按变更状态筛选" });
    expect(filterBtn.getAttribute("data-active")).toBeNull();

    // 筛选「新增与未跟踪」：命中 untracked (src/new-untracked.ts) 和 staged added (docs/added.md)
    await fireEvent.click(filterBtn);
    await fireEvent.click(screen.getByRole("menuitemradio", { name: "新增与未跟踪" }));

    expect(filterBtn.getAttribute("data-active")).toBe("true");
    expect(screen.getByText("状态：新增与未跟踪")).toBeTruthy();
    const visibleNames = screen.getAllByRole("option").map((el) => el.getAttribute("aria-label"));
    expect(visibleNames).toEqual(["src/new-untracked.ts", "docs/added.md"]);

    // 分组头真实计数与全部暂存范围不受筛选影响
    expect(screen.getByRole("button", { name: "未暂存的改动（3）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "已暂存（2）" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "全部暂存" }));
    expect(onStageAll).toHaveBeenCalledWith(["src/app.ts", "src/new-untracked.ts", "src/old.ts"]);

    // 切换为「重命名」
    await fireEvent.click(filterBtn);
    await fireEvent.click(screen.getByRole("menuitemradio", { name: "重命名" }));
    expect(screen.getAllByRole("option").map((el) => el.getAttribute("aria-label"))).toEqual(["src/renamed.ts"]);

    // 清除状态筛选后恢复全部 6 条
    await fireEvent.click(screen.getByRole("button", { name: "清除状态筛选" }));
    expect(screen.getAllByRole("option")).toHaveLength(6);
    expect(filterBtn.getAttribute("data-active")).toBeNull();
  });

  it("状态筛选与搜索、目录模式、隐藏已审阅组合生效，无匹配时给出带清除按钮的空状态", async () => {
    const { rerender } = renderList({
      query: "src/",
      reviewed: new Set(["src/app.ts"]),
      hideReviewed: true,
      onHideReviewed: vi.fn(),
    });

    // 切换到目录分组模式
    await fireEvent.click(screen.getByRole("button", { name: "目录" }));
    // 开启状态筛选「修改」：src/app.ts 虽是修改但已审阅被隐藏，命中 0 条
    await fireEvent.click(screen.getByRole("button", { name: "按变更状态筛选" }));
    await fireEvent.click(screen.getByRole("menuitemradio", { name: "修改" }));

    expect(screen.getByText("没有符合「修改」的文件")).toBeTruthy();
    expect(screen.queryByText("工作区很干净")).toBeNull();

    // 取消隐藏已审阅后，src/app.ts 在目录模式下恢复可见
    await rerender({
      files: SAMPLE_FILES,
      selected: { path: "src/app.ts", side: "unstaged" },
      selectedSet: [],
      query: "src/",
      disabled: false,
      reviewed: new Set(["src/app.ts"]),
      hideReviewed: false,
      onHideReviewed: vi.fn(),
      onQuery: vi.fn(),
      onSelect: vi.fn(),
      onStage: vi.fn(),
      onUnstage: vi.fn(),
    });
    expect(screen.getAllByRole("option").map((el) => el.getAttribute("aria-label"))).toEqual(["src/app.ts"]);
    expect(document.querySelector(".dir-name")?.textContent).toContain("src");
  });

  it("多选 ≥2 项时展示紧凑批量操作条，排除冲突文件并支持暂存/取消暂存/放弃/复制路径/退出多选", async () => {
    // 单选不渲染批量操作条
    const { rerender, onBatchStage, onBatchUnstage, onBatchDiscard, onBatchCopyPaths, onClearMultiSelect } =
      renderList({
        selectedSet: [{ path: "src/app.ts", side: "unstaged" }],
      });
    expect(screen.queryByRole("region", { name: "多选批量操作" })).toBeNull();

    const multiSet: FileSelection[] = [
      { path: "src/conflict.ts", side: "unstaged" },
      { path: "src/app.ts", side: "unstaged" },
      { path: "docs/added.md", side: "staged" },
    ];
    await rerender({
      files: SAMPLE_FILES,
      selected: multiSet[1],
      selectedSet: multiSet,
      query: "",
      disabled: false,
      onQuery: vi.fn(),
      onSelect: vi.fn(),
      onMultiSelect: vi.fn(),
      onStage: vi.fn(),
      onUnstage: vi.fn(),
      onBatchStage,
      onBatchUnstage,
      onBatchDiscard,
      onBatchCopyPaths,
      onClearMultiSelect,
    });
    await tick();

    const bar = screen.getByRole("region", { name: "多选批量操作" });
    expect(bar.textContent).toContain("已选中 3 项");
    expect(bar.textContent).toContain("含 1 个冲突");

    await fireEvent.click(screen.getByRole("button", { name: "批量暂存" }));
    expect(onBatchStage).toHaveBeenCalledWith(["src/app.ts"]);

    await fireEvent.click(screen.getByRole("button", { name: "批量取消暂存" }));
    expect(onBatchUnstage).toHaveBeenCalledWith(["docs/added.md"]);

    await fireEvent.click(screen.getByRole("button", { name: "批量放弃修改" }));
    expect(onBatchDiscard).toHaveBeenCalledWith(["src/app.ts", "docs/added.md"]);

    await fireEvent.click(screen.getByRole("button", { name: "复制已选路径" }));
    expect(onBatchCopyPaths).toHaveBeenCalledWith(["src/conflict.ts", "src/app.ts", "docs/added.md"]);

    await fireEvent.click(screen.getByRole("button", { name: "退出多选" }));
    expect(onClearMultiSelect).toHaveBeenCalledTimes(1);
  });

  it("聚焦分组折叠按钮或组级动作按钮按 Space 时不被列表 onKey 拦截，不误触当前文件暂存", async () => {
    const { onStage, onUnstage } = renderList();
    const unstagedToggle = screen.getByRole("button", { name: "未暂存的改动（3）" });
    unstagedToggle.focus();
    const toggleSpace = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    unstagedToggle.dispatchEvent(toggleSpace);
    expect(toggleSpace.defaultPrevented).toBe(false);
    expect(onStage).not.toHaveBeenCalled();
    expect(onUnstage).not.toHaveBeenCalled();

    const stageAllBtn = screen.getByRole("button", { name: "全部暂存" });
    stageAllBtn.focus();
    const actionSpace = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    stageAllBtn.dispatchEvent(actionSpace);
    expect(actionSpace.defaultPrevented).toBe(false);
    expect(onStage).not.toHaveBeenCalled();
  });

  it("窄左栏下状态筛选菜单的固定定位向左钳位到安全边距，不溢出视口左侧", async () => {
    renderList();
    const origWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    try {
      const filterBtn = screen.getByRole("button", { name: "按变更状态筛选" });
      vi.spyOn(filterBtn, "getBoundingClientRect").mockReturnValue({
        left: 80,
        right: 110,
        top: 40,
        bottom: 66,
        width: 30,
        height: 26,
        x: 80,
        y: 40,
        toJSON: () => ({}),
      });
      await fireEvent.click(filterBtn);
      const menu = screen.getByRole("menu", { name: "变更状态筛选" }) as HTMLElement;
      expect(menu.style.left).toBe("8px");
      expect(menu.style.right).toBe("auto");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: origWidth });
    }
  });
});
