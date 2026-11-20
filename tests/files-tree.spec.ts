import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openSubmenu, openTreeSubmenu, pickMenuItem, rootMenu } from "./helpers/menu";
import { chainOf, FILE_ROW_HEIGHT, filterRows, flattenTree, buildChangedTree, makeNode, sortTree, type FileNode } from "../src/lib/files.svelte";
import { BUSY_REASON } from "../src/lib/ui";
import type { FileChange } from "../src/lib/types";

const repositoryDirectory = vi.hoisted(() => vi.fn());
const repositoryFileContent = vi.hoisted(() => vi.fn());
const repositoryContentSearch = vi.hoisted(() => vi.fn());
const filePreview = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/api", () => ({ api: { repositoryDirectory, repositoryFileContent, repositoryContentSearch, filePreview } }));

import FileTree from "../src/lib/components/FileTree.svelte";
import RepositoryFiles from "../src/lib/components/RepositoryFiles.svelte";
import type { OpenedRepository, RepositoryDirectory } from "../src/lib/types";

const repoPath = "C:/work/demo";

function opened(path = repoPath, generation = 4): OpenedRepository {
  return {
    summary: { name: "demo", path },
    generation,
    snapshot: {
      generation,
      branch: {
        name: "main",
        detached: false,
        unborn: false,
        headOid: "a".repeat(40),
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        liveRemoteChecked: true,
        remoteCheckedAtMs: 1,
        remoteCheckStale: false,
      },
      files: [],
    },
    draft: "",
    watchDegraded: false,
  };
}

function dir(relative: string, entries: RepositoryDirectory["entries"], generation = 4): RepositoryDirectory {
  return { generation, path: relative, entries, errors: [] };
}

function node(path: string, kind: FileNode["kind"] = "directory", children: FileNode[] | null = null, name = path.split("/").pop() ?? path): FileNode {
  return { ...makeNode({ name, path, kind, ignored: false, size: kind === "file" ? 12 : null, error: null }), children };
}

function tree(): FileNode[] {
  const deep = node("src/lib/components", "directory", [
    node("src/lib/components/Button.svelte", "file", null, "Button.svelte"),
    node("src/lib/components/Icon.svelte", "file", null, "Icon.svelte"),
  ]);
  const lib = node("src/lib", "directory", [deep]);
  const src = node("src", "directory", [lib]);
  src.expanded = true;
  lib.expanded = true;
  deep.expanded = true;
  return [src, node("README.md", "file", null, "README.md")];
}

beforeEach(() => {
  repositoryDirectory.mockReset();
  repositoryFileContent.mockReset();
  repositoryContentSearch.mockReset();
  filePreview.mockReset();
});

describe("目录树结构", () => {
  it("单链目录合并成一行，拆开后逐级显示", () => {
    const src = tree()[0];
    const chain = chainOf(src);
    expect(chain.map((item) => item.name)).toEqual(["src", "lib", "components"]);
    const rows = flattenTree([src]);
    expect(rows[0].label).toBe("src/lib/components");
    expect(rows.map((row) => row.path)).toEqual([
      "src/lib/components",
      "src/lib/components/Button.svelte",
      "src/lib/components/Icon.svelte",
    ]);
    expect(rows[0].splittable).toBe(true);

    src.split = true;
    const split = flattenTree([src]);
    expect(split.slice(0, 3).map((row) => [row.label, row.depth, row.segment])).toEqual([
      ["src", 0, true],
      ["lib", 1, true],
      ["components", 2, false],
    ]);
  });

  it("嵌套仓库、符号链接与特殊文件不展开，也不参与单链合并", () => {
    const nested = node("vendor", "nestedRepository", [node("vendor/inner.ts", "file", null, "inner.ts")]);
    nested.expanded = true;
    const link = node("link", "symlink");
    const socket = node("socket", "special");
    const rows = flattenTree([nested, link, socket]);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => !row.expandable && !row.segment)).toBe(true);
    expect(chainOf(nested)).toHaveLength(1);
  });

  it("未展开的目录不带出后代，过滤保留匹配项的必要祖先", () => {
    const [src, readme] = tree();
    // 展开状态在合并链的最后一级上：折叠它，后代就不再出现。
    src.children![0].children![0].expanded = false;
    expect(flattenTree([src, readme]).map((row) => row.path)).toEqual(["src/lib/components", "README.md"]);

    const rows = flattenTree(tree());
    const filtered = filterRows(rows, "icon");
    expect(filtered.map((row) => row.path)).toEqual([
      "src/lib/components",
      "src/lib/components/Icon.svelte",
    ]);
  });

  it("仅改动树按自然序排列：数字段按数值比较", () => {
    const change = (path: string): FileChange => ({ path, originalPath: null, staged: "none", unstaged: "modified", untracked: false, unmerged: false });
    const files = [change("task-runs/T11-run.md"), change("task-runs/T2-run.md"), change("task-runs/T9-run.md")];
    const rows = flattenTree(buildChangedTree(files));
    expect(rows.map((row) => row.path)).toEqual(["task-runs", "task-runs/T2-run.md", "task-runs/T9-run.md", "task-runs/T11-run.md"]);
  });
});

describe("目录树交互", () => {
  const baseProps = () => ({
    rows: flattenTree(tree()),
    selectedPath: "src/lib/components/Button.svelte",
    selectedPaths: new Set<string>(),
    loading: false,
    failure: null,
    query: "",
    includeIgnored: false,
    disabled: false,
    onQuery: vi.fn(),
    onIncludeIgnored: vi.fn(),
    onToggle: vi.fn(),
    onSelect: vi.fn(),
    onSelectAll: vi.fn(),
    onClearSelection: vi.fn(),
    onSplit: vi.fn(),
    onHistory: vi.fn(),
    onRefresh: vi.fn(),
    onReveal: vi.fn(),
    onOpenDefault: vi.fn(),
    onCopyPath: vi.fn(),
    toAbsolute: (relative: string) => `C:/work/demo/${relative.split("/").join("\\")}`,
    hasChange: vi.fn(() => false),
    onViewDiff: vi.fn(),
  });

  it("长路径放在 title 上，忽略项与目录尺寸都有标记，且不截断 aria 名称", () => {
    const rows = flattenTree(tree());
    rows[0] = { ...rows[0], ignored: true };
    const props = { ...baseProps(), rows };
    render(FileTree, { props: props as never });
    const treeEl = screen.getByRole("tree", { name: "仓库文件" });
    expect(treeEl).toBeTruthy();
    const first = within(treeEl).getByRole("treeitem", { name: "src/lib/components" });
    expect(first.getAttribute("title")).toBe("src/lib/components");
    expect(first.textContent).toContain("忽略");
    expect(within(treeEl).getByText("Button.svelte")).toBeTruthy();
  });

  it("上下移动、Enter 打开与菜单键都在树上工作", async () => {
    const props = baseProps();
    const view = render(FileTree, { props: props as never });
    const treeEl = screen.getByRole("tree", { name: "仓库文件" });
    treeEl.focus();
    await fireEvent.keyDown(treeEl, { key: "ArrowDown" });
    expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ path: "src/lib/components/Icon.svelte" }));

    // 选择由状态决定：把焦点移到 Icon 后再按上键，回到 Button。
    await view.rerender({ ...props, selectedPath: "src/lib/components/Icon.svelte" } as never);
    await fireEvent.keyDown(screen.getByRole("tree", { name: "仓库文件" }), { key: "ArrowUp" });
    expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ path: "src/lib/components/Button.svelte" }));

    await view.rerender({ ...props, selectedPath: "src/lib/components/Button.svelte" } as never);
    props.onSelect.mockClear();
    await fireEvent.keyDown(screen.getByRole("tree", { name: "仓库文件" }), { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: "src/lib/components/Button.svelte" }));
  });

  it("目录行的左右键切换展开，菜单键打开上下文菜单", async () => {
    const rows = flattenTree(tree());
    const props = { ...baseProps(), rows, selectedPath: "src/lib/components" };
    render(FileTree, { props: props as never });
    const treeEl = screen.getByRole("tree", { name: "仓库文件" });
    treeEl.focus();
    await fireEvent.keyDown(treeEl, { key: "ArrowLeft" });
    expect(props.onToggle).toHaveBeenCalled();
    await fireEvent.keyDown(treeEl, { key: "ContextMenu" });
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("长列表只渲染可见行", () => {
    const entries = Array.from({ length: 2000 }, (_, index) => node(`src/gen/file-${index}.ts`, "file", null, `file-${index}.ts`));
    const rows = flattenTree([{ ...node("src/gen", "directory", entries), expanded: true }]);
    render(FileTree, { props: { ...baseProps(), rows } as never });
    expect(rows.length).toBe(2001);
    expect(document.querySelectorAll(".file-tree-row").length).toBeLessThan(80);
    expect(FILE_ROW_HEIGHT).toBeGreaterThan(0);
  });

  it("空状态区分空仓库、过滤无匹配与可能有被忽略的文件", async () => {
    const props = { ...baseProps(), rows: [] };
    const view = render(FileTree, { props: props as never });
    expect(screen.getByText("这里没有可显示的文件")).toBeTruthy();
    expect(screen.getByText(/被 \.gitignore 忽略的文件/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "显示忽略文件" }));
    expect(props.onIncludeIgnored).toHaveBeenCalledWith(true);

    await view.rerender({ ...props, includeIgnored: true } as never);
    expect(screen.getByText("这个仓库里没有可显示的文件")).toBeTruthy();

    await view.rerender({ ...props, query: "abc" } as never);
    expect(screen.getByText("没有匹配的路径")).toBeTruthy();
  });

  it("空目录与读取失败分别给出行内状态", () => {
    const empty = node("docs", "directory", []);
    empty.expanded = true;
    render(FileTree, { props: { ...baseProps(), rows: flattenTree([empty]) } as never });
    expect(screen.getByText("空目录")).toBeTruthy();

    const broken = node("vendor", "directory", []);
    broken.expanded = true;
    broken.failure = "无法读取这个目录";
    render(FileTree, { props: { ...baseProps(), rows: flattenTree([broken]) } as never });
    expect(screen.getByText("读取失败")).toBeTruthy();
  });
});

