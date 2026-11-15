import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "../src/lib/components/ContextMenu.svelte";

function request(entries: ContextMenuEntry[], label = "测试菜单"): ContextMenuRequest {
  return { x: 40, y: 40, entries, label };
}

function entries(spy = vi.fn()): ContextMenuEntry[] {
  return [
    { id: "top", label: "顶层动作", run: () => spy("top") },
    {
      id: "more",
      label: "更多",
      submenu: [
        { id: "a", label: "子项甲", run: () => spy("a") },
        { id: "b", label: "子项乙", run: () => spy("b") },
      ],
    },
    { id: "off", label: "不可用", disabledReason: "没有目标", submenu: [{ id: "x", label: "藏起来的", run: () => spy("x") }] },
  ];
}

describe("右键菜单的二级菜单", () => {
  it("子菜单入口带 aria-haspopup/expanded，点击后在旁边展开，执行子项后整个菜单关闭", async () => {
    const spy = vi.fn();
    const onClose = vi.fn();
    render(ContextMenu, { props: { request: request(entries(spy)), onClose } });
    const trigger = screen.getByRole("menuitem", { name: "更多" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(trigger);
    const sub = await screen.findByRole("menu", { name: "更多" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.click(within(sub).getByRole("menuitem", { name: "子项乙" }));
    expect(spy).toHaveBeenCalledWith("b");
    expect(onClose).toHaveBeenCalled();
  });

  it("键盘：→ 展开并聚焦第一项，← 收回并把焦点还给入口，Esc 先收子菜单再关根菜单", async () => {
    const onClose = vi.fn();
    render(ContextMenu, { props: { request: request(entries()), onClose } });
    const root = screen.getByRole("menu", { name: "测试菜单" });
    // 键盘唤起时挂载即聚焦第一项，↓ 一次到子菜单入口。
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "顶层动作" })));
    await fireEvent.keyDown(root, { key: "ArrowDown" });
    const trigger = screen.getByRole("menuitem", { name: "更多" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    await fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const sub = await screen.findByRole("menu", { name: "更多" });
    await waitFor(() => expect(document.activeElement).toBe(within(sub).getByRole("menuitem", { name: "子项甲" })));

    await fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.queryByRole("menu", { name: "更多" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    await fireEvent.keyDown(trigger, { key: "Enter" });
    const again = await screen.findByRole("menu", { name: "更多" });
    await fireEvent.keyDown(again, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "更多" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.keyDown(root, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("悬停片刻展开，移到同层普通条目后收起", async () => {
    vi.useFakeTimers();
    try {
      render(ContextMenu, { props: { request: request(entries()), onClose: vi.fn() } });
      await fireEvent.mouseMove(screen.getByRole("menuitem", { name: "更多" }));
      expect(screen.queryByRole("menu", { name: "更多" })).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(screen.getByRole("menu", { name: "更多" })).toBeTruthy();
      await fireEvent.mouseMove(screen.getByRole("menuitem", { name: "顶层动作" }));
      await vi.advanceTimersByTimeAsync(200);
      expect(screen.queryByRole("menu", { name: "更多" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("不可用的子菜单入口不展开，原因写在菜单里", async () => {
    render(ContextMenu, { props: { request: request(entries()), onClose: vi.fn() } });
    const off = screen.getByRole("menuitem", { name: "不可用" });
    expect(off.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("没有目标")).toBeTruthy();
    await fireEvent.click(off);
    expect(screen.queryByRole("menu", { name: "不可用" })).toBeNull();
  });

  it("菜单开着时换了 request：子菜单收起，根层换成新条目", async () => {
    const view = render(ContextMenu, { props: { request: request(entries()), onClose: vi.fn() } });
    await fireEvent.click(screen.getByRole("menuitem", { name: "更多" }));
    expect(await screen.findByRole("menu", { name: "更多" })).toBeTruthy();
    await view.rerender({ request: request([{ id: "n", label: "新条目", run: () => {} }], "新菜单"), onClose: vi.fn() });
    expect(screen.queryByRole("menu", { name: "更多" })).toBeNull();
    expect(within(screen.getByRole("menu", { name: "新菜单" })).getByRole("menuitem", { name: "新条目" })).toBeTruthy();
  });
});
