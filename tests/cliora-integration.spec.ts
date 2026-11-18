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
import { menuValues, pickMenu } from "./select-menu-helpers";

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
});

afterEach(() => {
  cleanup();
  resetClioraReview();
});

/** 等到外壳注册好 deep link 监听，返回运行中链接的处理函数。 */
async function mountShell() {
  render(App);
  await waitFor(() => expect(deepLink.onOpenUrl).toHaveBeenCalledTimes(1));
  const handler = deepLink.onOpenUrl.mock.calls[0][0] as (urls: string[]) => void;
  return handler;
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
    // 来源建立后标题栏给出返回入口。
    await waitFor(() => expect(screen.getByRole("button", { name: /返回 cliora/ })).toBeTruthy());
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
    expect(screen.getAllByRole("button", { name: /返回 cliora/ })).toHaveLength(1);
    await fireEvent.click(screen.getByRole("button", { name: /返回 cliora/ }));
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
    await pickMenu("选择 Cliora 审查来源", REVIEW_A);
    expect(clioraBaseline()).toBe(BASELINE);
    await pickMenu("选择 Cliora 审查来源", REVIEW_B);
    expect(clioraBaseline()).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: /返回 cliora/ }));
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_B, SESSION_B, "reviewed", null)));
  });

  it("打开失败回送 rejected，不回退主仓库也不写 Git", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockRejectedValue({ code: "not_repository", message: "该目录不是 Git 仓库，未做任何修改。" });

    await mountShell();

    await waitFor(() => expect(mocks.api.clioraReviewReceipt).toHaveBeenCalledWith(REVIEW_A, SESSION_A, false, "not_a_worktree"));
    expect(mocks.api.openRepository).toHaveBeenCalledTimes(1);
    expect(mocks.api.openRepository).toHaveBeenCalledWith(WORKTREE, expect.any(Number));
    expect(screen.queryByRole("button", { name: /返回 cliora/ })).toBeNull();
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
    await fireEvent.click(screen.getByRole("button", { name: /返回 cliora/ }));
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
    await waitFor(() => expect(screen.getByRole("button", { name: /返回 cliora/ })).toBeTruthy());

    // 提交成功的记录发生在 api.ts 的成功边界（tests/api.spec.ts 覆盖）；这里写入同一条
    // 内存态记录，验证标题栏结果与返回链接的内容。
    recordClioraCommit(WORKTREE, COMMITTED);
    await waitFor(() => expect(screen.getByText("已提交 " + COMMITTED.slice(0, 7))).toBeTruthy());

    mocks.api.commitChanges.mockClear();
    await fireEvent.click(screen.getByRole("button", { name: /返回 cliora/ }));
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_A, SESSION_A, "committed", COMMITTED)));
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
    expect(mocks.api.startMerge).not.toHaveBeenCalled();
    expect(mocks.api.completeMerge).not.toHaveBeenCalled();
  });

  it("提交区修订成功更新快照，普通提交草稿保持不变", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE));
    await mountShell();
    await waitFor(() => expect(screen.getByRole("button", { name: /返回 cliora/ })).toBeTruthy());
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
    await waitFor(() => expect(screen.getByRole("button", { name: /返回 cliora/ })).toBeTruthy());

    // 链接带起点：外壳进入历史，按任务范围过滤并选中「任务净差异」（只读）。审阅标记仍在改动视图里做。
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledWith(WORKTREE, BASELINE, expect.any(Number), expect.any(Number)));
    const nav = document.querySelector<HTMLElement>('.workbench-view[data-active="true"] nav[aria-label="视图"]')!;
    await fireEvent.click(within(nav).getByRole("button", { name: /^改动/ }));
    await waitFor(() => expect(document.querySelector('.workbench-view[data-active="true"] .file-list')).toBeTruthy());
    const list = document.querySelector<HTMLElement>('.workbench-view[data-active="true"] .file-list');
    expect(list).toBeTruthy();
    await fireEvent.click(await within(list!).findByRole("button", { name: "标记 src/a.ts 已审阅" }));
    await waitFor(() => expect(screen.getByLabelText("已审阅 1 个，共 1 个改动文件")).toBeTruthy());

    await fireEvent.click(screen.getByRole("button", { name: /返回 cliora/ }));
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_A, SESSION_A, "reviewed", null)));
    expect(document.body.textContent).not.toContain("已批准");
    expect(document.body.textContent).not.toContain("approved");
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
    expect(mocks.api.startMerge).not.toHaveBeenCalled();
    expect(mocks.api.completeMerge).not.toHaveBeenCalled();
  });

  it("带起点的链接进入历史并按任务范围过滤，选中任务净差异；没有起点时只打开普通历史", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE));
    await mountShell();

    // 有已校验起点：历史只列「起点..HEAD」，顶部「任务净差异」默认选中，起点就是链接给的 baseline。
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledWith(WORKTREE, BASELINE, expect.any(Number), expect.any(Number)));
    const activeView = () =>
      document.querySelector<HTMLElement>('.workbench-view[data-active="true"] [aria-current="page"]')?.getAttribute("data-view");
    await waitFor(() => expect(activeView()).toBe("history"));
    await waitFor(
      () => expect(mocks.api.historyPage).toHaveBeenCalledWith(WORKTREE, "", 0, expect.any(Number), expect.any(Number), { scope: `range:${BASELINE}` }),
      { timeout: 8000 },
    );
    const row = await screen.findByRole("button", { name: /任务净差异/ }, { timeout: 8000 });
    expect(row.getAttribute("aria-pressed")).toBe("true");
    const context = await screen.findByRole("group", { name: "任务范围" });
    expect(context.textContent).toContain(BASELINE.slice(0, 7));

    // 没有起点的链接：不建立范围、不猜 HEAD，只打开普通历史并说明原因。
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
    await screen.findByText(/没有携带起点，已打开普通提交历史/);
    await waitFor(() => expect(activeView()).toBe("history"));
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
    await waitFor(() => expect(screen.getByRole("button", { name: /返回 cliora/ })).toBeTruthy());

    await fireEvent.click(screen.getByRole("button", { name: /返回 cliora/ }));
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_A, SESSION_A, "reviewed", null)));
    await waitFor(() => expect(document.body.textContent).toContain("本次没有提交或合入，工作区没有未提交的改动"));

    // 提交之后又留下未提交修改：outcome 仍是真实的提交，工作区状态来自后端读到的 dirty。
    mocks.api.clioraReviewReturn.mockClear();
    mocks.api.clioraReviewReturn.mockResolvedValue({ worktreeState: "dirty", uncommitted: 2 });
    recordClioraCommit(WORKTREE, COMMITTED);
    await fireEvent.click(screen.getByRole("button", { name: /返回 cliora/ }));
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_A, SESSION_A, "committed", COMMITTED)));
    await waitFor(() => expect(document.body.textContent).toContain("提交或合入结果以待复核声明发送，工作区还有 2 个未提交的改动"));
    expect(document.body.textContent).not.toContain("本次只做了浏览");
    expect(mocks.api.commitChanges).not.toHaveBeenCalled();
  });

  it("前端快照不能替后端声明：本地看着干净，后端读到 dirty 时按 dirty 提示", async () => {
    const clean: StatusSnapshot = { generation: 4, branch, files: [] };
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue({ ...openedAt(WORKTREE), snapshot: clean });
    mocks.api.refreshStatus.mockResolvedValue(clean);
    mocks.api.clioraReviewReturn.mockResolvedValue({ worktreeState: "dirty", uncommitted: 1 });
    await mountShell();
    await waitFor(() => expect(screen.getByRole("button", { name: /返回 cliora/ })).toBeTruthy());

    await fireEvent.click(screen.getByRole("button", { name: /返回 cliora/ }));
    await waitFor(() => expect(document.body.textContent).toContain("本次没有提交或合入，工作区还有 1 个未提交的改动"));
    expect(document.body.textContent).not.toContain("本次没有提交或合入，工作区没有未提交的改动");
  });

  it("后端读不到工作区状态时如实说按未知发送；后端没给结果且本地也没读到时只说没读到", async () => {
    deepLink.getCurrent.mockResolvedValue([URL_A]);
    mocks.api.openRepository.mockResolvedValue({ ...openedAt(WORKTREE), snapshot: { generation: 4, branch, files: [] } });
    mocks.api.clioraReviewReturn.mockResolvedValue({ worktreeState: "unknown", uncommitted: null });
    await mountShell();
    await waitFor(() => expect(screen.getByRole("button", { name: /返回 cliora/ })).toBeTruthy());

    await fireEvent.click(screen.getByRole("button", { name: /返回 cliora/ }));
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_A, SESSION_A, "reviewed", null)));
    await waitFor(() => expect(document.body.textContent).toContain("这次没有读到工作区状态，已按未知发送"));

    // 浏览器预览等没有后端结果的环境：返回前刷新也失败，就不能把旧快照当成干净。
    mocks.api.clioraReviewReturn.mockClear();
    mocks.api.clioraReviewReturn.mockResolvedValue(undefined);
    mocks.api.refreshStatus.mockRejectedValue({ code: "git_failed", message: "读取状态失败。" });
    await fireEvent.click(screen.getByRole("button", { name: /返回 cliora/ }));
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
    await waitFor(() => expect(screen.queryByRole("button", { name: "选择 Cliora 审查来源" })).toBeTruthy());
    expect(await menuValues("选择 Cliora 审查来源")).toHaveLength(3);
    await pickMenu("选择 Cliora 审查来源", REVIEW_A);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_A));
    mocks.api.openRepository.mockRejectedValueOnce({ code: "path_missing", message: "B 目录失效" });
    await pickMenu("选择 Cliora 审查来源", REVIEW_B);
    await waitFor(() => expect(document.body.textContent).toContain("B 目录失效"));
    await fireEvent.click(screen.getByText("管理审查来源（2）"));
    await fireEvent.click(screen.getByRole("button", { name: `关闭审查来源 ${REVIEW_B.slice(0, 8)}` }));
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_B, SESSION_B));
    expect(clioraReview.source?.reviewId).toBe(REVIEW_A);
    expect(clioraReview.sources.map(source => source.reviewId)).toEqual([REVIEW_A]);
  });

  it("审查来源管理弹层支持点击条目切换、Esc 关闭归还焦点，且审查条支持一键回到任务净差异与关闭提示", async () => {
    mocks.api.clioraReviewSources.mockResolvedValue({
      sources: [
        { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE }, result: null, lastReturn: null },
        { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_B, sessionId: SESSION_B, worktreePath: OTHER_WORKTREE, baseline: COMMITTED }, result: null, lastReturn: null },
      ],
      expiredPending: 0,
    });
    mocks.api.openRepository.mockImplementation(async (path: string) => openedAt(path));
    await mountShell();

    // 恢复提示带可关闭按钮。
    const dismiss = await screen.findByRole("button", { name: "关闭审查提示" });
    await fireEvent.click(dismiss);
    expect(screen.queryByRole("button", { name: "关闭审查提示" })).toBeNull();

    // 打开管理弹层：Esc 关闭并把焦点归还给「管理审查来源（2）」按钮。
    const trigger = screen.getByRole("button", { name: "管理审查来源（2）" });
    await fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "管理审查来源" })).toBeTruthy();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "管理审查来源" })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // 再次打开管理弹层，直接点击第二条来源切换工作树与审查来源。
    await fireEvent.click(trigger);
    const pop = screen.getByRole("dialog", { name: "管理审查来源" });
    const rowB = pop.querySelector<HTMLElement>(`[data-review-source-id="${REVIEW_B}"] .review-source-switch`)!;
    await fireEvent.click(rowB);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_B));
    expect(screen.queryByRole("dialog", { name: "管理审查来源" })).toBeNull();

    // 切换到「改动」视图后，审查条出现「查看任务净差异」，一键跳回任务净差异。
    await fireEvent.click(screen.getByRole("button", { name: /^改动/ }));
    const jump = await screen.findByRole("button", { name: "查看任务净差异" });
    mocks.api.taskReview.mockClear();
    await fireEvent.click(jump);
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalledWith(OTHER_WORKTREE, COMMITTED, expect.anything(), expect.anything()));
  });

  it("twiglane://workspace 深链先走预览且不触发 clioraReviewRequest，关闭重开项目管理不会复现旧预览", async () => {
    mocks.api.workspaceList.mockResolvedValue({ hostId: "11111111-1111-4111-8111-111111111111", projects: [] });
    mocks.api.workspacePreviewLink.mockResolvedValue({
      path: "/work/shared.dev-workspace.json",
      digest: "digest-1",
      conflict: false,
      manifest: {
        schemaVersion: 1,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        name: "深链预览项目",
        revision: 1,
        repositories: [],
      },
    });
    const handle = await mountShell();
    handle(["twiglane://workspace?v=1&file=%2Fwork%2Fshared.dev-workspace.json"]);

    const previewRegion = await screen.findByRole("region", { name: "项目清单预览" });
    expect(within(previewRegion).getByText("深链预览项目")).toBeTruthy();
    expect(mocks.api.clioraReviewRequest).not.toHaveBeenCalled();
    expect(mocks.api.workspaceAttach).not.toHaveBeenCalled();

    // 关闭项目管理弹窗后，再从起始页「业务项目」打开：旧预览已被消费，不会复现。
    await fireEvent.keyDown(document.querySelector(".modal-card")!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "业务项目" })).toBeNull());
    await fireEvent.click(screen.getByRole("button", { name: "业务项目" }));
    await screen.findByRole("dialog", { name: "业务项目" });
    expect(screen.queryByRole("region", { name: "项目清单预览" })).toBeNull();
  });

  it("同一会话对同一工作树重复发起时，下拉标出发起次序与审查号，不再出现两行一样的文字", async () => {
    mocks.api.clioraReviewSources.mockResolvedValue({ sources: [
      { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_A, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE }, result: null, lastReturn: null },
      { source: { protocolVersion: 3, workspaceId: null, repositoryId: null, workspaceName: null, reviewId: REVIEW_B, sessionId: SESSION_A, worktreePath: WORKTREE, baseline: BASELINE }, result: null, lastReturn: null },
    ], expiredPending: 0 });
    mocks.api.openRepository.mockResolvedValue(openedAt(WORKTREE)); await mountShell();
    await waitFor(() => expect(screen.queryByRole("button", { name: "选择 Cliora 审查来源" })).toBeTruthy());
    await fireEvent.click(screen.getByRole("button", { name: "选择 Cliora 审查来源" }));
    const rows = await waitFor(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>(".popover [role=option]")].filter((node) => node.dataset.value);
      expect(nodes).toHaveLength(2);
      return nodes;
    });
    const texts = rows.map((node) => node.textContent ?? "");
    expect(new Set(texts).size).toBe(2);
    expect(texts[0]).toContain("第 1 次发起");
    expect(texts[0]).toContain(`审查 ${REVIEW_A.slice(0, 8)}`);
    expect(texts[1]).toContain("最新发起");
    expect(texts[1]).toContain(`审查 ${REVIEW_B.slice(0, 8)}`);
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
    await pickMenu("选择 Cliora 审查来源", REVIEW_A);
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
    await waitFor(() => expect(screen.queryByRole("button", { name: "选择 Cliora 审查来源" })).toBeTruthy());
    expect(await menuValues("选择 Cliora 审查来源")).toHaveLength(3);
    expect(clioraReview.source).toBeNull();
    expect(document.body.textContent).toContain("1 条尚未接受的来源已失效");
    expect(mocks.api.clioraReviewSources).toHaveBeenCalledWith(true);
    await pickMenu("选择 Cliora 审查来源", REVIEW_A);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_A));
    expect(clioraBaseline()).toBe(BASELINE);
    expect(clioraReview.result?.headOid).toBe(COMMITTED);
    expect(clioraReview.lastReturn?.revision).toBe(2);
    expect(screen.getByText("已保留上次返回尝试，接收结果以 Cliora 为准")).toBeTruthy();
    expect(mocks.api.clioraReviewReceipt).not.toHaveBeenCalled();
    await pickMenu("选择 Cliora 审查来源", REVIEW_B);
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
    expect(await menuValues("选择 Cliora 审查来源")).toHaveLength(3);
    await pickMenu("选择 Cliora 审查来源", REVIEW_A);
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe(REVIEW_A));
    expect(clioraBaseline()).toBe(BASELINE);
    expect(clioraReview.result?.headOid).toBe(COMMITTED);
    await fireEvent.click(screen.getByRole("button", { name: /返回 cliora/ }));
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith(...returned(REVIEW_A, SESSION_A, "committed", COMMITTED)));
    await fireEvent.click(screen.getByRole("button", { name: "关闭此审查来源" }));
    await waitFor(() => expect(mocks.api.clioraReviewForget).toHaveBeenCalledWith(REVIEW_A, SESSION_A));
    expect(clioraReview.sources.map((source) => source.reviewId)).toEqual([REVIEW_B]);
  });

  it("独立打开的仓库没有来源，不显示返回入口", async () => {
    mocks.api.openRepository.mockResolvedValue(openedAt("C:/work/demo"));
    await mountShell();
    await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
    await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenCalledWith("C:/work/demo", expect.any(Number)));
    expect(screen.queryByRole("button", { name: /返回 cliora/ })).toBeNull();
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
