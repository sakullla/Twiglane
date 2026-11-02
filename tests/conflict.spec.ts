import { readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import {
  alignHunk,
  applyEol,
  composeConflictText,
  detectEol,
  hasConflictMarkers,
  hunkHint,
  inlineRange,
  keepBothSides,
  normalizeEol,
  parseConflictText,
  resolvedLines,
  simpleResolution,
  splitRawLines,
  unresolvedCount,
} from "../src/lib/conflict";
import {
  computeMarks,
  exceedsMarkLimit,
  mapLine,
  markKindAt,
  MARK_LINE_LIMIT,
  runsInRange,
  splitMarkLines,
  type ThreeWayMarks,
} from "../src/lib/three-way-marks";
import type { ConflictView } from "../src/lib/types";
import ConflictResolver from "../src/lib/components/ConflictResolver.svelte";
import ThreeWayMerge from "../src/lib/components/ThreeWayMerge.svelte";

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
    expect(within(target).queryByRole("progressbar"), "还没有进度时不留空槽").toBeNull();

    await fireEvent.click(within(head(0)).getByRole("button", { name: "采用当前" }));
    expect(within(target).getByRole("progressbar", { name: "本文件冲突处理进度" })).toBeTruthy();
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

  it("超过 600 列的长行也进标尺，行钉在舞台里、只有代码按 --code-x 平移", async () => {
    const long = `${"中".repeat(900)}END`;
    renderResolver(`<<<<<<< HEAD\nx\n=======\n${long}\n>>>>>>> m\n`);
    expect(document.querySelector<HTMLElement>(".code-ruler.half span")?.dataset.text).toBe(long);
    const scroller = document.querySelector(".cr-scroll") as HTMLElement;
    scroller.scrollLeft = 120;
    await fireEvent.scroll(scroller);
    expect(scroller.style.getPropertyValue("--code-x")).toBe("120px");
    const pair = document.querySelector(".code-stage .cr-pair") as HTMLElement;
    expect(pair.style.left).toBe("");
    expect(pair.querySelectorAll(".cr-half .code-in")).toHaveLength(2);
    expect(pair.querySelector(".ln .code-in")).toBeNull();
  });

  it("结果预览按整行计算行程，长行不省略", async () => {
    const long = `${"a".repeat(800)}END`;
    renderResolver(`${long}\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> m\n`);
    await fireEvent.click(screen.getByRole("button", { name: "结果预览" }));
    const ruler = document.querySelector(".code-ruler") as HTMLElement;
    expect(ruler.classList.contains("half")).toBe(false);
    expect(ruler.querySelector<HTMLElement>("span")?.dataset.text).toBe(long);
    expect(document.querySelector(".cr-line .code-in")?.textContent).toBe(long);
  });
});

