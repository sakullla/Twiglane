/**
 * 顶级「审查」视图（R1、R2）：深链直接进入工作台、视图切换保留阅读状态、各整页状态的原因与动作。
 *
 * 外壳与 api 都用模块 mock；协议解析与来源校验在 Rust 侧与 cliora-integration.spec 覆盖，
 * 这里只盯工作台的信息架构与失败边界：不借历史入口、不用 HEAD 补缺、不伪造空任务。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clioraReview, resetClioraReview } from "../src/lib/cliora-review.svelte";
import { resetReviewProgress } from "../src/lib/review-progress.svelte";
import { resetReviewComments } from "../src/lib/review-comments.svelte";
import { resetReviewWorkbench } from "../src/lib/review-workbench.svelte";
import {
  BASELINE,
  BASELINE_B,
  REVIEW_A,
  REVIEW_B,
  SESSION_A,
  SESSION_B,
  WORKTREE,
  activeViewId,
  completionAction,
  openSourceMenu,
  resetShellMocks,
  reviewUrl,
  selectedTaskPath,
  switchView,
  switcherItem,
  taskFor,
  taskRow,
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

  it("来源失效：返回被原生拒绝为 source_expired 后，工作台说明原因并提供关闭此来源", async () => {
    mocks.api.clioraReviewReturn.mockRejectedValueOnce({ code: "source_expired", message: "审查来源不存在。" });
    await coldStart(reviewUrl(REVIEW_A, SESSION_A, BASELINE));
    await waitFor(() => expect(completionAction("return")).toBeTruthy());
    await fireEvent.click(completionAction("return")!);
    const title = await within(workbench()!).findByText("审查来源已失效", {}, { timeout: 8000 });
    const state = title.closest<HTMLElement>(".review-state")!;
    // 稳定错误与诊断放在详情里，首先说用户能做什么。
    expect(state.textContent).toContain("重新发起");
    await fireEvent.click(within(state).getByRole("button", { name: "关闭此来源" }));
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_A, SESSION_A));
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
