/**
 * cliora 审查集成（Twiglane 接收端）：链接打开、接收回执、来源返回与竞态。
 *
 * 协议解析在 Rust 侧（cliora.rs 的单测覆盖字段与错误码），这里盯的是外壳接线：
 * 只打开链接指定的 worktree、accepted/rejected 的时机、返回时携带的结果、独立仓库
 * 没有来源。deep-link 插件用模块 mock 顶替，冷启动取 getCurrent，运行中走 onOpenUrl。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clioraReview, clioraBaseline, recordClioraCommit, resetClioraReview } from "../src/lib/cliora-review.svelte";
import { resetReviewProgress } from "../src/lib/review-progress.svelte";
import { resetReviewComments } from "../src/lib/review-comments.svelte";
import type { DiffLine, DiffResponse, FileChange, StatusSnapshot } from "../src/lib/types";

const WORKTREE = "C:/work/代码 demo";
const OTHER_WORKTREE = "C:/work/other";
const REVIEW_A = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
const REVIEW_B = "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
const SESSION_A = "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0";
const SESSION_B = "2c3d4e5f-6071-4283-94a5-b6c7d8e9f0a1";
const BASELINE = "a".repeat(40);
const COMMITTED = "b".repeat(40);
const URL_A = "twiglane://review?v=2&reviewId=" + REVIEW_A + "&sessionId=" + SESSION_A + "&worktreePath=" + encodeURIComponent(WORKTREE) + "&baseline=" + BASELINE;
const URL_B = "twiglane://review?v=2&reviewId=" + REVIEW_B + "&sessionId=" + SESSION_B + "&worktreePath=" + encodeURIComponent(WORKTREE);
const WORKSPACE_HOST = "11111111-1111-4111-8111-111111111111";
const LINKED_PROJECT = "深链预览项目";
const LINKED_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const LINKED_MEMBER = "33333333-3333-4333-8333-000000000000";
const LINKED_MEMBER_PATH = "/work/team/commerce";
const LINKED_SOURCE = "/work/shared.dev-workspace.json";
/** v2 项目清单链接：清单路径与来源仓库 ID 缺一不可，由 Rust 侧严格解析。 */
const WORKSPACE_URL = "twiglane://workspace?v=2&file=" + encodeURIComponent(LINKED_SOURCE) + "&repository=" + LINKED_MEMBER;

/** `attached` 由后端按本机名单与清单内容是否一致给出：一致就不再要求确认关联。 */
function linkedPreview(attached: boolean) {
  return {
    path: LINKED_SOURCE,
    digest: "digest-1",
    conflict: false,
    sourceRepositoryId: LINKED_MEMBER,
    attached,
    manifest: {
      schemaVersion: 1 as const,
      workspaceId: LINKED_WORKSPACE,
      name: LINKED_PROJECT,
      revision: 1,
      repositories: [{ id: LINKED_MEMBER, name: "commerce", locations: [{ hostId: WORKSPACE_HOST, path: LINKED_MEMBER_PATH }] }],
    },
  };
}

function workspaceProject(digest: string) {
  const manifest = linkedPreview(false).manifest;
  return { manifest, sourcePath: LINKED_SOURCE, digest, error: null, favorites: [], bindings: {} };
}

/**
 * 前端交给后端的返回参数：只有 Git outcome。工作区状态由后端按来源工作树读取真实 Git
 * 状态填写（src-tauri 的单测覆盖），前端不声明。
 */
function returned(
  reviewId: string,
  sessionId: string,
  outcome: "reviewed" | "committed" | "merged",
  headOid: string | null,
): [string, string, "reviewed" | "committed" | "merged", string | null] {
  return [reviewId, sessionId, outcome, headOid];
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
  const lines: DiffLine[] = [{ kind: "context", text: " row", oldNo: 1, newNo: 1, hunkIndex: 0 }];
  return {
    generation: 4,
    path,
    staged: false,
    binary: false,
    text: null,
    summary: "1 行上下文。",
    additions: 0,
    deletions: 0,
    complete: true,
    truncated: false,
    snapshot: "snap",
    hunks: [{ index: 0, header: "@@ -1,1 +1,1 @@", complete: true, stageable: true, startLine: 0, lineCount: 1 }],
    lines,
    offset: 0,
    totalLines: 1,
  };
}

/** 任务范围夹具：链接自带的起点就是 baseline，HEAD 仍是当前 HEAD。 */
function taskFor(baseline: string) {
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
    files: [
      {
        path: "src/a.ts",
        originalPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
        oldSize: null,
        newSize: null,
        untracked: false,
        unmerged: false,
      },
    ],
    filesTotal: 1,
    filesTruncated: false,
    additions: 1,
    deletions: 0,
    dirty: true,
    untrackedFiles: 0,
    conflicted: false,
    empty: false,
    rangeVersion: `range-${baseline}`,
    message: "读取成功：起点之后 0 个提交，最终净改动 1 个文件。",
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
  return {
    api,
    created,
    listenEvent: vi.fn(),
    pickDirectory: vi.fn(),
    pickFile: vi.fn(),
  };
});

const deepLink = vi.hoisted(() => ({
  getCurrent: vi.fn(async (): Promise<string[] | null> => null),
  onOpenUrl: vi.fn(async (_handler: (urls: string[]) => void) => () => {}),
}));

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: deepLink.getCurrent,
  onOpenUrl: deepLink.onOpenUrl,
}));

vi.mock("../src/lib/api", () => ({
  api: mocks.api,
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));

import App from "../src/App.svelte";
import { remoteReviewPort as reviews } from "../src/lib/remote-worktree";


function resetMocks() {
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
  mocks.api.getSettings.mockResolvedValue({
    theme: "dark",
    panelWidths: { sidebar: 256, files: 360 },
    git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" },
    recent: [{ name: "demo", path: "C:/work/demo", openedAtMs: 1 }],
    settingsWarning: null,
  });
  mocks.api.detectGit.mockResolvedValue({ available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" });
  mocks.api.cancelReads.mockResolvedValue(undefined);
  mocks.api.saveDraft.mockResolvedValue(undefined);
  mocks.api.setTheme.mockResolvedValue(undefined);
  mocks.api.setPanelWidths.mockImplementation(async (widths: unknown) => widths);
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
  mocks.api.clioraReviewRequest.mockResolvedValue({
    reviewId: REVIEW_A,
    sessionId: SESSION_A,
    worktreePath: WORKTREE,
    baseline: BASELINE,
  });
  mocks.api.clioraReviewSources.mockResolvedValue(null);
  mocks.api.clioraReviewReceipt.mockResolvedValue(undefined);
  mocks.api.clioraReviewReturn.mockResolvedValue(undefined);
  // 审阅进度只影响本地标记，不参与协议结果。
  mocks.api.repositoryReviewToken.mockResolvedValue({
    generation: 4,
    path: "src/a.ts",
    state: "current",
    token: "token-src-a",
    staged: "none",
    unstaged: "modified",
    untracked: false,
    unmerged: false,
    contentVersion: "worktree:abc",
    message: "已确认这个文件当前的整份内容与改动。",
  });
}

beforeEach(() => {
  resetMocks();
  resetClioraReview();
  resetReviewProgress();
  resetReviewComments();
});

afterEach(() => {
  cleanup();
  resetClioraReview();
  resetReviewComments();
});

/** 等到外壳注册好 deep link 监听，返回运行中链接的处理函数。 */
async function mountShell() {
  render(App);
  await waitFor(() => expect(deepLink.onOpenUrl).toHaveBeenCalledTimes(1));
  const handler = deepLink.onOpenUrl.mock.calls[0][0] as (urls: string[]) => void;
  return handler;
}

/** 当前可见视图（切换条上 aria-current 的那一项）。 */
function activeViewId(): string | null {
  return document.querySelector<HTMLElement>('.workbench-view[data-active="true"] [aria-current="page"]')?.getAttribute("data-view") ?? null;
}

/** 从起始页打开最近仓库（夹具里 openRepository 决定实际打开哪个工作树）。 */
async function openRecentRepo() {
  await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
  await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
  await waitFor(() => expect(document.querySelector('.workbench-view[data-active="true"] nav[aria-label="视图"]')).toBeTruthy());
}

/** 进入审查视图：深链建立来源后外壳已经在这里；恢复的来源从切换条的「审查」进入。 */
async function openReviewView() {
  if (activeViewId() !== "review") {
    const button = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.workbench-view[data-active="true"] nav[aria-label="视图"] [data-view="review"]');
      if (!found) throw new Error("切换条上没有审查项");
      return found;
    });
    await fireEvent.click(button);
  }
  await waitFor(() => expect(activeViewId()).toBe("review"));
}

/** 审查工作台底部完成栏里的动作按钮（送回意见 / 返回 Cliora）。 */
function completionAction(id: "feedback" | "return"): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`.workbench-view[data-active="true"] .review-completion [data-completion-action="${id}"]`);
}

/** 返回入口只在完成栏：先进入审查视图，再点完成栏的「返回 Cliora」。 */
async function clickReturn() {
  await openReviewView();
  const button = await waitFor(() => {
    const found = completionAction("return");
    if (!found) throw new Error("完成栏没有返回入口");
    return found;
  });
  await fireEvent.click(button);
}

/** 打开来源卡上的来源菜单。 */
async function openSourceMenu(): Promise<HTMLElement> {
  await openReviewView();
  await fireEvent.click(await screen.findByRole("button", { name: "选择 Cliora 审查来源" }));
  return screen.findByRole("dialog", { name: "审查来源" });
}

