/**
 * 终端的纯逻辑：事件判定、状态文字、按键归类、配色读取与标签页/分屏布局。
 * 不触碰 IPC 与 DOM 实例，TerminalPanel / TerminalPane 只负责把它们接到界面上。
 */
import type { TerminalExitEvent, TerminalOutputEvent } from "./types";

/** 后端事件名：与 src-tauri/src/terminal.rs 的常量一致。 */
export const TERMINAL_OUTPUT_EVENT = "terminal-output";
export const TERMINAL_EXIT_EVENT = "terminal-exit";
export const TERMINAL_CLOSE_REQUESTED_EVENT = "terminal-close-requested";

/** 与后端 MAX_SESSIONS_PER_REPO 一致；界面提前禁用新建，后端仍会拒绝超额请求。 */
export const MAX_TERMINALS_PER_REPO = 12;
/** 一个标签页里最多并排的终端数；再多每格太窄，命令输出会频繁折行。 */
export const MAX_PANES_PER_GROUP = 4;
/** 字号范围与缺省值：与 src-tauri/src/state.rs 的 TERMINAL_FONT_* 一致。 */
export const TERMINAL_FONT_MIN = 9;
export const TERMINAL_FONT_MAX = 24;
export const TERMINAL_FONT_DEFAULT = 13;

export function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_FONT_DEFAULT;
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(value)));
}

/**
 * 一个输出/退出事件是否应写入某个终端：只接受该终端的 sessionId，并丢弃快照已经覆盖的旧序号。
 * 这条判定同时挡掉「重启后旧会话的迟到事件」和「重放时重复写入」。
 */
export function terminalEventApplies(
  currentSession: string | null,
  eventSession: string,
  seq: number,
  lastSeq: number,
): boolean {
  return currentSession !== null && eventSession === currentSession && seq > lastSeq;
}

export interface TerminalStatus {
  starting: boolean;
  failed: boolean;
  sessionId: string | null;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
}

/** 一句话状态；退出码与信号都如实显示，启动失败不伪装成运行中的终端。 */
export function terminalStatusLabel(state: TerminalStatus): string {
  if (state.starting) return "正在启动…";
  if (state.failed) return "启动失败";
  if (!state.sessionId) return "未连接";
  if (state.running) return "运行中";
  if (state.signal) return `已退出 · ${state.signal}`;
  return `已退出 · 退出码 ${state.exitCode ?? "未知"}`;
}

export type TerminalStateName = "starting" | "failed" | "idle" | "running" | "exited";

export function terminalStateName(state: TerminalStatus): TerminalStateName {
  if (state.failed) return "failed";
  if (state.starting) return "starting";
  if (!state.sessionId) return "idle";
  return state.running ? "running" : "exited";
}

/**
 * Windows 上 ConPTY/clink 会把终端对 DA 查询的回复当作键盘输入插入命令行，
 * 出现 `[?1;2c` 之类字面文本并污染后续命令。写入 PTY 前丢弃 DA1/DA2 回复；
 * DSR、方向键等其它序列保持原样。
 */
