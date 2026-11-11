<script module lang="ts">
  /** 后端事件名：与 src-tauri/src/terminal.rs 的常量一致。 */
  export const TERMINAL_OUTPUT_EVENT = "terminal-output";
  export const TERMINAL_EXIT_EVENT = "terminal-exit";
  export const TERMINAL_CLOSE_REQUESTED_EVENT = "terminal-close-requested";

  /**
   * 一个输出/退出事件是否应写入当前终端：只接受当前附着的 sessionId，并丢弃快照已经覆盖的旧序号。
   * 这条判定同时挡掉「切换仓库后旧会话的迟到事件」和「重放时重复写入」。
   */
  export function terminalEventApplies(
    currentSession: string | null,
    eventSession: string,
    seq: number,
    lastSeq: number,
  ): boolean {
    return currentSession !== null && eventSession === currentSession && seq > lastSeq;
  }

  /** 面板标题行的一句话状态；退出码与信号都如实显示，启动失败不伪装成运行中的终端。 */
  export function terminalStatusLabel(state: {
    starting: boolean;
    failed: boolean;
    sessionId: string | null;
    running: boolean;
    exitCode: number | null;
    signal: string | null;
  }): string {
    if (state.starting) return "正在启动…";
    if (state.failed) return "启动失败";
    if (!state.sessionId) return "未连接";
    if (state.running) return "运行中";
    if (state.signal) return `已退出 · ${state.signal}`;
    return `已退出 · 退出码 ${state.exitCode ?? "未知"}`;
  }

  /** xterm 的取色跟随应用 token 的浅深结果；面板本身仍由 terminal.css 绘制背景。 */
  export const TERMINAL_THEMES = {
    dark: {
      background: "#15181e",
      foreground: "#d8dee9",
      cursor: "#8ab4f8",
      selectionBackground: "#3b4a63",
      black: "#1b1f27",
      red: "#f07178",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#c0caf5",
    },
    light: {
      background: "#ffffff",
      foreground: "#24292f",
      cursor: "#0969da",
      selectionBackground: "#b6d7ff",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#7d4e00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
    },
  } as const;
</script>

