import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAND } from "../src/lib/brand";
import {
  beginClioraReview,
  recordClioraMerge,
  resetClioraReview,
} from "../src/lib/cliora-review.svelte";
import { resetReviewProgress } from "../src/lib/review-progress.svelte";
import type { DiffLine, DiffResponse, FileChange, HistoryCommit, StatusSnapshot } from "../src/lib/types";

/* ------------------------------------------------------------------ *
 * App 级夹具：真实 api 由 vi.mock 顶替，界面走完整外壳。
 * 本文件只盯外壳的可观察契约（标题栏、左栏、命令面板、主题解析），
 * 逐项比对清单而不是数数量，这样少一条动作或缺一个分组都会立刻失败。
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

/** 两个已暂存文件：配合空草稿，就是为了让「提交」两项因为缺说明而不可用。 */
const changes: FileChange[] = [
  change("src/App.svelte", "none", "modified"),
  change("src/app.css", "modified", "modified"),
  change("README.md", "modified", "none"),
  change("docs/start.md", "none", "deleted"),
  change("public/logo.png", "none", "modified"),
  change("src/lib/icon.ts", "none", "none", { untracked: true }),
];

const snapshot: StatusSnapshot = { generation: 4, branch, files: changes };

function diffFor(path: string, staged: boolean): DiffResponse {
  const lines: DiffLine[] = Array.from({ length: 6 }, (_, index) => ({
    kind: "context" as const,
    text: ` row-${index}`,
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
    summary: "6 行上下文。",
    additions: 0,
    deletions: 0,
    complete: true,
    truncated: false,
    snapshot: "snap",
    hunks: [{ index: 0, header: "@@ -1,6 +1,6 @@", complete: true, stageable: true, startLine: 0, lineCount: lines.length }],
    lines,
    offset: 0,
    totalLines: lines.length,
  };
}

const commits: HistoryCommit[] = Array.from({ length: 4 }, (_, index) => ({
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
  repoHeads: vi.fn(),
  removeWorktree: vi.fn(),
  refreshStatus: vi.fn(),
  loadDiff: vi.fn(),
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  stageHunks: vi.fn(),
  stageLines: vi.fn(),
  commitChanges: vi.fn(),
  commitAndPush: vi.fn(),
  fetchRemote: vi.fn(),
  pullFastForward: vi.fn(),
  pushBranch: vi.fn(),
  pushToRemote: vi.fn(),
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
  mergePreview: vi.fn(),
  startMerge: vi.fn(),
  switchBranch: vi.fn(),
  tagState: vi.fn(),
  stashState: vi.fn(),
  measureProbe: vi.fn(),
  measureSample: vi.fn(),
  measureFinish: vi.fn(),
  measureWait: vi.fn(),
  listenEvent: vi.fn(),
  pickDirectory: vi.fn(),
  pickFile: vi.fn(),
  repositoryDirectory: vi.fn(),
  repositoryFileContent: vi.fn(),
  repositoryPathSearch: vi.fn(),
  repositoryContentSearch: vi.fn(),
  repositoryReviewToken: vi.fn(),
  filePreview: vi.fn(),
  clioraReviewRequest: vi.fn(),
  clioraReviewReceipt: vi.fn(),
  clioraReviewReturn: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  api: { ...mocks, branchList: mocks.branchState },
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));

import App from "../src/App.svelte";
import { paletteItems, REPO_SWITCH_PREFIX, type CommandState } from "../src/lib/commands";

describe("原生状态测量", () => {
  it("旧 generation 响应不会自行触发无上限重试", async () => {
    mocks.openRepository.mockResolvedValue({
      summary: { name: "demo", path: repoPath }, generation: 5,
      snapshot: { ...snapshot, generation: 5 }, draft: "", watchDegraded: false,
    });
    mocks.refreshStatus.mockImplementation(async () => {
      if (mocks.refreshStatus.mock.calls.length > 1) throw new Error("不应自行重试旧响应");
      return snapshot;
    });
    render(App);
    await openRepo();
    const focus = mocks.listenEvent.mock.calls.find(([name]) => name === "window-focused")![1];
    focus();
    await tick();
    await tick();
    expect(mocks.refreshStatus).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0);
  });

  it("密集刷新只保留在途读取和一次后续读取", async () => {
    let finish!: (value: StatusSnapshot) => void;
    mocks.refreshStatus.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(App);
    await openRepo();
    const focus = mocks.listenEvent.mock.calls.find(([name]) => name === "window-focused")![1];
    for (let i = 0; i < 20; i += 1) focus();
    expect(mocks.refreshStatus).toHaveBeenCalledTimes(1);
    finish(snapshot);
    await waitFor(() => expect(mocks.refreshStatus).toHaveBeenCalledTimes(2));
    await tick();
    expect(mocks.refreshStatus).toHaveBeenCalledTimes(2);
  });

  it("监听事件推进 generation 后不应用旧状态，合并读取最新版本", async () => {
    let finish!: (value: StatusSnapshot) => void;
    mocks.refreshStatus.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    mocks.refreshStatus.mockResolvedValue({ ...snapshot, generation: 5 });
    render(App);
    await openRepo();
    const focus = mocks.listenEvent.mock.calls.find(([name]) => name === "window-focused")![1];
    const changed = mocks.listenEvent.mock.calls.find(([name]) => name === "repo-changed")![1];
    focus();
    changed({ path: repoPath, generation: 5, degraded: false });
    finish({ ...snapshot, files: [], generation: 4 });
    await waitFor(() => expect(mocks.refreshStatus).toHaveBeenCalledTimes(2));
    expect(mocks.refreshStatus).toHaveBeenLastCalledWith(repoPath, 5, expect.any(Number));
    await waitFor(() => expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
  });

  it("重新打开同一路径后丢弃旧会话的刷新结果", async () => {
    let finish!: (value: StatusSnapshot) => void;
    mocks.refreshStatus.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(App);
    await openRepo();
    const focus = mocks.listenEvent.mock.calls.find(([name]) => name === "window-focused")![1];
    focus();
    // 弹层选当前仓库只收起、不重读，同一路径重新打开走命令面板的切换命令。
    const palette = await openPalette();
    await fireEvent.click(within(palette).getByRole("option", { name: /切换到 demo/ }));
    await waitFor(() => expect(mocks.openRepository).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
    finish({ ...snapshot, files: [] });
    await tick();
    expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0);
  });

  it("从弹层切到另一个仓库后丢弃旧仓库的刷新结果", async () => {
    let finish!: (value: StatusSnapshot) => void;
    mocks.refreshStatus.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    useRecent([{ name: "demo", path: repoPath, openedAtMs: 1 }, { name: "other", path: "C:/work/other", openedAtMs: 2 }]);
    render(App);
    await openRepo();
    const focus = mocks.listenEvent.mock.calls.find(([name]) => name === "window-focused")![1];
    focus();
    await fireEvent.click(screen.getByRole("button", { name: "当前仓库 demo" }));
    const popover = await screen.findByRole("dialog", { name: "切换仓库" });
    await fireEvent.click(within(popover).getByRole("option", { name: /other/ }));
    await waitFor(() => expect(mocks.openRepository).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
    finish({ ...snapshot, files: [] });
    await tick();
    expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0);
  });

  it("刷新失败不能用旧快照报告测量成功", async () => {
    mocks.measureProbe.mockResolvedValue({ enabled: true, script: { steps: [
      { op: "open", repo: repoPath, expectChanges: changes.length },
      { op: "refresh", count: 1, expectChanges: changes.length },
    ] } });
    mocks.refreshStatus.mockRejectedValue({ code: "status_failed", message: "无法读取仓库状态。" });
    render(App);
    await waitFor(() => expect(mocks.measureSample).toHaveBeenCalledWith("measure-error", { message: "仓库状态刷新失败" }));
    expect(mocks.measureSample.mock.calls.some(([name]) => name === "status-refresh")).toBe(false);
  });
});

async function dragEvent(name: "enter" | "leave" | "drop", paths: string[] = []) {
  const eventName = `tauri://drag-${name}`;
  await waitFor(() => expect(mocks.listenEvent.mock.calls.some(([event]) => event === eventName)).toBe(true));
  const handler = mocks.listenEvent.mock.calls.find(([event]) => event === eventName)![1];
  handler({ paths });
  await tick();
}

describe("原生文件夹拖放", () => {
  it("拖入后显示提示，离开清除，放下后通过已有仓库校验打开", async () => {
    mocks.addRepository.mockResolvedValue({
      summary: { name: "dropped", path: "C:/work/dropped" },
      generation: 4, snapshot, draft: "", watchDegraded: false,
    });
    render(App);
    await dragEvent("enter", ["C:/work/dropped"]);
    expect(screen.getByText("松开以打开仓库文件夹")).toBeTruthy();
    await dragEvent("leave");
    expect(screen.queryByText("松开以打开仓库文件夹")).toBeNull();
    await dragEvent("drop", ["C:/work/dropped"]);
    await waitFor(() => expect(mocks.addRepository).toHaveBeenCalledWith("C:/work/dropped", expect.any(Number)));
    await waitFor(() => expect(document.querySelector(".file-list")).toBeTruthy());
    expect(mocks.pickDirectory).not.toHaveBeenCalled();
  });

  it("拒绝多文件夹拖放，不静默选择其中一个", async () => {
    render(App);
    await dragEvent("drop", ["C:/one", "C:/two"]);
    expect(screen.getAllByText("请一次拖入一个仓库文件夹。").length).toBeGreaterThan(0);
    expect(mocks.addRepository).not.toHaveBeenCalled();
  });

  it.each([
    ["not_repository", "该目录不是 Git 仓库，未做任何修改。"],
    ["not_directory", "请选择文件夹。"],
  ])("%s 失败保留当前仓库", async (code, message) => {
    mocks.addRepository.mockRejectedValue({ code, message });
    render(App);
    await openRepo();
    await dragEvent("drop", ["C:/invalid"]);
    await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0));
    expect(document.querySelector(".file-list")).toBeTruthy();
    expect(mocks.createRepository).not.toHaveBeenCalled();
  });

  it("打开尚未结束时拒绝连续拖入，避免覆盖在途结果", async () => {
    let finish!: (value: unknown) => void;
    mocks.addRepository.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(App);
    await dragEvent("drop", ["C:/first"]);
    await waitFor(() => expect(mocks.addRepository).toHaveBeenCalledTimes(1));
    await dragEvent("drop", ["C:/second"]);
    expect(mocks.addRepository).toHaveBeenCalledTimes(1);
    finish({ summary: { name: "first", path: "C:/first" }, generation: 4, snapshot, draft: "", watchDegraded: false });
    await waitFor(() => expect(document.querySelector(".file-list")).toBeTruthy());
  });

  it("对话框打开时不切换仓库", async () => {
    render(App);
    await openPalette();
    await dragEvent("drop", ["C:/other"]);
    expect(mocks.addRepository).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "命令面板" })).toBeTruthy();
  });

  it("拖放切换前保存尚未自动保存的提交草稿", async () => {
    mocks.addRepository.mockResolvedValue({
      summary: { name: "other", path: "C:/other" }, generation: 4, snapshot, draft: "", watchDegraded: false,
    });
    render(App);
    await openRepo();
    await fireEvent.input(document.querySelector<HTMLTextAreaElement>(".composer textarea")!, {
      target: { value: "保留当前仓库的说明" },
    });
    await dragEvent("drop", ["C:/other"]);
    await waitFor(() => expect(mocks.addRepository).toHaveBeenCalled());
    expect(mocks.saveDraft).toHaveBeenCalledWith(repoPath, "保留当前仓库的说明");
    expect(mocks.saveDraft.mock.invocationCallOrder[0]).toBeLessThan(mocks.addRepository.mock.invocationCallOrder[0]);
  });

  it("草稿保存失败时保留当前仓库和输入", async () => {
    mocks.saveDraft.mockRejectedValue({ code: "state_write", message: "无法保存草稿。" });
    render(App);
    await openRepo();
    await fireEvent.input(document.querySelector<HTMLTextAreaElement>(".composer textarea")!, {
      target: { value: "尚未保存的说明" },
    });
    await dragEvent("drop", ["C:/other"]);
    await waitFor(() => expect(screen.getAllByText("无法保存草稿。").length).toBeGreaterThan(0));
    expect(mocks.addRepository).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLTextAreaElement>(".composer textarea")!.value).toBe("尚未保存的说明");
  });

  it("卸载后完成的原生拖放监听注册立即取消", async () => {
    const registrations: (() => void)[] = [];
    const stops = [vi.fn(), vi.fn(), vi.fn()];
    mocks.listenEvent.mockImplementation((name: string) => {
      if (!name.startsWith("tauri://drag-")) return Promise.resolve(() => {});
      const stop = stops[registrations.length];
      return new Promise((resolve) => { registrations.push(() => resolve(stop)); });
    });
    const view = render(App);
    await waitFor(() => expect(registrations).toHaveLength(3));
    view.unmount();
    registrations.forEach((finish) => finish());
    await waitFor(() => stops.forEach((stop) => expect(stop).toHaveBeenCalledOnce()));
    mocks.listenEvent.mockReset();
  });
});

/**
 * R11 的动作清单：id 与面板上要看到的标题一一对应，顺序就是注册表顺序。
 * 仓库切换那条命令的 id 带路径，动态拼在最前面。
 */
const R11_ACTIONS: { id: string; title: string }[] = [
  { id: "view.changes", title: "改动" },
  { id: "view.files", title: "文件" },
  { id: "view.history", title: "提交历史" },
  { id: "task.scope", title: "本次提交范围" },
  { id: "stage.all", title: "全部暂存" },
  { id: "unstage.all", title: "全部取消暂存" },
  { id: "commit.local", title: "提交到本地" },
  { id: "commit.push", title: "提交并推送" },
  { id: "task.publish", title: "发布分支" },
  { id: "sync.fetch", title: "获取更新" },
  { id: "sync.pull", title: "拉取" },
  { id: "sync.push", title: "推送" },
  { id: "task.stash", title: "临时保存" },
  { id: "task.merge", title: "分支合并" },
  { id: "task.branch", title: "分支与标签" },
  { id: "task.remote", title: "远程" },
  { id: "task.settings", title: "设置" },
  { id: "repo.add", title: "添加仓库" },
  { id: "repo.clone", title: "克隆仓库" },
  { id: "repo.create", title: "新建仓库" },
  { id: "repo.copyPath", title: "复制路径" },
  { id: `${REPO_SWITCH_PREFIX}${repoPath}`, title: "切换到 demo" },
  { id: "theme.light", title: "浅色外观" },
  { id: "theme.dark", title: "深色外观" },
  { id: "theme.system", title: "跟随系统外观" },
  { id: "view.refresh", title: "刷新工作区" },
  { id: "rail.toggle", title: "隐藏/显示侧栏" },
  { id: "palette.open", title: "命令面板" },
  { id: "dialog.dependencies", title: "运行依赖" },
];

/** 原清单之外后加的视图命令：文件切换、改动块跳转、聚焦搜索。 */
const ADDED_COMMAND_IDS = [
  "file.prev",
  "file.next",
  "diff.hunk.prev",
  "diff.hunk.next",
  "view.find",
  "files.quickOpen",
  "files.search",
  "file.reveal",
  "file.back",
  "file.forward",
];
const ADDED_COMMAND_TITLES = [
  "上一个文件",
  "下一个文件",
  "上一处改动",
  "下一处改动",
  "聚焦搜索",
  "按路径打开文件",
  "全仓库搜索",
  "在文件树中显示",
  "后退",
  "前进",
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

/** 键盘层挂在 window 上，所以用真实事件派发；tick 保证 Svelte 已把状态刷进 DOM。 */
async function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }));
  await tick();
}