/** 在来源菜单里切换到指定来源。 */
async function pickSource(reviewId: string) {
  const menu = await openSourceMenu();
  const row = menu.querySelector<HTMLButtonElement>(`[data-review-source-id="${reviewId}"] .review-source-switch`);
  if (!row) throw new Error(`来源菜单里没有 ${reviewId}`);
  await fireEvent.click(row);
}

/** 读出来源菜单里的全部来源，再按 Esc 收起。 */
async function sourceMenuIds(): Promise<string[]> {
  const menu = await openSourceMenu();
  const ids = [...menu.querySelectorAll<HTMLElement>("[data-review-source-id]")].map((node) => node.dataset.reviewSourceId ?? "");
  await fireEvent.keyDown(window, { key: "Escape" });
  return ids;
}

describe("cliora v2 审查链接", () => {
  it("冷启动只打开链接指定的 worktree 并回送 accepted", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE));

    await mountShell();

    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenCalledWith(WORKTREE, expect.any(Number)));
    expect(mocks.api.openRepository).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_A, SESSION_A, true, null));
    expect(mocks.api.clioraReviewRequest).toHaveBeenCalledWith(URL_A);
    // 链接只能请求打开仓库：没有暂存、提交或合入调用。
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
    expect(mocks.api.startMerge).not.toHaveBeenCalled();
    // 来源建立后外壳进入审查工作台，返回入口在底部完成栏（标题栏不再有返回按钮）。
    await waitFor(() => expect(activeViewId()).toBe("review"));
    await waitFor(() => expect(completionAction("return")).toBeTruthy());
    expect(document.querySelector(".titlebar .cliora-return")).toBeNull();
  });

  it("同一 reviewId 被冷启动与热启动各派发一次时只处理一次", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE));

    const handle = await mountShell();
    // 冷启动那次已经在处理；同一条 URL 再从运行中事件来一次。
    handle([URL_A]);

    await waitFor(() => expect(mocks.api.clioraReviewRequest).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledTimes(1));
    expect(mocks.api.openRepository).toHaveBeenCalledTimes(1);
    expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_A, SESSION_A, true, null);
    // 来源只建立一次：返回入口只有一个，返回事件也只发一次。
    await waitFor(() => expect(screen.getAllByRole("button", { name: "返回 Cliora" })).toHaveLength(1));
    await fireEvent.click(screen.getByRole("button", { name: "返回 Cliora" }));
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledTimes(1));
  });
  it("运行中链接串行建立多个来源，最后来源活动且能显式切回", async () => {
    let finishFirst!: (value: unknown) => void;
    mocks.api.openRepository
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(openedAt(WORKTREE));
    mocks.api.clioraReviewRequest.mockImplementation(async (url: string) =>
      url === URL_A
        ? { reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE }
        : { reviewId: REVIEW_B, sessionId: SESSION_B, worktreePath: WORKTREE, baseline: null },
    );

    const handle = await mountShell();
    handle([URL_A]);
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenCalledTimes(1));
    handle([URL_B]);
    expect(mocks.api.openRepository).toHaveBeenCalledTimes(1);
    finishFirst(openedAt(WORKTREE));
    await waitFor(() => expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledTimes(2));
    expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_A, SESSION_A, true, null);
    expect(clioraReview.sources).toHaveLength(2);
    await pickSource(REVIEW_A);
    await waitFor(() => expect(clioraBaseline()).toBe(BASELINE));
    await pickSource(REVIEW_B);
    await waitFor(() => expect(clioraBaseline()).toBeNull());

    await clickReturn();
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_B, SESSION_B, "reviewed", null)));
  });

  it("打开失败回送 rejected，不回退主仓库也不写 Git", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockRejectedValue({ code: "not_repository", message: "该目录不是 Git 仓库，未做任何修改。" });

    await mountShell();

    await waitFor(() => expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_A, SESSION_A, false, "not_a_worktree"));
    expect(mocks.api.openRepository).toHaveBeenCalledTimes(1);
    expect(mocks.api.openRepository).toHaveBeenCalledWith(WORKTREE, expect.any(Number));
    expect(screen.queryByRole("button", { name: "返回 Cliora" })).toBeNull();
    expect(document.querySelector('[data-view="review"]')).toBeNull();
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
    expect(mocks.api.refreshStatus).not.toHaveBeenCalled();
  });

  it("路径失效按 invalid_path 拒绝，取消读取也回送 rejected", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockRejectedValue({ code: "invalid_path", message: "路径无效。" });
    const handle = await mountShell();
    await waitFor(() => expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_A, SESSION_A, false, "invalid_path"));

    // 重新发起是一次新的 reviewId：同一 reviewId 的重复链接只处理一次，这里用 URL_B。
    mocks.api.clioraReviewReceipt.mockClear();
    mocks.api.openRepository.mockRejectedValue({ code: "cancelled", message: "已取消读取。" });
    mocks.api.clioraReviewRequest.mockResolvedValue({
      reviewId: REVIEW_B,
      sessionId: SESSION_B,
      worktreePath: WORKTREE,
      baseline: null,
    });
    handle([URL_B]);
    await waitFor(() => expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_B, SESSION_B, false, "open_failed"));
  });

  it("旧链接的打开失败只回送自己的 rejected，不回退新链接的来源", async () => {
    let failFirst!: (reason: unknown) => void;
    mocks.api.openRepository
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockResolvedValue(openedAt(WORKTREE));
    mocks.api.clioraReviewRequest.mockImplementation(async (url: string) =>
      url === URL_A
        ? { reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE }
        : { reviewId: REVIEW_B, sessionId: SESSION_B, worktreePath: WORKTREE, baseline: null },
    );

    const handle = await mountShell();
    handle([URL_A]);
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenCalledTimes(1));
    handle([URL_B]);
    expect(mocks.api.openRepository).toHaveBeenCalledTimes(1);

    // 旧链接此时才失败：它自己的 reviewId 收到 rejected，但界面与来源仍是新链接的。
    failFirst({ code: "path_missing", message: "路径不存在，未创建或修改任何文件。" });
    await waitFor(() =>
      expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_A, SESSION_A, false, "invalid_path"),
    );
    await waitFor(() => expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_B, SESSION_B, true, null));
    expect(mocks.api.clioraReviewReceipt).not.toHaveBeenCalledWith(REVIEW_B, SESSION_B, false, expect.anything());
    await clickReturn();
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_B, SESSION_B, "reviewed", null)));
  });

  it("无效链接不打开仓库，也不伪造回执", async () => {
    deepLink.getCurrent.mockResolvedValue(["twiglane://review?v=1&reviewId=x"]);
    mocks.api.clioraReviewRequest.mockRejectedValue({ code: "unsupported_version", message: "只支持 v2 审查链接。" });

    await mountShell();

    await waitFor(() => expect(mocks.api.clioraReviewRequest).toHaveBeenCalledWith("twiglane://review?v=1&reviewId=x"));
    expect(mocks.api.openRepository).not.toHaveBeenCalled();
    expect(mocks.api.clioraReviewReceipt).not.toHaveBeenCalled();
    expect(mocks.api.clioraReviewReturn).not.toHaveBeenCalled();
  });

  it("返回 cliora 携带最新提交结果，且返回本身不触发 Git 写入", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE));
    await mountShell();
    await waitFor(() => expect(completionAction("return")).toBeTruthy());

    // 提交成功的记录发生在 api.ts 的成功边界（tests/api.spec.ts 覆盖）；这里写入同一条
    // 内存态记录，验证标题栏结果、完成栏的 Git 结果分项与返回链接的内容。
    recordClioraCommit(WORKTREE, COMMITTED);
    await waitFor(() => expect(screen.getByText("已提交 " + COMMITTED.slice(0, 7))).toBeTruthy());
    expect(document.querySelector('.review-completion [data-status="git"]')?.textContent).toContain("已提交 " + COMMITTED.slice(0, 7) + "（待复核）");

    mocks.api.commitChanges.mockClear();
    await clickReturn();
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_A, SESSION_A, "committed", COMMITTED)));
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
    expect(mocks.api.startMerge).not.toHaveBeenCalled();
    expect(mocks.api.completeMerge).not.toHaveBeenCalled();
  });

  it("提交区修订成功更新快照，普通提交草稿保持不变", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE));
    await mountShell();
    await waitFor(() => expect(completionAction("return")).toBeTruthy());
    const nav = document.querySelector<HTMLElement>('.workbench-view[data-active="true"] nav[aria-label="视图"]')!;
    await fireEvent.click(within(nav).getByRole("button", { name: /^改动/ }));
    const draft = (await screen.findByLabelText("提交说明草稿")) as HTMLTextAreaElement;
    await fireEvent.input(draft, { target: { value: "普通提交草稿" } });

    const preview = {
      generation: 4,
      code: "ok",
      eligible: true,
      wrote: false,
      headOid: BASELINE,
      parentOid: "c".repeat(40),
      summary: "旧说明",
      message: "旧说明\n\n完整正文",
      files: [{ path: "src/a.ts", originalPath: null, status: "modified", additions: 1, deletions: 0 }],
      stagedPaths: ["src/a.ts"],
      stagedToken: "f".repeat(64),
      note: "预览",
      snapshot,
    };
    const amendedSnapshot: StatusSnapshot = {
      ...snapshot,
      generation: 5,
      branch: { ...branch, headOid: COMMITTED },
      files: [
        ...changes,
        { path: "src/b.ts", originalPath: null, staged: "none", unstaged: "modified", untracked: false, unmerged: false },
      ],
    };
    const done = {
      ...preview,
      generation: 5,
      wrote: true,
      headOid: COMMITTED,
      summary: "新说明",
      message: "新说明",
      note: "已用新的修订提交替换最近提交。没有推送。",
      snapshot: amendedSnapshot,
    };
    mocks.api.amendCommit.mockResolvedValueOnce(preview).mockResolvedValueOnce(done);

    await fireEvent.click(screen.getByRole("button", { name: "更多提交操作" }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "修订最近提交" }));
    const dialog = await screen.findByRole("dialog", { name: "修订最近提交" });
    expect(mocks.api.amendCommit).toHaveBeenCalledWith(WORKTREE, BASELINE, null, false, null, false, 4, expect.any(Number));
    expect((within(dialog).getByLabelText("修订后的提交说明") as HTMLTextAreaElement).value).toBe("旧说明\n\n完整正文");
    await fireEvent.input(within(dialog).getByLabelText("修订后的提交说明"), { target: { value: "新说明" } });
    await fireEvent.click(within(dialog).getByRole("button", { name: "确认修订提交" }));
    await waitFor(() =>
      expect(mocks.api.amendCommit).toHaveBeenLastCalledWith(
        WORKTREE,
        BASELINE,
        "新说明",
        false,
        "f".repeat(64),
        true,
        4,
        expect.any(Number),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "修订最近提交" })).toBeNull());
    expect((screen.getByLabelText("提交说明草稿") as HTMLTextAreaElement).value).toBe("普通提交草稿");
    await waitFor(() => expect(document.querySelector('.file-row[title="src/b.ts"]')).toBeTruthy());
  });

  it("全部文件标记已审阅后仍返回 reviewed，不出现批准", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE));
    await mountShell();
    await waitFor(() => expect(completionAction("return")).toBeTruthy());

    // 链接带起点：外壳进入审查工作台读取「任务净差异」（只读）。这里改到改动视图里做审阅标记。
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledWith(WORKTREE, BASELINE, expect.any(Number), expect.any(Number)));
    const nav = document.querySelector<HTMLElement>('.workbench-view[data-active="true"] nav[aria-label="视图"]')!;
    await fireEvent.click(within(nav).getByRole("button", { name: /^改动/ }));
    await waitFor(() => expect(document.querySelector('.workbench-view[data-active="true"] .file-list')).toBeTruthy());
    const list = document.querySelector<HTMLElement>('.workbench-view[data-active="true"] .file-list');
    expect(list).toBeTruthy();
    await fireEvent.click(await within(list!).findByRole("button", { name: "标记 src/a.ts 已审阅" }));
    await waitFor(() => expect(screen.getByLabelText("已审阅 1 个，共 1 个改动文件")).toBeTruthy());

    await clickReturn();
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_A, SESSION_A, "reviewed", null)));
    expect(document.body.textContent).not.toContain("已批准");
    expect(document.body.textContent).not.toContain("approved");
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
    expect(mocks.api.startMerge).not.toHaveBeenCalled();
    expect(mocks.api.completeMerge).not.toHaveBeenCalled();
  });

  it("带起点的链接直接进入审查工作台并显示首个文件差异；没有起点时进入「无起点」状态，不用 HEAD 补缺", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE));
    mocks.api.taskReview.mockResolvedValue(taskFor(BASELINE));
    mocks.api.loadTaskDiff.mockImplementation(async (_worktree: string, _base: string, _head: string, path: string) => diffFor(path));
    await mountShell();

    // 有已校验起点：外壳进入审查视图，按链接给的 baseline 读取任务并选中首个文件读取差异。
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledWith(WORKTREE, BASELINE, expect.any(Number), expect.any(Number)));
    await waitFor(() => expect(activeViewId()).toBe("review"));
    const context = await screen.findByRole("group", { name: "任务范围" });
    expect(context.textContent).toContain(BASELINE.slice(0, 7));
    await waitFor(() => expect(mocks.api.loadTaskDiff).toHaveBeenCalledWith(WORKTREE, BASELINE, BASELINE, "src/a.ts", expect.anything(), expect.anything(), null, 0, 0, undefined, false));
    // 历史里不再出现任务净差异行。
    expect(screen.queryByRole("button", { name: /任务净差异/ })).toBeNull();

    // 没有起点的链接：不建立范围、不猜 HEAD，工作台停在「无起点」并给出两个动作。
    resetClioraReview();
    mocks.api.taskReview.mockClear();
    mocks.api.clioraReviewRequest.mockResolvedValue({
      reviewId: REVIEW_B,
      sessionId: SESSION_B,
      worktreePath: WORKTREE,
      baseline: null,
    });
    deepLink.getCurrent.mockResolvedValue([URL_B]);
    cleanup();
    await mountShell();
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenCalledWith(WORKTREE, expect.any(Number)));
    await screen.findByText("没有任务范围");
    expect(activeViewId()).toBe("review");
    expect(mocks.api.taskReview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "查看普通历史" })).toBeTruthy();
    expect(document.querySelector('.review-state [data-review-state-action="return"]')).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "查看普通历史" }));
    await waitFor(() => expect(activeViewId()).toBe("history"));
    await waitFor(() => expect(mocks.api.historyPage).toHaveBeenCalled(), { timeout: 8000 });
    // 普通历史不按任务范围过滤，也没有任务行。
    expect(mocks.api.historyPage.mock.calls.every((call) => !(call[5] as { scope?: string } | undefined)?.scope?.startsWith("range:"))).toBe(true);
    expect(screen.queryByRole("button", { name: /任务净差异/ })).toBeNull();
    expect(mocks.api.taskReview).not.toHaveBeenCalled();
  });

  it("提示按后端实际发送的工作区状态说明：干净、提交后仍有剩余修改分别如实提示", async () => {
    const clean: StatusSnapshot = { generation: 4, branch, files: [] };
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue({ ...openedAt(WORKTREE), snapshot: clean });
    mocks.api.refreshStatus.mockResolvedValue(clean);
    mocks.api.clioraReviewReturn.mockResolvedValue({ worktreeState: "clean", uncommitted: 0 });
    await mountShell();
    await waitFor(() => expect(completionAction("return")).toBeTruthy());

    await clickReturn();
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_A, SESSION_A, "reviewed", null)));
    await waitFor(() => expect(document.body.textContent).toContain("本次没有提交或合入，工作区没有未提交的改动"));

    // 提交之后又留下未提交修改：outcome 仍是真实的提交，工作区状态来自后端读到的 dirty。
    mocks.api.clioraReviewReturn.mockClear();
    mocks.api.clioraReviewReturn.mockResolvedValue({ worktreeState: "dirty", uncommitted: 2 });
    recordClioraCommit(WORKTREE, COMMITTED);
    await clickReturn();
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_A, SESSION_A, "committed", COMMITTED)));
    await waitFor(() => expect(document.body.textContent).toContain("提交或合入结果以待复核声明发送，工作区还有 2 个未提交的改动"));
    expect(document.body.textContent).not.toContain("本次只做了浏览");
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
  });

  it("返回后再提交：完成栏显示实时工作区计数，返回时的快照只在详情里标为「上次返回时」", async () => {
    const dirty3: StatusSnapshot = {
      generation: 4,
      branch,
      files: [changes[0], { ...changes[0], path: "src/b.ts" }, { ...changes[0], path: "src/c.ts" }],
    };
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue({ ...openedAt(WORKTREE), snapshot: dirty3 });
    mocks.api.refreshStatus.mockResolvedValue(dirty3);
    mocks.api.clioraReviewReturn.mockResolvedValue({ worktreeState: "dirty", uncommitted: 3 });
    await mountShell();
    await waitFor(() => expect(completionAction("return")).toBeTruthy());
    const worktreeItem = () => document.querySelector('.review-completion [data-status="worktree"]')?.textContent ?? "";
    await waitFor(() => expect(worktreeItem()).toBe("工作区还有 3 个未提交的改动"));

    await clickReturn();
    await waitFor(() => expect(document.querySelector('.review-completion [data-status="return"]')?.textContent).toContain("已返回 Cliora（第 1 次）"));

    // 返回之后在 Twiglane 里提交了两个文件：工作区只剩 1 个未提交改动。
    const dirty1: StatusSnapshot = { generation: 5, branch, files: [changes[0]] };
    mocks.api.refreshStatus.mockResolvedValue(dirty1);
    const changed = mocks.listenEvent.mock.calls.find(([name]) => name === "repo-changed")![1] as (event: {
      path: string;
      generation: number;
      degraded: boolean;
    }) => void;
    changed({ path: WORKTREE, generation: 5, degraded: false });

    await waitFor(() => expect(worktreeItem()).toBe("工作区还有 1 个未提交的改动"), { timeout: 8000 });
    expect(document.querySelector(".review-completion")?.textContent).not.toContain("工作区还有 3 个未提交的改动");
    await fireEvent.click(document.querySelector<HTMLButtonElement>(".review-completion-more")!);
    await waitFor(() => expect(document.querySelector("#review-completion-details")?.textContent).toContain("上次返回时工作区有 3 个未提交的改动"));
    // 返回本身不写 Git。
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
  });

  it("路径不存在：提示先说原因与「回到 Cliora 重新发起」，原始 OS 诊断只在详情里", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    const raw = "无法解析路径，未修改文件。No such file or directory (os error 2)";
    mocks.api.openRepository.mockRejectedValue({ code: "path_unreadable", message: raw });
    await mountShell();
    await waitFor(() => expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_A, SESSION_A, false, "invalid_path"));

    const toast = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".toast.error");
      if (!found) throw new Error("没有错误提示");
      return found;
    });
    const text = toast.querySelector(".toast-text")!;
    const main = [...text.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("");
    expect(main).toContain("找不到或无法读取");
    expect(main).toContain("回到 Cliora 原会话");
    expect(main).not.toContain("os error");
    const details = toast.querySelector("details.toast-detail")!;
    expect(details).toBeTruthy();
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.textContent).toContain("No such file or directory (os error 2)");
    expect(document.querySelector('[data-view="review"]')).toBeNull();
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
  });

  it("前端快照不能替后端声明：本地看着干净，后端读到 dirty 时按 dirty 提示", async () => {
    const clean: StatusSnapshot = { generation: 4, branch, files: [] };
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue({ ...openedAt(WORKTREE), snapshot: clean });
    mocks.api.refreshStatus.mockResolvedValue(clean);
    mocks.api.clioraReviewReturn.mockResolvedValue({ worktreeState: "dirty", uncommitted: 1 });
    await mountShell();
    await waitFor(() => expect(completionAction("return")).toBeTruthy());

    await clickReturn();
    await waitFor(() => expect(document.body.textContent).toContain("本次没有提交或合入，工作区还有 1 个未提交的改动"));
    expect(document.body.textContent).not.toContain("本次没有提交或合入，工作区没有未提交的改动");
  });

  it("后端读不到工作区状态时如实说按未知发送；后端没给结果且本地也没读到时只说没读到", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue({ ...openedAt(WORKTREE), snapshot: { generation: 4, branch, files: [] } });
    mocks.api.clioraReviewReturn.mockResolvedValue({ worktreeState: "unknown", uncommitted: null });
    await mountShell();
    await waitFor(() => expect(completionAction("return")).toBeTruthy());

    await clickReturn();
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_A, SESSION_A, "reviewed", null)));
    await waitFor(() => expect(document.body.textContent).toContain("这次没有读到工作区状态，已按未知发送"));

    // 浏览器预览等没有后端结果的环境：返回前刷新也失败，就不能把旧快照当成干净。
    mocks.api.clioraReviewReturn.mockClear();
    mocks.api.clioraReviewReturn.mockResolvedValue(undefined);
    mocks.api.refreshStatus.mockRejectedValue({ code: "git_failed", message: "读取状态失败。" });
    await clickReturn();
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.body.textContent).toContain("本次没有提交或合入，这次没有读到工作区状态。"));
    expect(document.body.textContent).not.toContain("本次没有提交或合入，工作区没有未提交的改动");
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
  });

  it("失效路径的非活动来源无需打开即可明确关闭，当前来源仍保留", async () => {
    mocks.api.clioraReviewSources.mockResolvedValue({ sources: [
      { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE }, result: null, lastReturn: null },
      { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_B, sessionId: SESSION_B, worktreePath: OTHER_WORKTREE, baseline: COMMITTED }, result: null, lastReturn: null },
    ], expiredPending: 0 });
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE)); await mountShell();
    await openRecentRepo();
    expect(await sourceMenuIds()).toHaveLength(2);
    await pickSource(REVIEW_A);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_A));
    mocks.api.openRepository.mockRejectedValueOnce({ code: "path_missing", message: "B 目录失效" });
    await pickSource(REVIEW_B);
    await waitFor(() => expect(document.body.textContent).toContain("B 目录失效"));
    const menu = await openSourceMenu();
    await fireEvent.click(within(menu).getByRole("button", { name: `关闭审查来源 ${REVIEW_B.slice(0, 8)}` }));
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_B, SESSION_B));
    expect(clioraReview.source?.reviewId).toBe(REVIEW_A);
    expect(clioraReview.sources.map(source => source.reviewId)).toEqual([REVIEW_A]);
  });

  it("未选中的来源可在来源菜单直接关闭，不必先切换过去；关闭不自动选择其他来源", async () => {
    mocks.api.clioraReviewSources.mockResolvedValue({ sources: [
      { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE }, result: null, lastReturn: null },
      { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_B, sessionId: SESSION_B, worktreePath: OTHER_WORKTREE, baseline: COMMITTED }, result: null, lastReturn: null },
    ], expiredPending: 0 });
    mocks.api.openRepository.mockImplementation(async (path: string) => openedAt(path));
    await mountShell();
    await openRecentRepo();
    // 当前仓库不是任何来源的工作树：工作台说明「未选择审查来源」。
    await openReviewView();
    expect(screen.getByText("未选择审查来源", { selector: ".review-state-title" })).toBeTruthy();

    // 关掉一个后只剩一个、且没有选中：不必先切换过去，直接关闭（没有意见，不需要确认）。
    let menu = await openSourceMenu();
    await fireEvent.click(within(menu).getByRole("button", { name: `关闭审查来源 ${REVIEW_B.slice(0, 8)}` }));
    await waitFor(() => expect(clioraReview.sources.map((source) => source.reviewId)).toEqual([REVIEW_A]));
    expect(clioraReview.source).toBeNull();
    menu = await openSourceMenu();
    await fireEvent.click(within(menu).getByRole("button", { name: `关闭审查来源 ${REVIEW_A.slice(0, 8)}` }));
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_A, SESSION_A));
    await waitFor(() => expect(clioraReview.sources).toHaveLength(0));
    expect(screen.queryByRole("dialog", { name: "关闭审查来源" })).toBeNull();
    expect(mocks.api.openRepository).not.toHaveBeenCalledWith(WORKTREE, expect.anything());
    expect(mocks.api.openRepository).not.toHaveBeenCalledWith(OTHER_WORKTREE, expect.anything());
    // 没有来源后工作台如实说明，并给出回到改动/历史的动作。
    await screen.findByText("没有审查来源");
    expect(screen.getByRole("button", { name: "回到改动" })).toBeTruthy();
  });

  it("来源菜单的「关闭全部来源」关闭全部来源，审查条已经不存在", async () => {
    mocks.api.clioraReviewSources.mockResolvedValue({ sources: [
      { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE }, result: null, lastReturn: null },
      { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_B, sessionId: SESSION_B, worktreePath: OTHER_WORKTREE, baseline: COMMITTED }, result: null, lastReturn: null },
    ], expiredPending: 0 });
    mocks.api.openRepository.mockImplementation(async (path: string) => openedAt(path));
    await mountShell();
    await openRecentRepo();
    expect(document.querySelector(".review-strip")).toBeNull();
    const menu = await openSourceMenu();
    await fireEvent.click(within(menu).getByRole("button", { name: "关闭全部来源" }));
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_A, SESSION_A));
    expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_B, SESSION_B);
    await waitFor(() => expect(clioraReview.sources).toHaveLength(0));
    expect(clioraReview.source).toBeNull();
  });

  it("来源菜单支持点击条目切换、Esc 关闭归还焦点；切到其他视图再回到审查会重读任务；恢复提示可关闭", async () => {
    mocks.api.clioraReviewSources.mockResolvedValue({
      sources: [
        { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE }, result: null, lastReturn: null },
        { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_B, sessionId: SESSION_B, worktreePath: OTHER_WORKTREE, baseline: COMMITTED }, result: null, lastReturn: null },
      ],
      expiredPending: 0,
    });
    mocks.api.openRepository.mockImplementation(async (path: string) => openedAt(path));
    await mountShell();
    await openRecentRepo();
    await openReviewView();

    // 恢复提示在来源卡里，带可关闭按钮。
    const dismiss = await screen.findByRole("button", { name: "关闭审查提示" });
    await fireEvent.click(dismiss);
    expect(screen.queryByRole("button", { name: "关闭审查提示" })).toBeNull();

    // 打开来源菜单：Esc 关闭并把焦点归还给来源卡。
    const trigger = screen.getByRole("button", { name: "选择 Cliora 审查来源" });
    await fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "审查来源" })).toBeTruthy();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "审查来源" })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // 再次打开菜单，直接点击第二条来源切换工作树与审查来源。
    await fireEvent.click(trigger);
    const pop = screen.getByRole("dialog", { name: "审查来源" });
    const rowB = pop.querySelector<HTMLElement>(`[data-review-source-id="${REVIEW_B}"] .review-source-switch`)!;
    await fireEvent.click(rowB);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_B));
    expect(screen.queryByRole("dialog", { name: "审查来源" })).toBeNull();
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledWith(OTHER_WORKTREE, COMMITTED, expect.anything(), expect.anything()));

    // 切换到「改动」视图后再回到审查：任务按最新状态重读，来源保持不变。
    await fireEvent.click(screen.getByRole("button", { name: /^改动/ }));
    await waitFor(() => expect(activeViewId()).toBe("changes"));
    mocks.api.taskReview.mockClear();
    await openReviewView();
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledWith(OTHER_WORKTREE, COMMITTED, expect.anything(), expect.anything()));
    expect(clioraReview.source?.reviewId).toBe(REVIEW_B);
  });

  it("twiglane://workspace?v=2 深链先走预览、取消即丢弃来源意图，关闭重开不会复现旧预览", async () => {
    mocks.api.workspaceList.mockResolvedValue({ hostId: WORKSPACE_HOST, projects: [] });
    mocks.api.workspacePreviewLink.mockResolvedValue(linkedPreview(false));
    const handle = await mountShell();
    handle([WORKSPACE_URL]);

    const previewRegion = await screen.findByRole("region", { name: "项目清单预览" });
    expect(within(previewRegion).getByText(LINKED_PROJECT)).toBeTruthy();
    // 只有项目清单预览：审查链接的解析与回执都不该被触发。
    expect(mocks.api.clioraReviewRequest).not.toHaveBeenCalled();
    expect(mocks.api.workspaceAttach).not.toHaveBeenCalled();
    expect(mocks.api.openRepository).not.toHaveBeenCalled();

    // 取消即消费掉这次意图：不关联、不打开来源仓库。
    await fireEvent.click(within(previewRegion).getByRole("button", { name: "取消预览" }));
    expect(mocks.api.workspaceAttach).not.toHaveBeenCalled();
    expect(mocks.api.openRepository).not.toHaveBeenCalled();

    // 关闭项目管理弹窗后，再从起始页「业务项目」打开：旧预览已被消费，不会复现。
    await fireEvent.keyDown(document.querySelector(".modal-card")!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "管理项目" })).toBeNull());
    await fireEvent.click(screen.getByRole("button", { name: "业务项目" }));
    await screen.findByRole("dialog", { name: "管理项目" });
    expect(screen.queryByRole("region", { name: "项目清单预览" })).toBeNull();
  });

  it("首次关联后继续同一来源仓库，已关联的链接不再弹预览而直接打开来源仓库", async () => {
    const linked = workspaceProject("digest-1");
    mocks.api.workspaceList.mockResolvedValue({ hostId: WORKSPACE_HOST, projects: [] });
    mocks.api.workspacePreviewLink.mockResolvedValue(linkedPreview(false));
    mocks.api.workspaceAttach.mockResolvedValue({ hostId: WORKSPACE_HOST, projects: [linked] });
    mocks.api.repoHeads.mockResolvedValue([{ path: LINKED_MEMBER_PATH, mainPath: null, branch: "main", detached: null, missing: false, worktree: false }]);
    mocks.api.openRepository.mockImplementation(async (path: string) => openedAt(path));
    const handle = await mountShell();
    handle([WORKSPACE_URL]);

    const previewRegion = await screen.findByRole("region", { name: "项目清单预览" });
    await fireEvent.click(within(previewRegion).getByRole("button", { name: "关联此项目清单" }));
    await waitFor(() => expect(mocks.api.workspaceAttach).toHaveBeenCalledTimes(1));
    // 接受关联后自动续接同一来源仓库：只打开那个目录，不写 Git、不触发审查链接。
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenCalledWith(LINKED_MEMBER_PATH, expect.any(Number)));
    expect(mocks.api.clioraReviewRequest).not.toHaveBeenCalled();
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
    expect(mocks.api.startMerge).not.toHaveBeenCalled();

    // 本机名单已一致（attached）：再收到同一项目的链接不再确认关联，直接定位来源仓库。
    cleanup();
    deepLink.onOpenUrl.mockClear();
    mocks.api.workspaceAttach.mockClear();
    mocks.api.openRepository.mockClear();
    mocks.api.workspaceList.mockResolvedValue({ hostId: WORKSPACE_HOST, projects: [linked] });
    mocks.api.workspaceRefresh.mockResolvedValue({ hostId: WORKSPACE_HOST, projects: [linked] });
    mocks.api.workspacePreviewLink.mockResolvedValue(linkedPreview(true));
    const reopen = await mountShell();
    reopen([WORKSPACE_URL]);
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenCalledWith(LINKED_MEMBER_PATH, expect.any(Number)));
    expect(mocks.api.workspaceAttach).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "项目清单预览" })).toBeNull();
    expect(mocks.api.clioraReviewRequest).not.toHaveBeenCalled();
  });

  it("同一会话对同一工作树重复发起时，来源菜单标出最新/较早发起，详情里给出各自的审查号", async () => {
    mocks.api.clioraReviewSources.mockResolvedValue({ sources: [
      { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE }, result: null, lastReturn: null, acceptedAt: 1_000 },
      { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_B, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE }, result: null, lastReturn: null, acceptedAt: 2_000 },
    ], expiredPending: 0 });
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE)); await mountShell();
    await openRecentRepo();
    const menu = await openSourceMenu();
    const rows = [...menu.querySelectorAll<HTMLElement>("[data-review-source-id]")];
    expect(rows).toHaveLength(2);
    const texts = rows.map((node) => node.textContent ?? "");
    expect(new Set(texts).size).toBe(2);
    // 接受时间较新的一项是「最新发起」，排在前面；ID 只在详情里出现。
    expect(rows[0].dataset.reviewSourceId).toBe(REVIEW_B);
    expect(texts[0]).toContain("最新发起");
    expect(texts[1]).toContain("较早发起");
    expect(texts[0]).not.toContain(REVIEW_B);
    await fireEvent.click(within(rows[1]).getByRole("button", { name: /来源详情/ }));
    const details = rows[1].querySelector(".review-source-details")!;
    expect(details.textContent).toContain(REVIEW_A);
    expect(details.textContent).toContain(SESSION_A);
    expect(details.textContent).toContain(WORKTREE);
    expect(details.textContent).toContain("v3");
  });

  it("accepted 迟到期间普通切到 B，保留 A 来源但不改 B 仓库或任务起点", async () => {
    let finishReceipt!: (value: unknown) => void;
    mocks.api.getSettings.mockResolvedValue({ theme: "dark", panelWidths: { sidebar: 256, files: 360 }, git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "available" }, recent: [{ name: "other", path: OTHER_WORKTREE, openedAtMs: 1 }], settingsWarning: null });
    mocks.api.openRepository.mockImplementation(async (path: string) => openedAt(path));
    mocks.api.clioraReviewReceipt.mockImplementationOnce(() => new Promise(resolve => { finishReceipt = resolve; }));
    const handle = await mountShell(); handle([URL_A]);
    await waitFor(() => expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_A, SESSION_A, true, null));
    await fireEvent.click(screen.getByRole("button", { name: "当前仓库 代码 demo" }));
    const switcher = await screen.findByRole("dialog", { name: "切换仓库" });
    await fireEvent.click(within(switcher).getByRole("option", { name: /other/ }));
    await waitFor(() => expect(document.querySelector(".project-context-path")?.textContent).toContain(OTHER_WORKTREE));
    mocks.api.taskReview.mockClear();
    finishReceipt(undefined);
    await waitFor(() => expect(clioraReview.sources.map(source => source.reviewId)).toContain(REVIEW_A));
    expect(clioraReview.source).toBeNull();
    expect(clioraBaseline()).toBeNull();
    expect(document.querySelector(".project-context-path")?.textContent).toContain(OTHER_WORKTREE);
    expect(mocks.api.taskReview).not.toHaveBeenCalledWith(OTHER_WORKTREE, BASELINE, expect.anything(), expect.anything());
    expect(mocks.api.taskReview).not.toHaveBeenCalled();
    await pickSource(REVIEW_A);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_A));
    expect(document.querySelector(".project-context-path")?.textContent).toContain(WORKTREE);
    expect(clioraBaseline()).toBe(BASELINE);
  });

  it("原生 accepted 尚未完成时不把新来源用于 Git 操作，回执传输失败也不伪造 rejected", async () => {
    let finishReceipt!: (value: unknown) => void;
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE));
    mocks.api.clioraReviewReceipt.mockImplementationOnce(() => new Promise(resolve => { finishReceipt = resolve; }));
    const handle = await mountShell(); handle([URL_A]);
    await waitFor(() => expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_A, SESSION_A, true, null));
    expect(clioraReview.source).toBeNull();
    finishReceipt(undefined);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_A));
    mocks.api.clioraReviewRequest.mockResolvedValue({ reviewId: REVIEW_B, sessionId: SESSION_B, worktreePath: WORKTREE, baseline: null });
    mocks.api.clioraReviewReceipt.mockRejectedValueOnce({ code: "cliora_unavailable", message: "系统回执投递失败" });
    handle([URL_B]);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_B));
    expect(mocks.api.clioraReviewReceipt).not.toHaveBeenCalledWith(REVIEW_B, SESSION_B, false, expect.anything());
    expect(document.body.textContent).toContain("系统回执投递失败");
  });

  it("首次恢复未完成时到达的新链接等待旧 pending 过期后才原生登记", async () => {
    let finishRestore!: (value: unknown) => void;
    mocks.api.clioraReviewSources.mockImplementationOnce(() => new Promise(resolve => { finishRestore = resolve; }));
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE));
    const handle = await mountShell();
    handle([URL_A]);
    await waitFor(() => expect(mocks.api.clioraReviewSources).toHaveBeenCalledWith(true));
    expect(mocks.api.clioraReviewRequest).not.toHaveBeenCalled();
    finishRestore({ sources: [], expiredPending: 1 });
    await waitFor(() => expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_A, SESSION_A, true, null));
    expect(clioraReview.sources.map(source => source.reviewId)).toEqual([REVIEW_A]);
  });

  it("webview 重载从原生恢复多个来源和最近返回结果，不伪造新的 accepted", async () => {
    mocks.api.clioraReviewSources.mockResolvedValue({ sources: [
      { source: { protocolVersion: 3, workspaceId: "project-A", repositoryId: "repo-A", workspaceName: "电商平台", reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE }, result: { outcome: "committed", headOid: COMMITTED, recordedAt: 1 }, lastReturn: { revision: 2, declaration: { reviewId: REVIEW_A, sessionId: SESSION_A, outcome: "committed", headOid: COMMITTED, worktreeState: "dirty", meta: [] } } },
      { source: { protocolVersion: 2, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_B, sessionId: SESSION_B, worktreePath: OTHER_WORKTREE, baseline: COMMITTED }, result: null, lastReturn: null },
    ], expiredPending: 1 });
    mocks.api.openRepository.mockImplementation(async (path: string) => openedAt(path));
    await mountShell();
    await openRecentRepo();
    expect(await sourceMenuIds()).toHaveLength(2);
    expect(clioraReview.source).toBeNull();
    expect(document.body.textContent).toContain("1 条尚未接受的来源已失效");
    expect(mocks.api.clioraReviewSources).toHaveBeenCalledWith(true);
    await pickSource(REVIEW_A);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_A));
    expect(clioraBaseline()).toBe(BASELINE);
    expect(clioraReview.result?.headOid).toBe(COMMITTED);
    expect(clioraReview.lastReturn?.revision).toBe(2);
    await waitFor(() => expect(screen.getByText("已保留上次返回尝试，接收结果以 Cliora 为准")).toBeTruthy());
    expect(mocks.api.clioraReviewReceipt).not.toHaveBeenCalled();
    await pickSource(REVIEW_B);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_B));
    expect(clioraReview.result).toBeNull();
  });

  it("两个项目审查 A 切 B 再回 A 保留各自基线和结果，显式关闭才释放", async () => {
    const otherUrl = URL_B + "&v3-source";
    mocks.api.clioraReviewRequest.mockImplementation(async (url: string) => ({
      protocolVersion: 3, workspaceId: url === URL_A ? "project-A" : "project-B", repositoryId: url === URL_A ? "repo-A" : "repo-B",
      workspaceName: url === URL_A ? "电商平台" : "支付系统", reviewId: url === URL_A ? REVIEW_A : REVIEW_B,
      sessionId: url === URL_A ? SESSION_A : SESSION_B, worktreePath: url === URL_A ? WORKTREE : OTHER_WORKTREE,
      baseline: url === URL_A ? BASELINE : COMMITTED,
    }));
    mocks.api.openRepository.mockImplementation(async (path: string) => ({ ...openedAt(path), draft: path === WORKTREE ? "A draft" : "B draft" }));
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    const handle = await mountShell();
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_A));
    recordClioraCommit(WORKTREE, COMMITTED);
    handle([otherUrl]);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_B));
    expect(clioraReview.result).toBeNull();
    expect(clioraBaseline()).toBe(COMMITTED);
    expect(await sourceMenuIds()).toHaveLength(2);
    await pickSource(REVIEW_A);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_A));
    expect(clioraBaseline()).toBe(BASELINE);
    expect(clioraReview.result?.headOid).toBe(COMMITTED);
    await clickReturn();
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_A, SESSION_A, "committed", COMMITTED)));
    await fireEvent.click(within(await openSourceMenu()).getByRole("button", { name: "关闭此审查来源" }));
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_A, SESSION_A));
    expect(clioraReview.sources.map((source) => source.reviewId)).toEqual([REVIEW_B]);
  });

  it("独立打开的仓库没有来源，不显示返回入口", async () => {
    mocks.api.openRepository.mockResolvedValue(openedAt("C:/work/demo"));
    await mountShell();
    await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
    await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenCalledWith("C:/work/demo", expect.any(Number)));
    expect(screen.queryByRole("button", { name: "返回 Cliora" })).toBeNull();
    // 普通独立仓库没有审查目标：切换条上不出现「审查」。
    await waitFor(() => expect(document.querySelector('.workbench-view[data-active="true"] nav[aria-label="视图"]')).toBeTruthy());
    expect(document.querySelector('[data-view="review"]')).toBeNull();
    expect(mocks.api.clioraReviewReceipt).not.toHaveBeenCalled();
    expect(mocks.api.clioraReviewReturn).not.toHaveBeenCalled();
  });
});

