/**
 * 原位意见（R5）：差异内的意见行（统一与并排）、已有标记打开锚点线程、按文件分组的意见抽屉与
 * 失效只读分区、草稿跨文件/来源保留、丢草稿前确认、编辑器内的上限错误与 IME 守卫。
 *
 * 组件级用例直接渲染审查工作台，意见状态用真实的 review-comments store（feedback-v1 的准备侧），
 * 每次意见变化后按 store 重新给出 props——与外壳接线一致。来源级关卡（切换来源、返回、送回）
 * 用 ReviewActions 加最小 host 验证。夹具都写在本文件内。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
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

vi.mock("../src/lib/api", () => ({
  api: mocks.api,
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));

import ReviewWorkbench from "../src/lib/components/review/ReviewWorkbench.svelte";
import {
  addComment,
  adoptCommentScope,
  commentDraft,
  commentDraftCount,
  commentLines,
  commentsIn,
  deleteComment,
  editComment,
  feedbackComments,
  MAX_BODY_BYTES,
  resetReviewComments,
  setCommentDraft,
  staleBatches,
  type CommentScope,
  type ReviewCommentAnchor,
} from "../src/lib/review-comments.svelte";
import { resetReviewWorkbench } from "../src/lib/review-workbench.svelte";
import { beginClioraReview, clioraReview, resetClioraReview } from "../src/lib/cliora-review.svelte";
import { createReviewActions, type ReviewActionsHost } from "../src/lib/review-actions.svelte";

/* ------------------------------- 夹具 ------------------------------- */

const WORKTREE = "C:/work/inline";
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const REVIEW = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
const OTHER_REVIEW = "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
const ROW = 18;
/** 长差异：块标题 + 199 行，第 100 行附近是改动。 */
const LONG_LINES = 200;
const MID = 95;

const branch: BranchInfo = {
  name: "main",
  detached: false,
  unborn: false,
  headOid: HEAD,
  upstream: null,
  ahead: 0,
  behind: 0,
  liveRemoteChecked: false,
  remoteCheckedAtMs: 0,
  remoteCheckStale: false,
};

const snapshot: StatusSnapshot = { generation: 4, branch, files: [] };

const opened: OpenedRepository = {
  summary: { name: "inline", path: WORKTREE },
  generation: 4,
  snapshot,
  draft: "",
  watchDegraded: false,
};

function taskFile(path: string): TaskFileChange {
  return { path, originalPath: null, status: "modified", additions: 3, deletions: 1, binary: false, oldSize: null, newSize: null, untracked: false, unmerged: false };
}

function task(rangeVersion = "range-1"): TaskReview {
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
    files: [taskFile("src/app.ts"), taskFile("src/other.ts")],
    filesTotal: 2,
    filesTruncated: false,
    additions: 6,
    deletions: 2,
    dirty: true,
    untrackedFiles: 0,
    conflicted: false,
    empty: false,
    rangeVersion,
    message: "读取成功：最终净改动 2 个文件。",
  };
}

/** 统一视图第 index 行对应的差异行：0 是块标题；95、96 是删除 + 新增；其余是上下文。 */
function longDiff(path: string): DiffResponse {
  const lines: DiffLine[] = [{ kind: "hunk", text: "@@ -1,198 +1,198 @@ function main()", oldNo: null, newNo: null, hunkIndex: 0 }];
  let oldNo = 1;
  let newNo = 1;
  for (let index = 1; index < LONG_LINES; index += 1) {
    if (index === MID) {
      lines.push({ kind: "del", text: `-old ${path} ${index}`, oldNo: oldNo++, newNo: null, hunkIndex: 0 });
    } else if (index === MID + 1) {
      lines.push({ kind: "add", text: `+new ${path} ${index}`, oldNo: null, newNo: newNo++, hunkIndex: 0 });
    } else {
      lines.push({ kind: "context", text: ` line ${path} ${index}`, oldNo: oldNo++, newNo: newNo++, hunkIndex: 0 });
    }
  }
  return {
    generation: 4,
    path,
    staged: false,
    binary: false,
    text: null,
    summary: "1 行修改。",
    additions: 1,
    deletions: 1,
    complete: true,
    truncated: false,
    snapshot: "snap",
    hunks: [{ index: 0, header: "@@ -1,198 +1,198 @@", complete: true, stageable: true, startLine: 0, lineCount: LONG_LINES }],
    lines,
    offset: 0,
    totalLines: lines.length,
  };
}

