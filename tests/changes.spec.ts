import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommitDraft from "../src/lib/components/CommitDraft.svelte";
import DiffView from "../src/lib/components/DiffView.svelte";
import FileList from "../src/lib/components/FileList.svelte";
import MultiFileDiff from "../src/lib/components/MultiFileDiff.svelte";
import { shortcutCommand, isTextEntry } from "../src/lib/shortcuts";
import {
  batchSummary,
  batchTargets,
  blockTops,
  blockWindow,
  fileNavState,
  orderedRows,
  rangeSelection,
  toggleSelection,
} from "../src/lib/ui";
import type {
  DiffLine,
  DiffResponse,
  FileChange,
  FileRow,
  FileSelection,
  HistoryCommit,
  OpenedRepository,
  StatusSnapshot,
} from "../src/lib/types";

/* ------------------------------------------------------------------ *
 * App 级夹具：真实的 api 由下面的 vi.mock 顶替，界面走完整外壳。
 * ------------------------------------------------------------------ */

const repoPath = "C:/work/demo";

const branch = {
  name: "main",
  detached: false,
  unborn: false,
  headOid: "a".repeat(40),
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  liveRemoteChecked: true,
  remoteCheckedAtMs: 1,
  remoteCheckStale: false,
};

function change(
  path: string,
  staged: FileChange["staged"],
  unstaged: FileChange["unstaged"],
  extra: Partial<FileChange> = {},
): FileChange {
  return { path, originalPath: null, staged, unstaged, untracked: false, unmerged: false, ...extra };
}

const changes: FileChange[] = [
  change("src/App.svelte", "none", "modified"),
  change("src/app.css", "modified", "modified"),
  change("README.md", "modified", "none"),
  change("docs/start.md", "none", "deleted"),
  change("public/logo.png", "none", "modified"),
  change("src/lib/icon.ts", "none", "none", { untracked: true }),
];

const snapshot: StatusSnapshot = { generation: 4, branch, files: changes };

/** 60 行差异：足够让虚拟窗口在 1280×840 的预算里放进 40 行以上。 */
function diffFor(path: string, staged: boolean): DiffResponse {
  const lines: DiffLine[] = Array.from({ length: 60 }, (_, index) => ({
    kind: index % 7 === 0 ? "add" : index % 11 === 0 ? "del" : "context",
    text: `${index % 7 === 0 ? "+" : index % 11 === 0 ? "-" : " "}line-${index}`,
    oldNo: index + 1,
    newNo: index + 1,
    hunkIndex: 0,
  }));
  return {
    generation: 4,
    path,
    staged,
    binary: false,
    text: null,
    summary: "新增 9 行，删除 5 行。",
    additions: 9,
    deletions: 5,
    complete: true,
    truncated: false,
    snapshot: "snap",
    hunks: [{ index: 0, header: "@@ -1,60 +1,60 @@", complete: true, stageable: true, startLine: 0, lineCount: 60 }],
    lines,
    offset: 0,
    totalLines: lines.length,
  };
}

const commits: HistoryCommit[] = Array.from({ length: 12 }, (_, index) => ({
  oid: `${index.toString(16).padStart(4, "0")}${"a1b2c3d4".repeat(9)}`.slice(0, 40),
  parents: [`${(index + 100).toString(16).padStart(4, "0")}${"e5f6a7b8".repeat(9)}`.slice(0, 40)],
  summary: `提交 ${index}`,
  authorName: "Ada",
  authorEmail: "ada@example.com",
  authoredAt: 1_700_000_000 - index * 60,
  labels: [],
}));

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  openRepository: vi.fn(),
  addRepository: vi.fn(),
  createRepository: vi.fn(),
  closeRepository: vi.fn(),
  forgetRecent: vi.fn(),
  refreshStatus: vi.fn(),
  loadDiff: vi.fn(),
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  stageHunks: vi.fn(),
  commitChanges: vi.fn(),
  commitAndPush: vi.fn(),
  fetchRemote: vi.fn(),
  pullFastForward: vi.fn(),
  pushBranch: vi.fn(),
  publishBranch: vi.fn(),
  associateUpstream: vi.fn(),
  mergeSession: vi.fn(),
  saveDraft: vi.fn(),
  setTheme: vi.fn(),
  setPanelWidths: vi.fn(),
  cancelReads: vi.fn(),
  historyPage: vi.fn(),
  commitDetail: vi.fn(),
  commitFileDiff: vi.fn(),
  fileHistory: vi.fn(),
  discardChanges: vi.fn(),
  undoCommit: vi.fn(),
  detectGit: vi.fn(),
  setGitExecutable: vi.fn(),
  clearGitExecutable: vi.fn(),
  cloneRepository: vi.fn(),
  remoteState: vi.fn(),
  branchState: vi.fn(),
  tagState: vi.fn(),
  stashState: vi.fn(),
  measureProbe: vi.fn(),
  measureSample: vi.fn(),
  measureFinish: vi.fn(),
  measureWait: vi.fn(),
  listenEvent: vi.fn(),
  pickDirectory: vi.fn(),
  pickFile: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  api: { ...mocks },
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));

import App from "../src/App.svelte";
import { paletteItems, REPO_SWITCH_PREFIX, type CommandState } from "../src/lib/commands";
import { createTextDiff } from "../src/lib/diff";
import { RULER_LINES, RULER_SAMPLE_CHARS } from "../src/lib/layout";
import { codeLine } from "./helpers/code";

/* ------------------------------------------------------------------ *
 * 组件级夹具：只关心差异密度与提交区形状。
 * ------------------------------------------------------------------ */

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

const ROW_HEIGHT = 18;

/** 键盘层挂在 window 上，所以用真实事件派发；tick 保证 Svelte 已把状态刷进 DOM。 */
async function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }));
  await tick();
}

/**
 * 窗口宽度是左栏收紧的唯一输入：改 innerWidth 再派发 resize，模拟桌面窗口缩放。
 * 用 defineProperty 覆盖，afterEach 里删掉这条自有属性即可回到 happy-dom 的默认视口。
 */
function resizeTo(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

function renderApp() {
  return render(App);
}

/** 打开夹具仓库，并等到改动视图与差异都就绪。 */
async function openRepo() {
  await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
  await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
  await waitFor(() => expect(document.querySelector(".file-list")).toBeTruthy());
  await waitFor(() => expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
}

/**
 * R11 列出的动作类别逐项对应的注册表 id（切换仓库另有一条带路径的动态命令）。
 * 面板条目按这份清单比对，而不是只数条目数量。
 */
const R11_COMMAND_IDS = [
  "view.changes",
  "view.history",
  "stage.all",
  "unstage.all",
  "task.scope",
  "commit.local",
  "commit.push",
  "task.publish",
  "sync.fetch",
  "sync.pull",
  "sync.push",
  "repo.copyPath",
  "task.stash",
  "task.merge",
  "task.branch",
  "task.remote",
  "task.settings",
  "repo.add",
  "repo.clone",
  "repo.create",
  "theme.light",
  "theme.dark",
  "theme.system",
  "dialog.dependencies",
];

/** 注册表状态夹具：暂存区有 2 个文件、草稿已填，是「看起来都能用」的那一侧。 */
function commandState(overrides: Partial<CommandState> = {}): CommandState {
  return {
    hasRepo: true,
    workspaceView: "changes",
    taskModal: null,
    sidebarHidden: false,
    writeLocked: false,
    writing: false,
    reading: false,
    switchingBlocked: false,
    upstreamMissing: true,
    stagedCount: 2,
    stageTargets: ["src/App.svelte"],
    unstageTargets: ["README.md"],
    draft: "写一条说明",
    theme: "dark",
    recentRepos: [{ name: "demo", path: repoPath, openedAtMs: 1 }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({
    theme: "dark",
    panelWidths: { sidebar: 256, files: 360 },
    git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" },
    recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }],
    settingsWarning: null,
  });
  mocks.listenEvent.mockResolvedValue(() => {});
  mocks.pickDirectory.mockResolvedValue(null);
  mocks.pickFile.mockResolvedValue(null);
  mocks.openRepository.mockResolvedValue({
    summary: { name: "demo", path: repoPath },
    generation: 4,
    snapshot,
    draft: "",
    watchDegraded: false,
  });
  mocks.refreshStatus.mockResolvedValue(snapshot);
  mocks.loadDiff.mockImplementation(async (_repo: string, path: string, staged: boolean) => diffFor(path, staged));
  mocks.mergeSession.mockResolvedValue({
    generation: 4,
    operation: "none",
    canContinue: false,
    canAbort: false,
    source: null,
    target: "main",
    headOid: branch.headOid,
    conflicts: [],
    unresolved: 0,
    note: "当前没有进行中的合并。",
    snapshot,
  });
  mocks.saveDraft.mockResolvedValue(undefined);
  mocks.setTheme.mockResolvedValue(undefined);
  mocks.setPanelWidths.mockImplementation(async (widths: unknown) => widths);
  mocks.cancelReads.mockResolvedValue(undefined);
  mocks.fetchRemote.mockResolvedValue(snapshot);
  mocks.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
  mocks.historyPage.mockImplementation(async (_path: string, query: string, offset: number) => ({
    generation: 4,
    query,
    offset,
    pageSize: 100,
    hasMore: false,
    state: "ok",
    commits,
  }));
  mocks.commitDetail.mockImplementation(async (_path: string, oid: string) => {
    const commit = commits.find((item) => item.oid === oid) ?? commits[0];
    return {
      generation: 4,
      commit,
      body: "",
      root: false,
      merge: false,
      selectedParent: commit.parents[0],
      files: [{ path: "src/App.svelte", originalPath: null, status: "modified" }],
    };
  });
  mocks.commitFileDiff.mockImplementation(async (_path: string, _oid: string, _parent: string, path: string) => diffFor(path, false));
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "innerWidth");
});

