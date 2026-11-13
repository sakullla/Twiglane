import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chainOf, FILE_ROW_HEIGHT, filterRows, flattenTree, buildChangedTree, makeNode, type FileNode } from "../src/lib/files.svelte";
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
    const first = within(treeEl).getByRole("treeitem", { name: /src\/lib\/components/ });
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
    return screen.getByRole("menu");
  }

  function labels(menu: HTMLElement): string[] {
    return within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim() ?? "");
  }

  it("目录菜单分组：展开/折叠、系统打开该目录、三种路径复制；右键目录不改变展开态", async () => {
    const props = baseProps();
    render(FileTree, { props: props as never });
    const menu = await openMenu("src/lib/components");
    const names = labels(menu);
    for (const label of ["折叠", "在系统文件管理器中打开该目录", "复制相对路径", "复制完整路径", "复制目录名"]) {
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
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /插入路径到终端/ }));
    expect(onInsertToTerminal).toHaveBeenCalledWith(["src/lib/components/Button.svelte"]);
    menu = await openMenu("src/lib/components");
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /插入路径到终端/ }));
    expect(onInsertToTerminal).toHaveBeenLastCalledWith(["src/lib/components"]);
    view.unmount();
    render(FileTree, { props: baseProps() as never });
    menu = await openMenu("src/lib/components/Button.svelte");
    expect(labels(menu).some((text) => text.includes("终端"))).toBe(false);
  });

  it("文件菜单分组：打开、文件历史、系统定位、用默认程序打开、三种路径复制", async () => {
    render(FileTree, { props: baseProps() as never });
    const menu = await openMenu("src/lib/components/Button.svelte");
    const names = labels(menu);
    for (const label of ["打开", "查看文件历史", "用默认程序打开", "复制相对路径", "复制完整路径", "复制文件名"]) {
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
    expect(within(menu).getByRole("menuitem", { name: "复制相对路径" })).toBeTruthy();
  });

  it("复制相对/完整/文件名分别得到对应文本，不再静默吞错", async () => {
    const props = baseProps();
    render(FileTree, { props: props as never });
    await fireEvent.click(within(await openMenu("src/lib/components/Button.svelte")).getByRole("menuitem", { name: "复制相对路径" }));
    expect(props.onCopyPath).toHaveBeenLastCalledWith("src/lib/components/Button.svelte", "相对路径");
    await fireEvent.click(within(await openMenu("src/lib/components/Button.svelte")).getByRole("menuitem", { name: "复制完整路径" }));
    expect(props.onCopyPath).toHaveBeenLastCalledWith("C:/work/demo/src\\lib\\components\\Button.svelte", "完整路径");
    await fireEvent.click(within(await openMenu("src/lib/components/Button.svelte")).getByRole("menuitem", { name: "复制文件名" }));
    expect(props.onCopyPath).toHaveBeenLastCalledWith("Button.svelte", "文件名");
  });

  it("目录复制目录名取末段，系统打开该目录经回调", async () => {
    const props = baseProps();
    render(FileTree, { props: props as never });
    const menu = await openMenu("src/lib/components");
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "在系统文件管理器中打开该目录" }));
    expect(props.onReveal).toHaveBeenCalledWith("src/lib/components");
    await fireEvent.click(within(await openMenu("src/lib/components")).getByRole("menuitem", { name: "复制目录名" }));
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
    await fireEvent.click(within(await openMenu("src/lib/components/Button.svelte")).getByRole("menuitem", { name: "复制相对路径" }));
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
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "复制相对路径" }));
    expect(props.onCopyPath).toHaveBeenLastCalledWith("src/lib/components/Button.svelte", "相对路径");
  });

  it("条目较多的文件菜单在自身区域滚动，末尾条目仍可到达", async () => {
    const props = { ...baseProps(), hasChange: vi.fn(() => true) };
    render(FileTree, { props: props as never });
    const menu = await openMenu("src/lib/components/Button.svelte");
    // .context-menu 固定定位并带 max-height + overflow，超长菜单在自身滚动而不是撑爆视口。
    expect(menu.classList.contains("context-menu")).toBe(true);
    // 末尾分组的条目（复制文件名）仍然渲染、可被键盘与指针到达。
    const last = within(menu).getByRole("menuitem", { name: "复制文件名" });
    expect(last).toBeTruthy();
    await fireEvent.click(last);
    expect(props.onCopyPath).toHaveBeenLastCalledWith("Button.svelte", "文件名");
  });

  it("右键菜单不含任何文件写入、Git 写入或编辑器入口（R8/R9 边界）", async () => {
    render(FileTree, { props: { ...baseProps(), hasChange: vi.fn(() => true) } as never });
    const fileMenu = labels(await openMenu("src/lib/components/Button.svelte")).join(" ");
    await fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    const dirMenu = labels(await openMenu("src/lib/components")).join(" ");
    for (const forbidden of ["暂存", "提交", "放弃", "删除", "重命名", "新建", "移动", "保存", ".gitignore", "忽略", "加入"]) {
      expect(fileMenu.includes(forbidden), `文件菜单不应含「${forbidden}」`).toBe(false);
      expect(dirMenu.includes(forbidden), `目录菜单不应含「${forbidden}」`).toBe(false);
    }
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

    await fireEvent.click(a);
    await fireEvent.click(b, { ctrlKey: true });
    expect(a.getAttribute("aria-selected")).toBe("true");
    expect(b.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("已选 2 项")).toBeTruthy();

    // Ctrl 点击的 b 是范围锚点：Shift 选 c 后保留 b、c，不残留隐藏的旧范围。
    await fireEvent.click(c, { shiftKey: true });
    expect(a.getAttribute("aria-selected")).toBe("false");
    expect(b.getAttribute("aria-selected")).toBe("true");
    expect(c.getAttribute("aria-selected")).toBe("true");

    await fireEvent.keyDown(tree, { key: "a", ctrlKey: true });
    expect(screen.getByText("已选 3 项")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "复制路径" }));
    expect(onCopyPath).toHaveBeenLastCalledWith("a.ts\nb.ts\nc.ts", "3 个相对路径");

    await fireEvent.contextMenu(b);
    expect(screen.getByText("已选 3 项", { selector: ".menu-label" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("menuitem", { name: "复制所选完整路径" }));
    expect(onCopyPath).toHaveBeenLastCalledWith("a.ts\nb.ts\nc.ts", "3 个完整路径");

    await fireEvent.keyDown(tree, { key: "Escape" });
    expect(screen.queryByText("已选 3 项")).toBeNull();
    expect(c.getAttribute("aria-selected")).toBe("true");

    await fireEvent.keyDown(tree, { key: "Home" });
    await fireEvent.keyDown(tree, { key: "End", shiftKey: true });
    expect(screen.getByText("已选 3 项")).toBeTruthy();
    expect(a.getAttribute("aria-selected")).toBe("true");
    expect(c.getAttribute("aria-selected")).toBe("true");
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
    repositoryDirectory.mockResolvedValue(dir("", []));
    render(RepositoryFiles, { props: { ...viewProps(true), opened: repo } as never });
    await screen.findByRole("tree", { name: "仓库文件" });
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalledTimes(1));
    // 「只看有改动的文件」在树上方的工具条里，不在树内部。
    await fireEvent.click(screen.getByRole("button", { name: "只看有改动的文件" }));
    const kept = await screen.findByRole("treeitem", { name: /kept\.rs/ });
    expect(within(kept).getByLabelText("修改")).toBeTruthy();
    const gone = await screen.findByRole("treeitem", { name: /gone\.rs/ });
    expect(within(gone).getByText("已删除")).toBeTruthy();
    // 仅改动树由快照派生，切换后不再读取目录。
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
    await fireEvent.click(screen.getByRole("button", { name: "更多文件树选项" }));
    const ignoredToggle = await screen.findByRole("menuitemcheckbox", { name: "显示忽略的文件" });
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
    await fireEvent.click(screen.getByRole("button", { name: "更多文件树选项" }));
    const refresh = await screen.findByRole("menuitem", { name: "重新读取目录" });
    expect(refresh.getAttribute("aria-disabled")).toBeNull();
  });
});
