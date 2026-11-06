import type { LineStat } from "./types";

export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

export function formatAuthoredAt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "未知时间";
  return new Date(seconds * 1000).toLocaleString();
}

export function historyStatus(state: string): string | null {
  if (state === "empty_repository") return "这个仓库还没有任何提交。";
  if (state === "empty_branch") return "当前分支还没有提交。范围是当前分支。";
  if (state === "no_match") return "没有符合条件的提交。";
  if (state === "no_file_history") return "这个文件没有可用历史。";
  return null;
}

export interface HistoryConditionInput {
  scope: string;
  head: string | null;
  author: string;
  since: string;
  until: string;
  path: string;
  query: string;
}

export function historyScopeLabel(scope: string, head: string | null): string {
  if (scope === "all") return "全部分支";
  if (!scope || scope === "current") return head ? `当前分支 ${head}` : "当前分支";
  return `分支 ${scope}`;
}

/** 无结果时写明仍在生效的条件。说明搜索和作者是两项，不会并成一次查询。 */
export function historyConditions(filters: HistoryConditionInput): string {
  const parts = [`范围：${historyScopeLabel(filters.scope, filters.head)}`];
  const author = filters.author.trim();
  if (author) parts.push(`作者：${author}`);
  if (filters.since || filters.until) {
    parts.push(`日期：${filters.since || "不限"} 至 ${filters.until || "不限"}（含起止当天）`);
  }
  const path = filters.path.trim();
  if (path) parts.push(`路径：${path}`);
  const query = filters.query.trim();
  if (query) parts.push(`说明或哈希：${query}`);
  return `生效条件：${parts.join("；")}。仓库没有被修改。`;
}

/** 本地日历日的含当日边界，单位秒。结束日取到 23:59:59。非法日期返回 null。 */
export function historyDayBound(day: string, end: boolean): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const stamp = new Date(year, month - 1, date, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0);
  if (stamp.getFullYear() !== year || stamp.getMonth() !== month - 1 || stamp.getDate() !== date) return null;
  return Math.floor(stamp.getTime() / 1000);
}

/** 距底部不足三行时追加。视口高度未知时不追加，避免高度为 0 时连续请求。 */
export function shouldAppendHistory(
  scrollTop: number,
  viewport: number,
  contentHeight: number,
  hasMore: boolean,
  busy: boolean,
): boolean {
  if (!hasMore || busy || viewport <= 0) return false;
  return contentHeight - scrollTop - viewport <= 180;
}

