<script module lang="ts">
  /** 任务组入口：打开对应 modal，不切换主视图。 */
  export type RailTask = "stash" | "merge" | "branch" | "remote";
</script>

<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import { filterRecent } from "../recent";
  import type { RecentRepo, WorkspaceView } from "../types";
  import { hueOf, initialOf } from "../ui";
  import Icon from "./Icon.svelte";

  /**
   * rail：导航组（改动、提交历史）与任务组（临时保存、分支合并、分支与标签、远程）。
   * 导航项切换主视图；任务项打开对应 modal，不切换主视图。
   * 折叠为仅图标形态时，名称改由 aria-label 与 title 承载，仍可完成同样的进入操作。
   */
  interface Props {
    repos: RecentRepo[];
    query: string;
    selectedPath: string | null;
    workspaceView: WorkspaceView;
    workspaceEnabled?: boolean;
    changeCount?: number;
    conflictCount?: number;
    /**
     * 合并已开始（MergeSession.operation === "merge" / canAbortMerge）。
     * 冲突可能已经全部解决、conflictCount 归零，但合并仍未完成，任务入口必须还能表达这件事，
     * 因此标记与计数分开：计数只表示未解决冲突数，圆点只表示「有进行中的合并」。
     */
    mergeInProgress?: boolean;
    collapsed?: boolean;
    disabled?: boolean;
    onView: (view: WorkspaceView) => void;
    onTask: (task: RailTask) => void;
    onToggleCollapsed?: () => void;
    onQuery: (value: string) => void;
    onSelect: (path: string) => void;
    onForget: (path: string) => void;
    onShowPath: (path: string) => void;
    onAdd?: () => void;
    onClone?: () => void;
    onCreate?: () => void;
  }

  let {
    repos,
    query,
    selectedPath,
    workspaceView,
    workspaceEnabled = false,
    changeCount = 0,
    conflictCount = 0,
    mergeInProgress = false,
    collapsed = false,
    disabled = false,
    onView,
    onTask,
    onToggleCollapsed,
    onQuery,
    onSelect,
    onForget,
    onShowPath,
    onAdd,
    onClone,
    onCreate,
  }: Props = $props();

  const navItems = [
    { id: "changes", label: "改动", icon: "file-diff", shortcut: "1" },
    { id: "history", label: "提交历史", icon: "history", shortcut: "2" },
  ] as const;

  const taskItems = [
    { id: "stash", label: "临时保存", icon: "archive" },
    { id: "merge", label: "分支合并", icon: "merge" },
    { id: "branch", label: "分支与标签", icon: "branch" },
    { id: "remote", label: "远程", icon: "globe" },
  ] as const;

  let visible = $derived(filterRecent(repos, query));
  let addMenu = $state(false);
  let addAnchor = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!addMenu) return;
    const close = (event: MouseEvent) => {
      if (addAnchor && !addAnchor.contains(event.target as Node)) addMenu = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") addMenu = false;
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  });

  function choose(action?: () => void) {
    addMenu = false;
    action?.();
  }

  function onSearchKey(event: KeyboardEvent) {
    if (event.key === "Enter" && visible.length > 0) {
      event.preventDefault();
      onSelect(visible[0].path);
    } else if (event.key === "Escape" && query) {
      event.preventDefault();
      onQuery("");
    }
  }

  function navLabel(label: string, count: number): string {
    return count > 0 ? `${label} ${count}` : label;
  }

  /** 合并进行中是独立状态，不并入冲突计数：两种情形可以同时成立。 */
  function taskState(task: RailTask): "merge" | null {
    return task === "merge" && mergeInProgress ? "merge" : null;
  }

  function taskLabel(task: RailTask, label: string, conflicts: number): string {
    const base = navLabel(label, conflicts);
    return taskState(task) === "merge" ? `${base}（合并进行中）` : base;
  }

  function taskTitle(task: RailTask, label: string): string {
    return taskState(task) === "merge" ? `${label}：合并进行中` : label;
  }

  function navCount(id: "changes" | "history"): number {
    return id === "changes" ? changeCount : 0;
  }
</script>

