// 仅用于浏览器里预览界面（npm run preview:ui）。不会进入 Tauri 构建，也不代表真实 Git 行为。
import type {
  BranchRecord,
  DiffLine,
  DiffResponse,
  FileChange,
  HistoryCommit,
  OpenedRepository,
  PreviewSources,
  StatusSnapshot,
  TerminalSnapshot,
  Theme,
} from "../../src/lib/types";
import { createTextDiff } from "../../src/lib/diff";

/** 预览 mock 的自我标识：健康端点和回归测试靠它确认浏览器拿到的是 mock，而不是真实 Tauri api。 */
export const UI_PREVIEW_MOCK = true;

/* 预览里终端固定走 DOM 渲染器：场景断言靠 DOM 文本核对输出与回显，headless Chrome 的
   SwiftShader WebGL 会让 .xterm-rows 为空。真实 Tauri 窗口没有这个标记，仍按可用性用 WebGL。 */
(window as unknown as { __uiPreviewDomTerminal?: boolean }).__uiPreviewDomTerminal = true;
import { sampleFor } from "./samples";
import { mockContentSearch, mockDirectory, mockDocument, mockDocumentResource, mockEditSave, mockEditSnapshot, mockFilePage, mockPathSearch } from "./mock-files";

const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const now = Math.floor(Date.now() / 1000);

/**
 * 进入预览 mock 平时到不了的状态：?switch=fail 让切换分支失败，?diff=paged 让差异续读挂住 8 秒，
 * ?git=missing / ?git=old 模拟 Git 缺失或低于基线，?recent=empty 清空最近仓库，?recent=many 模拟 500 个最近仓库。
 * ?conflict=modify-delete 把 .css 冲突换成 200 行的修改/删除冲突，?eol=crlf 把冲突文本换成 CRLF，
 * 写回的内容记在 window.__resolved，用来在真实 textarea 上核对字节；window.__mergePreviews 记预检次数。
 * ?doc=error / ?doc=large / ?doc=stale 切换只读文档读取的失败、超限与过期分支；
 * ?commitdoc=1 给提交详情补一个 README.md，用来走「历史差异 → 阅读文档」入口（默认数据不变）。
 * ?remote=unchecked / ?remote=stale 让远程核对状态停在「从未核对」或「缓存已过期」：
 * 折叠状态的同步按钮必须自己写明这件事，不能把缓存计数当成刚刚验证过的远程状态（R3）。
 * ?commit=error 让本地提交被钩子拒绝，?commit=push 让本地提交成功、推送失败；
 * 两者的失败文本都足够长，用来核对提交区的「展开」换行读全与「只重试推送」（R3/R6）。
 * ?task=error / ?task=empty 让任务范围读取失败或成功但为空；?worktree=stale / ?worktree=error
 * 让工作区总览出现「远程过期」的一项或整批失败；?history=hang 让最新的两条提交详情永不返回
 * （复现「旧批次挂住、换选择还要能读」），?history=detail-error 让多选详情全部失败。
 * 轻量编辑：?edit=conflict 让保存一律返回 edit_conflict（草稿保留），?edit=fail 让保存写入失败，
 * ?edit=mixed 让编辑快照判为混合行尾只读。保存成功只改写 mock 内存，不代表真实文件写入。
 */
