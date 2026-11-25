/**
 * 顶级「审查」视图（R1、R2）：深链直接进入工作台、视图切换保留阅读状态、各整页状态的原因与动作。
 *
 * 外壳与 api 都用模块 mock；协议解析与来源校验在 Rust 侧与 cliora-integration.spec 覆盖，
 * 这里只盯工作台的信息架构与失败边界：不借历史入口、不用 HEAD 补缺、不伪造空任务。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLine, DiffResponse, FileChange, StatusSnapshot } from "../src/lib/types";
import { clioraReview, resetClioraReview } from "../src/lib/cliora-review.svelte";
import { resetReviewProgress } from "../src/lib/review-progress.svelte";
import { resetReviewComments } from "../src/lib/review-comments.svelte";
import { resetReviewWorkbench } from "../src/lib/review-workbench.svelte";

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
import { tick } from "svelte";

/* ------------------------- 外壳夹具（本 spec 自包含） ------------------------- */

const WORKTREE = "C:/work/代码 demo";
const REVIEW_A = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
const REVIEW_B = "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
const SESSION_A = "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0";
const SESSION_B = "2c3d4e5f-6071-4283-94a5-b6c7d8e9f0a1";
const BASELINE = "a".repeat(40);
const BASELINE_B = "d".repeat(40);

/** v2 审查链接；baseline 省略时就是「没有起点」的链接。 */
function reviewUrl(reviewId: string, sessionId: string, baseline: string | null): string {
  return (
    "twiglane://review?v=2&reviewId=" + reviewId + "&sessionId=" + sessionId + "&worktreePath=" + encodeURIComponent(WORKTREE) +
    (baseline ? "&baseline=" + baseline : "")
  );
}

const branch = {
  name: "main",
  detached: false,
  unborn: false,
  headOid: BASELINE,
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  liveRemoteChecked: false,
  remoteCheckedAtMs: 0,
  remoteCheckStale: false,
};

const changes: FileChange[] = [
  { path: "src/a.ts", originalPath: null, staged: "none", unstaged: "modified", untracked: false, unmerged: false },
];

const snapshot: StatusSnapshot = { generation: 4, branch, files: changes };

function openedAt(path: string) {
  return { summary: { name: path.split("/").pop() ?? path, path }, generation: 4, snapshot, draft: "", watchDegraded: false };
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

/** 任务范围夹具：链接自带的起点就是 baseline。 */
function taskFor(baseline: string, paths: string[] = ["src/a.ts", "src/b.ts", "src/c.ts"]) {
  return {
    generation: 4,
    worktree: WORKTREE,
    baselineRef: baseline,
    baselineOid: baseline,
    headOid: BASELINE,
    branch,
    commits: [],
    commitCount: 0,
    commitsTruncated: false,
    files: paths.map((path) => ({
      path,
      originalPath: null,
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      oldSize: null,
      newSize: null,
      untracked: false,
      unmerged: false,
    })),
    filesTotal: paths.length,
    filesTruncated: false,
    additions: paths.length,
    deletions: 0,
    dirty: true,
    untrackedFiles: 0,
    conflicted: false,
    empty: paths.length === 0,
    rangeVersion: `range-${baseline}`,
    message: paths.length === 0 ? "这个任务在起点之后没有净改动。" : `读取成功：最终净改动 ${paths.length} 个文件。`,
  };
}

type MockFn = ReturnType<typeof vi.fn>;

interface ShellMocks {
  api: Record<string, MockFn>;
  created: Map<string, MockFn>;
  listenEvent: MockFn;
  pickDirectory: MockFn;
  pickFile: MockFn;
}

interface DeepLinkMocks {
  getCurrent: MockFn;
  onOpenUrl: MockFn;
}

/** 与 cliora-integration.spec 相同的外壳默认值：一个最近仓库、Git 可用、读取都成功。 */
function resetShellMocks(mocks: ShellMocks, deepLink: DeepLinkMocks): void {
  for (const fn of mocks.created.values()) fn.mockReset();
  mocks.listenEvent.mockReset();
  mocks.pickDirectory.mockReset();
  mocks.pickFile.mockReset();
  deepLink.getCurrent.mockReset();
  deepLink.onOpenUrl.mockReset();
  deepLink.getCurrent.mockResolvedValue(null);
  deepLink.onOpenUrl.mockResolvedValue(() => {});

  mocks.listenEvent.mockResolvedValue(() => {});
  mocks.pickDirectory.mockResolvedValue(null);
  mocks.pickFile.mockResolvedValue(null);
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
  mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE));
  mocks.api.refreshStatus.mockResolvedValue(snapshot);
  mocks.api.loadDiff.mockImplementation(async (_path: string, relative: string) => diffFor(relative));
  mocks.api.mergeSession.mockResolvedValue({
    generation: 4,
    operation: "none",
    canContinue: false,
    canAbort: false,
    source: null,
    target: "main",
    headOid: BASELINE,
    conflicts: [],
    unresolved: 0,
    note: "当前没有进行中的合并。",
    snapshot,
  });
  mocks.api.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
  mocks.api.repoHeads.mockResolvedValue([]);
  mocks.api.clioraReviewRequest.mockResolvedValue({ reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE });
  mocks.api.clioraReviewSources.mockResolvedValue(null);
  mocks.api.clioraReviewReceipt.mockResolvedValue(undefined);
  mocks.api.clioraReviewReturn.mockResolvedValue(undefined);
  mocks.api.clioraReviewForget.mockResolvedValue(undefined);
  mocks.api.taskReview.mockImplementation(async (_worktree: string, baseline: string) => taskFor(baseline));
  // 文件视图被切到时读取目录：给一个空仓库树。
  mocks.api.repositoryDirectory.mockImplementation(async (_repo: string, path: string) => ({ generation: 4, path, entries: [], errors: [] }));
  mocks.api.loadTaskDiff.mockImplementation(async (_worktree: string, _base: string, _head: string, path: string) => diffFor(path));
}

