/**
 * 全局右键兜底：应用内不出现 WebView 原生菜单（查询、翻译、重新载入、共享……）。
 *
 * 在 window 的冒泡阶段处理 contextmenu，所以组件自己的 oncontextmenu 总是先执行：
 * - 组件已经 preventDefault（自定义菜单、终端）→ 什么也不做；
 * - 终端（.xterm）里的右键交给终端自己；
 * - 可编辑的输入框 / 文本框 / contenteditable → 应用自己的 剪切 / 复制 / 粘贴 / 全选 菜单；
 * - 有选中文字 → 应用自己的 复制 菜单；
 * - 其它地方 → 只阻止原生菜单。
 */
import { MODIFIER_LABEL } from "./brand";
import type { ContextMenuEntry } from "./components/ContextMenu.svelte";

export type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export type ContextTarget =
  | { kind: "pass" }
  | { kind: "suppress" }
  | { kind: "editable"; element: EditableElement }
  | { kind: "selection"; text: string };

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "tel", "email", "password", "number"]);

function elementOf(target: EventTarget | null): Element | null {
  if (!target) return null;
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

/** 能输入文字的控件；checkbox、按钮之类的 input 不算。 */
export function editableElement(target: EventTarget | null): EditableElement | null {
  const element = elementOf(target);
  if (!element) return null;
  if (element instanceof HTMLTextAreaElement) return element;
  if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type) ? element : null;
  const editable = element.closest<HTMLElement>("[contenteditable]:not([contenteditable='false'])");
  if (editable && editable.isContentEditable) return editable;
  return null;
}

export function classifyContextTarget(event: Pick<MouseEvent, "defaultPrevented" | "target">, doc: Document = document): ContextTarget {
  if (event.defaultPrevented) return { kind: "pass" };
  const element = elementOf(event.target);
  if (element?.closest(".xterm, [data-terminal-pane]")) return { kind: "pass" };
  const editable = editableElement(event.target);
  if (editable) return { kind: "editable", element: editable };
  const selection = doc.getSelection?.();
  const text = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.toString() : "";
  if (text.trim()) return { kind: "selection", text };
  return { kind: "suppress" };
}

export interface EditActions {
  cut: () => void;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
}

function isTextControl(element: EditableElement): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

/** 控件里当前有没有选中的文字；contenteditable 看文档选区。 */
export function hasEditableSelection(element: EditableElement, doc: Document = document): boolean {
  if (isTextControl(element)) {
    try {
      return (element.selectionStart ?? 0) !== (element.selectionEnd ?? 0);
    } catch {
      return false; // number 等类型不支持 selectionStart
    }
  }
  const selection = doc.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.anchorNode && element.contains(selection.anchorNode));
}

function readOnly(element: EditableElement): boolean {
  if (isTextControl(element)) return element.readOnly || element.disabled;
  return !element.isContentEditable;
}

export function editableEntries(element: EditableElement, actions: EditActions, doc: Document = document): ContextMenuEntry[] {
  const selected = hasEditableSelection(element, doc);
  const secret = element instanceof HTMLInputElement && element.type === "password";
  const noSelection = selected ? undefined : "没有选中的文本";
  const locked = readOnly(element) ? "这里不能修改" : undefined;
  const hidden = secret ? "密码不能复制" : undefined;
  return [
    { id: "cut", label: "剪切", icon: "scissors", shortcut: `${MODIFIER_LABEL} X`, disabledReason: locked ?? hidden ?? noSelection, run: actions.cut },
    { id: "copy", label: "复制", icon: "copy", shortcut: `${MODIFIER_LABEL} C`, disabledReason: hidden ?? noSelection, run: actions.copy },
    { id: "paste", label: "粘贴", icon: "clipboard", shortcut: `${MODIFIER_LABEL} V`, disabledReason: locked, run: actions.paste },
    { separator: true },
    { id: "select-all", label: "全选", icon: "select-all", shortcut: `${MODIFIER_LABEL} A`, run: actions.selectAll },
  ];
}

export function selectionEntries(copy: () => void): ContextMenuEntry[] {
  return [{ id: "copy", label: "复制", icon: "copy", shortcut: `${MODIFIER_LABEL} C`, run: copy }];
}

/** 打开菜单时记下控件选区：点菜单项会挪走焦点，执行前要把选区还回去。 */
export interface SavedSelection {
  start: number;
  end: number;
  range: Range | null;
}

export function saveSelection(element: EditableElement, doc: Document = document): SavedSelection {
  if (isTextControl(element)) {
    try {
      return { start: element.selectionStart ?? 0, end: element.selectionEnd ?? 0, range: null };
    } catch {
      return { start: 0, end: 0, range: null };
    }
  }
  const selection = doc.getSelection?.();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
  return { start: 0, end: 0, range };
}

export function restoreSelection(element: EditableElement, saved: SavedSelection, doc: Document = document): void {
  element.focus({ preventScroll: true });
  if (isTextControl(element)) {
    try {
      element.setSelectionRange(saved.start, saved.end);
    } catch {
      /* number 等类型不支持设置选区 */
    }
    return;
  }
  if (saved.range) {
    const selection = doc.getSelection?.();
    selection?.removeAllRanges();
    selection?.addRange(saved.range);
  }
}

function selectedValue(element: EditableElement, saved: SavedSelection): string {
  if (isTextControl(element)) return element.value.slice(saved.start, saved.end);
  return saved.range?.toString() ?? "";
}

function execCommand(doc: Document, command: string, value?: string): boolean {
  try {
    return typeof doc.execCommand === "function" && doc.execCommand(command, false, value);
  } catch {
    return false;
  }
}

/** 在控件里插入文字：优先 execCommand（保留撤销栈），不支持时用 setRangeText 并补发 input。 */
export function insertText(element: EditableElement, text: string, doc: Document = document): void {
  if (execCommand(doc, "insertText", text)) return;
  if (isTextControl(element)) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    element.setRangeText(text, start, end, "end");
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* 剪贴板被拒绝：快捷键仍然可用 */
  }
}

/** 一个可编辑控件的四个动作；opened 时刻的选区由 saved 记住。 */
export function editActions(element: EditableElement, saved: SavedSelection, doc: Document = document): EditActions {
  return {
    copy: () => {
      restoreSelection(element, saved, doc);
      if (!execCommand(doc, "copy")) void writeClipboard(selectedValue(element, saved));
    },
    cut: () => {
      restoreSelection(element, saved, doc);
      if (execCommand(doc, "cut")) return;
      const text = selectedValue(element, saved);
      void writeClipboard(text).then(() => insertText(element, "", doc));
    },
    paste: () => {
      restoreSelection(element, saved, doc);
      void (async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) insertText(element, text, doc);
        } catch {
          /* 剪贴板被拒绝：⌘/Ctrl V 仍可用 */
        }
      })();
    },
    selectAll: () => {
      element.focus({ preventScroll: true });
      if (isTextControl(element)) {
        element.select();
        return;
      }
      const selection = doc.getSelection?.();
      const range = doc.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
  };
}

export async function copyText(text: string): Promise<void> {
  await writeClipboard(text);
}