describe("目录树右键菜单", () => {
  const baseProps = () => ({
    rows: flattenTree(tree()),
    selectedPath: "src/lib/components/Button.svelte",
    selectedPaths: new Set<string>(),
    loading: false,
    failure: null,
    query: "",
    includeIgnored: false,
    disabled: false,
    onQuery: vi.fn(),
    onIncludeIgnored: vi.fn(),
    onToggle: vi.fn(),
    onSelect: vi.fn(),
    onSelectAll: vi.fn(),
    onClearSelection: vi.fn(),
    onSplit: vi.fn(),
    onHistory: vi.fn(),
    onRefresh: vi.fn(),
    onReveal: vi.fn(),
    onOpenDefault: vi.fn(),
    onCopyPath: vi.fn(),
    toAbsolute: (relative: string) => `C:/work/demo/${relative.split("/").join("\\")}`,
    hasChange: vi.fn(() => false),
    onViewDiff: vi.fn(),
  });

  function rowEl(path: string): HTMLElement {
    const treeEl = screen.getByRole("tree", { name: "仓库文件" });
    const found = treeEl.querySelector<HTMLElement>(`.file-tree-row[title="${path}"]`);
    if (!found) throw new Error(`没有 ${path} 这一行`);
    return found;
  }

  async function openMenu(path: string) {
    await fireEvent.contextMenu(rowEl(path), { clientX: 60, clientY: 80 });
    return rootMenu();
  }

  function labels(menu: HTMLElement): string[] {
    return within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim() ?? "");
  }

  /** 顶层条目加上各个可展开子菜单里的条目（子菜单逐个展开读取）。 */
  async function deepLabels(menu: HTMLElement): Promise<string[]> {
    const names = labels(menu);
    for (const trigger of within(menu).getAllByRole("menuitem")) {
      if (trigger.getAttribute("aria-haspopup") !== "menu" || trigger.getAttribute("aria-disabled") === "true") continue;
      const sub = await openSubmenu(menu, trigger.getAttribute("aria-label") ?? "");
      names.push(...within(sub).queryAllByRole("menuitem").map((item) => item.textContent?.trim() ?? ""));
      names.push(...within(sub).queryAllByRole("menuitemcheckbox").map((item) => item.textContent?.trim() ?? ""));
    }
    return names;
  }

  it("目录菜单分组：系统定位、路径子菜单（三种复制）；展开/折叠交给单击，右键目录不改变展开态", async () => {
    const props = baseProps();
    render(FileTree, { props: props as never });
    const menu = await openMenu("src/lib/components");
    const top = labels(menu);
    // 展开/折叠由单击完成，菜单里不再重复。
    expect(top.some((text) => text === "折叠" || text === "展开")).toBe(false);
    expect(top.some((text) => /资源管理器|访达/.test(text))).toBe(true);
    const names = await deepLabels(menu);
    for (const label of ["复制相对路径", "复制完整路径", "复制目录名"]) {
      expect(names.some((text) => text.startsWith(label)), label).toBe(true);
    }
    // 目录没有「用默认程序打开」「查看改动」「查看文件历史」。
    expect(names.some((text) => text.startsWith("用默认程序打开"))).toBe(false);
    expect(names.some((text) => text.startsWith("查看改动"))).toBe(false);
    // 分组之间有分隔线。
    expect(menu.querySelectorAll('[role="separator"]').length).toBeGreaterThanOrEqual(2);
    // 右键只选中目标，不切换展开。
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: "src/lib/components" }));
    expect(props.onToggle).not.toHaveBeenCalled();
  });

  it("插入路径到终端：文件与目录都有入口，传仓库相对路径；没有终端回调时不显示", async () => {
    const onInsertToTerminal = vi.fn();
    const view = render(FileTree, { props: { ...baseProps(), onInsertToTerminal } as never });
    let menu = await openMenu("src/lib/components/Button.svelte");
    await pickMenuItem(menu, "路径", /插入路径到终端/);
    expect(onInsertToTerminal).toHaveBeenCalledWith(["src/lib/components/Button.svelte"]);
    menu = await openMenu("src/lib/components");
    await pickMenuItem(menu, "路径", /插入路径到终端/);
    expect(onInsertToTerminal).toHaveBeenLastCalledWith(["src/lib/components"]);
    view.unmount();
    render(FileTree, { props: baseProps() as never });
    menu = await openMenu("src/lib/components/Button.svelte");
    expect((await deepLabels(menu)).some((text) => text.includes("终端"))).toBe(false);
  });

  it("文件菜单分组：文件历史、系统定位、用默认程序打开、路径子菜单（三种复制）", async () => {
    render(FileTree, { props: baseProps() as never });
    const menu = await openMenu("src/lib/components/Button.svelte");
    // 单击即打开文件，菜单不再重复「打开」。
    expect(labels(menu).includes("打开")).toBe(false);
    const names = await deepLabels(menu);
    for (const label of ["查看文件历史", "用默认程序打开", "复制相对路径", "复制完整路径", "复制文件名"]) {
      expect(names.some((text) => text.startsWith(label)), label).toBe(true);
    }
    // 系统定位按平台切换文案（测试环境非 mac，故为资源管理器）。
    expect(names.some((text) => /资源管理器|访达/.test(text))).toBe(true);
    // 没有改动时不显示「查看改动」。
    expect(names.some((text) => text.startsWith("查看改动"))).toBe(false);
  });

  it("有改动的文件才显示「查看改动」，并路由到差异入口", async () => {
    const props = { ...baseProps(), hasChange: vi.fn((path: string) => path === "src/lib/components/Button.svelte") };
    render(FileTree, { props: props as never });
    const menu = await openMenu("src/lib/components/Button.svelte");
    const diff = within(menu).getByRole("menuitem", { name: "查看改动" });
    await fireEvent.click(diff);
    expect(props.onViewDiff).toHaveBeenCalledWith("src/lib/components/Button.svelte");

    // 另一个没有改动的文件不显示该项。
    const second = await openMenu("src/lib/components/Icon.svelte");
    expect(labels(second).some((text) => text.startsWith("查看改动"))).toBe(false);
  });

  it("忽略入口：文件与目录都按右键目标上报 .gitignore 与本地排除；没有回调时不显示", async () => {
    const onIgnore = vi.fn();
    const view = render(FileTree, { props: { ...baseProps(), onIgnore } as never });

    let menu = await openMenu("src/lib/components/Button.svelte");
    await pickMenuItem(menu, "忽略", "加入 .gitignore");
    expect(onIgnore).toHaveBeenLastCalledWith("src/lib/components/Button.svelte", false);

    menu = await openMenu("src/lib/components/Button.svelte");
    await pickMenuItem(menu, "忽略", "仅本地（.git/info/exclude）");
    expect(onIgnore).toHaveBeenLastCalledWith("src/lib/components/Button.svelte", true);

    // 目录同样可忽略：规则按目录路径写入，写入后整棵子树都不再列出。
    menu = await openMenu("src/lib/components");
    await pickMenuItem(menu, "忽略", "加入 .gitignore");
    expect(onIgnore).toHaveBeenLastCalledWith("src/lib/components", false);

    view.unmount();
    render(FileTree, { props: baseProps() as never });
    menu = await openMenu("src/lib/components/Button.svelte");
    expect(labels(menu).includes("忽略")).toBe(false);
    expect((await deepLabels(menu)).some((text) => text.startsWith("加入"))).toBe(false);
  });

  it("已忽略的条目与忙碌时忽略入口灰显，菜单内说明原因", async () => {
    const rows = flattenTree(tree());
    const readme = rows.find((row) => row.path === "README.md")!;
    rows[rows.indexOf(readme)] = { ...readme, ignored: true };
    const onIgnore = vi.fn();
    const view = render(FileTree, { props: { ...baseProps(), rows, onIgnore } as never });

    // 整个「忽略」子菜单入口灰显，点了也不展开。
    let menu = await openMenu("README.md");
    const git = within(menu).getByRole("menuitem", { name: "忽略" });
    expect(git.getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByText("已经处于忽略状态，不会重复写入规则")).toBeTruthy();
    await fireEvent.click(git);
    expect(screen.queryByRole("menu", { name: "忽略" })).toBeNull();
    expect(onIgnore).not.toHaveBeenCalled();

    view.unmount();
    render(FileTree, { props: { ...baseProps(), disabled: true, onIgnore } as never });
    menu = await openMenu("README.md");
    const local = within(menu).getByRole("menuitem", { name: "忽略" });
    expect(local.getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getAllByText(BUSY_REASON).length).toBeGreaterThan(0);
    await fireEvent.click(local);
    expect(onIgnore).not.toHaveBeenCalled();
  });

  it("已删除文件的「用默认程序打开」灰显，菜单内可读原因，历史与复制仍在", async () => {
    const rows = flattenTree(tree());
    const target = rows.find((row) => row.path === "src/lib/components/Button.svelte")!;
    rows[rows.indexOf(target)] = { ...target, deleted: true };
    render(FileTree, { props: { ...baseProps(), rows } as never });
    const menu = await openMenu("src/lib/components/Button.svelte");
    const open = within(menu).getByRole("menuitem", { name: "用默认程序打开" });
    expect(open.getAttribute("aria-disabled")).toBe("true");
    const reason = within(menu).getByText("文件已删除，工作区里没有它");
    expect(open.getAttribute("aria-describedby")).toBe(reason.id);
    // 历史与路径复制不受影响。
    expect(within(menu).getByRole("menuitem", { name: "查看文件历史" })).toBeTruthy();
    const paths = await openSubmenu(menu, "路径");
    expect(within(paths).getByRole("menuitem", { name: "复制相对路径" })).toBeTruthy();
  });

  it("复制相对/完整/文件名分别得到对应文本，不再静默吞错", async () => {
    const props = baseProps();
    render(FileTree, { props: props as never });
    await pickMenuItem(await openMenu("src/lib/components/Button.svelte"), "路径", "复制相对路径");
    expect(props.onCopyPath).toHaveBeenLastCalledWith("src/lib/components/Button.svelte", "相对路径");
    await pickMenuItem(await openMenu("src/lib/components/Button.svelte"), "路径", "复制完整路径");
    expect(props.onCopyPath).toHaveBeenLastCalledWith("C:/work/demo/src\\lib\\components\\Button.svelte", "完整路径");
    await pickMenuItem(await openMenu("src/lib/components/Button.svelte"), "路径", "复制文件名");
    expect(props.onCopyPath).toHaveBeenLastCalledWith("Button.svelte", "文件名");
  });

  it("目录复制目录名取末段，系统打开该目录经回调", async () => {
    const props = baseProps();
    render(FileTree, { props: props as never });
    const menu = await openMenu("src/lib/components");
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /资源管理器|访达/ }));
    expect(props.onReveal).toHaveBeenCalledWith("src/lib/components");
    await pickMenuItem(await openMenu("src/lib/components"), "路径", "复制目录名");
    expect(props.onCopyPath).toHaveBeenLastCalledWith("components", "目录名");
  });

  it("系统定位与用默认程序打开作用在右键目标，经既有后端回调", async () => {
    const props = baseProps();
    render(FileTree, { props: props as never });
    await fireEvent.click(within(await openMenu("src/lib/components/Button.svelte")).getByRole("menuitem", { name: /资源管理器|访达/ }));
    expect(props.onReveal).toHaveBeenCalledWith("src/lib/components/Button.svelte");
    await fireEvent.click(within(await openMenu("src/lib/components/Button.svelte")).getByRole("menuitem", { name: "用默认程序打开" }));
    expect(props.onOpenDefault).toHaveBeenCalledWith("src/lib/components/Button.svelte");
  });

  it("先选中 A 再右键 B，动作只作用于 B", async () => {
    const props = { ...baseProps(), selectedPath: "src/lib/components/Icon.svelte" };
    render(FileTree, { props: props as never });
    // 右键 Button（A 是 Icon）：先把选中切到 Button，再对 Button 执行。
    await pickMenuItem(await openMenu("src/lib/components/Button.svelte"), "路径", "复制相对路径");
    expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ path: "src/lib/components/Button.svelte" }));
    expect(props.onCopyPath).toHaveBeenLastCalledWith("src/lib/components/Button.svelte", "相对路径");
  });

  it("菜单键与 Shift+F10 对当前选中项打开同一份菜单与动作", async () => {
    const props = { ...baseProps(), selectedPath: "src/lib/components/Button.svelte" };
    render(FileTree, { props: props as never });
    const treeEl = screen.getByRole("tree", { name: "仓库文件" });
    treeEl.focus();
    await fireEvent.keyDown(treeEl, { key: "ContextMenu" });
    let menu = screen.getByRole("menu");
    expect(menu.getAttribute("aria-label")).toBe("src/lib/components/Button.svelte 的操作");
    const keyboardLabels = labels(menu);
    await fireEvent.keyDown(menu, { key: "Escape" });

    // Shift+F10 得到等价的一份菜单。
    await fireEvent.keyDown(screen.getByRole("tree", { name: "仓库文件" }), { key: "F10", shiftKey: true });
    menu = screen.getByRole("menu");
    expect(labels(menu)).toEqual(keyboardLabels);
    // 动作走同一回调。
    await pickMenuItem(menu, "路径", "复制相对路径");
    expect(props.onCopyPath).toHaveBeenLastCalledWith("src/lib/components/Button.svelte", "相对路径");
  });

  it("条目较多的文件菜单在自身区域滚动，末尾条目仍可到达", async () => {
    const props = { ...baseProps(), hasChange: vi.fn(() => true) };
    render(FileTree, { props: props as never });
    const menu = await openMenu("src/lib/components/Button.svelte");
    // .context-menu 固定定位并带 max-height + overflow，超长菜单在自身滚动而不是撑爆视口。
    expect(menu.classList.contains("context-menu")).toBe(true);
    // 末尾分组的条目（文件树子菜单）仍然渲染、可被键盘与指针到达。
    const last = within(menu).getByRole("menuitem", { name: "文件树" });
    expect(last).toBeTruthy();
    await pickMenuItem(menu, "文件树", "重新读取目录");
    expect(props.onRefresh).toHaveBeenCalled();
  });

  it("没有宿主授权时不出现文件操作入口，也不含 Git 写入或编辑器入口", async () => {
    render(FileTree, { props: { ...baseProps(), hasChange: vi.fn(() => true) } as never });
    const fileMenu = labels(await openMenu("src/lib/components/Button.svelte")).join(" ");
    await fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    const dirMenu = labels(await openMenu("src/lib/components")).join(" ");
    // 只读宿主（例如审阅、历史）不传 onEntryAction：菜单里就没有结构操作。
    for (const absent of ["新建", "复制到", "移动或重命名", "删除…"]) {
      expect(fileMenu.includes(absent), `文件菜单不应含「${absent}」`).toBe(false);
      expect(dirMenu.includes(absent), `目录菜单不应含「${absent}」`).toBe(false);
    }
    // 文件操作不借菜单做 Git 写入或编辑器入口。
    for (const forbidden of ["暂存", "提交", "放弃", "保存", ".gitignore", "忽略", "加入"]) {
      expect(fileMenu.includes(forbidden), `文件菜单不应含「${forbidden}」`).toBe(false);
      expect(dirMenu.includes(forbidden), `目录菜单不应含「${forbidden}」`).toBe(false);
    }
  });

  it("多选菜单提供批量复制、移动与删除，保留系统定位和路径复制", async () => {
    const rows = flattenTree([
      node("a.ts", "file", null, "a.ts"),
      node("b.ts", "file", null, "b.ts"),
      node("c.ts", "file", null, "c.ts"),
    ]);
    const onBatchEntry = vi.fn();
    render(FileTree, {
      props: {
        ...baseProps(),
        rows,
        selectedPath: "b.ts",
        selectedPaths: new Set(["a.ts", "b.ts"]),
        onBatchEntry,
      } as never,
    });
    const menu = await openMenu("b.ts");
    const names = labels(menu);
    expect(screen.getByText("已选 2 项", { selector: ".menu-label" })).toBeTruthy();
    const paths = await openSubmenu(menu, "路径");
    expect(within(paths).getByRole("menuitem", { name: "复制相对路径" })).toBeTruthy();
    for (const label of ["复制 2 项到…", "移动 2 项到…", "删除 2 项…"]) {
      expect(names.some((text) => text.startsWith(label)), label).toBe(true);
    }
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "移动 2 项到…" }));
    expect(onBatchEntry).toHaveBeenCalledWith("move", [expect.objectContaining({ path: "a.ts" }), expect.objectContaining({ path: "b.ts" })]);
  });

  it("批量结构操作排除目录后代与特殊项目，避免同一内容被处理两次", async () => {
    const rows = flattenTree([
      { ...node("src", "directory", [], "src"), expanded: true },
      node("src/a.ts", "file", null, "a.ts"),
      node("link.ts", "symlink", null, "link.ts"),
      node("vendor", "nestedRepository", [], "vendor"),
    ]);
    const onBatchEntry = vi.fn();
    render(FileTree, {
      props: {
        ...baseProps(),
        rows,
        selectedPath: "src",
        selectedPaths: new Set(["src", "src/a.ts", "link.ts", "vendor"]),
        onBatchEntry,
      } as never,
    });
    const menu = await openMenu("src");
    expect(within(menu).getByText("已选 1 项", { selector: ".menu-label" })).toBeTruthy();
    expect(screen.getByText(/已选\s*4\s*项/)).toBeTruthy();
    // 不参与操作的项目收在子菜单里，逐项写明原因。
    const excluded = await openSubmenu(menu, "2 项不参与操作");
    expect(within(excluded).getByText("符号链接不参与文件操作")).toBeTruthy();
    expect(within(excluded).getByText("嵌套仓库不参与文件操作")).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "src/a.ts" })).toBeNull();
    await fireEvent.keyDown(screen.getByRole("tree", { name: "仓库文件" }), { key: "Delete" });
    expect(onBatchEntry).toHaveBeenCalledWith("delete", [expect.objectContaining({ path: "src" })]);
    onBatchEntry.mockClear();
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "复制 1 项到…" }));
    expect(onBatchEntry).toHaveBeenCalledWith("copy", [expect.objectContaining({ path: "src" })]);
  });

  it("目录外的另一项仍单独计入，子路径不另算", async () => {
    const rows = flattenTree([
      { ...node("src", "directory", [], "src"), expanded: true },
      node("src/a.ts", "file", null, "a.ts"),
      node("note.txt", "file", null, "note.txt"),
    ]);
    const onBatchEntry = vi.fn();
    render(FileTree, {
      props: {
        ...baseProps(),
        rows,
        selectedPath: "src",
        selectedPaths: new Set(["src", "src/a.ts", "note.txt"]),
        onBatchEntry,
      } as never,
    });
    const menu = await openMenu("note.txt");
    expect(within(menu).getByText("已选 2 项", { selector: ".menu-label" })).toBeTruthy();
    expect(screen.getByText(/已选\s*3\s*项/)).toBeTruthy();
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "移动 2 项到…" }));
    expect(onBatchEntry).toHaveBeenCalledWith("move", [
      expect.objectContaining({ path: "src" }),
      expect.objectContaining({ path: "note.txt" }),
    ]);
  });
});

