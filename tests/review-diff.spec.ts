import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTextDiff } from "../src/lib/diff";
import type { CommitDetail, DiffResponse, OpenedRepository } from "../src/lib/types";

const commitFileDiff = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", () => ({ api: { commitFileDiff } }));

import CommitDiffList from "../src/lib/components/CommitDiffList.svelte";
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
