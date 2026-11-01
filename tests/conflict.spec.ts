import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import {
  alignHunk,
  composeConflictText,
  hasConflictMarkers,
  hunkHint,
  inlineRange,
  parseConflictText,
  resolvedLines,
  simpleResolution,
  splitRawLines,
  unresolvedCount,
} from "../src/lib/conflict";
import type { ConflictView } from "../src/lib/types";
import ConflictResolver from "../src/lib/components/ConflictResolver.svelte";

const TWO = [
  "head",
  "<<<<<<< HEAD",
  "ours one",
  "=======",
  "theirs one",
  ">>>>>>> feature",
  "middle",
  "<<<<<<< HEAD",
  "ours two a",
  "ours two b",
  "||||||| base",
  "base two",
  "=======",
  "theirs two",
  ">>>>>>> feature",
  "tail",
  "",
].join("\n");

function view(result: string, extra: Partial<ConflictView> = {}): ConflictView {
  return {
    generation: 4,
    path: "src/file.ts",
    kind: "text",
    editable: true,
    ours: { present: true, binary: false, truncated: false, text: "ours\n", summary: "本地" },
    theirs: { present: true, binary: false, truncated: false, text: "theirs\n", summary: "另一侧" },
    result: { present: true, binary: false, truncated: false, text: result, summary: "结果" },
    note: "可以编辑合并结果。",
    ...extra,
  };
}

