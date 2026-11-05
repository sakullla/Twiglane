import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergePreview, OpenedRepository } from "../src/lib/types";

const commitDetail = vi.hoisted(() => vi.fn());
const commitFileDiff = vi.hoisted(() => vi.fn());
const compareFileDiff = vi.hoisted(() => vi.fn());
const commitBranches = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", () => ({
  api: { commitDetail, commitFileDiff, compareFileDiff, commitBranches },
}));

import { trackNameFor } from "../src/lib/branches";
import CommitBranches from "../src/lib/components/CommitBranches.svelte";
import { tick } from "svelte";
import MergeReview from "../src/lib/components/MergeReview.svelte";
import TitleBar from "../src/lib/components/TitleBar.svelte";

const opened: OpenedRepository = {
  summary: { name: "demo", path: "/repo" },
  generation: 4,
  draft: "",
  watchDegraded: false,
  snapshot: {
    generation: 4,
    branch: {
      name: "main",
      detached: false,
      unborn: false,
      headOid: "a".repeat(40),
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      liveRemoteChecked: true,
      remoteCheckedAtMs: 1,
      remoteCheckStale: false,
    },
    files: [],
  },
} as OpenedRepository;

const commitA = { oid: "c".repeat(40), parents: ["b".repeat(40)], summary: "加上登录页", authorName: "Ada", authorEmail: "a@x", authoredAt: 1, labels: [] };
const commitB = { oid: "d".repeat(40), parents: ["c".repeat(40)], summary: "修复登录跳转", authorName: "Grace", authorEmail: "g@x", authoredAt: 2, labels: [] };

function preview(extra: Partial<MergePreview> = {}): MergePreview {
  return {
    generation: 4,
    source: "feature",
    target: "main",
    headOid: "a".repeat(40),
    dirty: false,
    localPaths: [],
    canStart: true,
    operation: "none",
    note: "",
    current: "main",
    needsSwitch: false,
    incoming: 120,
    outgoing: 1,
    upToDate: false,
    fastForward: false,
    commits: [commitA, commitB],
    files: [
      { path: "src/login.ts", originalPath: null, status: "added" },
      { path: "src/app.ts", originalPath: null, status: "modified" },
    ],
    filesTotal: 2,
    conflictCheck: "conflicts",
    conflictPaths: ["src/app.ts"],
    blocker: null,
    baseOid: "1".repeat(40),
    sourceOid: "2".repeat(40),
    ...extra,
  } as MergePreview;
}

function diffOf(path: string) {
  return {
    generation: 4, path, staged: false, binary: false, text: null, summary: "", additions: 1, deletions: 0,
    complete: true, truncated: false, snapshot: "s", offset: 0, totalLines: 2,
    hunks: [{ index: 0, header: "@@ -0,0 +1 @@", complete: true, stageable: false, startLine: 0, lineCount: 2 }],
    lines: [
      { kind: "hunk", text: "@@ -0,0 +1 @@", oldNo: null, newNo: null, hunkIndex: 0 },
      { kind: "add", text: "+export const login = true;", oldNo: null, newNo: 1, hunkIndex: 0 },
    ],
  };
}

