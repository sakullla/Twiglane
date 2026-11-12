// @vitest-environment node
import { describe, expect, it } from "vitest";
import { commentPrefix, cursorInfo, detectIndent, indentEdit, newlineEdit, toggleCommentEdit, type TextEdit } from "../src/lib/editor-keys";
import { expandReplacement, findMatches, firstEndingAfter, matchAtOrAfter, parseGoto, replaceAllEdit } from "../src/lib/editor-find";
import { appendFileWindow, FILE_WINDOW_BYTES, FILE_WINDOW_LINES } from "../src/lib/file-window";
import { createTextDiff, LOCAL_DIFF_CHAR_LIMIT, LOCAL_DIFF_LINE_LIMIT } from "../src/lib/diff";

function apply(text: string, edit: TextEdit | null): string {
  if (!edit) return text;
  return text.slice(0, edit.from) + edit.text + text.slice(edit.to);
}

describe("editor-keys", () => {
  it("detects indent style", () => {
    expect(detectIndent("a\n\tb\n\tc")).toBe("\t");
    expect(detectIndent("a\n  b\n    c")).toBe("  ");
    expect(detectIndent("a\nb")).toBe("    ");
  });

  it("inserts one unit for Tab without a multi-line selection", () => {
    const edit = indentEdit("ab", 1, 1, "  ", false)!;
    expect(apply("ab", edit)).toBe("a  b");
    expect(edit.selStart).toBe(3);
  });

  it("indents and outdents whole lines, skipping blank ones", () => {
    const text = "a\n\nb";
    const indented = apply(text, indentEdit(text, 0, text.length, "  ", false));
    expect(indented).toBe("  a\n\n  b");
    expect(apply(indented, indentEdit(indented, 0, indented.length, "  ", true))).toBe(text);
    expect(indentEdit("a", 0, 0, "  ", true)).toBeNull();
  });

  it("does not include the line after a selection that ends at a line start", () => {
    const text = "a\nb\nc";
    expect(apply(text, indentEdit(text, 0, 4, "  ", false))).toBe("  a\n  b\nc");
  });

  it("keeps indentation on Enter and splits bracket pairs", () => {
    expect(newlineEdit("abc", 3, 3, "  ")).toBeNull();
    expect(apply("  abc", newlineEdit("  abc", 5, 5, "  "))).toBe("  abc\n  ");
    const pair = "f() {}";
    const edit = newlineEdit(pair, 5, 5, "  ")!;
    expect(apply(pair, edit)).toBe("f() {\n  \n}");
    expect(edit.selStart).toBe(8);
  });

  it("toggles line comments", () => {
    const text = "  a\n  b";
    const on = apply(text, toggleCommentEdit(text, 0, text.length, "//"));
    expect(on).toBe("  // a\n  // b");
    expect(apply(on, toggleCommentEdit(on, 0, on.length, "//"))).toBe(text);
    expect(toggleCommentEdit("\n", 0, 0, "//")).toBeNull();
    expect(commentPrefix("python")).toBe("#");
    expect(commentPrefix("json")).toBeNull();
  });

  it("reports line, column and selection length", () => {
    expect(cursorInfo("ab\ncd", 4, 5)).toEqual({ line: 2, column: 2, selected: 1 });
    expect(cursorInfo("", 0, 0)).toEqual({ line: 1, column: 1, selected: 0 });
  });
});


const plain = { caseSensitive: false, regex: false, wholeWord: false };

function spans(text: string, query: string, options = plain): string[] {
  return findMatches(text, query, options).matches.map((match) => text.slice(match.start, match.end));
}

