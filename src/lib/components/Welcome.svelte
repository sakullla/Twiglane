<script lang="ts">
  import { repeatedNames } from "../recent";
  import type { RecentRepo } from "../types";
  import { hueOf, initialOf } from "../ui";
  import BrandMark from "./BrandMark.svelte";
  import { isContextKey, pointFor } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";

  /**
   * 起始页：品牌标记、打开 / 克隆 / 新建三个入口和最近仓库，一屏放下（R8）。
   * Git 不可用时只多一行诊断入口，说明留在设置的运行环境分区；这里是起始页唯一的提示，
   * 顶部通知条只在打开仓库后出现，所以关掉通知条不影响这个入口。
   */
  interface Props {
    recent: RecentRepo[];
    disabled: boolean;
    /** 三个入口不可用的原因：写在入口下方，不只放在悬停提示里（R12）。 */
    disabledReason?: string;
    onAdd: () => void;
    onClone: () => void;
    onCreate: () => void;
    onOpen: (path: string) => void;
    onContextMenu?: (repo: RecentRepo, point: { x: number; y: number }) => void;
    diagnostic?: string | null;
    onDiagnose?: () => void;
  }
  let {
    recent,
    disabled,
    disabledReason = "",
    onAdd,
    onClone,
    onCreate,
    onOpen,
    onContextMenu,
    diagnostic = null,
    onDiagnose,
  }: Props = $props();
  let shown = $derived(recent.slice(0, 5));
  let sameNames = $derived(repeatedNames(recent));
  let actionTitle = $derived(disabled ? disabledReason || undefined : undefined);

  function onRowKey(event: KeyboardEvent, repo: RecentRepo) {
    if (!isContextKey(event) || !onContextMenu) return;
    event.preventDefault();
    onContextMenu(repo, pointFor(event.currentTarget as Element));
  }
</script>

<div class="welcome">
  <div class="welcome-inner">
    <div class="welcome-brand"><BrandMark /></div>

    <section class="welcome-actions" aria-label="开始使用">
      <button type="button" class="action-card primary" {disabled} title={actionTitle} onclick={onAdd}>
        <Icon name="folder-open" size={18} />
        <span class="ac-copy"><strong>打开本地仓库</strong><span>选择目录或拖入文件夹</span></span>
      </button>
      <button type="button" class="action-card" {disabled} title={actionTitle} onclick={onClone}>
        <Icon name="download" size={18} />
        <span class="ac-copy"><strong>克隆远程仓库</strong><span>HTTPS、SSH 或本机路径</span></span>
      </button>
      <button type="button" class="action-card" {disabled} title={actionTitle} onclick={onCreate}>
        <Icon name="folder-plus" size={18} />
        <span class="ac-copy"><strong>新建仓库</strong><span>在空目录初始化 Git</span></span>
      </button>
    </section>

    {#if disabled && disabledReason}
      <p class="hint welcome-reason" role="status" data-welcome-reason>{disabledReason}</p>
    {/if}

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
        <h2>最近仓库</h2>
        {#if recent.length > shown.length}<span class="hint">共 {recent.length} 个</span>{/if}
      </div>
      {#if shown.length === 0}
        <p class="hint welcome-empty">还没有最近仓库，先打开或克隆一个。</p>
      {:else}
        <div class="welcome-recent">
          {#each shown as repo (repo.path)}
            <button
              type="button"
              title={repo.path}
              onclick={() => onOpen(repo.path)}
              oncontextmenu={(event) => {
                if (!onContextMenu) return;
                event.preventDefault();
                onContextMenu(repo, { x: event.clientX, y: event.clientY });
              }}
              onkeydown={(event) => onRowKey(event, repo)}
            >
              <span class="repo-badge" style={`--hue:${hueOf(repo.path)}`} aria-hidden="true">{initialOf(repo.name)}</span>
              <span class="repo-text">
                <span class="repo-name">{repo.name}</span>
                <span class={sameNames.has(repo.name) ? "repo-path-full" : "repo-path"}><bdi>{repo.path}</bdi></span>
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</div>
