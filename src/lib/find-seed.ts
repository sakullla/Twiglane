/**
 * ⌘/Ctrl+F 的查找词带入：和 VS Code 一样，打开查找时用当前选中的文字作为查找词。
 *
 * - 只带入单行选区；跨行选区不带入（保留查找框原有内容）。
 * - 三击整行时选区末尾常带一个换行，这一个换行忽略后仍按单行处理。
 * - 空白选区、超长选区不带入。
 *
 * 所有「在文件中查找」与筛选框的快捷键都走这里，保证各处行为一致。
 */

export const MAX_FIND_SEED = 200;

/** 选中文字 → 查找词；不该带入时返回 null。 */
export function findSeed(text: string | null | undefined): string | null {
  if (!text) return null;
  const single = text.replace(/\r?\n$/, "");
  if (/[\r\n]/.test(single)) return null;
  if (!single.trim()) return null;
  if (single.length > MAX_FIND_SEED) return null;
  return single;
}

function isTextControl(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  if (!element) return false;
  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName !== "INPUT") return false;
  const type = (element as HTMLInputElement).type;
  return type === "text" || type === "search" || type === "" || type === "url";
}

/**
 * 当前选中的文字。传入 root 时只认落在 root 里的选区（避免把别处残留的选区带进来）。
 * 焦点在输入框或文本框里时，读它自己的选区（document 选区读不到控件内的文字）。
 * `exclude` 是查找框本身：焦点已在查找框里时不再拿它的选区去覆盖它。
 */
export function selectedText(root: Node | null = null, exclude: Element | null = null, doc: Document = document): string {
  const active = doc.activeElement;
  if (isTextControl(active) && active !== exclude && (!root || root.contains(active))) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    if (end > start) return active.value.slice(start, end);
  }
  const selection = doc.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return "";
  if (root) {
    const { anchorNode, focusNode } = selection;
    if (!anchorNode || !focusNode || !root.contains(anchorNode) || !root.contains(focusNode)) return "";
  }
  if (exclude && selection.anchorNode && exclude.contains(selection.anchorNode)) return "";
  return selection.toString();
}

function lineOf(node: Node, attribute: string): number | null {
  const element = node instanceof Element ? node : node.parentElement;
  const row = element?.closest(`[${attribute}]`);
  const value = Number(row?.getAttribute(attribute));
  return row && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 选区起止所在元素上 `data-*` 行号（如 data-file-line）。虚拟列表的每一行是绝对定位的块，
 * Selection.toString 在不同宿主里不一定插入换行，所以跨行要按行号判断。读不到时为 null。
 */
export function selectionLines(attribute: string, doc: Document = document): { start: number; end: number } | null {
  const selection = doc.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const start = lineOf(range.startContainer, attribute);
  const end = lineOf(range.endContainer, attribute);
  if (start === null || end === null) return null;
  return { start, end };
}

/** 选区起点所在行号，读不到时为 null。 */
export function selectionLine(attribute: string, doc: Document = document): number | null {
  return selectionLines(attribute, doc)?.start ?? null;
}

/**
 * 把查找词写进一个 bind:value 的输入框：改 value 后派发 input 事件，让 Svelte 绑定与 oninput 都收到；
 * 最后全选查找框文字，接着打字就是替换。seed 为 null 时只全选原有内容。
 */
export function seedInput(input: HTMLInputElement | HTMLTextAreaElement | null, seed: string | null): void {
  if (!input) return;
  if (seed !== null && input.value !== seed) {
    input.value = seed;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  input.select();
}

/** 聚焦一个查找/筛选入口；是文字输入框时带入查找词并全选（按钮等其它入口只聚焦）。 */
export function focusFindTarget(target: HTMLElement | null | undefined, seed: string | null): void {
  if (!target) return;
  target.focus();
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) seedInput(target, seed);
}

/** 按行号从近到远挑匹配：第一处行号不早于 line 的匹配；都在前面时回到第一处。 */
export function matchIndexFromLine(matches: readonly { line: number }[], line: number | null): number {
  if (matches.length === 0) return -1;
  if (line === null) return 0;
  const index = matches.findIndex((match) => match.line >= line);
  return index >= 0 ? index : 0;
}
