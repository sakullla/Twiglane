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