export function stripWindowsTerminalReplies(data: string): string {
  return data.replace(/\x1b\[[?>][0-9;]*c/g, "");
}

/* ---------------------------------------------------------------- 按键 */

export type TerminalKeyAction =
  | "copy"
  | "paste"
  | "find"
  | "toggle"
  | "new"
  | "split"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "prev-tab"
  | "next-tab";

export interface TerminalKey {
  type?: string;
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * 终端获得焦点时由界面接管的组合键；其余按键原样交给 shell。
 * - 复制：⌘C（macOS）、Ctrl+Shift+C；Windows/Linux 的 Ctrl+C 只在有选区时复制，否则仍是中断信号。
 * - 粘贴：⌘V、Ctrl+V、Ctrl+Shift+V 交给浏览器的原生粘贴事件，由 xterm 处理括号粘贴。
 * - 查找、开关/新建/拆分、字号缩放与切换标签页沿用常见集成终端的键位。
 */
export function terminalKeyAction(event: TerminalKey, mac: boolean, hasSelection: boolean): TerminalKeyAction | null {
  if (event.altKey) return null;
  const primary = mac ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
  const key = event.key.toLowerCase();
  const code = event.code ?? "";
  if (code === "Backquote" && (event.ctrlKey || event.metaKey)) return event.shiftKey ? "new" : "toggle";
  if (mac && event.metaKey && !event.ctrlKey) {
    if (key === "c" && !event.shiftKey) return hasSelection ? "copy" : null;
    if (key === "v" && !event.shiftKey) return "paste";
  }
  if (!mac && event.ctrlKey && !event.metaKey) {
    if (key === "c") return event.shiftKey || hasSelection ? "copy" : null;
    if (key === "v") return "paste";
  }
  if (!primary) return null;
  if (event.shiftKey && (code === "Digit5" || key === "%")) return "split";
  if (event.shiftKey) return null;
  if (key === "f") return "find";
  if (key === "=" || key === "+") return "zoom-in";
  if (key === "-") return "zoom-out";
  if (key === "0") return "zoom-reset";
  if (key === "pageup") return "prev-tab";
  if (key === "pagedown") return "next-tab";
  return null;
}

/* ---------------------------------------------------------------- 配色 */

/** xterm 主题键 → tokens.css 里的终端令牌。配色只在 tokens.css 声明一份。 */
export const TERMINAL_THEME_TOKENS = {
  background: "--term-bg",
  foreground: "--term-fg",
  cursor: "--term-cursor",
  cursorAccent: "--term-cursor-accent",
  selectionBackground: "--term-selection",
  selectionInactiveBackground: "--term-selection-inactive",
  scrollbarSliderBackground: "--term-scroll-thumb",
  scrollbarSliderHoverBackground: "--term-scroll-thumb-hover",
  scrollbarSliderActiveBackground: "--term-scroll-thumb-hover",
  black: "--term-black",
  red: "--term-red",
  green: "--term-green",
  yellow: "--term-yellow",
  blue: "--term-blue",
  magenta: "--term-magenta",
  cyan: "--term-cyan",
  white: "--term-white",
  brightBlack: "--term-bright-black",
  brightRed: "--term-bright-red",
  brightGreen: "--term-bright-green",
  brightYellow: "--term-bright-yellow",
  brightBlue: "--term-bright-blue",
  brightMagenta: "--term-bright-magenta",
  brightCyan: "--term-bright-cyan",
  brightWhite: "--term-bright-white",
} as const;

export type TerminalTheme = Partial<Record<keyof typeof TERMINAL_THEME_TOKENS, string>>;

/** 按当前主题读取终端令牌；读不到的键不写入，交给 xterm 自己的缺省值。 */
export function readTerminalTheme(read: (token: string) => string): TerminalTheme {
  const theme: TerminalTheme = {};
  for (const [key, token] of Object.entries(TERMINAL_THEME_TOKENS) as [keyof typeof TERMINAL_THEME_TOKENS, string][]) {
    const value = read(token).trim();
    if (value) theme[key] = value;
  }
  return theme;
}

/* ---------------------------------------------------------------- 查找 */

export interface TerminalFindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** 查找结果：`index` 从 0 开始，-1 表示有匹配但还没定位到当前项（或超出加亮上限）。 */
export interface TerminalFindResult {
  index: number;
  count: number;
}

/** 搜索插件最多加亮的匹配数；超过时 xterm 给出的计数就是上限本身。 */
export const TERMINAL_FIND_LIMIT = 1000;

/** 正则模式下的查询能否编译；不能时不交给 xterm，直接在查找条里说明。 */
export function terminalFindProblem(query: string, options: Pick<TerminalFindOptions, "regex">): string | null {
  if (!options.regex || !query) return null;
  try {
    new RegExp(query);
    return null;
  } catch {
    return "正则无效";
  }
}

/** 查找条右侧的计数：「3/12」「无结果」「1000+ 处」；还没查或没有计数时返回空串。 */
export function terminalFindSummary(query: string, result: TerminalFindResult | null, miss: boolean): string {
  if (!query) return "";
  if (miss || (result && result.count === 0)) return "无结果";
  if (!result) return "";
  if (result.count >= TERMINAL_FIND_LIMIT) {
    return result.index >= 0 ? `${result.index + 1}/${TERMINAL_FIND_LIMIT}+` : `${TERMINAL_FIND_LIMIT}+ 处`;
  }
  return result.index >= 0 ? `${result.index + 1}/${result.count}` : `${result.count} 处`;
}

/** 匹配加亮的颜色（xterm 要求 #RRGGBB），随主题令牌变化；读不到时用中性的黄色系。 */
export function terminalFindDecorations(read: (token: string) => string) {
  const pick = (token: string, fallback: string) => {
    const value = read(token).trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  };
  const match = pick("--term-find-match", "#5a4a1f");
  const active = pick("--term-find-active", "#e8c072");
  return {
    matchBackground: match,
    matchBorder: match,
    matchOverviewRuler: match,
    activeMatchBackground: pick("--term-find-active-bg", match),
    activeMatchBorder: active,
    activeMatchColorOverviewRuler: active,
  };
}

/* ---------------------------------------------------------------- 布局 */

/** 一个标签页：并排的若干终端会话。`name` 是使用者改过的名字，null 时按终端类型显示。 */
export interface TerminalGroup {
  id: string;
  panes: string[];
  name: string | null;
  /** 标签页里最后聚焦的终端；切回这个标签页时焦点回到它。 */
  last?: string | null;
}

export interface TerminalLayout {
  groups: TerminalGroup[];
  activeGroup: string | null;
  focused: string | null;
}

let groupSerial = 0;
function nextGroupId(): string {
  groupSerial += 1;
  return `terminal-group-${groupSerial}`;
}

export function emptyLayout(): TerminalLayout {
  return { groups: [], activeGroup: null, focused: null };
}

export function sessionCount(layout: TerminalLayout): number {
  return layout.groups.reduce((total, group) => total + group.panes.length, 0);
}

export function groupOf(layout: TerminalLayout, sessionId: string): TerminalGroup | null {
  return layout.groups.find((group) => group.panes.includes(sessionId)) ?? null;
}

/** 追加一个标签页并切过去。 */
export function addGroup(layout: TerminalLayout, sessionId: string): TerminalLayout {
  const group: TerminalGroup = { id: nextGroupId(), panes: [sessionId], name: null, last: sessionId };
  return { groups: [...layout.groups, group], activeGroup: group.id, focused: sessionId };
}

/** 在标签页里、当前聚焦终端的右侧并排一个新终端；标签页不存在时退化为新建标签页。 */
export function splitGroup(layout: TerminalLayout, groupId: string | null, sessionId: string): TerminalLayout {
  const target = layout.groups.find((group) => group.id === groupId);
  if (!target || target.panes.length >= MAX_PANES_PER_GROUP) return addGroup(layout, sessionId);
  const anchor = layout.focused && target.panes.includes(layout.focused) ? target.panes.indexOf(layout.focused) : target.panes.length - 1;
  const panes = [...target.panes.slice(0, anchor + 1), sessionId, ...target.panes.slice(anchor + 1)];
  return {
    groups: layout.groups.map((group) => (group.id === target.id ? { ...group, panes, last: sessionId } : group)),
    activeGroup: target.id,
    focused: sessionId,
  };
}

/**
 * 移除一个终端。标签页空了就一起移除；焦点优先留在同一标签页的相邻终端，
 * 否则落到右侧（没有则左侧）的标签页，和常见编辑器关标签的方向一致。
 */
export function removeSession(layout: TerminalLayout, sessionId: string): TerminalLayout {
  const index = layout.groups.findIndex((group) => group.panes.includes(sessionId));
  if (index < 0) return layout;
  const group = layout.groups[index];
  const paneIndex = group.panes.indexOf(sessionId);
  const panes = group.panes.filter((pane) => pane !== sessionId);
  if (panes.length > 0) {
    const groups = layout.groups.map((item) => (item.id === group.id ? { ...item, panes } : item));
    const focused = layout.focused === sessionId ? panes[Math.min(paneIndex, panes.length - 1)] : layout.focused;
    return { groups, activeGroup: layout.activeGroup, focused };
  }
  const groups = layout.groups.filter((item) => item.id !== group.id);
  if (layout.activeGroup !== group.id) {
    return { groups, activeGroup: layout.activeGroup, focused: layout.focused === sessionId ? null : layout.focused };
  }
  const next = groups[Math.min(index, groups.length - 1)] ?? null;
  return { groups, activeGroup: next?.id ?? null, focused: next?.panes[0] ?? null };
}

/** 重启后新会话接替旧会话的位置与焦点。 */
export function replaceSession(layout: TerminalLayout, oldId: string, newId: string): TerminalLayout {
  return {
    groups: layout.groups.map((group) => ({
      ...group,
      panes: group.panes.map((pane) => (pane === oldId ? newId : pane)),
      last: group.last === oldId ? newId : group.last,
    })),
    activeGroup: layout.activeGroup,
    focused: layout.focused === oldId ? newId : layout.focused,
  };
}

export function selectGroup(layout: TerminalLayout, groupId: string): TerminalLayout {
  const group = layout.groups.find((item) => item.id === groupId);
  if (!group) return layout;
  const remembered = group.last && group.panes.includes(group.last) ? group.last : null;
  const focused = layout.focused && group.panes.includes(layout.focused) ? layout.focused : (remembered ?? group.panes[0]);
  return { ...layout, activeGroup: group.id, focused };
}

/** 相对切换标签页（循环）。 */
export function cycleGroup(layout: TerminalLayout, delta: number): TerminalLayout {
  if (layout.groups.length < 2) return layout;
  const index = Math.max(0, layout.groups.findIndex((group) => group.id === layout.activeGroup));
  const next = layout.groups[(index + delta + layout.groups.length) % layout.groups.length];
  return selectGroup(layout, next.id);
}

export function focusSession(layout: TerminalLayout, sessionId: string): TerminalLayout {
  const group = groupOf(layout, sessionId);
  if (!group) return layout;
  if (layout.focused === sessionId && layout.activeGroup === group.id && group.last === sessionId) return layout;
  return {
    groups: layout.groups.map((item) => (item.id === group.id ? { ...item, last: sessionId } : item)),
    activeGroup: group.id,
    focused: sessionId,
  };
}

export function renameGroup(layout: TerminalLayout, groupId: string, name: string): TerminalLayout {
  const trimmed = name.trim().slice(0, 40);
  return {
    ...layout,
    groups: layout.groups.map((group) => (group.id === groupId ? { ...group, name: trimmed || null } : group)),
  };
}

/** 后端已有会话（按创建顺序）各占一个标签页；用于重新附着仓库时恢复。 */
export function layoutFromSessions(sessionIds: string[]): TerminalLayout {
  let layout = emptyLayout();
  for (const id of sessionIds) layout = addGroup(layout, id);
  if (layout.groups.length > 0) layout = selectGroup(layout, layout.groups[0].id);
  return layout;
}

/**
 * 标签页标题：改过名用名字；否则用各终端的类型名，并排时用「·」连起来。
 * 同名标签页按出现顺序补序号（PowerShell、PowerShell 2），一眼能区分。
 */
export function groupTitles(layout: TerminalLayout, labelOf: (sessionId: string) => string): Map<string, string> {
  const titles = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const group of layout.groups) {
    const base = group.name ?? group.panes.map(labelOf).join(" · ");
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    titles.set(group.id, count > 1 && !group.name ? `${base} ${count}` : base);
  }
  return titles;
}

/** shell 路径 → 显示名，后端没有提供 label 时使用。 */
export function shellLabel(shell: string): string {
  const name = shell.split(/[\\/]/).filter(Boolean).pop() ?? shell;
  return name.replace(/\.exe$/i, "") || "终端";
}

/* ---------------------------------------------------------------- 事件路由 */

export interface TerminalListeners {
  output: (event: TerminalOutputEvent) => void;
  exit: (event: TerminalExitEvent) => void;
}

type Listen = <T>(name: string, handler: (payload: T) => void) => Promise<() => void>;

/**
 * 全局只订阅一次后端事件，再按 sessionId 分发给对应终端：N 个终端不会各自收到并过滤全部输出。
 */
export class TerminalRouter {
  private readonly targets = new Map<string, TerminalListeners>();
  private ready: Promise<void> | null = null;
  private stops: (() => void)[] = [];
  private disposed = false;

  constructor(private readonly listen: Listen) {}

  /** 订阅成功后才 resolve；失败时下次调用会重试。 */
  start(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          const stopOutput = await this.listen<TerminalOutputEvent>(TERMINAL_OUTPUT_EVENT, (event) =>
            this.targets.get(event.sessionId)?.output(event),
          );
          const stopExit = await this.listen<TerminalExitEvent>(TERMINAL_EXIT_EVENT, (event) =>
            this.targets.get(event.sessionId)?.exit(event),
          );
          if (this.disposed) {
            stopOutput();
            stopExit();
            return;
          }
          this.stops.push(stopOutput, stopExit);
        } catch (error) {
          this.ready = null;
          throw error;
        }
      })();
    }
    return this.ready;
  }

  subscribe(sessionId: string, listeners: TerminalListeners): () => void {
    this.targets.set(sessionId, listeners);
    return () => {
      if (this.targets.get(sessionId) === listeners) this.targets.delete(sessionId);
    };
  }

  dispose() {
    this.disposed = true;
    this.stops.forEach((stop) => stop());
    this.stops = [];
    this.targets.clear();
  }
}

