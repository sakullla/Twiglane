import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  diffPrefs,
  parseStoredDiffPrefs,
  resetDiffPrefs,
  setHideWhitespaceOnly,
  setShowWhitespace,
  toggleHideWhitespaceOnly,
  toggleShowWhitespace,
} from "../src/lib/diff-prefs.svelte";

const KEY = "twiglane.diffPrefs";

function stored(): unknown {
  return JSON.parse(localStorage.getItem(KEY) ?? "{}");
}

describe("差异显示偏好（本机）", () => {
  beforeEach(() => {
    localStorage.clear();
    resetDiffPrefs();
  });

  it("默认都不开启：先看不带标记的原文，需要时才打开", () => {
    expect(diffPrefs.showWhitespace).toBe(false);
    expect(diffPrefs.hideWhitespaceOnly).toBe(false);
  });

  it("改一个开关立刻写进本机存储，另一项不变", () => {
    setShowWhitespace(true);
    expect(diffPrefs.showWhitespace).toBe(true);
    expect(stored()).toEqual({ showWhitespace: true, hideWhitespaceOnly: false });

    setHideWhitespaceOnly(true);
    expect(stored()).toEqual({ showWhitespace: true, hideWhitespaceOnly: true });

    setShowWhitespace(false);
    expect(stored()).toEqual({ showWhitespace: false, hideWhitespaceOnly: true });
  });

  it("两个开关各自切换，互不覆盖", () => {
    toggleShowWhitespace();
    expect(diffPrefs).toMatchObject({ showWhitespace: true, hideWhitespaceOnly: false });
    toggleHideWhitespaceOnly();
    expect(diffPrefs).toMatchObject({ showWhitespace: true, hideWhitespaceOnly: true });
    toggleShowWhitespace();
    expect(diffPrefs).toMatchObject({ showWhitespace: false, hideWhitespaceOnly: true });
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
    expect(stored()).toEqual({ showWhitespace: false, hideWhitespaceOnly: false });
    // 存储恢复后下一次修改照常落盘。
    setHideWhitespaceOnly(false);
    expect(stored()).toEqual({ showWhitespace: true, hideWhitespaceOnly: false });
  });

  it("读取失败或内容坏掉时退回默认值，不让一条脏数据卡住差异视图", () => {
    expect(parseStoredDiffPrefs(null)).toEqual({ showWhitespace: false, hideWhitespaceOnly: false });
    expect(parseStoredDiffPrefs("")).toEqual({ showWhitespace: false, hideWhitespaceOnly: false });
    expect(parseStoredDiffPrefs("{坏掉的 JSON")).toEqual({ showWhitespace: false, hideWhitespaceOnly: false });
    expect(parseStoredDiffPrefs("[1,2,3]")).toEqual({ showWhitespace: false, hideWhitespaceOnly: false });
    // 只认真正的 true：字符串 "true"、1 都不算用户打开过。
    expect(parseStoredDiffPrefs('{"showWhitespace":"true","hideWhitespaceOnly":1}')).toEqual({
      showWhitespace: false,
      hideWhitespaceOnly: false,
    });
    expect(parseStoredDiffPrefs('{"showWhitespace":true}')).toEqual({ showWhitespace: true, hideWhitespaceOnly: false });
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
