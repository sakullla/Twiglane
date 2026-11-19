import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Popover from "../src/lib/components/Popover.svelte";

/* ------------------------------------------------------------------ *
 * 共用弹层的定位契约（R1）：位置在首次显示前就按触发按钮定好，
 * 入场动画不得参与几何计算，也不允许「先摆一个位置、动画结束后再跳回来」。
 * happy-dom 没有布局，所以这里用可控的矩形替身描述浏览器已经算好的几何：
 * 触发按钮、可选的「带变换的祖先」（fixed 的包含块）和弹层自己的矩形。
 * ------------------------------------------------------------------ */

type Box = { top: number; left: number; width: number; height: number };

const VIEWPORT = { width: 1200, height: 800 };
/** 包含块原点：视口为 0；弹层放在带变换的祖先里时是那个祖先的左上。 */
let origin: { left: number; top: number } = { left: 0, top: 0 };
let anchorBox: Box = { top: 100, left: 40, width: 120, height: 32 };
/** 带变换的祖先（fixed 的包含块）的矩形；没有这种祖先时是 null。 */
let blockBox: Box | null = null;
/** 弹层自身入场变换带来的矩形偏移：修复前它会被当成包含块偏移，修复后不参与计算。 */
let ownShift: { x: number; y: number } = { x: 0, y: 0 };
const POPOVER_HEIGHT = 120;

const originalRect = Element.prototype.getBoundingClientRect;

/** 弹层是 fixed：矩形来自内联方位值 + 包含块原点（再加上任何自身变换）。 */
function popoverBox(el: HTMLElement): Box {
  const top = el.style.top ? parseFloat(el.style.top) : null;
  const bottom = el.style.bottom ? parseFloat(el.style.bottom) : null;
  const height = POPOVER_HEIGHT;
  const placedTop = top !== null ? origin.top + top : VIEWPORT.height - (bottom ?? 0) - height;
  return { top: placedTop + ownShift.y, left: origin.left + (parseFloat(el.style.left) || 0) + ownShift.x, width: parseFloat(el.style.width) || 0, height };
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: VIEWPORT.width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: VIEWPORT.height, configurable: true });
  origin = { left: 0, top: 0 };
  anchorBox = { top: 100, left: 40, width: 120, height: 32 };
  blockBox = null;
  ownShift = { x: 0, y: 0 };
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const el = this as HTMLElement;
    const box = el.classList.contains("popover")
      ? popoverBox(el)
      : el.hasAttribute("data-test-anchor")
        ? anchorBox
        : el.hasAttribute("data-test-block")
          ? (blockBox ?? { top: 0, left: 0, width: 0, height: 0 })
          : { top: 0, left: 0, width: 0, height: 0 };
    return {
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON: () => box,
    } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
  Element.prototype.getBoundingClientRect = originalRect;
});

const list = createRawSnippet((id: () => string) => ({
  render: () => `<div role="option" data-index="0" id="${id()}-0" tabindex="-1">第一项</div>`,
}));

function makeAnchor(): HTMLButtonElement {
  const anchor = document.createElement("button");
  anchor.setAttribute("data-test-anchor", "");
  return anchor;
}

/** 挂载共用外壳：返回弹层根元素与关闭回调；container 用来模拟「弹窗里的下拉」。 */
async function mount(options: { searchable?: boolean; anchor?: HTMLButtonElement; container?: HTMLElement; dismiss?: boolean } = {}) {
  const anchor = options.anchor ?? makeAnchor();
  if (!anchor.isConnected) document.body.append(anchor);
  // 真实消费者收到 onClose 就把弹层从渲染里去掉，焦点因此落到 body。
  const onClose = vi.fn((refocus: boolean) => {
    if (!options.dismiss) return;
    document.querySelector(".popover")?.remove();
    if (refocus) (document.activeElement as HTMLElement | null)?.blur?.();
  });
  render(Popover, {
    ...(options.container ? { target: options.container } : {}),
    props: {
      anchor,
      label: "测试弹层",
      placeholder: "搜索",
      searchable: options.searchable ?? true,
      query: "",
      active: 0,
      count: 1,
      width: 400,
      list,
      onChoose: () => {},
      onClose,
    },
  });
  const popover = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(".popover");
    if (!found) throw new Error("弹层没有打开");
    return found;
  });
  return { anchor, popover, onClose };
}

