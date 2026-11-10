import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchRecord, OpenedRepository } from "../src/lib/types";

const branchState = vi.hoisted(() => vi.fn());
const switchBranch = vi.hoisted(() => vi.fn());
const trackRemoteAs = vi.hoisted(() => vi.fn());
const setUpstream = vi.hoisted(() => vi.fn());
const tagState = vi.hoisted(() => vi.fn());
const remoteState = vi.hoisted(() => vi.fn());
const addRemote = vi.hoisted(() => vi.fn());
const createBranchFrom = vi.hoisted(() => vi.fn());
const renameBranch = vi.hoisted(() => vi.fn());
const cloneRepository = vi.hoisted(() => vi.fn());
const deleteTag = vi.hoisted(() => vi.fn());
const openRepository = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", () => ({
  api: {
    branchState,
    branchList: branchState,
    switchBranch,
    trackRemoteAs,
    setUpstream,
    createBranch: vi.fn(),
    createBranchFrom,
    renameBranch,
    deleteBranch: vi.fn(),
    deleteRemoteBranch: vi.fn(),
    tagState,
    createTag: vi.fn(),
    deleteTag,
    pushTag: vi.fn(),
    remoteState,
    addRemote,
    setRemoteUrl: vi.fn(),
    cloneRepository,
    openRepository,
  },
  pickDirectory: vi.fn(),
}));

