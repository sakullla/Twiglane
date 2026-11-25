/**
 * 来源菜单与关闭保护（R7）：人类可读的来源信息、详情折叠、含未送回意见或草稿时二次确认、
 * 取消后原样保留、无意见时轻量关闭、关闭不自动选择其他来源、已准备送回的意见不再拦截。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLine, DiffResponse, FileChange, StatusSnapshot } from "../src/lib/types";
import { clioraReview, resetClioraReview } from "../src/lib/cliora-review.svelte";
import { resetReviewProgress } from "../src/lib/review-progress.svelte";
import { commentDraftCount, resetReviewComments } from "../src/lib/review-comments.svelte";
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

/* ------------------------- 外壳夹具（本 spec 自包含） ------------------------- */

const WORKTREE = "C:/work/代码 demo";
const REVIEW_A = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
const REVIEW_B = "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
const SESSION_A = "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0";
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

async function openSourceMenu(): Promise<HTMLElement> {
  if (activeViewId() !== "review") await switchView("review");
  await fireEvent.click(await screen.findByRole("button", { name: "选择 Cliora 审查来源" }));
  return screen.findByRole("dialog", { name: "审查来源" });
}

async function composeComment(text: string): Promise<void> {
  const bubble = await waitFor(() => {
    const found = workbench()?.querySelector<HTMLButtonElement>("[data-comment-line]");
    if (!found) throw new Error("差异里没有行意见入口");
    return found;
  }, { timeout: 8000 });
  await fireEvent.click(bubble);
  const form = await screen.findByRole("form", { name: "给这一行添加意见" });
  const box = form.querySelector<HTMLTextAreaElement>('textarea[aria-label="意见正文"]')!;
  await fireEvent.input(box, { target: { value: text } });
  const add = [...form.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "添加意见")!;
  await fireEvent.click(add);
}

const clipboard = { writeText: vi.fn(async (_text: string) => {}) };

beforeEach(() => {
  resetShellMocks(mocks, deepLink);
  resetClioraReview();
  resetReviewProgress();
  resetReviewComments();
  resetReviewWorkbench();
  clipboard.writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
});

afterEach(() => {
  cleanup();
  resetClioraReview();
  resetReviewComments();
});

async function coldStart() {
  deepLink.getCurrent.mockResolvedValue([reviewUrl(REVIEW_A, SESSION_A, BASELINE)]);
  render(App);
  await waitFor(() => expect(activeViewId()).toBe("review"), { timeout: 8000 });
  await waitFor(() => expect(selectedTaskPath()).toBe("src/a.ts"));
}

/** 同一会话对同一工作树再发起一次（新的 reviewId 与起点）。 */
async function relaunch() {
  mocks.api.clioraReviewRequest.mockResolvedValue({ reviewId: REVIEW_B, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE_B });
  const handler = deepLink.onOpenUrl.mock.calls[0][0] as (urls: string[]) => void;
  handler([reviewUrl(REVIEW_B, SESSION_A, BASELINE_B)]);
  await waitFor(() => expect(clioraReview.sources).toHaveLength(2), { timeout: 8000 });
}

function menuRow(menu: HTMLElement, reviewId: string): HTMLElement {
  const row = menu.querySelector<HTMLElement>(`[data-review-source-id="${reviewId}"]`);
  if (!row) throw new Error(`来源菜单里没有 ${reviewId}`);
  return row;
}

function closeButtonOf(menu: HTMLElement, reviewId: string): HTMLButtonElement {
  return within(menuRow(menu, reviewId)).getByRole("button", { name: `关闭审查来源 ${reviewId.slice(0, 8)}` });
}

