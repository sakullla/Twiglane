import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchRecord, BranchTrack, OpenedRepository } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  branchList: vi.fn(),
  branchTracking: vi.fn(),
  updateBranch: vi.fn(),
  pushLocalBranch: vi.fn(),
  renameBranch: vi.fn(),
  deleteBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  switchBranch: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({ api: mocks }));

import { trackingSummary, trackingSummaryText } from "../src/lib/branches";
import BranchSwitcher from "../src/lib/components/BranchSwitcher.svelte";

const snapshot = {
  generation: 4,
  branch: { name: "main", detached: false, unborn: false, upstream: "origin/main", ahead: 0, behind: 0, liveRemoteChecked: false, remoteCheckedAtMs: null, remoteCheckStale: false },
  files: [],
} as unknown as OpenedRepository["snapshot"];
const opened = { summary: { name: "demo", path: "/repo" }, generation: 4, snapshot } as OpenedRepository;

function local(name: string, upstream: string | null = `origin/${name}`, extra: Partial<BranchRecord> = {}): BranchRecord {
  return { name, remote: false, current: name === "main", upstream, worktree: null, ...extra };
}
function remote(name: string): BranchRecord {
  return { name, remote: true, current: false, upstream: null, worktree: null };
}
function track(name: string, ahead: number, behind: number, gone = false): BranchTrack {
  return { name, upstream: `origin/${name}`, ahead, behind, gone };
}

const branches = [local("main"), local("dev"), local("feature/very-long-branch-name-for-energy-control-tower"), local("solo", null), remote("origin/main"), remote("origin/dev"), remote("origin/feature/x")];
const tracks = [track("main", 0, 0), track("dev", 0, 3), track("feature/very-long-branch-name-for-energy-control-tower", 2, 1), { name: "solo", upstream: null, ahead: 0, behind: 0, gone: false }];

function show(extra: Record<string, unknown> = {}) {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const props = {
    anchor,
    opened,
    blockedReason: null as string | null,
    nextId: () => 9,
    onBusy: vi.fn(),
    onGeneration: vi.fn(),
    onSnapshot: vi.fn(),
    onFailure: vi.fn(),
    onNotice: vi.fn(),
    onCommand: vi.fn(),
    onCreateBranch: vi.fn(),
    onTracking: vi.fn(),
    onClose: vi.fn(),
    branchGroups: false,
    ...extra,
  };
  render(BranchSwitcher, { props });
  return props;
}

async function rowOf(name: string): Promise<HTMLElement> {
  const popover = await screen.findByRole("dialog", { name: "切换分支" });
  return waitFor(() => {
    const found = [...popover.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.querySelector(".branch-option-name")?.textContent === name);
    if (!found) throw new Error(`没有 ${name}`);
    return found;
  });
}

