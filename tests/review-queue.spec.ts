/**
 * 审查队列（R3、R4）：筛选段与「可见 m · 共 n」、清除筛选、标记并继续（按可见队列，末尾不循环）、
 * 连续阅读作用于可见队列、MultiFileDiff 批量撤销已审阅，以及纯键盘的连续审阅流程。
 *
 * 组件级用例直接渲染 ReviewWorkbench，审阅记录用 SvelteSet 模拟外壳的响应式集合；
 * App 级用例只用键盘（快捷键与命令面板）完成标记、撤销、筛选、跳转与标记并继续。
 * 夹具全部写在本文件里。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchInfo, DiffLine, DiffResponse, OpenedRepository, StatusSnapshot, TaskFileChange, TaskReview } from "../src/lib/types";

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

const deepLink = vi.hoisted(() => ({
  getCurrent: vi.fn(async (): Promise<string[] | null> => null),
  onOpenUrl: vi.fn(async (_handler: (urls: string[]) => void) => () => {}),
}));

vi.mock("@tauri-apps/plugin-deep-link", () => ({ getCurrent: deepLink.getCurrent, onOpenUrl: deepLink.onOpenUrl }));
vi.mock("../src/lib/api", () => ({
  api: mocks.api,
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));

import App from "../src/App.svelte";
import ReviewWorkbench from "../src/lib/components/review/ReviewWorkbench.svelte";
import type { ReviewQueueControl } from "../src/lib/components/review/ReviewWorkbench.svelte";
import { resetClioraReview } from "../src/lib/cliora-review.svelte";
import { resetReviewComments, type ReviewComment } from "../src/lib/review-comments.svelte";
import { resetReviewProgress } from "../src/lib/review-progress.svelte";
import { resetReviewWorkbench } from "../src/lib/review-workbench.svelte";
import { shortcutCommand } from "../src/lib/shortcuts";
import { commandById, commandAvailable, commandReason, type CommandState } from "../src/lib/commands";
import { filterQueueRows, LAST_UNREVIEWED, nextUnreviewedAfter, reviewLayoutTier } from "../src/lib/ui";

/* ------------------------------ 夹具 ------------------------------ */

const WORKTREE = "C:/work/代码 demo";
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const REVIEW_A = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
const SESSION_A = "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0";
const PATHS = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];

const branch: BranchInfo = {
  name: "main",
  detached: false,
  unborn: false,
  headOid: HEAD,
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  liveRemoteChecked: false,
  remoteCheckedAtMs: 0,
  remoteCheckStale: false,
};

const snapshot: StatusSnapshot = {
  generation: 4,
  branch,
  files: [{ path: "src/a.ts", originalPath: null, staged: "none", unstaged: "modified", untracked: false, unmerged: false }],
};

const opened: OpenedRepository = { summary: { name: "demo", path: WORKTREE }, generation: 4, snapshot, draft: "", watchDegraded: false };

function taskFile(path: string): TaskFileChange {
  return { path, originalPath: null, status: "modified", additions: 1, deletions: 0, binary: false, oldSize: null, newSize: null, untracked: false, unmerged: false };
}

function taskFixture(paths: string[] = PATHS): TaskReview {
  return {
    generation: 4,
    worktree: WORKTREE,
    baselineRef: BASE,
    baselineOid: BASE,
    headOid: HEAD,
    branch,
    commits: [],
    commitCount: 0,
    commitsTruncated: false,
    files: paths.map(taskFile),
    filesTotal: paths.length,
    filesTruncated: false,
    additions: paths.length,
    deletions: 0,
    dirty: true,
    untrackedFiles: 0,
    conflicted: false,
    empty: paths.length === 0,
    rangeVersion: "range-1",
    message: `读取成功：最终净改动 ${paths.length} 个文件。`,
  };
}

function diffFor(path: string): DiffResponse {
  const lines: DiffLine[] = [
    { kind: "context", text: " keep", oldNo: 1, newNo: 1, hunkIndex: 0 },
    { kind: "add", text: "+" + path, oldNo: null, newNo: 2, hunkIndex: 0 },
  ];
  return {
    generation: 4,
    path,
    staged: false,
    binary: false,
    text: null,
    summary: "1 行新增。",
    additions: 1,
    deletions: 0,
    complete: true,
    truncated: false,
    snapshot: "snap",
    hunks: [{ index: 0, header: "@@ -1,1 +1,2 @@", complete: true, stageable: true, startLine: 0, lineCount: 2 }],
    lines,
    offset: 0,
    totalLines: 2,
  };
}