describe("主工作台", () => {
  it("改动视图同屏显示文件列表与差异，并一次渲染 40 行以上差异", async () => {
    renderApp();
    await openRepo();

    const pane = document.querySelector(".changes");
    expect(pane?.querySelector(".file-list"), "同屏要有文件列表").toBeTruthy();
    expect(pane?.querySelector(".diff"), "同屏要有差异面板").toBeTruthy();
    expect(pane?.querySelectorAll("[data-diff-row]").length).toBeGreaterThanOrEqual(40);
    // 密度由行高 18px 决定：22px 的行高在 840px 里放不下 40 行。
    for (const row of document.querySelectorAll<HTMLElement>("[data-diff-row]")) {
      expect(row.style.height).toBe(`${ROW_HEIGHT}px`);
    }
    // 标题栏仍是 6 个常驻控件（刷新、发布分支等已离开标题栏）。
    expect(document.querySelectorAll("[data-titlebar-control]")).toHaveLength(6);
  });

  it("提交区无多行说明，撤销提交与放弃修改只在溢出菜单里", async () => {
    renderApp();
    await openRepo();

    const composer = document.querySelector(".composer.compact");
    expect(composer).toBeTruthy();
    expect(composer?.querySelector("p"), "提交区不应再有说明性段落").toBeNull();
    expect(composer?.textContent).not.toContain("只创建本地提交，不会推送");
    // 首屏没有撤销/放弃入口
    expect(screen.queryByRole("button", { name: "撤销最近提交并保留改动" })).toBeNull();
    expect(screen.queryByRole("button", { name: "放弃所选文件修改" })).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "更多提交操作" }));
    const menu = screen.getByRole("menu", { name: "更多提交操作" });
    // 菜单项是带名称与一行说明的竖排菜单项，而不是只靠悬停提示的图标按钮。
    const undo = screen.getByRole("menuitem", { name: "撤销最近提交并保留改动" });
    const discard = screen.getByRole("menuitem", { name: "放弃所选文件修改" });
    expect(menu.contains(undo)).toBe(true);
    expect(menu.contains(discard)).toBe(true);
    expect(undo.textContent).toContain("仅限未推送的普通提交");
    expect(discard.textContent).toContain("确认后才写入");
  });

  it("从提交区菜单打开撤销确认，收起确认后菜单一起收起，焦点回到「更多」", async () => {
    mocks.undoCommit.mockResolvedValue({
      generation: 4,
      code: "undo_pushed",
      eligible: false,
      wrote: false,
      headOid: "a".repeat(40),
      parentOid: "b".repeat(40),
      summary: "已经推送",
      reason: "这个提交已经推送。",
      snapshot: { generation: 4, branch: {}, files: [] },
    });
    render(App);
    await openRepo();
    const more = screen.getByRole("button", { name: "更多提交操作" });
    await fireEvent.click(more);
    await fireEvent.click(screen.getByRole("menuitem", { name: "撤销最近提交并保留改动" }));
    const dialog = await screen.findByRole("dialog", { name: "撤销最近提交并保留改动" });
    await fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("menu", { name: "更多提交操作" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

  it("运行环境正常时提交区菜单不放「运行依赖」，Git 缺失时它回到菜单里", async () => {
    renderApp();
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: "更多提交操作" }));
    const healthy = screen.getByRole("menu", { name: "更多提交操作" });
    expect(healthy.textContent).not.toContain("运行依赖");
    expect(healthy.textContent).toContain("获取更新");
    cleanup();

    mocks.getSettings.mockResolvedValue({
      theme: "dark",
      panelWidths: { sidebar: 256, files: 360 },
      git: { available: false, path: null, version: null, overridden: false, belowBaseline: false, message: "没有找到 Git" },
      recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }],
      settingsWarning: null,
    });
    renderApp();
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: "更多提交操作" }));
    expect(screen.getByRole("menu", { name: "更多提交操作" }).textContent).toContain("运行依赖");
  });

  it("左栏头部与命令面板打开同一个任务 modal，且单槽只有一层", async () => {
    renderApp();
    await openRepo();

    await fireEvent.click(screen.getByRole("button", { name: "临时保存" }));
    expect(document.querySelectorAll('[data-task-modal="stash"]')).toHaveLength(1);
    expect(document.querySelectorAll("[data-task-modal]")).toHaveLength(1);

    await fireEvent.keyDown(screen.getByRole("dialog", { name: /临时保存/ }), { key: "Escape" });
    await waitFor(() => expect(document.querySelectorAll("[data-task-modal]")).toHaveLength(0));

    await press("k");
    const palette = await screen.findByRole("dialog", { name: "命令面板" });
    await fireEvent.click(screen.getByRole("option", { name: /临时保存/ }));
    expect(palette.isConnected).toBe(false);
    expect(document.querySelectorAll('[data-task-modal="stash"]')).toHaveLength(1);
    expect(document.querySelectorAll("[data-task-modal]")).toHaveLength(1);
  });

  it("命令面板与标题栏同步组走同一条命令", async () => {
    renderApp();
    await openRepo();

    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /获取更新/ }));
    expect(mocks.fetchRemote).toHaveBeenCalledTimes(1);

    await press("k");
    await screen.findByRole("dialog", { name: "命令面板" });
    await fireEvent.click(screen.getByRole("option", { name: /获取更新/ }));
    expect(mocks.fetchRemote).toHaveBeenCalledTimes(2);
    expect(mocks.fetchRemote.mock.calls[0][0]).toBe(repoPath);
  });

  it("命令注册表按 R11 清单覆盖每一类动作，含切库、全部暂存与复制路径", async () => {
    const items = paletteItems(commandState());
    const ids = items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(R11_COMMAND_IDS));
    expect(ids).toContain(`${REPO_SWITCH_PREFIX}${repoPath}`);
    // 四类新增动作此刻都真的可执行，不是灰着的占位
    for (const id of ["stage.all", "unstage.all", "repo.copyPath", `${REPO_SWITCH_PREFIX}${repoPath}`]) {
      expect(items.find((item) => item.id === id)?.enabled, `${id} 应该可执行`).toBe(true);
    }
    // R11：不可用的动作必须带原因，不允许静默失败
    expect(items.filter((item) => !item.enabled && !item.reason)).toEqual([]);

    renderApp();
    await openRepo();
    await press("k");
    await screen.findByRole("dialog", { name: "命令面板" });
    for (const title of ["全部暂存", "全部取消暂存", "复制路径", "切换到 demo"]) {
      expect(screen.getByRole("option", { name: new RegExp(title) }), title).toBeTruthy();
    }
  });

  it("命令面板按仓库路径片段能筛出对应仓库，没有关键词的命令行为不变", async () => {
    // 注册表一侧：切库命令单独带路径关键词，其它命令没有关键词
    const items = paletteItems(commandState());
    expect(items.find((item) => item.id === `${REPO_SWITCH_PREFIX}${repoPath}`)?.keywords).toBe(repoPath);
    expect(items.find((item) => item.id === "view.changes")?.keywords).toBeUndefined();

    renderApp();
    await openRepo();
    await press("k");
    const palette = await screen.findByRole("dialog", { name: "命令面板" });
    const input = within(palette).getByRole("combobox", { name: "搜索命令" });

    // 路径片段（不是仓库名）也能筛出仓库，且大小写不敏感
    await fireEvent.input(input, { target: { value: "WORK/demo" } });
    const byPath = within(palette).getAllByRole("option");
    expect(byPath, "路径片段只命中那一条仓库命令").toHaveLength(1);
    expect(byPath[0].textContent).toContain("切换到 demo");
    // 关键词只参与过滤、不参与显示：选项文案里不出现路径
    expect(byPath[0].textContent).not.toContain("C:/work");

    // 没有关键词的命令仍只按标题与分组匹配
    await fireEvent.input(input, { target: { value: "提交历史" } });
    const byTitle = within(palette).getAllByRole("option");
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0].textContent).toContain("提交历史");
  });

  it("草稿为空时面板里的提交项与提交区按钮一样不可用，并就地说明原因", async () => {
    renderApp();
    await openRepo();

    // 暂存区非空、草稿为空：提交区按钮是灰的，原因同时出现在可见文本与 title 上
    const localButton = screen.getByRole("button", { name: "提交到本地" });
    expect(localButton.hasAttribute("disabled")).toBe(true);
    expect(localButton.getAttribute("title")).toContain("填写提交说明后即可提交");
    const blocker = document.querySelector("[data-commit-blocker]");
    expect(blocker?.textContent?.trim(), "原因要就地可见，而不是只在悬停提示里").toBe("填写提交说明后即可提交");
    expect(blocker?.getAttribute("title")).toContain("填写提交说明后即可提交");

    await press("k");
    await screen.findByRole("dialog", { name: "命令面板" });
    for (const name of [/提交到本地/, /提交并推送/]) {
      const option = screen.getByRole("option", { name });
      expect(option.getAttribute("aria-disabled")).toBe("true");
      expect(option.textContent).toContain("填写提交说明后即可提交");
    }
    await fireEvent.click(screen.getByRole("option", { name: /提交到本地/ }));
    expect(mocks.commitChanges).not.toHaveBeenCalled();

    // 填好草稿后两处一起恢复可用
    await fireEvent.keyDown(screen.getByRole("dialog", { name: "命令面板" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "命令面板" })).toBeNull());
    await fireEvent.input(document.querySelector<HTMLTextAreaElement>(".composer textarea")!, {
      target: { value: "重做工作台外壳" },
    });
    expect(screen.getByRole("button", { name: "提交到本地" }).hasAttribute("disabled")).toBe(false);
    expect(document.querySelector("[data-commit-blocker]"), "可提交后原因消失").toBeNull();
    await press("k");
    await screen.findByRole("dialog", { name: "命令面板" });
    expect(screen.getByRole("option", { name: /提交到本地/ }).getAttribute("aria-disabled")).toBe("false");
  });

  it("面板里的全部暂存、全部取消暂存、复制路径与切换仓库都复用按钮的 handler", async () => {
    mocks.stageFiles.mockResolvedValue(snapshot);
    mocks.unstageFiles.mockResolvedValue(snapshot);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderApp();
    await openRepo();

    // 全部暂存：先点分组头按钮，再从面板触发，两次的目标路径必须一致
    await fireEvent.click(screen.getByRole("button", { name: "全部暂存" }));
    await waitFor(() => expect(mocks.stageFiles).toHaveBeenCalledTimes(1));
    await press("k");
    await screen.findByRole("dialog", { name: "命令面板" });
    await fireEvent.click(screen.getByRole("option", { name: /全部暂存/ }));
    await waitFor(() => expect(mocks.stageFiles).toHaveBeenCalledTimes(2));
    expect(mocks.stageFiles.mock.calls[1][0]).toBe(repoPath);
    expect(mocks.stageFiles.mock.calls[1][1]).toEqual([
      "src/App.svelte",
      "src/app.css",
      "docs/start.md",
      "public/logo.png",
      "src/lib/icon.ts",
    ]);
    expect(mocks.stageFiles.mock.calls[1][1]).toEqual(mocks.stageFiles.mock.calls[0][1]);

    // 全部取消暂存：同上，目标路径与分组头按钮完全一致
    await fireEvent.click(screen.getByRole("button", { name: "全部取消暂存" }));
    await waitFor(() => expect(mocks.unstageFiles).toHaveBeenCalledTimes(1));
    await press("k");
    await screen.findByRole("dialog", { name: "命令面板" });
    await fireEvent.click(screen.getByRole("option", { name: /全部取消暂存/ }));
    await waitFor(() => expect(mocks.unstageFiles).toHaveBeenCalledTimes(2));
    expect(mocks.unstageFiles.mock.calls[1][1]).toEqual(["src/app.css", "README.md"]);
    expect(mocks.unstageFiles.mock.calls[1][1]).toEqual(mocks.unstageFiles.mock.calls[0][1]);

    // 复制路径：与标题栏仓库菜单调的是同一个 copyPath
    await press("k");
    await screen.findByRole("dialog", { name: "命令面板" });
    await fireEvent.click(screen.getByRole("option", { name: /复制路径/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(repoPath));

    // 切换仓库：与仓库菜单里的条目调的是同一个 openRecent
    const openedBefore = mocks.openRepository.mock.calls.length;
    await press("k");
    await screen.findByRole("dialog", { name: "命令面板" });
    await fireEvent.click(screen.getByRole("option", { name: /切换到 demo/ }));
    await waitFor(() => expect(mocks.openRepository.mock.calls.length).toBe(openedBefore + 1));
    expect(mocks.openRepository.mock.lastCall?.[0]).toBe(repoPath);
  });

  it("提交失败时在提交区就地说明原因，两条提交路径都算，草稿与暂存都保留（R5）", async () => {
    // Rust 侧 classify_commit 的真实措辞：钩子拒绝与缺身份分别可辨，不是笼统的「提交失败」。
    const hookFailure = {
      code: "hook_rejected",
      message: "提交钩子拒绝了这次提交。.git/hooks/pre-commit 以 1 退出。 说明和已暂存内容都还保留。",
    };
    const identityFailure = {
      code: "identity_missing",
      message: "缺少提交身份。请配置 user.name 与 user.email 后再试。说明和已暂存内容都还保留。",
    };
    mocks.commitChanges.mockRejectedValueOnce(hookFailure);
    renderApp();
    await openRepo();

    const textarea = () => document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    await fireEvent.input(textarea(), { target: { value: "重做工作台外壳" } });
    await fireEvent.click(screen.getByRole("button", { name: "提交到本地" }));

    const inline = await waitFor(() => {
      const node = document.querySelector<HTMLElement>("[data-commit-error]");
      expect(node, "提交区要就地给出失败原因").toBeTruthy();
      return node!;
    });
    expect(inline.textContent?.trim()).toContain("提交钩子拒绝了这次提交");
    expect(inline.getAttribute("title")).toContain("提交钩子拒绝了这次提交");
    // 通知条可以留着，但它不能是唯一渠道：两块文本同时说同一件事。
    await waitFor(() =>
      expect(document.querySelector(".toast.error .toast-text")?.textContent).toContain("提交钩子拒绝了这次提交"),
    );
    // 失败不吞掉输入：说明还在，按钮仍然可用（暂存也还在）。
    expect(textarea().value).toBe("重做工作台外壳");
    const localButton = screen.getByRole("button", { name: "提交到本地" });
    expect(localButton.hasAttribute("disabled")).toBe(false);
    expect(document.querySelector("[data-commit-blocker]"), "有失败原因时不再显示「草稿自动保存」").toBeNull();

    // 说明一改，上一次的原因就不再对应现在这条说明。
    await fireEvent.input(textarea(), { target: { value: "重做工作台外壳，补一句" } });
    expect(document.querySelector("[data-commit-error]")).toBeNull();

    // 第二条提交路径（提交并推送的「先完成本地提交」阶段）给出同一份就地原因。
    mocks.commitAndPush.mockRejectedValueOnce(identityFailure);
    await fireEvent.click(screen.getByRole("button", { name: "提交并推送" }));
    await waitFor(() =>
      expect(document.querySelector("[data-commit-error]")?.textContent?.trim()).toContain("缺少提交身份"),
    );

    // 重试成功后就地原因消失，改由 blocker 说明下一次为什么点不动。
    mocks.commitChanges.mockResolvedValueOnce({
      oid: "abcdef1234567",
      generation: 5,
      branch: "main",
      summary: "已提交 abcdef1",
      files: ["src/app.css"],
      pushed: false,
      snapshot: { generation: 5, branch, files: [] },
    });
    await fireEvent.click(screen.getByRole("button", { name: "提交到本地" }));
    await waitFor(() => expect(document.querySelector("[data-commit-error]")).toBeNull());
    expect(document.querySelector("[data-commit-blocker]")?.textContent?.trim()).toBe("先暂存要提交的文件");
  });

  it("历史与改动来回切换后各自滚动与选中保留，浏览历史不写入", async () => {
    renderApp();
    await openRepo();

    const fileRow = document.querySelector<HTMLElement>('.file-row[title="README.md"]');
    expect(fileRow).toBeTruthy();
    await fireEvent.click(fileRow!);
    const fileList = document.querySelector<HTMLElement>(".file-list")!;
    fileList.scrollTop = 68;

    await press("2");
    const history = await waitFor(() => {
      const list = document.querySelector<HTMLElement>(".history-list");
      expect(list).toBeTruthy();
      expect(list!.querySelectorAll('[role="option"]').length).toBeGreaterThan(2);
      return list!;
    });
    await fireEvent.click(history.querySelectorAll<HTMLElement>('[role="option"]')[2]);
    await waitFor(() => expect(document.querySelector('.history-row[aria-selected="true"]')).toBeTruthy());
    history.scrollTop = 124;

    // 回到改动：选中与滚动都还在
    await press("1");
    expect(document.querySelector('.file-row[title="README.md"]')?.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector<HTMLElement>(".file-list")!.scrollTop).toBe(68);

    // 再回历史：同一个列表节点、同一段滚动、同一个选中行
    await press("2");
    expect(document.querySelector(".history-list")).toBe(history);
    expect(history.scrollTop).toBe(124);
    expect(document.querySelector('.history-row[aria-selected="true"]')?.getAttribute("title")).toContain("提交 2");

    // 浏览历史不改变分支、暂存区与工作区
    expect(mocks.stageFiles).not.toHaveBeenCalled();
    expect(mocks.unstageFiles).not.toHaveBeenCalled();
    expect(mocks.commitChanges).not.toHaveBeenCalled();
    expect(mocks.refreshStatus).not.toHaveBeenCalled();
  });

  it("⌘Enter 走同一条提交命令，⌘R 刷新", async () => {
    mocks.commitChanges.mockResolvedValue({
      oid: "abcdef1234567",
      generation: 5,
      branch: "main",
      summary: "已提交 abcdef1",
      files: ["src/app.css"],
      pushed: false,
      snapshot: { generation: 5, branch, files: [] },
    });
    renderApp();
    await openRepo();

    const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    await fireEvent.input(textarea, { target: { value: "重做工作台外壳" } });
    await press("Enter");
    await waitFor(() => expect(mocks.commitChanges).toHaveBeenCalledTimes(1));
    expect(mocks.commitChanges.mock.calls[0][0]).toBe(repoPath);
    expect(mocks.commitChanges.mock.calls[0][1]).toBe("重做工作台外壳");

    await press("r");
    expect(mocks.refreshStatus).toHaveBeenCalledTimes(1);
  });

  it("⌘B 隐藏左栏、⌘R 刷新、Esc 关闭命令面板", async () => {
    renderApp();
    await openRepo();
    const workspace = document.querySelector<HTMLElement>(".workspace")!;
    expect(workspace.dataset.sidebar).toBe("visible");
    expect(workspace.style.getPropertyValue("--files")).toBe("360px");

    await press("b");
    expect(workspace.dataset.sidebar).toBe("hidden");
    expect(screen.getByRole("button", { name: "显示侧栏" })).toBeTruthy();
    expect(document.querySelector(".file-list"), "隐藏不卸载，列表滚动位置才留得住").toBeTruthy();
    await press("b");
    expect(workspace.dataset.sidebar).toBe("visible");
    expect(workspace.style.getPropertyValue("--files"), "恢复原宽度").toBe("360px");
    expect(screen.getByRole("button", { name: "隐藏侧栏" })).toBeTruthy();

    await press("r");
    expect(mocks.refreshStatus).toHaveBeenCalledTimes(1);

    await press("k");
    const palette = await screen.findByRole("dialog", { name: "命令面板" });
    await fireEvent.keyDown(palette.querySelector("input")!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "命令面板" })).toBeNull());
  });

  it("状态栏按钮与 ⌘B 走同一条命令，隐藏后仍有鼠标入口", async () => {
    renderApp();
    await openRepo();
    const workspace = document.querySelector<HTMLElement>(".workspace")!;
    await fireEvent.click(screen.getByRole("button", { name: "隐藏侧栏" }));
    expect(workspace.dataset.sidebar).toBe("hidden");
    await fireEvent.click(screen.getByRole("button", { name: "显示侧栏" }));
    expect(workspace.dataset.sidebar).toBe("visible");
  });

  it("窗口变窄不自动隐藏左栏，只收紧渲染宽度，不改写已保存的宽度（R14）", async () => {
    resizeTo(1280);
    renderApp();
    await openRepo();
    const workspace = document.querySelector<HTMLElement>(".workspace")!;
    const width = () => workspace.style.getPropertyValue("--files");
    expect(width()).toBe("360px");

    resizeTo(900);
    await tick();
    expect(workspace.dataset.sidebar, "最小窗口仍显示文件列表").toBe("visible");
    expect(width(), "900 宽给主内容留 560").toBe("340px");
    expect(document.querySelector(".file-list")).toBeTruthy();

    resizeTo(720);
    await tick();
    expect(width(), "再窄也不低于 240").toBe("240px");
    expect(mocks.setPanelWidths, "收紧只影响显示").not.toHaveBeenCalled();

    resizeTo(1280);
    await tick();
    expect(width(), "窗口放宽后回到保存的宽度").toBe("360px");
  });

  it("手动隐藏后窗口缩放不改变选择（R14）", async () => {
    resizeTo(1280);
    renderApp();
    await openRepo();
    const workspace = document.querySelector<HTMLElement>(".workspace")!;
    await press("b");
    resizeTo(900);
    await tick();
    resizeTo(1280);
    await tick();
    expect(workspace.dataset.sidebar).toBe("hidden");
    await press("b");
    expect(workspace.style.getPropertyValue("--files")).toBe("360px");
  });

  it("拖动条改左栏宽度并保存；只点一下不保存，窄窗口的收紧值不会变成偏好", async () => {
    resizeTo(900);
    renderApp();
    await openRepo();
    const workspace = document.querySelector<HTMLElement>(".workspace")!;
    const slider = screen.getByRole("slider", { name: "调整侧栏宽度" });
    expect(slider.getAttribute("aria-valuenow")).toBe("340");

    await fireEvent.pointerDown(slider, { clientX: 340, pointerId: 1 });
    await fireEvent.pointerUp(slider, { clientX: 340, pointerId: 1 });
    expect(mocks.setPanelWidths).not.toHaveBeenCalled();

    await fireEvent.pointerDown(slider, { clientX: 340, pointerId: 1 });
    await fireEvent.pointerMove(slider, { clientX: 300, pointerId: 1 });
    expect(workspace.style.getPropertyValue("--files")).toBe("300px");
    await fireEvent.pointerUp(slider, { clientX: 300, pointerId: 1 });
    await waitFor(() => expect(mocks.setPanelWidths).toHaveBeenCalledTimes(1));
    expect(mocks.setPanelWidths.mock.calls[0][0]).toMatchObject({ files: 300 });

    await fireEvent.keyDown(slider, { key: "ArrowLeft" });
    await waitFor(() => expect(mocks.setPanelWidths).toHaveBeenCalledTimes(2));
    expect(mocks.setPanelWidths.mock.calls[1][0]).toMatchObject({ files: 284 });
  });

  it("顶着窗口上限继续调宽不改写保存值，窗口放宽后回到原宽度", async () => {
    resizeTo(900);
    renderApp();
    await openRepo();
    const workspace = document.querySelector<HTMLElement>(".workspace")!;
    const slider = screen.getByRole("slider", { name: "调整侧栏宽度" });

    await fireEvent.keyDown(slider, { key: "ArrowRight" });
    await fireEvent.pointerDown(slider, { clientX: 340, pointerId: 1 });
    await fireEvent.pointerMove(slider, { clientX: 400, pointerId: 1 });
    await fireEvent.pointerUp(slider, { clientX: 400, pointerId: 1 });
    expect(mocks.setPanelWidths, "渲染宽度没变就不提交").not.toHaveBeenCalled();

    resizeTo(1280);
    await tick();
    expect(workspace.style.getPropertyValue("--files")).toBe("360px");
  });

  it("拖走再拖回原位不改写保存值，窗口放宽后回到原宽度", async () => {
    resizeTo(900);
    renderApp();
    await openRepo();
    const workspace = document.querySelector<HTMLElement>(".workspace")!;
    const slider = screen.getByRole("slider", { name: "调整侧栏宽度" });
    await fireEvent.pointerDown(slider, { clientX: 340, pointerId: 1 });
    await fireEvent.pointerMove(slider, { clientX: 300, pointerId: 1 });
    expect(workspace.style.getPropertyValue("--files")).toBe("300px");
    await fireEvent.pointerMove(slider, { clientX: 340, pointerId: 1 });
    await fireEvent.pointerUp(slider, { clientX: 340, pointerId: 1 });
    await tick();
    expect(mocks.setPanelWidths, "净变化为 0 不提交").not.toHaveBeenCalled();
    resizeTo(1280);
    await tick();
    expect(workspace.style.getPropertyValue("--files"), "内存里的宽度也要恢复").toBe("360px");
  });

  it("没有仓库时 ⌘B 不改写左栏状态，打开仓库后左栏可见", async () => {
    renderApp();
    await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
    await press("b");
    await openRepo();
    expect(document.querySelector<HTMLElement>(".workspace")!.dataset.sidebar).toBe("visible");
    expect(screen.getByRole("button", { name: "隐藏侧栏" })).toBeTruthy();
  });

  it("历史视图用同一份左栏宽度：视图切换和拖动条在历史里同样可用", async () => {
    resizeTo(1280);
    renderApp();
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: "提交历史" }));
    await waitFor(() => expect(document.querySelector(".history-pane .history-list")).toBeTruthy());
    const pane = document.querySelector<HTMLElement>(".history-pane")!;
    expect(within(pane).getByRole("button", { name: "提交历史" }).getAttribute("aria-current")).toBe("page");
    await fireEvent.keyDown(document.querySelector<HTMLElement>(".history-layout > .resizer")!, { key: "ArrowRight" });
    expect(document.querySelector<HTMLElement>(".workspace")!.style.getPropertyValue("--files")).toBe("376px");
    await fireEvent.click(within(pane).getByRole("button", { name: /^改动/ }));
    expect(document.querySelectorAll('.workbench-view[data-active="true"] .file-list').length).toBe(1);
  });
});

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
    // 分组表头“未暂存的改动”占第 0 行，文件从第 1 行开始；单行文件行每行 30px。
    expect(list.scrollTop).toBe(80 * 30);
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
    expect(region.scrollTop).toBe(ROW_HEIGHT);
    await fireEvent.keyDown(region, { key: "End" });
    expect(region.scrollTop).toBe(80 * ROW_HEIGHT);
    expect(screen.getByText(codeLine("row-79"))).toBeTruthy();
    // 虚拟窗口只保留可见附近的行：滚到底之后首行必须已经出窗。
    expect(screen.queryByText("row-0")).toBeNull();
    await fireEvent.keyDown(region, { key: "Home" });
    expect(region.scrollTop).toBe(0);
    expect(screen.getByText("row-0")).toBeTruthy();
    expect(screen.queryByText(codeLine("row-79"))).toBeNull();
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
    expect(screen.getByText(codeLine("kept"))).toBeTruthy();
    expect(screen.getByRole("button", { name: "暂存此块" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "已截断" }).hasAttribute("disabled")).toBe(true);
  });

  it("切换文件时不展示旧差异，加载后显示新文件内容", async () => {
    const view = render(DiffView, {
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
    expect(screen.getByText(codeLine("kept"))).toBeTruthy();
    const nextSelection: FileSelection = { path: "other.txt", side: "unstaged" };
    await view.rerender({ selection: nextSelection, diff, error: null, loading: true, disabled: false, onStageHunk: () => {}, onLoadMore: () => {} });
    expect(screen.queryByText(codeLine("kept"))).toBeNull();
    expect(screen.getByText("正在读取差异")).toBeTruthy();
    const nextDiff: DiffResponse = {
      ...diff,
      path: "other.txt",
      lines: [{ kind: "add", text: "+new-file-content", oldNo: null, newNo: 1, hunkIndex: 0 }],
      totalLines: 1,
    };
    await view.rerender({ selection: nextSelection, diff: nextDiff, error: null, loading: false, disabled: false, onStageHunk: () => {}, onLoadMore: () => {} });
    expect(screen.getByText(codeLine("new-file-content"))).toBeTruthy();
    expect(screen.queryByText(codeLine("kept"))).toBeNull();
  });

  it("空暂存时提交不可用，范围改成计数入口而不是说明段落", async () => {
    const onScope = vi.fn();
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
        onScope,
      },
    });
    expect(screen.getByText("提交到 main（尚无提交） · 暂存区是空的")).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交到本地" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "提交并推送" }).hasAttribute("disabled")).toBe(true);
    // 暂存区为空的原因在可见文本里，且两种空态给的是不同的话
    expect(document.querySelector("[data-commit-blocker]")?.textContent?.trim()).toBe("先暂存要提交的文件");
    // 提交区不再有说明性段落，只剩一行以内的元信息
    expect(document.querySelector(".composer p")).toBeNull();
    const scopeButton = screen.getByRole("button", { name: "本次提交范围：0 个已暂存文件" });
    await fireEvent.click(scopeButton);
    expect(onScope).toHaveBeenCalledTimes(1);
  });
});