function scopeFor(reviewId = REVIEW, rangeVersion = "range-1", generation = 4): CommentScope {
  return { reviewId, sessionId: "session", worktree: WORKTREE, baselineOid: BASE, headOid: HEAD, rangeVersion, generation };
}

let scope = scopeFor();
let workbenchId: string | null = REVIEW;
/** 外壳每次切换来源都会发出新的任务请求（nonce 前进）。 */
let nonce = 1;
let rerenderView: ((props: Record<string, unknown>) => Promise<void>) | null = null;

function props(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opened,
    active: true,
    request: { baseline: BASE, origin: "cliora" as const, nonce },
    nextId: () => 7,
    fullFile: false,
    onFullFile: vi.fn(),
    onGeneration: vi.fn(),
    onFileHistory: vi.fn(),
    reviewed: new Set<string>(),
    onToggleReview: vi.fn(),
    workbenchId,
    comments: commentsIn(scope),
    commentKeys: commentLines(scope),
    staleComments: staleBatches(scope.reviewId),
    onAddComment: (anchor: ReviewCommentAnchor, body: string) => {
      addComment(scope, anchor, body);
      void sync();
    },
    onEditComment: (id: string, body: string) => {
      if (!editComment(scope, id, body)) throw new Error("这条意见已经不在当前批次里，请重新读取任务。");
      void sync();
    },
    onDeleteComment: (id: string) => {
      deleteComment(scope, id);
      void sync();
    },
    onCopyText: copyText,
    ...extra,
  };
}

const copyText = vi.fn();

/** 意见 store 变化后按 store 重新给出 props：与 App 的派生接线相同。 */
async function sync(extra: Record<string, unknown> = {}): Promise<void> {
  await rerenderView?.(props(extra));
}

async function mount(extra: Record<string, unknown> = {}) {
  type WorkbenchProps = ComponentProps<typeof ReviewWorkbench>;
  const view = render(ReviewWorkbench, { props: props(extra) as unknown as WorkbenchProps });
  rerenderView = (next) => view.rerender(next as unknown as Partial<WorkbenchProps>);
  await screen.findByRole("listbox", { name: "任务文件" });
  await waitFor(() => expect(document.querySelector("[data-comment-line]")).toBeTruthy());
  return view;
}

function scroller(): HTMLElement {
  return document.querySelector<HTMLElement>(".review-stage .diff-scroll")!;
}

/** 把单文件差异滚到中部：虚拟窗口只渲染附近的行。 */
async function scrollToMiddle(): Promise<void> {
  const node = scroller();
  node.scrollTop = (MID - 5) * ROW;
  await fireEvent.scroll(node);
  await waitFor(() => expect(document.querySelector(`[data-comment-line="${MID}"]`)).toBeTruthy());
}

function bubble(index: number): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`.review-stage [data-comment-line="${index}"]`);
  if (!found) throw new Error(`第 ${index} 行没有意见入口`);
  return found;
}

function inlineRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".review-stage .diff-inline-comment");
}

function topOf(node: Element | null): number {
  return Number.parseFloat((node as HTMLElement | null)?.style.top ?? "NaN");
}

function textbox(container: HTMLElement = document.body): HTMLTextAreaElement {
  return within(container).getByRole("textbox", { name: "意见正文" }) as HTMLTextAreaElement;
}

function feedback(): string {
  return document.querySelector(".review-comment-feedback")?.textContent?.trim() ?? "";
}

function anchorAt(newNo: number, extra: Partial<ReviewCommentAnchor> = {}): ReviewCommentAnchor {
  return { path: "src/app.ts", hunkIndex: 0, kind: "context", oldNo: newNo, newNo, quote: ` line src/app.ts ${newNo}`, ...extra };
}

beforeEach(() => {
  for (const fn of mocks.created.values()) fn.mockReset();
  mocks.api.taskReview.mockImplementation(async () => task());
  mocks.api.loadTaskDiff.mockImplementation(async (_w: string, _b: string, _h: string, path: string) => longDiff(path));
  mocks.api.cancelReads.mockResolvedValue(undefined);
  copyText.mockReset();
  resetReviewComments();
  resetReviewWorkbench();
  resetClioraReview();
  scope = scopeFor();
  workbenchId = REVIEW;
  nonce = 1;
  adoptCommentScope(scope);
});

