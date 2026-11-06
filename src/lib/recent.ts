import type { RecentRepo, RepoHead } from "./types";

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