<aside class="sidebar rail" class:collapsed aria-label="仓库与工作区">
  <div class="rail-head">
    {#if onToggleCollapsed}
      <button
        type="button"
        class="icon-btn rail-toggle"
        aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
        aria-expanded={!collapsed}
        title={`${collapsed ? "展开" : "折叠"}侧栏（${MODIFIER_LABEL}+B）`}
        onclick={onToggleCollapsed}
      >
        <Icon name="sidebar" size={18} />
      </button>
    {/if}
    {#if (onAdd || onClone || onCreate) && !collapsed}
      <div class="menu-anchor rail-add" bind:this={addAnchor}>
        <button
          type="button"
          class="sidebar-add"
          aria-label="添加仓库"
          title="添加、克隆或新建仓库"
          aria-haspopup="menu"
          aria-expanded={addMenu}
          disabled={disabled}
          onclick={() => (addMenu = !addMenu)}
        >
          <span class="sidebar-add-icon"><Icon name="plus" size={17} /></span>
          <span>添加仓库</span>
          <Icon name="chevron-down" size={14} />
        </button>
        {#if addMenu}
          <div class="menu left sidebar-menu" role="menu">
            {#if onAdd}
              <button type="button" class="menu-item" role="menuitem" onclick={() => choose(onAdd)}>
                <Icon name="folder-open" />
                <span>打开本地仓库<small>选择已有目录，只检查不写入</small></span>
              </button>
            {/if}
            {#if onClone}
              <button type="button" class="menu-item" role="menuitem" onclick={() => choose(onClone)}>
                <Icon name="download" />
                <span>克隆远程仓库<small>克隆到新目录，不覆盖已有文件</small></span>
              </button>
            {/if}
            {#if onCreate}
              <div class="menu-sep"></div>
              <button type="button" class="menu-item" role="menuitem" onclick={() => choose(onCreate)}>
                <Icon name="folder-plus" />
                <span>新建仓库<small>在目录中初始化，确认前不写入</small></span>
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if !collapsed}
    <div class="sidebar-search">
      <!-- 这个框只过滤下面的最近仓库列表；命令面板由 Ctrl/⌘K 打开，两者不能混为一谈。 -->
      <label class="sr-only" for="repo-search">过滤最近仓库列表（按名称或路径）</label>
      <div class="field sm">
        <Icon name="search" size={14} />
        <input
          id="repo-search"
          placeholder="过滤最近仓库（名称或路径）"
          title={`只过滤最近仓库列表；命令面板用 ${MODIFIER_LABEL}+K`}
          autocomplete="off"
          spellcheck="false"
          value={query}
          oninput={(event) => onQuery((event.currentTarget as HTMLInputElement).value)}
          onkeydown={onSearchKey}
        />
        {#if query}
          <button type="button" class="field-clear" aria-label="清空搜索" onclick={() => onQuery("")}>
            <Icon name="x" size={12} />
          </button>
        {/if}
      </div>
    </div>
  {/if}

  <nav class="workspace-nav rail-nav" aria-label="导航">
    {#if !collapsed}<div class="sidebar-section"><span>导航</span></div>{/if}
    {#each navItems as view (view.id)}
      {@const count = navCount(view.id)}
      <button
        type="button"
        class="workspace-nav-item"
        class:active={workspaceView === view.id}
        aria-current={workspaceView === view.id ? "page" : undefined}
        aria-label={navLabel(view.label, count)}
        disabled={!workspaceEnabled}
        title={`${view.label}（${MODIFIER_LABEL}+${view.shortcut}）`}
        onclick={() => onView(view.id)}
      >
        <span class="nav-icon"><Icon name={view.icon} size={17} /></span>
        {#if !collapsed}<span>{view.label}</span>{/if}
        <span class="spacer"></span>
        {#if count > 0}
          <span class="count">{count}</span>
        {:else if workspaceEnabled && !collapsed}
          <kbd>{MODIFIER_LABEL} {view.shortcut}</kbd>
        {/if}
      </button>
    {/each}
  </nav>

  <nav class="workspace-nav rail-tasks" aria-label="任务">
    {#if !collapsed}<div class="sidebar-section"><span>任务</span></div>{/if}
    {#each taskItems as task (task.id)}
      {@const conflicts = task.id === "merge" ? conflictCount : 0}
      {@const state = taskState(task.id)}
      <button
        type="button"
        class="workspace-nav-item"
        class:merging={state === "merge"}
        aria-label={taskLabel(task.id, task.label, conflicts)}
        disabled={!workspaceEnabled}
        title={taskTitle(task.id, task.label)}
        onclick={() => onTask(task.id)}
      >
        <span class="nav-icon"><Icon name={task.icon} size={17} /></span>
        {#if !collapsed}<span>{task.label}</span>{/if}
        <span class="spacer"></span>
        {#if conflicts > 0}<span class="count danger">{conflicts}</span>{/if}
        {#if state === "merge"}
          <span class="rail-status-dot" data-rail-status="merge" aria-hidden="true"></span>
        {/if}
      </button>
    {/each}
  </nav>

  {#if !collapsed}
    <div class="sidebar-section repo-section-title">
      <span>最近仓库</span>
      {#if repos.length > 0}<span class="count">{repos.length}</span>{/if}
    </div>
    <div class="sidebar-scroll">
      {#if repos.length === 0}
        <div class="sidebar-empty">
          <span class="empty-icon"><Icon name="folder" size={19} /></span>
          <p class="hint">从本地目录开始，或克隆一个远程仓库。</p>
        </div>
      {:else if visible.length === 0}
        <div class="sidebar-empty">
          <span class="empty-icon"><Icon name="search" size={19} /></span>
          <p class="hint">没有匹配的仓库，试试名称或路径。</p>
        </div>
      {:else}
        <div class="repo-list" role="list">
          {#each visible as repo (repo.path)}
            <div class="repo" role="listitem" aria-current={repo.path === selectedPath ? "true" : undefined}>
              <button type="button" class="repo-main" title={repo.path} onclick={() => onSelect(repo.path)}>
                <span class="repo-badge" style={`--hue:${hueOf(repo.path)}`} aria-hidden="true">{initialOf(repo.name)}</span>
                <span class="repo-text">
                  <span class="repo-name">{repo.name}</span>
                  <span class="repo-path"><bdi>{repo.path}</bdi></span>
                </span>
              </button>
              <span class="repo-actions">
                <button type="button" class="icon-btn sm" aria-label="复制完整路径" title="复制完整路径" onclick={() => onShowPath(repo.path)}>
                  <Icon name="copy" size={13} />
                </button>
                <button type="button" class="icon-btn sm danger" aria-label="从列表移除" title="从列表移除（不删除文件）" onclick={() => onForget(repo.path)}>
                  <Icon name="x" size={13} />
                </button>
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <div class="sidebar-foot rail-foot">
    {#if !collapsed}
      <div class="sidebar-foot-brand">
        <span class="local-dot"></span>
        <span>本地优先，无需登录</span>
      </div>
    {:else}
      <span class="local-dot" title="本地优先，无需登录"></span>
    {/if}
  </div>
</aside>
