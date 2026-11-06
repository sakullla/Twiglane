import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLine, DiffResponse, FileChange, StatusSnapshot } from "../src/lib/types";
import { commitScope, groupFiles } from "../src/lib/labels";

const repoPath = "C:/work/demo";
const branch = {
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
};

function change(path: string, staged: FileChange["staged"], unstaged: FileChange["unstaged"], extra: Partial<FileChange> = {}): FileChange {
  return { path, originalPath: null, staged, unstaged, untracked: false, unmerged: false, ...extra };
}

const files: FileChange[] = [
  change("src/App.svelte", "none", "modified"),
  change("src/app.css", "modified", "none"),
  change("notes/todo.log", "none", "none", { untracked: true }),
  change("src/merge.ts", "unmerged", "unmerged", { unmerged: true }),
];
const snapshot: StatusSnapshot = { generation: 4, branch, files };

function diffFor(path: string, staged: boolean): DiffResponse {
  const lines: DiffLine[] = [
    { kind: "hunk", text: "@@ -1,2 +1,2 @@", oldNo: null, newNo: null, hunkIndex: 0 },
    { kind: "context", text: " keep", oldNo: 1, newNo: 1, hunkIndex: 0 },
    { kind: "del", text: "-const a = 1;", oldNo: 2, newNo: null, hunkIndex: 0 },
    { kind: "add", text: "+const a = 2;", oldNo: null, newNo: 2, hunkIndex: 0 },
  ];
  return {
    generation: 4,
    path,
    staged,
    binary: false,
    text: null,
    summary: "",
    additions: 1,
    deletions: 1,
    complete: true,
    truncated: false,
    snapshot: "s",
    hunks: [{ index: 0, header: "@@ -1,2 +1,2 @@", complete: true, stageable: true, startLine: 0, lineCount: 4 }],
    lines,
    offset: 0,
    totalLines: lines.length,
  };
}

