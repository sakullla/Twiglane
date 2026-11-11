/**
 * 任务净差异（cliora 审查）：范围上下文、净文件队列、只读净差异与失败恢复。
 *
 * 组件级用例直接渲染 TaskReview，验证它自己的状态机；App 级用例验证外壳接线：
 * 任务范围只来自 cliora 链接，没有独立视图，普通仓库里不出现任务入口。
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
    request: { baseline: "main~2", origin: "cliora" as const, nonce: 1 },
    nextId: () => 7,
    fullFile: false,
    onFullFile: vi.fn(),
    onGeneration: vi.fn(),
    onNotice: vi.fn(),
    onFailure: vi.fn(),
    onFileHistory: vi.fn(),
    onSummary: vi.fn(),
    onFileNav: vi.fn(),
    onHunkNav: vi.fn(),
    reviewed: new Set<string>(),
    reviewBusy: null,
    reviewNote: null,
    hideReviewed: false,
    onToggleReview: vi.fn(),
    onHideReviewed: vi.fn(),
    onStageFile: vi.fn(),
    onOpenUnstaged: vi.fn(),
    onOpenChanges: vi.fn(),
    stagedPaths: [] as string[],
    onSnapshot: vi.fn(),
    onSelection: vi.fn(),
    onReviewNav: vi.fn(),
    ...overrides,
  };
}

describe("任务审阅组件", () => {
  it("连续分页不重复读取或跳过页，反复点击只保留一个分页请求", async () => {
    const pending: Array<() => void> = [];
    mocks.api.loadTaskDiff.mockImplementation((_worktree: string, _base: string, _head: string, path: string, _generation: number, _id: number, _original: string | null, offset: number) => {
      const page = { ...diffFor(path), offset, totalLines: 18 };
      return offset === 0 ? Promise.resolve(page) : new Promise((resolve) => pending.push(() => resolve(page)));
    });
    render(TaskReview, { props: reviewProps() });
    let more = await screen.findByRole("button", { name: "继续加载" });
    await fireEvent.click(more);
    await fireEvent.click(more);
    expect(mocks.api.loadTaskDiff).toHaveBeenCalledTimes(2);
    pending[0]();
    await waitFor(() => expect(document.body.textContent).toContain("已显示 12 / 18 行"));
    more = screen.getByRole("button", { name: "继续加载" });
    await fireEvent.click(more);
    expect(mocks.api.loadTaskDiff.mock.calls.map((call) => call[7])).toEqual([0, 6, 12]);
    pending[1]();
    await waitFor(() => expect(screen.queryByRole("button", { name: "继续加载" })).toBeNull());
  });

  it("快速点选只保留两项在途读取和最后一次待执行选择", async () => {
    const finishes: Array<() => void> = [];
    mocks.api.loadTaskDiff.mockImplementation((_worktree: string, _base: string, _head: string, path: string) =>
      new Promise((resolve) => finishes.push(() => resolve(diffFor(path)))),
    );
    render(TaskReview, { props: reviewProps() });
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    await waitFor(() => expect(mocks.api.loadTaskDiff).toHaveBeenCalledTimes(1));
    const rows = within(list).getAllByRole("option");
    await fireEvent.click(rows[1]);
    await fireEvent.click(rows[2]);
    await fireEvent.click(rows[0]);
    expect(mocks.api.loadTaskDiff).toHaveBeenCalledTimes(2);
    finishes[0]();
    await waitFor(() => expect(mocks.api.loadTaskDiff).toHaveBeenCalledTimes(3));
    expect(mocks.api.loadTaskDiff.mock.calls[2][3]).toBe(mocks.api.loadTaskDiff.mock.calls[0][3]);
    finishes[1]();
    finishes[2]();
    await tick();
    expect(mocks.api.loadTaskDiff).toHaveBeenCalledTimes(3);
  });

  it("隐藏详情释放差异，迟到结果不重新填入，返回时按保留选择重读", async () => {
    let finish!: (value: DiffResponse) => void;
    mocks.api.loadTaskDiff.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const { rerender } = render(TaskReview, { props: reviewProps() });
    await waitFor(() => expect(mocks.api.loadTaskDiff).toHaveBeenCalledTimes(1));
    const path = mocks.api.loadTaskDiff.mock.calls[0][3];
    await rerender(reviewProps({ visible: false }));
    finish(diffFor(path));
    await tick();
    expect(document.querySelectorAll("[data-diff-row]")).toHaveLength(0);
    await rerender(reviewProps({ visible: true }));
    await waitFor(() => expect(mocks.api.loadTaskDiff).toHaveBeenCalledTimes(2));
    expect(mocks.api.loadTaskDiff.mock.calls[1][3]).toBe(path);
    expect(mocks.api.taskReview).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
    await rerender(reviewProps({ visible: false }));
    expect(document.querySelectorAll("[data-diff-row]")).toHaveLength(0);
  });

  it("离开视图后迟到的任务列表不再触发差异读取", async () => {
    let finish!: (value: TaskSnapshot) => void;
    mocks.api.taskReview.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const { rerender } = render(TaskReview, { props: reviewProps() });
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledTimes(1));
    await rerender(reviewProps({ active: false }));
    finish(taskFixture());
    await tick();
    expect(mocks.api.loadTaskDiff).not.toHaveBeenCalled();
    await rerender(reviewProps({ active: true }));
    await waitFor(() => expect(mocks.api.loadTaskDiff).toHaveBeenCalledTimes(1));
  });

  it("没有起点时不建立任务范围，也不用 HEAD 补缺", async () => {
    const onSummary = vi.fn();
    render(TaskReview, { props: reviewProps({ request: null, onSummary }) });
    await screen.findByText("没有任务范围");
    expect(screen.getByText(/不会用 HEAD 或默认分支代替/)).toBeTruthy();
    expect(mocks.api.taskReview).not.toHaveBeenCalled();
    expect(document.querySelector(".file-list")).toBeNull();
    expect(document.querySelector(".task-baseline")).toBeNull();
    expect(onSummary).toHaveBeenLastCalledWith(expect.objectContaining({ state: "none" }));
  });

  it("有起点时展示范围上下文、净文件队列与提交统计", async () => {
    render(TaskReview, { props: reviewProps() });
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledWith(WORKTREE, "main~2", 4, expect.any(Number)));
    const context = await screen.findByRole("group", { name: "任务范围" });
    expect(context.textContent).toContain(BASE.slice(0, 7));
    expect(context.textContent).toContain("main");
    expect(context.textContent).toContain("2 个提交");
    expect(context.textContent).toContain("3 个文件");
    expect(context.textContent).toContain("+ 未提交改动");
    expect(context.textContent).toContain("未跟踪 1 个");
    expect(context.textContent).toContain("来自 cliora 审查链接");
    expect(screen.getByRole("heading", { name: "任务净差异" })).toBeTruthy();
    // 文件队列仍是同一套列表：表头改称任务文件，并且没有暂存入口。
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    expect(within(list).getByText("任务文件")).toBeTruthy();
    // 没有泛化的「暂存」入口：整文件暂存必须指名这条真实路径。
    expect(within(list).queryByRole("button", { name: "暂存" })).toBeNull();
    // 任务队列与改动队列共用标记：这里是同一条命令的另一个入口。
    expect(within(list).getAllByRole("button", { name: /标记 .* 已审阅/ }).length).toBeGreaterThan(0);
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
    // 任务净差异不再借用改动视图的侧别文案：标题与标签都说明这是任务范围。
    expect(document.querySelector(".diff-path")?.getAttribute("title")).toContain("任务净差异");
    expect(document.querySelector(".diff-path")?.getAttribute("title")).not.toContain("未暂存");
    expect(document.querySelector(".diff-side.task")?.textContent).toBe("任务净差异");
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

  it("范围失效时撤下结果并给出重新读取，不提供重选起点", async () => {
    const onSummary = vi.fn();
    const { rerender } = render(TaskReview, { props: reviewProps({ onSummary }) });
    await screen.findByRole("listbox", { name: "任务文件" });
    mocks.api.taskReview.mockRejectedValue({ code: "task_head_changed", message: "当前 HEAD 已经不是这个任务快照的 HEAD。" });
    await rerender(reviewProps({ onSummary, request: { baseline: "main~2", origin: "cliora" as const, nonce: 2 } }));
    await screen.findByText("任务范围已失效");
    // 旧结果被撤下：不能继续当成当前任务。
    expect(document.querySelector(".file-list")).toBeNull();
    expect(screen.queryByRole("listbox", { name: "任务文件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重选起点" })).toBeNull();
    expect(onSummary).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failed" }));
    mocks.api.taskReview.mockResolvedValue(taskFixture());
    await fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await screen.findByRole("listbox", { name: "任务文件" });
  });

  it("旧响应不覆盖新选择", async () => {
    let finishFirst!: (value: TaskSnapshot) => void;
    let finishSecond!: (value: TaskSnapshot) => void;
    mocks.api.taskReview
      .mockImplementationOnce(() => new Promise<TaskSnapshot>((resolve) => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<TaskSnapshot>((resolve) => { finishSecond = resolve; }));
    const { rerender } = render(TaskReview, { props: reviewProps() });
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledTimes(1));
    await rerender(reviewProps({ request: { baseline: "feature/task", origin: "cliora" as const, nonce: 2 } }));
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledTimes(2));
    finishSecond(taskFixture({ baselineRef: "feature/task", commitCount: 5, commits: [], message: "第二个选择" }));
    await waitFor(() => expect(document.body.textContent).toContain("5 个提交"));
    finishFirst(taskFixture({ baselineRef: "main~2", commitCount: 1, commits: [] }));
    await tick();
    expect(document.body.textContent, "迟到的第一份结果不能盖掉新选择").toContain("5 个提交");
    expect(document.body.textContent).not.toContain("1 个提交");
  });

  it("把读取状态、文件数与净行数上报给历史顶部那一行", async () => {
    const onSummary = vi.fn();
    render(TaskReview, { props: reviewProps({ onSummary }) });
    expect(onSummary).toHaveBeenCalledWith(expect.objectContaining({ state: "reading", baseline: "main~2" }));
    await screen.findByRole("listbox", { name: "任务文件" });
    expect(onSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "ready", files: 3, additions: 9, deletions: 8, commits: 2, dirty: true, baseline: BASE.slice(0, 7) }),
    );
    // 范围内提交就是历史列表本身：任务详情里不再重复列一遍。
    expect(screen.queryByLabelText("范围内提交")).toBeNull();
  });

  it("隐藏时保活：不卸载文件队列，也不清掉选择", async () => {
    const { rerender } = render(TaskReview, { props: reviewProps() });
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    await rerender(reviewProps({ visible: false }));
    expect(document.querySelector<HTMLElement>(".task-detail")!.style.display).toBe("none");
    expect(list.isConnected).toBe(true);
    await rerender(reviewProps({ visible: true }));
    expect(document.querySelector<HTMLElement>(".task-detail")!.style.display).toBe("");
    expect(mocks.api.taskReview).toHaveBeenCalledTimes(1);
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
    // 每个文件的块标题都提供「转到真实未提交差异」，聚合补丁本身不能做块/行补丁。
    expect(
      within(document.querySelector<HTMLElement>(".multi-stack")!).getAllByRole("button", {
        name: /在未提交差异里按块\/行暂存/,
      }).length,
    ).toBeGreaterThan(0);
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

describe("任务范围的外壳接线", () => {
  it("普通仓库没有任务入口：切换条只有三个视图，⌘4 不切视图，历史里没有任务行", async () => {
    render(App);
    await openRepo();
    expect(activeView()).toBe("changes");
    const nav = document.querySelector('.workbench-view[data-active="true"] nav[aria-label="视图"]')!;
    expect([...nav.querySelectorAll("button")].map((button) => button.getAttribute("data-view"))).toEqual(["changes", "history", "files"]);
    await press("4");
    await tick();
    expect(activeView()).toBe("changes");
    await press("2");
    await waitFor(() => expect(activeView()).toBe("history"));
    await waitFor(() => expect(mocks.api.historyPage).toHaveBeenCalled(), { timeout: 8000 });
    await waitFor(() => expect(document.querySelector('.workbench-view[data-active="true"] .history-row')).toBeTruthy(), { timeout: 8000 });
    expect(screen.queryByRole("button", { name: /任务净差异/ })).toBeNull();
    expect(mocks.api.taskReview).not.toHaveBeenCalled();
    expect(mocks.created.get("stageFiles")?.mock.calls.length ?? 0).toBe(0);
    expect(mocks.created.get("commitChanges")?.mock.calls.length ?? 0).toBe(0);
  });
});
/* ------------------------------------------------------------------ *
 * T3：任务页的连续审阅队列、范围分离与真实写入入口。
 * 组件级用例只验自己的状态与回调；真实 Git 语义仍由 Rust 夹具覆盖。
 * ------------------------------------------------------------------ */