describe("来源菜单的人类可读信息（R7）", () => {
  it("同一会话对同一工作树多次发起：不比较 UUID 也能分出当前、最新与较早；ID、路径与协议只在详情里", async () => {
    await coldStart();
    await relaunch();
    const menu = await openSourceMenu();
    const rows = [...menu.querySelectorAll<HTMLElement>("[data-review-source-id]")];
    expect(rows).toHaveLength(2);
    // 当前来源排在最前；后发起的是「最新发起」。
    const current = rows.find((row) => row.classList.contains("current"))!;
    expect(current.dataset.reviewSourceId).toBe(clioraReview.source?.reviewId);
    expect(menuRow(menu, REVIEW_B).textContent).toContain("最新发起");
    expect(menuRow(menu, REVIEW_A).textContent).toContain("较早发起");
    for (const row of rows) {
      // 相对时间来自原生接受时间。
      expect(row.textContent).toContain("刚刚");
      // 折叠状态下不出现会话 ID、审查 ID 或完整路径。
      expect(row.textContent).not.toContain(SESSION_A);
      expect(row.textContent).not.toContain(REVIEW_A);
      expect(row.textContent).not.toContain(WORKTREE);
    }

    await fireEvent.click(within(menuRow(menu, REVIEW_A)).getByRole("button", { name: /的来源详情$/ }));
    const details = menuRow(menu, REVIEW_A).querySelector(".review-source-details")!;
    expect(details.textContent).toContain(REVIEW_A);
    expect(details.textContent).toContain(SESSION_A);
    expect(details.textContent).toContain(WORKTREE);
    expect(details.textContent).toContain("v2");
  });
});

