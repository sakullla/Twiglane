import { tick } from "svelte";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchState, OpenedRepository } from "../src/lib/types";

const api = vi.hoisted(() => ({
  branchState: vi.fn(),
  switchBranch: vi.fn(),
  createBranch: vi.fn(),
  createBranchFrom: vi.fn(),
  renameBranch: vi.fn(),
  deleteBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  tagState: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({ api }));

import BranchDialog from "../src/lib/components/BranchDialog.svelte";

const snapshot = {
  generation: 4,
  branch: {
    name: "feature/ui",
    detached: false,
    unborn: false,
    headOid: "a".repeat(40),
    upstream: null,
    ahead: 0,
    behind: 0,
    liveRemoteChecked: false,
    remoteCheckedAtMs: null,
    remoteCheckStale: false,
  },
  files: [],
};
const opened: OpenedRepository = { summary: { name: "demo", path: "/repo" }, generation: 4, snapshot, draft: "", watchDegraded: false };

const state: BranchState = {
  generation: 4,
  branches: [
    { name: "feature/ui", remote: false, current: true, upstream: null, worktree: null },
    { name: "main", remote: false, current: false, upstream: "origin/main", worktree: null },
    { name: "origin/main", remote: true, current: false, upstream: null, worktree: null },
  ],
  snapshot,
};

function setup() {
  const handlers = { onClose: vi.fn(), onNotice: vi.fn(), onMergeBranch: vi.fn(), onFailure: vi.fn() };
  render(BranchDialog, {
    props: { opened, disabled: false, onBusy: vi.fn(), onSnapshot: vi.fn(), nextId: () => 7, ...handlers },
  });
  return handlers;
}

function rowOf(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(".branch-row")].find((row) => row.querySelector(".lr-title span")?.textContent === name);
  if (!found) throw new Error(`没有分支行 ${name}`);
  return found;
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.branchState.mockResolvedValue(state);
  api.tagState.mockResolvedValue({ generation: 4, tags: [], snapshot });
  api.createBranchFrom.mockResolvedValue(state);
  api.renameBranch.mockResolvedValue(state);
});