import { pickDirectory } from "../src/lib/api";
import BranchDialog from "../src/lib/components/BranchDialog.svelte";
import BranchPicker from "../src/lib/components/BranchPicker.svelte";
import BranchSwitcher from "../src/lib/components/BranchSwitcher.svelte";
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
    await waitFor(() => expect((screen.getByRole("button", { name: "新分支的起点" }) as HTMLButtonElement).disabled).toBe(false));
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

  it("删除确认是叠在列表上的对话框：焦点在取消上，列表原样留着；取消后回到触发按钮", async () => {
    render(BranchDialog, { props: props() });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    const list = document.querySelector<HTMLElement>(".branch-list")!;
    list.scrollTop = 40;
    const trigger = screen.getByRole("button", { name: "删除 main" });
    trigger.focus();
    await fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "删除本地分支" });
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(within(dialog).getByRole("list", { name: "要删除的分支" }).textContent).toContain("main");
    expect(within(dialog).getByRole("button", { name: /删除分支/ })).toBeTruthy();
    expect(list.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>(".branch-manager-tools")!.hidden).toBe(false);
    await fireEvent.click(cancel);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.queryByRole("dialog", { name: "删除本地分支" })).toBeNull();
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

  it("行内垃圾桶：Esc 收起确认后再按 Esc 关闭 modal", async () => {
    const base = props();
    render(BranchDialog, { props: base });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    const trigger = screen.getByRole("button", { name: "删除 main" });
    trigger.focus();
    await fireEvent.click(trigger);
    await waitFor(() => expect(document.querySelector("[data-modal-impact]")).toBeTruthy());
    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(base.onClose).not.toHaveBeenCalled();
    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(base.onClose).toHaveBeenCalledTimes(1);
  });

  it("行内「更多操作」按钮上按 Esc 也能到 Modal", async () => {
    const base = props();
    render(BranchDialog, { props: base });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    const more = screen.getByRole("button", { name: "main 的更多操作" });
    more.focus();
    await fireEvent.keyDown(more, { key: "Escape" });
    expect(base.onClose).toHaveBeenCalledTimes(1);
  });

  it("行内按钮的 Enter 和空格不冒泡成切换分支", async () => {
    render(BranchDialog, { props: props() });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    switchBranch.mockClear();
    for (const name of ["main 的更多操作", "删除 main"]) {
      const button = screen.getByRole("button", { name });
      await fireEvent.keyDown(button, { key: "Enter" });
      await fireEvent.keyDown(button, { key: " " });
    }
    expect(switchBranch).not.toHaveBeenCalled();
  });

  it("重命名在途再按回车：不重复写入，取消仍禁用、Esc 不收起", async () => {
    let finish: (value: unknown) => void = () => {};
    renameBranch.mockReset();
    renameBranch.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const base = props();
    render(BranchDialog, { props: base });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    await fireEvent.contextMenu(document.querySelector<HTMLElement>('[aria-label="切换到 main"]')!);
    await fireEvent.click(await screen.findByRole("menuitem", { name: /重命名/ }));
    const input = await screen.findByLabelText(/重命名本地分支 main/);
    await fireEvent.input(input, { target: { value: "trunk" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(cancel.hasAttribute("disabled")).toBe(true);

    await fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    expect(renameBranch).toHaveBeenCalledTimes(1);
    expect(cancel.hasAttribute("disabled"), "第二次回车不能把写入状态复位").toBe(true);
    await fireEvent.keyDown(input, { key: "Escape" });
    expect(document.querySelector("[data-branch-rename]"), "在途不收起").toBeTruthy();

    finish({ generation: 5, branches: [], snapshot: opened.snapshot });
    await waitFor(() => expect(document.querySelector("[data-branch-rename]")).toBeNull());
  });

  it("新建在途再次提交不会复位写入状态", async () => {
    let finish: (value: unknown) => void = () => {};
    createBranchFrom.mockReset();
    createBranchFrom.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(BranchDialog, { props: props() });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    await fireEvent.click(screen.getByRole("button", { name: "新建分支" }));
    const input = await screen.findByLabelText("新建分支");
    await fireEvent.input(input, { target: { value: "next" } });
    const form = document.querySelector<HTMLFormElement>("[data-branch-create]")!;
    await fireEvent.submit(form);
    await tick();
    await fireEvent.submit(form);
    await tick();
    expect(createBranchFrom).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "取消" }).hasAttribute("disabled")).toBe(true);
    finish({ generation: 5, branches: [], snapshot: opened.snapshot });
    await waitFor(() => expect(document.querySelector("[data-branch-create]")).toBeNull());
  });

  it("标签写入在途：不能切分区，也不能关闭，完成后恢复", async () => {
    let finish: (value: unknown) => void = () => {};
    tagState.mockReset();
    tagState.mockResolvedValue({
      generation: 4,
      tags: [{ name: "v1", targetOid: "a".repeat(40), message: "", createdAt: 1 }],
      snapshot: opened.snapshot,
    });
    deleteTag.mockReset();
    deleteTag.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const base = props();
    render(BranchDialog, { props: base });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    await fireEvent.click(screen.getByRole("tab", { name: /标签/ }));
    await fireEvent.click(await screen.findByRole("button", { name: "删除标签 v1" }));
    await fireEvent.click(await screen.findByRole("button", { name: /^删除标签$/ }));
    await tick();
    // 写入在途：确认框锁住（Esc、右上角关闭都不收起），背后的分区和外层对话框也都不能切走或关闭。
    await fireEvent.keyDown(document.body, { key: "Escape" });
    const confirm = screen.getByRole("dialog", { name: "删除本地标签" });
    expect((within(confirm).getByRole("button", { name: "关闭对话框" }) as HTMLButtonElement).disabled).toBe(true);

    const local = document.getElementById("branch-tab-local")!;
    expect(local.getAttribute("aria-disabled")).toBe("true");
    expect(local.getAttribute("title")).toContain("写入完成");
    await fireEvent.click(local);
    expect(document.querySelector('[data-branch-panel="tags"]'), "在途不切走").toBeTruthy();
    const outerClose = document.querySelector<HTMLButtonElement>('[data-task-modal="branch"] .modal-head .icon-btn')!;
    expect(outerClose.disabled).toBe(true);
    await fireEvent.click(outerClose);
    expect(base.onClose).not.toHaveBeenCalled();

    finish({ generation: 5, tags: [], snapshot: opened.snapshot });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除本地标签" })).toBeNull());
    await waitFor(() => expect(local.getAttribute("aria-disabled")).toBeNull());
    await fireEvent.click(local);
    expect(document.querySelector('[data-branch-panel="local"]')).toBeTruthy();
  });

  it("删除确认打开时背后的分区不可操作，取消后分区照常可切", async () => {
    render(BranchDialog, { props: props() });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    await fireEvent.click(screen.getByRole("button", { name: "删除 main" }));
    await waitFor(() => expect(document.querySelector("[data-modal-impact]")).toBeTruthy());
    expect(screen.queryByRole("tab", { name: /远程分支/ }), "背后的分区被确认框挡住").toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await fireEvent.click(await screen.findByRole("tab", { name: /远程分支/ }));
    expect(document.querySelector('[data-branch-panel="remote"]')).toBeTruthy();
    expect(document.querySelector("[data-modal-impact]")).toBeNull();
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

  function repoProps(mode: "clone" | "remote") {
    return {
      mode,
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
    };
  }

  it("保存远程在途时不能关闭，读取时仍可关闭", async () => {
    remoteState.mockReset();
    addRemote.mockReset();
    remoteState.mockResolvedValue({ generation: 4, remotes: [], snapshot: opened.snapshot });
    let finish: (value: unknown) => void = () => {};
    addRemote.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const base = repoProps("remote");
    render(RepoDialogs, { props: base });
    await screen.findByText("还没有远程。在下面添加一个。");
    await fireEvent.input(screen.getByLabelText("地址"), { target: { value: "https://e.com/r.git" } });
    await fireEvent.click(screen.getByRole("button", { name: /保存远程/ }));
    await tick();
    await fireEvent.keyDown(document.body, { key: "Escape" });
    expect(base.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "关闭" }).hasAttribute("disabled")).toBe(true);
    finish({ generation: 5, remotes: [], snapshot: opened.snapshot });
    await waitFor(() => expect(screen.getByRole("button", { name: "关闭" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.keyDown(document.body, { key: "Escape" });
    expect(base.onClose).toHaveBeenCalledTimes(1);
  });

  it("克隆无法取消：在途时入口写明“在后台继续”，收起后照常打开仓库", async () => {
    vi.mocked(pickDirectory).mockResolvedValue("/parent");
    let finish: (value: unknown) => void = () => {};
    cloneRepository.mockReset();
    cloneRepository.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const base = repoProps("clone");
    render(RepoDialogs, { props: { ...base, opened: null } });
    const start = screen.getByRole("button", { name: /开始克隆/ });
    expect(start.getAttribute("title"), "不可用时说明原因").toBe("先填写远程地址");
    await fireEvent.input(screen.getByLabelText("远程地址"), { target: { value: "https://e.com/r.git" } });
    await fireEvent.click(screen.getByRole("button", { name: /选择目录/ }));
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    await fireEvent.click(start);
    await tick();
    expect(screen.queryByRole("button", { name: "取消" }), "不能写“取消”，后端停不下来").toBeNull();
    expect(document.querySelector("[data-clone-running]")?.textContent).toContain("无法中途取消");
    const keepGoing = screen.getByRole("button", { name: "在后台继续" });
    expect(keepGoing.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "关闭对话框" }).hasAttribute("disabled"), "X 同样可以收起").toBe(false);
    await fireEvent.keyDown(document.body, { key: "Escape" });
    expect(base.onClose).toHaveBeenCalledTimes(1);
    finish({ path: "/parent/r", opened: { ...opened, summary: { name: "r", path: "/parent/r" } } });
    await waitFor(() => expect(base.onOpened).toHaveBeenCalledTimes(1));
  });

  it("收起克隆后打开远程：列表读得到、窗口能关闭，写锁不被读取清掉，保存仍受限", async () => {
    vi.mocked(pickDirectory).mockResolvedValue("/parent");
    remoteState.mockReset();
    remoteState.mockResolvedValue({ generation: 4, remotes: [{ name: "origin", fetchUrl: "https://e.com/r.git", pushUrl: null }], snapshot: opened.snapshot });
    let finish: (value: unknown) => void = () => {};
    cloneRepository.mockReset();
    cloneRepository.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const base = repoProps("clone");
    const view = render(RepoDialogs, { props: base });
    await fireEvent.input(screen.getByLabelText("远程地址"), { target: { value: "https://e.com/r.git" } });
    await fireEvent.click(screen.getByRole("button", { name: /选择目录/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /开始克隆/ }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: /开始克隆/ }));
    await tick();
    expect(base.onBusy).toHaveBeenLastCalledWith("clone");

    // 外壳在克隆期间把 disabled 置真；用户收起克隆，从同步菜单打开远程。
    await view.rerender({ ...base, disabled: true, mode: "remote" });
    expect(await screen.findByText("https://e.com/r.git")).toBeTruthy();
    expect(document.querySelector("[data-remote-loading]"), "不停在“正在读取远程”").toBeNull();
    expect(base.onBusy, "读取不碰克隆占着的写锁").toHaveBeenLastCalledWith("clone");
    expect(remoteState).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /保存远程/ }).hasAttribute("disabled"), "写入仍被拦住").toBe(true);
    expect(screen.getByRole("button", { name: "关闭" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "关闭对话框" }).hasAttribute("disabled")).toBe(false);
    await fireEvent.keyDown(document.body, { key: "Escape" });
    expect(base.onClose).toHaveBeenCalledTimes(1);

    finish({ path: "/parent/r", opened: { ...opened, summary: { name: "r", path: "/parent/r" } } });
    await waitFor(() => expect(base.onOpened).toHaveBeenCalledTimes(1));
    expect(base.onClose, "克隆结束时不去关远程窗口").toHaveBeenCalledTimes(1);
  });

  it("后台克隆期间打开分支与标签：读得到列表，不动写锁，写入仍被拦住", async () => {
    tagState.mockReset();
    tagState.mockResolvedValue({ generation: 4, tags: [{ name: "v1", targetOid: "a".repeat(40), message: "", createdAt: 1 }], snapshot: opened.snapshot });
    branchState.mockReset();
    branchState.mockResolvedValue({
      generation: 4,
      branches: [
        { name: "feature/ui", remote: false, current: true, upstream: null, worktree: null },
        { name: "main", remote: false, current: false, upstream: null, worktree: null },
      ],
      snapshot: opened.snapshot,
    });
    const base = { ...props(), disabled: true, backgroundClone: true };
    render(BranchDialog, { props: base });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    expect(screen.getByRole("button", { name: "删除 main" }).hasAttribute("disabled"), "写入入口仍禁用").toBe(true);
    await fireEvent.click(screen.getByRole("tab", { name: /标签/ }));
    expect(await screen.findByText("v1")).toBeTruthy();
    expect(base.onBusy, "读取不能把克隆的写锁清掉").not.toHaveBeenCalled();
  });

  it("收起后克隆失败仍通知原因，不再去关别的对话框", async () => {
    vi.mocked(pickDirectory).mockResolvedValue("/parent");
    let fail: (reason: unknown) => void = () => {};
    cloneRepository.mockReset();
    cloneRepository.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const base = repoProps("clone");
    const view = render(RepoDialogs, { props: { ...base, opened: null } });
    await fireEvent.input(screen.getByLabelText("远程地址"), { target: { value: "https://e.com/r.git" } });
    await fireEvent.click(screen.getByRole("button", { name: /选择目录/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /开始克隆/ }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: /开始克隆/ }));
    await tick();
    await view.rerender({ ...base, opened: null, mode: null });
    fail({ code: "auth", message: "认证失败" });
    await waitFor(() => expect(base.onFailure).toHaveBeenCalledTimes(1));
    expect(base.onOpened).not.toHaveBeenCalled();
    expect(base.onClose).not.toHaveBeenCalled();
  });
});

