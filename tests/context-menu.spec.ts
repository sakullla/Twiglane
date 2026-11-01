import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLine, DiffResponse, FileChange, StatusSnapshot } from "../src/lib/types";
import { commitScope, groupFiles } from "../src/lib/labels";

const repoPath = "C:/work/demo";
const branch = {
  name: "main",
  detached: false,
  unborn: false,
  headOid: "a".repeat(40),
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  liveRemoteChecked: true,
  remoteCheckedAtMs: 1,
  remoteCheckStale: false,
};

function change(path: string, staged: FileChange["staged"], unstaged: FileChange["unstaged"], extra: Partial<FileChange> = {}): FileChange {
  return { path, originalPath: null, staged, unstaged, untracked: false, unmerged: false, ...extra };
}

const files: FileChange[] = [
  change("src/App.svelte", "none", "modified"),
  change("src/app.css", "modified", "none"),
  change("notes/todo.log", "none", "none", { untracked: true }),
  change("src/merge.ts", "unmerged", "unmerged", { unmerged: true }),
];
const snapshot: StatusSnapshot = { generation: 4, branch, files };

function diffFor(path: string, staged: boolean): DiffResponse {
  const lines: DiffLine[] = [
    { kind: "hunk", text: "@@ -1,2 +1,2 @@", oldNo: null, newNo: null, hunkIndex: 0 },
    { kind: "context", text: " keep", oldNo: 1, newNo: 1, hunkIndex: 0 },
    { kind: "del", text: "-const a = 1;", oldNo: 2, newNo: null, hunkIndex: 0 },
    { kind: "add", text: "+const a = 2;", oldNo: null, newNo: 2, hunkIndex: 0 },
  ];
  return {
    generation: 4,
    path,
    staged,
    binary: false,
    text: null,
    summary: "",
    additions: 1,
    deletions: 1,
    complete: true,
    truncated: false,
    snapshot: "s",
    hunks: [{ index: 0, header: "@@ -1,2 +1,2 @@", complete: true, stageable: true, startLine: 0, lineCount: 4 }],
    lines,
    offset: 0,
    totalLines: lines.length,
  };
}

