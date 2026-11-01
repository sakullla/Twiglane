import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAND } from "../src/lib/brand";
import type { DiffLine, DiffResponse, FileChange, HistoryCommit, StatusSnapshot } from "../src/lib/types";

/* ------------------------------------------------------------------ *
 * App 级夹具：真实 api 由 vi.mock 顶替，界面走完整外壳。
 * 本文件只盯外壳的可观察契约（标题栏、rail 分组、命令面板、主题解析），
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

/**
 * R11 的动作清单：id 与面板上要看到的标题一一对应，顺序就是注册表顺序。
 * 仓库切换那条命令的 id 带路径，动态拼在最前面。
 */
const R11_ACTIONS: { id: string; title: string }[] = [
  { id: "view.changes", title: "改动" },
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
  { id: "rail.toggle", title: "折叠侧栏" },
  { id: "palette.open", title: "命令面板" },
  { id: "dialog.dependencies", title: "运行依赖" },
];

/** 注册表状态夹具：暂存区有 2 个文件、草稿已填，是「看起来都能用」的那一侧。 */
function commandState(overrides: Partial<CommandState> = {}): CommandState {
  return {
    hasRepo: true,
    workspaceView: "changes",
    taskModal: null,
    navCollapsed: false,
    writeLocked: false,
    writing: false,
    reading: false,
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
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
});

