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