const previewParams = new URLSearchParams(location.search);
const healthyGit = { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" };
const previewGit = {
  missing: { available: false, path: null, version: null, overridden: false, belowBaseline: false, message: "没有找到 Git，请安装后重新检测" },
  old: { available: true, path: "/usr/bin/git", version: "2.30.1", overridden: false, belowBaseline: true, message: "Git 2.30.1 低于 2.48 基线，请升级" },
}[previewParams.get("git") ?? ""] ?? healthyGit;

let generation = 1;
let theme: Theme = (localStorage.getItem("preview-theme") as Theme) || "dark";
let recent = [
  { name: "twiglane", path: "C:/Users/dev/project/twiglane", openedAtMs: Date.now() },
  { name: "design-system", path: "C:/Users/dev/work/design-system", openedAtMs: Date.now() - 1000 },
  { name: "api-gateway", path: "D:/code/backend/api-gateway", openedAtMs: Date.now() - 2000 },
  { name: "demo", path: "/work/alpha/demo", openedAtMs: Date.now() - 3000 },
  { name: "demo", path: "/work/beta/demo", openedAtMs: Date.now() - 4000 },
];
if (previewParams.get("recent") === "empty") recent = [];
if (previewParams.get("recent") === "many") {
  // 每 50 个有一组同名仓库，路径够长才能看出完整路径折行。
  for (let index = recent.length; index < 500; index += 1) {
    const name = index % 50 === 0 ? "demo" : `repo-${String(index).padStart(3, "0")}`;
    const group = index % 50 === 0 ? `clients/${index}/a-rather-long-directory-name/that-keeps-going/and-going/for-a-while` : `group-${index % 7}`;
    recent.push({ name, path: `/work/${group}/${name}`, openedAtMs: Date.now() - index * 1000 });
  }
}

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
  file("public/logo.png", "none", "modified", { unstagedLines: { additions: null, deletions: null, oldSize: 18_432, newSize: 21_870 } }),
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
      const line =
        index % 9 === 0
          ? ""
          : index === 2 && seed === 0
            ? `  // ${"未冲突的超长行：确认结果预览也能滚到行尾，".repeat(16)}CTX-END`
            : `  const value${seed}_${index} = compute("merge.ts", ${seed}, ${index});`;
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
    ["export function createView(options: ViewOptions) {", '  const mode = "workspace";', "  const size = 12;", '  const sidebar = "expanded";', `  // 当前：${"这一侧的中文长行短一些，".repeat(14)}OURS-END`],
    ["export function createView(options: ViewOptions, extra?: ViewExtra) {", '  const mode = "review";', "  const size = 14;", '  const sidebar = "compact";', "  const density = extra?.density ?? 1;", `  // 来源：${"这一侧的中文长行更长一些，用来确认两栏按较宽的一栏计算行程，".repeat(10)}THEIRS-END`],
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

/*
 * 默认数据是「刚核对过远程」；?remote=unchecked 表示从未核对（没有可信时间），
 * ?remote=stale 表示上一次核对已经过期。两者都必须保留原来的计数，界面要说明计数只是记录的对比。
 */
const remoteMode = previewParams.get("remote");
const branch = {
  name: "feature/modern-ui",
  detached: false,
  unborn: false,
  headOid: "8f3c2a1d9b7e6f5a4c3b2a1908f7e6d5c4b3a291",
  upstream: "origin/feature/modern-ui",
  ahead: 2,
  behind: 1,
  liveRemoteChecked: remoteMode !== "unchecked" && remoteMode !== "stale",
  remoteCheckedAtMs: remoteMode === "unchecked"
    ? null
    : remoteMode === "stale"
      ? Date.now() - 3 * 60 * 60_000
      : Date.now() - 60_000,
  remoteCheckStale: remoteMode === "stale",
};

/** ?commit=error / ?commit=push 共用的长失败说明：超过提交区单行阈值，必须能展开读全。 */
const COMMIT_FAILURE = "pre-commit 钩子拒绝提交：scripts/check-commit-msg.mjs 报告提交说明首行超过 72 个字符（实际 96 个），"
  + "并且 tools/lint 与 src/styles/tokens.css 的检查没有通过。请修改说明或修复上述检查后重试；草稿与已暂存内容都还在。";
const PUSH_FAILURE = "无法连接到远程 origin：fatal: unable to access 'https://github.com/example/twiglane.git/': "
  + "Failed to connect to github.com port 443 after 21008 ms: Couldn't connect to server。"
  + "远程可能不可达或需要代理；本地提交已经完成，重试只会再次推送，不会创建第二个提交。";

function snapshot(): StatusSnapshot {
  return { generation, branch: { ...branch }, files: files.map((item) => ({ ...item })) };
}

function opened(path: string): OpenedRepository {
  const name = path.split(/[\\/]/).pop() ?? path;
  return { summary: { name, path }, generation, snapshot: snapshot(), draft: "", watchDegraded: false };
}

/** 与原生 changes/history 同一形状的 Markdown 前后版本来源：非 Markdown 不给。 */
function markdownSides(repo: string, path: string, oldPath: string, staged: boolean, oldRevision = ""): PreviewSources | undefined {
  if (!/\.(md|markdown|mdown|rmd)$/i.test(path)) return undefined;
  return {
    repository: repo,
    old: { revision: oldRevision || (staged ? "HEAD" : "index"), path: oldPath },
    new: { revision: staged ? "index" : "worktree", path },
  };
}

function diffFor(path: string, staged: boolean): DiffResponse {
  if (path.endsWith(".png")) {
    return { generation, path, staged, binary: true, text: null, summary: "二进制文件有变化：18 KB → 21 KB。", additions: 0, deletions: 0, complete: true, truncated: false, snapshot: "s", hunks: [], lines: [], offset: 0, totalLines: 0, oldSize: 18_432, newSize: 21_870 };
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
    // 第一段带超长行（含中文），预览里用来核对横向滚动能到行尾。
    if (h === 0) lines[lines.length - 1].text = `   // ${"长行样本：确认中文全角字符也能滚到行尾，".repeat(16)}CJK-END`;
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

/** 真实后端的差异带 Git 文件头（diff --git / index / --- / +++），预览也带上，界面负责隐藏。 */
function withHeaders(diff: DiffResponse): DiffResponse {
  if (diff.binary) return diff;
  const head: DiffLine[] = [
    { kind: "meta", text: `diff --git a/${diff.path} b/${diff.path}`, oldNo: null, newNo: null, hunkIndex: null },
    { kind: "meta", text: "index 833f1f8..b476ae7 100644", oldNo: null, newNo: null, hunkIndex: null },
    { kind: "meta", text: `--- a/${diff.path}`, oldNo: null, newNo: null, hunkIndex: null },
    { kind: "meta", text: `+++ b/${diff.path}`, oldNo: null, newNo: null, hunkIndex: null },
  ];
  return {
    ...diff,
    lines: [...head, ...diff.lines],
    hunks: diff.hunks.map((hunk) => ({ ...hunk, startLine: hunk.startLine + head.length })),
    totalLines: diff.totalLines + head.length,
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
const commitOid = (i: number) => (i.toString(16).padStart(4, "0") + "a9c3e1f2b4d6".repeat(4)).slice(0, 40);
/* 父提交指向真实存在的下一条提交，拓扑才是连起来的一条主线；第 5 条是合并提交，
   第二父提交落在后面第 8 条，画出一段并行分支后汇回主线。最后一条超出一页的父提交按结果外处理。 */
const commits: HistoryCommit[] = Array.from({ length: 60 }, (_, i) => ({
  oid: commitOid(i),
  parents: i === 5 ? [commitOid(6), commitOid(8)] : [commitOid(i + 1)],
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
  { name: "v0.3.0-dev", targetOid: commits[0].oid, message: "", createdAt: commits[0].authoredAt },
];

const branches: BranchRecord[] = [
  { name: "feature/modern-ui", remote: false, current: true, upstream: "origin/feature/modern-ui", worktree: null },
  { name: "main", remote: false, current: false, upstream: "origin/main", worktree: null },
  { name: "fix/merge-refresh", remote: false, current: false, upstream: null, worktree: "C:/Users/dev/wt/fix" },
  { name: "origin/main", remote: true, current: false, upstream: null, worktree: null },
  { name: "origin/feature/modern-ui", remote: true, current: false, upstream: null, worktree: null },
  // 已合入主干（main 与 origin/main 都包含），本地与远程同名：用来预览「已合入」标记和「同时删除远程分支」。
  { name: "feature/login", remote: false, current: false, upstream: "origin/feature/login", worktree: null, merged: true },
  { name: "origin/feature/login", remote: true, current: false, upstream: null, worktree: null, merged: true },
];

const ok = async <T>(value: T, ms?: number) => {
  await wait(ms);
  return value;
};

/**
 * 本地提交在 mock 里的落地效果：已提交的暂存项离开改动列表，领先计数前进一位，代次递增。
 * 「提交到本地」和「提交并推送」的本地那一步共用它，两条路径提交后的界面状态才会一致。
 */
function applyLocalCommit(): void {
  files = files
    .filter((item) => item.unstaged !== "none" || item.untracked || item.unmerged)
    .map((item) => ({ ...item, staged: item.unmerged ? item.staged : "none" }));
  generation += 1;
  branch.ahead += 1;
}

/** 远程操作：可以被 cancelRemote 中途停下，用来预览「取消」。 */
let remoteAbort: (() => void) | null = null;
function slowRemote<T>(finish: () => T, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      remoteAbort = null;
      resolve(finish());
    }, ms);
    remoteAbort = () => {
      clearTimeout(timer);
      remoteAbort = null;
      reject({ code: "cancelled", generation, message: `已取消${label}。远程可能已经收到部分请求，请以刷新后的状态为准。` });
    };
  });
}

// 默认覆盖已推送、未推送、远程不同三种状态；?tags=offline 模拟读不到远程。
const remoteTagOids = new Map([
  ["v0.1.0", commits[3].oid],
  ["v0.2.0-rc.1", commits[0].oid],
]);

function branchData() {
  return { generation, branches: branches.map((item) => ({ ...item })), snapshot: snapshot(), defaultBranch: "main", mergeBases: ["main", "origin/main"] };
}

let stashRecords = [
  { oid: "c0ffee1234567890c0ffee1234567890c0ffee12", message: "WIP: 顶栏布局实验", committedAt: now - 7200 },
  { oid: "deadbeef34567890deadbeef34567890deadbeef", message: "", committedAt: now - 86400 * 2 },
];

function stashData(include: boolean) {
  const many = previewParams.get("stash") === "many";
  const allTracked = many
    ? Array.from({ length: 3200 }, (_, index) => `src/generated/feature-${index % 40}/module-${index}.ts`)
    : files.filter((item) => !item.untracked && !item.unmerged).map((item) => item.path);
  const trackedPaths = allTracked.slice(0, 200);
  const untrackedPaths = files.filter((item) => item.untracked).map((item) => item.path);
  const canSave = trackedPaths.length > 0 || (include && untrackedPaths.length > 0);
  return {
    generation,
    preview: {
      trackedCount: allTracked.length,
      untrackedCount: untrackedPaths.length,
      ignoredCount: 1,
      trackedPaths,
      untrackedPaths,
      ignoredPaths: ["debug.log"],
      includeUntracked: include,
      canSave,
      summary: `将保存已跟踪的暂存和未暂存改动 ${allTracked.length} 个。未跟踪文件 ${untrackedPaths.length} 个${include ? "会一并保存" : "这次不保存"}。忽略文件 1 个不会保存。`,
    },
    records: stashRecords.map((item) => ({ ...item })),
    snapshot: snapshot(),
  };
}

// 预览默认从「没有进行中的合并」开始；URL 带 ?merge=conflict 时直接进入冲突处理。
let mergeOperation = new URLSearchParams(location.search).get("merge") === "conflict" ? "merge" : "none";
let mergeSourceName = "main";

function mergeData() {
  const conflicts = files.filter((item) => item.unmerged).map((item) => ({ path: item.path, kind: "text", summary: "文本" }));
  const active = mergeOperation === "merge";
  const sourceName = mergeSourceName;
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

/**
 * 预览事件总线：真实后端用 Tauri emit，这里用内存监听表。
 * 终端输出/退出事件因此能在浏览器里驱动同一个 TerminalPanel，而不是只有静态快照。
 */
type PreviewEventListener = (payload: unknown) => void;
const previewListeners = new Map<string, Set<PreviewEventListener>>();

export async function listenEvent<T>(name: string, handler: (payload: T) => void): Promise<() => void> {
  const listeners = previewListeners.get(name) ?? new Set<PreviewEventListener>();
  previewListeners.set(name, listeners);
  listeners.add(handler as PreviewEventListener);
  return () => {
    listeners.delete(handler as PreviewEventListener);
  };
}

function emitPreviewEvent(name: string, payload: unknown) {
  for (const listener of [...(previewListeners.get(name) ?? [])]) listener(payload);
}
/** 预览没有 Tauri 运行时：版本号未知，设置里的应用更新分区按不可用展示。 */
export async function appVersion() {
  return null;
}
export async function pickDirectory() {
  return "C:/Users/dev/project/new-repo";
}
export async function pickFile() {
  return null;
}

/*
 * 终端预览：只在 mock 内存里模拟按仓库一个会话。
 * ?terminal=error 让启动失败，?terminal=exited 让打开时已是退出状态（可重新启动），
 * ?terminal=write 让写入失败。默认回显输入，输入 exit 回车后给出退出码 0。
 * 这里不执行任何真实命令，也不能替代桌面 PTY 行为。
 */
interface PreviewTerminal {
  sessionId: string;
  repoPath: string;
  profile: string;
  label: string;
  shell: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  seq: number;
  output: string;
  line: string;
}

const terminalMode = previewParams.get("terminal") ?? "";
const terminalById = new Map<string, PreviewTerminal>();
let terminalSerial = 0;

function terminalEmitOutput(session: PreviewTerminal, data: string) {
  if (!data) return;
  session.output += data;
  session.seq += 1;
  emitPreviewEvent("terminal-output", { sessionId: session.sessionId, seq: session.seq, data });
}

function terminalEmitExit(session: PreviewTerminal, exitCode: number) {
  if (!session.running) return;
  session.running = false;
  session.exitCode = exitCode;
  session.seq += 1;
  emitPreviewEvent("terminal-exit", { sessionId: session.sessionId, seq: session.seq, exitCode, signal: null });
}

function terminalSnapshot(session: PreviewTerminal): TerminalSnapshot {
  return {
    sessionId: session.sessionId,
    repoPath: session.repoPath,
    profile: session.profile,
    label: session.label,
    shell: session.shell,
    cwd: session.cwd,
    running: session.running,
    exitCode: session.exitCode,
    signal: session.signal,
    seq: session.seq,
    output: session.output,
  };
}

const PREVIEW_LABELS: Record<string, string> = { pwsh: "PowerShell", cmd: "命令提示符", "git-bash": "Git Bash" };

function createPreviewTerminal(path: string, running = true, profile: string | null = null): PreviewTerminal {
  terminalSerial += 1;
  const id = profile && PREVIEW_LABELS[profile] ? profile : "pwsh";
  const session: PreviewTerminal = {
    sessionId: `preview-terminal-${terminalSerial}`,
    repoPath: path,
    profile: id,
    label: PREVIEW_LABELS[id],
    shell: "preview-shell",
    cwd: path,
    running,
    exitCode: running ? null : 1,
    signal: null,
    seq: 0,
    output: "",
    line: "",
  };
  terminalById.set(session.sessionId, session);
  terminalEmitOutput(
    session,
    "Twiglane 终端预览（mock 数据，不执行真实命令）\r\n" +
      `\x1b[2m工作目录：${path}\x1b[0m\r\n` +
      "\x1b[32m✔\x1b[0m \x1b[1mready\x1b[0m  \x1b[33mwarn\x1b[0m  \x1b[31merror\x1b[0m  \x1b[34minfo\x1b[0m  \x1b[35mdebug\x1b[0m  \x1b[36mtrace\x1b[0m  \x1b[93mnpm\x1b[0m  \x1b[90mhint\x1b[0m\r\n" +
      (running ? "$ " : "进程已退出，退出码 1。\r\n$ "),
  );
  return session;
}

function terminalReply(session: PreviewTerminal, data: string) {
  if (!session.running) return;
  if (data.includes("\u0003")) {
    terminalEmitOutput(session, "^C\r\n$ ");
    session.line = "";
    return;
  }
  const text = data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  terminalEmitOutput(session, text);
  for (const char of text) {
    if (char === "\n") {
      const command = session.line.trim();
      session.line = "";
      if (command === "exit") {
        terminalEmitExit(session, 0);
        return;
      }
      if (command === "clear") continue;
      terminalEmitOutput(session, "$ ");
    } else {
      session.line += char;
    }
  }
}

export const api: Record<string, (...args: never[]) => Promise<unknown>> = {
  detectGit: () => ok(previewGit),
  setGitExecutable: () => ok({}),
  clearGitExecutable: () => ok({}),
  getSettings: () =>
    ok({
      theme,
      panelWidths: { sidebar: 264, files: 360 },
      git: previewGit,
      recent,
      settingsWarning: null,
      terminal: { profile: null, fontSize: 13 },
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
  terminalProfiles: () =>
    ok([
      { id: "pwsh", label: "PowerShell", path: "C:/Program Files/PowerShell/7/pwsh.exe" },
      { id: "cmd", label: "命令提示符", path: "C:/Windows/System32/cmd.exe" },
      { id: "git-bash", label: "Git Bash", path: "C:/Program Files/Git/bin/bash.exe" },
    ]),
  terminalList: (path: string) =>
    ok(
      [...terminalById.values()].filter((session) => session.repoPath === path).map((session) => ({ ...terminalSnapshot(session), output: "" })),
      40,
    ),
  terminalCreate: (path: string, profile: string | null) => {
    if (terminalMode === "error") {
      return Promise.reject({ code: "terminal_start", message: "无法启动终端 shell：预览 mock 模拟启动失败。" });
    }
    return ok(terminalSnapshot(createPreviewTerminal(path, terminalMode !== "exited", profile)), 140);
  },
  terminalAttach: (sessionId: string) => {
    const session = terminalById.get(sessionId);
    if (!session) return Promise.reject({ code: "terminal_unknown", message: "终端会话不存在，请重新附着。" });
    return ok(terminalSnapshot(session), 30);
  },
  terminalRestart: (sessionId: string) => {
    const old = terminalById.get(sessionId);
    if (!old) return Promise.reject({ code: "terminal_unknown", message: "终端会话不存在，请重新附着。" });
    terminalById.delete(sessionId);
    return ok(terminalSnapshot(createPreviewTerminal(old.repoPath, true, old.profile)), 120);
  },
  terminalClose: (sessionId: string) => {
    terminalById.delete(sessionId);
    return ok(undefined, 60);
  },
  setTerminalPrefs: (prefs: never) => ok(prefs),
  terminalWrite: (sessionId: string, data: string) => {
    if (terminalMode === "write") {
      return Promise.reject({ code: "terminal_write", message: "无法写入终端：预览 mock 模拟写入失败。" });
    }
    const session = terminalById.get(sessionId);
    if (!session) {
      return Promise.reject({ code: "terminal_unknown", message: "终端会话不存在，请重新附着。" });
    }
    if (!session.running) {
      return Promise.reject({ code: "terminal_closed", message: "终端已退出，无法继续输入。" });
    }
    terminalReply(session, data);
    return ok(undefined, 10);
  },
  terminalResize: () => ok(undefined, 0),
  terminateTerminals: () => {
    const stopped = [...terminalById.values()].filter((session) => session.running);
    for (const session of stopped) {
      terminalEmitOutput(session, "\r\n终端已结束。\r\n");
      terminalEmitExit(session, 0);
    }
    return ok(stopped.map((session) => ({ sessionId: session.sessionId, repoPath: session.repoPath })), 120);
  },
  updateInstallSupported: () => ok(true),
  repoHeads: (paths: string[]) =>
    ok(paths.map((path, index) => ({
      path,
      branch: index % 4 === 3 ? null : ["feature/modern-ui", "main", "develop", ""][index % 4] || "main",
      detached: index % 4 === 3 ? "1a2b3c4" : null,
      missing: index === 2 && !path.includes("/wt/"),
      // 预览里 /wt/ 下的目录扮演 git worktree add 建的附属工作区。
      worktree: path.includes("/wt/"),
      mainPath: path.includes("/wt/") ? "C:/Users/dev/project/twiglane" : null,
    })), 60),
  /**
   * 逐项 worktree 状态总览（R3）。默认数据里就带三类真实状态：正常、未知（读不到未提交状态）、
   * 缺失（目录已经不在）；?worktree=stale 让主仓库落成「远程未核对且已过期」，
   * ?worktree=error 让整批读取失败（界面应说明整批失败而不是把旧数字当新鲜结果）。
   */
  worktreeOverview: (paths: string[]) => {
    const mode = previewParams.get("worktree") ?? "";
    if (mode === "error") return Promise.reject({ code: "overview_failed", message: "读取工作区状态失败：git 命令超时。" });
    const linked = (path: string) => path.includes("/wt/");
    const items = paths.map((path, index) => {
      const main = index === 0;
      const missing = index === 2 && !linked(path);
      const stale = mode === "stale" && main;
      return {
        path,
        mainPath: linked(path) ? "C:/Users/dev/project/twiglane" : null,
        branch: index % 4 === 3 ? null : ["feature/modern-ui", "main", "develop", "main"][index % 4],
        detached: index % 4 === 3 ? "1a2b3c4" : null,
        missing,
        linked: linked(path),
        locked: false,
        recent: true,
        dirty: missing ? null : main ? true : index % 3 === 0 ? null : false,
        changed: missing ? null : main ? 13 : index % 3 === 0 ? null : 2,
        staged: missing ? null : main ? 1 : 0,
        unstaged: missing ? null : main ? 9 : index % 3 === 0 ? null : 2,
        untracked: missing ? null : main ? 3 : 0,
        conflicted: missing ? null : 0,
        upstream: index % 4 === 3 ? null : "origin/feature/modern-ui",
        ahead: missing ? null : main ? 2 : 0,
        behind: missing ? null : main ? 1 : 0,
        liveRemoteChecked: main ? !stale : false,
        remoteCheckedAtMs: main ? (stale ? Date.now() - 3 * 60 * 60_000 : Date.now() - 60_000) : null,
        remoteCheckStale: main ? stale : false,
        status: missing ? "missing" : index % 3 === 0 && !main ? "unknown" : "ready",
        note: missing
          ? "目录已经不在了；这一项只保留最近记录。"
          : index % 3 === 0 && !main
            ? "读取未提交状态失败：索引被另一个进程占用。"
            : "",
        checkedAtMs: missing || (index % 3 === 0 && !main) ? null : Date.now() - 60_000,
      };
    });
    // 枚举出来的附属工作区不一定在最近列表里：这两项只由总览返回，用来核对分组与缺失项。
    items.push(
      {
        path: "C:/Users/dev/project/twiglane/wt/review", mainPath: "C:/Users/dev/project/twiglane",
        branch: "feature/task-review", detached: null, missing: false, linked: true, locked: false, recent: false,
        dirty: true, changed: 4, staged: 0, unstaged: 4, untracked: 1, conflicted: 0,
        upstream: "origin/feature/task-review", ahead: 1, behind: 0,
        liveRemoteChecked: false, remoteCheckedAtMs: null, remoteCheckStale: false,
        status: "ready", note: "未核对远程：领先/落后只反映本地记录。", checkedAtMs: Date.now() - 90_000,
      },
      {
        path: "C:/Users/dev/project/twiglane/wt/locked", mainPath: "C:/Users/dev/project/twiglane",
        branch: "release/2026.11", detached: null, missing: false, linked: true, locked: true, recent: false,
        dirty: null, changed: null, staged: null, unstaged: null, untracked: null, conflicted: null,
        upstream: null, ahead: null, behind: null,
        liveRemoteChecked: false, remoteCheckedAtMs: null, remoteCheckStale: false,
        status: "unknown", note: "这个工作区被锁定，未提交状态没有读取。", checkedAtMs: null,
      },
    );
    return ok({ items, checkedAtMs: Date.now() }, 80);
  },
  removeWorktree: (path: string) => {
    for (const branch of branches) if (branch.worktree === path) branch.worktree = null;
    recent = recent.filter((item) => item.path !== path);
    generation += 1;
    return ok(recent, 400);
  },
  cancelRemote: () => {
    remoteAbort?.();
    return ok(undefined, 0);
  },
  refreshStatus: () => ok(snapshot()),
  loadDiff: (_repo: string, path: string, staged: boolean, _generation: number, _request: number, _original: string | null, offset = 0) => {
    const result = withHeaders(diffFor(path, staged));
    // Markdown 差异带上前后版本来源，界面才有「阅读文档」入口；重命名用旧路径读改动前。
    const document = markdownSides(_repo, path, _original || path, staged);
    if (document) result.document = document;
    if (previewParams.get("diff") !== "paged") return ok(result);
    if (offset === 0) return ok({ ...result, totalLines: result.lines.length + 400 });
    return ok({ ...result, lines: [], hunks: [], offset }, 8000);
  },
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
    if (previewParams.get("commit") === "error") {
      return Promise.reject({ code: "commit_hook", generation, message: COMMIT_FAILURE });
    }
    applyLocalCommit();
    return ok({ oid: "abcdef1234567", generation, branch: branch.name, summary: `已提交 abcdef1：${message.split("\n")[0]}`, files: [], pushed: false, snapshot: snapshot() }, 400);
  },
  commitAndPush: () => {
    if (previewParams.get("commit") === "error") {
      return Promise.reject({ code: "commit_hook", generation, message: COMMIT_FAILURE });
    }
    // 「先提交再推送」和「只提交」在本地那一步是同一件事：不落地这一步，推送失败的界面
    // 就会一边说「本地提交 abc 已完成」、一边留着 3 个文件与旧的领先计数。
    applyLocalCommit();
    return ok({
      committed: true,
      pushed: false,
      retryPush: true,
      oid: "abc",
      branch: branch.name,
      summary: "本地提交已完成，推送失败。",
      pushError: previewParams.get("commit") === "push" ? PUSH_FAILURE : "网络不可用：无法连接到远程。可以稍后只重试推送。",
      generation,
      snapshot: snapshot(),
    }, 500);
  },
  cloneRepository: (_url: string, parent: string, name: string) => ok({ path: `${parent}/${name || "clone"}`, opened: opened(`${parent}/${name || "clone"}`) }, 800),
  remoteState: () => ok({ generation, remotes: [
    { name: "origin", fetchUrl: "https://github.com/example/twiglane.git", pushUrl: null },
    ...(previewParams.get("remotes") === "1" ? [] : [{ name: "upstream", fetchUrl: "https://github.com/upstream/twiglane.git", pushUrl: null }]),
  ], snapshot: snapshot() }),
  pushToRemote: (_repo: string, remote: string) => slowRemote(() => snapshot(), 900, `推送到 ${remote}`),
  addRemote: () => ok({ generation, remotes: [], snapshot: snapshot() }),
  setRemoteUrl: () => ok({ generation, remotes: [], snapshot: snapshot() }),
  fetchRemote: () => ok(snapshot(), 900),
  pullFastForward: () => {
    branch.behind = 0;
    return ok(snapshot(), 700);
  },
  pushBranch: () =>
    slowRemote(() => {
      branch.ahead = 0;
      return snapshot();
    }, previewParams.get("remote") === "slow" ? 30_000 : 700, "推送"),
  publishBranch: () => ok(snapshot()),
  associateUpstream: () => ok(snapshot()),
  branchList: () => ok(branchData()),
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
  ignorePath: (_repo: string, pattern: string, local = false) => {
    const needle = pattern.replace(/^\//, "").replace(/^\*/, "");
    const tracked = files.some((item) => !item.untracked && item.path === needle);
    if (!tracked) {
      files = files.filter((item) => item.unmerged || !(item.untracked && item.path.endsWith(needle)));
    }
    generation += 1;
    const note = tracked
      ? local
        ? "已把规则写入本地排除。规则只对未跟踪文件生效，该文件仍留在改动中，索引和文件内容未改。"
        : "已把规则写入 .gitignore。规则只对未跟踪文件生效，该文件仍留在改动中，索引和文件内容未改。"
      : local
        ? "已把规则写入本地排除。该文件不再进入改动列表，这条规则也不会进入提交。"
        : "已把规则写入 .gitignore。这次修改会出现在改动列表里。";
    return ok({ snapshot: snapshot(), note });
  },
  switchBranch: async (_repo: string, name: string) => {
    if (previewParams.get("switch") === "fail") {
      await wait(250);
      throw { code: "switch_failed", generation, message: "此操作会覆盖未提交的修改，已停止。这些修改仍留在工作区。请先提交，或先临时保存，然后再继续。" };
    }
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
  deleteRemoteBranch: (_repo: string, remote: string, name: string) =>
    slowRemote(() => {
      const index = branches.findIndex((item) => item.remote && (item.name === name || item.name === `${remote}/${name}`));
      if (index >= 0) branches.splice(index, 1);
      generation += 1;
      return branchData();
    }, previewParams.get("remote") === "slow" ? 30_000 : 400, "删除远程分支"),
  setUpstream: (_repo: string, upstream: string) => {
    if (!branches.some((item) => item.remote && item.name === upstream)) {
      return Promise.reject({ code: "upstream_missing", generation, message: `没有远程分支 ${upstream}。上游没有修改。` });
    }
    for (const item of branches) if (!item.remote && item.current) item.upstream = upstream;
    branch.upstream = upstream;
    generation += 1;
    return ok(branchData(), 250);
  },
  trackRemoteAs: (_repo: string, remoteBranch: string, local: string) => {
    if (branches.some((item) => !item.remote && item.name === local)) {
      return Promise.reject({ code: "branch_duplicate", generation, message: "已有同名分支，未再创建一个。" });
    }
    branches.push({ name: local, remote: false, current: false, upstream: remoteBranch, worktree: null });
    for (const item of branches) item.current = !item.remote && item.name === local;
    branch.name = local;
    branch.upstream = remoteBranch;
    generation += 1;
    return ok(branchData(), 250);
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
  tagRemoteState: () => {
    if (previewParams.get("tags") === "offline") return Promise.reject({ code: "tag_remote_failed", message: "无法读取远程标签。 fatal: unable to access remote" });
    return ok([...remoteTagOids].map(([name, oid]) => ({ name, oid })));
  },
  pushTag: (_repo: string, _remote: string, name: string) => {
    const tag = mockTags.find((item) => item.name === name);
    if (tag) remoteTagOids.set(tag.name, tag.targetOid);
    generation += 1;
    return ok({ generation, tags: mockTags.map((item) => ({ ...item })), snapshot: snapshot() });
  },
  historyPage: (_repo: string, query: string, offset: number, _generation?: number, _requestId?: number, filters?: { scope?: string; author?: string; path?: string }) => {
    const needle = query.trim().toLowerCase();
    const author = filters?.author?.trim().toLowerCase() ?? "";
    // 任务范围 range:<起点>：只列起点之后到 HEAD 的提交（mock 里是线性的前几条）。
    const rangeBase = filters?.scope?.startsWith("range:") ? filters.scope.slice("range:".length) : null;
    const rangeEnd = rangeBase ? commits.findIndex((item) => item.oid === rangeBase) : -1;
    const scoped = rangeBase ? commits.slice(0, rangeEnd < 0 ? 0 : rangeEnd) : commits;
    const matched = scoped.filter((item) => {
      const text = !needle || item.summary.toLowerCase().includes(needle) || item.oid.toLowerCase().startsWith(needle);
      const who = !author || item.authorName.toLowerCase().includes(author);
      return text && who;
    });
    return ok({
      generation,
      query,
      offset,
      pageSize: 100,
      hasMore: false,
      state: matched.length ? "ok" : "no_match",
      commits: matched,
      scope: filters?.scope ?? "current",
      branches: ["main"],
      head: "main",
    });
  },
  fileHistory: (_repo: string, path: string, offset: number, _generation?: number, _requestId?: number, filters?: { scope?: string; query?: string }) =>
    ok({
      generation,
      path,
      offset,
      pageSize: 100,
      hasMore: false,
      state: "ok",
      commits: commits.slice(0, 8).filter((item) => !filters?.query || item.summary.toLowerCase().includes(filters.query.toLowerCase())),
      scope: filters?.scope ?? "current",
      branches: ["main"],
      head: "main",
    }),
  commitBranches: (_repo: string, oid: string) => {
    const index = Math.max(0, commits.findIndex((item) => item.oid === oid));
    const list = [
      ...(index < 40 ? [{ name: branch.name, remote: false, current: true }] : []),
      ...(index > 2 ? [{ name: "main", remote: false, current: false }, { name: "origin/main", remote: true, current: false }] : []),
      ...(index % 2 === 0 ? [{ name: "origin/feature/modern-ui", remote: true, current: false }, { name: "upstream/feature/modern-ui", remote: true, current: false }] : []),
      ...(index > 6 ? Array.from({ length: 14 }, (_, n) => ({ name: `release/2026.${n + 1}`, remote: false, current: false })) : []),
    ];
    return ok({ generation, oid, branches: list, total: list.length, current: branch.name }, 350);
  },
  compareFileDiff: (_repo: string, _base: string, _head: string, path: string) => ok(withHeaders(diffFor(path, false)), 200),
  /** 多选提交的最终结果：两点之间的净文件清单（mock 固定一份，含改名与删除）。 */
  compareFiles: (_repo: string, base: string | null, head: string) => previewParams.get("history") === "compare-error"
    ? Promise.reject({ code: "history_failed", message: "无法读取提交中的文件： git 命令返回非零状态。" })
    : ok({
    generation,
    base,
    head,
    files: [
      { path: "src/App.svelte", originalPath: null, status: "modified", additions: 21, deletions: 9 },
      { path: "src/app.css", originalPath: null, status: "modified", additions: 12, deletions: 4 },
      { path: "src/lib/components/Icon.svelte", originalPath: null, status: "added", additions: 29, deletions: 0 },
      { path: "docs/guide/start.md", originalPath: "docs/start.md", status: "renamed", additions: 3, deletions: 1 },
      { path: "src/lib/old.ts", originalPath: null, status: "deleted", additions: 0, deletions: 41 },
    ],
  }, 220),
  /** ?cliora=1：预览里的 cliora 审查链接，起点是第 5 条提交（范围内 4 个提交）。 */
  clioraReviewRequest: (url: string) => ok({
    reviewId: "preview-review",
    sessionId: "preview-session",
    worktreePath: recent[0]?.path ?? "C:/Users/dev/project/twiglane",
    baseline: url.includes("nobase=1") ? null : commits[4].oid,
  }, 80),
  clioraReviewReceipt: () => ok(undefined),
  clioraReviewReturn: () => ok(undefined),
  cherryPickCommits: () => ok({ generation, conflicted: false, skipped: [], note: "已按从旧到新拣选到当前分支。没有推送。", snapshot: snapshot() }),
  checkoutCommit: () => ok({ ...snapshot(), branch: { ...snapshot().branch, detached: true, name: null } }),
  commitDetail: (_repo: string, oid: string) => {
    // ?history=hang：最新的两条提交详情永不返回，用来复现「旧批次在途请求不结束、新选择还要能读」。
    // ?history=detail-error：所有详情都失败，用来核对失败说明与「重新读取」恢复入口。
    const historyMode = previewParams.get("history") ?? "";
    if (historyMode === "hang" && commits.slice(0, 2).some((item) => item.oid === oid)) return new Promise(() => {});
    if (historyMode === "detail-error") {
      return Promise.reject({ code: "detail_failed", message: "提交详情读取失败： git 命令返回非零状态。" });
    }
    const commit = commits.find((item) => item.oid === oid) ?? commits[0];
    return ok({
      generation,
      commit,
      body: commit.summary + "\n\n这次提交重新组织了主界面：\n- 顶栏集中同步操作\n- 改动列表分组并支持全部暂存\n- 统一的对话框与提示样式" + (previewParams.get("body") === "long" ? "\n- 长说明的一行".repeat(30) : ""),
      root: false,
      merge: commit.parents.length > 1,
      selectedParent: commit.parents[0],
      files: previewParams.has("preview") ? [{ path: previewParams.get("preview") === "archive" ? "assets/images.zip" : "assets/logo.png", originalPath: null, status: "modified", additions: null, deletions: null, binary: true, oldSize: 81920, newSize: 146752 }] : previewParams.get("files") === "many" ? Array.from({ length: 24 }, (_, index) => ({ path: `src/generated/file-${index}.ts`, originalPath: null, status: "modified", additions: index + 1, deletions: index % 3 })) : [
        // ?commitdoc=1 给这次提交加一个 Markdown 文件：历史/提交差异里的「阅读文档」入口
        // 需要一份真实存在的 Markdown 版本才能验证，默认数据保持不变（不影响既有对照截图）。
        ...(previewParams.get("commitdoc") === "1"
          ? [{ path: "README.md", originalPath: null, status: "modified" as const, additions: 6, deletions: 2 }]
          : []),
        { path: "src/App.svelte", originalPath: null, status: "modified", additions: 9, deletions: 7 },
        { path: "src/app.css", originalPath: null, status: "modified", additions: 12, deletions: 4 },
        { path: "src/lib/components/Icon.svelte", originalPath: null, status: "added", additions: 29, deletions: 0 },
        { path: "src/lib/old.ts", originalPath: null, status: "deleted", additions: 0, deletions: 41 },
      ],
    });
  },
  /**
   * 任务只读范围（R1）。?task=error 让起点校验失败，?task=empty 返回成功但空的任务，
   * 默认返回「提交 + 未提交改动」都有的净结果：起点、提交数、文件队列与净差异一次给全。
   */
  taskReview: (_repo: string, baseline: string, generation: number) => {
    const mode = previewParams.get("task") ?? "";
    if (mode === "error") {
      return Promise.reject({
        code: "baseline_missing",
        message: `起点 ${baseline} 不是当前分支的祖先，任务范围没有建立。`,
      });
    }
    const empty = mode === "empty";
    const files = [
      { path: "src/App.svelte", originalPath: null, status: "modified", additions: 18, deletions: 6 },
      { path: "src/lib/components/FileList.svelte", originalPath: null, status: "modified", additions: 42, deletions: 11 },
      { path: "src/lib/components/TaskReview.svelte", originalPath: null, status: "added", additions: 96, deletions: 0 },
      { path: "src/lib/review-progress.svelte.ts", originalPath: null, status: "modified", additions: 7, deletions: 3 },
      { path: "docs/guide/task-review.md", originalPath: "docs/task-review.md", status: "renamed", additions: 12, deletions: 4 },
      { path: "src/lib/legacy-panel.ts", originalPath: null, status: "deleted", additions: 0, deletions: 58 },
      { path: "assets/screenshot.png", originalPath: null, status: "modified", additions: null, deletions: null, binary: true, oldSize: 81_920, newSize: 146_752 },
      { path: "src/lib/scratch.ts", originalPath: null, status: "added", additions: 9, deletions: 0, untracked: true },
    ];
    return ok({
      generation,
      worktree: _repo,
      baselineRef: baseline,
      baselineOid: /^[0-9a-f]{40}$/.test(baseline) ? baseline : "3d1c8f0a2b4e6d8c0a1f3b5d7e9c2a4b6d8e0f1a",
      headOid: branch.headOid,
      branch: { ...branch },
      commits: empty ? [] : commits.slice(0, 4),
      commitCount: empty ? 0 : 4,
      commitsTruncated: false,
      files: empty ? [] : files,
      filesTotal: empty ? 0 : files.length,
      filesTruncated: false,
      additions: empty ? 0 : 184,
      deletions: empty ? 0 : 82,
      dirty: !empty,
      untrackedFiles: empty ? 0 : 1,
      conflicted: false,
      empty,
      rangeVersion: `task:${baseline}:${branch.headOid}:dirty`,
      message: empty ? "起点之后没有任何提交，也没有净改动。" : "任务范围包含 4 个提交，工作区还有未提交改动；任务范围与本次提交范围是两件事。",
    }, 260);
  },
  loadTaskDiff: (_repo: string, _baseline: string, _head: string, path: string, _generation: number, _request: number, _original: string | null, offset = 0) => {
    const diff = withHeaders(diffFor(path, false));
    return ok(offset > 0 ? { ...diff, offset, lines: [], hunks: [] } : diff, 120);
  },
  taskReviewToken: (_repo: string, baselineOid: string, _head: string, relative: string, generation: number) => ok({
    generation,
    path: relative,
    baselineOid,
    state: "current",
    token: `task:${baselineOid}:${relative}`,
    status: "modified",
    untracked: false,
    unmerged: false,
    baselineVersion: `blob:${relative}`,
    contentVersion: `worktree:${relative}`,
    truncated: false,
    message: "",
  }, 60),
  commitFileDiff: (_repo: string, _oid: string, _parent: string, path: string) => {
    const base = withHeaders(diffFor(path, false));
    // 提交差异同样给出两个固定提交的来源：改动前是父提交，改动后是这次提交。
    const document = markdownSides(_repo, path, path, false, _parent);
    if (document) {
      document.new = { revision: _oid, path };
      base.document = document;
    }
    return ok(previewParams.has("preview") ? {
      ...base, binary: true, lines: [], hunks: [], oldSize: 81920, newSize: 146752,
      preview: { repository: _repo, old: { revision: _parent, path }, new: { revision: _oid, path } },
    } : base);
  },
  repositoryDirectory: (_repo: string, relative: string, includeIgnored: boolean, generation: number) => {
    if (relative === "broken") {
      return Promise.reject({ code: "path_unreadable", message: "无法读取这个目录：权限不足。" });
    }
    return ok(mockDirectory(relative, includeIgnored, generation), 40);
  },
  repositoryFileContent: (_repo: string, relative: string, offset: number, limit: number | undefined, generation: number) => {
    if (relative === "assets/permission.txt") {
      return Promise.reject({ code: "path_unreadable", message: "无法读取这个文件：权限不足。" });
    }
    return ok(mockFilePage(relative, offset, limit, generation), 40);
  },
  repositoryEditSnapshot: (_repo: string, relative: string, generation: number) =>
    ok(mockEditSnapshot(relative, generation, previewParams.get("edit")), 60),
  repositoryEditSave: async (_repo: string, relative: string, expectedDigest: string, content: string, _generation: number) => {
    await wait(160);
    // 保存成功推进代次，与真实后端一致：随后的状态刷新按新代次读取。
    const result = mockEditSave(relative, expectedDigest, content, generation + 1, previewParams.get("edit"));
    if ("error" in result) return Promise.reject(result.error);
    generation += 1;
    return result.snapshot;
  },
  /**
   * 只读文档正文：?doc=error 演示读取失败，?doc=large 演示超过排版预览上限时仍可读源码，
   * ?doc=stale 让第一次请求报 stale，用来核对按新代次重读。
   */
  repositoryDocument: (
    _repo: string,
    source: { revision: string; path: string },
    generation: number,
    _request: number,
    mode: "document" | "source" = "document",
    offset = 0,
    limit: number | undefined,
  ) => {
    if (previewParams.get("doc") === "error") {
      return Promise.reject({ code: "document_read", message: "无法读取这个版本的正文。" });
    }
    if (previewParams.get("doc") === "large" && mode === "document") {
      return ok({
        ...mockDocument(source, "document", 0, limit, generation),
        kind: "tooLarge",
        text: null,
        truncated: true,
        message: "文档超过 2 MiB 排版预览上限，请查看源码。",
      });
    }
    const document = mockDocument(source, mode, offset, limit, generation);
    // 改动前一侧（暂存区）在预览里也要和改动后不同，否则看不出「读的是哪个版本」。
    if (document.kind === "text" && source.revision === "index") {
      if (document.text !== null) {
        document.text = `> 预览 mock：这是暂存区版本，正文与工作区可能不同。\n\n${document.text}`;
      }
      if (document.lines.length > 0) {
        document.lines = ["> 预览 mock：这是暂存区版本。", "", ...document.lines];
      }
    }
    return ok(document, 40);
  },
  documentResource: (_repo: string, source: { revision: string; path: string }, generation: number) =>
    ok(mockDocumentResource(source, generation), 40),
  documentRemoteImage: () =>
    ok({
      generation: 0,
      kind: "image",
      size: 68,
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      entries: [],
      truncated: false,
      message: "",
      lfsOid: null,
      canDownload: false,
    }, 300),
  openDocumentUrl: () => ok(undefined, 0),
  cancelDocumentResources: () => ok(undefined, 0),
  repositoryContentSearch: (
    _repo: string,
    query: string,
    scope: { kind?: string; path?: string } | undefined,
    _includeIgnored: boolean,
    limit: number | undefined,
    generation: number,
  ) => {
    // ?search=error 用来演示搜索的局部失败：界面必须显示原因，而不是「没有匹配」。
    if (previewParams.get("search") === "error") {
      return Promise.reject({ code: "io", message: "搜索时有一个目录读取失败。" });
    }
    return ok(mockContentSearch(query, scope, limit, generation), 60);
  },
  /**
   * 审阅确认：token 由这条路径当前的两侧状态与行数摘要决定。
   * 内容或状态一变就换 token，界面因此自动撤销旧标记，其他文件不受影响。
   */
  repositoryReviewToken: (_repo: string, relative: string, generation: number) => {
    const entry = files.find((item) => item.path === relative);
    if (!entry) {
      return ok({
        generation,
        path: relative,
        state: "unchanged",
        token: null,
        staged: "none",
        unstaged: "none",
        untracked: false,
        unmerged: false,
        contentVersion: null,
        message: "这条路径当前没有未提交的改动，不能标记已审阅。",
      });
    }
    const digest = [
      entry.staged,
      entry.unstaged,
      entry.untracked,
      entry.unmerged,
      entry.stagedLines?.additions ?? "",
      entry.unstagedLines?.additions ?? "",
    ].join("|");
    return ok(
      {
        generation,
        path: relative,
        state: "current",
        token: `mock-${relative}-${digest}`,
        staged: entry.staged,
        unstaged: entry.unstaged,
        untracked: entry.untracked,
        unmerged: entry.unmerged,
        contentVersion: "worktree:mock",
        message: "已确认这个文件当前的整份内容与改动。",
      },
      30,
    );
  },
  repositoryPathSearch: (
    _repo: string,
    query: string,
    directory: string | null,
    includeIgnored: boolean,
    _limit: number | undefined,
    generation: number,
  ) => {
    // ?filter=truncated 演示树过滤的全仓补齐被截断：界面必须说结果不完整，而不是「没有更多匹配」。
    // ?filter=error 演示补齐整体失败：界面要给原因和就地重试，而不是只说「没有匹配的路径」。
    if (previewParams.get("filter") === "error") {
      return Promise.reject({ code: "io", message: "无法遍历 vendor 目录。" });
    }
    if (previewParams.get("filter") === "truncated") {
      const entries = Array.from({ length: 70 }, (_item, index) => ({
        path: `vendor/generated/part-${String(index).padStart(2, "0")}.ts`,
        kind: "file" as const,
        ignored: false,
      }));
      return ok(
        { generation, query, directory, includeIgnored, scanned: 320, entries, truncated: true, message: "路径结果达到上限。" },
        60,
      );
    }
    return ok(mockPathSearch(query, directory, includeIgnored, generation), 60);
  },
  filePreview: (_repo: string, _source: unknown, _generation: number, download = false) => ok({
    generation, kind: previewParams.get("preview") === "archive" ? "archive" : previewParams.get("preview") === "lfs" && !download ? "lfs" : "image",
    size: 146752, dataUrl: "/brand-icon.png", entries: Array.from({ length: 2000 }, (_, index) => ({ name: `assets/images/photo-${String(index).padStart(4, "0")}.png`, size: 2048 + index, directory: false })),
    message: previewParams.get("preview") === "lfs" && !download ? "LFS 内容尚未下载。" : "", truncated: false,
    lfsOid: previewParams.get("preview") === "lfs" ? "a".repeat(64) : null,
    canDownload: previewParams.get("preview") === "lfs" && !download,
  }),
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
  mergePreview: (_repo: string, source: string, target: string | null) => {
    const calls = window as unknown as { __mergePreviews?: number };
    calls.__mergePreviews = (calls.__mergePreviews ?? 0) + 1;
    const into = target ?? branch.name;
    const localPaths = files.filter((item) => !item.untracked && !item.unmerged).map((item) => item.path);
    const dirty = localPaths.length > 0 && new URLSearchParams(location.search).get("dirty") === "1";
    const upToDate = source === "origin/feature/modern-ui";
    const fastForward = into === "main" && source === "feature/modern-ui";
    const conflictPaths = source === "main" ? ["src/lib/merge.ts", "src/styles/theme.css"] : [];
    const blocker = upToDate ? "up_to_date" : dirty ? "dirty" : null;
    const incoming = upToDate ? 0 : source === "main" ? 6 : 3;
    return ok({
      generation, source, target: into, headOid: branch.headOid, dirty, localPaths: dirty ? localPaths : [],
      canStart: !blocker, operation: "none",
      note: upToDate ? `${into} 已经包含 ${source} 的全部提交，不需要合并。` : dirty ? `工作区有 ${localPaths.length} 处未提交改动，合并前请先提交或临时保存，避免覆盖。未开始合并。` : into !== branch.name ? `将先切换到 ${into}，再把 ${source} 合并进去。当前没有未提交改动。` : `将把 ${source} 合并到 ${into}。当前没有未提交改动。`,
      current: branch.name, needsSwitch: into !== branch.name, incoming, outgoing: fastForward ? 0 : 2, upToDate, fastForward,
      commits: upToDate ? [] : commits.slice(1, 1 + incoming),
      files: upToDate ? [] : [
        { path: "src/lib/merge.ts", originalPath: null, status: "modified" },
        { path: "src/styles/theme.css", originalPath: null, status: "modified" },
        { path: "src/lib/components/BranchPicker.svelte", originalPath: null, status: "added" },
        { path: "docs/guide/merge.md", originalPath: "docs/merge.md", status: "renamed" },
        { path: "src/lib/legacy.ts", originalPath: null, status: "deleted" },
      ],
      filesTotal: upToDate ? 0 : 5,
      conflictCheck: upToDate || fastForward ? "clean" : conflictPaths.length ? "conflicts" : "clean",
      conflictPaths,
      blocker,
      baseOid: upToDate ? null : commits[20].oid,
      sourceOid: upToDate ? null : commits[1].oid,
    }, 260);
  },
  startMerge: (_repo: string, source: string, target: string | null, mode: string) => {
    const from = branch.name;
    if (target && target !== branch.name) {
      for (const item of branches) item.current = !item.remote && item.name === target;
      branch.name = target;
    }
    generation += 1;
    mergeSourceName = source;
    if (mode === "ff-only") {
      mergeOperation = "none";
      return ok({ ...mergeData(), switchedFrom: target && target !== from ? from : null, fastForwarded: true }, 400);
    }
    mergeOperation = "merge";
    if (source !== "main") files = files.filter((item) => !item.unmerged);
    return ok({ ...mergeData(), switchedFrom: target && target !== from ? from : null, fastForwarded: false }, 400);
  },
  mergeSession: () => ok(mergeData()),
  conflictView: (_repo: string, path: string) => {
    if (previewParams.get("conflict") === "modify-delete" && path.endsWith(".css")) {
      const text = Array.from({ length: 200 }, (_, index) => `.rule-${index + 1} { padding: ${index}px; }\n`).join("");
      return ok({
        generation, path, kind: "modify_delete", editable: false,
        ours: { present: true, binary: false, truncated: false, text, summary: "本地修改了这个文件。" },
        theirs: { present: false, binary: false, truncated: false, text: null, summary: "另一分支删除了这个文件。" },
        result: { present: true, binary: false, truncated: false, text, summary: "工作区保留了本地版本。" },
        note: "另一分支删除了这个文件。选择保留本地版本，或接受删除。",
      });
    }
    const crlf = (view: Record<string, unknown>) => {
      if (previewParams.get("eol") !== "crlf") return view;
      const side = (part: { text: string | null }) => ({ ...part, text: part.text?.replace(/\n/g, "\r\n") ?? null });
      type Side = { text: string | null };
      return { ...view, ours: side(view.ours as Side), theirs: side(view.theirs as Side), result: side(view.result as Side) };
    };
    if (path.endsWith(".png")) {
      return ok({
        generation, path, kind: "binary", editable: false,
        ours: { present: true, binary: true, truncated: false, text: null, summary: "本地版本是二进制，245 KB，不显示伪文本。", size: 250_880 },
        theirs: { present: true, binary: true, truncated: false, text: null, summary: "另一分支版本是二进制，312 KB，不显示伪文本。", size: 319_488 },
        result: { present: true, binary: true, truncated: false, text: null, summary: "当前合并结果是二进制。" },
        note: "这是二进制冲突，不能按文本合并。请明确保留本地版本或另一分支版本。",
      });
    }
    if (path.endsWith(".css")) {
      const ours = ":root {\n  --accent: #0e7c55;\n  --radius: 11px;\n}\n\n.button {\n  padding: 0 14px;\n}\n";
      const theirs = ":root {\n  --accent: #10a37f;\n  --radius: 12px;\n}\n\n.button {\n  padding: 0 16px;\n}\n";
      const result = ":root {\n<<<<<<< HEAD\n  --accent: #0e7c55;\n  --radius: 11px;\n||||||| base\n  --accent: #0e7c55;\n  --radius: 10px;\n=======\n  --accent: #10a37f;\n  --radius: 12px;\n>>>>>>> main\n}\n\n.button {\n<<<<<<< HEAD\n  padding: 0 14px;\n=======\n  padding: 0 16px;\n>>>>>>> main\n}\n";
      return ok(crlf({
        generation, path, kind: "text", editable: true,
        ours: { present: true, binary: false, truncated: false, text: ours, summary: "本地" },
        theirs: { present: true, binary: false, truncated: false, text: theirs, summary: "另一侧" },
        result: { present: true, binary: false, truncated: false, text: result, summary: "结果" },
        note: "可以编辑合并结果。标记后只解决这个文件，其他冲突保持不变。",
      }));
    }
    return ok(crlf({
      generation, path, kind: "text", editable: true,
      ours: { present: true, binary: false, truncated: false, text: BIG_CONFLICT.ours, summary: "本地" },
      theirs: { present: true, binary: false, truncated: false, text: BIG_CONFLICT.theirs, summary: "另一侧" },
      result: { present: true, binary: false, truncated: false, text: BIG_CONFLICT.result, summary: "结果" },
      note: "可以编辑合并结果。标记后只解决这个文件，其他冲突保持不变。",
    }));
  },
  resolveConflict: (...args: never[]) => {
    const [, path, , content] = args as unknown as [string, string, string, string | undefined];
    const log = window as unknown as { __resolved?: unknown[] };
    (log.__resolved ??= []).push({ path, content });
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
  setPullIntegration: () => ok(undefined, 0),
  setBranchGroups: () => ok(undefined, 0),
  setFilesView: () => ok(undefined, 0),
  setPanelWidths: (widths: unknown) => ok(widths, 0),
  measureProbe: () => ok({ enabled: false, elapsedMs: 0, script: null }, 0),
  measureSample: () => ok(undefined, 0),
  measureFinish: () => ok(undefined, 0),
  measureWait: () => ok(undefined, 0),
};