describe("差异工具条分段与空/失败状态（T3）", () => {
  const base = () => ({
    error: null as string | null,
    loading: false,
    disabled: false,
    onStageHunk: () => {},
    onLoadMore: () => {},
  });
  const nav = () => ({
    index: 1,
    total: 3,
    prevReason: null as string | null,
    nextReason: null as string | null,
    onPrev: () => {},
    onNext: () => {},
  });

  it("工具条按「位置与身份 → 文件动作 → 显示方式」三段排列", () => {
    render(DiffView, {
      props: {
        ...base(),
        selection,
        diff,
        fileNav: nav(),
        onFileHistory: () => {},
        onFullFile: () => {},
      },
    });
    const toolbar = document.querySelector(".diff-toolbar") as HTMLElement;
    const groups = [...toolbar.children] as HTMLElement[];
    expect(groups).toHaveLength(3);
    expect(groups[0].className).toContain("context");
    // 第一段：上一个/下一个文件 + 路径与侧别，位置信息在前。
    expect(groups[0].querySelector(".file-nav")).toBeTruthy();
    expect(groups[0].querySelector(".diff-path")).toBeTruthy();
    // 第二段：只放能对这个文件做的事。
    expect(within(groups[1]).getByRole("button", { name: "此文件历史" })).toBeTruthy();
    expect(within(groups[1]).getByRole("button", { name: /只看改动|完整文件/ })).toBeTruthy();
    // 第三段：显示方式留在最右。
    expect(within(groups[2]).getByRole("group", { name: "差异布局" })).toBeTruthy();
  });

  it("没有语言、历史、完整文件这些动作时只留两段，不画空段", () => {
    render(DiffView, { props: { ...base(), selection, diff: null } });
    const groups = [...(document.querySelector(".diff-toolbar") as HTMLElement).children] as HTMLElement[];
    expect(groups).toHaveLength(2);
    expect(groups[0].className).toContain("context");
    expect(groups[1].querySelector(".segmented")).toBeTruthy();
    expect(document.querySelectorAll(".diff-toolbar-group:empty")).toHaveLength(0);
  });

  it("读取失败时就地给出「重新读取」，走同一条读取回调", async () => {
    const onRetry = vi.fn();
    render(DiffView, { props: { ...base(), selection, diff: null, error: "索引被锁定", onRetry } });
    expect(screen.getByText("差异没有读取完成")).toBeTruthy();
    expect(screen.getByText("索引被锁定")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    document.body.innerHTML = "";
    // 多文件视图按块自己重读，不传 onRetry 时不能出现一个假的恢复入口。
    render(DiffView, { props: { ...base(), selection, diff: null, error: "索引被锁定" } });
    expect(screen.queryByRole("button", { name: "重新读取" })).toBeNull();
  });

  it("没有改动时右侧不再要求「选择一个文件」", () => {
    render(DiffView, { props: { ...base(), selection: null, diff: null, fileCount: 0 } });
    expect(screen.getByText("工作区没有未提交的改动")).toBeTruthy();
    expect(screen.queryByText("选择一个文件查看差异")).toBeNull();
    document.body.innerHTML = "";
    render(DiffView, { props: { ...base(), selection: null, diff: null, fileCount: 3 } });
    expect(screen.getByText("选择一个文件查看差异")).toBeTruthy();
    expect(screen.queryByText("工作区没有未提交的改动")).toBeNull();
  });
});

describe("差异横向滚动", () => {
  const longLine = `${"中文长行".repeat(40)}LINE-END`;

  function renderDiff() {
    return render(DiffView, {
      props: {
        selection: { path: "a.ts", side: "unstaged" },
        diff: createTextDiff("a.ts", "short\n", `short\n${longLine}\n`, 1),
        error: null,
        loading: false,
        disabled: false,
        onStageHunk: () => {},
        onLoadMore: () => {},
      },
    });
  }

  it("标尺取全量最长行，内容不进文本和选区；并排时两栏各有一把只量本栏的标尺", async () => {
    renderDiff();
    const scroller = document.querySelector(".diff-scroll") as HTMLElement;
    const firstRuler = () => document.querySelector<HTMLElement>(".code-ruler span")?.dataset.text;
    expect(firstRuler()).toBe(longLine);
    expect(document.querySelector(".code-ruler")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".code-ruler")?.textContent).toBe("");
    expect(document.querySelector(".split-hbars")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: /并排/ }));
    // 并排时滚动容器只管纵向，横向交给两栏各自的滚动条。
    expect(document.querySelector(".code-ruler")).toBeNull();
    expect(scroller.classList.contains("split-x")).toBe(true);
    const rulers = [...document.querySelectorAll(".split-hbars .split-ruler")].map((ruler) =>
      [...ruler.querySelectorAll<HTMLElement>("span")].map((span) => span.dataset.text),
    );
    expect(rulers).toEqual([["short"], [longLine, "short"]]);
    expect(document.querySelector(".split-hbars")?.textContent?.trim()).toBe("");
    expect(scroller.isConnected).toBe(true);
  });

  it("并排两栏各自横向滚动：每栏的滚动条只平移本栏的代码，横向滑动滚指针所在的栏", async () => {
    renderDiff();
    await fireEvent.click(screen.getByRole("button", { name: /并排/ }));
    const scroller = document.querySelector(".diff-scroll") as HTMLElement;
    const [left, right] = [...document.querySelectorAll<HTMLElement>(".split-hbar")];
    right.scrollLeft = 240;
    await fireEvent.scroll(right);
    expect(scroller.style.getPropertyValue("--code-xr")).toBe("240px");
    expect(scroller.style.getPropertyValue("--code-xl")).toBe("0px");
    left.scrollLeft = 30;
    await fireEvent.scroll(left);
    expect(scroller.style.getPropertyValue("--code-xl")).toBe("30px");
    expect(scroller.style.getPropertyValue("--code-xr")).toBe("240px");

    const inner = [...document.querySelectorAll(".side-cell.side-r .code-in")].find((node) => node.textContent === longLine);
    expect(inner?.getAttribute("data-sign")).toBe("+");
    // 行号、块标题都在 .code-in 之外，不跟着平移。
    expect(document.querySelector(".ln .code-in, .hunk-caption .code-in")).toBeNull();
    expect(document.querySelector(".code-stage .side-row")).not.toBeNull();

    // happy-dom 的 WheelEvent 不带 clientX / shiftKey：用触控板的横向滑动，指针不在左半栏时滚右栏。
    const wheel = new WheelEvent("wheel", { deltaX: 50, bubbles: true, cancelable: true });
    scroller.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(right.scrollLeft).toBe(290);
    const vertical = new WheelEvent("wheel", { deltaY: 50, bubbles: true, cancelable: true });
    scroller.dispatchEvent(vertical);
    expect(vertical.defaultPrevented, "纵向滚动交给浏览器").toBe(false);
  });

  it("竖向滚动条增减时重读 clientWidth：内容变高和尺寸回调都会更新 --code-view", async () => {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(920);
    try {
      const view = renderDiff();
      const scroller = document.querySelector(".diff-scroll") as HTMLElement;
      await tick();
      expect(scroller.style.getPropertyValue("--code-view")).toBe("920px");
      // 同一实例内内容变高：出现竖向滚动条，外框不变，bind:clientWidth 收不到通知。
      clientWidth.mockReturnValue(908);
      await view.rerender({ diff: createTextDiff("a.ts", "short\n", `short\n${longLine}\n${"more\n".repeat(200)}`, 1) });
      await tick();
      expect(document.querySelector(".diff-scroll")).toBe(scroller);
      expect(scroller.style.getPropertyValue("--code-view")).toBe("908px");
      // 只有滚动条变化、没有内容重算时，靠轨道和容器的 ResizeObserver。
      clientWidth.mockReturnValue(920);
      for (const callback of callbacks) callback();
      expect(scroller.style.getPropertyValue("--code-view")).toBe("920px");
    } finally {
      vi.unstubAllGlobals();
      clientWidth.mockRestore();
    }
  });

  // happy-dom 没有布局：宽度按当下 DOM 里的真实文字算，中间态的多余文字会如实反映出来。
  const widthFromText = () =>
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return (this.textContent?.length ?? 0) * 10;
    });
  const nextFrame = async () => {
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  };

  it("已渲染行比标尺宽时撑大标尺，切布局不缩，内容换了才重新起算", async () => {
    const offsetWidth = widthFromText();
    try {
      const view = renderDiff();
      const scroller = document.querySelector(".diff-scroll") as HTMLElement;
      await nextFrame();
      const floor = `${longLine.length * 10}px`;
      expect(scroller.style.getPropertyValue("--code-floor")).toBe(floor);
      await fireEvent.click(screen.getByRole("button", { name: /并排/ }));
      await nextFrame();
      expect(scroller.style.getPropertyValue("--code-floor")).toBe(floor);
      await view.rerender({ diff: createTextDiff("a.ts", "short\n", "other\n", 1) });
      await nextFrame();
      expect(scroller.style.getPropertyValue("--code-floor")).toBe("50px");
    } finally {
      offsetWidth.mockRestore();
    }
  });

  it("内容相同的刷新不重算：不写 --code-floor，横向位置不动", async () => {
    const offsetWidth = widthFromText();
    try {
      const view = renderDiff();
      const scroller = document.querySelector(".diff-scroll") as HTMLElement;
      await nextFrame();
      scroller.scrollLeft = 500;
      await fireEvent.scroll(scroller);
      const writes: string[] = [];
      const setProperty = vi.spyOn(scroller.style, "setProperty").mockImplementation(function (this: CSSStyleDeclaration, name: string, value: string | null) {
        if (name === "--code-floor") writes.push(String(value));
      });
      await view.rerender({ diff: createTextDiff("a.ts", "short\n", `short\n${longLine}\n`, 2) });
      await nextFrame();
      setProperty.mockRestore();
      expect(writes).toEqual([]);
      expect(scroller.scrollLeft).toBe(500);
      expect(scroller.style.getPropertyValue("--code-x")).toBe("500px");
    } finally {
      offsetWidth.mockRestore();
    }
  });

  it("采样文字和总规模都相同、只有余量不同时也算内容换了，floor 不残留", async () => {
    // 长度从一行挪到另一行：总字符数和最长行的先后都不变，只有 restCh 能认出来。x 开头的行实测按两倍算。
    const offsetWidth = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      const text = this.textContent ?? "";
      return text.length * (text.startsWith("x") ? 20 : 10);
    });
    try {
      const x = "x".repeat(RULER_SAMPLE_CHARS);
      const y = "y".repeat(RULER_SAMPLE_CHARS);
      const content = (xRest: number, yRest: number) => `${x}${"p".repeat(xRest)}\n${y}${"p".repeat(yRest)}\n`;
      const view = render(DiffView, {
        props: {
          selection: { path: "a.ts", side: "unstaged" },
          diff: createTextDiff("a.ts", "", content(500, 10), 1),
          error: null,
          loading: false,
          disabled: false,
          onStageHunk: () => {},
          onLoadMore: () => {},
        },
      });
      const scroller = document.querySelector(".diff-scroll") as HTMLElement;
      await nextFrame();
      expect(scroller.style.getPropertyValue("--code-floor")).toBe(`${(RULER_SAMPLE_CHARS + 500) * 20}px`);
      await view.rerender({ diff: createTextDiff("a.ts", "", content(400, 110), 1) });
      await nextFrame();
      expect(scroller.style.getPropertyValue("--code-floor")).toBe(`${(RULER_SAMPLE_CHARS + 400) * 20}px`);
    } finally {
      offsetWidth.mockRestore();
    }
  });

  it("最长的几行不变、其余行换了时也重新起算，floor 不残留", async () => {
    // 标尺只留最长的几行：更短的行实测反而最宽（比如全角多的行）时，只有内容规模能认出它走了。
    const offsetWidth = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.textContent?.startsWith("wide") ? 9000 : (this.textContent?.length ?? 0) * 10;
    });
    try {
      const longest = Array.from({ length: RULER_LINES * 4 }, (_, index) => `${"long".repeat(20)}${index}`);
      const joined = (lines: string[]) => `${lines.join("\n")}\n`;
      const view = render(DiffView, {
        props: {
          selection: { path: "a.ts", side: "unstaged" },
          diff: createTextDiff("a.ts", "", joined(["wide", ...longest]), 1),
          error: null,
          loading: false,
          disabled: false,
          onStageHunk: () => {},
          onLoadMore: () => {},
        },
      });
      const scroller = document.querySelector(".diff-scroll") as HTMLElement;
      await nextFrame();
      expect(scroller.style.getPropertyValue("--code-floor")).toBe("9000px");
      await view.rerender({ diff: createTextDiff("a.ts", "", joined(longest), 1) });
      await nextFrame();
      expect(scroller.style.getPropertyValue("--code-floor")).not.toBe("9000px");
    } finally {
      offsetWidth.mockRestore();
    }
  });

  it("换内容时一次写入新宽度，不经过中间的 0", async () => {
    const offsetWidth = widthFromText();
    try {
      const view = renderDiff();
      const scroller = document.querySelector(".diff-scroll") as HTMLElement;
      await nextFrame();
      const writes: string[] = [];
      const original = scroller.style.setProperty.bind(scroller.style);
      const setProperty = vi.spyOn(scroller.style, "setProperty").mockImplementation((name: string, value: string | null) => {
        if (name === "--code-floor") writes.push(String(value));
        original(name, value);
      });
      await view.rerender({ diff: createTextDiff("a.ts", "short\n", "other\n", 1) });
      await nextFrame();
      setProperty.mockRestore();
      expect(writes).toEqual(["50px"]);
    } finally {
      offsetWidth.mockRestore();
    }
  });

  it("行文本长度和数据不一致的行不参与实测，卸载时取消未执行的帧", async () => {
    const offsetWidth = widthFromText();
    try {
      const view = renderDiff();
      const scroller = document.querySelector(".diff-scroll") as HTMLElement;
      await nextFrame();
      const before = scroller.style.getPropertyValue("--code-floor");
      const code = [...document.querySelectorAll<HTMLElement>(".code-in")].find((node) => node.textContent === longLine);
      code?.append("这段文字不属于这一行".repeat(50));
      await fireEvent.click(screen.getByRole("button", { name: /并排/ }));
      await fireEvent.click(screen.getByRole("button", { name: /统一/ }));
      await nextFrame();
      expect(scroller.style.getPropertyValue("--code-floor")).toBe(before);
      const cancel = vi.spyOn(globalThis, "cancelAnimationFrame");
      await fireEvent.click(screen.getByRole("button", { name: /并排/ }));
      view.unmount();
      expect(cancel).toHaveBeenCalled();
      cancel.mockRestore();
    } finally {
      offsetWidth.mockRestore();
    }
  });

  it("换文件时横向位置归零", async () => {
    const view = renderDiff();
    const scroller = document.querySelector(".diff-scroll") as HTMLElement;
    scroller.scrollLeft = 300;
    await fireEvent.scroll(scroller);
    await view.rerender({
      selection: { path: "b.ts", side: "unstaged" },
      diff: createTextDiff("b.ts", "x\n", "y\n", 1),
    });
    await tick();
    expect(scroller.scrollLeft).toBe(0);
    expect(scroller.style.getPropertyValue("--code-x")).toBe("0px");
  });
});

