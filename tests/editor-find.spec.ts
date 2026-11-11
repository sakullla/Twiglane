import { describe, expect, it } from "vitest";
import { expandReplacement, findMatches, firstEndingAfter, matchAtOrAfter, parseGoto, replaceAllEdit } from "../src/lib/editor-find";

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