/** 打开夹具仓库，等到改动视图与差异都就绪。 */
async function openRepo() {
  await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
  await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
  await waitFor(() => expect(document.querySelector(".file-list")).toBeTruthy());
  await waitFor(() => expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
}

/** 合并会话夹具：只有 operation 与 canAbort 影响左栏提示。 */
function mergeSessionWith(operation: "merge" | "none") {
  return {
    generation: 4,
    operation,
    canContinue: false,
    canAbort: operation === "merge",
    source: null,
    target: "main",
    headOid: branch.headOid,
    conflicts: [],
    unresolved: 0,
    note: "",
  };
}

/** 换掉夹具的最近仓库列表，其余设置不变。 */
function useRecent(recent: { name: string; path: string; openedAtMs: number }[]) {
  mocks.getSettings.mockResolvedValue({
    theme: "dark",
    panelWidths: { sidebar: 256, files: 360 },
    git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" },
    recent,
    settingsWarning: null,
  });
}

/** 分支夹具：当前分支不在最前，带一条其他工作区占用的分支和 origin/HEAD。 */
function branchFixture() {
  const record = (name: string, remote = false, worktree: string | null = null) => ({ name, remote, current: name === "main", upstream: null, worktree });
  return {
    generation: 4,
    branches: [record("origin/HEAD", true), record("origin/develop", true), record("develop"), record("shared", false, "D:/wt"), record("main")],
    snapshot,
  };
}

async function openPalette() {
  await press("k");
  return screen.findByRole("dialog", { name: "命令面板" });
}

/** 主题解析用：可控的 matchMedia，能改 matches 并通知已注册的 change 监听。 */
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");

function stubSystemDark(matches: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const media = {
    matches,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      listeners.delete(listener);
    },
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => media,
  });
  return {
    set(next: boolean) {
      media.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
    listeners,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 审阅进度是模块级会话状态：用例之间必须清空，否则上一个用例的标记会带进来。
  resetReviewProgress();
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
  // 文件视图的目录与内容：外壳测试只用来看视图是否保活、是否按需读取。
  mocks.repositoryDirectory.mockResolvedValue({
    generation: 4,
    path: "",
    entries: [
      { name: "README.md", path: "README.md", kind: "file", ignored: false, size: 20, error: null },
      { name: "src", path: "src", kind: "directory", ignored: false, size: null, error: null },
    ],
    errors: [],
  });
  mocks.repositoryFileContent.mockResolvedValue({
    generation: 4,
    path: "README.md",
    kind: "text",
    size: 20,
    offset: 0,
    lines: ["# demo"],
    nextOffset: 1,
    hasMore: false,
    truncated: false,
    message: null,
  });
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
      files: [],
    };
  });
  mocks.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
  mocks.mergePreview.mockImplementation(async (_path: string, source: string, target: string | null) => ({
    generation: 5,
    source,
    target: target ?? "main",
    headOid: branch.headOid,
    dirty: false,
    localPaths: [],
    canStart: true,
    operation: "none",
    note: "可以合并或变基。",
    current: "main",
    needsSwitch: Boolean(target),
    incoming: 1,
    outgoing: 1,
    upToDate: false,
    fastForward: false,
    commits: [],
    files: [],
    filesTotal: 0,
    conflictCheck: "clean",
    conflictPaths: [],
    blocker: null,
  }));
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
});

describe("审阅进度（R5）", () => {
  /** 审阅入口有两处（改动列表行与当前差异工具条）：列表断言只看左栏。 */
  function fileList(): HTMLElement {
    const node = document.querySelector<HTMLElement>(".file-list");
    if (!node) throw new Error("改动列表没有渲染");
    return node;
  }

  /** 同一路径可能同时出现在未暂存与已暂存两组：同一路径的按钮重复，取第一行即可。 */
  async function reviewButton(name: string): Promise<HTMLElement> {
    await waitFor(() => expect(within(fileList()).queryAllByRole("button", { name }).length).toBeGreaterThan(0));
    return within(fileList()).getAllByRole("button", { name })[0];
  }

  function tokenFor(path: string, token: string) {
    return {
      generation: 4,
      path,
      state: "current" as const,
      token,
      staged: "none" as const,
      unstaged: "modified" as const,
      untracked: false,
      unmerged: false,
      contentVersion: "worktree:abc",
      message: "已确认这个文件当前的整份内容与改动。",
    };
  }

  it("标记与撤销同步计数，隐藏已审阅只改显示", async () => {
    mocks.repositoryReviewToken.mockImplementation(async (_repo: string, path: string) => tokenFor(path, `tok:${path}`));
    render(App);
    await openRepo();

    await fireEvent.click(await reviewButton("标记 src/App.svelte 已审阅"));
    await waitFor(() => expect(screen.getByLabelText("已审阅 1 个，共 6 个改动文件")).toBeTruthy());
    expect(mocks.repositoryReviewToken).toHaveBeenCalledWith(repoPath, "src/App.svelte", 4, expect.any(Number));

    // 隐藏只折叠已审阅的行：分组数量与提交范围不变，计数仍然可读。
    await fireEvent.click(screen.getByRole("button", { name: "隐藏已审阅" }));
    await tick();
    expect(within(fileList()).queryAllByRole("button", { name: /撤销 src\/App\.svelte 的已审阅标记/ })).toHaveLength(0);
    expect(within(fileList()).queryAllByRole("button", { name: /标记 src\/App\.svelte 已审阅/ })).toHaveLength(0);
    expect(within(fileList()).getAllByRole("button", { name: "标记 src/app.css 已审阅" }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("已审阅 1 个，共 6 个改动文件")).toBeTruthy();

    // 撤销仍然可用：隐藏状态下重新显示后能撤销标记。
    await fireEvent.click(screen.getByRole("button", { name: "隐藏已审阅" }));
    await tick();
    await fireEvent.click(await reviewButton("撤销 src/App.svelte 的已审阅标记"));
    await waitFor(() => expect(screen.getByLabelText("已审阅 0 个，共 6 个改动文件")).toBeTruthy());
    expect(within(fileList()).getAllByRole("button", { name: "标记 src/App.svelte 已审阅" }).length).toBeGreaterThan(0);
  });

  it("刷新后只重验已标记路径：变化的失效，其他标记保留", async () => {
    let round = 0;
    mocks.repositoryReviewToken.mockImplementation(async (_repo: string, path: string) =>
      tokenFor(path, path === "src/App.svelte" && round > 0 ? `tok:${path}:changed` : `tok:${path}`),
    );
    render(App);
    await openRepo();
    await fireEvent.click(await reviewButton("标记 src/App.svelte 已审阅"));
    await fireEvent.click(await reviewButton("标记 src/app.css 已审阅"));
    await waitFor(() => expect(screen.getByLabelText("已审阅 2 个，共 6 个改动文件")).toBeTruthy());
    mocks.repositoryReviewToken.mockClear();

    // 外部变化：App.svelte 的内容换了，app.css 没有。
    round = 1;
    const focus = mocks.listenEvent.mock.calls.find(([name]) => name === "window-focused")![1];
    focus();
    await waitFor(() => expect(mocks.repositoryReviewToken).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText("已审阅 1 个，共 6 个改动文件")).toBeTruthy());
    expect(within(fileList()).getAllByRole("button", { name: "标记 src/App.svelte 已审阅" }).length).toBeGreaterThan(0);
    expect(within(fileList()).getAllByRole("button", { name: "撤销 src/app.css 的已审阅标记" }).length).toBeGreaterThan(0);
    // 只为已标记的两条路径请求，未标记的文件不计算 token。
    const queried = mocks.repositoryReviewToken.mock.calls.map((call) => call[1]).sort();
    expect(queried).toEqual(["src/App.svelte", "src/app.css"]);
    expect(screen.getByRole("alert").textContent).toContain("快照已变化");
  });

  it("独立打开另一个仓库清空进度", async () => {
    mocks.repositoryReviewToken.mockImplementation(async (_repo: string, path: string) => tokenFor(path, `tok:${path}`));
    useRecent([{ name: "demo", path: repoPath, openedAtMs: 1 }, { name: "other", path: "C:/work/other", openedAtMs: 2 }]);
    mocks.openRepository.mockImplementation(async (path: string) => ({
      summary: { name: path.split("/").pop() ?? path, path },
      generation: 4,
      snapshot,
      draft: "",
      watchDegraded: false,
    }));
    render(App);
    await openRepo();
    await fireEvent.click(await reviewButton("标记 src/App.svelte 已审阅"));
    await waitFor(() => expect(screen.getByLabelText("已审阅 1 个，共 6 个改动文件")).toBeTruthy());

    await fireEvent.click(screen.getByRole("button", { name: "当前仓库 demo" }));
    const popover = await screen.findByRole("dialog", { name: "切换仓库" });
    await fireEvent.click(within(popover).getByRole("option", { name: /other/ }));
    await waitFor(() => expect(mocks.openRepository).toHaveBeenLastCalledWith("C:/work/other", expect.any(Number)));
    await waitFor(() => expect(screen.getByLabelText("已审阅 0 个，共 6 个改动文件")).toBeTruthy());
    expect(within(fileList()).getAllByRole("button", { name: /标记 .* 已审阅/ }).length).toBeGreaterThan(0);
  });

  it("文件视图与审阅入口不提供新建、删除、保存、运行或 LSP 能力", async () => {
    render(App);
    await openRepo();
    // 文件视图、改动列表与差异工具条：只读浏览与审阅，不含文件管理、编辑或 IDE 语义入口。
    const texts = [
      ...document.querySelectorAll<HTMLElement>(".workbench-view button, .workbench-view [role=menuitem]"),
    ].map((node) => (node.getAttribute("aria-label") ?? "") + (node.textContent ?? ""));
    for (const banned of ["新建文件", "新建目录", "移动文件", "重命名文件", "删除文件", "保存文件", "另存", "运行", "调试", "定义", "引用", "重构", "评论", "批准"]) {
      expect(texts.some((text) => text.includes(banned)), `${banned} 不该出现在文件与审阅入口`).toBe(false);
    }
  });
});