describe("目录树默认外观", () => {
  const baseProps = () => ({
    rows: flattenTree(tree()),
    selectedPath: "src/lib/components/Button.svelte",
    selectedPaths: new Set<string>(),
    loading: false,
    failure: null,
    query: "",
    includeIgnored: false,
    disabled: false,
    onQuery: vi.fn(),
    onIncludeIgnored: vi.fn(),
    onToggle: vi.fn(),
    onSelect: vi.fn(),
    onSelectAll: vi.fn(),
    onClearSelection: vi.fn(),
    onSplit: vi.fn(),
    onHistory: vi.fn(),
    onRefresh: vi.fn(),
    onReveal: vi.fn(),
    onOpenDefault: vi.fn(),
    onCopyPath: vi.fn(),
    toAbsolute: (relative: string) => `C:/work/demo/${relative}`,
    hasChange: vi.fn(() => false),
    onViewDiff: vi.fn(),
    onSearch: vi.fn(),
    onChangedOnly: vi.fn(),
    onNameDirection: vi.fn(),
    onCollapseAll: vi.fn(),
    onEntryAction: vi.fn(),
  });

  async function openMenu(path: string) {
    const treeEl = screen.getByRole("tree", { name: "仓库文件" });
    const row = treeEl.querySelector<HTMLElement>(`.file-tree-row[title="${path}"]`);
    if (!row) throw new Error(`没有 ${path} 这一行`);
    await fireEvent.contextMenu(row, { clientX: 40, clientY: 48 });
    return rootMenu();
  }

  function expectNoTreeChrome() {
    expect(document.querySelector(".tree-select")).toBeNull();
    expect(document.querySelector(".file-tools-actions")).toBeNull();
    for (const name of ["全仓库搜索", "只看有改动的文件", "更多文件树选项"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /名称(升序|降序)/ })).toBeNull();
    expect(screen.getByRole("textbox", { name: "过滤文件树" })).toBeTruthy();
  }

  it("未多选时没有选择框，筛选框旁也没有四个图标", async () => {
    render(FileTree, { props: baseProps() as never });
    expectNoTreeChrome();
    const treeEl = screen.getByRole("tree", { name: "仓库文件" });
    await fireEvent.mouseEnter(treeEl);
    await fireEvent.focus(treeEl);
    const row = treeEl.querySelector(".file-tree-row") as HTMLElement;
    await fireEvent.mouseEnter(row);
    await fireEvent.focus(row);
    expectNoTreeChrome();
  });

  it("多选仍只高亮并显示已选行数，Esc 后选择框和图标都不出现", async () => {
    const props = { ...baseProps(), selectedPaths: new Set(["src/lib/components", "README.md"]) };
    const view = render(FileTree, { props: props as never });
    expect(screen.getByText(/已选\s*2\s*项/)).toBeTruthy();
    expectNoTreeChrome();
    await fireEvent.keyDown(screen.getByRole("tree", { name: "仓库文件" }), { key: "Escape" });
    expect(props.onClearSelection).toHaveBeenCalled();
    await view.rerender({ ...props, selectedPaths: new Set<string>() } as never);
    expect(screen.queryByText(/已选\s*2\s*项/)).toBeNull();
    expectNoTreeChrome();
  });

  it("单选与多选右键都能到达树级动作，并保留新建、复制、移动、删除和复制路径", async () => {
    const props = baseProps();
    const view = render(FileTree, { props: props as never });
    let menu = await openMenu("src/lib/components");
    for (const name of ["新建", "复制到…", "移动或重命名…", "删除…", "路径", "文件树"]) {
      expect(within(menu).getByRole("menuitem", { name }), name).toBeTruthy();
    }
    expect(within(menu).getByRole("menuitem", { name: /资源管理器|访达/ })).toBeTruthy();
    const create = await openSubmenu(menu, "新建");
    for (const name of ["文件…", "目录…"]) expect(within(create).getByRole("menuitem", { name }), name).toBeTruthy();
    const treeMenu = await openSubmenu(menu, "文件树");
    for (const name of ["全仓库搜索", "全部折叠", "重新读取目录"]) {
      expect(within(treeMenu).getByRole("menuitem", { name }), name).toBeTruthy();
    }
    // 按路径打开走 Ctrl/⌘ P，不再占菜单位置。
    expect(within(treeMenu).queryByRole("menuitem", { name: "按路径打开" })).toBeNull();
    expect(within(treeMenu).getByRole("menuitemcheckbox", { name: "只看有改动的文件" }).getAttribute("aria-checked")).toBe("false");
    expect(within(treeMenu).getByRole("menuitemcheckbox", { name: "名称降序" }).getAttribute("aria-checked")).toBe("false");
    expect(within(treeMenu).getByRole("menuitemcheckbox", { name: "显示忽略的文件" }).getAttribute("aria-checked")).toBe("false");

    await fireEvent.click(within(treeMenu).getByRole("menuitem", { name: "全仓库搜索" }));
    expect(props.onSearch).toHaveBeenCalledWith("content");
    await pickMenuItem(await openMenu("src/lib/components"), "文件树", "只看有改动的文件");
    expect(props.onChangedOnly).toHaveBeenCalledWith(true);
    await pickMenuItem(await openMenu("src/lib/components"), "文件树", "名称降序");
    expect(props.onNameDirection).toHaveBeenCalledWith("desc");
    await pickMenuItem(await openMenu("src/lib/components"), "文件树", "显示忽略的文件");
    expect(props.onIncludeIgnored).toHaveBeenCalledWith(true);
    await pickMenuItem(await openMenu("src/lib/components"), "文件树", "全部折叠");
    expect(props.onCollapseAll).toHaveBeenCalled();
    await pickMenuItem(await openMenu("src/lib/components"), "文件树", "重新读取目录");
    expect(props.onRefresh).toHaveBeenCalled();

    view.unmount();
    render(FileTree, {
      props: {
        ...baseProps(),
        rows: flattenTree([node("a.ts", "file", null, "a.ts"), node("b.ts", "file", null, "b.ts")]),
        selectedPath: "a.ts",
        selectedPaths: new Set(["a.ts", "b.ts"]),
        onBatchEntry: vi.fn(),
      } as never,
    });
    menu = await openMenu("b.ts");
    expect(within(menu).getByRole("menuitem", { name: "复制 2 项到…" })).toBeTruthy();
    const batchTree = await openSubmenu(menu, "文件树");
    expect(within(batchTree).getByRole("menuitem", { name: "全仓库搜索" })).toBeTruthy();
    expect(within(batchTree).getByRole("menuitemcheckbox", { name: "只看有改动的文件" })).toBeTruthy();
    expectNoTreeChrome();
  });

  it("在目录树空白处右键提供仓库根目录的新建、路径与文件树入口，不额外增加常驻按钮", async () => {
    const onEntryAction = vi.fn();
    const onCopyPath = vi.fn();
    const onReveal = vi.fn();
    const props = {
      ...baseProps(),
      onEntryAction,
      onCopyPath,
      onReveal,
      toAbsolute: (rel: string) => (rel ? `/repo/${rel}` : "/repo"),
    };
    render(FileTree, { props: props as never });
    expectNoTreeChrome();

    const treeEl = screen.getByRole("tree", { name: "仓库文件" });
    await fireEvent.contextMenu(treeEl, { clientX: 64, clientY: 180 });
    const menu = screen.getByRole("menu", { name: "仓库根目录的操作" });
    expect(within(menu).getByRole("menuitem", { name: "新建" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "路径" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "文件树" })).toBeTruthy();

    const createSub = await openSubmenu(menu, "新建");
    await fireEvent.click(within(createSub).getByRole("menuitem", { name: "文件…" }));
    expect(onEntryAction).toHaveBeenCalledWith("createFile", expect.objectContaining({ path: "", kind: "directory" }));

    await fireEvent.contextMenu(treeEl, { clientX: 64, clientY: 180 });
    const pathSub = await openSubmenu(screen.getByRole("menu", { name: "仓库根目录的操作" }), "路径");
    await fireEvent.click(within(pathSub).getByRole("menuitem", { name: "复制完整路径" }));
    expect(onCopyPath).toHaveBeenCalledWith("/repo", "仓库路径");
    expectNoTreeChrome();
  });

  it("只看有改动时树上方有一行可关闭的说明，关掉后图标排不出现", async () => {
    const props = { ...baseProps(), changedOnly: true };
    const view = render(FileTree, { props: props as never });
    expect(screen.getByText("正在只看有改动的文件")).toBeTruthy();
    const menu = await openMenu("README.md");
    const treeMenu = await openSubmenu(menu, "文件树");
    expect(within(treeMenu).getByRole("menuitemcheckbox", { name: "只看有改动的文件" }).getAttribute("aria-checked")).toBe("true");
    // Esc 先收回子菜单，再关掉整个菜单。
    await fireEvent.keyDown(treeMenu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "文件树" })).toBeNull();
    await fireEvent.keyDown(menu, { key: "Escape" });
    await fireEvent.click(screen.getByRole("button", { name: "显示全部" }));
    expect(props.onChangedOnly).toHaveBeenCalledWith(false);
    await view.rerender({ ...props, changedOnly: false } as never);
    expect(screen.queryByText("正在只看有改动的文件")).toBeNull();
    expectNoTreeChrome();
  });

  it("名称不是升序时只在右键菜单标明，不另起说明行", async () => {
    const props = { ...baseProps(), nameDirection: "desc" as const };
    render(FileTree, { props: props as never });
    expect(document.querySelector(".file-tree-status")).toBeNull();
    const item = within(await openSubmenu(await openMenu("README.md"), "文件树")).getByRole("menuitemcheckbox", { name: "名称降序" });
    expect(item.getAttribute("aria-checked")).toBe("true");
    await fireEvent.click(item);
    expect(props.onNameDirection).toHaveBeenCalledWith("asc");
    expect(screen.queryByRole("button", { name: "名称降序" })).toBeNull();
  });
});

