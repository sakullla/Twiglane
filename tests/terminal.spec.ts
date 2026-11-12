import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSnapshot } from "../src/lib/types";

/* ------------------------------------------------------------------ *
 * 终端回归：面板只消费结构化 IPC，会话按仓库保留，一个仓库可以有多个标签页与并排终端。
 * 每个终端挂载时先订阅事件再附着快照，旧序号与其它会话的事件必须丢弃。关窗确认在 App 外壳里，
 * 取消不终止进程，确认先等待 terminateTerminals 成功再关窗口，失败保留对话框与真实错误。
 * ------------------------------------------------------------------ */

const xtermMock = vi.hoisted(() => {
  const instances: FakeTerminalShape[] = [];
  interface FakeTerminalShape {
    options: Record<string, unknown>;
    writes: string[];
    rows: number;
    cols: number;
    selection: string;
    pasted: string[];
    dataHandlers: ((data: string) => void)[];
    resizeHandlers: ((size: { rows: number; cols: number }) => void)[];
    keyHandler: ((event: KeyboardEvent) => boolean) | null;
    disposed: boolean;
  }
  class FakeTerminal implements FakeTerminalShape {
    options: Record<string, unknown>;
    writes: string[] = [];
    /** 与后端默认的 24×80 不同：附着后必须显式把真实尺寸补发给新会话。 */
    rows = 33;
    cols = 121;
    selection = "";
    pasted: string[] = [];
    dataHandlers: ((data: string) => void)[] = [];
    resizeHandlers: ((size: { rows: number; cols: number }) => void)[] = [];
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    disposed = false;
    unicode = { activeVersion: "6" };
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
      instances.push(this);
    }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    onData(handler: (data: string) => void) {
      this.dataHandlers.push(handler);
    }
    onResize(handler: (size: { rows: number; cols: number }) => void) {
      this.resizeHandlers.push(handler);
    }
    write(data: string) {
      this.writes.push(data);
    }
    paste(data: string) {
      this.pasted.push(data);
    }
    hasSelection() {
      return this.selection.length > 0;
    }
    getSelection() {
      return this.selection;
    }
    clearSelection() {
      this.selection = "";
    }
    selectAll() {}
    clear() {
      this.writes.push("[clear]");
    }
    focus() {}
    dispose() {
      this.disposed = true;
    }
  }
  class FakeAddon {
    fit() {}
    findNext() {
      return true;
    }
    findPrevious() {
      return true;
    }
    clearDecorations() {}
    onContextLoss() {}
    dispose() {}
  }
  /** 查找插件：记录每次查找的参数，并能像 xterm 一样回报匹配计数。 */
  const searches: FakeSearch[] = [];
  class FakeSearch extends FakeAddon {
    calls: { direction: "next" | "prev"; query: string; options: Record<string, unknown> }[] = [];
    resultHandlers: ((result: { resultIndex: number; resultCount: number }) => void)[] = [];
    found = true;
    constructor() {
      super();
      searches.push(this);
    }
    override findNext(query?: string, options?: Record<string, unknown>) {
      this.calls.push({ direction: "next", query: query ?? "", options: options ?? {} });
      return this.found;
    }
    override findPrevious(query?: string, options?: Record<string, unknown>) {
      this.calls.push({ direction: "prev", query: query ?? "", options: options ?? {} });
      return this.found;
    }
    onDidChangeResults(handler: (result: { resultIndex: number; resultCount: number }) => void) {
      this.resultHandlers.push(handler);
      return { dispose() {} };
    }
    emit(resultIndex: number, resultCount: number) {
      for (const handler of this.resultHandlers) handler({ resultIndex, resultCount });
    }
  }
  return { instances, searches, Terminal: FakeTerminal, Addon: FakeAddon, Search: FakeSearch };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xtermMock.Terminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xtermMock.Addon }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: xtermMock.Search }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: xtermMock.Addon }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: xtermMock.Addon }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: xtermMock.Addon }));

const windowMock = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: windowMock.close }) }));

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const api = {
    getSettings: vi.fn(),
    measureProbe: vi.fn(),
    measureSample: vi.fn(),
    measureFinish: vi.fn(),
    measureWait: vi.fn(),
    cancelReads: vi.fn(),
    openRepository: vi.fn(),
    mergeSession: vi.fn(),
    loadDiff: vi.fn(),
    repositoryDirectory: vi.fn(),
    terminalProfiles: vi.fn(),
    terminalList: vi.fn(),
    terminalCreate: vi.fn(),
    terminalAttach: vi.fn(),
    terminalRestart: vi.fn(),
    terminalClose: vi.fn(),
    setTerminalPrefs: vi.fn(),
    terminalWrite: vi.fn(),
    terminalResize: vi.fn(),
    terminateTerminals: vi.fn(),
    openDocumentUrl: vi.fn(),
    // 打开终端与命令面板不应自动触发的 Git 写入/发布接口。
    commitChanges: vi.fn(),
    commitAndPush: vi.fn(),
    pushBranch: vi.fn(),
    pushToRemote: vi.fn(),
    publishBranch: vi.fn(),
    createTag: vi.fn(),
    pushTag: vi.fn(),
    setTheme: vi.fn(),
  };
  const listenEvent = vi.fn(async (name: string, handler: (payload: unknown) => void) => {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
    return () => {
      const current = handlers.get(name) ?? [];
      handlers.set(name, current.filter((item) => item !== handler));
    };
  });
  return { api, handlers, listenEvent, pickDirectory: vi.fn(), pickFile: vi.fn() };
});

vi.mock("../src/lib/api", () => ({
  api: mocks.api,
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));

import App from "../src/App.svelte";
import TerminalPanel, {
  TERMINAL_CLOSE_REQUESTED_EVENT,
  TERMINAL_EXIT_EVENT,
  TERMINAL_OUTPUT_EVENT,
  stripWindowsTerminalReplies,
  terminalEventApplies,
  terminalStatusLabel,
} from "../src/lib/components/TerminalPanel.svelte";
import {
  MAX_PANES_PER_GROUP,
  addGroup,
  clampFontSize,
  cycleGroup,
  emptyLayout,
  groupTitles,
  layoutFromSessions,
  readTerminalTheme,
  formatDroppedPaths,
  quotePathForShell,
  terminalFindDecorations,
  terminalFindProblem,
  terminalFindSummary,
  removeSession,
  replaceSession,
  splitGroup,
  terminalKeyAction,
} from "../src/lib/terminal";

const repoPath = "C:/work/demo";
const otherRepo = "C:/work/other";

function snapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    sessionId: "s1",
    repoPath,
    profile: "pwsh",
    label: "PowerShell",
    shell: "C:/Program Files/PowerShell/7/pwsh.exe",
    cwd: repoPath,
    running: true,
    exitCode: null,
    signal: null,
    seq: 1,
    output: "welcome\r\n$ ",
    ...overrides,
  };
}