describe("共用弹层：首帧位置与展开方向", () => {
  it("入场变换不参与包含块原点：首帧就是最终位置，不再靠延时重测纠正", async () => {
    // 修复前：矩形里带着 translateY(-5px) 的入场位移，被当成包含块原点偏了 5px，
    // 于是先摆在偏低 5px 的位置，动画结束后重测才跳回；这里复现同一组几何。
    ownShift = { x: 0, y: 5 };
    const { popover } = await mount();
    expect(popover.dataset.side).toBe("down");
    // 贴住触发按钮下沿 + 间隙，不受自身变换影响。
    expect(popover.style.top).toBe("138px");
    expect(popover.style.left).toBe("40px");
    expect(popover.style.width).toBe("400px");
  });

  it("下方空间不足时直接向上展开：底边贴住触发按钮，不再先向下再向上", async () => {
    Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
    anchorBox = { top: 380, left: 40, width: 120, height: 32 };
    ownShift = { x: 0, y: -5 };
    const { popover } = await mount();
    expect(popover.dataset.side).toBe("up");
    expect(popover.style.top).toBe("");
    expect(popover.style.bottom).toBe(`${500 - 380 + 6}px`);
    expect(popover.style.maxHeight).toBe(`${380 - 6 - 8}px`);
  });

  it("弹窗里的下拉：带变换的祖先接管 fixed 时扣掉它的原点，矩形里的位移动画同样不算", async () => {
    const modal = document.createElement("div");
    modal.className = "modal-card";
    modal.setAttribute("data-test-block", "");
    modal.style.transform = "translateZ(0)";
    document.body.append(modal);
    origin = { left: 100, top: 50 };
    blockBox = { top: 50, left: 100, width: 900, height: 500 };
    anchorBox = { top: 120, left: 140, width: 120, height: 32 };
    ownShift = { x: 3, y: 5 };
    const anchor = makeAnchor();
    modal.append(anchor);
    const { popover } = await mount({ anchor, container: modal });
    expect(popover.parentElement).toBe(modal);
    expect(popover.style.top).toBe(`${120 + 32 + 6 - 50}px`);
    expect(popover.style.left).toBe(`${140 - 100}px`);
  });

  it("content-visibility 的祖先同样接管 fixed：没枚举到就会按视口原点摆放而整体偏移", async () => {
    // 实测 content-visibility: auto/hidden 会带 layout 与 paint 包含，浏览器因此把它当作 fixed 的包含块；
    // 判定里漏掉它时弹层仍按视口原点算，位置与锚点的间隙凭空多出这个祖先的偏移。
    const block = document.createElement("div");
    block.setAttribute("data-test-block", "");
    block.style.setProperty("content-visibility", "auto");
    document.body.append(block);
    origin = { left: 100, top: 50 };
    blockBox = { top: 50, left: 100, width: 900, height: 500 };
    anchorBox = { top: 120, left: 140, width: 120, height: 32 };
    const anchor = makeAnchor();
    block.append(anchor);
    const { popover } = await mount({ anchor, container: block });
    expect(popover.style.top).toBe(`${120 + 32 + 6 - 50}px`);
    expect(popover.style.left).toBe(`${140 - 100}px`);
  });

  it("content-visibility: visible（默认值）不算包含块：仍按视口原点摆放", async () => {
    const block = document.createElement("div");
    block.setAttribute("data-test-block", "");
    block.style.setProperty("content-visibility", "visible");
    document.body.append(block);
    origin = { left: 100, top: 50 };
    blockBox = { top: 50, left: 100, width: 900, height: 500 };
    anchorBox = { top: 120, left: 140, width: 120, height: 32 };
    const anchor = makeAnchor();
    block.append(anchor);
    const { popover } = await mount({ anchor, container: block });
    expect(popover.style.top).toBe(`${120 + 32 + 6}px`);
    expect(popover.style.left).toBe("140px");
  });

  it("贴在窗口内：靠近右边缘时收在边距里，不横向溢出", async () => {
    anchorBox = { top: 100, left: VIEWPORT.width - 60, width: 120, height: 32 };
    const { popover } = await mount();
    expect(popover.style.left).toBe(`${VIEWPORT.width - 400 - 8}px`);
    expect(parseFloat(popover.style.width)).toBeLessThanOrEqual(VIEWPORT.width - 16);
  });

  it("只在真实变化时重算：没有固定延时重测，窗口尺寸变化才换位置", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { popover } = await mount();
    expect(popover.style.top).toBe("138px");
    // 触发按钮被别的原因挪走：弹层不跟着乱跳，也不在某个固定延时后自己重算。
    anchorBox = { top: 400, left: 300, width: 120, height: 32 };
    await vi.advanceTimersByTimeAsync(400);
    expect(popover.style.top).toBe("138px");
    expect(popover.style.left).toBe("40px");
    // 真正的窗口变化才重选位置与方向。
    Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(popover.dataset.side).toBe("up"));
    expect(popover.style.bottom).toBe(`${500 - 400 + 6}px`);
  });

  it("入场动效只淡入：弹层外壳不再复用带位移与缩放的 pop", () => {
    const css = readFileSync(path.join(__dirname, "../src/styles/components.css"), "utf8");
    const rule = css.match(/\.popover \{[^}]*\}/)?.[0] ?? "";
    const animation = /animation:\s*([a-z-]+)/.exec(rule)?.[1] ?? "";
    expect(animation).not.toBe("pop");
    const base = readFileSync(path.join(__dirname, "../src/styles/base.css"), "utf8");
    const keyframes = base.match(new RegExp(`@keyframes ${animation} \\{[^}]*\\}`))?.[0] ?? "";
    expect(keyframes).not.toContain("transform");
  });
});

describe("共用弹层：关闭语义", () => {
  it("点外面关闭不抢焦点：焦点留在用户点的位置，Esc 才回到触发按钮", async () => {
    const { anchor, onClose } = await mount({ dismiss: true });
    const outside = document.createElement("button");
    outside.textContent = "外面";
    document.body.append(outside);
    outside.focus();
    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onClose).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(outside);

    // 重新打开，这次用 Esc 收起：焦点必须回到触发按钮。
    const reopened = await mount({ anchor, dismiss: true });
    reopened.onClose.mockClear();
    const search = reopened.popover.querySelector("input");
    search?.focus();
    search?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(reopened.onClose).toHaveBeenCalledWith(true);
    expect(document.querySelector(".popover")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(anchor));
  });
});