const mocks = vi.hoisted(() => {
  const names = [
    "getSettings", "openRepository", "addRepository", "createRepository", "closeRepository", "forgetRecent",
    "refreshStatus", "loadDiff", "stageFiles", "unstageFiles", "stageHunks", "commitChanges", "commitAndPush",
    "fetchRemote", "pullFastForward", "pushBranch", "publishBranch", "associateUpstream", "mergeSession",
    "saveDraft", "setTheme", "setPanelWidths", "cancelReads", "historyPage", "commitDetail", "commitFileDiff",
    "fileHistory", "discardChanges", "undoCommit", "detectGit", "setGitExecutable", "clearGitExecutable",
    "cloneRepository", "remoteState", "branchState", "tagState", "stashState", "measureProbe", "measureSample",
    "measureFinish", "measureWait", "revealPath", "openPath", "ignorePath", "listenEvent", "pickDirectory", "pickFile",
  ];
  return Object.fromEntries(names.map((name) => [name, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>;
});

vi.mock("../src/lib/api", () => ({
  api: { ...mocks },
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));

import App from "../src/App.svelte";
import ContextMenu from "../src/lib/components/ContextMenu.svelte";
import Popover from "../src/lib/components/Popover.svelte";
import StatusBar from "../src/lib/components/StatusBar.svelte";

const writeText = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  mocks.getSettings.mockResolvedValue({
    theme: "dark",
    panelWidths: { sidebar: 256, files: 360 },
    git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "ok" },
    recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }],
    settingsWarning: null,
  });
  mocks.listenEvent.mockResolvedValue(() => {});
  mocks.openRepository.mockResolvedValue({ summary: { name: "demo", path: repoPath }, generation: 4, snapshot, draft: "", watchDegraded: false });
  mocks.refreshStatus.mockResolvedValue(snapshot);
  mocks.loadDiff.mockImplementation(async (_repo: string, path: string, staged: boolean) => diffFor(path, staged));
  mocks.mergeSession.mockResolvedValue({ generation: 4, operation: "none", canContinue: false, canAbort: false, source: null, target: "main", headOid: null, conflicts: [], unresolved: 0, note: "", snapshot });
  mocks.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
  mocks.saveDraft.mockResolvedValue(undefined);
  mocks.revealPath.mockResolvedValue(undefined);
  mocks.openPath.mockResolvedValue(undefined);
  mocks.ignorePath.mockResolvedValue({
    snapshot: { ...snapshot, generation: 5, files: files.filter((file) => !file.untracked) },
    note: "已把规则写入 .gitignore。这次修改会出现在改动列表里。",
  });
  mocks.discardChanges.mockImplementation(async (_repo: string, paths: string[], confirm: boolean) => ({
    generation: 4,
    wrote: confirm,
    boundary: "确认只影响所选文件。取消不写入。",
    snapshot,
    files: paths.map((path) => ({ path, originalPath: null, staged: "none", unstaged: "modified", untracked: false, impact: "回到当前提交。", recovery: "不能找回。" })),
  }));
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function openRepo() {
  render(App);
  await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
  await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
  await waitFor(() => expect(document.querySelector(".file-list")).toBeTruthy());
}

function row(path: string): HTMLElement {
  const name = path.split("/").pop() ?? path;
  const found = [...document.querySelectorAll<HTMLElement>(".file-row")].find((element) => element.querySelector(".fn")?.textContent === name);
  if (!found) throw new Error(`没有 ${path} 这一行`);
  return found;
}

async function rightClick(element: Element) {
  await fireEvent.contextMenu(element, { clientX: 200, clientY: 150 });
  return screen.getByRole("menu");
}

describe("改动分组", () => {
  it("冲突文件单独成组，不再同时出现在未暂存和已暂存里；已暂存数与提交范围一致", () => {
    const groups = groupFiles(files);
    expect(groups.conflicted.map((file) => file.path)).toEqual(["src/merge.ts"]);
    expect(groups.unstaged.map((file) => file.path)).toEqual(["src/App.svelte", "notes/todo.log"]);
    expect(groups.staged.map((file) => file.path)).toEqual(["src/app.css"]);
    expect(commitScope("main", files).paths).toHaveLength(groups.staged.length);
  });
});

describe("文件右键菜单", () => {
  it("列出常用操作；放弃更改走影响清单确认，只针对这个文件", async () => {
    await openRepo();
    const menu = await rightClick(row("src/App.svelte"));
    const labels = within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim());
    for (const label of ["暂存", "放弃更改…", "查看完整文件", "查看文件历史", "用默认程序打开", "复制相对路径", "复制完整路径", "复制文件名"]) {
      expect(labels.some((text) => text?.startsWith(label)), label).toBe(true);
    }
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /放弃更改/ }));
    await screen.findByRole("dialog", { name: "放弃文件修改" });
    expect(mocks.discardChanges).toHaveBeenLastCalledWith(repoPath, ["src/App.svelte"], false, 4, expect.any(Number));
    await fireEvent.click(screen.getByRole("button", { name: /个文件的修改$/ }));
    await waitFor(() => expect(mocks.discardChanges).toHaveBeenLastCalledWith(repoPath, ["src/App.svelte"], true, 4, expect.any(Number)));
  });

  it("复制路径、在文件管理器中显示与打开都作用在这一行", async () => {
    await openRepo();
    await fireEvent.click(within(await rightClick(row("src/App.svelte"))).getByRole("menuitem", { name: "复制相对路径" }));
    expect(writeText).toHaveBeenLastCalledWith("src/App.svelte");
    await fireEvent.click(within(await rightClick(row("src/App.svelte"))).getByRole("menuitem", { name: "复制完整路径" }));
    expect(writeText).toHaveBeenLastCalledWith("C:/work/demo/src/App.svelte");
    await fireEvent.click(within(await rightClick(row("src/App.svelte"))).getByRole("menuitem", { name: /中显示/ }));
    expect(mocks.revealPath).toHaveBeenCalledWith(repoPath, "src/App.svelte");
    await fireEvent.click(within(await rightClick(row("src/App.svelte"))).getByRole("menuitem", { name: "用默认程序打开" }));
    expect(mocks.openPath).toHaveBeenCalledWith(repoPath, "src/App.svelte");
  });

  it("工作区文件只提供加入 .gitignore 和本地排除，已跟踪文件仍留在改动里", async () => {
    await openRepo();
    const untracked = await rightClick(row("notes/todo.log"));
    const labels = within(untracked).getAllByRole("menuitem").map((item) => item.textContent?.trim());
    expect(labels).toContain("加入 .gitignore");
    expect(labels).toContain("加入 .git/info/exclude");
    expect(labels.some((text) => text?.includes("扩展名") || text?.includes("忽略目录"))).toBe(false);
    await fireEvent.click(within(untracked).getByRole("menuitem", { name: "加入 .gitignore" }));
    await waitFor(() => expect(mocks.ignorePath).toHaveBeenCalledWith(repoPath, "/notes/todo.log", false, 4, expect.any(Number)));
    expect(await screen.findAllByText("已把规则写入 .gitignore。这次修改会出现在改动列表里。")).not.toHaveLength(0);

    mocks.ignorePath.mockResolvedValueOnce({
      snapshot,
      note: "已把规则写入本地排除。规则只对未跟踪文件生效，该文件仍留在改动中，索引和文件内容未改。",
    });
    const tracked = await rightClick(row("src/App.svelte"));
    expect(within(tracked).queryByRole("menuitem", { name: /忽略所有/ })).toBeNull();
    expect(within(tracked).queryByRole("menuitem", { name: /忽略目录/ })).toBeNull();
    await fireEvent.click(within(tracked).getByRole("menuitem", { name: "加入 .git/info/exclude" }));
    await waitFor(() =>
      expect(mocks.ignorePath).toHaveBeenCalledWith(repoPath, "/src/App.svelte", true, 5, expect.any(Number)),
    );
    expect((await screen.findAllByText(/仍留在改动中/)).length).toBeGreaterThan(0);
  });

  it("冲突文件的菜单给出处理冲突而不是暂存或放弃；分组头可直接去处理", async () => {
    await openRepo();
    expect(document.querySelector(".file-group")?.textContent).toContain("冲突");
    const menu = await rightClick(row("src/merge.ts"));
    expect(within(menu).getByRole("menuitem", { name: "处理冲突…" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: /放弃更改/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /^暂存/ })).toBeNull();
  });

  it("键盘：菜单键打开、方向键移动、Esc 关闭并把焦点还给文件列表", async () => {
    await openRepo();
    const list = document.querySelector<HTMLElement>(".file-list")!;
    list.focus();
    await fireEvent.keyDown(list, { key: "ContextMenu" });
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    await fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    await fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(list);
  });
});

