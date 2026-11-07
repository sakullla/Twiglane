import { readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import CommandPalette from "../src/lib/components/CommandPalette.svelte";
import MergeBanner from "../src/lib/components/MergeBanner.svelte";
import RepoSwitcher from "../src/lib/components/RepoSwitcher.svelte";
import StatusBar from "../src/lib/components/StatusBar.svelte";
import TitleBar from "../src/lib/components/TitleBar.svelte";
import ViewSwitcher from "../src/lib/components/ViewSwitcher.svelte";
import Welcome from "../src/lib/components/Welcome.svelte";
import { rowOffsets, rowWindow } from "../src/lib/recent";
import type { RecentRepo, RepoSummary, Theme } from "../src/lib/types";

const repos: RecentRepo[] = [
  { name: "demo", path: "/work/alpha/demo", openedAtMs: 2 },
  { name: "demo", path: "/work/beta/demo", openedAtMs: 1 },
];

const repo: RepoSummary = { name: "demo", path: "/work/alpha/demo" };

describe("仓库弹层", () => {
  function repoProps(overrides: Record<string, unknown> = {}) {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    return {
      anchor,
      repos,
      currentPath: repos[0].path,
      blockedReason: null,
      actionReason: null,
      onSelect: () => {},
      onForget: () => {},
      onCopyPath: () => {},
      onContextMenu: () => {},
      onCommand: () => {},
      onClose: () => {},
      ...overrides,
    };
  }

  it("同时展示同名仓库的完整路径", () => {
    render(RepoSwitcher, { props: repoProps() as never });
    expect(screen.getAllByText("demo")).toHaveLength(2);
    expect(screen.getByText("/work/alpha/demo")).toBeTruthy();
    expect(screen.getByText("/work/beta/demo")).toBeTruthy();
  });

  it("搜索框只过滤最近仓库，框内不挂 Ctrl/⌘K 键帽", () => {
    render(RepoSwitcher, { props: repoProps() as never });
    const dialog = screen.getByRole("dialog", { name: "切换仓库" });
    const input = within(dialog).getByRole("combobox") as HTMLInputElement;
    expect(input.placeholder).toContain("仓库");
    expect(input.placeholder).not.toMatch(/命令|Ctrl|⌘/);
    expect(dialog.querySelector("kbd")).toBeNull();
  });

  it("打开、克隆、新建入口都在弹层底部，取代 rail 的添加仓库菜单", async () => {
    const onCommand = vi.fn();
    render(RepoSwitcher, { props: repoProps({ onCommand }) as never });
    for (const [name, id] of [["打开本地仓库", "repo.add"], ["克隆远程仓库", "repo.clone"], ["新建仓库", "repo.create"]]) {
      await fireEvent.click(screen.getByRole("button", { name }));
      expect(onCommand).toHaveBeenLastCalledWith(id);
    }
  });
});

describe("大量最近仓库", () => {
  /** RepoSwitcher 里单行与多一行原因文字的估算高度。 */
  const ROW = 49;
  const LINE = 16;
  const many: RecentRepo[] = Array.from({ length: 500 }, (_, index) => {
    const name = index === 300 || index === 450 ? "demo" : `repo-${index}`;
    return { name, path: `/work/group-${index}/${name}`, openedAtMs: index };
  });

  function props(overrides: Record<string, unknown> = {}) {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    return {
      anchor,
      repos: many,
      currentPath: many[0].path,
      blockedReason: null,
      actionReason: null,
      onSelect: vi.fn(),
      onForget: () => {},
      onCopyPath: () => {},
      onContextMenu: vi.fn(),
      onCommand: () => {},
      onClose: () => {},
      ...overrides,
    };
  }

  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  const active = () => document.querySelector<HTMLElement>(".switcher-option.active");
  const input = () => within(screen.getByRole("dialog", { name: "切换仓库" })).getByRole("combobox") as HTMLInputElement;

  it("行窗口：只覆盖视口和上下余量，首尾不越界", () => {
    const offsets = rowOffsets(Array.from({ length: 100 }, () => 40));
    expect(offsets[100]).toBe(4000);
    expect(rowWindow(offsets, 0, 400, 2)).toEqual({ start: 0, end: 12 });
    expect(rowWindow(offsets, 2000, 400, 2)).toEqual({ start: 48, end: 62 });
    expect(rowWindow(offsets, 3900, 400, 2)).toEqual({ start: 95, end: 100 });
    expect(rowWindow(rowOffsets([]), 0, 400, 2)).toEqual({ start: 0, end: 0 });
    expect(rowWindow(rowOffsets([10, 100, 10]), 50, 10, 0), "高度不同也落在对的行").toEqual({ start: 1, end: 2 });
  });

  it("500 个仓库只渲染视口附近的行，内容轨道按全量撑高", () => {
    render(RepoSwitcher, { props: props() as never });
    expect(options().length).toBeLessThan(30);
    expect(parseInt((document.querySelector(".switcher-space") as HTMLElement).style.height, 10)).toBeGreaterThan(500 * 30);
    expect(options()[0].getAttribute("aria-setsize")).toBe("500");
  });

  it("滚动后渲染窗口跟着走，定位按全量下标", async () => {
    render(RepoSwitcher, { props: props() as never });
    const list = document.querySelector(".popover-list") as HTMLElement;
    list.scrollTop = ROW * 200;
    await fireEvent.scroll(list);
    const indexes = options().map((option) => Number(option.dataset.index));
    expect(indexes).toContain(200);
    expect(indexes.filter((index) => index > 1).every((index) => index > 150 && index < 240)).toBe(true);
    const row = options().find((option) => option.dataset.index === "200")?.parentElement as HTMLElement;
    expect(row.style.top).toBe(`${ROW * 200}px`);
  });

  it("过滤对全量生效，不区分大小写，能搜路径片段", async () => {
    render(RepoSwitcher, { props: props() as never });
    await fireEvent.input(input(), { target: { value: "GROUP-449" } });
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain("repo-449");
    expect(options()[0].dataset.index).toBe("0");
  });

  it("换关键词时滚动回到顶部", async () => {
    render(RepoSwitcher, { props: props() as never });
    const list = document.querySelector(".popover-list") as HTMLElement;
    list.scrollTop = 4000;
    await fireEvent.scroll(list);
    await fireEvent.input(input(), { target: { value: "repo-1" } });
    expect(list.scrollTop).toBe(0);
    expect(options().some((option) => option.dataset.index === "0")).toBe(true);
  });

  it("方向键能走到窗口外的行，回车切换；反向绕到最后一个", async () => {
    const onSelect = vi.fn();
    render(RepoSwitcher, { props: props({ onSelect }) as never });
    for (let step = 0; step < 60; step += 1) await fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(active()?.textContent).toContain("repo-61");
    expect(active()?.getAttribute("aria-posinset")).toBe("62");
    expect(input().getAttribute("aria-activedescendant")).toBe(active()?.id);
    await fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(many[61].path);
  });

  it("首项按向上绕到最后一个仓库，当前项不在窗口里也有节点", async () => {
    render(RepoSwitcher, { props: props({ currentPath: null }) as never });
    await fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(active()?.dataset.index).toBe("499");
    expect(document.getElementById(input().getAttribute("aria-activedescendant") as string)).toBe(active());
  });

  it("滚走之后当前项仍有节点，菜单键落在它身上", async () => {
    const onContextMenu = vi.fn();
    render(RepoSwitcher, { props: props({ onContextMenu }) as never });
    const list = document.querySelector(".popover-list") as HTMLElement;
    list.scrollTop = ROW * 300;
    await fireEvent.scroll(list);
    await fireEvent.keyDown(input(), { key: "F10", shiftKey: true });
    expect(onContextMenu).toHaveBeenCalledWith(many[1], expect.anything(), null);
  });

  it("窗口里的行右键给到对应仓库，同名行显示完整路径", async () => {
    const onContextMenu = vi.fn();
    render(RepoSwitcher, { props: props({ onContextMenu }) as never });
    const list = document.querySelector(".popover-list") as HTMLElement;
    list.scrollTop = ROW * 300;
    await fireEvent.scroll(list);
    const row = options().find((option) => option.dataset.index === "300") as HTMLElement;
    expect(row.querySelector(".repo-path-full")?.textContent).toBe(many[300].path);
    expect(options().find((option) => option.dataset.index === "301")?.querySelector(".repo-path")).toBeTruthy();
    await fireEvent.contextMenu(row, { clientX: 5, clientY: 6 });
    expect(onContextMenu).toHaveBeenCalledWith(many[300], { x: 5, y: 6 }, null);
    expect(active()?.dataset.index).toBe("300");
  });

  it("实测行高修正定位；视口上方的行变高时滚动位置同步推开", async () => {
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.repoRow === "300" ? ROW + 30 : this.dataset.repoRow ? ROW : 0;
    });
    try {
      render(RepoSwitcher, { props: props() as never });
      const list = document.querySelector(".popover-list") as HTMLElement;
      list.scrollTop = ROW * 305;
      await fireEvent.scroll(list);
      await tick();
      await tick();
      const after = options().find((option) => option.dataset.index === "301")?.parentElement as HTMLElement;
      expect(after.style.top).toBe(`${ROW * 301 + 30}px`);
      expect(list.scrollTop).toBe(ROW * 305 + 30);
    } finally {
      offsetHeight.mockRestore();
    }
  });

  it("阻塞解除时行高整体变化，视口顶部的行不跳", async () => {
    const view = render(RepoSwitcher, { props: props({ blockedReason: "操作进行中" }) as never });
    const list = document.querySelector(".popover-list") as HTMLElement;
    const blockedTop = ROW + (ROW + LINE) * 299;
    list.scrollTop = blockedTop + 10;
    await fireEvent.scroll(list);
    await view.rerender({ blockedReason: null });
    await tick();
    expect(list.scrollTop, "第 300 行留在视口顶，行内偏移不变").toBe(ROW * 300 + 10);
    expect(options().some((option) => option.dataset.index === "300")).toBe(true);
    await view.rerender({ blockedReason: "又忙了" });
    await tick();
    expect(list.scrollTop, "阻塞出现时同样钉住").toBe(blockedTop + 10);
  });

  it("重排后实测行高和估算不同，锚点按实测位置恢复；行内偏移不超过新行高", async () => {
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.repoRow ? 42 : 0;
    });
    try {
      const view = render(RepoSwitcher, { props: props({ blockedReason: "操作进行中" }) as never });
      const list = document.querySelector(".popover-list") as HTMLElement;
      await tick();
      await tick();
      const row = () => options().find((option) => option.dataset.index === "20")?.parentElement as HTMLElement;
      list.scrollTop = ROW * 20;
      await fireEvent.scroll(list);
      await tick();
      await tick();
      list.scrollTop = parseFloat(row().style.top) + 41;
      await fireEvent.scroll(list);
      await tick();
      await view.rerender({ blockedReason: null });
      for (let step = 0; step < 30; step += 1) await tick();
      expect(list.scrollTop - parseFloat(row().style.top), "第 20 行还在视口顶").toBeGreaterThanOrEqual(0);
      expect(list.scrollTop - parseFloat(row().style.top)).toBeLessThan(42);
    } finally {
      offsetHeight.mockRestore();
    }
  });

  it("从列表移除后当前项留在原位，不甩回开头", async () => {
    const view = render(RepoSwitcher, { props: props() as never });
    for (let step = 0; step < 40; step += 1) await fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(active()?.dataset.index).toBe("41");
    await view.rerender({ repos: many.filter((_, index) => index !== 41) });
    expect(active()?.dataset.index).toBe("41");
    expect(active()?.textContent).toContain("repo-42");
    await view.rerender({ repos: many.slice(0, 3) });
    expect(active()?.dataset.index).toBe("2");
  });

  it("禁止切换时原因写在行内，行高一起算进去", () => {
    render(RepoSwitcher, { props: props({ blockedReason: "操作进行中" }) as never });
    const row = options().find((option) => option.dataset.index === "2") as HTMLElement;
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("操作进行中");
    expect((row.parentElement as HTMLElement).style.top).toBe(`${ROW + (ROW + LINE)}px`);
  });
});