describe("任务审阅的队列与写入边界（T3）", () => {
  it("没有「换起点」入口：起点只来自 cliora 链接", async () => {
    render(TaskReview, { props: reviewProps() });
    await screen.findByRole("listbox", { name: "任务文件" });
    expect(screen.queryByRole("button", { name: "换起点" })).toBeNull();
    expect(screen.getByRole("button", { name: "回到改动视图提交" })).toBeTruthy();
  });

  it("真实暂存范围与任务范围分开显示，空暂存区说清这次提交不含任务文件", async () => {
    const { rerender } = render(TaskReview, { props: reviewProps({ stagedPaths: ["src/app.css", "README.md"] }) });
    const scope = await screen.findByLabelText("本次提交暂存范围");
    expect(scope.textContent).toContain("2 个已暂存文件");
    expect(scope.textContent).toContain("与任务范围分开");
    expect(scope.textContent).toContain("这里的 3 个任务文件不会自动进入提交");
    expect(scope.querySelector('[title]')?.getAttribute("title")).toBe("src/app.css\nREADME.md");
    expect(document.querySelector(".read-only-chip")?.getAttribute("title")).toContain("任务净差异只读");

    await rerender(reviewProps({ stagedPaths: [] }));
    await waitFor(() =>
      expect(screen.getByLabelText("本次提交暂存范围").textContent).toContain("暂存区是空的"),
    );
  });

  it("工作区重建在文件行与单文件差异里说明同一语义", async () => {
    mocks.api.taskReview.mockResolvedValue(
      taskFixture({
        files: [taskFile("src/fresh.ts", "added", { untracked: true, rebuilt: true, additions: 5, deletions: 0 })],
        filesTotal: 1,
        untrackedFiles: 1,
      }),
    );
    render(TaskReview, { props: reviewProps() });
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    expect(within(list).getByText("工作区重建")).toBeTruthy();
    await waitFor(() => expect(document.body.textContent).toContain("当前是工作区重建"));
    expect(document.body.textContent).toContain("行数只统计重建后的文件");
  });

  it("任务文件可整文件暂存，按块/行入口转到真实未提交差异", async () => {
    const onStageFile = vi.fn();
    const onOpenUnstaged = vi.fn();
    render(TaskReview, { props: reviewProps({ onStageFile, onOpenUnstaged }) });
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    await fireEvent.click(within(list).getByRole("button", { name: "暂存 src/app.ts 到索引" }));
    expect(onStageFile).toHaveBeenCalledWith("src/app.ts");

    await fireEvent.click(screen.getByRole("button", { name: "在未提交差异里按块/行暂存 src/app.ts" }));
    expect(onOpenUnstaged).toHaveBeenCalledWith("src/app.ts");
    // 任务页自己不做任何部分补丁：组件内没有按块/按行写入接口。
    for (const name of ["stageFiles", "stageHunks", "stageLines", "commitChanges"]) {
      expect(mocks.created.get(name)?.mock.calls.length ?? 0, name).toBe(0);
    }
  });

  it("已审阅来自传入集合，标记与撤销共用同一个回调", async () => {
    const onToggleReview = vi.fn();
    const reviewed = new Set(["src/app.ts"]);
    render(TaskReview, { props: reviewProps({ reviewed, onToggleReview }) });
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    expect(screen.getByLabelText("已审阅 1 个，共 3 个任务文件")).toBeTruthy();
    await fireEvent.click(within(list).getAllByRole("button", { name: "撤销 src/app.ts 的已审阅标记" })[0]);
    expect(onToggleReview).toHaveBeenCalledWith("src/app.ts");
  });

  it("队列状态与选择交给外壳：下一个未审阅只在未审阅文件里走", async () => {
    const onReviewNav = vi.fn();
    const onSelection = vi.fn();
    render(TaskReview, { props: reviewProps({ reviewed: new Set(["src/app.ts"]), onReviewNav, onSelection }) });
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    await waitFor(() => expect(onReviewNav).toHaveBeenCalled());
    const nav = onReviewNav.mock.calls.at(-1)?.[0];
    expect(nav).toMatchObject({ total: 3, remaining: 2 });
    await waitFor(() => expect(onSelection).toHaveBeenCalledWith("src/app.ts"));

    // 队列按钮在工具条里（列表之外），与命令面板读同一份状态。
    await fireEvent.click(screen.getByRole("button", { name: "下一个未审阅文件" }));
    await waitFor(() => expect(onSelection).toHaveBeenLastCalledWith("docs/gone.md"));
  });
});
/* ------------------------------------------------------------------ *
 * T3：任务队列的键盘写入与隐藏语义。
 * 空格在这里只写真实索引；隐藏已审阅不改任务统计。
 * ------------------------------------------------------------------ */
