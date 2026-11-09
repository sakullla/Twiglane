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
  it("视图按改动、文件、历史、任务的顺序注册，文件用数字 3、任务用 4", () => {
    const ids = COMMANDS.filter((command) => command.group === "视图").map((command) => command.id);
    expect(ids.slice(0, 3)).toEqual(["view.changes", "view.files", "view.history"]);
    const files = commandById("view.files")!;
    expect(files.title).toBe("文件");
    expect(files.shortcut).toBe(`${MODIFIER_LABEL} 3`);
    // 原快捷键不变：改动 1、历史 2。
    expect(commandById("view.changes")!.shortcut).toBe(`${MODIFIER_LABEL} 1`);
    expect(commandById("view.history")!.shortcut).toBe(`${MODIFIER_LABEL} 2`);
    expect(commandById("view.task")!.shortcut).toBe(`${MODIFIER_LABEL} 4`);
  });

  it("没有仓库时文件视图不可用，原因与其它视图同源", () => {
    const files = commandById("view.files")!;
    expect(commandAvailable(files, state({ hasRepo: false }))).toBe(false);
    expect(commandReason(files, state({ hasRepo: false }))).toBe("先打开一个仓库");
    expect(commandAvailable(files, state())).toBe(true);
  });

  it("设置里关闭文件视图后，文件视图的入口都不可用并说明原因；其它视图不受影响", () => {
    const off = state({ filesViewEnabled: false, currentFilePath: "src/a.ts" });
    for (const id of ["view.files", "files.quickOpen", "files.search", "file.reveal"]) {
      const command = commandById(id)!;
      expect(commandAvailable(command, off), id).toBe(false);
      expect(commandReason(command, off), id).toBe("文件视图已在设置里关闭");
    }
    expect(commandAvailable(commandById("view.changes")!, off)).toBe(true);
    expect(commandAvailable(commandById("view.history")!, off)).toBe(true);
    expect(commandAvailable(commandById("file.reveal")!, state({ currentFilePath: "src/a.ts" }))).toBe(true);
  });

  it("数字键映射保持原意并把 3 交给文件视图", () => {
    expect(shortcutCommand({ key: "1", ctrlKey: true })).toBe("view.changes");
    expect(shortcutCommand({ key: "2", ctrlKey: true })).toBe("view.history");
    expect(shortcutCommand({ key: "3", ctrlKey: true })).toBe("view.files");
    expect(shortcutCommand({ key: "3", metaKey: true })).toBe("view.files");
    expect(shortcutCommand({ key: "4", ctrlKey: true })).toBe("view.task");
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
describe("文件导航命令", () => {
  it("路径打开、全文搜索、在文件树中显示与新快捷键都登记在注册表里", () => {
    const ids = COMMANDS.filter((command) => command.group === "视图").map((command) => command.id);
    expect(ids).toEqual([
      "view.changes",
      "view.files",
      "view.history",
      "view.task",
      "file.prev",
      "file.next",
      "review.prev",
      "review.next",
      "review.toggle",
      "review.hide",
      "diff.hunk.prev",
      "diff.hunk.next",
      "view.find",
      "files.quickOpen",
      "files.search",
      "file.reveal",
      "file.back",
      "file.forward",
    ]);
    expect(commandById("files.quickOpen")!.shortcut).toBe(`${MODIFIER_LABEL} P`);
    expect(commandById("file.back")!.shortcut).toBe(`${MODIFIER_LABEL} ⇧ ←`);
    expect(commandById("file.forward")!.shortcut).toBe(`${MODIFIER_LABEL} ⇧ →`);
  });

  it("没有选中文件时「在文件树中显示」给出原因，有选中时可执行", () => {
    const reveal = commandById("file.reveal")!;
    expect(commandAvailable(reveal, state({ currentFilePath: null }))).toBe(false);
    expect(commandReason(reveal, state({ currentFilePath: null }))).toBe("先在改动里选择一个文件");
    expect(commandReason(reveal, state({ hasRepo: false }))).toBe("先打开一个仓库");
    expect(commandAvailable(reveal, state({ currentFilePath: "src/App.svelte" }))).toBe(true);
  });

  it("后退/前进只有文件视图提供历史，到头时原因来自同一份状态", () => {
    const back = commandById("file.back")!;
    const forward = commandById("file.forward")!;
    expect(commandAvailable(back, state())).toBe(false);
    expect(commandReason(back, state())).toBe("文件视图里才有打开历史");

    const atStart = state({ workspaceView: "files", fileHistory: { backReason: "已经是本次会话的第一个文件", forwardReason: null } });
    expect(commandAvailable(back, atStart)).toBe(false);
    expect(commandReason(back, atStart)).toBe("已经是本次会话的第一个文件");
    expect(commandAvailable(forward, atStart)).toBe(true);

    const atEnd = state({ workspaceView: "files", fileHistory: { backReason: null, forwardReason: "已经是最新打开的文件" } });
    expect(commandAvailable(forward, atEnd)).toBe(false);
    expect(commandReason(forward, atEnd)).toBe("已经是最新打开的文件");
  });

  it("新快捷键不覆盖原有的文件、改动块与聚焦搜索组合", () => {
    expect(shortcutCommand({ key: "p", ctrlKey: true })).toBe("files.quickOpen");
    expect(shortcutCommand({ key: "ArrowLeft", ctrlKey: true, shiftKey: true })).toBe("file.back");
    expect(shortcutCommand({ key: "ArrowRight", metaKey: true, shiftKey: true })).toBe("file.forward");
    // 原有组合原样保留。
    expect(shortcutCommand({ key: "ArrowLeft", altKey: true })).toBe("file.prev");
    expect(shortcutCommand({ key: "ArrowUp", altKey: true })).toBe("diff.hunk.prev");
    expect(shortcutCommand({ key: "f", ctrlKey: true })).toBe("view.find");
    // 未登记的 ⌘⇧ 组合仍不匹配。
    expect(shortcutCommand({ key: "k", metaKey: true, shiftKey: true })).toBeNull();
    // 未审阅队列占用 Alt+Shift+←/→ 与 Alt+M；⌘/Ctrl+Alt 组合仍然不匹配。
    expect(shortcutCommand({ key: "ArrowLeft", altKey: true, shiftKey: true })).toBe("review.prev");
    expect(shortcutCommand({ key: "ArrowRight", altKey: true, shiftKey: true })).toBe("review.next");
    expect(shortcutCommand({ key: "m", altKey: true })).toBe("review.toggle");
    expect(shortcutCommand({ key: "ArrowRight", altKey: true, ctrlKey: true })).toBeNull();
  });

  it("未审阅队列的四个命令读同一份状态，原因与队尾语义一致", () => {
    const queue = {
      prevReason: "已经是第一个未审阅文件",
      nextReason: "没有更多未审阅文件",
      toggleReason: null,
      reviewed: false,
      hideReason: null,
      hidden: false,
      remaining: 2,
      total: 4,
      scope: "changes" as const,
    };
    const at = state({ review: queue });
    expect(commandAvailable(commandById("review.prev")!, at)).toBe(false);
    expect(commandReason(commandById("review.prev")!, at)).toBe("已经是第一个未审阅文件");
    expect(commandAvailable(commandById("review.next")!, at)).toBe(false);
    expect(commandReason(commandById("review.next")!, at)).toBe("没有更多未审阅文件");
    expect(commandAvailable(commandById("review.toggle")!, at)).toBe(true);
    expect(commandAvailable(commandById("review.hide")!, at)).toBe(true);
    // 没有选中文件时标记就地说明原因。
    const noFile = state({ review: { ...queue, toggleReason: "先选择一个文件" } });
    expect(commandAvailable(commandById("review.toggle")!, noFile)).toBe(false);
    expect(commandReason(commandById("review.toggle")!, noFile)).toBe("先选择一个文件");
    // 没有审阅范围（例如没有打开仓库）时四个命令都不可用。
    expect(commandAvailable(commandById("review.next")!, state({ review: null }))).toBe(false);
    expect(commandReason(commandById("review.next")!, state({ review: null }))).toBe("当前视图没有审阅队列");
    expect(commandReason(commandById("review.next")!, state({ review: null, hasRepo: false }))).toBe("先打开一个仓库");

    // 整文件暂存只在真实状态有可写一侧时可用。
    expect(commandAvailable(commandById("stage.file")!, state({ fileStage: { path: "a.ts", side: "unstaged", reason: null } }))).toBe(true);
    expect(commandAvailable(commandById("stage.file")!, state({ fileStage: { path: "a.ts", side: "staged", reason: null } }))).toBe(false);
    expect(commandReason(commandById("stage.file")!, state({ fileStage: { path: "a.ts", side: "staged", reason: null } }))).toBe(
      "当前文件没有可暂存的真实改动",
    );
    expect(commandReason(commandById("unstage.file")!, state({ fileStage: { path: null, side: "none", reason: null } }))).toBe(
      "先选择一个文件",
    );
  });
});
