/**
 * 来源菜单与关闭保护（R7）：人类可读的来源信息、详情折叠、含未送回意见或草稿时二次确认、
 * 取消后原样保留、无意见时轻量关闭、关闭不自动选择其他来源、已准备送回的意见不再拦截。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clioraReview, resetClioraReview } from "../src/lib/cliora-review.svelte";
import { resetReviewProgress } from "../src/lib/review-progress.svelte";
import { commentDraftCount, resetReviewComments } from "../src/lib/review-comments.svelte";
import { resetReviewWorkbench } from "../src/lib/review-workbench.svelte";
import {
  BASELINE,
  BASELINE_B,
  REVIEW_A,
  REVIEW_B,
  SESSION_A,
  WORKTREE,
  activeViewId,
  completionAction,
  composeComment,
  openSourceMenu,
  resetShellMocks,
  reviewUrl,
  selectedTaskPath,
  workbench,
} from "./helpers/review-shell";

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