describe("临时保存清单的右键菜单", () => {
  function stashFile(name: string): HTMLElement {
    const found = [...document.querySelectorAll<HTMLElement>(".stash-file")].find((element) => element.textContent?.includes(name));
    if (!found) throw new Error(`没有 ${name} 这一行`);
    return found;
  }

  async function openStash() {
    mocks.stashState.mockResolvedValue({
      generation: 4,
      preview: {
        trackedCount: 2,
        untrackedCount: 1,
        ignoredCount: 0,
        trackedPaths: ["src/App.svelte", "src/app.css"],
        untrackedPaths: ["notes/todo.log"],
        ignoredPaths: [],
        includeUntracked: false,
        canSave: true,
        summary: "将保存已跟踪的暂存和未暂存改动 2 个。未跟踪文件 1 个这次不保存。",
      },
      records: [],
      snapshot,
    });
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: "临时保存" }));
    await screen.findByRole("dialog", { name: "临时保存" });
    await waitFor(() => expect(document.querySelector(".stash-file")).toBeTruthy());
  }

  it("已跟踪文件可以查看改动、复制和定位，不提供忽略", async () => {
    await openStash();
    const menu = await rightClick(stashFile("App.svelte"));
    const labels = within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim());
    for (const label of ["查看改动", "查看文件历史", "用默认程序打开", "复制相对路径", "复制完整路径", "复制文件名"]) {
      expect(labels, label).toContain(label);
    }
    expect(labels.some((text) => text?.startsWith("加入"))).toBe(false);
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "复制相对路径" }));
    expect(writeText).toHaveBeenLastCalledWith("src/App.svelte");
    // 查看改动：关掉临时保存，回到改动视图并选中这个文件。
    await fireEvent.click(within(await rightClick(stashFile("App.svelte"))).getByRole("menuitem", { name: "查看改动" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "临时保存" })).toBeNull());
    await waitFor(() => expect(row("src/App.svelte").getAttribute("aria-selected")).toBe("true"));
  });

  it("未跟踪文件可以直接加入 .gitignore，写入后范围随状态刷新", async () => {
    await openStash();
    await fireEvent.click(screen.getByRole("tab", { name: /未跟踪文件/ }));
    const menu = await rightClick(stashFile("todo.log"));
    expect(within(menu).getByRole("menuitem", { name: "加入 .git/info/exclude" })).toBeTruthy();
    const before = mocks.stashState.mock.calls.length;
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "加入 .gitignore" }));
    await waitFor(() => expect(mocks.ignorePath).toHaveBeenCalledWith(repoPath, "/notes/todo.log", false, 4, expect.any(Number)));
    // 状态刷新后临时保存按新 generation 重读范围。
    await waitFor(() => expect(mocks.stashState.mock.calls.length).toBeGreaterThan(before));
    expect(mocks.stashState).toHaveBeenLastCalledWith(repoPath, false, 5, expect.any(Number));
  });

  it("键盘：清单聚焦后 ↓ 移动，Shift+F10 打开当前行的菜单", async () => {
    await openStash();
    const list = screen.getByRole("list", { name: "保存范围" });
    list.focus();
    await fireEvent.keyDown(list, { key: "ArrowDown" });
    await fireEvent.keyDown(list, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu");
    expect(menu.getAttribute("aria-label")).toBe("src/app.css 的操作");
  });
});

