import { afterEach, describe, expect, it } from "vitest";
import { modalityForKey, trackInputModality } from "../src/lib/input-modality";

describe("输入方式跟踪", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
    delete document.documentElement.dataset.input;
  });

  it("指针按下切到 pointer，导航键切回 keyboard", () => {
    stop = trackInputModality();
    window.dispatchEvent(new PointerEvent("pointerdown"));
    expect(document.documentElement.dataset.input).toBe("pointer");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(document.documentElement.dataset.input).toBe("keyboard");
  });

  it("只按修饰键或 Ctrl/⌘ 组合不算键盘导航", () => {
    expect(modalityForKey({ key: "Shift", ctrlKey: false, metaKey: false })).toBeNull();
    expect(modalityForKey({ key: "c", ctrlKey: true, metaKey: false })).toBeNull();
    expect(modalityForKey({ key: "k", ctrlKey: false, metaKey: true })).toBeNull();
    expect(modalityForKey({ key: "Tab", ctrlKey: false, metaKey: false })).toBe("keyboard");
    stop = trackInputModality();
    window.dispatchEvent(new PointerEvent("pointerdown"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }));
    expect(document.documentElement.dataset.input, "复制不让焦点环冒出来").toBe("pointer");
  });

  it("停止跟踪后不再改写", () => {
    stop = trackInputModality();
    stop();
    stop = null;
    window.dispatchEvent(new PointerEvent("pointerdown"));
    expect(document.documentElement.dataset.input).toBeUndefined();
  });
});