describe("文件与目录操作入口", () => {
  const baseProps = () => ({
    rows: flattenTree(tree()),
    selectedPath: "src/lib/components/Button.svelte",
    selectedPaths: new Set<string>(),
    loading: false,
    failure: null,
    query: "",
    includeIgnored: false,
    disabled: false,
    onQuery: vi.fn(),
    onIncludeIgnored: vi.fn(),
    onToggle: vi.fn(),
    onSelect: vi.fn(),
    onSelectAll: vi.fn(),
    onClearSelection: vi.fn(),
    onSplit: vi.fn(),
    onHistory: vi.fn(),
    onRefresh: vi.fn(),
    onReveal: vi.fn(),
    onOpenDefault: vi.fn(),
    onCopyPath: vi.fn(),
    toAbsolute: (relative: string) => `C:/work/demo/${relative}`,
    hasChange: vi.fn(() => false),
    onViewDiff: vi.fn(),
  });

  async function openMenu(path: string) {
    const treeEl = screen.getByRole("tree", { name: "仓库文件" });
    const row =
      treeEl.querySelector<HTMLElement>(`.file-tree-row[title="${path}"]`) ??
      within(treeEl).getByRole("treeitem", { name: new RegExp(path.split("/").pop()!) });
    await fireEvent.contextMenu(row, { clientX: 60, clientY: 80 });
    return rootMenu();
  }

  it("目录与文件菜单上报右键目标与动作：新建、复制、移动、删除", async () => {
    const onEntryAction = vi.fn();
    render(FileTree, { props: { ...baseProps(), onEntryAction } as never });
    const menu = await openMenu("src/lib/components");
    await pickMenuItem(menu, "新建", "文件…");
    expect(onEntryAction).toHaveBeenLastCalledWith(
      "createFile",
      expect.objectContaining({ path: "src/lib/components", kind: "directory" }),
    );
    await pickMenuItem(await openMenu("src/lib/components"), "新建", "目录…");
    expect(onEntryAction).toHaveBeenLastCalledWith(
      "createDirectory",
      expect.objectContaining({ path: "src/lib/components", kind: "directory" }),
    );
    await fireEvent.click(within(await openMenu("src/lib/components")).getByRole("menuitem", { name: "复制到…" }));
    expect(onEntryAction).toHaveBeenLastCalledWith("copy", expect.objectContaining({ path: "src/lib/components" }));
    await fireEvent.click(within(await openMenu("src/lib/components/Icon.svelte")).getByRole("menuitem", { name: "移动或重命名…" }));
    expect(onEntryAction).toHaveBeenLastCalledWith("move", expect.objectContaining({ path: "src/lib/components/Icon.svelte" }));
    await fireEvent.click(within(await openMenu("src/lib/components/Icon.svelte")).getByRole("menuitem", { name: "删除…" }));
    expect(onEntryAction).toHaveBeenLastCalledWith("delete", expect.objectContaining({ path: "src/lib/components/Icon.svelte" }));
  });

  it("只有一个删除入口：Delete 与右键都是同一个删除动作，不再另设永久删除快捷键", async () => {
    const rows = flattenTree([node("a.ts", "file", null, "a.ts"), node("b.ts", "file", null, "b.ts")]);
    const onEntryAction = vi.fn();
    const onBatchEntry = vi.fn();
    const props = { ...baseProps(), rows, selectedPath: "a.ts", onEntryAction, onBatchEntry };
    const view = render(FileTree, { props: props as never });
    const tree = screen.getByRole("tree", { name: "仓库文件" });
    await fireEvent.keyDown(tree, { key: "Delete" });
    expect(onEntryAction).toHaveBeenLastCalledWith("delete", expect.objectContaining({ path: "a.ts" }));
    // 落点由确认框里的选项决定：加 Shift 不会滑到另一个不可恢复的动作。
    await fireEvent.keyDown(tree, { key: "Delete", shiftKey: true });
    expect(onEntryAction).toHaveBeenLastCalledWith("delete", expect.objectContaining({ path: "a.ts" }));

    await view.rerender({ ...props, selectedPaths: new Set(["a.ts", "b.ts"]) } as never);
    await fireEvent.keyDown(tree, { key: "Delete", shiftKey: true });
    expect(onBatchEntry).toHaveBeenCalledWith("delete", [
      expect.objectContaining({ path: "a.ts" }),
      expect.objectContaining({ path: "b.ts" }),
    ]);
    const menu = await openMenu("a.ts");
    expect(within(menu).queryByRole("menuitem", { name: /永久删除/ })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "删除 2 项…" }).getAttribute("aria-keyshortcuts")).toBe("Delete");
  });

  it("特殊类型、嵌套仓库、已删除文件与忙碌状态灰显并说明原因", async () => {
    const rows = flattenTree([
      node("link.ts", "symlink", null, "link.ts"),
      node("pipe.fifo", "special", null, "pipe.fifo"),
      node("vendor", "nestedRepository", [], "vendor"),
    ]);
    const onEntryAction = vi.fn();
    const props = { ...baseProps(), rows, onEntryAction };
    const view = render(FileTree, { props: props as never });

    const symlinkMenu = await openMenu("link.ts");
    const create = within(symlinkMenu).getByRole("menuitem", { name: "新建" });
    expect(create.getAttribute("aria-disabled")).toBe("true");
    expect(within(symlinkMenu).getByText("符号链接不参与文件操作")).toBeTruthy();
    await fireEvent.click(create);
    expect(onEntryAction).not.toHaveBeenCalled();

    const specialMenu = await openMenu("pipe.fifo");
    expect(within(specialMenu).getByText("特殊文件不参与文件操作")).toBeTruthy();

    const nestedMenu = await openMenu("vendor");
    expect(within(nestedMenu).getByText("嵌套仓库不参与文件操作")).toBeTruthy();
    expect(onEntryAction).not.toHaveBeenCalled();

    // 写入或读取在途：所有结构操作一起灰显，并给出同一条忙碌原因。
    view.unmount();
    render(FileTree, { props: { ...baseProps(), onEntryAction, disabled: true } as never });
    const busyMenu = await openMenu("src/lib/components/Icon.svelte");
    expect(within(busyMenu).getByRole("menuitem", { name: "删除…" }).getAttribute("aria-disabled")).toBe("true");
    expect(busyMenu.textContent).toContain("正在读取或写入");
  });

  it("已删除文件的移入回收站灰显，理由说明文件已不在工作区", async () => {
    const rows = flattenTree(tree());
    const target = rows.find((row) => row.path === "src/lib/components/Button.svelte")!;
    rows[rows.indexOf(target)] = { ...target, deleted: true };
    const onEntryAction = vi.fn();
    render(FileTree, { props: { ...baseProps(), rows, onEntryAction } as never });
    const menu = await openMenu("src/lib/components/Button.svelte");
    const remove = within(menu).getByRole("menuitem", { name: "删除…" });
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByText("文件已从工作区删除，不能在这里操作")).toBeTruthy();
    expect(onEntryAction).not.toHaveBeenCalled();
  });
});