afterEach(() => {
  cleanup();
  rerenderView = null;
  resetReviewComments();
  resetReviewWorkbench();
  resetClioraReview();
});

/* ------------------------------ 原位编辑器 ------------------------------ */

describe("差异内的原位意见行", () => {
  it("长差异中部点行意见：编辑器出现在该行正下方、与引用同屏，其后的行整体下移；保存后标记出现", async () => {
    await mount();
    await scrollToMiddle();
    const anchorRow = document.querySelector<HTMLElement>(`.review-stage .diff-line[data-line="${MID}"]`)!;
    expect(topOf(anchorRow)).toBe(MID * ROW);

    await fireEvent.click(bubble(MID));
    const row = await waitFor(() => {
      const found = inlineRow();
      expect(found).toBeTruthy();
      return found!;
    });
    // 编辑器紧跟锚点行：位置就是锚点行的下一行，不是顶部固定区域。
    expect(row.dataset.inlineAfter).toBe(String(MID));
    expect(topOf(row)).toBe(topOf(anchorRow) + ROW);
    const form = within(row).getByRole("form", { name: "给这一行添加意见" });
    // 引用就是这一行的代码，与输入框在同一个意见行里。
    expect(within(form).getByLabelText("引用的代码").textContent).toBe(`old src/app.ts ${MID}`);
    expect(form.textContent).toContain("删除第");
    // 其后的行让出意见行的高度，不与编辑器重叠。
    const next = document.querySelector<HTMLElement>(`.review-stage .diff-line[data-line="${MID + 1}"]`)!;
    expect(topOf(next)).toBeGreaterThan(topOf(row));
    expect(document.querySelector(".task-comment-composer")).toBeNull();

    await fireEvent.input(textbox(form), { target: { value: "旧值要保留到新值读到为止。" } });
    await fireEvent.keyDown(textbox(form), { key: "Enter", metaKey: true });
    await waitFor(() => expect(inlineRow()).toBeNull());
    expect(commentsIn(scope)).toHaveLength(1);
    expect(commentsIn(scope)[0].anchor).toMatchObject({ path: "src/app.ts", hunkIndex: 0, kind: "del", newNo: null });
    await waitFor(() => expect(bubble(MID).classList.contains("commented")).toBe(true));
    expect(feedback()).toContain("已添加意见");
    // 后面的行回到原位。
    expect(topOf(document.querySelector(`.review-stage .diff-line[data-line="${MID + 1}"]`))).toBe((MID + 1) * ROW);
  });

  it("并排视图同样成立：意见行跨两栏，紧跟锚点所在的并排行", async () => {
    await mount();
    await fireEvent.click(screen.getByTitle("并排视图"));
    await waitFor(() => expect(document.querySelector(".review-stage .side-row")).toBeTruthy());
    await scrollToMiddle();
    // 新增行在右栏：并排行的 data-line 取右侧下标。
    await fireEvent.click(bubble(MID + 1));
    const row = await waitFor(() => {
      const found = inlineRow();
      expect(found).toBeTruthy();
      return found!;
    });
    expect(row.classList.contains("split")).toBe(true);
    const sideRow = document.querySelector<HTMLElement>(`.review-stage .side-row[data-line="${MID + 1}"]`)!;
    expect(topOf(row)).toBe(topOf(sideRow) + ROW);
    const form = within(row).getByRole("form", { name: "给这一行添加意见" });
    expect(within(form).getByLabelText("引用的代码").textContent).toBe(`new src/app.ts ${MID + 1}`);
    await fireEvent.input(textbox(form), { target: { value: "并排里写的意见" } });
    await fireEvent.click(within(form).getByRole("button", { name: "添加意见" }));
    await waitFor(() => expect(commentsIn(scope)).toHaveLength(1));
    expect(commentsIn(scope)[0].anchor).toMatchObject({ kind: "add", oldNo: null });
    await waitFor(() => expect(bubble(MID + 1).classList.contains("commented")).toBe(true));
  });

  it("连续阅读（多文件堆叠）里同样原位展开：只在锚点所属的文件块里", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "连续" }));
    const block = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.multi-file[data-path="src/other.ts"] [data-comment-line="3"]');
      expect(found).toBeTruthy();
      return found!;
    });
    await fireEvent.click(block);
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".multi-file .diff-inline-comment");
      expect(found).toBeTruthy();
      return found!;
    });
    expect(row.closest<HTMLElement>(".multi-file")?.dataset.path).toBe("src/other.ts");
    expect(document.querySelectorAll(".multi-file .diff-inline-comment")).toHaveLength(1);
    const form = within(row).getByRole("form", { name: "给这一行添加意见" });
    expect(within(form).getByLabelText("引用的代码").textContent).toBe("line src/other.ts 3");
    await fireEvent.input(textbox(form), { target: { value: "连续阅读里写的" } });
    await fireEvent.keyDown(textbox(form), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(commentsIn(scope)).toHaveLength(1));
    expect(commentsIn(scope)[0].anchor.path).toBe("src/other.ts");
  });

  it("评论此块：意见行出现在块标题之后，锚点与区间编码不变", async () => {
    await mount();
    await fireEvent.click(document.querySelector<HTMLButtonElement>(".review-stage [data-hunk-comment]")!);
    const row = await waitFor(() => {
      const found = inlineRow();
      expect(found).toBeTruthy();
      return found!;
    });
    expect(row.dataset.inlineAfter).toBe("0");
    const form = within(row).getByRole("form", { name: "给这一块添加意见" });
    await fireEvent.input(textbox(form), { target: { value: "整块都要改" } });
    await fireEvent.keyDown(textbox(form), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(commentsIn(scope)).toHaveLength(1));
    const [sent] = feedbackComments(scope);
    // feedback-v1 仍是单行锚点：落在块内第一条新增行上，正文开头写明区间。
    expect(sent).toMatchObject({ path: "src/app.ts", hunkIndex: 0, kind: "add", oldNo: null });
    expect(sent.body.startsWith("（第 ")).toBe(true);
    expect(sent.body).toContain("整块都要改");
  });
});

