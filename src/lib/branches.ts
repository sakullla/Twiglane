import type { BranchRecord } from "./types";

const VISIBLE_LIMIT = 200;

export function filterBranches(branches: BranchRecord[], query: string): BranchRecord[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? branches.filter((branch) => branch.name.toLowerCase().includes(needle))
    : branches.slice();
  return matched.slice(0, VISIBLE_LIMIT);
}

export function branchLists(branches: BranchRecord[]): { local: BranchRecord[]; remote: BranchRecord[] } {
  return {
    local: branches.filter((branch) => !branch.remote),
    remote: branches.filter((branch) => branch.remote),
  };
}

export interface BranchGroup {
  prefix: string;
  branches: BranchRecord[];
}

export interface BranchBuckets {
  top: BranchRecord[];
  groups: BranchGroup[];
}

/** 只标本地分支，远程同名跟踪分支不带这枚徽章。 */
export function isDefaultBranch(branch: BranchRecord, defaultName: string | null | undefined): boolean {
  return !!defaultName && !branch.remote && branch.name === defaultName;
}

/** 按名称里的第一个 / 分组。没有 / 的留在顶层，组内保持原顺序。 */
export function bucketBranches(branches: BranchRecord[]): BranchBuckets {
  const top: BranchRecord[] = [];
  const groups: BranchGroup[] = [];
  const byPrefix = new Map<string, BranchGroup>();
  for (const branch of branches) {
    const slash = branch.name.indexOf("/");
    if (slash <= 0) {
      top.push(branch);
      continue;
    }
    const prefix = branch.name.slice(0, slash);
    let group = byPrefix.get(prefix);
    if (!group) {
      group = { prefix, branches: [] };
      byPrefix.set(prefix, group);
      groups.push(group);
    }
    group.branches.push(branch);
  }
  return { top, groups };
}

/**
 * 手动记录优先。没有记录时，只有包含当前分支的组展开。
 * key 要带上本地/远程，避免同名的另一侧被一起打开。
 */
export function groupIsOpen(
  branches: BranchRecord[],
  currentName: string | null,
  overrides: Readonly<Record<string, boolean>>,
  key: string,
): boolean {
  if (Object.hasOwn(overrides, key)) return overrides[key] === true;
  return branches.some((branch) => branch.current || (currentName !== null && !branch.remote && branch.name === currentName));
}
