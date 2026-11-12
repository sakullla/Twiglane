<script module lang="ts">
  /* 旧入口的名字：外壳与测试仍从这里取事件名与判定函数，实现统一在 ../terminal.ts。 */
  import * as terminalModel from "../terminal";
  export const TERMINAL_OUTPUT_EVENT = terminalModel.TERMINAL_OUTPUT_EVENT;
  export const TERMINAL_EXIT_EVENT = terminalModel.TERMINAL_EXIT_EVENT;
  export const TERMINAL_CLOSE_REQUESTED_EVENT = terminalModel.TERMINAL_CLOSE_REQUESTED_EVENT;
  export const stripWindowsTerminalReplies = terminalModel.stripWindowsTerminalReplies;
  export const terminalEventApplies = terminalModel.terminalEventApplies;
  export const terminalStatusLabel = terminalModel.terminalStatusLabel;

  const HEIGHT_KEY = "twiglane.terminal.height";
  const MIN_HEIGHT = 140;
  /** 面板之上至少给工作台留出这么高，拖到底也还能看见标题栏下的内容。 */
  const WORKBENCH_RESERVE = 200;

  function loadHeight(): number | null {
    try {
      const value = Number(localStorage.getItem(HEIGHT_KEY));
      return Number.isFinite(value) && value >= MIN_HEIGHT ? value : null;
    } catch {
      return null;
    }
  }

  const IS_MAC_PANEL = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "");
  const MOD = IS_MAC_PANEL ? "⌘" : "Ctrl";
</script>

