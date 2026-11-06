import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { branchLists, filterBranches } from "../src/lib/branches";
import type { BranchRecord, DiffLine, DiffResponse, FileChange, StatusSnapshot } from "../src/lib/types";

/* App 级夹具：只盯本轮改动涉及的就地反馈与写入边界，真实 api 由 vi.mock 顶替。 */
const repoPath = "C:/work/demo";

const branch = {
  name: "main",
  detached: false,
  unborn: false,
  headOid: "a".repeat(40),
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  liveRemoteChecked: true,
  remoteCheckedAtMs: 1,
  remoteCheckStale: false,
};

function change(path: string, staged: FileChange["staged"], unstaged: FileChange["unstaged"]): FileChange {
  return { path, originalPath: null, staged, unstaged, untracked: false, unmerged: false };
}

const changes: FileChange[] = [change("src/App.svelte", "modified", "none")];
const snapshot: StatusSnapshot = { generation: 4, branch, files: changes };

function diffFor(path: string, staged: boolean): DiffResponse {
  const lines: DiffLine[] = Array.from({ length: 6 }, (_, index) => ({
    kind: "context" as const,
    text: ` row-${index}`,
    oldNo: index + 1,
    newNo: index + 1,
    hunkIndex: 0,
  }));
  return {
    generation: 4,
    path,
    staged,
    binary: false,
    text: null,
    summary: "6 行上下文。",
    additions: 0,
    deletions: 0,
    complete: true,
    truncated: false,
    snapshot: "snap",
    hunks: [{ index: 0, header: "@@ -1,6 +1,6 @@", complete: true, stageable: true, startLine: 0, lineCount: lines.length }],
    lines,
    offset: 0,
    totalLines: lines.length,
  };
}

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  openRepository: vi.fn(),
  refreshStatus: vi.fn(),
  loadDiff: vi.fn(),
  commitChanges: vi.fn(),
  commitAndPush: vi.fn(),
  fetchRemote: vi.fn(),
  pushBranch: vi.fn(),
  mergeSession: vi.fn(),
  remoteState: vi.fn(),
  saveDraft: vi.fn(),
  setTheme: vi.fn(),
  setPanelWidths: vi.fn(),
  cancelReads: vi.fn(),
  measureProbe: vi.fn(),
  listenEvent: vi.fn(),
  pickDirectory: vi.fn(),
  pickFile: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  api: { ...mocks },
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));

import App from "../src/App.svelte";

async function openRepo() {
  await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
  await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
  await waitFor(() => expect(document.querySelector(".file-list")).toBeTruthy());
  await waitFor(() => expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
}

const diffRows = () => document.querySelectorAll("[data-diff-row]").length;
const refreshingStatus = () => document.querySelector('[data-refreshing="true"]');

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSettings.mockResolvedValue({
    theme: "dark",
    panelWidths: { sidebar: 256, files: 360 },
    git: {
      available: true,
      path: "git",
      version: "2.49.0",
      overridden: false,
      belowBaseline: false,
      message: "Git 2.49.0 可用",
    },
    recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }],
    settingsWarning: null,
  });
  mocks.listenEvent.mockResolvedValue(() => {});
  mocks.pickDirectory.mockResolvedValue(null);
  mocks.pickFile.mockResolvedValue(null);
  mocks.openRepository.mockResolvedValue({
    summary: { name: "demo", path: repoPath },
    generation: 4,
    snapshot,
    draft: "",
    watchDegraded: false,
  });
  mocks.refreshStatus.mockResolvedValue(snapshot);
  mocks.loadDiff.mockImplementation(async (_repo: string, path: string, staged: boolean) => diffFor(path, staged));
  mocks.mergeSession.mockResolvedValue({
    generation: 4,
    operation: "none",
    canContinue: false,
    canAbort: false,
    source: null,
    target: "main",
    headOid: branch.headOid,
    conflicts: [],
    unresolved: 0,
    note: "当前没有进行中的合并。",
    snapshot,
  });
  mocks.remoteState.mockResolvedValue({ generation: 4, remotes: [], snapshot });
  mocks.saveDraft.mockResolvedValue(undefined);
  mocks.setTheme.mockResolvedValue(undefined);
  mocks.setPanelWidths.mockImplementation(async (widths: unknown) => widths);
  mocks.cancelReads.mockResolvedValue(undefined);
  mocks.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
});

