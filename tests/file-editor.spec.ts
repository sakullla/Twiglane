/**
 * 轻量编辑（T2）：编辑会话状态与外壳接线。
 *
 * - 会话层：草稿按「仓库 + 路径 + baseDigest」保留，保存只发基线摘要；外部修改不覆盖 dirty 草稿，
 *   保存失败保留草稿，冲突不自动重试，代次过期按新代次重发一次；
 * - 外壳：只有改动的未暂存一侧与任务净差异的工作区文件能进入编辑；保存后按真实快照刷新，
 *   不暂存、不提交；换仓库与返回 cliora 前必须保存、放弃或取消；cliora 来源保持不变。
 *
 * 真实文件与 Git 语义（摘要复核、BOM/行尾、原子替换、HEAD 与索引不变）由 Rust 夹具覆盖
 * （src-tauri/src/git/files.rs）；这里的 api 都是 mock，不代表真实写入。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BranchInfo,
  DiffLine,
  DiffResponse,
  FileChange,
  RepositoryEditSnapshot,
  StatusSnapshot,
  TaskReview as TaskSnapshot,
} from "../src/lib/types";

const REPO = "C:/work/demo";
const OTHER = "C:/work/other";
const DIGEST = "a".repeat(64);
const NEXT = "b".repeat(64);
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);

const branch: BranchInfo = {
  name: "main",
  detached: false,
  unborn: false,
  headOid: HEAD,
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
  change("src/app.ts", "none", "modified"),
  change("docs/old.md", "none", "deleted"),
  change("README.md", "modified", "none"),
];
const snapshot: StatusSnapshot = { generation: 4, branch, files };

function editSnap(overrides: Partial<RepositoryEditSnapshot> = {}): RepositoryEditSnapshot {
  return {
    generation: 4,
    path: "src/app.ts",
    state: "editable",
    editable: true,
    size: 20,
    digest: DIGEST,
    text: "line 1\nline 2\nline 3\n",
    bom: false,
    lineEnding: "lf",
    finalNewline: true,
    message: "",
    ...overrides,
  };
}

function diffFor(path: string, staged = false): DiffResponse {
  const lines: DiffLine[] = Array.from({ length: 4 }, (_, index) => ({
    kind: index === 1 ? "add" : "context",
    text: index === 1 ? "+line 2" : ` line ${index + 1}`,
    oldNo: index === 1 ? null : index + 1,
    newNo: index + 1,
    hunkIndex: 0,
  }));
  return {
    generation: 4,
    path,
    staged,
    binary: false,
    text: null,
    summary: "新增 1 行。",
    additions: 1,
    deletions: 0,
    complete: true,
    truncated: false,
    snapshot: "snap",
    hunks: [{ index: 0, header: "@@ -1,3 +1,4 @@", complete: true, stageable: true, startLine: 0, lineCount: lines.length }],
    lines,
    offset: 0,
    totalLines: lines.length,
  };
}

function taskFixture(): TaskSnapshot {
  return {
    generation: 4,
    worktree: REPO,
    baselineRef: BASE,
    baselineOid: BASE,
    headOid: HEAD,
    branch,
    commits: [],
    commitCount: 1,
    commitsTruncated: false,
    files: [
      { path: "src/app.ts", originalPath: null, status: "modified", additions: 1, deletions: 0, binary: false, oldSize: null, newSize: null, untracked: false, unmerged: false },
    ],
    filesTotal: 1,
    filesTruncated: false,
    additions: 1,
    deletions: 0,
    dirty: true,
    untrackedFiles: 0,
    conflicted: false,
    empty: false,
    rangeVersion: "range-1",
    message: "读取成功。",
  };
}

const mocks = vi.hoisted(() => {
  const created = new Map<string, ReturnType<typeof vi.fn>>();
  const api = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get: (_target, name) => {
      if (typeof name !== "string") return undefined;
      if (!created.has(name)) created.set(name, vi.fn());
      return created.get(name)!;
    },
  });
  return { api, created, listenEvent: vi.fn(), pickDirectory: vi.fn(), pickFile: vi.fn() };
});

const deepLink = vi.hoisted(() => ({
  handler: null as null | ((urls: string[]) => void),
  getCurrent: vi.fn(),
  onOpenUrl: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: deepLink.getCurrent,
  onOpenUrl: deepLink.onOpenUrl,
}));

vi.mock("../src/lib/api", () => ({
  api: mocks.api,
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));
// 沙箱里不起分词 Worker：只验证文本与交互，不验证着色。
vi.mock("../src/lib/syntax/client", () => ({ highlightLines: vi.fn(() => vi.fn()) }));

import App from "../src/App.svelte";
import { beginClioraReview, clioraReview, resetClioraReview } from "../src/lib/cliora-review.svelte";
import { createFileEditor, fileEditor, isDirty, saveBlocker } from "../src/lib/file-editor.svelte";
import { resetReviewProgress } from "../src/lib/review-progress.svelte";

const calls = (name: string) => mocks.created.get(name)?.mock.calls.length ?? 0;

function resetMocks() {
  for (const fn of mocks.created.values()) fn.mockReset();
  mocks.listenEvent.mockReset();
  mocks.listenEvent.mockResolvedValue(() => {});
  mocks.pickDirectory.mockResolvedValue(null);
  mocks.pickFile.mockResolvedValue(null);
  mocks.api.getSettings.mockResolvedValue({
    theme: "dark",
    panelWidths: { sidebar: 256, files: 360 },
    git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" },
    recent: [
      { name: "demo", path: REPO, openedAtMs: 2 },
      { name: "other", path: OTHER, openedAtMs: 1 },
    ],
    settingsWarning: null,
  });
  mocks.api.detectGit.mockResolvedValue({ available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" });
  mocks.api.cancelReads.mockResolvedValue(undefined);
  mocks.api.saveDraft.mockResolvedValue(undefined);
  mocks.api.setTheme.mockResolvedValue(undefined);
  mocks.api.setPanelWidths.mockImplementation(async (widths: unknown) => widths);
  mocks.api.openRepository.mockImplementation(async (path: string) => ({
    summary: { name: path.split("/").pop() ?? path, path },
    generation: 4,
    snapshot,
    draft: "",
    watchDegraded: false,
  }));
  mocks.api.refreshStatus.mockResolvedValue(snapshot);
  mocks.api.loadDiff.mockImplementation(async (_repo: string, path: string, staged: boolean) => diffFor(path, staged));
  mocks.api.mergeSession.mockResolvedValue({
    generation: 4, operation: "none", canContinue: false, canAbort: false, source: null, target: "main",
    headOid: HEAD, conflicts: [], unresolved: 0, note: "当前没有进行中的合并。", snapshot,
  });
  mocks.api.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
  mocks.api.repoHeads.mockResolvedValue([]);
  mocks.api.repositoryReviewToken.mockResolvedValue({ generation: 4, path: "src/app.ts", state: "unchanged", token: null, message: "" });
  mocks.api.repositoryDirectory.mockImplementation(async (_repo: string, relative: string) => ({
    generation: 4,
    path: relative,
    entries:
      relative === ""
        ? [
            { name: "src", path: "src", kind: "directory", ignored: false, size: null, error: null },
            { name: "README.md", path: "README.md", kind: "file", ignored: false, size: 10, version: "r1", error: null },
          ]
        : relative === "src"
          ? [{ name: "app.ts", path: "src/app.ts", kind: "file", ignored: false, size: 20, version: "v1", error: null }]
          : [],
    errors: [],
  }));
  mocks.api.repositoryFileContent.mockImplementation(async (_repo: string, relative: string) => ({
    generation: 4, path: relative, kind: "text", size: 20, version: "v1", offset: 0,
    lines: ["line 1", "line 2", "line 3"], nextOffset: 3, hasMore: false, truncated: false, message: null,
  }));
  mocks.api.repositoryEditSnapshot.mockResolvedValue(editSnap());
  mocks.api.repositoryEditSave.mockImplementation(async (_repo: string, path: string, _digest: string, content: string) =>
    editSnap({ generation: 5, path, digest: NEXT, text: content }));
  mocks.api.historyPage.mockResolvedValue({
    generation: 4, query: "", offset: 0, pageSize: 100, hasMore: false, state: "ok", commits: [],
    scope: "current", branches: ["main"], head: "main",
  });
  mocks.api.branchList.mockResolvedValue({ generation: 4, branches: [] });
  mocks.api.taskReview.mockResolvedValue(taskFixture());
  mocks.api.taskReviewToken.mockResolvedValue({ generation: 4, path: "src/app.ts", state: "unchanged", token: null, message: "" });
  mocks.api.loadTaskDiff.mockImplementation(async (_w: string, _b: string, _h: string, path: string) => diffFor(path));
  mocks.api.clioraReviewReceipt.mockResolvedValue(undefined);
  mocks.api.clioraReviewReturn.mockResolvedValue(undefined);
}

beforeEach(() => {
  resetMocks();
  resetClioraReview();
  resetReviewProgress();
  fileEditor.reset();
  deepLink.handler = null;
  deepLink.getCurrent.mockResolvedValue(null);
  deepLink.onOpenUrl.mockImplementation(async (handler: (urls: string[]) => void) => {
    deepLink.handler = handler;
    return () => {};
  });
});

afterEach(() => {
  cleanup();
  resetClioraReview();
  resetReviewProgress();
  fileEditor.reset();
});

/* ------------------------------------------------------------------ *
 * 会话层
 * ------------------------------------------------------------------ */
