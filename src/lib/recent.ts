import type { RecentRepo, RepoHead, WorktreeItem } from "./types";

/** 搜「worktree」或「工作区」时列出所有附属工作区。 */
const WORKTREE_WORDS = ["worktree", "工作区"];

/**
 * 关键字搜索最近仓库：命中名称、路径、当前分支（或游离提交）、附属工作区所属的主仓库，
 * 关键字是 worktree / 工作区时还命中所有附属工作区。分支信息还没读到时只按名称和路径匹配。
 */
export function filterRecent(
  repos: RecentRepo[],
  query: string,
  headOf: (path: string) => RepoHead | null = () => null,
): RecentRepo[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return repos;
  const asksWorktree = needle.length >= 2 && WORKTREE_WORDS.some((word) => word.startsWith(needle));
  return repos.filter((repo) => {
    if (repo.name.toLocaleLowerCase().includes(needle) || repo.path.toLocaleLowerCase().includes(needle)) return true;
    const head = headOf(repo.path);
    if (!head) return false;
    if (head.worktree && asksWorktree) return true;
    return [head.branch, head.detached, head.mainPath].some((text) => text?.toLocaleLowerCase().includes(needle));
  });
}

/** 路径的最后一段，用来显示附属工作区来自哪个主仓库。 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}

/** 出现不止一次的仓库名：这些仓库只能靠路径区分，界面要显示完整路径而不是截断。 */
export function repeatedNames(repos: RecentRepo[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const repo of repos) (seen.has(repo.name) ? repeated : seen).add(repo.name);
  return repeated;
}

/**
 * 同名仓库的路径差异段：组内所有路径的最长公共前缀之后、到下一个分隔符为止的那一段，
 * 是唯一能区分彼此的片段。返回每条路径的 { head, diverge, tail } 拆分，渲染时差异段
 * 用正文色强调、公共段保持弱化色，一眼看出两个同名仓库差在哪。
 * 比较时统一分隔符与大小写（Windows 上 C:\x 与 c:/x 同仓），渲染保留原样；组内路径
 * 完全相同时 diverge 为空，退化成普通显示。
 */
export function pathDivergence(paths: readonly string[]): Map<string, { head: string; diverge: string; tail: string }> {
  const result = new Map<string, { head: string; diverge: string; tail: string }>();
  if (paths.length < 2) {
    for (const path of paths) result.set(path, { head: "", diverge: "", tail: path });
    return result;
  }
  const keys = paths.map((path) => normalizeRepoPath(path));
  let common = keys[0];
  for (const key of keys.slice(1)) {
    let index = 0;
    while (index < common.length && index < key.length && common[index] === key[index]) index += 1;
    common = common.slice(0, index);
    if (!common) break;
  }
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const key = keys[index];
    if (key.length <= common.length) {
      result.set(path, { head: path, diverge: "", tail: "" });
      continue;
    }
    // 公共前缀截回分隔符边界：半段分隔符差异没有信息量，整段一起当公共部分。
    let cut = common.length;
    while (cut > 0 && key[cut - 1] !== "/") cut -= 1;
    let end = key.indexOf("/", cut);
    if (end < 0) end = key.length;
    result.set(path, { head: path.slice(0, cut), diverge: path.slice(cut, end), tail: path.slice(end) });
  }
  return result;
}

/** 每一行的顶部位置，末尾多一项是总高度。 */
export function rowOffsets(heights: readonly number[]): number[] {
  const offsets = [0];
  for (const height of heights) offsets.push(offsets[offsets.length - 1] + height);
  return offsets;
}

/** 视口覆盖的行区间 [start, end)，上下各多留 overscan 行。 */
export function rowWindow(offsets: readonly number[], top: number, height: number, overscan: number): { start: number; end: number } {
  const count = offsets.length - 1;
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= top) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  let last = first;
  while (last < count && offsets[last] < top + height) last += 1;
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
}
/** 路径身份：Windows 上大小写与分隔符都不参与判定，末尾分隔符也忽略。 */
export function normalizeRepoPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** worktree 总览的筛选条件；都是真实 Git 状态，不需要额外的运行状态。 */
export type WorktreeFilter = "all" | "worktree" | "dirty" | "conflict" | "sync";

