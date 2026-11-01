import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenedRepository } from "../src/lib/types";

const branchState = vi.hoisted(() => vi.fn());
const switchBranch = vi.hoisted(() => vi.fn());
const tagState = vi.hoisted(() => vi.fn());
const remoteState = vi.hoisted(() => vi.fn());
const addRemote = vi.hoisted(() => vi.fn());
const createBranchFrom = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", () => ({
  api: {
    branchState,
    switchBranch,
    createBranch: vi.fn(),
    createBranchFrom,
    deleteBranch: vi.fn(),
    deleteRemoteBranch: vi.fn(),
    tagState,
    createTag: vi.fn(),
    deleteTag: vi.fn(),
    pushTag: vi.fn(),
    remoteState,
    addRemote,
    setRemoteUrl: vi.fn(),
    cloneRepository: vi.fn(),
  },
  pickDirectory: vi.fn(),
}));

import BranchDialog from "../src/lib/components/BranchDialog.svelte";
import { openModalCount } from "../src/lib/components/Modal.svelte";
import RepoDialogs from "../src/lib/components/RepoDialogs.svelte";

const opened: OpenedRepository = {
  summary: { name: "demo", path: "/repo" },
  generation: 4,
  snapshot: {
    generation: 4,
    branch: {
      name: "feature/ui",
      detached: false,
      unborn: false,
      headOid: "a".repeat(40),
      upstream: "origin/feature/ui",
      ahead: 2,
      behind: 1,
      liveRemoteChecked: true,
      remoteCheckedAtMs: 1,
      remoteCheckStale: false,
    },
    files: [],
  },
  draft: "",
  watchDegraded: false,
};

afterEach(() => cleanup());

function props(overrides: { onClose?: () => void; onSnapshot?: (snapshot: OpenedRepository["snapshot"]) => void } = {}) {
  return {
    opened,
    disabled: false,
    onClose: overrides.onClose ?? vi.fn(),
    onBusy: vi.fn(),
    onSnapshot: overrides.onSnapshot ?? vi.fn(),
    onFailure: vi.fn(),
    onNotice: vi.fn(),
    nextId: () => 9,
  };
}