describe("结果栏来源标记", () => {
  const kinds = (marks: ThreeWayMarks) => Array.from({ length: marks.lines }, (_, line) => markKindAt(marks, line));
  const OURS = "head\nours a\nours b\nmiddle\nshared\ntail\n";
  const THEIRS = "head\ntheirs a\nmiddle\nshared\ntail\n";

  it("填入当前后，只有当前侧的行标为来自当前，两侧都有的行不标", () => {
    const marks = computeMarks(OURS, OURS, THEIRS);
    expect(kinds(marks)).toEqual(["same", "ours", "ours", "same", "same", "same"]);
    expect(marks.runs).toEqual([{ kind: "ours", from: 1, to: 3 }]);
  });

  it("填入来源后，只有来源侧的行标为来自来源", () => {
    expect(kinds(computeMarks(THEIRS, OURS, THEIRS))).toEqual(["same", "theirs", "same", "same", "same"]);
  });

  it("手动修改的行标为手动编辑，其余行不受影响", () => {
    const edited = OURS.replace("ours b", "typed by hand");
    expect(kinds(computeMarks(edited, OURS, THEIRS))).toEqual(["same", "ours", "manual", "same", "same", "same"]);
  });

  it("保留双方时两段分别归到各自一侧", () => {
    const both = "ours a\ntheirs a\n";
    expect(kinds(computeMarks(both, "ours a\n", "theirs a\n"))).toEqual(["ours", "theirs"]);
  });

  it("被挪动的行仍算来源，不算手动编辑", () => {
    const moved = "tail\nhead\nours a\n";
    expect(kinds(computeMarks(moved, "head\nours a\ntail\n", "head\ntail\n"))).not.toContain("manual");
  });

  it("冲突标记行单独成类，不算手动编辑；来源里本来就有的同形文字不算标记", () => {
    const text = "<<<<<<< HEAD\nours a\n=======\ntheirs a\n>>>>>>> main\n";
    expect(kinds(computeMarks(text, "ours a\n", "theirs a\n"))).toEqual(["marker", "ours", "marker", "theirs", "marker"]);
    expect(kinds(computeMarks("=======\n", "=======\n", "x\n"))).toEqual(["ours"]);
  });

  it("比较忽略行尾，CRLF 文件读回 LF 不会整份变成手动编辑", () => {
    const crlf = "a\r\nb\r\n";
    expect(splitMarkLines(crlf)).toEqual(["a", "b"]);
    expect(kinds(computeMarks("a\nb\n", crlf, crlf))).toEqual(["same", "same"]);
  });

  it("空文本和末尾无换行都能处理", () => {
    expect(computeMarks("", "", "").lines).toBe(0);
    expect(splitMarkLines("a\n\n")).toEqual(["a", ""]);
    expect(kinds(computeMarks("a", "a\n", "b\n"))).toEqual(["ours"]);
  });

  it("只取视口附近的区段", () => {
    const runs = [
      { kind: "ours", from: 0, to: 2 },
      { kind: "manual", from: 10, to: 12 },
      { kind: "theirs", from: 20, to: 30 },
    ] as const;
    expect(runsInRange(runs, 11, 25).map((run) => run.kind)).toEqual(["manual", "theirs"]);
    expect(runsInRange(runs, 3, 9)).toEqual([]);
  });

  it("行数不同时按内容换算：插入之后的行仍对到同一内容", () => {
    const ours = Array.from({ length: 100 }, (_, index) => `line ${index}`);
    const longer = [...ours.slice(0, 50), ...Array.from({ length: 30 }, (_, index) => `new ${index}`), ...ours.slice(50)];
    const marks = computeMarks(`${longer.join("\n")}\n`, `${ours.join("\n")}\n`, `${ours.join("\n")}\n`);
    expect(mapLine(marks.ours.result, marks.ours.side, 10)).toBe(10);
    expect(mapLine(marks.ours.result, marks.ours.side, 90)).toBe(60);
    expect(mapLine(marks.ours.side, marks.ours.result, 60)).toBe(90);
    expect(mapLine(marks.ours.result, marks.ours.side, 130)).toBe(100);
    expect(mapLine([], [], 3)).toBe(0);
  });

  it("几万行与大量重复行都在预算内完成", () => {
    const unique = Array.from({ length: 60_000 }, (_, index) => `const value${index} = ${index};`);
    const edited = unique.map((line, index) => (index % 500 === 0 ? `${line} // 改` : line));
    const repeated = Array.from({ length: 60_000 }, (_, index) => (index % 3 === 0 ? "}" : index % 3 === 1 ? "" : "  x();"));
    const shifted = ["first", ...repeated.slice(0, 30_000), "middle", ...repeated.slice(30_000).reverse()];
    const started = performance.now();
    const marks = computeMarks(`${edited.join("\n")}\n`, `${unique.join("\n")}\n`, `${unique.join("\n")}\n`);
    computeMarks(`${shifted.join("\n")}\n`, `${repeated.join("\n")}\n`, `${shifted.join("\n")}\n`);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(marks.runs).toHaveLength(120);
    expect(marks.runs.every((run) => run.kind === "manual")).toBe(true);
  });

  it("超过上限时关闭标记", () => {
    expect(exceedsMarkLimit("a\n", "b\n")).toBe(false);
    expect(exceedsMarkLimit("a\n".repeat(MARK_LINE_LIMIT + 1))).toBe(true);
    expect(exceedsMarkLimit("a\n".repeat(MARK_LINE_LIMIT))).toBe(false);
  });
});

