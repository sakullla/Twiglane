import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  changeRunIndexes,
  createTextDiff,
  HUNK_FIRST,
  HUNK_LAST,
  HUNK_NONE,
  hunkJump,
  hunkRowIndexes,
  lineSelectionScope,
  whitespaceOnlyHunks,
} from "../src/lib/diff";
import { lineSegments } from "../src/lib/syntax/segments";
import type { CommitDetail, DiffResponse, OpenedRepository, PreviewSources } from "../src/lib/types";

const commitFileDiff = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", () => ({ api: { commitFileDiff } }));

import CommitDiffList from "../src/lib/components/CommitDiffList.svelte";
import DiffView from "../src/lib/components/DiffView.svelte";
import { codeLine } from "./helpers/code";

const opened: OpenedRepository = {
  summary: { name: "demo", path: "/repo" },
  generation: 3,
  snapshot: {
    generation: 3,
    branch: {
      name: "main",
      detached: false,
      unborn: false,
      headOid: "abc",
      upstream: null,
      ahead: 0,
      behind: 0,
      liveRemoteChecked: false,
      remoteCheckedAtMs: null,
      remoteCheckStale: false,
    },
    files: [],
  },
  draft: "",
  watchDegraded: false,
};

const detail: CommitDetail = {
  generation: 3,
  commit: {
    oid: "abcdef1234567890",
    parents: ["parent0"],
    summary: "Review multiple files",
    authorName: "Ada",
    authorEmail: "ada@example.com",
    authoredAt: 1_700_000_000,
    labels: [],
  },
  body: "",
  root: false,
  merge: false,
  selectedParent: "parent0",
  files: [
    { path: "src/a.ts", originalPath: null, status: "modified" },
    { path: "src/b.ts", originalPath: null, status: "modified" },
  ],
};

function diffFor(path: string, text: string): DiffResponse {
  return {
    generation: 3,
    path,
    staged: false,
    binary: false,
    text: null,
    summary: "新增 1 行。",
    additions: 1,
    deletions: 0,
    complete: true,
    truncated: false,
    snapshot: "snap",
    offset: 0,
    totalLines: 1,
    hunks: [],
    lines: [{ kind: "add", text, oldNo: null, newNo: 1, hunkIndex: null }],
  };
}

describe("改动块跳转", () => {
  it("完整文件按连续改动段落跳转，落点前留上下文，相邻太近的段落合并", () => {
    const changed = (pattern: string) => [...pattern].map((char) => char === "x");
    expect(changeRunIndexes(changed("....xx......x...x"), 3)).toEqual([1, 9, 13]);
    expect(changeRunIndexes(changed("x..xx"), 3)).toEqual([0]);
    expect(changeRunIndexes(changed("......"), 3)).toEqual([]);
  });

  it("贴住块头时上一处去上一块，没贴住时先回到块头", () => {
    const indexes = hunkRowIndexes(["hunk", "add", "context", "hunk", "del"]);
    expect(indexes).toEqual([0, 3]);
    expect(hunkJump(indexes, 0, 18)).toMatchObject({
      current: 0,
      total: 2,
      prevRow: null,
      nextRow: 3,
      prevReason: HUNK_FIRST,
      nextReason: null,
    });
    const mid = hunkJump(indexes, 18, 18);
    expect(mid.current).toBe(0);
    expect(mid.prevRow).toBe(0);
    expect(mid.nextRow).toBe(3);
    const atSecond = hunkJump(indexes, 3 * 18, 18);
    expect(atSecond).toMatchObject({ current: 1, prevRow: 0, nextRow: null, nextReason: HUNK_LAST });
  });

  it("视口已经滚到底时，后面的块不再算作可跳", () => {
    expect(hunkJump([0, 40], 0, 18, 0)).toMatchObject({
      prevRow: null,
      nextRow: null,
      prevReason: HUNK_FIRST,
      nextReason: HUNK_LAST,
    });
  });

  it("没有块头时两侧都说明", () => {
    expect(hunkJump([], 0, 18)).toMatchObject({ total: 0, prevReason: HUNK_NONE, nextReason: HUNK_NONE });
    expect(hunkJump([0], 0, 0)).toMatchObject({ prevReason: HUNK_NONE, nextReason: HUNK_NONE });
  });
});