export const WORKTREE_FILTERS: { id: WorktreeFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "worktree", label: "worktree" },
  { id: "dirty", label: "有改动" },
  { id: "conflict", label: "有冲突" },
  { id: "sync", label: "同步待处理" },
];

/**
 * 总览里的一行：Git 读到的状态 + 当前会话已有的审阅条数。
 * 读不到的状态保持 null，界面显示未知，绝不用 0 或旧数字代替。
 */
export interface WorktreeRow {
  path: string;
  name: string;
  branch: string | null;
  detached: string | null;
  /** 所属主仓库的工作区路径；无法归属时为 null，单独成组。 */
  mainPath: string | null;
  linked: boolean;
  locked: boolean;
  missing: boolean;
  current: boolean;
  recent: boolean;
  /** 最近列表里的打开时间；枚举出来的工作区是 0。 */
  openedAtMs: number;
  /** 后端读到状态的时间；没有读到状态时为空。 */
  checkedAtMs: number | null;
  /** 最近一次成功刷新没有确认到这一项：值来自更早的读取，不能当成当前状态。 */
  stale: boolean;
  state: "ready" | "unknown" | "missing";
  note: string;
  dirty: boolean | null;
  changed: number | null;
  staged: number | null;
  unstaged: number | null;
  untracked: number | null;
  conflicted: number | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  liveRemoteChecked: boolean;
  remoteCheckedAtMs: number | null;
  remoteCheckStale: boolean;
  /** 当前会话已审阅的文件数（真实记录，不是完成度或百分比）。 */
  reviewed: number;
}

/** 按主仓库聚合的一组工作区。 */
export interface WorktreeGroup {
  /** 规范化后的主仓库路径，也是分组的去重键。 */
  key: string;
  mainPath: string | null;
  name: string;
  rows: WorktreeRow[];
}

export type WorktreeListRow =
  | { kind: "group"; key: string; group: WorktreeGroup; index: -1 }
  | { kind: "item"; key: string; group: WorktreeGroup; row: WorktreeRow; index: number };

function rowOf(
  repo: { name: string; path: string; openedAtMs: number },
  item: WorktreeItem | null,
  head: RepoHead | null,
  current: string | null,
  reviewed: Readonly<Record<string, number>>,
  recent: boolean,
  confirmed: ReadonlySet<string> | null,
): WorktreeRow {
  const { name, path } = repo;
  const key = normalizeRepoPath(path);
  const linked = item?.linked ?? head?.worktree ?? false;
  const missing = item?.missing ?? head?.missing ?? false;
  const mainPath = item?.mainPath ?? head?.mainPath ?? (linked ? null : path);
  return {
    path,
    name,
    branch: item?.branch ?? head?.branch ?? null,
    detached: item?.detached ?? head?.detached ?? null,
    mainPath,
    linked,
    locked: item?.locked ?? false,
    missing,
    current: current !== null && key === current,
    recent,
    openedAtMs: repo.openedAtMs,
    checkedAtMs: item?.checkedAtMs ?? null,
    stale: confirmed !== null && item !== null && !confirmed.has(key),
    state: item ? item.status : missing ? "missing" : "unknown",
    note: item?.note ?? (missing ? "目录已不存在或不再是 Git 仓库。" : "还没有读到这个工作区的状态。"),
    dirty: item?.dirty ?? null,
    changed: item?.changed ?? null,
    staged: item?.staged ?? null,
    unstaged: item?.unstaged ?? null,
    untracked: item?.untracked ?? null,
    conflicted: item?.conflicted ?? null,
    upstream: item?.upstream ?? null,
    ahead: item?.ahead ?? null,
    behind: item?.behind ?? null,
    liveRemoteChecked: item?.liveRemoteChecked ?? false,
    remoteCheckedAtMs: item?.remoteCheckedAtMs ?? null,
    remoteCheckStale: item?.remoteCheckStale ?? false,
    reviewed: reviewed[key] ?? 0,
  };
}