describe("合并审阅", () => {
  beforeEach(() => {
    commitDetail.mockReset();
    commitFileDiff.mockReset();
    compareFileDiff.mockReset();
    commitDetail.mockImplementation(async (_repo: string, oid: string) => ({
      generation: 4,
      commit: oid === commitA.oid ? commitA : commitB,
      body: "加上登录页\n\n包含表单与校验",
      root: false,
      merge: false,
      selectedParent: "b".repeat(40),
      files: [{ path: "src/login.ts", originalPath: null, status: "added", additions: 1, deletions: 0 }],
    }));
    commitFileDiff.mockImplementation(async (_repo: string, _oid: string, _parent: string, path: string) => diffOf(path));
    compareFileDiff.mockImplementation(async (_repo: string, _base: string, _head: string, path: string) => diffOf(path));
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function renderReview(extra: Partial<MergePreview> = {}) {
    return render(MergeReview, {
      props: { opened, preview: preview(extra), disabled: false, nextId: () => 1, onGeneration: vi.fn(), onFailure: vi.fn() },
    });
  }

  it("默认选中第一个提交并读出它的明细；点另一个提交或用方向键切换", async () => {
    renderReview();
    const list = screen.getByRole("listbox", { name: "将带入的提交" });
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    await waitFor(() => expect(commitDetail).toHaveBeenCalledWith("/repo", commitA.oid, null, 4, 1));
    expect(await screen.findByText("包含表单与校验")).toBeTruthy();
    expect(screen.getByText("还有 118 个更早的提交没有列出")).toBeTruthy();

    await fireEvent.click(within(list).getByText("修复登录跳转"));
    await waitFor(() => expect(commitDetail).toHaveBeenLastCalledWith("/repo", commitB.oid, null, 4, 1));
    expect(within(list).getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");

    await fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(within(list).getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("文件与冲突页：点开文件看共同祖先到来源顶端的差异，冲突文件带说明", async () => {
    renderReview();
    await fireEvent.click(screen.getByRole("tab", { name: /文件/ }));
    const files = screen.getByRole("listbox", { name: "将带入的文件" });
    expect(within(files).getByText("可能冲突")).toBeTruthy();
    await waitFor(() => expect(compareFileDiff).toHaveBeenCalledWith("/repo", "1".repeat(40), "2".repeat(40), "src/login.ts", 4, 1));

    await fireEvent.click(screen.getByRole("tab", { name: /冲突/ }));
    const conflicts = screen.getByRole("listbox", { name: "预计冲突的文件" });
    expect(within(conflicts).getAllByRole("option")).toHaveLength(1);
    await waitFor(() => expect(compareFileDiff).toHaveBeenLastCalledWith("/repo", "1".repeat(40), "2".repeat(40), "src/app.ts", 4, 1));
    expect(document.querySelector(".merge-detail-note")?.textContent).toContain("main 也改了这个文件");
  });

  it("筛选只留匹配的条目；没有共同祖先时不发差异读取并说明原因", async () => {
    renderReview({ baseOid: null });
    await fireEvent.input(screen.getByRole("textbox", { name: "筛选提交" }), { target: { value: "跳转" } });
    const list = screen.getByRole("listbox", { name: "将带入的提交" });
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    await fireEvent.click(screen.getByRole("tab", { name: /文件/ }));
    expect(await screen.findByText("暂时无法比较这个文件")).toBeTruthy();
    expect(compareFileDiff).not.toHaveBeenCalled();
  });
});

describe("提交所在分支", () => {
  const membership = (oid: string, name: string) => ({
    generation: 4, oid, total: 1, current: name,
    branches: [{ name, remote: false, current: true }],
  });

  it("返回缓存命中的提交时，迟到响应不能覆盖它", async () => {
    let old: (value: ReturnType<typeof membership>) => void = () => {};
    commitBranches.mockResolvedValueOnce(membership("a", "cached-main"));
    const view = render(CommitBranches, { repo: "/cache-race", oid: "a", generation: 4, nextId: () => 1, onGeneration: vi.fn() });
    expect(await screen.findByText("cached-main")).toBeTruthy();
    commitBranches.mockImplementationOnce(() => new Promise((resolve) => { old = resolve; }));
    await view.rerender({ oid: "b" });
    await waitFor(() => expect(commitBranches).toHaveBeenCalledTimes(2));
    await view.rerender({ oid: "a" });
    old(membership("b", "stale-topic"));
    await tick();
    expect(screen.queryByText("stale-topic")).toBeNull();
    expect(screen.getByText("cached-main")).toBeTruthy();
  });

  it("连续切换只运行两个查询；隐藏后不启动排队项或显示迟到结果", async () => {
    const pending: Array<(value: ReturnType<typeof membership>) => void> = [];
    commitBranches.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const view = render(CommitBranches, { repo: "/bounded-branches", oid: "a", generation: 4, nextId: () => 1, onGeneration: vi.fn() });
    await waitFor(() => expect(pending).toHaveLength(1));
    await view.rerender({ oid: "b" });
    await waitFor(() => expect(pending).toHaveLength(2));
    await view.rerender({ oid: "c" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pending).toHaveLength(2);
    await view.rerender({ active: false });
    pending[0](membership("a", "old-a"));
    pending[1](membership("b", "old-b"));
    await tick();
    expect(document.querySelector(".cb-chip")).toBeNull();
    expect(pending).toHaveLength(2);
    view.unmount();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    commitBranches.mockReset();
  });

  it("当前检出的分支排最前并标为当前；超过 6 个时折叠，可展开", async () => {
    const names = Array.from({ length: 8 }, (_, index) => ({ name: `release/${index}`, remote: false, current: false }));
    commitBranches.mockResolvedValue({
      generation: 4, oid: "e".repeat(40), total: 10, current: "main",
      branches: [{ name: "main", remote: false, current: true }, ...names, { name: "origin/main", remote: true, current: false }],
    });
    render(CommitBranches, { props: { repo: "/r1", oid: "e".repeat(40), generation: 4, nextId: () => 1, onGeneration: vi.fn() } });
    await waitFor(() => expect(document.querySelector(".cb-chip.current")?.textContent).toContain("main"));
    expect(document.querySelectorAll(".cb-chip")).toHaveLength(6);
    await fireEvent.click(screen.getByRole("button", { name: "+4" }));
    expect(document.querySelectorAll(".cb-chip")).toHaveLength(10);
  });

  it("当前分支不包含这次提交时明确提示；读取失败可以重试", async () => {
    commitBranches.mockRejectedValueOnce({ code: "history_failed", message: "读不到" });
    commitBranches.mockResolvedValueOnce({
      generation: 4, oid: "f".repeat(40), total: 1, current: "main",
      branches: [{ name: "topic", remote: false, current: false }],
    });
    render(CommitBranches, { props: { repo: "/r2", oid: "f".repeat(40), generation: 4, nextId: () => 1, onGeneration: vi.fn() } });
    await fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect((await screen.findByText(/不在当前分支 main/)).textContent).toContain("main");
    expect(commitBranches).toHaveBeenCalledTimes(2);
  });
});

describe("多远程", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("远程短名被占用时给出不冲突的本地名", () => {
    const local = (name: string) => ({ name, remote: false, current: false, upstream: null, worktree: null });
    expect(trackNameFor("upstream/main", [local("main")])).toBe("upstream-main");
    expect(trackNameFor("upstream/feature/x", [local("upstream-feature/x")])).toBe("upstream-feature/x-2");
  });

  function renderBar(extra: Record<string, unknown> = {}) {
    const props = {
      repo: { name: "demo", path: "/repo" },
      branch: "main",
      theme: "light",
      platform: "macos",
      upstream: "origin/main",
      remotes: ["origin", "upstream", "mirror"],
      onBrand: vi.fn(), onRepo: vi.fn(), onBranch: vi.fn(), onFetch: vi.fn(), onPull: vi.fn(), onPush: vi.fn(),
      onRemote: vi.fn(), onTheme: vi.fn(), onSettings: vi.fn(), onSyncOpen: vi.fn(), onPushTo: vi.fn(), onPushAll: vi.fn(), onCancelSync: vi.fn(),
      ...extra,
    };
    render(TitleBar, { props: props as never });
    return props;
  }

  it("同步菜单列出上游以外的远程，可单独推送或推送到全部", async () => {
    const props = renderBar();
    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    expect(props.onSyncOpen).toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: /^推送.*到 origin\/main/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /^推送到 origin/ })).toBeNull();
    await fireEvent.click(screen.getByRole("menuitem", { name: /^推送到 upstream/ }));
    expect(props.onPushTo).toHaveBeenCalledWith("upstream");
    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /推送到全部 3 个远程/ }));
    expect(props.onPushAll).toHaveBeenCalledTimes(1);
  });

  it("远程操作进行中：其他项不可用，取消项可用", async () => {
    const props = renderBar({ disabled: true, remoteBusy: true, pending: "push" });
    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    expect((screen.getByRole("menuitem", { name: /^推送到 upstream/ }) as HTMLButtonElement).disabled).toBe(true);
    const cancel = screen.getByRole("menuitem", { name: /取消正在进行的同步/ }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    await fireEvent.click(cancel);
    expect(props.onCancelSync).toHaveBeenCalledTimes(1);
  });
});