function comment(path: string): ReviewComment {
  return {
    id: `c-${path}`,
    anchor: { path, hunkIndex: 0, kind: "add", oldNo: null, newNo: 2, quote: "+x" },
    body: "改一下",
    createdAt: 1,
    updatedAt: 1,
  };
}

function resetMocks(): void {
  for (const fn of mocks.created.values()) fn.mockReset();
  mocks.listenEvent.mockReset();
  mocks.listenEvent.mockResolvedValue(() => {});
  mocks.pickDirectory.mockResolvedValue(null);
  mocks.pickFile.mockResolvedValue(null);
  deepLink.getCurrent.mockReset();
  deepLink.onOpenUrl.mockReset();
  deepLink.getCurrent.mockResolvedValue(null);
  deepLink.onOpenUrl.mockResolvedValue(() => {});
  const git = { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" };
  mocks.api.getSettings.mockResolvedValue({
    theme: "dark",
    panelWidths: { sidebar: 256, files: 360 },
    git,
    recent: [{ name: "demo", path: WORKTREE, openedAtMs: 1 }],
    settingsWarning: null,
  });
  mocks.api.detectGit.mockResolvedValue(git);
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
  mocks.api.clioraReviewRequest.mockResolvedValue({ reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASE });
  mocks.api.clioraReviewSources.mockResolvedValue(null);
  mocks.api.clioraReviewReceipt.mockResolvedValue(undefined);
  mocks.api.clioraReviewReturn.mockResolvedValue(undefined);
  mocks.api.clioraReviewForget.mockResolvedValue(undefined);
  mocks.api.repositoryDirectory.mockImplementation(async (_repo: string, path: string) => ({ generation: 4, path, entries: [], errors: [] }));
  mocks.api.taskReview.mockResolvedValue(taskFixture());
  mocks.api.loadTaskDiff.mockImplementation(async (_w: string, _b: string, _h: string, path: string) => diffFor(path));
  mocks.api.taskReviewToken.mockImplementation(async (_w: string, baseline: string, _h: string, path: string) => ({
    generation: 4,
    path,
    baselineOid: baseline,
    state: "current",
    token: `tok:${path}`,
    status: "modified",
    untracked: false,
    message: "已确认当前快照。",
  }));
}

beforeEach(() => {
  resetMocks();
  resetClioraReview();
  resetReviewProgress();
  resetReviewComments();
  resetReviewWorkbench();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetClioraReview();
  resetReviewComments();
});

/* --------------------------- 组件级夹具 --------------------------- */

function workbenchProps(overrides: Record<string, unknown> = {}) {
  return {
    opened,
    active: true,
    request: { baseline: BASE, origin: "cliora" as const, nonce: 1 },
    nextId: () => 7,
    fullFile: false,
    onFullFile: vi.fn(),
    onGeneration: vi.fn(),
    reviewed: new SvelteSet<string>(),
    onToggleReview: vi.fn(),
    onHideReviewed: vi.fn(),
    onSelection: vi.fn(),
    onReviewNav: vi.fn(),
    workbenchId: REVIEW_A,
    ...overrides,
  };
}

/** 有状态的审阅记录：标记与撤销都改同一个响应式集合，像外壳一样。 */
function reviewState(initial: string[] = []) {
  const reviewed = new SvelteSet<string>(initial);
  const onToggleReview = vi.fn((path: string) => {
    if (reviewed.has(path)) reviewed.delete(path);
    else reviewed.add(path);
  });
  const onMarkReviewed = vi.fn(async (path: string) => {
    reviewed.add(path);
    return true;
  });
  return { reviewed, onToggleReview, onMarkReviewed };
}

function queueList(): HTMLElement {
  return screen.getByRole("listbox", { name: "任务文件" });
}

function visiblePaths(): string[] {
  return [...queueList().querySelectorAll<HTMLElement>(".file-row")].map((row) => row.getAttribute("title") ?? "");
}

function selectedPath(): string | null {
  return queueList().querySelector<HTMLElement>('[aria-selected="true"]')?.getAttribute("title") ?? null;
}

function filterButton(name: "全部" | "未审阅" | "有意见"): HTMLButtonElement {
  return within(screen.getByRole("group", { name: "队列筛选" })).getByRole("button", { name: new RegExp(`^${name}`) });
}

function countText(): string {
  return document.querySelector(".review-queue-count [role=\"status\"]")?.textContent?.trim() ?? "";
}

/* ------------------------------ 纯函数 ------------------------------ */

describe("队列纯函数", () => {
  const rows = PATHS.map((path) => ({ path, side: "unstaged" as const }));

  it("筛选只读审阅记录与意见路径，不改输入", () => {
    const reviewed = new Set(["src/b.ts"]);
    const commented = new Set(["src/c.ts"]);
    expect(filterQueueRows(rows, "all", reviewed, commented).map((row) => row.path)).toEqual(PATHS);
    expect(filterQueueRows(rows, "unreviewed", reviewed, commented).map((row) => row.path)).toEqual(["src/a.ts", "src/c.ts", "src/d.ts"]);
    expect(filterQueueRows(rows, "commented", reviewed, commented).map((row) => row.path)).toEqual(["src/c.ts"]);
    expect(rows).toHaveLength(4);
  });

  it("标记并继续的下一站只往后找未审阅文件，到末尾返回 null 而不是回到开头", () => {
    const reviewed = new Set(["src/b.ts"]);
    expect(nextUnreviewedAfter(rows, "src/a.ts", reviewed)?.path).toBe("src/c.ts");
    expect(nextUnreviewedAfter(rows, "src/d.ts", reviewed)).toBeNull();
    // 当前文件不在可见队列里时从队首找。
    expect(nextUnreviewedAfter(rows, "src/zzz.ts", reviewed)?.path).toBe("src/a.ts");
    expect(nextUnreviewedAfter(rows, "src/c.ts", new Set(["src/d.ts"]))).toBeNull();
    expect(LAST_UNREVIEWED).toBe("已是最后一个未审阅文件");
  });

  it("工作台宽度分三档：≥1100、720–1100、<720", () => {
    expect(reviewLayoutTier(1280)).toBe("wide");
    expect(reviewLayoutTier(1100)).toBe("wide");
    expect(reviewLayoutTier(1099)).toBe("medium");
    expect(reviewLayoutTier(720)).toBe("medium");
    expect(reviewLayoutTier(719)).toBe("narrow");
    // 尚未测量时按宽档，不在首帧把队列收起来。
    expect(reviewLayoutTier(0)).toBe("wide");
  });

  it("Alt+Shift+M 是标记并继续，不占用既有键位", () => {
    expect(shortcutCommand({ key: "M", code: "KeyM", altKey: true, shiftKey: true })).toBe("review.markNext");
    // macOS ⌥⇧M 产生组合字符，按物理键兜底。
    expect(shortcutCommand({ key: "Â", code: "KeyM", altKey: true, shiftKey: true })).toBe("review.markNext");
    expect(shortcutCommand({ key: "m", code: "KeyM", altKey: true })).toBe("review.toggle");
    expect(shortcutCommand({ key: "ArrowRight", altKey: true, shiftKey: true })).toBe("review.next");
    expect(shortcutCommand({ key: "ArrowLeft", altKey: true, shiftKey: true })).toBe("review.prev");
  });

  it("命令可用性：没有审查队列时说明原因；筛选命令在当前筛选上不可用", () => {
    const base = { hasRepo: true } as CommandState;
    const markNext = commandById("review.markNext")!;
    expect(commandAvailable(markNext, base)).toBe(false);
    expect(commandReason(markNext, base)).toBe("只在审查工作台里可用");
    const review = { prevReason: null, nextReason: null, toggleReason: null, reviewed: false, hideReason: null, hidden: false, remaining: 2, total: 3, scope: "task" as const };
    expect(commandAvailable(markNext, { ...base, review: { ...review, markNextReason: null, filter: "all" } })).toBe(true);
    expect(commandReason(markNext, { ...base, review: { ...review, markNextReason: "先选择一个文件", filter: "all" } })).toBe("先选择一个文件");
    const unreviewed = commandById("review.filter.unreviewed")!;
    expect(commandAvailable(unreviewed, { ...base, review: { ...review, markNextReason: null, filter: "all" } })).toBe(true);
    expect(commandReason(unreviewed, { ...base, review: { ...review, markNextReason: null, filter: "unreviewed" } })).toBe("已经是当前筛选");
  });
});

/* --------------------------- 组件：筛选与计数 --------------------------- */

describe("筛选段与计数（R3）", () => {
  it("筛选不改进度总数与审阅记录；计数区分可见与总计，清除筛选恢复完整队列", async () => {
    const state = reviewState(["src/b.ts"]);
    const onToggleReview = state.onToggleReview;
    const comments = [comment("src/c.ts")];
    render(ReviewWorkbench, { props: workbenchProps({ ...state, comments }) });
    await waitFor(() => expect(visiblePaths()).toEqual(PATHS));
    expect(countText()).toBe("可见 4 · 共 4");
    expect(screen.getByLabelText("已审阅 1 个，共 4 个任务文件")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /清除筛选/ })).toBeNull();

    await fireEvent.click(filterButton("未审阅"));
    await waitFor(() => expect(visiblePaths()).toEqual(["src/a.ts", "src/c.ts", "src/d.ts"]));
    expect(filterButton("未审阅").getAttribute("aria-pressed")).toBe("true");
    expect(countText()).toBe("可见 3 · 共 4");
    // 进度仍按任务真实总数，审阅记录没有被写。
    expect(screen.getByLabelText("已审阅 1 个，共 4 个任务文件")).toBeTruthy();
    expect([...state.reviewed]).toEqual(["src/b.ts"]);
    expect(onToggleReview).not.toHaveBeenCalled();

    await fireEvent.click(filterButton("有意见"));
    await waitFor(() => expect(visiblePaths()).toEqual(["src/c.ts"]));
    expect(countText()).toBe("可见 1 · 共 4");

    // 搜索与筛选叠加：可见数如实减少，总数不变。
    await fireEvent.input(screen.getByLabelText("搜索任务文件"), { target: { value: "zzz" } });
    await waitFor(() => expect(countText()).toBe("可见 0 · 共 4"));

    await fireEvent.click(within(document.querySelector<HTMLElement>(".review-queue-bar")!).getByRole("button", { name: /清除筛选/ }));
    await waitFor(() => expect(visiblePaths()).toEqual(PATHS));
    expect(countText()).toBe("可见 4 · 共 4");
    expect(filterButton("全部").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("搜索任务文件") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("已审阅 1 个，共 4 个任务文件")).toBeTruthy();
  });

  it("筛选没有命中时说明并给出清除筛选，不冒充空任务或工作区干净", async () => {
    render(ReviewWorkbench, { props: workbenchProps({ ...reviewState() }) });
    await waitFor(() => expect(visiblePaths()).toEqual(PATHS));
    await fireEvent.click(filterButton("有意见"));
    const empty = await within(queueList()).findByText("「有意见」筛选下没有文件");
    expect(queueList().textContent).not.toContain("工作区很干净");
    expect(document.body.textContent).not.toContain("这个任务没有净改动");
    await fireEvent.click(within(empty.closest(".empty") as HTMLElement).getByRole("button", { name: "清除筛选" }));
    await waitFor(() => expect(visiblePaths()).toEqual(PATHS));
  });

  it("隐藏已审阅也算筛选：清除筛选同时请外壳取消隐藏", async () => {
    const onHideReviewed = vi.fn();
    render(ReviewWorkbench, { props: workbenchProps({ ...reviewState(["src/a.ts"]), hideReviewed: true, onHideReviewed }) });
    await waitFor(() => expect(visiblePaths()).toEqual(["src/b.ts", "src/c.ts", "src/d.ts"]));
    expect(countText()).toBe("可见 3 · 共 4");
    await fireEvent.click(within(document.querySelector<HTMLElement>(".review-queue-bar")!).getByRole("button", { name: /清除筛选/ }));
    expect(onHideReviewed).toHaveBeenCalledWith(false);
  });

  it("筛选按来源保存：切走再切回恢复筛选", async () => {
    const props = workbenchProps({ ...reviewState() });
    const { rerender } = render(ReviewWorkbench, { props });
    await waitFor(() => expect(visiblePaths()).toEqual(PATHS));
    await fireEvent.click(filterButton("未审阅"));
    await rerender({ ...props, workbenchId: "other-review" });
    await waitFor(() => expect(filterButton("全部").getAttribute("aria-pressed")).toBe("true"));
    await rerender({ ...props, workbenchId: REVIEW_A });
    await waitFor(() => expect(filterButton("未审阅").getAttribute("aria-pressed")).toBe("true"));
  });
});

