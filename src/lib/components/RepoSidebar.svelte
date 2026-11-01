<script lang="ts">
  import { BRAND, MODIFIER_LABEL } from "../brand";
  import { filterRecent } from "../recent";
  import type { RecentRepo, Theme, WorkspaceView } from "../types";
  import { hueOf, initialOf } from "../ui";
  import BrandMark from "./BrandMark.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    repos: RecentRepo[];
    query: string;
    selectedPath: string | null;
    theme: Theme;
    disabled?: boolean;
    workspaceView?: WorkspaceView;
    workspaceEnabled?: boolean;
    changeCount?: number;
    conflictCount?: number;
    onView?: (view: WorkspaceView) => void;
    onQuery: (value: string) => void;
    onSelect: (path: string) => void;
    onForget: (path: string) => void;
    onShowPath: (path: string) => void;
    onTheme: (theme: Theme) => void;
    onAdd?: () => void;
    onClone?: () => void;
    onCreate?: () => void;
  }

  let {
    repos,
    query,
    selectedPath,
    theme,
    disabled = false,
    workspaceView = "changes",
    workspaceEnabled = false,
    changeCount = 0,
    conflictCount = 0,
    onView,
    onQuery,
    onSelect,
    onForget,
    onShowPath,
    onTheme,
    onAdd,
    onClone,
    onCreate,
  }: Props = $props();

  const views = [
    { id: "changes", label: "改动", icon: "file-diff", shortcut: "1" },
    { id: "history", label: "提交历史", icon: "history", shortcut: "2" },
    { id: "stash", label: "临时保存", icon: "archive", shortcut: "3" },
    { id: "merge", label: "分支合并", icon: "merge", shortcut: "4" },
  ] as const;

  let visible = $derived(filterRecent(repos, query));
  let menuOpen = $state(false);
  let anchor = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (anchor && !anchor.contains(event.target as Node)) menuOpen = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") menuOpen = false;
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  });

  function choose(action?: () => void) {
    menuOpen = false;
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
</script>

<aside class="sidebar" aria-label="仓库与工作区">
  <div class="sidebar-head">
    <BrandMark />
  </div>

  {#if onAdd || onClone || onCreate}
    <div class="sidebar-add-wrap">
      <div class="menu-anchor" bind:this={anchor}>
        <button
          type="button"
          class="sidebar-add"
          aria-label="添加仓库"
          title="添加、克隆或新建仓库"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={disabled}
          onclick={() => (menuOpen = !menuOpen)}
        >
          <span class="sidebar-add-icon"><Icon name="plus" size={17} /></span>
          <span>添加仓库</span>
          <Icon name="chevron-down" size={14} />
        </button>
        {#if menuOpen}
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
    </div>
  {/if}

  <div class="sidebar-search">
    <label class="sr-only" for="repo-search">搜索最近仓库（{MODIFIER_LABEL}+K）</label>
    <div class="field sm">
      <Icon name="search" size={14} />
      <input
        id="repo-search"
        placeholder="搜索仓库或路径"
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
      {:else}
        <kbd>{MODIFIER_LABEL} K</kbd>
      {/if}
    </div>
  </div>

  {#if onView}
    <nav class="workspace-nav" aria-label="工作区导航">
      <div class="sidebar-section"><span>工作区</span></div>
      {#each views as view (view.id)}
        <button
          type="button"
          class="workspace-nav-item"
          class:active={workspaceView === view.id}
          aria-current={workspaceView === view.id ? "page" : undefined}
          disabled={!workspaceEnabled}
          title={`${view.label}（${MODIFIER_LABEL}+${view.shortcut}）`}
          onclick={() => onView?.(view.id)}
        >
          <span class="nav-icon"><Icon name={view.icon} size={17} /></span>
          <span>{view.label}</span>
          <span class="spacer"></span>
          {#if view.id === "changes" && changeCount > 0}
            <span class="count">{changeCount}</span>
          {:else if view.id === "merge" && conflictCount > 0}
            <span class="count danger">{conflictCount}</span>
          {:else if workspaceEnabled}
            <kbd>{MODIFIER_LABEL} {view.shortcut}</kbd>
          {/if}
        </button>
      {/each}
    </nav>
  {/if}

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

  <div class="sidebar-foot">
    <div class="sidebar-foot-brand">
      <span class="local-dot"></span>
      <span title={`${BRAND.full} · ${BRAND.tagline}`}>本地优先，无需登录</span>
    </div>
    <div class="segmented theme-switch" role="group" aria-label="主题">
      <button type="button" aria-pressed={theme === "light"} onclick={() => onTheme("light")}>
        <Icon name="sun" size={13} />浅色
      </button>
      <button type="button" aria-pressed={theme === "dark"} onclick={() => onTheme("dark")}>
        <Icon name="moon" size={13} />深色
      </button>
    </div>
  </div>
</aside>
