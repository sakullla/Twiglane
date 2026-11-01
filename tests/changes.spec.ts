import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommitDraft from "../src/lib/components/CommitDraft.svelte";
import DiffView from "../src/lib/components/DiffView.svelte";
import FileList from "../src/lib/components/FileList.svelte";
import type {
  DiffLine,
  DiffResponse,
  FileChange,
  FileSelection,
  HistoryCommit,
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
    // 分组表头“未暂存的改动”占第 0 行，文件从第 1 行开始；每行 40px。
    expect(list.scrollTop).toBe(80 * 40);
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