/**
 * 真实联动证据门禁（scripts/verify-cliora-integration.mjs）：只用临时报告驱动脚本，确认再次审阅闭环
 * 是必需场景，缺少关键观察或沿用旧 reviewId 时不通过。这里不产生任何联动证据。
 */
describe("cliora 联动证据门禁", () => {
  const root = path.resolve(__dirname, "..");
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version as string;
  const build = (v: string) => ({ version: v, bundle: "nsis", installed: true, installerSha256: "c".repeat(64) });
  const scenario = (id: string, observations: Record<string, string> = { result: "已实机观察" }) => ({
    id,
    status: "passed",
    executedAt: "2026-11-11T08:00:00Z",
    realApp: true,
    realGit: true,
    steps: ["在已安装的两端应用中操作"],
    observations: {
      workspaceA: "project-A", workspaceB: "project-B", promptScope: "repository A", originalSession: SESSION_A, returnedSource: "project A/repo A/session A",
      reviewA: REVIEW_A, reviewB: REVIEW_B, baselineA: BASELINE, baselineB: COMMITTED, draftRestored: "A草稿恢复", independentResults: "B未继承A结果",
      explicitSelection: "用户选择A", capacityError: "第九条拒绝", retainedSource: "第一条仍在", explicitRelease: "明确关闭", restartExpired: "来源失效",
      v2Receipt: "v2", v2Return: "v2", v3NoDowngrade: "没有重发v2", newRevision: "2", oldRevisionIgnored: "1被忽略", lateReceiptIgnored: "状态保持returned",
      ...observations,
    },
  });
  const reReview = {
    clioraRecheck: "cliora 复核 HEAD 与未提交文件后显示剩余修改",
    continuedFix: "在原会话继续修复并产生新提交",
    firstReviewId: REVIEW_A,
    reReviewId: REVIEW_B,
    reReviewBaseline: BASELINE,
    reReviewHead: COMMITTED,
    staleReviewStateCleared: "旧差异与旧审阅标记未带入新范围",
    staleReturnIgnored: "迟到的旧 returned 未覆盖新审查",
  };
  const BASE_IDS = [
    "project-prompt-review-return", "multi-source-switchback", "same-checkout-source-selection",
    "source-capacity-and-expiry", "v2-source-roundtrip", "result-revision-order",
    "cold-start-review",
    "commit-and-return",
    "merge-and-stale-head",
    "invalid-links",
    "standalone-repository",
    "light-edit-return",
    "extension-and-version-mismatch",
  ];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "twiglane-cliora-evidence-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function verify(scenarios: unknown[]) {
    const report = path.join(dir, "report.json");
    writeFileSync(
      report,
      JSON.stringify({
        format: "cliora-integration-evidence",
        version: 3,
        protocol: "twiglane-review-v3",
        host: { platform: "windows" },
        builds: { twiglane: build(version), cliora: build("9.9.9") },
        scenarios,
        limitations: [{ platform: "macOS/Linux", verified: false }],
      }),
    );
    return spawnSync(
      process.execPath,
      [
        path.join(root, "scripts", "verify-cliora-integration.mjs"),
        "--report",
        report,
        "--cliora-package",
        path.join(dir, "missing-package.json"),
        "--json",
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
  }

  it("再次审阅闭环完整记录时才通过", () => {
    const result = verify([...BASE_IDS.map((id) => scenario(id)), scenario("return-fix-and-re-review", reReview)]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).scenarios).toContain("return-fix-and-re-review");
  });

  it("缺少再次审阅场景时不通过", () => {
    const result = verify(BASE_IDS.map((id) => scenario(id)));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("缺少场景 return-fix-and-re-review");
  });

  it("再次审阅沿用旧 reviewId 或缺少迟到回执观察时不通过", () => {
    const incomplete: Record<string, string> = { ...reReview, reReviewId: REVIEW_A };
    delete incomplete.staleReturnIgnored;
    const result = verify([...BASE_IDS.map((id) => scenario(id)), scenario("return-fix-and-re-review", incomplete)]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("observations 缺少 staleReturnIgnored");
    expect(result.stdout).toContain("firstReviewId、reReviewId 必须互不相同");
  });
});

describe("Cliora 远端审查入口", () => {
  const target = {
    targetId: "remote-a", targetRevision: "a".repeat(64), name: "服务器 A",
    host: "host-a", user: "tester", port: 22, authMethod: "key", defaultPath: "/srv/worktree",
  };
  const source = {
    reviewId: REVIEW_A, sessionId: SESSION_A, targetId: target.targetId, targetRevision: target.targetRevision,
    peerRevision: "b".repeat(64), peerIdentity: "c".repeat(64), worktreeIdentity: "f".repeat(64), worktreePath: "/srv/worktree", baseline: BASELINE,
  };
  const url = "twiglane://remote-review?" + new URLSearchParams({ v: "1", ...source }).toString();

  afterEach(() => vi.restoreAllMocks());

  it("冷启动在主窗口打开原远端会话：等待安装确认后接收，再返回 Cliora；同名本机路径始终未被打开", async () => {
    deepLink.getCurrent.mockResolvedValue([url]);
    const begin = vi.spyOn(reviews, "begin").mockResolvedValueOnce(source).mockResolvedValue(null);
    const end = vi.spyOn(reviews, "end").mockResolvedValue();
    mocks.api.remoteTargets.mockResolvedValue([target]);
    mocks.api.openRemoteRepository
      .mockResolvedValueOnce({ kind: "install_required", version: "v2", size: 2048, confirmationId: "offered" })
      .mockResolvedValueOnce({
        kind: "opened",
        repository: {
          summary: { name: "worktree", path: "ssh://remote-a/srv/worktree", host: "服务器 A", remotePath: "/srv/worktree" },
          generation: 21,
          snapshot: { generation: 21, branch: { name: "main", detached: false, unborn: false, headOid: BASELINE, upstream: null, ahead: null, behind: null, liveRemoteChecked: false, remoteCheckedAtMs: null, remoteCheckStale: false }, files: [] },
          draft: "",
          watchDegraded: false,
        },
        key: "ssh://remote-a/srv/worktree",
        host: "服务器 A",
        path: "/srv/worktree",
        pending: null,
        reviewId: REVIEW_A,
      });
    mocks.api.remoteRepositoryState.mockReturnValue({
      key: "ssh://remote-a/srv/worktree",
      host: "服务器 A",
      path: "/srv/worktree",
      pending: false,
      reviewId: REVIEW_A,
      connected: true,
    });
    mocks.api.remoteReturnReview.mockResolvedValue({ state: "sent", outcome: "reviewed" });
    mocks.api.taskReview.mockResolvedValue({ ...taskFor(BASELINE), worktree: "ssh://remote-a/srv/worktree" });
    mocks.api.loadTaskDiff.mockImplementation(async (_worktree, _base, _head, path) => diffFor(path));

    const handle = await mountShell();
    const install = await screen.findByRole("button", { name: "确认安装" });
    expect(begin).toHaveBeenCalledWith(url);
    // 主窗口打开：主机、工作树与审查来源一起传，安装缺省不传输。
    // 主窗口路径发送了来源基线：后端按 baseline 相等判定这条打开是不是那条审查。
    expect(mocks.api.openRemoteRepository).toHaveBeenNthCalledWith(
      1,
      { kind: "ssh", hostId: source.targetId, hostRevision: source.targetRevision, path: source.worktreePath },
      expect.objectContaining({ reviewId: REVIEW_A, allowInstall: false, baseline: BASELINE }),
    );
    expect(mocks.api.remoteRepositoryState).not.toHaveBeenCalled();
    handle([url]);
    await waitFor(() => expect(begin).toHaveBeenCalledTimes(2));
    expect(mocks.api.openRemoteRepository).toHaveBeenCalledTimes(1);

    await fireEvent.click(install);
    await waitFor(() =>
      expect(mocks.api.openRemoteRepository).toHaveBeenNthCalledWith(
        2,
        { kind: "ssh", hostId: source.targetId, hostRevision: source.targetRevision, path: source.worktreePath },
        expect.objectContaining({
          reviewId: REVIEW_A,
          allowInstall: true,
          installConfirmation: "offered",
          baseline: BASELINE,
        }),
      ),
    );
    // 打开后主窗口显示真实主机与远端路径，进入审查工作台，返回入口在完成栏；没有独立的远端弹层。
    await waitFor(() => expect(document.querySelector("[data-remote-repository]")).toBeTruthy());
    expect(screen.queryByRole("dialog", { name: "Cliora 远端审查" })).toBeNull();
    await waitFor(() => expect(activeViewId()).toBe("review"));
    // 远程来源不支持送回意见：完成栏只有返回。
    expect(completionAction("feedback")).toBeNull();
    await fireEvent.click(await screen.findByRole("button", { name: "返回 Cliora" }));
    await waitFor(() => expect(mocks.api.remoteReturnReview).toHaveBeenCalledWith("ssh://remote-a/srv/worktree"));
    // 同名本机路径从未被打开，也没有走本机审查回执。
    expect(mocks.api.openRepository).not.toHaveBeenCalled();
    expect(mocks.api.clioraReviewRequest).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    cleanup();
  });

  it("活动窗口收到远端来源，原主机已变更时回送拒绝，不会选择其它同路径主机", async () => {
    vi.spyOn(reviews, "begin").mockResolvedValue(source);
    const end = vi.spyOn(reviews, "end").mockResolvedValue();
    mocks.api.remoteTargets.mockResolvedValue([{ ...target, targetRevision: "e".repeat(64) }]);
    const handle = await mountShell();
    handle([url]);
    await waitFor(() => expect(end).toHaveBeenCalledWith(REVIEW_A, "target_changed"));
    expect(mocks.api.openRemoteRepository).not.toHaveBeenCalled();
    expect(mocks.api.openRepository).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "返回 Cliora" })).toBeNull();
    cleanup();
  });
});