describe("文件视图容器", () => {
  function viewProps(active: boolean, opts: Partial<{ path: string; generation: number }> = {}) {
    const openedRepo = opened(opts.path ?? repoPath, opts.generation ?? 4);
    return {
      active,
      opened: openedRepo,
      disabled: false,
      nextId: () => 1,
      paneWidth: 280,
      windowWidth: 1280,
      onResize: vi.fn(),
      onResizeCommit: vi.fn(),
      onGeneration: vi.fn(),
      onFileHistory: vi.fn(),
      onNav: vi.fn(),
    };
  }

  it("隐藏的视图不读取目录，激活后按当前代次读取根目录", async () => {
    repositoryDirectory.mockResolvedValue(dir("", [{ name: "src", path: "src", kind: "directory", ignored: false, size: null, error: null }]));
    const view = render(RepositoryFiles, { props: viewProps(false) as never });
    await Promise.resolve();
    expect(repositoryDirectory).not.toHaveBeenCalled();
    await view.rerender(viewProps(true));
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());
    expect(repositoryDirectory.mock.calls[0].slice(0, 4)).toEqual([repoPath, "", false, 4]);
    expect(await screen.findByRole("treeitem", { name: /src/ })).toBeTruthy();
  });

  it("Ctrl 多选、Shift 范围、全选、批量复制与 Esc 使用同一份选择", async () => {
    const entry = (path: string) => ({ name: path, path, kind: "file" as const, ignored: false, size: 4, error: null });
    repositoryDirectory.mockResolvedValue(dir("", [entry("a.ts"), entry("b.ts"), entry("c.ts")]));
    repositoryFileContent.mockResolvedValue({ generation: 4, path: "a.ts", kind: "text", size: 4, offset: 0, lines: ["a"], nextOffset: 1, hasMore: false, truncated: false, message: null });
    const onCopyPath = vi.fn();
    render(RepositoryFiles, { props: { ...viewProps(true), onCopyPath } as never });
    const tree = await screen.findByRole("tree", { name: "仓库文件" });
    const a = await within(tree).findByRole("treeitem", { name: "a.ts" });
    const b = within(tree).getByRole("treeitem", { name: "b.ts" });
    const c = within(tree).getByRole("treeitem", { name: "c.ts" });

    expect(document.querySelector(".tree-select")).toBeNull();
    expect(screen.queryByRole("button", { name: "全仓库搜索" })).toBeNull();
    expect(screen.queryByRole("button", { name: "只看有改动的文件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "更多文件树选项" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "过滤文件树" })).toBeTruthy();

    await fireEvent.click(a);
    await fireEvent.click(b, { ctrlKey: true });
    expect(a.getAttribute("aria-selected")).toBe("true");
    expect(b.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(/已选\s*2\s*项/)).toBeTruthy();

    // Ctrl 点击的 b 是范围锚点：Shift 选 c 后保留 b、c，不残留隐藏的旧范围。
    await fireEvent.click(c, { shiftKey: true });
    expect(a.getAttribute("aria-selected")).toBe("false");
    expect(b.getAttribute("aria-selected")).toBe("true");
    expect(c.getAttribute("aria-selected")).toBe("true");

    await fireEvent.keyDown(tree, { key: "a", ctrlKey: true });
    expect(screen.getByText(/已选\s*3\s*项/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "复制路径" }));
    expect(onCopyPath).toHaveBeenLastCalledWith("a.ts\nb.ts\nc.ts", "3 个相对路径");

    await fireEvent.contextMenu(b);
    expect(screen.getByText("已选 3 项", { selector: ".menu-label" })).toBeTruthy();
    await pickMenuItem(rootMenu(), "路径", "复制完整路径");
    expect(onCopyPath).toHaveBeenLastCalledWith("a.ts\nb.ts\nc.ts", "3 个完整路径");

    await fireEvent.keyDown(tree, { key: "Escape" });
    expect(screen.queryByText("已选 3 项")).toBeNull();
    expect(c.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".tree-select")).toBeNull();
    expect(screen.queryByRole("button", { name: "全仓库搜索" })).toBeNull();
    expect(screen.queryByRole("button", { name: /名称(升序|降序)/ })).toBeNull();

    await fireEvent.keyDown(tree, { key: "Home" });
    await fireEvent.keyDown(tree, { key: "End", shiftKey: true });
    expect(screen.getByText(/已选\s*3\s*项/)).toBeTruthy();
    expect(a.getAttribute("aria-selected")).toBe("true");
    expect(c.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".tree-select")).toBeNull();
  });

  it("同时选中目录和子路径时，删除确认清单只有该目录", async () => {
    const entry = (path: string, kind: "file" | "directory" = "file") => ({
      name: path.split("/").pop() ?? path,
      path,
      kind,
      ignored: false,
      size: kind === "file" ? 4 : null,
      error: null,
    });
    repositoryDirectory.mockImplementation((_repo: string, relative: string) => {
      if (relative === "") return Promise.resolve(dir("", [entry("src", "directory"), entry("note.txt")]));
      if (relative === "src") return Promise.resolve(dir("src", [entry("src/a.ts")]));
      return Promise.resolve(dir(relative, []));
    });
    repositoryFileContent.mockResolvedValue({
      generation: 4,
      path: "src/a.ts",
      kind: "text",
      size: 4,
      offset: 0,
      lines: ["a"],
      nextOffset: 1,
      hasMore: false,
      truncated: false,
      message: null,
    });
    render(RepositoryFiles, { props: { ...viewProps(true), onEntry: vi.fn(async () => ({ ok: false, message: "" })) } as never });
    const tree = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(await within(tree).findByRole("button", { name: "展开 src" }));
    await within(tree).findByRole("treeitem", { name: "src/a.ts" });
    await fireEvent.click(within(tree).getByRole("treeitem", { name: "src" }), { ctrlKey: true });
    await fireEvent.click(within(tree).getByRole("treeitem", { name: "src/a.ts" }), { ctrlKey: true });
    expect(screen.getByText(/已选\s*2\s*项/)).toBeTruthy();
    expect(document.querySelector(".tree-select")).toBeNull();
    await fireEvent.contextMenu(within(tree).getByRole("treeitem", { name: "src" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("已选 1 项", { selector: ".menu-label" })).toBeTruthy();
    expect(menu.getAttribute("aria-label")).toBe("已选 1 项的操作");
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "删除 1 项…" }));
    const dialog = await screen.findByRole("dialog", { name: "删除" });
    expect(dialog.textContent).toContain("src");
    expect(dialog.textContent).not.toContain("src/a.ts");
  });

  it("文件与祖先目录显示当前 StatusSnapshot 的 Git 装饰", async () => {
    const repo = opened();
    repo.snapshot.files = [
      { path: "src/lib/app.ts", originalPath: null, staged: "none", unstaged: "modified", untracked: false, unmerged: false },
      { path: "src/main.rs", originalPath: null, staged: "none", unstaged: "deleted", untracked: false, unmerged: false },
      { path: "notes.txt", originalPath: null, staged: "none", unstaged: "none", untracked: true, unmerged: false },
    ];
    repositoryDirectory.mockResolvedValue(
      dir("", [
        { name: "src", path: "src", kind: "directory", ignored: false, size: null, error: null },
        { name: "notes.txt", path: "notes.txt", kind: "file", ignored: false, size: 3, error: null },
        { name: "README.md", path: "README.md", kind: "file", ignored: false, size: 9, error: null },
      ]),
    );
    render(RepositoryFiles, { props: { ...viewProps(true), opened: repo } as never });
    const tree = await screen.findByRole("tree", { name: "仓库文件" });

    await waitFor(() => expect(tree.querySelector('.file-tree-row[title="src"]')).toBeTruthy());
    // 文件行用与改动列表同一套状态字母与颜色。
    const notes = tree.querySelector<HTMLElement>('.file-tree-row[title="notes.txt"]')!;
    expect(within(notes).getByLabelText("未跟踪")).toBeTruthy();
    // 祖先目录聚合后代改动，并说明有多少个改动文件。
    const src = tree.querySelector<HTMLElement>('.file-tree-row[title="src"]')!;
    expect(within(src).getByLabelText("删除，目录下 2 个改动文件")).toBeTruthy();
    // 没有改动的文件不伪造装饰。
    const readme = tree.querySelector<HTMLElement>('.file-tree-row[title="README.md"]')!;
    expect(readme.querySelector(".st")).toBeNull();
  });

  it("仅改动树沿用删除墓碑并显示状态装饰，不读取目录", async () => {
    const repo = opened();
    repo.snapshot.files = [
      { path: "src/gone.rs", originalPath: null, staged: "none", unstaged: "deleted", untracked: false, unmerged: false },
      { path: "src/kept.rs", originalPath: null, staged: "modified", unstaged: "modified", untracked: false, unmerged: false },
    ];
    repositoryDirectory.mockResolvedValue(dir("", [
      { name: "src", path: "src", kind: "directory", ignored: false, size: null, error: null },
    ]));
    render(RepositoryFiles, { props: { ...viewProps(true), opened: repo } as never });
    const tree = await screen.findByRole("tree", { name: "仓库文件" });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalledTimes(1));
    await fireEvent.contextMenu(await within(tree).findByRole("treeitem", { name: "src" }));
    await pickMenuItem(await screen.findByRole("menu", { name: /的操作$/ }), "文件树", "只看有改动的文件");
    expect(await screen.findByText("正在只看有改动的文件")).toBeTruthy();
    const kept = await screen.findByRole("treeitem", { name: /kept\.rs/ });
    expect(within(kept).getByLabelText("修改")).toBeTruthy();
    const gone = await screen.findByRole("treeitem", { name: /gone\.rs/ });
    expect(within(gone).getByText("已删除")).toBeTruthy();
    // 仅改动树由快照派生，切换后不再读取目录。
    expect(repositoryDirectory).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: "显示全部" }));
    await waitFor(() => expect(screen.queryByText("正在只看有改动的文件")).toBeNull());
    expect(screen.queryByRole("button", { name: "全仓库搜索" })).toBeNull();
    expect(document.querySelector(".tree-select")).toBeNull();
    expect(repositoryDirectory).toHaveBeenCalledTimes(1);
  });

  it("切换仓库清空旧树与选择，旧响应不再显示", async () => {
    let finishOld!: (value: RepositoryDirectory) => void;
    repositoryDirectory.mockImplementationOnce(() => new Promise<RepositoryDirectory>((resolve) => (finishOld = resolve)));
    const view = render(RepositoryFiles, { props: viewProps(true) as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalledTimes(1));

    repositoryDirectory.mockResolvedValue(dir("", [{ name: "other.ts", path: "other.ts", kind: "file", ignored: false, size: 3, error: null }], 9));
    await view.rerender(viewProps(true, { path: "C:/work/other", generation: 9 }));
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalledTimes(2));
    expect(repositoryDirectory.mock.calls[1].slice(0, 4)).toEqual(["C:/work/other", "", false, 9]);
    expect(await screen.findByRole("treeitem", { name: /other\.ts/ })).toBeTruthy();

    finishOld(dir("", [{ name: "stale.ts", path: "stale.ts", kind: "file", ignored: false, size: 1, error: null }], 4));
    await Promise.resolve();
    expect(screen.queryByText("stale.ts")).toBeNull();
  });

  it("显示忽略文件时请求带 includeIgnored，读取失败就地显示原因", async () => {
    repositoryDirectory.mockResolvedValueOnce(dir("", [
      { name: "build", path: "build", kind: "directory", ignored: true, size: null, error: null },
      { name: "src", path: "src", kind: "directory", ignored: false, size: null, error: null },
    ], 5));
    render(RepositoryFiles, { props: viewProps(true, { generation: 5 }) as never });
    const treeEl = await screen.findByRole("tree", { name: "仓库文件" });
    const ignoredRow = await within(treeEl).findByRole("treeitem", { name: /build/ });
    expect(within(ignoredRow).getByText("忽略")).toBeTruthy();

    repositoryDirectory.mockResolvedValue(dir("", [], 5));
    await fireEvent.contextMenu(within(treeEl).getByRole("treeitem", { name: "src" }));
    const ignoredToggle = within(await openSubmenu(await screen.findByRole("menu", { name: /的操作$/ }), "文件树")).getByRole("menuitemcheckbox", { name: "显示忽略的文件" });
    expect(ignoredToggle.getAttribute("aria-checked")).toBe("false");
    await fireEvent.click(ignoredToggle);
    await waitFor(() => expect(repositoryDirectory).toHaveBeenLastCalledWith(repoPath, "", true, 5, expect.any(Number)));

    repositoryDirectory.mockRejectedValue({ code: "path_unreadable", message: "无法读取这个目录。" });
    const view = render(RepositoryFiles, { props: viewProps(true, { generation: 6 }) as never });
    await waitFor(() => expect(screen.getAllByText("无法读取这个目录。").length).toBeGreaterThan(0));
    view.unmount();
  });

  it("隐藏期间代次前进：重新激活重验已展开目录，删掉的项消失、新增的项出现", async () => {
    const entry = (path: string, kind: "file" | "directory" = "file") => ({
      name: path.split("/").pop() ?? path,
      path,
      kind,
      ignored: false,
      size: kind === "file" ? 4 : null,
      error: null,
    });
    repositoryDirectory.mockImplementation((_repo: string, relative: string, _ignored: boolean, generation: number) => {
      if (relative === "") {
        return Promise.resolve(dir("", [entry("src", "directory"), entry("README.md")], generation));
      }
      if (relative === "src") {
        return Promise.resolve(
          dir("src", generation >= 7 ? [entry("src/app.ts"), entry("src/added.ts")] : [entry("src/app.ts"), entry("src/old.ts")], generation),
        );
      }
      return Promise.resolve(dir(relative, [], generation));
    });

    const view = render(RepositoryFiles, { props: viewProps(true, { generation: 4 }) as never });
    const treeEl = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(await within(treeEl).findByRole("button", { name: "展开 src" }));
    await waitFor(() => expect(screen.getByText("old.ts")).toBeTruthy());

    // 隐藏时只记隐藏瞬间的代次；隐藏期间代次前进必须留到激活时重验，不能被吸收。
    await view.rerender(viewProps(false, { generation: 4 }) as never);
    await view.rerender(viewProps(false, { generation: 7 }) as never);
    repositoryDirectory.mockClear();

    await view.rerender(viewProps(true, { generation: 7 }) as never);
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());
    const asked = repositoryDirectory.mock.calls.map((call) => call[1]);
    expect(asked).toContain("");
    expect(asked).toContain("src");
    expect(repositoryDirectory.mock.calls.every((call) => call[3] === 7)).toBe(true);
    await waitFor(() => expect(screen.queryByText("old.ts")).toBeNull());
    expect(screen.getByText("added.ts")).toBeTruthy();
    expect(screen.getByText("app.ts")).toBeTruthy();
  });

  it("隐藏期间到达的旧代次根目录响应不写入，回到视图后仍能读取", async () => {
    let finishRoot!: (value: RepositoryDirectory) => void;
    repositoryDirectory.mockImplementationOnce(() => new Promise<RepositoryDirectory>((resolve) => (finishRoot = resolve)));
    const view = render(RepositoryFiles, { props: viewProps(true, { generation: 4 }) as never });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalledTimes(1));

    // 根目录读取还在飞行中切走，隐藏期间代次前进。
    await view.rerender(viewProps(false, { generation: 4 }) as never);
    await view.rerender(viewProps(false, { generation: 7 }) as never);

    repositoryDirectory.mockResolvedValue(
      dir("", [{ name: "later.ts", path: "later.ts", kind: "file", ignored: false, size: 2, error: null }], 7),
    );
    // 旧代次响应这时才回来：隐藏视图不接纳，也不能把 loading 留在飞行状态。
    finishRoot(dir("", [{ name: "stale.ts", path: "stale.ts", kind: "file", ignored: false, size: 1, error: null }], 4));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("stale.ts")).toBeNull();

    await view.rerender(viewProps(true, { generation: 7 }) as never);
    await waitFor(() => expect(screen.getByText("later.ts")).toBeTruthy());
    expect(screen.queryByText("stale.ts")).toBeNull();
    expect(repositoryDirectory).toHaveBeenLastCalledWith(repoPath, "", false, 7, expect.any(Number));
    // 刷新入口没有被残留的 loading 锁死。
    await fireEvent.contextMenu(screen.getByRole("treeitem", { name: "later.ts" }));
    const refresh = within(await openSubmenu(await screen.findByRole("menu", { name: /的操作$/ }), "文件树")).getByRole("menuitem", { name: "重新读取目录" });
    expect(refresh.getAttribute("aria-disabled")).toBeNull();
  });
});

