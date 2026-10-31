import { describe, expect, it } from "vitest";
import { branchLists, filterBranches } from "../src/lib/branches";
import type { BranchRecord } from "../src/lib/types";

const branches: BranchRecord[] = [
  { name: "main", remote: false, current: true, upstream: "origin/main", worktree: null },
  { name: "feature/ui", remote: false, current: false, upstream: null, worktree: "/tmp/wt" },
  { name: "origin/main", remote: true, current: false, upstream: null, worktree: null },
  { name: "origin/feature/ui", remote: true, current: false, upstream: null, worktree: null },
];

describe("分支搜索", () => {
  it("同时覆盖本地和远程，并限制可见数量", () => {
    expect(filterBranches(branches, "feature").map((branch) => branch.name)).toEqual([
      "feature/ui",
      "origin/feature/ui",
    ]);
    expect(filterBranches(branches, "missing")).toEqual([]);
    const lists = branchLists(filterBranches(branches, ""));
    expect(lists.local.map((branch) => branch.name)).toEqual(["main", "feature/ui"]);
    expect(lists.remote.map((branch) => branch.name)).toEqual(["origin/main", "origin/feature/ui"]);
    const many = Array.from({ length: 240 }, (_, index) => ({
      name: `branch-${index}`,
      remote: false,
      current: false,
      upstream: null,
      worktree: null,
    }));
    expect(filterBranches(many, "").length).toBe(200);
  });
});
