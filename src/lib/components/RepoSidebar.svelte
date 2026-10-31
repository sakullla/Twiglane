<script lang="ts">
  import { BRAND, MODIFIER_LABEL } from "../brand";
  import { filterRecent } from "../recent";
  import type { RecentRepo, Theme } from "../types";
  import BrandMark from "./BrandMark.svelte";

  interface Props {
    repos: RecentRepo[];
    query: string;
    selectedPath: string | null;
    theme: Theme;
    onQuery: (value: string) => void;
    onSelect: (path: string) => void;
    onForget: (path: string) => void;
    onShowPath: (path: string) => void;
    onTheme: (theme: Theme) => void;
  }

  let {
    repos,
    query,
    selectedPath,
    theme,
    onQuery,
    onSelect,
    onForget,
    onShowPath,
    onTheme,
  }: Props = $props();

  let visible = $derived(filterRecent(repos, query));
</script>

<aside class="sidebar" aria-label="仓库">
  <BrandMark />
  <p class="hint">{BRAND.tagline}</p>
  <label class="hint" for="repo-search">搜索最近仓库（{MODIFIER_LABEL}+K）</label>
  <input
    id="repo-search"
    class="search"
    placeholder="名称或完整路径"
    value={query}
    oninput={(event) => onQuery((event.currentTarget as HTMLInputElement).value)}
  />
  {#if repos.length === 0}
    <p class="hint">还没有最近仓库。添加已有仓库，或明确新建一个。</p>
  {:else if visible.length === 0}
    <p class="hint">没有匹配的仓库。试试路径中的其他片段。</p>
  {:else}
    <div class="repo-list" role="list">
      {#each visible as repo (repo.path)}
        <div class="repo" role="listitem" aria-current={repo.path === selectedPath ? "true" : undefined}>
          <button type="button" class="ghost" onclick={() => onSelect(repo.path)}>
            <span class="repo-name">{repo.name}</span>
            <span class="repo-path" title={repo.path}>{repo.path}</span>
          </button>
          <span class="row">
            <button type="button" class="ghost" onclick={() => onShowPath(repo.path)}>查看完整路径</button>
            <button type="button" class="ghost" onclick={() => onForget(repo.path)}>从列表移除</button>
          </span>
        </div>
      {/each}
    </div>
  {/if}
  <div class="row" aria-label="主题">
    <button type="button" class="theme-btn" aria-pressed={theme === "light"} onclick={() => onTheme("light")}>浅色</button>
    <button type="button" class="theme-btn" aria-pressed={theme === "dark"} onclick={() => onTheme("dark")}>深色</button>
  </div>
  <p class="hint footer-brand">{BRAND.full} · {BRAND.tagline}</p>
</aside>