describe("名称排序", () => {
  function mixedTree(): FileNode[] {
    const deep = node("src", "directory", [
      node("src/b.ts", "file", null, "b.ts"),
      node("src/a10.ts", "file", null, "a10.ts"),
      node("src/a2.ts", "file", null, "a2.ts"),
    ]);
    deep.expanded = true;
    return [
      node("b.txt", "file", null, "b.txt"),
      node("a10.txt", "file", null, "a10.txt"),
      node("a2.txt", "file", null, "a2.txt"),
      deep,
      node("vendor", "nestedRepository", [], "vendor"),
    ];
  }

  it("目录与嵌套仓库始终在前，名称按自然顺序比较（a2 在 a10 之前）", () => {
    const names = (direction: "asc" | "desc") => sortTree(mixedTree(), direction).map((item) => item.name);
    expect(names("asc")).toEqual(["src", "vendor", "a2.txt", "a10.txt", "b.txt"]);
    // 降序只反转同一组里的名称，目录组不会排到文件后面。
    expect(names("desc")).toEqual(["vendor", "src", "b.txt", "a10.txt", "a2.txt"]);
  });

  it("子目录里的名称按同一规则逐个排序", () => {
    const src = sortTree(mixedTree(), "asc").find((item) => item.name === "src")!;
    expect(src.children?.map((item) => item.name)).toEqual(["a2.ts", "a10.ts", "b.ts"]);
    const desc = sortTree(mixedTree(), "desc").find((item) => item.name === "src")!;
    expect(desc.children?.map((item) => item.name)).toEqual(["b.ts", "a10.ts", "a2.ts"]);
  });

  it("仅改动树用同一个方向重建，过滤结果也沿用同一份顺序", () => {
    const changes: FileChange[] = [
      { path: "src/b.ts", originalPath: null, staged: "none", unstaged: "modified", untracked: false, unmerged: false },
      { path: "src/a10.ts", originalPath: null, staged: "none", unstaged: "modified", untracked: false, unmerged: false },
      { path: "src/a2.ts", originalPath: null, staged: "none", unstaged: "modified", untracked: false, unmerged: false },
      { path: "README.md", originalPath: null, staged: "none", unstaged: "modified", untracked: false, unmerged: false },
    ];
    const names = (direction: "asc" | "desc") => buildChangedTree(changes, undefined, false, direction).map((item) => item.name);
    expect(names("asc")).toEqual(["src", "README.md"]);
    // 方向只影响同一组里的名称：目录仍排在文件前面。
    expect(names("desc")).toEqual(["src", "README.md"]);
    const children = (direction: "asc" | "desc") =>
      buildChangedTree(changes, undefined, false, direction).find((item) => item.name === "src")?.children?.map((item) => item.name);
    expect(children("asc")).toEqual(["a2.ts", "a10.ts", "b.ts"]);
    expect(children("desc")).toEqual(["b.ts", "a10.ts", "a2.ts"]);

    // 过滤只筛选已排序的行，不重新排序。
    const rows = flattenTree(buildChangedTree(changes, undefined, false, "desc"));
    expect(filterRows(rows, ".ts").map((row) => row.path)).toEqual(["src", "src/b.ts", "src/a10.ts", "src/a2.ts"]);
  });

  it("切换升降序保留选择，Shift 范围按当前显示顺序计算", async () => {
    const entry = (path: string) => ({ name: path, path, kind: "file" as const, ignored: false, size: 4, error: null });
    repositoryDirectory.mockResolvedValue(dir("", [entry("b.txt"), entry("a10.txt"), entry("a2.txt")]));
    repositoryFileContent.mockResolvedValue({
      generation: 4, path: "a2.txt", kind: "text", size: 4, offset: 0, lines: ["a"], nextOffset: 1, hasMore: false, truncated: false, message: null,
    });
    const props = () => ({
      active: true,
      opened: opened(),
      disabled: false,
      nextId: () => 1,
      paneWidth: 280,
      windowWidth: 1280,
      onResize: vi.fn(),
      onResizeCommit: vi.fn(),
      onGeneration: vi.fn(),
      onFileHistory: vi.fn(),
      onNav: vi.fn(),
    });
    render(RepositoryFiles, { props: props() as never });
    const tree = await screen.findByRole("tree", { name: "仓库文件" });
    const paths = () =>
      [...tree.querySelectorAll<HTMLElement>(".file-tree-row")].map((row) => row.getAttribute("title"));
    await waitFor(() => expect(paths()).toEqual(["a2.txt", "a10.txt", "b.txt"]));

    const a2 = within(tree).getByRole("treeitem", { name: "a2.txt" });
    await fireEvent.click(a2);
    expect(a2.getAttribute("aria-selected")).toBe("true");

    await fireEvent.contextMenu(a2);
    const ascending = within(await openTreeSubmenu(rootMenu())).getByRole("menuitemcheckbox", { name: "名称降序" });
    expect(ascending.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector(".file-tree-status")?.textContent ?? "").not.toMatch(/升序|降序/);
    await fireEvent.click(ascending);
    await waitFor(() => expect(paths()).toEqual(["b.txt", "a10.txt", "a2.txt"]));
    // 选择按路径保留，不跟着行号走。降序只在右键菜单标明，不另起说明行，也不回到常驻按钮。
    expect(within(tree).getByRole("treeitem", { name: "a2.txt" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".file-tree-status")).toBeNull();
    expect(screen.queryByRole("button", { name: "名称降序" })).toBeNull();
    await fireEvent.contextMenu(within(tree).getByRole("treeitem", { name: "a2.txt" }));
    const descending = within(await openTreeSubmenu(rootMenu())).getByRole("menuitemcheckbox", { name: "名称降序" });
    expect(descending.getAttribute("aria-checked")).toBe("true");
    await fireEvent.keyDown(descending, { key: "Tab" });

    // Shift 范围按当前显示顺序：从第一行到尾行覆盖三行。
    await fireEvent.click(within(tree).getByRole("treeitem", { name: "b.txt" }));
    await fireEvent.click(within(tree).getByRole("treeitem", { name: "a2.txt" }), { shiftKey: true });
    expect(screen.getByText(/已选\s*3\s*项/)).toBeTruthy();
  });

  it("重新读取目录会刷新合并单链下已展开的子目录并触发仓库刷新回调", async () => {
    const item = (p: string, kind: "directory" | "file") => ({
      name: p.split("/").pop() ?? p,
      path: p,
      kind,
      ignored: false,
      size: kind === "file" ? 4 : null,
      error: null,
    });
    let added = false;
    repositoryDirectory.mockImplementation(async (_repo: string, target: string) => {
      if (target === "") return dir("", [item("docs", "directory"), item("README.md", "file")]);
      if (target === "docs") return dir("docs", [item("docs/run", "directory")]);
      if (target === "docs/run") {
        return dir(
          "docs/run",
          added ? [item("docs/run/T1.md", "file"), item("docs/run/T2.md", "file")] : [item("docs/run/T1.md", "file")],
        );
      }
      return dir(target, []);
    });
    const onRefreshRepo = vi.fn();
    render(RepositoryFiles, {
      props: {
        active: true,
        opened: opened(),
        disabled: false,
        nextId: () => 1,
        paneWidth: 280,
        windowWidth: 1280,
        onResize: vi.fn(),
        onResizeCommit: vi.fn(),
        onGeneration: vi.fn(),
        onFileHistory: vi.fn(),
        onNav: vi.fn(),
        onRefreshRepo,
      } as never,
    });
    const tree = await screen.findByRole("tree", { name: "仓库文件" });
    await waitFor(() => expect(within(tree).getByRole("treeitem", { name: "docs" })).toBeTruthy());
    await fireEvent.click(within(tree).getByRole("treeitem", { name: "docs" }));
    // docs 与唯一子目录 run 合并成单链 docs/run；点击展开末级目录
    await waitFor(() => expect(within(tree).getByRole("treeitem", { name: "docs/run" })).toBeTruthy());
    await fireEvent.click(within(tree).getByRole("treeitem", { name: "docs/run" }));
    await waitFor(() => expect(within(tree).getByRole("treeitem", { name: "docs/run/T1.md" })).toBeTruthy());

    // 即使当前选中项不在该合并单链里，重新读取目录也必须刷新 docs/run 并发现新增文件
    await fireEvent.click(within(tree).getByRole("treeitem", { name: "README.md" }));
    added = true;
    await fireEvent.contextMenu(within(tree).getByRole("treeitem", { name: "docs/run/T1.md" }));
    await fireEvent.click(within(await openTreeSubmenu(rootMenu())).getByRole("menuitem", { name: "重新读取目录" }));

    await waitFor(() => expect(within(tree).getByRole("treeitem", { name: "docs/run/T2.md" })).toBeTruthy());
    expect(onRefreshRepo).toHaveBeenCalledTimes(1);
  });
});
