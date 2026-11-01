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

/**
 * 返回命令 id；不是注册表里的组合键时返回 null。
 *
 * - ⌘/Ctrl 起手；Alt 一律不认，避免和输入法的组合键抢键。
 * - Shift 只放行 ⌘⇧Enter（部分键盘布局里回车需要 Shift），其余一律不匹配，
 *   这样 ⌘⇧K 不会被当成 ⌘K。
 */
export function shortcutCommand(event: KeyLike): string | null {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey && key !== "enter") return null;
  const digit = DIGIT_VIEWS[event.key];
  if (digit) return digit;
  return KEY_COMMANDS[key] ?? null;
}