describe("关闭保护（R7）", () => {
  it("没有意见与草稿时关闭是轻量的：不弹确认，仓库与视图仍可用", async () => {
    await coldStart();
    const menu = await openSourceMenu();
    await fireEvent.click(closeButtonOf(menu, REVIEW_A));
    expect(screen.queryByRole("dialog", { name: "关闭审查来源" })).toBeNull();
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_A, SESSION_A));
    await waitFor(() => expect(clioraReview.sources).toHaveLength(0));
    expect(mocks.api.openRepository).toHaveBeenCalledTimes(1);
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
  });

  it("含未送回意见时一次误点不会丢：先确认，取消后来源与意见原样保留", async () => {
    await coldStart();
    await composeComment("这条意见还没送回。");
    await waitFor(() => expect(document.querySelector('.review-completion [data-status="comments"]')?.textContent).toContain("1 条意见"));

    let menu = await openSourceMenu();
    await fireEvent.click(closeButtonOf(menu, REVIEW_A));
    const dialog = await screen.findByRole("dialog", { name: "关闭审查来源" });
    expect(dialog.textContent).toContain("1 条未送回的意见");
    expect(dialog.textContent).toContain("不会自动切换到其他来源");
    await fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "关闭审查来源" })).toBeNull());
    expect(mocks.api.clioraReviewForget).not.toHaveBeenCalled();
    expect(clioraReview.source?.reviewId).toBe(REVIEW_A);
    expect(document.querySelector('.review-completion [data-status="comments"]')?.textContent).toContain("1 条意见");

    // 复制意见后关闭：剪贴板拿到原正文，然后才关闭。
    menu = await openSourceMenu();
    await fireEvent.click(closeButtonOf(menu, REVIEW_A));
    const again = await screen.findByRole("dialog", { name: "关闭审查来源" });
    await fireEvent.click(within(again).getByRole("button", { name: "复制意见后关闭" }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
    expect(clipboard.writeText.mock.calls[0][0]).toContain("这条意见还没送回。");
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_A, SESSION_A));
  });

  it("只有未保存的意见草稿也要确认；取消后草稿仍在", async () => {
    await coldStart();
    const bubble = await waitFor(() => {
      const found = workbench()?.querySelector<HTMLButtonElement>("[data-comment-line]");
      if (!found) throw new Error("没有行意见入口");
      return found;
    }, { timeout: 8000 });
    await fireEvent.click(bubble);
    const form = await screen.findByRole("form", { name: "给这一行添加意见" });
    await fireEvent.input(within(form).getByRole("textbox", { name: "意见正文" }), { target: { value: "写了一半" } });
    await waitFor(() => expect(commentDraftCount(REVIEW_A)).toBe(1));

    const menu = await openSourceMenu();
    await fireEvent.click(closeButtonOf(menu, REVIEW_A));
    const dialog = await screen.findByRole("dialog", { name: "关闭审查来源" });
    expect(dialog.textContent).toContain("1 条意见草稿");
    await fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(mocks.api.clioraReviewForget).not.toHaveBeenCalled();
    expect(commentDraftCount(REVIEW_A)).toBe(1);
    expect((within(form).getByRole("textbox", { name: "意见正文" }) as HTMLTextAreaElement).value).toBe("写了一半");
  });

  it("确认后关闭含意见的当前来源：不自动选择剩下的来源冒充当前任务", async () => {
    await coldStart();
    await relaunch();
    // 切回 A，在 A 上写一条意见。
    let menu = await openSourceMenu();
    await fireEvent.click(menuRow(menu, REVIEW_A).querySelector<HTMLButtonElement>(".review-source-switch")!);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_A));
    await waitFor(() => expect(selectedTaskPath()).toBe("src/a.ts"));
    await composeComment("A 上的意见");
    await waitFor(() => expect(document.querySelector('.review-completion [data-status="comments"]')?.textContent).toContain("1 条意见"));

    menu = await openSourceMenu();
    await fireEvent.click(within(menu).getByRole("button", { name: "关闭此审查来源" }));
    const dialog = await screen.findByRole("dialog", { name: "关闭审查来源" });
    await fireEvent.click(within(dialog).getByRole("button", { name: "仍然关闭" }));
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_A, SESSION_A));
    await waitFor(() => expect(clioraReview.sources.map((source) => source.reviewId)).toEqual([REVIEW_B]));
    expect(clioraReview.source).toBeNull();
    expect(mocks.api.clioraReviewForget).toHaveBeenCalledTimes(1);
  });

  it("关闭全部来源时汇总每个来源会丢的内容；没有内容的来源不阻塞", async () => {
    await coldStart();
    await composeComment("A 上的意见");
    await waitFor(() => expect(document.querySelector('.review-completion [data-status="comments"]')?.textContent).toContain("1 条意见"));
    await relaunch();

    const menu = await openSourceMenu();
    await fireEvent.click(within(menu).getByRole("button", { name: "关闭全部来源" }));
    const dialog = await screen.findByRole("dialog", { name: "关闭全部审查来源" });
    const targets = dialog.textContent ?? "";
    expect(targets).toContain("1 条未送回的意见");
    await fireEvent.click(within(dialog).getByRole("button", { name: "仍然关闭" }));
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(clioraReview.sources).toHaveLength(0));
  });

  it("意见已成功准备送回后关闭不再拦截；准备之后新加的意见仍算未送回", async () => {
    mocks.api.prepareReviewFeedback.mockResolvedValue({
      feedbackId: "8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1",
      digest: "a".repeat(64),
      commentCount: 1,
      url: "cliora://review-feedback?v=1&feedbackId=8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1",
    });
    await coldStart();
    await composeComment("第一条");
    await waitFor(() => expect(completionAction("feedback")).toBeTruthy());
    await fireEvent.click(completionAction("feedback")!);
    await waitFor(() => expect(mocks.api.prepareReviewFeedback).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector('.review-completion [data-status="handoff"]')?.textContent).toContain("等待确认"));

    let menu = await openSourceMenu();
    await fireEvent.click(closeButtonOf(menu, REVIEW_A));
    // 已成功准备的批次不算会丢的内容：直接关闭，不弹确认。
    expect(screen.queryByRole("dialog", { name: "关闭审查来源" })).toBeNull();
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledTimes(1));
    expect(clioraReview.sources).toHaveLength(0);

    // 重新发起一个来源：准备后再加的意见要拦截。
    mocks.api.clioraReviewRequest.mockResolvedValue({ reviewId: REVIEW_B, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE_B });
    const handler = deepLink.onOpenUrl.mock.calls[0][0] as (urls: string[]) => void;
    handler([reviewUrl(REVIEW_B, SESSION_A, BASELINE_B)]);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_B), { timeout: 8000 });
    await waitFor(() => expect(selectedTaskPath()).toBe("src/a.ts"));
    await composeComment("第一条");
    await waitFor(() => expect(completionAction("feedback")).toBeTruthy());
    await fireEvent.click(completionAction("feedback")!);
    await waitFor(() => expect(mocks.api.prepareReviewFeedback).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector('.review-completion [data-status="handoff"]')?.textContent).toContain("等待确认"));
    await composeComment("准备之后新加的");
    await waitFor(() => expect(document.querySelector('.review-completion [data-status="comments"]')?.textContent).toContain("1 条未送回"));

    menu = await openSourceMenu();
    await fireEvent.click(closeButtonOf(menu, REVIEW_B));
    const dialog = await screen.findByRole("dialog", { name: "关闭审查来源" });
    expect(dialog.textContent).toContain("1 条未送回的意见");
  });
});