describe("任务列表的键盘写入与隐藏（T3）", () => {
  it("空格整文件暂存到真实索引，隐藏已审阅不改任务统计", async () => {
    const onStageFile = vi.fn();
    const onHideReviewed = vi.fn();
    render(TaskReview, {
      props: reviewProps({ onStageFile, onHideReviewed, reviewed: new Set(["docs/gone.md"]), hideReviewed: true }),
    });
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    // 隐藏只影响显示：任务文件总数与已审阅数不变。
    expect(screen.getByLabelText("已审阅 1 个，共 3 个任务文件")).toBeTruthy();
    expect(document.querySelector(".file-group .count")?.textContent).toBe("3");

    list.focus();
    await fireEvent.keyDown(list, { key: " " });
    expect(onStageFile).toHaveBeenCalledWith("src/app.ts");
    expect(onStageFile).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "隐藏已审阅" }));
    expect(onHideReviewed).toHaveBeenCalledWith(false);
  });

  it("整文件动作按真实侧别宣布方向：已暂存只说取消暂存，写入中就地禁用", async () => {
    const onStageFile = vi.fn();
    const onUnstageFile = vi.fn();
    // 任务行本身只有净结果，方向必须来自真实 Git 状态：这里三条路径各代表一侧。
    const stageSideFor = (path: string) =>
      path === "docs/gone.md" ? "staged" : path === "src/app.ts" ? "unstaged" : "none";
    const { rerender } = render(TaskReview, { props: reviewProps({ onStageFile, onUnstageFile, stageSideFor }) });
    const list = await screen.findByRole("listbox", { name: "任务文件" });

    // 真实状态只有已暂存一侧：按钮不能再宣称「暂存」。
    expect(within(list).queryByRole("button", { name: "暂存 docs/gone.md 到索引" })).toBeNull();
    await fireEvent.click(within(list).getByRole("button", { name: "取消暂存 docs/gone.md" }));
    expect(onUnstageFile).toHaveBeenCalledWith("docs/gone.md");
    expect(onStageFile).not.toHaveBeenCalled();

    // 真实状态两侧都没有改动（任务净差异来自提交）：按钮禁用并说明原因。
    const none = within(list).getByRole("button", { name: "src/fresh.ts 没有可暂存的真实改动" });
    expect(none.hasAttribute("disabled")).toBe(true);

    // 空格与按钮同一方向：选中已暂存行按空格也是取消暂存。
    const row = [...list.querySelectorAll<HTMLElement>(".file-row")].find(
      (item) => item.getAttribute("title") === "docs/gone.md",
    )!;
    await fireEvent.click(row);
    list.focus();
    await fireEvent.keyDown(list, { key: " " });
    expect(onUnstageFile).toHaveBeenCalledTimes(2);
    expect(onStageFile).not.toHaveBeenCalled();

    // 写入中：整文件按钮禁用，空格也不再写入。
    await rerender(reviewProps({ onStageFile, onUnstageFile, stageSideFor, writeLocked: true }));
    const busy = await waitFor(() => {
      const node = within(list).getByRole("button", { name: "取消暂存 docs/gone.md" });
      expect(node.hasAttribute("disabled")).toBe(true);
      return node;
    });
    expect(busy.getAttribute("title")).toContain("正在读取或写入");
    await fireEvent.keyDown(list, { key: " " });
    expect(onUnstageFile).toHaveBeenCalledTimes(2);
  });

  it("任务行真实侧别为 none 时，空格与双击都就地说明，不静默无反应", async () => {
    const onStageFile = vi.fn();
    const onUnstageFile = vi.fn();
    // 任务净差异全部来自提交：真实索引与工作区里没有可写的一侧。
    const stageSideFor = () => "none" as const;
    render(TaskReview, { props: reviewProps({ onStageFile, onUnstageFile, stageSideFor }) });
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    const row = [...list.querySelectorAll<HTMLElement>(".file-row")][0]!;
    await fireEvent.click(row);
    list.focus();

    await fireEvent.keyDown(list, { key: " " });
    const note = await screen.findByText(/没有未提交或已暂存的改动，空格不能把它写进索引/);
    expect(note.getAttribute("role")).toBe("status");
    expect(onStageFile).not.toHaveBeenCalled();
    expect(onUnstageFile).not.toHaveBeenCalled();

    await fireEvent.dblClick(row);
    expect(screen.getByText(/没有未提交或已暂存的改动，空格不能把它写进索引/)).toBeTruthy();
    expect(onStageFile).not.toHaveBeenCalled();

    // 换成另一行后提示收起，不留在屏幕上冒充当前文件的状态。
    await fireEvent.click([...list.querySelectorAll<HTMLElement>(".file-row")][1]!);
    await waitFor(() => expect(screen.queryByText(/没有未提交或已暂存的改动/)).toBeNull());
  });

  it("搜索时未审阅队列只走可见文件，不跳到被过滤掉的行", async () => {
    const onSelection = vi.fn();
    const onReviewNav = vi.fn();
    render(TaskReview, { props: reviewProps({ onSelection, onReviewNav }) });
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    await waitFor(() => expect(onSelection).toHaveBeenCalledWith("src/app.ts"));

    await fireEvent.input(screen.getByLabelText("搜索任务文件"), { target: { value: "gone" } });
    await waitFor(() => expect(list.querySelectorAll(".file-row")).toHaveLength(1));
    // 队列与列表读同一份过滤后的有序行：总数只剩可见的那一个。
    await waitFor(() => expect(onReviewNav.mock.calls.at(-1)?.[0]).toMatchObject({ total: 1, remaining: 1 }));
    await fireEvent.click(screen.getByRole("button", { name: "下一个未审阅文件" }));
    await waitFor(() => expect(onSelection).toHaveBeenLastCalledWith("docs/gone.md"));
  });
});

