import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenedRepository } from "../src/lib/types";

const branchState = vi.hoisted(() => vi.fn());
const switchBranch = vi.hoisted(() => vi.fn());
const tagState = vi.hoisted(() => vi.fn());
const remoteState = vi.hoisted(() => vi.fn());
const addRemote = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", () => ({
  api: {
    branchState,
    switchBranch,
    createBranch: vi.fn(),
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
