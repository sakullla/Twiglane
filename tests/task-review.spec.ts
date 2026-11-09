/**
 * 任务审阅（T2）：起点选择、范围上下文、净文件队列、只读净差异、范围内历史与失败恢复。
 *
 * 组件级用例直接渲染 TaskReview，验证它自己的状态机；App 级用例验证外壳接线
 * （⌘4 / 视图切换 / cliora 之外的普通仓库入口）与「只读、不写 Git」的边界。
 * 真实 Git 的净差异语义由 Rust 侧夹具覆盖（src-tauri/src/git/task.rs）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BranchInfo,
  DiffLine,
  DiffResponse,
  HistoryCommit,
  OpenedRepository,
  StatusSnapshot,
  TaskFileChange,
  TaskReview as TaskSnapshot,
} from "../src/lib/types";

const WORKTREE = "C:/work/demo";
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);

const branch: BranchInfo = {
  name: "main",
  detached: false,
  unborn: false,
  headOid: HEAD,
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  liveRemoteChecked: false,
  remoteCheckedAtMs: 0,
  remoteCheckStale: false,
};

const snapshot: StatusSnapshot = {
  generation: 4,
  branch,
  files: [
    {
      path: "src/app.ts",
      originalPath: null,
      staged: "none",
      unstaged: "modified",
      untracked: true,
      unmerged: false,
    },
  ],
};

const opened: OpenedRepository = {
  summary: { name: "demo", path: WORKTREE },
  generation: 4,
  snapshot,
  draft: "",
  watchDegraded: false,
};

const commits: HistoryCommit[] = [
  {
    oid: "d".repeat(40),
    parents: [BASE],
    summary: "第二个提交",
    authorName: "Ada",
    authorEmail: "ada@example.com",
    authoredAt: 1_700_000_200,
    labels: [],
  },
  {
    oid: "e".repeat(40),
    parents: [BASE],
    summary: "第一个提交",
    authorName: "Ada",
    authorEmail: "ada@example.com",
    authoredAt: 1_700_000_100,
    labels: [],
  },
];

function taskFile(path: string, status: string, extra: Partial<TaskFileChange> = {}): TaskFileChange {
  return {
    path,
    originalPath: null,
    status,
    additions: 4,
    deletions: 1,
    binary: false,
    oldSize: null,
    newSize: null,
    untracked: false,
    unmerged: false,
    ...extra,
  };
}

function taskFixture(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    generation: 4,
    worktree: WORKTREE,
    baselineRef: "main~2",
    baselineOid: BASE,
    headOid: HEAD,
    branch,
    commits,
    commitCount: 2,
    commitsTruncated: false,
    files: [
      taskFile("src/app.ts", "modified"),
      taskFile("docs/gone.md", "deleted", { additions: 0, deletions: 7 }),
      taskFile("src/fresh.ts", "added", { untracked: true, additions: 5, deletions: 0 }),
    ],
    filesTotal: 3,
    filesTruncated: false,
    additions: 9,
    deletions: 8,
    dirty: true,
    untrackedFiles: 1,
    conflicted: false,
    empty: false,
    rangeVersion: "range-1",
    message: "读取成功：起点之后 2 个提交，最终净改动 3 个文件。",
    ...overrides,
  };
}

function diffFor(path: string): DiffResponse {
  const lines: DiffLine[] = Array.from({ length: 6 }, (_, index) => ({
    kind: index === 2 ? "add" : "context",
    text: index === 2 ? "+任务净改动" : ` line-${index}`,
    oldNo: index + 1,
    newNo: index + 1,
    hunkIndex: 0,
  }));
  return {
    generation: 4,
    path,
    staged: false,
    binary: false,
    text: null,
    summary: "新增 1 行。",
    additions: 1,
    deletions: 0,
    complete: true,
    truncated: false,
    snapshot: "snap",
    hunks: [{ index: 0, header: "@@ -1,6 +1,6 @@", complete: true, stageable: true, startLine: 0, lineCount: 6 }],
    lines,
    offset: 0,
    totalLines: lines.length,
  };
}

const mocks = vi.hoisted(() => {
  const created = new Map<string, ReturnType<typeof vi.fn>>();
  const api = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get: (_target, name) => {
      if (typeof name !== "string") return undefined;
      if (!created.has(name)) created.set(name, vi.fn());
      return created.get(name)!;
    },
  });
  return { api, created, listenEvent: vi.fn(), pickDirectory: vi.fn(), pickFile: vi.fn() };
});

vi.mock("../src/lib/api", () => ({
  api: mocks.api,
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));

import App from "../src/App.svelte";
import TaskReview from "../src/lib/components/TaskReview.svelte";
import { resetClioraReview } from "../src/lib/cliora-review.svelte";
import { resetReviewProgress } from "../src/lib/review-progress.svelte";

function resetMocks() {
  for (const fn of mocks.created.values()) fn.mockReset();
  mocks.listenEvent.mockReset();
  mocks.listenEvent.mockResolvedValue(() => {});
  mocks.pickDirectory.mockResolvedValue(null);
  mocks.pickFile.mockResolvedValue(null);
  mocks.api.getSettings.mockResolvedValue({
    theme: "dark",
    panelWidths: { sidebar: 256, files: 360 },
    git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" },
    recent: [{ name: "demo", path: WORKTREE, openedAtMs: 1 }],
    settingsWarning: null,
  });
  mocks.api.detectGit.mockResolvedValue({ available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" });
  mocks.api.cancelReads.mockResolvedValue(undefined);
  mocks.api.saveDraft.mockResolvedValue(undefined);
  mocks.api.setTheme.mockResolvedValue(undefined);
  mocks.api.setPanelWidths.mockImplementation(async (widths: unknown) => widths);
  mocks.api.openRepository.mockResolvedValue(opened);
  mocks.api.refreshStatus.mockResolvedValue(snapshot);
  mocks.api.loadDiff.mockImplementation(async (_path: string, relative: string) => diffFor(relative));
  mocks.api.mergeSession.mockResolvedValue({
    generation: 4,
    operation: "none",
    canContinue: false,
    canAbort: false,
    source: null,
    target: "main",
    headOid: HEAD,
    conflicts: [],
    unresolved: 0,
    note: "当前没有进行中的合并。",
    snapshot,
  });
  mocks.api.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
  mocks.api.repoHeads.mockResolvedValue([]);
  mocks.api.branchList.mockResolvedValue({
    generation: 4,
    branches: [
      { name: "main", remote: false, current: true, upstream: "origin/main", worktree: null },
      { name: "feature/task", remote: false, current: false, upstream: null, worktree: null },
    ],
  });
  mocks.api.historyPage.mockResolvedValue({
    generation: 4,
    query: "",
    offset: 0,
    pageSize: 100,
    hasMore: false,
    state: "ok",
    commits,
    scope: "current",
    branches: ["main"],
    head: "main",
  });
  mocks.api.taskReview.mockResolvedValue(taskFixture());
  mocks.api.loadTaskDiff.mockImplementation(async (_worktree: string, _base: string, _head: string, relative: string) => diffFor(relative));
}

beforeEach(() => {
  resetMocks();
  resetClioraReview();
  resetReviewProgress();
});

afterEach(() => {
  cleanup();
  resetClioraReview();
  resetReviewProgress();
});

function reviewProps(overrides: Record<string, unknown> = {}) {
  return {
    opened,
    active: true,
    request: { baseline: "main~2", origin: "manual" as const, nonce: 1 },
    nextId: () => 7,
    fullFile: false,
    onFullFile: vi.fn(),
    onGeneration: vi.fn(),
    onNotice: vi.fn(),
    onFailure: vi.fn(),
    onFileHistory: vi.fn(),
    onCommitHistory: vi.fn(),
    onPickBaseline: vi.fn(),
    onClearBaseline: vi.fn(),
    onFileNav: vi.fn(),
    onHunkNav: vi.fn(),
    ...overrides,
  };
}

describe("任务审阅组件", () => {
  it("没有起点时只给选择器，不读取任务，也不用 HEAD 补缺", async () => {
    render(TaskReview, { props: reviewProps({ request: null }) });
    await screen.findByText(/任务起点必须由你明确选择/);
    expect(mocks.api.taskReview).not.toHaveBeenCalled();
    expect(document.querySelector(".file-list")).toBeNull();
    // 候选要用户自己点：没有任何一项被预选成起点。
    expect(document.querySelector('.task-baseline-item[aria-pressed="true"]')).toBeNull();
  });

  it("有起点时展示范围上下文、净文件队列与提交统计", async () => {
    render(TaskReview, { props: reviewProps() });
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledWith(WORKTREE, "main~2", 4, expect.any(Number)));
    const context = await screen.findByRole("group", { name: "任务范围" });
    expect(context.textContent).toContain(BASE.slice(0, 7));
    expect(context.textContent).toContain("main");
    expect(context.textContent).toContain("2 个提交");
    expect(context.textContent).toContain("3 个文件");
    expect(context.textContent).toContain("含未提交改动");
    expect(context.textContent).toContain("未跟踪 1 个");
    // 文件队列仍是同一套列表：表头改称任务文件，并且没有暂存入口。
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    expect(within(list).getByText("任务文件")).toBeTruthy();
    expect(within(list).queryByRole("button", { name: "暂存" })).toBeNull();
    expect(within(list).queryByRole("button", { name: /标记 .* 已审阅/ })).toBeNull();
  });

  it("首个文件自动选中并读取只读净差异，工具栏没有暂存动作", async () => {
    render(TaskReview, { props: reviewProps() });
    await waitFor(() => expect(mocks.api.loadTaskDiff).toHaveBeenCalled());
    const call = mocks.api.loadTaskDiff.mock.calls[0];
    expect(call[0]).toBe(WORKTREE);
    expect(call[1]).toBe(BASE);
    expect(call[2]).toBe(HEAD);
    await waitFor(() => expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
    const toolbar = document.querySelector(".diff-toolbar")!;
    expect(toolbar.querySelector('[aria-label="暂存"]')).toBeNull();
    expect(document.body.textContent).toContain("只读");
  });

  it("空任务只在完整读取成功后出现", async () => {
    mocks.api.taskReview.mockResolvedValue(
      taskFixture({ files: [], filesTotal: 0, additions: 0, deletions: 0, empty: true, dirty: false, untrackedFiles: 0, commitCount: 0, commits: [], message: "读取成功：起点之后没有提交，也没有未提交改动。" }),
    );
    render(TaskReview, { props: reviewProps() });
    await screen.findByText("这个任务没有净改动");
    expect(document.querySelector(".file-list")).toBeNull();
    expect(mocks.api.loadTaskDiff).not.toHaveBeenCalled();
  });

  it("范围失效时撤下结果并给出重新读取与重选起点", async () => {
    const onClearBaseline = vi.fn();
    const { rerender } = render(TaskReview, { props: reviewProps({ onClearBaseline }) });
    await screen.findByRole("listbox", { name: "任务文件" });
    mocks.api.taskReview.mockRejectedValue({ code: "task_head_changed", message: "当前 HEAD 已经不是这个任务快照的 HEAD。" });
    await rerender(reviewProps({ onClearBaseline, request: { baseline: "main~2", origin: "manual" as const, nonce: 2 } }));
    await screen.findByText("任务范围已失效");
    // 旧结果被撤下：不能继续当成当前任务。
    expect(document.querySelector(".file-list")).toBeNull();
    expect(screen.queryByRole("listbox", { name: "任务文件" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "重选起点" }));
    expect(onClearBaseline).toHaveBeenCalledTimes(1);
  });

  it("旧响应不覆盖新选择", async () => {
    let finishFirst!: (value: TaskSnapshot) => void;
    let finishSecond!: (value: TaskSnapshot) => void;
    mocks.api.taskReview
      .mockImplementationOnce(() => new Promise<TaskSnapshot>((resolve) => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<TaskSnapshot>((resolve) => { finishSecond = resolve; }));
    const { rerender } = render(TaskReview, { props: reviewProps() });
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledTimes(1));
    await rerender(reviewProps({ request: { baseline: "feature/task", origin: "manual" as const, nonce: 2 } }));
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledTimes(2));
    finishSecond(taskFixture({ baselineRef: "feature/task", commitCount: 5, commits: [], message: "第二个选择" }));
    await waitFor(() => expect(document.body.textContent).toContain("5 个提交"));
    finishFirst(taskFixture({ baselineRef: "main~2", commitCount: 1, commits: [] }));
    await tick();
    expect(document.body.textContent, "迟到的第一份结果不能盖掉新选择").toContain("5 个提交");
    expect(document.body.textContent).not.toContain("1 个提交");
  });

  it("范围内提交可以进入提交历史", async () => {
    const onCommitHistory = vi.fn();
    render(TaskReview, { props: reviewProps({ onCommitHistory }) });
    const history = await screen.findByLabelText("范围内提交");
    expect(history.textContent).toContain("第二个提交");
    await fireEvent.click(within(history).getByRole("button", { name: /第二个提交/ }));
    expect(onCommitHistory).toHaveBeenCalledWith(commits[0].oid);
  });

  it("隐藏的任务视图不读取，回到任务页才按最新状态读取", async () => {
    const { rerender } = render(TaskReview, { props: reviewProps({ active: false }) });
    await tick();
    expect(mocks.api.taskReview).not.toHaveBeenCalled();
    await rerender(reviewProps({ active: true }));
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledTimes(1));
    await rerender(reviewProps({ active: false }));
    await tick();
    expect(mocks.api.taskReview).toHaveBeenCalledTimes(1);
    // 回到任务页：重读一次，而不是拿旧结果当最新状态。
    await rerender(reviewProps({ active: true }));
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledTimes(2));
  });

  it("多选文件时按块读取净差异，工具条只留只读说明", async () => {
    render(TaskReview, { props: reviewProps() });
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    const rows = within(list).getAllByRole("option");
    expect(rows.length).toBe(3);
    await fireEvent.click(rows[1], { ctrlKey: true });
    await waitFor(() => expect(document.querySelector(".multi-stack")).toBeTruthy());
    await waitFor(() => {
      const paths = mocks.api.loadTaskDiff.mock.calls.map((call) => call[3]);
      expect(new Set(paths).size).toBeGreaterThanOrEqual(2);
    });
    const toolbar = document.querySelector(".multi-stack .diff-toolbar")!;
    expect(toolbar.querySelector('[aria-label^="暂存 "]')).toBeNull();
    expect(toolbar.querySelector('[aria-label^="放弃 "]')).toBeNull();
    expect(document.body.textContent).toContain("任务净差异只读");
  });

  it("单文件读取失败就地说明并可按同一读取路径重试", async () => {
    mocks.api.loadTaskDiff.mockRejectedValueOnce({ code: "diff_failed", message: "无法读取这次任务的差异，未修改仓库。" });
    render(TaskReview, { props: reviewProps() });
    await screen.findByText("差异没有读取完成");
    expect(document.body.textContent).toContain("无法读取这次任务的差异，未修改仓库。");
    // 其他文件仍在队列里：一个文件失败不会清空任务。
    expect(screen.getByRole("listbox", { name: "任务文件" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
  });

  it("二进制差异给出大小并可转成文本读取", async () => {
    mocks.api.loadTaskDiff.mockResolvedValueOnce({
      ...diffFor("src/app.ts"),
      binary: true,
      oldSize: 11,
      newSize: 6,
      additions: 0,
      deletions: 0,
      summary: "二进制文件。",
      hunks: [],
      lines: [],
      totalLines: 0,
    });
    render(TaskReview, { props: reviewProps() });
    await screen.findByText("二进制文件有变动");
    expect(document.body.textContent).toContain("11 B");
    expect(document.body.textContent).toContain("6 B");
    mocks.api.loadTaskDiff.mockClear();
    await fireEvent.click(screen.getByRole("button", { name: "按文本查看" }));
    await waitFor(() => expect(mocks.api.loadTaskDiff).toHaveBeenCalled());
    expect(mocks.api.loadTaskDiff.mock.calls.at(-1)?.[10]).toBe(true);
  });

  it("截断的差异沿用同一条说明，不冒充完整结果", async () => {
    mocks.api.loadTaskDiff.mockResolvedValueOnce({
      ...diffFor("src/app.ts"),
      complete: false,
      truncated: true,
      summary: "差异超过预览上限，只显示前 6 行。",
    });
    render(TaskReview, { props: reviewProps() });
    await waitFor(() => expect(document.body.textContent).toContain("差异超过预览上限"));
  });

  it("只读取差异，不调用任何写入接口", async () => {
    render(TaskReview, { props: reviewProps() });
    await waitFor(() => expect(mocks.api.loadTaskDiff).toHaveBeenCalled());
    for (const name of ["stageFiles", "unstageFiles", "stageHunks", "stageLines", "commitChanges", "switchBranch"]) {
      expect(mocks.created.get(name)?.mock.calls.length ?? 0, name).toBe(0);
    }
  });
});

/** 打开夹具仓库，等到改动视图就绪。 */
async function openRepo() {
  await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
  await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
  await waitFor(() => expect(document.querySelector(".workbench-view[data-active=\"true\"] .file-list")).toBeTruthy());
}