/* ---------------------------------------------------------------- 拖入路径 */

const WINDOWS_DRIVE = /^([A-Za-z]):[\\/](.*)$/;

/** 按终端类型把一个路径写成可直接粘到命令行的参数：需要时加引号，Git Bash / WSL 换成各自的路径写法。 */
export function quotePathForShell(path: string, profile: string): string {
  const id = profile.toLowerCase();
  if (id === "cmd") {
    // cmd 的参数只认双引号；路径里不会出现双引号（Windows 文件名不允许）。
    return /^[\w@%+=:,.\\/-]+$/.test(path) && !path.includes("%") ? path : `"${path}"`;
  }
  if (id === "pwsh" || id === "powershell") {
    if (/^[\w@+=:,.\\/-]+$/.test(path)) return path;
    // 单引号里不展开变量；单引号本身写成两个单引号。
    return `'${path.replace(/'/g, "''")}'`;
  }
  let posix = path;
  const drive = WINDOWS_DRIVE.exec(path);
  if (drive && (id === "git-bash" || id === "wsl")) {
    const rest = drive[2].replace(/\\/g, "/");
    const letter = drive[1].toLowerCase();
    posix = id === "wsl" ? `/mnt/${letter}/${rest}` : `/${letter}/${rest}`;
  }
  if (/^[\w@%+=:,./-]+$/.test(posix)) return posix;
  if (id === "fish") return `'${posix.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  // POSIX shell：单引号里一切按字面，单引号本身写成 '\''。
  return `'${posix.replace(/'/g, "'\\''")}'`;
}

/** 多个路径用空格连接，末尾补一个空格，方便接着输入。 */
export function formatDroppedPaths(paths: string[], profile: string): string {
  const parts = paths.filter((path) => path.length > 0).map((path) => quotePathForShell(path, profile));
  return parts.length > 0 ? `${parts.join(" ")} ` : "";
}
