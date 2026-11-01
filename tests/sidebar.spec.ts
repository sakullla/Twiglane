import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import CommandPalette from "../src/lib/components/CommandPalette.svelte";
import RepoSidebar from "../src/lib/components/RepoSidebar.svelte";
import StatusBar from "../src/lib/components/StatusBar.svelte";
import TitleBar from "../src/lib/components/TitleBar.svelte";
import Welcome from "../src/lib/components/Welcome.svelte";
import WorkspaceRail from "../src/lib/components/WorkspaceRail.svelte";
import type { RecentRepo, RepoSummary, Theme } from "../src/lib/types";

const repos: RecentRepo[] = [
  { name: "demo", path: "/work/alpha/demo", openedAtMs: 2 },
  { name: "demo", path: "/work/beta/demo", openedAtMs: 1 },
];

const repo: RepoSummary = { name: "demo", path: "/work/alpha/demo" };

describe("仓库侧栏", () => {
  it("同时展示同名仓库的完整路径", () => {
    render(RepoSidebar, {
      props: {
        repos,
        query: "",
        selectedPath: repos[0].path,
        theme: "light",
        onQuery: () => {},
        onSelect: () => {},
        onForget: () => {},
        onShowPath: () => {},
        onTheme: () => {},
      },
    });
    expect(screen.getAllByText("demo")).toHaveLength(2);
    expect(screen.getByText("/work/alpha/demo")).toBeTruthy();
    expect(screen.getByText("/work/beta/demo")).toBeTruthy();
  });

  it("工作区导航展示改动与冲突数量，并切换视图", async () => {
    const onView = vi.fn();
    render(RepoSidebar, {
      props: {
        repos,
        query: "",
        selectedPath: repos[0].path,
        theme: "dark",
        workspaceView: "changes",
        workspaceEnabled: true,
        changeCount: 8,
        conflictCount: 1,
        onView,
        onQuery: () => {},
        onSelect: () => {},
        onForget: () => {},
        onShowPath: () => {},
        onTheme: () => {},
      },
    });
    expect(screen.getByRole("button", { name: /^改动 8/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: /^分支合并 1/ })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: /^提交历史/ }));
    expect(onView).toHaveBeenCalledWith("history");
  });
});

describe("rail 分组与折叠", () => {
  function railProps(overrides: Record<string, unknown> = {}) {
    return {
      repos,
      query: "",
      selectedPath: repos[0].path,
      workspaceView: "changes",
      workspaceEnabled: true,
      changeCount: 8,
      conflictCount: 1,
      onView: () => {},
      onTask: () => {},
      onQuery: () => {},
      onSelect: () => {},
      onForget: () => {},
      onShowPath: () => {},
      ...overrides,
    };
  }

  it("导航组是改动与提交历史，任务组是临时保存、分支合并、分支与标签、远程", () => {
    render(WorkspaceRail, { props: railProps() as never });
    const nav = screen.getByRole("navigation", { name: "导航" });
    const navNames = [...nav.querySelectorAll("button")].map((item) => item.getAttribute("aria-label"));
    expect(navNames).toEqual(["改动 8", "提交历史"]);

    const tasks = screen.getByRole("navigation", { name: "任务" });
    const taskNames = [...tasks.querySelectorAll("button")].map((item) => item.getAttribute("aria-label"));
    expect(taskNames).toEqual(["临时保存", "分支合并 1", "分支与标签", "远程"]);
  });

  it("点任务项只打开任务，不切换主视图", async () => {
    const onTask = vi.fn();
    const onView = vi.fn();
    render(WorkspaceRail, { props: railProps({ onTask, onView }) as never });
    await fireEvent.click(screen.getByRole("button", { name: "分支与标签" }));
    expect(onTask).toHaveBeenCalledWith("branch");
    expect(onView).not.toHaveBeenCalled();
  });

  it("折叠后只留图标，名称仍可通过标签与提示访问", async () => {
    const onView = vi.fn();
    const onToggleCollapsed = vi.fn();
    render(WorkspaceRail, { props: railProps({ collapsed: true, onView, onToggleCollapsed }) as never });
    expect(screen.queryByText("提交历史")).toBeNull();
    const history = screen.getByRole("button", { name: "提交历史" });
    expect(history.getAttribute("title")).toContain("提交历史");
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeTruthy();
    await fireEvent.click(history);
    expect(onView).toHaveBeenCalledWith("history");
    await fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(onToggleCollapsed).toHaveBeenCalled();
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
      onTheme: () => {},
      onSettings: () => {},
      ...overrides,
    };
  }

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
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    expect(screen.getByRole("menuitem", { name: /获取更新/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /拉取 1 个提交/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /推送 2 个提交/ })).toBeTruthy();
    await fireEvent.click(screen.getByRole("menuitem", { name: /获取更新/ }));
    expect(onFetch).toHaveBeenCalled();
    expect(onPull).not.toHaveBeenCalled();
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
  it("显示分支、同步与改动计数，刷新入口在这里", async () => {
    const onRefresh = vi.fn();
    render(StatusBar, {
      props: { branch: "main", sync: "领先 2", changeCount: 8, conflictCount: 1, onRefresh } as never,
    });
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("领先 2")).toBeTruthy();
    expect(screen.getByText("改动 8")).toBeTruthy();
    expect(screen.getByText("冲突 1")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "刷新工作区" }));
    expect(onRefresh).toHaveBeenCalled();
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
    await fireEvent.click(screen.getByText("/work/beta/demo"));
    expect(onOpen).toHaveBeenCalledWith("/work/beta/demo");
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