/** 模拟后端：按 sessionId 保存快照，create 依次分配 s1、s2…，attach 返回当前快照。 */
let backend: Map<string, TerminalSnapshot>;
let serial: number;

function installBackend() {
  backend = new Map();
  serial = 0;
  mocks.api.terminalList.mockImplementation(async (path: string) =>
    [...backend.values()].filter((item) => item.repoPath === path).map((item) => ({ ...item, output: "" })),
  );
  mocks.api.terminalCreate.mockImplementation(async (path: string, profile: string | null) => {
    serial += 1;
    const created = snapshot({
      sessionId: `s${serial}`,
      repoPath: path,
      cwd: path,
      profile: profile ?? "pwsh",
      label: profile === "cmd" ? "命令提示符" : "PowerShell",
      output: `welcome-${serial}\r\n$ `,
    });
    backend.set(created.sessionId, created);
    return created;
  });
  mocks.api.terminalAttach.mockImplementation(async (id: string) => {
    const found = backend.get(id);
    if (!found) throw { code: "terminal_unknown", message: "终端会话不存在" };
    return found;
  });
  mocks.api.terminalRestart.mockImplementation(async (id: string) => {
    const old = backend.get(id)!;
    serial += 1;
    const fresh = { ...old, sessionId: `s${serial}`, running: true, exitCode: null, seq: 1, output: "fresh\r\n$ " };
    backend.delete(id);
    backend.set(fresh.sessionId, fresh);
    return fresh;
  });
  mocks.api.terminalClose.mockImplementation(async (id: string) => {
    backend.delete(id);
  });
}

function emit(name: string, payload: unknown) {
  for (const handler of [...(mocks.handlers.get(name) ?? [])]) handler(payload);
}

async function renderPanel(props: Partial<{ path: string; open: boolean; theme: "light" | "dark"; fontSize: number }> = {}) {
  const onClose = vi.fn();
  const onFontSize = vi.fn();
  const view = render(TerminalPanel, {
    props: { path: repoPath, open: true, theme: "dark", onClose, onFontSize, ...props },
  });
  return { view, onClose, onFontSize };
}

async function waitForTerminal(index = 0) {
  await waitFor(() => expect(xtermMock.instances.length).toBeGreaterThan(index));
  const term = xtermMock.instances[index];
  await waitFor(() => expect(term.writes.length).toBeGreaterThan(0));
  return term;
}

function stateOf() {
  return document.querySelector("[data-terminal-state]")?.getAttribute("data-terminal-state");
}

function tabs() {
  return [...document.querySelectorAll<HTMLElement>("[data-terminal-tab]")];
}

function key(init: KeyboardEventInit & { key: string }) {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

/** happy-dom 不做布局：让每个终端格都占 (0,0)-(800,400)，其它元素保持原样。 */
function stubPaneRect() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute("data-terminal-pane")) {
      return { left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400, x: 0, y: 0, toJSON() {} } as DOMRect;
    }
    return original.call(this);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  xtermMock.instances.length = 0;
  xtermMock.searches.length = 0;
  localStorage.clear();
  windowMock.close.mockReset();
  windowMock.close.mockResolvedValue(undefined);
  mocks.api.getSettings.mockResolvedValue({
    theme: "dark",
    panelWidths: { sidebar: 256, files: 360 },
    git: {
      available: true,
      path: "git",
      version: "2.49.0",
      overridden: false,
      belowBaseline: false,
      message: "Git 2.49.0 可用",
    },
    recent: [],
    settingsWarning: null,
    terminal: { profile: null, fontSize: 13 },
  });
  mocks.api.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
  mocks.api.cancelReads.mockResolvedValue(undefined);
  mocks.api.terminalProfiles.mockResolvedValue([
    { id: "pwsh", label: "PowerShell", path: "C:/Program Files/PowerShell/7/pwsh.exe" },
    { id: "cmd", label: "命令提示符", path: "C:/Windows/System32/cmd.exe" },
  ]);
  mocks.api.setTerminalPrefs.mockImplementation(async (prefs: unknown) => prefs);
  mocks.api.terminalWrite.mockResolvedValue(undefined);
  mocks.api.terminalResize.mockResolvedValue(undefined);
  mocks.api.terminateTerminals.mockResolvedValue([]);
  installBackend();
});

afterEach(() => {
  cleanup();
});

/* ------------------------------------------------------------------ 纯逻辑 */