describe("逐处导航跨文件", () => {
  function renderNav(text = TWO, extra: Record<string, unknown> = {}) {
    const onExhausted = vi.fn(() => false);
    render(ConflictResolver, {
      props: {
        view: view(text),
        currentLabel: "main",
        incomingLabel: "feature",
        disabled: false,
        onResolve: () => {},
        onExhausted,
        ...extra,
      },
    });
    return { onExhausted };
  }
  const label = () => document.querySelector(".cr-nav-label")?.textContent?.replace(/\s+/g, " ").trim();
  const stream = () => screen.getByRole("region", { name: "逐处处理冲突" });
  const ONE = "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> m\n";

  it("文件内还有下一处时留在文件内，走完才交给宿主", async () => {
    const { onExhausted } = renderNav();
    await fireEvent.click(screen.getByRole("button", { name: "下一处冲突" }));
    expect(label()).toContain("第 2 / 2 处");
    expect(onExhausted).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "下一处未处理" }));
    expect(onExhausted).toHaveBeenCalledWith(1, true);
  });

  it("宿主没有别的文件时在本文件绕回；只有一处时留在原地", async () => {
    renderNav();
    await fireEvent.keyDown(stream(), { key: "F7", shiftKey: true });
    expect(label()).toContain("第 2 / 2 处");
    await fireEvent.keyDown(stream(), { key: "ArrowDown", altKey: true });
    expect(label()).toContain("第 1 / 2 处");
  });

  it("只有 1 处冲突时下一处未处理也交给宿主", async () => {
    const { onExhausted } = renderNav(ONE);
    await fireEvent.keyDown(stream(), { key: "F7" });
    expect(onExhausted).toHaveBeenCalledWith(1, true);
  });

  it("本文件全部选好后不再绕回，告诉宿主无处可留", async () => {
    const { onExhausted } = renderNav(ONE);
    await fireEvent.keyDown(stream(), { key: "1" });
    await fireEvent.keyDown(stream(), { key: "F7" });
    expect(onExhausted).toHaveBeenCalledWith(1, false);
    expect(label()).toContain("第 1 / 1 处");
    expect(screen.queryByRole("button", { name: "下一处未处理" }), "无处可去时不留空转按钮").toBeNull();
    expect(screen.getByText(/标记后可以完成合并/)).toBeTruthy();
  });

  it("其他文件还有未处理时，本文件选完也保留下一处未处理", async () => {
    renderNav(ONE, { pendingElsewhere: 2, fileIndex: 1, fileTotal: 3 });
    await fireEvent.keyDown(stream(), { key: "1" });
    expect(screen.getByRole("button", { name: "下一处未处理" })).toBeTruthy();
    expect(label()).toBe("文件 1 / 3· 第 1 / 1 处");
  });

  it("从上一文件跳来时定位末处未处理，并把焦点交给冲突流", async () => {
    renderNav(TWO, { entry: "last" });
    await tick();
    await tick();
    expect(label()).toContain("第 2 / 2 处");
    expect(document.activeElement).toBe(stream());
  });

  it("跳来时跳过已经选好的，定位首处未处理", async () => {
    const original = TWO;
    const draft = { original, base: original, resolutions: { 0: { choice: "ours" as const } }, whole: null };
    renderNav(TWO, { entry: "first", draft });
    expect(label()).toContain("第 2 / 2 处");
  });

  it("单处编辑没完成时不离开文件，编辑内容还在", async () => {
    const { onExhausted } = renderNav(ONE);
    await fireEvent.keyDown(stream(), { key: "e" });
    const area = await screen.findByRole("textbox", { name: "编辑冲突 1 的结果" });
    await fireEvent.input(area, { target: { value: "half done" } });
    await fireEvent.click(screen.getByRole("button", { name: "下一处未处理" }));
    expect(onExhausted).not.toHaveBeenCalled();
    expect(screen.getByText("先完成正在编辑的一处，再切换文件。")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "编辑冲突 1 的结果" }) as HTMLTextAreaElement).value).toBe("half done");
  });

  for (const [name, finish] of [
    ["取消", () => fireEvent.click(screen.getByRole("button", { name: "取消" }))],
    ["完成编辑", () => fireEvent.click(screen.getByRole("button", { name: /完成编辑/ }))],
    ["切换视图", () => fireEvent.click(screen.getByRole("button", { name: "结果预览" }))],
  ] as const) {
    it(`编辑以${name}结束时，“先完成编辑”的提示一起消失`, async () => {
      renderNav(ONE);
      await fireEvent.keyDown(stream(), { key: "e" });
      await screen.findByRole("textbox", { name: "编辑冲突 1 的结果" });
      await fireEvent.click(screen.getByRole("button", { name: "下一处未处理" }));
      expect(screen.getByText("先完成正在编辑的一处，再切换文件。")).toBeTruthy();
      await finish();
      await tick();
      expect(screen.queryByText("先完成正在编辑的一处，再切换文件。")).toBeNull();
    });
  }

  it("整文件编辑按文件为单位移动，结果栏里 F7 也生效，普通按键仍是输入", async () => {
    const { onExhausted } = renderNav(TWO, { fileIndex: 2, fileTotal: 3, pendingElsewhere: 1 });
    await fireEvent.click(screen.getByRole("button", { name: /整文件编辑/ }));
    expect(label()).toBe("文件 2 / 3");
    const area = screen.getByRole("textbox", { name: "合并结果" });
    await fireEvent.keyDown(area, { key: "F7" });
    expect(onExhausted).toHaveBeenCalledWith(1, false);
    await fireEvent.keyDown(area, { key: "ArrowUp", altKey: true });
    expect(onExhausted).toHaveBeenLastCalledWith(-1, false);
    onExhausted.mockClear();
    await fireEvent.keyDown(area, { key: "n" });
    expect(onExhausted).not.toHaveBeenCalled();
  });
});