describe("多选文件的右键菜单", () => {
  const manyFiles: FileChange[] = [
    change("src/App.svelte", "none", "modified"),
    change("src/app.css", "none", "modified"),
    change("src/util.ts", "none", "modified"),
    change("src/merge.ts", "unmerged", "unmerged", { unmerged: true }),
  ];

  beforeEach(() => {
    const many = { ...snapshot, files: manyFiles };
    mocks.openRepository.mockResolvedValue({ summary: { name: "demo", path: repoPath }, generation: 4, snapshot: many, draft: "", watchDegraded: false });
    mocks.refreshStatus.mockResolvedValue(many);
    let generation = 4;
    mocks.stageFiles.mockImplementation(async (_repo: string, paths: string[]) => {
      generation += 1;
      return { ...many, generation, files: manyFiles.filter((file) => !paths.includes(file.path)) };
    });
  });

  async function selectThree() {
    await openRepo();
    await waitFor(() => expect(document.querySelector('.file-row[aria-selected="true"]')).toBeTruthy());
    await fireEvent.click(row("src/App.svelte"));
    await fireEvent.click(row("src/app.css"), { ctrlKey: true });
    await fireEvent.click(row("src/merge.ts"), { ctrlKey: true });
    await waitFor(() => expect(document.querySelectorAll('.file-row[aria-selected="true"]')).toHaveLength(3));
  }

  it("右键已选文件作用于全部选中，冲突文件排除并说明，未选中的文件不动", async () => {
    await selectThree();
    const menu = await rightClick(row("src/app.css"));
    expect(menu.textContent).toContain("已选 3 个文件");
    expect(menu.textContent).toContain("已排除 1 个冲突文件");
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /暂存 2 个文件/ }));
    await waitFor(() => expect(mocks.stageFiles).toHaveBeenCalledTimes(2));
    expect(mocks.stageFiles.mock.calls.map((call) => call[1])).toEqual([["src/App.svelte"], ["src/app.css"]]);
  });

  it("右键未选文件变为单选它，菜单回到单文件内容", async () => {
    await selectThree();
    const menu = await rightClick(row("src/util.ts"));
    expect(menu.textContent).not.toContain("已选");
    expect(within(menu).getByRole("menuitem", { name: /放弃更改/ })).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll('.file-row[aria-selected="true"]')).toHaveLength(1));
    expect(document.querySelector(".multi-stack")).toBeNull();
  });

  it("放弃先列出全部影响，取消不写入，冲突文件不在清单里", async () => {
    await selectThree();
    const menu = await rightClick(row("src/App.svelte"));
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /放弃 2 个文件的更改/ }));
    const dialog = await screen.findByRole("dialog", { name: "放弃文件修改" });
    expect(mocks.discardChanges).toHaveBeenLastCalledWith(repoPath, ["src/App.svelte", "src/app.css"], false, 4, expect.any(Number));
    expect(dialog.textContent).toContain("src/App.svelte");
    expect(dialog.textContent).toContain("src/app.css");
    expect(dialog.textContent).not.toContain("src/merge.ts");
    await fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "放弃文件修改" })).toBeNull());
    expect(mocks.discardChanges.mock.calls.some((call) => call[2] === true)).toBe(false);
    expect(document.querySelectorAll('.file-row[aria-selected="true"]')).toHaveLength(3);
  });

  it("中途失败说明是哪个文件，已成功的保留，其余继续", async () => {
    mocks.stageFiles
      .mockRejectedValueOnce({ code: "git", message: "索引被锁定" })
      .mockImplementationOnce(async () => ({ ...snapshot, generation: 5, files: manyFiles.filter((file) => file.path !== "src/app.css") }));
    await selectThree();
    const menu = await rightClick(row("src/app.css"));
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /暂存 2 个文件/ }));
    const toast = await waitFor(() => {
      const element = document.querySelector(".toast.error");
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });
    expect(toast.textContent).toContain("已暂存 1 个文件");
    expect(toast.textContent).toContain("src/App.svelte：索引被锁定");
    expect(mocks.stageFiles).toHaveBeenCalledTimes(2);
  });

  it("批量自身触发的 stale：git add 写索引，监视器 300ms 防抖后推高 generation，重试后全部完成", async () => {
    // 模拟后端：写入成功后 300ms 才推高 generation；请求带旧 generation 时什么都不写。
    let backend = 4;
    const written: string[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    mocks.stageFiles.mockImplementation(async (_repo: string, paths: string[], generation: number) => {
      if (generation !== backend) throw { code: "stale", message: "仓库状态已变化。", generation: backend };
      written.push(...paths);
      const settled = backend;
      timers.push(setTimeout(() => (backend += 1), 300));
      await new Promise((resolve) => setTimeout(resolve, 320));
      return { ...snapshot, generation: settled, files: manyFiles.filter((file) => !written.includes(file.path)) };
    });
    await selectThree();
    await fireEvent.click(row("src/util.ts"), { ctrlKey: true });
    const menu = await rightClick(row("src/app.css"));
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /暂存 3 个文件/ }));
    await waitFor(() => expect(written).toEqual(["src/App.svelte", "src/app.css", "src/util.ts"]), { timeout: 3000 });
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新工作区" })).toHaveProperty("disabled", false), { timeout: 3000 });
    timers.forEach(clearTimeout);
    expect(mocks.stageFiles.mock.calls.length, "第 2、3 个文件各被 stale 拒绝一次").toBe(5);
    expect(document.querySelector(".toast.error")).toBeNull();
  });

  it("stale 只重试当前文件，连续 6 次后才停下并说明，已成功的保留", async () => {
    let attempts = 0;
    mocks.stageFiles.mockImplementation(async (_repo: string, paths: string[]) => {
      if (paths[0] === "src/App.svelte") return { ...snapshot, generation: 5, files: manyFiles.filter((file) => file.path !== "src/App.svelte") };
      attempts += 1;
      throw { code: "stale", message: "仓库状态已变化", generation: 5 + attempts };
    });
    await selectThree();
    await fireEvent.click(row("src/util.ts"), { ctrlKey: true });
    const menu = await rightClick(row("src/app.css"));
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /暂存 3 个文件/ }));
    await waitFor(() => expect(document.querySelector(".toast.error")?.textContent).toContain("1 个文件未处理"));
    expect(attempts, "首次加 6 次重试").toBe(7);
    const text = document.querySelector(".toast.error")?.textContent ?? "";
    expect(text).toContain("已暂存 1 个文件");
    expect(text).toContain("src/app.css：仓库状态持续变化，重试 6 次后停止");
  });

  it("没有新 generation 的 stale 不盲目重试", async () => {
    mocks.stageFiles.mockRejectedValueOnce({ code: "stale", message: "仓库状态已变化" });
    await selectThree();
    const menu = await rightClick(row("src/app.css"));
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /暂存 2 个文件/ }));
    await waitFor(() => expect(document.querySelector(".toast.error")?.textContent).toContain("1 个文件未处理"));
    expect(mocks.stageFiles).toHaveBeenCalledTimes(1);
  });

  it("写锁占用时批量项不可点并说明原因", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.stageFiles.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await selectThree();
    await fireEvent.click(within(await rightClick(row("src/app.css"))).getByRole("menuitem", { name: /暂存 2 个文件/ }));
    const menu = await rightClick(row("src/App.svelte"));
    const item = within(menu).getByRole("menuitem", { name: /暂存 2 个文件/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.title).toContain("稍后再试");
    finish({ ...snapshot, generation: 5, files: manyFiles });
  });
});

