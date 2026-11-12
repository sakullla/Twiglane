import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSnapshot } from "../src/lib/types";

/* ------------------------------------------------------------------ *
 * 终端回归：面板只消费结构化 IPC，会话按仓库保留；展开/切换仓库用快照重放，
 * 旧序号与非当前会话的事件必须丢弃。关窗确认在 App 外壳里，取消不终止进程，
 * 确认先等待 terminateTerminals 成功再关窗口，失败保留对话框与真实错误。
 * ------------------------------------------------------------------ */

const xtermMock = vi.hoisted(() => {
  const instances: {
    options: Record<string, unknown>;
    writes: string[];
    rows: number;
    cols: number;
    dataHandlers: ((data: string) => void)[];
    resizeHandlers: ((size: { rows: number; cols: number }) => void)[];
    disposed: boolean;
  }[] = [];
  class FakeTerminal {
    options: Record<string, unknown> = {};
    writes: string[] = [];
    /** 与后端默认的 24×80 不同：附着后必须显式把真实尺寸补发给新会话。 */
    rows = 33;
    cols = 121;
    dataHandlers: ((data: string) => void)[] = [];
    resizeHandlers: ((size: { rows: number; cols: number }) => void)[] = [];
    disposed = false;
    constructor() {
      instances.push(this);
    }
    loadAddon() {}
    open() {}
    onData(handler: (data: string) => void) {
      this.dataHandlers.push(handler);
    }
    onResize(handler: (size: { rows: number; cols: number }) => void) {
      this.resizeHandlers.push(handler);
    }
    write(data: string) {
      this.writes.push(data);
    }
    reset() {
      this.writes.push("[reset]");
    }
    focus() {}
    dispose() {
      this.disposed = true;
    }
  }
  class FakeFitAddon {
    fit() {}
  }
  return { instances, Terminal: FakeTerminal, FitAddon: FakeFitAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xtermMock.Terminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xtermMock.FitAddon }));

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
    openTerminal: vi.fn(),
    restartTerminal: vi.fn(),
    terminalWrite: vi.fn(),
    terminalResize: vi.fn(),
    terminateTerminals: vi.fn(),
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

const repoPath = "C:/work/demo";
const otherRepo = "C:/work/other";

function snapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    sessionId: "s1",
    repoPath,
    shell: "/bin/sh",
    cwd: repoPath,
    running: true,
    exitCode: null,
    signal: null,
    seq: 1,
    output: "welcome\r\n$ ",
    ...overrides,
  };
}

function emit(name: string, payload: unknown) {
  for (const handler of [...(mocks.handlers.get(name) ?? [])]) handler(payload);
}

async function renderPanel(props: Partial<{ path: string; open: boolean; theme: "light" | "dark" }> = {}) {
  const onClose = vi.fn();
  const view = render(TerminalPanel, {
    props: { path: repoPath, open: true, theme: "dark", onClose, ...props },
  });
  return { view, onClose };
}

async function waitForPanel() {
  await waitFor(() => expect(document.querySelector(".terminal-panel .xterm-helper-textarea, .terminal-panel")).toBeTruthy());
  await waitFor(() => expect(mocks.api.openTerminal).toHaveBeenCalled());
  await waitFor(() => expect(xtermMock.instances).toHaveLength(1));
  return xtermMock.instances[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  xtermMock.instances.length = 0;
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
  });
  mocks.api.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
  mocks.api.cancelReads.mockResolvedValue(undefined);
  mocks.api.openTerminal.mockResolvedValue(snapshot());
  mocks.api.restartTerminal.mockResolvedValue(snapshot({ sessionId: "s2", seq: 1, output: "fresh\r\n$ " }));
  mocks.api.terminalWrite.mockResolvedValue(undefined);
  mocks.api.terminalResize.mockResolvedValue(undefined);
  mocks.api.terminateTerminals.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

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
});

