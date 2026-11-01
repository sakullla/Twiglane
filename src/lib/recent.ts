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
