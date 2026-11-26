import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import {
  getRecentBranches,
  previousRecentBranch,
  recordRecentBranch,
  removeRecentBranch,
  renameRecentBranch,
  resetRecentBranchesMemory,
} from "../src/lib/recent-branches";
import ShortcutHelpModal, { buildShortcutSections, filterShortcutSections } from "../src/lib/components/ShortcutHelpModal.svelte";
import BranchSwitcher from "../src/lib/components/BranchSwitcher.svelte";
import { api } from "../src/lib/api";
import type { BranchListing, OpenedRepository } from "../src/lib/types";

function makeOpened(path = "/repo/demo", branch = "main"): OpenedRepository {
  return {
    summary: { path, name: "demo", remotePath: null },
    generation: 1,
    snapshot: {
      generation: 1,
      branch: {
        name: branch,
        headOid: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
        detached: false,
        unborn: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        liveRemoteChecked: false,
        remoteCheckStale: false,
        remoteCheckedAtMs: null,
      },
      files: [],
    },
  } as unknown as OpenedRepository;
}

describe("recent-branches 持久化与内存退化", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRecentBranchesMemory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("按规范化仓库路径隔离记忆，去重、最新在前、上限 5 条并排除当前分支", () => {
    recordRecentBranch("/repo/a/", "b1");
    recordRecentBranch("/repo/a", "b2");
    recordRecentBranch("/repo/a", "b3");
    recordRecentBranch("/repo/a", "b4");
    recordRecentBranch("/repo/a", "b5");
    recordRecentBranch("/repo/a", "b6");
    recordRecentBranch("/repo/a", "b2"); // 去重并提前
    recordRecentBranch("/repo/b", "other");

    expect(getRecentBranches("/repo/a")).toEqual(["b2", "b6", "b5", "b4", "b3"]);
    expect(getRecentBranches("/repo/a", "b2")).toEqual(["b6", "b5", "b4", "b3"]);
    expect(getRecentBranches("/repo/b")).toEqual(["other"]);
    expect(previousRecentBranch("/repo/a", "main", ["b5", "b3"])).toBe("b5");
  });

  it("支持重命名同步与删除清理", () => {
    recordRecentBranch("/repo/a", "feat/old");
    recordRecentBranch("/repo/a", "fix/one");
    renameRecentBranch("/repo/a", "feat/old", "feat/new");
    expect(getRecentBranches("/repo/a")).toEqual(["fix/one", "feat/new"]);

    removeRecentBranch("/repo/a", "fix/one");
    expect(getRecentBranches("/repo/a")).toEqual(["feat/new"]);
  });

  it("localStorage 不可用时静默退化为会话内存", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    recordRecentBranch("/repo/mem", "feat/a");
    recordRecentBranch("/repo/mem", "feat/b");
    expect(getRecentBranches("/repo/mem", "main")).toEqual(["feat/b", "feat/a"]);
  });
});

describe("BranchSwitcher 最近访问分区", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRecentBranchesMemory();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("顶部展示最近访问本地分支，自动过滤已删除分支且默认游标落上一分支", async () => {
    recordRecentBranch("/repo/demo", "feat/deleted");
    recordRecentBranch("/repo/demo", "feat/older");
    recordRecentBranch("/repo/demo", "feat/prev");

    const listing: BranchListing = {
      generation: 1,
      defaultBranch: "main",
      mergeBases: ["main"],
      branches: [
        { name: "main", remote: false, current: true, upstream: null, worktree: null },
        { name: "feat/alpha", remote: false, current: false, upstream: null, worktree: null },
        { name: "feat/older", remote: false, current: false, upstream: null, worktree: null },
        { name: "feat/prev", remote: false, current: false, upstream: null, worktree: null },
      ],
    };
    vi.spyOn(api, "branchList").mockResolvedValue(listing);
    vi.spyOn(api, "branchTracking").mockResolvedValue({ generation: 1, branches: [] });

    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    let serial = 1;

    render(BranchSwitcher, {
      props: {
        anchor,
        opened: makeOpened("/repo/demo", "main"),
        blockedReason: null,
        nextId: () => ++serial,
        onBusy: () => {},
        onGeneration: () => {},
        onSnapshot: () => {},
        onFailure: () => {},
        onNotice: () => {},
        onCommand: () => {},
        onCreateBranch: () => {},
        onClose: () => {},
      },
    });

    await waitFor(() => {
      expect(screen.getByText("最近访问")).toBeTruthy();
    });

    // 已删除的 feat/deleted 不会出现在列表里
    expect(screen.queryByText("feat/deleted")).toBeNull();

    // 默认游标落在最近访问首项（feat/prev）
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("feat/prev");
    const search = screen.getByRole("combobox");
    expect(search.getAttribute("aria-activedescendant")).toBe(options[0].id);

    // 输入搜索词后收起最近访问分区，正常搜索过滤
    await fireEvent.input(search, { target: { value: "alpha" } });
    await waitFor(() => {
      expect(screen.queryByText("最近访问")).toBeNull();
    });
    expect(screen.getAllByRole("option").some((opt) => opt.textContent?.includes("feat/alpha"))).toBe(true);

    anchor.remove();
  });
});