export function commitSelectionRange(oids: string[], anchor: string | null, target: string): string[] {
  const end = oids.indexOf(target);
  if (end < 0) return [];
  const found = anchor ? oids.indexOf(anchor) : -1;
  const start = found < 0 ? end : found;
  return oids.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/** 最后一个提交不能取消，避免详情区空白。 */
export function toggleCommitSelection(base: string[], oid: string): string[] {
  if (base.includes(oid)) {
    const next = base.filter((item) => item !== oid);
    return next.length === 0 ? base : next;
  }
  return [...base, oid];
}

export function parentCaption(parents: string[], root = false): string {
  if (root || parents.length === 0) return "首个提交，没有父提交，差异相对空树。";
  if (parents.length === 1) return `父提交 ${shortOid(parents[0])}`;
  return `合并提交，父提交 ${parents.map((oid) => shortOid(oid)).join("、")}`;
}

export function refLabel(kind: string, name: string, current: boolean): string {
  const prefix = kind === "remote" ? "远程" : kind === "tag" ? "标签" : kind === "head" ? "HEAD" : "分支";
  return current ? `${prefix} ${name} · 当前` : `${prefix} ${name}`;
}

/** 提交文件行上的行数。二进制显示「二进制」；两边都未知时不显示；纯新增也显示 0 删除。 */
export function commitLineStat(file: {
  additions?: number | null;
  deletions?: number | null;
  binary?: boolean;
  oldSize?: number | null;
  newSize?: number | null;
}): LineStat | null {
  if (file.binary) return { additions: null, deletions: null, oldSize: file.oldSize ?? null, newSize: file.newSize ?? null };
  if (file.additions == null && file.deletions == null) return null;
  return { additions: file.additions ?? 0, deletions: file.deletions ?? 0 };
}

export interface CommitLineTotals {
  additions: number;
  deletions: number;
  /** 有完整增删行数、实际参与合计的文件数。 */
  counted: number;
  /** 未计入合计的文件数：二进制或缺任一侧行数统计。 */
  skipped: number;
}

/**
 * 「变更文件」标题的增删行合计。输入是完整文件清单（不是虚拟列表的可见行），
 * 单提交用 detail.files，多提交用按路径累计后的并集，因此合计与逐文件数字同口径。
 * 二进制和缺失统计不当作零：只计入 skipped，全部不可统计时返回 null，不渲染 +0 −0。
 */
export function commitLineTotals(
  files: readonly {
    additions?: number | null;
    deletions?: number | null;
    binary?: boolean;
  }[],
): CommitLineTotals | null {
  let additions = 0;
  let deletions = 0;
  let counted = 0;
  let skipped = 0;
  for (const file of files) {
    if (file.binary || file.additions == null || file.deletions == null) {
      skipped += 1;
      continue;
    }
    additions += file.additions;
    deletions += file.deletions;
    counted += 1;
  }
  return counted > 0 ? { additions, deletions, counted, skipped } : null;
}

/** 合计的可访问名称：写明统计范围和未计入的文件，不只靠视觉上的 +/−。 */
export function commitLineTotalLabel(totals: CommitLineTotals, subject = "这次提交"): string {
  const base = `${subject}新增 ${totals.additions} 行，删除 ${totals.deletions} 行`;
  if (totals.skipped === 0) return base;
  return `${base}；另有 ${totals.skipped} 个文件未计入合计（二进制或没有行数统计）`;
}

export function commitFileLabel(status: string): string {
  switch (status) {
    case "added":
      return "新增";
    case "modified":
      return "修改";
    case "deleted":
      return "删除";
    case "renamed":
      return "重命名";
    case "copied":
      return "复制";
    case "typeChanged":
      return "类型变化";
    default:
      return "变化";
  }
}

export function mergeAbortAvailable(canAbortMerge: boolean): boolean {
  return canAbortMerge;
}

export const HISTORY_SEARCH_DEBOUNCE_MS = 300;

export function preferredCommitFile<T extends { path: string; originalPath: string | null }>(
  files: T[],
  requested: string | null,
): T | null {
  if (requested) {
    const match = files.find((file) => file.path === requested || file.originalPath === requested);
    if (match) return match;
  }
  return files[0] ?? null;
}

export function stashPathBadge(kind: "tracked" | "untracked" | "ignored", includeUntracked: boolean): string {
  if (kind === "tracked") return "将保存";
  if (kind === "ignored") return "忽略不保存";
  return includeUntracked ? "会一并保存" : "不保存";
}

export interface RefPill {
  kind: "branch" | "remote" | "tag" | "head";
  name: string;
  current: boolean;
  /** 同名远程分支指向同一提交时合并成一枚胶囊，这里记远程名（例如 origin）。 */
  remote: string | null;
  /** 完整说明，作为可访问名称与悬停提示。 */
  label: string;
}

const PILL_ORDER: Record<RefPill["kind"], number> = { head: 0, branch: 1, tag: 2, remote: 3 };

/** 把提交上的引用整理成胶囊：本地分支与指向同一提交的同名远程分支合成一枚，当前分支排最前。 */
export function refPills(labels: { name: string; kind: string; current: boolean }[]): RefPill[] {
  const remotes = labels.filter((label) => label.kind === "remote");
  const absorbed = new Set<string>();
  const pills: RefPill[] = [];
  for (const label of labels) {
    if (label.kind !== "branch") continue;
    const twin = remotes.find((remote) => remote.name.slice(remote.name.indexOf("/") + 1) === label.name);
    if (twin) absorbed.add(twin.name);
    const remote = twin ? twin.name.slice(0, twin.name.indexOf("/")) : null;
    const base = refLabel("branch", label.name, label.current);
    pills.push({
      kind: "branch",
      name: label.name,
      current: label.current,
      remote,
      label: remote ? `${base}，与远程 ${twin?.name} 一致` : base,
    });
  }
  for (const label of labels) {
    if (label.kind === "branch" || absorbed.has(label.name)) continue;
    if (label.kind === "remote" && label.name.endsWith("/HEAD")) continue;
    const kind = label.kind === "remote" || label.kind === "tag" || label.kind === "head" ? label.kind : "branch";
    pills.push({ kind, name: label.name, current: label.current, remote: null, label: refLabel(label.kind, label.name, label.current) });
  }
  return pills.sort((left, right) => Number(right.current) - Number(left.current) || PILL_ORDER[left.kind] - PILL_ORDER[right.kind]);
}

/** 提交说明里除去标题行之后的正文（%B 含标题，详情区已单独显示标题）。 */
export function commitBodyRest(body: string, summary: string): string {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const [first, ...rest] = text.split("\n");
  if (first.trim() !== summary.trim()) return text;
  return rest.join("\n").trim();
}
