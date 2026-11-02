import type { RecentRepo } from "./types";

export function filterRecent(repos: RecentRepo[], query: string): RecentRepo[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return repos;
  return repos.filter((repo) => {
    return (
      repo.name.toLocaleLowerCase().includes(needle) ||
      repo.path.toLocaleLowerCase().includes(needle)
    );
  });
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