describe("ShortcutHelpModal 快捷键一览面板", () => {
  afterEach(() => {
    cleanup();
  });

  it("与命令注册表同源生成分组并自适应平台键帽", () => {
    const macSections = buildShortcutSections("⌘");
    const winSections = buildShortcutSections("Ctrl");

    const macShortcuts = macSections.flatMap((s) => s.items);
    const winShortcuts = winSections.flatMap((s) => s.items);

    const macPalette = macShortcuts.find((item) => item.id === "palette.open");
    const winPalette = winShortcuts.find((item) => item.id === "palette.open");
    expect(macPalette?.keyGroups).toEqual([["⌘", "K"]]);
    expect(winPalette?.keyGroups).toEqual([["Ctrl", "K"]]);

    const macHelp = macShortcuts.find((item) => item.id === "dialog.shortcuts");
    const winHelp = winShortcuts.find((item) => item.id === "dialog.shortcuts");
    expect(macHelp?.keyGroups).toEqual([["⌘", "/"]]);
    expect(winHelp?.keyGroups).toEqual([["Ctrl", "/"]]);

    const macReview = macShortcuts.find((item) => item.id === "review.toggle");
    const winReview = winShortcuts.find((item) => item.id === "review.toggle");
    expect(macReview?.keyGroups).toEqual([["⌥", "M"]]);
    expect(winReview?.keyGroups).toEqual([["Alt", "M"]]);

    expect(filterShortcutSections(winSections, "终端").flatMap((s) => s.items).length).toBeGreaterThan(0);
    expect(filterShortcutSections(winSections, "不存在的关键词xyz")).toHaveLength(0);
  });

  it("⌘ / 与 Ctrl / 渲染为字面 <kbd>/</kbd> 而非“或”，多组快捷键才显示“或”分隔", () => {
    const winView = render(ShortcutHelpModal, {
      props: { onClose: () => {}, modifierLabel: "Ctrl" },
    });
    const winRow = winView.container.querySelector('[data-shortcut-id="dialog.shortcuts"]')!;
    expect([...winRow.querySelectorAll("kbd")].map((node) => node.textContent)).toEqual(["Ctrl", "/"]);
    expect(winRow.querySelector(".shortcut-or")).toBeNull();

    const multiRow = winView.container.querySelector('[data-shortcut-id="files.multi"]')!;
    expect(multiRow.querySelector(".shortcut-or")?.textContent).toBe("或");
    expect([...multiRow.querySelectorAll("kbd")].map((node) => node.textContent)).toEqual(["Ctrl", "点击", "⇧", "点击"]);
    cleanup();

    const macView = render(ShortcutHelpModal, {
      props: { onClose: () => {}, modifierLabel: "⌘" },
    });
    const macRow = macView.container.querySelector('[data-shortcut-id="dialog.shortcuts"]')!;
    expect([...macRow.querySelectorAll("kbd")].map((node) => node.textContent)).toEqual(["⌘", "/"]);
    expect(macRow.querySelector(".shortcut-or")).toBeNull();
  });

  it("支持搜索过滤、清空搜索与 Esc 归还焦点", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "触发按钮";
    document.body.appendChild(trigger);
    trigger.focus();

    const onClose = vi.fn();
    render(ShortcutHelpModal, {
      props: {
        onClose,
        returnFocus: trigger,
        modifierLabel: "Ctrl",
      },
    });

    const dialog = screen.getByRole("dialog", { name: "快捷键一览" });
    expect(dialog).toBeTruthy();

    const input = screen.getByRole("searchbox", { name: "搜索快捷键" }) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "不存在的快捷键xyz" } });
    expect(screen.getByText("没有匹配的快捷键")).toBeTruthy();

    // 第一次 Esc 清空搜索，不关闭弹窗
    await fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();

    // 第二次 Esc 关闭弹窗
    await fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    trigger.remove();
  });
});