<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { api, listenEvent } from "../api";
  import { normalizeError } from "../errors";
  import {
    MAX_PANES_PER_GROUP,
    MAX_TERMINALS_PER_REPO,
    TERMINAL_FONT_DEFAULT,
    TerminalRouter,
    addGroup,
    clampFontSize,
    cycleGroup,
    emptyLayout,
    focusSession,
    groupOf,
    groupTitles,
    layoutFromSessions,
    removeSession,
    renameGroup,
    replaceSession,
    selectGroup,
    sessionCount,
    shellLabel,
    splitGroup,
    terminalStateName,
    type TerminalKeyAction,
    type TerminalLayout,
  } from "../terminal";
  import type { TerminalProfile, TerminalSnapshot } from "../types";
  import ContextMenu, { pointFor, type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";
  import TerminalPane, { type TerminalPaneApi, type TerminalPaneStatus } from "./TerminalPane.svelte";

  /**
   * 工作台底部终端：多标签页、标签页内并排拆分、按仓库保存。
   * 会话保存在后端；切换仓库时卸载画面，回来后按后端列表与快照重新附着，输出不丢。
   * 面板在视图切换时保持挂载，收起只隐藏 DOM，不重建 xterm 或后端会话。
   */
  interface Props {
    /** 当前仓库根目录；每个仓库有自己的一组终端。 */
    path: string;
    /** 状态栏与命令面板共同控制的展开状态。 */
    open: boolean;
    theme: "light" | "dark";
    /** 终端字号（设置里保存）；缩放快捷键通过 onFontSize 改它。 */
    fontSize?: number;
    /** 设置里的默认终端类型 id；null 表示平台默认（探测结果第一项）。 */
    defaultProfile?: string | null;
    onClose: () => void;
    onFontSize?: (size: number) => void;
    /** 打开设置的终端分区（「设置默认终端…」入口）。 */
    onOpenSettings?: () => void;
    /** 当前仓库的终端数量变化，用于状态栏的数量提示。 */
    onCountChange?: (count: number) => void;
  }

  let {
    path,
    open,
    theme,
    fontSize = TERMINAL_FONT_DEFAULT,
    defaultProfile = null,
    onClose,
    onFontSize = () => {},
    onOpenSettings,
    onCountChange,
  }: Props = $props();

  interface SessionInfo {
    label: string;
    profile: string;
    status: TerminalPaneStatus;
  }

  const router = new TerminalRouter(listenEvent);
  const paneApis = new Map<string, TerminalPaneApi>();

  let layouts = $state<Record<string, TerminalLayout>>({});
  let infos = $state<Record<string, SessionInfo>>({});
  let booting = $state<Record<string, boolean>>({});
  let bootErrors = $state<Record<string, string | null>>({});
  let actionError = $state<string | null>(null);
  let creating = $state(false);
  let profiles = $state<TerminalProfile[]>([]);
  let maximized = $state(false);
  let height = $state<number | null>(loadHeight());
  let menu = $state<ContextMenuRequest | null>(null);
  let findOpen = $state(false);
  let findQuery = $state("");
  let findMiss = $state(false);
  let renaming = $state<string | null>(null);
  let renameValue = $state("");
  let panel: HTMLElement;
  let findInput = $state<HTMLInputElement | null>(null);

  let layout = $derived(layouts[path] ?? emptyLayout());
  let count = $derived(sessionCount(layout));
  let bootError = $derived(bootErrors[path] ?? null);
  let isBooting = $derived(booting[path] === true);
  let activeGroup = $derived(layout.groups.find((group) => group.id === layout.activeGroup) ?? null);
  let titles = $derived(groupTitles(layout, (id) => infos[id]?.label ?? "终端"));
  let focusedInfo = $derived(layout.focused ? (infos[layout.focused] ?? null) : null);
  let atLimit = $derived(count >= MAX_TERMINALS_PER_REPO);
  let splitFull = $derived((activeGroup?.panes.length ?? 0) >= MAX_PANES_PER_GROUP);
  let limitReason = $derived(atLimit ? `每个仓库最多 ${MAX_TERMINALS_PER_REPO} 个终端，请先关闭不用的终端` : "");
  let splitReason = $derived(limitReason || (splitFull ? `一个标签页最多并排 ${MAX_PANES_PER_GROUP} 个终端` : ""));

  let statusInput = $derived({
    starting: isBooting || (focusedInfo?.status.starting ?? false),
    failed: bootError !== null || Boolean(focusedInfo?.status.error),
    sessionId: layout.focused,
    running: focusedInfo?.status.running ?? false,
    exitCode: focusedInfo?.status.exitCode ?? null,
    signal: focusedInfo?.status.signal ?? null,
  });
  let statusText = $derived(terminalStatusLabel(statusInput));
  let stateName = $derived(terminalStateName(statusInput));

  $effect(() => {
    const value = count;
    untrack(() => onCountChange?.(value));
  });

  $effect(() => {
    const isOpen = open;
    const repo = path;
    if (!isOpen || !repo) return;
    untrack(() => {
      const current = layouts[repo];
      if ((!current || sessionCount(current) === 0) && !booting[repo]) void bootstrap(repo);
    });
  });

  onMount(() => {
    const onWindowResize = () => {
      if (height !== null) height = clampHeight(height);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
      router.dispose();
    };
  });

  /* ------------------------------------------------------------ 会话 */

  function remember(snapshot: TerminalSnapshot) {
    infos[snapshot.sessionId] = {
      label: snapshot.label || shellLabel(snapshot.shell),
      profile: snapshot.profile ?? "",
      status: {
        starting: true,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        signal: snapshot.signal,
        error: null,
      },
    };
  }

  function forget(sessionId: string) {
    delete infos[sessionId];
    paneApis.delete(sessionId);
  }

  function repoOf(sessionId: string): string | null {
    for (const [repo, value] of Object.entries(layouts)) {
      if (groupOf(value, sessionId)) return repo;
    }
    return null;
  }

  /** 首次展开某个仓库：先恢复后端已有会话，没有才新建一个。返回是否新建过。 */
  async function bootstrap(repo: string): Promise<boolean> {
    booting[repo] = true;
    bootErrors[repo] = null;
    try {
      const existing = await api.terminalList(repo);
      if (existing.length > 0) {
        existing.forEach(remember);
        layouts[repo] = layoutFromSessions(existing.map((snapshot) => snapshot.sessionId));
        return false;
      }
      const snapshot = await api.terminalCreate(repo, null);
      remember(snapshot);
      layouts[repo] = addGroup(emptyLayout(), snapshot.sessionId);
      return true;
    } catch (error) {
      bootErrors[repo] = normalizeError(error).message;
      return false;
    } finally {
      booting[repo] = false;
    }
  }

  /** 新建终端：`split` 时并排进当前标签页，否则开新标签页。 */
  async function create(profile: string | null, split: boolean) {
    const repo = path;
    if (!repo || creating) return;
    if (sessionCount(layouts[repo] ?? emptyLayout()) >= MAX_TERMINALS_PER_REPO) {
      actionError = limitReason || `每个仓库最多 ${MAX_TERMINALS_PER_REPO} 个终端，请先关闭不用的终端`;
      return;
    }
    creating = true;
    actionError = null;
    try {
      const snapshot = await api.terminalCreate(repo, profile);
      remember(snapshot);
      const current = layouts[repo] ?? emptyLayout();
      layouts[repo] = split ? splitGroup(current, current.activeGroup, snapshot.sessionId) : addGroup(current, snapshot.sessionId);
      bootErrors[repo] = null;
    } catch (error) {
      actionError = normalizeError(error).message;
    } finally {
      creating = false;
    }
  }

  /** 外壳的「新建终端」命令：面板还没有终端时由首次展开负责新建，不重复开两个。 */
  export async function newTerminal(profile: string | null = null) {
    const repo = path;
    if (!repo) return;
    const current = layouts[repo];
    if (!current || sessionCount(current) === 0) {
      if (booting[repo]) return;
      const created = await bootstrap(repo);
      if (created || bootErrors[repo]) return;
    }
    await create(profile, false);
  }

  async function closeSession(sessionId: string) {
    const repo = repoOf(sessionId);
    if (!repo) return;
    actionError = null;
    try {
      await api.terminalClose(sessionId);
    } catch (error) {
      actionError = normalizeError(error).message;
      return;
    }
    const next = removeSession(layouts[repo] ?? emptyLayout(), sessionId);
    layouts[repo] = next;
    forget(sessionId);
    if (sessionCount(next) === 0 && repo === path) {
      // 最后一个终端关掉后收起面板；下次展开再新建。
      findOpen = false;
      collapse();
    }
  }

  async function closeGroup(groupId: string) {
    const group = layout.groups.find((item) => item.id === groupId);
    if (!group) return;
    for (const pane of [...group.panes]) await closeSession(pane);
  }

  async function closeOtherGroups(groupId: string) {
    for (const group of layout.groups.filter((item) => item.id !== groupId)) await closeGroup(group.id);
  }

  async function restartSession(sessionId: string) {
    const repo = repoOf(sessionId);
    if (!repo) return;
    actionError = null;
    try {
      const snapshot = await api.terminalRestart(sessionId);
      remember(snapshot);
      layouts[repo] = replaceSession(layouts[repo] ?? emptyLayout(), sessionId, snapshot.sessionId);
      forget(sessionId);
    } catch (error) {
      actionError = normalizeError(error).message;
    }
  }

  async function retryBoot() {
    if (isBooting) return;
    await bootstrap(path);
  }

  /* ------------------------------------------------------------ 布局与焦点 */

  function setLayout(next: TerminalLayout) {
    if (next !== layouts[path]) layouts[path] = next;
  }

  function onPaneFocus(sessionId: string) {
    const current = layouts[path];
    if (!current || (current.focused === sessionId && groupOf(current, sessionId)?.id === current.activeGroup)) return;
    setLayout(focusSession(current, sessionId));
  }

  function onPaneStatus(sessionId: string, status: TerminalPaneStatus) {
    const info = infos[sessionId];
    if (info) info.status = status;
  }

  function registerPane(sessionId: string, paneApi: TerminalPaneApi | null) {
    if (paneApi) paneApis.set(sessionId, paneApi);
    else paneApis.delete(sessionId);
  }

  function focusedApi(): TerminalPaneApi | null {
    return layout.focused ? (paneApis.get(layout.focused) ?? null) : null;
  }

  function selectTab(groupId: string) {
    setLayout(selectGroup(layout, groupId));
  }

  /** 收起面板；焦点在终端里时交还给工作台主区，键盘不会落到已隐藏的元素上。 */
  function collapse() {
    const inside = panel?.contains(document.activeElement);
    onClose();
    if (inside) void tick().then(() => document.querySelector<HTMLElement>("[data-app-main]")?.focus({ preventScroll: true }));
  }

  function toggleMaximize() {
    maximized = !maximized;
    void tick().then(() => focusedApi()?.focus());
  }

  function onPaneAction(sessionId: string, action: TerminalKeyAction) {
    switch (action) {
      case "toggle":
        collapse();
        return;
      case "new":
        void create(null, false);
        return;
      case "split":
        void create(infos[sessionId]?.profile || null, true);
        return;
      case "find":
        void openFind();
        return;
      case "zoom-in":
        onFontSize(clampFontSize(fontSize + 1));
        return;
      case "zoom-out":
        onFontSize(clampFontSize(fontSize - 1));
        return;
      case "zoom-reset":
        onFontSize(TERMINAL_FONT_DEFAULT);
        return;
      case "prev-tab":
        setLayout(cycleGroup(layout, -1));
        return;
      case "next-tab":
        setLayout(cycleGroup(layout, 1));
        return;
      default:
        return;
    }
  }

  /* ------------------------------------------------------------ 菜单 */

  function paneMenu(sessionId: string, event: MouseEvent) {
    const paneApi = paneApis.get(sessionId);
    const info = infos[sessionId];
    const exited = info ? !info.status.running && !info.status.starting && !info.status.error : false;
    const entries: ContextMenuEntry[] = [
      {
        id: "copy",
        label: "复制",
        icon: "copy",
        shortcut: IS_MAC_PANEL ? "⌘ C" : "Ctrl ⇧ C",
        disabledReason: paneApi?.hasSelection() ? undefined : "没有选中的文本",
        run: () => void paneApi?.copy(),
      },
      { id: "paste", label: "粘贴", icon: "clipboard", shortcut: `${MOD} V`, run: () => void paneApi?.paste() },
      { id: "select-all", label: "全选", icon: "select-all", run: () => paneApi?.selectAll() },
      { separator: true },
      { id: "find", label: "查找…", icon: "search", shortcut: `${MOD} F`, run: () => void openFind() },
      { id: "clear", label: "清屏", icon: "trash", run: () => paneApi?.clear() },
      { separator: true },
      {
        id: "split",
        label: "拆分终端",
        icon: "split",
        shortcut: `${MOD} ⇧ 5`,
        disabledReason: splitReason || undefined,
        run: () => void create(info?.profile || null, true),
      },
      {
        id: "new",
        label: "新建终端",
        icon: "plus",
        shortcut: `${MOD} ⇧ \``,
        disabledReason: limitReason || undefined,
        run: () => void create(null, false),
      },
      { separator: true },
    ];
    if (exited) entries.push({ id: "restart", label: "重新启动", icon: "refresh", run: () => void restartSession(sessionId) });
    entries.push({ id: "close", label: "关闭终端", icon: "x", danger: true, run: () => void closeSession(sessionId) });
    menu = { x: event.clientX, y: event.clientY, entries, label: "终端操作" };
  }

  function tabMenu(groupId: string, x: number, y: number) {
    const group = layout.groups.find((item) => item.id === groupId);
    if (!group) return;
    const anchor = group.panes[0];
    menu = {
      x,
      y,
      label: "终端标签页操作",
      entries: [
        { id: "rename", label: "重命名", icon: "pencil", run: () => startRename(groupId) },
        {
          id: "split",
          label: "拆分终端",
          icon: "split",
          disabledReason:
            limitReason || (group.panes.length >= MAX_PANES_PER_GROUP ? `一个标签页最多并排 ${MAX_PANES_PER_GROUP} 个终端` : undefined),
          run: () => {
            setLayout(selectGroup(layout, groupId));
            void create(infos[anchor]?.profile || null, true);
          },
        },
        { separator: true },
        { id: "close", label: "关闭标签页", icon: "x", danger: true, run: () => void closeGroup(groupId) },
        {
          id: "close-others",
          label: "关闭其他标签页",
          disabledReason: layout.groups.length < 2 ? "没有其他标签页" : undefined,
          danger: true,
          run: () => void closeOtherGroups(groupId),
        },
      ],
    };
  }

  async function loadProfiles(): Promise<TerminalProfile[]> {
    if (profiles.length > 0) return profiles;
    try {
      profiles = await api.terminalProfiles();
    } catch (error) {
      actionError = normalizeError(error).message;
    }
    return profiles;
  }

  async function profileMenu(anchor: HTMLElement) {
    const list = await loadProfiles();
    const defaultId = list.some((item) => item.id === defaultProfile) ? defaultProfile : (list[0]?.id ?? null);
    const point = pointFor(anchor);
    const entries: ContextMenuEntry[] = [{ heading: "新建终端" }];
    for (const profile of list) {
      entries.push({
        id: `profile:${profile.id}`,
        label: profile.id === defaultId ? `${profile.label}（默认）` : profile.label,
        icon: "terminal",
        disabledReason: limitReason || undefined,
        run: () => void create(profile.id, false),
      });
    }
    if (list.length === 0) entries.push({ id: "profile:none", label: "没有探测到可用的终端", disabledReason: "本机没有可用的终端类型", run: () => {} });
    entries.push(
      { separator: true },
      {
        id: "split",
        label: "拆分当前终端",
        icon: "split",
        shortcut: `${MOD} ⇧ 5`,
        disabledReason: count === 0 ? "还没有终端" : splitReason || undefined,
        run: () => void create(layout.focused ? infos[layout.focused]?.profile || null : null, true),
      },
    );
    if (onOpenSettings) {
      entries.push({ separator: true }, { id: "settings", label: "设置默认终端与字号…", icon: "settings", run: onOpenSettings });
    }
    menu = { x: point.x, y: point.y, entries, label: "选择终端类型" };
  }

  /* ------------------------------------------------------------ 标签页 */

  function startRename(groupId: string) {
    const group = layout.groups.find((item) => item.id === groupId);
    if (!group) return;
    renaming = groupId;
    renameValue = titles.get(groupId) ?? "";
    void tick().then(() => {
      const input = panel?.querySelector<HTMLInputElement>("[data-terminal-rename]");
      input?.focus();
      input?.select();
    });
  }

  function commitRename() {
    if (!renaming) return;
    setLayout(renameGroup(layout, renaming, renameValue));
    renaming = null;
    void tick().then(() => focusedApi()?.focus());
  }

  function onTabKey(event: KeyboardEvent, groupId: string) {
    const index = layout.groups.findIndex((group) => group.id === groupId);
    let target = -1;
    if (event.key === "ArrowRight") target = (index + 1) % layout.groups.length;
    else if (event.key === "ArrowLeft") target = (index - 1 + layout.groups.length) % layout.groups.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = layout.groups.length - 1;
    else if (event.key === "Delete") {
      event.preventDefault();
      void closeGroup(groupId);
      return;
    } else if (event.key === "F2") {
      event.preventDefault();
      startRename(groupId);
      return;
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectTab(groupId);
      void tick().then(() => focusedApi()?.focus());
      return;
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const point = pointFor(event.currentTarget as HTMLElement);
      tabMenu(groupId, point.x, point.y);
      return;
    }
    if (target < 0) return;
    event.preventDefault();
    const next = layout.groups[target];
    selectTab(next.id);
    void tick().then(() => panel?.querySelector<HTMLElement>(`[data-terminal-tab="${next.id}"]`)?.focus());
  }

  function groupState(groupId: string): "running" | "exited" | "failed" | "starting" {
    const group = layout.groups.find((item) => item.id === groupId);
    const states = (group?.panes ?? []).map((id) => infos[id]?.status);
    if (states.some((status) => status?.error)) return "failed";
    if (states.some((status) => status && !status.starting && !status.running)) return "exited";
    if (states.some((status) => !status || status.starting)) return "starting";
    return "running";
  }

  /* ------------------------------------------------------------ 查找 */

  async function openFind() {
    findOpen = true;
    findMiss = false;
    await tick();
    findInput?.focus();
    findInput?.select();
  }

  function runFind(direction: "next" | "prev", incremental = false) {
    const paneApi = focusedApi();
    if (!paneApi || !findQuery) {
      findMiss = false;
      return;
    }
    findMiss = !paneApi.find(findQuery, direction, incremental);
  }

  function closeFind() {
    findOpen = false;
    findMiss = false;
    const paneApi = focusedApi();
    paneApi?.clearFind();
    paneApi?.focus();
  }

  function onFindKey(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      runFind(event.shiftKey ? "prev" : "next");
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFind();
    }
  }

  /* ------------------------------------------------------------ 高度 */

  function clampHeight(value: number): number {
    const limit = Math.max(MIN_HEIGHT, window.innerHeight - WORKBENCH_RESERVE);
    return Math.round(Math.min(limit, Math.max(MIN_HEIGHT, value)));
  }

  function saveHeight() {
    try {
      if (height !== null) localStorage.setItem(HEIGHT_KEY, String(height));
    } catch {
      // 存不下只影响下次启动的高度。
    }
  }

  function startResize(event: PointerEvent) {
    if (maximized || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    handle.setPointerCapture?.(event.pointerId);
    panel.classList.add("resizing");
    const move = (next: PointerEvent) => {
      height = clampHeight(startHeight + (startY - next.clientY));
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      panel.classList.remove("resizing");
      saveHeight();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function onResizeKey(event: KeyboardEvent) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const current = height ?? panel.getBoundingClientRect().height;
    height = clampHeight(current + (event.key === "ArrowUp" ? 24 : -24));
    saveHeight();
  }
</script>

<aside
  class="terminal-panel"
  class:maximized
  data-terminal-panel
  aria-label="终端"
  hidden={!open}
  style={height !== null && !maximized ? `height:${height}px` : undefined}
  bind:this={panel}
>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="terminal-resizer"
    role="separator"
    aria-orientation="horizontal"
    aria-label="调整终端高度"
    title="拖动调整高度，双击最大化"
    tabindex={maximized ? -1 : 0}
    onpointerdown={startResize}
    ondblclick={toggleMaximize}
    onkeydown={onResizeKey}
  ></div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="terminal-head"
    ondblclick={(event) => {
      if (event.target === event.currentTarget) toggleMaximize();
    }}
  >
    <div class="terminal-tabs" role="tablist" aria-label="终端标签页">
      {#each layout.groups as group (group.id)}
        {@const active = group.id === layout.activeGroup}
        {@const title = titles.get(group.id) ?? "终端"}
        <div
          class="terminal-tab"
          class:active
          role="tab"
          tabindex={active ? 0 : -1}
          aria-selected={active}
          data-terminal-tab={group.id}
          data-state={groupState(group.id)}
          title={`${title}（双击重命名，中键关闭）`}
          onclick={() => {
            selectTab(group.id);
            void tick().then(() => focusedApi()?.focus());
          }}
          ondblclick={() => startRename(group.id)}
          onauxclick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              void closeGroup(group.id);
            }
          }}
          oncontextmenu={(event) => {
            event.preventDefault();
            tabMenu(group.id, event.clientX, event.clientY);
          }}
          onkeydown={(event) => onTabKey(event, group.id)}
        >
          <span class="terminal-tab-dot" aria-hidden="true"></span>
          {#if renaming === group.id}
            <input
              class="terminal-tab-input"
              data-terminal-rename
              aria-label="标签页名称"
              maxlength="40"
              bind:value={renameValue}
              onclick={(event) => event.stopPropagation()}
              ondblclick={(event) => event.stopPropagation()}
              onkeydown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") commitRename();
                else if (event.key === "Escape") {
                  renaming = null;
                  void tick().then(() => focusedApi()?.focus());
                }
              }}
              onblur={commitRename}
            />
          {:else}
            <span class="terminal-tab-label">{title}</span>
          {/if}
          {#if group.panes.length > 1}
            <span class="terminal-tab-count" aria-label={`并排 ${group.panes.length} 个终端`}><Icon name="split" size={11} />{group.panes.length}</span>
          {/if}
          <button
            type="button"
            class="terminal-tab-close"
            tabindex="-1"
            aria-label={`关闭 ${title}`}
            title="关闭标签页（结束其中的 shell）"
            onclick={(event) => {
              event.stopPropagation();
              void closeGroup(group.id);
            }}
          >
            <Icon name="x" size={11} />
          </button>
        </div>
      {/each}
    </div>
    <div class="terminal-new" role="group" aria-label="新建终端">
      <button
        type="button"
        class="icon-btn sm"
        data-terminal-new
        aria-label="新建终端"
        title={limitReason || `新建终端（${MOD}+Shift+\`）`}
        disabled={atLimit || creating || isBooting}
        onclick={() => void create(null, false)}
      >
        <Icon name="plus" size={14} />
      </button>
      <button
        type="button"
        class="icon-btn sm terminal-new-more"
        data-terminal-profiles
        aria-label="选择终端类型"
        aria-haspopup="menu"
        title="选择终端类型新建，或设置默认终端"
        onclick={(event) => void profileMenu(event.currentTarget as HTMLElement)}
      >
        <Icon name="chevron-down" size={12} />
      </button>
    </div>
    <span class="terminal-spacer"></span>
    <span class="terminal-status" data-terminal-state={stateName} role="status" aria-live="polite">{statusText}</span>
    <button
      type="button"
      class="icon-btn sm"
      data-terminal-split
      aria-label="拆分终端"
      title={count === 0 ? "还没有终端" : splitReason || `拆分终端（${MOD}+Shift+5）`}
      disabled={count === 0 || Boolean(splitReason) || creating}
      onclick={() => void create(layout.focused ? infos[layout.focused]?.profile || null : null, true)}
    >
      <Icon name="split" size={14} />
    </button>
    <button
      type="button"
      class="icon-btn sm"
      data-terminal-kill
      aria-label="关闭当前终端"
      title={layout.focused ? "关闭当前终端（结束其中的 shell 与子进程）" : "还没有终端"}
      disabled={!layout.focused}
      onclick={() => layout.focused && void closeSession(layout.focused)}
    >
      <Icon name="trash" size={13} />
    </button>
    <button
      type="button"
      class="icon-btn sm"
      data-terminal-maximize
      aria-label={maximized ? "还原终端面板" : "最大化终端面板"}
      aria-pressed={maximized}
      title={maximized ? "还原面板高度" : "最大化面板，占满工作台"}
      onclick={toggleMaximize}
    >
      <Icon name={maximized ? "minimize" : "maximize"} size={13} />
    </button>
    <button
      type="button"
      class="icon-btn sm"
      aria-label="收起终端"
      title={`收起底部终端，命令继续运行（${MOD}+\`）`}
      onclick={collapse}
    >
      <Icon name="chevron-down" size={14} />
    </button>
  </div>
  {#if bootError}
    <div class="terminal-notice error" role="alert" data-terminal-error>
      <Icon name="alert-circle" size={14} />
      <span>{bootError}</span>
      <button type="button" class="btn btn-secondary btn-sm" data-terminal-retry title="重新尝试启动这个仓库的终端" onclick={() => void retryBoot()}>
        重试启动
      </button>
    </div>
  {/if}
  {#if actionError}
    <div class="terminal-notice warn" role="alert" data-terminal-action-error>
      <Icon name="alert" size={14} />
      <span>{actionError}</span>
      <button type="button" class="icon-btn sm" aria-label="关闭提示" onclick={() => (actionError = null)}><Icon name="x" size={12} /></button>
    </div>
  {/if}
  <div class="terminal-body">
    {#each layout.groups as group (group.id)}
      {@const active = group.id === layout.activeGroup}
      <div class="terminal-group" data-terminal-group={group.id} class:active role="tabpanel" aria-label={titles.get(group.id)} hidden={!active}>
        {#each group.panes as sessionId (sessionId)}
          <TerminalPane
            {sessionId}
            {router}
            visible={open && active}
            focused={open && active && layout.focused === sessionId}
            {theme}
            {fontSize}
            label={infos[sessionId]?.label ?? "终端"}
            showLabel={group.panes.length > 1}
            onStatus={onPaneStatus}
            onFocus={onPaneFocus}
            onAction={onPaneAction}
            onContextMenu={paneMenu}
            onRestart={restartSession}
            onClosePane={(id) => void closeSession(id)}
            register={registerPane}
          />
        {/each}
      </div>
    {/each}
    {#if count === 0 && !bootError}
      <div class="terminal-empty" role="status">
        {#if isBooting}<span class="spinner" aria-hidden="true"></span>正在启动终端…{:else}还没有终端{/if}
      </div>
    {/if}
    {#if findOpen}
      <div class="terminal-find" role="search" aria-label="在终端输出中查找">
        <Icon name="search" size={13} />
        <input
          class="terminal-find-input"
          data-terminal-find
          type="text"
          placeholder="在终端输出中查找"
          aria-label="在终端输出中查找"
          bind:value={findQuery}
          bind:this={findInput}
          oninput={() => runFind("next", true)}
          onkeydown={onFindKey}
        />
        {#if findMiss}<span class="terminal-find-miss" role="status">无结果</span>{/if}
        <button type="button" class="icon-btn sm" aria-label="上一个匹配" title="上一个（Shift+Enter）" disabled={!findQuery} onclick={() => runFind("prev")}>
          <Icon name="chevron-up" size={13} />
        </button>
        <button type="button" class="icon-btn sm" aria-label="下一个匹配" title="下一个（Enter）" disabled={!findQuery} onclick={() => runFind("next")}>
          <Icon name="chevron-down" size={13} />
        </button>
        <button type="button" class="icon-btn sm" aria-label="关闭查找" title="关闭查找（Esc）" onclick={closeFind}>
          <Icon name="x" size={12} />
        </button>
      </div>
    {/if}
  </div>
  {#if menu}
    <ContextMenu request={menu} onClose={() => (menu = null)} />
  {/if}
</aside>