describe("终端事件与状态", () => {
  it("只接受当前 sessionId 且序号更大的事件", () => {
    expect(terminalEventApplies("s1", "s1", 2, 1)).toBe(true);
    expect(terminalEventApplies("s1", "s1", 1, 1)).toBe(false);
    expect(terminalEventApplies("s1", "s1", 0, 1)).toBe(false);
    expect(terminalEventApplies("s1", "s2", 9, 1)).toBe(false);
    expect(terminalEventApplies(null, "s1", 2, 1)).toBe(false);
  });

  it("Windows 的 DA 回复在写入 PTY 前被丢弃，普通按键与 DSR 不受影响", () => {
    expect(stripWindowsTerminalReplies("\x1b[?1;2c")).toBe("");
    expect(stripWindowsTerminalReplies("\x1b[>0;276;0c")).toBe("");
    expect(stripWindowsTerminalReplies("a\x1b[?1;2cb")).toBe("ab");
    expect(stripWindowsTerminalReplies("\x1b[A\x1b[1;24R\r")).toBe("\x1b[A\x1b[1;24R\r");
  });

  it("状态文字如实区分启动中、失败、运行与真实退出码", () => {
    const base = { starting: false, failed: false, sessionId: "s1", running: true, exitCode: null, signal: null };
    expect(terminalStatusLabel(base)).toBe("运行中");
    expect(terminalStatusLabel({ ...base, starting: true })).toBe("正在启动…");
    expect(terminalStatusLabel({ ...base, running: false, failed: true })).toBe("启动失败");
    expect(terminalStatusLabel({ ...base, sessionId: null })).toBe("未连接");
    expect(terminalStatusLabel({ ...base, running: false, exitCode: 7 })).toBe("已退出 · 退出码 7");
    expect(terminalStatusLabel({ ...base, running: false, exitCode: null, signal: "SIGTERM" })).toBe("已退出 · SIGTERM");
  });

  it("按键归类：Ctrl+C 无选区时仍是中断信号，有选区或加 Shift 时复制；粘贴与界面快捷键被接管", () => {
    const win = (init: Parameters<typeof terminalKeyAction>[0], selection = false) => terminalKeyAction(init, false, selection);
    const mac = (init: Parameters<typeof terminalKeyAction>[0], selection = false) => terminalKeyAction(init, true, selection);
    expect(win({ key: "c", ctrlKey: true })).toBeNull();
    expect(win({ key: "c", ctrlKey: true }, true)).toBe("copy");
    expect(win({ key: "C", ctrlKey: true, shiftKey: true })).toBe("copy");
    expect(win({ key: "v", ctrlKey: true })).toBe("paste");
    expect(win({ key: "V", ctrlKey: true, shiftKey: true })).toBe("paste");
    expect(win({ key: "f", ctrlKey: true })).toBe("find");
    expect(win({ key: "`", code: "Backquote", ctrlKey: true })).toBe("toggle");
    expect(win({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true })).toBe("new");
    expect(win({ key: "%", code: "Digit5", ctrlKey: true, shiftKey: true })).toBe("split");
    expect(win({ key: "=", ctrlKey: true })).toBe("zoom-in");
    expect(win({ key: "-", ctrlKey: true })).toBe("zoom-out");
    expect(win({ key: "0", ctrlKey: true })).toBe("zoom-reset");
    expect(win({ key: "PageDown", ctrlKey: true })).toBe("next-tab");
    // 普通字符、Ctrl+R / Ctrl+D 等 shell 常用组合与 Alt 组合原样交给 shell。
    expect(win({ key: "a" })).toBeNull();
    expect(win({ key: "r", ctrlKey: true })).toBeNull();
    expect(win({ key: "d", ctrlKey: true })).toBeNull();
    expect(win({ key: "f", altKey: true })).toBeNull();
    // macOS：⌘C 只在有选区时复制；Ctrl+C 始终是中断信号。
    expect(mac({ key: "c", metaKey: true }, true)).toBe("copy");
    expect(mac({ key: "c", ctrlKey: true }, true)).toBeNull();
    expect(mac({ key: "v", metaKey: true })).toBe("paste");
    expect(mac({ key: "f", metaKey: true })).toBe("find");
    expect(mac({ key: "f", ctrlKey: true })).toBeNull();
  });

  it("字号夹在 9–24 之间并取整", () => {
    expect(clampFontSize(3)).toBe(9);
    expect(clampFontSize(40)).toBe(24);
    expect(clampFontSize(13.6)).toBe(14);
    expect(clampFontSize(Number.NaN)).toBe(13);
  });

  it("配色从终端令牌读取，读不到的键交给 xterm 缺省值", () => {
    const tokens: Record<string, string> = { "--term-bg": " #111216", "--term-bright-yellow": "#f5d695" };
    const theme = readTerminalTheme((token) => tokens[token] ?? "");
    expect(theme).toEqual({ background: "#111216", brightYellow: "#f5d695" });
  });
});

describe("拖入路径的引号与路径写法", () => {
  it("按终端类型加引号：不需要时保持原样，特殊字符不会被 shell 展开", () => {
    expect(quotePathForShell("C:\\work\\demo\\a.txt", "pwsh")).toBe("C:\\work\\demo\\a.txt");
    expect(quotePathForShell("C:\\Program Files\\it's.txt", "pwsh")).toBe("'C:\\Program Files\\it''s.txt'");
    expect(quotePathForShell("C:\\a $b.txt", "powershell")).toBe("'C:\\a $b.txt'");
    expect(quotePathForShell("C:\\Program Files\\x", "cmd")).toBe('"C:\\Program Files\\x"');
    expect(quotePathForShell("C:\\100%\\x", "cmd")).toBe('"C:\\100%\\x"');
    expect(quotePathForShell("/home/me/src", "bash")).toBe("/home/me/src");
    expect(quotePathForShell("/home/me/it's $x", "zsh")).toBe("'/home/me/it'\\''s $x'");
    expect(quotePathForShell("/home/me/it's", "fish")).toBe("'/home/me/it\\'s'");
  });

  it("Git Bash 与 WSL 把盘符路径换成各自的写法", () => {
    expect(quotePathForShell("C:\\work\\demo", "git-bash")).toBe("/c/work/demo");
    expect(quotePathForShell("D:\\My Docs\\a.md", "wsl")).toBe("'/mnt/d/My Docs/a.md'");
  });

  it("多个路径空格连接并补一个尾随空格；空列表不插入任何内容", () => {
    expect(formatDroppedPaths(["/a", "/b c"], "bash")).toBe("/a '/b c' ");
    expect(formatDroppedPaths([], "bash")).toBe("");
  });
});

