import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DiffView from "../src/lib/components/DiffView.svelte";
import { resetDiffPrefs } from "../src/lib/diff-prefs.svelte";
import {
  REMOTE_HUNKS_UNSTAGEABLE_REASON,
  type DiffLine,
  type DiffResponse,
  type FileSelection,
} from "../src/lib/types";

/*
 * 远端差异的行选入口（B2 第 3 轮）：远端没有 patch 写入，所以「选行」与「暂存选中行」不能可用，
 * 右键菜单也不能给「块被截断」这种与事实无关的理由。这条断言必须渲染组件，所以放在 happy-dom
 * 文件里；tests/branches.spec.ts 是 node 环境，只断言 API 层带下来的原因。
 */

const selection: FileSelection = { path: "demo.txt", side: "unstaged" };

const lines: DiffLine[] = [
  { kind: "hunk", text: "@@ -1,4 +1,4 @@", oldNo: null, newNo: null, hunkIndex: 0 },
  { kind: "context", text: " line 1", oldNo: 1, newNo: 1, hunkIndex: 0 },
  { kind: "del", text: "-old 2", oldNo: 2, newNo: null, hunkIndex: 0 },
  { kind: "add", text: "+new 2", oldNo: null, newNo: 2, hunkIndex: 0 },
  { kind: "context", text: " line 3", oldNo: 3, newNo: 3, hunkIndex: 0 },
];

/** 同一份差异的两种能力：块可暂存（本地），或块完整但远端不支持暂存。 */
function diffOf(stageable: boolean, reason: string | null = null): DiffResponse {
  return {
    generation: 4,
    path: "demo.txt",
    staged: false,
    binary: false,
    text: null,
    summary: "新增 1 行，删除 1 行。",
    additions: 1,
    deletions: 1,
    complete: true,
    truncated: false,
    snapshot: "snap",
    hunks: [{ index: 0, header: "@@ -1,4 +1,4 @@", complete: true, stageable, startLine: 0, lineCount: 5 }],
    lines,
    offset: 0,
    totalLines: lines.length,
    ...(reason === null ? {} : { hunksStageableReason: reason }),
  };
}

function renderDiff(diff: DiffResponse, extra: Record<string, unknown> = {}) {
  const onStageLines = vi.fn();
  render(DiffView, {
    props: {
      selection,
      diff,
      error: null,
      loading: false,
      disabled: false,
      onStageHunk: () => {},
      onLoadMore: () => {},
      onStageLines,
      ...extra,
    },
  });
  return { onStageLines };
}

beforeEach(() => {
  resetDiffPrefs();
});

afterEach(() => {
  cleanup();
});

describe("远端差异的按行暂存入口", () => {
  it("远端差异下「选行」被禁用，禁用理由是真实原因，不会出现「暂存选中行」", async () => {
    const { onStageLines } = renderDiff(diffOf(false, REMOTE_HUNKS_UNSTAGEABLE_REASON));

    const pick = screen.getByRole("button", { name: "选择行" });
    expect(pick.hasAttribute("disabled"), "远端不支持块级写入时选行不能可用").toBe(true);
    expect(pick.getAttribute("title")).toContain("远端暂不支持块级/逐行暂存");
    // 禁用理由不能是「块被截断」：这份差异的块是完整的，只是远端写不进去。
    expect(pick.getAttribute("title")).not.toContain("截断");

    // 进不去选行模式，就没有「暂存选中行」这个写入入口可点。
    expect(screen.queryByRole("button", { name: "暂存选中行" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消暂存选中行" })).toBeNull();
    expect(onStageLines).not.toHaveBeenCalled();
  });

  it("同一份差异在本地块可暂存时「选行」仍可用，不会被误伤", async () => {
    renderDiff(diffOf(true));
    const pick = screen.getByRole("button", { name: "选择行" });
    expect(pick.hasAttribute("disabled")).toBe(false);
    expect(pick.getAttribute("title")).not.toContain("远端暂不支持");
  });

  it("右键菜单的按块暂存理由同样用真实原因，不再说「截断的代码块」", async () => {
    renderDiff(diffOf(false, REMOTE_HUNKS_UNSTAGEABLE_REASON));
    const row = document.querySelector<HTMLElement>("[data-line]");
    if (!row) throw new Error("没有可右键的代码行");
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    await tick();

    const item = screen.getByRole("menuitem", { name: "暂存此块" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("title")).toBe(REMOTE_HUNKS_UNSTAGEABLE_REASON);
    expect(item.textContent).not.toContain("截断");
  });
});
