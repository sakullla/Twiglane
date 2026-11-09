/**
 * ⌘/Ctrl A 的兜底：桌面应用里浏览器原生的「全选」会把标题栏、侧栏、按钮文字和所有面板一起选中，
 * 复制出来是一堆界面文案，没有用处。这里把它收窄到焦点所在的阅读区域。
 *
 * - 焦点在输入框、文本域或可编辑区域里：不拦，交给原生全选（只选输入框内容）；
 * - 组件自己处理过（defaultPrevented，例如文件列表的多选、文件查看的整份内容）：不再处理；
 * - 焦点落在带 `data-select-scope` 的区域（或其内部）：只选这个区域的内容；
 * - 其他位置：拦下，什么也不选。
 */
export const SELECT_SCOPE_ATTR = "data-select-scope";

export function isSelectAllKey(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a";
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

/** 处理了（选中了一个区域，或拦下了外溢的全选）时返回 true。 */
export function scopedSelectAll(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || !isSelectAllKey(event)) return false;
  if (isEditable(event.target)) return false;
  event.preventDefault();
  const origin = event.target instanceof Element ? event.target : null;
  const scope = origin?.closest<HTMLElement>(`[${SELECT_SCOPE_ATTR}]`) ?? null;
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (scope) selection?.selectAllChildren(scope);
  return true;
}