/* ------------------------------ 键盘、上限与反馈 ------------------------------ */

describe("编辑器的键盘、上限与反馈", () => {
  it("输入法组字时 Enter 与 Esc 都不触发；⌘/Ctrl+Enter 保存", async () => {
    await mount();
    await fireEvent.click(bubble(3));
    const box = textbox(inlineRow()!);
    await fireEvent.input(box, { target: { value: "组字中" } });
    await fireEvent.keyDown(box, { key: "Enter", ctrlKey: true, isComposing: true });
    await fireEvent.keyDown(box, { key: "Escape", isComposing: true });
    await fireEvent.keyDown(box, { key: "Enter", metaKey: true, keyCode: 229 });
    expect(commentsIn(scope)).toHaveLength(0);
    expect(inlineRow()).toBeTruthy();
    expect(within(inlineRow()!).queryByText(/放弃这条草稿/)).toBeNull();
    await fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(commentsIn(scope)).toHaveLength(1));
  });

  it("Esc 取消：有正文先就地确认，再按一次 Esc 才放弃；空编辑器直接收起；都有反馈", async () => {
    await mount();
    await fireEvent.click(bubble(3));
    let box = textbox(inlineRow()!);
    await fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(inlineRow()).toBeNull());
    expect(feedback()).toBe("已取消。");

    await fireEvent.click(bubble(3));
    box = textbox(inlineRow()!);
    await fireEvent.input(box, { target: { value: "写了一半" } });
    await fireEvent.keyDown(box, { key: "Escape" });
    const confirm = within(inlineRow()!).getByRole("alert");
    expect(confirm.textContent).toContain("放弃这条草稿");
    expect(box.value).toBe("写了一半");
    // 「继续编辑」收起确认，正文仍在。
    await fireEvent.click(within(confirm).getByRole("button", { name: "继续编辑" }));
    expect(within(inlineRow()!).queryByText(/放弃这条草稿/)).toBeNull();
    await fireEvent.keyDown(box, { key: "Escape" });
    await fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(inlineRow()).toBeNull());
    expect(feedback()).toBe("已放弃这条意见草稿。");
    expect(commentDraft(REVIEW)).toBeNull();
  });

  it("超过 16 KiB：编辑器内先提示，保存失败的错误显示在编辑器里，正文不清空", async () => {
    await mount();
    await fireEvent.click(bubble(3));
    const row = inlineRow()!;
    const box = textbox(row);
    const long = "意".repeat(Math.ceil(MAX_BODY_BYTES / 3) + 10);
    await fireEvent.input(box, { target: { value: long } });
    expect(row.querySelector('.inline-comment-limit[data-over="true"]')?.textContent).toContain("16 KiB");
    await fireEvent.click(within(row).getByRole("button", { name: "添加意见" }));
    const error = await within(row).findByText(/超过 16 KiB/, { selector: ".inline-comment-error span" });
    expect(error).toBeTruthy();
    expect(box.value).toBe(long);
    expect(commentsIn(scope)).toHaveLength(0);
  });

  it("第 65 条：错误显示在编辑器里，正文保留；上限不变", async () => {
    for (let index = 0; index < 64; index += 1) addComment(scope, anchorAt(150, { quote: "q" }), `第 ${index + 1} 条`);
    await mount();
    await fireEvent.click(bubble(3));
    const row = inlineRow()!;
    // 第 3 行还没有意见：打开的是新草稿而不是线程。
    expect(within(row).getByRole("form", { name: "给这一行添加意见" })).toBeTruthy();
    await fireEvent.input(textbox(row), { target: { value: "第 65 条" } });
    await fireEvent.keyDown(textbox(row), { key: "Enter", ctrlKey: true });
    await within(row).findByText(/一次最多送回 64 条意见/);
    expect(textbox(row).value).toBe("第 65 条");
    expect(commentsIn(scope)).toHaveLength(64);
  });
});

