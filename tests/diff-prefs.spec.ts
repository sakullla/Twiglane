import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDiffFilterRules,
  diffPrefs,
  parseStoredDiffPrefs,
  resetDiffPrefs,
  setHideWhitespaceOnly,
  setIgnoreBlankLines,
  setIgnoreCase,
  setShowWhitespace,
  setWhitespaceMode,
  toggleHideWhitespaceOnly,
  toggleIgnoreEol,
  toggleShowWhitespace,
} from "../src/lib/diff-prefs.svelte";
import { analyzeDiffSpecials, createTextDiff, filterDiffHunks } from "../src/lib/diff";

const KEY = "twiglane.diffPrefs";

function stored(): unknown {
  return JSON.parse(localStorage.getItem(KEY) ?? "{}");
}

const DEFAULT_PREFS = {
  showWhitespace: false,
  hideWhitespaceOnly: false,
  whitespaceMode: "none",
  ignoreBlankLines: false,
  ignoreCase: false,
};

describe("差异显示偏好（本机）", () => {
  beforeEach(() => {
    localStorage.clear();
    resetDiffPrefs();
  });

  it("默认都不开启：先看不带标记的原文，需要时才打开", () => {
    expect(diffPrefs.showWhitespace).toBe(false);
    expect(diffPrefs.hideWhitespaceOnly).toBe(false);
    expect(diffPrefs.whitespaceMode).toBe("none");
    expect(diffPrefs.ignoreBlankLines).toBe(false);
    expect(diffPrefs.ignoreCase).toBe(false);
  });

  it("改一个开关立刻写进本机存储，另一项不变", () => {
    setShowWhitespace(true);
    expect(diffPrefs.showWhitespace).toBe(true);
    expect(stored()).toEqual({ ...DEFAULT_PREFS, showWhitespace: true });

    setHideWhitespaceOnly(true);
    expect(stored()).toEqual({ ...DEFAULT_PREFS, showWhitespace: true, hideWhitespaceOnly: true, whitespaceMode: "all" });

    setShowWhitespace(false);
    expect(stored()).toEqual({ ...DEFAULT_PREFS, showWhitespace: false, hideWhitespaceOnly: true, whitespaceMode: "all" });
  });

  it("两个开关各自切换，互不覆盖", () => {
    toggleShowWhitespace();
    expect(diffPrefs).toMatchObject({ showWhitespace: true, hideWhitespaceOnly: false });
    toggleHideWhitespaceOnly();
    expect(diffPrefs).toMatchObject({ showWhitespace: true, hideWhitespaceOnly: true, whitespaceMode: "all" });
    toggleShowWhitespace();
    expect(diffPrefs).toMatchObject({ showWhitespace: false, hideWhitespaceOnly: true, whitespaceMode: "all" });
  });

  it("支持 CRLF/LF、行尾空白、空白数量、纯空行与大小写规则并可一键清除", () => {
    toggleIgnoreEol();
    expect(diffPrefs.whitespaceMode).toBe("eol");
    expect(diffPrefs.hideWhitespaceOnly).toBe(false);
    setWhitespaceMode("trailing");
    setIgnoreBlankLines(true);
    setIgnoreCase(true);
    expect(parseStoredDiffPrefs(localStorage.getItem(KEY))).toEqual({
      showWhitespace: false,
      hideWhitespaceOnly: false,
      whitespaceMode: "trailing",
      ignoreBlankLines: true,
      ignoreCase: true,
    });
    clearDiffFilterRules();
    expect(diffPrefs).toMatchObject(DEFAULT_PREFS);
  });

  it("工具条溢出入口复用同一份偏好，不另写存储键", () => {
    setShowWhitespace(true);
    setHideWhitespaceOnly(true);
    expect(Object.keys(stored() as Record<string, unknown>).sort()).toEqual([
      "hideWhitespaceOnly",
      "ignoreBlankLines",
      "ignoreCase",
      "showWhitespace",
      "whitespaceMode",
    ]);
    // 收进溢出区域后读到的仍是这份状态，不会出现第二套开关。
    expect(parseStoredDiffPrefs(localStorage.getItem(KEY))).toEqual({
      ...DEFAULT_PREFS,
      showWhitespace: true,
      hideWhitespaceOnly: true,
      whitespaceMode: "all",
    });
    resetDiffPrefs();
    expect(diffPrefs).toMatchObject(DEFAULT_PREFS);
    expect(stored()).toEqual(DEFAULT_PREFS);
  });

  it("存储写不进去时只在本次会话生效，不抛错也不回滚", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {},
      clear: () => {},
    });
    try {
      expect(() => setShowWhitespace(true)).not.toThrow();
      expect(diffPrefs.showWhitespace).toBe(true);
      expect(() => setHideWhitespaceOnly(true)).not.toThrow();
      expect(diffPrefs.hideWhitespaceOnly).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    // 写失败时存下的还是打开设置前的那一份，会话里的值却已经生效。
    expect(stored()).toEqual(DEFAULT_PREFS);
    // 存储恢复后下一次修改照常落盘。
    setHideWhitespaceOnly(false);
    expect(stored()).toEqual({ ...DEFAULT_PREFS, showWhitespace: true });
  });

  it("读取失败或内容坏掉时退回默认值，并兼容旧版本仅两字段的存储格式", () => {
    expect(parseStoredDiffPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parseStoredDiffPrefs("")).toEqual(DEFAULT_PREFS);
    expect(parseStoredDiffPrefs("{坏掉的 JSON")).toEqual(DEFAULT_PREFS);
    expect(parseStoredDiffPrefs("[1,2,3]")).toEqual(DEFAULT_PREFS);
    // 只认真正的 true：字符串 "true"、1 都不算用户打开过。
    expect(parseStoredDiffPrefs('{"showWhitespace":"true","hideWhitespaceOnly":1}')).toEqual(DEFAULT_PREFS);
    expect(parseStoredDiffPrefs('{"showWhitespace":true}')).toEqual({ ...DEFAULT_PREFS, showWhitespace: true });
    expect(parseStoredDiffPrefs('{"hideWhitespaceOnly":true}')).toEqual({
      ...DEFAULT_PREFS,
      hideWhitespaceOnly: true,
      whitespaceMode: "all",
    });
  });

  it("getItem 抛错时模块级偏好仍可用", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
    try {
      vi.resetModules();
      const reloaded = await import("../src/lib/diff-prefs.svelte");
      expect(reloaded.diffPrefs.showWhitespace).toBe(false);
      expect(reloaded.diffPrefs.hideWhitespaceOnly).toBe(false);
      reloaded.setShowWhitespace(true);
      expect(reloaded.diffPrefs.showWhitespace).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe("增强差异比对规则与性能", () => {
  it("识别 LF ↔ CRLF 变化与 BOM 变化，并支持按规则过滤改动块", () => {
    const lines = [
      { kind: "hunk", text: "@@ -1,2 +1,2 @@", oldNo: null, newNo: null, hunkIndex: 0 },
      { kind: "del", text: "-const a = 1;", oldNo: 1, newNo: null, hunkIndex: 0 },
      { kind: "add", text: "+const a = 1;", oldNo: null, newNo: 1, hunkIndex: 0, eol: "crlf" as const },
      { kind: "hunk", text: "@@ -5,1 +5,2 @@", oldNo: null, newNo: null, hunkIndex: 1 },
      { kind: "add", text: "+   ", oldNo: null, newNo: 5, hunkIndex: 1, eol: "crlf" as const },
      { kind: "hunk", text: "@@ -10,1 +11,1 @@", oldNo: null, newNo: null, hunkIndex: 2 },
      { kind: "del", text: "-SELECT * FROM users", oldNo: 10, newNo: null, hunkIndex: 2 },
      { kind: "add", text: "+select * from users", oldNo: null, newNo: 11, hunkIndex: 2 },
    ];
    const specials = analyzeDiffSpecials(lines);
    expect(specials.eolLabel).toBe("LF → 混合");
    expect(specials.eolOnlyHunks).toBe(1);
    expect(specials.bomChanged).toBe(false);

    expect([...filterDiffHunks(lines, { whitespaceMode: "eol", ignoreBlankLines: false, ignoreCase: false }).hunks]).toEqual([0]);
    expect([...filterDiffHunks(lines, { whitespaceMode: "none", ignoreBlankLines: true, ignoreCase: false }).hunks]).toEqual([1]);
    expect([...filterDiffHunks(lines, { whitespaceMode: "none", ignoreBlankLines: false, ignoreCase: true }).hunks]).toEqual([2]);
    expect([...filterDiffHunks(lines, { whitespaceMode: "eol", ignoreBlankLines: false, ignoreCase: true }).hunks]).toEqual([0, 2]);
  });

  it("Myers 文本比对在数千行大文件少量编辑下精准且不退化为整块替换", () => {
    const base = Array.from({ length: 2000 }, (_, i) => `line_${i}`);
    const next = [...base];
    next[1200] = "line_1200_changed";
    const diff = createTextDiff("big.ts", base.join("\n") + "\n", next.join("\n") + "\n", 1);
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.lines.some((line) => line.kind === "del" && line.text === "-line_1200")).toBe(true);
    expect(diff.lines.some((line) => line.kind === "add" && line.text === "+line_1200_changed")).toBe(true);
  });
});