describe("冲突标记解析", () => {
  it("切出公共段与每处冲突，识别标签与 diff3 共同祖先", () => {
    const parsed = parseConflictText(TWO);
    expect(parsed.malformed).toBe(false);
    expect(parsed.hunks).toHaveLength(2);
    const [first, second] = parsed.hunks;
    expect(first.ours).toEqual(["ours one\n"]);
    expect(first.theirs).toEqual(["theirs one\n"]);
    expect(first.base).toBeNull();
    expect(first.oursLabel).toBe("HEAD");
    expect(first.theirsLabel).toBe("feature");
    expect(second.ours).toEqual(["ours two a\n", "ours two b\n"]);
    expect(second.base).toEqual(["base two\n"]);
    expect(second.baseLabel).toBe("base");
    expect(second.startLine).toBe(7);
  });

  it("不做任何选择时组合结果与原文逐字节一致（LF、CRLF、混用、末行无换行）", () => {
    const samples = [
      TWO,
      TWO.replace(/\n/g, "\r\n"),
      "a\r\nb\n<<<<<<< HEAD\r\nx\n=======\r\ny\n>>>>>>> m\r\nc",
      "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> m",
    ];
    for (const text of samples) {
      const parsed = parseConflictText(text);
      expect(composeConflictText(parsed, {})).toBe(text);
    }
  });

  it("每种选择都只替换对应冲突块，未处理的块保留标记", () => {
    const parsed = parseConflictText(TWO);
    const take = (choice: "ours" | "theirs" | "ours-theirs" | "theirs-ours" | "base" | "none") =>
      composeConflictText(parsed, { 1: { choice } });
    expect(take("ours")).toContain("middle\nours two a\nours two b\ntail\n");
    expect(take("theirs")).toContain("middle\ntheirs two\ntail\n");
    expect(take("ours-theirs")).toContain("middle\nours two a\nours two b\ntheirs two\ntail\n");
    expect(take("theirs-ours")).toContain("middle\ntheirs two\nours two a\nours two b\ntail\n");
    expect(take("base")).toContain("middle\nbase two\ntail\n");
    expect(take("none")).toContain("middle\ntail\n");
    // 第一处没选：标记原样保留
    expect(take("ours")).toContain("<<<<<<< HEAD\nours one\n=======\ntheirs one\n>>>>>>> feature\n");
    expect(unresolvedCount(parsed, { 1: { choice: "ours" } })).toBe(1);
    const done = composeConflictText(parsed, { 0: { choice: "theirs" }, 1: { choice: "custom", lines: ["merged"] } });
    expect(done).toBe("head\ntheirs one\nmiddle\nmerged\ntail\n");
    expect(hasConflictMarkers(done)).toBe(false);
  });

  it("CRLF 文件的手动编辑结果沿用文件的行尾", () => {
    const parsed = parseConflictText(TWO.replace(/\n/g, "\r\n"));
    const text = composeConflictText(parsed, { 0: { choice: "custom", lines: ["a", "b"] }, 1: { choice: "ours" } });
    expect(text).toBe("head\r\na\r\nb\r\nmiddle\r\nours two a\r\nours two b\r\ntail\r\n");
  });

  it("文件末尾的冲突里一侧缺换行时，保留两者不会把两行粘在一起", () => {
    const parsed = parseConflictText("<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> m");
    const hunk = parsed.hunks[0];
    hunk.ours = ["x"];
    expect(resolvedLines(hunk, { choice: "ours-theirs" })).toEqual(["x", "y"]);
  });

  it("标记残缺时不猜，交给整文件编辑；没有标记时没有冲突块", () => {
    expect(parseConflictText("a\n<<<<<<< HEAD\nx\n=======\ny\n").malformed).toBe(true);
    expect(parseConflictText("<<<<<<< HEAD\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> m\n").malformed).toBe(true);
    const plain = parseConflictText("ok\n");
    expect(plain.malformed).toBe(false);
    expect(plain.hunks).toHaveLength(0);
    // 更长的箭头串不是本层标记
    expect(parseConflictText("<<<<<<<< not a marker\n").hunks).toHaveLength(0);
    expect(hasConflictMarkers("<<<<<<<< x\n")).toBe(false);
    expect(hasConflictMarkers("x\n>>>>>>> branch\n")).toBe(true);
  });

  it("简单冲突：两侧相同或一侧未改动可自动处理，仅空白不同只提示", () => {
    const [identical] = parseConflictText("<<<<<<< A\nx\n=======\nx\n>>>>>>> B\n").hunks;
    expect(hunkHint(identical)).toBe("identical");
    expect(simpleResolution(identical)).toEqual({ choice: "ours" });
    const [oursSame] = parseConflictText("<<<<<<< A\nold\n||||||| O\nold\n=======\nnew\n>>>>>>> B\n").hunks;
    expect(hunkHint(oursSame)).toBe("ours-unchanged");
    expect(simpleResolution(oursSame)).toEqual({ choice: "theirs" });
    const [space] = parseConflictText("<<<<<<< A\nreturn  x;\n=======\nreturn x;\n>>>>>>> B\n").hunks;
    expect(hunkHint(space)).toBe("whitespace");
    expect(simpleResolution(space)).toBeNull();
  });

  it("块内对齐：相同行并排，不同行成对；超大块按行号配对", () => {
    const rows = alignHunk(["a\n", "x\n", "c\n"], ["a\n", "y\n", "z\n", "c\n"]);
    expect(rows.filter((row) => row.same).map((row) => [row.ours, row.theirs])).toEqual([
      [0, 0],
      [2, 3],
    ]);
    expect(rows).toHaveLength(4);
    const big = Array.from({ length: 400 }, (_, index) => `l${index}\n`);
    const paired = alignHunk(big, big.slice(0, 300));
    expect(paired).toHaveLength(400);
    expect(inlineRange("const a = 1;", "const a = 22;")).toEqual({ a: [10, 11], b: [10, 12] });
    expect(inlineRange("same", "same")).toBeNull();
  });

  it("五万行、上百处冲突的文件解析与组合仍是线性开销", () => {
    const lines: string[] = [];
    for (let block = 0; block < 120; block += 1) {
      for (let index = 0; index < 400; index += 1) lines.push(`const v${block}_${index} = ${index};`);
      lines.push("<<<<<<< HEAD", `ours ${block}`, "=======", `theirs ${block}`, ">>>>>>> main");
    }
    const text = `${lines.join("\n")}\n`;
    expect(splitRawLines(text).length).toBeGreaterThan(48_000);
    const started = performance.now();
    const parsed = parseConflictText(text);
    const resolutions = Object.fromEntries(parsed.hunks.map((hunk) => [hunk.index, { choice: "theirs" as const }]));
    const composed = composeConflictText(parsed, resolutions);
    const elapsed = performance.now() - started;
    expect(parsed.hunks).toHaveLength(120);
    expect(hasConflictMarkers(composed)).toBe(false);
    expect(composed).toContain("theirs 119\n");
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("逐处处理冲突", () => {
  function renderResolver(result = TWO, extra: Record<string, unknown> = {}) {
    const onResolve = vi.fn();
    const onDraft = vi.fn();
    const utils = render(ConflictResolver, {
      props: {
        view: view(result),
        currentLabel: "main",
        incomingLabel: "feature",
        disabled: false,
        onResolve,
        onDraft,
        ...extra,
      },
    });
    return { ...utils, onResolve, onDraft };
  }

  function head(index: number): HTMLElement {
    const node = document.querySelector<HTMLElement>(`.cr-head[data-hunk="${index}"]`);
    if (!node) throw new Error(`没有渲染冲突 ${index + 1}`);
    return node;
  }

  it("每一处都要明确选择后才能标记，写回的是逐处组合后的完整文本", async () => {
    const { onResolve } = renderResolver();
    const mark = screen.getByRole("button", { name: "标记编辑结果" });
    expect(mark.hasAttribute("disabled")).toBe(true);
    expect(mark.textContent).toContain("还有 2 处未处理");

    await fireEvent.click(within(head(0)).getByRole("button", { name: "采用来源" }));
    expect(screen.getByRole("button", { name: "标记编辑结果" }).hasAttribute("disabled")).toBe(true);
    expect(within(head(0)).getByText("采用来源")).toBeTruthy();

    await fireEvent.click(within(head(1)).getByRole("button", { name: "当前 + 来源" }));
    const ready = screen.getByRole("button", { name: "标记编辑结果" });
    expect(ready.hasAttribute("disabled")).toBe(false);
    await fireEvent.click(ready);
    expect(onResolve).toHaveBeenCalledWith("text", "head\ntheirs one\nmiddle\nours two a\nours two b\ntheirs two\ntail\n");
  });

  it("撤销一处后回到未处理，标记再次不可用", async () => {
    renderResolver();
    await fireEvent.click(within(head(0)).getByRole("button", { name: "采用当前" }));
    await fireEvent.click(within(head(1)).getByRole("button", { name: "采用当前" }));
    expect(screen.getByRole("button", { name: "标记编辑结果" }).hasAttribute("disabled")).toBe(false);
    await fireEvent.click(within(head(1)).getByRole("button", { name: /撤销/ }));
    expect(screen.getByRole("button", { name: "标记编辑结果" }).hasAttribute("disabled")).toBe(true);
    expect(head(1).querySelector('[data-hunk-state="pending"]')).toBeTruthy();
  });

  it("键盘：数字键处理当前一处并前进到下一处未处理，U 撤销", async () => {
    renderResolver();
    const stream = screen.getByRole("region", { name: "逐处处理冲突" });
    await fireEvent.keyDown(stream, { key: "2" });
    expect(head(0).querySelector('[data-hunk-state="resolved"]')?.textContent).toBe("采用来源");
    expect(document.querySelector(".cr-nav-label")?.textContent).toContain("第 2 / 2 处");
    await fireEvent.keyDown(stream, { key: "1" });
    expect(head(1).querySelector('[data-hunk-state="resolved"]')?.textContent).toBe("采用当前");
    await fireEvent.keyDown(stream, { key: "u" });
    expect(head(1).querySelector('[data-hunk-state="pending"]')).toBeTruthy();
    await fireEvent.keyDown(stream, { key: "ArrowUp", altKey: true });
    await fireEvent.keyDown(stream, { key: "5" });
    // 第二处带共同祖先，按 5 采用祖先
    expect(head(1).querySelector('[data-hunk-state="resolved"]')?.textContent).toBe("采用共同祖先");
  });

  it("快捷键提示默认不占行，按需打开，Esc 只收起帮助并把焦点还给冲突流", async () => {
    renderResolver();
    expect(document.querySelector(".cr-keys")).toBeNull();
    const toggle = screen.getByRole("button", { name: "快捷键" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await fireEvent.click(toggle);
    const help = screen.getByRole("dialog", { name: "冲突处理快捷键" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    for (const label of ["上一处未处理", "下一处未处理", "采用当前", "采用来源", "当前 + 来源", "来源 + 当前", "采用共同祖先", "手动编辑", "撤销这一处"]) {
      expect(within(help).getByText(label)).toBeTruthy();
    }

    const bubbled = vi.fn();
    window.addEventListener("keydown", bubbled);
    await fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", bubbled);
    expect(screen.queryByRole("dialog", { name: "冲突处理快捷键" })).toBeNull();
    expect(bubbled, "Esc 不能继续冒泡去关闭合并窗口").not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "逐处处理冲突" }));

    await fireEvent.click(toggle);
    await fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "冲突处理快捷键" })).toBeNull();
  });

  it("次要动作收敛后仍可一次点击，1–5 与按钮一一对应", async () => {
    renderResolver();
    const actions = within(head(1));
    expect(actions.getByRole("button", { name: "采用当前" }).classList.contains("quiet")).toBe(false);
    expect(actions.getByRole("button", { name: "采用来源" }).classList.contains("quiet")).toBe(false);
    for (const name of ["当前 + 来源", "来源 + 当前", "祖先", "编辑"]) {
      expect(actions.getByRole("button", { name }).classList.contains("quiet"), name).toBe(true);
    }
    expect(actions.getByRole("button", { name: "祖先" }).getAttribute("title")).toContain("（5）");
  });

  it("底部落到宿主指定的位置：操作照常，切换或卸载后不残留", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const { onResolve, unmount } = renderResolver(TWO, { footTarget: target });
    const mark = within(target).getByRole("button", { name: "标记编辑结果" });
    expect(document.querySelector("[data-conflict-resolver] .cr-foot")).toBeNull();
    expect(within(target).getByRole("group", { name: "冲突导航" })).toBeTruthy();
    expect(within(target).getByRole("progressbar", { name: "本文件冲突处理进度" })).toBeTruthy();

    await fireEvent.click(within(head(0)).getByRole("button", { name: "采用当前" }));
    await fireEvent.click(within(head(1)).getByRole("button", { name: "采用当前" }));
    await fireEvent.click(mark);
    expect(onResolve).toHaveBeenCalledTimes(1);

    unmount();
    expect(target.childElementCount).toBe(0);
    target.remove();
  });

  it("手动编辑一处：在两侧内容基础上改写，完成后计入已处理", async () => {
    const { onResolve } = renderResolver();
    await fireEvent.click(within(head(0)).getByRole("button", { name: "编辑" }));
    const area = screen.getByRole("textbox", { name: "编辑冲突 1 的结果" }) as HTMLTextAreaElement;
    expect(area.value).toBe("ours one\ntheirs one");
    await fireEvent.input(area, { target: { value: "combined one" } });
    await fireEvent.click(screen.getByRole("button", { name: "完成编辑" }));
    expect(within(head(0)).getByText("手动编辑")).toBeTruthy();
    await fireEvent.click(within(head(1)).getByRole("button", { name: "采用来源" }));
    await fireEvent.click(screen.getByRole("button", { name: "标记编辑结果" }));
    expect(onResolve).toHaveBeenCalledWith("text", "head\ncombined one\nmiddle\ntheirs two\ntail\n");
  });

  it("简单冲突一键处理只处理结论确定的那几处", async () => {
    const text = "<<<<<<< A\nsame\n=======\nsame\n>>>>>>> B\nmid\n<<<<<<< A\nx\n=======\ny\n>>>>>>> B\n";
    renderResolver(text);
    await fireEvent.click(screen.getByRole("button", { name: /处理 1 处简单冲突/ }));
    expect(head(0).querySelector('[data-hunk-state="resolved"]')).toBeTruthy();
    expect(head(1).querySelector('[data-hunk-state="pending"]')).toBeTruthy();
  });

  it("切换文件后恢复草稿；工作区内容变了旧草稿作废", async () => {
    const first = renderResolver();
    await fireEvent.click(within(head(0)).getByRole("button", { name: "采用来源" }));
    const draft = first.onDraft.mock.calls.at(-1)?.[0];
    expect(first.onDraft.mock.calls.at(-1)?.[1]).toEqual({ total: 2, done: 1 });
    first.unmount();

    renderResolver(TWO, { draft });
    expect(head(0).querySelector('[data-hunk-state="resolved"]')?.textContent).toBe("采用来源");
    document.body.innerHTML = "";

    renderResolver(`${TWO}extra\n`, { draft });
    expect(head(0).querySelector('[data-hunk-state="pending"]')).toBeTruthy();
  });

  it("整文件编辑里仍有冲突标记时，需要再确认一次才写入", async () => {
    const { onResolve } = renderResolver();
    await fireEvent.click(screen.getByRole("button", { name: /整文件编辑/ }));
    const area = screen.getByRole("textbox", { name: "合并结果" }) as HTMLTextAreaElement;
    expect(area.value).toBe(TWO);
    expect(screen.getByText(/结果里仍有冲突标记/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "标记编辑结果" }));
    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "标记编辑结果" }).textContent).toContain("确认");
    await fireEvent.click(screen.getByRole("button", { name: "标记编辑结果" }));
    expect(onResolve).toHaveBeenCalledWith("text", TWO);
  });

  it("整文件编辑后回到逐处处理，以编辑后的文本为新起点", async () => {
    renderResolver();
    await fireEvent.click(screen.getByRole("button", { name: /整文件编辑/ }));
    const edited = TWO.replace("<<<<<<< HEAD\nours one\n=======\ntheirs one\n>>>>>>> feature\n", "fixed\n");
    await fireEvent.input(screen.getByRole("textbox", { name: "合并结果" }), { target: { value: edited } });
    await fireEvent.click(screen.getByRole("button", { name: /逐处处理/ }));
    expect(document.querySelectorAll(".cr-head")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "标记编辑结果" }).textContent).toContain("还有 1 处未处理");
  });

  it("未冲突的大段内容默认折叠，可以展开", async () => {
    const body = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    renderResolver(`${body}\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> m\n${body}\n`);
    const folds = document.querySelectorAll(".cr-fold");
    expect(folds.length).toBe(2);
    expect(folds[0].textContent).toContain("497 行未冲突内容");
    expect(document.querySelectorAll(".cr-line").length).toBeLessThan(20);
    await fireEvent.click(within(folds[0] as HTMLElement).getByRole("button", { name: /行未冲突内容/ }));
    // 展开后上方 500 行都成了普通行，但仍只渲染视口附近的一屏（虚拟滚动）。
    expect(document.querySelector(".cr-line .code")?.textContent).toBe("line 0");
    const rendered = document.querySelectorAll(".cr-line").length;
    expect(rendered).toBeGreaterThan(30);
    expect(rendered).toBeLessThan(80);
  });
});