describe("视图切换", () => {
  it("展示改动数量，标出当前视图，并切换视图", async () => {
    const onView = vi.fn();
    const { container } = render(ViewSwitcher, { props: { view: "changes", changeCount: 8, onView } });
    const nav = screen.getByRole("navigation", { name: "视图" });
    expect([...nav.querySelectorAll("button")].map((item) => item.getAttribute("aria-label"))).toEqual(["改动 8", "文件", "提交历史"]);
    expect(screen.getByRole("button", { name: /^改动 8/ }).getAttribute("aria-current")).toBe("page");
    expect(container.querySelector(".count")?.textContent).toBe("8");
    await fireEvent.click(screen.getByRole("button", { name: /^提交历史/ }));
    expect(onView).toHaveBeenCalledWith("history");
  });

  it("名称和快捷键由标签与提示承载，没有改动时不显示 0", () => {
    const { container } = render(ViewSwitcher, { props: { view: "history", changeCount: 0, onView: () => {} } });
    expect(container.querySelector(".count")).toBeNull();
    const history = screen.getByRole("button", { name: "提交历史" });
    expect(history.getAttribute("aria-current")).toBe("page");
    expect(history.getAttribute("title")).toContain("提交历史");
    expect(history.getAttribute("title")).toContain("+2");
  });
});