/** 键盘层挂在 window 上：⌘/Ctrl + 数字切换视图。 */
async function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }));
  await tick();
}

function activeView(): string | null {
  return (
    document
      .querySelector('.workbench-view[data-active="true"] [aria-current="page"]')
      ?.getAttribute("data-view") ?? null
  );
}

describe("任务视图接线", () => {
  it("⌘4 进入任务视图，没有起点时要求选择，全程不写 Git", async () => {
    render(App);
    await openRepo();
    expect(activeView()).toBe("changes");
    await press("4");
    await waitFor(() => expect(activeView()).toBe("task"));
    await screen.findByText(/任务起点必须由你明确选择/);
    expect(mocks.api.taskReview).not.toHaveBeenCalled();
    expect(mocks.created.get("stageFiles")?.mock.calls.length ?? 0).toBe(0);
    expect(mocks.created.get("commitChanges")?.mock.calls.length ?? 0).toBe(0);
  });

  it("从范围内的提交进入提交历史，不切换分支也不写工作区", async () => {
    render(App);
    await openRepo();
    await press("4");
    await waitFor(() => expect(activeView()).toBe("task"));
    const picker = await screen.findByLabelText("选择任务起点");
    await fireEvent.click(await within(picker).findByRole("button", { name: /feature\/task/ }));
    const history = await screen.findByLabelText("范围内提交");
    await waitFor(() => expect(within(history).getByRole("button", { name: /第二个提交/ })).toBeTruthy());
    await fireEvent.click(within(history).getByRole("button", { name: /第二个提交/ }));
    await waitFor(() => expect(activeView()).toBe("history"));
    // 历史面板是懒加载的：等它真的带着这个提交标识发起读取。
    await waitFor(
      () =>
        expect(mocks.api.historyPage).toHaveBeenCalledWith(
          WORKTREE,
          commits[0].oid,
          0,
          expect.any(Number),
          expect.any(Number),
        ),
      { timeout: 8000 },
    );
    // 用完整提交标识进入历史：按哈希筛选，而不是切到那条提交所在的分支。
    expect(mocks.created.get("switchBranch")?.mock.calls.length ?? 0).toBe(0);
    expect(mocks.created.get("stageFiles")?.mock.calls.length ?? 0).toBe(0);
  });

  it("选定分支起点后读取任务范围，并让改动视图的选择与差异保持可用", async () => {
    render(App);
    await openRepo();
    await press("4");
    await waitFor(() => expect(activeView()).toBe("task"));
    const picker = await screen.findByLabelText("选择任务起点");
    await waitFor(() => expect(within(picker).getByRole("button", { name: /feature\/task/ })).toBeTruthy());
    await fireEvent.click(within(picker).getByRole("button", { name: /feature\/task/ }));
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledWith(WORKTREE, "feature/task", 4, expect.any(Number)));
    await screen.findByRole("listbox", { name: "任务文件" });
    // 返回改动视图仍走原来的读取，任务范围不改变真实暂存内容。
    mocks.api.loadDiff.mockClear();
    await press("1");
    await waitFor(() => expect(activeView()).toBe("changes"));
    await waitFor(() => expect(mocks.api.loadDiff).toHaveBeenCalled());
    expect(mocks.created.get("stageFiles")?.mock.calls.length ?? 0).toBe(0);
  });
});
