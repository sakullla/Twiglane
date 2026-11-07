import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryDirectory = vi.hoisted(() => vi.fn());
const repositoryFileContent = vi.hoisted(() => vi.fn());
const repositoryPathSearch = vi.hoisted(() => vi.fn());
const repositoryContentSearch = vi.hoisted(() => vi.fn());
const filePreview = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/api", () => ({
  api: { repositoryDirectory, repositoryFileContent, repositoryPathSearch, repositoryContentSearch, filePreview },
}));

import RepositoryFiles from "../src/lib/components/RepositoryFiles.svelte";
import type { FileChange, OpenedRepository, RepositoryDirectory } from "../src/lib/types";

const repoPath = "C:/work/demo";

function opened(files: FileChange[] = [], generation = 4, path = repoPath): OpenedRepository {
  return {
    summary: { name: path.split("/").pop() ?? path, path },
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
      files,
    },
    draft: "",
    watchDegraded: false,
  };
}

function change(path: string, staged: FileChange["staged"], unstaged: FileChange["unstaged"]): FileChange {
  return { path, originalPath: null, staged, unstaged, untracked: false, unmerged: false };
}

function entry(path: string, kind: "file" | "directory" = "file") {
  return { name: path.split("/").pop() ?? path, path, kind, ignored: false, size: kind === "file" ? 8 : null, error: null };
}

function dir(relative: string, entries: ReturnType<typeof entry>[], generation = 4): RepositoryDirectory {
  return { generation, path: relative, entries, errors: [] };
}

function page(path: string, offset: number, generation = 4) {
  return {
    generation,
    path,
    kind: "text" as const,
    size: 30,
    offset,
    lines: [`line-${offset + 1}`],
    nextOffset: offset + 1,
    hasMore: false,
    truncated: false,
    message: null,
  };
}

function viewProps(overrides: Record<string, unknown> = {}) {
  return {
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
    onOpenDiff: vi.fn(),
    onNav: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  repositoryDirectory.mockReset();
  repositoryFileContent.mockReset();
  repositoryPathSearch.mockReset();
  repositoryContentSearch.mockReset();
  filePreview.mockReset();
  repositoryFileContent.mockImplementation((_repo: string, path: string, offset: number, _limit: number | undefined, generation: number) =>
    Promise.resolve(page(path, offset, generation)),
  );
});