describe("分支右键菜单", () => {
  it("给出切换、新建、合并、重命名、复制与删除；当前分支不能删也不能合并到自己", async () => {
    setup();
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(2));
    await fireEvent.contextMenu(rowOf("main"), { clientX: 100, clientY: 100 });
    let menu = screen.getByRole("menu");
    const labels = within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim() ?? "");
    for (const label of ["切换到此分支", "从此分支新建分支…", "合并到当前分支", "重命名…", "复制分支名", "删除…"]) {
      expect(labels.some((text) => text.startsWith(label)), label).toBe(true);
    }
    await fireEvent.keyDown(menu, { key: "Escape" });

    await fireEvent.contextMenu(rowOf("feature/ui"), { clientX: 100, clientY: 100 });
    menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "删除…" }).getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByRole("menuitem", { name: /合并到当前分支/ }).getAttribute("aria-disabled")).toBe("true");
  });

  it("「⋯」按钮打开同一份菜单；合并交给外壳并预选来源", async () => {
    const { onMergeBranch } = setup();
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(2));
    await fireEvent.click(screen.getByRole("button", { name: "main 的更多操作" }));
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /合并到当前分支/ }));
    expect(onMergeBranch).toHaveBeenCalledWith("main");
  });

  it("变基到所点分支；当前分支、其他工作区占用时不可用，远程分支可以当基底", async () => {
    api.branchState.mockResolvedValue({
      ...state,
      branches: [
        ...state.branches,
        { name: "shared", remote: false, current: false, upstream: null, worktree: "D:/other" },
      ],
    });
    const onRebaseBranch = vi.fn();
    render(BranchDialog, {
      props: {
        opened,
        disabled: false,
        onBusy: vi.fn(),
        onSnapshot: vi.fn(),
        onFailure: vi.fn(),
        onNotice: vi.fn(),
        onClose: vi.fn(),
        onMergeBranch: vi.fn(),
        onRebaseBranch,
        nextId: () => 7,
      },
    });
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(3));
    await fireEvent.contextMenu(rowOf("main"), { clientX: 80, clientY: 80 });
    const ontoMain = within(screen.getByRole("menu")).getByRole("menuitem", { name: "把当前分支变基到此分支…" });
    expect(ontoMain.getAttribute("aria-disabled")).toBeNull();
    await fireEvent.click(ontoMain);
    expect(onRebaseBranch).toHaveBeenCalledWith("main");

    await fireEvent.contextMenu(rowOf("feature/ui"), { clientX: 80, clientY: 120 });
    const currentItem = within(screen.getByRole("menu")).getByRole("menuitem", { name: "把当前分支变基到此分支…" });
    expect(currentItem.getAttribute("aria-disabled")).toBe("true");
    expect(currentItem.getAttribute("title")).toBe("这就是当前分支");

    await fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await fireEvent.contextMenu(rowOf("shared"), { clientX: 80, clientY: 160 });
    const occupied = within(screen.getByRole("menu")).getByRole("menuitem", { name: "把当前分支变基到此分支…" });
    expect(occupied.getAttribute("aria-disabled")).toBe("true");
    expect(occupied.getAttribute("title")).toContain("正被其他工作区使用");

    await fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await fireEvent.click(screen.getByRole("tab", { name: /远程分支/ }));
    await waitFor(() => expect(rowOf("origin/main")).toBeTruthy());
    await fireEvent.contextMenu(rowOf("origin/main"), { clientX: 80, clientY: 200 });
    const remote = within(screen.getByRole("menu")).getByRole("menuitem", { name: "把当前分支变基到此分支…" });
    expect(remote.getAttribute("aria-disabled")).toBeNull();
    await fireEvent.click(remote);
    expect(onRebaseBranch).toHaveBeenLastCalledWith("origin/main");
  });

  it("从选中分支新建并切换：起点与切换选项一起传给后端，成功后关闭", async () => {
    const { onClose } = setup();
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(2));
    await fireEvent.contextMenu(rowOf("main"), { clientX: 100, clientY: 100 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "从此分支新建分支…" }));
    expect((screen.getByRole("combobox", { name: "新分支的起点" }) as HTMLSelectElement).value).toBe("main");
    await fireEvent.input(screen.getByLabelText("新建分支"), { target: { value: "hotfix/login" } });
    await fireEvent.click(screen.getByRole("button", { name: /创建并切换/ }));
    await waitFor(() => expect(api.createBranchFrom).toHaveBeenCalledWith("/repo", "hotfix/login", "main", true, 4, 7));
    expect(onClose).toHaveBeenCalled();
  });

  it("默认从当前分支创建；取消「创建后切换」时只创建、不关闭", async () => {
    const { onClose } = setup();
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(2));
    await fireEvent.click(screen.getByRole("button", { name: "新建分支" }));
    await fireEvent.input(screen.getByLabelText("新建分支"), { target: { value: "spike" } });
    await fireEvent.click(screen.getByRole("checkbox", { name: "创建后切换过去" }));
    await fireEvent.click(screen.getByRole("button", { name: /创建分支/ }));
    await waitFor(() => expect(api.createBranchFrom).toHaveBeenCalledWith("/repo", "spike", "feature/ui", false, 4, 7));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("从当前分支新建时起点落在「当前分支」选项上，不留空下拉", async () => {
    setup();
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(2));
    await fireEvent.contextMenu(rowOf("feature/ui"), { clientX: 100, clientY: 100 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "从此分支新建分支…" }));
    const base = screen.getByRole("combobox", { name: "新分支的起点" }) as HTMLSelectElement;
    expect(base.value).toBe("");
    expect(base.selectedIndex).toBe(0);
  });

  it("从分支菜单新建：表单直接展开并聚焦名称，收起后起点不残留", async () => {
    setup();
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(2));
    await fireEvent.contextMenu(rowOf("main"), { clientX: 100, clientY: 100 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "从此分支新建分支…" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("新建分支")));
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "新建分支" })));
    await fireEvent.click(screen.getByRole("button", { name: "新建分支" }));
    expect((screen.getByRole("combobox", { name: "新分支的起点" }) as HTMLSelectElement).value).toBe("");
  });

  it("未合入才升级强删确认：焦点落在取消，再次确认才带 force", async () => {
    api.deleteBranch.mockRejectedValueOnce({ code: "branch_unmerged", message: "未合入" }).mockResolvedValueOnce(state);
    setup();
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(2));
    await fireEvent.click(screen.getByRole("button", { name: "删除 main" }));
    await fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    const force = await screen.findByRole("button", { name: "确认删除未合入分支" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" })));
    expect(api.deleteBranch).toHaveBeenCalledTimes(1);
    expect(api.deleteBranch.mock.calls[0][2]).toBe(false);
    await fireEvent.click(force);
    await waitFor(() => expect(api.deleteBranch).toHaveBeenCalledTimes(2));
    expect(api.deleteBranch.mock.calls[1][2]).toBe(true);
    await waitFor(() => expect(document.querySelector("[data-modal-impact]")).toBeNull());
  });

  it("其它失败不升级强删：收起确认、焦点回到触发按钮", async () => {
    api.deleteBranch.mockRejectedValueOnce({ code: "unknown", message: "网络不可用" });
    const { onNotice } = setup();
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(2));
    const trigger = screen.getByRole("button", { name: "删除 main" });
    trigger.focus();
    await fireEvent.click(trigger);
    await fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(document.querySelector("[data-modal-impact]")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(api.deleteBranch).toHaveBeenCalledTimes(1);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("远程删除：确认后才调用，失败时不报成功", async () => {
    api.branchState.mockResolvedValue({
      ...state,
      branches: [...state.branches, { name: "origin/old", remote: true, current: false, upstream: null, worktree: null }],
    });
    api.deleteRemoteBranch.mockRejectedValueOnce({ code: "unknown", message: "网络不可用" }).mockResolvedValueOnce(state);
    const { onNotice } = setup();
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(2));
    await fireEvent.click(screen.getByRole("tab", { name: /远程分支/ }));
    await fireEvent.click(await screen.findByRole("button", { name: "删除远程 origin/old" }));
    expect(api.deleteRemoteBranch).not.toHaveBeenCalled();
    await fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.deleteRemoteBranch).toHaveBeenCalledTimes(1));
    expect(api.deleteRemoteBranch.mock.calls[0].slice(0, 4)).toEqual(["/repo", "origin", "old", true]);
    await waitFor(() => expect(document.querySelector("[data-modal-impact]")).toBeNull());
    expect(onNotice).not.toHaveBeenCalled();

    await fireEvent.click(await screen.findByRole("button", { name: "删除远程 origin/old" }));
    await fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("已删除远程分支 origin/old"));
  });

  it("重命名区替换列表、焦点落在输入框；Esc 和取消后回到触发按钮", async () => {
    const { onClose } = setup();
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(2));
    const more = screen.getByRole("button", { name: "main 的更多操作" });
    more.focus();
    await fireEvent.click(more);
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "重命名…" }));
    const input = await screen.findByLabelText(/重命名本地分支/);
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(document.querySelector<HTMLElement>(".branch-list")!.hidden).toBe(true);
    await fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(more));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("重命名写入在途时取消禁用、Esc 不收起，成功后焦点落在搜索框", async () => {
    let finish: (value: unknown) => void = () => {};
    api.renameBranch.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    setup();
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(2));
    await fireEvent.contextMenu(rowOf("main"), { clientX: 100, clientY: 100 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "重命名…" }));
    const input = await screen.findByLabelText(/重命名本地分支/);
    await fireEvent.input(input, { target: { value: "trunk" } });
    await fireEvent.click(screen.getByRole("button", { name: "确认重命名" }));
    await waitFor(() => expect(api.renameBranch).toHaveBeenCalled());
    await tick();
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.keyDown(input, { key: "Escape" });
    await tick();
    expect(document.querySelector("[data-branch-rename]")).toBeTruthy();
    finish(state);
    await waitFor(() => expect(document.querySelector("[data-branch-rename]")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("搜索分支")));
  });

  it("重命名：就地输入新名称，确认后调用后端；名称没变时不可确认", async () => {
    setup();
    await waitFor(() => expect(document.querySelectorAll(".branch-row").length).toBe(2));
    await fireEvent.contextMenu(rowOf("main"), { clientX: 100, clientY: 100 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "重命名…" }));
    const confirm = screen.getByRole("button", { name: "确认重命名" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await fireEvent.input(screen.getByLabelText(/重命名本地分支/), { target: { value: "trunk" } });
    await fireEvent.click(screen.getByRole("button", { name: "确认重命名" }));
    await waitFor(() => expect(api.renameBranch).toHaveBeenCalledWith("/repo", "main", "trunk", 4, 7));
  });
});
