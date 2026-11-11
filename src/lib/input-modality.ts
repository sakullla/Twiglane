/**
 * 最近一次输入是指针还是键盘，写到 <html data-input>。
 *
 * 文件列表、差异区、历史列表、文件树这类「整块可聚焦的滚动容器」在点选行之后会被程序聚焦，
 * 浏览器按启发式仍会给它们套上 :focus-visible，于是鼠标用户每点一下就看到一整圈焦点框。
 * 样式层据此在指针模式下收掉容器级焦点环（选中行本身已经标出位置），
 * 一按导航键立刻切回 keyboard，焦点环随之出现，键盘可见性不受影响。
 */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph", "Fn"]);

export type InputModality = "pointer" | "keyboard";

export function modalityForKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">): InputModality | null {
  // 只按修饰键、或 Ctrl/⌘ 组合（复制、保存、命令面板）不是在用键盘移动焦点，不切换。
  if (MODIFIERS.has(event.key) || event.ctrlKey || event.metaKey) return null;
  return "keyboard";
}

export function trackInputModality(root: HTMLElement = document.documentElement): () => void {
  const set = (mode: InputModality) => {
    if (root.dataset.input !== mode) root.dataset.input = mode;
  };
  const onPointer = () => set("pointer");
  const onKey = (event: KeyboardEvent) => {
    const mode = modalityForKey(event);
    if (mode) set(mode);
  };
  window.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
  window.addEventListener("keydown", onKey, { capture: true, passive: true });
  return () => {
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("keydown", onKey, true);
  };
}
