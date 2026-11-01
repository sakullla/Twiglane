<script lang="ts">
  import type { RecentRepo } from "../types";
  import { hueOf, initialOf } from "../ui";
  import Icon from "./Icon.svelte";

  /**
   * 起始页：单屏三入口（打开 / 克隆 / 新建）加最近仓库，不堆营销段落。
   * Git 不可用时只多一行诊断入口，不展开说明。
   */
  interface Props {
    recent: RecentRepo[];
    disabled: boolean;
    onAdd: () => void;
    onClone: () => void;
    onCreate: () => void;
    onOpen: (path: string) => void;
    diagnostic?: string | null;
    onDiagnose?: () => void;
  }
  let {
    recent,
    disabled,
    onAdd,
    onClone,
    onCreate,
    onOpen,
    diagnostic = null,
    onDiagnose,
  }: Props = $props();
  let shown = $derived(recent.slice(0, 5));
</script>

<div class="welcome welcome-compact">
  <div class="welcome-inner welcome-inner-compact">
    <section class="welcome-actions" aria-label="开始使用">
      <button type="button" class="action-card primary" {disabled} onclick={onAdd}>
        <span class="ac-icon"><Icon name="folder-open" size={21} /></span>
        <span class="ac-copy"><strong>打开本地仓库</strong><span>选择已有目录</span></span>
        <Icon name="arrow-up" size={17} class="action-arrow" />
      </button>
      <button type="button" class="action-card" {disabled} onclick={onClone}>
        <span class="ac-icon"><Icon name="download" size={20} /></span>
        <span class="ac-copy"><strong>克隆远程仓库</strong><span>HTTPS、SSH 或本机路径</span></span>
        <Icon name="chevron-right" size={17} />
      </button>
      <button type="button" class="action-card" {disabled} onclick={onCreate}>
        <span class="ac-icon"><Icon name="folder-plus" size={20} /></span>
        <span class="ac-copy"><strong>新建仓库</strong><span>在空目录初始化 Git</span></span>
        <Icon name="chevron-right" size={17} />
      </button>
    </section>

    {#if diagnostic}
      {#if onDiagnose}
        <button type="button" class="welcome-diagnostic" onclick={onDiagnose}>
          <Icon name="alert-circle" size={15} />
          <span>{diagnostic}</span>
          <Icon name="chevron-right" size={14} />
        </button>
      {:else}
        <p class="welcome-diagnostic">{diagnostic}</p>
      {/if}
    {/if}

    <section class="welcome-section" aria-label="最近仓库">
      <div class="welcome-section-head">
        <div><span class="section-kicker">继续之前的工作</span><h2>最近仓库</h2></div>
        {#if recent.length > 0}<span class="hint">{recent.length} 个仓库</span>{/if}
      </div>
      {#if shown.length === 0}
        <p class="hint welcome-empty">还没有最近仓库，先打开或克隆一个。</p>
      {:else}
        <div class="welcome-recent">
          {#each shown as repo (repo.path)}
            <button type="button" title={repo.path} onclick={() => onOpen(repo.path)}>
              <span class="repo-badge" style={`--hue:${hueOf(repo.path)}`} aria-hidden="true">{initialOf(repo.name)}</span>
              <span class="repo-text">
                <span class="repo-name">{repo.name}</span>
                <span class="repo-path"><bdi>{repo.path}</bdi></span>
              </span>
              <span class="recent-open">打开<Icon name="arrow-up" size={13} /></span>
            </button>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</div>