/* ------------------------------------------------------------------ *
 * 轻量编辑入口（T2）：任务净差异本身只读，只有「当前工作区一侧」能转去文件视图编辑。
 * 删除文件、未解决冲突与多选聚合都没有编辑入口；组件自己从不写入文件。
 * ------------------------------------------------------------------ */
describe("任务净差异的轻量编辑入口（T2）", () => {
  it("当前工作区里的任务文件可以转去编辑，净差异本身没有保存入口", async () => {
    const onEditFile = vi.fn();
    render(TaskReview, { props: reviewProps({ onEditFile }) });
    await screen.findByRole("listbox", { name: "任务文件" });
    const edit = await screen.findByRole("button", { name: "编辑工作区文件" });
    await fireEvent.click(edit);
    // 带上视口里第一条新侧行号，进入编辑时定位到附近。
    expect(onEditFile).toHaveBeenCalledWith("src/app.ts", 1);
    // 净差异仍标为只读，组件里没有任何保存或写文件的入口。
    expect(screen.getByTitle(/任务净差异只读/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^保存/ })).toBeNull();
    for (const name of ["repositoryEditSave", "repositoryEditSnapshot", "stageFiles", "commitChanges"]) {
      expect(mocks.created.get(name)?.mock.calls.length ?? 0, name).toBe(0);
    }
  });

  it("删除的任务文件没有编辑入口；没有接线时也不显示", async () => {
    const onEditFile = vi.fn();
    const { unmount } = render(TaskReview, { props: reviewProps({ onEditFile }) });
    const list = await screen.findByRole("listbox", { name: "任务文件" });
    await screen.findByRole("button", { name: "编辑工作区文件" });
    const gone = [...list.querySelectorAll<HTMLElement>(".file-row")].find((row) => row.textContent?.includes("gone.md"));
    expect(gone, "删除文件的行").toBeTruthy();
    await fireEvent.click(gone!);
    await waitFor(() =>
      expect(mocks.api.loadTaskDiff).toHaveBeenLastCalledWith(
        WORKTREE, BASE, HEAD, "docs/gone.md", 4, expect.any(Number), null, 0, 0, undefined, false,
      ),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "编辑工作区文件" })).toBeNull());
    expect(onEditFile).not.toHaveBeenCalled();
    unmount();

    render(TaskReview, { props: reviewProps() });
    await screen.findByRole("listbox", { name: "任务文件" });
    await waitFor(() => expect(mocks.api.loadTaskDiff).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "编辑工作区文件" })).toBeNull();
  });
});