describe("编辑会话", () => {
  const context = (generation = 4) => ({ generation, nextId: () => 9, onGeneration: vi.fn() });

  it("读取完整快照后才可编辑；保存只发基线摘要与 LF 文本，成功后换到新基线", async () => {
    const editor = createFileEditor();
    await editor.open(REPO, "src/app.ts", context());
    const session = editor.session(REPO, "src/app.ts")!;
    expect(session.phase).toBe("ready");
    expect(isDirty(session)).toBe(false);
    expect(saveBlocker(session)).toBe("没有未保存的修改");

    editor.input(REPO, "src/app.ts", "line 1\nchanged\n");
    expect(isDirty(editor.session(REPO, "src/app.ts"))).toBe(true);
    expect(editor.dirty(REPO).map((item) => item.path)).toEqual(["src/app.ts"]);
    const outcome = await editor.save(REPO, "src/app.ts", context());
    expect(outcome.ok).toBe(true);
    expect(mocks.api.repositoryEditSave).toHaveBeenCalledWith(REPO, "src/app.ts", DIGEST, "line 1\nchanged\n", 4, 9);
    const saved = editor.session(REPO, "src/app.ts")!;
    expect(saved.baseDigest).toBe(NEXT);
    expect(isDirty(saved)).toBe(false);
    expect(editor.dirty(REPO)).toEqual([]);
  });

  it("后端判为只读时会话只读并带具体原因，不能输入或保存", async () => {
    mocks.api.repositoryEditSnapshot.mockResolvedValue(
      editSnap({ state: "binary", editable: false, digest: null, text: null, message: "二进制内容保持只读。" }),
    );
    const editor = createFileEditor();
    await editor.open(REPO, "assets/a.bin", context());
    const session = editor.session(REPO, "assets/a.bin")!;
    expect(session.phase).toBe("readonly");
    expect(session.error).toBe("二进制内容保持只读。");
    editor.input(REPO, "assets/a.bin", "x");
    expect(isDirty(editor.session(REPO, "assets/a.bin"))).toBe(false);
    expect((await editor.save(REPO, "assets/a.bin", context())).ok).toBe(false);
    expect(mocks.api.repositoryEditSave).not.toHaveBeenCalled();
  });

  it("代次过期时按后端给的新代次重发一次；摘要冲突保留草稿且不重试", async () => {
    const editor = createFileEditor();
    const ctx = context();
    await editor.open(REPO, "src/app.ts", ctx);
    editor.input(REPO, "src/app.ts", "draft\n");
    mocks.api.repositoryEditSave.mockRejectedValueOnce({ code: "stale", message: "旧代次", generation: 6 });
    const first = await editor.save(REPO, "src/app.ts", ctx);
    expect(first.ok).toBe(true);
    expect(ctx.onGeneration).toHaveBeenCalledWith(6);
    expect(mocks.api.repositoryEditSave.mock.calls.map((call) => call[4])).toEqual([4, 6]);

    editor.input(REPO, "src/app.ts", "draft 2\n");
    mocks.api.repositoryEditSave.mockRejectedValueOnce({ code: "edit_conflict", message: "文件已被外部修改，保存未写入。" });
    const second = await editor.save(REPO, "src/app.ts", ctx);
    expect(second).toEqual({ ok: false, code: "edit_conflict", message: "文件已被外部修改，保存未写入。" });
    const session = editor.session(REPO, "src/app.ts")!;
    expect(session.draft).toBe("draft 2\n");
    expect(session.conflict).toBe("文件已被外部修改，保存未写入。");
    expect(saveBlocker(session)).toContain("外部修改");
    expect(mocks.api.repositoryEditSave).toHaveBeenCalledTimes(3);
  });

  it("写入失败保留草稿与原基线，可以按同一基线重试", async () => {
    const editor = createFileEditor();
    await editor.open(REPO, "src/app.ts", context());
    editor.input(REPO, "src/app.ts", "draft\n");
    mocks.api.repositoryEditSave.mockRejectedValueOnce({ code: "edit_write_failed", message: "磁盘已满，原文件保持不变。" });
    const failed = await editor.save(REPO, "src/app.ts", context());
    expect(failed.ok).toBe(false);
    const session = editor.session(REPO, "src/app.ts")!;
    expect(session.draft).toBe("draft\n");
    expect(session.baseDigest).toBe(DIGEST);
    expect(session.error).toContain("磁盘已满");
    expect(saveBlocker(session)).toBeNull();
    expect((await editor.save(REPO, "src/app.ts", context())).ok).toBe(true);
    expect(mocks.api.repositoryEditSave.mock.calls.map((call) => call[2])).toEqual([DIGEST, DIGEST]);
  });

  it("外部修改：干净会话换到新基线，dirty 草稿只标冲突；外部改回原样时冲突解除", async () => {
    const editor = createFileEditor();
    await editor.open(REPO, "src/app.ts", context());
    mocks.api.repositoryEditSnapshot.mockResolvedValue(editSnap({ digest: NEXT, text: "external\n" }));
    await editor.checkExternal(REPO, "src/app.ts", context());
    expect(editor.session(REPO, "src/app.ts")!.draft).toBe("external\n");
    expect(editor.session(REPO, "src/app.ts")!.baseDigest).toBe(NEXT);

    editor.input(REPO, "src/app.ts", "mine\n");
    mocks.api.repositoryEditSnapshot.mockResolvedValue(editSnap({ digest: "c".repeat(64), text: "other\n" }));
    await editor.checkExternal(REPO, "src/app.ts", context());
    let session = editor.session(REPO, "src/app.ts")!;
    expect(session.draft).toBe("mine\n");
    expect(session.baseDigest).toBe(NEXT);
    expect(session.conflict).toContain("被外部修改");

    mocks.api.repositoryEditSnapshot.mockResolvedValue(editSnap({ digest: NEXT, text: "external\n" }));
    await editor.checkExternal(REPO, "src/app.ts", context());
    session = editor.session(REPO, "src/app.ts")!;
    expect(session.conflict).toBeNull();
    expect(session.draft).toBe("mine\n");
  });

  it("保存在途时读到的「外部变化」就是这次写入本身，不当成冲突；保存期间的新输入继续是草稿", async () => {
    const editor = createFileEditor();
    await editor.open(REPO, "src/app.ts", context());
    editor.input(REPO, "src/app.ts", "first\n");
    let finish!: (value: RepositoryEditSnapshot) => void;
    mocks.api.repositoryEditSave.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const saving = editor.save(REPO, "src/app.ts", context());
    // 保存期间文件版本前进：复核不发生（saving），也不会把本次写入标成外部冲突。
    mocks.api.repositoryEditSnapshot.mockResolvedValue(editSnap({ digest: NEXT, text: "first\n" }));
    await editor.checkExternal(REPO, "src/app.ts", context());
    editor.input(REPO, "src/app.ts", "first\nsecond\n");
    finish(editSnap({ generation: 5, digest: NEXT, text: "first\n" }));
    await saving;
    const session = editor.session(REPO, "src/app.ts")!;
    expect(session.conflict).toBeNull();
    expect(session.baseDigest).toBe(NEXT);
    expect(session.draft).toBe("first\nsecond\n");
    expect(isDirty(session)).toBe(true);
  });

  it("换仓库时别的仓库里干净会话结束，未保存草稿保留；关闭后在途结果不写回", async () => {
    const editor = createFileEditor();
    await editor.open(REPO, "src/app.ts", context());
    await editor.open(REPO, "README.md", context());
    editor.input(REPO, "README.md", "draft\n");
    expect(editor.retainRepository(OTHER)).toEqual([`${REPO}:README.md`]);
    expect(editor.session(REPO, "src/app.ts")).toBeNull();
    expect(editor.session(REPO, "README.md")?.draft).toBe("draft\n");

    let finish!: (value: RepositoryEditSnapshot) => void;
    mocks.api.repositoryEditSnapshot.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const opening = editor.open(OTHER, "late.ts", context());
    editor.close(OTHER, "late.ts");
    finish(editSnap({ path: "late.ts" }));
    await opening;
    expect(editor.session(OTHER, "late.ts")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 外壳接线
 * ------------------------------------------------------------------ */

async function openRepo() {
  await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
  await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
  await waitFor(() => expect(document.querySelector(".file-list")).toBeTruthy());
  await waitFor(() => expect(document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0));
}

const activeView = () => document.querySelector<HTMLElement>('.workbench-view[data-active="true"]')?.dataset.viewScope ?? null;
const editorBox = () => document.querySelector<HTMLTextAreaElement>('.workbench-view[data-active="true"] .text-editor-input');

function changesRow(path: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('.workbench-view[data-view-scope="changes"] .file-row')].find(
    (item) => item.getAttribute("title") === path,
  );
  if (!row) throw new Error(`改动列表里没有 ${path}`);
  return row;
}

/** 从改动差异进入编辑并输入一份草稿。 */
async function editFromChanges(draft: string) {
  const edit = await waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>('.workbench-view[data-active="true"] button[aria-label="编辑工作区文件"]');
    if (!button) throw new Error("差异工具条没有编辑入口");
    return button;
  });
  await fireEvent.click(edit);
  await waitFor(() => expect(activeView()).toBe("files"));
  await waitFor(() => expect(editorBox()).toBeTruthy());
  await waitFor(() => expect(editorBox()!.value).toBe("line 1\nline 2\nline 3\n"));
  await fireEvent.input(editorBox()!, { target: { value: draft } });
}

describe("改动差异进入编辑", () => {
  it("未暂存一侧可编辑；保存只写工作区文件并按新代次刷新状态与差异，不暂存不提交", async () => {
    render(App);
    await openRepo();
    await editFromChanges("line 1\nline 2 edited\nline 3\n");
    expect(mocks.api.repositoryEditSnapshot).toHaveBeenCalledWith(REPO, "src/app.ts", 4, expect.any(Number));
    const refreshes = calls("refreshStatus");
    await fireEvent.click(screen.getByRole("button", { name: "保存修改到工作区" }));
    await waitFor(() =>
      expect(mocks.api.repositoryEditSave).toHaveBeenCalledWith(REPO, "src/app.ts", DIGEST, "line 1\nline 2 edited\nline 3\n", 4, expect.any(Number)),
    );
    // 保存后的代次是后端给的新值：随后的状态刷新按它读取，而不是旧代次。
    await waitFor(() => expect(calls("refreshStatus")).toBeGreaterThan(refreshes));
    expect(mocks.api.refreshStatus).toHaveBeenLastCalledWith(REPO, 5, expect.any(Number));
    for (const name of ["stageFiles", "stageHunks", "stageLines", "commitChanges", "commitAndPush", "pushBranch"]) {
      expect(calls(name), name).toBe(0);
    }

    // 返回差异：回到改动视图同一文件的未暂存一侧，并重新读取差异。
    const diffs = calls("loadDiff");
    await fireEvent.click(screen.getByRole("button", { name: "返回差异" }));
    await waitFor(() => expect(activeView()).toBe("changes"));
    await waitFor(() => expect(calls("loadDiff")).toBeGreaterThan(diffs));
    expect(mocks.api.loadDiff.mock.calls.at(-1)?.slice(0, 3)).toEqual([REPO, "src/app.ts", false]);
  });

  it("已暂存一侧（新侧是索引）与删除文件没有编辑入口", async () => {
    render(App);
    await openRepo();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "编辑工作区文件" }).length).toBeGreaterThan(0));

    await fireEvent.click(changesRow("README.md"));
    await waitFor(() => expect(mocks.api.loadDiff.mock.calls.at(-1)?.slice(0, 3)).toEqual([REPO, "README.md", true]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "编辑工作区文件" })).toBeNull());

    await fireEvent.click(changesRow("docs/old.md"));
    await waitFor(() => expect(mocks.api.loadDiff.mock.calls.at(-1)?.slice(0, 3)).toEqual([REPO, "docs/old.md", false]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "编辑工作区文件" })).toBeNull());
    expect(mocks.api.repositoryEditSnapshot).not.toHaveBeenCalled();
  });

  it("文本框里的工作台快捷键不生效：Ctrl 1 不切视图，Alt M 不标记审阅", async () => {
    render(App);
    await openRepo();
    await editFromChanges("draft\n");
    const box = editorBox()!;
    await fireEvent.keyDown(box, { key: "1", ctrlKey: true });
    await fireEvent.keyDown(box, { key: "m", altKey: true });
    await tick();
    expect(activeView()).toBe("files");
    expect(calls("repositoryReviewToken")).toBe(0);
    expect(editorBox()!.value).toBe("draft\n");
  });

  it("有 dirty 草稿时返回差异先问：取消留在编辑器，放弃后才回到差异", async () => {
    render(App);
    await openRepo();
    await editFromChanges("draft\n");
    await fireEvent.click(screen.getByRole("button", { name: "返回差异" }));
    const dialog = await screen.findByRole("dialog", { name: "有未保存的编辑" });
    expect(within(dialog).getByText("src/app.ts")).toBeTruthy();
    await fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "有未保存的编辑" })).toBeNull());
    expect(activeView()).toBe("files");
    expect(editorBox()!.value).toBe("draft\n");

    await fireEvent.click(screen.getByRole("button", { name: "返回差异" }));
    const again = await screen.findByRole("dialog", { name: "有未保存的编辑" });
    await fireEvent.click(within(again).getByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(activeView()).toBe("changes"));
    expect(mocks.api.repositoryEditSave).not.toHaveBeenCalled();
    expect(fileEditor.dirty(REPO)).toEqual([]);
  });
});

