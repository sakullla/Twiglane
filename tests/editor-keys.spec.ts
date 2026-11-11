import { describe, expect, it } from "vitest";
import { commentPrefix, cursorInfo, detectIndent, indentEdit, newlineEdit, toggleCommentEdit, type TextEdit } from "../src/lib/editor-keys";

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