/* ------------------------------------------------------------------ *
 * R19、R20：多选文件与上一个、下一个文件。
 * ------------------------------------------------------------------ */

function fileRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".file-row")];
}

function selectedNames(): string[] {
  return fileRows()
    .filter((row) => row.getAttribute("aria-selected") === "true")
    .map((row) => row.querySelector(".fn")?.textContent ?? "");
}

function blockPaths(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".multi-stack .multi-file")].map((block) => block.dataset.path ?? "");
}

function altKey(key: string, target: EventTarget = window) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true }));
  return tick();
}

describe("上一个、下一个文件（R20）", () => {
  it("按列表顺序切换，列表选中同步，首尾不可用并说明原因", async () => {
    renderApp();
    await openRepo();
    const prev = screen.getByRole("button", { name: "上一个文件" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "下一个文件" }) as HTMLButtonElement;
    expect(selectedNames()).toEqual(["App.svelte"]);
    expect(prev.disabled).toBe(true);
    expect(prev.title).toBe("已经是第一个文件");

    await fireEvent.click(next);
    await waitFor(() => expect(selectedNames()).toEqual(["app.css"]));
    await waitFor(() => expect(document.querySelector(".diff-path")?.textContent).toContain("app.css"));
    expect(prev.disabled).toBe(false);

    // 跨过未暂存分组走进已暂存：最后一行是 README.md。
    const rows = fileRows();
    await fireEvent.click(rows[rows.length - 1]);
    await waitFor(() => expect(next.disabled).toBe(true));
    expect(next.title).toBe("已经是最后一个文件");
    await fireEvent.click(prev);
    await waitFor(() => expect(selectedNames()).toEqual(["app.css"]));
    await waitFor(() => expect(mocks.loadDiff).toHaveBeenLastCalledWith(repoPath, "src/app.css", true, 4, expect.any(Number), null, 0, 0, undefined));
  });

  it("走到最后一个文件时焦点交给上一个文件按钮，不掉到 body", async () => {
    renderApp();
    await openRepo();
    const rows = fileRows();
    await fireEvent.click(rows[rows.length - 2]);
    const next = screen.getByRole("button", { name: "下一个文件" }) as HTMLButtonElement;
    await waitFor(() => expect(next.disabled).toBe(false));
    next.focus();
    await fireEvent.click(next);
    await waitFor(() => expect(next.disabled).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "上一个文件" })));
  });

  it("Alt+←/→ 切换文件，输入框聚焦时让给光标移动", async () => {
    renderApp();
    await openRepo();
    await altKey("ArrowRight");
    await waitFor(() => expect(selectedNames()).toEqual(["app.css"]));
    await altKey("ArrowLeft");
    await waitFor(() => expect(selectedNames()).toEqual(["App.svelte"]));

    const input = document.getElementById("file-search") as HTMLInputElement;
    input.focus();
    await altKey("ArrowRight", input);
    await tick();
    expect(selectedNames()).toEqual(["App.svelte"]);

    // 到头时快捷键不动，只说明原因。
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true }));
    await waitFor(() => expect(document.querySelector(".toast.ok")?.textContent).toContain("已经是第一个文件"));
  });

  it("命令面板能找到 file.prev、file.next，到头时给原因，快捷键映射不影响原有组合", () => {
    const items = paletteItems(commandState({ fileNav: { prevReason: "已经是第一个文件", nextReason: null } }));
    expect(items.find((item) => item.id === "file.prev")).toMatchObject({ enabled: false, reason: "已经是第一个文件" });
    expect(items.find((item) => item.id === "file.next")).toMatchObject({ enabled: true });
    expect(paletteItems(commandState()).find((item) => item.id === "file.next")).toMatchObject({ enabled: false, reason: "先选择一个文件" });

    expect(shortcutCommand({ key: "ArrowLeft", altKey: true })).toBe("file.prev");
    expect(shortcutCommand({ key: "ArrowRight", altKey: true })).toBe("file.next");
    expect(shortcutCommand({ key: "ArrowRight", altKey: true, shiftKey: true })).toBeNull();
    expect(shortcutCommand({ key: "ArrowRight", altKey: true, ctrlKey: true })).toBeNull();
    expect(shortcutCommand({ key: "ArrowRight" })).toBeNull();
    expect(shortcutCommand({ key: "k", altKey: true })).toBeNull();
    expect(shortcutCommand({ key: "k", altKey: true, ctrlKey: true })).toBeNull();
    expect(isTextEntry(document.createElement("textarea"))).toBe(true);
    expect(isTextEntry(document.createElement("div"))).toBe(false);
  });

  it("fileNavState：筛掉当前文件时从第一个继续，空列表两侧都说明", () => {
    const go = vi.fn();
    const filtered = fileNavState(["a", "b"], -1, go);
    expect(filtered.prevReason).toBe("当前文件不在列表里");
    expect(filtered.nextReason).toBeNull();
    filtered.onNext();
    expect(go).toHaveBeenCalledWith("a");
    filtered.onPrev();
    expect(go).toHaveBeenCalledTimes(1);
    const empty = fileNavState([], -1, go);
    expect(empty.prevReason).toBe("没有可切换的文件");
    expect(empty.nextReason).toBe("没有可切换的文件");
  });
});

