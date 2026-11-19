import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppContextMenu from "../src/lib/components/AppContextMenu.svelte";
import { classifyContextTarget, editActions, editableEntries, saveSelection } from "../src/lib/app-context-menu";

function host(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function rightClick(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("classifyContextTarget", () => {
  it("组件已处理、终端交给自己；输入框与选中文字给编辑菜单；其它只拦原生菜单", () => {
    const root = host(`
      <div id="plain">plain text</div>
      <input id="text" />
      <input id="check" type="checkbox" />
      <textarea id="area"></textarea>
      <div id="rich" contenteditable="true"><b id="bold">x</b></div>
      <div class="xterm"><span id="term">$</span></div>
    `);
    const at = (id: string) => ({ defaultPrevented: false, target: root.querySelector(`#${id}`) });
    expect(classifyContextTarget({ defaultPrevented: true, target: root.querySelector("#plain") }).kind).toBe("pass");
    expect(classifyContextTarget(at("term")).kind).toBe("pass");
    expect(classifyContextTarget(at("text")).kind).toBe("editable");
    expect(classifyContextTarget(at("area")).kind).toBe("editable");
    expect(classifyContextTarget(at("check")).kind).toBe("suppress");
    expect(classifyContextTarget(at("plain")).kind).toBe("suppress");

    const range = document.createRange();
    range.setStart(root.querySelector("#plain")!.firstChild!, 0);
    range.setEnd(root.querySelector("#plain")!.firstChild!, 5);
    window.getSelection()!.addRange(range);
    expect(classifyContextTarget(at("plain"))).toEqual({ kind: "selection", text: "plain" });
  });

  it("只读输入框不能剪切粘贴，密码框不能复制", () => {
    const root = host(`<input id="ro" readonly value="abc" /><input id="pw" type="password" value="secret" />`);
    const actions = { cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn() };
    const ro = root.querySelector<HTMLInputElement>("#ro")!;
    ro.setSelectionRange(0, 2);
    const roEntries = editableEntries(ro, actions);
    const reason = (entries: typeof roEntries, id: string) => entries.find((entry) => "id" in entry && entry.id === id) as { disabledReason?: string };
    expect(reason(roEntries, "cut").disabledReason).toBeTruthy();
    expect(reason(roEntries, "paste").disabledReason).toBeTruthy();
    expect(reason(roEntries, "copy").disabledReason).toBeUndefined();
    const pw = root.querySelector<HTMLInputElement>("#pw")!;
    pw.setSelectionRange(0, 3);
    expect(reason(editableEntries(pw, actions), "copy").disabledReason).toBe("密码不能复制");
  });

  it("粘贴写回打开菜单时记下的选区位置", async () => {
    const root = host(`<input id="field" value="hello world" />`);
    const field = root.querySelector<HTMLInputElement>("#field")!;
    field.focus();
    field.setSelectionRange(6, 11);
    const saved = saveSelection(field);
    field.setSelectionRange(0, 0);
    const readText = vi.fn(async () => "there");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText, writeText: vi.fn(async () => {}) } });
    const onInput = vi.fn();
    field.addEventListener("input", onInput);
    editActions(field, saved).paste();
    await waitFor(() => expect(field.value).toBe("hello there"));
    expect(onInput).toHaveBeenCalled();
  });
});

describe("AppContextMenu 全局兜底", () => {
  it("空白处右键阻止原生菜单且不弹应用菜单", async () => {
    render(AppContextMenu);
    const root = host(`<div id="plain">plain</div>`);
    const event = rightClick(root.querySelector("#plain")!);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("组件自己的右键菜单优先：已 preventDefault 或 stopPropagation 时不弹兜底菜单", async () => {
    render(AppContextMenu);
    const root = host(`<button id="own">own</button><button id="stop">stop</button><input id="custom" />`);
    root.querySelector("#own")!.addEventListener("contextmenu", (event) => event.preventDefault());
    root.querySelector("#stop")!.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    root.querySelector("#custom")!.addEventListener("contextmenu", (event) => event.preventDefault());
    expect(rightClick(root.querySelector("#own")!).defaultPrevented).toBe(true);
    rightClick(root.querySelector("#stop")!);
    rightClick(root.querySelector("#custom")!);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("终端里不处理也不拦截，由终端自己决定", () => {
    render(AppContextMenu);
    const root = host(`<div data-terminal-pane="1"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div></div>`);
    const event = rightClick(root.querySelector("textarea")!);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("输入框右键弹出应用自己的 剪切/复制/粘贴/全选", async () => {
    render(AppContextMenu);
    const root = host(`<input id="field" value="hello" />`);
    const field = root.querySelector<HTMLInputElement>("#field")!;
    field.focus();
    field.setSelectionRange(0, 0);
    const event = rightClick(field);
    expect(event.defaultPrevented).toBe(true);
    const menu = await screen.findByRole("menu", { name: "编辑菜单" });
    expect(menu.textContent).toContain("剪切");
    expect(menu.textContent).toContain("粘贴");
    await fireEvent.click(screen.getByRole("menuitem", { name: /全选/ }));
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5]);
  });

  it("有选中文字时右键提供复制", async () => {
    render(AppContextMenu);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const root = host(`<p id="para">copy me please</p>`);
    const text = root.querySelector("#para")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 7);
    window.getSelection()!.addRange(range);
    const event = rightClick(root.querySelector("#para")!);
    expect(event.defaultPrevented).toBe(true);
    await screen.findByRole("menu", { name: "文本菜单" });
    await fireEvent.click(screen.getByRole("menuitem", { name: /复制/ }));
    expect(writeText).toHaveBeenCalledWith("copy me");
  });
});