describe("写锁期间的首次读取", () => {
  const lockedProps = () => ({ ...props(), disabled: true });

  beforeEach(() => {
    branchState.mockReset();
    remoteState.mockReset();
    tagState.mockReset();
    branchState.mockResolvedValue({
      generation: 4,
      branches: [{ name: "feature/ui", remote: false, current: true, upstream: null, worktree: null }],
      snapshot: opened.snapshot,
    });
    remoteState.mockResolvedValue({ generation: 4, remotes: [{ name: "origin", fetchUrl: "https://e.com/r.git", pushUrl: null }], snapshot: opened.snapshot });
    tagState.mockResolvedValue({ generation: 4, tags: [], snapshot: opened.snapshot });
  });

  it("分支：锁定时不读取、显示读取中；解锁后读一次并显示真实列表", async () => {
    const base = lockedProps();
    const { rerender } = render(BranchDialog, { props: base });
    await tick();
    expect(branchState).not.toHaveBeenCalled();
    expect(document.querySelector("[data-branch-loading]")).toBeTruthy();
    expect(document.body.textContent).not.toContain("没有匹配的分支");
    await rerender({ ...base, disabled: false });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    expect(branchState).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-branch-loading]")).toBeNull();
  });

  it("分支：读取失败不循环重试，重试按钮可恢复", async () => {
    branchState.mockReset();
    branchState.mockRejectedValueOnce({ code: "unknown", message: "读不到" });
    const base = props();
    render(BranchDialog, { props: base });
    const retry = await screen.findByRole("button", { name: "重试" });
    await tick();
    await tick();
    expect(branchState).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("没有匹配的分支");
    branchState.mockResolvedValueOnce({
      generation: 4,
      branches: [{ name: "feature/ui", remote: false, current: true, upstream: null, worktree: null }],
      snapshot: opened.snapshot,
    });
    await fireEvent.click(retry);
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    expect(branchState).toHaveBeenCalledTimes(2);
  });

  it("分支：generation 过期不记失败，用新 generation 自动重读一次", async () => {
    const list = await branchState();
    branchState.mockReset();
    branchState.mockRejectedValueOnce({ code: "stale", message: "过期", generation: 6 }).mockResolvedValueOnce(list);
    const base = props();
    render(BranchDialog, { props: base });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    expect(branchState.mock.calls.map((call) => call[1])).toEqual([4, 6]);
    expect(base.onFailure).not.toHaveBeenCalled();
    expect(base.onSnapshot).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("分支：重读仍过期时按失败处理，不循环读取", async () => {
    branchState.mockReset();
    branchState.mockRejectedValue({ code: "stale", message: "过期", generation: 6 });
    const base = props();
    render(BranchDialog, { props: base });
    await screen.findByRole("button", { name: "重试" });
    await tick();
    await tick();
    expect(branchState).toHaveBeenCalledTimes(2);
    expect(base.onFailure).toHaveBeenCalledTimes(1);
  });

  it("分支：重试后焦点落在搜索框，Esc 仍能关闭 modal", async () => {
    branchState.mockReset();
    branchState.mockRejectedValueOnce({ code: "unknown", message: "读不到" });
    branchState.mockReturnValueOnce(new Promise(() => {}));
    const base = props();
    render(BranchDialog, { props: base });
    const retry = await screen.findByRole("button", { name: "重试" });
    retry.focus();
    await fireEvent.click(retry);
    await waitFor(() => expect(document.querySelector("[data-branch-loading]")).toBeTruthy());
    const search = screen.getByLabelText("搜索分支");
    expect(document.activeElement).toBe(search);
    await fireEvent.keyDown(search, { key: "Escape" });
    expect(base.onClose).toHaveBeenCalledTimes(1);
  });

  it("标签页：锁定时不说「还没有标签」，解锁后读取", async () => {
    const base = lockedProps();
    const { rerender } = render(BranchDialog, { props: base });
    await fireEvent.click(screen.getByRole("tab", { name: /标签/ }));
    await tick();
    expect(tagState).not.toHaveBeenCalled();
    expect(document.querySelector("[data-tag-loading]")).toBeTruthy();
    expect(document.body.textContent).not.toContain("还没有标签");
    await rerender({ ...base, disabled: false });
    await waitFor(() => expect(document.body.textContent).toContain("还没有标签"));
    expect(document.querySelector("[data-tag-loading]")).toBeNull();
  });

  it("远程：锁定时不说「还没有远程」；解锁后显示真实远程；失败不循环", async () => {
    const remoteProps = { ...props(), mode: "remote" as const, opened, disabled: true, onOpened: vi.fn(), onOpenHistory: vi.fn() };
    const { rerender } = render(RepoDialogs, { props: remoteProps });
    await tick();
    expect(remoteState).not.toHaveBeenCalled();
    expect(document.querySelector("[data-remote-loading]")).toBeTruthy();
    expect(document.body.textContent).not.toContain("还没有远程");
    await rerender({ ...remoteProps, disabled: false });
    await waitFor(() => expect(document.body.textContent).toContain("https://e.com/r.git"));
    expect(remoteState).toHaveBeenCalledTimes(1);

    await rerender({ ...remoteProps, disabled: false, mode: null });
    remoteState.mockRejectedValueOnce({ code: "unknown", message: "读不到" });
    await rerender({ ...remoteProps, disabled: false });
    const retry = await screen.findByRole("button", { name: "重试" });
    await tick();
    await tick();
    expect(remoteState).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("还没有远程");
    await fireEvent.click(retry);
    await waitFor(() => expect(document.body.textContent).toContain("https://e.com/r.git"));
  });
});

describe("远程读取的过期与重试", () => {
  const remoteList = { generation: 6, remotes: [{ name: "origin", fetchUrl: "https://e.com/r.git", pushUrl: null }], snapshot: opened.snapshot };
  const remoteProps = () => ({ ...props(), mode: "remote" as const, opened, onOpened: vi.fn(), onOpenHistory: vi.fn() });

  beforeEach(() => {
    remoteState.mockReset();
  });

  it("generation 过期不记失败，用新 generation 自动重读一次", async () => {
    remoteState.mockRejectedValueOnce({ code: "stale", message: "过期", generation: 6 }).mockResolvedValueOnce(remoteList);
    const base = remoteProps();
    render(RepoDialogs, { props: base });
    await waitFor(() => expect(document.body.textContent).toContain("https://e.com/r.git"));
    expect(remoteState.mock.calls.map((call) => call[1])).toEqual([4, 6]);
    expect(base.onFailure).not.toHaveBeenCalled();
  });

  it("重读仍过期时按失败处理，不循环读取", async () => {
    remoteState.mockRejectedValue({ code: "stale", message: "过期", generation: 6 });
    const base = remoteProps();
    render(RepoDialogs, { props: base });
    await screen.findByRole("button", { name: "重试" });
    await tick();
    await tick();
    expect(remoteState).toHaveBeenCalledTimes(2);
    expect(base.onFailure).toHaveBeenCalledTimes(1);
  });

  it("重试后焦点落在远程名称，Esc 仍能关闭 modal", async () => {
    remoteState.mockRejectedValueOnce({ code: "unknown", message: "读不到" }).mockReturnValueOnce(new Promise(() => {}));
    const base = remoteProps();
    render(RepoDialogs, { props: base });
    const retry = await screen.findByRole("button", { name: "重试" });
    retry.focus();
    await fireEvent.click(retry);
    await waitFor(() => expect(document.querySelector("[data-remote-loading]")).toBeTruthy());
    const name = screen.getByLabelText("名称");
    expect(document.activeElement).toBe(name);
    await fireEvent.keyDown(name, { key: "Escape" });
    expect(base.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("分支管理", () => {
  beforeEach(() => {
    branchState.mockReset();
    switchBranch.mockReset();
    tagState.mockReset();
    branchState.mockResolvedValue({
      generation: 4,
      branches: [
        { name: "feature/ui", remote: false, current: true, upstream: "origin/feature/ui", worktree: null },
        { name: "main", remote: false, current: false, upstream: "origin/main", worktree: null },
      ],
      snapshot: opened.snapshot,
    });
    tagState.mockResolvedValue({
      generation: 4,
      tags: [{ name: "v1.0.0", targetOid: "b".repeat(40), message: "release", createdAt: 1_700_000_000 }],
      snapshot: opened.snapshot,
    });
  });

  it("打开时只有精简的当前分支行，新建表单点击后才出现并替换列表", async () => {
    render(BranchDialog, { props: props() });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    const status = document.querySelector("[data-branch-status]");
    expect(status?.textContent).toContain("feature/ui");
    expect(status?.textContent).toContain("跟踪 origin/feature/ui");
    expect(screen.queryByLabelText("新建分支")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "新建分支" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("新建分支")));
    expect(document.querySelector(".branch-row"), "不和列表同时铺开").toBeNull();
  });

  it("取消和 Esc 都只收起表单、不关 modal，草稿不残留，焦点回到新建按钮", async () => {
    const base = props();
    render(BranchDialog, { props: base });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    const open = () => fireEvent.click(screen.getByRole("button", { name: "新建分支" }));

    await open();
    await fireEvent.input(screen.getByLabelText("新建分支"), { target: { value: "draft" } });
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "新建分支" })));
    expect(document.querySelector(".branch-row")).toBeTruthy();

    await open();
    const input = screen.getByLabelText("新建分支") as HTMLInputElement;
    expect(input.value).toBe("");
    await fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("新建分支")).toBeNull());
    expect(base.onClose).not.toHaveBeenCalled();
  });

  it("带打开意图时直接展开表单，读取中名称也不失焦", async () => {
    branchState.mockReset();
    let finish: (value: unknown) => void = () => {};
    branchState.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(BranchDialog, { props: { ...props(), startCreating: true } });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("新建分支")));
    await waitFor(() => expect(branchState).toHaveBeenCalled());
    await tick();
    expect((screen.getByLabelText("新建分支") as HTMLInputElement).disabled).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText("新建分支"));
    finish({ generation: 4, branches: [], snapshot: opened.snapshot });
  });

  it("新建写入在途时取消禁用、Esc 不收起，失败后表单和草稿都在", async () => {
    let fail: (reason: unknown) => void = () => {};
    createBranchFrom.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    render(BranchDialog, { props: { ...props(), startCreating: true } });
    await waitFor(() => expect(document.querySelector("[data-branch-create] select option[value='main']")).toBeTruthy());
    const input = screen.getByLabelText("新建分支") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "spike" } });
    await fireEvent.click(screen.getByRole("button", { name: /创建并切换/ }));
    await waitFor(() => expect(createBranchFrom).toHaveBeenCalled());
    await tick();
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(input);
    await fireEvent.keyDown(input, { key: "Escape" });
    await tick();
    expect(screen.queryByLabelText("新建分支")).toBeTruthy();
    fail({ code: "unknown", message: "已存在" });
    await waitFor(() => expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(false));
    expect(input.value).toBe("spike");
    expect(document.activeElement).toBe(input);
  });

  it("新建表单打开时切分区：收起并清空，切回不残留，切到远程也不显示表单", async () => {
    render(BranchDialog, { props: props() });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    await fireEvent.click(screen.getByRole("button", { name: "新建分支" }));
    await fireEvent.input(screen.getByLabelText("新建分支"), { target: { value: "draft" } });
    await fireEvent.click(screen.getByRole("tab", { name: /远程分支/ }));
    expect(screen.queryByLabelText("新建分支")).toBeNull();
    expect(screen.getByRole("tab", { name: /远程分支/ }).getAttribute("aria-selected")).toBe("true");
    await fireEvent.click(screen.getByRole("tab", { name: /本地分支/ }));
    expect(screen.queryByLabelText("新建分支")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "新建分支" }));
    expect((screen.getByLabelText("新建分支") as HTMLInputElement).value).toBe("");
  });

  it("在远程分区点新建：落到本地分区，高亮和表单一致", async () => {
    render(BranchDialog, { props: props() });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    await fireEvent.click(screen.getByRole("tab", { name: /远程分支/ }));
    await fireEvent.click(screen.getByRole("button", { name: "新建分支" }));
    expect(screen.getByLabelText("新建分支")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /本地分支/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("删除确认替换列表，焦点在取消上；取消后回到触发按钮和原滚动位置", async () => {
    render(BranchDialog, { props: props() });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    const list = document.querySelector<HTMLElement>(".branch-list")!;
    list.scrollTop = 40;
    const trigger = screen.getByRole("button", { name: "删除 main" });
    trigger.focus();
    await fireEvent.click(trigger);
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector("[data-modal-impact] .btn-secondary")));
    expect(document.activeElement?.textContent).toBe("取消");
    expect(list.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>(".branch-manager-tools")!.hidden).toBe(true);
    await fireEvent.click(document.activeElement!);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(list.hidden).toBe(false);
    expect(list.scrollTop).toBe(40);
  });

  it("删除确认里 Esc 只收起确认，不关 modal，焦点回到触发按钮", async () => {
    const base = props();
    render(BranchDialog, { props: base });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    const trigger = screen.getByRole("button", { name: "删除 main" });
    trigger.focus();
    await fireEvent.click(trigger);
    await waitFor(() => expect(document.querySelector("[data-modal-impact]")).toBeTruthy());
    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.querySelector("[data-modal-impact]")).toBeNull();
    expect(base.onClose).not.toHaveBeenCalled();
  });

  it("切分区时收起删除确认，切回时列表正常显示", async () => {
    render(BranchDialog, { props: props() });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    await fireEvent.click(screen.getByRole("button", { name: "删除 main" }));
    await waitFor(() => expect(document.querySelector("[data-modal-impact]")).toBeTruthy());
    await fireEvent.click(screen.getByRole("tab", { name: /远程分支/ }));
    await fireEvent.click(screen.getByRole("tab", { name: /本地分支/ }));
    expect(document.querySelector("[data-modal-impact]")).toBeNull();
    expect(document.querySelector<HTMLElement>(".branch-list")!.hidden).toBe(false);
  });

  it("切换成功后更新状态并自动关闭", async () => {
    const onClose = vi.fn();
    const onSnapshot = vi.fn();
    const nextSnapshot = {
      ...opened.snapshot,
      generation: 5,
      branch: { ...opened.snapshot.branch, name: "main", upstream: "origin/main", ahead: 0, behind: 0 },
    };
    switchBranch.mockResolvedValue({
      generation: 5,
      branches: [{ name: "main", remote: false, current: true, upstream: "origin/main", worktree: null }],
      snapshot: nextSnapshot,
    });
    const current = props({ onClose, onSnapshot });
    render(BranchDialog, { props: current });
    await fireEvent.click(await screen.findByRole("button", { name: "切换到 main" }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(switchBranch).toHaveBeenCalledWith("/repo", "main", 4, 9);
    expect(onSnapshot).toHaveBeenCalledWith(nextSnapshot);
    expect(current.onNotice).toHaveBeenCalledWith("已切换到 main");
    expect(current.onBusy).toHaveBeenLastCalledWith(null);
  });

  it("关闭按钮始终调用关闭回调", async () => {
    const onClose = vi.fn();
    render(BranchDialog, { props: props({ onClose }) });
    await screen.findByRole("button", { name: "切换到 main" });
    await fireEvent.click(screen.getByRole("button", { name: /^关闭$/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("分支与标签在同一 modal 内同层切换，不出现第二层 dialog", async () => {
    render(BranchDialog, { props: props() });
    await screen.findByRole("button", { name: "切换到 main" });

    const dialog = screen.getByRole("dialog");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelectorAll("[data-task-modal]")).toHaveLength(1);
    expect(dialog.getAttribute("data-task-modal")).toBe("branch");
    expect(openModalCount()).toBe(1);

    const tablist = screen.getByRole("tablist", { name: "分支与标签分区" });
    expect(tablist).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.trim())).toHaveLength(3);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    const panel = document.getElementById("branch-tab-panel")!;
    expect(panel.getAttribute("data-branch-panel")).toBe("local");
    expect(dialog.contains(panel)).toBe(true);

    await fireEvent.click(screen.getByRole("tab", { name: "标签" }));
    expect(await screen.findByText("v1.0.0")).toBeTruthy();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelectorAll("[data-task-modal]")).toHaveLength(1);
    expect(openModalCount()).toBe(1);
    expect(document.getElementById("branch-tab-panel")!.getAttribute("data-branch-panel")).toBe("tags");
    expect(dialog.contains(screen.getByText("v1.0.0"))).toBe(true);

    await fireEvent.click(screen.getByRole("tab", { name: /本地分支/ }));
    expect(await screen.findByRole("button", { name: "切换到 main" })).toBeTruthy();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("背景施加 inert，Esc 关闭后焦点回到触发元素", async () => {
    const shell = document.createElement("div");
    shell.id = "app-shell";
    const trigger = document.createElement("button");
    trigger.textContent = "打开分支与标签";
    shell.appendChild(trigger);
    document.body.appendChild(shell);
    const toasts = document.createElement("div");
    toasts.className = "toasts";
    toasts.style.position = "fixed";
    document.body.appendChild(toasts);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const onClose = vi.fn();
    const view = render(BranchDialog, { props: props({ onClose }) });
    const dialog = await screen.findByRole("dialog");
    expect(shell.hasAttribute("inert")).toBe(true);
    expect(shell.getAttribute("aria-hidden")).toBe("true");
    // 画在 modal 之上的固定层（toast）保持可交互与可读。
    expect(toasts.hasAttribute("inert")).toBe(false);
    expect(document.activeElement === trigger).toBe(false);

    await fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);

    view.unmount();
    expect(shell.hasAttribute("inert")).toBe(false);
    expect(shell.hasAttribute("aria-hidden")).toBe(false);
    expect(openModalCount()).toBe(0);
    shell.remove();
    toasts.remove();
  });
});

describe("远程管理 modal", () => {
  it("以单一任务 modal 打开并列出远程地址", async () => {
    remoteState.mockReset();
    addRemote.mockReset();
    remoteState.mockResolvedValue({
      generation: 4,
      remotes: [{ name: "origin", fetchUrl: "git@example.com:demo.git", pushUrl: null }],
      snapshot: opened.snapshot,
    });
    render(RepoDialogs, {
      props: {
        mode: "remote",
        opened,
        disabled: false,
        onClose: vi.fn(),
        onBusy: vi.fn(),
        onSnapshot: vi.fn(),
        onOpened: vi.fn(),
        onFailure: vi.fn(),
        onNotice: vi.fn(),
        onOpenHistory: vi.fn(),
        nextId: () => 5,
      },
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("data-task-modal")).toBe("remote");
    expect(document.querySelectorAll("[data-task-modal]")).toHaveLength(1);
    expect(await screen.findByText("origin")).toBeTruthy();
    expect(remoteState).toHaveBeenCalledWith("/repo", 4, 5);
    expect(dialog.querySelector(".modal-desc")?.textContent).toContain("凭据不会保存");
    expect(screen.getByRole("button", { name: /保存远程/ })).toBeTruthy();
  });
});
