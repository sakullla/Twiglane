import { readFileSync } from "node:fs";
import path from "node:path";
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

  it("冲突清零但合并仍在进行时，分支合并入口仍有独立标记", () => {
    const merging = render(WorkspaceRail, {
      props: railProps({ conflictCount: 0, mergeInProgress: true }) as never,
    });
    const merge = merging.container.querySelector<HTMLElement>('[aria-label="分支合并（合并进行中）"]');
    expect(merge, "进行中的合并必须在任务入口的 aria-label 上可见").toBeTruthy();
    expect(merge?.getAttribute("title")).toContain("合并进行中");
    const marker = merge?.querySelector("[data-rail-status]");
    expect(marker, "进行中的合并要有独立于冲突计数的标记").toBeTruthy();
    expect(marker?.getAttribute("aria-hidden")).toBe("true");
    expect(merge?.querySelector(".count"), "冲突数为 0 时不该出现计数").toBeNull();

    // 计数与「进行中」互不替代：同时成立时两者都渲染
    const both = render(WorkspaceRail, {
      props: railProps({ conflictCount: 2, mergeInProgress: true }) as never,
    });
    const bothMerge = both.container.querySelector<HTMLElement>('[aria-label="分支合并 2（合并进行中）"]');
    expect(bothMerge?.querySelector("[data-rail-status]")).toBeTruthy();
    expect(bothMerge?.textContent).toContain("2");
  });

  it("折叠态同时呈现冲突数与进行中的合并，两种信息都不丢", () => {
    const { container } = render(WorkspaceRail, {
      props: railProps({ collapsed: true, conflictCount: 2, mergeInProgress: true }) as never,
    });
    const merge = container.querySelector<HTMLElement>('[aria-label="分支合并 2（合并进行中）"]');
    expect(merge, "折叠后名称、数量与状态仍由标签承载").toBeTruthy();
    const count = merge?.querySelector(".count");
    const dot = merge?.querySelector("[data-rail-status]");
    expect(count?.textContent, "数量由徽标本身承载").toBe("2");
    expect(dot, "进行中的合并另有独立标记").toBeTruthy();
    expect(count === dot, "两者必须是两个节点，样式层才有错开位点的余地").toBe(false);
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

  it("仓库搜索框只宣称过滤最近仓库列表，不再声称 Ctrl/⌘K 会定位到它", () => {
    const { container } = render(WorkspaceRail, { props: railProps() as never });
    const input = container.querySelector<HTMLInputElement>("#repo-search")!;
    expect(input.placeholder).toContain("过滤最近仓库");
    expect(input.placeholder).not.toMatch(/搜索/);
    // 提示里出现的是「过滤列表」与「命令面板用 Ctrl/⌘K」，不是「按 Ctrl/⌘K 定位搜索框」
    expect(input.getAttribute("title")).toContain("命令面板");
    expect(input.getAttribute("title")).toContain("只过滤最近仓库列表");
    // 字段内不再挂 ⌘K 键帽：那个组合键的真实动作是打开命令面板
    const field = input.closest(".field")!;
    expect(field.querySelector("kbd")).toBeNull();
    expect(input.getAttribute("aria-label") ?? container.textContent).toBeTruthy();
    // 可访问名称来自 label（读屏读到的也是「过滤」而不是「搜索」）
    const label = container.querySelector<HTMLLabelElement>('label[for="repo-search"]')!;
    expect(label.textContent).toContain("过滤最近仓库列表");
    expect(label.textContent).not.toMatch(/搜索/);
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

  it("标题栏、rail、命令面板与起始页的每个新类名都有真实规则", () => {
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
          ".rail",
          ".rail-head",
          ".rail-toggle",
          ".rail-add",
          ".rail-nav",
          ".rail-tasks",
          ".rail-status-dot",
          ".collapsed",
          ".welcome-compact",
          ".welcome-inner-compact",
          ".welcome-empty",
          ".welcome-diagnostic",
          ".welcome-section",
        ],
      ],
      [
        componentClasses,
        [
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

  it("rail 展开 240px、折叠 56px，折叠态同时收窄网格轨道", () => {
    expect(ruleBody(layoutCss, ".rail")).toMatch(/240px/);
    expect(ruleBody(layoutCss, ".sidebar.rail.collapsed")).toMatch(/--rail-width:\s*56px/);
    expect(layoutCss).toMatch(/\.workspace:has\(> \.sidebar\.rail\.collapsed\)\s*\{[^}]*56px/);
    // 折叠态每项收成图标方块（R4：折叠后只显示图标）
    expect(ruleBody(layoutCss, ".sidebar.rail.collapsed .workspace-nav-item")).toMatch(/justify-content:\s*center/);
  });

  /** 折叠态两个标记的位点：冲突计数徽标与「合并进行中」圆点可以同时成立，位点必须错开。 */
  it("折叠态计数徽标与合并进行中圆点位点错开，并存时不遮挡", () => {
    const badge = ruleBody(layoutCss, ".sidebar.rail.collapsed .workspace-nav-item .count");
    const dot = ruleBody(layoutCss, ".sidebar.rail.collapsed .workspace-nav-item .rail-status-dot");
    expect(badge).toMatch(/position:\s*absolute/);
    expect(badge).toMatch(/top:\s*3px/);
    expect(dot).toMatch(/position:\s*absolute/);
    expect(dot, "圆点不能与 14px 计数徽标同占右上角").not.toMatch(/top:\s*3px/);
    expect(dot, "圆点挪到图标项右下角").toMatch(/bottom:\s*3px/);
    expect(badge, "徽标留在右上角，与圆点不同侧").not.toMatch(/bottom:\s*3px/);
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