describe("共用组件状态反馈", () => {
  it("禁用菜单项直接显示原因、关联描述且不会执行", async () => {
    const run = vi.fn();
    render(ContextMenu, {
      props: {
        request: {
          x: 20,
          y: 20,
          label: "差异操作",
          entries: [{ id: "stage", label: "暂存此块", disabledReason: "完整文件视图不支持按块暂存", run }],
        },
        onClose: vi.fn(),
      },
    });
    const item = await screen.findByRole("menuitem", { name: "暂存此块" });
    const reason = screen.getByText("完整文件视图不支持按块暂存");
    expect(reason.id).not.toBe("");
    expect(item.getAttribute("aria-describedby")).toBe(reason.id);
    await fireEvent.click(item);
    expect(run).not.toHaveBeenCalled();
  });

  it("菜单项的快捷键进入 aria-keyshortcuts，可访问名称仍是 label", async () => {
    render(ContextMenu, {
      props: {
        request: {
          x: 20,
          y: 20,
          label: "提交操作",
          entries: [
            { id: "copy", label: "复制提交哈希", shortcut: "⌘ ⇧ C", run: vi.fn() },
            { id: "amend", label: "撤销最近提交并保留改动", shortcut: "Ctrl 1", run: vi.fn() },
          ],
        },
        onClose: vi.fn(),
      },
    });
    const copy = await screen.findByRole("menuitem", { name: "复制提交哈希" });
    expect(copy.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+C");
    expect(screen.getByText("⌘ ⇧ C")).toBeTruthy();
    const amend = screen.getByRole("menuitem", { name: "撤销最近提交并保留改动" });
    expect(amend.getAttribute("aria-keyshortcuts")).toBe("Control+1");
  });

  it("状态栏暴露忙碌和警告，禁用刷新给出当前原因", async () => {
    const view = render(StatusBar, {
      props: { hasRepo: true, sync: "已同步", busy: true, busyLabel: "提交中", warning: "远程暂不可达，本地提交仍有效", onRefresh: vi.fn() },
    });
    const busy = screen.getByRole("status", { name: "提交中" });
    expect(busy.getAttribute("aria-live")).toBe("polite");
    expect(busy.getAttribute("title")).toBe("提交中");
    expect(busy.querySelector(".sb-text")?.textContent).toBe("提交中");
    // 警告只是常驻文本：播报交给已有的 toast，这里不再做第二个 live region。
    const warning = document.querySelector(".sb-warn")!;
    expect(warning.getAttribute("role")).toBeNull();
    expect(warning.getAttribute("aria-live")).toBeNull();
    expect(warning.getAttribute("title")).toBe("远程暂不可达，本地提交仍有效");
    expect(warning.querySelector(".sb-text")?.textContent).toBe("远程暂不可达，本地提交仍有效");
    // 同步结论被裁切时 title 是完整结论，不是「同步状态」这种空提示。
    expect(document.querySelector(".sb-sync")?.getAttribute("title")).toBe("已同步");
    const refresh = screen.getByRole("button", { name: "刷新工作区" });
    expect(refresh.hasAttribute("disabled")).toBe(true);
    expect(refresh.getAttribute("title")).toContain("当前操作完成后");
    const describedby = refresh.getAttribute("aria-describedby")!;
    const reason = document.getElementById(describedby)!;
    expect(reason.className).toBe("sr-only");
    expect(reason.textContent).toBe("当前操作完成后才能刷新");
    await view.rerender({ busy: false, warning: null });
    expect(refresh.hasAttribute("disabled")).toBe(false);
    expect(refresh.getAttribute("title")).toBe("重新读取工作区与当前差异");
    expect(document.getElementById(describedby)?.textContent).toBe("重新读取工作区与当前差异");
  });
});

describe("弹层与菜单的焦点返回", () => {
  function mountTrigger() {
    const trigger = document.createElement("button");
    trigger.id = "menu-trigger";
    trigger.textContent = "打开";
    document.body.appendChild(trigger);
    trigger.focus();
    return trigger;
  }

  it("菜单没有可执行项时焦点落在菜单本身，Esc 关闭后回到触发控件", async () => {
    const trigger = mountTrigger();
    let view: { unmount: () => void } | null = null;
    const onClose = vi.fn(() => view?.unmount());
    view = render(ContextMenu, {
      props: {
        request: {
          x: 20,
          y: 20,
          label: "差异操作",
          entries: [{ id: "stage", label: "暂存此块", disabledReason: "完整文件视图不支持按块暂存", run: vi.fn() }],
        },
        onClose,
      },
    });
    const menu = await screen.findByRole("menu");
    expect(menu.getAttribute("aria-orientation")).toBe("vertical");
    await waitFor(() => expect(document.activeElement, "没有可聚焦条目时由菜单容器接住焦点").toBe(menu));
    await fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("Tab 关闭菜单与 Esc 一样归还焦点，不把焦点留在背后", async () => {
    const trigger = mountTrigger();
    let view: { unmount: () => void } | null = null;
    const onClose = vi.fn(() => view?.unmount());
    view = render(ContextMenu, {
      props: {
        request: { x: 20, y: 20, label: "提交操作", entries: [{ id: "copy", label: "复制哈希", run: vi.fn() }] },
        onClose,
      },
    });
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(document.activeElement).not.toBe(trigger));
    await fireEvent.keyDown(menu, { key: "Tab" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("弹层 Esc 关闭后调用方没接焦点时，外壳自己把焦点还给触发按钮", async () => {
    const anchor = mountTrigger();
    let view: { unmount: () => void } | null = null;
    const onClose = vi.fn((refocus: boolean) => {
      if (refocus) view?.unmount();
    });
    view = render(Popover, {
      props: {
        anchor,
        label: "切换分支",
        placeholder: "搜索分支",
        query: "",
        active: 0,
        count: 0,
        onChoose: vi.fn(),
        onClose,
        list: createRawSnippet(() => ({ render: () => "<p>没有匹配的分支</p>" })),
      },
    });
    const search = await screen.findByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(search));
    await fireEvent.keyDown(search, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换分支" })).toBeNull());
    await waitFor(() => expect(document.activeElement, "焦点不能掉到 body").toBe(anchor));
    anchor.remove();
  });
});

describe("仓库弹层的仓库操作", () => {
  const other = "D:/code/other";

  async function openPopover() {
    mocks.getSettings.mockResolvedValue({
      theme: "dark",
      panelWidths: { sidebar: 256, files: 360 },
      git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "ok" },
      recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }, { name: "other", path: other, openedAtMs: 2 }],
      settingsWarning: null,
    });
    await openRepo();
    await fireEvent.click(screen.getByRole("button", { name: "当前仓库 demo" }));
    return screen.findByRole("dialog", { name: "切换仓库" });
  }

  it("右键菜单叠在弹层上：复制路径后弹层还在，Esc 只关菜单这一层", async () => {
    const popover = await openPopover();
    const search = within(popover).getByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(search));
    const option = within(popover).getByRole("option", { name: /other/ });
    await fireEvent.contextMenu(option, { clientX: 40, clientY: 90 });
    let menu = screen.getByRole("menu", { name: "other 的操作" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "打开",
      "在资源管理器中显示",
      "复制完整路径",
      "从最近列表移除",
    ]);
    // 点菜单不算点外面。
    await fireEvent.mouseDown(within(menu).getByRole("menuitem", { name: "复制完整路径" }));
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "复制完整路径" }));
    expect(writeText).toHaveBeenLastCalledWith(other);
    expect(screen.getByRole("dialog", { name: "切换仓库" })).toBe(popover);

    await fireEvent.contextMenu(option, { clientX: 40, clientY: 90 });
    menu = screen.getByRole("menu", { name: "other 的操作" });
    await fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "切换仓库" })).toBe(popover);
    await waitFor(() => expect(document.activeElement, "焦点回到搜索框").toBe(search));
  });

  it("键盘：菜单键打开当前项的菜单，打开动作切换仓库并收起弹层", async () => {
    mocks.openRepository.mockResolvedValue({ summary: { name: "demo", path: repoPath }, generation: 4, snapshot, draft: "", watchDegraded: false });
    const popover = await openPopover();
    const search = within(popover).getByRole("combobox");
    await fireEvent.keyDown(search, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "other 的操作" });
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "打开" }));
    await waitFor(() => expect(mocks.openRepository).toHaveBeenLastCalledWith(other, expect.any(Number)));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "切换仓库" })).toBeNull());
  });

  it("行内按钮和右键都能移除；移除不删文件，弹层留着显示剩下的仓库", async () => {
    mocks.forgetRecent.mockResolvedValue([{ name: "demo", path: repoPath, openedAtMs: 1 }]);
    const popover = await openPopover();
    await fireEvent.click(within(popover).getByRole("button", { name: "复制 other 的完整路径" }));
    expect(writeText).toHaveBeenLastCalledWith(other);
    await fireEvent.click(within(popover).getByRole("button", { name: "从列表移除 other" }));
    await waitFor(() => expect(mocks.forgetRecent).toHaveBeenCalledWith(other));
    await waitFor(() => expect(within(popover).getAllByRole("option")).toHaveLength(1));
    expect(mocks.closeRepository, "移除别的仓库不关闭当前仓库").not.toHaveBeenCalled();
    await fireEvent.keyDown(within(popover).getByRole("combobox"), { key: "ContextMenu" });
    await fireEvent.click(within(screen.getByRole("menu", { name: "demo 的操作" })).getByRole("menuitem", { name: "从最近列表移除" }));
    await waitFor(() => expect(mocks.forgetRecent).toHaveBeenLastCalledWith(repoPath));
  });
});

