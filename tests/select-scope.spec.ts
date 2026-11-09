import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "../src/lib/components/CommandPalette.svelte";
import { scopedSelectAll } from "../src/lib/select-scope";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function press(target: Element, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  scopedSelectAll(event);
  return event;
}

describe("⌘/Ctrl A 只选焦点所在的阅读区域", () => {
  it("在阅读区域里只选它自己的内容", () => {
    document.body.innerHTML = `<header>标题栏</header><div data-select-scope><p id="inner">正文</p></div>`;
    const scope = document.querySelector("[data-select-scope]")!;
    const select = vi.spyOn(window.getSelection()!, "selectAllChildren");
    const event = press(document.getElementById("inner")!);
    expect(event.defaultPrevented).toBe(true);
    expect(select).toHaveBeenCalledWith(scope);
    select.mockRestore();
  });

  it("不在任何阅读区域时拦下原生全选，不把整个窗口选中", () => {
    document.body.innerHTML = `<button id="b">按钮</button>`;
    const select = vi.spyOn(window.getSelection()!, "selectAllChildren");
    const event = press(document.getElementById("b")!);
    expect(event.defaultPrevented).toBe(true);
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
  });

  it("输入框、组件已处理、带其他修饰键时都不拦", () => {
    document.body.innerHTML = `<input id="i" /><textarea id="t"></textarea><div data-select-scope id="s"></div>`;
    expect(press(document.getElementById("i")!).defaultPrevented).toBe(false);
    expect(press(document.getElementById("t")!).defaultPrevented).toBe(false);
    expect(press(document.getElementById("s")!, { shiftKey: true }).defaultPrevented).toBe(false);
    const handled = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    handled.preventDefault();
    expect(scopedSelectAll(handled)).toBe(false);
  });
});

describe("命令面板的不可用条目", () => {
  const commands = [
    { id: "a", group: "提交", title: "提交到本地", enabled: false, reason: "暂存区为空", run: vi.fn() },
    { id: "b", group: "提交", title: "提交并推送", enabled: false, reason: "暂存区为空", run: vi.fn() },
    { id: "c", group: "同步", title: "推送", run: vi.fn() },
  ];

  it("打开时游标落在第一条可用命令上；搜索时可用的排在前面", async () => {
    render(CommandPalette, { props: { open: true, onClose: () => {}, commands } as never });
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    const active = () => document.getElementById(input.getAttribute("aria-activedescendant") ?? "");
    expect(active()?.textContent).toContain("推送");
    expect(active()?.getAttribute("aria-disabled")).toBe("false");

    await fireEvent.input(input, { target: { value: "推送" } });
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.firstElementChild?.textContent)).toEqual(["推送", "提交并推送"]);
    expect(active()?.textContent).toContain("推送");
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(commands[2].run).toHaveBeenCalledTimes(1);
  });

  it("不可用条目的原因写在条目里与悬停提示上，点了不执行", async () => {
    render(CommandPalette, { props: { open: true, onClose: () => {}, commands } as never });
    const option = screen.getByRole("option", { name: /提交到本地/ });
    expect(option.getAttribute("title")).toBe("暂存区为空");
    expect(option.querySelector(".palette-reason")?.textContent).toBe("暂存区为空");
    await fireEvent.click(option);
    expect(commands[0].run).not.toHaveBeenCalled();
  });
});
