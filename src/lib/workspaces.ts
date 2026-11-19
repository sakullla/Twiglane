import type { RecentRepo } from "./types";
export interface WorkspaceLocation { hostId: string; path: string }
export interface WorkspaceRepository { id: string; name: string; locations: WorkspaceLocation[] }
export interface WorkspaceManifest {
  schemaVersion: 1;
  workspaceId: string;
  name: string;
  revision: number;
  repositories: WorkspaceRepository[];
}
export interface Project {
  manifest: WorkspaceManifest;
  sourcePath: string | null;
  digest: string | null;
  error: string | null;
  favorites: string[];
  bindings: Record<string, string>;
}
export interface Projects { hostId: string; projects: Project[] }
/** 深链预览：`sourceRepositoryId` 只在 `twiglane://workspace?v=2` 里出现，普通文件预览为空。 */
export interface WorkspacePreview {
  manifest: WorkspaceManifest;
  path: string;
  digest: string;
  conflict: boolean;
  sourceRepositoryId: string | null;
  /** 本机名单已与这份内容一致：可直接续接来源仓库，不必再次确认关联。 */
  attached: boolean;
}
export interface WorkspaceCandidate { path: string; name: string; commonDirectory: string | null; repositoryId: string | null; error: string | null }
export interface WorkspaceDiscovery { candidates: WorkspaceCandidate[]; cancelled: boolean; partial: boolean }
/** POSIX is case-sensitive; drive/UNC path comparison follows the receiving Windows convention. */
export function checkoutKey(path: string): string {
  // A backslash is a literal filename character in a POSIX path. Classify the
  // original syntax before normalizing Windows separators or casing.
  const windows = /^[a-z]:[\\/]/i.test(path) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(path);
  if (!windows) return path.replace(/\/+$/, "") || (path.startsWith("/") ? "/" : path);
  let flat = path.replace(/\\/g, "/");
  if (/^\/\/\?\/unc\//i.test(flat)) flat = "//" + flat.slice(8);
  else if (/^\/\/\?\/[a-z]:\//i.test(flat)) flat = flat.slice(4);
  flat = flat.startsWith("//") ? "//" + flat.slice(2).replace(/\/+/g, "/") : flat.replace(/\/+/g, "/");
  return (/^[a-z]:\/$/i.test(flat) ? flat : flat.replace(/\/+$/, "")).toLowerCase();
}
/**
 * 项目里的仓库顺序按「我接下来最可能打开谁」排：当前仓库 → 收藏 → 最近打开（新的在前）→ 其余按名称。
 * 名单原始顺序只是导入顺序，对挑选没有意义；同名同时间时保持名单顺序（排序稳定）。
 */
export function projectRepos(project: Project | null, hostId: string, recent: RecentRepo[], currentPath: string | null = null): RecentRepo[] {
  if (!project) return recent;
  const opened = new Map(recent.map((r) => [checkoutKey(r.path), r.openedAtMs]));
  const favorites = new Set(project.favorites);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const current = currentPath ? checkoutKey(currentPath) : null;
  const rows = project.manifest.repositories.flatMap((repo) => {
    const favorite = favorites.has(repo.id);
    return repo.locations.filter((l) => l.hostId === hostId).map((location) => ({
      repo: { name: repo.name, path: location.path, openedAtMs: opened.get(checkoutKey(location.path)) ?? 0 },
      favorite,
      current: current !== null && checkoutKey(location.path) === current,
    }));
  });
  rows.sort((a, b) =>
    Number(b.current) - Number(a.current)
    || Number(b.favorite) - Number(a.favorite)
    || b.repo.openedAtMs - a.repo.openedAtMs
    || collator.compare(a.repo.name, b.repo.name));
  return rows.map((row) => row.repo);
}
export function addCandidates(manifest: WorkspaceManifest, candidates: WorkspaceCandidate[], hostId: string): WorkspaceManifest {
  const repositories = manifest.repositories.map((repo) => ({ ...repo, locations: repo.locations.map((l) => ({ ...l })) }));
  const byId = new Map(repositories.map((repo) => [repo.id, repo]));
  const paths = new Set<string>();
  for (const repo of repositories) {
    for (const location of repo.locations) {
      if (location.hostId === hostId) paths.add(checkoutKey(location.path));
    }
  }
  const commonIds = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.error) continue;
    const key = checkoutKey(candidate.path);
    if (paths.has(key)) continue;
    paths.add(key);
    const id = candidate.repositoryId ?? (candidate.commonDirectory ? commonIds.get(candidate.commonDirectory) : null) ?? crypto.randomUUID();
    if (candidate.commonDirectory) commonIds.set(candidate.commonDirectory, id);
    let repo = byId.get(id);
    if (!repo) {
      repo = { id, name: candidate.name, locations: [] };
      repositories.push(repo);
      byId.set(id, repo);
    }
    repo.locations.push({ hostId, path: candidate.path });
  }
  return { ...manifest, repositories };
}

/** A verified linked worktree is another checkout of its member's main repository. */
export function projectMemberForCheckout(
  project: Project,
  hostId: string,
  path: string,
  heads: readonly import("./types").RepoHead[],
): WorkspaceRepository | null {
  const direct = project.manifest.repositories.find((repo) => repo.locations.some((location) => location.hostId === hostId && checkoutKey(location.path) === checkoutKey(path)));
  if (direct) return direct;
  const byPath = new Map(heads.map((head) => [checkoutKey(head.path), head]));
  const current = byPath.get(checkoutKey(path));
  if (!current || current.missing) return null;
  const main = checkoutKey(current.mainPath ?? current.path);
  return project.manifest.repositories.find((repo) => repo.locations.some((location) => {
    if (location.hostId !== hostId) return false;
    const head = byPath.get(checkoutKey(location.path));
    return head && !head.missing && checkoutKey(head.mainPath ?? head.path) === main;
  })) ?? null;
}

/** 项目名的首字（跳过开头的符号），用作徽章；同一函数给标题栏、管理弹窗与审查来源共用。 */
export function projectInitial(name: string): string {
  return (name.replace(/^[^\p{L}\p{N}]+/u, "")[0] ?? "?").toLocaleUpperCase();
}