describe("三栏联动与来源标记", () => {
  /** happy-dom 不排版：给每个滚动容器一份真实几何，scrollTop 按上限截断。 */
  function layout(node: HTMLElement, lines: number, height = 400, width = 300, contentWidth = 2000) {
    let top = 0;
    let left = 0;
    const maxTop = 16 + lines * 20 - height;
    Object.defineProperties(node, {
      scrollHeight: { configurable: true, get: () => 16 + lines * 20 },
      clientHeight: { configurable: true, get: () => height },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => (top = Math.max(0, Math.min(maxTop, value))) },
      clientWidth: { configurable: true, get: () => width },
      scrollWidth: { configurable: true, get: () => contentWidth },
      scrollLeft: { configurable: true, get: () => left, set: (value: number) => (left = Math.max(0, Math.min(contentWidth - width, value))) },
    });
    return node;
  }

  const body = (count: number, from = 0) => Array.from({ length: count }, (_, index) => `line ${from + index}`);
  const joined = (lines: string[]) => `${lines.join("\n")}\n`;

  function renderThree(oursLines: string[], theirsLines: string[], resultLines: string[]) {
    render(ThreeWayMerge, {
      props: {
        view: view(joined(resultLines), {
          ours: { present: true, binary: false, truncated: false, text: joined(oursLines), summary: "" },
          theirs: { present: true, binary: false, truncated: false, text: joined(theirsLines), summary: "" },
        }),
        resultText: joined(resultLines),
        disabled: false,
        onResult: () => {},
        onChoice: () => {},
        onResolve: () => {},
        onReset: () => {},
      },
    });
    return {
      ours: layout(screen.getByRole("region", { name: "当前分支版本" }), oursLines.length),
      theirs: layout(screen.getByRole("region", { name: "来源分支版本" }), theirsLines.length),
      result: layout(screen.getByRole("textbox", { name: "合并结果" }), resultLines.length),
    };
  }

  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  it("滚动任意一栏，另外两栏纵向、横向都跟随", async () => {
    const lines = body(300);
    const panes = renderThree(lines, lines, lines);
    for (const [from, others] of [
      ["ours", ["result", "theirs"]],
      ["result", ["ours", "theirs"]],
      ["theirs", ["ours", "result"]],
    ] as const) {
      await frames();
      panes[from].scrollTop = from === "ours" ? 800 : from === "result" ? 1600 : 2400;
      panes[from].scrollLeft = from === "ours" ? 120 : from === "result" ? 240 : 360;
      await fireEvent.scroll(panes[from]);
      for (const other of others) {
        expect(panes[other].scrollTop, `${from} → ${other}`).toBeCloseTo(panes[from].scrollTop, 0);
        expect(panes[other].scrollLeft, `${from} → ${other}`).toBe(panes[from].scrollLeft);
      }
    }
  });

  it("写入引起的回声不反向带动，防止回环", async () => {
    const lines = body(300);
    const panes = renderThree(lines, lines, lines);
    panes.ours.scrollTop = 800;
    await fireEvent.scroll(panes.ours);
    // 回声到达时用户已经继续滚动：回声不能把主动栏拉回去。
    panes.theirs.scrollTop = 100;
    await fireEvent.scroll(panes.theirs);
    expect(panes.ours.scrollTop).toBe(800);
    await frames();
    await fireEvent.scroll(panes.theirs);
    expect(panes.ours.scrollTop, "放开后这一栏可以成为新的主动栏").not.toBe(800);
  });

  it("行数不同时按内容对齐，同时到顶、同时到底", async () => {
    const ours = body(300);
    const extra = Array.from({ length: 100 }, (_, index) => `added ${index}`);
    const result = [...ours.slice(0, 100), ...extra, ...ours.slice(100)];
    const panes = renderThree(ours, ours, result);
    panes.ours.scrollTop = 3000;
    await fireEvent.scroll(panes.ours);
    const progress = 3000 / (16 + 300 * 20 - 400);
    const focusLine = (3000 + 392 * progress - 8) / 20;
    expect(focusLine).toBeGreaterThan(100);
    const expected = (focusLine + 100) * 20 + 8 - 392 * progress;
    expect(panes.result.scrollTop, "第 100 行之后差出插入的 100 行").toBeCloseTo(expected, 0);

    await frames();
    panes.ours.scrollTop = 1e6;
    await fireEvent.scroll(panes.ours);
    expect(panes.result.scrollTop, "到底时结果栏也到底").toBeCloseTo(16 + 400 * 20 - 400, 0);
    await frames();
    panes.ours.scrollTop = 0;
    await fireEvent.scroll(panes.ours);
    expect(panes.result.scrollTop).toBe(0);
  });

  it("结果栏有图例，标记层按行定位，文本一字不改", async () => {
    const ours = ["same", "only ours", "tail"];
    const theirs = ["same", "only theirs", "tail"];
    const result = ["same", "only ours", "typed", "only theirs", "tail"];
    const { result: area } = renderThree(ours, theirs, result);
    expect((area as HTMLTextAreaElement).value).toBe(joined(result));
    const legend = document.querySelector(".three-way-legend");
    for (const text of ["当前", "来源", "手动编辑", "两侧相同"]) expect(legend?.textContent).toContain(text);
    await vi.waitFor(() => expect(document.querySelectorAll(".three-way-mark")).toHaveLength(3));
    const mark = (kind: string) => document.querySelector<HTMLElement>(`.three-way-mark.${kind}`)?.getAttribute("style");
    expect(mark("ours")).toContain("top: 28px");
    expect(mark("manual")).toContain("top: 48px");
    expect(mark("theirs")).toContain("top: 68px");
    expect(document.querySelector(".three-way-gutter-row.manual")?.textContent).toBe("3手");
    expect((area as HTMLTextAreaElement).value, "标记后文本不变").toBe(joined(result));
  });

  it("编辑后标记随内容更新", async () => {
    const ours = ["a", "b"];
    const theirs = ["a", "c"];
    const props = {
      view: view("a\nb\n", {
        ours: { present: true, binary: false, truncated: false, text: joined(ours), summary: "" },
        theirs: { present: true, binary: false, truncated: false, text: joined(theirs), summary: "" },
      }),
      resultText: "a\nb\n",
      disabled: false,
      onResult: () => {},
      onChoice: () => {},
      onResolve: () => {},
      onReset: () => {},
    };
    const { rerender } = render(ThreeWayMerge, { props });
    await vi.waitFor(() => expect(document.querySelector(".three-way-mark.ours")).toBeTruthy());
    await rerender({ ...props, resultText: "a\nhand\n" });
    await vi.waitFor(() => expect(document.querySelector(".three-way-mark.manual")).toBeTruthy());
    expect(document.querySelector(".three-way-mark.ours")).toBeNull();
  });

  it("超大文件关闭标记并说明，滚动退回按比例", async () => {
    const big = "x\n".repeat(MARK_LINE_LIMIT + 1);
    render(ThreeWayMerge, {
      props: {
        view: view(big, {
          ours: { present: true, binary: false, truncated: false, text: big, summary: "" },
          theirs: { present: true, binary: false, truncated: false, text: "y\n", summary: "" },
        }),
        resultText: big,
        disabled: false,
        onResult: () => {},
        onChoice: () => {},
        onResolve: () => {},
        onReset: () => {},
      },
    });
    expect(document.querySelector(".three-way-legend")?.textContent).toContain("已关闭来源标记");
    expect(document.querySelector(".three-way-mark")).toBeNull();
    const ours = layout(screen.getByRole("region", { name: "当前分支版本" }), 1000);
    const area = layout(screen.getByRole("textbox", { name: "合并结果" }), 2000);
    ours.scrollTop = (16 + 1000 * 20 - 400) / 2;
    await fireEvent.scroll(ours);
    expect(area.scrollTop).toBeCloseTo((16 + 2000 * 20 - 400) / 2, 0);
  });

  function renderReadonly(extra: Partial<ConflictView>) {
    render(ThreeWayMerge, {
      props: {
        view: view("r\n", { editable: false, kind: "modify_delete", ...extra }),
        resultText: "",
        disabled: false,
        onResult: () => {},
        onChoice: () => {},
        onResolve: () => {},
        onReset: () => {},
      },
    });
  }
  const deleted = { present: false, binary: false, truncated: false, text: null, summary: "另一侧删除了文件" };

  it("修改/删除带文本时，结果栏的 pre 才是滚动元素，两个方向都联动", async () => {
    renderReadonly({ theirs: deleted });
    expect(document.querySelector(".three-way-legend")).toBeNull();
    expect(document.querySelector(".three-way-merge")?.classList.contains("has-text")).toBe(true);
    const ours = layout(screen.getByRole("region", { name: "当前分支版本" }), 200);
    const pre = layout(document.querySelector<HTMLElement>(".three-way-pane.result > pre") as HTMLElement, 200);
    ours.scrollTop = 500;
    await fireEvent.scroll(ours);
    expect(pre.scrollTop).toBeCloseTo(500, 0);
    await frames();
    pre.scrollTop = 1200;
    pre.scrollLeft = 80;
    await fireEvent.scroll(pre);
    expect(ours.scrollTop).toBeCloseTo(1200, 0);
    expect(ours.scrollLeft).toBe(80);
  });

  it("只有说明文字的只读冲突没有 has-text，仍收成自然高度", () => {
    const summary = (text: string) => ({ present: true, binary: true, truncated: false, text: null, summary: text });
    renderReadonly({ kind: "binary", ours: summary("本地"), theirs: summary("另一侧"), result: summary("结果") });
    expect(document.querySelector(".three-way-merge")?.classList.contains("has-text")).toBe(false);
    expect(document.querySelector(".three-way-pane.result > pre")).toBeNull();
  });

  it("带文本的只读三栏走 flex: 1，只有纯说明才收起", () => {
    const css = readFileSync(path.resolve(__dirname, "../src/styles/components.css"), "utf8");
    expect(css).toContain(".three-way-merge.readonly:not(.has-text) .three-way-body { flex: none; min-height: 120px; }");
    expect(css).toContain(".conflict-sides:has(.three-way-merge.readonly:not(.has-text)) { flex: none; }");
    expect(css).not.toMatch(/\.three-way-merge\.readonly( \.three-way-body)? \{ flex: none/);
  });

  it("到底时跟随栏取真实上限，小数像素的 scrollTop 也算到底", async () => {
    const ours = body(300);
    const extra = Array.from({ length: 37 }, (_, index) => `added ${index}`);
    const panes = renderThree(ours, ours, [...ours.slice(0, 280), ...extra, ...ours.slice(280)]);
    panes.ours.scrollTop = 16 + 300 * 20 - 400 - 0.5;
    await fireEvent.scroll(panes.ours);
    expect(panes.result.scrollTop).toBe(16 + 337 * 20 - 400);
    expect(panes.theirs.scrollTop).toBe(16 + 300 * 20 - 400);
  });

  it("穿过对面没有的大段插入时，跟随栏不反向漂移", async () => {
    const ours = body(300);
    const extra = Array.from({ length: 200 }, (_, index) => `added ${index}`);
    const panes = renderThree(ours, ours, [...ours.slice(0, 50), ...extra, ...ours.slice(50)]);
    const walk = async (from: number, to: number, step: number) => {
      const seen: number[] = [];
      for (let top = from; step > 0 ? top <= to : top >= to; top += step) {
        panes.result.scrollTop = top;
        await fireEvent.scroll(panes.result);
        seen.push(panes.ours.scrollTop);
      }
      return seen;
    };
    const down = await walk(0, 9600, 400);
    expect(down.every((top, index) => index === 0 || top >= down[index - 1]), `向下：${down.join(",")}`).toBe(true);
    const up = await walk(9600, 0, -400);
    expect(up.every((top, index) => index === 0 || top <= up[index - 1]), `向上：${up.join(",")}`).toBe(true);
    expect(up.at(-1), "回到顶也真正到顶").toBe(0);
  });

  it("纯横向滚动不改变任何一栏的纵向位置", async () => {
    const ours = body(300);
    const extra = Array.from({ length: 100 }, (_, index) => `added ${index}`);
    const panes = renderThree(ours, ours, [...ours.slice(0, 100), ...extra, ...ours.slice(100)]);
    panes.ours.scrollTop = 3000;
    await fireEvent.scroll(panes.ours);
    await frames();
    const top = panes.result.scrollTop;
    for (const offset of [7, -7]) {
      panes.result.scrollTop = top + offset;
      await frames();
      panes.ours.scrollLeft = 200 + offset;
      await fireEvent.scroll(panes.ours);
      expect(panes.result.scrollTop).toBe(top + offset);
      await frames();
    }
    expect(panes.result.scrollLeft).toBe(193);
  });
});

