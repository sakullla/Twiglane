import { describe, expect, it } from "vitest";
import { MODIFIER_LABEL } from "../src/lib/brand";
import { COMMANDS, commandAvailable, commandById, commandReason, paletteItems, type CommandState } from "../src/lib/commands";
import { shortcutCommand } from "../src/lib/shortcuts";

function state(overrides: Partial<CommandState> = {}): CommandState {
  return {
    hasRepo: true,
    workspaceView: "changes",
    taskModal: null,
    sidebarHidden: false,
    writeLocked: false,
    writing: false,
    reading: false,
    switchingBlocked: false,
    upstreamMissing: false,
    stagedCount: 0,
    stageTargets: [],
    unstageTargets: [],
    draft: "",
    theme: "dark",
    recentRepos: [],
    ...overrides,
  };
}

describe("视图命令", () => {
  it("三个视图按改动、文件、历史的顺序注册，文件用数字 3", () => {
    const ids = COMMANDS.filter((command) => command.group === "视图").map((command) => command.id);
    expect(ids.slice(0, 3)).toEqual(["view.changes", "view.files", "view.history"]);
    const files = commandById("view.files")!;
    expect(files.title).toBe("文件");
    expect(files.shortcut).toBe(`${MODIFIER_LABEL} 3`);
    // 原快捷键不变：改动 1、历史 2。
    expect(commandById("view.changes")!.shortcut).toBe(`${MODIFIER_LABEL} 1`);
    expect(commandById("view.history")!.shortcut).toBe(`${MODIFIER_LABEL} 2`);
  });

  it("没有仓库时文件视图不可用，原因与其它视图同源", () => {
    const files = commandById("view.files")!;
    expect(commandAvailable(files, state({ hasRepo: false }))).toBe(false);
    expect(commandReason(files, state({ hasRepo: false }))).toBe("先打开一个仓库");
    expect(commandAvailable(files, state())).toBe(true);
  });

  it("数字键映射保持原意并把 3 交给文件视图", () => {
    expect(shortcutCommand({ key: "1", ctrlKey: true })).toBe("view.changes");
    expect(shortcutCommand({ key: "2", ctrlKey: true })).toBe("view.history");
    expect(shortcutCommand({ key: "3", ctrlKey: true })).toBe("view.files");
    expect(shortcutCommand({ key: "3", metaKey: true })).toBe("view.files");
    // Shift 仍然不参与数字视图切换。
    expect(shortcutCommand({ key: "3", ctrlKey: true, shiftKey: true })).toBeNull();
  });

  it("命令面板里三个视图连续出现，文件在改动与历史之间", () => {
    const titles = paletteItems(state()).filter((item) => item.group === "视图").map((item) => item.title);
    expect(titles.slice(0, 3)).toEqual(["改动", "文件", "提交历史"]);
  });

  it("文件视图的上下文件切换读文件视图自己的导航状态", () => {
    const nav = { prevReason: null, nextReason: "已经是最后一个文件" };
    const prev = commandById("file.prev")!;
    const next = commandById("file.next")!;
    expect(commandAvailable(prev, state({ workspaceView: "files", fileNav: { prevReason: null, nextReason: "已经是最后一个文件" } }))).toBe(true);
    expect(commandAvailable(next, state({ workspaceView: "files", fileNav: nav }))).toBe(false);
    expect(commandReason(next, state({ workspaceView: "files", fileNav: nav }))).toBe("已经是最后一个文件");
    expect(commandAvailable(prev, state({ workspaceView: "files", fileNav: null }))).toBe(false);
  });
});
