import { readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import CommandPalette from "../src/lib/components/CommandPalette.svelte";
import MergeBanner from "../src/lib/components/MergeBanner.svelte";
import RepoSwitcher from "../src/lib/components/RepoSwitcher.svelte";
import StatusBar from "../src/lib/components/StatusBar.svelte";
import TitleBar from "../src/lib/components/TitleBar.svelte";
import ViewSwitcher from "../src/lib/components/ViewSwitcher.svelte";
import Welcome from "../src/lib/components/Welcome.svelte";
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

describe("视图切换", () => {
  it("展示改动数量，标出当前视图，并切换视图", async () => {
    const onView = vi.fn();
    const { container } = render(ViewSwitcher, { props: { view: "changes", changeCount: 8, onView } });
    const nav = screen.getByRole("navigation", { name: "视图" });
    expect([...nav.querySelectorAll("button")].map((item) => item.getAttribute("aria-label"))).toEqual(["改动 8", "提交历史"]);
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
    expect(screen.getByRole("menuitem", { name: /拉取 1 个提交/ })).toBeTruthy();
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

  it("命令面板 560px 宽并复用 modal 背板与卡片外壳", () => {
    expect(ruleBody(componentsCss, ".palette-card")).toMatch(/560px/);
    expect(componentsCss).toMatch(/\.palette-backdrop[^{]*\{[^}]*var\(--z-palette\)/);
  });
});

