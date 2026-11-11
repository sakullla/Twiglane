/**
 * 键盘层：把一次按键翻译成注册表里的命令 id。
 *
 * 只做「按键 → id」的映射，不判断命令是否可用、也不执行；
 * 可用性由 commands.ts 提供，执行由外壳的 runCommand 负责。
 * Escape 不在这里：它属于「关掉最上面那一层」，由命令面板、modal 与外壳各管自己那一层。
 */
export interface KeyLike {
  key: string;
  /** 物理键位置（KeyboardEvent.code）：macOS ⌥+字母会产生组合字符，只有它稳定。 */
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** 数字键与左栏切换条同序：1 改动、2 历史、3 文件。 */
const DIGIT_VIEWS: Record<string, string> = {
  "1": "view.changes",
  "2": "view.history",
  "3": "view.files",
};

const KEY_COMMANDS: Record<string, string> = {
  k: "palette.open",
  b: "rail.toggle",
  r: "view.refresh",
  f: "view.find",
  p: "files.quickOpen",
  enter: "commit.local",
};

/**
 * ⌘/Ctrl+Shift 组合：文件视图的搜索与返回/前进。
 * 这些键位此前没有含义，因此不覆盖 Alt+←/→、Alt+↑/↓ 与 ⌘/Ctrl+F。
 */
const SHIFT_KEY_COMMANDS: Record<string, string> = {
  arrowleft: "file.back",
  arrowright: "file.forward",
};

const ALT_COMMANDS: Record<string, string> = {
  ArrowLeft: "file.prev",
  ArrowRight: "file.next",
  ArrowUp: "diff.hunk.prev",
  ArrowDown: "diff.hunk.next",
  /** Alt+M：标记/撤销当前文件的已审阅，和工具条按钮、命令面板是同一条命令。 */
  m: "review.toggle",
};

/**
 * Alt+Shift：只在未审阅文件之间走。没有占用已有的 Alt+←/→（按列表顺序切文件）与
 * ⌘/Ctrl+Shift+←/→（文件视图后退/前进），因此不会覆盖任何既有键位。
 */
const ALT_SHIFT_COMMANDS: Record<string, string> = {
  ArrowLeft: "review.prev",
  ArrowRight: "review.next",
};

/**
 * 文字输入控件：Alt+←/→ 在这里按单词移动光标，也不能拿 Esc 去清多选。差异区是只读 textbox，不算。
 * xterm 的输入目标是 `.xterm-helper-textarea`，但 IME 组合与粘贴期间事件目标可能落在终端容器里，
 * 所以整棵 `.xterm` 都算输入区：字符、方向键、Ctrl+C 与输入法都由终端处理，不落到背景快捷键。
 */
export function isTextEntry(target: EventTarget | null): boolean {
  const element = target as Partial<HTMLElement> | null;
  if (element?.tagName === "INPUT" || element?.tagName === "TEXTAREA" || element?.tagName === "SELECT" || element?.isContentEditable === true) {
    return true;
  }
  return element?.closest?.(".xterm") != null;
}

/**
 * Alt 组合键的名字候选：先看 key，再看物理键。
 *
 * macOS 的 ⌥ 是字符修饰键：⌥+M 的 event.key 是「µ」而不是「m」，只按字符匹配会让
 * 标记/撤销已审阅在 Mac 上悄悄失效。这里把 event.code 的 KeyX 还原成字母作为兜底；
 * 常规键盘布局下 key 仍然优先，Windows/Linux 与现有测试的行为不变。
 */
function altKeyNames(event: KeyLike): string[] {
  const names = [event.key];
  const code = event.code;
  if (code && code.length === 4 && code.startsWith("Key")) {
    const letter = code.slice(3).toLowerCase();
    if (letter !== event.key) names.push(letter);
  }
  return names;
}

function altCommand(map: Record<string, string>, event: KeyLike): string | null {
  for (const name of altKeyNames(event)) {
    const id = map[name];
    if (id) return id;
  }
  return null;
}

/**
 * 返回命令 id；不是注册表里的组合键时返回 null。
 *
 * - 单独的 Alt+←/→ 切换上一个、下一个文件，Alt+↑/↓ 跳到上一处、下一处改动；
 *   Alt+Shift+←/→ 只在未审阅文件之间走，Alt+M 标记/撤销当前文件的已审阅；
 *   是否让位给输入框由外壳按焦点判断。
 * - Alt+字母先按 key 再按物理键 event.code 匹配，macOS 的 ⌥ 组合字符不会让键位失效。
 * - 其余都是 ⌘/Ctrl 起手；此时 Alt 一律不认，避免和输入法的组合键抢键。
 * - Shift 只放行 ⌘⇧Enter（部分键盘布局里回车需要 Shift），其余一律不匹配，
 *   这样 ⌘⇧K 不会被当成 ⌘K。
 */
export function shortcutCommand(event: KeyLike): string | null {
  const mod = event.metaKey || event.ctrlKey;
  if (event.altKey && !mod && event.shiftKey) return altCommand(ALT_SHIFT_COMMANDS, event);
  if (event.altKey && !mod && !event.shiftKey) return altCommand(ALT_COMMANDS, event);
  if (!mod || event.altKey) return null;
  const key = event.key.toLowerCase();
  // ⌘⇧ 组合只认注册表里显式登记的几项，其余一律不匹配（⌘⇧K 仍然不是 ⌘K）。
  if (event.shiftKey && key !== "enter") return SHIFT_KEY_COMMANDS[key] ?? null;
  const digit = DIGIT_VIEWS[event.key];
  if (digit) return digit;
  return KEY_COMMANDS[key] ?? null;
}