/**
 * 把最近仓库、HEAD 与总览结果合并成分组列表（ADR-4）：
 * - 最近列表里的每一项都保留，即使目录缺失或还没读到状态；
 * - 枚举出来但不在最近列表里的附属工作区一并列出；
 * - 同一路径只出现一次，按规范化主仓库路径分组，主仓库排在组内最前。
 */
export function buildWorktreeGroups(
  recent: readonly RecentRepo[],
  heads: ReadonlyMap<string, RepoHead>,
  items: ReadonlyMap<string, WorktreeItem>,
  currentPath: string | null,
  reviewed: Readonly<Record<string, number>> = {},
  confirmed: ReadonlySet<string> | null = null,
): WorktreeGroup[] {
  const groups: WorktreeGroup[] = [];
  const byKey = new Map<string, WorktreeGroup>();
  const seen = new Set<string>();
  const current = currentPath ? normalizeRepoPath(currentPath) : null;

  const push = (row: WorktreeRow) => {
    const key = row.mainPath ? normalizeRepoPath(row.mainPath) : normalizeRepoPath(row.path);
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        mainPath: row.mainPath,
        name: row.mainPath ? baseName(row.mainPath) : row.name,
        rows: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  };

  for (const repo of recent) {
    const key = normalizeRepoPath(repo.path);
    if (seen.has(key)) continue;
    seen.add(key);
    push(rowOf(repo, items.get(key) ?? null, heads.get(key) ?? null, current, reviewed, true, confirmed));
  }
  for (const item of items.values()) {
    const key = normalizeRepoPath(item.path);
    if (seen.has(key)) continue;
    seen.add(key);
    push(
      rowOf(
        { name: baseName(item.path), path: item.path, openedAtMs: 0 },
        item,
        null,
        current,
        reviewed,
        false,
        confirmed,
      ),
    );
  }
  // 组内主仓库在前；其余保持最近列表与枚举顺序（Array.sort 稳定）。
  for (const group of groups) group.rows.sort((left, right) => Number(left.linked) - Number(right.linked));
  return groups;
}

export function syncPending(row: WorktreeRow): boolean {
  return (row.ahead ?? 0) > 0 || (row.behind ?? 0) > 0;
}

export function rowMatchesFilter(row: WorktreeRow, filter: WorktreeFilter): boolean {
  switch (filter) {
    case "worktree":
      return row.linked;
    case "dirty":
      return row.dirty === true;
    case "conflict":
      return (row.conflicted ?? 0) > 0;
    case "sync":
      return syncPending(row);
    default:
      return true;
  }
}

/** 关键字同时匹配名称、路径、分支、游离提交、主仓库路径与主仓库名。 */
export function rowMatchesQuery(row: WorktreeRow, group: WorktreeGroup, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [row.name, row.path, row.branch, row.detached, row.mainPath, group.name].some((text) =>
    text?.toLocaleLowerCase().includes(needle),
  );
}

/** 关键字与筛选可组合：先按真实状态筛，再按关键字筛；没有命中的组整体隐藏。 */
export function filterWorktreeGroups(
  groups: readonly WorktreeGroup[],
  query: string,
  filter: WorktreeFilter,
): WorktreeGroup[] {
  const kept: WorktreeGroup[] = [];
  for (const group of groups) {
    const rows = group.rows.filter(
      (row) => rowMatchesFilter(row, filter) && rowMatchesQuery(row, group, query),
    );
    if (rows.length > 0) kept.push({ ...group, rows });
  }
  return kept;
}