describe("editor-find", () => {
  it("finds literal text case-insensitively by default and treats regex characters literally", () => {
    expect(spans("Foo foo FOO", "foo")).toEqual(["Foo", "foo", "FOO"]);
    expect(spans("Foo foo", "foo", { ...plain, caseSensitive: true })).toEqual(["foo"]);
    expect(spans("a.b axb", "a.b")).toEqual(["a.b"]);
  });

  it("matches whole words, including CJK boundaries", () => {
    expect(spans("cat concat cat_x cat", "cat", { ...plain, wholeWord: true })).toEqual(["cat", "cat"]);
    expect(spans("中文 中文字", "中文", { ...plain, wholeWord: true })).toEqual(["中文"]);
  });

  it("reports invalid regex instead of throwing and skips empty matches", () => {
    const bad = findMatches("abc", "(", { ...plain, regex: true });
    expect(bad.error).toMatch(/正则/);
    expect(bad.matches).toEqual([]);
    expect(findMatches("a\nb", "^", { ...plain, regex: true }).matches).toEqual([]);
  });

  it("truncates at the limit", () => {
    const result = findMatches("aaaa", "a", plain, 2);
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("expands dollar references only in regex mode", () => {
    const text = "key: value";
    const [match] = findMatches(text, "(\\w+): (?<v>\\w+)", { ...plain, regex: true }).matches;
    expect(expandReplacement("$2=$1 [$&] $<v> $$ $9", match, text, true)).toBe("value=key [key: value] value $ $9");
    expect(expandReplacement("$1", match, text, false)).toBe("$1");
  });

  it("replaces all matches within one span", () => {
    const text = "x a x b x";
    const { matches } = findMatches(text, "x", plain);
    expect(replaceAllEdit(text, matches, "yy", false)).toEqual({ from: 0, to: 9, text: "yy a yy b yy" });
    expect(replaceAllEdit(text, [], "y", false)).toBeNull();
  });

  it("locates the current match and line overlaps", () => {
    const { matches } = findMatches("ab ab ab", "ab", plain);
    expect(matchAtOrAfter(matches, 0)).toBe(0);
    expect(matchAtOrAfter(matches, 1)).toBe(1);
    expect(matchAtOrAfter(matches, 7)).toBe(0);
    expect(matchAtOrAfter([], 0)).toBe(-1);
    expect(firstEndingAfter(matches, 2)).toBe(1);
  });

  it("parses goto input", () => {
    expect(parseGoto("12")).toEqual({ line: 12, column: 1 });
    expect(parseGoto(" 3:7 ")).toEqual({ line: 3, column: 7 });
    expect(parseGoto("3：7")).toEqual({ line: 3, column: 7 });
    expect(parseGoto("0")).toBeNull();
    expect(parseGoto("abc")).toBeNull();
  });
});


describe("正文分页内存窗口", () => {
  it("持续续读只保留预算内的尾部，偏移仍能定位准确行号", () => {
    let lines: string[] = [];
    let offset = 0;
    for (let page = 0; page < 60; page += 1) {
      const next = Array.from({ length: 500 }, (_, index) => `line-${page * 500 + index}`);
      const result = appendFileWindow(lines, next);
      lines = result.lines;
      offset += result.dropped;
      expect(lines.length).toBeLessThanOrEqual(FILE_WINDOW_LINES);
      expect(lines[0]).toBe(`line-${offset}`);
    }
    expect(offset + lines.length).toBe(30_000);
    expect(lines.at(-1)).toBe("line-29999");
  });

  it("长行按估算字节预算裁剪，不裁断字符，原数组不被修改", () => {
    const line = "中文😀".repeat(8000);
    const current = Array.from({ length: 80 }, () => line);
    const next = ["last"];
    const result = appendFileWindow(current, next);
    expect(result.lines.reduce((sum, value) => sum + value.length * 2 + 32, 0)).toBeLessThanOrEqual(FILE_WINDOW_BYTES);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.lines[0]).toBe(line);
    expect(result.lines.at(-1)).toBe("last");
    expect(current).toHaveLength(80);
    expect(next).toEqual(["last"]);
  });
});


describe("超大本地文本差异", () => {
  it("总字符预算截在 emoji 中间时也不保留半个代理对", () => {
    const prefix = `${"x".repeat(100)}\n`.repeat(Math.floor(LOCAL_DIFF_CHAR_LIMIT / 101));
    const tail = "x".repeat(LOCAL_DIFF_CHAR_LIMIT - prefix.length - 1);
    const diff = createTextDiff("large.txt", "", `${prefix}${tail}😀end`);
    expect(diff.truncated).toBe(true);
    expect(diff.lines.at(-1)?.text).toBe(`+${tail}`);
  });

  it("几十万行替换保持预览有界，不触发展开参数栈溢出", () => {
    const before = "old\n".repeat(200_000);
    const after = "new\n".repeat(200_000);
    const diff = createTextDiff("large.txt", before, after);
    expect(diff.truncated).toBe(true);
    expect(diff.complete).toBe(false);
    expect(diff.lines.length).toBeLessThanOrEqual(LOCAL_DIFF_LINE_LIMIT * 2 + 1);
    expect(diff.summary).toContain("部分内容");
    expect(before.length).toBe(800_000);
    expect(after.length).toBe(800_000);
  });

  it("大量纯删除不需要二维对齐表，仍保留准确行号", () => {
    const diff = createTextDiff("removed.txt", "gone\n".repeat(30_000), "");
    expect(diff.deletions).toBe(30_000);
    expect(diff.complete).toBe(true);
    expect(diff.lines.at(-1)?.oldNo).toBe(30_000);
    expect(diff.lines.at(-1)?.newNo).toBeNull();
  });

  it("超长单行限制显示长度并保持完整 Unicode 字符", () => {
    const diff = createTextDiff("large.json", "", `a${"😀".repeat(100_000)}`);
    expect(diff.truncated).toBe(true);
    const added = diff.lines.find((line) => line.kind === "add")!.text;
    expect(added.length).toBeLessThanOrEqual(32 * 1024 + 1);
    expect(added.endsWith("😀")).toBe(true);
  });
});