describe("应用外壳", () => {
  it("标题栏不超过 6 个常驻控件，刷新、发布分支、只关联上游、远程管理都不在里面", async () => {
    render(App);

    // 未打开仓库时不超过 6 个（R6）：分支和同步没有对象，不显示无效控件。
    const idle = [...document.querySelectorAll<HTMLElement>("[data-titlebar-control]")];
    expect(idle.length).toBeLessThanOrEqual(6);
    expect(idle.map((control) => control.getAttribute("aria-label"))).toEqual([
      `${BRAND.full} 品牌菜单`,
      "打开仓库",
      "主题：深色",
      "设置",
    ]);
    expect(document.querySelector(".branch-pill"), "起始页不显示“无分支”和“同步”").toBeNull();

    await openRepo();

    const header = document.querySelector("header.titlebar");
    expect(header, "标题栏要存在").toBeTruthy();
    // 拖拽区在整条标题栏上；交互控件自己不带这个属性，所以不会被拖拽命中。
    expect(header!.hasAttribute("data-tauri-drag-region")).toBe(true);

    const controls = [...header!.querySelectorAll<HTMLElement>("[data-titlebar-control]")];
    expect(controls).toHaveLength(6);
    for (const control of controls) {
      expect(control.tagName, "常驻控件都是可交互按钮").toBe("BUTTON");
      expect(control.hasAttribute("data-tauri-drag-region"), "交互控件不参与拖拽").toBe(false);
    }

    // 逐项比对六个角色，而不是只看数量：品牌、仓库、分支、同步组、主题、设置。
    const labels = controls.map((control) => control.getAttribute("aria-label") ?? "");
    expect(labels[0]).toBe(`${BRAND.full} 品牌菜单`);
    expect(labels[1]).toBe("当前仓库 demo");
    expect(labels[2]).toBe("当前分支 main");
    expect(labels[3]).toMatch(/^同步 /);
    expect(labels[4]).toBe("主题：深色");
    expect(labels[5]).toBe("设置");

    for (const control of controls) {
      for (const banned of ["刷新", "发布分支", "只关联上游", "远程管理"]) {
        expect(control.getAttribute("aria-label") ?? "", `${banned} 不该出现在标题栏`).not.toContain(banned);
        expect(control.getAttribute("title") ?? "").not.toContain(banned);
      }
    }

    // 刷新离开标题栏后仍然可达：状态栏上的刷新按钮走同一条 view.refresh 命令。
    const statusbar = document.querySelector(".statusbar");
    expect(statusbar).toBeTruthy();
    const refresh = within(statusbar as HTMLElement).getByRole("button", { name: "刷新工作区" });
    const before = mocks.refreshStatus.mock.calls.length;
    await fireEvent.click(refresh);
    await waitFor(() => expect(mocks.refreshStatus.mock.calls.length).toBe(before + 1));
  });

  it("主界面只有标题栏、左栏、主内容和状态栏，没有常驻仓库列表", async () => {
    useRecent([{ name: "demo", path: repoPath, openedAtMs: 1 }, { name: "other", path: "C:/work/other", openedAtMs: 2 }]);
    render(App);
    await openRepo();
    expect(document.querySelector(".rail"), "rail 已删除").toBeNull();
    expect(document.querySelector(".workspace > aside"), "工作区只剩主内容").toBeNull();
    expect(document.querySelector(".workspace")?.children).toHaveLength(1);
    expect(document.body.textContent, "其他仓库只在弹层里出现").not.toContain("other");
    expect(document.querySelector(".pane .file-list"), "文件列表在左栏").toBeTruthy();
    expect(document.querySelector(".pane .composer"), "提交区在左栏").toBeTruthy();
  });

  it("左栏头部切换视图，隐藏后仍能进入，导航恰好是改动、文件与提交历史", async () => {
    render(App);
    await openRepo();

    const activeNav = () =>
      document.querySelector<HTMLElement>('.workbench-view[data-active="true"] nav[aria-label="视图"]')!;
    const labelsOf = (nav: HTMLElement) =>
      [...nav.querySelectorAll<HTMLElement>("button")].map((item) => (item.getAttribute("aria-label") ?? "").replace(/\s+\d+$/, ""));
    const current = () => activeNav().querySelector<HTMLElement>('[aria-current="page"]')?.getAttribute("aria-label");

    expect(labelsOf(activeNav())).toEqual(["改动", "提交历史", "文件"]);
    expect(current()).toMatch(/^改动/);
    // 点第二项真的换成历史，而不是只换高亮；历史懒加载期间左栏头部也不消失。
    await fireEvent.click(within(activeNav()).getByRole("button", { name: "提交历史" }));
    expect(current()).toBe("提交历史");
    await waitFor(() => expect(document.querySelector(".history-list")).toBeTruthy());
    expect(current()).toBe("提交历史");

    // 隐藏后条目和名称都还在 DOM，⌘1/⌘2 与命令面板照常切换。
    await press("b");
    expect(document.querySelector<HTMLElement>(".workspace")?.dataset.sidebar).toBe("hidden");
    await press("1");
    await waitFor(() => expect(current()).toMatch(/^改动/));
    await press("2");
    await waitFor(() => expect(current()).toBe("提交历史"));
    expect(labelsOf(activeNav())).toEqual(["改动", "提交历史", "文件"]);
  });

  it("三个视图同时保活：⌘3 进入文件视图，隐藏视图 inert，切回改动恢复差异", async () => {
    render(App);
    await openRepo();
    const view = () =>
      document.querySelector('.workbench-view[data-active="true"] [aria-current="page"]')?.getAttribute("data-view");
    expect(view()).toBe("changes");

    await press("3");
    await waitFor(() => expect(view()).toBe("files"));
    const views = [...document.querySelectorAll<HTMLElement>(".workbench-view")];
    expect(views, "三个视图都在 DOM 里，切换不重挂").toHaveLength(3);
    expect(views.filter((item) => item.getAttribute("aria-hidden") === "true")).toHaveLength(2);
    expect(views.find((item) => item.dataset.active === "true")?.hasAttribute("inert")).toBe(false);
    await waitFor(() => expect(mocks.repositoryDirectory).toHaveBeenCalled());

    // ⌘F 落在当前视图的搜索框：文件视图是树过滤，不是改动的文件搜索。
    await press("f");
    await tick();
    expect(document.activeElement?.id).toBe("files-search");

    mocks.loadDiff.mockClear();
    await press("1");
    await waitFor(() => expect(view()).toBe("changes"));
    await waitFor(() => expect(mocks.loadDiff).toHaveBeenCalled());
  });

  it("隐藏的页面不继续读取，回到页面才读取最新状态", async () => {
    mocks.historyPage.mockImplementation(async (_repo, query, offset, generation) => ({ generation, query, offset, pageSize: 100, hasMore: false, state: "ok", commits }));
    mocks.commitDetail.mockImplementation(async (_repo, _oid, _parent, generation) => ({ generation, commit: commits[0], body: "", root: false, merge: false, selectedParent: commits[0].parents[0], files: [{ path: "sample.txt", originalPath: null, status: "modified" }] }));
    mocks.commitFileDiff.mockImplementation(async (_repo, _oid, _parent, path, generation) => ({ ...diffFor(path, false), generation }));
    render(App);
    await openRepo();
    await press("2");
    await waitFor(() => expect(mocks.commitFileDiff).toHaveBeenCalled());
    mocks.loadDiff.mockClear();
    mocks.refreshStatus.mockResolvedValue({ ...snapshot, generation: 5 });
    const changed = mocks.listenEvent.mock.calls.find(([name]) => name === "repo-changed")![1];
    changed({ path: repoPath, generation: 5, degraded: false });
    await waitFor(() => expect(mocks.refreshStatus).toHaveBeenCalled());
    await tick();
    expect(mocks.loadDiff, "历史页显示时不读取隐藏的改动差异").not.toHaveBeenCalled();
    await press("1");
    await waitFor(() => expect(mocks.loadDiff).toHaveBeenCalled());
    await tick();
    mocks.historyPage.mockClear();
    mocks.commitDetail.mockClear();
    mocks.commitFileDiff.mockClear();
    mocks.refreshStatus.mockResolvedValue({ ...snapshot, generation: 6 });
    changed({ path: repoPath, generation: 6, degraded: false });
    await tick();
    await tick();
    expect(mocks.historyPage).not.toHaveBeenCalled();
    expect(mocks.commitDetail).not.toHaveBeenCalled();
    expect(mocks.commitFileDiff).not.toHaveBeenCalled();
    await press("2");
    await waitFor(() => expect(mocks.historyPage).toHaveBeenCalled());
    expect(mocks.historyPage.mock.calls.at(-1)?.[3]).toBe(6);
  });

  it("临时保存一次点击可达，只打开任务，不切换主视图", async () => {
    render(App);
    await openRepo();
    const view = () => document.querySelector('.workbench-view[data-active="true"] [aria-current="page"]')?.getAttribute("data-view");
    expect(view()).toBe("changes");
    await fireEvent.click(screen.getByRole("button", { name: "临时保存" }));
    await waitFor(() => expect(document.querySelector('[data-panel="stash"]')).toBeTruthy());
    expect(view()).toBe("changes");
  });

  it("合并提示：无合并不显示，有冲突显示数量，冲突解决但未完成时仍在，点击进入合并，两个视图都有", async () => {
    const banner = () => document.querySelector<HTMLElement>('.workbench-view[data-active="true"] [data-merge-banner]');
    render(App);
    await openRepo();
    expect(banner(), "没有合并时不占位").toBeNull();

    // 冲突：快照里有未合并文件。
    const conflicted = { ...changes[0], unmerged: true };
    mocks.mergeSession.mockResolvedValue(mergeSessionWith("merge"));
    mocks.refreshStatus.mockResolvedValue({ ...snapshot, files: [conflicted, ...changes.slice(1)] });
    await press("r");
    await waitFor(() => expect(banner()?.textContent).toContain("1 个冲突待处理"));
    expect(banner()?.getAttribute("aria-label")).toContain("合并进行中");

    // 冲突全部解决：计数归零，但合并还没完成。
    mocks.refreshStatus.mockResolvedValue({ ...snapshot, files: changes });
    await press("r");
    await waitFor(() => expect(banner()?.textContent).toContain("可以完成合并"));

    await press("2");
    await waitFor(() => expect(document.querySelector(".history-list")).toBeTruthy());
    expect(banner()?.textContent, "历史视图同样显示").toContain("可以完成合并");
    await fireEvent.click(banner()!);
    await waitFor(() => expect(document.querySelector('[data-panel="merge"], .merge-panel')).toBeTruthy());
  });

  it("左栏隐藏时状态栏接替合并提示，可点击进入，左栏显示时不重复", async () => {
    mocks.mergeSession.mockResolvedValue(mergeSessionWith("merge"));
    render(App);
    await openRepo();
    const status = () => document.querySelector<HTMLElement>("[data-merge-status]");
    const banner = () => document.querySelector<HTMLElement>('.workbench-view[data-active="true"] [data-merge-banner]');
    await waitFor(() => expect(banner()).toBeTruthy());
    expect(status(), "左栏显示时只有左栏一处").toBeNull();

    await press("b");
    expect(status()?.tagName).toBe("BUTTON");
    expect(status()?.textContent, "文案与左栏一致").toContain(banner()!.textContent!.trim());
    expect(status()?.getAttribute("aria-label")).toBe(banner()?.getAttribute("aria-label"));
    await fireEvent.click(status()!);
    await waitFor(() => expect(document.querySelector('[data-panel="merge"], .merge-panel')).toBeTruthy());
  });

  it("没有合并时左栏隐藏，状态栏也没有提示", async () => {
    render(App);
    await openRepo();
    await press("b");
    expect(document.querySelector("[data-merge-status]")).toBeNull();
  });

  it("探测返回 stale 时保留合并提示，其他失败才收起", async () => {
    mocks.mergeSession.mockResolvedValue(mergeSessionWith("merge"));
    render(App);
    await openRepo();
    const banner = () => document.querySelector('.workbench-view[data-active="true"] [data-merge-banner]');
    await waitFor(() => expect(banner()).toBeTruthy());

    const calls = mocks.mergeSession.mock.calls.length;
    mocks.mergeSession.mockRejectedValue({ code: "stale", message: "状态已变化", generation: 9 });
    await press("r");
    await waitFor(() => expect(mocks.mergeSession.mock.calls.length).toBe(calls + 1));
    await tick();
    await tick();
    expect(banner(), "stale 不代表合并结束").toBeTruthy();

    mocks.mergeSession.mockRejectedValue({ code: "merge_failed", message: "读取失败" });
    await press("r");
    await waitFor(() => expect(banner()).toBeNull());
  });

  it("较早的探测晚到达时不盖掉新结果", async () => {
    mocks.mergeSession.mockResolvedValue(mergeSessionWith("merge"));
    render(App);
    await openRepo();
    const banner = () => document.querySelector('.workbench-view[data-active="true"] [data-merge-banner]');
    await waitFor(() => expect(banner()).toBeTruthy());

    const resolvers: ((value: unknown) => void)[] = [];
    mocks.mergeSession.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    await press("r");
    await waitFor(() => expect(resolvers).toHaveLength(1));
    await waitFor(() => expect(document.querySelector("[data-diff-row]")).toBeTruthy());
    await tick();
    await press("r");
    await waitFor(() => expect(resolvers).toHaveLength(2));

    resolvers[1](mergeSessionWith("merge"));
    await tick();
    resolvers[0](mergeSessionWith("none"));
    await tick();
    await tick();
    expect(banner(), "旧探测说没有合并，也不能盖掉较新的结果").toBeTruthy();

    // 同一旧结果反过来也不能抢先：较新探测说结束时提示收起。
    const more: ((value: unknown) => void)[] = [];
    mocks.mergeSession.mockImplementation(() => new Promise((resolve) => more.push(resolve)));
    await press("r");
    await waitFor(() => expect(more).toHaveLength(1));
    await press("r");
    await waitFor(() => expect(more).toHaveLength(2));
    more[1](mergeSessionWith("none"));
    await waitFor(() => expect(banner()).toBeNull());
    more[0](mergeSessionWith("merge"));
    await tick();
    await tick();
    expect(banner()).toBeNull();
  });

  it("合并在外部完成后，下一次刷新收起提示", async () => {
    mocks.mergeSession.mockResolvedValue(mergeSessionWith("merge"));
    render(App);
    await openRepo();
    const banner = () => document.querySelector('.workbench-view[data-active="true"] [data-merge-banner]');
    await waitFor(() => expect(banner()).toBeTruthy());
    mocks.mergeSession.mockResolvedValue(mergeSessionWith("none"));
    await press("r");
    await waitFor(() => expect(banner()).toBeNull());
  });

  it("命令面板按 R11 的 id 清单逐项列出动作，草稿为空时两项提交都带原因", async () => {
    // 注册表一侧：原 27 条都在且顺序稳定（仓库切换插在仓库组的末尾），后加的视图命令跟在文件切换后面。
    const ids = paletteItems(commandState()).map((item) => item.id);
    expect(ids.filter((id) => !ADDED_COMMAND_IDS.includes(id))).toEqual(R11_ACTIONS.map((action) => action.id));
    expect(ids.filter((id) => ADDED_COMMAND_IDS.includes(id))).toEqual(ADDED_COMMAND_IDS);

    // 暂存区非空、草稿为空：这是「面板里看起来能点、按钮却是灰的」最容易分叉的时刻。
    render(App);
    await openRepo();
    const palette = await openPalette();
    const options = within(palette).getAllByRole("option");
    expect(options, "面板条目与注册表动作一一对应").toHaveLength(ids.length);
    const titles = options.map((option) => option.firstElementChild?.textContent?.trim());
    expect(titles.filter((title) => !ADDED_COMMAND_TITLES.includes(title ?? ""))).toEqual(R11_ACTIONS.map((action) => action.title));
    expect(titles, "同组命令连续，文件切换紧跟两个视图").toEqual(expect.arrayContaining(ADDED_COMMAND_TITLES));
    expect(titles.indexOf("上一个文件")).toBe(titles.indexOf("提交历史") + 1);
    expect(titles.indexOf("下一个文件")).toBe(titles.indexOf("提交历史") + 2);

    // 不可用的条目必须就地给出原因，不允许静默失败。
    for (const option of options) {
      if (option.getAttribute("aria-disabled") === "true") {
        expect(option.querySelector(".palette-reason")?.textContent?.trim(), option.textContent ?? "").toBeTruthy();
      }
    }

    const local = within(palette).getByRole("option", { name: /提交到本地/ });
    const push = within(palette).getByRole("option", { name: /提交并推送/ });
    for (const option of [local, push]) {
      expect(option.getAttribute("aria-disabled")).toBe("true");
      expect(option.textContent).toContain("填写提交说明后即可提交");
    }
    await fireEvent.click(local);
    expect(mocks.commitChanges, "不可用的条目点了也不提交").not.toHaveBeenCalled();
    expect(palette.isConnected, "点了不可用条目，面板留在原地").toBe(true);

    // 填好说明后两处一起恢复：不可用不是写死的。
    await fireEvent.keyDown(palette, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "命令面板" })).toBeNull());
    await fireEvent.input(document.querySelector<HTMLTextAreaElement>(".composer textarea")!, {
      target: { value: "补齐外壳断言" },
    });
    const reopened = await openPalette();
    expect(within(reopened).getByRole("option", { name: /提交到本地/ }).getAttribute("aria-disabled")).toBe("false");
    expect(within(reopened).getByRole("option", { name: /提交并推送/ }).getAttribute("aria-disabled")).toBe("false");
  });

  it("主题三态：跟随系统解析成 light/dark 而不是 system，并随系统设置变化", async () => {
    const system = stubSystemDark(false);
    render(App);

    // 默认深色来自已保存的选择。
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));

    // 第三态：选择跟随系统后，documentElement 上只能出现解析结果。
    let palette = await openPalette();
    await fireEvent.click(within(palette).getByRole("option", { name: /跟随系统外观/ }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(document.documentElement.dataset.theme).not.toBe("system");
    expect(mocks.setTheme, "第三态同样被写回设置").toHaveBeenCalledWith("system");

    // 系统切到深色偏好：解析结果跟着变，仍然不是 "system"。
    system.set(true);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(document.documentElement.dataset.theme).not.toBe("system");

    // 另外两态各自落到具体值，三态不是只有一个能用的选项。
    palette = await openPalette();
    await fireEvent.click(within(palette).getByRole("option", { name: /浅色外观/ }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(mocks.setTheme).toHaveBeenLastCalledWith("light");

    palette = await openPalette();
    await fireEvent.click(within(palette).getByRole("option", { name: /深色外观/ }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(mocks.setTheme).toHaveBeenLastCalledWith("dark");
  });

  it("读与写分开：只读期间说「正在读取」，写操作期间才说「正在写入」", () => {
    const reading = paletteItems(commandState({ writeLocked: true, writing: false, reading: true }));
    const writing = paletteItems(commandState({ writeLocked: true, writing: true, reading: false }));
    const reasonOf = (items: ReturnType<typeof paletteItems>, id: string) =>
      items.find((item) => item.id === id)?.reason;

    // 同步与刷新在只读期间只是「等读取结束」，不是被写入挡住。
    for (const id of ["sync.fetch", "sync.pull", "sync.push", "view.refresh", "repo.add", "commit.local"]) {
      expect(reasonOf(reading, id), `${id} 在只读期间的原因`).toBe("正在读取，稍后再试");
      expect(reasonOf(writing, id), `${id} 在写操作期间的原因`).toBe("正在写入，稍后再试");
    }

    // 切换仓库只听「有没有任意操作在飞行中」：只读整仓库仍可切换（外壳会取消上一次读取），
    // 差异续读与写操作都被拒，原因按写/读分开说（R11）。
    const switchId = `${REPO_SWITCH_PREFIX}${repoPath}`;
    const diffReading = paletteItems(commandState({ writeLocked: true, writing: false, reading: true, switchingBlocked: true }));
    const writingState = paletteItems(commandState({ writeLocked: true, writing: true, reading: false, switchingBlocked: true }));
    expect(reading.find((item) => item.id === switchId)?.enabled, "只读整仓库不锁切换").toBe(true);
    expect(diffReading.find((item) => item.id === switchId)?.enabled, "差异续读期间不能切仓库").toBe(false);
    expect(reasonOf(diffReading, switchId)).toBe("正在读取，稍后再试");
    expect(writingState.find((item) => item.id === switchId)?.enabled).toBe(false);
    expect(reasonOf(writingState, switchId)).toBe("正在写入，稍后再试");
  });

  it("差异续读期间三个入口对切换仓库的结论一致，拖入目录会说明原因而不是静默失败（R11）", async () => {
    // 续读那一次 loadDiff 挂起不结算，把外壳稳定停在 pending="diff" 上。
    let hold: ((value: DiffResponse) => void) | null = null;
    mocks.loadDiff.mockImplementation(
      async (_repo: string, path: string, staged: boolean, _generation: number, _request: number, _original: string | null, offset: number) => {
        const base = diffFor(path, staged);
        // 首屏只给 3 行、声明总共 12 行：差异区因此出现「继续加载」。
        if (offset === 0) return { ...base, lines: base.lines.slice(0, 3), hunks: [{ ...base.hunks[0], lineCount: 3 }], totalLines: 12 };
        return new Promise<DiffResponse>((resolve) => {
          hold = resolve;
        });
      },
    );

    useRecent([{ name: "demo", path: repoPath, openedAtMs: 1 }, { name: "other", path: "C:/work/other", openedAtMs: 2 }]);
    render(App);
    await openRepo();
    const openedBefore = mocks.openRepository.mock.calls.length;
    // 这是 App 内的真实路径：标题栏弹层与面板都通向同一个 openRecent。
    const clicked = () => mocks.openRepository.mock.calls.length;

    await fireEvent.click(screen.getByRole("button", { name: "继续加载" }));
    await waitFor(() => expect(hold, "续读已经开始且没有结算").not.toBeNull());

    // 入口三：拖入目录没有可以置灰的条目，所以必须给出同一个原因，而不是什么都不发生。
    await dragEvent("drop", ["C:/another"]);
    expect(mocks.addRepository, "差异续读时拖入目录也不能切换").not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector(".toast.ok .toast-text")?.textContent).toBe("正在读取，稍后再试"));

    // 入口一：命令面板就地禁用并说明「正在读取」，点了也不会偷偷发请求。
    let palette = await openPalette();
    const switchOption = () => within(palette).getByRole("option", { name: /切换到 demo/ });
    expect(switchOption().getAttribute("aria-disabled"), "面板与执行 guard 同源").toBe("true");
    expect(switchOption().textContent).toContain("正在读取，稍后再试");
    await fireEvent.click(switchOption());
    expect(clicked(), "面板里点不动就不该发请求").toBe(openedBefore);
    await fireEvent.keyDown(palette, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "命令面板" })).toBeNull());

    // 入口二：标题栏仓库弹层里的其他仓库同样置灰，当前仓库不需要切换，不跟着置灰。
    const trigger = screen.getByRole("button", { name: "当前仓库 demo" });
    await fireEvent.click(trigger);
    const popover = await screen.findByRole("dialog", { name: "切换仓库" });
    const other = within(popover).getByRole("option", { name: /other/ });
    expect(other.getAttribute("aria-disabled"), "标题栏弹层与面板同源").toBe("true");
    // 灰条目也要说出原因：README 承诺「就地禁用并给出原因」，所以写进条目文本和 title。
    expect(other.textContent, "条目上带着同一个原因").toContain("正在读取，稍后再试");
    expect(other.getAttribute("title")).toBe("正在读取，稍后再试");
    expect(within(popover).getByRole("option", { name: /demo/ }).getAttribute("aria-disabled")).toBeNull();
    await fireEvent.click(other);
    await fireEvent.keyDown(within(popover).getByRole("combobox"), { key: "Enter" });
    expect(clicked(), "弹层里点不动、回车也不发请求").toBe(openedBefore);
    await press("Escape");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换仓库" })).toBeNull());
    expect(document.activeElement, "Esc 把焦点还给触发按钮").toBe(trigger);

    // 右键菜单的「打开」与条目同源，同样带着原因。
    await fireEvent.click(trigger);
    const again = await screen.findByRole("dialog", { name: "切换仓库" });
    await fireEvent.contextMenu(within(again).getByRole("option", { name: /other/ }));
    const openItem = await screen.findByRole("menuitem", { name: /打开/ });
    expect(openItem.getAttribute("aria-disabled") ?? String((openItem as HTMLButtonElement).disabled)).toBe("true");
    await fireEvent.click(openItem);
    expect(clicked(), "右键菜单同样不发请求").toBe(openedBefore);
    await fireEvent.mouseDown(document.querySelector(".statusbar")!);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换仓库" })).toBeNull());

    // 续读结算后三个入口一起恢复：面板可用、弹层点击真的换仓库。
    const release = hold as unknown as (value: DiffResponse) => void;
    release(diffFor("src/App.svelte", false));
    palette = await openPalette();
    await waitFor(() => expect(within(palette).getByRole("option", { name: /切换到 demo/ }).getAttribute("aria-disabled")).toBe("false"));
    await fireEvent.keyDown(palette, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "命令面板" })).toBeNull());
    await fireEvent.click(trigger);
    const restored = await screen.findByRole("dialog", { name: "切换仓库" });
    await fireEvent.click(within(restored).getByRole("option", { name: /other/ }));
    await waitFor(() => expect(clicked()).toBe(openedBefore + 1));
  });

  it("仓库弹层：搜索路径后回车直接切换，同名仓库显示完整路径", async () => {
    const twin = "D:/archive/2019/demo";
    useRecent([
      { name: "demo", path: repoPath, openedAtMs: 1 },
      { name: "demo", path: twin, openedAtMs: 2 },
      { name: "gateway", path: "C:/work/gateway", openedAtMs: 3 },
    ]);
    render(App);
    await openRepo();
    const trigger = screen.getByRole("button", { name: "当前仓库 demo" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    await fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const popover = await screen.findByRole("dialog", { name: "切换仓库" });
    const search = within(popover).getByRole("combobox") as HTMLInputElement;
    await waitFor(() => expect(document.activeElement, "打开后焦点在搜索框").toBe(search));

    // 同名两条的路径完整显示（不走截断样式），不同名的继续截断。
    expect(popover.querySelectorAll(".repo-path-full bdi")).toHaveLength(2);
    expect([...popover.querySelectorAll(".repo-path-full bdi")].map((node) => node.textContent)).toEqual([repoPath, twin]);
    expect(popover.querySelector(".repo-path bdi")?.textContent).toBe("C:/work/gateway");

    // 默认项跳过当前仓库：不输入也是一次回车换到另一个仓库。
    const activeId = () => document.getElementById(search.getAttribute("aria-activedescendant") ?? "");
    expect(activeId()?.title).toBe(twin);
    await fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(activeId()?.title).toBe("C:/work/gateway");
    await fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(activeId()?.title, "方向键循环").toBe(repoPath);

    await fireEvent.input(search, { target: { value: "archive" } });
    await waitFor(() => expect(within(popover).getAllByRole("option")).toHaveLength(1));
    await fireEvent.input(search, { target: { value: "没有这个仓库" } });
    await waitFor(() => expect(popover.textContent).toContain("没有匹配的仓库"));
    await fireEvent.keyDown(search, { key: "Enter" });
    expect(mocks.openRepository, "没有结果时回车什么都不做").toHaveBeenCalledTimes(1);

    await fireEvent.input(search, { target: { value: "archive" } });
    await waitFor(() => expect(within(popover).getAllByRole("option")).toHaveLength(1));
    // 输入法选词时的回车不算确认。
    await fireEvent.keyDown(search, { key: "Enter", isComposing: true });
    expect(mocks.openRepository).toHaveBeenCalledTimes(1);
    await fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(mocks.openRepository).toHaveBeenLastCalledWith(twin, expect.any(Number)));
    expect(screen.queryByRole("dialog", { name: "切换仓库" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("仓库弹层：点外面关闭，选当前仓库只收起，底部是打开、克隆、新建", async () => {
    render(App);
    await openRepo();
    const trigger = screen.getByRole("button", { name: "当前仓库 demo" });
    const open = async () => {
      await fireEvent.click(trigger);
      return screen.findByRole("dialog", { name: "切换仓库" });
    };

    await open();
    await fireEvent.mouseDown(document.querySelector(".statusbar")!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换仓库" })).toBeNull());

    // 再点触发按钮是收起，而不是先被「点外面」关掉又重新打开。
    await open();
    await fireEvent.mouseDown(trigger);
    await fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换仓库" })).toBeNull());

    const calls = mocks.openRepository.mock.calls.length;
    let popover = await open();
    await fireEvent.click(within(popover).getByRole("option", { name: /demo/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换仓库" })).toBeNull());
    expect(mocks.openRepository, "当前仓库不重新读取").toHaveBeenCalledTimes(calls);

    popover = await open();
    await fireEvent.click(within(popover).getByRole("button", { name: "打开本地仓库" }));
    await waitFor(() => expect(mocks.pickDirectory).toHaveBeenCalledWith("添加已有仓库"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换仓库" })).toBeNull());

    popover = await open();
    await fireEvent.click(within(popover).getByRole("button", { name: "新建仓库" }));
    await waitFor(() => expect(mocks.pickDirectory).toHaveBeenCalledWith("选择要新建仓库的目录"));

    popover = await open();
    await fireEvent.click(within(popover).getByRole("button", { name: "克隆远程仓库" }));
    await screen.findByRole("dialog", { name: "克隆仓库" });
  });

  it("仓库弹层：Tab 在搜索框与底部动作之间循环，写入期间底部动作禁用并说明原因", async () => {
    render(App);
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: "当前仓库 demo" }));
    const popover = await screen.findByRole("dialog", { name: "切换仓库" });
    const search = within(popover).getByRole("combobox");
    const add = within(popover).getByRole("button", { name: "打开本地仓库" });
    const create = within(popover).getByRole("button", { name: "新建仓库" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    await fireEvent.keyDown(search, { key: "Tab" });
    expect(document.activeElement, "行内按钮不进 Tab 序").toBe(add);
    await fireEvent.keyDown(add, { key: "ArrowDown" });
    await fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(create);
    await fireEvent.keyDown(create, { key: "Tab" });
    expect(document.activeElement, "到底后回到搜索框").toBe(search);
    await fireEvent.keyDown(search, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(create);

    let finish!: (value: StatusSnapshot) => void;
    mocks.fetchRemote.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await fireEvent.keyDown(create, { key: "Escape" });
    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /获取更新/ }));
    await fireEvent.click(screen.getByRole("button", { name: "当前仓库 demo" }));
    const busy = await screen.findByRole("dialog", { name: "切换仓库" });
    const blocked = within(busy).getByRole("button", { name: "打开本地仓库" }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toBe("正在写入，稍后再试");
    finish(snapshot);
    await waitFor(() => expect(blocked.disabled).toBe(false));
  });

  it("分支弹层：搜索后切换，只调一次切换并用返回的状态刷新标题栏", async () => {
    const switched = { ...snapshot, generation: 5, branch: { ...branch, name: "develop" } };
    mocks.branchState.mockResolvedValue(branchFixture());
    mocks.switchBranch.mockResolvedValue({ generation: 5, branches: [], snapshot: switched });
    render(App);
    await openRepo();
    const trigger = screen.getByRole("button", { name: "当前分支 main" });
    await fireEvent.click(trigger);
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    await waitFor(() => expect(within(popover).getAllByRole("option").length).toBe(3));
    const names = within(popover).getAllByRole("option").map((option) => option.querySelector(".branch-option-name")?.textContent);
    expect(names, "当前分支最前、本地在远程之前；含斜杠的远程分支先收起，origin/HEAD 不列出").toEqual(["main", "develop", "shared"]);
    expect(popover.textContent).not.toContain("origin/HEAD");
    expect(within(popover).getByRole("button", { name: "展开分组 origin" })).toBeTruthy();
    expect(mocks.branchState, "读分支列表不占写锁").toHaveBeenCalledTimes(1);
    expect(within(popover).getByRole("option", { name: /main/ }).getAttribute("aria-selected")).toBe("true");

    const search = within(popover).getByRole("combobox");
    await fireEvent.input(search, { target: { value: "没有" } });
    await waitFor(() => expect(popover.textContent).toContain("没有匹配的分支"));
    await fireEvent.input(search, { target: { value: "devel" } });
    await waitFor(() => expect(within(popover).getAllByRole("option")).toHaveLength(2));
    await fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(mocks.switchBranch).toHaveBeenCalledWith(repoPath, "develop", 4, expect.any(Number)));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换分支" })).toBeNull());
    expect(mocks.switchBranch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "当前分支 develop" })).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(document.querySelector(".toast.ok .toast-text")?.textContent).toBe("已切换到 develop"));
  });

  it("分支弹层：切换失败时弹层内显示原因，分支和文件列表都不变，重试能成功", async () => {
    const message = "此操作会覆盖未提交的修改，已停止。这些修改仍留在工作区。请先提交，或先临时保存，然后再继续。";
    mocks.branchState.mockResolvedValue(branchFixture());
    mocks.switchBranch.mockRejectedValueOnce({ code: "switch_failed", message, generation: 4 });
    render(App);
    await openRepo();
    const fileRows = document.querySelectorAll(".file-row").length;
    await fireEvent.click(screen.getByRole("button", { name: "当前分支 main" }));
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    await waitFor(() => expect(within(popover).getAllByRole("option").length).toBe(3));
    await fireEvent.click(within(popover).getByRole("option", { name: /^develop/ }));

    const alert = await within(popover).findByRole("alert");
    expect(alert.textContent, "原因完整出现在弹层内").toContain(message);
    expect(screen.getByRole("dialog", { name: "切换分支" }), "失败后弹层留着").toBe(popover);
    expect(screen.getByRole("button", { name: "当前分支 main" })).toBeTruthy();
    expect(document.querySelectorAll(".file-row")).toHaveLength(fileRows);
    await waitFor(() => expect(within(popover).getByRole("option", { name: /^develop/ }).getAttribute("aria-disabled")).toBeNull());

    mocks.switchBranch.mockResolvedValueOnce({ generation: 5, branches: [], snapshot: { ...snapshot, branch: { ...branch, name: "develop" } } });
    await fireEvent.click(within(popover).getByRole("option", { name: /^develop/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换分支" })).toBeNull());
    expect(mocks.switchBranch).toHaveBeenCalledTimes(2);
  });

  it("分支弹层：切换进行中和差异续读时条目置灰并说明原因，其他工作区的分支不能切", async () => {
    mocks.branchState.mockResolvedValue(branchFixture());
    let finish!: (value: StatusSnapshot) => void;
    mocks.fetchRemote.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(App);
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /获取更新/ }));

    // 写入中分支按钮仍可打开：弹层顶部说明一次原因，条目置灰并在提示里带上原因，而不是一个灰按钮。
    await fireEvent.click(screen.getByRole("button", { name: "当前分支 main" }));
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    const develop = await within(popover).findByRole("option", { name: /^develop/ });
    expect(develop.getAttribute("aria-disabled")).toBe("true");
    expect(develop.getAttribute("title")).toBe("正在写入，稍后再试");
    expect(within(popover).getByRole("status").textContent).toContain("正在写入，稍后再试");
    await fireEvent.click(develop);
    expect(mocks.switchBranch).not.toHaveBeenCalled();

    finish(snapshot);
    await waitFor(() => expect(develop.getAttribute("aria-disabled")).toBeNull());
    const shared = within(popover).getByRole("option", { name: /^shared/ });
    expect(shared.getAttribute("aria-disabled")).toBe("true");
    expect(shared.getAttribute("title")).toBe("正被其他工作区使用：D:/wt");
    expect(within(shared).getByRole("button", { name: /打开此工作区/ })).toBeTruthy();
    await fireEvent.click(shared);
    expect(mocks.switchBranch).not.toHaveBeenCalled();
  });

  it("分支弹层：列表过期时跟上 generation 重读一次，读取失败在弹层内说明", async () => {
    mocks.branchState.mockRejectedValueOnce({ code: "stale", message: "过期", generation: 9 }).mockResolvedValueOnce(branchFixture());
    render(App);
    await openRepo();
    const trigger = screen.getByRole("button", { name: "当前分支 main" });
    await fireEvent.click(trigger);
    let popover = await screen.findByRole("dialog", { name: "切换分支" });
    await waitFor(() => expect(within(popover).getAllByRole("option").length).toBe(3));
    expect(mocks.branchState.mock.calls[1].slice(0, 2)).toEqual([repoPath, 9]);
    expect(within(popover).queryByRole("alert")).toBeNull();
    await press("Escape");

    mocks.branchState.mockRejectedValueOnce({ code: "unknown", message: "读取分支失败" });
    await fireEvent.click(trigger);
    popover = await screen.findByRole("dialog", { name: "切换分支" });
    expect((await within(popover).findByRole("alert")).textContent).toContain("读取分支失败");
  });

  it("分支弹层：切换在途时再回车不会重复提交，收起换别的弹层后成功也不抢焦点", async () => {
    mocks.branchState.mockResolvedValue(branchFixture());
    let finish!: (value: unknown) => void;
    mocks.switchBranch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(App);
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: "当前分支 main" }));
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    await waitFor(() => expect(within(popover).getAllByRole("option").length).toBe(3));
    const search = within(popover).getByRole("combobox");
    await fireEvent.keyDown(search, { key: "Enter" });
    await tick();
    await fireEvent.keyDown(search, { key: "Enter" });
    await fireEvent.click(within(popover).getByRole("option", { name: /^develop/ }));
    expect(mocks.switchBranch, "写锁挡住第二次").toHaveBeenCalledTimes(1);
    expect(within(popover).getByRole("option", { name: /^develop/ }).getAttribute("title")).toBe("正在写入，稍后再试");

    await press("Escape");
    await fireEvent.click(screen.getByRole("button", { name: "当前仓库 demo" }));
    const repoPopover = await screen.findByRole("dialog", { name: "切换仓库" });
    const repoSearch = within(repoPopover).getByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(repoSearch));

    finish({ generation: 5, branches: [], snapshot: { ...snapshot, generation: 5, branch: { ...branch, name: "develop" } } });
    await screen.findByRole("button", { name: "当前分支 develop" });
    await tick();
    expect(screen.getByRole("dialog", { name: "切换仓库" }), "别的弹层不被关掉").toBe(repoPopover);
    expect(document.activeElement, "焦点留在别的弹层").toBe(repoSearch);
  });

  it("分支弹层：差异续读期间条目置灰并说明原因，结算后恢复", async () => {
    mocks.branchState.mockResolvedValue(branchFixture());
    let hold: ((value: DiffResponse) => void) | null = null;
    mocks.loadDiff.mockImplementation(
      async (_repo: string, path: string, staged: boolean, _generation: number, _request: number, _original: string | null, offset: number) => {
        const base = diffFor(path, staged);
        if (offset === 0) return { ...base, lines: base.lines.slice(0, 3), hunks: [{ ...base.hunks[0], lineCount: 3 }], totalLines: 12 };
        return new Promise<DiffResponse>((resolve) => { hold = resolve; });
      },
    );
    render(App);
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: "继续加载" }));
    await waitFor(() => expect(hold).not.toBeNull());
    await fireEvent.click(screen.getByRole("button", { name: "当前分支 main" }));
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    const develop = await within(popover).findByRole("option", { name: /^develop/ });
    expect(develop.getAttribute("aria-disabled")).toBe("true");
    expect(develop.getAttribute("title")).toBe("正在读取，稍后再试");
    expect(within(popover).getByRole("status").textContent).toContain("正在读取，稍后再试");
    await fireEvent.click(develop);
    await fireEvent.keyDown(within(popover).getByRole("combobox"), { key: "Enter" });
    expect(mocks.switchBranch).not.toHaveBeenCalled();

    (hold as unknown as (value: DiffResponse) => void)(diffFor("src/App.svelte", false));
    await waitFor(() => expect(develop.getAttribute("aria-disabled")).toBeNull());
  });

  it("分支弹层：切换返回 stale 时弹层内说明原因，跟上 generation 刷新，重试用新 generation", async () => {
    mocks.branchState.mockResolvedValue(branchFixture());
    mocks.switchBranch.mockRejectedValueOnce({ code: "stale", message: "仓库状态已变化，请重试。", generation: 7 });
    render(App);
    await openRepo();
    const refreshes = mocks.refreshStatus.mock.calls.length;
    await fireEvent.click(screen.getByRole("button", { name: "当前分支 main" }));
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    await waitFor(() => expect(within(popover).getAllByRole("option").length).toBe(3));
    await fireEvent.click(within(popover).getByRole("option", { name: /^develop/ }));
    expect((await within(popover).findByRole("alert")).textContent).toContain("仓库状态已变化，请重试。");
    expect(screen.getByRole("button", { name: "当前分支 main" }), "分支没变").toBeTruthy();
    await waitFor(() => expect(mocks.refreshStatus.mock.calls.length).toBeGreaterThan(refreshes));
    expect(mocks.refreshStatus.mock.calls.at(-1)?.[1], "外壳跟上了 generation").toBe(7);

    mocks.refreshStatus.mockResolvedValue({ ...snapshot, generation: 7 });
    await waitFor(() => expect(within(popover).getByRole("option", { name: /^develop/ }).getAttribute("aria-disabled")).toBeNull());
    mocks.switchBranch.mockResolvedValueOnce({ generation: 8, branches: [], snapshot: { ...snapshot, generation: 8, branch: { ...branch, name: "develop" } } });
    await fireEvent.click(within(popover).getByRole("option", { name: /^develop/ }));
    await waitFor(() => expect(mocks.switchBranch).toHaveBeenLastCalledWith(repoPath, "develop", 7, expect.any(Number)));
  });

  it("写锁中进入分支管理和远程：显示读取中，不下假结论，锁释放后读到真实列表", async () => {
    let finish!: (value: StatusSnapshot) => void;
    const hold = () => { mocks.fetchRemote.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })); };
    mocks.branchState.mockResolvedValue(branchFixture());
    mocks.remoteState.mockResolvedValue({
      generation: 4,
      remotes: [{ name: "origin", fetchUrl: "https://example.com/demo.git", pushUrl: null }],
      snapshot,
    });
    render(App);
    await openRepo();
    const sync = screen.getByRole("button", { name: /^同步/ });
    const startFetch = async () => {
      hold();
      await fireEvent.click(sync);
      await fireEvent.click(screen.getByRole("menuitem", { name: /获取更新/ }));
      await waitFor(() => expect(sync.classList.contains("busy")).toBe(true));
    };

    await startFetch();
    await fireEvent.click(screen.getByRole("button", { name: "当前分支 main" }));
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    await fireEvent.click(within(popover).getByRole("button", { name: "管理分支与标签" }));
    const manager = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-task-modal="branch"]');
      expect(node).toBeTruthy();
      return node!;
    });
    expect(manager.querySelector("[data-branch-loading]"), "锁定中是读取态").toBeTruthy();
    expect(manager.textContent).not.toContain("没有匹配的分支");
    expect(manager.querySelector("#branch-tab-local .count"), "不显示假的 0").toBeNull();
    finish(snapshot);
    await waitFor(() => expect(manager.querySelector("#branch-tab-local .count")?.textContent).toBe("3"));
    expect(manager.querySelector("[data-branch-loading]")).toBeNull();
    await fireEvent.click(manager.querySelector<HTMLElement>("[aria-label='关闭对话框']")!);
    await waitFor(() => expect(document.querySelector("[data-task-modal]")).toBeNull());

    await startFetch();
    // 打开同步菜单时（尚未锁定）会读一次远程列表，用来提供「推送到其他远程」；锁定之后不再读。
    mocks.remoteState.mockClear();
    await fireEvent.click(sync);
    await fireEvent.click(screen.getByRole("menuitem", { name: /^远程/ }));
    const remote = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-task-modal="remote"]');
      expect(node).toBeTruthy();
      return node!;
    });
    expect(remote.querySelector("[data-remote-loading]")).toBeTruthy();
    expect(remote.textContent).not.toContain("还没有远程");
    expect(mocks.remoteState, "锁定中不发读取").not.toHaveBeenCalled();
    finish(snapshot);
    await waitFor(() => expect(remote.textContent).toContain("https://example.com/demo.git"));
    expect(mocks.remoteState).toHaveBeenCalledTimes(1);
    expect(remote.querySelector("[data-remote-loading]")).toBeNull();

    // 关闭后焦点回到同步按钮；再打开时重新读取。
    await fireEvent.click(remote.querySelector<HTMLElement>("[aria-label='关闭对话框']")!);
    await waitFor(() => expect(document.activeElement, "Modal 关闭后焦点落在触发按钮").toBe(sync));
    await fireEvent.click(sync);
    await fireEvent.click(screen.getByRole("menuitem", { name: /^远程/ }));
    await waitFor(() => expect(mocks.remoteState).toHaveBeenCalledTimes(2));
  });

  it("推送到指定远程时播报目标，不误报成正在检查远程", async () => {
    mocks.remoteState.mockResolvedValue({ generation: 4, snapshot, remotes: [
      { name: "origin", fetchUrl: "https://example.com/demo.git", pushUrl: null },
      { name: "mirror", fetchUrl: "https://example.com/mirror.git", pushUrl: null },
    ] });
    let finish: (value: StatusSnapshot) => void = () => {};
    mocks.pushToRemote.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(App);
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: /^推送到 mirror/ }));
    await waitFor(() => expect(mocks.pushToRemote).toHaveBeenCalledWith(repoPath, "mirror", 4, expect.any(Number)));
    expect(screen.getByText("正在推送到 mirror")).toBeTruthy();
    finish(snapshot);
    await waitFor(() => expect(document.querySelector(".toast-text")?.textContent).toBe("已推送到 mirror，没有强行推送，上游保持不变。"));
  });

  it("低频入口：分支弹层进入新建、合并和管理，同步菜单进入远程，命令面板的分支与标签仍是管理界面", async () => {
    mocks.branchState.mockResolvedValue(branchFixture());
    mocks.tagState.mockResolvedValue({ generation: 4, tags: [], snapshot });
    mocks.remoteState.mockResolvedValue({ generation: 4, remotes: [], snapshot });
    render(App);
    await openRepo();
    const trigger = screen.getByRole("button", { name: "当前分支 main" });
    const closeModal = async () => {
      await fireEvent.click(document.querySelector<HTMLElement>("[data-task-modal] [aria-label='关闭对话框']")!);
      await waitFor(() => expect(document.querySelector("[data-task-modal]")).toBeNull());
    };
    const viaPopover = async (name: string, task: string, inspect?: () => void) => {
      await fireEvent.click(trigger);
      const popover = await screen.findByRole("dialog", { name: "切换分支" });
      await fireEvent.click(within(popover).getByRole("button", { name }));
      await waitFor(() => expect(document.querySelector(`[data-task-modal="${task}"]`), name).toBeTruthy());
      expect(screen.queryByRole("dialog", { name: "切换分支" })).toBeNull();
      inspect?.();
      await closeModal();
    };
    const createForm = () => document.querySelector("[data-branch-create]");
    await viaPopover("新建分支", "branch", () => {
      expect(createForm(), "新建入口直接展开表单").toBeTruthy();
      expect(document.activeElement).toBe(screen.getByLabelText("新建分支"));
    });
    await viaPopover("合并到当前分支", "merge");
    await viaPopover("管理分支与标签", "branch", () => expect(createForm(), "管理入口的意图不残留").toBeNull());

    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /^远程/ }));
    await waitFor(() => expect(document.querySelector('[data-task-modal="remote"]')).toBeTruthy());
    await closeModal();

    const palette = await openPalette();
    await fireEvent.click(within(palette).getByRole("option", { name: /分支与标签/ }));
    await waitFor(() => expect(document.querySelector('[data-task-modal="branch"]')).toBeTruthy());
    expect(screen.queryByRole("dialog", { name: "切换分支" })).toBeNull();
  });

  it("命令面板打开的任务弹窗：Esc 后焦点回到打开面板前的控件，不落到 body", async () => {
    mocks.branchState.mockResolvedValue(branchFixture());
    mocks.tagState.mockResolvedValue({ generation: 4, tags: [], snapshot });
    mocks.stashState.mockResolvedValue({
      generation: 4,
      preview: {
        trackedCount: 2,
        untrackedCount: 0,
        ignoredCount: 0,
        trackedPaths: ["src/App.svelte", "src/app.css"],
        untrackedPaths: [],
        ignoredPaths: [],
        includeUntracked: false,
        canSave: true,
        summary: "将保存已跟踪的暂存和未暂存改动 2 个。",
      },
      records: [],
      snapshot,
    });
    render(App);
    await openRepo();
    const origin = document.querySelector<HTMLElement>(".file-list")!;
    origin.focus();
    expect(document.activeElement, "出发点是面板打开前的控件").toBe(origin);

    const entries: [RegExp, string][] = [
      [/^临时保存/, "stash"],
      [/^分支与标签/, "branch"],
      [/^本次提交范围/, "scope"],
      [/^分支合并/, "merge"],
      [/^设置/, "settings"],
    ];
    for (const [name, task] of entries) {
      const palette = await openPalette();
      await fireEvent.click(within(palette).getByRole("option", { name }));
      const modal = await waitFor(() => {
        const node = document.querySelector<HTMLElement>(`[data-task-modal="${task}"]`);
        expect(node, `${task}：面板要打开对应任务弹窗`).toBeTruthy();
        return node!;
      });
      expect(modal.contains(document.activeElement), `${task}：打开后焦点在弹窗内`).toBe(true);
      await fireEvent.keyDown(modal, { key: "Escape" });
      await waitFor(() => expect(document.querySelector("[data-task-modal]")).toBeNull());
      expect(document.activeElement, `${task}：Esc 后不落在 body`).not.toBe(document.body);
      expect(document.activeElement, `${task}：回到打开面板前的控件`).toBe(origin);
      origin.focus();
    }

    // 远程与克隆由 RepoDialogs 自己挂 Modal，不占任务槽位：Esc 之后同样不落 body。
    mocks.remoteState.mockResolvedValue({ generation: 4, remotes: [], snapshot });
    const fromPalette = async (name: RegExp, find: () => HTMLElement | null) => {
      const palette = await openPalette();
      await fireEvent.click(within(palette).getByRole("option", { name }));
      return waitFor(() => {
        const node = find();
        expect(node, `${name}：打开对应弹窗`).toBeTruthy();
        return node!;
      });
    };
    const remoteModal = () => document.querySelector<HTMLElement>('[data-task-modal="remote"]');
    const cloneModal = () => screen.queryByRole("dialog", { name: "克隆仓库" }) as HTMLElement | null;

    for (const [name, find, closed] of [
      [/^远程/, remoteModal, () => document.querySelector('[data-task-modal="remote"]')],
      [/^克隆仓库/, cloneModal, () => screen.queryByRole("dialog", { name: "克隆仓库" })],
    ] as [RegExp, () => HTMLElement | null, () => unknown][]) {
      // 一、面板打开前焦点在控件上：关闭后回到它。
      origin.focus();
      const modal = await fromPalette(name, find);
      expect(modal.contains(document.activeElement), `${name}：打开后焦点在弹窗内`).toBe(true);
      await fireEvent.keyDown(modal, { key: "Escape" });
      await waitFor(() => expect(closed(), `${name}：Esc 关闭弹窗`).toBeNull());
      await waitFor(() => expect(document.activeElement, `${name}：回到打开面板前的控件`).toBe(origin));

      // 二、面板之前焦点在 body（刚进界面就按 ⌘K）：落回主内容区，而不是留在 body。
      // 只靠命令面板自己还焦点时这里会停在 body，所以这一条能单独判别修复是否接上。
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement, `${name}：出发点是 body`).toBe(document.body);
      const second = await fromPalette(name, find);
      await fireEvent.keyDown(second, { key: "Escape" });
      await waitFor(() => expect(closed(), `${name}：第二次 Esc 关闭弹窗`).toBeNull());
      await waitFor(() => expect(document.activeElement, `${name}：焦点不可用时落到主内容区`).toBe(document.querySelector("main.content")));
      expect(document.activeElement, `${name}：后备也不是 body`).not.toBe(document.body);
    }
    origin.focus();

    // 面板打开前焦点不在任何控件（刚进界面就按 ⌘K）：走明确后备，同样不落回 body。
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    const palette = await openPalette();
    await fireEvent.click(within(palette).getByRole("option", { name: /^设置/ }));
    const modal = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-task-modal="settings"]');
      expect(node).toBeTruthy();
      return node!;
    });
    await fireEvent.keyDown(modal, { key: "Escape" });
    await waitFor(() => expect(document.querySelector("[data-task-modal]")).toBeNull());
    expect(document.activeElement, "焦点不可用时落到主内容区").toBe(document.querySelector("main.content"));
    expect(document.activeElement, "后备也不是 body").not.toBe(document.body);
  });

  it("起始页命令面板打开克隆：克隆成功自动关窗后焦点不落在 body", async () => {
    const cloned = { summary: { name: "fresh", path: "/parent/fresh" }, generation: 1, snapshot, draft: "", watchDegraded: false };
    let finish: (value: unknown) => void = () => {};
    mocks.cloneRepository.mockReset();
    mocks.cloneRepository.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    mocks.pickDirectory.mockResolvedValue("/parent");
    render(App);
    await waitFor(() => expect(document.querySelector(".welcome")).toBeTruthy());
    // 起点是起始页，焦点还在 body：面板只能落到主内容区这个明确后备。
    expect(document.activeElement, "起始页没有可回的控件").toBe(document.body);
    const main = document.querySelector<HTMLElement>("main.content")!;

    const palette = await openPalette();
    await fireEvent.click(within(palette).getByRole("option", { name: /^克隆仓库/ }));
    const dialog = await screen.findByRole("dialog", { name: "克隆仓库" });
    await fireEvent.input(within(dialog).getByLabelText("远程地址"), { target: { value: "https://e.com/fresh.git" } });
    await fireEvent.click(within(dialog).getByRole("button", { name: /选择目录/ }));
    const start = within(dialog).getByRole("button", { name: /开始克隆/ });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    await fireEvent.click(start);
    await within(dialog).findByRole("button", { name: "在后台继续" });

    // 窗口还开着时克隆完成：外壳直接打开新仓库并自动关窗，这条收尾不走 onClose。
    finish({ path: "/parent/fresh", opened: cloned });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "克隆仓库" })).toBeNull());
    expect(screen.getByRole("button", { name: "当前仓库 fresh" }), "新仓库已打开").toBeTruthy();
    await waitFor(() => expect(document.activeElement, "自动关窗后不落 body").not.toBe(document.body));
    expect(document.activeElement, "回到面板打开前定下的落点：主内容区").toBe(main);
  });

  it("Git 不可用：入口可关闭、指向设置运行环境分区，起始页也接上了诊断（R10、R13）", async () => {
    mocks.getSettings.mockResolvedValue({
      theme: "dark",
      panelWidths: { sidebar: 256, files: 360 },
      git: {
        available: false,
        path: null,
        version: null,
        overridden: false,
        belowBaseline: false,
        message: "没有找到 Git",
      },
      recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }],
      settingsWarning: null,
    });
    render(App);

    // 起始页只有一处提示：通知条在打开仓库后才出现，同一句话不重复（R8、R12）。
    const welcomeEntry = await waitFor(() =>
      within(document.querySelector<HTMLElement>(".welcome")!).getByRole("button", { name: /没有找到 Git/ }),
    );
    expect(document.querySelector(".infobar.error"), "起始页不再叠一条通知").toBeNull();
    expect(document.querySelectorAll(".infobar, .welcome-diagnostic"), "同一句提示只有一处可见").toHaveLength(1);

    // 诊断动作打开设置 modal 的运行环境分区，并把焦点放进去
    welcomeEntry.focus();
    await fireEvent.click(welcomeEntry);
    const modal = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-task-modal="settings"]');
      expect(node, "诊断动作要打开设置 modal").toBeTruthy();
      return node!;
    });
    const runtime = modal.querySelector<HTMLElement>('[data-settings-section="runtime"]');
    expect(runtime, "设置 modal 要有运行环境分区锚点").toBeTruthy();
    expect(runtime!.contains(document.activeElement), "打开后焦点落在运行环境分区").toBe(true);
    expect(within(runtime!).getByRole("list", { name: "Git 诊断" }).textContent, "直接看到问题说明").toContain("没有找到 Git");
    expect(runtime!.querySelector("[data-git-next-step]")?.textContent, "下一步就在当前入口").toContain("安装 Git");
    expect(within(runtime!).getByRole("button", { name: "重新检测" })).toBeTruthy();
    expect(within(runtime!).getByRole("button", { name: "选择 Git" })).toBeTruthy();
    expect(runtime!.querySelector("details")?.open, "Git 缺失时说明默认展开").toBe(true);

    // Esc 关闭后焦点回到触发元素
    await fireEvent.keyDown(modal, { key: "Escape" });
    await waitFor(() => expect(document.querySelector('[data-task-modal="settings"]')).toBeNull());
    expect(document.activeElement, "关闭后焦点回到起始页的诊断入口").toBe(welcomeEntry);

    // 打开仓库后起始页不在了，诊断由通知条承担：一句结论 + 一个可关闭入口，长说明不堆在这里（R12、R13）。
    await openRepo();
    const bar = document.querySelector<HTMLElement>(".infobar.error");
    expect(bar, "打开仓库后要有诊断入口").toBeTruthy();
    expect(bar!.textContent).toContain("没有找到 Git");
    expect(bar!.querySelector("p"), "通知条里不再有说明段落").toBeNull();
    expect(bar!.textContent).not.toContain("git-scm.com");
    await fireEvent.click(within(bar!).getByRole("button", { name: "运行环境诊断" }));
    await waitFor(() => expect(document.querySelector('[data-settings-section="runtime"]')).toBeTruthy());
    await fireEvent.keyDown(document.querySelector('[data-task-modal="settings"]')!, { key: "Escape" });
    await waitFor(() => expect(document.querySelector('[data-task-modal="settings"]')).toBeNull());

    await fireEvent.click(within(bar!).getByRole("button", { name: "关闭 Git 诊断入口" }));
    await waitFor(() => expect(document.querySelector(".infobar.error")).toBeNull());
    expect(screen.queryByRole("button", { name: "关闭 Git 诊断入口" })).toBeNull();

    // 关闭只在「这次缺失」内记住：Git 恢复可用后重新武装，再缺一次通知照样回来。
    mocks.detectGit
      .mockResolvedValueOnce({
        available: true,
        path: "git",
        version: "2.49.0",
        overridden: false,
        belowBaseline: false,
        message: "Git 2.49.0 可用",
      })
      .mockResolvedValueOnce({
        available: false,
        path: null,
        version: null,
        overridden: false,
        belowBaseline: false,
        message: "没有找到 Git",
      });
    await fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settings = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-task-modal="settings"]');
      expect(node, "设置 modal 要能从标题栏打开").toBeTruthy();
      return node!;
    });
    const redetect = within(settings).getByRole("button", { name: "重新检测" });
    await fireEvent.click(redetect);
    await waitFor(() => expect(mocks.detectGit).toHaveBeenCalledTimes(1));
    expect(document.querySelector(".infobar.error"), "Git 可用时本来就不该有诊断通知").toBeNull();
    await fireEvent.click(redetect);
    await waitFor(() => expect(mocks.detectGit).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(document.querySelector(".infobar.error"), "恢复可用后重新武装，再缺失时通知要回来").toBeTruthy(),
    );
    await fireEvent.keyDown(document.querySelector('[data-task-modal="settings"]')!, { key: "Escape" });
    await waitFor(() => expect(document.querySelector('[data-task-modal="settings"]')).toBeNull());

    // 关掉通知条后回到起始页，入口仍在（R13 不因关闭而消失）。
    await fireEvent.click(screen.getByRole("button", { name: "关闭 Git 诊断入口" }));
    await waitFor(() => expect(document.querySelector(".infobar.error")).toBeNull());
    mocks.forgetRecent.mockResolvedValue([]);
    await fireEvent.click(screen.getByRole("button", { name: /^当前仓库/ }));
    await fireEvent.click(await screen.findByRole("button", { name: /^从列表移除/ }));
    await waitFor(() => expect(document.querySelector(".welcome")).toBeTruthy());
    expect(
      within(document.querySelector<HTMLElement>(".welcome")!).getByRole("button", { name: /没有找到 Git/ }),
      "关掉通知条不影响起始页自己的诊断入口",
    ).toBeTruthy();
    expect(document.querySelector(".infobar.error"), "回到起始页也不重复通知条").toBeNull();
  });

  describe("后台克隆完成", () => {
    const clonedRepo = { summary: { name: "fresh", path: "/parent/fresh" }, generation: 1, snapshot, draft: "", watchDegraded: false };

    const dot = () => document.querySelector(".statusbar .sb-dot");

    /** 从仓库弹层开始克隆，窗口仍开着。 */
    async function startClone() {
      let finish: (value: unknown) => void = () => {};
      let fail: (reason: unknown) => void = () => {};
      mocks.cloneRepository.mockReset();
      mocks.cloneRepository.mockReturnValue(new Promise((resolve, reject) => ((finish = resolve), (fail = reject))));
      mocks.pickDirectory.mockResolvedValue("/parent");
      await fireEvent.click(screen.getByRole("button", { name: /^当前仓库/ }));
      await fireEvent.click(await screen.findByRole("button", { name: "克隆远程仓库" }));
      const dialog = await screen.findByRole("dialog", { name: "克隆仓库" });
      await fireEvent.input(within(dialog).getByLabelText("远程地址"), { target: { value: "https://e.com/fresh.git" } });
      await fireEvent.click(within(dialog).getByRole("button", { name: /选择目录/ }));
      const start = within(dialog).getByRole("button", { name: /开始克隆/ });
      await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
      await fireEvent.click(start);
      await within(dialog).findByRole("button", { name: "在后台继续" });
      return { dialog, finish: () => finish({ path: "/parent/fresh", opened: clonedRepo }), fail };
    }

    async function startBackgroundClone() {
      const clone = await startClone();
      await fireEvent.click(within(clone.dialog).getByRole("button", { name: "在后台继续" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "克隆仓库" })).toBeNull());
      return clone;
    }

    it("克隆窗口还开着时完成后打开新仓库，不用接回监听", async () => {
      render(App);
      await openRepo();
      const clone = await startClone();
      const opens = mocks.openRepository.mock.calls.length;
      clone.finish();
      await waitFor(() => expect(screen.getByRole("button", { name: "当前仓库 fresh" })).toBeTruthy());
      expect(screen.queryByRole("dialog", { name: "克隆仓库" })).toBeNull();
      expect(document.querySelector(".toast.ok")?.textContent).toContain("已克隆并打开 fresh");
      expect(mocks.openRepository.mock.calls.length).toBe(opens);
    });

    it("点过在后台继续：什么窗口都没开也不切换，草稿不动，加入最近仓库", async () => {
      render(App);
      await openRepo();
      const message = screen.getByRole("textbox", { name: "提交说明草稿" });
      await fireEvent.input(message, { target: { value: "写到一半的说明" } });
      const clone = await startBackgroundClone();
      clone.finish();
      await waitFor(() => expect(document.querySelector(".toast.ok")?.textContent).toContain("克隆完成：fresh"));
      expect(document.querySelector(".toast.ok")?.textContent).toContain("仓库弹层");
      expect(screen.getByRole("button", { name: "当前仓库 demo" }), "仓库不切换").toBeTruthy();
      expect((screen.getByRole("textbox", { name: "提交说明草稿" }) as HTMLTextAreaElement).value).toBe("写到一半的说明");
      await fireEvent.click(screen.getByRole("button", { name: "当前仓库 demo" }));
      expect(await screen.findByRole("option", { name: /fresh/ }), "能从仓库弹层打开").toBeTruthy();
    });

    it("设置开着时不关窗口", async () => {
      render(App);
      await openRepo();
      const clone = await startBackgroundClone();
      await fireEvent.click(screen.getByRole("button", { name: "设置" }));
      await screen.findByRole("dialog", { name: "设置" });
      clone.finish();
      await waitFor(() => expect(document.querySelector(".toast.ok")?.textContent).toContain("克隆完成：fresh"));
      expect(screen.getByRole("dialog", { name: "设置" }), "窗口不关").toBeTruthy();
    });

    it("起始页收到后台克隆完成时不打开，也不去接回监听", async () => {
      mocks.pickDirectory.mockResolvedValue("/parent");
      render(App);
      await waitFor(() => expect(document.querySelector(".welcome")).toBeTruthy());
      let finish: (value: unknown) => void = () => {};
      mocks.cloneRepository.mockReset();
      mocks.cloneRepository.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      await fireEvent.click(screen.getByRole("button", { name: /克隆远程仓库/ }));
      const dialog = await screen.findByRole("dialog", { name: "克隆仓库" });
      await fireEvent.input(within(dialog).getByLabelText("远程地址"), { target: { value: "https://e.com/fresh.git" } });
      await fireEvent.click(within(dialog).getByRole("button", { name: /选择目录/ }));
      const start = within(dialog).getByRole("button", { name: /开始克隆/ });
      await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
      await fireEvent.click(start);
      await fireEvent.click(await within(dialog).findByRole("button", { name: "在后台继续" }));
      finish({ path: "/parent/fresh", opened: clonedRepo });
      await waitFor(() => expect(document.querySelector(".toast.ok")?.textContent).toContain("克隆完成：fresh"));
      expect(document.querySelector(".welcome")).toBeTruthy();
      expect(document.querySelector(".welcome-recent")?.textContent).toContain("fresh");
      expect(mocks.openRepository).not.toHaveBeenCalled();
    });

    it("接回期间发生写入：不应用旧快照，generation 不回退，接回后用当前 generation 刷新", async () => {
      render(App);
      await openRepo();
      const clone = await startBackgroundClone();
      let reopen: (value: unknown) => void = () => {};
      mocks.openRepository.mockReturnValueOnce(new Promise((resolve) => (reopen = resolve)));
      clone.finish();
      await waitFor(() => expect(document.querySelector(".toast.ok")?.textContent).toContain("克隆完成：fresh"));

      const newer = { ...snapshot, generation: 9, files: [] };
      mocks.refreshStatus.mockResolvedValue(newer);
      const changed = mocks.listenEvent.mock.calls.find(([name]) => name === "repo-changed")![1];
      changed({ path: repoPath, generation: 9, degraded: false });
      await waitFor(() => expect(mocks.refreshStatus).toHaveBeenCalled());
      await waitFor(() => expect(document.querySelector(".file-row")).toBeNull());
      mocks.refreshStatus.mockClear();

      reopen({ summary: { name: "demo", path: repoPath }, generation: 4, snapshot, draft: "", watchDegraded: false });
      await waitFor(() => expect(mocks.refreshStatus).toHaveBeenCalled());
      expect(mocks.refreshStatus.mock.calls[0][1], "generation 不回退").toBe(9);
      await tick();
      expect(document.querySelector(".file-row"), "旧快照里的文件不回来").toBeNull();
    });

    it("接回期间切了仓库：不刷新旧仓库，把监听接到新仓库", async () => {
      render(App);
      await openRepo();
      const clone = await startBackgroundClone();
      let reopen: (value: unknown) => void = () => {};
      mocks.openRepository.mockReturnValueOnce(new Promise((resolve) => (reopen = resolve)));
      clone.finish();
      await waitFor(() => expect(document.querySelector(".toast.ok")?.textContent).toContain("克隆完成：fresh"));

      mocks.openRepository.mockResolvedValueOnce(clonedRepo);
      await fireEvent.click(screen.getByRole("button", { name: "当前仓库 demo" }));
      await fireEvent.click(await screen.findByRole("option", { name: /fresh/ }));
      await waitFor(() => expect(screen.getByRole("button", { name: "当前仓库 fresh" })).toBeTruthy());

      mocks.refreshStatus.mockClear();
      mocks.openRepository.mockResolvedValueOnce(clonedRepo);
      reopen({ summary: { name: "demo", path: repoPath }, generation: 4, snapshot, draft: "", watchDegraded: false });
      await waitFor(() => expect(mocks.openRepository.mock.calls.at(-1)?.[0]).toBe("/parent/fresh"));
      await waitFor(() => expect(mocks.refreshStatus).toHaveBeenCalled());
      expect(mocks.refreshStatus.mock.calls.every(([path]) => path === "/parent/fresh"), "旧仓库不刷新").toBe(true);
    });

    it("接回遇到 stale 时重试一次，成功后监听恢复", async () => {
      render(App);
      await openRepo();
      const clone = await startBackgroundClone();
      const opens = mocks.openRepository.mock.calls.length;
      mocks.openRepository.mockRejectedValueOnce({ code: "stale", message: "过期" });
      clone.finish();
      await waitFor(() => expect(mocks.openRepository.mock.calls.length).toBe(opens + 2));
      await waitFor(() => expect(mocks.refreshStatus).toHaveBeenCalled());
      expect(dot()?.classList.contains("stale"), "接回成功不算降级").toBe(false);
    });

    it("重试也失败才退回低频重读", async () => {
      render(App);
      await openRepo();
      const clone = await startBackgroundClone();
      const opens = mocks.openRepository.mock.calls.length;
      mocks.openRepository.mockRejectedValueOnce({ code: "stale", message: "过期" });
      mocks.openRepository.mockRejectedValueOnce({ code: "stale", message: "过期" });
      clone.finish();
      await waitFor(() => expect(dot()?.classList.contains("stale")).toBe(true));
      expect(mocks.openRepository.mock.calls.length).toBe(opens + 2);
    });

    it("不是 stale 的失败不重试，直接退回低频重读", async () => {
      render(App);
      await openRepo();
      const clone = await startBackgroundClone();
      const opens = mocks.openRepository.mock.calls.length;
      mocks.openRepository.mockRejectedValueOnce({ code: "unknown", message: "读不到" });
      clone.finish();
      await waitFor(() => expect(dot()?.classList.contains("stale")).toBe(true));
      expect(mocks.openRepository.mock.calls.length).toBe(opens + 1);
    });

    it("失败时通知原因，写锁释放", async () => {
      render(App);
      await openRepo();
      const clone = await startBackgroundClone();
      clone.fail({ code: "clone_failed", message: "认证失败" });
      await waitFor(() => expect(document.querySelector(".toast.error")?.textContent).toContain("认证失败"));
      expect(document.querySelector(".toast.error")?.textContent, "后台失败的通知也带下一步").toContain("下一步：");
      expect(screen.getByRole("button", { name: "当前仓库 demo" })).toBeTruthy();
    });
  });

  describe("HTTP 克隆认证引导", () => {
    it("认证失败时就地要用户名和密码，带凭据重试，成功后说明凭据去向", async () => {
      render(App);
      await openRepo();
      let fail: (reason: unknown) => void = () => {};
      let finish: (value: unknown) => void = () => {};
      mocks.cloneRepository.mockReset();
      mocks.cloneRepository.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
      mocks.pickDirectory.mockResolvedValue("/parent");
      await fireEvent.click(screen.getByRole("button", { name: /^当前仓库/ }));
      await fireEvent.click(await screen.findByRole("button", { name: "克隆远程仓库" }));
      const dialog = await screen.findByRole("dialog", { name: "克隆仓库" });
      await fireEvent.input(within(dialog).getByLabelText("远程地址"), { target: { value: "http://git.example.com/app.git" } });
      await fireEvent.click(within(dialog).getByRole("button", { name: /选择目录/ }));
      const start = within(dialog).getByRole("button", { name: /开始克隆/ });
      await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
      await fireEvent.click(start);
      fail({ code: "auth", message: "认证失败。" });

      const user = await within(dialog).findByLabelText("用户名");
      expect(document.querySelector(".toast.error"), "窗口开着时不弹失败通知").toBeNull();
      const retry = within(dialog).getByRole("button", { name: "登录并克隆" });
      expect(retry.hasAttribute("disabled"), "没填凭据时不能重试").toBe(true);
      await fireEvent.input(user, { target: { value: "alice" } });
      await fireEvent.input(within(dialog).getByLabelText("密码或访问令牌"), { target: { value: "tok-123" } });
      mocks.cloneRepository.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
      await fireEvent.click(retry);
      expect(mocks.cloneRepository).toHaveBeenLastCalledWith(
        "http://git.example.com/app.git", "/parent", "", expect.any(Number),
        { username: "alice", password: "tok-123", remember: true },
      );
      finish({
        path: "/parent/fresh",
        opened: { summary: { name: "fresh", path: "/parent/fresh" }, generation: 1, snapshot, draft: "", watchDegraded: false },
        credentialNote: "凭据已交给系统凭据助手保存。",
      });
      await waitFor(() => expect(screen.getByRole("button", { name: "当前仓库 fresh" })).toBeTruthy());
      await waitFor(() => expect(document.body.textContent).toContain("凭据已交给系统凭据助手保存。"));
    });

    it("SSH 地址认证失败照常通知，不出现用户名密码表单", async () => {
      render(App);
      await openRepo();
      mocks.cloneRepository.mockReset();
      mocks.cloneRepository.mockRejectedValueOnce({ code: "auth", message: "认证失败，请检查 SSH agent。" });
      mocks.pickDirectory.mockResolvedValue("/parent");
      await fireEvent.click(screen.getByRole("button", { name: /^当前仓库/ }));
      await fireEvent.click(await screen.findByRole("button", { name: "克隆远程仓库" }));
      const dialog = await screen.findByRole("dialog", { name: "克隆仓库" });
      await fireEvent.input(within(dialog).getByLabelText("远程地址"), { target: { value: "git@example.com:app.git" } });
      await fireEvent.click(within(dialog).getByRole("button", { name: /选择目录/ }));
      const start = within(dialog).getByRole("button", { name: /开始克隆/ });
      await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
      await fireEvent.click(start);
      await waitFor(() => expect(document.body.textContent).toContain("认证失败，请检查 SSH agent。"));
      expect(within(dialog).queryByLabelText("用户名")).toBeNull();
    });
  });

  describe("删除 worktree", () => {
    const linked = "/work/app-feature";
    function useWorktreeHeads() {
      useRecent([
        { name: "demo", path: repoPath, openedAtMs: 2 },
        { name: "app-feature", path: linked, openedAtMs: 1 },
      ]);
      mocks.repoHeads.mockResolvedValue([
        { path: repoPath, branch: "main", detached: null, missing: false, worktree: false, mainPath: null },
        { path: linked, branch: "feature/x", detached: null, missing: false, worktree: true, mainPath: "/work/app" },
      ]);
    }

    it("可按分支搜到 worktree；有改动时升级为强制删除确认，删除后移出列表", async () => {
      useWorktreeHeads();
      render(App);
      await openRepo();
      await fireEvent.click(screen.getByRole("button", { name: /^当前仓库/ }));
      const search = await screen.findByRole("combobox", { name: "搜索仓库名称、路径、分支或 worktree" });
      await waitFor(() => expect(document.querySelector(".repo-worktree")).toBeTruthy());
      await fireEvent.input(search, { target: { value: "feature/x" } });
      await waitFor(() => expect(document.querySelectorAll("[data-repo-row]")).toHaveLength(1));
      expect(document.querySelector("[data-repo-row] .repo-name")?.textContent).toBe("app-feature");
      expect(document.querySelector(".repo-worktree")?.textContent).toContain("app");

      mocks.removeWorktree.mockRejectedValueOnce({ code: "worktree_dirty", message: "有未提交改动" });
      await fireEvent.click(screen.getByRole("button", { name: "删除工作区 app-feature" }));
      const confirm = await screen.findByRole("dialog", { name: "删除工作区" });
      await fireEvent.click(within(confirm).getByRole("button", { name: "删除工作区" }));
      expect(mocks.removeWorktree).toHaveBeenLastCalledWith(linked, false, expect.any(Number));
      const forced = await screen.findByRole("dialog", { name: "强制删除工作区" });
      mocks.removeWorktree.mockResolvedValueOnce([{ name: "demo", path: repoPath, openedAtMs: 2 }]);
      await fireEvent.click(within(forced).getByRole("button", { name: "强制删除" }));
      expect(mocks.removeWorktree).toHaveBeenLastCalledWith(linked, true, expect.any(Number));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "强制删除工作区" })).toBeNull());
      expect(document.body.textContent).toContain("已删除工作区 app-feature");
    });

    it("当前打开的 worktree 不能删除，主仓库没有删除入口", async () => {
      useWorktreeHeads();
      mocks.repoHeads.mockResolvedValue([
        { path: repoPath, branch: "feature/x", detached: null, missing: false, worktree: true, mainPath: "/work/app" },
        { path: linked, branch: "main", detached: null, missing: false, worktree: false, mainPath: null },
      ]);
      render(App);
      await openRepo();
      await fireEvent.click(screen.getByRole("button", { name: /^当前仓库/ }));
      const remove = await screen.findByRole("button", { name: "删除工作区 demo" });
      expect(remove.hasAttribute("disabled")).toBe(true);
      expect(screen.queryByRole("button", { name: "删除工作区 app-feature" })).toBeNull();
    });
  });

  it("起始页三个入口不可用时就地说明原因", async () => {
    let finish: (value: unknown) => void = () => {};
    render(App);
    await waitFor(() => expect(document.querySelector(".welcome")).toBeTruthy());
    expect(document.querySelector("[data-welcome-reason]"), "可用时不占位").toBeNull();
    for (const card of document.querySelectorAll<HTMLButtonElement>(".action-card")) expect(card.title).toBe("");

    mocks.openRepository.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
    const reason = await waitFor(() => {
      const node = document.querySelector<HTMLElement>("[data-welcome-reason]");
      expect(node, "禁用时要看得到原因").toBeTruthy();
      return node!;
    });
    expect(reason.textContent).toBe("正在读取，稍后再试");
    const cards = document.querySelectorAll<HTMLButtonElement>(".action-card");
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.disabled).toBe(true);
      expect(card.title).toBe("正在读取，稍后再试");
    }
    finish(undefined);
  });

  it("起始页空状态保留三个入口，并说明打开只检查仓库身份", async () => {
    useRecent([]);
    render(App);
    await waitFor(() => expect(document.querySelector("[data-welcome-empty]")).toBeTruthy());
    expect(document.querySelectorAll(".action-card")).toHaveLength(3);
    expect(screen.queryByRole("textbox", { name: "搜索最近仓库" }), "没有仓库时不出现搜索").toBeNull();
    expect(document.querySelector("[data-welcome-empty]")?.textContent).toContain("还没有最近仓库");
    expect(document.querySelector("[data-welcome-empty-note]")?.textContent).toContain("不会初始化");
    mocks.pickDirectory.mockResolvedValue(null);
    await fireEvent.click(screen.getByRole("button", { name: /打开本地仓库/ }));
    await waitFor(() => expect(mocks.pickDirectory).toHaveBeenCalledWith("添加已有仓库"));
  });

  it("起始页五个最近仓库全部列出且不显示搜索，点击即可继续", async () => {
    useRecent(
      Array.from({ length: 5 }, (_, index) => ({
        name: `repo-${index}`,
        path: `C:/work/repo-${index}`,
        openedAtMs: 1_700_000_000_000 + index,
      })),
    );
    render(App);
    await waitFor(() => expect(document.querySelectorAll(".welcome-recent > button")).toHaveLength(5));
    expect(screen.queryByRole("textbox", { name: "搜索最近仓库" }), "不超过五行时不用搜索也都在眼前").toBeNull();
    expect(document.querySelector("[data-welcome-count]")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: /repo-1/ }));
    await waitFor(() => expect(mocks.openRepository).toHaveBeenCalledWith("C:/work/repo-1", expect.any(Number)));
  });

  it("起始页数百个最近仓库默认显示前五个，搜索能发现列表外项目并区分同名路径", async () => {
    const many = Array.from({ length: 240 }, (_, index) => ({
      name: `repo-${index}`,
      path: `C:/work/repo-${index}`,
      openedAtMs: 1_700_000_000_000 + index,
    }));
    many[0] = { name: "demo", path: "C:/work/demo", openedAtMs: 1_700_000_000_001 };
    many[3] = { name: "demo", path: "D:/archive/2019/demo", openedAtMs: 1_700_000_000_002 };
    many[237] = { name: "needle-project", path: "E:/far/needle-project", openedAtMs: 1_700_000_000_003 };
    useRecent(many);
    render(App);

    const search = await screen.findByRole("textbox", { name: "搜索最近仓库" });
    expect(document.querySelectorAll(".welcome-recent > button")).toHaveLength(5);
    expect(document.querySelector("[data-welcome-count]")?.textContent).toContain("共 240 个");
    expect(document.querySelector("[data-welcome-limit]")?.textContent).toContain("显示前 5 个");

    await fireEvent.input(search, { target: { value: "needle" } });
    await waitFor(() => expect(document.querySelectorAll(".welcome-recent > button")).toHaveLength(1));
    expect(screen.getByRole("button", { name: /needle-project/ })).toBeTruthy();
    expect(document.querySelector("[data-welcome-count]")?.textContent).toContain("匹配 1 个");

    await fireEvent.input(search, { target: { value: "demo" } });
    await waitFor(() => expect(document.querySelectorAll(".welcome-recent > button")).toHaveLength(2));
    const shownPaths = [...document.querySelectorAll(".welcome-recent .repo-path-full bdi")].map((node) => node.textContent);
    expect(shownPaths, "同名仓库用完整路径区分").toEqual(["C:/work/demo", "D:/archive/2019/demo"]);
    expect(document.querySelector("[data-welcome-count]")?.textContent).toContain("匹配 2 个");

    await fireEvent.input(search, { target: { value: "没有这个仓库" } });
    await waitFor(() => expect(document.querySelector("[data-welcome-no-match]")).toBeTruthy());
    expect(document.querySelectorAll(".welcome-recent > button")).toHaveLength(0);

    await fireEvent.input(search, { target: { value: "needle" } });
    await waitFor(() => expect(document.querySelectorAll(".welcome-recent > button")).toHaveLength(1));
    await fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(mocks.openRepository).toHaveBeenCalledWith("E:/far/needle-project", expect.any(Number)));
  });

  it("克隆目标已有内容时就地给出原因和下一步，不弹重复通知也不覆盖", async () => {
    render(App);
    await waitFor(() => expect(document.querySelector(".welcome")).toBeTruthy());
    await fireEvent.click(screen.getByRole("button", { name: /克隆远程仓库/ }));
    const dialog = await screen.findByRole("dialog", { name: "克隆仓库" });
    await fireEvent.input(within(dialog).getByLabelText("远程地址"), { target: { value: "https://e.com/demo.git" } });
    mocks.pickDirectory.mockResolvedValue("C:/work");
    await fireEvent.click(within(dialog).getByRole("button", { name: /选择目录/ }));
    await waitFor(() => expect((within(dialog).getByLabelText("父目录") as HTMLInputElement).value).toBe("C:/work"));

    mocks.cloneRepository.mockRejectedValueOnce({
      code: "clone_destination",
      message: "目标目录已有文件，未覆盖任何内容。C:/work/demo",
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: /开始克隆/ }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("目标目录已有文件，未覆盖任何内容。");
    expect(alert.querySelector("[data-clone-next]")?.textContent, "下一步就在当前入口").toContain("换一个目录名");
    expect(document.querySelector(".toast.error"), "同一原因不再弹一条通知").toBeNull();
    expect(mocks.createRepository).not.toHaveBeenCalled();

    await fireEvent.input(within(dialog).getByLabelText("目录名"), { target: { value: "demo-copy" } });
    await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());

    mocks.cloneRepository.mockResolvedValueOnce({
      path: "C:/work/demo-copy",
      opened: { summary: { name: "demo-copy", path: "C:/work/demo-copy" }, generation: 4, snapshot, draft: "", watchDegraded: false },
      credentialNote: null,
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: /开始克隆/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "当前仓库 demo-copy" })).toBeTruthy());
    expect(mocks.cloneRepository).toHaveBeenLastCalledWith("https://e.com/demo.git", "C:/work", "demo-copy", expect.any(Number), null);
    expect(screen.queryByRole("dialog", { name: "克隆仓库" })).toBeNull();
  });

  it("添加仓库：拖放与命令入口对无效路径给出同一原因，不初始化也不改写", async () => {
    const message = "该目录不是 Git 仓库，未做任何修改。";
    mocks.addRepository.mockRejectedValue({ code: "not_repository", message });
    mocks.pickDirectory.mockResolvedValue("C:/plain-folder");
    render(App);
    await waitFor(() => expect(document.querySelector(".welcome")).toBeTruthy());

    const palette = await openPalette();
    await fireEvent.click(within(palette).getByRole("option", { name: /^添加仓库/ }));
    await waitFor(() => expect(mocks.addRepository).toHaveBeenCalledWith("C:/plain-folder", expect.any(Number)));
    await waitFor(() => expect(document.querySelector(".toast-text")?.textContent).toBe(message));

    await dragEvent("drop", ["C:/plain-folder"]);
    await waitFor(() => expect(mocks.addRepository).toHaveBeenCalledTimes(2));
    expect(document.querySelector(".toast-text")?.textContent, "两个入口给出同一原因").toBe(message);
    expect(mocks.createRepository).not.toHaveBeenCalled();
    expect(document.querySelector(".welcome"), "仍在起始页，没有被打开成仓库").toBeTruthy();
    expect(screen.getByRole("button", { name: /新建仓库/ }), "下一步入口就在起始页").toBeTruthy();
  });

  it("添加仓库：路径不存在时只说明原因，不创建目录也不改写文件", async () => {
    const message = "路径不存在，未创建或修改任何文件。";
    mocks.addRepository.mockRejectedValue({ code: "path_missing", message });
    mocks.pickDirectory.mockResolvedValue("C:/missing");
    render(App);
    await waitFor(() => expect(document.querySelector(".welcome")).toBeTruthy());

    const palette = await openPalette();
    await fireEvent.click(within(palette).getByRole("option", { name: /^添加仓库/ }));
    await waitFor(() => expect(mocks.addRepository).toHaveBeenCalledWith("C:/missing", expect.any(Number)));
    await waitFor(() => expect(document.querySelector(".toast-text")?.textContent).toBe(message));
    expect(mocks.createRepository, "只检查身份，不会为无效路径初始化仓库").not.toHaveBeenCalled();
    expect(document.querySelector(".welcome")).toBeTruthy();
  });

  it("Git 版本过低：起始页提示与设置运行环境给出同一原因和下一步", async () => {
    const message = "已检测到 Git 2.20.0，低于建议基线 2.48，仍会继续使用。";
    mocks.getSettings.mockResolvedValue({
      theme: "dark",
      panelWidths: { sidebar: 256, files: 360 },
      git: { available: true, path: "C:/Git/bin/git.exe", version: "2.20.0", overridden: false, belowBaseline: true, message },
      recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }],
      settingsWarning: null,
    });
    render(App);
    const warn = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".infobar.warn");
      expect(node, "起始页也要看到版本过低的提示").toBeTruthy();
      return node!;
    });
    expect(warn.textContent).toContain("低于建议基线 2.48");

    await fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settings = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-task-modal="settings"]');
      expect(node).toBeTruthy();
      return node!;
    });
    const runtime = settings.querySelector<HTMLElement>('[data-settings-section="runtime"]');
    expect(runtime).toBeTruthy();
    expect(runtime!.textContent).toContain("版本过低");
    expect(runtime!.textContent).toContain("低于建议基线 2.48");
    expect(runtime!.querySelector("[data-git-next-step]")?.textContent).toContain("2.48");
    expect(runtime!.querySelector("details")?.open, "版本过低时说明默认展开").toBe(true);
  });

  it("分叉拉取按设置预选方式，取消确认不开始且当前分支不动", async () => {
    mocks.getSettings.mockResolvedValue({
      theme: "dark",
      panelWidths: { sidebar: 256, files: 360 },
      git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" },
      recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }],
      settingsWarning: null,
      pullIntegration: "rebase",
    });
    mocks.branchState.mockResolvedValue(branchFixture());
    mocks.pullFastForward.mockRejectedValue({
      code: "diverged",
      message: "本地和远程都有新提交，不能快进。当前分支没有移动。",
      generation: 4,
    });
    render(App);
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /拉取/ }));
    const dialog = await screen.findByRole("dialog", { name: "合并分支" });
    const radio = await within(dialog).findByRole("radio", { name: /变基/ });
    expect(radio.getAttribute("aria-checked")).toBe("true");
    expect(dialog.textContent).toContain("将改写当前分支");
    expect(document.querySelector(".branch-pill")?.textContent).toContain("main");
    expect(mocks.startMerge).not.toHaveBeenCalled();
    await fireEvent.click(within(dialog).getByRole("button", { name: "变基并改写当前分支" }));
    const confirm = await screen.findByRole("dialog", { name: "确认变基" });
    await fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(mocks.startMerge).not.toHaveBeenCalled();
    expect(document.querySelector(".branch-pill")?.textContent).toContain("main");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("没有拉取方式设置时分叉预选合并", async () => {
    mocks.branchState.mockResolvedValue(branchFixture());
    mocks.pullFastForward.mockRejectedValue({
      code: "diverged",
      message: "本地和远程都有新提交，不能快进。当前分支没有移动。",
      generation: 4,
    });
    render(App);
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /拉取/ }));
    const dialog = await screen.findByRole("dialog", { name: "合并分支" });
    const merge = await within(dialog).findByRole("radio", { name: /创建合并提交/ });
    expect(merge.getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByRole("radio", { name: /变基/ }).getAttribute("aria-checked")).toBe("false");
    expect(mocks.startMerge).not.toHaveBeenCalled();
  });

  it("没有上游或游离 HEAD 时不打开方式选择", async () => {
    mocks.pullFastForward.mockRejectedValue({
      code: "no_upstream",
      message: "当前分支没有上游。请先发布，或只关联上游后再快进拉取。工作区没有改动。",
      generation: 4,
    });
    render(App);
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /拉取/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("没有上游");
    expect(screen.queryByRole("dialog", { name: "合并分支" })).toBeNull();
    cleanup();

    const detached = { ...snapshot, branch: { ...branch, name: null, detached: true, upstream: null } };
    mocks.openRepository.mockResolvedValue({
      summary: { name: "demo", path: repoPath },
      generation: 4,
      snapshot: detached,
      draft: "",
      watchDegraded: false,
    });
    mocks.pullFastForward.mockRejectedValue({
      code: "detached",
      message: "当前是游离 HEAD，不能推送或发布。请先创建或切换到分支。没有改写远程。",
      generation: 4,
    });
    render(App);
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /拉取/ }));
    const detachedAlert = await screen.findByRole("alert");
    expect(detachedAlert.textContent).toContain("游离");
    expect(screen.queryByRole("dialog", { name: "合并分支" })).toBeNull();
  });

  it("从分支与标签进入合并：关闭合并回到分支与标签；从标题栏进入时关闭就回到工作区", async () => {
    mocks.branchState.mockResolvedValue(branchFixture());
    render(App);
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: "当前分支 main" }));
    await fireEvent.click(await screen.findByRole("button", { name: "管理分支与标签" }));
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBeGreaterThan(0));
    const develop = [...document.querySelectorAll<HTMLElement>(".branch-row")].find((row) => row.textContent?.includes("develop"));
    await fireEvent.contextMenu(develop!, { clientX: 40, clientY: 40 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^合并到当前分支/ }));
    let merge = await screen.findByRole("dialog", { name: "合并分支" });
    await fireEvent.click(await within(merge).findByRole("button", { name: "返回分支与标签" }));
    expect(await screen.findByRole("dialog", { name: "分支与标签" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "合并分支" })).toBeNull();

    // 右上角关闭和 Esc 同样回到来源；回去之后再关就回到工作区，不会来回弹。
    const again = [...document.querySelectorAll<HTMLElement>(".branch-row")].find((row) => row.textContent?.includes("develop"));
    await waitFor(() => expect(again).toBeTruthy());
    await fireEvent.contextMenu(again!, { clientX: 40, clientY: 40 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^合并到当前分支/ }));
    merge = await screen.findByRole("dialog", { name: "合并分支" });
    await fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(await screen.findByRole("dialog", { name: "分支与标签" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "合并分支" })).toBeNull());
    await fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "分支与标签" })).toBeNull());

    // 标题栏分支弹层直接进入合并：没有来源 modal，按钮仍是「关闭」。
    await fireEvent.click(screen.getByRole("button", { name: "当前分支 main" }));
    await fireEvent.click(await screen.findByRole("button", { name: "合并到当前分支" }));
    merge = await screen.findByRole("dialog", { name: "合并分支" });
    expect(within(merge).queryByRole("button", { name: "返回分支与标签" })).toBeNull();
    await fireEvent.click(within(merge).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "合并分支" })).toBeNull());
    expect(screen.queryByRole("dialog", { name: "分支与标签" })).toBeNull();
  });

  it("从其他分支变基时基底是所点分支，当前分支保持不动", async () => {
    mocks.branchState.mockResolvedValue(branchFixture());
    render(App);
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: "当前分支 main" }));
    await fireEvent.click(await screen.findByRole("button", { name: "管理分支与标签" }));
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBeGreaterThan(0));
    const develop = [...document.querySelectorAll<HTMLElement>(".branch-row")].find((row) => row.textContent?.includes("develop"));
    expect(develop).toBeTruthy();
    await fireEvent.contextMenu(develop!, { clientX: 40, clientY: 40 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "把当前分支变基到此分支…" }));
    const dialog = await screen.findByRole("dialog", { name: "合并分支" });
    const radio = await within(dialog).findByRole("radio", { name: /变基/ });
    expect(radio.getAttribute("aria-checked")).toBe("true");
    expect(dialog.textContent).toContain("将改写当前分支");
    await vi.waitFor(() => expect(mocks.mergePreview).toHaveBeenCalledWith(repoPath, "develop", null, 4, expect.any(Number)));
    expect(mocks.startMerge).not.toHaveBeenCalled();
    await fireEvent.click(within(dialog).getByRole("button", { name: "变基并改写当前分支" }));
    await fireEvent.click(within(await screen.findByRole("dialog", { name: "确认变基" })).getByRole("button", { name: "取消" }));
    expect(mocks.startMerge).not.toHaveBeenCalled();
    expect(document.querySelector(".branch-pill")?.textContent).toContain("main");
  });
});