/** 铺平成分组头 + 工作区行；分组头不参与选择，行上的 index 是可选序号。 */
export function flattenWorktreeGroups(groups: readonly WorktreeGroup[]): WorktreeListRow[] {
  const rows: WorktreeListRow[] = [];
  let index = 0;
  for (const group of groups) {
    // 只有一个工作区的组不需要分组头：那条路径本身就是主仓库，抬头只是噪音。
    if (group.rows.length > 1) rows.push({ kind: "group", key: `group:${group.key}`, group, index: -1 });
    for (const row of group.rows) {
      rows.push({ kind: "item", key: `row:${normalizeRepoPath(row.path)}`, group, row, index });
      index += 1;
    }
  }
  return rows;
}

/** 可选择的项（分组头不在其中）：键盘当前项和 openRecent 的入口都取这一份。 */
export function selectableWorktreeRows(rows: readonly WorktreeListRow[]): WorktreeRow[] {
  return rows
    .filter((row): row is Extract<WorktreeListRow, { kind: "item" }> => row.kind === "item")
    .map((row) => row.row);
}

/** 右键菜单沿用 RepoHead：总览里的字段够用，不需要再造一份来源。 */
export function headOfRow(row: WorktreeRow): RepoHead {
  return {
    path: row.path,
    branch: row.branch,
    detached: row.detached,
    missing: row.missing,
    worktree: row.linked,
    mainPath: row.mainPath,
  };
}

/** 读取时间的短格式：到分钟即可判断新旧。 */
export function timeLabel(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 这一项的状态是什么时候读到的：从未读到、缺失或具体时间。 */
export function statusTimeText(row: WorktreeRow): string {
  if (row.checkedAtMs === null) return "状态未读取";
  return `状态读取于 ${timeLabel(row.checkedAtMs)}`;
}

/** 远程是否核对过：未核 / 过期 / 已核对；本地 upstream 不会被说成远端实时状态。 */
export function remoteText(row: WorktreeRow): string {
  if (row.liveRemoteChecked && row.remoteCheckedAtMs !== null) {
    return `远程已核对 ${timeLabel(row.remoteCheckedAtMs)}`;
  }
  if (row.remoteCheckedAtMs !== null) return `远程状态过期（${timeLabel(row.remoteCheckedAtMs)}）`;
  return "远程未核";
}
/**
 * 本次总览真正权威枚举过的主仓库：它们的工作区列表以这次结果为准，
 * 因此「不在这次结果里」的缓存项就是已经消失的工作区（ADR-4）。
 *
 * - 主仓库自己读到状态（ready）说明这次枚举成功，列表完整；
 * - 主仓库自己已缺失（missing）时，它的附属工作区不可能还存在。
 *
 * 读取失败、超限、目录暂时读不到的项一律不算确认：宁可留着标过期，也不误删。
 */
export function authoritativeMains(items: readonly WorktreeItem[]): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    const own = normalizeRepoPath(item.path);
    const main = item.mainPath ? normalizeRepoPath(item.mainPath) : own;
    if (item.status === "ready" || (item.status === "missing" && main === own)) keys.add(main);
  }
  return keys;
}

/**
 * 只保留仍能归属到最近仓库的项：最近列表里被移除的仓库及其工作区不再复活，
 * 而它的附属工作区在移除后仍然在场（枚举结果没被重新请求）。
 */
export function pruneWorktreeItems(
  recent: readonly RecentRepo[],
  items: ReadonlyMap<string, WorktreeItem>,
): Map<string, WorktreeItem> {
  const recentKeys = new Set(recent.map((repo) => normalizeRepoPath(repo.path)));
  const mains = new Set<string>();
  for (const item of items.values()) {
    const key = normalizeRepoPath(item.path);
    if (recentKeys.has(key) && item.mainPath) mains.add(normalizeRepoPath(item.mainPath));
  }
  const kept = new Map<string, WorktreeItem>();
  for (const [key, item] of items) {
    const main = item.mainPath ? normalizeRepoPath(item.mainPath) : null;
    if (recentKeys.has(key) || (main !== null && (recentKeys.has(main) || mains.has(main)))) kept.set(key, item);
  }
  return kept;
}