/* --------------------------- 组件：标记并继续 --------------------------- */

describe("标记并继续（R4）", () => {
  it("标记当前文件后前往可见队列里的下一个未审阅文件，跳过已审阅的", async () => {
    const state = reviewState(["src/b.ts"]);
    render(ReviewWorkbench, { props: workbenchProps({ ...state }) });
    await waitFor(() => expect(selectedPath()).toBe("src/a.ts"));
    const button = screen.getByRole("button", { name: "标记并继续" });
    expect(button.getAttribute("title")).toContain("Alt+Shift+M");
    await fireEvent.click(button);
    await waitFor(() => expect(selectedPath()).toBe("src/c.ts"));
    expect(state.onMarkReviewed).toHaveBeenCalledWith("src/a.ts");
    expect(state.reviewed.has("src/a.ts")).toBe(true);
  });

  it("末尾明确说明「已是最后一个未审阅文件」并停在当前文件，不回到开头", async () => {
    const state = reviewState();
    render(ReviewWorkbench, { props: workbenchProps({ ...state }) });
    await waitFor(() => expect(selectedPath()).toBe("src/a.ts"));
    await fireEvent.click(within(queueList()).getAllByRole("option")[3]);
    await waitFor(() => expect(selectedPath()).toBe("src/d.ts"));
    await fireEvent.click(screen.getByRole("button", { name: "标记并继续" }));
    await waitFor(() => expect(screen.getByText(LAST_UNREVIEWED)).toBeTruthy());
    expect(screen.getByText(LAST_UNREVIEWED).closest("[role=status]")).toBeTruthy();
    expect(selectedPath()).toBe("src/d.ts");
    expect(state.reviewed.has("src/d.ts")).toBe(true);
    // src/a.ts 仍未审阅，但它在当前文件之前：不循环回去。
    expect(state.reviewed.has("src/a.ts")).toBe(false);

    // 换文件后提示收起，不留着描述旧位置。
    await fireEvent.click(within(queueList()).getAllByRole("option")[0]);
    await waitFor(() => expect(screen.queryByText(LAST_UNREVIEWED)).toBeNull());
  });

  it("「未审阅」筛选下按标记前的可见顺序前进；标记失败时停在原文件", async () => {
    const state = reviewState();
    render(ReviewWorkbench, { props: workbenchProps({ ...state }) });
    await waitFor(() => expect(selectedPath()).toBe("src/a.ts"));
    await fireEvent.click(filterButton("未审阅"));
    await fireEvent.click(screen.getByRole("button", { name: "标记并继续" }));
    await waitFor(() => expect(selectedPath()).toBe("src/b.ts"));
    // 已标记的 a 离开「未审阅」队列，进度总数不变。
    expect(visiblePaths()).toEqual(["src/b.ts", "src/c.ts", "src/d.ts"]);
    expect(countText()).toBe("可见 3 · 共 4");

    state.onMarkReviewed.mockImplementationOnce(async () => false);
    await fireEvent.click(screen.getByRole("button", { name: "标记并继续" }));
    await tick();
    await tick();
    expect(selectedPath()).toBe("src/b.ts");
    expect(screen.queryByText(LAST_UNREVIEWED)).toBeNull();
  });

  it("控制面交给外壳：可见/总计、筛选与不可用原因同源", async () => {
    const onQueue = vi.fn();
    const state = reviewState(["src/c.ts"]);
    render(ReviewWorkbench, { props: workbenchProps({ ...state, onQueue }) });
    await waitFor(() => expect(selectedPath()).toBe("src/a.ts"));
    await waitFor(() => expect(onQueue.mock.calls.at(-1)?.[0]).toMatchObject({ filter: "all", visible: 4, total: 4, reviewed: 1, markNextReason: null }));
    const control = onQueue.mock.calls.at(-1)?.[0] as ReviewQueueControl;
    control.setFilter("unreviewed");
    await waitFor(() => expect(onQueue.mock.calls.at(-1)?.[0]).toMatchObject({ filter: "unreviewed", visible: 3, total: 4, reviewed: 1 }));
    (onQueue.mock.calls.at(-1)?.[0] as ReviewQueueControl).markNext();
    await waitFor(() => expect(selectedPath()).toBe("src/b.ts"));
    await waitFor(() => expect(onQueue.mock.calls.at(-1)?.[0]).toMatchObject({ visible: 2, total: 4, reviewed: 2 }));
  });
});

