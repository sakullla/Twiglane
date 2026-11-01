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
import { createTextDiff } from "../../src/lib/diff";
import { sampleFor } from "./samples";

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
  file("src-tauri/src/repo.rs", "none", "modified"),
  file("scripts/config.py", "none", "modified"),
  file("docs/fixtures/rows.txt", "none", "modified"),
  file("src/lib/merge.ts", "unmerged", "unmerged", { unmerged: true }),
  file("src/styles/theme.css", "unmerged", "unmerged", { unmerged: true }),
  file("public/hero.png", "unmerged", "unmerged", { unmerged: true }),
];

/**
 * 预览用的大冲突文件：约 2 万行、9 处冲突，覆盖逐处处理的各种形态——
 * 多行改写、两侧相同（简单冲突）、仅空白不同、带共同祖先（diff3）且一侧未改动、
 * 超长行、文件末尾的冲突。ours/theirs 是两侧完整版本，result 是带标记的工作区文件。
 */
function bigConflict(): { ours: string; theirs: string; result: string } {
  const ours: string[] = [];
  const theirs: string[] = [];
  const result: string[] = [];
  const common = (count: number, seed: number) => {
    for (let index = 0; index < count; index += 1) {
      const line = index % 9 === 0 ? "" : `  const value${seed}_${index} = compute("merge.ts", ${seed}, ${index});`;
      ours.push(line);
      theirs.push(line);
      result.push(line);
    }
  };
  const conflict = (a: string[], b: string[], base: string[] | null = null) => {
    ours.push(...a);
    theirs.push(...b);
    result.push("<<<<<<< HEAD", ...a);
    if (base) result.push("||||||| merged common ancestors", ...base);
    result.push("=======", ...b, ">>>>>>> main");
  };
  result.push("// merge.ts —— 预览数据");
  ours.push("// merge.ts —— 预览数据");
  theirs.push("// merge.ts —— 预览数据");
  common(40, 0);
  conflict(
    ["export function createView(options: ViewOptions) {", '  const mode = "workspace";', "  const size = 12;", '  const sidebar = "expanded";'],
    ["export function createView(options: ViewOptions, extra?: ViewExtra) {", '  const mode = "review";', "  const size = 14;", '  const sidebar = "compact";', "  const density = extra?.density ?? 1;"],
  );
  common(2400, 1);
  conflict(['import { render } from "./render";'], ['import { render } from "./render";']);
  common(3100, 2);
  conflict(["    return  { ok: true, value };"], ["    return { ok: true, value };"]);
  common(1800, 3);
  conflict(
    ["  retries: 3,", "  timeoutMs: 5000,"],
    ["  retries: 5,", "  timeoutMs: 5000,", "  backoff: \"exponential\","],
    ["  retries: 3,", "  timeoutMs: 5000,"],
  );
  common(4200, 4);
  conflict(
    ['  logger.info("merge finished", { files: result.files.length, conflicts: result.conflicts.length, durationMs: Date.now() - started, source: options.source, target: options.target });'],
    ['  logger.debug("merge finished", { files: result.files.length, conflicts: result.conflicts.length, durationMs: performance.now() - started, source: options.source, target: options.target, strategy: options.strategy });'],
  );
  common(2600, 5);
  conflict(
    ["function resolveAll(entries: Entry[]) {", "  for (const entry of entries) {", "    apply(entry);", "  }", "}"],
    ["async function resolveAll(entries: Entry[], signal: AbortSignal) {", "  for (const entry of entries) {", "    if (signal.aborted) return;", "    await apply(entry);", "  }", "}"],
  );
  common(3300, 6);
  conflict(["export const VERSION = \"2.3.0\";"], ["export const VERSION = \"2.4.0-beta.1\";"], ["export const VERSION = \"2.2.0\";"]);
  common(1500, 7);
  conflict(["  // 合并完成后刷新缓存", "  cache.clear();"], ["  // 合并完成后只失效相关条目", "  cache.invalidate(result.paths);"]);
  common(12, 8);
  conflict(["export default createView;"], ["export default createView;", "export { resolveAll };"]);
  const join = (lines: string[]) => `${lines.join("\n")}\n`;
  return { ours: join(ours), theirs: join(theirs), result: join(result) };
}
const BIG_CONFLICT = bigConflict();

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
  // 有多语言样本的文件用真实感代码，便于看语法高亮与行内改动标记；其余沿用 90 行的长夹具。
  const sample = sampleFor(path);
  if (sample) {
    const diff = createTextDiff(path, sample.before, sample.after, generation);
    const sampleHunks = diff.lines
      .map((line, start) => ({ line, start }))
      .filter(({ line }) => line.kind === "hunk")
      .map(({ line, start }, hunkIndex, all) => ({
        index: hunkIndex,
        header: line.text,
        complete: true,
        stageable: true,
        startLine: start,
        lineCount: (all[hunkIndex + 1]?.start ?? diff.lines.length) - start,
      }));
    let current = -1;
    const lines = diff.lines.map((line) => {
      if (line.kind === "hunk") current += 1;
      return { ...line, hunkIndex: current };
    });
    return { ...diff, staged, hunks: sampleHunks, lines, totalLines: lines.length, snapshot: `sample-${path}` };
  }
  const lines: DiffLine[] = [];
  const hunks = [];
  const name = path.split("/").pop() ?? path;
  let index = 0;
  // 9 段 × 10 行 = 90 行：R3 要求 1280×840 下差异视口完整可见 ≥40 行，
  // 夹具必须多于该阈值，才能在预览里直接数 [data-diff-row]，而不是靠容量推算。
  for (let h = 0; h < 9; h += 1) {
    const start = lines.length;
    const base = h * 40 + 10;
    lines.push({ kind: "hunk", text: `@@ -${base},8 +${base},9 @@ ${path} · section${h}`, oldNo: null, newNo: null, hunkIndex: index });
    for (let i = 0; i < 3; i += 1) lines.push({ kind: "context", text: `   const value${i} = compute("${name}", ${i});`, oldNo: base + i, newNo: base + i, hunkIndex: index });
    lines.push({ kind: "del", text: `-  return legacyRender("${path}", value0);`, oldNo: base + 3, newNo: null, hunkIndex: index });
    lines.push({ kind: "add", text: `+  const view = render("${path}", { theme: "modern" });`, oldNo: null, newNo: base + 3, hunkIndex: index });
    lines.push({ kind: "add", text: `+  return view.mount("${name}");`, oldNo: null, newNo: base + 4, hunkIndex: index });
    for (let i = 0; i < 3; i += 1) lines.push({ kind: "context", text: `   const context${i} = normalize(value${i}, "${name}");`, oldNo: base + 4 + i, newNo: base + 5 + i, hunkIndex: index });
    hunks.push({ index, header: lines[start].text, complete: true, stageable: h < 8, startLine: start, lineCount: lines.length - start });
    index += 1;
  }
  return {
    generation, path, staged, binary: false, text: null,
    summary: "新增 18 行，删除 9 行。", additions: 18, deletions: 9, complete: true, truncated: false,
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

let mockTags = [
  { name: "v0.1.0", targetOid: commits[3].oid, message: "首个公开测试版本", createdAt: commits[3].authoredAt },
  { name: "v0.2.0-rc.1", targetOid: commits[1].oid, message: "现代化工作区候选版本", createdAt: commits[1].authoredAt },
];

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

function branchData() {
  return { generation, branches: branches.map((item) => ({ ...item })), snapshot: snapshot() };
}

let stashRecords = [
  { oid: "c0ffee1234567890c0ffee1234567890c0ffee12", message: "WIP: 顶栏布局实验", committedAt: now - 7200 },
  { oid: "deadbeef34567890deadbeef34567890deadbeef", message: "", committedAt: now - 86400 * 2 },
];

function stashData(include: boolean) {
  const trackedPaths = files.filter((item) => !item.untracked && !item.unmerged).map((item) => item.path);
  const untrackedPaths = files.filter((item) => item.untracked).map((item) => item.path);
  const canSave = trackedPaths.length > 0 || (include && untrackedPaths.length > 0);
  return {
    generation,
    preview: {
      trackedCount: trackedPaths.length,
      untrackedCount: untrackedPaths.length,
      ignoredCount: 1,
      trackedPaths,
      untrackedPaths,
      ignoredPaths: ["debug.log"],
      includeUntracked: include,
      canSave,
      summary: `将保存已跟踪的暂存和未暂存改动 ${trackedPaths.length} 个。未跟踪文件 ${untrackedPaths.length} 个${include ? "会一并保存" : "这次不保存"}。忽略文件 1 个不会保存。`,
    },
    records: stashRecords.map((item) => ({ ...item })),
    snapshot: snapshot(),
  };
}

let mergeOperation = "merge";

function mergeData() {
  const conflicts = files.filter((item) => item.unmerged).map((item) => ({ path: item.path, kind: "text", summary: "文本" }));
  const active = mergeOperation === "merge";
  const sourceName = branch.name === "main" ? "feature/modern-ui" : "main";
  return {
    generation,
    operation: mergeOperation,
    canContinue: active && conflicts.length === 0,
    canAbort: active,
    source: active ? sourceName : null,
    target: branch.name,
    headOid: branch.headOid,
    conflicts,
    unresolved: conflicts.length,
    note: active
      ? conflicts.length > 0
        ? `正在把 ${sourceName} 合并到 ${branch.name}，还有 ${conflicts.length} 个文件需要处理。`
        : "所有冲突都已标记，可以检查并完成合并。"
      : "当前没有进行中的合并。",
    snapshot: snapshot(),
  };
}

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
  branchState: () => ok(branchData()),
  createBranch: (_repo: string, name: string) => {
    if (!branches.some((item) => item.name === name)) {
      branches.push({ name, remote: false, current: false, upstream: null, worktree: null });
    }
    generation += 1;
    return ok(branchData());
  },
  createBranchFrom: (_repo: string, name: string, _start: string, checkout: boolean) => {
    if (!branches.some((item) => !item.remote && item.name === name)) {
      branches.push({ name, remote: false, current: false, upstream: null, worktree: null });
    }
    if (checkout) {
      for (const item of branches) item.current = !item.remote && item.name === name;
      branch.name = name;
      branch.upstream = null;
      branch.ahead = 0;
      branch.behind = 0;
    }
    generation += 1;
    return ok(branchData());
  },
  renameBranch: (_repo: string, oldName: string, newName: string) => {
    const target = branches.find((item) => !item.remote && item.name === oldName);
    if (target) target.name = newName;
    if (branch.name === oldName) branch.name = newName;
    generation += 1;
    return ok(branchData());
  },
  revealPath: () => ok(undefined),
  openPath: () => ok(undefined),
  ignorePath: (_repo: string, pattern: string) => {
    const needle = pattern.replace(/^\//, "").replace(/^\*/, "");
    files = files.filter((item) => item.unmerged || !(item.untracked && item.path.endsWith(needle)));
    generation += 1;
    return ok(snapshot());
  },
  switchBranch: (_repo: string, name: string) => {
    const selected = branches.find((item) => item.name === name);
    const localName = selected?.remote ? name.slice(name.indexOf("/") + 1) : name;
    let local = branches.find((item) => !item.remote && item.name === localName);
    if (!local) {
      local = { name: localName, remote: false, current: false, upstream: selected?.remote ? name : null, worktree: null };
      branches.push(local);
    }
    for (const item of branches) item.current = item === local;
    branch.name = localName;
    branch.upstream = local.upstream;
    branch.ahead = 0;
    branch.behind = 0;
    generation += 1;
    return ok(branchData(), 250);
  },
  deleteBranch: (_repo: string, name: string) => {
    const index = branches.findIndex((item) => !item.remote && !item.current && item.name === name);
    if (index >= 0) branches.splice(index, 1);
    generation += 1;
    return ok(branchData());
  },
  deleteRemoteBranch: (_repo: string, _remote: string, name: string) => {
    const index = branches.findIndex((item) => item.remote && item.name === name);
    if (index >= 0) branches.splice(index, 1);
    generation += 1;
    return ok(branchData());
  },
  tagState: () => ok({ generation, tags: mockTags.map((item) => ({ ...item })), snapshot: snapshot() }),
  createTag: (_repo: string, name: string, target: string, message: string) => {
    const targetOid = target === "HEAD" ? commits[0].oid : (commits.find((item) => item.oid.startsWith(target))?.oid ?? commits[0].oid);
    mockTags = mockTags.filter((item) => item.name !== name);
    mockTags.push({ name, targetOid, message, createdAt: Math.floor(Date.now() / 1000) });
    mockTags.sort((a, b) => a.name.localeCompare(b.name));
    generation += 1;
    return ok({ generation, tags: mockTags.map((item) => ({ ...item })), snapshot: snapshot() });
  },
  deleteTag: (_repo: string, name: string) => {
    mockTags = mockTags.filter((item) => item.name !== name);
    generation += 1;
    return ok({ generation, tags: mockTags.map((item) => ({ ...item })), snapshot: snapshot() });
  },
  pushTag: () => {
    generation += 1;
    return ok({ generation, tags: mockTags.map((item) => ({ ...item })), snapshot: snapshot() });
  },
  historyPage: (_repo: string, query: string, offset: number) => {
    const needle = query.trim().toLowerCase();
    const matched = commits.filter((item) => !needle || item.summary.toLowerCase().includes(needle) || item.authorName.toLowerCase().includes(needle) || item.oid.toLowerCase().startsWith(needle));
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
  stashState: (_repo: string, include: boolean) => ok(stashData(include)),
  saveStash: (_repo: string, include: boolean, message: string) => {
    const oid = "12345678abcdef12345678abcdef12345678abcd";
    stashRecords.unshift({ oid, message, committedAt: now });
    files = [];
    generation += 1;
    return ok({ oid, note: "当前改动已临时保存，工作区已恢复干净。", state: stashData(include) });
  },
  applyStash: (_repo: string, oid: string) => {
    if (files.length === 0) files = [file("src/lib/restored.ts", "none", "none", { untracked: true })];
    generation += 1;
    return ok({ generation, oid, kept: true, operation: "none", conflicted: false, conflictPaths: [], canAbortMerge: false, note: "临时保存已恢复，原记录仍保留。", snapshot: snapshot() });
  },
  deleteStash: (_repo: string, oid: string) => {
    stashRecords = stashRecords.filter((item) => item.oid !== oid);
    generation += 1;
    return ok(stashData(false));
  },
  mergePreview: (_repo: string, source: string) => {
    const localPaths = files.map((item) => item.path);
    const canStart = localPaths.length === 0;
    return ok({ generation, source, target: branch.name, headOid: branch.headOid, dirty: !canStart, localPaths, canStart, operation: mergeOperation, note: canStart ? "工作区干净，可以开始合并。确认前不会写入。" : `工作区有 ${localPaths.length} 处未提交改动。合并前请先提交或临时保存。未开始合并。` });
  },
  startMerge: () => {
    mergeOperation = "merge";
    generation += 1;
    return ok(mergeData());
  },
  mergeSession: () => ok(mergeData()),
  conflictView: (_repo: string, path: string) => {
    if (path.endsWith(".png")) {
      return ok({
        generation, path, kind: "binary", editable: false,
        ours: { present: true, binary: true, truncated: false, text: null, summary: "本地版本是二进制，不显示伪文本。" },
        theirs: { present: true, binary: true, truncated: false, text: null, summary: "另一分支版本是二进制，不显示伪文本。" },
        result: { present: true, binary: true, truncated: false, text: null, summary: "当前合并结果是二进制。" },
        note: "这是二进制冲突，不能按文本合并。请明确保留本地版本或另一分支版本。",
      });
    }
    if (path.endsWith(".css")) {
      const ours = ":root {\n  --accent: #0e7c55;\n  --radius: 11px;\n}\n\n.button {\n  padding: 0 14px;\n}\n";
      const theirs = ":root {\n  --accent: #10a37f;\n  --radius: 12px;\n}\n\n.button {\n  padding: 0 16px;\n}\n";
      const result = ":root {\n<<<<<<< HEAD\n  --accent: #0e7c55;\n  --radius: 11px;\n||||||| base\n  --accent: #0e7c55;\n  --radius: 10px;\n=======\n  --accent: #10a37f;\n  --radius: 12px;\n>>>>>>> main\n}\n\n.button {\n<<<<<<< HEAD\n  padding: 0 14px;\n=======\n  padding: 0 16px;\n>>>>>>> main\n}\n";
      return ok({
        generation, path, kind: "text", editable: true,
        ours: { present: true, binary: false, truncated: false, text: ours, summary: "本地" },
        theirs: { present: true, binary: false, truncated: false, text: theirs, summary: "另一侧" },
        result: { present: true, binary: false, truncated: false, text: result, summary: "结果" },
        note: "可以编辑合并结果。标记后只解决这个文件，其他冲突保持不变。",
      });
    }
    return ok({
      generation, path, kind: "text", editable: true,
      ours: { present: true, binary: false, truncated: false, text: BIG_CONFLICT.ours, summary: "本地" },
      theirs: { present: true, binary: false, truncated: false, text: BIG_CONFLICT.theirs, summary: "另一侧" },
      result: { present: true, binary: false, truncated: false, text: BIG_CONFLICT.result, summary: "结果" },
      note: "可以编辑合并结果。标记后只解决这个文件，其他冲突保持不变。",
    });
  },
  resolveConflict: (_repo: string, path: string) => {
    files = files.map((item) => item.path === path ? { ...item, staged: "modified", unstaged: "none", untracked: false, unmerged: false } : item);
    generation += 1;
    return ok(mergeData());
  },
  completeMerge: () => {
    mergeOperation = "none";
    branch.ahead += 1;
    generation += 1;
    return ok({ oid: "merge1234567890", generation, summary: "已完成合并 merge123", files: [], snapshot: snapshot() });
  },
  abortMerge: (_repo: string, confirm: boolean) => {
    if (confirm) {
      files = files.filter((item) => !item.unmerged);
      mergeOperation = "none";
      generation += 1;
    }
    return ok({ generation, wrote: confirm, paths: ["src/lib/merge.ts"], stashOids: [], note: confirm ? "已中止合并并恢复合并前状态。" : "中止将撤销本次合并中的冲突编辑，其他仓库内容保持不变。", snapshot: snapshot() });
  },
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