describe("文本差异计算", () => {
  it("标记真实增删行并保留上下文", () => {
    const result = createTextDiff("sample.ts", "const a = 1;\nconst b = 2;\n", "const a = 1;\nconst b = 3;\nconst c = 4;\n", 7);
    expect(result.generation).toBe(7);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(1);
    expect(result.lines.map((line) => line.text)).toEqual(expect.arrayContaining(["-const b = 2;", "+const b = 3;", "+const c = 4;", " const a = 1;"]));
    expect(result.lines.some((line) => line.kind === "hunk")).toBe(true);
  });
});

describe("纯空白改动过滤（R5）", () => {
  it("只差空白的块被隐藏，混合块与单侧改动整体保留", () => {
    const lines = [
      { kind: "hunk", text: "@@ -1,2 +1,2 @@", hunkIndex: 0 },
      { kind: "del", text: "-  const a = 1;  ", hunkIndex: 0 },
      { kind: "add", text: "+\tconst a = 1;", hunkIndex: 0 },
      { kind: "hunk", text: "@@ -9,3 +9,2 @@", hunkIndex: 1 },
      { kind: "del", text: "-const b = 2;", hunkIndex: 1 },
      { kind: "del", text: "-const c = 3;", hunkIndex: 1 },
      { kind: "add", text: "+const b = 2;", hunkIndex: 1 },
      { kind: "hunk", text: "@@ -20 +20 @@", hunkIndex: 2 },
      { kind: "add", text: "+   ", hunkIndex: 2 },
      { kind: "add", text: "+   ", hunkIndex: null },
    ];
    const filter = whitespaceOnlyHunks(lines);
    expect([...filter.hunks]).toEqual([0]);
    // 被隐藏的只有第一块的两行代码，块头不算。
    expect(filter.lines).toBe(2);
  });

  it("缩进或行尾空白变更才算纯空白；内容变动、行数不同都保留", () => {
    expect([...whitespaceOnlyHunks([
      { kind: "del", text: "-return x;", hunkIndex: 0 },
      { kind: "add", text: "+return y;", hunkIndex: 0 },
    ]).hunks]).toEqual([]);
    expect([...whitespaceOnlyHunks([
      { kind: "del", text: "-    if (a) {", hunkIndex: 0 },
      { kind: "add", text: "+  if (a) {", hunkIndex: 0 },
    ]).hunks]).toEqual([0]);
    // 只新增空白行：另一侧没有对应行，属于真实改动，不隐藏。
    expect([...whitespaceOnlyHunks([{ kind: "add", text: "+   ", hunkIndex: 0 }]).hunks]).toEqual([]);
    // 只有上下文行的块不是改动块。
    const keep = whitespaceOnlyHunks([{ kind: "context", text: " keep", hunkIndex: 0 }]);
    expect(keep.hunks.size).toBe(0);
    expect(keep.lines).toBe(0);
  });
});

describe("行选清理的触发条件（T3 建立入口，T4 接行选）", () => {
  const base = {
    path: "src/a.ts",
    side: "unstaged",
    generation: 3,
    mode: "unified" as const,
    fullFile: false,
    hideWhitespaceOnly: false,
  };

  it("什么都没变时 key 不变，同一份行选可以留着", () => {
    expect(lineSelectionScope({ ...base })).toBe(lineSelectionScope(base));
  });

  it("换文件、侧别、generation、布局、完整文件或空白过滤都会让旧行选失效", () => {
    const key = lineSelectionScope(base);
    const changes = [
      { ...base, path: "src/b.ts" },
      { ...base, side: "staged" },
      { ...base, generation: 4 },
      { ...base, generation: null },
      { ...base, mode: "split" as const },
      { ...base, fullFile: true },
      { ...base, hideWhitespaceOnly: true },
    ];
    for (const next of changes) expect(lineSelectionScope(next)).not.toBe(key);
  });
});