<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { Terminal as XTerm } from "@xterm/xterm";
  import type { FitAddon } from "@xterm/addon-fit";
  import { api, listenEvent } from "../api";
  import { normalizeError } from "../errors";
  import type { TerminalExitEvent, TerminalOutputEvent, TerminalSnapshot } from "../types";
  import Icon from "./Icon.svelte";

  /**
   * 工作台底部终端：只消费 terminal.rs 的结构化 IPC，不解析命令、也不判断构建或发布结果。
   * 会话按仓库保存在后端；这里展开/切仓库时重新附着同一 sessionId，用快照重放隐藏期间的输出。
   * 面板在视图切换时保持挂载，收起只隐藏 DOM，不重建 xterm 或后端会话。
   */
  interface Props {
    /** 当前仓库根目录；切换仓库时后端返回该仓库自己的 sessionId。 */
    path: string;
    /** 状态栏与命令面板共同控制的展开状态。 */
    open: boolean;
    theme: "light" | "dark";
    onClose: () => void;
  }

  let { path, open, theme, onClose }: Props = $props();

  let surface: HTMLDivElement;
  let term: XTerm | null = null;
  let fitAddon: FitAddon | null = null;
  let initPromise: Promise<boolean> | null = null;
  let disposed = false;
  let eventsReady = false;
  let stopEvents: (() => void)[] = [];

  let sessionId = $state<string | null>(null);
  let running = $state(false);
  let exitCode = $state<number | null>(null);
  let signalName = $state<string | null>(null);
  let starting = $state(false);
  let startError = $state<string | null>(null);
  let writeError = $state<string | null>(null);
  let lastSeq = 0;
  let attachSerial = 0;
  let attaching = false;
  let pending: ({ kind: "output" } & TerminalOutputEvent | { kind: "exit" } & TerminalExitEvent)[] = [];

  let statusText = $derived(
    terminalStatusLabel({ starting, failed: startError !== null, sessionId, running, exitCode, signal: signalName }),
  );
  let stateName = $derived(
    startError !== null ? "failed" : starting ? "starting" : sessionId === null ? "idle" : running ? "running" : "exited",
  );

  function applyThemeOptions() {
    if (!term) return;
    term.options.theme = theme === "light" ? TERMINAL_THEMES.light : TERMINAL_THEMES.dark;
  }

  $effect(() => {
    // 只跟随外部主题；term 本身不是响应式对象，浅深切换时原地替换配色。
    const mode = theme;
    void mode;
    applyThemeOptions();
  });

  $effect(() => {
    const isOpen = open;
    const repo = path;
    const serial = ++attachSerial;
    if (!isOpen || !repo) {
      // 收起或没有仓库：停止缓冲在途事件；下次展开用新快照重放。
      attaching = false;
      pending = [];
      starting = false;
      return;
    }
    void tick().then(async () => {
      if (disposed || serial !== attachSerial) return;
      if (!(await ensureTerminal())) return;
      if (disposed || serial !== attachSerial) return;
      fitTerminal();
      await attach(repo, serial, false);
      if (!disposed && serial === attachSerial) term?.focus();
    });
  });

  onMount(() => {
    disposed = false;
    const onWindowResize = () => fitTerminal();
    window.addEventListener("resize", onWindowResize);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function" && surface) {
      observer = new ResizeObserver(() => fitTerminal());
      observer.observe(surface);
    }
    return () => {
      disposed = true;
      attachSerial += 1;
      window.removeEventListener("resize", onWindowResize);
      observer?.disconnect();
      stopEvents.forEach((stop) => stop());
      stopEvents = [];
      term?.dispose();
      term = null;
      fitAddon = null;
      initPromise = null;
    };
  });

  async function ensureTerminal(): Promise<boolean> {
    if (term) return true;
    if (!initPromise) {
      initPromise = (async () => {
        try {
          const [{ Terminal }, { FitAddon }] = await Promise.all([
            import("@xterm/xterm"),
            import("@xterm/addon-fit"),
          ]);
          if (disposed) return false;
          const instance = new Terminal({
            convertEol: false,
            cursorBlink: true,
            fontSize: 12.5,
            fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, "Liberation Mono", monospace',
            scrollback: 5000,
            theme: theme === "light" ? TERMINAL_THEMES.light : TERMINAL_THEMES.dark,
          });
          const addon = new FitAddon();
          instance.loadAddon(addon);
          instance.open(surface);
          instance.onData((data) => void sendInput(data));
          instance.onResize(({ rows, cols }) => {
            const id = sessionId;
            if (!id || !running) return;
            void api.terminalResize(id, rows, cols).catch(() => {
              // resize 失败不改变会话状态：下一次 fit 或输入仍会继续尝试。
            });
          });
          term = instance;
          fitAddon = addon;
          applyThemeOptions();
          return true;
        } catch (error) {
          // 模块加载失败也允许「重试启动」重新尝试，而不是永远复用失败的初始化。
          initPromise = null;
          startError = normalizeError(error).message;
          return false;
        }
      })();
    }
    return initPromise;
  }

  async function ensureEvents(): Promise<void> {
    if (eventsReady) return;
    eventsReady = true;
    try {
      const stopOutput = await listenEvent<TerminalOutputEvent>(TERMINAL_OUTPUT_EVENT, (event) => {
        if (attaching) {
          pending.push({ kind: "output", ...event });
          return;
        }
        applyOutput(event);
      });
      const stopExit = await listenEvent<TerminalExitEvent>(TERMINAL_EXIT_EVENT, (event) => {
        if (attaching) {
          pending.push({ kind: "exit", ...event });
          return;
        }
        applyExit(event);
      });
      if (disposed) {
        stopOutput();
        stopExit();
        return;
      }
      stopEvents.push(stopOutput, stopExit);
    } catch {
      eventsReady = false;
    }
  }

  async function attach(repo: string, serial: number, restart: boolean): Promise<void> {
    await ensureEvents();
    if (disposed || serial !== attachSerial) return;
    starting = true;
    startError = null;
    writeError = null;
    attaching = true;
    pending = [];
    sessionId = null;
    running = false;
    exitCode = null;
    signalName = null;
    lastSeq = 0;
    term?.reset();
    try {
      const snapshot: TerminalSnapshot = restart
        ? await api.restartTerminal(repo)
        : await api.openTerminal(repo);
      if (disposed || serial !== attachSerial) return;
      sessionId = snapshot.sessionId;
      running = snapshot.running;
      exitCode = snapshot.exitCode;
      signalName = snapshot.signal;
      lastSeq = snapshot.seq;
      if (snapshot.output) term?.write(snapshot.output);
      attaching = false;
      const buffered = pending;
      pending = [];
      for (const event of buffered) {
        if (event.kind === "output") applyOutput(event);
        else applyExit(event);
      }
      // attach 前那次 fit 发生在 sessionId 还是 null/旧会话的时候，onResize 不会发给新会话；
      // 后端新建 PTY 固定 24×80，所以拿到快照后必须补一次真实尺寸，否则换行和全屏程序会错位。
      if (snapshot.running) syncTerminalSize(snapshot.sessionId);
    } catch (error) {
      // 已被新的附着取代时不要碰共用的 attaching/pending，否则会吞掉新会话的事件。
      if (disposed || serial !== attachSerial) return;
      attaching = false;
      pending = [];
      startError = normalizeError(error).message;
    } finally {
      if (serial === attachSerial) starting = false;
    }
  }

  function applyOutput(event: TerminalOutputEvent) {
    if (!terminalEventApplies(sessionId, event.sessionId, event.seq, lastSeq)) return;
    lastSeq = event.seq;
    term?.write(event.data);
  }

  function applyExit(event: TerminalExitEvent) {
    if (!terminalEventApplies(sessionId, event.sessionId, event.seq, lastSeq)) return;
    lastSeq = event.seq;
    running = false;
    exitCode = event.exitCode;
    signalName = event.signal;
  }

  async function sendInput(data: string) {
    const id = sessionId;
    if (!id) return;
    if (!running) {
      writeError = "终端已退出，无法继续输入；请重新启动这个会话。";
      return;
    }
    try {
      await api.terminalWrite(id, data);
      writeError = null;
    } catch (error) {
      const failure = normalizeError(error);
      writeError = failure.message;
      if (failure.code === "terminal_closed") running = false;
    }
  }

  /** 把当前 xterm 的行列数同步给指定会话；失败只影响尺寸，不改变会话状态。 */
  function syncTerminalSize(id: string) {
    if (!term || !running || !id) return;
    const rows = term.rows;
    const cols = term.cols;
    if (!rows || !cols) return;
    void api.terminalResize(id, rows, cols).catch(() => {
      // resize 失败不冒充会话结束；下一次 attach/窗口变化还会再同步。
    });
  }

  function fitTerminal() {
    if (!open || !fitAddon) return;
    try {
      fitAddon.fit();
    } catch {
      // 容器暂时不可测量（收起或被隐藏）时跳过；下次展开会重新 fit。
    }
  }

  async function restart() {
    if (starting) return;
    const serial = ++attachSerial;
    if (!(await ensureTerminal())) return;
    if (disposed || serial !== attachSerial) return;
    fitTerminal();
    await attach(path, serial, true);
    if (!disposed && serial === attachSerial) term?.focus();
  }

  async function retryStart() {
    if (starting) return;
    const serial = ++attachSerial;
    if (!(await ensureTerminal())) return;
    if (disposed || serial !== attachSerial) return;
    fitTerminal();
    await attach(path, serial, false);
    if (!disposed && serial === attachSerial) term?.focus();
  }
