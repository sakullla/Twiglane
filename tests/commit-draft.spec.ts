import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTextDiff } from "../src/lib/diff";
import { hasCommitSummary } from "../src/lib/ui";
import CommitDraft, {
  MESSAGE_HEIGHT_COMPACT,
  MESSAGE_HEIGHT_DEFAULT,
  MESSAGE_HEIGHT_MAX,
  MESSAGE_HEIGHT_MIN,
  clampMessageHeight,
} from "../src/lib/components/CommitDraft.svelte";
import DiffView from "../src/lib/components/DiffView.svelte";

/** 提交区除说明框外的高度和面板高度：上限 = 面板 − 其余部分 − 文件列表保留的 300。 */
const LAYOUT_CHROME = 118;
const LAYOUT_PANEL = 772;
const LAYOUT_LIMIT = LAYOUT_PANEL - LAYOUT_CHROME - 300;

/**
 * happy-dom 没有布局，clientHeight 恒为 0 时上限计算直接跳过，问题看不出来。
 * 这里让尺寸跟着说明框已渲染的 style 走，与真实 DOM 一样：状态变了、DOM 没刷新时读到的还是旧值。
 */
function mockLayout(panel = LAYOUT_PANEL) {
  vi.restoreAllMocks();
  const textareaHeight = (element: HTMLElement) =>
    Number.parseFloat(element.querySelector("textarea")?.style.height ?? "0");
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this instanceof HTMLTextAreaElement) return Number.parseFloat(this.style.height);
    return this.matches(".composer") ? LAYOUT_CHROME + textareaHeight(this) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.querySelector(":scope > .composer") ? panel : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.querySelector(":scope > .composer") ? 340 : 0;
  });
}

function mockPanelHeight(panel: number) {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.querySelector(":scope > .composer") ? panel : 0;
  });
}

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