describe("显示空白的视觉层（R5）", () => {
  it("切出的空白片段拼回去仍是原文，不插入标记字符", () => {
    const text = "  \tconst  a = ";
    const segments = lineSegments(text, null, null, true);
    expect(segments.map((seg) => seg.t).join("")).toBe(text);
    expect(segments.filter((seg) => seg.ws === "space").map((seg) => seg.t)).toEqual(["  ", "  ", " ", " "]);
    expect(segments.filter((seg) => seg.ws === "tab").map((seg) => seg.t)).toEqual(["\t"]);
    // 不开显示空白时片段结构完全不变，分词与既有断言不受影响。
    expect(lineSegments("other", null)).toEqual([{ t: "other", k: "", m: false }]);
  });

  it("标记由样式表画出来，样式里没有往代码里插字符", () => {
    const css = readFileSync("src/styles/components.css", "utf8");
    expect(css).toContain(".diff .ws-space {");
    expect(css).toContain(".diff .ws-tab {");
    expect(css).toContain('.diff-toolbar .diff-ws-btn[aria-pressed="true"]');
  });
});

describe("多文件差异", () => {
  beforeEach(() => {
    commitFileDiff.mockReset();
    commitFileDiff.mockImplementation((_repo: string, _oid: string, _parent: string, path: string) =>
      Promise.resolve(diffFor(path, `+${path.endsWith("a.ts") ? "a" : "b"}-content`)),
    );
  });

  it("同时加载多个文件，并可独立收起和重新展开", async () => {
    render(CommitDiffList, {
      props: {
        opened,
        detail,
        parent: "parent0",
        disabled: false,
        nextId: () => 1,
        onGeneration: () => {},
        onFailure: () => {},
        onFileHistory: () => {},
      },
    });
    expect(await screen.findByText(codeLine("a-content"))).toBeTruthy();
    expect(await screen.findByText(codeLine("b-content"))).toBeTruthy();
    expect(commitFileDiff).toHaveBeenCalledWith("/repo", detail.commit.oid, "parent0", "src/a.ts", 3, 1, 0, 0);
    expect(commitFileDiff).toHaveBeenCalledWith("/repo", detail.commit.oid, "parent0", "src/b.ts", 3, 1, 0, 0);
    await fireEvent.click(screen.getByRole("button", { name: "收起 src/a.ts" }));
    expect(screen.queryByText(codeLine("a-content"))).toBeNull();
    expect(screen.getByText(codeLine("b-content"))).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "展开全部" }));
    expect(await screen.findByText(codeLine("a-content"))).toBeTruthy();
    expect(screen.getByText(codeLine("b-content"))).toBeTruthy();
  });

  it("离开视口后释放差异，返回时重新读取，不累计最近 24 个文件", async () => {
    const many = { ...detail, files: Array.from({ length: 100 }, (_, i) => ({ ...detail.files[0], path: `file-${i}.txt` })) };
    const view = render(CommitDiffList, {
      opened, detail: many, parent: "parent0", focusPath: "file-0.txt", disabled: false,
      nextId: () => 1, onGeneration: vi.fn(), onFailure: vi.fn(),
    });
    const callsFor = (path: string) => commitFileDiff.mock.calls.filter((call) => call[3] === path).length;
    await waitFor(() => expect(callsFor("file-0.txt")).toBe(1));
    await view.rerender({ focusPath: "file-99.txt" });
    await waitFor(() => expect(callsFor("file-99.txt")).toBe(1));
    await view.rerender({ focusPath: "file-0.txt" });
    await waitFor(() => expect(callsFor("file-0.txt")).toBe(2));
    await fireEvent.click(screen.getByRole("button", { name: "全部收起" }));
    await waitFor(() => expect(screen.getByText(/已展开 0 \/ 100 个，已加载 0 个/)).toBeTruthy());
  });

  it("隐藏后立即重开相同提交也丢弃旧轮次响应", async () => {
    const requests: Array<(value: DiffResponse) => void> = [];
    commitFileDiff.mockImplementation(() => new Promise((resolve) => requests.push(resolve)));
    const view = render(CommitDiffList, {
      opened, detail: { ...detail, files: detail.files.slice(0, 1) }, parent: "parent0", disabled: false,
      nextId: () => 1, onGeneration: vi.fn(), onFailure: vi.fn(),
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await view.rerender({ active: false });
    await view.rerender({ active: true });
    await waitFor(() => expect(requests).toHaveLength(2));
    requests[0](diffFor("src/a.ts", "+OLD RESPONSE"));
    await tick();
    expect(screen.queryByText(codeLine("OLD RESPONSE"))).toBeNull();
    requests[1](diffFor("src/a.ts", "+NEW RESPONSE"));
    expect(await screen.findByText(codeLine("NEW RESPONSE"))).toBeTruthy();
  });

  it("文件块高度跟随内容，标题带行数，一个文件失败时另一个仍可阅读", async () => {
    commitFileDiff.mockImplementation((_repo: string, _oid: string, _parent: string, path: string) => {
      if (path.endsWith("b.ts")) return Promise.reject({ code: "diff_failed", message: "这个文件的差异没有读出来。" });
      return Promise.resolve(diffFor(path, "+a-content"));
    });
    const counted: CommitDetail = {
      ...detail,
      files: [
        { path: "src/a.ts", originalPath: null, status: "added", additions: 4, deletions: 0 },
        { path: "src/b.ts", originalPath: null, status: "modified", binary: true },
      ],
    };
    render(CommitDiffList, {
      props: {
        opened,
        detail: counted,
        parent: "parent0",
        disabled: false,
        nextId: () => 1,
        onGeneration: () => {},
        onFailure: () => {},
        onFileHistory: () => {},
      },
    });
    expect(await screen.findByText(codeLine("a-content"))).toBeTruthy();
    expect(await screen.findByText("这个文件的差异没有读出来。")).toBeTruthy();
    expect(screen.getByLabelText("新增 4 行，删除 0 行")).toBeTruthy();
    expect(screen.getByText("二进制")).toBeTruthy();
    const article = document.querySelector<HTMLElement>('.multi-file[data-path="src/a.ts"]');
    expect(article?.getAttribute("style") ?? "").not.toContain("420");
    expect(document.querySelector<HTMLElement>(".history-multi .multi-file-diff")?.style.maxHeight).not.toBe("");
    const css = readFileSync("src/styles/components.css", "utf8");
    expect(css).toContain(".history-multi .multi-file-diff { display: block; height: auto;");
    expect(css).toContain(".history-multi .multi-file-head { position: sticky;");
    expect(css).toContain(".side-row > .hunk-btn { grid-column: 3; grid-row: 1; }");
  });

  it("长差异在文件块内滚动后能看到 40 行之后，并排开关在缩窄后仍可恢复", async () => {
    const lines = Array.from({ length: 80 }, (_, index) => ({
      kind: "context" as const,
      text: ` L${index}`,
      oldNo: index + 1,
      newNo: index + 1,
      hunkIndex: 0,
    }));
    commitFileDiff.mockImplementation((_repo: string, _oid: string, _parent: string, path: string) =>
      Promise.resolve({
        ...diffFor(path, "+unused"),
        additions: 0,
        deletions: 0,
        totalLines: lines.length,
        lines,
      }),
    );
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let width = 800;
    const widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    try {
      render(CommitDiffList, {
        props: {
          opened,
          detail: {
            ...detail,
            files: [{ path: "src/a.ts", originalPath: null, status: "modified", additions: 0, deletions: 0 }],
          },
          parent: "parent0",
          disabled: false,
          nextId: () => 1,
          onGeneration: () => {},
          onFailure: () => {},
          onFileHistory: () => {},
        },
      });
      await screen.findByText(codeLine("L0"));
      expect(screen.queryByText(codeLine("L60"))).toBeNull();
      expect(document.querySelectorAll(".history-multi [data-diff-row]").length).toBeLessThanOrEqual(40);
      const host = document.querySelector<HTMLElement>(".history-multi .multi-file-diff")!;
      const scroller = host.querySelector<HTMLElement>(".diff-scroll")!;
      const box = (top: number, height: number) =>
        ({ top, height, left: 0, width: width, right: width, bottom: top + height, x: 0, y: top, toJSON() { return {}; } }) as DOMRect;
      host.getBoundingClientRect = () => box(0, 180);
      scroller.getBoundingClientRect = () => box(-60 * 18, 80 * 18);
      await fireEvent.scroll(host);
      await waitFor(() => expect(screen.getByText(codeLine("L60"))).toBeTruthy());
      const space = host.querySelector<HTMLElement>(".virtual-space")!;
      expect(space.style.height).toBe(`${80 * 18}px`);
      expect(host.querySelector(".multi-file-head")?.textContent).toContain("+0");
      expect(host.querySelector(".multi-file-head")?.textContent).toContain("−0");

      const split = screen.getByRole("button", { name: "并排" });
      expect(split.getAttribute("aria-pressed")).toBe("false");
      await fireEvent.click(split);
      expect(split.getAttribute("aria-pressed")).toBe("true");
      expect(host.querySelector(".side-row")).not.toBeNull();
      width = 80;
      for (const callback of callbacks) callback([], callback as unknown as ResizeObserver);
      await tick();
      expect(host.querySelector(".side-row")).toBeNull();
      expect(split.getAttribute("aria-pressed")).toBe("true");
      expect(host.querySelector(".diff")?.getAttribute("title")).toContain("窗口太窄，暂时使用统一视图");
      width = 800;
      for (const callback of callbacks) callback([], callback as unknown as ResizeObserver);
      await tick();
      expect(host.querySelector(".side-row")).not.toBeNull();
      expect(split.getAttribute("aria-pressed")).toBe("true");
      expect(host.querySelector(".hunk-btn")).toBeNull();
    } finally {
      widthSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
describe("历史只读差异的行选边界（R6）", () => {
  beforeEach(() => {
    commitFileDiff.mockReset();
    commitFileDiff.mockImplementation((_repo: string, _oid: string, _parent: string, path: string) =>
      Promise.resolve(diffFor(path, "+readonly-content")),
    );
  });

  it("只读差异没有选行入口，也不会出现暂存选中行", async () => {
    render(CommitDiffList, {
      props: {
        opened,
        detail: { ...detail, files: [detail.files[0]] },
        parent: "parent0",
        disabled: false,
        nextId: () => 1,
        onGeneration: () => {},
        onFailure: () => {},
        onFileHistory: () => {},
      },
    });
    expect(await screen.findByText(codeLine("readonly-content"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "选择行" })).toBeNull();
    expect(screen.queryByRole("button", { name: "暂存选中行" })).toBeNull();
  });
});

describe("只读差异的窄工具条（R2）", () => {
  function stubToolbarWidth(width: number) {
    const spy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("diff-toolbar") ? width : 0;
    });
    return () => spy.mockRestore();
  }

  const base = () => ({
    selection: { path: "src/a.ts", side: "unstaged" as const },
    diff: diffFor("src/a.ts", "+readonly-content"),
    error: null,
    loading: false,
    disabled: false,
    readOnly: true,
    onStageHunk: () => {},
    onLoadMore: () => {},
    onFileHistory: () => {},
  });

  it("只读差异的溢出只保留查看工具，没有行选与写入入口", async () => {
    const restore = stubToolbarWidth(560);
    try {
      render(DiffView, { props: base() });
      await tick();
      expect(screen.queryByRole("button", { name: "选择行" })).toBeNull();
      expect(screen.queryByRole("button", { name: /暂存选中行/ })).toBeNull();
      expect(screen.queryByRole("group", { name: "差异布局" })).toBeNull();

      await fireEvent.click(screen.getByRole("button", { name: /更多差异工具/ }));
      const dialog = screen.getByRole("dialog", { name: "差异工具" });
      // 低频查看工具仍可到达；写入动作不在只读视图里出现。
      expect(within(dialog).getByRole("option", { name: /此文件历史/ })).toBeTruthy();
      expect(within(dialog).getByRole("option", { name: /并排视图/ })).toBeTruthy();
      expect(within(dialog).queryByRole("option", { name: /清除选中的行/ })).toBeNull();
      expect(within(dialog).queryByRole("option", { name: /暂存/ })).toBeNull();
      await fireEvent.keyDown(dialog, { key: "Escape" });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /更多差异工具/ }));
    } finally {
      restore();
    }
  });

  it("embedded 差异块不画工具条，也不留悬空的溢出入口", async () => {
    const restore = stubToolbarWidth(420);
    try {
      render(DiffView, { props: { ...base(), embedded: true } });
      await tick();
      expect(document.querySelector(".diff-toolbar")).toBeNull();
      expect(screen.queryByRole("button", { name: /更多差异工具/ })).toBeNull();
    } finally {
      restore();
    }
  });

  /**
   * 宽度不变时 ResizeObserver 不会回调，靠 toolbarSignature 触发重测。
   * 这里让「文本差异」刚好放得下（scrollWidth = clientWidth = FULL_MIN），
   * 再把同一个差异换成带文档来源的 Markdown 差异并让内容实际变宽（多一个按钮）：
   * 只有签名包含「阅读文档」这一项，才会重新测量并收敛到溢出菜单。
   */
  it("同宽度从文本差异切到 Markdown 差异时重新测量并收进溢出菜单", async () => {
    const mdSides: PreviewSources = {
      repository: "/repo",
      old: { revision: "parent0", path: "src/a.ts" },
      new: { revision: "abc123", path: "src/a.ts" },
    };
    // happy-dom 没有排版：工具条宽度固定在 FULL_MIN，内容宽度代表「多一个按钮会不会折行」。
    let contentWidth = 1160;
    const widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("diff-toolbar") ? 1160 : 0;
    });
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("diff-toolbar") ? contentWidth : 0;
    });
    const onReadDocument = vi.fn();
    try {
      const view = render(DiffView, { props: { ...base(), onReadDocument } });
      await tick();
      // 起点：普通文本差异放得下，完整档没有溢出入口。
      expect(screen.queryByRole("button", { name: "阅读文档" })).toBeNull();
      expect(screen.queryByRole("button", { name: /更多差异工具/ })).toBeNull();

      // 同宽度换成 Markdown 差异：多出的「阅读文档」把内容挤宽，ResizeObserver 收不到通知。
      contentWidth = 1200;
      await view.rerender({
        ...base(),
        diff: { ...base().diff, document: mdSides },
        onReadDocument,
      });
      // 重测后按溢出自愈收敛：按钮不再直接露出，低频工具统一进溢出菜单。
      await waitFor(() => expect(screen.queryByRole("button", { name: /更多差异工具/ })).toBeTruthy());
      expect(screen.queryByRole("button", { name: "阅读文档" })).toBeNull();
      await fireEvent.click(screen.getByRole("button", { name: /更多差异工具/ }));
      const dialog = screen.getByRole("dialog", { name: "差异工具" });
      expect(within(dialog).getByRole("option", { name: /阅读文档/ })).toBeTruthy();
    } finally {
      widthSpy.mockRestore();
      scrollSpy.mockRestore();
    }
  });
});