/* ------------------------------ 线程与抽屉 ------------------------------ */

describe("已有意见的线程与意见抽屉", () => {
  it("点已有标记打开该锚点的线程：可编辑、删除、添加另一条、在抽屉中定位", async () => {
    const first = addComment(scope, anchorAt(3, { quote: " line src/app.ts 3" }), "第一条意见");
    await mount();
    await waitFor(() => expect(bubble(3).classList.contains("commented")).toBe(true));
    await fireEvent.click(bubble(3));
    const thread = await screen.findByRole("region", { name: "这一行的意见" });
    expect(inlineRow()!.contains(thread)).toBe(true);
    // 不再直接开空草稿。
    expect(within(thread).queryByRole("form", { name: "给这一行添加意见" })).toBeNull();
    expect(within(thread).getByText("第一条意见")).toBeTruthy();

    // 编辑：就地改，保存后线程仍在，正文更新。
    await fireEvent.click(within(thread).getByRole("button", { name: "编辑" }));
    const editor = within(thread).getByRole("form", { name: "编辑这条意见" });
    await fireEvent.input(textbox(editor), { target: { value: "第一条意见（改过）" } });
    await fireEvent.click(within(editor).getByRole("button", { name: "保存意见" }));
    await waitFor(() => expect(commentsIn(scope)[0].body).toBe("第一条意见（改过）"));
    expect(feedback()).toContain("已保存");
    const live = await screen.findByRole("region", { name: "这一行的意见" });
    expect(within(live).getByText("第一条意见（改过）")).toBeTruthy();

    // 在抽屉中定位：抽屉打开，对应卡片高亮。
    await fireEvent.click(within(live).getByRole("button", { name: "在抽屉中定位" }));
    const drawer = await screen.findByLabelText("意见列表");
    await waitFor(() => expect(drawer.querySelector(`[data-comment-id="${first.id}"]`)?.classList.contains("focused")).toBe(true));

    // 添加另一条：同一位置开新草稿。
    await fireEvent.click(within(live).getByRole("button", { name: "添加另一条" }));
    const form = await screen.findByRole("form", { name: "给这一行添加意见" });
    await fireEvent.input(textbox(form), { target: { value: "第二条意见" } });
    await fireEvent.keyDown(textbox(form), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(commentsIn(scope)).toHaveLength(2));

    // 再点标记：线程里两条都在；删除一条有反馈。
    await fireEvent.click(bubble(3));
    const again = await screen.findByRole("region", { name: "这一行的意见" });
    expect(again.textContent).toContain("2 条意见");
    await fireEvent.click(within(again).getAllByRole("button", { name: "删除" })[0]);
    await waitFor(() => expect(commentsIn(scope)).toHaveLength(1));
    expect(feedback()).toContain("已删除");
    expect(commentsIn(scope)[0].body).toBe("第二条意见");
  });

  it("抽屉按文件分组成结构化卡片，与差异标记数量一致；定位回到差异并打开线程", async () => {
    addComment(scope, anchorAt(3), "app 第 3 行");
    addComment(scope, anchorAt(5), "app 第 5 行");
    addComment(scope, { ...anchorAt(7), path: "src/other.ts", quote: " line src/other.ts 7" }, "other 第 7 行");
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "查看意见列表" }));
    const drawer = await screen.findByLabelText("意见列表");
    expect(drawer.querySelector("pre")).toBeNull();
    expect(drawer.querySelector(".review-drawer-count")?.textContent).toBe("3 条 · 2 个文件");
    const appGroup = within(drawer).getByRole("region", { name: "src/app.ts 的意见" });
    const otherGroup = within(drawer).getByRole("region", { name: "src/other.ts 的意见" });
    const appCards = appGroup.querySelectorAll("[data-comment-id]");
    expect(appCards).toHaveLength(2);
    expect(otherGroup.querySelectorAll("[data-comment-id]")).toHaveLength(1);
    // 当前文件 src/app.ts：差异里的已有意见标记数与抽屉里这个文件的卡片数一致。
    await waitFor(() => expect(document.querySelectorAll(".review-stage .line-comment.commented")).toHaveLength(appCards.length));
    // 逐卡预览送回内容。
    expect(appCards[0].querySelector("details.review-comment-sent")?.textContent).toContain("app 第 3 行");

    // 定位 other.ts 的意见：切到那个文件并在锚点处打开线程。
    await fireEvent.click(within(otherGroup).getByRole("button", { name: "定位" }));
    const thread = await screen.findByRole("region", { name: "这一行的意见" }, { timeout: 4000 });
    expect(thread.textContent).toContain("src/other.ts");
    expect(thread.textContent).toContain("other 第 7 行");
  });

  it("范围或代次前进后：当前批次不含旧意见，失效分区显示原因、原正文、路径与行号，可复制、不可编辑", async () => {
    const old = addComment(scope, anchorAt(3), "旧范围里的意见");
    // 代次前进（范围形状不变、内容变了）：上一批整体失效。
    scope = scopeFor(REVIEW, "range-1", 5);
    adoptCommentScope(scope);
    await mount();
    expect(commentsIn(scope)).toHaveLength(0);
    // 差异里不显示失效标记。
    expect(document.querySelectorAll(".review-stage .line-comment.commented")).toHaveLength(0);
    await fireEvent.click(screen.getByRole("button", { name: "查看意见列表" }));
    const drawer = await screen.findByLabelText("意见列表");
    expect(drawer.querySelectorAll(".review-comment-group")).toHaveLength(0);
    const stale = within(drawer).getByRole("region", { name: "已失效的意见" });
    expect(stale.textContent).toContain("读取代次 4 → 5");
    const card = stale.querySelector<HTMLElement>(`[data-stale-comment-id="${old.id}"]`)!;
    expect(card.textContent).toContain("旧范围里的意见");
    expect(card.textContent).toContain("src/app.ts");
    expect(card.textContent).toContain("第 3 行");
    expect(within(card).queryByRole("button", { name: "编辑" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "删除" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "定位" })).toBeNull();
    await fireEvent.click(within(card).getByRole("button", { name: "复制" }));
    expect(copyText).toHaveBeenCalledWith("src/app.ts（第 3 行）\n旧范围里的意见", "失效意见");
    await fireEvent.click(within(stale).getByRole("button", { name: "复制全部" }));
    expect(copyText.mock.calls[1][0]).toContain("旧范围里的意见");

    // 范围本身变化：说明是范围变化，旧意见同样不进入当前批次。
    addComment(scope, anchorAt(5), "代次 5 的意见");
    const moved = scopeFor(REVIEW, "range-2", 5);
    adoptCommentScope(moved);
    expect(commentsIn(moved)).toHaveLength(0);
    expect(staleBatches(REVIEW)[0].reason).toContain("任务范围（起点、HEAD 或工作区）已经变化");
  });
});