const mocks = vi.hoisted(() => {
  const names = [
    "getSettings", "openRepository", "addRepository", "createRepository", "closeRepository", "forgetRecent",
    "refreshStatus", "loadDiff", "stageFiles", "unstageFiles", "stageHunks", "commitChanges", "commitAndPush",
    "fetchRemote", "pullFastForward", "pushBranch", "publishBranch", "associateUpstream", "mergeSession",
    "saveDraft", "setTheme", "setPanelWidths", "cancelReads", "historyPage", "commitDetail", "commitFileDiff",
    "fileHistory", "discardChanges", "undoCommit", "detectGit", "setGitExecutable", "clearGitExecutable",
    "cloneRepository", "remoteState", "branchState", "tagState", "stashState", "measureProbe", "measureSample",
    "measureFinish", "measureWait", "revealPath", "openPath", "ignorePath", "listenEvent", "pickDirectory", "pickFile",
  ];
  return Object.fromEntries(names.map((name) => [name, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>;
});

vi.mock("../src/lib/api", () => ({
  api: { ...mocks },
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));

import App from "../src/App.svelte";

const writeText = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  mocks.getSettings.mockResolvedValue({
    theme: "dark",
    panelWidths: { sidebar: 256, files: 360 },
    git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "ok" },
    recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }],
    settingsWarning: null,
  });
  mocks.listenEvent.mockResolvedValue(() => {});
  mocks.openRepository.mockResolvedValue({ summary: { name: "demo", path: repoPath }, generation: 4, snapshot, draft: "", watchDegraded: false });
  mocks.refreshStatus.mockResolvedValue(snapshot);
  mocks.loadDiff.mockImplementation(async (_repo: string, path: string, staged: boolean) => diffFor(path, staged));
  mocks.mergeSession.mockResolvedValue({ generation: 4, operation: "none", canContinue: false, canAbort: false, source: null, target: "main", headOid: null, conflicts: [], unresolved: 0, note: "", snapshot });
  mocks.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
  mocks.saveDraft.mockResolvedValue(undefined);
  mocks.revealPath.mockResolvedValue(undefined);
  mocks.openPath.mockResolvedValue(undefined);
  mocks.ignorePath.mockResolvedValue({ ...snapshot, generation: 5, files: files.filter((file) => !file.untracked) });
  mocks.discardChanges.mockImplementation(async (_repo: string, paths: string[], confirm: boolean) => ({
    generation: 4,
    wrote: confirm,
    boundary: "确认只影响所选文件。取消不写入。",
    snapshot,
    files: paths.map((path) => ({ path, originalPath: null, staged: "none", unstaged: "modified", untracked: false, impact: "回到当前提交。", recovery: "不能找回。" })),
  }));
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function openRepo() {
  render(App);
  await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
  await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
  await waitFor(() => expect(document.querySelector(".file-list")).toBeTruthy());
}

function row(path: string): HTMLElement {
  const name = path.split("/").pop() ?? path;
  const found = [...document.querySelectorAll<HTMLElement>(".file-row")].find((element) => element.querySelector(".fn")?.textContent === name);
  if (!found) throw new Error(`没有 ${path} 这一行`);
  return found;
}

async function rightClick(element: Element) {
  await fireEvent.contextMenu(element, { clientX: 200, clientY: 150 });
  return screen.getByRole("menu");
}

describe("改动分组", () => {
  it("冲突文件单独成组，不再同时出现在未暂存和已暂存里；已暂存数与提交范围一致", () => {
    const groups = groupFiles(files);
    expect(groups.conflicted.map((file) => file.path)).toEqual(["src/merge.ts"]);
    expect(groups.unstaged.map((file) => file.path)).toEqual(["src/App.svelte", "notes/todo.log"]);
    expect(groups.staged.map((file) => file.path)).toEqual(["src/app.css"]);
    expect(commitScope("main", files).paths).toHaveLength(groups.staged.length);
  });
});

describe("文件右键菜单", () => {
  it("列出常用操作；放弃更改走影响清单确认，只针对这个文件", async () => {
    await openRepo();
    const menu = await rightClick(row("src/App.svelte"));
    const labels = within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim());
    for (const label of ["暂存", "放弃更改…", "查看完整文件", "查看文件历史", "用默认程序打开", "复制相对路径", "复制完整路径", "复制文件名"]) {
      expect(labels.some((text) => text?.startsWith(label)), label).toBe(true);
    }
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /放弃更改/ }));
    await screen.findByRole("dialog", { name: "放弃文件修改" });
    expect(mocks.discardChanges).toHaveBeenLastCalledWith(repoPath, ["src/App.svelte"], false, 4, expect.any(Number));
    await fireEvent.click(screen.getByRole("button", { name: "确认放弃所选" }));
    await waitFor(() => expect(mocks.discardChanges).toHaveBeenLastCalledWith(repoPath, ["src/App.svelte"], true, 4, expect.any(Number)));
  });

  it("复制路径、在文件管理器中显示与打开都作用在这一行", async () => {
    await openRepo();
    await fireEvent.click(within(await rightClick(row("src/App.svelte"))).getByRole("menuitem", { name: "复制相对路径" }));
    expect(writeText).toHaveBeenLastCalledWith("src/App.svelte");
    await fireEvent.click(within(await rightClick(row("src/App.svelte"))).getByRole("menuitem", { name: "复制完整路径" }));
    expect(writeText).toHaveBeenLastCalledWith("C:/work/demo/src/App.svelte");
    await fireEvent.click(within(await rightClick(row("src/App.svelte"))).getByRole("menuitem", { name: /中显示/ }));
    expect(mocks.revealPath).toHaveBeenCalledWith(repoPath, "src/App.svelte");
    await fireEvent.click(within(await rightClick(row("src/App.svelte"))).getByRole("menuitem", { name: "用默认程序打开" }));
    expect(mocks.openPath).toHaveBeenCalledWith(repoPath, "src/App.svelte");
  });

  it("未跟踪文件可以加入 .gitignore（按文件、扩展名或目录）", async () => {
    await openRepo();
    const menu = await rightClick(row("notes/todo.log"));
    expect(within(menu).getByRole("menuitem", { name: "忽略所有 .log 文件" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "忽略目录 notes/" })).toBeTruthy();
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "忽略此文件（/notes/todo.log）" }));
    await waitFor(() => expect(mocks.ignorePath).toHaveBeenCalledWith(repoPath, "/notes/todo.log", 4, expect.any(Number)));
  });

  it("冲突文件的菜单给出处理冲突而不是暂存或放弃；分组头可直接去处理", async () => {
    await openRepo();
    expect(document.querySelector(".file-group")?.textContent).toContain("冲突");
    const menu = await rightClick(row("src/merge.ts"));
    expect(within(menu).getByRole("menuitem", { name: "处理冲突…" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: /放弃更改/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /^暂存/ })).toBeNull();
  });

  it("键盘：菜单键打开、方向键移动、Esc 关闭并把焦点还给文件列表", async () => {
    await openRepo();
    const list = document.querySelector<HTMLElement>(".file-list")!;
    list.focus();
    await fireEvent.keyDown(list, { key: "ContextMenu" });
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    await fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    await fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(list);
  });
});