describe("从改动进入文件树", () => {
  it("右键「在文件树中显示」切到文件视图并逐级读取目标路径", async () => {
    const dirEntry = (path: string, kind: "file" | "directory") => ({
      name: path.split("/").pop() ?? path,
      path,
      kind,
      ignored: false,
      size: kind === "file" ? 10 : null,
      error: null,
    });
    mocks.repositoryDirectory.mockImplementation((_repo: string, relative: string, _ignored: boolean, generation: number) =>
      Promise.resolve({
        generation,
        path: relative,
        entries: relative === "" ? [dirEntry("src", "directory")] : [dirEntry("src/App.svelte", "file")],
        errors: [],
      }),
    );
    mocks.repositoryFileContent.mockResolvedValue({
      generation: 4,
      path: "src/App.svelte",
      kind: "text",
      size: 10,
      offset: 0,
      lines: ["content"],
      nextOffset: 1,
      hasMore: false,
      truncated: false,
      message: null,
    });
    render(App);
    await openRepo();

    const row = [...document.querySelectorAll<HTMLElement>(".file-list .file-row")].find((item) =>
      item.getAttribute("title")?.includes("src/App.svelte"),
    );
    expect(row).toBeTruthy();
    await fireEvent.contextMenu(row!);
    const item = await screen.findByRole("menuitem", { name: "在文件树中显示" });
    await fireEvent.click(item);

    await waitFor(() =>
      expect(document.querySelector('.workbench-view[data-active="true"] [aria-current="page"]')?.getAttribute("data-view")).toBe("files"),
    );
    await waitFor(() =>
      expect(mocks.repositoryDirectory.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining(["", "src"])),
    );
    await waitFor(() =>
      expect(mocks.repositoryFileContent).toHaveBeenCalledWith(repoPath, "src/App.svelte", 0, undefined, 4, expect.any(Number)),
    );
  });
});

