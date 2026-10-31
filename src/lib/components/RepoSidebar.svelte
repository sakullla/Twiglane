<script lang="ts">
  import { BRAND, MODIFIER_LABEL } from "../brand";
  import { filterRecent } from "../recent";
  import type { RecentRepo, Theme } from "../types";
  import { hueOf, initialOf } from "../ui";
  import BrandMark from "./BrandMark.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    repos: RecentRepo[];
    query: string;
    selectedPath: string | null;
    theme: Theme;
    disabled?: boolean;
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
    onQuery,
    onSelect,
    onForget,
    onShowPath,
    onTheme,
    onAdd,
    onClone,
    onCreate,
  }: Props = $props();

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

<aside class="sidebar" aria-label="仓库">
  <div class="sidebar-head">
    <BrandMark />
    {#if onAdd || onClone || onCreate}
      <div class="menu-anchor" bind:this={anchor}>
        <button
          type="button"
          class="icon-btn"
          aria-label="添加仓库"
          title="添加、克隆或新建仓库"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={disabled}
          onclick={() => (menuOpen = !menuOpen)}
        >
          <Icon name="plus" size={18} />
        </button>
        {#if menuOpen}
          <div class="menu" role="menu">
            {#if onAdd}
              <button type="button" class="menu-item" role="menuitem" onclick={() => choose(onAdd)}>
                <Icon name="folder-open" />
                <span>添加本地仓库<small>选择已有目录，只检查不写入</small></span>
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

  <div class="sidebar-search">
    <label class="sr-only" for="repo-search">搜索最近仓库（{MODIFIER_LABEL}+K）</label>
    <div class="field sm">
      <Icon name="search" size={14} />
      <input
        id="repo-search"
        placeholder="搜索仓库"
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

  <div class="sidebar-section">
    <span>最近仓库</span>
    {#if repos.length > 0}<span class="count">{repos.length}</span>{/if}
  </div>
  <div class="sidebar-scroll">
    {#if repos.length === 0}
      <p class="hint sidebar-empty">还没有最近仓库。点右上角的 + 添加已有仓库，或明确新建一个。</p>
    {:else if visible.length === 0}
      <p class="hint sidebar-empty">没有匹配的仓库。试试路径中的其他片段。</p>
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
              <button type="button" class="icon-btn sm" aria-label="查看完整路径" title="查看完整路径" onclick={() => onShowPath(repo.path)}>
                <Icon name="info" size={14} />
              </button>
              <button type="button" class="icon-btn sm danger" aria-label="从列表移除" title="从列表移除（不删除文件）" onclick={() => onForget(repo.path)}>
                <Icon name="x" size={14} />
              </button>
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="sidebar-foot">
    <div class="segmented" role="group" aria-label="主题">
      <button type="button" aria-pressed={theme === "light"} onclick={() => onTheme("light")}>
        <Icon name="sun" size={13} />浅色
      </button>
      <button type="button" aria-pressed={theme === "dark"} onclick={() => onTheme("dark")}>
        <Icon name="moon" size={13} />深色
      </button>
    </div>
    <span class="spacer"></span>
    <span class="hint" title={`${BRAND.full} · ${BRAND.tagline}`}>{BRAND.zh}</span>
  </div>
</aside>