describe("起始页的最近仓库菜单", () => {
  async function startPageRow() {
    mocks.getSettings.mockResolvedValue({
      theme: "dark",
      panelWidths: { sidebar: 256, files: 360 },
      git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "" },
      recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }],
      settingsWarning: null,
    });
    render(App);
    await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
    return document.querySelector<HTMLButtonElement>(".welcome-recent button")!;
  }

  it("右键列出打开、显示、复制路径和移除，移除后列表回到空状态", async () => {
    mocks.forgetRecent.mockResolvedValue([]);
    const menu = await rightClick(await startPageRow());
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "打开",
      "在资源管理器中显示",
      "复制完整路径",
      "从最近列表移除",
    ]);
    expect(mocks.openRepository, "右键不会打开仓库").not.toHaveBeenCalled();
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "从最近列表移除" }));
    await waitFor(() => expect(mocks.forgetRecent).toHaveBeenCalledWith(repoPath));
    await waitFor(() => expect(screen.getByText("还没有最近仓库，先打开或克隆一个。")).toBeTruthy());
  });

  it("键盘菜单键同样打开菜单", async () => {
    await fireEvent.keyDown(await startPageRow(), { key: "ContextMenu" });
    expect(screen.getByRole("menu", { name: "demo 的操作" })).toBeTruthy();
  });
});