afterEach(() => cleanup());

const branches: BranchRecord[] = [
  { name: "main", remote: false, current: true, upstream: "origin/main", worktree: null },
  { name: "feature/ui", remote: false, current: false, upstream: null, worktree: "/tmp/wt" },
  { name: "origin/main", remote: true, current: false, upstream: null, worktree: null },
  { name: "origin/feature/ui", remote: true, current: false, upstream: null, worktree: null },
];

describe("分支搜索", () => {
  it("同时覆盖本地和远程，保留完整搜索结果", () => {
    expect(filterBranches(branches, "feature").map((branch) => branch.name)).toEqual([
      "feature/ui",
      "origin/feature/ui",
    ]);
    expect(filterBranches(branches, "missing")).toEqual([]);
    const lists = branchLists(filterBranches(branches, ""));
    expect(lists.local.map((branch) => branch.name)).toEqual(["main", "feature/ui"]);
    expect(lists.remote.map((branch) => branch.name)).toEqual(["origin/main", "origin/feature/ui"]);
    const many = Array.from({ length: 6000 }, (_, index) => ({
      name: `branch-${index}`,
      remote: false,
      current: false,
      upstream: null,
      worktree: null,
    }));
    expect(filterBranches(many, "").length).toBe(6000);
  });
});

describe("重新验证与同步的原地反馈", () => {
  it("重新验证已有内容时保留差异并显示刷新中，失败不清空可读内容", async () => {
    let finish: (value: StatusSnapshot) => void = () => {};
    mocks.refreshStatus.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    render(App);
    await openRepo();
    const before = diffRows();
    expect(before).toBeGreaterThan(0);

    await waitFor(() =>
      expect(mocks.listenEvent.mock.calls.some(([name]) => name === "window-focused")).toBe(true),
    );
    const focus = mocks.listenEvent.mock.calls.find(([name]) => name === "window-focused")![1] as () => void;
    focus();
    await waitFor(() => expect(refreshingStatus()?.textContent).toContain("刷新中"));
    expect(diffRows(), "刷新期间旧差异仍然可读").toBe(before);

    finish({ ...snapshot, generation: 5 });
    await waitFor(() => expect(refreshingStatus()).toBeNull());
    expect(diffRows()).toBe(before);

    // 重新验证失败：错误有结论，旧差异不被清空，进行中状态收起。
    mocks.refreshStatus.mockRejectedValueOnce({ code: "status_failed", message: "无法读取仓库状态。" });
    focus();
    await waitFor(() => expect(document.querySelector(".toast.error .toast-text")?.textContent).toContain("无法读取仓库状态"));
    expect(diffRows(), "刷新失败不能清空旧内容").toBe(before);
    expect(refreshingStatus()).toBeNull();
  });

  it("同步失败说明阶段和重试范围，已有差异保持可读", async () => {
    let failFetch: (reason: unknown) => void = () => {};
    mocks.fetchRemote.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (failFetch = reject)),
    );
    render(App);
    await openRepo();
    const before = diffRows();

    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: /获取更新/ }));
    // 远程网络单独说，不混成本地写入或笼统加载。
    await waitFor(() => expect(document.querySelector(".statusbar .sb-busy .sb-text")?.textContent).toBe("正在检查远程"));
    expect(diffRows(), "同步期间旧差异仍然可读").toBe(before);
    failFetch({ code: "network", message: "远程不可达。" });
    await waitFor(() =>
      expect(document.querySelector(".toast.error .toast-text")?.textContent).toContain("获取更新失败"),
    );
    const message = document.querySelector(".toast.error .toast-text")!.textContent!;
    expect(message).toContain("远程不可达");
    expect(message).toContain("可以重试获取更新");
    expect(diffRows()).toBe(before);
    expect(document.querySelector('[data-refreshing="true"]')).toBeNull();
  });

  it("推送失败保留本地提交结果，重试只推送且不会再次提交", async () => {
    mocks.commitAndPush.mockResolvedValueOnce({
      committed: true,
      pushed: false,
      retryPush: true,
      oid: "abcdef1234567",
      branch: "main",
      summary: "已提交 abcdef1",
      pushError: "远程不可达。",
      generation: 5,
      snapshot: { ...snapshot, generation: 5, files: [] },
    });
    let finishPush: (value: StatusSnapshot) => void = () => {};
    mocks.pushBranch.mockImplementation(() => new Promise((resolve) => (finishPush = resolve)));
    render(App);
    await openRepo();
    const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    await fireEvent.input(textarea, { target: { value: "提交并推送" } });
    await fireEvent.click(screen.getByRole("button", { name: "提交并推送" }));

    const row = await waitFor(() => {
      const node = document.querySelector<HTMLElement>("[data-push-error]");
      expect(node, "推送失败要留在提交区").toBeTruthy();
      return node!;
    });
    expect(row.textContent).toContain("推送失败");
    expect(row.textContent).toContain("本地提交 abcdef1 已完成");
    expect(row.textContent).toContain("不会再次提交");
    const toast = document.querySelector(".toast.error .toast-text")?.textContent ?? "";
    expect(toast).toContain("推送失败");
    expect(toast).toContain("不会再次提交");
    expect(mocks.commitAndPush).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLTextAreaElement>(".composer textarea")?.value, "本地提交成功后草稿清空").toBe("");

    const retry = screen.getByRole("button", { name: "重试推送" });
    const first = fireEvent.click(retry);
    const second = fireEvent.click(retry);
    await Promise.all([first, second]);
    expect(mocks.pushBranch, "写入在途时重复触发只启动一次").toHaveBeenCalledTimes(1);
    expect(mocks.commitAndPush, "重试推送不重复本地提交").toHaveBeenCalledTimes(1);
    expect(document.querySelector(".toast.ok .toast-text")?.textContent).toContain("正在重试推送，不会再次提交");

    finishPush({ ...snapshot, generation: 6, files: [] });
    await waitFor(() => expect(document.querySelector("[data-push-error]")).toBeNull());
    expect(mocks.pushBranch).toHaveBeenLastCalledWith(repoPath, 5, expect.any(Number));
    expect(mocks.commitAndPush).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(document.querySelector(".toast.ok .toast-text")?.textContent).toContain("推送已完成。没有再次创建提交。"),
    );
  });

  it("本地提交失败保留草稿与暂存，错误说明阶段和重试范围", async () => {
    mocks.commitChanges.mockRejectedValueOnce({
      code: "hook_rejected",
      message: "提交钩子拒绝了这次提交。",
    });
    render(App);
    await openRepo();
    const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    await fireEvent.input(textarea, { target: { value: "保留的提交说明" } });
    await fireEvent.click(screen.getByRole("button", { name: "提交到本地" }));

    const inline = await waitFor(() => {
      const node = document.querySelector<HTMLElement>("[data-commit-error]");
      expect(node, "提交区要就地说明失败").toBeTruthy();
      return node!;
    });
    expect(inline.textContent).toContain("本地提交失败");
    expect(inline.textContent).toContain("提交钩子拒绝了这次提交");
    expect(inline.textContent).toContain("草稿和已暂存内容都已保留");
    expect(textarea.value, "失败后说明仍可编辑").toBe("保留的提交说明");
    expect(document.querySelector(".toast.error .toast-text")?.textContent).toContain("本地提交失败");
    expect(mocks.commitChanges).toHaveBeenCalledTimes(1);
    // 暂存范围没有因为失败被清掉，按钮仍可重试。
    expect(screen.getByRole("button", { name: "提交到本地" }).hasAttribute("disabled")).toBe(false);
  });
});