/* ----------------------- 组件：连续阅读与批量撤销 ----------------------- */

describe("连续阅读与批量撤销（R3、R4）", () => {
  it("连续阅读作用于当前可见队列，不要求多选；筛选后堆叠随之变化", async () => {
    const state = reviewState(["src/b.ts"]);
    render(ReviewWorkbench, { props: workbenchProps({ ...state }) });
    await waitFor(() => expect(selectedPath()).toBe("src/a.ts"));
    await fireEvent.click(screen.getByRole("button", { name: "连续" }));
    await waitFor(() => expect(document.querySelector(".multi-stack")).toBeTruthy());
    expect(document.querySelector(".multi-stack-count")?.textContent).toBe("连续阅读 · 可见 4 个文件");
    await fireEvent.click(filterButton("未审阅"));
    await waitFor(() => expect(document.querySelector(".multi-stack-count")?.textContent).toBe("连续阅读 · 可见 3 个文件"));
    // 不是多选：列表里没有多选成员，退出按钮回到单文件。
    expect(queueList().querySelector("[data-member]")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "回到单文件" }));
    await waitFor(() => expect(document.querySelector(".multi-stack")).toBeNull());
    expect(selectedPath()).toBe("src/a.ts");
  });

  it("MultiFileDiff 批量撤销已审阅：只撤这批里已审阅的文件", async () => {
    const state = reviewState(["src/b.ts", "src/d.ts"]);
    render(ReviewWorkbench, { props: workbenchProps({ ...state }) });
    await waitFor(() => expect(selectedPath()).toBe("src/a.ts"));
    await fireEvent.click(screen.getByRole("button", { name: "连续" }));
    const undo = await screen.findByRole("button", { name: "撤销 2 个文件的已审阅" });
    expect(screen.getByRole("button", { name: "标记 2 个文件为已审阅" })).toBeTruthy();
    await fireEvent.click(undo);
    expect(state.onToggleReview.mock.calls.map((call) => call[0]).sort()).toEqual(["src/b.ts", "src/d.ts"]);
    await waitFor(() => expect(state.reviewed.size).toBe(0));
    const disabled = await screen.findByRole("button", { name: "撤销 0 个文件的已审阅" });
    expect(disabled.hasAttribute("disabled")).toBe(true);
    expect(disabled.getAttribute("title")).toBe("这批文件还没有已审阅标记");
  });

  it("写入进行中时批量撤销与标记一起禁用", async () => {
    render(ReviewWorkbench, { props: workbenchProps({ ...reviewState(["src/a.ts"]), writeLocked: true }) });
    await waitFor(() => expect(selectedPath()).toBe("src/a.ts"));
    await fireEvent.click(screen.getByRole("button", { name: "连续" }));
    const undo = await screen.findByRole("button", { name: "撤销 1 个文件的已审阅" });
    expect(undo.hasAttribute("disabled")).toBe(true);
  });
});