describe("远端仓库在主窗口：最近记录与草稿", () => {
  const REMOTE_KEY = "ssh://remote-a/srv/worktree";
  const REMOTE_HOST = "服务器 A";
  const REMOTE_PATH = "/srv/worktree";
  const host = {
    targetId: "remote-a", targetRevision: "a".repeat(64), name: "服务器 A",
    host: "host-a", user: "tester", port: 22, authMethod: "key", defaultPath: REMOTE_PATH,
  };
  const source = {
    reviewId: REVIEW_A, sessionId: SESSION_A, targetId: host.targetId, targetRevision: host.targetRevision,
    peerRevision: "b".repeat(64), peerIdentity: "c".repeat(64), worktreeIdentity: "f".repeat(64),
    worktreePath: REMOTE_PATH, baseline: BASELINE,
  };
  const url = "twiglane://remote-review?" + new URLSearchParams({ v: "1", ...source }).toString();

  /** 远端仓库在主窗口的 DTO：summary 带主机与远端路径，path 是内部仓库键。 */
  function remoteOpened(draft = "") {
    return {
      summary: { name: "worktree", path: REMOTE_KEY, host: REMOTE_HOST, remotePath: REMOTE_PATH },
      generation: 21,
      snapshot: { ...snapshot, files: [] },
      draft,
      watchDegraded: false,
    };
  }

  /** 从标题栏仓库弹层切到另一个仓库：按当前显示名打开，再按目标名选择。 */
  async function switchRepo(current: string, target: RegExp) {
    await fireEvent.click(await screen.findByRole("button", { name: `当前仓库 ${current}` }));
    const popover = await screen.findByRole("dialog", { name: "切换仓库" });
    await fireEvent.click(within(popover).getByRole("option", { name: target }));
  }

  afterEach(() => vi.restoreAllMocks());

  /** 打开一条带基线的远端审查，并把「打开远端仓库」与「远端状态」都接上。 */
  async function openReview(opened: () => unknown) {
    deepLink.getCurrent.mockResolvedValue([url]);
    vi.spyOn(reviews, "begin").mockResolvedValue(source);
    vi.spyOn(reviews, "end").mockResolvedValue();
    mocks.api.remoteTargets.mockResolvedValue([host]);
    mocks.api.taskReview.mockResolvedValue({ ...taskFor(BASELINE), worktree: REMOTE_KEY });
    mocks.api.loadTaskDiff.mockImplementation(async (_worktree, _base, _head, path) => diffFor(path));
    mocks.api.openRemoteRepository.mockResolvedValue({
      kind: "opened",
      repository: opened(),
      key: REMOTE_KEY,
      host: REMOTE_HOST,
      path: REMOTE_PATH,
      pending: null,
      reviewId: REVIEW_A,
    });
    mocks.api.remoteRepositoryState.mockReturnValue({
      key: REMOTE_KEY,
      host: REMOTE_HOST,
      path: REMOTE_PATH,
      pending: false,
      reviewId: REVIEW_A,
      connected: true,
    });
    mocks.api.openRepository.mockImplementation(async (path: string) => (path === REMOTE_KEY ? opened() : openedAt(path)));
    await mountShell();
    await waitFor(() => expect(document.querySelector("[data-remote-repository]")).toBeTruthy());
  }

  it("重开远端仓库后最近记录仍带主机与远端路径，弹层不显示内部仓库键", async () => {
    await openReview(() => remoteOpened());

    // 先切到本机仓库，再从弹层切回远端仓库：这一步由 rememberOpened 重写最近记录。
    await switchRepo("worktree", /demo/);
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenCalledWith("C:/work/demo", expect.any(Number)));
    await switchRepo("demo", /worktree/);
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenCalledWith(
      REMOTE_KEY, expect.any(Number),
      expect.objectContaining({ onProgress: expect.any(Function), signal: expect.any(AbortSignal) }),
    ));
    await screen.findByRole("button", { name: "当前仓库 worktree" });

    await fireEvent.click(screen.getByRole("button", { name: "当前仓库 worktree" }));
    const popover = await screen.findByRole("dialog", { name: "切换仓库" });
    const rows = within(popover).getAllByRole("option");
    const remoteRow = rows.find((row) => row.textContent?.includes("worktree"));
    expect(remoteRow, "远端仓库仍在最近记录里").toBeTruthy();
    expect(remoteRow!.querySelector(".repo-path bdi")?.textContent).toBe(`${REMOTE_HOST} · ${REMOTE_PATH}`);
    expect(remoteRow!.textContent).not.toContain("ssh://");
  });

  it("远端草稿切走再回来仍在：离开时存进会话内存，回到这个仓库时回读", async () => {
    const saved = new Map<string, string>();
    // 顶替 api 的草稿契约：保存进内存，重开同一个仓库时随 OpenedRepository.draft 回读。
    mocks.api.saveDraft.mockImplementation(async (path: string, message: string) => {
      saved.set(path, message);
    });
    await openReview(() => remoteOpened(saved.get(REMOTE_KEY) ?? ""));

    await fireEvent.click(await screen.findByRole("button", { name: /^改动(?: \d+)?$/ }));
    const message = (await screen.findByRole("textbox", { name: "提交说明草稿" })) as HTMLTextAreaElement;
    await fireEvent.input(message, { target: { value: "远端草稿正文" } });
    await fireEvent.blur(message);
    await waitFor(() => expect(mocks.api.saveDraft).toHaveBeenCalledWith(REMOTE_KEY, "远端草稿正文"));

    await switchRepo("worktree", /demo/);
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenCalledWith("C:/work/demo", expect.any(Number)));
    await switchRepo("demo", /worktree/);
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenCalledWith(
      REMOTE_KEY, expect.any(Number),
      expect.objectContaining({ onProgress: expect.any(Function), signal: expect.any(AbortSignal) }),
    ));

    await waitFor(() => {
      const back = screen.getByRole("textbox", { name: "提交说明草稿" }) as HTMLTextAreaElement;
      expect(back.value).toBe("远端草稿正文");
    });
  });
});