describe("多选文件（R19）", () => {
  const ctrlClick = (element: Element) => fireEvent.click(element, { ctrlKey: true });

  it("⌘/Ctrl+点击增减，主内容区按列表顺序堆叠，普通点击回到单选", async () => {
    renderApp();
    await openRepo();
    const rows = fileRows();
    await ctrlClick(rows[2]);
    await waitFor(() => expect(blockPaths()).toEqual(["src/App.svelte", "docs/start.md"]));
    expect(screen.getByText("已选 2 个文件")).toBeTruthy();
    expect(selectedNames()).toEqual(["App.svelte", "start.md"]);
    expect(document.querySelector(".file-list")?.getAttribute("aria-multiselectable")).toBe("true");

    await ctrlClick(rows[3]);
    await waitFor(() => expect(blockPaths()).toEqual(["src/App.svelte", "docs/start.md", "public/logo.png"]));
    // 点击已选文件取消选中；减到一个时回到单文件差异。
    await ctrlClick(fileRows()[3]);
    await ctrlClick(fileRows()[0]);
    await waitFor(() => expect(document.querySelector(".multi-stack")).toBeNull());
    expect(selectedNames()).toEqual(["start.md"]);

    await ctrlClick(fileRows()[0]);
    await waitFor(() => expect(blockPaths()).toHaveLength(2));
    await fireEvent.click(fileRows()[1]);
    await waitFor(() => expect(document.querySelector(".multi-stack")).toBeNull());
    expect(selectedNames()).toEqual(["app.css"]);
  });

  it("Shift+点击选连续范围，Shift+方向键扩展，Ctrl+A 全选当前列表，Esc 回单选", async () => {
    renderApp();
    await openRepo();
    await fireEvent.click(fileRows()[1]);
    await fireEvent.click(fileRows()[4], { shiftKey: true });
    await waitFor(() => expect(selectedNames()).toEqual(["app.css", "start.md", "logo.png", "icon.ts"]));

    await fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".multi-stack")).toBeNull());
    expect(selectedNames()).toEqual(["app.css"]);

    const list = document.querySelector<HTMLElement>(".file-list")!;
    await fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    await fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => expect(selectedNames()).toEqual(["app.css", "start.md", "logo.png"]));
    await fireEvent.keyDown(list, { key: "ArrowUp", shiftKey: true });
    await waitFor(() => expect(selectedNames()).toEqual(["app.css", "start.md"]));

    await fireEvent.keyDown(list, { key: "a", ctrlKey: true });
    await waitFor(() => expect(selectedNames()).toHaveLength(fileRows().length));
    // 筛选后 Ctrl+A 只选当前列表。
    await fireEvent.keyDown(window, { key: "Escape" });
    await fireEvent.input(document.getElementById("file-search")!, { target: { value: "app" } });
    await waitFor(() => expect(fileRows().length).toBeLessThan(5));
    await fireEvent.keyDown(document.querySelector(".file-list")!, { key: "a", metaKey: true });
    await waitFor(() => expect(screen.getByText(`已选 ${fileRows().length} 个文件`)).toBeTruthy());
  });

  it("Shift 扩展的起点不随上一个/下一个漂移，Esc 回单选后对齐焦点文件", async () => {
    renderApp();
    await openRepo();
    await fireEvent.click(fileRows()[1]);
    await fireEvent.click(fileRows()[3], { shiftKey: true });
    await waitFor(() => expect(selectedNames()).toEqual(["app.css", "start.md", "logo.png"]));
    await fireEvent.click(screen.getByRole("button", { name: "下一个文件" }));
    await fireEvent.click(screen.getByRole("button", { name: "下一个文件" }));
    await waitFor(() => expect(document.querySelector(".multi-file.focused")?.getAttribute("data-path")).toBe("public/logo.png"));
    // 起点还是 app.css，范围从它算，不是从定位到的 logo.png 算。
    await fireEvent.click(fileRows()[2], { shiftKey: true });
    await waitFor(() => expect(selectedNames()).toEqual(["app.css", "start.md"]));

    await fireEvent.click(fileRows()[4], { shiftKey: true });
    await fireEvent.click(screen.getByRole("button", { name: "下一个文件" }));
    await fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".multi-stack")).toBeNull());
    expect(selectedNames()).toEqual(["start.md"]);
    await fireEvent.click(fileRows()[3], { shiftKey: true });
    await waitFor(() => expect(selectedNames()).toEqual(["start.md", "logo.png"]));
  });

  it("更多菜单、同步菜单、放弃确认打开时 Esc 不清多选，Alt+→ 不在背后切文件", async () => {
    mocks.discardChanges.mockResolvedValue({ generation: 4, wrote: false, boundary: "只影响所选文件。", snapshot, files: [] });
    renderApp();
    await openRepo();
    await ctrlClick(fileRows()[2]);
    await waitFor(() => expect(blockPaths()).toHaveLength(2));
    const focused = () => document.querySelector(".multi-file.focused")?.getAttribute("data-path");
    await fireEvent.click(screen.getByRole("button", { name: "上一个文件" }));
    await waitFor(() => expect(focused()).toBe("src/App.svelte"));

    const probe = async () => {
      await altKey("ArrowRight");
      await tick();
      expect(focused(), "背后不切文件").toBe("src/App.svelte");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await tick();
      await tick();
      expect(blockPaths(), "多选还在").toHaveLength(2);
    };

    await fireEvent.click(screen.getByRole("button", { name: "更多提交操作" }));
    await waitFor(() => expect(screen.getByRole("menu", { name: "更多提交操作" })).toBeTruthy());
    await probe();
    await waitFor(() => expect(screen.queryByRole("menu", { name: "更多提交操作" })).toBeNull());

    await fireEvent.click(document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-label^="同步"], .titlebar .menu-anchor button')!);
    await waitFor(() => expect(screen.getByRole("menu", { name: "同步" })).toBeTruthy());
    await probe();
    await waitFor(() => expect(screen.queryByRole("menu", { name: "同步" })).toBeNull());

    await fireEvent.click(screen.getByRole("button", { name: /放弃 2 个文件的更改/ }));
    const dialog = await screen.findByRole("dialog", { name: "放弃文件修改" });
    await altKey("ArrowRight");
    await tick();
    expect(focused(), "确认层打开时不切文件").toBe("src/App.svelte");
    await fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "放弃文件修改" })).toBeNull());
    expect(blockPaths(), "Esc 只关确认层").toHaveLength(2);
  });

  it("定位后焦点从块内收到滚动容器，退出多选交回文件列表", async () => {
    renderApp();
    await openRepo();
    await ctrlClick(fileRows()[2]);
    await waitFor(() => expect(document.querySelectorAll(".multi-stack .diff-scroll").length).toBeGreaterThan(0));
    await fireEvent.click(screen.getByRole("button", { name: "上一个文件" }));
    await waitFor(() => expect(document.querySelector(".multi-file.focused")?.getAttribute("data-path")).toBe("src/App.svelte"));
    document.querySelector<HTMLElement>(".multi-stack .diff-scroll")!.focus();
    await altKey("ArrowRight");
    const host = document.querySelector<HTMLElement>(".multi-stack-scroll")!;
    await waitFor(() => expect(document.activeElement).toBe(host));
    await fireEvent.keyDown(host, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".multi-stack")).toBeNull());
    expect(document.activeElement).toBe(document.querySelector(".file-list"));
  });

  it("输入框里的 Esc 和历史视图里的 Esc 不清除多选", async () => {
    renderApp();
    await openRepo();
    await ctrlClick(fileRows()[2]);
    await waitFor(() => expect(blockPaths()).toHaveLength(2));
    const input = document.getElementById("file-search") as HTMLInputElement;
    await fireEvent.keyDown(input, { key: "Escape" });
    await tick();
    expect(blockPaths()).toHaveLength(2);

    await press("2");
    await fireEvent.keyDown(window, { key: "Escape" });
    await press("1");
    expect(blockPaths()).toHaveLength(2);
  });

  it("多选时上一个、下一个只在选中文件之间走，到头说明原因", async () => {
    renderApp();
    await openRepo();
    await ctrlClick(fileRows()[2]);
    await ctrlClick(fileRows()[4]);
    await fireEvent.click(fileRows()[0], { ctrlKey: true });
    await fireEvent.click(fileRows()[0], { ctrlKey: true });
    await waitFor(() => expect(blockPaths()).toHaveLength(3));
    const next = screen.getByRole("button", { name: "下一个文件" }) as HTMLButtonElement;
    await waitFor(() => expect(document.querySelector(".multi-file.focused")?.getAttribute("data-path")).toBe("src/App.svelte"));
    await fireEvent.click(next);
    await waitFor(() => expect(document.querySelector(".multi-file.focused")?.getAttribute("data-path")).toBe("docs/start.md"));
    expect(selectedNames()).toHaveLength(3);
    await fireEvent.click(next);
    await waitFor(() => expect(next.disabled).toBe(true));
    expect(next.title).toBe("已经是最后一个选中文件");
  });

  it("刷新后按 path+side 收敛，提交后清理，只剩一个时回到单选", async () => {
    renderApp();
    await openRepo();
    await ctrlClick(fileRows()[1]);
    await ctrlClick(fileRows()[2]);
    await waitFor(() => expect(blockPaths()).toEqual(["src/App.svelte", "src/app.css", "docs/start.md"]));

    mocks.refreshStatus.mockResolvedValueOnce({ ...snapshot, generation: 5, files: changes.filter((file) => file.path !== "docs/start.md") });
    await press("r");
    await waitFor(() => expect(blockPaths()).toEqual(["src/App.svelte", "src/app.css"]));

    mocks.refreshStatus.mockResolvedValueOnce({ ...snapshot, generation: 6, files: changes.filter((file) => file.path !== "src/app.css") });
    await press("r");
    await waitFor(() => expect(document.querySelector(".multi-stack")).toBeNull());
    expect(selectedNames()).toEqual(["App.svelte"]);
  });

  it("切换分组后选中集合跟着文件走：批量暂存后仍是这些文件", async () => {
    mocks.stageFiles.mockImplementation(async (_repo: string, paths: string[]) => ({
      ...snapshot,
      generation: 4 + mocks.stageFiles.mock.calls.length,
      files: changes.map((file) => (paths.includes(file.path) || mocks.stageFiles.mock.calls.some(([, done]) => done.includes(file.path)) ? { ...file, staged: "modified", unstaged: "none", untracked: false } : file)),
    }));
    renderApp();
    await openRepo();
    await ctrlClick(fileRows()[2]);
    await waitFor(() => expect(blockPaths()).toHaveLength(2));
    await fireEvent.click(screen.getByRole("button", { name: "暂存 2 个文件" }));
    await waitFor(() => expect(mocks.stageFiles).toHaveBeenCalledTimes(2));
    expect(mocks.stageFiles.mock.calls.map((call) => call[1])).toEqual([["src/App.svelte"], ["docs/start.md"]]);
    expect(mocks.stageFiles.mock.calls.map((call) => call[2])).toEqual([4, 5]);
    await waitFor(() => expect(document.querySelectorAll('.multi-stack .diff-side.staged')).toHaveLength(2));
    expect(blockPaths().sort()).toEqual(["docs/start.md", "src/App.svelte"]);
  });

  it("纯函数：范围不分方向，切换可增可减，同名文件按 path+side 区分", () => {
    const rows: FileSelection[] = [
      { path: "a", side: "unstaged" },
      { path: "b", side: "unstaged" },
      { path: "a", side: "staged" },
    ];
    expect(rangeSelection(rows, rows[2], rows[1])).toEqual([rows[1], rows[2]]);
    expect(rangeSelection(rows, null, rows[1])).toEqual([rows[1]]);
    expect(rangeSelection(rows, rows[0], { path: "gone", side: "staged" })).toEqual([]);
    expect(toggleSelection([rows[0]], rows[2])).toEqual([rows[0], rows[2]]);
    expect(toggleSelection([rows[0], rows[2]], rows[0])).toEqual([rows[2]]);
    expect(orderedRows(changes).map((row) => `${row.side}:${row.path}`).slice(-2)).toEqual(["staged:src/app.css", "staged:README.md"]);
  });

  it("批量目标排除冲突文件，结论写清成功、失败和未处理", () => {
    const row = (path: string, side: FileRow["side"], unmerged = false): FileRow => ({ ...change(path, "modified", "modified", { unmerged }), side });
    expect(batchTargets([row("a", "unstaged"), row("a", "staged"), row("b", "staged"), row("c", "unstaged", true)])).toEqual({
      stage: ["a"],
      unstage: ["a", "b"],
      discard: ["a", "b"],
      conflicts: 1,
    });
    expect(batchSummary("暂存", 2, [{ path: "c.ts", message: "索引被锁定" }], 1)).toBe("已暂存 2 个文件，成功的改动已保留。失败 c.ts：索引被锁定。1 个文件未处理。");
    expect(batchSummary("暂存", 0, [{ path: "c.ts", message: "x" }], 0)).toContain("没有文件被暂存");
    // 后端原因自带句号时不叠成「。；」或「。。」。
    expect(batchSummary("暂存", 1, [{ path: "a", message: "索引被锁定。" }, { path: "b", message: "权限不足." }], 0)).toBe(
      "已暂存 1 个文件，成功的改动已保留。失败 a：索引被锁定；b：权限不足。",
    );
  });

  it("渲染窗口只覆盖视口附近的块，上下由占位补齐", () => {
    const tops = blockTops(Array.from({ length: 100 }, () => 100), 10);
    expect(tops[100]).toBe(11000);
    const near = blockWindow(tops, 2200, 400, 200);
    expect(near.start).toBe(18);
    expect(near.end).toBe(26);
    expect(near.before).toBe(tops[18]);
    expect(near.before + (tops[near.end] - tops[near.start]) + near.after).toBe(tops[100]);
    expect(blockWindow(tops, 0, 0, 200).end).toBe(6);
    expect(blockWindow(blockTops([], 10), 0, 300, 200)).toEqual({ start: 0, end: 0, before: 0, after: 0 });
  });
});