describe("换仓库前处理未保存草稿", () => {
  async function switchToOther() {
    await fireEvent.click(screen.getByRole("button", { name: "当前仓库 demo" }));
    const popover = await screen.findByRole("dialog", { name: "切换仓库" });
    await fireEvent.click(within(popover).getByRole("option", { name: /other/ }));
  }

  it("取消留在原仓库与草稿；放弃后才打开另一个仓库", async () => {
    render(App);
    await openRepo();
    await editFromChanges("draft\n");
    await switchToOther();
    const dialog = await screen.findByRole("dialog", { name: "有未保存的编辑" });
    expect(mocks.api.openRepository).toHaveBeenCalledTimes(1);
    await fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "有未保存的编辑" })).toBeNull());
    expect(mocks.api.openRepository).toHaveBeenCalledTimes(1);
    expect(editorBox()!.value).toBe("draft\n");

    await switchToOther();
    const again = await screen.findByRole("dialog", { name: "有未保存的编辑" });
    await fireEvent.click(within(again).getByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenLastCalledWith(OTHER, expect.any(Number)));
    expect(mocks.api.repositoryEditSave).not.toHaveBeenCalled();
    expect(fileEditor.session(REPO, "src/app.ts")).toBeNull();
  });

  it("选择保存时先保存再切换；保存失败停在对话框里，草稿不丢、不切换", async () => {
    render(App);
    await openRepo();
    await editFromChanges("draft\n");
    mocks.api.repositoryEditSave.mockRejectedValueOnce({ code: "edit_write_failed", message: "磁盘已满，原文件保持不变。" });
    await switchToOther();
    const dialog = await screen.findByRole("dialog", { name: "有未保存的编辑" });
    await fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByText(/src\/app\.ts 没有保存：磁盘已满/)).toBeTruthy();
    expect(mocks.api.openRepository).toHaveBeenCalledTimes(1);
    expect(fileEditor.session(REPO, "src/app.ts")?.draft).toBe("draft\n");

    // 同一个对话框里再保存一次：成功后才切换仓库。
    await fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.api.openRepository).toHaveBeenLastCalledWith(OTHER, expect.any(Number)));
    expect(mocks.api.repositoryEditSave.mock.calls.map((call) => call.slice(0, 4))).toEqual([
      [REPO, "src/app.ts", DIGEST, "draft\n"],
      [REPO, "src/app.ts", DIGEST, "draft\n"],
    ]);
  });
});