async function menuFor(name: string) {
  await fireEvent.contextMenu(await rowOf(name), { clientX: 30, clientY: 40 });
  return screen.getByRole("menu", { name: `${name} 的操作` });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.branchList.mockResolvedValue({ generation: 4, branches, defaultBranch: "main", mergeBases: ["main", "origin/main"] });
  mocks.branchTracking.mockResolvedValue({ generation: 4, branches: tracks });
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("领先/落后汇总", () => {
  it("只数分支，生成一句短提示；都为 0 时没有提示", () => {
    const summary = trackingSummary(tracks);
    expect(summary).toEqual({ pull: 2, push: 1, gone: 0 });
    expect(trackingSummaryText(summary)).toBe("2 个分支需要拉取 · 1 个分支需要推送");
    expect(trackingSummaryText(trackingSummary([]))).toBeNull();
    const many = Array.from({ length: 800 }, (_, index) => track(`b-${index}`, index % 5 === 0 ? 1 : 0, index % 2));
    expect(trackingSummary(many)).toEqual({ pull: 400, push: 160, gone: 0 });
  });
});

describe("分支弹层的同步徽标与不切换的拉取 / 推送", () => {
  it("本地分支行尾显示 ↓落后 ↑领先，顶部汇总可筛出需要拉取的分支，并把读数交给外壳", async () => {
    const props = show();
    const dev = await rowOf("dev");
    await waitFor(() => expect(dev.querySelector("[data-branch-sync]")?.textContent).toContain("↓3"));
    expect(dev.querySelector("[data-branch-sync]")?.getAttribute("title")).toContain("落后上游 3 个提交");
    const long = await rowOf("feature/very-long-branch-name-for-energy-control-tower");
    expect(long.querySelector("[data-branch-sync]")?.textContent?.replace(/\s/g, "")).toBe("↓1↑2");
    expect((await rowOf("origin/dev")).querySelector("[data-branch-sync]"), "远程分支不画徽标").toBeNull();
    expect(props.onTracking).toHaveBeenCalledWith(tracks);

    const summary = screen.getByRole("group", { name: "需要同步的分支" });
    const pull = within(summary).getByRole("button", { name: /2 个需要拉取/ });
    expect(within(summary).getByRole("button", { name: /1 个需要推送/ })).toBeTruthy();
    await fireEvent.click(pull);
    await waitFor(() =>
      expect([...document.querySelectorAll(".branch-option-name")].map((node) => node.textContent)).toEqual(["dev", "feature/very-long-branch-name-for-energy-control-tower"]),
    );
    await fireEvent.click(pull);
    await waitFor(() => expect(document.querySelectorAll(".branch-option-name").length).toBe(branches.length));
  });

  it("非当前分支右键拉取：走快进 updateBranch，不切换分支，弹层留着并刷新列表", async () => {
    const props = show();
    mocks.updateBranch.mockResolvedValue({ generation: 6, branches, snapshot, defaultBranch: "main", mergeBases: [] });
    const menu = await waitFor(async () => {
      const found = await menuFor("dev");
      within(found).getByRole("menuitem", { name: "拉取 3 个提交（快进，不切换）" });
      return found;
    });
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "拉取 3 个提交（快进，不切换）" }));
    await waitFor(() => expect(mocks.updateBranch).toHaveBeenCalledWith("/repo", "dev", 4, 9));
    expect(mocks.switchBranch).not.toHaveBeenCalled();
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith(expect.stringContaining("没有切换分支")));
    expect(props.onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(props.onBusy).toHaveBeenCalledWith("pull");
    expect(props.onBusy).toHaveBeenLastCalledWith(null);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(mocks.branchTracking).toHaveBeenCalledTimes(2);
  });

  it("不能快进时给出明确原因，分支保持原样", async () => {
    const props = show();
    mocks.updateBranch.mockRejectedValue({ code: "branch_not_fast_forward", generation: 5, message: "dev 与 origin/dev 已经分叉（本地领先 1 个提交），不能快进。分支保持原样；请切换到它后合并或变基。" });
    const menu = await menuFor("dev");
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /^拉取/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("不能快进");
    expect(props.onGeneration).toHaveBeenCalledWith(5);
    expect(props.onFailure).toHaveBeenCalled();
  });

  it("当前分支的拉取 / 推送交给同步菜单的常规流程；没有上游的分支拉取不可用、推送即发布", async () => {
    const props = show();
    let menu = await menuFor("main");
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "拉取（快进）" }));
    expect(props.onCommand).toHaveBeenCalledWith("sync.pull");
    expect(mocks.updateBranch).not.toHaveBeenCalled();
    menu = await menuFor("main");
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "推送" }));
    expect(props.onCommand).toHaveBeenCalledWith("sync.push");

    menu = await menuFor("solo");
    const pull = within(menu).getByRole("menuitem", { name: /^拉取/ });
    expect(pull.getAttribute("aria-disabled")).toBe("true");
    mocks.pushLocalBranch.mockResolvedValue({ generation: 6, branches, snapshot });
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "推送并建立上游" }));
    await waitFor(() => expect(mocks.pushLocalBranch).toHaveBeenCalledWith("/repo", "solo", 4, 9));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("已发布 solo 并建立上游。"));
  });

  it("其他工作区检出的分支不能在这里拉取；忙碌时推送给出原因", async () => {
    mocks.branchList.mockResolvedValue({ generation: 4, branches: [local("main"), local("dev", "origin/dev", { worktree: "/wt" })] });
    show({ blockedReason: "正在写入，稍后再试" });
    const menu = await menuFor("dev");
    expect(within(menu).getByRole("menuitem", { name: /^拉取/ }).getAttribute("title")).toBe("正被其他工作区使用：/wt");
    expect(within(menu).getByRole("menuitem", { name: /^推送/ }).getAttribute("title")).toBe("正在写入，稍后再试");
  });

  it("重命名就地展开表单；删除交给分支管理里统一的删除确认", async () => {
    const onDeleteBranch = vi.fn();
    const props = show({ onDeleteBranch });
    mocks.renameBranch.mockResolvedValue({ generation: 6, branches, snapshot });
    let menu = await menuFor("dev");
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名…" }));
    const field = await screen.findByRole("textbox", { name: "新的分支名称" });
    await fireEvent.input(field, { target: { value: "develop" } });
    await fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(mocks.renameBranch).toHaveBeenCalledWith("/repo", "dev", "develop", 4, 9));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("已把 dev 重命名为 develop。"));

    menu = await menuFor("dev");
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "删除分支…" }));
    expect(onDeleteBranch).toHaveBeenCalledWith(expect.objectContaining({ name: "dev", remote: false }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mocks.deleteBranch).not.toHaveBeenCalled();

    menu = await menuFor("main");
    expect(within(menu).getByRole("menuitem", { name: "删除分支…" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("远程分支有自己的右键菜单：检出、合并、复制、从远程删除走统一确认", async () => {
    const onDeleteBranch = vi.fn();
    show({ onMergeBranch: vi.fn(), onDeleteBranch });
    const menu = await menuFor("origin/feature/x");
    const labels = within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim());
    expect(labels).toEqual(expect.arrayContaining(["检出为本地分支并切换", "复制分支名", "从远程删除…"]));
    expect(labels.some((label) => label?.startsWith("拉取"))).toBe(false);
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "从远程删除…" }));
    expect(onDeleteBranch).toHaveBeenCalledWith(expect.objectContaining({ name: "origin/feature/x", remote: true }));
    expect(mocks.deleteRemoteBranch).not.toHaveBeenCalled();
  });

  it("分组行与列表空白处不出 WebView 原生菜单：分组行给自己的菜单", async () => {
    mocks.branchList.mockResolvedValue({ generation: 4, branches: [local("main"), local("feature/a"), local("feature/b")] });
    show({ branchGroups: true });
    const group = await screen.findByRole("button", { name: /分组 feature/ });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    group.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const menu = await screen.findByRole("menu", { name: "分组 feature 的操作" });
    expect(within(menu).getByRole("menuitem", { name: "复制前缀" })).toBeTruthy();
    const label = document.querySelector(".branch-popover-group")!;
    const quiet = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    label.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(true);
  });
});