describe("终端面板", () => {
  it("附着快照、丢弃旧序号与其他会话、显示退出码", async () => {
    mocks.api.openTerminal.mockResolvedValue(snapshot({ sessionId: "s1", seq: 5, output: "welcome\r\n$ " }));
    await renderPanel();
    const term = await waitForPanel();
    await waitFor(() => expect(term.writes).toContain("welcome\r\n$ "));
    expect(document.querySelector("[data-terminal-state]")?.getAttribute("data-terminal-state")).toBe("running");

    emit(TERMINAL_OUTPUT_EVENT, { sessionId: "s1", seq: 6, data: "next-line\r\n" });
    await tick();
    expect(term.writes.at(-1)).toBe("next-line\r\n");

    const written = term.writes.length;
    emit(TERMINAL_OUTPUT_EVENT, { sessionId: "s1", seq: 5, data: "duplicate\r\n" });
    emit(TERMINAL_OUTPUT_EVENT, { sessionId: "old-session", seq: 99, data: "other\r\n" });
    await tick();
    expect(term.writes, "快照覆盖的旧事件与其它仓库会话都不能重复写入").toHaveLength(written);

    emit(TERMINAL_EXIT_EVENT, { sessionId: "s1", seq: 7, exitCode: 7, signal: null });
    await tick();
    const state = document.querySelector("[data-terminal-state]");
    expect(state?.getAttribute("data-terminal-state")).toBe("exited");
    expect(state?.textContent).toContain("退出码 7");
    // 退出后输入不再写入，并就地说明；已有输出保留。
    term.dataHandlers[0]("echo ignored\r");
    await waitFor(() => expect(screen.getByText(/终端已退出，无法继续输入/)).toBeTruthy());
    expect(mocks.api.terminalWrite).not.toHaveBeenCalled();
  });

  it("附着和重新启动后都把 xterm 的真实行列同步给新会话，不停留在后端默认 24×80", async () => {
    mocks.api.openTerminal.mockResolvedValue(snapshot({ sessionId: "s1", seq: 1, running: true }));
    mocks.api.restartTerminal.mockResolvedValue(snapshot({ sessionId: "s2", seq: 1, running: true, output: "fresh\r\n$ " }));
    await renderPanel();
    const term = await waitForPanel();
    expect(term.rows).not.toBe(24);
    expect(term.cols).not.toBe(80);
    await waitFor(() => expect(mocks.api.terminalResize).toHaveBeenCalledWith("s1", term.rows, term.cols));

    emit(TERMINAL_EXIT_EVENT, { sessionId: "s1", seq: 2, exitCode: 0, signal: null });
    await tick();
    await fireEvent.click(document.querySelector<HTMLButtonElement>("[data-terminal-restart]")!);
    await waitFor(() => expect(mocks.api.restartTerminal).toHaveBeenCalledWith(repoPath));
    await waitFor(() => expect(mocks.api.terminalResize).toHaveBeenCalledWith("s2", term.rows, term.cols));
  });

  it("键盘输入与尺寸变化转成 terminalWrite / terminalResize；退出后可以重新启动", async () => {
    await renderPanel();
    const term = await waitForPanel();
    term.dataHandlers[0]("npm test\r");
    await waitFor(() => expect(mocks.api.terminalWrite).toHaveBeenCalledWith("s1", "npm test\r"));
    term.resizeHandlers[0]({ rows: 32, cols: 110 });
    await waitFor(() => expect(mocks.api.terminalResize).toHaveBeenCalledWith("s1", 32, 110));

    emit(TERMINAL_EXIT_EVENT, { sessionId: "s1", seq: 2, exitCode: 0, signal: null });
    await tick();
    const restart = document.querySelector<HTMLButtonElement>("[data-terminal-restart]")!;
    expect(restart).toBeTruthy();
    await fireEvent.click(restart);
    await waitFor(() => expect(mocks.api.restartTerminal).toHaveBeenCalledWith(repoPath));
    await waitFor(() => expect(term.writes).toContain("fresh\r\n$ "));
    expect(document.querySelector("[data-terminal-state]")?.getAttribute("data-terminal-state")).toBe("running");
  });

  it("启动失败不伪装成可用终端，重试可以重新附着", async () => {
    mocks.api.openTerminal.mockRejectedValueOnce({ code: "terminal_start", message: "无法启动终端 shell：模拟失败" });
    await renderPanel();
    await waitFor(() => expect(screen.getByText("无法启动终端 shell：模拟失败")).toBeTruthy());
    const state = document.querySelector("[data-terminal-state]");
    expect(state?.getAttribute("data-terminal-state")).toBe("failed");
    expect(document.querySelector(".terminal-surface")?.classList.contains("terminal-hidden")).toBe(true);
    expect(document.querySelector("[data-terminal-retry]")).toBeTruthy();

    mocks.api.openTerminal.mockResolvedValue(snapshot({ seq: 1, output: "ok\r\n$ " }));
    await fireEvent.click(document.querySelector<HTMLButtonElement>("[data-terminal-retry]")!);
    await waitFor(() => expect(mocks.api.openTerminal).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector("[data-terminal-state]")?.getAttribute("data-terminal-state")).toBe("running"));
    expect(document.querySelector(".terminal-surface")?.classList.contains("terminal-hidden")).toBe(false);
  });

  it("写入失败就地说明并保留已有输出", async () => {
    mocks.api.terminalWrite.mockRejectedValueOnce({ code: "terminal_write", message: "无法写入终端：模拟失败" });
    await renderPanel();
    const term = await waitForPanel();
    term.dataHandlers[0]("x");
    await waitFor(() => expect(screen.getByText("无法写入终端：模拟失败")).toBeTruthy());
    expect(term.writes).toContain("welcome\r\n$ ");
    expect(document.querySelector("[data-terminal-state]")?.getAttribute("data-terminal-state")).toBe("running");
  });

  it("收起再展开重新附着同一会话；浅深主题更新终端配色", async () => {
    const { view } = await renderPanel();
    const term = await waitForPanel();
    expect(term.options.theme).toMatchObject({ background: "#15181e" });

    await view.rerender({ path: repoPath, open: false, theme: "dark", onClose: vi.fn() });
    await tick();
    expect(document.querySelector(".terminal-panel")?.hasAttribute("hidden")).toBe(true);

    await view.rerender({ path: repoPath, open: true, theme: "light", onClose: vi.fn() });
    await waitFor(() => expect(mocks.api.openTerminal).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(term.options.theme).toMatchObject({ background: "#ffffff" }));
    expect(xtermMock.instances, "收起/展开不重建 xterm 实例").toHaveLength(1);
    expect(document.querySelector("[data-terminal-state]")?.getAttribute("data-terminal-state")).toBe("running");
  });

  it("切换仓库重新附着对应 sessionId 并重放该仓库的输出", async () => {
    mocks.api.openTerminal.mockImplementation(async (path: string) =>
      path === otherRepo
        ? snapshot({ sessionId: "other", repoPath: otherRepo, cwd: otherRepo, seq: 2, output: "other-history\r\n$ " })
        : snapshot(),
    );
    const { view } = await renderPanel();
    const term = await waitForPanel();
    await waitFor(() => expect(term.writes).toContain("welcome\r\n$ "));

    await view.rerender({ path: otherRepo, open: true, theme: "dark", onClose: vi.fn() });
    await waitFor(() => expect(mocks.api.openTerminal).toHaveBeenCalledWith(otherRepo));
    await waitFor(() => expect(term.writes).toContain("[reset]"));
    await waitFor(() => expect(term.writes).toContain("other-history\r\n$ "));
    expect(xtermMock.instances, "切换仓库不重建 xterm 实例").toHaveLength(1);
    expect(document.querySelector("[data-terminal-state]")?.getAttribute("data-terminal-state")).toBe("running");
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
  mocks.api.openTerminal.mockResolvedValue(snapshot());
  render(App);
  await waitFor(() => expect(document.querySelector(".welcome-recent button")).toBeTruthy());
  await fireEvent.click(document.querySelector<HTMLButtonElement>(".welcome-recent button")!);
  await waitFor(() => expect(document.querySelector(".file-list")).toBeTruthy());
  await waitFor(() => expect(document.querySelector("[data-terminal-toggle]")).toBeTruthy());
}

async function openTerminalFromStatus() {
  const toggle = document.querySelector<HTMLButtonElement>("[data-terminal-toggle]")!;
  await fireEvent.click(toggle);
  await waitFor(() => expect(mocks.api.openTerminal).toHaveBeenCalledWith(repoPath));
  await waitFor(() => expect(document.querySelector(".terminal-panel")?.hasAttribute("hidden")).toBe(false));
}

describe("外壳终端入口与关窗确认", () => {
  it("状态栏展开终端；切换视图不重建会话，也不自动调用版本、提交、标签或推送接口", async () => {
    await renderShell();
    await openTerminalFromStatus();
    const panel = document.querySelector<HTMLElement>("[data-terminal-panel]")!;
    expect(panel).toBeTruthy();
    expect(document.querySelector("[data-terminal-toggle]")?.getAttribute("aria-expanded")).toBe("true");

    // 切到文件视图：三个工作台视图之外的面板仍在，没有再次打开会话。
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", ctrlKey: true, bubbles: true }));
    await tick();
    expect(document.querySelector('.workbench-view[data-view-scope="files"][data-active="true"]')).toBeTruthy();
    expect(document.querySelector("[data-terminal-panel]")).toBe(panel);
    expect(mocks.api.openTerminal).toHaveBeenCalledTimes(1);

    // 在终端里输入普通构建命令只会写 PTY，不触发版本、提交、标签或推送接口。
    xtermMock.instances[0].dataHandlers[0]("npm run build\r");
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

  it("命令面板与状态栏是同一个终端开关：展开与收起都走同一条命令", async () => {
    await renderShell();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    const palette = await screen.findByRole("dialog", { name: "命令面板" });
    await fireEvent.click(within(palette).getByRole("option", { name: /^终端/ }));
    await waitFor(() => expect(mocks.api.openTerminal).toHaveBeenCalledWith(repoPath));
    expect(document.querySelector("[data-terminal-toggle]")?.getAttribute("aria-expanded")).toBe("true");

    await fireEvent.click(document.querySelector<HTMLButtonElement>("[data-terminal-toggle]")!);
    await waitFor(() => expect(document.querySelector("[data-terminal-panel]")?.hasAttribute("hidden")).toBe(true));
    expect(document.querySelector("[data-terminal-toggle]")?.getAttribute("aria-expanded")).toBe("false");
    expect(mocks.api.openTerminal).toHaveBeenCalledTimes(1);
  });

  it("关窗取消保持进程；确认先等待终止成功再关闭；失败保留对话框与错误", async () => {
    await renderShell();
    await waitFor(() => expect(mocks.handlers.has(TERMINAL_CLOSE_REQUESTED_EVENT)).toBe(true));
    const sessions = [{ sessionId: "s1", repoPath }];

    // 第一次：取消不调用终止，对话框收起，进程状态未被宣称结束。
    emit(TERMINAL_CLOSE_REQUESTED_EVENT, { sessions });
    const dialog = await screen.findByRole("dialog", { name: /结束终端并关闭应用/ });
    expect(within(dialog).getByText(repoPath)).toBeTruthy();
    await fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /结束终端并关闭应用/ })).toBeNull());
    expect(mocks.api.terminateTerminals).not.toHaveBeenCalled();
    expect(windowMock.close).not.toHaveBeenCalled();

    // 第二次：终止失败时对话框与真实错误保留，窗口不关闭。
    mocks.api.terminateTerminals.mockRejectedValueOnce({ code: "terminal_stop", message: "部分终端未能终止：无法确认 shell 已退出。" });
    emit(TERMINAL_CLOSE_REQUESTED_EVENT, { sessions });
    const failed = await screen.findByRole("dialog", { name: /结束终端并关闭应用/ });
    await fireEvent.click(within(failed).getByRole("button", { name: "结束终端并关闭" }));
    await waitFor(() => expect(screen.getByText("部分终端未能终止：无法确认 shell 已退出。")).toBeTruthy());
    expect(screen.getByRole("dialog", { name: /结束终端并关闭应用/ })).toBeTruthy();
    expect(windowMock.close).not.toHaveBeenCalled();

    // 第三次：终止成功后请求关闭窗口；两件事的顺序固定。
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

    // 第二次原生关窗请求到达时，确认按钮必须保持忙碌，不能被重新启用。
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