describe("整文件编辑的行尾", () => {
  const crlf = (text: string) => text.replace(/\n/g, "\r\n");
  const CRLF_TWO = crlf(TWO);

  /** 真实 textarea 读回的 value 永远是 LF：happy-dom 不做这一步，这里按浏览器的结果写入。 */
  async function type(value: string) {
    await fireEvent.input(screen.getByRole("textbox", { name: "合并结果" }), { target: { value: normalizeEol(value) } });
  }

  function open(text: string, extra: Partial<ConflictView> = {}, props: Record<string, unknown> = {}) {
    const onResolve = vi.fn();
    render(ConflictResolver, {
      props: { view: view(text, extra), currentLabel: "main", incomingLabel: "feature", disabled: false, onResolve, ...props },
    });
    return onResolve;
  }

  const whole = () => fireEvent.click(screen.getByRole("button", { name: /整文件编辑/ }));
  const mark = async () => {
    await fireEvent.click(screen.getByRole("button", { name: "标记编辑结果" }));
    if (screen.getByRole("button", { name: "标记编辑结果" }).textContent?.includes("确认")) {
      await fireEvent.click(screen.getByRole("button", { name: "标记编辑结果" }));
    }
  };
  const FIXED = "one\ntwo\nthree\n";

  it("行尾工具：规范化幂等，主导行尾按多数派，平手算 LF", () => {
    expect(normalizeEol("a\r\nb\rc\n")).toBe("a\nb\nc\n");
    expect(applyEol("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
    expect(applyEol("a\r\nb\r\n", "\r\n"), "已是 CRLF 不会叠成 \\r\\r\\n").toBe("a\r\nb\r\n");
    expect(applyEol("a\r\nb\n", "\n")).toBe("a\nb\n");
    expect(detectEol("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(detectEol("a\r\nb\n")).toBe("\n");
    expect(detectEol("没有换行", null, "x\r\n"), "结果没有换行时看两侧").toBe("\r\n");
    expect(detectEol("", null)).toBe("\n");
  });

  it("保留双方拼出来只有一种行尾，缺一侧也成立", () => {
    expect(keepBothSides("a\r\nb\r\n", "c\nd\n", "\r\n")).toBe("a\r\nb\r\nc\r\nd\r\n");
    expect(keepBothSides("a\r\n", "b\n", "\n")).toBe("a\nb\n");
    expect(keepBothSides("", "b\r\n", "\r\n")).toBe("b\r\n");
    expect(keepBothSides("", "", "\r\n")).toBe("");
  });

  it("打一个字后 CRLF 文件逐字节保持 CRLF", async () => {
    const onResolve = open(CRLF_TWO);
    await whole();
    await type(`${TWO}x\n`);
    await mark();
    expect(onResolve).toHaveBeenCalledWith("text", `${CRLF_TWO}x\r\n`);
  });

  it("LF 文件写回仍是 LF，不打字时混合行尾原样保留", async () => {
    const mixed = "a\r\nb\r\nc\n";
    const onResolve = open(mixed);
    await whole();
    await mark();
    expect(onResolve).toHaveBeenLastCalledWith("text", mixed);
  });

  it("混合行尾文件编辑后按主导行尾写回", async () => {
    const onResolve = open("a\r\nb\r\nc\n");
    await whole();
    await type("a\nb\nc\nd\n");
    await mark();
    expect(onResolve).toHaveBeenLastCalledWith("text", "a\r\nb\r\nc\r\nd\r\n");
  });

  it("删空重打也沿用打开时的行尾", async () => {
    const onResolve = open("a\r\nb\r\n");
    await whole();
    await type("");
    await type(FIXED);
    await mark();
    expect(onResolve).toHaveBeenLastCalledWith("text", crlf(FIXED));
  });

  it("整文件的保留双方同一行尾，之后再打字也不变", async () => {
    const side = (text: string) => ({ present: true, binary: false, truncated: false, text, summary: "" });
    const onResolve = open(CRLF_TWO, { ours: side("o1\r\no2\r\n"), theirs: side("t1\r\nt2\r\n") });
    await whole();
    await fireEvent.click(screen.getByRole("button", { name: /保留双方/ }));
    await mark();
    expect(onResolve).toHaveBeenLastCalledWith("text", "o1\r\no2\r\nt1\r\nt2\r\n");
    await type("o1\no2\nt1\nt2\nx\n");
    await mark();
    expect(onResolve).toHaveBeenLastCalledWith("text", "o1\r\no2\r\nt1\r\nt2\r\nx\r\n");
  });

  it("切回逐处后组合结果和手动编辑都是 CRLF", async () => {
    const onResolve = open(CRLF_TWO);
    await whole();
    await type(TWO.replace("head\n", "edited\n"));
    await fireEvent.click(screen.getByRole("button", { name: /逐处处理/ }));
    expect(document.querySelectorAll(".cr-head")).toHaveLength(2);
    const stream = screen.getByRole("region", { name: "逐处处理冲突" });
    await fireEvent.keyDown(stream, { key: "1" });
    await fireEvent.keyDown(stream, { key: "e" });
    await fireEvent.input(await screen.findByRole("textbox", { name: "编辑冲突 2 的结果" }), { target: { value: "hand a\nhand b" } });
    await fireEvent.click(screen.getByRole("button", { name: /完成编辑/ }));
    await mark();
    expect(onResolve).toHaveBeenLastCalledWith("text", "edited\r\nours one\r\nmiddle\r\nhand a\r\nhand b\r\ntail\r\n");
  });

  it("草稿恢复后继续打字仍是 CRLF", async () => {
    const onResolve = open(CRLF_TWO, {}, { draft: { original: CRLF_TWO, base: CRLF_TWO, resolutions: {}, whole: crlf("saved\n") } });
    expect((screen.getByRole("textbox", { name: "合并结果" }) as HTMLTextAreaElement).value).toBe("saved\n");
    await type("saved\nmore\n");
    await mark();
    expect(onResolve).toHaveBeenLastCalledWith("text", crlf("saved\nmore\n"));
  });

  it("MergePanel 直接用的三栏：oninput 已还原行尾", async () => {
    const onResult = vi.fn();
    render(ThreeWayMerge, {
      props: { view: view("a\r\nb\r\n"), resultText: "a\r\nb\r\n", disabled: false, onResult, onChoice: () => {}, onResolve: () => {}, onReset: () => {} },
    });
    await type("a\nb\nc\n");
    expect(onResult).toHaveBeenCalledWith("a\r\nb\r\nc\r\n");
  });

  it("CRLF 内容回传时不写回 textarea，光标不跳", async () => {
    const onResolve = open(CRLF_TWO);
    await whole();
    const area = screen.getByRole("textbox", { name: "合并结果" }) as HTMLTextAreaElement;
    expect(area.value, "展示给 textarea 的是规范化文本").toBe(TWO);
    const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), "value") as PropertyDescriptor;
    const writes: string[] = [];
    Object.defineProperty(area, "value", {
      configurable: true,
      get: () => native.get?.call(area),
      set: (value: string) => {
        writes.push(value);
        native.set?.call(area, value);
      },
    });
    native.set?.call(area, `${TWO}x`);
    area.setSelectionRange(3, 3);
    await fireEvent.input(area);
    await tick();
    expect(writes, "Svelte 没有把文本写回").toEqual([]);
    expect(area.selectionStart).toBe(3);
    await mark();
    expect(onResolve).toHaveBeenLastCalledWith("text", `${CRLF_TWO}x`);
  });
});
