import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTextDiff } from "../src/lib/diff";
import { hasCommitSummary } from "../src/lib/ui";
import CommitDraft, {
  MESSAGE_HEIGHT_DEFAULT,
  MESSAGE_HEIGHT_MAX,
  MESSAGE_HEIGHT_MIN,
  clampMessageHeight,
} from "../src/lib/components/CommitDraft.svelte";
import DiffView from "../src/lib/components/DiffView.svelte";

function renderDraft(extra: Record<string, unknown> = {}) {
  const onInput = vi.fn();
  const onCommit = vi.fn();
  const onStageAll = vi.fn();
  const utils = render(CommitDraft, {
    props: {
      branch: "feature/ui",
      scope: "提交到 feature/ui · 2 个已暂存文件",
      paths: ["a.ts", "b.ts"],
      value: "",
      disabled: false,
      onInput,
      onBlur: () => {},
      onCommit,
      onScope: () => {},
      onStageAll,
      ...extra,
    },
  });
  return { ...utils, onInput, onCommit, onStageAll };
}

const message = () => screen.getByRole("textbox", { name: "提交说明草稿" }) as HTMLTextAreaElement;
const handle = () => screen.getByRole("separator", { name: "调整提交说明高度" });

describe("提交区", () => {
  beforeEach(() => localStorage.clear());

  it("只有一个说明框，输入原样回写；第一行为空时不能提交", async () => {
    const { onInput } = renderDraft({ value: "修复登录\n\n原因：令牌过期" });
    expect(document.querySelectorAll(".composer textarea, .composer input")).toHaveLength(1);
    expect(message().value).toBe("修复登录\n\n原因：令牌过期");
    await fireEvent.input(message(), { target: { value: "修复登录跳转" } });
    expect(onInput).toHaveBeenLastCalledWith("修复登录跳转");
    expect(hasCommitSummary("修复登录\n\n正文")).toBe(true);
    expect(hasCommitSummary("\n\n只有正文")).toBe(false);
    document.body.innerHTML = "";
    renderDraft({ value: "\n\n只有正文" });
    expect(screen.getByRole("button", { name: "提交到本地" }).hasAttribute("disabled")).toBe(true);
    expect(document.querySelector("[data-commit-blocker]")?.textContent?.trim()).toBe("填写提交说明后即可提交");
  });

  it("第一行超过建议长度时给出计数提示，超过 72 个字符转为警示", () => {
    renderDraft({ value: "x".repeat(60) });
    expect(document.querySelector(".composer-count")?.textContent).toBe("摘要 60/72");
    expect(document.querySelector(".composer-count")?.className).toContain("near");
    document.body.innerHTML = "";
    renderDraft({ value: `${"x".repeat(80)}\n\n正文不计入` });
    expect(document.querySelector(".composer-count")?.className).toContain("over");
  });

  it("默认说明框够写几行，上沿分隔线可用键盘调高调低并记住", async () => {
    renderDraft();
    expect(MESSAGE_HEIGHT_DEFAULT).toBeGreaterThanOrEqual(100);
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_DEFAULT}px`);
    expect(handle().getAttribute("aria-valuenow")).toBe(String(MESSAGE_HEIGHT_DEFAULT));
    await fireEvent.keyDown(handle(), { key: "ArrowUp" });
    await fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_DEFAULT + 32}px`);
    expect(localStorage.getItem("twiglane.commitMessageHeight")).toBe(String(MESSAGE_HEIGHT_DEFAULT + 32));
    await fireEvent.keyDown(handle(), { key: "Home" });
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_MIN}px`);
    await fireEvent.dblClick(handle());
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_DEFAULT}px`);

    localStorage.setItem("twiglane.commitMessageHeight", "240");
    document.body.innerHTML = "";
    renderDraft();
    expect(message().style.height).toBe("240px");
  });

  it("拖动上沿分隔线：向上拖拉高说明框，向下拖还给文件列表", async () => {
    renderDraft();
    await fireEvent.pointerDown(handle(), { button: 0, clientY: 500, pointerId: 1 });
    await fireEvent.pointerMove(handle(), { clientY: 380, pointerId: 1 });
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_DEFAULT + 120}px`);
    await fireEvent.pointerMove(handle(), { clientY: 540, pointerId: 1 });
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_DEFAULT - 40}px`);
    await fireEvent.pointerUp(handle(), { clientY: 540, pointerId: 1 });
    expect(localStorage.getItem("twiglane.commitMessageHeight")).toBe(String(MESSAGE_HEIGHT_DEFAULT - 40));
  });

  it("高度有上下限", () => {
    expect(clampMessageHeight(10)).toBe(MESSAGE_HEIGHT_MIN);
    expect(clampMessageHeight(5000)).toBe(MESSAGE_HEIGHT_MAX);
    expect(clampMessageHeight(400, 300)).toBe(300);
    expect(clampMessageHeight(400, 20)).toBe(MESSAGE_HEIGHT_MIN);
  });

  it("暂存区为空而工作区有改动时，就地提供「全部暂存」", async () => {
    const { onStageAll } = renderDraft({ paths: [], value: "说明", stageableCount: 4 });
    expect(document.querySelector("[data-commit-blocker]")?.textContent?.trim()).toBe("先暂存要提交的文件");
    await fireEvent.click(screen.getByRole("button", { name: "全部暂存 4" }));
    expect(onStageAll).toHaveBeenCalledTimes(1);
    document.body.innerHTML = "";
    renderDraft({ paths: [], value: "说明", stageableCount: 0 });
    expect(screen.queryByRole("button", { name: /全部暂存/ })).toBeNull();
  });

  it("可提交时显示目标分支与文件数，提交按钮可用", async () => {
    const { onCommit } = renderDraft({ value: "重做提交区" });
    expect(document.querySelector(".composer-branch")?.textContent).toContain("feature/ui");
    expect(screen.getByRole("button", { name: "本次提交范围：2 个已暂存文件" }).textContent).toContain("2 个文件");
    await fireEvent.click(screen.getByRole("button", { name: "提交到本地" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe("并排差异", () => {
  it("一删两增时多出的新增行排在配对行之后，占位格不借用全局空状态样式", async () => {
    const diff = createTextDiff("a.ts", "a\nold\nb\n", "a\nnew\nmore\nb\n", 1);
    render(DiffView, {
      props: {
        selection: { path: "a.ts", side: "unstaged" },
        diff,
        error: null,
        loading: false,
        disabled: false,
        onStageHunk: () => {},
        onLoadMore: () => {},
      },
    });
    await fireEvent.click(screen.getByRole("button", { name: /并排/ }));
    // .empty 是全局空状态（flex + 大内边距），占位格用了它就会被撑高、相邻行文字叠在一起。
    expect(document.querySelector(".side-cell.empty")).toBeNull();
    const rows = [...document.querySelectorAll(".side-row")].map((row) =>
      [...row.querySelectorAll(".side-cell")].map((cell) => cell.querySelector(".ln")?.textContent ?? ""),
    );
    const right = rows.map((cells) => cells[1]).filter(Boolean);
    expect(right).toEqual([...right].sort((x, y) => Number(x) - Number(y)));
    expect(document.querySelectorAll(".side-cell.blank")).toHaveLength(1);
  });
});