describe("cliora 来源展示", () => {
  const reviewId = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
  const sessionId = "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0";
  const mergedOid = "c".repeat(40);

  beforeEach(() => {
    resetClioraReview();
    mocks.openRepository.mockResolvedValue({
      summary: { name: "demo", path: repoPath },
      generation: 4,
      snapshot,
      draft: "",
      watchDegraded: false,
    });
  });

  afterEach(() => resetClioraReview());

  it("独立打开别的仓库后清掉 cliora 来源，返回入口消失", async () => {
    beginClioraReview({
      reviewId,
      sessionId,
      worktreePath: "C:/work/other",
      baseline: null,
    });
    render(App);
    await openRepo();
    expect(screen.queryByRole("button", { name: /返回 cliora/ })).toBeNull();
    expect(screen.queryByText("cliora")).toBeNull();
  });

  it("进入文件视图浏览文件后来源仍在，返回 cliora 仍是 reviewed 且没有 Git 写入", async () => {
    beginClioraReview({ reviewId, sessionId, worktreePath: repoPath, baseline: null });
    mocks.repositoryDirectory.mockResolvedValue({
      generation: 4,
      path: "",
      entries: [{ name: "App.svelte", path: "App.svelte", kind: "file", ignored: false, size: 10, error: null }],
      errors: [],
    });
    mocks.repositoryFileContent.mockResolvedValue({
      generation: 4,
      path: "App.svelte",
      kind: "text",
      size: 10,
      offset: 0,
      lines: ["content"],
      nextOffset: 1,
      hasMore: false,
      truncated: false,
      message: null,
    });
    render(App);
    await openRepo();
    expect(screen.getByRole("button", { name: /返回 cliora/ })).toBeTruthy();

    await press("3");
    await waitFor(() =>
      expect(document.querySelector('.workbench-view[data-active="true"] [aria-current="page"]')?.getAttribute("data-view")).toBe("files"),
    );
    // 切换视图不清来源。
    expect(screen.getByRole("button", { name: /返回 cliora/ })).toBeTruthy();

    const tree = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(await within(tree).findByRole("treeitem", { name: /App\.svelte/ }));
    await waitFor(() => expect(mocks.repositoryFileContent).toHaveBeenCalled());

    await fireEvent.click(screen.getByRole("button", { name: /返回 cliora/ }));
    await waitFor(() => expect(mocks.clioraReviewReturn).toHaveBeenCalledWith(reviewId, sessionId, "reviewed", null));
    expect(mocks.stageFiles).not.toHaveBeenCalled();
    expect(mocks.commitChanges).not.toHaveBeenCalled();
  });

  it("同一 worktree 重新打开时保留来源与最新合入结果", async () => {
    beginClioraReview({ reviewId, sessionId, worktreePath: repoPath, baseline: null });
    recordClioraMerge(repoPath, mergedOid);
    render(App);
    await openRepo();
    await waitFor(() =>
      expect(screen.getByText("已合入 " + mergedOid.slice(0, 7))).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /返回 cliora/ })).toBeTruthy();
  });
});
