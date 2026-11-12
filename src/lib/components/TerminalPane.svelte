<script module lang="ts">
  import type { Terminal as XTerm } from "@xterm/xterm";
  import type { FitAddon } from "@xterm/addon-fit";
  import type { SearchAddon } from "@xterm/addon-search";
  import type { WebglAddon } from "@xterm/addon-webgl";
  import type { TerminalFindOptions, TerminalFindResult } from "../terminal";

  /** 面板对单个终端的操作入口：右键菜单、查找条与工具栏都通过它驱动，不直接摸 xterm 实例。 */
  export interface TerminalPaneApi {
    focus(): void;
    hasSelection(): boolean;
    copy(): Promise<boolean>;
    paste(): Promise<void>;
    /** 把一段文本当作粘贴送进终端（拖入路径用）；终端已退出时返回 false。 */
    insert(text: string): boolean;
    /** 快照已附着（输出可写）：插入路径前等到这一步，避免把「还在附着」误报成已退出。 */
    isAttached(): boolean;
    selectAll(): void;
    clear(): void;
    /** 查找并定位；匹配计数随后经 `onFindResults` 送回（输出变化时也会更新）。 */
    find(query: string, direction: "next" | "prev", options?: Partial<TerminalFindOptions> & { incremental?: boolean }): boolean;
    clearFind(): void;
  }

  export interface TerminalPaneStatus {
    starting: boolean;
    running: boolean;
    exitCode: number | null;
    signal: string | null;
    error: string | null;
  }

  interface Modules {
    Terminal: typeof XTerm;
    FitAddon: typeof FitAddon;
    SearchAddon: typeof SearchAddon;
    WebLinksAddon: typeof import("@xterm/addon-web-links").WebLinksAddon;
    Unicode11Addon: typeof import("@xterm/addon-unicode11").Unicode11Addon;
  }

  /** xterm 与插件只加载一次，所有终端共用；加载失败时下次重试，不永久缓存失败。 */
  let modules: Promise<Modules> | null = null;
  function loadModules(): Promise<Modules> {
    if (!modules) {
      modules = Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-unicode11"),
      ]).then(
        ([xterm, fit, search, links, unicode]) => ({
          Terminal: xterm.Terminal,
          FitAddon: fit.FitAddon,
          SearchAddon: search.SearchAddon,
          WebLinksAddon: links.WebLinksAddon,
          Unicode11Addon: unicode.Unicode11Addon,
        }),
        (error) => {
          modules = null;
          throw error;
        },
      );
    }
    return modules;
  }

  /** 用户打开终端时，与后端启动 shell 并行加载前端模块。 */
  export function preloadTerminal(): void {
    void loadModules().catch(() => {});
  }

  /** WebGL 渲染器单独加载：不可用（驱动、上下文数量上限）时保留 DOM 渲染，不影响终端可用。 */
  let webglDisabled = false;

  const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "");
  const FALLBACK_FONT = '"Cascadia Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
</script>

