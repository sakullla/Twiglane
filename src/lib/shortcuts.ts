/**
 * 键盘层：把一次按键翻译成注册表里的命令 id。
 *
 * 只做「按键 → id」的映射，不判断命令是否可用、也不执行；
 * 可用性由 commands.ts 提供，执行由外壳的 runCommand 负责。
 * Escape 不在这里：它属于「关掉最上面那一层」，由命令面板、modal 与外壳各管自己那一层。
 */
export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

const DIGIT_VIEWS: Record<string, string> = {
  "1": "view.changes",
  "2": "view.history",
};

const KEY_COMMANDS: Record<string, string> = {
  k: "palette.open",
  b: "rail.toggle",
  r: "view.refresh",
  enter: "commit.local",
};

const FILE_COMMANDS: Record<string, string> = {
  ArrowLeft: "file.prev",
  ArrowRight: "file.next",
};

/** 文字输入控件：Alt+←/→ 在这里按单词移动光标，也不能拿 Esc 去清多选。差异区是只读 textbox，不算。 */
export function isTextEntry(target: EventTarget | null): boolean {
  const element = target as Partial<HTMLElement> | null;
  return element?.tagName === "INPUT" || element?.tagName === "TEXTAREA" || element?.tagName === "SELECT" || element?.isContentEditable === true;
}

/**
 * 返回命令 id；不是注册表里的组合键时返回 null。
 *
 * - 单独的 Alt+←/→ 切换上一个、下一个文件；是否让位给输入框由外壳按焦点判断。
 * - 其余都是 ⌘/Ctrl 起手；此时 Alt 一律不认，避免和输入法的组合键抢键。
 * - Shift 只放行 ⌘⇧Enter（部分键盘布局里回车需要 Shift），其余一律不匹配，
 *   这样 ⌘⇧K 不会被当成 ⌘K。
 */
export function shortcutCommand(event: KeyLike): string | null {
  const mod = event.metaKey || event.ctrlKey;
  if (event.altKey && !mod && !event.shiftKey) return FILE_COMMANDS[event.key] ?? null;
  if (!mod || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey && key !== "enter") return null;
  const digit = DIGIT_VIEWS[event.key];
  if (digit) return digit;
  return KEY_COMMANDS[key] ?? null;
}