describe("差异区", () => {
  it("可展开为完整文件（按大上下文重新读取），展开后不提供按块暂存", async () => {
    await openRepo();
    await waitFor(() => expect(document.querySelector(".hunk-btn")).toBeTruthy());
    await fireEvent.click(screen.getByRole("button", { name: /只看改动/ }));
    await waitFor(() => expect(mocks.loadDiff.mock.calls.at(-1)?.[8]).toBe(1_000_000));
    await waitFor(() => expect(document.querySelector(".hunk-btn")).toBeNull());
    expect(localStorage.getItem("twiglane.diffFullFile")).toBe("1");
    // 右键里的「暂存此块」说明为什么现在不能用
    await fireEvent.contextMenu(document.querySelector("[data-line='3']")!, { clientX: 300, clientY: 200 });
    const stage = within(screen.getByRole("menu")).getByRole("menuitem", { name: "暂存此块" });
    expect(stage.getAttribute("aria-disabled")).toBe("true");
    expect(stage.getAttribute("title")).toContain("完整文件视图");
  });

  it("右键某个代码块可以直接暂存它", async () => {
    await openRepo();
    await waitFor(() => expect(document.querySelector("[data-line='3']")).toBeTruthy());
    await fireEvent.contextMenu(document.querySelector("[data-line='3']")!, { clientX: 300, clientY: 200 });
    mocks.stageHunks.mockResolvedValue(snapshot);
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "暂存此块" }));
    await waitFor(() => expect(mocks.stageHunks).toHaveBeenCalledTimes(1));
  });
});
describe("右键菜单定位", () => {
  function stubMenuBox(width: number, height: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height,
      toJSON: () => ({}),
    } as DOMRect);
  }
  const menuAt = (x: number, y: number) => ({
    x,
    y,
    label: "测试菜单",
    entries: [{ id: "only", label: "唯一操作", run: () => {} }],
  });
  const placed = () => {
    const menu = document.querySelector<HTMLElement>(".context-menu");
    return { left: Number.parseFloat(menu?.style.left ?? ""), top: Number.parseFloat(menu?.style.top ?? "") };
  };

  afterEach(() => vi.restoreAllMocks());

  it("右下越界时向内收到边距内", async () => {
    stubMenuBox(240, 180);
    render(ContextMenu, { props: { request: menuAt(window.innerWidth - 10, window.innerHeight - 10), onClose: () => {} } });
    await waitFor(() => expect(placed().left).toBe(window.innerWidth - 240 - 8));
    expect(placed().top).toBe(window.innerHeight - 180 - 8);
  });

  it("顶部和左侧越界时也不出视口（键盘唤起、行在视口上方时会出现负坐标）", async () => {
    stubMenuBox(240, 180);
    render(ContextMenu, { props: { request: menuAt(-20, -91), onClose: () => {} } });
    await waitFor(() => expect(placed().left).toBe(8));
    expect(placed().top).toBe(8);
  });

  it("放得下时仍在唤起点，不被钳制移位", async () => {
    stubMenuBox(240, 180);
    render(ContextMenu, { props: { request: menuAt(120, 140), onClose: () => {} } });
    await waitFor(() => expect(placed().left).toBe(120));
    expect(placed().top).toBe(140);
  });
});
