import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Modal, { openModalCount } from "../src/lib/components/Modal.svelte";

const body = (html: string) => createRawSnippet(() => ({ render: () => `<div>${html}</div>` }));

function open(title: string, extra: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const view = render(Modal, {
    props: { title, titleId: `${title}-title`, onClose, children: body(`<button id="${title}-a">甲</button><button id="${title}-b">乙</button>`), ...extra },
  });
  return { onClose, view };
}

const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key, ...init });

describe("Modal 键盘处理不依赖焦点位置", () => {
  afterEach(() => {
    cleanup();
    expect(openModalCount()).toBe(0);
  });

  const blurToBody = () => (document.activeElement as HTMLElement | null)?.blur();

  it("焦点落到 body 时 Esc 仍能关闭", async () => {
    const { onClose } = open("甲窗");
    blurToBody();
    expect(document.activeElement).toBe(document.body);
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("焦点落到 body 时 Tab 拉回弹窗，Shift+Tab 落在末项", async () => {
    open("甲窗");
    const dialog = screen.getByRole("dialog");
    blurToBody();
    await press("Tab");
    expect(dialog.contains(document.activeElement)).toBe(true);
    blurToBody();
    await press("Tab", { shiftKey: true });
    expect(document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.id).toBe("甲窗-b");
  });

  it("Tab 在首尾循环", async () => {
    open("甲窗");
    document.getElementById("甲窗-b")!.focus();
    await press("Tab");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("关闭对话框");
    await press("Tab", { shiftKey: true });
    expect(document.activeElement?.id).toBe("甲窗-b");
  });

  it("叠层时只有最上层响应", async () => {
    const lower = open("下层");
    const upper = open("上层");
    await press("Escape");
    expect(upper.onClose).toHaveBeenCalledTimes(1);
    expect(lower.onClose).not.toHaveBeenCalled();
  });

  it("上层在同一次按键里卸载，下层也不接着关", async () => {
    const lower = open("下层");
    const onClose = vi.fn();
    const upper = render(Modal, {
      props: { title: "上层", titleId: "上层-title", children: body("<button>甲</button>"), onClose: () => { onClose(); upper.unmount(); } },
    });
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lower.onClose).not.toHaveBeenCalled();
  });

  it("内层处理过的 Esc 不再关闭弹窗", async () => {
    const { onClose } = open("甲窗");
    const inner = document.getElementById("甲窗-a")!;
    inner.addEventListener("keydown", (event) => event.preventDefault());
    await fireEvent.keyDown(inner, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.keyDown(inner, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("写入在途锁定：Esc、背板和右上角都不关闭，结束后恢复", async () => {
    const { onClose, view } = open("甲窗", { locked: true });
    await press("Escape");
    await fireEvent.mouseDown(document.querySelector("[data-modal-backdrop]")!);
    const close = screen.getByRole("button", { name: "关闭对话框" });
    expect(close.hasAttribute("disabled")).toBe(true);
    expect(close.getAttribute("title")).toContain("写入完成");
    expect(onClose).not.toHaveBeenCalled();
    await view.rerender({ locked: false });
    await tick();
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("关闭后不再监听", async () => {
    const { onClose, view } = open("甲窗");
    view.unmount();
    await press("Escape");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("headExtra 排在标题之后、关闭按钮之前", () => {
    open("甲窗", { headExtra: createRawSnippet(() => ({ render: () => `<div id="extra"></div>` })) });
    const head = document.querySelector(".modal-head")!;
    expect(head.querySelector(".modal-titles + #extra + button")).toBeTruthy();
  });
});