describe("改动与文件的双向导航", () => {
  it("仅改动树从当前状态派生：删除的文件是墓碑，不读取当前内容", async () => {
    repositoryDirectory.mockResolvedValue(dir("", [entry("src", "directory")]));
    const onFileHistory = vi.fn();
    render(
      RepositoryFiles,
      {
        props: viewProps({
          opened: opened([change("src/app.ts", "none", "modified"), change("docs/gone.md", "none", "deleted")]),
          onFileHistory,
        }) as never,
      },
    );
    await waitFor(() => expect(repositoryDirectory).toHaveBeenCalled());
    repositoryDirectory.mockClear();

    await fireEvent.click(screen.getByRole("button", { name: "只看有改动的文件" }));
    const treeEl = await screen.findByRole("tree", { name: "仓库文件" });
    const gone = await within(treeEl).findByRole("treeitem", { name: /gone\.md/ });
    expect(gone.textContent).toContain("已删除");
    expect(within(treeEl).getByRole("treeitem", { name: /app\.ts/ })).toBeTruthy();
    // 行来自 StatusSnapshot，切换仅改动不读目录。
    expect(repositoryDirectory).not.toHaveBeenCalled();

    await fireEvent.click(gone);
    expect(await screen.findByText("文件已删除")).toBeTruthy();
    expect(repositoryFileContent).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "查看文件历史" }));
    expect(onFileHistory).toHaveBeenCalledWith("docs/gone.md");
  });

  it("文件可以进入它自己的未暂存 / 已暂存改动", async () => {
    repositoryDirectory.mockResolvedValue(dir("", [entry("src/app.ts")]));
    const onOpenDiff = vi.fn();
    render(
      RepositoryFiles,
      {
        props: viewProps({
          opened: opened([change("src/app.ts", "modified", "modified")]),
          onOpenDiff,
        }) as never,
      },
    );
    const treeEl = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(await within(treeEl).findByRole("treeitem", { name: /app\.ts/ }));
    await waitFor(() => expect(repositoryFileContent).toHaveBeenCalled());

    await fireEvent.click(screen.getByRole("button", { name: "查看未暂存的改动" }));
    expect(onOpenDiff).toHaveBeenLastCalledWith("src/app.ts", "unstaged");
    await fireEvent.click(screen.getByRole("button", { name: "查看已暂存的改动" }));
    expect(onOpenDiff).toHaveBeenLastCalledWith("src/app.ts", "staged");
  });

  it("后退与前进按本次会话的路径工作，并给出到头原因", async () => {
    repositoryDirectory.mockResolvedValue(
      dir("", [entry("src/a.ts"), entry("src/b.ts"), entry("src/c.ts")]),
    );
    const onNav = vi.fn();
    const props = viewProps({ onNav });
    const view = render(RepositoryFiles, { props: props as never });
    const treeEl = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(await within(treeEl).findByRole("treeitem", { name: /a\.ts/ }));
    await waitFor(() => expect(repositoryFileContent).toHaveBeenLastCalledWith(repoPath, "src/a.ts", 0, undefined, 4, expect.any(Number)));
    await fireEvent.click(within(treeEl).getByRole("treeitem", { name: /b\.ts/ }));
    await waitFor(() => expect(repositoryFileContent).toHaveBeenLastCalledWith(repoPath, "src/b.ts", 0, undefined, 4, expect.any(Number)));

    const nav = () => onNav.mock.calls.at(-1)?.[0];
    expect(nav().history.backReason).toBeNull();
    expect(nav().history.forwardReason).toBe("已经是最新打开的文件");

    nav().history.onBack();
    await waitFor(() => expect(repositoryFileContent).toHaveBeenLastCalledWith(repoPath, "src/a.ts", 0, undefined, 4, expect.any(Number)));
    await waitFor(() => expect(nav().history.backReason).toBe("已经是本次会话的第一个文件"));
    expect(nav().history.forwardReason).toBeNull();
    expect(within(screen.getByRole("tree", { name: "仓库文件" })).getByRole("treeitem", { name: /a\.ts/ }).getAttribute("aria-selected")).toBe("true");

    nav().history.onForward();
    await waitFor(() => expect(repositoryFileContent).toHaveBeenLastCalledWith(repoPath, "src/b.ts", 0, undefined, 4, expect.any(Number)));

    // 最近打开按路径记录，可以在里面直接回到先前文件。
    expect(nav().history.recent.map((visit: { path: string }) => visit.path)).toEqual(["src/a.ts", "src/b.ts"]);
    await view.rerender(props as never);
  });

  it("同一代次隐藏再显示：选择、已读内容与滚动位置都保留，不重复读取", async () => {
    repositoryDirectory.mockResolvedValue(dir("", [entry("src/a.ts"), entry("src/b.ts")]));
    const props = viewProps();
    const view = render(RepositoryFiles, { props: props as never });
    const treeEl = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(await within(treeEl).findByRole("treeitem", { name: /a\.ts/ }));
    await waitFor(() => expect(repositoryFileContent).toHaveBeenCalledTimes(1));
    repositoryDirectory.mockClear();

    await view.rerender({ ...props, active: false } as never);
    await view.rerender({ ...props, active: true } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(repositoryFileContent).toHaveBeenCalledTimes(1);
    expect(repositoryDirectory).not.toHaveBeenCalled();
    const tree = screen.getByRole("tree", { name: "仓库文件" });
    expect(within(tree).getByRole("treeitem", { name: /a\.ts/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("切换仓库后不回退到旧选择，打开历史与搜索一起清空", async () => {
    repositoryDirectory.mockResolvedValue(dir("", [entry("src/a.ts")]));
    const onNav = vi.fn();
    const props = viewProps({ onNav });
    const view = render(RepositoryFiles, { props: props as never });
    const treeEl = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(await within(treeEl).findByRole("treeitem", { name: /a\.ts/ }));
    await waitFor(() => expect(repositoryFileContent).toHaveBeenCalled());
    expect(onNav.mock.calls.at(-1)?.[0].history.backReason).toBe("已经是本次会话的第一个文件");

    repositoryDirectory.mockResolvedValue(dir("", [entry("other.ts")], 9));
    await view.rerender({ ...props, opened: opened([], 9, "C:/work/other") } as never);
    // 新仓库的选择与打开历史都是空的：不保留上一仓库的路径。
    await waitFor(() => expect(onNav.mock.calls.at(-1)?.[0]?.history.backReason).toBe("还没有打开过文件"));
    expect(await screen.findByRole("treeitem", { name: /other\.ts/ })).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: /a\.ts/ })).toBeNull();
  });

  it("内容区工具栏真的渲染后退/前进/最近打开，最近打开能点回先前文件", async () => {
    repositoryDirectory.mockResolvedValue(dir("", [entry("a.ts"), entry("b.ts")]));
    render(RepositoryFiles, { props: viewProps() as never });
    const treeEl = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(await within(treeEl).findByRole("treeitem", { name: /a\.ts/ }));
    await waitFor(() => expect(repositoryFileContent).toHaveBeenLastCalledWith(repoPath, "a.ts", 0, undefined, 4, expect.any(Number)));

    // 这三个按钮由 FileNav 自己渲染：不是只把状态交给 onNav。
    const back = screen.getByRole("button", { name: "后退" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    const recentButton = screen.getByRole("button", { name: "最近打开" });
    expect(recentButton.tagName).toBe("BUTTON");

    await fireEvent.click(within(treeEl).getByRole("treeitem", { name: /b\.ts/ }));
    await waitFor(() => expect(repositoryFileContent).toHaveBeenLastCalledWith(repoPath, "b.ts", 0, undefined, 4, expect.any(Number)));
    // 有了第二个文件，后退才真的可点；前进在历史末尾是禁用的。
    expect((screen.getByRole("button", { name: "后退" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "前进" }) as HTMLButtonElement).disabled).toBe(true);

    await fireEvent.click(recentButton);
    const menu = await screen.findByRole("menu", { name: "最近打开的文件" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([expect.stringContaining("b.ts"), expect.stringContaining("a.ts"), "收起"]);

    await fireEvent.click(items[1]);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "最近打开的文件" })).toBeNull());
    await waitFor(() => expect(repositoryFileContent).toHaveBeenLastCalledWith(repoPath, "a.ts", 0, undefined, 4, expect.any(Number)));
    expect(within(screen.getByRole("tree", { name: "仓库文件" })).getByRole("treeitem", { name: /a\.ts/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("先过滤再开仅改动：非改动文件与补齐行都消失，点击行不偷改模式", async () => {
    repositoryDirectory.mockResolvedValue(dir("", [entry("README.md"), entry("src", "directory")]));
    repositoryPathSearch.mockResolvedValue({
      generation: 4,
      query: "app",
      directory: null,
      includeIgnored: false,
      scanned: 4,
      entries: [{ path: "src/app.ts", kind: "file", ignored: false }],
      truncated: false,
      message: null,
    });
    render(
      RepositoryFiles,
      { props: viewProps({ opened: opened([change("src/app.ts", "none", "modified")]) }) as never },
    );
    const treeEl = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.input(screen.getByRole("textbox", { name: "过滤文件树" }), { target: { value: "app" } });

    // 完整树模式：未展开的匹配由全仓库补齐补进来，并带「全仓库」标记。
    const extra = await within(treeEl).findByRole("treeitem", { name: /app\.ts/ });
    expect(extra.textContent).toContain("全仓库");

    await fireEvent.click(screen.getByRole("button", { name: "只看有改动的文件" }));
    const changedOnlyButton = screen.getByRole("button", { name: "只看有改动的文件" });
    expect(changedOnlyButton.getAttribute("aria-pressed")).toBe("true");

    const changedTree = screen.getByRole("tree", { name: "仓库文件" });
    const rows = within(changedTree).getAllByRole("treeitem");
    // 只剩改动文件与它的祖先目录：README.md 这种非改动路径不能混进来。
    expect(rows.every((row) => row.textContent?.includes("全仓库") !== true)).toBe(true);
    expect(within(changedTree).queryByRole("treeitem", { name: /README\.md/ })).toBeNull();
    const appRow = within(changedTree).getByRole("treeitem", { name: /app\.ts/ });

    await fireEvent.click(appRow);
    // 点击改动文件行不能把「只看有改动」悄悄关掉。
    expect(screen.getByRole("button", { name: "只看有改动的文件" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("先开仅改动再过滤：只在改动文件里匹配，不请求全仓补齐", async () => {
    repositoryDirectory.mockResolvedValue(dir("", [entry("README.md"), entry("src", "directory")]));
    repositoryPathSearch.mockResolvedValue({
      generation: 4,
      query: "app",
      directory: null,
      includeIgnored: false,
      scanned: 4,
      entries: [{ path: "ignored/app.ts", kind: "file", ignored: false }],
      truncated: false,
      message: null,
    });
    render(
      RepositoryFiles,
      { props: viewProps({ opened: opened([change("src/app.ts", "none", "modified")]) }) as never },
    );
    const treeEl = await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(screen.getByRole("button", { name: "只看有改动的文件" }));
    await fireEvent.input(screen.getByRole("textbox", { name: "过滤文件树" }), { target: { value: "app" } });

    const changedTree = await screen.findByRole("tree", { name: "仓库文件" });
    expect(within(changedTree).getByRole("treeitem", { name: /app\.ts/ })).toBeTruthy();
    expect(within(changedTree).queryByRole("treeitem", { name: /ignored/ })).toBeNull();
    expect(within(changedTree).queryByRole("treeitem", { name: /README\.md/ })).toBeNull();
    // 改动树已经覆盖全部改动路径：不需要、也不应该再请求全仓库补齐。
    expect(repositoryPathSearch).not.toHaveBeenCalled();
    expect(screen.getByText(/仅在改动文件里匹配/)).toBeTruthy();
    expect(treeEl).toBeTruthy();
  });

  it("仅改动树的折叠按路径保持，不被每次重建弹回展开", async () => {
    repositoryDirectory.mockResolvedValue(dir("", []));
    render(
      RepositoryFiles,
      {
        props: viewProps({
          opened: opened([change("src/app.ts", "none", "modified"), change("src/lib/util.ts", "none", "modified")]),
        }) as never,
      },
    );
    await screen.findByRole("tree", { name: "仓库文件" });
    await fireEvent.click(screen.getByRole("button", { name: "只看有改动的文件" }));
    const tree = await screen.findByRole("tree", { name: "仓库文件" });
    expect(within(tree).getByRole("treeitem", { name: /app\.ts/ })).toBeTruthy();

    await fireEvent.click(within(tree).getByRole("button", { name: "折叠 src" }));
    expect(within(screen.getByRole("tree", { name: "仓库文件" })).queryByRole("treeitem", { name: /app\.ts/ })).toBeNull();

    // 触发一次行重建（过滤输入再清空）：折叠状态必须还在。
    const filter = screen.getByRole("textbox", { name: "过滤文件树" });
    await fireEvent.input(filter, { target: { value: "app" } });
    await fireEvent.input(filter, { target: { value: "" } });
    const after = screen.getByRole("tree", { name: "仓库文件" });
    expect(within(after).queryByRole("treeitem", { name: /app\.ts/ })).toBeNull();
    expect(within(after).getByRole("button", { name: "展开 src" })).toBeTruthy();
  });
});
