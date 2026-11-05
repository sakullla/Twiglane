import type { BranchRecord } from "./types";

export function filterBranches(branches: BranchRecord[], query: string): BranchRecord[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? branches.filter((branch) => branch.name.toLowerCase().includes(needle))
    : branches.slice();
  return matched;
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

/** 只有名字的列表（原生下拉框）同样按第一个 / 分组，用于 <optgroup>。 */
export function bucketNames(names: string[]): { top: string[]; groups: { prefix: string; names: string[] }[] } {
  const buckets = bucketBranches(names.map((name) => ({ name }) as BranchRecord));
  return {
    top: buckets.top.map((branch) => branch.name),
    groups: buckets.groups.map((group) => ({ prefix: group.prefix, names: group.branches.map((branch) => branch.name) })),
  };
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

/**
 * 主干分支：本地默认分支和它的远程对应分支（后端给出的 mergeBases，例如 main 与 origin/main）。
 * 后端没给时只认本地默认分支。列表里用星标代替普通的分支图标。
 */
export function mainBranchNames(state: { defaultBranch?: string | null; mergeBases?: string[] } | null | undefined): Set<string> {
  if (!state) return new Set();
  if (state.mergeBases && state.mergeBases.length > 0) return new Set(state.mergeBases);
  return state.defaultBranch ? new Set([state.defaultBranch]) : new Set();
}

/**
 * 远程分支的短名已被另一个本地分支占用（例如 upstream/main 与跟踪 origin/main 的 main）时，
 * 给它一个不冲突的本地名：`upstream-main`，再冲突就加序号。
 */
export function trackNameFor(remoteBranch: string, branches: BranchRecord[]): string {
  const slash = remoteBranch.indexOf("/");
  const remote = slash > 0 ? remoteBranch.slice(0, slash) : "remote";
  const short = slash > 0 ? remoteBranch.slice(slash + 1) : remoteBranch;
  const taken = new Set(branches.filter((branch) => !branch.remote).map((branch) => branch.name));
  const base = `${remote}-${short}`;
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}