describe("仓库弹层的仓库操作", () => {
  const other = "D:/code/other";

  async function openPopover() {
    mocks.getSettings.mockResolvedValue({
      theme: "dark",
      panelWidths: { sidebar: 256, files: 360 },
      git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "ok" },
      recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }, { name: "other", path: other, openedAtMs: 2 }],
      settingsWarning: null,
    });
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: "当前仓库 demo" }));
    return screen.findByRole("dialog", { name: "切换仓库" });
  }

  it("右键菜单叠在弹层上：复制路径后弹层还在，Esc 只关菜单这一层", async () => {
    const popover = await openPopover();
    const search = within(popover).getByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(search));
    const option = within(popover).getByRole("option", { name: /other/ });
    await fireEvent.contextMenu(option, { clientX: 40, clientY: 90 });
    let menu = screen.getByRole("menu", { name: "other 的操作" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "打开",
      "在资源管理器中显示",
      "复制完整路径",
      "从最近列表移除",
    ]);
    // 点菜单不算点外面。
    await fireEvent.mouseDown(within(menu).getByRole("menuitem", { name: "复制完整路径" }));
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "复制完整路径" }));
    expect(writeText).toHaveBeenLastCalledWith(other);
    expect(screen.getByRole("dialog", { name: "切换仓库" })).toBe(popover);

    await fireEvent.contextMenu(option, { clientX: 40, clientY: 90 });
    menu = screen.getByRole("menu", { name: "other 的操作" });
    await fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "切换仓库" })).toBe(popover);
    await waitFor(() => expect(document.activeElement, "焦点回到搜索框").toBe(search));
  });

  it("键盘：菜单键打开当前项的菜单，打开动作切换仓库并收起弹层", async () => {
    mocks.openRepository.mockResolvedValue({ summary: { name: "demo", path: repoPath }, generation: 4, snapshot, draft: "", watchDegraded: false });
    const popover = await openPopover();
    const search = within(popover).getByRole("combobox");
    await fireEvent.keyDown(search, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "other 的操作" });
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "打开" }));
    await waitFor(() => expect(mocks.openRepository).toHaveBeenLastCalledWith(other, expect.any(Number)));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换仓库" })).toBeNull());
  });

  it("行内按钮和右键都能移除；移除不删文件，弹层留着显示剩下的仓库", async () => {
    mocks.forgetRecent.mockResolvedValue([{ name: "demo", path: repoPath, openedAtMs: 1 }]);
    const popover = await openPopover();
    await fireEvent.click(within(popover).getByRole("button", { name: "复制 other 的完整路径" }));
    expect(writeText).toHaveBeenLastCalledWith(other);
    await fireEvent.click(within(popover).getByRole("button", { name: "从列表移除 other" }));
    await waitFor(() => expect(mocks.forgetRecent).toHaveBeenCalledWith(other));
    await waitFor(() => expect(within(popover).getAllByRole("option")).toHaveLength(1));
    expect(mocks.closeRepository, "移除别的仓库不关闭当前仓库").not.toHaveBeenCalled();
    await fireEvent.keyDown(within(popover).getByRole("combobox"), { key: "ContextMenu" });
    await fireEvent.click(within(screen.getByRole("menu", { name: "demo 的操作" })).getByRole("menuitem", { name: "从最近列表移除" }));
    await waitFor(() => expect(mocks.forgetRecent).toHaveBeenLastCalledWith(repoPath));
  });
});