<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import {
    readTerminalTheme,
    terminalFindDecorations,
    TERMINAL_FIND_LIMIT,
    stripWindowsTerminalReplies,
    terminalEventApplies,
    terminalKeyAction,
    type TerminalKeyAction,
    type TerminalRouter,
  } from "../terminal";
  import type { TerminalExitEvent, TerminalOutputEvent } from "../types";
  import Icon from "./Icon.svelte";

  /**
   * 一个终端会话的画面：只消费 terminal.rs 的结构化 IPC，不解析命令、也不判断构建或发布结果。
   * 挂载时先订阅事件再附着快照，快照之后的输出按序号补上，重放不重复、不丢失。
   */
  interface Props {
    sessionId: string;
    router: TerminalRouter;
    /** 所在标签页是否正在显示（面板展开且标签页激活）。隐藏时不测量尺寸。 */
    visible: boolean;
    /** 是否是当前聚焦的终端；变为 true 且可见时把键盘焦点给它。 */
    focused: boolean;
    theme: "light" | "dark";
    fontSize: number;
    label: string;
    /** 并排显示时才显示的小标题，用来分辨焦点在哪一格。 */
    showLabel?: boolean;
    /** 正有文件拖到这一格上方：显示放下提示。 */
    dropActive?: boolean;
    onStatus: (sessionId: string, status: TerminalPaneStatus) => void;
    onFocus: (sessionId: string) => void;
    onAction: (sessionId: string, action: TerminalKeyAction) => void;
    onContextMenu: (sessionId: string, event: MouseEvent) => void;
    onRestart: (sessionId: string) => Promise<void>;
    onClosePane: (sessionId: string) => void;
    /** 查找匹配数变化（含输出刷新后的重算）。 */
    onFindResults?: (sessionId: string, result: TerminalFindResult) => void;
    register: (sessionId: string, api: TerminalPaneApi | null) => void;
  }

  let {
    sessionId,
    router,
    visible,
    focused,
    theme,
    fontSize,
    label,
    showLabel = false,
    dropActive = false,
    onStatus,
    onFocus,
    onAction,
    onContextMenu,
    onRestart,
    onClosePane,
    onFindResults,
    register,
  }: Props = $props();

  let host: HTMLDivElement;
  let term: XTerm | null = null;
  let fit: FitAddon | null = null;
  let search: SearchAddon | null = null;
  let webgl: WebglAddon | null = null;
  let webglLoading = false;
  let disposed = false;
  let attached = false;
  let lastSeq = 0;
  let pending: ({ kind: "output" } & TerminalOutputEvent | { kind: "exit" } & TerminalExitEvent)[] = [];
  let lastSize = "";
  let fitFrame = 0;

  let starting = $state(true);
  let running = $state(false);
  let exitCode = $state<number | null>(null);
  let signalName = $state<string | null>(null);
  let attachError = $state<string | null>(null);
  let writeError = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let linkHint = $state<{ x: number; y: number } | null>(null);
  let restarting = $state(false);

  let exited = $derived(!starting && attachError === null && !running);
  let exitText = $derived(signalName ? `进程已退出 · ${signalName}` : `进程已退出 · 退出码 ${exitCode ?? "未知"}`);

  $effect(() => {
    const status: TerminalPaneStatus = { starting, running, exitCode, signal: signalName, error: attachError };
    untrack(() => onStatus(sessionId, status));
  });

  $effect(() => {
    // 浅深主题与字号原地更新，不重建 xterm；主题属性可能在同一轮里才落到根元素上，下一帧再读一次。
    void theme;
    void fontSize;
    untrack(() => {
      applyAppearance();
      requestFrame(applyAppearance);
    });
  });

  $effect(() => {
    const show = visible;
    const wants = focused;
    untrack(() => {
      if (!show) {
        releaseWebgl();
        return;
      }
      if (term) void loadWebgl(term);
      scheduleFit();
      if (wants) requestFrame(() => term?.focus());
    });
  });

  function requestFrame(callback: () => void): number {
    if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
    return setTimeout(callback, 16) as unknown as number;
  }

  function cssValue(token: string): string {
    if (!host || typeof getComputedStyle !== "function") return "";
    return getComputedStyle(host).getPropertyValue(token);
  }

  function applyAppearance() {
    if (!term) return;
    term.options.theme = readTerminalTheme(cssValue);
    if (term.options.fontSize !== fontSize) {
      term.options.fontSize = fontSize;
      scheduleFit();
    }
  }

  onMount(() => {
    disposed = false;
    let stopEvents = () => {};
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => scheduleFit());
      observer.observe(host);
    }
    void (async () => {
      let loaded: Modules;
      try {
        loaded = await loadModules();
      } catch (error) {
        if (disposed) return;
        attachError = normalizeError(error).message;
        starting = false;
        return;
      }
      if (disposed) return;
      const instance = new loaded.Terminal({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: "bar",
        cursorInactiveStyle: "outline",
        fontSize,
        fontFamily: cssValue("--mono").trim() || FALLBACK_FONT,
        lineHeight: 1.2,
        letterSpacing: 0,
        scrollback: 10000,
        smoothScrollDuration: 0,
        fastScrollModifier: "alt",
        // 浅色画布上程序自带的真彩色也保持可读，与常见编辑器终端的缺省一致。
        minimumContrastRatio: 4.5,
        macOptionIsMeta: true,
        rightClickSelectsWord: false,
        theme: readTerminalTheme(cssValue),
      });
      const fitAddon = new loaded.FitAddon();
      const searchAddon = new loaded.SearchAddon({ highlightLimit: TERMINAL_FIND_LIMIT });
      searchAddon.onDidChangeResults?.(({ resultIndex, resultCount }) => {
        onFindResults?.(sessionId, { index: resultIndex, count: resultCount });
      });
      instance.loadAddon(fitAddon);
      instance.loadAddon(searchAddon);
      instance.loadAddon(
        new loaded.WebLinksAddon((event, uri) => openLink(event, uri), {
          hover: (event) => {
            const rect = host.getBoundingClientRect();
            linkHint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
          },
          leave: () => {
            linkHint = null;
          },
        }),
      );
      try {
        instance.loadAddon(new loaded.Unicode11Addon());
        instance.unicode.activeVersion = "11";
      } catch {
        // 宽字符表不可用时保留 xterm 自带的 Unicode 6 宽度。
      }
      instance.open(host);
      instance.attachCustomKeyEventHandler((event) => handleKey(event));
      instance.onData((data) => void sendInput(data));
      instance.onResize(({ rows, cols }) => sendSize(rows, cols));
      term = instance;
      fit = fitAddon;
      search = searchAddon;
      void loadWebgl(instance);
      register(sessionId, paneApi);
      fitNow();

      stopEvents = router.subscribe(sessionId, {
        output: (event) => {
          if (!attached && starting) pending.push({ kind: "output", ...event });
          else if (!attached) return;
          else applyOutput(event);
        },
        exit: (event) => {
          if (!attached && starting) pending.push({ kind: "exit", ...event });
          else if (!attached) return;
          else applyExit(event);
        },
      });
      try {
        await router.start();
      } catch {
        // 事件订阅失败时仍附着一次快照：至少能看到已有输出，新输出由下一次附着补上。
      }
      if (disposed) return;
      await attach();
    })();
    return () => {
      disposed = true;
      attached = false;
      pending = [];
      stopEvents();
      observer?.disconnect();
      if (fitFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(fitFrame);
      register(sessionId, null);
      releaseWebgl();
      term?.dispose();
      term = null;
      fit = null;
      search = null;
    };
  });

  async function loadWebgl(instance: XTerm) {
    if (webglDisabled || !visible || webgl || webglLoading) return;
    webglLoading = true;
    let addon: WebglAddon | null = null;
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      if (disposed || term !== instance || !visible) return;
      addon = new WebglAddon();
      addon.onContextLoss(() => releaseWebgl());
      instance.loadAddon(addon);
      webgl = addon;
    } catch {
      addon?.dispose();
      // 没有 WebGL：本次运行都用 DOM 渲染，不再反复尝试。
      webglDisabled = true;
    } finally {
      webglLoading = false;
    }
  }

  /** 隐藏标签页只保留终端文本状态，释放 WebGL 渲染器与纹理；再次显示时恢复加速。 */
  function releaseWebgl() {
    const addon = webgl;
    webgl = null;
    addon?.dispose();
  }

  async function attach() {
    starting = true;
    attachError = null;
    try {
      const snapshot = await api.terminalAttach(sessionId);
      if (disposed) return;
      running = snapshot.running;
      exitCode = snapshot.exitCode;
      signalName = snapshot.signal;
      lastSeq = snapshot.seq;
      if (snapshot.output) term?.write(snapshot.output);
      attached = true;
      const buffered = pending;
      pending = [];
      for (const event of buffered) {
        if (event.kind === "output") applyOutput(event);
        else applyExit(event);
      }
      // 后端新建 PTY 固定 24×80：附着后必须补一次真实尺寸，否则换行和全屏程序会错位。
      lastSize = "";
      fitNow();
      if (term) sendSize(term.rows, term.cols);
    } catch (error) {
      if (disposed) return;
      pending = [];
      attachError = normalizeError(error).message;
    } finally {
      if (!disposed) starting = false;
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
    if (!attached) return;
    if (!running) {
      writeError = "终端已退出，无法继续输入；请重新启动这个会话。";
      return;
    }
    const payload = IS_WINDOWS ? stripWindowsTerminalReplies(data) : data;
    if (!payload) return;
    try {
      await api.terminalWrite(sessionId, payload);
      writeError = null;
    } catch (error) {
      const failure = normalizeError(error);
      writeError = failure.message;
      if (failure.code === "terminal_closed") running = false;
    }
  }

  /** 行列变化才发给后端；失败只影响尺寸，不改变会话状态，下一次变化还会再同步。 */
  function sendSize(rows: number, cols: number) {
    if (!attached || !running || !rows || !cols) return;
    const size = `${rows}x${cols}`;
    if (size === lastSize) return;
    lastSize = size;
    void api.terminalResize(sessionId, rows, cols).catch(() => {
      lastSize = "";
    });
  }

  /** 拖动面板高度、窗口缩放时合并到下一帧再测量，避免每个像素都重排一次。 */
  function scheduleFit() {
    if (fitFrame) return;
    fitFrame = requestFrame(() => {
      fitFrame = 0;
      fitNow();
    });
  }

  function fitNow() {
    if (!fit || !visible || !host) return;
    if (!host.clientWidth || !host.clientHeight) return;
    try {
      fit.fit();
    } catch {
      // 容器暂时不可测量时跳过；下次可见会重新测量。
    }
  }

  function handleKey(event: KeyboardEvent): boolean {
    const action = terminalKeyAction(event, IS_MAC, term?.hasSelection() ?? false);
    if (!action) return true;
    // 粘贴交给浏览器的原生 paste 事件，由 xterm 处理换行与括号粘贴；这里只让 xterm 别把它当成 ^V。
    if (action === "paste") return false;
    if (event.type === "keydown") {
      event.preventDefault();
      if (action === "copy") void copySelection(true);
      else onAction(sessionId, action);
    }
    return false;
  }

  async function copySelection(clearAfter: boolean): Promise<boolean> {
    const text = term?.getSelection() ?? "";
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      if (clearAfter) term?.clearSelection();
      notice = null;
      return true;
    } catch {
      notice = "无法写入剪贴板。";
      return false;
    }
  }

  async function pasteClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) term?.paste(text);
      notice = null;
    } catch {
      notice = `无法读取剪贴板，请改用 ${IS_MAC ? "⌘V" : "Ctrl+V"} 粘贴。`;
    }
    term?.focus();
  }

  function openLink(event: MouseEvent, uri: string) {
    // 和常见编辑器终端一致：按住 Ctrl/⌘ 单击才打开，普通单击仍用于选择文本。
    if (!(event.ctrlKey || event.metaKey)) return;
    void api.openDocumentUrl(uri).catch((error) => {
      notice = normalizeError(error).message;
    });
  }

  const paneApi: TerminalPaneApi = {
    focus: () => term?.focus(),
    hasSelection: () => term?.hasSelection() ?? false,
    copy: () => copySelection(false),
    paste: () => pasteClipboard(),
    insert: (text) => {
      if (!term || !text) return false;
      if (!attached || !running) {
        writeError = "终端已退出，无法插入路径；请重新启动这个会话。";
        return false;
      }
      term.paste(text);
      term.focus();
      return true;
    },
    isAttached: () => attached,
    selectAll: () => term?.selectAll(),
    clear: () => {
      term?.clear();
      term?.focus();
    },
    find: (query, direction, settings = {}) => {
      if (!search || !query) return false;
      const options = {
        incremental: settings.incremental ?? false,
        caseSensitive: settings.caseSensitive ?? false,
        wholeWord: settings.wholeWord ?? false,
        regex: settings.regex ?? false,
        // 加亮全部匹配：xterm 只在开了加亮时才回报计数，也让人一眼看到所有命中位置。
        decorations: terminalFindDecorations(cssValue),
      };
      return direction === "prev" ? search.findPrevious(query, options) : search.findNext(query, options);
    },
    clearFind: () => {
      search?.clearDecorations();
      term?.clearSelection();
    },
  };

  async function restart() {
    if (restarting) return;
    restarting = true;
    try {
      await onRestart(sessionId);
    } finally {
      // 成功时本组件会被新会话替换卸载；失败时恢复按钮，错误由面板就地说明。
      if (!disposed) restarting = false;
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="terminal-pane"
  class:focused
  class:drop-active={dropActive}
  data-terminal-pane={sessionId}
  data-terminal-session-state={attachError ? "failed" : starting ? "starting" : running ? "running" : "exited"}
  onfocusin={() => onFocus(sessionId)}
  onpointerdown={() => onFocus(sessionId)}
  oncontextmenu={(event) => {
    event.preventDefault();
    onFocus(sessionId);
    onContextMenu(sessionId, event);
  }}
>
  {#if showLabel}
    <div class="terminal-pane-label" aria-hidden="true">{label}</div>
  {/if}
  {#if attachError}
    <div class="terminal-notice error" role="alert" data-terminal-error>
      <Icon name="alert-circle" size={14} />
      <span>{attachError}</span>
      <button type="button" class="btn btn-secondary btn-sm" onclick={() => onClosePane(sessionId)}>关闭</button>
    </div>
  {/if}
  {#if writeError}
    <div class="terminal-notice warn" role="alert" data-terminal-write-error>
      <Icon name="alert" size={14} />
      <span>{writeError}</span>
    </div>
  {/if}
  {#if notice}
    <div class="terminal-notice warn" role="status">
      <Icon name="info" size={14} />
      <span>{notice}</span>
      <button type="button" class="icon-btn sm" aria-label="关闭提示" onclick={() => (notice = null)}><Icon name="x" size={12} /></button>
    </div>
  {/if}
  <div class="terminal-surface" class:terminal-hidden={attachError !== null} bind:this={host}></div>
  {#if linkHint}
    <div class="terminal-link-hint" style={`left:${linkHint.x}px;top:${linkHint.y}px`} aria-hidden="true">
      {IS_MAC ? "⌘" : "Ctrl"}+单击打开链接
    </div>
  {/if}
  {#if dropActive}
    <div class="terminal-drop-hint" data-terminal-drop-hint aria-hidden="true">
      <Icon name="terminal" size={16} />松开以插入路径
    </div>
  {/if}
  {#if exited}
    <div class="terminal-exit" data-terminal-exit role="status">
      <span class="terminal-exit-text">{exitText}</span>
      <span class="terminal-exit-note">输出已保留</span>
      <span class="terminal-spacer"></span>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        data-terminal-restart
        disabled={restarting}
        title={restarting ? "正在重新启动" : "用同一种终端重新启动；当前输出会被清空"}
        onclick={restart}
      >
        <Icon name="refresh" size={12} />重新启动
      </button>
      <button type="button" class="btn btn-ghost btn-sm" data-terminal-dismiss onclick={() => onClosePane(sessionId)}>关闭</button>
    </div>
  {/if}
</div>