/* ------------------------------ DOM 查询 ------------------------------ */

function activeViewId(): string | null {
  return document.querySelector<HTMLElement>('.workbench-view[data-active="true"] [aria-current="page"]')?.getAttribute("data-view") ?? null;
}

function switcherItem(view: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.workbench-view[data-active="true"] nav[aria-label="视图"] [data-view="${view}"]`);
}

async function switchView(view: "changes" | "history" | "files" | "review"): Promise<void> {
  const item = await waitFor(() => {
    const found = switcherItem(view);
    if (!found) throw new Error(`切换条上没有 ${view}`);
    return found;
  });
  await fireEvent.click(item);
  await waitFor(() => expect(activeViewId()).toBe(view));
}

function workbench(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.workbench-view[data-view-scope="review"] .review-workbench');
}

function completionAction(id: "feedback" | "return"): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`.workbench-view[data-active="true"] .review-completion [data-completion-action="${id}"]`);
}

/** 任务文件队列里选中的路径。 */
function selectedTaskPath(): string | null {
  const list = workbench()?.querySelector<HTMLElement>('[role="listbox"][aria-label="任务文件"]');
  return list?.querySelector<HTMLElement>('[aria-selected="true"]')?.getAttribute("title") ?? null;
}

function taskRow(path: string): HTMLElement {
  const row = [...(workbench()?.querySelectorAll<HTMLElement>(".file-row") ?? [])].find((item) => item.getAttribute("title") === path);
  if (!row) throw new Error(`任务队列里没有 ${path}`);
  return row;
}

async function openSourceMenu(): Promise<HTMLElement> {
  if (activeViewId() !== "review") await switchView("review");
  await fireEvent.click(await screen.findByRole("button", { name: "选择 Cliora 审查来源" }));
  return screen.findByRole("dialog", { name: "审查来源" });
}

beforeEach(() => {
  resetShellMocks(mocks, deepLink);
  resetClioraReview();
  resetReviewProgress();
  resetReviewComments();
  resetReviewWorkbench();
});

afterEach(() => {
  cleanup();
  resetClioraReview();
  resetReviewComments();
});

/** 冷启动带一条审查链接，等到审查工作台成为当前视图。 */
async function coldStart(url: string) {
  deepLink.getCurrent.mockResolvedValue([url]);
  render(App);
  await waitFor(() => expect(activeViewId()).toBe("review"), { timeout: 8000 });
}

/** 运行中再收到一条链接。 */
function hotLink(url: string) {
  const handler = deepLink.onOpenUrl.mock.calls[0][0] as (urls: string[]) => void;
  handler([url]);
}

describe("审查工作台入口（R1）", () => {
  it("有效深链直接进入审查视图并显示首个文件的差异；历史里不再有任务净差异行", async () => {
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, BASELINE));
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledWith(WORKTREE, BASELINE, expect.any(Number), expect.any(Number)));
    // 首个可审内容：队列选中第一个文件，差异区已渲染它的行。
    await waitFor(() => expect(selectedTaskPath()).toBe("src/a.ts"));
    await waitFor(() => expect(workbench()!.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
    expect(mocks.api.loadTaskDiff.mock.calls.some((call) => call[0] === WORKTREE && call[1] === BASELINE && call[3] === "src/a.ts")).toBe(true);

    // 顶级导航区分改动 / 历史 / 文件 / 审查，当前位置可辨认。
    const nav = switcherItem("review")!.closest("nav")!;
    expect([...nav.querySelectorAll("button")].map((button) => button.dataset.view)).toEqual(["changes", "history", "files", "review"]);
    expect(switcherItem("review")!.getAttribute("aria-current")).toBe("page");

    await switchView("history");
    expect(screen.queryByRole("button", { name: /任务净差异/ })).toBeNull();
    // 链接只打开工作树：没有 Git 写入。
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
    expect(mocks.api.stageFiles).not.toHaveBeenCalled();
  });

  it("普通独立仓库没有审查入口", async () => {
    render(App);
    await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
    await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
    await waitFor(() => expect(switcherItem("changes")).toBeTruthy());
    expect(switcherItem("review")).toBeNull();
    expect(document.querySelector('.workbench-view[data-view-scope="review"]')).toBeNull();
  });

  it("切到其他视图再回来：来源、选中文件与阅读模式都保留", async () => {
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, BASELINE));
    await waitFor(() => expect(selectedTaskPath()).toBe("src/a.ts"));
    await fireEvent.click(taskRow("src/b.ts"));
    await waitFor(() => expect(selectedTaskPath()).toBe("src/b.ts"));
    const continuous = within(workbench()!).getByRole("button", { name: "连续" });
    await fireEvent.click(continuous);
    await waitFor(() => expect(continuous.getAttribute("aria-pressed")).toBe("true"));

    await switchView("history");
    await switchView("files");
    await switchView("changes");
    await switchView("review");

    expect(clioraReview.source?.reviewId).toBe(REVIEW_A);
    await waitFor(() => expect(selectedTaskPath()).toBe("src/b.ts"));
    expect(within(workbench()!).getByRole("button", { name: "连续" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("在两个来源之间切换时各自恢复选中文件", async () => {
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, BASELINE));
    await waitFor(() => expect(selectedTaskPath()).toBe("src/a.ts"));
    await fireEvent.click(taskRow("src/c.ts"));
    await waitFor(() => expect(selectedTaskPath()).toBe("src/c.ts"));

    mocks.api.clioraReviewRequest.mockResolvedValue({ reviewId: REVIEW_B, sessionId: SESSION_B, worktreePath: WORKTREE, baseline: BASELINE_B });
    hotLink(reviewUrl(REVIEW_B, SESSION_B, BASELINE_B));
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_B), { timeout: 8000 });
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledWith(WORKTREE, BASELINE_B, expect.any(Number), expect.any(Number)));
    await waitFor(() => expect(selectedTaskPath()).toBe("src/a.ts"));

    const menu = await openSourceMenu();
    await fireEvent.click(menu.querySelector<HTMLButtonElement>(`[data-review-source-id="${REVIEW_A}"] .review-source-switch`)!);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_A));
    await waitFor(() => expect(selectedTaskPath()).toBe("src/c.ts"));
  });
});

describe("整页状态：原因与可执行动作（R1）", () => {
  it("没有起点：进入工作台说明原因，不读任务范围、不用 HEAD 补缺；可查看普通历史或返回 Cliora", async () => {
    // 原生解析结果里就没有起点（链接没带 baseline）。
    mocks.api.clioraReviewRequest.mockResolvedValue({ reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: null });
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, null));
    const panel = await within(workbench()!).findByText("没有任务范围");
    const state = panel.closest<HTMLElement>(".review-state")!;
    expect(state.textContent).toContain("不会用 HEAD 或默认分支补缺");
    expect(mocks.api.taskReview).not.toHaveBeenCalled();
    // 返回入口仍在完成栏：无起点不等于无法返回。
    expect(completionAction("return")).toBeTruthy();

    await fireEvent.click(within(state).getByRole("button", { name: "返回 Cliora" }));
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(REVIEW_A, SESSION_A, "reviewed", null));

    await fireEvent.click(within(state).getByRole("button", { name: "查看普通历史" }));
    await waitFor(() => expect(activeViewId()).toBe("history"));
    expect(mocks.api.taskReview).not.toHaveBeenCalled();
  });

  it("读取失败：说明失败并可重新读取，不出现空任务", async () => {
    mocks.api.taskReview.mockRejectedValueOnce({ code: "git_failed", message: "git rev-list 失败：磁盘不可读。" });
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, BASELINE));
    const title = await within(workbench()!).findByText("读取任务范围失败", {}, { timeout: 8000 });
    const state = title.closest<HTMLElement>(".review-state")!;
    expect(state.textContent).toContain("磁盘不可读");
    expect(within(workbench()!).queryByText("这个任务没有净改动")).toBeNull();
    await fireEvent.click(within(state).getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(selectedTaskPath()).toBe("src/a.ts"));
    expect(mocks.api.taskReview).toHaveBeenCalledTimes(2);
  });

  it("任务范围失效：说明失效并给出重新读取与返回 Cliora", async () => {
    mocks.api.taskReview.mockRejectedValue({ code: "task_baseline_missing", message: "起点提交已不在仓库里。" });
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, BASELINE));
    const title = await within(workbench()!).findByText("任务范围已失效", {}, { timeout: 8000 });
    const state = title.closest<HTMLElement>(".review-state")!;
    expect(within(state).getByRole("button", { name: "重新读取" })).toBeTruthy();
    expect(within(state).getByRole("button", { name: "返回 Cliora" })).toBeTruthy();
    // 不回退到 HEAD 或主检出读取别的范围。
    for (const call of mocks.api.taskReview.mock.calls) expect(call[1]).toBe(BASELINE);
    expect(mocks.api.openRepository.mock.calls.every((call) => call[0] === WORKTREE)).toBe(true);
  });

  it("空任务如实显示，不当成读取失败", async () => {
    mocks.api.taskReview.mockResolvedValue(taskFor(BASELINE, []));
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, BASELINE));
    await within(workbench()!).findByText("这个任务没有净改动", {}, { timeout: 8000 });
    expect(within(workbench()!).queryByText("读取任务范围失败")).toBeNull();
  });

  it("来源失效：返回被原生拒绝为 source_expired 后，工作台说明原因，关闭此来源即使原生也报失效仍能移除", async () => {
    mocks.api.clioraReviewReturn.mockRejectedValueOnce({ code: "source_expired", message: "审查来源不存在。" });
    // 原生已不认识这个来源：forget 同样拒绝为 source_expired。
    mocks.api.clioraReviewForget.mockRejectedValue({ code: "source_expired", message: "审查来源不存在。" });
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, BASELINE));
    await waitFor(() => expect(completionAction("return")).toBeTruthy());
    await fireEvent.click(completionAction("return")!);
    const title = await within(workbench()!).findByText("审查来源已失效", {}, { timeout: 8000 });
    const state = title.closest<HTMLElement>(".review-state")!;
    // 稳定错误与诊断放在详情里，首先说用户能做什么。
    expect(state.textContent).toContain("重新发起");
    await fireEvent.click(within(state).getByRole("button", { name: "关闭此来源" }));
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_A, SESSION_A));
    // 失效来源仍从本地移除，并说明原因；不做 Git 写入。
    await waitFor(() => expect(clioraReview.sources).toHaveLength(0));
    expect((await screen.findAllByText(/来源已失效，已从列表移除/)).length).toBeGreaterThan(0);
    if (activeViewId() === "review") await within(workbench()!).findByText("没有审查来源");
    else expect(activeViewId()).toBe("changes");
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
    expect(mocks.api.stageFiles).not.toHaveBeenCalled();
  });

  it("关闭来源时原生报其他错误：来源保留并报错", async () => {
    mocks.api.clioraReviewForget.mockRejectedValue({ code: "io_failed", message: "写入来源记录失败。" });
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, BASELINE));
    await waitFor(() => expect(selectedTaskPath()).toBe("src/a.ts"));
    const menu = await openSourceMenu();
    await fireEvent.click(within(menu).getByRole("button", { name: "关闭此审查来源" }));
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_A, SESSION_A));
    expect((await screen.findAllByText(/写入来源记录失败/)).length).toBeGreaterThan(0);
    expect(clioraReview.sources.map((item) => item.reviewId)).toEqual([REVIEW_A]);
  });

  it("版本不兼容：说明需要升级后重新发起，不显示伪造的任务内容", async () => {
    mocks.api.clioraReviewReturn.mockRejectedValueOnce({ code: "unsupported_version", message: "Cliora 不接受这个协议版本。" });
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, BASELINE));
    await waitFor(() => expect(completionAction("return")).toBeTruthy());
    await fireEvent.click(completionAction("return")!);
    const title = await within(workbench()!).findByText("审查协议版本不兼容", {}, { timeout: 8000 });
    expect(title.closest(".review-state")!.textContent).toContain("升级");
    expect(workbench()!.querySelector('[role="listbox"][aria-label="任务文件"]')?.closest("[hidden]") ?? null).toBeNull();
  });

  it("关闭唯一来源后：审查视图说明没有来源并给出回到改动，仓库保持打开", async () => {
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, BASELINE));
    await waitFor(() => expect(selectedTaskPath()).toBe("src/a.ts"));
    const menu = await openSourceMenu();
    await fireEvent.click(within(menu).getByRole("button", { name: "关闭此审查来源" }));
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_A, SESSION_A));
    await waitFor(() => expect(clioraReview.sources).toHaveLength(0));
    // 没有其他来源可冒充当前任务；如果审查视图仍在，它只说明「没有来源」。
    if (activeViewId() === "review") {
      const title = await within(workbench()!).findByText("没有审查来源");
      await fireEvent.click(within(title.closest<HTMLElement>(".review-state")!).getByRole("button", { name: "回到改动" }));
    }
    await waitFor(() => expect(activeViewId()).toBe("changes"));
    expect(mocks.api.openRepository).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * T4：阅读位置在模式切换、抽屉、栏宽与窄窗口重排后保持；失效撤销逐文件说明原因。
 * ------------------------------------------------------------------ */

function workbenchProps(overrides: Record<string, unknown> = {}) {
  return {
    opened: openedAt(WORKTREE),
    active: true,
    request: { baseline: BASELINE, origin: "cliora" as const, nonce: 1 },
    nextId: () => 7,
    fullFile: false,
    onFullFile: vi.fn(),
    onGeneration: vi.fn(),
    reviewed: new Set<string>(),
    onToggleReview: vi.fn(),
    onAddComment: vi.fn(),
    onEditComment: vi.fn(),
    onDeleteComment: vi.fn(),
    workbenchId: REVIEW_A,
    ...overrides,
  };
}

function queueSelected(): string | null {
  return document.querySelector<HTMLElement>('[role="listbox"][aria-label="任务文件"] [aria-selected="true"]')?.getAttribute("title") ?? null;
}

function queueRow(path: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>(".review-workbench .file-row")].find((item) => item.getAttribute("title") === path);
  if (!row) throw new Error(`队列里没有 ${path}`);
  return row;
}

/** 让工作台量到指定宽度：clientWidth 读数 + 手动触发 ResizeObserver。 */
function stubWorkbenchWidth(initial: number) {
  let width = initial;
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains("review-layout") ? width : (original?.get?.call(this) ?? 0);
    },
  });
  return {
    async set(next: number) {
      width = next;
      const layout = document.querySelector<HTMLElement>(".review-layout");
      for (const callback of [...callbacks]) callback(layout ? [{ target: layout } as unknown as ResizeObserverEntry] : [], {} as ResizeObserver);
      await tick();
    },
    restore() {
      if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
      vi.unstubAllGlobals();
    },
  };
}

describe("阅读位置与响应式重排（R3）", () => {
  it("单文件/连续切换、意见抽屉开合、栏宽调整后当前文件仍选中，单文件滚动位置恢复", async () => {
    // 测试环境没有布局：给差异滚动区一个可滚动的高度，滚动记忆才会保存与恢复。
    const heights = ["scrollHeight", "clientHeight"].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get(this: HTMLElement) { return this.classList?.contains("diff-scroll") ? 2000 : 0; } });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) { return this.classList?.contains("diff-scroll") ? 400 : 0; } });
    try {
    render(ReviewWorkbench, { props: workbenchProps() });
    await waitFor(() => expect(queueSelected()).toBe("src/a.ts"));
    await fireEvent.click(queueRow("src/b.ts"));
    await waitFor(() => expect(queueSelected()).toBe("src/b.ts"));
    const scroller = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".review-workbench .diff-scroll");
      if (!found) throw new Error("差异还没渲染");
      return found;
    });
    // 等这次选择的位置恢复（同一会话里可能记过这个文件的位置）落定，再模拟用户滚动。
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event("scroll"));

    // 连续：当前文件就是堆叠里的焦点块。
    await fireEvent.click(screen.getByRole("button", { name: "连续" }));
    await waitFor(() => expect(document.querySelector(".multi-file.focused")?.getAttribute("data-path")).toBe("src/b.ts"));
    expect(queueSelected()).toBe("src/b.ts");

    // 回到单文件：同一文件、同一滚动位置。
    await fireEvent.click(screen.getByRole("button", { name: "单文件" }));
    await waitFor(() => expect(document.querySelector<HTMLElement>(".review-workbench .diff-scroll")?.scrollTop).toBe(120));
    expect(queueSelected()).toBe("src/b.ts");

    // 意见抽屉开合不卸载差异。
    const diffNode = document.querySelector(".review-workbench .diff-scroll");
    await fireEvent.click(screen.getByRole("button", { name: "查看意见列表" }));
    expect(document.querySelector(".review-body")?.getAttribute("data-drawer")).toBe("open");
    await fireEvent.click(screen.getByRole("button", { name: "收起意见列表" }));
    expect(document.querySelector(".review-body")?.getAttribute("data-drawer")).toBeNull();
    expect(document.querySelector(".review-workbench .diff-scroll")).toBe(diffNode);

    // 栏宽调整同样不动选择与差异。
    await fireEvent.keyDown(screen.getByRole("slider", { name: "调整任务文件栏宽度" }), { key: "ArrowRight" });
    expect(queueSelected()).toBe("src/b.ts");
    expect(document.querySelector(".review-workbench .diff-scroll")).toBe(diffNode);
    globalThis.localStorage?.removeItem("twiglane.taskFilesWidth");
    } finally {
      for (const [name, descriptor] of heights) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    }
  });

  it("收起左栏只改布局：队列保活、当前文件不变，展开后原样回来", async () => {
    render(ReviewWorkbench, { props: workbenchProps() });
    await waitFor(() => expect(queueSelected()).toBe("src/a.ts"));
    await fireEvent.click(queueRow("src/c.ts"));
    const toggle = screen.getByRole("button", { name: "收起左栏" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await fireEvent.click(toggle);
    const layout = document.querySelector<HTMLElement>(".review-layout")!;
    expect(layout.classList.contains("queue-hidden")).toBe(true);
    // 队列没有卸载：选择仍在 DOM 里，差异仍是同一个文件。
    expect(queueSelected()).toBe("src/c.ts");
    await fireEvent.click(screen.getByRole("button", { name: "展开左栏" }));
    expect(layout.classList.contains("queue-hidden")).toBe(false);
    expect(queueSelected()).toBe("src/c.ts");
  });

  it("三档重排：宽 → 中 → 窄，窄档文件队列是抽屉，选好文件后收起；重排后当前文件不变", async () => {
    const width = stubWorkbenchWidth(1280);
    try {
      render(ReviewWorkbench, { props: workbenchProps() });
      await waitFor(() => expect(queueSelected()).toBe("src/a.ts"));
      const layout = document.querySelector<HTMLElement>(".review-layout")!;
      await waitFor(() => expect(layout.dataset.tier).toBe("wide"));
      await fireEvent.click(queueRow("src/b.ts"));

      await width.set(900);
      await waitFor(() => expect(layout.dataset.tier).toBe("medium"));
      expect(layout.classList.contains("queue-hidden")).toBe(false);
      expect(queueSelected()).toBe("src/b.ts");

      await width.set(640);
      await waitFor(() => expect(layout.dataset.tier).toBe("narrow"));
      // 窄档默认收起文件队列，主区全宽；当前文件不变。
      expect(layout.classList.contains("queue-hidden")).toBe(true);
      expect(queueSelected()).toBe("src/b.ts");
      const open = screen.getByRole("button", { name: "打开文件队列" });
      await fireEvent.click(open);
      expect(layout.classList.contains("queue-hidden")).toBe(false);
      await fireEvent.click(queueRow("src/c.ts"));
      await waitFor(() => expect(layout.classList.contains("queue-hidden")).toBe(true));
      expect(queueSelected()).toBe("src/c.ts");

      // 回到宽档：队列重新常驻，选择保持。
      await width.set(1280);
      await waitFor(() => expect(layout.dataset.tier).toBe("wide"));
      expect(layout.classList.contains("queue-hidden")).toBe(false);
      expect(queueSelected()).toBe("src/c.ts");
    } finally {
      width.restore();
    }
  });

  it("样式按三档声明：中/窄档意见抽屉覆盖差异，窄档队列可收起，左栏收起有专门规则", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(process.cwd(), "src/styles/review.css"), "utf8");
    expect(css).toMatch(/\.review-layout\[data-tier="medium"\] \.review-body > \.review-drawer/);
    expect(css).toMatch(/\.review-layout\[data-tier="narrow"\] \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.review-layout\[data-tier="narrow"\]\.queue-hidden \.review-queue \{ display: none; \}/);
    expect(css).toMatch(/\.review-layout\.queue-hidden \{ grid-template-columns: 0 0 minmax\(0, 1fr\); \}/);
  });
});

describe("失效撤销逐文件说明原因（R3）", () => {
  it("内容变化 / 路径消失 / 无法确认只撤销对应文件并在队列行说明原因；重新标记后原因消失", async () => {
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
    mocks.api.taskReview.mockImplementation(async (_worktree: string, baseline: string) => taskFor(baseline, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]));
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, BASELINE));
    await waitFor(() => expect(selectedTaskPath()).toBe("src/a.ts"));
    for (const path of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]) {
      await fireEvent.click(within(taskRow(path)).getByRole("button", { name: `标记 ${path} 已审阅` }));
      await waitFor(() => expect(within(taskRow(path)).getByRole("button", { name: `撤销 ${path} 的已审阅标记` })).toBeTruthy());
    }

    // 重验：a 内容变了，b 不再有净改动，c 读不出快照，d 不变。
    mocks.api.taskReviewToken.mockImplementation(async (_w: string, baseline: string, _h: string, path: string) => {
      if (path === "src/c.ts") throw { code: "io", message: "读取失败" };
      const base = { generation: 4, path, baselineOid: baseline, status: "modified", untracked: false };
      if (path === "src/a.ts") return { ...base, state: "current", token: "tok:new", message: "已确认当前快照。" };
      if (path === "src/b.ts") return { ...base, state: "unchanged", token: null, message: "这条路径相对起点没有净变化，不能标记已审阅。" };
      return { ...base, state: "current", token: `tok:${path}`, message: "已确认当前快照。" };
    });
    await switchView("history");
    await switchView("review");

    await waitFor(() => expect(taskRow("src/a.ts").querySelector(".file-tag.revoked")?.textContent).toContain("内容变化"));
    expect(taskRow("src/b.ts").querySelector(".file-tag.revoked")?.textContent).toContain("路径消失");
    expect(taskRow("src/b.ts").querySelector(".file-tag.revoked")?.getAttribute("title")).toContain("没有净变化");
    expect(taskRow("src/c.ts").querySelector(".file-tag.revoked")?.textContent).toContain("无法确认");
    expect(taskRow("src/c.ts").querySelector(".file-tag.revoked")?.getAttribute("title")).toContain("读取失败");
    // 只影响对应文件：d 仍已审阅、没有撤销说明。
    expect(taskRow("src/d.ts").querySelector(".file-tag.revoked")).toBeNull();
    expect(within(taskRow("src/d.ts")).getByRole("button", { name: "撤销 src/d.ts 的已审阅标记" })).toBeTruthy();
    expect(within(workbench()!).getByLabelText("已审阅 1 个，共 4 个任务文件")).toBeTruthy();
    // 原因带图标与文字，不只靠颜色。
    expect(taskRow("src/a.ts").querySelector(".file-tag.revoked svg, .file-tag.revoked .icon")).toBeTruthy();

    // 重新标记 a：说明消失，其他文件的说明保留。
    mocks.api.taskReviewToken.mockImplementation(async (_w: string, baseline: string, _h: string, path: string) => ({
      generation: 4, path, baselineOid: baseline, state: "current", token: "tok:new", status: "modified", untracked: false, message: "已确认当前快照。",
    }));
    await fireEvent.click(within(taskRow("src/a.ts")).getByRole("button", { name: "标记 src/a.ts 已审阅" }));
    await waitFor(() => expect(taskRow("src/a.ts").querySelector(".file-tag.revoked")).toBeNull());
    expect(taskRow("src/b.ts").querySelector(".file-tag.revoked")).toBeTruthy();
  });
});
