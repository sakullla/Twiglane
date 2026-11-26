/**
 * 每仓最近访问的本地分支记忆：
 * - 按规范化仓库路径持久化在 localStorage（上限 5 条，去重，最新在前）；
 * - localStorage 不可用或抛错时静默退化为会话内存，不阻塞任何分支操作。
 */
export const RECENT_BRANCHES_STORAGE_KEY = "twiglane.recentBranches.v1";
export const RECENT_BRANCHES_LIMIT = 5;

type RecentBranchStore = Record<string, string[]>;

const memoryStore = new Map<string, string[]>();

/** 规范化仓库路径键，去掉多余尾部分隔符，避免同一仓库产生重复键。 */
export function normalizeRecentRepoKey(repoPath: string): string {
  const trimmed = repoPath.trim();
  if (!trimmed) return "";
  if (trimmed === "/" || /^[a-zA-Z]:[\\/]?$/.test(trimmed)) return trimmed.replace(/\\/g, "/");
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
}

function sanitizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
    if (result.length >= RECENT_BRANCHES_LIMIT) break;
  }
  return result;
}

function readStore(): { map: RecentBranchStore; persistent: boolean } {
  try {
    const storage = globalThis.localStorage;
    if (!storage) {
      return { map: Object.fromEntries(memoryStore), persistent: false };
    }
    const raw = storage.getItem(RECENT_BRANCHES_STORAGE_KEY);
    if (!raw) return { map: {}, persistent: true };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { map: {}, persistent: true };
    }
    const map: RecentBranchStore = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeRecentRepoKey(key);
      if (!normalized) continue;
      const list = sanitizeList(value);
      if (list.length > 0) map[normalized] = list;
    }
    return { map, persistent: true };
  } catch {
    return { map: Object.fromEntries(memoryStore), persistent: false };
  }
}

function writeStore(map: RecentBranchStore): void {
  memoryStore.clear();
  for (const [key, list] of Object.entries(map)) {
    if (list.length > 0) memoryStore.set(key, [...list]);
  }
  try {
    globalThis.localStorage?.setItem(RECENT_BRANCHES_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 存储不可用或配额满时保留内存态，静默退化。
  }
}

/** 读取某仓库最近访问的本地分支列表；传入 currentBranch 时自动排除当前分支。 */
export function getRecentBranches(repoPath: string, currentBranch?: string | null): string[] {
  const key = normalizeRecentRepoKey(repoPath);
  if (!key) return [];
  const { map } = readStore();
  const list = map[key] ?? [];
  const current = currentBranch?.trim() || null;
  return (current ? list.filter((name) => name !== current) : [...list]).slice(0, RECENT_BRANCHES_LIMIT);
}

/** 记录一个最近访问的本地分支到列表头部（去重、截断至上限 5 条）。 */
export function recordRecentBranch(repoPath: string, branchName: string | null | undefined): string[] {
  const key = normalizeRecentRepoKey(repoPath);
  const name = branchName?.trim() ?? "";
  if (!key || !name) return key ? getRecentBranches(key) : [];
  const { map } = readStore();
  const existing = map[key] ?? [];
  const next = [name, ...existing.filter((item) => item !== name)].slice(0, RECENT_BRANCHES_LIMIT);
  map[key] = next;
  writeStore(map);
  return next;
}

/** 本地分支重命名后同步更新记忆中的名称。 */
export function renameRecentBranch(repoPath: string, oldName: string, newName: string): string[] {
  const key = normalizeRecentRepoKey(repoPath);
  const from = oldName.trim();
  const to = newName.trim();
  if (!key || !from || !to) return key ? getRecentBranches(key) : [];
  const { map } = readStore();
  const existing = map[key] ?? [];
  if (!existing.includes(from)) return existing;
  const next = sanitizeList(existing.map((item) => (item === from ? to : item)));
  if (next.length > 0) map[key] = next;
  else delete map[key];
  writeStore(map);
  return next;
}

/** 分支已删除时从记忆中移除。 */
export function removeRecentBranch(repoPath: string, branchName: string): string[] {
  const key = normalizeRecentRepoKey(repoPath);
  const name = branchName.trim();
  if (!key || !name) return key ? getRecentBranches(key) : [];
  const { map } = readStore();
  const existing = map[key] ?? [];
  const next = existing.filter((item) => item !== name);
  if (next.length > 0) map[key] = next;
  else delete map[key];
  writeStore(map);
  return next;
}

/** 返回可切回的上一分支（可传入现有本地分支集合过滤已删分支）。 */
export function previousRecentBranch(
  repoPath: string,
  currentBranch: string | null,
  availableLocalBranches?: readonly string[],
): string | null {
  const candidates = getRecentBranches(repoPath, currentBranch);
  if (!availableLocalBranches) return candidates[0] ?? null;
  const available = new Set(availableLocalBranches);
  return candidates.find((name) => available.has(name)) ?? null;
}

/** 仅用于测试重置内存退化缓存。 */
export function resetRecentBranchesMemory(): void {
  memoryStore.clear();
}