describe("终端查找文案", () => {
  it("计数显示当前项/总数，超出加亮上限时加 +，没有命中写「无结果」", () => {
    expect(terminalFindSummary("", { index: 0, count: 3 }, false)).toBe("");
    expect(terminalFindSummary("err", null, false)).toBe("");
    expect(terminalFindSummary("err", { index: 1, count: 3 }, false)).toBe("2/3");
    expect(terminalFindSummary("err", { index: -1, count: 3 }, false)).toBe("3 处");
    expect(terminalFindSummary("err", { index: -1, count: 0 }, false)).toBe("无结果");
    expect(terminalFindSummary("err", null, true)).toBe("无结果");
    expect(terminalFindSummary("err", { index: 4, count: 1000 }, false)).toBe("5/1000+");
    expect(terminalFindSummary("err", { index: -1, count: 1000 }, false)).toBe("1000+ 处");
  });

  it("只有正则模式才校验表达式", () => {
    expect(terminalFindProblem("a(b", { regex: true })).toBe("正则无效");
    expect(terminalFindProblem("a(b", { regex: false })).toBeNull();
    expect(terminalFindProblem("a+b", { regex: true })).toBeNull();
    expect(terminalFindProblem("", { regex: true })).toBeNull();
  });

  it("加亮颜色取主题令牌，非 #RRGGBB 时退回缺省", () => {
    const tokens: Record<string, string> = { "--term-find-match": " #112233 ", "--term-find-active": "rgba(0,0,0,.5)" };
    const decorations = terminalFindDecorations((token) => tokens[token] ?? "");
    expect(decorations.matchBackground).toBe("#112233");
    expect(decorations.activeMatchBackground).toBe("#112233");
    expect(decorations.activeMatchBorder).toMatch(/^#[0-9a-f]{6}$/i);
    expect(decorations.activeMatchBorder).not.toBe("rgba(0,0,0,.5)");
  });
});

describe("标签页与拆分布局", () => {
  it("新建、拆分、关闭与重启都维持焦点与顺序", () => {
    let layout = addGroup(emptyLayout(), "a");
    layout = addGroup(layout, "b");
    expect(layout.groups.map((group) => group.panes)).toEqual([["a"], ["b"]]);
    expect(layout.focused).toBe("b");

    layout = splitGroup(layout, layout.activeGroup, "c");
    expect(layout.groups[1].panes).toEqual(["b", "c"]);
    expect(layout.focused).toBe("c");

    layout = replaceSession(layout, "c", "c2");
    expect(layout.groups[1].panes).toEqual(["b", "c2"]);
    expect(layout.focused).toBe("c2");

    // 关闭聚焦的并排终端：焦点留在同一标签页。
    layout = removeSession(layout, "c2");
    expect(layout.groups[1].panes).toEqual(["b"]);
    expect(layout.focused).toBe("b");

    // 关闭激活标签页的最后一个终端：落到相邻标签页。
    layout = removeSession(layout, "b");
    expect(layout.groups.map((group) => group.panes)).toEqual([["a"]]);
    expect(layout.focused).toBe("a");
    expect(removeSession(layout, "a")).toEqual({ groups: [], activeGroup: null, focused: null });
  });

  it("一个标签页最多并排四个，再拆分改为新标签页；切换标签页循环", () => {
    let layout = addGroup(emptyLayout(), "p0");
    for (let index = 1; index < MAX_PANES_PER_GROUP; index += 1) layout = splitGroup(layout, layout.activeGroup, `p${index}`);
    expect(layout.groups).toHaveLength(1);
    layout = splitGroup(layout, layout.activeGroup, "overflow");
    expect(layout.groups).toHaveLength(2);
    expect(layout.focused).toBe("overflow");
    layout = cycleGroup(layout, 1);
    expect(layout.activeGroup).toBe(layout.groups[0].id);
    expect(layout.focused).toBe("p3");
  });

  it("同名标签页补序号，改过名的保留原名；恢复已有会话时各占一个标签页并激活第一个", () => {
    const layout = layoutFromSessions(["a", "b", "c"]);
    expect(layout.activeGroup).toBe(layout.groups[0].id);
    const labels: Record<string, string> = { a: "PowerShell", b: "PowerShell", c: "Git Bash" };
    expect([...groupTitles(layout, (id) => labels[id]).values()]).toEqual(["PowerShell", "PowerShell 2", "Git Bash"]);
  });
});

/* ------------------------------------------------------------------ 面板 */

describe("终端面板", () => {
  it("首次展开在仓库根目录新建会话；附着快照、丢弃旧序号与其他会话、显示退出码", async () => {
    await renderPanel();
    const term = await waitForTerminal();
    expect(mocks.api.terminalList).toHaveBeenCalledWith(repoPath);
    expect(mocks.api.terminalCreate).toHaveBeenCalledWith(repoPath, null);
    await waitFor(() => expect(term.writes).toContain("welcome-1\r\n$ "));
    await waitFor(() => expect(stateOf()).toBe("running"));
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0].textContent).toContain("PowerShell");

    emit(TERMINAL_OUTPUT_EVENT, { sessionId: "s1", seq: 2, data: "next-line\r\n" });
    await tick();
    expect(term.writes.at(-1)).toBe("next-line\r\n");

    const written = term.writes.length;
    emit(TERMINAL_OUTPUT_EVENT, { sessionId: "s1", seq: 2, data: "duplicate\r\n" });
    emit(TERMINAL_OUTPUT_EVENT, { sessionId: "old-session", seq: 99, data: "other\r\n" });
    await tick();
    expect(term.writes, "快照覆盖的旧事件与其它会话都不能重复写入").toHaveLength(written);

    emit(TERMINAL_EXIT_EVENT, { sessionId: "s1", seq: 3, exitCode: 7, signal: null });
    await waitFor(() => expect(stateOf()).toBe("exited"));
    expect(document.querySelector("[data-terminal-state]")?.textContent).toContain("退出码 7");
    expect(document.querySelector("[data-terminal-exit]")?.textContent).toContain("退出码 7");
    expect(tabs()[0].getAttribute("data-state")).toBe("exited");
    // 退出后输入不再写入，并就地说明；已有输出保留。
    term.dataHandlers[0]("echo ignored\r");
    await waitFor(() => expect(screen.getByText(/终端已退出，无法继续输入/)).toBeTruthy());
    expect(mocks.api.terminalWrite).not.toHaveBeenCalled();
  });

  it("挂载前到达的输出由附着快照覆盖，快照之后的事件按序补上", async () => {
    let releaseAttach!: () => void;
    mocks.api.terminalAttach.mockImplementationOnce(
      (id: string) =>
        new Promise((resolve) => {
          releaseAttach = () => resolve({ ...backend.get(id)!, seq: 4, output: "early\r\n" });
        }),
    );
    await renderPanel();
    await waitFor(() => expect(mocks.api.terminalAttach).toHaveBeenCalledWith("s1"));
    // 附着返回前到达：seq 4 已在快照里，seq 5 只能在快照之后写入一次。
    emit(TERMINAL_OUTPUT_EVENT, { sessionId: "s1", seq: 4, data: "early\r\n" });
    emit(TERMINAL_OUTPUT_EVENT, { sessionId: "s1", seq: 5, data: "late\r\n" });
    releaseAttach();
    const term = xtermMock.instances[0];
    await waitFor(() => expect(term.writes).toEqual(["early\r\n", "late\r\n"]));
  });

  it("恢复后端已有会话：每个会话一个标签页，不新建 shell", async () => {
    backend.set("a", snapshot({ sessionId: "a", label: "PowerShell", output: "a-out" }));
    backend.set("b", snapshot({ sessionId: "b", profile: "cmd", label: "命令提示符", output: "b-out" }));
    await renderPanel();
    await waitFor(() => expect(tabs()).toHaveLength(2));
    expect(mocks.api.terminalCreate).not.toHaveBeenCalled();
    expect(tabs().map((tab) => tab.querySelector(".terminal-tab-label")?.textContent)).toEqual(["PowerShell", "命令提示符"]);
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(mocks.api.terminalAttach).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(mocks.api.terminalAttach).toHaveBeenCalledWith("b"));
  });

  it("附着和重新启动后都把 xterm 的真实行列同步给会话，不停留在后端默认 24×80", async () => {
    await renderPanel();
    const term = await waitForTerminal();
    await waitFor(() => expect(mocks.api.terminalResize).toHaveBeenCalledWith("s1", term.rows, term.cols));

    emit(TERMINAL_EXIT_EVENT, { sessionId: "s1", seq: 2, exitCode: 0, signal: null });
    await waitFor(() => expect(document.querySelector("[data-terminal-restart]")).toBeTruthy());
    await fireEvent.click(document.querySelector<HTMLButtonElement>("[data-terminal-restart]")!);
    await waitFor(() => expect(mocks.api.terminalRestart).toHaveBeenCalledWith("s1"));
    const fresh = await waitForTerminal(1);
    await waitFor(() => expect(fresh.writes).toContain("fresh\r\n$ "));
    await waitFor(() => expect(mocks.api.terminalResize).toHaveBeenCalledWith("s2", fresh.rows, fresh.cols));
    expect(tabs(), "重启沿用原标签页").toHaveLength(1);
    await waitFor(() => expect(stateOf()).toBe("running"));
  });

  it("键盘输入与尺寸变化转成 terminalWrite / terminalResize", async () => {
    await renderPanel();
    const term = await waitForTerminal();
    await waitFor(() => expect(stateOf()).toBe("running"));
    term.dataHandlers[0]("npm test\r");
    await waitFor(() => expect(mocks.api.terminalWrite).toHaveBeenCalledWith("s1", "npm test\r"));
    term.resizeHandlers[0]({ rows: 32, cols: 110 });
    await waitFor(() => expect(mocks.api.terminalResize).toHaveBeenCalledWith("s1", 32, 110));
  });

  it("新建标签页、选择终端类型、拆分与关闭；关掉最后一个终端收起面板", async () => {
    const { onClose } = await renderPanel();
    await waitForTerminal();

    await fireEvent.click(document.querySelector<HTMLButtonElement>("[data-terminal-new]")!);
    await waitFor(() => expect(tabs()).toHaveLength(2));
    expect(mocks.api.terminalCreate).toHaveBeenLastCalledWith(repoPath, null);
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs()[1].textContent).toContain("PowerShell 2");

    // 下拉里按类型新建：后端按 id 解析，前端不传程序路径。
    await fireEvent.click(document.querySelector<HTMLButtonElement>("[data-terminal-profiles]")!);
    const menu = await screen.findByRole("menu", { name: "选择终端类型" });
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /命令提示符/ }));
    await waitFor(() => expect(tabs()).toHaveLength(3));
    expect(mocks.api.terminalCreate).toHaveBeenLastCalledWith(repoPath, "cmd");

    // 拆分：同一标签页里并排，沿用当前终端的类型。
    await fireEvent.click(document.querySelector<HTMLButtonElement>("[data-terminal-split]")!);
    await waitFor(() => expect(document.querySelectorAll(".terminal-group.active [data-terminal-pane]")).toHaveLength(2));
    expect(mocks.api.terminalCreate).toHaveBeenLastCalledWith(repoPath, "cmd");
    expect(tabs()).toHaveLength(3);

    // 关闭当前终端只关聚焦的那一格。
    await fireEvent.click(document.querySelector<HTMLButtonElement>("[data-terminal-kill]")!);
    await waitFor(() => expect(mocks.api.terminalClose).toHaveBeenCalledWith("s4"));
    await waitFor(() => expect(document.querySelectorAll(".terminal-group.active [data-terminal-pane]")).toHaveLength(1));

    // 逐个关闭标签页；最后一个关掉后收起面板。
    for (const tab of tabs().reverse()) {
      await fireEvent.click(tab.querySelector<HTMLButtonElement>(".terminal-tab-close")!);
    }
    await waitFor(() => expect(tabs()).toHaveLength(0));
    expect(mocks.api.terminalClose).toHaveBeenCalledTimes(4);
    expect(onClose).toHaveBeenCalled();
  });

  it("关闭失败保留标签页并说明真实错误", async () => {
    await renderPanel();
    await waitForTerminal();
    mocks.api.terminalClose.mockRejectedValueOnce({ code: "terminal_stop", message: "无法确认终端 shell 及其子进程已退出。" });
    await fireEvent.click(document.querySelector<HTMLButtonElement>("[data-terminal-kill]")!);
    await waitFor(() => expect(screen.getByText("无法确认终端 shell 及其子进程已退出。")).toBeTruthy());
    expect(tabs()).toHaveLength(1);
  });

  it("启动失败不伪装成可用终端，重试可以重新新建", async () => {
    mocks.api.terminalCreate.mockRejectedValueOnce({ code: "terminal_start", message: "无法启动终端 shell：模拟失败" });
    await renderPanel();
    await waitFor(() => expect(screen.getByText("无法启动终端 shell：模拟失败")).toBeTruthy());
    expect(stateOf()).toBe("failed");
    expect(document.querySelector("[data-terminal-pane]")).toBeNull();
    expect(xtermMock.instances).toHaveLength(0);

    await fireEvent.click(document.querySelector<HTMLButtonElement>("[data-terminal-retry]")!);
    await waitFor(() => expect(mocks.api.terminalCreate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(stateOf()).toBe("running"));
    expect(document.querySelector("[data-terminal-retry]")).toBeNull();
  });

  it("写入失败就地说明并保留已有输出", async () => {
    mocks.api.terminalWrite.mockRejectedValueOnce({ code: "terminal_write", message: "无法写入终端：模拟失败" });
    await renderPanel();
    const term = await waitForTerminal();
    await waitFor(() => expect(stateOf()).toBe("running"));
    term.dataHandlers[0]("x");
    await waitFor(() => expect(screen.getByText("无法写入终端：模拟失败")).toBeTruthy());
    expect(term.writes).toContain("welcome-1\r\n$ ");
    expect(stateOf()).toBe("running");
  });

  it("收起再展开保留同一 xterm 与会话；字号变化原地更新", async () => {
    const { view } = await renderPanel();
    const term = await waitForTerminal();
    expect(term.options.fontSize).toBe(13);

    await view.rerender({ path: repoPath, open: false, theme: "dark", fontSize: 13 });
    await tick();
    expect(document.querySelector(".terminal-panel")?.hasAttribute("hidden")).toBe(true);

    await view.rerender({ path: repoPath, open: true, theme: "light", fontSize: 16 });
    await waitFor(() => expect(term.options.fontSize).toBe(16));
    expect(xtermMock.instances, "收起/展开不重建 xterm 实例").toHaveLength(1);
    expect(mocks.api.terminalCreate).toHaveBeenCalledTimes(1);
    expect(stateOf()).toBe("running");
  });

  it("切换仓库各自一组终端；切回原仓库重新附着原会话并重放输出", async () => {
    const { view } = await renderPanel();
    await waitForTerminal();

    await view.rerender({ path: otherRepo, open: true, theme: "dark" });
    await waitFor(() => expect(mocks.api.terminalCreate).toHaveBeenCalledWith(otherRepo, null));
    const other = await waitForTerminal(1);
    await waitFor(() => expect(other.writes).toContain("welcome-2\r\n$ "));
    expect(xtermMock.instances[0].disposed, "离开仓库时卸载画面，会话仍在后端").toBe(true);

    await view.rerender({ path: repoPath, open: true, theme: "dark" });
    const back = await waitForTerminal(2);
    await waitFor(() => expect(back.writes).toContain("welcome-1\r\n$ "));
    expect(mocks.api.terminalCreate, "回到原仓库不新建 shell").toHaveBeenCalledTimes(2);
    expect(mocks.api.terminalAttach.mock.calls.filter(([id]) => id === "s1")).toHaveLength(2);
  });

  it("右键菜单：无选区时复制不可用并说明原因，新建终端走同一入口", async () => {
    await renderPanel();
    await waitForTerminal();
    const pane = document.querySelector<HTMLElement>("[data-terminal-pane]")!;
    await fireEvent.contextMenu(pane, { clientX: 40, clientY: 40 });
    const menu = await screen.findByRole("menu", { name: "终端操作" });
    const copy = within(menu).getByRole("menuitem", { name: /复制/ });
    expect(copy.getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByRole("menuitem", { name: /粘贴/ })).toBeTruthy();
    await fireEvent.click(within(menu).getByRole("menuitem", { name: /新建终端/ }));
    await waitFor(() => expect(tabs()).toHaveLength(2));
  });

  it("终端内快捷键：Ctrl+Shift+5 拆分、Ctrl+F 打开查找、Ctrl+= 放大字号、Ctrl+` 收起；Ctrl+C 无选区交给 shell", async () => {
    const { onClose, onFontSize } = await renderPanel();
    const term = await waitForTerminal();
    const handler = term.keyHandler!;
    expect(handler(key({ key: "c", ctrlKey: true }))).toBe(true);

    expect(handler(key({ key: "%", code: "Digit5", ctrlKey: true, shiftKey: true }))).toBe(false);
    await waitFor(() => expect(document.querySelectorAll(".terminal-group.active [data-terminal-pane]")).toHaveLength(2));

    handler(key({ key: "f", ctrlKey: true }));
    await waitFor(() => expect(document.querySelector("[data-terminal-find]")).toBeTruthy());

    handler(key({ key: "=", ctrlKey: true }));
    expect(onFontSize).toHaveBeenCalledWith(14);

    handler(key({ key: "`", code: "Backquote", ctrlKey: true }));
    expect(onClose).toHaveBeenCalled();
  });

  it("查找条：显示当前终端的匹配计数，大小写/全词/正则开关随查找下发，无效正则不交给 xterm", async () => {
    await renderPanel();
    const term = await waitForTerminal();
    await waitFor(() => expect(stateOf()).toBe("running"));
    term.keyHandler!(key({ key: "f", ctrlKey: true }));
    const input = await waitFor(() => {
      const found = document.querySelector<HTMLInputElement>("[data-terminal-find]");
      expect(found).toBeTruthy();
      return found!;
    });
    const search = xtermMock.searches[0];
    const count = () => document.querySelector("[data-terminal-find-count]")?.textContent?.trim();

    await fireEvent.input(input, { target: { value: "error" } });
    expect(search.calls.at(-1)).toMatchObject({
      direction: "next",
      query: "error",
      options: { incremental: true, caseSensitive: false, wholeWord: false, regex: false },
    });
    expect(search.calls.at(-1)?.options.decorations).toBeTruthy();
    search.emit(1, 4);
    await tick();
    expect(count()).toBe("2/4");

    await fireEvent.click(screen.getByRole("button", { name: "区分大小写" }));
    expect(screen.getByRole("button", { name: "区分大小写" }).getAttribute("aria-pressed")).toBe("true");
    expect(search.calls.at(-1)?.options).toMatchObject({ caseSensitive: true });
    await fireEvent.keyDown(input, { key: "w", altKey: true });
    expect(screen.getByRole("button", { name: "全词匹配" }).getAttribute("aria-pressed")).toBe("true");
    expect(search.calls.at(-1)?.options).toMatchObject({ caseSensitive: true, wholeWord: true });

    // 正则模式下无法编译的表达式：就地说明，不调用 xterm，上一/下一个禁用。
    await fireEvent.click(screen.getByRole("button", { name: "正则表达式" }));
    const before = search.calls.length;
    await fireEvent.input(input, { target: { value: "err(" } });
    expect(search.calls.length).toBe(before);
    expect(count()).toBe("正则无效");
    expect((screen.getByRole("button", { name: "下一个匹配" }) as HTMLButtonElement).disabled).toBe(true);

    search.found = false;
    await fireEvent.input(input, { target: { value: "nothing" } });
    expect(count()).toBe("无结果");

    // 关闭后再打开：开关保留，计数清空。
    await fireEvent.keyDown(input, { key: "Escape" });
    term.keyHandler!(key({ key: "f", ctrlKey: true }));
    await waitFor(() => expect(document.querySelector("[data-terminal-find]")).toBeTruthy());
    expect(screen.getByRole("button", { name: "正则表达式" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("插入路径：等终端附着后按类型加引号插入、不回车；还没有终端时先启动一个", async () => {
    const { view } = await renderPanel();
    const panel = view.component as unknown as { insertPaths: (paths: string[]) => Promise<boolean> };
    const inserted = panel.insertPaths(["C:\\work\\my file.txt"]);
    const term = await waitForTerminal();
    expect(await inserted).toBe(true);
    expect(term.pasted.at(-1)).toBe(formatDroppedPaths(["C:\\work\\my file.txt"], "pwsh"));
    expect(term.pasted.at(-1)).not.toContain("\r");
    expect(await panel.insertPaths([])).toBe(false);
  });

  it("拖入文件：经过时高亮目标终端，放下按终端类型插入带引号的路径且不回车；终端外交还外壳", async () => {
    const { view } = await renderPanel();
    const term = await waitForTerminal();
    await waitFor(() => expect(stateOf()).toBe("running"));
    const restore = stubPaneRect();
    try {
      const panel = view.component as unknown as {
        dragOver: (x: number, y: number) => boolean;
        dropPaths: (paths: string[], x: number, y: number) => boolean;
      };
      expect(panel.dragOver(50, 50)).toBe(true);
      await waitFor(() => expect(document.querySelector("[data-terminal-drop-hint]")).toBeTruthy());
      expect(panel.dragOver(5000, 5000)).toBe(false);
      await waitFor(() => expect(document.querySelector("[data-terminal-drop-hint]")).toBeNull());

      expect(panel.dropPaths(["C:\\Program Files\\demo", "C:\\work\\a.txt"], 50, 50)).toBe(true);
      expect(term.pasted).toEqual(["'C:\\Program Files\\demo' C:\\work\\a.txt "]);
      expect(document.querySelector("[data-terminal-drop-hint]")).toBeNull();
      expect(panel.dropPaths(["C:\\x"], 5000, 5000), "终端之外的放下由外壳处理").toBe(false);

      // 已退出的终端不插入，就地说明。
      emit(TERMINAL_EXIT_EVENT, { sessionId: "s1", seq: 2, exitCode: 0, signal: null });
      await waitFor(() => expect(stateOf()).toBe("exited"));
      expect(panel.dropPaths(["C:\\y"], 50, 50)).toBe(true);
      expect(term.pasted).toHaveLength(1);
      await waitFor(() => expect(screen.getByText(/终端已退出，无法插入路径/)).toBeTruthy());
    } finally {
      restore();
    }
  });

  it("最大化切换面板状态，不影响会话", async () => {
    await renderPanel();
    await waitForTerminal();
    const button = document.querySelector<HTMLButtonElement>("[data-terminal-maximize]")!;
    await fireEvent.click(button);
    expect(document.querySelector(".terminal-panel")?.classList.contains("maximized")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await fireEvent.click(button);
    expect(document.querySelector(".terminal-panel")?.classList.contains("maximized")).toBe(false);
    expect(mocks.api.terminalCreate).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * 外壳：展开终端只打开/附着 PTY，不触发任何 Git 写入；关窗确认走完整取消/确认/失败路径。
 * ------------------------------------------------------------------ */

const branch = {
  name: "main",
  detached: false,
  unborn: false,
  headOid: "a".repeat(40),
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  liveRemoteChecked: true,
  remoteCheckedAtMs: 1,
  remoteCheckStale: false,
};

function openedRepo() {
  return {
    summary: { name: "demo", path: repoPath },
    generation: 4,
    snapshot: {
      generation: 4,
      branch,
      files: [
        {
          path: "README.md",
          originalPath: null,
          staged: "none" as const,
          unstaged: "modified" as const,
          untracked: false,
          unmerged: false,
        },
      ],
    },
    draft: "",
    watchDegraded: false,
  };
}

function simpleDiff(path: string, staged: boolean) {
  return {
    generation: 4,
    path,
    staged,
    binary: false,
    text: null,
    summary: "1 行上下文。",
    additions: 0,
    deletions: 0,
    complete: true,
    truncated: false,
    snapshot: "s",
    hunks: [],
    lines: [{ kind: "context" as const, text: " line", oldNo: 1, newNo: 1, hunkIndex: 0 }],
    offset: 0,
    totalLines: 1,
  };
}

async function renderShell() {
  mocks.api.getSettings.mockResolvedValue({
    theme: "dark",
    panelWidths: { sidebar: 256, files: 360 },
    git: {
      available: true,
      path: "git",
      version: "2.49.0",
      overridden: false,
      belowBaseline: false,
      message: "Git 2.49.0 可用",
    },
    recent: [{ name: "demo", path: repoPath, openedAtMs: 1 }],
    settingsWarning: null,
    terminal: { profile: null, fontSize: 13 },
  });
  mocks.api.openRepository.mockResolvedValue(openedRepo());
  mocks.api.mergeSession.mockResolvedValue({
    generation: 4,
    operation: "none",
    canContinue: false,
    canAbort: false,
    source: null,
    target: "main",
    headOid: branch.headOid,
    conflicts: [],
    unresolved: 0,
    note: "当前没有进行中的合并。",
    snapshot: openedRepo().snapshot,
  });
  mocks.api.loadDiff.mockImplementation(async (_path: string, relative: string, staged: boolean) => simpleDiff(relative, staged));
  mocks.api.repositoryDirectory.mockResolvedValue({ generation: 4, path: "", entries: [], errors: [] });
  render(App);
  await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
  await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
  await waitFor(() => expect(document.querySelector(".file-list")).toBeTruthy());
  await waitFor(() => expect(document.querySelector("[data-terminal-toggle]")).toBeTruthy());
}

async function openTerminalFromStatus() {
  const toggle = document.querySelector<HTMLButtonElement>("[data-terminal-toggle]")!;
  await fireEvent.click(toggle);
  await waitFor(() => expect(mocks.api.terminalCreate).toHaveBeenCalledWith(repoPath, null));
  await waitFor(() => expect(document.querySelector(".terminal-panel")?.hasAttribute("hidden")).toBe(false));
}

describe("外壳终端入口与关窗确认", () => {
  it("状态栏展开终端；切换视图不重建会话，也不自动调用版本、提交、标签或推送接口", async () => {
    await renderShell();
    await openTerminalFromStatus();
    const panel = document.querySelector<HTMLElement>("[data-terminal-panel]")!;
    expect(panel).toBeTruthy();
    expect(document.querySelector("[data-terminal-toggle]")?.getAttribute("aria-expanded")).toBe("true");

    // 切到文件视图：三个工作台视图之外的面板仍在，没有再次新建会话。
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", ctrlKey: true, bubbles: true }));
    await tick();
    expect(document.querySelector('.workbench-view[data-view-scope="files"][data-active="true"]')).toBeTruthy();
    expect(document.querySelector("[data-terminal-panel]")).toBe(panel);
    expect(mocks.api.terminalCreate).toHaveBeenCalledTimes(1);

    // 在终端里输入普通构建命令只会写 PTY，不触发版本、提交、标签或推送接口。
    const term = await waitForTerminal();
    await waitFor(() => expect(document.querySelector("[data-terminal-state]")?.getAttribute("data-terminal-state")).toBe("running"));
    term.dataHandlers[0]("npm run build\r");
    await waitFor(() => expect(mocks.api.terminalWrite).toHaveBeenCalledWith("s1", "npm run build\r"));

    for (const banned of [
      mocks.api.commitChanges,
      mocks.api.commitAndPush,
      mocks.api.pushBranch,
      mocks.api.pushToRemote,
      mocks.api.publishBranch,
      mocks.api.createTag,
      mocks.api.pushTag,
      mocks.api.setTheme,
    ]) {
      expect(banned).not.toHaveBeenCalled();
    }
  });

  it("命令面板与状态栏是同一个终端开关；Ctrl+` 也走同一条命令", async () => {
    await renderShell();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    const palette = await screen.findByRole("dialog", { name: "命令面板" });
    await fireEvent.click(within(palette).getByRole("option", { name: /^终端/ }));
    await waitFor(() => expect(mocks.api.terminalCreate).toHaveBeenCalledWith(repoPath, null));
    expect(document.querySelector("[data-terminal-toggle]")?.getAttribute("aria-expanded")).toBe("true");

    await fireEvent.click(document.querySelector<HTMLButtonElement>("[data-terminal-toggle]")!);
    await waitFor(() => expect(document.querySelector("[data-terminal-panel]")?.hasAttribute("hidden")).toBe(true));
    expect(document.querySelector("[data-terminal-toggle]")?.getAttribute("aria-expanded")).toBe("false");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "`", code: "Backquote", ctrlKey: true, bubbles: true }));
    await waitFor(() => expect(document.querySelector("[data-terminal-panel]")?.hasAttribute("hidden")).toBe(false));
    expect(mocks.api.terminalCreate).toHaveBeenCalledTimes(1);
  });

  it("新建终端命令在已有终端时追加标签页，在没有终端时只新建一个", async () => {
    await renderShell();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "~", code: "Backquote", ctrlKey: true, shiftKey: true, bubbles: true }));
    await waitFor(() => expect(tabs()).toHaveLength(1));
    await tick();
    expect(mocks.api.terminalCreate).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "~", code: "Backquote", ctrlKey: true, shiftKey: true, bubbles: true }));
    await waitFor(() => expect(tabs()).toHaveLength(2));
    expect(mocks.api.terminalCreate).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-terminal-toggle] .sb-count")?.textContent).toBe("2");
  });

  it("从系统拖入文件到展开的终端：插入路径，不按「拖入仓库」处理", async () => {
    await renderShell();
    await openTerminalFromStatus();
    const term = await waitForTerminal();
    await waitFor(() => expect(document.querySelector("[data-terminal-state]")?.getAttribute("data-terminal-state")).toBe("running"));
    const restore = stubPaneRect();
    const ratio = window.devicePixelRatio || 1;
    try {
      emit("tauri://drag-enter", { paths: ["C:\\work\\a b.txt"], position: { x: 40 * ratio, y: 40 * ratio } });
      await waitFor(() => expect(document.querySelector("[data-terminal-drop-hint]")).toBeTruthy());
      expect(document.querySelector(".repository-drop-hint"), "落在终端上时不显示拖入仓库的整窗提示").toBeNull();
      emit("tauri://drag-drop", { paths: ["C:\\work\\a b.txt"], position: { x: 40 * ratio, y: 40 * ratio } });
      await waitFor(() => expect(term.pasted).toEqual(["'C:\\work\\a b.txt' "]));
      expect(document.querySelector("[data-terminal-drop-hint]")).toBeNull();
      expect(mocks.api.openRepository).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("关窗取消保持进程；确认先等待终止成功再关闭；失败保留对话框与错误", async () => {
    await renderShell();
    await waitFor(() => expect(mocks.handlers.has(TERMINAL_CLOSE_REQUESTED_EVENT)).toBe(true));
    const sessions = [{ sessionId: "s1", repoPath }];

    emit(TERMINAL_CLOSE_REQUESTED_EVENT, { sessions });
    const dialog = await screen.findByRole("dialog", { name: /结束终端并关闭应用/ });
    expect(within(dialog).getByText(repoPath)).toBeTruthy();
    await fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /结束终端并关闭应用/ })).toBeNull());
    expect(mocks.api.terminateTerminals).not.toHaveBeenCalled();
    expect(windowMock.close).not.toHaveBeenCalled();

    mocks.api.terminateTerminals.mockRejectedValueOnce({ code: "terminal_stop", message: "部分终端未能终止：无法确认 shell 已退出。" });
    emit(TERMINAL_CLOSE_REQUESTED_EVENT, { sessions });
    const failed = await screen.findByRole("dialog", { name: /结束终端并关闭应用/ });
    await fireEvent.click(within(failed).getByRole("button", { name: "结束终端并关闭" }));
    await waitFor(() => expect(screen.getByText("部分终端未能终止：无法确认 shell 已退出。")).toBeTruthy());
    expect(screen.getByRole("dialog", { name: /结束终端并关闭应用/ })).toBeTruthy();
    expect(windowMock.close).not.toHaveBeenCalled();

    emit(TERMINAL_CLOSE_REQUESTED_EVENT, { sessions });
    const confirmed = await screen.findByRole("dialog", { name: /结束终端并关闭应用/ });
    await fireEvent.click(within(confirmed).getByRole("button", { name: "结束终端并关闭" }));
    await waitFor(() => expect(windowMock.close).toHaveBeenCalled());
    expect(mocks.api.terminateTerminals.mock.invocationCallOrder.at(-1)).toBeLessThan(
      windowMock.close.mock.invocationCallOrder[0],
    );
  });

  it("终止进行中再次收到原生关窗请求不会重置忙碌状态", async () => {
    await renderShell();
    await waitFor(() => expect(mocks.handlers.has(TERMINAL_CLOSE_REQUESTED_EVENT)).toBe(true));
    const sessions = [{ sessionId: "s1", repoPath }];
    let resolveTerminate!: (value: typeof sessions) => void;
    mocks.api.terminateTerminals.mockImplementationOnce(
      () => new Promise<typeof sessions>((resolve) => {
        resolveTerminate = resolve;
      }),
    );

    emit(TERMINAL_CLOSE_REQUESTED_EVENT, { sessions });
    const dialog = await screen.findByRole("dialog", { name: /结束终端并关闭应用/ });
    const confirm = within(dialog).getByRole("button", { name: "结束终端并关闭" }) as HTMLButtonElement;
    await fireEvent.click(confirm);
    await waitFor(() => expect(confirm.disabled).toBe(true));
    expect(confirm.getAttribute("aria-busy")).toBe("true");

    emit(TERMINAL_CLOSE_REQUESTED_EVENT, { sessions });
    await tick();
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(windowMock.close).not.toHaveBeenCalled();

    resolveTerminate([]);
    await waitFor(() => expect(windowMock.close).toHaveBeenCalled());
  });

  it("没有活动会话的关窗事件不弹确认", async () => {
    await renderShell();
    await waitFor(() => expect(mocks.handlers.has(TERMINAL_CLOSE_REQUESTED_EVENT)).toBe(true));
    emit(TERMINAL_CLOSE_REQUESTED_EVENT, { sessions: [] });
    await tick();
    expect(screen.queryByRole("dialog", { name: /结束终端并关闭应用/ })).toBeNull();
    expect(mocks.api.terminateTerminals).not.toHaveBeenCalled();
  });
});