describe("起始页的最近仓库菜单", () => {
  async function startPageRow() {
    mocks.getSettings.mockResolvedValue({
      theme: "dark",
      panelWidths: { sidebar: 256, files: 360 },
      git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "" },
      recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }],
      settingsWarning: null,
    });
    render(App);
    await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
    return document.querySelector<HTMLButtonElement>(".welcome-recent button")!;
  }

  it("右键列出打开、显示、复制路径和移除，移除后列表回到空状态", async () => {
    mocks.forgetRecent.mockResolvedValue([]);
    const menu = await rightClick(await startPageRow());
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "打开",
      "在资源管理器中显示",
      "复制完整路径",
      "从最近列表移除",
    ]);
    expect(mocks.openRepository, "右键不会打开仓库").not.toHaveBeenCalled();
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "从最近列表移除" }));
    await waitFor(() => expect(mocks.forgetRecent).toHaveBeenCalledWith(repoPath));
    await waitFor(() => expect(screen.getByText("还没有最近仓库，先打开或克隆一个。")).toBeTruthy());
  });

  it("键盘菜单键同样打开菜单", async () => {
    await fireEvent.keyDown(await startPageRow(), { key: "ContextMenu" });
    expect(screen.getByRole("menu", { name: "demo 的操作" })).toBeTruthy();
  });
});

describe("差异区", () => {
  it("可展开为完整文件（按大上下文重新读取），展开后不提供按块暂存", async () => {
    await openRepo();
    await waitFor(() => expect(document.querySelector(".hunk-btn")).toBeTruthy());
    await fireEvent.click(screen.getByRole("button", { name: /只看改动/ }));
    await waitFor(() => expect(mocks.loadDiff.mock.calls.at(-1)?.[8]).toBe(1_000_000));
    await waitFor(() => expect(document.querySelector(".hunk-btn")).toBeNull());
    expect(localStorage.getItem("twiglane.diffFullFile")).toBe("1");
    // 右键里的「暂存此块」说明为什么现在不能用
    await fireEvent.contextMenu(document.querySelector("[data-line='3']")!, { clientX: 300, clientY: 200 });
    const stage = within(screen.getByRole("menu")).getByRole("menuitem", { name: "暂存此块" });
    expect(stage.getAttribute("aria-disabled")).toBe("true");
    expect(stage.getAttribute("title")).toContain("完整文件视图");
  });

  it("右键某个代码块可以直接暂存它", async () => {
    await openRepo();
    await waitFor(() => expect(document.querySelector("[data-line='3']")).toBeTruthy());
    await fireEvent.contextMenu(document.querySelector("[data-line='3']")!, { clientX: 300, clientY: 200 });
    mocks.stageHunks.mockResolvedValue(snapshot);
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "暂存此块" }));
    await waitFor(() => expect(mocks.stageHunks).toHaveBeenCalledTimes(1));
  });
});