</script>

<aside class="terminal-panel" data-terminal-panel aria-label="终端" hidden={!open}>
  <div class="terminal-head">
    <span class="terminal-title"><Icon name="code" size={13} />终端</span>
    <span class="terminal-status" data-terminal-state={stateName} role="status" aria-live="polite">{statusText}</span>
    <span class="terminal-path" title={path}>{path}</span>
    <span class="terminal-spacer"></span>
    {#if sessionId && !running && !starting}
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        data-terminal-restart
        title={startError ? "重新尝试启动这个仓库的终端" : "结束的会话保留输出；重新启动会新建一个 shell"}
        onclick={() => void restart()}
      >
        <Icon name="refresh" size={12} />重新启动
      </button>
    {/if}
    <button
      type="button"
      class="icon-btn sm"
      aria-label="收起终端"
      title="收起底部终端，命令继续运行"
      onclick={onClose}
    >
      <Icon name="chevron-down" size={14} />
    </button>
  </div>
  {#if startError}
    <div class="terminal-notice error" role="alert" data-terminal-error>
      <Icon name="alert-circle" size={14} />
      <span>{startError}</span>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        data-terminal-retry
        title="重新尝试启动这个仓库的终端"
        onclick={() => void retryStart()}
      >
        重试启动
      </button>
    </div>
  {/if}
  {#if writeError}
    <div class="terminal-notice warn" role="alert" data-terminal-write-error>
      <Icon name="alert" size={14} />
      <span>{writeError}</span>
    </div>
  {/if}
  <div class="terminal-body">
    <div class="terminal-surface" class:terminal-hidden={startError !== null} bind:this={surface}></div>
  </div>
</aside>
