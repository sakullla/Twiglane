import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND } from "../src/lib/brand";
import { classifyDiffLine } from "../src/lib/diff";
import { DraftBuffer } from "../src/lib/draft";
import { normalizeError } from "../src/lib/errors";
import { branchLabel, gitInstallHint, groupFiles, retainSelection, syncLabel } from "../src/lib/labels";
import { clampWidth, nextIndex, shouldPoll } from "../src/lib/layout";
import { filterRecent } from "../src/lib/recent";
import type { BranchInfo, FileChange, RecentRepo } from "../src/lib/types";

const branch: BranchInfo = {
  name: "feature/very-long-name",
  detached: false,
  unborn: false,
  headOid: "abc1234",
  upstream: "origin/feature/very-long-name",
  ahead: 1,
  behind: 1,
  liveRemoteChecked: false,
};

describe("最近仓库", () => {
  const repos: RecentRepo[] = [
    { name: "demo", path: "/work/alpha/demo", openedAtMs: 2 },
    { name: "demo", path: "/work/beta/demo", openedAtMs: 1 },
  ];

  it("区分同名不同路径并可按路径搜索", () => {
    expect(filterRecent(repos, "").map((repo) => repo.path)).toEqual([
      "/work/alpha/demo",
      "/work/beta/demo",
    ]);
    expect(filterRecent(repos, "beta")).toEqual([repos[1]]);
    expect(filterRecent(repos, "missing")).toEqual([]);
  });
});

describe("工作区状态", () => {
  it("同步标签明确未检查远程", () => {
    expect(syncLabel(branch)).toBe("相对已记录上游 +1 −1 · 未检查远程");
    expect(syncLabel(branch)).not.toContain("−-");
    expect(syncLabel({ ...branch, upstream: null })).toBe("无上游 · 未检查远程");
    expect(branchLabel({ ...branch, detached: true, name: null, headOid: "abcdef123456" })).toBe(
      "游离 HEAD abcdef1",
    );
    expect(branchLabel({ ...branch, unborn: true, name: "main" })).toBe("main（尚无提交）");
  });

  it("分组保留选择，键盘移动不会越过边界", () => {
    const files: FileChange[] = [
      {
        path: "src/app.ts",
        originalPath: null,
        staged: "none",
        unstaged: "modified",
        untracked: false,
        unmerged: false,
      },
      {
        path: "new.txt",
        originalPath: null,
        staged: "added",
        unstaged: "none",
        untracked: false,
        unmerged: false,
      },
    ];
    const groups = groupFiles(files);
    expect(groups.unstaged.map((file) => file.path)).toEqual(["src/app.ts"]);
    expect(groups.staged.map((file) => file.path)).toEqual(["new.txt"]);
    expect(retainSelection(files, { path: "src/app.ts", side: "unstaged" })?.path).toBe("src/app.ts");
    expect(retainSelection(files, { path: "src/app.ts", side: "staged" })).toBeNull();
    expect(nextIndex(-1, "ArrowDown", 2)).toBe(0);
    expect(nextIndex(0, "ArrowUp", 2)).toBe(0);
    expect(nextIndex(1, "End", 2)).toBe(1);
    expect(nextIndex(0, "ArrowDown", 0)).toBeNull();
  });

  it("差异符号不只依赖颜色", () => {
    expect(classifyDiffLine("+++ b/file")).toBe("meta");
    expect(classifyDiffLine("+added")).toBe("add");
    expect(classifyDiffLine("-removed")).toBe("del");
    expect(classifyDiffLine("@@ -1 +1 @@")).toBe("hunk");
  });

  it("面板宽度、监听回退和草稿切换有边界", () => {
    expect(clampWidth(10)).toBe(160);
    expect(clampWidth(900)).toBe(560);
    expect(shouldPoll(true, true, true)).toBe(true);
    expect(shouldPoll(true, false, true)).toBe(false);
    expect(shouldPoll(false, true, true)).toBe(false);
    const buffer = new DraftBuffer();
    buffer.load("/a", "old");
    buffer.edit("新说明");
    buffer.load("/b", "");
    expect(buffer.takePending("/a")).toBeNull();
    expect(buffer.takePending("/b")).toBeNull();
  });

  it("错误和 Git 提示不泄漏原始对象", () => {
    expect(normalizeError('{"code":"stale","message":"过期","generation":4}')).toEqual({
      code: "stale",
      message: "过期",
      generation: 4,
    });
    expect(gitInstallHint("MacIntel")).toContain("macOS");
    expect(gitInstallHint("windows")).toContain("Windows");
  });
});

describe("品牌", () => {
  it("介绍使用完整名称和品牌短句", () => {
    expect(BRAND.full).toBe("Twiglane（枝序）");
    expect(BRAND.tagline).toBe("让每次改动，都清晰有序。");
    const readme = readFileSync(path.resolve(process.cwd(), "README.md"), "utf8");
    const html = readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    expect(readme).toContain(BRAND.full);
    expect(readme).toContain(BRAND.tagline);
    expect(html).toContain("<title>Twiglane</title>");
    expect(html).toContain('lang="zh-CN"');
  });
});
