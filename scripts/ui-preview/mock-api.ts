// 仅用于浏览器里预览界面（npm run preview:ui）。不会进入 Tauri 构建，也不代表真实 Git 行为。
import type {
  BranchRecord,
  DiffLine,
  DiffResponse,
  FileChange,
  HistoryCommit,
  OpenedRepository,
  StatusSnapshot,
  Theme,
} from "../../src/lib/types";

const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const now = Math.floor(Date.now() / 1000);

let generation = 1;
let theme: Theme = (localStorage.getItem("preview-theme") as Theme) || "light";
let recent = [
  { name: "twiglane", path: "C:/Users/dev/project/twiglane", openedAtMs: Date.now() },
  { name: "design-system", path: "C:/Users/dev/work/design-system", openedAtMs: Date.now() - 1000 },
  { name: "api-gateway", path: "D:/code/backend/api-gateway", openedAtMs: Date.now() - 2000 },
  { name: "demo", path: "/work/alpha/demo", openedAtMs: Date.now() - 3000 },
  { name: "demo", path: "/work/beta/demo", openedAtMs: Date.now() - 4000 },
];

function file(path: string, staged: FileChange["staged"], unstaged: FileChange["unstaged"], extra: Partial<FileChange> = {}): FileChange {
  return { path, originalPath: null, staged, unstaged, untracked: false, unmerged: false, ...extra };
}

let files: FileChange[] = [
  file("src/App.svelte", "none", "modified"),
  file("src/app.css", "modified", "modified"),
  file("src/lib/components/Icon.svelte", "none", "none", { untracked: true }),
  file("src/lib/legacy/old-panel.ts", "none", "deleted"),
  file("README.md", "modified", "none"),
  file("docs/guide/getting-started.md", "renamed", "none", { originalPath: "docs/start.md" }),
  file("public/logo.png", "none", "modified"),
  file("src/lib/merge.ts", "unmerged", "unmerged", { unmerged: true }),
];

const branch = {
  name: "feature/modern-ui",
  detached: false,
  unborn: false,
  headOid: "8f3c2a1d9b7e6f5a4c3b2a1908f7e6d5c4b3a291",
  upstream: "origin/feature/modern-ui",
  ahead: 2,
  behind: 1,
  liveRemoteChecked: true,
  remoteCheckedAtMs: Date.now() - 60_000,
  remoteCheckStale: false,
};

function snapshot(): StatusSnapshot {
  return { generation, branch: { ...branch }, files: files.map((item) => ({ ...item })) };
}

function opened(path: string): OpenedRepository {
  const name = path.split(/[\\/]/).pop() ?? path;
  return { summary: { name, path }, generation, snapshot: snapshot(), draft: "", watchDegraded: false };
}

function diffFor(path: string, staged: boolean): DiffResponse {
  if (path.endsWith(".png")) {
    return { generation, path, staged, binary: true, text: null, summary: "二进制文件有变化。", additions: 0, deletions: 0, complete: true, truncated: false, snapshot: "s", hunks: [], lines: [], offset: 0, totalLines: 0 };
  }
  const lines: DiffLine[] = [];
  const hunks = [];
  let index = 0;
  for (let h = 0; h < 3; h += 1) {
    const start = lines.length;
    const base = h * 40 + 10;
    lines.push({ kind: "hunk", text: `@@ -${base},8 +${base},9 @@ function section${h}() {`, oldNo: null, newNo: null, hunkIndex: index });
    for (let i = 0; i < 3; i += 1) lines.push({ kind: "context", text: `   const value${i} = compute(${i}, options);`, oldNo: base + i, newNo: base + i, hunkIndex: index });
    lines.push({ kind: "del", text: `-  return legacyRender(value0, value1);`, oldNo: base + 3, newNo: null, hunkIndex: index });
    lines.push({ kind: "add", text: `+  const view = render({ value0, value1, theme: "modern" });`, oldNo: null, newNo: base + 3, hunkIndex: index });
    lines.push({ kind: "add", text: `+  return view.mount(target);`, oldNo: null, newNo: base + 4, hunkIndex: index });
    for (let i = 0; i < 3; i += 1) lines.push({ kind: "context", text: `   // 保持原有行为 ${i}`, oldNo: base + 4 + i, newNo: base + 5 + i, hunkIndex: index });
    hunks.push({ index, header: lines[start].text, complete: true, stageable: h < 2, startLine: start, lineCount: lines.length - start });
    index += 1;
  }
  return {
    generation, path, staged, binary: false, text: null,
    summary: "新增 6 行，删除 3 行。", additions: 6, deletions: 3, complete: true, truncated: false,
    snapshot: "snap", hunks, lines, offset: 0, totalLines: lines.length,
  };
}