afterEach(() => vi.restoreAllMocks());

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

  it("说明框静止且为空时只占一行，聚焦后展开到记住的高度，有内容时保持展开", async () => {
    localStorage.setItem("twiglane.commitMessageHeight", "240");
    const outside = document.createElement("button");
    document.body.append(outside);
    renderDraft();
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_COMPACT}px`);
    expect(MESSAGE_HEIGHT_COMPACT).toBeLessThan(MESSAGE_HEIGHT_MIN);

    await fireEvent.focus(message());
    expect(message().style.height, "聚焦后展开到已保存高度").toBe("240px");
    await fireEvent.pointerDown(document.querySelector(".composer-scope")!);
    expect(message().style.height, "点提交区内的按钮不改变布局，否则按钮会在按下时移位").toBe("240px");
    await fireEvent.pointerDown(outside);
    expect(message().style.height, "点到提交区外才收起").toBe(`${MESSAGE_HEIGHT_COMPACT}px`);

    await fireEvent.focus(message());
    await fireEvent.focusIn(outside);
    expect(message().style.height, "键盘把焦点移走也收起").toBe(`${MESSAGE_HEIGHT_COMPACT}px`);
    outside.remove();

    document.body.innerHTML = "";
    renderDraft({ value: "草稿" });
    expect(message().style.height, "有内容时不收起").toBe("240px");
  });

  it("空说明也能用键盘调高：分隔线聚焦时展开，否则调整看不见", async () => {
    renderDraft();
    await fireEvent.focus(handle());
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_DEFAULT}px`);
    await fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_DEFAULT + 16}px`);
  });

  it("提交并推送的文字任何宽度都完整显示，不再收成图标", () => {
    renderDraft();
    expect(document.querySelector(".composer-commit-label")?.textContent).toBe("提交到本地");
    expect(document.querySelector(".composer-push-label")?.textContent).toBe("提交并推送");
  });

  it("默认说明框够写几行，上沿分隔线可用键盘调高调低并记住", async () => {
    renderDraft({ value: "草稿" });
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
    renderDraft({ value: "草稿" });
    expect(message().style.height).toBe("240px");
  });

  it("收起态按下分隔线不跳变，拖动从显示高度起算，松手后结果保持可见并记住", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    renderDraft();
    await fireEvent.pointerDown(handle(), { button: 0, clientY: 500, pointerId: 1 });
    expect(message().style.height, "按下时分隔线不能和指针错开").toBe(`${MESSAGE_HEIGHT_COMPACT}px`);
    await fireEvent.pointerMove(handle(), { clientY: 380, pointerId: 1 });
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_COMPACT + 120}px`);
    await fireEvent.pointerUp(handle(), { clientY: 380, pointerId: 1 });
    expect(message().style.height, "松手不收回").toBe(`${MESSAGE_HEIGHT_COMPACT + 120}px`);
    expect(localStorage.getItem("twiglane.commitMessageHeight")).toBe(String(MESSAGE_HEIGHT_COMPACT + 120));

    await fireEvent.pointerDown(document.querySelector(".composer-scope")!);
    expect(message().style.height, "点提交区内部仍不收起").toBe(`${MESSAGE_HEIGHT_COMPACT + 120}px`);
    await fireEvent.pointerDown(outside);
    expect(message().style.height, "离开提交区才收起").toBe(`${MESSAGE_HEIGHT_COMPACT}px`);
    await fireEvent.focus(message());
    expect(message().style.height, "再次聚焦回到拖出来的高度").toBe(`${MESSAGE_HEIGHT_COMPACT + 120}px`);
    outside.remove();
  });

  it("收起态只点一下或手抖不改变布局，也不改写记住的高度", async () => {
    localStorage.setItem("twiglane.commitMessageHeight", "240");
    renderDraft();
    await fireEvent.pointerDown(handle(), { button: 0, clientY: 500, pointerId: 1 });
    await fireEvent.pointerMove(handle(), { clientY: 498, pointerId: 1 });
    await fireEvent.pointerUp(handle(), { clientY: 498, pointerId: 1 });
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_COMPACT}px`);
    expect(localStorage.getItem("twiglane.commitMessageHeight")).toBe("240");
  });

  it("收起态向下拖没有效果，不改写记住的高度", async () => {
    localStorage.setItem("twiglane.commitMessageHeight", "240");
    renderDraft();
    await fireEvent.pointerDown(handle(), { button: 0, clientY: 500, pointerId: 1 });
    await fireEvent.pointerMove(handle(), { clientY: 560, pointerId: 1 });
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_COMPACT}px`);
    await fireEvent.pointerUp(handle(), { clientY: 560, pointerId: 1 });
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_COMPACT}px`);
    expect(localStorage.getItem("twiglane.commitMessageHeight")).toBe("240");
  });

  it("收起态上拖没到最小高度按点击处理：恢复收起，不改写记住的高度", async () => {
    localStorage.setItem("twiglane.commitMessageHeight", "240");
    renderDraft();
    for (const clientY of [496, 490, 481]) {
      await fireEvent.pointerDown(handle(), { button: 0, clientY: 500, pointerId: 1 });
      await fireEvent.pointerMove(handle(), { clientY, pointerId: 1 });
      expect(message().style.height).toBe(`${MESSAGE_HEIGHT_COMPACT + 500 - clientY}px`);
      await fireEvent.pointerUp(handle(), { clientY, pointerId: 1 });
      expect(message().style.height, `上拖 ${500 - clientY}px`).toBe(`${MESSAGE_HEIGHT_COMPACT}px`);
      expect(localStorage.getItem("twiglane.commitMessageHeight")).toBe("240");
    }
  });

  it("收起态刚好拖到最小高度时算一次调整", async () => {
    renderDraft();
    const clientY = 500 - (MESSAGE_HEIGHT_MIN - MESSAGE_HEIGHT_COMPACT);
    await fireEvent.pointerDown(handle(), { button: 0, clientY: 500, pointerId: 1 });
    await fireEvent.pointerMove(handle(), { clientY, pointerId: 1 });
    await fireEvent.pointerUp(handle(), { clientY, pointerId: 1 });
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_MIN}px`);
    expect(localStorage.getItem("twiglane.commitMessageHeight")).toBe(String(MESSAGE_HEIGHT_MIN));
  });

  it("窗口收紧过的高度上拖动再拖回原位，不把收紧值写成偏好", async () => {
    mockLayout();
    localStorage.setItem("twiglane.commitMessageHeight", "500");
    renderDraft({ value: "草稿" });
    expect(message().style.height).toBe(`${LAYOUT_LIMIT}px`);
    await fireEvent.pointerDown(handle(), { button: 0, clientY: 500, pointerId: 1 });
    await fireEvent.pointerMove(handle(), { clientY: 540, pointerId: 1 });
    await fireEvent.pointerMove(handle(), { clientY: 500, pointerId: 1 });
    await fireEvent.pointerUp(handle(), { clientY: 500, pointerId: 1 });
    expect(localStorage.getItem("twiglane.commitMessageHeight")).toBe("500");
  });

  describe("可用空间变化时重算上限", () => {
    type Callback = () => void;
    let observers: { callback: Callback; targets: Element[] }[];

    beforeEach(() => {
      observers = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          entry: { callback: Callback; targets: Element[] };
          constructor(callback: Callback) {
            this.entry = { callback, targets: [] };
            observers.push(this.entry);
          }
          observe(target: Element) {
            this.entry.targets.push(target);
          }
          disconnect() {
            this.entry.targets = [];
          }
        },
      );
    });

    afterEach(() => vi.unstubAllGlobals());

    const fire = async () => {
      for (const observer of observers) observer.callback();
      await tick();
    };

    it("同时观察提交区和父面板", () => {
      renderDraft({ value: "草稿" });
      const section = document.querySelector(".composer")!;
      expect(observers).toHaveLength(1);
      expect(observers[0].targets).toEqual([section, section.parentElement]);
    });

    it("栏宽变窄、提交区变高时收紧说明框，不改写保存值", async () => {
      mockLayout();
      localStorage.setItem("twiglane.commitMessageHeight", "300");
      renderDraft({ value: "草稿" });
      expect(message().style.height).toBe("300px");
      // 没有窗口 resize：按钮堆叠让提交区其余部分从 118 变成 200。
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        if (this instanceof HTMLTextAreaElement) return Number.parseFloat(this.style.height);
        return this.matches(".composer") ? 200 + Number.parseFloat(this.querySelector("textarea")!.style.height) : 0;
      });
      await fire();
      expect(message().style.height).toBe(`${LAYOUT_PANEL - 200 - 300}px`);
      expect(localStorage.getItem("twiglane.commitMessageHeight")).toBe("300");
    });

    it("隐藏的左栏不参与计算，显示回来后按当前空间恢复", async () => {
      mockLayout(420);
      localStorage.setItem("twiglane.commitMessageHeight", "90");
      renderDraft({ value: "草稿" });
      expect(message().style.height).toBe(`${MESSAGE_HEIGHT_MIN}px`);
      // 隐藏期间宽度为 0：量到的高度没有意义，不更新。
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(0);
      mockPanelHeight(LAYOUT_PANEL);
      await fire();
      expect(message().style.height).toBe(`${MESSAGE_HEIGHT_MIN}px`);
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
        return this.querySelector(":scope > .composer") ? 340 : 0;
      });
      await fire();
      expect(message().style.height).toBe("90px");
      expect(localStorage.getItem("twiglane.commitMessageHeight")).toBe("90");
    });
  });

  describe("真实布局尺寸下的上限", () => {
    /** 拖到目标高度再松手：松手值和保存值都必须等于松手前的显示值。 */
    async function dragTo(target: number, startHeight: number) {
      await fireEvent.pointerDown(handle(), { button: 0, clientY: 600, pointerId: 1 });
      await fireEvent.pointerMove(handle(), { clientY: 600 - (target - startHeight), pointerId: 1 });
      const before = message().style.height;
      await fireEvent.pointerUp(handle(), { clientY: 600 - (target - startHeight), pointerId: 1 });
      await tick();
      expect(message().style.height, `拖到 ${target}`).toBe(before);
      expect(`${localStorage.getItem("twiglane.commitMessageHeight")}px`).toBe(before);
      return before;
    }

    beforeEach(() => mockLayout());

    for (const target of [156, 236, 262, 304, 316, LAYOUT_LIMIT]) {
      it(`收起态拖到 ${target}，松手值和保存值都不变`, async () => {
        renderDraft();
        expect(await dragTo(target, MESSAGE_HEIGHT_COMPACT)).toBe(`${target}px`);
      });

      it(`有草稿时拖到 ${target}，松手值和保存值都不变`, async () => {
        renderDraft({ value: "草稿" });
        expect(await dragTo(target, MESSAGE_HEIGHT_DEFAULT)).toBe(`${target}px`);
      });
    }

    it("拖过上限时停在上限，松手不回退", async () => {
      renderDraft({ value: "草稿" });
      expect(await dragTo(LAYOUT_LIMIT + 200, MESSAGE_HEIGHT_DEFAULT)).toBe(`${LAYOUT_LIMIT}px`);
    });

    it("矮窗口上限更低时同样不回退", async () => {
      mockLayout(532);
      renderDraft();
      expect(await dragTo(114, MESSAGE_HEIGHT_COMPACT)).toBe("114px");
    });

    it("收起态双击按展开后的尺寸计算上限，不会超过上限", async () => {
      mockLayout(500);
      localStorage.setItem("twiglane.commitMessageHeight", "60");
      renderDraft();
      await fireEvent.dblClick(handle());
      expect(message().style.height).toBe("82px");
    });
  });

  it("收起态双击恢复默认高度，结果看得见", async () => {
    localStorage.setItem("twiglane.commitMessageHeight", "240");
    renderDraft();
    await fireEvent.dblClick(handle());
    expect(message().style.height).toBe(`${MESSAGE_HEIGHT_DEFAULT}px`);
    expect(localStorage.getItem("twiglane.commitMessageHeight")).toBe(String(MESSAGE_HEIGHT_DEFAULT));
  });

  it("拖动上沿分隔线：向上拖拉高说明框，向下拖还给文件列表", async () => {
    renderDraft({ value: "草稿" });
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