describe("应用外壳", () => {
  it("标题栏恰好 6 个常驻控件，刷新、发布分支、只关联上游、远程管理都不在里面", async () => {
    render(App);

    // 未打开仓库时同样是 6 个：常驻是这个标题栏的契约，不是「打开后才补齐」。
    expect(document.querySelectorAll("[data-titlebar-control]")).toHaveLength(6);

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

  it("rail 分导航与任务两组，导航恰好是改动与提交历史", async () => {
    render(App);
    await openRepo();

    const rail = document.querySelector<HTMLElement>("aside.rail");
    expect(rail, "rail 要存在").toBeTruthy();
    const navs = [...rail!.querySelectorAll<HTMLElement>("nav")];
    // 两组且只有两组：组名进 aria-label，读屏与测试都按名字取。
    expect(navs.map((nav) => nav.getAttribute("aria-label"))).toEqual(["导航", "任务"]);

    const labelsOf = (nav: HTMLElement) =>
      [...nav.querySelectorAll<HTMLElement>(".workspace-nav-item")].map((item) =>
        (item.getAttribute("aria-label") ?? "").replace(/\s+\d+$/, ""),
      );

    const navLabels = labelsOf(navs[0]);
    const taskLabels = labelsOf(navs[1]);
    expect(navLabels).toEqual(["改动", "提交历史"]);
    expect(taskLabels).toEqual(["临时保存", "分支合并", "分支与标签", "远程"]);
    // 两组的入口不重叠：任务项不会挤进导航组，反之亦然。
    expect(navLabels.filter((label) => taskLabels.includes(label))).toEqual([]);

    // 导航组的第一项是当前视图；点第二项真的换成历史，而不是只换高亮。
    expect(navs[0].querySelector<HTMLElement>('.workspace-nav-item[aria-current="page"]')?.getAttribute("aria-label")).toMatch(/^改动/);
    await fireEvent.click(screen.getByRole("button", { name: "提交历史" }));
    await waitFor(() =>
      expect(navs[0].querySelector<HTMLElement>('.workspace-nav-item[aria-current="page"]')?.getAttribute("aria-label")).toBe(
        "提交历史",
      ),
    );
    await waitFor(() => expect(document.querySelector(".history-list")).toBeTruthy());

    // 折叠为仅图标后两组与条目都还在，名称改由 aria-label 承载。
    await press("b");
    const collapsedRail = document.querySelector<HTMLElement>("aside.rail.collapsed");
    expect(collapsedRail).toBeTruthy();
    const collapsedNavs = [...collapsedRail!.querySelectorAll<HTMLElement>("nav")];
    expect(collapsedNavs.map((nav) => nav.getAttribute("aria-label"))).toEqual(["导航", "任务"]);
    expect(labelsOf(collapsedNavs[0])).toEqual(["改动", "提交历史"]);
    expect(labelsOf(collapsedNavs[1])).toEqual(["临时保存", "分支合并", "分支与标签", "远程"]);
    // 折叠态不再渲染名称文字，只剩图标与计数；名称改由 aria-label 承载。
    for (const item of collapsedRail!.querySelectorAll<HTMLElement>(".workspace-nav-item")) {
      expect(item.textContent?.trim() ?? "").not.toMatch(/改动|提交历史|临时保存|分支合并|分支与标签|远程/);
    }
    expect(screen.getByRole("button", { name: "提交历史" }), "折叠态仍可进入").toBeTruthy();
  });

  it("命令面板按 R11 的 id 清单逐项列出动作，草稿为空时两项提交都带原因", async () => {
    // 注册表一侧：id 清单完整且顺序稳定（仓库切换插在仓库组的末尾）。
    expect(paletteItems(commandState()).map((item) => item.id)).toEqual(R11_ACTIONS.map((action) => action.id));

    // 暂存区非空、草稿为空：这是「面板里看起来能点、按钮却是灰的」最容易分叉的时刻。
    render(App);
    await openRepo();
    const palette = await openPalette();
    const options = within(palette).getAllByRole("option");
    expect(options, "面板条目与注册表动作一一对应").toHaveLength(R11_ACTIONS.length);
    expect(options.map((option) => option.firstElementChild?.textContent?.trim())).toEqual(
      R11_ACTIONS.map((action) => action.title),
    );

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

    // 只读不锁切换仓库：写操作才锁。
    expect(reading.find((item) => item.id === `${REPO_SWITCH_PREFIX}${repoPath}`)?.enabled).toBe(true);
    expect(writing.find((item) => item.id === `${REPO_SWITCH_PREFIX}${repoPath}`)?.enabled).toBe(false);
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

    // 首屏只有一句结论加一个入口：长安装说明不再作为段落堆在这里（R12、R13）。
    const bar = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(".infobar.error");
      expect(node, "Git 不可用要有常驻诊断入口").toBeTruthy();
      return node!;
    });
    expect(bar.textContent).toContain("没有找到 Git");
    expect(bar.querySelector("p"), "通知条里不再有说明段落").toBeNull();
    expect(bar.textContent).not.toContain("git-scm.com");
    expect(within(bar).getByRole("button", { name: "关闭 Git 诊断入口" }), "入口必须可关闭").toBeTruthy();

    // 起始页自己也接了诊断入口：Welcome 的 diagnostic/onDiagnose 由外壳传入
    const welcomeEntry = within(document.querySelector<HTMLElement>(".welcome")!).getByRole("button", {
      name: /没有找到 Git/,
    });

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

    // Esc 关闭后焦点回到触发元素
    await fireEvent.keyDown(modal, { key: "Escape" });
    await waitFor(() => expect(document.querySelector('[data-task-modal="settings"]')).toBeNull());
    expect(document.activeElement, "关闭后焦点回到起始页的诊断入口").toBe(welcomeEntry);

    // 通知条上的诊断按钮走同一条动作；关掉通知条后起始页入口仍在（R13 不因关闭而消失）
    await fireEvent.click(within(bar).getByRole("button", { name: "运行环境诊断" }));
    await waitFor(() => expect(document.querySelector('[data-settings-section="runtime"]')).toBeTruthy());
    await fireEvent.keyDown(document.querySelector('[data-task-modal="settings"]')!, { key: "Escape" });
    await waitFor(() => expect(document.querySelector('[data-task-modal="settings"]')).toBeNull());

    await fireEvent.click(within(bar).getByRole("button", { name: "关闭 Git 诊断入口" }));
    await waitFor(() => expect(document.querySelector(".infobar.error")).toBeNull());
    expect(screen.queryByRole("button", { name: "关闭 Git 诊断入口" })).toBeNull();
    expect(
      within(document.querySelector<HTMLElement>(".welcome")!).getByRole("button", { name: /没有找到 Git/ }),
      "关掉通知条不影响起始页自己的诊断入口",
    ).toBeTruthy();
  });
});
