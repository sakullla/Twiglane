import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND } from "../src/lib/brand";
import { classifyDiffLine } from "../src/lib/diff";
import { DraftBuffer } from "../src/lib/draft";
import { normalizeError } from "../src/lib/errors";
import { toSideRows } from "../src/lib/diff";
import { branchLabel, commitScope, dependencyNote, filterRows, gitInstallHint, groupFiles, retainSelection, selectionAfterEdit, syncLabel } from "../src/lib/labels";
import { finishDiffAttempt } from "../src/lib/diff";
import {
  clampWidth,
  codeRuler,
  lineWidth,
  MAX_RULER_CELLS,
  nextIndex,
  RULER_LINES,
  RULER_SAMPLE_CHARS,
  rulerPadding,
  scrollByRows,
  scrollIndexIntoView,
  shouldPoll,
  visibleRange,
} from "../src/lib/layout";
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
  remoteCheckedAtMs: null,
  remoteCheckStale: false,
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
    expect(syncLabel({ ...branch, liveRemoteChecked: true, remoteCheckedAtMs: Date.UTC(2026, 9, 31, 1, 2) })).toContain(
      "已于",
    );
    expect(syncLabel({ ...branch, remoteCheckStale: true, remoteCheckedAtMs: Date.UTC(2026, 9, 31, 1, 2) })).toContain(
      "过期",
    );
    expect(syncLabel({ ...branch, liveRemoteChecked: true })).not.toContain("未检查远程");
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
    expect(selectionAfterEdit(files, { path: "new.txt", side: "unstaged" })?.side).toBe("staged");
    expect(filterRows(groups.unstaged.concat(groups.staged), "app").map((row) => row.path)).toEqual(["src/app.ts"]);
    expect(commitScope("main", files).label).toBe("提交到 main · 1 个已暂存文件");
    expect(commitScope("main", files).paths).toEqual(["new.txt"]);
    const long = Array.from({ length: 1000 }, (_, index) => index);
    expect(visibleRange(long.length, 800, 200, 40).start).toBeGreaterThan(0);
    expect(visibleRange(long.length, 800, 200, 40).end).toBeLessThan(long.length);
    const paired = toSideRows([
      { kind: "hunk", text: "@@ -1 +1 @@", oldNo: null, newNo: null, hunkIndex: 0 },
      { kind: "del", text: "-old", oldNo: 1, newNo: null, hunkIndex: 0 },
      { kind: "add", text: "+new", oldNo: null, newNo: 1, hunkIndex: 0 },
    ]);
    expect(paired[1]?.left?.text).toBe("-old");
    expect(paired[1]?.right?.text).toBe("+new");
    expect(paired[0]?.showStage).toBe(true);
    // 一删两增：第二个新增行排在配对行之后，左栏不多出空行，右栏行号保持递增。
    const uneven = toSideRows([
      { kind: "context", text: " a", oldNo: 12, newNo: 12, hunkIndex: 0 },
      { kind: "del", text: "-old", oldNo: 13, newNo: null, hunkIndex: 0 },
      { kind: "add", text: "+new", oldNo: null, newNo: 13, hunkIndex: 0 },
      { kind: "add", text: "+more", oldNo: null, newNo: 14, hunkIndex: 0 },
      { kind: "context", text: " b", oldNo: 14, newNo: 15, hunkIndex: 0 },
    ]);
    expect(uneven.map((row) => [row.left?.no ?? null, row.right?.no ?? null])).toEqual([
      [12, 12],
      [13, 13],
      [null, 14],
      [14, 15],
    ]);
    const missingNewline = "\\ No newline at end of file";
    // 标记插在没有结尾换行的删除行和后面的新增行之间时，左右仍要落在同一行。
    const splitByMarker = toSideRows([
      { kind: "del", text: "-old", oldNo: 1, newNo: null, hunkIndex: 0 },
      { kind: "nonewline", text: missingNewline, oldNo: null, newNo: null, hunkIndex: 0 },
      { kind: "add", text: "+new", oldNo: null, newNo: 1, hunkIndex: 0 },
    ]);
    expect(splitByMarker[0]?.left?.text).toBe("-old");
    expect(splitByMarker[0]?.right?.text).toBe("+new");
    expect(splitByMarker[1]?.left?.text).toBe(missingNewline);
    expect(splitByMarker[1]?.right).toBeNull();
    // 删除行本身有换行、标记出现在新增行之后时，配对保持，标记跟在新增侧。
    const markerAfterAdd = toSideRows([
      { kind: "del", text: "-old", oldNo: 1, newNo: null, hunkIndex: 0 },
      { kind: "add", text: "+new", oldNo: null, newNo: 1, hunkIndex: 0 },
      { kind: "nonewline", text: missingNewline, oldNo: null, newNo: null, hunkIndex: 0 },
    ]);
    expect(markerAfterAdd[0]?.left?.text).toBe("-old");
    expect(markerAfterAdd[0]?.right?.text).toBe("+new");
    expect(markerAfterAdd[1]?.left).toBeNull();
    expect(markerAfterAdd[1]?.right?.text).toBe(missingNewline);
    // 多出来的新增行仍排在配对行之后，标记不占用配对槽。
    const markerBetweenExtra = toSideRows([
      { kind: "del", text: "-old", oldNo: 13, newNo: null, hunkIndex: 0 },
      { kind: "nonewline", text: missingNewline, oldNo: null, newNo: null, hunkIndex: 0 },
      { kind: "add", text: "+new", oldNo: null, newNo: 13, hunkIndex: 0 },
      { kind: "add", text: "+more", oldNo: null, newNo: 14, hunkIndex: 0 },
    ]);
    expect(markerBetweenExtra.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ["-old", "+new"],
      [missingNewline, null],
      [null, "+more"],
    ]);
    expect(nextIndex(-1, "ArrowDown", 2)).toBe(0);
    expect(nextIndex(0, "ArrowUp", 2)).toBe(0);
    expect(nextIndex(1, "End", 2)).toBe(1);
    expect(nextIndex(0, "ArrowDown", 0)).toBeNull();
    expect(scrollIndexIntoView(2, 0, 200, 40)).toBe(0);
    expect(scrollIndexIntoView(10, 0, 200, 40)).toBe(240);
    expect(scrollIndexIntoView(1, 80, 200, 40)).toBe(40);
    expect(scrollIndexIntoView(20, 0, 0, 40)).toBe(800);
    expect(scrollByRows(0, 1, 80, 220, 22)).toBe(22);
    expect(scrollByRows(0, 10, 80, 220, 22)).toBe(220);
    expect(scrollByRows(0, 80, 80, 220, 22)).toBe(80 * 22 - 220);
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

  it("被取代的差异结果和错误都丢弃", async () => {
    let token = 1;
    let path = "a.txt";
    const current = () => ({ token, repo: "/repo", path, side: "unstaged" as const });
    const attempt = { token: 1, repo: "/repo", path: "a.txt", side: "unstaged" };
    await expect(finishDiffAttempt(attempt, current, async () => "diff")).resolves.toEqual({
      state: "applied",
      value: "diff",
    });
    await expect(
      finishDiffAttempt(attempt, current, async () => {
        token = 2;
        path = "b.txt";
        throw new Error("该操作正在执行，未重复启动。");
      }),
    ).resolves.toEqual({ state: "discarded" });
    await expect(
      finishDiffAttempt(attempt, current, async () => {
        token = 3;
        return "old";
      }),
    ).resolves.toEqual({ state: "discarded" });
    await expect(
      finishDiffAttempt(
        { token: 3, repo: "/repo", path: "b.txt", side: "unstaged" },
        current,
        async () => {
          throw new Error("读取失败");
        },
      ),
    ).resolves.toMatchObject({ state: "failed" });
  });

  it("错误和 Git 提示不泄漏原始对象", () => {
    expect(normalizeError('{"code":"stale","message":"过期","generation":4}')).toEqual({
      code: "stale",
      message: "过期",
      generation: 4,
    });
    expect(gitInstallHint("MacIntel")).toContain("macOS");
    expect(gitInstallHint("windows")).toContain("Windows");
    expect(gitInstallHint("windows")).toContain("WebView2");
    expect(dependencyNote("windows")).toContain("不计入");
    expect(dependencyNote("macos")).toContain("未");
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

describe("代码窗口标尺", () => {
  const texts = (lines: { text: string }[]) => lines.map((line) => line.text);

  it("按宽度分量拆行，全角不折算成固定列数，tab 走到下一制表位", () => {
    expect(lineWidth("abc")).toEqual({ narrow: 3, wide: 0, other: 0 });
    expect(lineWidth("中文")).toEqual({ narrow: 0, wide: 2, other: 0 });
    expect(lineWidth("ａ，").wide).toBe(2);
    expect(lineWidth("\tx").narrow).toBe(5);
    expect(lineWidth("ab\tx").narrow).toBe(5);
    // 组合符和表情的宽度取决于回退字体，归到单独的分量。
    expect(lineWidth("e\u0301")).toEqual({ narrow: 1, wide: 0, other: 1 });
    expect(lineWidth("😀a")).toEqual({ narrow: 1, wide: 0, other: 2 });
  });

  it("大量中文长行不会把真实更宽的 ASCII 行挤出标尺", () => {
    const cjk = Array.from({ length: 14 }, (_, index) => `${"中".repeat(100)}${index}`);
    const ascii = "a".repeat(193);
    expect(texts(codeRuler([...cjk, ascii]))).toContain(ascii);
  });

  it("反过来，大量 ASCII 长行也挤不掉全角、表情和组合字符行", () => {
    const ascii = Array.from({ length: 40 }, (_, index) => `${"a".repeat(300)}${index}`);
    const cjk = "中".repeat(150);
    const emoji = "😀".repeat(60);
    const marks = "e\u0301".repeat(90);
    const chosen = texts(codeRuler([...ascii, cjk, emoji, marks]));
    expect(chosen).toEqual(expect.arrayContaining([cjk, emoji, marks]));
  });

  it("每个分量只保留固定行数，全量里靠后的最长行也不漏", () => {
    const lines = Array.from({ length: 50_000 }, (_, index) => `line ${index}`);
    lines.push("x".repeat(500));
    const chosen = codeRuler(lines);
    expect(chosen.length).toBeLessThanOrEqual(RULER_LINES * 4);
    expect(chosen[0].text).toBe("x".repeat(500));
  });

  it("tab 很多的短行不会被长度上界跳过", () => {
    const chosen = codeRuler(["a".repeat(30), "b".repeat(29), "\t".repeat(10)], 2);
    expect(chosen[0].text).toBe("\t".repeat(10));
  });

  it("超长行只排版样本，半角按 ch、全角按 ic 补宽", () => {
    const [ascii] = codeRuler(["a".repeat(RULER_SAMPLE_CHARS + 500)]);
    expect(ascii).toEqual({ text: "a".repeat(RULER_SAMPLE_CHARS), restCh: 500, restIc: 0 });
    expect(rulerPadding(ascii)).toBe("padding-right:calc(500ch + 0ic)");
    const [cjk] = codeRuler(["中".repeat(RULER_SAMPLE_CHARS + 300)]);
    expect(cjk).toEqual({ text: "中".repeat(RULER_SAMPLE_CHARS), restCh: 0, restIc: 300 });
    expect(rulerPadding({ text: "a", restCh: 0, restIc: 0 })).toBeUndefined();
  });

  it("补宽上限不低于后端 2 MiB 差异预览，超过才封顶", () => {
    expect(MAX_RULER_CELLS).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    const [atLimit] = codeRuler(["a".repeat(2 * 1024 * 1024)]);
    expect(atLimit.text.length + atLimit.restCh).toBe(2 * 1024 * 1024);
    const [huge] = codeRuler(["a".repeat(MAX_RULER_CELLS + 500)]);
    expect(huge.text.length + huge.restCh).toBe(MAX_RULER_CELLS);
  });

  it("空输入不产生标尺", () => {
    expect(codeRuler([])).toEqual([]);
  });
});
