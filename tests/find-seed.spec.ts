import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FIND_SEED,
  findSeed,
  focusFindTarget,
  matchIndexFromLine,
  seedInput,
  selectedText,
  selectionLine,
  selectionLines,
} from "../src/lib/find-seed";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

function selectText(node: Node, start: number, end: number, endNode: Node = node): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(endNode, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("findSeed：与 VS Code 一致只带入单行选区", () => {
  it("单行选区原样带入（不裁剪首尾空格）", () => {
    expect(findSeed("carrier")).toBe("carrier");
    expect(findSeed(" a b ")).toBe(" a b ");
  });

  it("跨行、空白、过长或空选区不带入", () => {
    expect(findSeed("a\nb")).toBeNull();
    expect(findSeed("a\r\nb")).toBeNull();
    expect(findSeed("   ")).toBeNull();
    expect(findSeed("")).toBeNull();
    expect(findSeed(null)).toBeNull();
    expect(findSeed("x".repeat(MAX_FIND_SEED + 1))).toBeNull();
    expect(findSeed("x".repeat(MAX_FIND_SEED))).toHaveLength(MAX_FIND_SEED);
  });

  it("三击整行带出的末尾换行忽略后按单行处理", () => {
    expect(findSeed("const value = 1;\n")).toBe("const value = 1;");
    expect(findSeed("const value = 1;\r\n")).toBe("const value = 1;");
  });
});

describe("selectedText", () => {
  it("读文档选区，并只认 root 里的选区", () => {
    document.body.innerHTML = `<div id="a"><span data-file-line="7">hello world</span></div><div id="b">other</div>`;
    const text = document.querySelector("#a span")!.firstChild!;
    selectText(text, 0, 5);
    expect(selectedText()).toBe("hello");
    expect(selectedText(document.getElementById("a"))).toBe("hello");
    expect(selectedText(document.getElementById("b"))).toBe("");
    expect(selectionLine("data-file-line")).toBe(7);
  });

  it("焦点在输入框时读它自己的选区；查找框本身不算", () => {
    document.body.innerHTML = `<textarea>alpha beta</textarea><input id="find" value="old" />`;
    const area = document.querySelector("textarea")!;
    area.focus();
    area.setSelectionRange(6, 10);
    expect(selectedText()).toBe("beta");
    const find = document.getElementById("find") as HTMLInputElement;
    find.focus();
    find.setSelectionRange(0, 3);
    expect(selectedText(null, find)).toBe("");
  });

  it("折叠的选区没有文字", () => {
    document.body.innerHTML = `<p>text</p>`;
    selectText(document.querySelector("p")!.firstChild!, 1, 1);
    expect(selectedText()).toBe("");
    expect(selectionLine("data-file-line")).toBeNull();
  });
});

describe("seedInput / focusFindTarget", () => {
  it("写入查找词、派发 input 让绑定收到，并全选查找框文字", () => {
    document.body.innerHTML = `<input id="filter" value="old" />`;
    const input = document.getElementById("filter") as HTMLInputElement;
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    focusFindTarget(input, "carrier");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("carrier");
    expect(onInput).toHaveBeenCalledTimes(1);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 7]);
  });

  it("没有查找词时保留原内容，只全选", () => {
    document.body.innerHTML = `<input id="filter" value="keep" />`;
    const input = document.getElementById("filter") as HTMLInputElement;
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    seedInput(input, null);
    expect(input.value).toBe("keep");
    expect(onInput).not.toHaveBeenCalled();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4]);
  });

  it("按钮之类的入口只聚焦", () => {
    document.body.innerHTML = `<button>open</button>`;
    const button = document.querySelector("button")!;
    focusFindTarget(button, "x");
    expect(document.activeElement).toBe(button);
  });
});

describe("matchIndexFromLine", () => {
  const matches = [{ line: 2 }, { line: 5 }, { line: 9 }];
  it("取第一处不早于选区所在行的匹配；都在前面时回到第一处", () => {
    expect(matchIndexFromLine(matches, 5)).toBe(1);
    expect(matchIndexFromLine(matches, 6)).toBe(2);
    expect(matchIndexFromLine(matches, 10)).toBe(0);
    expect(matchIndexFromLine(matches, null)).toBe(0);
    expect(matchIndexFromLine([], 3)).toBe(-1);
  });
});

describe("selectionLines", () => {
  it("按行号判断选区是否跨行", () => {
    document.body.innerHTML = `<div data-file-line="3"><span>one</span></div><div data-file-line="4"><span>two</span></div>`;
    const [first, second] = [...document.querySelectorAll("span")].map((span) => span.firstChild!);
    selectText(first, 0, 2, second);
    expect(selectionLines("data-file-line")).toEqual({ start: 3, end: 4 });
    selectText(first, 0, 2);
    expect(selectionLines("data-file-line")).toEqual({ start: 3, end: 3 });
  });
});