/* ------------------------------ 草稿保留与丢失前确认 ------------------------------ */

describe("草稿跨文件、视图与来源保留", () => {
  function fileOption(path: string): HTMLElement {
    const list = screen.getByRole("listbox", { name: "任务文件" });
    return within(list).getAllByRole("option").find((option) => option.getAttribute("title") === path)!;
  }

  it("切换文件再返回草稿仍在；草稿不在眼前时给出「继续编辑」", async () => {
    await mount();
    await fireEvent.click(bubble(3));
    await fireEvent.input(textbox(inlineRow()!), { target: { value: "跨文件保留的草稿" } });
    await waitFor(() => expect(commentDraftCount(REVIEW)).toBe(1));

    await fireEvent.click(fileOption("src/other.ts"));
    await waitFor(() => expect(mocks.api.loadTaskDiff.mock.calls.at(-1)?.[3]).toBe("src/other.ts"));
    await waitFor(() => expect(inlineRow()).toBeNull());
    const away = await screen.findByText(/1 条意见草稿未保存：src\/app\.ts/);
    expect(commentDraftCount(REVIEW)).toBe(1);

    await fireEvent.click(within(away.closest(".review-draft-away")! as HTMLElement).getByRole("button", { name: "继续编辑" }));
    const row = await waitFor(() => {
      const found = inlineRow();
      expect(found).toBeTruthy();
      return found!;
    });
    expect(textbox(row).value).toBe("跨文件保留的草稿");
    expect(row.dataset.inlineAfter).toBe("3");
  });

  it("切换到连续阅读再回来、切换来源再切回：草稿都还在", async () => {
    await mount();
    await fireEvent.click(bubble(3));
    await fireEvent.input(textbox(inlineRow()!), { target: { value: "跨视图与来源" } });
    await waitFor(() => expect(commentDraft(REVIEW)?.body).toBe("跨视图与来源"));

    await fireEvent.click(screen.getByRole("button", { name: "连续" }));
    await fireEvent.click(screen.getByRole("button", { name: "单文件" }));
    await waitFor(() => expect(textbox(inlineRow()!).value).toBe("跨视图与来源"));

    workbenchId = OTHER_REVIEW;
    nonce += 1;
    await sync();
    await waitFor(() => expect(inlineRow()).toBeNull());
    expect(commentDraft(REVIEW)?.body).toBe("跨视图与来源");
    workbenchId = REVIEW;
    nonce += 1;
    await sync();
    await waitFor(() => expect(textbox(inlineRow()!).value).toBe("跨视图与来源"));
  });

  it("在另一行新开草稿会丢掉写了内容的草稿：先确认，取消则原样保留", async () => {
    await mount();
    await fireEvent.click(bubble(3));
    await fireEvent.input(textbox(inlineRow()!), { target: { value: "第 3 行的草稿" } });
    await fireEvent.click(bubble(5));
    const dialog = await screen.findByRole("dialog", { name: "放弃未保存的意见草稿？" });
    await fireEvent.click(within(dialog).getByRole("button", { name: "继续编辑草稿" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "放弃未保存的意见草稿？" })).toBeNull());
    expect(inlineRow()!.dataset.inlineAfter).toBe("3");
    expect(textbox(inlineRow()!).value).toBe("第 3 行的草稿");

    await fireEvent.click(bubble(5));
    await fireEvent.click(within(await screen.findByRole("dialog", { name: "放弃未保存的意见草稿？" })).getByRole("button", { name: "放弃草稿并继续" }));
    await waitFor(() => expect(inlineRow()!.dataset.inlineAfter).toBe("5"));
    expect(textbox(inlineRow()!).value).toBe("");
  });

  it("草稿槽里的草稿在挂载时恢复到原位", async () => {
    setCommentDraft(REVIEW, { anchor: anchorAt(4), body: "上次没写完", editingId: null });
    await mount();
    const row = await waitFor(() => {
      const found = inlineRow();
      expect(found).toBeTruthy();
      return found!;
    });
    expect(row.dataset.inlineAfter).toBe("4");
    expect(textbox(row).value).toBe("上次没写完");
  });
});