describe("feedback-v1 准备送回", () => {
  async function openTaskWithDiff() {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE));
    mocks.api.taskReview.mockResolvedValue(taskFor(BASELINE));
    mocks.api.loadTaskDiff.mockImplementation(async (_worktree: string, _base: string, _head: string, path: string) => diffFor(path));
    await mountShell();
    await waitFor(() => expect(completionAction("return")).toBeTruthy());
    await waitFor(() => expect(document.querySelector("[data-comment-line]")).toBeTruthy(), { timeout: 8000 });
  }

  async function composeComment(text: string): Promise<void> {
    await fireEvent.click(document.querySelector<HTMLButtonElement>("[data-comment-line]")!);
    const form = await screen.findByRole("form", { name: "给这一行添加意见" });
    await fireEvent.input(within(form).getByRole("textbox", { name: "意见正文" }), { target: { value: text } });
    await fireEvent.click(within(form).getByRole("button", { name: "添加意见" }));
  }

  it("准备时带来源、结果版本与任务范围，成功只说明已准备，不声称已发送", async () => {
    const prepared = {
      feedbackId: "8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1",
      digest: "a".repeat(64),
      commentCount: 1,
      url: "cliora://review-feedback?v=1&feedbackId=8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1",
    };
    mocks.api.prepareReviewFeedback.mockResolvedValueOnce(prepared);
    await openTaskWithDiff();

    // 没有意见时按钮是禁用的：不会凭空生成 feedbackId。
    // 没有意见时完成栏没有送回动作：不会凭空生成 feedbackId；主动作是返回 Cliora。
    expect(completionAction("feedback")).toBeNull();
    expect(mocks.api.prepareReviewFeedback).not.toHaveBeenCalled();

    await composeComment("这一行要在失败时保留上一份结果。");
    await waitFor(() => expect(document.body.textContent).toContain("1 条意见"));

    const send = completionAction("feedback")!;
    expect(send.textContent).toContain("送回 1 条意见");
    expect(send.disabled).toBe(false);
    await fireEvent.click(send);
    await waitFor(() => expect(mocks.api.prepareReviewFeedback).toHaveBeenCalledTimes(1));
    const request = mocks.api.prepareReviewFeedback.mock.calls[0][0];
    expect(request).toMatchObject({
      reviewId: REVIEW_A,
      sessionId: SESSION_A,
      resultRevision: 0,
      worktreePath: WORKTREE,
      rangeVersion: "range-" + BASELINE,
      baselineOid: BASELINE,
      headOid: BASELINE,
    });
    expect(request.comments).toHaveLength(1);
    expect(request.comments[0]).toMatchObject({ path: "src/a.ts", kind: expect.stringMatching(/add|del|context/), body: "这一行要在失败时保留上一份结果。" });
    // 准备不等于发送：没有 PTY 写入、没有 Git 写入、也没有返回事件。
    expect(mocks.api.terminalWrite).not.toHaveBeenCalled();
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
    expect(mocks.api.clioraReviewReturn).not.toHaveBeenCalled();
    await waitFor(() => expect(document.body.textContent).toContain("已准备 1 条意见"));
    await waitFor(() => expect(document.querySelector('.review-completion [data-status="handoff"]')?.textContent).toContain("已准备 1 条意见，已打开 Cliora 等待确认"));
    expect(document.body.textContent).not.toContain("已发送");
    expect(document.body.textContent).not.toContain("已执行");
  });

  it("文件只改内容、范围形状不变：代次前进后旧意见失效，准备按钮不再送出过期批次", async () => {
    await openTaskWithDiff();
    await composeComment("这条意见绑在旧内容的那一行上。");
    await waitFor(() => expect(document.body.textContent).toContain("1 条意见"));

    // 工作区内容被改写：起点、HEAD 与未提交状态形状都没变（rangeVersion 不变），
    // 只有仓库代次前进——文件监听把任务页重读一次。
    mocks.api.refreshStatus.mockResolvedValue({ ...snapshot, generation: 5 });
    mocks.api.taskReview.mockResolvedValue({ ...taskFor(BASELINE), generation: 5 });
    const changed = mocks.listenEvent.mock.calls.find(([name]) => name === "repo-changed")![1] as (event: {
      path: string;
      generation: number;
      degraded: boolean;
    }) => void;
    changed({ path: WORKTREE, generation: 5, degraded: false });

    // 旧批次整体失效：界面上说清是内容被重新读过，而不是含糊成范围变化。
    await waitFor(() => expect(document.body.textContent).toContain("任务范围没变"), { timeout: 8000 });
    expect(document.body.textContent).toContain("不会自动对应到新行号");
    await waitFor(() => expect(document.querySelector('.review-completion [data-status="comments"]')?.textContent).toBe("没有待送回的意见"));
    expect(completionAction("feedback"), "过期批次没有可送的内容").toBeNull();
    expect(document.querySelector('.review-completion [data-status="stale"]')?.textContent).toContain("1 条意见已失效，不会送回");
    expect(mocks.api.prepareReviewFeedback).not.toHaveBeenCalled();
    expect(mocks.api.terminalWrite).not.toHaveBeenCalled();
  });

  it("范围前进后：已准备与已添加意见的提示收起，完成栏不再说等待确认，旧批次只在详情里说明", async () => {
    mocks.api.prepareReviewFeedback.mockResolvedValueOnce({
      feedbackId: "05d1396d-4f30-4121-8394-a5b6c7d8e9f1",
      digest: "a".repeat(64),
      commentCount: 1,
      url: "cliora://review-feedback?v=1",
    });
    await openTaskWithDiff();
    await composeComment("准备之后范围会前进。");
    await waitFor(() => expect(document.querySelector(".review-comment-feedback")?.textContent).toContain("已添加意见"));
    await fireEvent.click(completionAction("feedback")!);
    await waitFor(() => expect(document.querySelector(".review-comment-notice")?.textContent).toContain("已准备 1 条意见（批次 05d1396d）"));
    await waitFor(() => expect(document.querySelector('.review-completion [data-status="handoff"]')?.textContent).toContain("等待确认"));

    // 提交之后范围前进：HEAD 变了，这批意见整体失效。
    mocks.api.refreshStatus.mockResolvedValue({ ...snapshot, generation: 5 });
    mocks.api.taskReview.mockResolvedValue({ ...taskFor(BASELINE), generation: 5 });
    const changed = mocks.listenEvent.mock.calls.find(([name]) => name === "repo-changed")![1] as (event: {
      path: string;
      generation: number;
      degraded: boolean;
    }) => void;
    changed({ path: WORKTREE, generation: 5, degraded: false });

    await waitFor(() => expect(document.querySelector('.review-completion [data-status="stale"]')?.textContent).toContain("1 条意见已失效，不会送回"), { timeout: 8000 });
    expect(document.querySelector(".review-comment-notice")?.textContent ?? "").not.toContain("已准备");
    expect(document.querySelector(".review-comment-feedback")?.textContent ?? "").not.toContain("已添加意见");
    expect(document.querySelector('.review-completion [data-status="handoff"]')).toBeNull();
    await fireEvent.click(document.querySelector<HTMLButtonElement>(".review-completion-more")!);
    await waitFor(() => expect(document.querySelector("#review-completion-details")?.textContent).toContain("范围变化前准备的批次 05d1396d"));
  });

  it("准备失败时不唤起 cliora，意见与提示都保留并可以再试", async () => {
    mocks.api.prepareReviewFeedback.mockRejectedValueOnce({
      code: "feedback_write_failed",
      message: "无法写入意见交接文件，未打开 cliora。",
    });
    await openTaskWithDiff();
    await composeComment("这条意见要留在界面上。");
    await waitFor(() => expect(document.body.textContent).toContain("1 条意见"));

    await fireEvent.click(completionAction("feedback")!);
    await waitFor(() => expect(document.body.textContent).toContain("没有准备好"));
    // 意见仍在，任务仍可继续编辑；没有发送、没有 Git 写入。完成栏给出重试。
    expect(document.body.textContent).toContain("1 条意见");
    await waitFor(() => expect(completionAction("feedback")?.textContent).toContain("重试送回 1 条意见"));
    await fireEvent.click(completionAction("feedback")!);
    await waitFor(() => expect(mocks.api.prepareReviewFeedback).toHaveBeenCalledTimes(2));
    expect(mocks.api.terminalWrite).not.toHaveBeenCalled();
    expect(mocks.api.clioraReviewReturn).not.toHaveBeenCalled();
  });
});