describe("合并提示", () => {
  const props = (overrides: Record<string, unknown> = {}) => ({ conflictCount: 0, mergeInProgress: false, onOpen: () => {}, ...overrides });

  it("没有合并也没有冲突时不渲染", () => {
    const { container } = render(MergeBanner, { props: props() });
    expect(container.querySelector("[data-merge-banner]")).toBeNull();
  });

  it("冲突清零但合并仍在进行时提示不消失，点击打开合并，不切换主视图", async () => {
    const onOpen = vi.fn();
    const { container } = render(MergeBanner, { props: props({ mergeInProgress: true, onOpen }) });
    const banner = container.querySelector<HTMLElement>("[data-merge-banner]");
    expect(banner?.textContent).toContain("可以完成合并");
    expect(banner?.getAttribute("aria-label")).toContain("合并进行中");
    expect(banner?.textContent, "冲突数为 0 时不出现计数").not.toMatch(/\d/);
    await fireEvent.click(banner!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("冲突数与进行中同时成立时两种信息都在", () => {
    const { container } = render(MergeBanner, { props: props({ conflictCount: 2, mergeInProgress: true }) });
    const banner = container.querySelector<HTMLElement>("[data-merge-banner]");
    expect(banner?.textContent).toContain("2 个冲突待处理");
    expect(banner?.getAttribute("aria-label")).toContain("合并进行中");
  });

  it("只有冲突、没有进行中的合并时（例如恢复临时保存），不声称合并进行中", () => {
    const { container } = render(MergeBanner, { props: props({ conflictCount: 1 }) });
    const banner = container.querySelector<HTMLElement>("[data-merge-banner]");
    expect(banner?.textContent).toContain("1 个冲突待处理");
    expect(banner?.getAttribute("aria-label")).not.toContain("合并进行中");
  });
});

describe("自绘标题栏", () => {
  function titleProps(overrides: Record<string, unknown> = {}) {
    return {
      repo,
      branch: "main",
      theme: "dark" as Theme,
      onBrand: () => {},
      onRepo: () => {},
      onBranch: () => {},
      onFetch: () => {},
      onPull: () => {},
      onPush: () => {},
      onRemote: () => {},
      onTheme: () => {},
      onSettings: () => {},
      ...overrides,
    };
  }

  it("没有打开仓库时不显示分支和同步", () => {
    const { container } = render(TitleBar, { props: titleProps({ repo: null, branch: null }) as never });
    expect(container.querySelector(".branch-pill")).toBeNull();
    expect(container.querySelectorAll("[data-titlebar-control]").length).toBeLessThanOrEqual(6);
  });

  it("命令面板过滤后游标归零，回车执行第一条匹配", async () => {
    const run = vi.fn();
    const skip = vi.fn();
    render(CommandPalette, {
      props: {
        open: true,
        onClose: () => {},
        commands: [
          { id: "a", title: "甲", group: "组", run: skip },
          { id: "b", title: "乙", group: "组", run: skip },
          { id: "c", title: "丙命令", group: "组", run },
        ],
      } as never,
    });
    const input = screen.getByRole("combobox");
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await fireEvent.input(input, { target: { value: "丙" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(skip).not.toHaveBeenCalled();
  });

  it("常驻交互项恰好 6 个，且不含刷新、发布分支、只关联上游、远程管理", () => {
    const { container } = render(TitleBar, { props: titleProps() as never });
    const controls = [...container.querySelectorAll("[data-titlebar-control]")];
    expect(controls).toHaveLength(6);
    // 下拉未打开时，标题栏里的应用可交互元素也只有这 6 个（同步的三个动作收在组内菜单）；
    // 自绘窗口按钮属于窗口装饰，不算应用交互项。
    const appButtons = [...container.querySelectorAll("button")].filter(
      (item) => item.closest(".titlebar-window-controls") === null,
    );
    expect(appButtons).toHaveLength(6);
    const text = controls.map((item) => `${item.getAttribute("aria-label")} ${item.textContent}`).join(" ");
    expect(text).toContain("品牌");
    expect(text).toContain("当前仓库");
    expect(text).toContain("当前分支");
    expect(text).toContain("同步");
    expect(text).toContain("主题");
    expect(text).toContain("设置");
    expect(text).not.toContain("刷新");
    expect(text).not.toContain("发布分支");
    expect(text).not.toContain("只关联上游");
    expect(text).not.toContain("远程管理");
  });

  it("同步组一处提供获取、拉取、推送，并把动作回写给调用方", async () => {
    const onFetch = vi.fn();
    const onPull = vi.fn();
    const onPush = vi.fn();
    render(TitleBar, { props: titleProps({ ahead: 2, behind: 1, onFetch, onPull, onPush }) as never });
    const sync = screen.getByRole("button", { name: "同步 领先 2，落后 1" });
    await fireEvent.click(sync);
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
    expect(screen.getByRole("menuitem", { name: /获取更新/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /拉取 1 个提交/ }).textContent).toContain("分叉");
    expect(screen.getByRole("menuitem", { name: /推送 2 个提交/ })).toBeTruthy();
    await fireEvent.click(screen.getByRole("menuitem", { name: /获取更新/ }));
    expect(onFetch).toHaveBeenCalled();
    expect(onPull).not.toHaveBeenCalled();
  });

  it("同步菜单底部进入远程；写入中菜单仍能打开，同步动作禁用而远程可用", async () => {
    const onRemote = vi.fn();
    render(TitleBar, { props: titleProps({ onRemote, disabled: true }) as never });
    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    const items = screen.getAllByRole("menuitem") as HTMLButtonElement[];
    expect(items.at(-1)?.textContent, "远程在菜单最底部").toContain("远程");
    expect(items.map((item) => item.disabled)).toEqual([true, true, true, false]);
    await fireEvent.click(items.at(-1)!);
    expect(onRemote).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement, "菜单卸载前先把焦点还给触发按钮").toBe(screen.getByRole("button", { name: /^同步/ }));
  });

  it("同步菜单全程可用键盘：方向键打开并移动，Esc 关闭并把焦点还给触发按钮", async () => {
    render(TitleBar, { props: titleProps() as never });
    const sync = screen.getByRole("button", { name: /^同步/ });
    sync.focus();
    await fireEvent.keyDown(sync, { key: "ArrowDown" });
    const items = screen.getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    await fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(document.activeElement, "向上循环到底部的远程").toBe(items[3]);
    await fireEvent.keyDown(items[3], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(sync);
  });

  it("仓库和分支按钮把自己交给外壳，并显示弹层展开状态", async () => {
    const onRepo = vi.fn();
    const onBranch = vi.fn();
    const { rerender } = render(TitleBar, { props: titleProps({ onRepo, onBranch, disabled: true }) as never });
    const repoButton = screen.getByRole("button", { name: /^当前仓库/ }) as HTMLButtonElement;
    const branchButton = screen.getByRole("button", { name: /^当前分支/ }) as HTMLButtonElement;
    expect(branchButton.disabled, "忙碌时仍能打开弹层看原因").toBe(false);
    await fireEvent.click(repoButton);
    await fireEvent.click(branchButton);
    expect(onRepo).toHaveBeenCalledWith(repoButton);
    expect(onBranch).toHaveBeenCalledWith(branchButton);
    expect(branchButton.getAttribute("aria-expanded")).toBe("false");
    await rerender(titleProps({ onRepo, onBranch, openSwitcher: "branch" }) as never);
    expect(branchButton.getAttribute("aria-expanded")).toBe("true");
    expect(repoButton.getAttribute("aria-expanded")).toBe("false");
    await rerender(titleProps({ branch: null }) as never);
    expect(branchButton.disabled, "没有仓库就没有分支可切").toBe(true);
  });

  it("标题栏是拖拽区，按钮与控件不参与拖拽", () => {
    const { container } = render(TitleBar, { props: titleProps() as never });
    const titlebar = container.querySelector("header.titlebar");
    expect(titlebar?.hasAttribute("data-tauri-drag-region")).toBe(true);
    const surfaces = [...container.querySelectorAll("[data-tauri-drag-region]")];
    expect(surfaces.length).toBeGreaterThan(0);
    for (const surface of surfaces) {
      expect(surface.tagName.toLowerCase()).not.toBe("button");
      expect(surface.hasAttribute("data-titlebar-control")).toBe(false);
    }
    for (const button of [...container.querySelectorAll("button")]) {
      expect(button.hasAttribute("data-tauri-drag-region")).toBe(false);
    }
  });

  it("上游未关联时分支处只显示状态提示，不新增按钮", () => {
    const { container } = render(TitleBar, { props: titleProps({ upstreamMissing: true }) as never });
    expect(container.querySelectorAll("[data-titlebar-control]")).toHaveLength(6);
    expect(container.textContent).toContain("未关联上游");
    expect(container.textContent).not.toContain("发布分支");
  });

  it("主题控件提供浅色、深色、跟随系统三态并回写选择", async () => {
    const onTheme = vi.fn();
    render(TitleBar, { props: titleProps({ theme: "light", onTheme }) as never });
    const themeButton = screen.getByRole("button", { name: "主题：浅色" });
    await fireEvent.click(themeButton);
    const options = screen.getAllByRole("menuitemradio");
    expect(options.map((item) => item.textContent?.trim())).toEqual(["浅色", "深色", "跟随系统"]);
    expect(options.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    await fireEvent.click(screen.getByRole("menuitemradio", { name: /跟随系统/ }));
    expect(onTheme).toHaveBeenCalledWith("system");
  });

  it("Windows 自绘窗口按钮不占用 6 个控制项，macOS 不留自绘按钮", () => {
    const windows = render(TitleBar, { props: titleProps({ platform: "windows" }) as never });
    expect(windows.container.querySelectorAll("[data-titlebar-control]")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "最小化窗口" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭窗口" }).hasAttribute("data-titlebar-control")).toBe(false);
    windows.unmount();

    const macos = render(TitleBar, { props: titleProps({ platform: "macos" }) as never });
    expect(macos.container.querySelector(".titlebar")?.classList.contains("titlebar-macos")).toBe(true);
    expect(screen.queryByRole("button", { name: "最小化窗口" })).toBeNull();
  });
});

describe("状态栏", () => {
  it("显示同步结论和刷新入口，不重复分支名、改动数和冲突数", async () => {
    const onRefresh = vi.fn();
    const { container } = render(StatusBar, { props: { hasRepo: true, sync: "领先 2", onRefresh } as never });
    expect(screen.getByText("领先 2")).toBeTruthy();
    // 同步结论是状态栏唯一的主读数：它挂在 .sb-sync 上，颜色比两侧按钮实一档。
    expect(container.querySelector(".statusbar .sb-sync")?.textContent).toContain("领先 2");
    const text = container.textContent ?? "";
    expect(text).not.toContain("改动");
    expect(text).not.toContain("冲突");
    await fireEvent.click(screen.getByRole("button", { name: "刷新工作区" }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("健康态圆点保持语义绿，降级或有警告时变警告，没有仓库时熄灭", async () => {
    const { container, rerender } = render(StatusBar, { props: { hasRepo: true, sync: "领先 2" } as never });
    const dot = () => container.querySelector(".sb-dot")!.className.trim();
    expect(dot()).toBe("sb-dot");
    await rerender({ hasRepo: true, sync: "领先 2", degraded: true } as never);
    expect(dot()).toContain("stale");
    await rerender({ hasRepo: true, sync: "领先 2", warning: "设置写入失败" } as never);
    expect(dot()).toContain("stale");
    expect(screen.getByText("设置写入失败")).toBeTruthy();
    await rerender({ hasRepo: false, sync: "未检查远程", degraded: false, warning: null } as never);
    expect(dot()).toContain("off");
    expect(screen.getByText("无仓库")).toBeTruthy();
  });

  it("写入中就地显示，刷新不可用", () => {
    render(StatusBar, { props: { hasRepo: true, sync: "领先 2", busy: true, onRefresh: () => {} } as never });
    expect(screen.getByText("写入中")).toBeTruthy();
    expect((screen.getByRole("button", { name: "刷新工作区" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("只读的忙碌说读取中，不把读取说成写入", () => {
    render(StatusBar, { props: { hasRepo: true, sync: "领先 2", busy: true, busyLabel: "读取中", onRefresh: () => {} } as never });
    expect(screen.getByText("读取中")).toBeTruthy();
    expect(screen.queryByText("写入中")).toBeNull();
  });

  it("没有仓库时不显示刷新入口，打开仓库后出现", async () => {
    const onRefresh = vi.fn();
    const { rerender } = render(StatusBar, { props: { hasRepo: false, sync: "", onRefresh } as never });
    expect(screen.queryByRole("button", { name: "刷新工作区" })).toBeNull();
    await rerender({ hasRepo: true, sync: "领先 2", onRefresh } as never);
    expect(screen.getByRole("button", { name: "刷新工作区" })).toBeTruthy();
  });

  it("合并提示只在左栏隐藏时出现，文案与左栏一致，点击打开合并", async () => {
    const onOpenMerge = vi.fn();
    const base = { hasRepo: true, sync: "", conflictCount: 2, mergeInProgress: true, onOpenMerge };
    const { container, rerender } = render(StatusBar, { props: base as never });
    expect(container.querySelector("[data-merge-status]"), "左栏显示时不重复").toBeNull();

    await rerender({ ...base, sidebarHidden: true } as never);
    const notice = screen.getByRole("button", { name: "合并进行中，2 个冲突待处理，打开分支合并" });
    expect(notice.textContent).toContain("2 个冲突待处理");
    await fireEvent.click(notice);
    expect(onOpenMerge).toHaveBeenCalledTimes(1);

    await rerender({ ...base, sidebarHidden: true, conflictCount: 0 } as never);
    expect(container.querySelector("[data-merge-status]")?.textContent, "冲突解决但未完成时仍在").toContain("可以完成合并");
    await rerender({ ...base, sidebarHidden: true, conflictCount: 0, mergeInProgress: false } as never);
    expect(container.querySelector("[data-merge-status]")).toBeNull();
    await rerender({ ...base, sidebarHidden: true, hasRepo: false } as never);
    expect(container.querySelector("[data-merge-status]")).toBeNull();
  });

  it("隐藏侧栏按钮说出下一步动作，没有仓库时不显示", async () => {
    const onToggleSidebar = vi.fn();
    const { rerender } = render(StatusBar, { props: { hasRepo: true, sync: "", onToggleSidebar } as never });
    const toggle = screen.getByRole("button", { name: "隐藏侧栏" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await fireEvent.click(toggle);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    await rerender({ hasRepo: true, sync: "", sidebarHidden: true, onToggleSidebar } as never);
    expect(screen.getByRole("button", { name: "显示侧栏" }).getAttribute("aria-expanded")).toBe("false");
    await rerender({ hasRepo: false, sync: "", onToggleSidebar } as never);
    expect(screen.queryByRole("button", { name: /侧栏/ })).toBeNull();
  });
});

describe("命令面板", () => {
  const commands = [
    { id: "view.changes", group: "视图", title: "切换到改动", shortcut: "Ctrl+1", run: vi.fn() },
    { id: "view.history", group: "视图", title: "切换到提交历史", shortcut: "Ctrl+2", run: vi.fn() },
    {
      id: "commit",
      group: "提交",
      title: "提交到本地",
      shortcut: "Ctrl+Enter",
      enabled: false,
      reason: "暂存区为空",
      run: vi.fn(),
    },
  ];

  it("方向键移动、回车执行选中项", async () => {
    const runs = commands.map(() => vi.fn());
    const onClose = vi.fn();
    render(CommandPalette, {
      props: {
        open: true,
        onClose,
        commands: [
          { ...commands[0], run: runs[0] },
          { ...commands[1], run: runs[1] },
          { ...commands[2], run: runs[2] },
        ],
      } as never,
    });
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(runs[1]).toHaveBeenCalledTimes(1);
    expect(runs[0]).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("不可用动作就地说明原因且不执行", async () => {
    const run = vi.fn();
    render(CommandPalette, {
      props: { open: true, onClose: () => {}, commands: [{ ...commands[2], run }] } as never,
    });
    const option = screen.getByRole("option", { name: /提交到本地/ });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("暂存区为空")).toBeTruthy();
    await fireEvent.click(option);
    expect(run).not.toHaveBeenCalled();
  });

  it("输入过滤命令，无匹配时给出结论，Esc 关闭", async () => {
    const onClose = vi.fn();
    render(CommandPalette, {
      props: { open: true, onClose, commands } as never,
    });
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    await fireEvent.input(input, { target: { value: "历史" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await fireEvent.input(input, { target: { value: "没有这个" } });
    expect(screen.getByText("没有匹配的命令")).toBeTruthy();
    await fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("命令面板用 aria-activedescendant 跟随键盘当前项，无匹配时给下一步", async () => {
    render(CommandPalette, { props: { open: true, onClose: () => {}, commands } as never });
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    const active = () => document.getElementById(input.getAttribute("aria-activedescendant") ?? "");
    expect(active(), "当前项指向真实存在的条目").toBe(screen.getAllByRole("option")[0]);
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active()).toBe(screen.getAllByRole("option")[1]);
    await fireEvent.input(input, { target: { value: "没有这个" } });
    expect(screen.getByText("没有匹配的命令")).toBeTruthy();
    expect(screen.getByText("换个关键词试试，或按 Esc 关闭")).toBeTruthy();
    // 结论和下一步在同一个 status 里：读屏一次播报两句，不会只念到结论。
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("没有匹配的命令");
    expect(status.textContent).toContain("换个关键词试试，或按 Esc 关闭");
    expect(input.getAttribute("aria-activedescendant"), "没有条目时不再指向不存在的 id").toBeNull();
  });

  it("keywords 参与过滤但不显示，没有 keywords 的命令仍只按标题与分组匹配", async () => {
    const withKeywords = [
      { id: "repo.one", group: "仓库", title: "切换到 demo", keywords: "C:/work/alpha/demo", run: vi.fn() },
      { id: "repo.two", group: "仓库", title: "切换到 demo", keywords: "C:/work/beta/demo", run: vi.fn() },
      commands[0],
    ];
    render(CommandPalette, { props: { open: true, onClose: () => {}, commands: withKeywords } as never });
    const input = screen.getByRole("combobox", { name: "搜索命令" });

    // 同名仓库用路径片段区分：只筛出 alpha 那一条
    await fireEvent.input(input, { target: { value: "alpha" } });
    const one = screen.getAllByRole("option");
    expect(one).toHaveLength(1);
    expect(one[0].textContent).toContain("切换到 demo");
    // 关键词只参与匹配、不写进选项文案
    expect(one[0].textContent).not.toContain("alpha");

    // 大小写不敏感，且不带 keywords 的命令按标题照常命中
    await fireEvent.input(input, { target: { value: "BETA" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await fireEvent.input(input, { target: { value: "改动" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /改动/ })).toBeTruthy();

    // 没有命中任何关键词时仍给结论
    await fireEvent.input(input, { target: { value: "gamma" } });
    expect(screen.getByText("没有匹配的命令")).toBeTruthy();
  });

  it("空格分隔的多个词须全部命中，顺序不限；任一词不中则不出现", async () => {
    const items = [
      { id: "commit.local", group: "提交", title: "提交到本地", run: vi.fn() },
      { id: "commit.push", group: "提交", title: "提交并推送", run: vi.fn() },
      { id: "sync.push", group: "同步", title: "推送", run: vi.fn() },
    ];
    render(CommandPalette, { props: { open: true, onClose: () => {}, commands: items } as never });
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    await fireEvent.input(input, { target: { value: "推送  提交" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent?.trim())).toEqual(["提交并推送"]);
    // 分组名也算命中范围：「同步 推送」只剩同步组那一条
    await fireEvent.input(input, { target: { value: "同步 推送" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent?.trim())).toEqual(["推送"]);
    await fireEvent.input(input, { target: { value: "提交 拉取" } });
    expect(screen.getByText("没有匹配的命令")).toBeTruthy();
  });

  it("detail 作为弱化补充显示在标题后，没有 detail 的选项不多出节点", () => {
    const items = [
      { id: "repo.one", group: "仓库", title: "切换到 demo", detail: "/work/alpha/demo", run: vi.fn() },
      { id: "repo.two", group: "仓库", title: "切换到 solo", run: vi.fn() },
    ];
    render(CommandPalette, { props: { open: true, onClose: () => {}, commands: items } as never });
    const [one, two] = screen.getAllByRole("option");
    expect(one.querySelector(".palette-detail")?.textContent).toBe("/work/alpha/demo");
    expect(two.querySelector(".palette-detail")).toBeNull();
  });

  it("焦点在选项上时 Esc 关掉面板并把焦点还给触发元素", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开命令面板";
    document.body.append(trigger);
    trigger.focus();

    const onClose = vi.fn();
    const view = render(CommandPalette, { props: { open: true, onClose, commands } as never });
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    const option = screen.getAllByRole("option")[0];

    await fireEvent.keyDown(input, { key: "Tab" });
    expect(document.activeElement, "复现路径的第一步：Tab 把焦点送进选中项").toBe(option);

    await fireEvent.keyDown(option, { key: "Escape" });
    expect(onClose, "焦点在选项上时 Esc 仍要关闭面板").toHaveBeenCalledTimes(1);

    await view.rerender({ open: false } as never);
    expect(document.activeElement, "关闭后焦点回到打开面板前的触发元素").toBe(trigger);

    trigger.remove();
  });

  it("焦点在选项上时方向键仍移动游标，回车执行当前项", async () => {
    const runs = commands.map(() => vi.fn());
    render(CommandPalette, {
      props: {
        open: true,
        onClose: () => {},
        commands: [
          { ...commands[0], run: runs[0] },
          { ...commands[1], run: runs[1] },
          { ...commands[2], run: runs[2] },
        ],
      } as never,
    });
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    const options = screen.getAllByRole("option");

    input.focus();
    await fireEvent.keyDown(input, { key: "Tab" });
    expect(document.activeElement).toBe(options[0]);

    await fireEvent.keyDown(options[0], { key: "ArrowDown" });
    expect(options[1].getAttribute("aria-selected"), "方向键在选项上把游标下移").toBe("true");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(document.activeElement, "焦点跟随游标，高亮与键盘焦点不分叉").toBe(options[1]);

    await fireEvent.keyDown(options[1], { key: "Enter" });
    expect(runs[1], "选项上的回车执行当前项").toHaveBeenCalledTimes(1);
    expect(runs[0]).not.toHaveBeenCalled();
  });

  it("Tab 在面板内首尾环绕，不把焦点落到背景", async () => {
    render(CommandPalette, { props: { open: true, onClose: () => {}, commands } as never });
    const dialog = screen.getByRole("dialog", { name: "命令面板" });
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    const first = screen.getAllByRole("option")[0];
    expect(first.getAttribute("tabindex"), "当前选中项要能被 Tab 命中").toBe("0");

    input.focus();
    await fireEvent.keyDown(input, { key: "Tab" });
    expect(document.activeElement, "Tab 从搜索框进入选中项").toBe(first);
    expect(dialog.contains(document.activeElement)).toBe(true);

    await fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
    expect(document.activeElement, "末位 Tab 回到面板首个可聚焦元素").toBe(input);
    expect(dialog.contains(document.activeElement)).toBe(true);

    await fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(document.activeElement, "Shift+Tab 从首位回到末位").toBe(first);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("起始页", () => {
  it("单屏三个入口加最近仓库，不再堆营销段落", async () => {
    const onOpen = vi.fn();
    render(Welcome, {
      props: { recent: repos, disabled: false, onAdd: () => {}, onClone: () => {}, onCreate: () => {}, onOpen } as never,
    });
    expect(screen.getByRole("button", { name: /打开本地仓库/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /克隆远程仓库/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /新建仓库/ })).toBeTruthy();
    expect(screen.getAllByText("demo")).toHaveLength(2);
    expect(screen.queryByText(/都清晰有序/)).toBeNull();
    expect(document.querySelector("h1"), "没有 hero 标题").toBeNull();
    for (const removed of [".welcome-hero", ".welcome-art", ".welcome-assurances", ".welcome-footer"]) {
      expect(document.querySelector(removed), removed).toBeNull();
    }
    expect(screen.queryByText(/本地优先/), "没有卖点").toBeNull();
    await fireEvent.click(screen.getByText("/work/beta/demo"));
    expect(onOpen).toHaveBeenCalledWith("/work/beta/demo");
  });

  it("同名仓库显示完整路径，其余仓库仍是单行路径", () => {
    const named = [...repos, { name: "solo", path: "/work/solo", openedAtMs: 0 }];
    const { container } = render(Welcome, {
      props: { recent: named, disabled: false, onAdd: () => {}, onClone: () => {}, onCreate: () => {}, onOpen: () => {} },
    });
    expect([...container.querySelectorAll(".repo-path-full")].map((node) => node.textContent)).toEqual(
      named.filter((item) => item.name === "demo").map((item) => item.path),
    );
    expect(container.querySelector(".repo-path")?.textContent).toBe("/work/solo");
  });

  it("最多列五个最近仓库，多出来时说明总数", () => {
    const many = Array.from({ length: 7 }, (_, index) => ({ name: `repo-${index}`, path: `/work/${index}`, openedAtMs: index }));
    const { container } = render(Welcome, {
      props: { recent: many, disabled: false, onAdd: () => {}, onClone: () => {}, onCreate: () => {}, onOpen: () => {} },
    });
    expect(container.querySelectorAll(".welcome-recent button")).toHaveLength(5);
    expect(screen.getByText("共 7 个")).toBeTruthy();
  });

  it("最近仓库行尾显示上次打开的相对时间，时间戳不可信时不显示", () => {
    const now = Date.now();
    const recent = [
      { name: "fresh", path: "/work/fresh", openedAtMs: now - 3 * 3600 * 1000 },
      { name: "legacy", path: "/work/legacy", openedAtMs: 1 },
    ];
    const { container } = render(Welcome, {
      props: { recent, disabled: false, onAdd: () => {}, onClone: () => {}, onCreate: () => {}, onOpen: () => {} },
    });
    const rows = [...container.querySelectorAll(".welcome-recent button")];
    expect(rows[0].querySelector("[data-repo-when]")?.textContent).toBe("3 小时前");
    expect(rows[1].querySelector("[data-repo-when]"), "1970 年的占位时间戳不当作真实打开时间").toBeNull();
  });

  describe("多于 5 个时搜索", () => {
    const many = Array.from({ length: 500 }, (_, index) => ({ name: `repo-${index}`, path: `/work/Group-${index % 7}/repo-${index}`, openedAtMs: index }));
    const box = () => screen.getByRole("textbox", { name: "搜索最近仓库" }) as HTMLInputElement;
    const names = () => [...document.querySelectorAll(".welcome-recent .repo-name")].map((node) => node.textContent);
    function renderMany(onOpen = vi.fn(), onContextMenu = vi.fn()) {
      render(Welcome, { props: { recent: many, disabled: false, onAdd: () => {}, onClone: () => {}, onCreate: () => {}, onOpen, onContextMenu } });
      return { onOpen, onContextMenu };
    }

    it("5 个以内没有搜索框", () => {
      render(Welcome, { props: { recent: many.slice(0, 5), disabled: false, onAdd: () => {}, onClone: () => {}, onCreate: () => {}, onOpen: () => {} } });
      expect(screen.queryByRole("textbox", { name: "搜索最近仓库" })).toBeNull();
      expect(document.querySelector(".welcome-recent")?.classList.contains("searchable")).toBe(false);
    });

    it("6 个开始有搜索框，能找到列表外的仓库并打开", async () => {
      const { onOpen } = renderMany();
      expect(names()).not.toContain("repo-333");
      await fireEvent.input(box(), { target: { value: "REPO-333" } });
      expect(names()).toEqual(["repo-333"]);
      expect(screen.getByText("匹配 1 个")).toBeTruthy();
      await fireEvent.click(screen.getByText("/work/Group-4/repo-333"));
      expect(onOpen).toHaveBeenCalledWith("/work/Group-4/repo-333");
    });

    it("支持路径片段，结果多时只列五行并说明", async () => {
      renderMany();
      await fireEvent.input(box(), { target: { value: "group-2/" } });
      expect(names()).toHaveLength(5);
      expect(screen.getByText(/匹配 72 个，显示前 5 个/)).toBeTruthy();
    });

    it("回车打开第一条结果；Esc 只清空关键词；输入法选词时不动作", async () => {
      const { onOpen } = renderMany();
      await fireEvent.keyDown(box(), { key: "Enter" });
      expect(onOpen, "没有关键词时回车不打开").not.toHaveBeenCalled();
      await fireEvent.input(box(), { target: { value: "repo-77" } });
      await fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
      expect(onOpen).not.toHaveBeenCalled();
      await fireEvent.keyDown(box(), { key: "Enter" });
      expect(onOpen).toHaveBeenCalledWith(many[77].path);
      await fireEvent.keyDown(box(), { key: "Escape" });
      expect(box().value).toBe("");
      expect(names()).toHaveLength(5);
      expect(screen.getByText("共 500 个")).toBeTruthy();
    });

    it("方向键在最近仓库之间移动，到顶回到搜索框", async () => {
      renderMany();
      const buttons = () => [...document.querySelectorAll<HTMLButtonElement>(".welcome-recent > button")];
      box().focus();
      await fireEvent.keyDown(box(), { key: "ArrowDown" });
      expect(document.activeElement).toBe(buttons()[0]);
      await fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(buttons()[1]);
      await fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      expect(document.activeElement).toBe(buttons()[0]);
      await fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      expect(document.activeElement).toBe(box());
    });

    it("没有匹配时说明，清空按钮恢复列表", async () => {
      renderMany();
      await fireEvent.input(box(), { target: { value: "没有这个" } });
      expect(names()).toEqual([]);
      expect(screen.getByText("没有匹配的仓库，试试名称或路径。")).toBeTruthy();
      await fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
      expect(names()).toHaveLength(5);
    });

    it("搜索结果的右键菜单给到对应仓库", async () => {
      const { onContextMenu } = renderMany();
      await fireEvent.input(box(), { target: { value: "repo-333" } });
      await fireEvent.contextMenu(screen.getByText("/work/Group-4/repo-333").closest("button")!, { clientX: 1, clientY: 2 });
      expect(onContextMenu).toHaveBeenCalledWith(many[333], { x: 1, y: 2 });
    });
  });

  it("最近仓库右键和键盘菜单键都能打开仓库操作，右键不会顺带打开仓库", async () => {
    const onOpen = vi.fn();
    const onContextMenu = vi.fn();
    render(Welcome, {
      props: { recent: repos, disabled: false, onAdd: () => {}, onClone: () => {}, onCreate: () => {}, onOpen, onContextMenu },
    });
    const row = screen.getByText("/work/beta/demo").closest("button")!;
    await fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    expect(onContextMenu).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/work/beta/demo" }), { x: 40, y: 60 });
    await fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    await fireEvent.keyDown(row, { key: "ContextMenu" });
    expect(onContextMenu).toHaveBeenCalledTimes(3);
    await fireEvent.keyDown(row, { key: "a" });
    expect(onContextMenu).toHaveBeenCalledTimes(3);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("禁用时三个入口都不可点", () => {
    render(Welcome, {
      props: { recent: [], disabled: true, onAdd: () => {}, onClone: () => {}, onCreate: () => {}, onOpen: () => {} },
    });
    for (const name of [/打开本地仓库/, /克隆远程仓库/, /新建仓库/]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled, String(name)).toBe(true);
    }
  });

  it("没有最近仓库时只给一句结论，Git 不可用时可进入诊断", async () => {
    const onDiagnose = vi.fn();
    render(Welcome, {
      props: {
        recent: [],
        disabled: false,
        onAdd: () => {},
        onClone: () => {},
        onCreate: () => {},
        onOpen: () => {},
        diagnostic: "Git 不可用",
        onDiagnose,
      } as never,
    });
    expect(screen.getByText("还没有最近仓库，先打开或克隆一个。")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: /Git 不可用/ }));
    expect(onDiagnose).toHaveBeenCalled();
  });
});

/**
 * 外壳类名契约 —— 「样式写完了」的可执行事实
 * ---------------------------------------------------------------------------
 * 上轮阻断项是：外壳四组件在 DOM 上引入的类名在 src/styles 里一条规则都没有，
 * 于是 40px 标题栏、交通灯避让、折叠成图标栏这些验收全落空，而 DOM 层测试仍全绿。
 * 这里直接读样式层文本核对两件事：组件用到的每个新类名都在规则里出现；
 * 计划写死的尺寸（40/78/46×3=138/240/56/560）确实写进了样式，而不是留在组件内联。
 * 判据是「类名出现在某条规则的选择器里」，所以 `.sync-pill .subtle-count` 这类
 * 后代规则同样算覆盖；纯字面量子串（例如 `.titlebar` 被 `.titlebar-group` 含住）不算。
 */
describe("外壳样式契约", () => {
  const stylesDir = path.resolve(__dirname, "../src/styles");
  const readLayer = (file: string) => readFileSync(path.join(stylesDir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const layoutCss = readLayer("layout.css");
  const componentsCss = readLayer("components.css");

  /** 规则前导串：忽略 @media 等 at-rule 本身，够本仓库的「一行/一段选择器 + {」使用。 */
  function selectorsOf(css: string): string[] {
    return [...css.matchAll(/(?:^|[}\n;])\s*([^{}@]+?)\s*\{/g)].map((match) => match[1]);
  }

  function classTokens(css: string): Set<string> {
    const tokens = new Set<string>();
    for (const selector of selectorsOf(css)) {
      for (const part of selector.split(/[\s>+~]+/)) {
        for (const match of part.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) tokens.add(`.${match[1]}`);
      }
    }
    return tokens;
  }

  function ruleBodies(css: string, selector: string): string[] {
    const bodies: string[] = [];
    for (const match of css.matchAll(/(?:^|[}\n;])\s*([^{}@]+?)\s*\{([^}]*)\}/g)) {
      const selectors = match[1].split(",").map((item) => item.trim());
      if (selectors.includes(selector)) bodies.push(match[2]);
    }
    return bodies;
  }

  /** 某选择器的全部声明体拼起来：同一个选择器可以在多处补声明（例如 .shell, .titlebar）。 */
  function ruleBody(css: string, selector: string): string {
    const bodies = ruleBodies(css, selector);
    if (bodies.length === 0) throw new Error(`未找到规则 ${selector}`);
    return bodies.join("\n");
  }

  it("标题栏、左栏、命令面板与起始页的每个新类名都有真实规则", () => {
    const layoutClasses = classTokens(layoutCss);
    const componentClasses = classTokens(componentsCss);
    const required: [Set<string>, string[]][] = [
      [
        layoutClasses,
        [
          ".titlebar",
          ".titlebar-group",
          ".titlebar-context",
          ".titlebar-actions",
          ".titlebar-spacer",
          ".titlebar-brand",
          ".titlebar-macos",
          ".titlebar-window-controls",
          ".titlebar-win-btn",
          ".titlebar-settings",
          ".branch-hint",
          ".sync-pill",
          ".subtle-count",
          ".pane",
          ".changes",
          ".history-layout",
          ".merge-banner",
          ".welcome-inner",
          ".welcome-brand",
          ".welcome-actions",
          ".welcome-recent",
          ".welcome-empty",
          ".welcome-diagnostic",
          ".welcome-section",
        ],
      ],
      [
        componentClasses,
        [
          ".pane-head",
          ".view-switcher",
          ".history-view",
          ".history-tools",
          ".history-pager",
          ".palette-backdrop",
          ".palette-card",
          ".palette-search",
          ".palette-body",
          ".palette-group",
          ".palette-group-title",
          ".palette-item",
          ".palette-reason",
          ".palette-empty",
        ],
      ],
    ];
    const missing = required.flatMap(([tokens, names]) => names.filter((name) => !tokens.has(name)));
    expect(missing, "以下类名没有对应的样式规则（样式未实现时组件等于裸 DOM）").toEqual([]);
  });

  it("标题栏 40px、交通灯 78px、Windows 三键 46×40 合计 138px 都写进样式", () => {
    expect(layoutCss).toMatch(/--titlebar-height:\s*40px/);
    expect(ruleBody(layoutCss, ".titlebar")).toMatch(/height:\s*var\(--titlebar-height\)/);
    expect(ruleBody(layoutCss, ".titlebar-macos")).toMatch(/padding-left:\s*78px/);
    expect(ruleBody(layoutCss, ".titlebar-window-controls")).toMatch(/width:\s*138px/);
    expect(ruleBody(layoutCss, ".titlebar-window-controls")).toMatch(/height:\s*40px/);
    expect(ruleBody(layoutCss, ".titlebar-win-btn")).toMatch(/width:\s*46px/);
    expect(ruleBody(layoutCss, ".titlebar-win-btn")).toMatch(/height:\s*40px/);
  });

  it("改动和历史的左栏同读 --files，隐藏时收起轨道，且不卸载内容", () => {
    expect(ruleBody(layoutCss, ".changes")).toMatch(/var\(--files\) 1px minmax\(0, 1fr\)/);
    expect(ruleBody(layoutCss, ".history-layout")).toMatch(/var\(--files\) 1px minmax\(0, 1fr\)/);
    expect(ruleBody(layoutCss, '.workspace[data-sidebar="hidden"] .changes')).toMatch(/grid-template-columns:\s*0 0 minmax\(0, 1fr\)/);
    expect(ruleBody(layoutCss, '.workspace[data-sidebar="hidden"] .history-layout')).toMatch(/grid-template-columns:\s*0 0 minmax\(0, 1fr\)/);
    // display:none 会丢滚动位置；visibility 同时让隐藏的控件不可聚焦。
    const hidden = ruleBody(layoutCss, '.workspace[data-sidebar="hidden"] .pane');
    expect(hidden).toMatch(/visibility:\s*hidden/);
    expect(hidden).not.toMatch(/display:\s*none/);
    expect(ruleBody(layoutCss, '.workspace[data-sidebar="hidden"] .resizer')).toMatch(/visibility:\s*hidden/);
  });

  it("左栏是贴边平面面板，差异不再是圆角卡片", () => {
    const pane = ruleBody(layoutCss, ".pane");
    expect(pane).toMatch(/background:\s*var\(--surface-2\)/);
    expect(pane).not.toMatch(/border|box-shadow/);
    const flat = ruleBody(componentsCss, ".diff");
    expect(flat).not.toMatch(/(?:^|;)\s*border(?:-radius)?\s*:/);
    expect(flat).not.toMatch(/box-shadow/);
  });

  it("窄左栏里分组动作收成图标，把宽度留给分组标题", () => {
    const narrow = componentsCss.match(/@container file-list \(max-width: 240px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(narrow).toMatch(/\.file-group-action\s*\{[^}]*display:\s*none/);
  });

  it("窄左栏里两个提交按钮上下排列，都不收成图标", () => {
    const narrow = componentsCss.match(/@container composer \(max-width: 300px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(narrow).toMatch(/\.composer-actions\s*\{[^}]*flex-direction:\s*column/);
    expect(narrow, "文字标签不能隐藏").not.toMatch(/composer-push-label|composer-commit-label/);
  });

  it("进度条跟随标题栏高度令牌，不再写死 63/57", () => {
    const line = ruleBody(layoutCss, ".progress-line");
    expect(line).toMatch(/top:\s*var\(--titlebar-height\)/);
    expect(line).not.toMatch(/top:\s*\d+px/);
    expect(layoutCss).not.toMatch(/\.progress-line\s*\{\s*top:\s*\d+px/);
  });

  /**
   * 六个常驻项的样式归属：
   * 1 品牌 .titlebar-brand、2 仓库 .repo-switch、3 分支 .branch-pill、
   * 4 同步 .branch-pill.sync-pill（复用分支 pill 的规则）、5 主题 .icon-btn、
   * 6 设置 .icon-btn.titlebar-settings（复用图标按钮的规则）。
   * 后三项必须在各自追加规则里不写 height，否则六个项又会分叉。
   */
  it("标题栏六个常驻项（品牌/仓库/分支/同步/主题/设置）同高，高度只来自 --titlebar-control", () => {
    const tokensCss = readLayer("tokens.css");
    const control = Number(tokensCss.match(/--titlebar-control:\s*(\d+)px/)?.[1]);
    expect(control, "标题栏控件高度令牌必须是一个实际像素值").toBeGreaterThan(0);
    const owned: [string, string][] = [
      [".titlebar-brand", "品牌"],
      [".repo-switch", "仓库"],
      [".branch-pill", "分支（同步 .sync-pill 复用同一规则）"],
    ];
    for (const [selector, label] of owned) {
      const body = ruleBody(layoutCss, selector);
      expect(body, `${label}取 --titlebar-control`).toMatch(/height:\s*var\(--titlebar-control\)/);
      expect(body, `${label}不再写死高度`).not.toMatch(/height:\s*\d+px/);
    }
    const iconBtn = layoutCss.match(/\.titlebar \.icon-btn\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(iconBtn, "主题与设置两个图标按钮同高").toMatch(/height:\s*var\(--titlebar-control\)/);
    expect(iconBtn, "标题栏图标按钮不再写死高度").not.toMatch(/height:\s*\d+px/);
    // 同步与设置只追加不涉及高度的声明（.sync-pill 宽度/内边距、.titlebar-settings 颜色）。
    expect(ruleBody(layoutCss, ".sync-pill"), "同步项不另写高度").not.toMatch(/height:/);
    expect(ruleBody(layoutCss, ".titlebar-settings"), "设置项不另写高度").not.toMatch(/height:/);
  });

  it("状态栏按钮命中区按 --statusbar-hit 撑到 24px，26px 条高仍放得下", () => {
    const tokensCss = readLayer("tokens.css");
    const px = (name: string) => Number(tokensCss.match(new RegExp(name + ":\\s*(\\d+)px"))?.[1]);
    const hit = px("--statusbar-hit");
    const barHeight = px("--statusbar-height");
    expect(hit, "命中区不小于 24px（R14 交互目标下限）").toBeGreaterThanOrEqual(24);
    expect(hit, "按钮不能撑破状态栏").toBeLessThan(barHeight);
    expect(ruleBody(layoutCss, ".statusbar")).toMatch(/height:\s*var\(--statusbar-height\)/);
    const button = ruleBody(layoutCss, ".statusbar button.sb-item");
    expect(button).toMatch(/height:\s*var\(--statusbar-hit\)/);
    expect(button, "图标按钮也要有方形命中区").toMatch(/min-width:\s*var\(--statusbar-hit\)/);
    expect(ruleBody(layoutCss, ".statusbar button.sb-item:focus-visible"), "焦点环收在条内，不被 26px 裁掉").toMatch(/outline-offset:\s*-2px/);
  });

  it("900×600 有独立的紧凑版式：只收间距与图标块，条目与占位高度都按紧凑行高", () => {
    const compact = layoutCss.match(/@media \(max-height: 660px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(compact, "缺少 600 高档的紧凑版式").not.toBe("");
    const compactRule = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return compact.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"))?.[1] ?? "";
    };
    // 取值断言：只检查选择器存在拦不住「紧凑档没生效」或「占位被清零」这类回归。
    expect(compactRule(".welcome"), "外面距收到 8px").toMatch(/padding-block:\s*var\(--space-8\)/);
    expect(compactRule(".welcome-inner"), "组间距收到 12px").toMatch(/gap:\s*var\(--space-12\)/);
    expect(compactRule(".welcome .action-card"), "行式卡片内边距盖过 max-width:960px 那档").toMatch(
      /padding:\s*var\(--space-8\) var\(--space-12\)/,
    );
    expect(compactRule(".welcome-recent"), "列表内边距收到 4px").toMatch(/padding:\s*var\(--space-4\)/);
    expect(compactRule(".welcome-recent button"), "行内边距收到 4px").toMatch(/padding-block:\s*var\(--space-4\)/);
    expect(compactRule(".welcome-section-head"), "标题行收到 24px").toMatch(/min-height:\s*24px/);

    // 搜索占位：必须是按紧凑行高算出的实际高度，不能是 0。
    // 900×600 实测五行 217.95px（行高 40.390625 × 5 + 间隙 2 × 4 + 内边距 4 × 2），占位取 218px；
    // 清零时 .welcome-inner 的 margin:auto 会重新居中，搜索框从 304 跳到 392（88px）。
    const reserved = Number(compactRule(".welcome-recent.searchable").match(/min-height:\s*(\d+)px/)?.[1] ?? NaN);
    expect(reserved, "搜索占位必须是实际像素值，不能继续锁死 min-height: 0").toBe(218);
    expect(compact).not.toMatch(/\.welcome-recent\.searchable\s*\{[^}]*min-height:\s*0\b/);
    // 宽档的占位仍要更高，否则两个断点的五行高度会互相顶。
    expect(layoutCss, "宽档占位保持 257px").toMatch(/\.welcome-recent\.searchable\s*\{[^}]*min-height:\s*257px/);
  });

  it("菜单宽度容得下同步项说明，菜单项不因折行高低不齐", () => {
    expect(ruleBody(componentsCss, ".menu")).toMatch(/min-width:\s*268px/);
  });

  it("窄窗口三个入口仍是一排三列，只改成行式卡片；矮窗口不再隐藏使用提示", () => {
    const narrow = layoutCss.match(/@media \(max-width: 960px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(narrow, "缺少 960 宽档").not.toBe("");
    expect(narrow, "不再把入口堆成单列").not.toMatch(/\.welcome-actions\s*\{[^}]*grid-template-columns/);
    expect(narrow).toMatch(/\.action-card\s*\{[^}]*flex-direction:\s*row/);
    expect(ruleBody(layoutCss, ".welcome-actions")).toMatch(/repeat\(3, minmax\(0, 1fr\)\)/);
    const short = layoutCss.match(/@media \(max-height: 720px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(short, "缺少 720 高档").not.toBe("");
    expect(short).not.toMatch(/\.welcome-foot\s*\{[^}]*display:\s*none/);
  });

  /**
   * 减少动效的可执行事实：普通档确实有位移（否则取消位移是空断言），
   * 减少动效档把它改成 none，并且过渡被 base.css 关掉。
   * 静态截图分不出 :hover 状态，所以这里用样式文本断言补上那部分判别力。
   */
  it("减少动效时卡片悬停不再位移（普通档确实有位移，不是空断言）", () => {
    const normal = ruleBody(layoutCss, ".action-card:hover:not(:disabled)");
    expect(normal, "普通档悬停有 1px 抬升").toMatch(/transform:\s*translateY\(-1px\)/);
    const reduced = layoutCss.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(reduced, "缺少减少动效覆盖").not.toBe("");
    expect(reduced).toMatch(/\.action-card:hover:not\(:disabled\)\s*\{[^}]*transform:\s*none/);
    const baseCss = readLayer("base.css");
    expect(baseCss, "减少动效下全局过渡关闭").toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition:\s*none\s*!important/,
    );
  });

  it("命令面板 560px 宽并复用 modal 背板与卡片外壳", () => {
    expect(ruleBody(componentsCss, ".palette-card")).toMatch(/560px/);
    expect(componentsCss).toMatch(/\.palette-backdrop[^{]*\{[^}]*var\(--z-palette\)/);
  });
});

