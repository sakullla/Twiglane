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