const authors = ["林知远", "Ada Lovelace", "陈一鸣", "Grace Hopper", "周小满"];
const summaries = [
  "重做界面：现代化布局与深色模式",
  "修复合并冲突后状态未刷新",
  "提交区支持草稿自动保存",
  "优化长差异的虚拟滚动性能",
  "新增分支搜索与远程分支删除确认",
  "Merge branch 'feature/history' into main",
  "文档：补充安装与运行说明",
];
const commits: HistoryCommit[] = Array.from({ length: 60 }, (_, i) => ({
  oid: (i.toString(16).padStart(4, "0") + "a9c3e1f2b4d6".repeat(4)).slice(0, 40),
  parents: i === 5 ? ["1111111aaaaaaa", "2222222bbbbbbb"] : [`${(i + 1).toString(16).padStart(7, "0")}`],
  summary: summaries[i % summaries.length],
  authorName: authors[i % authors.length],
  authorEmail: "dev@example.com",
  authoredAt: now - i * 5400 - 300,
  labels:
    i === 0
      ? [{ name: "feature/modern-ui", kind: "branch", current: true }, { name: "origin/feature/modern-ui", kind: "remote", current: false }]
      : i === 3
        ? [{ name: "v0.1.0", kind: "tag", current: false }]
        : [],
}));

const branches: BranchRecord[] = [
  { name: "feature/modern-ui", remote: false, current: true, upstream: "origin/feature/modern-ui", worktree: null },
  { name: "main", remote: false, current: false, upstream: "origin/main", worktree: null },
  { name: "fix/merge-refresh", remote: false, current: false, upstream: null, worktree: "C:/Users/dev/wt/fix" },
  { name: "origin/main", remote: true, current: false, upstream: null, worktree: null },
  { name: "origin/feature/modern-ui", remote: true, current: false, upstream: null, worktree: null },
];

const ok = async <T>(value: T, ms?: number) => {
  await wait(ms);
  return value;
};

export async function listenEvent() {
  return () => {};
}
export async function pickDirectory() {
  return "C:/Users/dev/project/new-repo";
}
export async function pickFile() {
  return null;
}