describe("MultiFileDiff 逐块懒加载（R19）", () => {
  type Pending = { path: string; resolve: (value: DiffResponse) => void; reject: (reason: unknown) => void };
  let pendingReads: Pending[] = [];

  const opened = (generation = 4, files: FileChange[] = []): OpenedRepository =>
    ({ summary: { name: "demo", path: repoPath }, generation, snapshot: { ...snapshot, generation, files }, draft: "", watchDegraded: false }) as OpenedRepository;
  const rowsOf = (count: number): FileRow[] => Array.from({ length: count }, (_, index) => ({ ...change(`gen/file-${index}.ts`, "none", "modified"), side: "unstaged" as const }));

  function props(overrides: Record<string, unknown> = {}) {
    const rows = (overrides.rows as FileRow[] | undefined) ?? rowsOf(100);
    return {
      opened: opened(),
      rows,
      focus: { path: rows[0].path, side: rows[0].side },
      nav: fileNavState(rows, 0, () => {}, "选中文件"),
      disabled: false,
      fullFile: false,
      fullContext: 1_000_000,
      stageCount: rows.length,
      unstageCount: 0,
      discardCount: rows.length,
      conflictCount: 0,
      nextId: () => 1,
      onFocus: vi.fn(),
      onStale: vi.fn(),
      onStageHunk: vi.fn(),
      onFullFile: vi.fn(),
      onFileHistory: vi.fn(),
      onStage: vi.fn(),
      onUnstage: vi.fn(),
      onDiscard: vi.fn(),
      onClear: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(() => {
    pendingReads = [];
    mocks.loadDiff.mockImplementation(
      (_repo: string, path: string) => new Promise((resolve, reject) => pendingReads.push({ path, resolve, reject })),
    );
  });

  it("选 100 个文件时只挂载视口附近的块，读取最多并发 3 个，读完一个再补一个", async () => {
    render(MultiFileDiff, { props: props() });
    await waitFor(() => expect(pendingReads).toHaveLength(3));
    expect(document.querySelectorAll(".multi-file").length).toBeLessThanOrEqual(6);
    expect(screen.getByText("已选 100 个文件")).toBeTruthy();
    expect(pendingReads.map((read) => read.path)).toEqual(["gen/file-0.ts", "gen/file-1.ts", "gen/file-2.ts"]);

    pendingReads[0].resolve(diffFor("gen/file-0.ts", false));
    await waitFor(() => expect(pendingReads).toHaveLength(4));
    expect(pendingReads[3].path).toBe("gen/file-3.ts");
    await waitFor(() => expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
    // 只堆叠块自己的内容：embedded 差异不画工具栏，也不留纵向滚动。
    expect(document.querySelector(".diff.embedded .diff-toolbar")).toBeNull();
  });

  it("单个文件失败只在该块显示原因，其它块继续", async () => {
    render(MultiFileDiff, { props: props({ rows: rowsOf(3) }) });
    await waitFor(() => expect(pendingReads).toHaveLength(3));
    pendingReads[1].reject({ code: "git", message: "读取 file-1 失败" });
    pendingReads[0].resolve(diffFor("gen/file-0.ts", false));
    pendingReads[2].resolve(diffFor("gen/file-2.ts", false));
    await screen.findByText("读取 file-1 失败");
    const failed = document.querySelector('.multi-file[data-path="gen/file-1.ts"]');
    expect(failed?.textContent).toContain("差异没有读取完成");
    await waitFor(() => expect(document.querySelector('.multi-file[data-path="gen/file-0.ts"] [data-diff-row]')).toBeTruthy());
    expect(document.querySelector('.multi-file[data-path="gen/file-2.ts"] [data-diff-row]')).toBeTruthy();
  });

  it("滚出预读区后释放差异，返回时重新读取而不是累积全部选中文件", async () => {
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    mocks.loadDiff.mockImplementation(async (_repo: string, path: string) => diffFor(path, false));
    const view = render(MultiFileDiff, { props: props() });
    try {
      await waitFor(() => expect(document.querySelector('[data-path="gen/file-0.ts"] [data-diff-row]')).toBeTruthy());
      const host = document.querySelector<HTMLElement>(".multi-stack-scroll")!;
      const initial = mocks.loadDiff.mock.calls.filter((call) => call[1] === "gen/file-0.ts").length;
      await fireEvent.wheel(host);
      host.scrollTop = 10_000;
      await fireEvent.scroll(host);
      await waitFor(() => expect(document.querySelector('[data-path="gen/file-0.ts"]')).toBeNull());
      host.scrollTop = 0;
      await fireEvent.scroll(host);
      await waitFor(() => expect(mocks.loadDiff.mock.calls.filter((call) => call[1] === "gen/file-0.ts")).toHaveLength(initial + 1));
      await waitFor(() => expect(document.querySelector('[data-path="gen/file-0.ts"] [data-diff-row]')).toBeTruthy());
    } finally {
      view.unmount();
      height.mockRestore();
    }
  });

  it("折叠时丢弃迟到内容，再展开重新读取；隐藏页面释放已读差异", async () => {
    const view = render(MultiFileDiff, { props: props({ rows: rowsOf(1) }) });
    await waitFor(() => expect(pendingReads).toHaveLength(1));
    await fireEvent.click(screen.getByRole("button", { name: "收起 gen/file-0.ts" }));
    pendingReads[0].resolve({ ...diffFor("gen/file-0.ts", false), additions: 111 });
    await tick();
    await fireEvent.click(screen.getByRole("button", { name: "展开 gen/file-0.ts" }));
    await waitFor(() => expect(pendingReads).toHaveLength(2));
    expect(document.body.textContent).not.toContain("+111");
    pendingReads[1].resolve(diffFor("gen/file-0.ts", false));
    await waitFor(() => expect(document.querySelector("[data-diff-row]")).toBeTruthy());
    await view.rerender({ active: false });
    expect(document.querySelector("[data-diff-row]")).toBeNull();
    await view.rerender({ active: true });
    await waitFor(() => expect(pendingReads).toHaveLength(3));
  });

  it("generation 变化后丢弃在途响应并重新读取；旧 generation 报 stale 时交给外壳刷新", async () => {
    const shown = props({ rows: rowsOf(2) });
    const view = render(MultiFileDiff, { props: shown });
    await waitFor(() => expect(pendingReads).toHaveLength(2));
    const old = pendingReads.slice();
    await view.rerender({ opened: opened(5) });
    // 旧响应还占着通道：并发上限跨轮次同样有效，只放进来一个新读取。
    await waitFor(() => expect(pendingReads).toHaveLength(3));

    old[0].resolve({ ...diffFor("gen/file-0.ts", false), additions: 111 });
    await waitFor(() => expect(pendingReads).toHaveLength(4));
    expect(document.body.textContent).not.toContain("+111");
    expect(mocks.loadDiff.mock.calls.slice(2).map((call) => call[3])).toEqual([5, 5]);
    pendingReads[2].resolve({ ...diffFor("gen/file-0.ts", false), additions: 222 });
    await screen.findByText("+222");
    expect(document.body.textContent).not.toContain("+111");

    old[1].reject({ code: "stale", message: "过期", generation: 9 });
    await tick();
    expect(shown.onStale, "旧轮次的失败同样丢弃").not.toHaveBeenCalled();
    pendingReads[3].reject({ code: "stale", message: "过期", generation: 9 });
    await waitFor(() => expect(shown.onStale).toHaveBeenCalledWith(9));
  });

  it("块内不滚纵向：按外层视口算虚拟窗口，只渲染可见行", async () => {
    const rows = rowsOf(1);
    const long: DiffResponse = {
      ...diffFor(rows[0].path, false),
      lines: Array.from({ length: 2000 }, (_, index) => ({ kind: "context" as const, text: ` line-${index}`, oldNo: index + 1, newNo: index + 1, hunkIndex: 0 })),
    };
    mocks.loadDiff.mockImplementation(async () => long);
    render(MultiFileDiff, { props: props({ rows }) });
    await waitFor(() => expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
    expect(document.querySelectorAll("[data-diff-row]").length).toBeLessThan(100);
    const space = document.querySelector<HTMLElement>(".diff.embedded .virtual-space")!;
    expect(space.style.height).toBe(`${2000 * 18}px`);
  });

  describe("吸底横向滚动条（R21）", () => {
    let widths: ReturnType<typeof vi.spyOn>[] = [];

    beforeEach(() => {
      mocks.loadDiff.mockImplementation(async (_repo: string, path: string) => diffFor(path, false));
      widths = [
        vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(2400),
        vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800),
      ];
    });

    afterEach(() => widths.forEach((spy) => spy.mockRestore()));

    const blockOf = () => document.querySelector<HTMLElement>('.multi-file[data-path="gen/file-0.ts"]')!;
    const waitBar = () => waitFor(() => {
      const bar = blockOf()?.querySelector<HTMLElement>(".diff-hbar");
      expect(bar).toBeTruthy();
      return bar!;
    });

    it("代理条内宽等于本块 scrollWidth，与差异区双向同步", async () => {
      render(MultiFileDiff, { props: props({ rows: rowsOf(2) }) });
      const bar = await waitBar();
      const code = blockOf().querySelector<HTMLElement>(".diff-scroll")!;
      expect((bar.firstElementChild as HTMLElement).style.width).toBe("2400px");

      code.scrollLeft = 300;
      await fireEvent.scroll(code);
      expect(bar.scrollLeft).toBe(300);
      bar.scrollLeft = 640;
      await fireEvent.scroll(bar);
      expect(code.scrollLeft).toBe(640);
    });

    it("没有长行时不显示代理条", async () => {
      widths[0].mockReturnValue(800);
      render(MultiFileDiff, { props: props({ rows: rowsOf(1) }) });
      await waitFor(() => expect(document.querySelector("[data-diff-row]")).toBeTruthy());
      expect(document.querySelector(".diff-hbar")).toBeNull();
    });

    it("块卸载再挂载时恢复横向位置，代理条跟着恢复", async () => {
      render(MultiFileDiff, { props: props({ rows: rowsOf(2) }) });
      await waitBar();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const code = blockOf().querySelector<HTMLElement>(".diff-scroll")!;
      code.scrollLeft = 520;
      await fireEvent.scroll(code);

      await fireEvent.click(screen.getByRole("button", { name: "收起 gen/file-0.ts" }));
      await waitFor(() => expect(blockOf().querySelector(".diff-scroll")).toBeNull());
      await fireEvent.click(screen.getByRole("button", { name: "展开 gen/file-0.ts" }));
      const bar = await waitBar();
      await waitFor(() => expect(blockOf().querySelector<HTMLElement>(".diff-scroll")!.scrollLeft).toBe(520));
      await waitFor(() => expect(bar.scrollLeft).toBe(520));
    });
  });

  it("按块暂存带上所在文件块的身份和差异，不是焦点文件的", async () => {
    const rows = rowsOf(2);
    const shown = props({ rows });
    mocks.loadDiff.mockImplementation(async (_repo: string, path: string, staged: boolean) => {
      const loaded = diffFor(path, staged);
      return { ...loaded, lines: [{ kind: "hunk", text: "@@ -1 +1 @@", oldNo: null, newNo: null, hunkIndex: 0 }, ...loaded.lines] };
    });
    render(MultiFileDiff, { props: shown });
    const block = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('.multi-file[data-path="gen/file-1.ts"]');
      expect(element?.querySelector(".hunk-btn")).toBeTruthy();
      return element!;
    });
    await fireEvent.click(block.querySelector(".hunk-btn")!);
    expect(shown.onStageHunk).toHaveBeenCalledWith(
      { path: "gen/file-1.ts", side: "unstaged" },
      expect.objectContaining({ path: "gen/file-1.ts" }),
      expect.objectContaining({ index: 0 }),
    );
  });

  it("文件离开选中集合后，它的迟到响应不再写入", async () => {
    const rows = rowsOf(2);
    const view = render(MultiFileDiff, { props: props({ rows }) });
    await waitFor(() => expect(pendingReads).toHaveLength(2));
    await view.rerender({ rows: rows.slice(0, 1) });
    pendingReads[1].resolve({ ...diffFor("gen/file-1.ts", false), additions: 333 });
    await tick();
    expect(document.body.textContent).not.toContain("+333");
    expect(blockPaths()).toEqual(["gen/file-0.ts"]);
  });

  it("每块可折叠，折叠的块不读取；工具栏批量动作说明排除了冲突文件", async () => {
    render(MultiFileDiff, { props: props({ rows: rowsOf(4), conflictCount: 1 }) });
    await waitFor(() => expect(pendingReads).toHaveLength(3));
    await fireEvent.click(screen.getByRole("button", { name: "收起 gen/file-3.ts" }));
    pendingReads.forEach((read) => read.resolve(diffFor(read.path, false)));
    await tick();
    await tick();
    expect(pendingReads).toHaveLength(3);
    expect(document.querySelector('.multi-file[data-path="gen/file-3.ts"] .multi-file-diff')).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "展开 gen/file-3.ts" }));
    await waitFor(() => expect(pendingReads).toHaveLength(4));
    expect(screen.getByRole("button", { name: "暂存 4 个文件" }).title).toContain("已排除 1 个冲突文件");
  });
});