describe("打开其他工作区、默认徽章与斜杠分组", () => {
  const anchors: HTMLElement[] = [];

  beforeEach(() => {
    branchState.mockReset();
    switchBranch.mockReset();
    openRepository.mockReset();
    tagState.mockReset();
    tagState.mockResolvedValue({ generation: 4, tags: [], snapshot: opened.snapshot });
  });

  afterEach(() => {
    for (const anchor of anchors) anchor.remove();
    anchors.length = 0;
  });

  function record(name: string, current = false, worktree: string | null = null, remote = false) {
    return { name, remote, current, upstream: null, worktree };
  }

  function onBranch(name: string): OpenedRepository {
    return { ...opened, snapshot: { ...opened.snapshot, branch: { ...opened.snapshot.branch, name } } };
  }

  function rowNames(): string[] {
    return [...document.querySelectorAll<HTMLElement>(".branch-row")].map((row) => row.querySelector(".lr-title span")?.textContent ?? "");
  }

  function badgedRows(): string[] {
    return [...document.querySelectorAll<HTMLElement>(".branch-row [data-default-branch]")].map(
      (chip) => chip.closest(".branch-row")?.querySelector(".lr-title span")?.textContent ?? "",
    );
  }

  function optionNames(): string[] {
    return [...document.querySelectorAll<HTMLElement>('[role="option"] .branch-option-name')].map((node) => node.textContent ?? "");
  }

  function badgedOptions(): string[] {
    return [...document.querySelectorAll<HTMLElement>('[role="option"] [data-default-branch]')].map(
      (chip) => chip.closest('[role="option"]')?.querySelector(".branch-option-name")?.textContent ?? "",
    );
  }

  async function showDialog(branches: ReturnType<typeof record>[], defaultBranch: string | null, current = "feature/ui") {
    branchState.mockResolvedValue({ generation: 4, branches, snapshot: opened.snapshot, defaultBranch });
    const props = {
      ...propsBase(),
      opened: onBranch(current),
    };
    const view = render(BranchDialog, { props });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    return { view, props };
  }

  function propsBase(extra: Record<string, unknown> = {}) {
    return {
      opened,
      disabled: false,
      blockedReason: null as string | null,
      onClose: vi.fn(),
      onBusy: vi.fn(),
      onSnapshot: vi.fn(),
      onFailure: vi.fn(),
      onNotice: vi.fn(),
      onOpened: vi.fn(),
      nextId: () => 9,
      branchGroups: true,
      ...extra,
    };
  }

  function showSwitcher(
    branches: BranchRecord[],
    defaultBranch: string | null,
    current = "feature/ui",
    extra: Record<string, unknown> = {},
  ) {
    branchState.mockResolvedValue({ generation: 4, branches, snapshot: opened.snapshot, defaultBranch });
    const anchor = document.createElement("button");
    document.body.append(anchor);
    anchors.push(anchor);
    const props = {
      anchor,
      opened: onBranch(current),
      blockedReason: null as string | null,
      nextId: () => 9,
      onBusy: vi.fn(),
      onGeneration: vi.fn(),
      onSnapshot: vi.fn(),
      onFailure: vi.fn(),
      onNotice: vi.fn(),
      onCommand: vi.fn(),
      onCreateBranch: vi.fn(),
      onOpened: vi.fn(),
      onClose: vi.fn(),
      branchGroups: true,
      ...extra,
    };
    const view = render(BranchSwitcher, { props });
    return { view, props };
  }

  it("6000 个分支完整分组并虚拟滚动，末尾分支仍可搜索和切换", async () => {
    const branches = Array.from({ length: 6000 }, (_, index) => record(`feature/item-${String(index).padStart(4, "0")}`));
    const { props } = showSwitcher(branches, null, "feature/item-0000");
    await screen.findByRole("button", { name: "收起分组 feature" });
    expect(screen.getByText("6000")).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBeLessThan(30);
    const list = screen.getByRole("listbox");
    list.scrollTop = 36 * 5990;
    await fireEvent.scroll(list);
    expect(await screen.findByRole("option", { name: /feature\/item-5999/ })).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBeLessThan(30);
    await fireEvent.input(screen.getByRole("combobox"), { target: { value: "item-5999" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    switchBranch.mockResolvedValueOnce({ snapshot: opened.snapshot });
    await fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(switchBranch).toHaveBeenCalledWith("/repo", "feature/item-5999", props.opened.generation, 9));
  });

  it("远程分支的短名被跟踪别处的本地分支占用：不报错了事，可以用新名称检出", async () => {
    const listed = [
      { ...record("main", true), upstream: "origin/main" },
      record("origin/main", false, null, true),
      record("upstream/main", false, null, true),
    ];
    const { props } = showSwitcher(listed, "main", "main");
    switchBranch.mockRejectedValueOnce({ code: "branch_upstream_mismatch", generation: 5, message: "本地分支 main 已占用这个短名" });
    await fireEvent.input(screen.getByRole("combobox"), { target: { value: "upstream/main" } });
    await fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    const choice = await screen.findByRole("alert");
    expect(choice.textContent).toContain("本地已有 main");
    expect(choice.textContent).toContain("origin/main");
    expect(props.onFailure).not.toHaveBeenCalled();
    trackRemoteAs.mockResolvedValueOnce({ generation: 6, branches: [], snapshot: onBranch("upstream-main").snapshot });
    await fireEvent.click(within(choice).getByRole("button", { name: /检出为 upstream-main/ }));
    await waitFor(() => expect(trackRemoteAs).toHaveBeenCalledWith("/repo", "upstream/main", "upstream-main", props.opened.generation, 9));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith(expect.stringContaining("upstream-main")));
  });

  it("当前分支可以把上游改成不同名的远程分支，只改配置不推送", async () => {
    const listed = [
      record("feature/ui", true),
      record("origin/HEAD", false, null, true),
      record("origin/feature/ui", false, null, true),
      record("origin/develop", false, null, true),
    ];
    const { props } = await showDialog(listed, null);
    const changed = { ...opened.snapshot, branch: { ...opened.snapshot.branch, upstream: "origin/develop" } };
    setUpstream.mockResolvedValueOnce({ generation: 5, branches: listed, snapshot: changed });
    const picker = screen.getByRole("button", { name: "修改上游分支" });
    await waitFor(() => expect((picker as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(picker);
    await waitFor(() => expect(optionNames()).toEqual(expect.arrayContaining(["origin/develop", "origin/feature/ui"])));
    expect(optionNames(), "符号引用不能作为上游").not.toContain("origin/HEAD");
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.querySelector(".branch-option-name")?.textContent === "origin/develop",
    );
    await fireEvent.click(option!);
    await waitFor(() => expect(setUpstream).toHaveBeenCalledWith("/repo", "origin/develop", props.opened.generation, 9));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith(expect.stringContaining("origin/develop")));
    expect(props.onSnapshot).toHaveBeenCalledWith(changed);
  });

  it("分支菜单打开其他工作区；路径无效或正在写入时留在原仓库", async () => {
    const listed = [record("feature/ui", true), record("shared", false, "D:/wt")];
    const next = { ...opened, summary: { name: "wt", path: "D:/wt" }, generation: 8 };
    openRepository.mockResolvedValueOnce(next);
    const { props } = await showDialog(listed, null);
    const shared = () => {
      const found = [...document.querySelectorAll<HTMLElement>(".branch-row")].find((row) => row.querySelector(".lr-title span")?.textContent === "shared");
      if (!found) throw new Error("没有 shared");
      return found;
    };
    await fireEvent.click(shared());
    expect(switchBranch).not.toHaveBeenCalled();
    await fireEvent.contextMenu(shared(), { clientX: 12, clientY: 12 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "打开此工作区" }));
    await waitFor(() => expect(openRepository).toHaveBeenCalledWith("D:/wt", 9));
    expect(props.onOpened).toHaveBeenCalledWith(next);
    expect(props.onClose).toHaveBeenCalled();
    expect(switchBranch).not.toHaveBeenCalled();
    cleanup();

    openRepository.mockRejectedValueOnce({ code: "not_repository", message: "该目录不是 Git 仓库，未做任何修改。" });
    const failed = await showDialog(listed, null);
    await fireEvent.contextMenu(shared(), { clientX: 12, clientY: 20 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "打开此工作区" }));
    expect((await screen.findByRole("alert")).textContent).toContain("该目录不是 Git 仓库，未做任何修改。");
    expect(failed.props.onOpened).not.toHaveBeenCalled();
    expect(failed.props.onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[data-branch-status]")?.textContent).toContain("feature/ui");
    cleanup();

    const blocked = await showDialog(listed, null);
    await blocked.view.rerender({ ...blocked.props, disabled: true, blockedReason: "正在写入，稍后再试" });
    await fireEvent.contextMenu(shared(), { clientX: 12, clientY: 28 });
    const item = within(screen.getByRole("menu")).getByRole("menuitem", { name: "打开此工作区" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("title")).toBe("正在写入，稍后再试");
    await fireEvent.click(item);
    expect(openRepository).toHaveBeenCalledTimes(2);
    expect(blocked.props.onOpened).not.toHaveBeenCalled();
    expect(document.querySelector("[data-branch-status]")?.textContent).toContain("feature/ui");
  });

  it("切换器打开其他工作区；路径不存在或正在写入时不切走", async () => {
    const listed = [record("feature/ui", true), record("shared", false, "D:/wt"), record("origin/shared", false, null, true)];
    const next = { ...opened, summary: { name: "wt", path: "D:/wt" }, generation: 8 };
    openRepository.mockResolvedValueOnce(next);
    const openedSwitcher = showSwitcher(listed, null);
    const button = async () => within(await screen.findByRole("dialog", { name: "切换分支" })).findByRole("button", { name: "打开此工作区" });
    const option = async () => within(await screen.findByRole("dialog", { name: "切换分支" })).findByRole("option", { name: /^shared/ });
    await fireEvent.click(await option());
    expect(switchBranch).not.toHaveBeenCalled();
    await fireEvent.click(await button());
    await waitFor(() => expect(openRepository).toHaveBeenCalledWith("D:/wt", 9));
    expect(openedSwitcher.props.onOpened).toHaveBeenCalledWith(next);
    expect(openedSwitcher.props.onClose).toHaveBeenCalled();
    expect(openedSwitcher.props.onBusy).toHaveBeenCalledWith("open");
    expect(switchBranch).not.toHaveBeenCalled();
    cleanup();

    openRepository.mockRejectedValueOnce({ code: "path_missing", message: "路径不存在，未创建或修改任何文件。" });
    const missing = showSwitcher(listed, null);
    await fireEvent.click(await button());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("路径不存在，未创建或修改任何文件。");
    expect(missing.props.onOpened).not.toHaveBeenCalled();
    expect(missing.props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "切换分支" })).toBeTruthy();
    expect(switchBranch).not.toHaveBeenCalled();
    cleanup();

    const writing = showSwitcher(listed, null, "feature/ui", { blockedReason: "正在写入，稍后再试" });
    const blockedButton = await button();
    expect((blockedButton as HTMLButtonElement).disabled).toBe(true);
    expect(blockedButton.getAttribute("title")).toBe("正在写入，稍后再试");
    await fireEvent.click(blockedButton);
    await fireEvent.click(await option());
    expect(openRepository).toHaveBeenCalledTimes(2);
    expect(switchBranch).not.toHaveBeenCalled();
    expect(writing.props.onOpened).not.toHaveBeenCalled();
    expect(writing.props.onClose).not.toHaveBeenCalled();
  });

  it("列表和切换器按四种结果标默认徽章，徽章不单独占横幅", async () => {
    await showDialog(
      [record("feature/ui", true), record("main"), record("master"), record("release"), record("origin/main", false, null, true)],
      "release",
    );
    expect(badgedRows()).toEqual(["release"]);
    expect(document.querySelector(".branch-status [data-default-branch], .list-section [data-default-branch]")).toBeNull();
    cleanup();

    const currentDefault = showSwitcher([record("main", true), record("master"), record("origin/main", false, null, true)], "main", "main");
    await waitFor(() => expect(badgedOptions()).toEqual(["main"]));
    const mainOption = screen.getByRole("option", { name: /^main/ });
    expect(mainOption.textContent).toContain("默认");
    expect(mainOption.textContent).toContain("当前");
    expect(mainOption.querySelector("[data-default-branch]")?.textContent).toBe("默认");
    expect(currentDefault.props.onCommand).not.toHaveBeenCalled();
    cleanup();

    await showDialog([record("feature/ui", true), record("master"), record("develop")], "master");
    expect(badgedRows()).toEqual(["master"]);
    cleanup();
    await showDialog([record("feature/ui", true), record("develop")], "develop");
    expect(badgedRows()).toEqual(["develop"]);
    cleanup();
    await showDialog([record("feature/ui", true), record("main"), record("master"), record("develop")], "main");
    expect(badgedRows()).toEqual(["main"]);
    cleanup();

    const none = showSwitcher([record("topic", true)], null, "topic");
    await waitFor(() => expect(optionNames()).toEqual(["topic"]));
    expect(document.querySelector("[data-default-branch]")).toBeNull();
    expect(none.props.onClose).not.toHaveBeenCalled();
  });

  it("切换器分组展开当前组，标题不能检出，搜索显示完整名称", async () => {
    switchBranch.mockResolvedValue({ generation: 5, branches: [], snapshot: opened.snapshot });
    const listed = [record("feature/a", true), record("feature/b"), record("bugfix/x"), record("main"), record("origin/feature/a", false, null, true)];
    showSwitcher(listed, "main", "feature/a");
    await waitFor(() => expect(optionNames()).toEqual(["main", "feature/a", "feature/b"]));
    expect(badgedOptions()).toEqual(["main"]);
    expect(screen.getByRole("option", { name: /^feature\/a/ }).getAttribute("aria-selected")).toBe("true");
    const title = screen.getByRole("button", { name: "收起分组 feature" });
    expect(title.getAttribute("role")).not.toBe("option");
    await fireEvent.click(title);
    await fireEvent.click(screen.getByRole("button", { name: "展开分组 bugfix" }));
    expect(switchBranch).not.toHaveBeenCalled();
    expect(screen.queryByRole("option", { name: /^feature\/a/ })).toBeNull();

    const search = screen.getByRole("combobox", { name: "搜索本地或远程分支" });
    await fireEvent.input(search, { target: { value: "feature/b" } });
    await waitFor(() => expect(optionNames()).toEqual(["feature/b"]));
    expect(screen.queryByRole("button", { name: /分组/ })).toBeNull();
    await fireEvent.click(screen.getByRole("option", { name: "feature/b" }));
    await waitFor(() => expect(switchBranch).toHaveBeenCalledWith("/repo", "feature/b", 4, 9));
  });

  it("切换器关闭分组后平铺，再次开启仍分组且当前分支不变", async () => {
    const listed = [record("feature/a", true), record("feature/b"), record("bugfix/x"), record("main")];
    const mounted = showSwitcher(listed, "main", "feature/a");
    await waitFor(() => expect(optionNames()).toEqual(["main", "feature/a", "feature/b"]));
    await fireEvent.click(screen.getByRole("button", { name: "展开分组 bugfix" }));
    expect(optionNames()).toContain("bugfix/x");

    await mounted.view.rerender({ ...mounted.props, branchGroups: false });
    await waitFor(() => expect(optionNames()).toEqual(["feature/a", "feature/b", "bugfix/x", "main"]));
    expect(screen.queryByRole("button", { name: /分组/ })).toBeNull();
    expect(badgedOptions()).toEqual(["main"]);
    expect(screen.getByRole("option", { name: "bugfix/x" }).querySelector(".branch-option-name")?.textContent).toBe("bugfix/x");

    await mounted.view.rerender({ ...mounted.props, branchGroups: true });
    await waitFor(() => expect(optionNames()).toEqual(["main", "feature/a", "feature/b"]));
    expect(screen.getByRole("button", { name: "展开分组 bugfix" })).toBeTruthy();
    expect(badgedOptions()).toEqual(["main"]);
    expect(screen.getByRole("option", { name: /^feature\/a/ }).getAttribute("aria-selected")).toBe("true");
    expect(switchBranch).not.toHaveBeenCalled();
    expect(openRepository).not.toHaveBeenCalled();
  });

  it("对话框分组随设置关闭后平铺，再打开仍只展开当前分支所在组", async () => {
    const listed = [record("feature/ui", true), record("feature/extra"), record("bugfix/login"), record("main")];
    const mounted = await showDialog(listed, "main");
    expect(rowNames()).toEqual(["main", "feature/ui", "feature/extra"]);
    await mounted.view.rerender({ ...mounted.props, branchGroups: false });
    await waitFor(() => expect(rowNames()).toEqual(["feature/ui", "feature/extra", "bugfix/login", "main"]));
    expect(document.querySelector(".branch-group")).toBeNull();
    expect(badgedRows()).toEqual(["main"]);
    await mounted.view.rerender({ ...mounted.props, branchGroups: true });
    await waitFor(() => expect(rowNames()).toEqual(["main", "feature/ui", "feature/extra"]));
    expect(screen.getByRole("button", { name: "展开分组 bugfix" })).toBeTruthy();
    const title = screen.getByRole("button", { name: "收起分组 feature" });
    await fireEvent.click(title);
    expect(switchBranch).not.toHaveBeenCalled();
    expect(document.querySelector("[data-branch-status]")?.textContent).toContain("feature/ui");
    expect(badgedRows()).toEqual(["main"]);
  });

  it("合并的分支选择器按设置分组：含当前或已选分支的组展开，关掉设置后平铺，搜索时也平铺", async () => {
    const listed = [record("feature/a", true), record("feature/b"), record("bugfix/x"), record("main"), record("origin/main", false, null, true)];
    const onChange = vi.fn();
    const props = { label: "来源分支", branches: listed, value: "main", current: "feature/a", onChange, branchGroups: true };
    const view = render(BranchPicker, { props });
    await fireEvent.click(screen.getByRole("button", { name: "来源分支" }));
    await waitFor(() => expect(optionNames()).toEqual(["main", "feature/a", "feature/b"]));
    expect(screen.getByRole("button", { name: "收起分组 feature" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开分组 bugfix" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开分组 origin" })).toBeTruthy();

    // 分组标题不是选项：展开只改列表，不触发选择。
    await fireEvent.click(screen.getByRole("button", { name: "展开分组 bugfix" }));
    expect(optionNames()).toEqual(["main", "feature/a", "feature/b", "bugfix/x"]);
    expect(onChange).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "收起分组 feature" }));
    expect(optionNames()).toEqual(["main", "bugfix/x"]);

    // 键盘只在看得见的分支之间移动，回车选中的就是高亮的那一个。
    const search = screen.getByLabelText("搜索来源分支");
    await fireEvent.keyDown(search, { key: "ArrowDown" });
    await fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("bugfix/x");

    await fireEvent.click(screen.getByRole("button", { name: "来源分支" }));
    await fireEvent.input(screen.getByLabelText("搜索来源分支"), { target: { value: "b" } });
    await waitFor(() => expect(optionNames()).toEqual(["feature/b", "bugfix/x"]));
    expect(screen.queryByRole("button", { name: /分组/ })).toBeNull();

    await view.rerender({ ...props, branchGroups: false });
    await fireEvent.input(screen.getByLabelText("搜索来源分支"), { target: { value: "" } });
    await waitFor(() => expect(optionNames()).toEqual(["feature/a", "feature/b", "bugfix/x", "main", "origin/main"]));
    expect(screen.queryByRole("button", { name: /分组/ })).toBeNull();
  });

  it("新建分支的起点下拉框按设置分组：开启时按前缀成组，关闭时平铺", async () => {
    const listed = [record("feature/ui", true), record("feature/extra"), record("bugfix/login"), record("main"), record("origin/main", false, null, true)];
    const mounted = await showDialog(listed, "main");
    await fireEvent.click(screen.getByRole("button", { name: "新建分支" }));
    const base = () => screen.getByRole("button", { name: "新分支的起点" });
    const groups = () => [...document.querySelectorAll<HTMLElement>("[data-branch-group]")].map((node) => node.dataset.branchGroup);
    await waitFor(() => expect((base() as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(base());
    // 当前分支由顶部的「当前分支」选项代表，列表里不重复出现。
    expect(optionNames()).toEqual(["当前分支（feature/ui）", "main"]);
    expect(groups()).toEqual(["feature", "bugfix", "origin"]);
    expect(badgedOptions()).toEqual(["main"]);
    await fireEvent.click(screen.getByRole("button", { name: "展开分组 origin" }));
    expect(optionNames()).toEqual(["当前分支（feature/ui）", "main", "origin/main"]);
    await fireEvent.click(screen.getByRole("option", { name: "origin/main" }));
    expect(base().dataset.value).toBe("origin/main");
    expect(screen.queryByRole("listbox")).toBeNull();

    await mounted.view.rerender({ ...mounted.props, branchGroups: false });
    await fireEvent.click(base());
    expect(groups()).toEqual([]);
    expect(optionNames()).toEqual(["当前分支（feature/ui）", "feature/extra", "bugfix/login", "main", "origin/main"]);
    await fireEvent.click(screen.getByRole("option", { name: "当前分支（feature/ui）" }));
    expect(base().dataset.value).toBe("");
  });

  it("切换器的分支行有右键菜单：新建、合并、变基带上所点分支，当前分支不能再切换", async () => {
    const listed = [record("feature/ui", true), record("main"), record("shared", false, "D:/wt"), record("origin/main", false, null, true)];
    const onMergeBranch = vi.fn();
    const onMergeInto = vi.fn();
    const onRebaseBranch = vi.fn();
    const { props } = showSwitcher(listed, "main", "feature/ui", { onMergeBranch, onMergeInto, onRebaseBranch });
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    const main = await within(popover).findByRole("option", { name: /^main/ });

    await fireEvent.contextMenu(main, { clientX: 40, clientY: 60 });
    let menu = screen.getByRole("menu", { name: "main 的操作" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "切换到此分支",
      "从此分支新建分支…",
      "合并到当前分支（feature/ui）…",
      "把 feature/ui 合并到此分支…",
      "把当前分支变基到此分支…",
      "复制分支名",
      "重命名或删除…",
    ]);
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "从此分支新建分支…" }));
    expect(props.onCreateBranch).toHaveBeenLastCalledWith("main");

    await fireEvent.contextMenu(main, { clientX: 40, clientY: 60 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^合并到当前分支/ }));
    expect(onMergeBranch).toHaveBeenLastCalledWith("main");
    await fireEvent.contextMenu(main, { clientX: 40, clientY: 60 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "把 feature/ui 合并到此分支…" }));
    expect(onMergeInto).toHaveBeenLastCalledWith("main");
    await fireEvent.contextMenu(main, { clientX: 40, clientY: 60 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "把当前分支变基到此分支…" }));
    expect(onRebaseBranch).toHaveBeenLastCalledWith("main");

    // 当前分支：切换、合并、变基都给出原因；从当前分支新建时不带起点。
    await fireEvent.contextMenu(within(popover).getByRole("option", { name: /^feature\/ui/ }), { clientX: 40, clientY: 60 });
    menu = screen.getByRole("menu", { name: "feature/ui 的操作" });
    const switchItem = within(menu).getByRole("menuitem", { name: "切换到此分支" });
    expect(switchItem.getAttribute("aria-disabled")).toBe("true");
    expect(switchItem.getAttribute("title")).toBe("这就是当前分支");
    for (const name of [/^合并到当前分支/, /合并到此分支/, /变基到此分支/]) {
      expect(within(menu).getByRole("menuitem", { name }).getAttribute("title")).toBe("这就是当前分支");
    }
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "从此分支新建分支…" }));
    expect(props.onCreateBranch).toHaveBeenLastCalledWith(undefined);

    // 其他工作区占用的分支：可以打开那个工作区，不能在这里切换。
    await fireEvent.contextMenu(within(popover).getByRole("option", { name: /^shared/ }), { clientX: 40, clientY: 60 });
    menu = screen.getByRole("menu", { name: "shared 的操作" });
    expect(within(menu).getByRole("menuitem", { name: "切换到此分支" }).getAttribute("title")).toBe("正被其他工作区使用：D:/wt");
    expect(within(menu).getByRole("menuitem", { name: "打开此工作区" }).getAttribute("aria-disabled")).toBeNull();

    // Esc 只关菜单，弹层还在；菜单键在键盘当前项上打开同一份菜单。
    await fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "切换分支" })).toBe(popover);
    await fireEvent.keyDown(within(popover).getByRole("combobox"), { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(switchBranch).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("写入中切换器在顶部说明一次原因，条目置灰并把原因放进提示", async () => {
    showSwitcher([record("feature/ui", true), record("main")], null, "feature/ui", { blockedReason: "正在写入，稍后再试" });
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    expect(within(popover).getByRole("status").textContent).toContain("正在写入，稍后再试");
    const main = await within(popover).findByRole("option", { name: "main" });
    expect(main.getAttribute("aria-disabled")).toBe("true");
    expect(main.getAttribute("title")).toBe("正在写入，稍后再试");
    expect(main.textContent?.trim()).toBe("main");
  });

  it("占用中的分支在弹层里就地写明原因，不用悬停", async () => {
    showSwitcher([record("feature/ui", true), record("shared", false, "D:/wt")], null, "feature/ui");
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    const shared = await within(popover).findByRole("option", { name: /shared/ });
    expect(shared.getAttribute("aria-disabled")).toBe("true");
    expect(shared.querySelector(".branch-option-note")?.textContent).toBe("其他工作区");
    expect(shared.getAttribute("title")).toBe("正被其他工作区使用：D:/wt");
  });

  it("分支对话框里的起点下拉：Esc 只收起下拉，不关闭对话框；从分支弹层带来的起点直接选好", async () => {
    branchState.mockResolvedValue({ generation: 4, branches: [record("feature/ui", true), record("main")], snapshot: opened.snapshot, defaultBranch: "main" });
    const props = { ...propsBase(), opened: onBranch("feature/ui"), startCreating: true, startBase: "main" };
    render(BranchDialog, { props });
    const base = () => screen.getByRole("button", { name: "新分支的起点" }) as HTMLButtonElement;
    await waitFor(() => expect(base().disabled).toBe(false));
    expect(base().dataset.value).toBe("main");
    await fireEvent.click(base());
    const search = screen.getByLabelText("搜索新分支的起点");
    await waitFor(() => expect(document.activeElement).toBe(search));
    await fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByLabelText("搜索新分支的起点")).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("新建分支")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(base()));
  });

  it("主干分支（本地默认分支和它的远程对应分支）用星标；已合入主干的分支只是一枚小勾徽章", async () => {
    const listed = [
      record("feature/ui", true),
      record("main"),
      { ...record("done"), merged: true },
      record("origin/main", false, null, true),
      { ...record("origin/done", false, null, true), merged: true },
    ];
    branchState.mockResolvedValue({ generation: 4, branches: listed, snapshot: opened.snapshot, defaultBranch: "main", mergeBases: ["main", "origin/main"] });
    const anchor = document.createElement("button");
    document.body.append(anchor);
    anchors.push(anchor);
    render(BranchSwitcher, {
      props: {
        anchor,
        opened: onBranch("feature/ui"),
        blockedReason: null,
        nextId: () => 9,
        onBusy: vi.fn(),
        onGeneration: vi.fn(),
        onSnapshot: vi.fn(),
        onFailure: vi.fn(),
        onNotice: vi.fn(),
        onCommand: vi.fn(),
        onCreateBranch: vi.fn(),
        onClose: vi.fn(),
        branchGroups: false,
      },
    });
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    await waitFor(() => expect(within(popover).getAllByRole("option").length).toBe(5));
    const starred = [...popover.querySelectorAll(".branch-option-icon.main")].map((icon) => icon.closest('[role="option"]')?.querySelector(".branch-option-name")?.textContent);
    expect(starred).toEqual(["main", "origin/main"]);
    const merged = [...popover.querySelectorAll<HTMLElement>("[data-merged-branch]")];
    expect(merged.map((badge) => badge.closest('[role="option"]')?.querySelector(".branch-option-name")?.textContent)).toEqual(["done", "origin/done"]);
    expect(merged[0].textContent?.trim(), "徽章不带文字").toBe("");
    expect(merged[0].getAttribute("aria-label")).toBe("已合入主干");
    expect(merged[0].title).toContain("main 和 origin/main");
    cleanup();

    render(BranchDialog, { props: { ...propsBase(), opened: onBranch("feature/ui"), branchGroups: false } });
    await waitFor(() => expect(document.querySelector(".branch-row")).toBeTruthy());
    const mainRow = [...document.querySelectorAll<HTMLElement>(".branch-row")].find((row) => row.querySelector(".lr-title span")?.textContent === "main")!;
    expect(mainRow.querySelector(".branch-row-icon.main")).toBeTruthy();
    expect(mainRow.querySelector(".branch-row-icon")?.getAttribute("title")).toBe("主干分支");
  });

  it("默认徽章不大于当前分支标记", () => {
    const css = readFileSync(path.join(__dirname, "../src/styles/components.css"), "utf8");
    const height = (selector: string) => {
      const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*?height:\\s*(\\d+)px`);
      const found = css.match(pattern);
      if (!found) throw new Error(`没有 ${selector} 的高度`);
      return Number(found[1]);
    };
    expect(height(".branch-row .chip.default-branch")).toBeLessThanOrEqual(height(".chip"));
    expect(height(".branch-picker-tag.default-branch")).toBeLessThanOrEqual(height(".branch-picker-tag"));
  });
});