export const api: Record<string, (...args: never[]) => Promise<unknown>> = {
  detectGit: () => ok({ available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" }),
  setGitExecutable: () => ok({}),
  clearGitExecutable: () => ok({}),
  getSettings: () =>
    ok({
      theme,
      panelWidths: { sidebar: 264, files: 360 },
      git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" },
      recent,
      settingsWarning: null,
    }),
  addRepository: () => ok(opened(recent[0].path)),
  createRepository: (path: string) => ok(opened(path)),
  openRepository: (path: string) => ok(opened(path), 300),
  closeRepository: () => ok(undefined),
  forgetRecent: (path: string) => {
    recent = recent.filter((item) => item.path !== path);
    return ok(recent);
  },
  cancelReads: () => ok(undefined),
  refreshStatus: () => ok(snapshot()),
  loadDiff: (_repo: string, path: string, staged: boolean) => ok(diffFor(path, staged)),
  stageFiles: (_repo: string, paths: string[]) => {
    files = files.map((item) =>
      paths.includes(item.path) && !item.unmerged
        ? { ...item, staged: item.untracked ? "added" : item.unstaged !== "none" ? item.unstaged : item.staged, unstaged: "none", untracked: false }
        : item,
    );
    generation += 1;
    return ok(snapshot());
  },
  unstageFiles: (_repo: string, paths: string[]) => {
    files = files.map((item) =>
      paths.includes(item.path) ? { ...item, unstaged: item.staged === "added" ? "none" : item.staged, untracked: item.staged === "added", staged: "none" } : item,
    );
    generation += 1;
    return ok(snapshot());
  },
  stageHunks: () => ok(snapshot()),
  saveDraft: () => ok(undefined),
  commitChanges: (_repo: string, message: string) => {
    files = files.filter((item) => item.unstaged !== "none" || item.untracked || item.unmerged).map((item) => ({ ...item, staged: item.unmerged ? item.staged : "none" }));
    generation += 1;
    branch.ahead += 1;
    return ok({ oid: "abcdef1234567", generation, branch: branch.name, summary: `已提交 abcdef1：${message.split("\n")[0]}`, files: [], pushed: false, snapshot: snapshot() }, 400);
  },
  commitAndPush: () => ok({ committed: true, pushed: false, retryPush: true, oid: "abc", branch: branch.name, summary: "本地提交已完成，推送失败。", pushError: "网络不可用：无法连接到远程。可以稍后只重试推送。", generation, snapshot: snapshot() }, 500),
  cloneRepository: (_url: string, parent: string, name: string) => ok({ path: `${parent}/${name || "clone"}`, opened: opened(`${parent}/${name || "clone"}`) }, 800),
  remoteState: () => ok({ generation, remotes: [{ name: "origin", fetchUrl: "https://github.com/example/twiglane.git", pushUrl: null }], snapshot: snapshot() }),
  addRemote: () => ok({ generation, remotes: [], snapshot: snapshot() }),
  setRemoteUrl: () => ok({ generation, remotes: [], snapshot: snapshot() }),
  fetchRemote: () => ok(snapshot(), 900),
  pullFastForward: () => {
    branch.behind = 0;
    return ok(snapshot(), 700);
  },
  pushBranch: () => {
    branch.ahead = 0;
    return ok(snapshot(), 700);
  },
  publishBranch: () => ok(snapshot()),
  associateUpstream: () => ok(snapshot()),
  branchState: () => ok({ generation, branches, snapshot: snapshot() }),
  createBranch: () => ok({ generation, branches, snapshot: snapshot() }),
  switchBranch: () => ok({ generation, branches, snapshot: snapshot() }),
  deleteBranch: () => ok({ generation, branches, snapshot: snapshot() }),
  deleteRemoteBranch: () => ok({ generation, branches, snapshot: snapshot() }),
  historyPage: (_repo: string, query: string, offset: number) => {
    const matched = commits.filter((item) => !query || item.summary.includes(query) || item.authorName.includes(query));
    return ok({ generation, query, offset, pageSize: 100, hasMore: false, state: matched.length ? "ok" : "no_match", commits: matched });
  },
  fileHistory: (_repo: string, path: string, offset: number) =>
    ok({ generation, path, offset, pageSize: 100, hasMore: false, state: "ok", commits: commits.slice(0, 8) }),
  commitDetail: (_repo: string, oid: string) => {
    const commit = commits.find((item) => item.oid === oid) ?? commits[0];
    return ok({
      generation,
      commit,
      body: "这次提交重新组织了主界面：\n- 顶栏集中同步操作\n- 改动列表分组并支持全部暂存\n- 统一的对话框与提示样式",
      root: false,
      merge: commit.parents.length > 1,
      selectedParent: commit.parents[0],
      files: [
        { path: "src/App.svelte", originalPath: null, status: "modified" },
        { path: "src/app.css", originalPath: null, status: "modified" },
        { path: "src/lib/components/Icon.svelte", originalPath: null, status: "added" },
        { path: "src/lib/old.ts", originalPath: null, status: "deleted" },
      ],
    });
  },
  commitFileDiff: (_repo: string, _oid: string, _parent: string, path: string) => ok(diffFor(path, false)),
  stashState: (_repo: string, include: boolean) =>
    ok({
      generation,
      preview: {
        trackedCount: 3, untrackedCount: 1, ignoredCount: 1,
        trackedPaths: ["src/App.svelte", "src/app.css", "README.md"], untrackedPaths: ["src/lib/components/Icon.svelte"], ignoredPaths: ["debug.log"],
        includeUntracked: include, canSave: true,
        summary: `将保存已跟踪的暂存和未暂存改动 3 个。未跟踪文件 1 个${include ? "会一并保存" : "这次不保存"}。忽略文件 1 个不会保存。`,
      },
      records: [
        { oid: "c0ffee1234567890c0ffee1234567890c0ffee12", message: "WIP: 顶栏布局实验", committedAt: now - 7200 },
        { oid: "deadbeef34567890deadbeef34567890deadbeef", message: "", committedAt: now - 86400 * 2 },
      ],
      snapshot: snapshot(),
    }),
  saveStash: () => ok({}),
  applyStash: () => ok({}),
  deleteStash: () => ok({}),
  mergePreview: (_repo: string, source: string) =>
    ok({ generation, source, target: branch.name, headOid: branch.headOid, dirty: true, localPaths: ["src/App.svelte", "src/app.css"], canStart: false, operation: "none", note: "工作区有 2 处未提交改动。合并前请先提交或临时保存。未开始合并。" }),
  startMerge: () => ok({}),
  mergeSession: () =>
    ok({
      generation, operation: "unmerged", canContinue: false, canAbort: false, source: null, target: branch.name, headOid: branch.headOid,
      conflicts: [{ path: "src/lib/merge.ts", kind: "text", summary: "文本" }], unresolved: 1,
      note: "有未合并文件。这不是分支合并，不能中止合并。", snapshot: snapshot(),
    }),
  conflictView: (_repo: string, path: string) =>
    ok({
      generation, path, kind: "text", editable: true,
      ours: { present: true, binary: false, truncated: false, text: "export const mode = \"ours\";\nexport const size = 12;\n", summary: "本地" },
      theirs: { present: true, binary: false, truncated: false, text: "export const mode = \"theirs\";\nexport const size = 14;\n", summary: "另一侧" },
      result: { present: true, binary: false, truncated: false, text: "export const mode = \"ours\";\nexport const size = 14;\n", summary: "结果" },
      note: "可以编辑合并结果，再标记为已解决。",
    }),
  resolveConflict: () => ok({}),
  completeMerge: () => ok({}),
  abortMerge: () => ok({}),
  undoCommit: (_repo: string, head: string) =>
    ok({ generation, code: "ok", eligible: true, wrote: false, headOid: head, parentOid: "b".repeat(40), summary: "重做界面：现代化布局", reason: "这个提交只在本地，可以撤销并保留改动。", snapshot: snapshot() }),
  discardChanges: (_repo: string, paths: string[]) =>
    ok({
      generation, wrote: false, boundary: "确认只影响所选文件。取消不写入，未选择的文件保持原内容。", snapshot: snapshot(),
      files: paths.map((path) => ({ path, originalPath: null, staged: "none", unstaged: "modified", untracked: false, impact: "未暂存的修改会回到当前提交。", recovery: "放弃后 Git 不保留这份未提交内容。" })),
    }),
  setTheme: (next: Theme) => {
    theme = next;
    localStorage.setItem("preview-theme", next);
    return ok(undefined, 0);
  },
  setPanelWidths: (widths: unknown) => ok(widths, 0),
  measureProbe: () => ok({ enabled: false, elapsedMs: 0, script: null }, 0),
  measureSample: () => ok(undefined, 0),
  measureFinish: () => ok(undefined, 0),
  measureWait: () => ok(undefined, 0),
};