describe("视野外的行内改动", () => {
  function rect(left: number, right: number, top: number, bottom: number): DOMRect {
    return { left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) } as DOMRect;
  }

  /** happy-dom 不排版：按类名给出几何，模拟「代码窗口 100–400px，改动落在 900px」的长行。 */
  function stubGeometry(markLeft: () => number) {
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("diff-scroll")) return rect(0, 400, 0, 300);
      if (this.classList.contains("code")) return rect(100, 400, 20, 38);
      if (this.classList.contains("wd")) return rect(markLeft(), markLeft() + 10, 20, 38);
      return rect(0, 0, 0, 0);
    });
    return () => spy.mockRestore();
  }

  function renderLongLine() {
    const prefix = "const description = \"" + "x".repeat(120);
    const diff = createTextDiff("src/a.ts", `${prefix}a";\n`, `${prefix}b";\n`, 1);
    return render(DiffView, {
      props: {
        selection: { path: "src/a.ts", side: "unstaged" as const },
        diff,
        error: null,
        loading: false,
        disabled: false,
        onStageHunk: () => {},
        onLoadMore: () => {},
      },
    });
  }

  it("改动在可见窗口右侧时给出入口，点击横向滚到改动处；看得见后入口收起", async () => {
    let markLeft = 900;
    const restore = stubGeometry(() => markLeft);
    try {
      renderLongLine();
      const hint = await screen.findByRole("button", { name: /2 行改动在右侧/ });
      expect(hint.getAttribute("data-hidden-change")).toBe("right");
      const scroller = document.querySelector<HTMLElement>(".diff-scroll")!;
      scroller.scrollLeft = 0;
      await fireEvent.click(hint);
      // 滚到改动左侧还留出一点上下文。
      expect(scroller.scrollLeft).toBe(900 - 100 - 48);
      markLeft = 148;
      await fireEvent.scroll(scroller);
      await waitFor(() => expect(screen.queryByRole("button", { name: /行改动在/ })).toBeNull());
    } finally {
      restore();
    }
  });

  it("改动已在可见窗口里时不显示入口", async () => {
    const restore = stubGeometry(() => 200);
    try {
      renderLongLine();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(document.querySelector("[data-hidden-change]")).toBeNull();
    } finally {
      restore();
    }
  });
});