/* --------------------------- App：纯键盘流程 --------------------------- */

function reviewUrl(): string {
  return `twiglane://review?v=2&reviewId=${REVIEW_A}&sessionId=${SESSION_A}&worktreePath=${encodeURIComponent(WORKTREE)}&baseline=${BASE}`;
}

function activeWorkbench(): HTMLElement {
  return document.querySelector<HTMLElement>('.workbench-view[data-view-scope="review"] .review-workbench')!;
}

function appSelected(): string | null {
  return activeWorkbench().querySelector<HTMLElement>('[role="listbox"][aria-label="任务文件"] [aria-selected="true"]')?.getAttribute("title") ?? null;
}

async function key(init: KeyboardEventInit): Promise<void> {
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  await tick();
}

/** 命令面板全键盘：⌘/Ctrl+K 打开，输入标题，回车执行。 */
async function paletteRun(title: string): Promise<void> {
  await key({ key: "k", ctrlKey: true });
  const palette = await screen.findByRole("dialog", { name: "命令面板" });
  const input = within(palette).getByRole("combobox");
  await fireEvent.input(input, { target: { value: title } });
  await fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "命令面板" })).toBeNull());
}

describe("纯键盘连续审阅（R4）", () => {
  it("只用键盘完成标记、撤销、跳转、筛选未审阅与标记并继续，末尾不循环", async () => {
    deepLink.getCurrent.mockResolvedValue([reviewUrl()]);
    render(App);
    await waitFor(() => expect(appSelected()).toBe("src/a.ts"), { timeout: 8000 });
    const progress = (reviewed: number) => within(activeWorkbench()).getByLabelText(`已审阅 ${reviewed} 个，共 4 个任务文件`);

    // 下一个/上一个未审阅：Alt+Shift+→/←。
    await key({ key: "ArrowRight", altKey: true, shiftKey: true });
    await waitFor(() => expect(appSelected()).toBe("src/b.ts"));
    await key({ key: "ArrowLeft", altKey: true, shiftKey: true });
    await waitFor(() => expect(appSelected()).toBe("src/a.ts"));

    // 标记与撤销：Alt+M。
    await key({ key: "m", code: "KeyM", altKey: true });
    await waitFor(() => expect(progress(1)).toBeTruthy());
    await key({ key: "m", code: "KeyM", altKey: true });
    await waitFor(() => expect(progress(0)).toBeTruthy());

    // 标记并继续：Alt+Shift+M。
    await key({ key: "M", code: "KeyM", altKey: true, shiftKey: true });
    await waitFor(() => expect(appSelected()).toBe("src/b.ts"));
    expect(progress(1)).toBeTruthy();
    expect(mocks.api.taskReviewToken).toHaveBeenCalledWith(WORKTREE, BASE, HEAD, "src/a.ts", expect.any(Number), expect.any(Number));

    // 筛选未审阅（命令面板）：可见与总计分开，进度不变。
    await paletteRun("只看未审阅");
    await waitFor(() => expect(within(activeWorkbench()).getByRole("button", { name: /^未审阅/ }).getAttribute("aria-pressed")).toBe("true"));
    expect(activeWorkbench().querySelector(".review-queue-count [role=status]")?.textContent?.trim()).toBe("可见 3 · 共 4");
    expect(progress(1)).toBeTruthy();

    await key({ key: "M", code: "KeyM", altKey: true, shiftKey: true });
    await waitFor(() => expect(appSelected()).toBe("src/c.ts"));
    await key({ key: "M", code: "KeyM", altKey: true, shiftKey: true });
    await waitFor(() => expect(appSelected()).toBe("src/d.ts"));

    // 回到完整队列，再到末尾：说明「已是最后一个未审阅文件」并停在 d，不回到开头。
    await paletteRun("显示全部");
    await waitFor(() => expect(within(activeWorkbench()).getByRole("button", { name: /^全部/ }).getAttribute("aria-pressed")).toBe("true"));
    await key({ key: "M", code: "KeyM", altKey: true, shiftKey: true });
    await waitFor(() => expect(within(activeWorkbench()).getByText(LAST_UNREVIEWED)).toBeTruthy());
    expect(appSelected()).toBe("src/d.ts");
    expect(progress(4)).toBeTruthy();

    // 撤销最后一个，再用 Alt+Shift+→ 回到下一个未审阅。
    await key({ key: "m", code: "KeyM", altKey: true });
    await waitFor(() => expect(progress(3)).toBeTruthy());
    await key({ key: "ArrowLeft", altKey: true });
    await waitFor(() => expect(appSelected()).toBe("src/c.ts"));
    await key({ key: "ArrowRight", altKey: true, shiftKey: true });
    await waitFor(() => expect(appSelected()).toBe("src/d.ts"));

    // 全程没有 Git 写入。
    expect(mocks.api.stageFiles).not.toHaveBeenCalled();
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
  });
});