describe("cliora 来源与编辑", () => {
  it("任务净差异进入编辑不清除来源；返回 cliora 前先处理草稿，保存不变成提交或合入", async () => {
    mocks.api.clioraReviewRequest.mockResolvedValue({ reviewId: "review-1", sessionId: "session-1", worktreePath: REPO, baseline: BASE });
    render(App);
    await waitFor(() => expect(deepLink.handler).toBeTruthy());
    deepLink.handler!(["twiglane://review?v=1&reviewId=review-1"]);
    await waitFor(() => expect(mocks.api.taskReview).toHaveBeenCalled(), { timeout: 8000 });
    await waitFor(() => expect(clioraReview.source?.reviewId).toBe("review-1"));

    const edit = await screen.findByRole("button", { name: "编辑工作区文件" }, { timeout: 8000 });
    await fireEvent.click(edit);
    await waitFor(() => expect(activeView()).toBe("files"));
    await waitFor(() => expect(editorBox()!.value).toBe("line 1\nline 2\nline 3\n"));
    expect(clioraReview.source?.reviewId, "进入编辑不清来源").toBe("review-1");
    expect(screen.getByRole("button", { name: "返回任务差异" })).toBeTruthy();
    await fireEvent.input(editorBox()!, { target: { value: "edited\n" } });

    await fireEvent.click(screen.getByRole("button", { name: /^返回 cliora/ }));
    const dialog = await screen.findByRole("dialog", { name: "有未保存的编辑" });
    expect(mocks.api.clioraReviewReturn).not.toHaveBeenCalled();
    await fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith("review-1", "session-1", "reviewed", null));
    expect(mocks.api.repositoryEditSave).toHaveBeenCalledWith(REPO, "src/app.ts", DIGEST, "edited\n", 4, expect.any(Number));
    expect(clioraReview.source?.reviewId, "保存与返回都不清来源").toBe("review-1");
    expect(calls("commitChanges")).toBe(0);

    // 回到任务差异：任务页按新代次重新读取净差异。
    const reads = calls("taskReview");
    await fireEvent.click(screen.getByRole("button", { name: "返回任务差异" }));
    await waitFor(() => expect(activeView()).toBe("history"));
    await waitFor(() => expect(calls("taskReview")).toBeGreaterThan(reads));
  });

  it("没有草稿时返回 cliora 不弹确认", async () => {
    render(App);
    await openRepo();
    beginClioraReview({ reviewId: "review-2", sessionId: "session-2", worktreePath: REPO, baseline: null });
    await fireEvent.click(await screen.findByRole("button", { name: /^返回 cliora/ }));
    await waitFor(() => expect(mocks.api.clioraReviewReturn).toHaveBeenCalledWith("review-2", "session-2", "reviewed", null));
    expect(screen.queryByRole("dialog", { name: "有未保存的编辑" })).toBeNull();
  });
});