describe("文件列表的目录分组和行数", () => {
  function listProps(files: FileChange[], query = "") {
    return {
      files,
      selected: null as FileSelection | null,
      query,
      disabled: false,
      onQuery: () => {},
      onSelect: () => {},
      onStage: vi.fn(),
      onUnstage: vi.fn(),
      onStageAll: vi.fn(),
      onUnstageAll: vi.fn(),
    };
  }

  it("默认每一项都是文件；目录分组只展开收起，暂存作用在文件上，搜索能展开到收起的文件", async () => {
    const files = [
      change("notes/todo.log", "none", "none", { untracked: true, unstagedLines: { additions: 3, deletions: 0 } }),
      change("notes/other.log", "none", "none", { untracked: true }),
      change("README.md", "none", "modified", { unstagedLines: { additions: 2, deletions: 1 } }),
      change("blob.bin", "none", "modified", { unstagedLines: { additions: null, deletions: null } }),
    ];
    const props = listProps(files);
    const view = render(FileList, { props });
    const names = () => [...document.querySelectorAll(".file-row .fn")].map((node) => node.textContent);
    expect(names()).toEqual(expect.arrayContaining(["todo.log", "other.log", "README.md", "blob.bin"]));
    expect(names()).not.toContain("notes");
    expect(screen.getByLabelText("新增 3 行，删除 0 行")).toBeTruthy();
    expect(screen.getByLabelText("新增 2 行，删除 1 行")).toBeTruthy();
    // 文件清单行里二进制不占位：大小留给差异工具条。
    expect(screen.queryByText("二进制")).toBeNull();
    expect([...document.querySelectorAll(".file-row")].find((row) => row.textContent?.includes("blob.bin"))?.querySelector(".diff-stats")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "目录" }));
    expect(screen.getByRole("button", { name: "目录" }).getAttribute("aria-pressed")).toBe("true");
    expect(props.onStage).not.toHaveBeenCalled();
    expect(props.onStageAll).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "列表" }));
    expect(props.onStage).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "目录" }));
    const folder = screen.getByRole("button", { name: /^notes/ });
    await fireEvent.click(folder);
    expect(screen.queryByRole("option", { name: /todo\.log/ })).toBeNull();
    await view.rerender({ ...props, query: "todo" });
    expect(await screen.findByRole("option", { name: /todo\.log/ })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "暂存 notes" }));
    expect(props.onStageAll).toHaveBeenCalledWith(["notes/todo.log"]);
  });

  it("分区之间的分隔线只画在后面几个分区上，第一个表头不画", () => {
    const files = [
      change("a.ts", "none", "modified"),
      change("b.ts", "modified", "none"),
      change("c.ts", "unmerged", "unmerged", { unmerged: true }),
    ];
    const view = render(FileList, { props: listProps(files) });
    const heads = () => [...document.querySelectorAll(".file-group")] as HTMLElement[];
    expect(heads().map((head) => head.textContent?.trim().split(/\s/)[0])).toEqual(["冲突", "未暂存的改动", "已暂存"]);
    expect(heads()[0].className, "第一个表头上面就是搜索框").toContain("first");
    expect(heads()[1].className).not.toContain("first");
    expect(heads()[2].className).not.toContain("first");
    // 筛掉第一个分区后，新的第一个表头接手「不画线」，行高与虚拟化不受影响。
    return view.rerender({ ...listProps(files, "a.ts") }).then(() => {
      const filtered = heads();
      expect(filtered.map((head) => head.textContent?.trim().split(/\s/)[0])).toEqual(["未暂存的改动"]);
      expect(filtered[0].className).toContain("first");
    });
  });
});