/* ------------------------------ 来源级关卡 ------------------------------ */

describe("切换来源、返回 Cliora、送回意见前的草稿关卡", () => {
  const A = REVIEW;
  const B = OTHER_REVIEW;

  function host(overrides: Partial<ReviewActionsHost> = {}): ReviewActionsHost & { confirmCommentDraft: ReturnType<typeof vi.fn> } {
    return {
      opened: () => opened,
      taskScope: () => null,
      taskTarget: () => null,
      commentScope: () => scopeFor(A),
      commentScopeOutdated: () => false,
      nextId: () => 1,
      notice: vi.fn(),
      showError: vi.fn(),
      setReviewNote: vi.fn(),
      setTaskReviewNote: vi.fn(),
      confirmEditorLeave: async () => true,
      refresh: async () => true,
      switchBlocked: () => false,
      openRecent: async () => undefined,
      openTaskReview: vi.fn(),
      closeTask: vi.fn(),
      closeReviewManager: vi.fn(),
      clearSourcesNotice: vi.fn(),
      confirmCommentDraft: vi.fn(async () => false),
      ...overrides,
    } as ReviewActionsHost & { confirmCommentDraft: ReturnType<typeof vi.fn> };
  }

  beforeEach(() => {
    beginClioraReview({ reviewId: B, sessionId: "s-b", worktreePath: WORKTREE, baseline: BASE });
    beginClioraReview({ reviewId: A, sessionId: "s-a", worktreePath: WORKTREE, baseline: BASE });
    mocks.api.clioraReviewSources.mockResolvedValue(null);
    mocks.api.clioraReviewReturn.mockResolvedValue(undefined);
    mocks.api.prepareReviewFeedback.mockResolvedValue({ feedbackId: "f".repeat(32), digest: "a".repeat(64), commentCount: 1, url: "cliora://x" });
  });

  it("没有草稿时不拦截", async () => {
    const h = host();
    const actions = createReviewActions(h);
    await actions.chooseClioraReview(B);
    expect(h.confirmCommentDraft).not.toHaveBeenCalled();
    expect(clioraReview.source?.reviewId).toBe(B);
  });

  it("切换来源：有草稿先确认，取消则停在当前来源，草稿保留；确认后切换，草稿仍留在原来源", async () => {
    setCommentDraft(A, { anchor: anchorAt(3), body: "A 的草稿", editingId: null });
    const h = host();
    const actions = createReviewActions(h);
    await actions.chooseClioraReview(B);
    expect(h.confirmCommentDraft).toHaveBeenCalledWith("switch");
    expect(clioraReview.source?.reviewId).toBe(A);
    expect(h.openTaskReview).not.toHaveBeenCalled();

    h.confirmCommentDraft.mockResolvedValue(true);
    await actions.chooseClioraReview(B);
    expect(clioraReview.source?.reviewId).toBe(B);
    expect(commentDraft(A)?.body).toBe("A 的草稿");
  });

  it("返回 Cliora：有草稿先确认，取消则不返回、状态复原", async () => {
    setCommentDraft(A, { anchor: anchorAt(3), body: "A 的草稿", editingId: null });
    const h = host();
    const actions = createReviewActions(h);
    await actions.returnToCliora();
    expect(h.confirmCommentDraft).toHaveBeenCalledWith("return");
    expect(mocks.api.clioraReviewReturn).not.toHaveBeenCalled();
    expect(actions.returnOf(A)).toEqual({ state: "idle" });
    expect(actions.returning).toBe(false);

    h.confirmCommentDraft.mockResolvedValue(true);
    await actions.returnToCliora();
    expect(mocks.api.clioraReviewReturn).toHaveBeenCalledTimes(1);
    expect(commentDraft(A)?.body).toBe("A 的草稿");
  });

  it("送回意见：有草稿先确认，取消则不准备；确认后只送出已保存的意见", async () => {
    const live = scopeFor(A);
    adoptCommentScope(live);
    addComment(live, anchorAt(5), "已保存的意见");
    setCommentDraft(A, { anchor: anchorAt(3), body: "没保存的草稿", editingId: null });
    const h = host({ commentScope: () => live });
    const actions = createReviewActions(h);
    await actions.prepareFeedback();
    expect(h.confirmCommentDraft).toHaveBeenCalledWith("feedback");
    expect(mocks.api.prepareReviewFeedback).not.toHaveBeenCalled();
    expect(actions.feedbackPreparing).toBe(false);

    h.confirmCommentDraft.mockResolvedValue(true);
    await actions.prepareFeedback();
    expect(mocks.api.prepareReviewFeedback).toHaveBeenCalledTimes(1);
    const sent = mocks.api.prepareReviewFeedback.mock.calls[0][0] as { comments: { body: string }[] };
    expect(sent.comments.map((comment) => comment.body)).toEqual(["已保存的意见"]);
    expect(commentDraft(A)?.body).toBe("没保存的草稿");
  });
});
