<script lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import { filterRecent, repeatedNames } from "../recent";
  import type { RecentRepo } from "../types";
  import { hueOf, relativeTime, repoBadgeLetters } from "../ui";
  import BrandMark from "./BrandMark.svelte";
  import { isContextKey, pointFor } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";

  /**
   * 起始页：品牌标记、打开 / 克隆 / 新建三个入口和最近仓库，一屏放下（R8）。
   * Git 不可用时只多一行诊断入口，说明留在设置的运行环境分区；这里是起始页唯一的提示，
   * 顶部通知条只在打开仓库后出现，所以关掉通知条不影响这个入口。
   * 最近仓库最多列五行，多出来时才有搜索框：搜索范围是全部仓库，结果同样最多五行（R26）。
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
  const LIMIT = 5;
  let query = $state("");
  let searchable = $derived(recent.length > LIMIT);
  let searching = $derived(searchable && query.trim().length > 0);
  let matches = $derived(searching ? filterRecent(recent, query) : recent);
  let shown = $derived(matches.slice(0, LIMIT));
  let badgeLetters = $derived(repoBadgeLetters(shown.map((repo) => repo.name)));
  let sameNames = $derived(repeatedNames(recent));
  let actionTitle = $derived(disabled ? disabledReason || undefined : undefined);

  /** 回车打开第一条结果；Esc 只清空关键词；向下进入结果列表。 */
  function onSearchKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === "Enter" && searching && shown.length > 0) {
      event.preventDefault();
      onOpen(shown[0].path);
    } else if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      query = "";
    } else if (event.key === "ArrowDown" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const first = document.querySelector<HTMLButtonElement>(".welcome-recent > button");
      if (!first) return;
      event.preventDefault();
      first.focus();
    }
  }

  function onRowKey(event: KeyboardEvent, repo: RecentRepo) {
    if (isContextKey(event) && onContextMenu) {
      event.preventDefault();
      onContextMenu(repo, pointFor(event.currentTarget as Element));
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>(":scope > button") ?? []];
    const index = buttons.indexOf(event.currentTarget as HTMLButtonElement);
    if (index < 0) return;
    if (event.key === "ArrowUp" && index === 0) {
      const search = document.getElementById("welcome-search");
      if (!search) return;
      event.preventDefault();
      search.focus();
      return;
    }
    event.preventDefault();
    const next = event.key === "ArrowDown" ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1);
    buttons[next]?.focus();
  }

  /** 上次打开的相对时间：同名或相近的仓库多一条可区分的线索。没有可信时间戳时不显示。 */
  function openedLabel(repo: RecentRepo): string | null {
    if (!Number.isFinite(repo.openedAtMs) || repo.openedAtMs < 1_000_000_000_000) return null;
    return relativeTime(repo.openedAtMs / 1000);
  }
</script>

<div class="welcome">
  <div class="welcome-inner">
    <div class="welcome-brand"><BrandMark /></div>

    <section class="welcome-actions" aria-label="开始使用">
      <button type="button" class="action-card primary" {disabled} title={actionTitle} onclick={onAdd}>
        <Icon name="folder-open" size={18} />
        <span class="ac-copy"><strong>打开本地仓库</strong><span>选择目录或拖入文件夹；只检查仓库身份，不会初始化</span></span>
      </button>
      <button type="button" class="action-card" {disabled} title={actionTitle} onclick={onClone}>
        <Icon name="download" size={18} />
        <span class="ac-copy"><strong>克隆远程仓库</strong><span>HTTPS、SSH 或本机路径；目标已有文件时不会覆盖</span></span>
      </button>
      <button type="button" class="action-card" {disabled} title={actionTitle} onclick={onCreate}>
        <Icon name="folder-plus" size={18} />
        <span class="ac-copy"><strong>新建仓库</strong><span>在空目录初始化 Git；已有内容不覆盖</span></span>
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
        {#if searchable}
          <div class="field sm welcome-search">
            <Icon name="search" size={14} />
            <input id="welcome-search" aria-label="搜索最近仓库" placeholder="搜索名称或路径" autocomplete="off" spellcheck="false" bind:value={query} onkeydown={onSearchKey} />
            {#if query}
              <button type="button" class="field-clear" aria-label="清空搜索" onclick={() => (query = "")}>
                <Icon name="x" size={12} />
              </button>
            {/if}
          </div>
          <span class="hint" role="status" data-welcome-count>
            {#if !searching}共 {recent.length} 个{:else if matches.length > shown.length}匹配 {matches.length} 个，显示前 {shown.length} 个{:else}匹配 {matches.length} 个{/if}
          </span>
          {#if !searching && recent.length > shown.length}
            <span class="hint" data-welcome-limit>显示前 {shown.length} 个</span>
          {/if}
        {/if}
      </div>
      {#if recent.length === 0}
        <p class="hint welcome-empty" data-welcome-empty>还没有最近仓库，先打开或克隆一个。</p>
        <p class="hint" data-welcome-empty-note>打开只会检查仓库身份，不会初始化目录；需要初始化请用「新建仓库」。</p>
      {:else}
        <div class="welcome-recent" class:searchable>
          {#if shown.length === 0}
            <p class="hint welcome-no-match" data-welcome-no-match>没有匹配的仓库，试试名称或路径。</p>
          {/if}
          {#each shown as repo, index (repo.path)}
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
              <span class="repo-badge" style={`--hue:${hueOf(repo.path)}`} aria-hidden="true">{badgeLetters[index]}</span>
              <span class="repo-text">
                <span class="repo-name">{repo.name}</span>
                <span class={sameNames.has(repo.name) ? "repo-path-full" : "repo-path"}><bdi>{repo.path}</bdi></span>
              </span>
              {#if openedLabel(repo)}<span class="repo-when" data-repo-when>{openedLabel(repo)}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <footer class="welcome-foot" aria-label="使用提示">
      <span><kbd>{MODIFIER_LABEL} K</kbd>命令面板</span>
      <span><Icon name="folder-open" size={13} />把仓库文件夹拖进窗口即可打开</span>
      <span>右键最近仓库可复制路径或移出列表</span>
    </footer>
  </div>
</div>
