<script lang="ts">
  import { tick } from "svelte";
  import type { ReviewSourceEntry } from "../../review-actions.svelte";
  import Icon from "../Icon.svelte";

  /**
   * 审查工作台左栏顶部的来源卡：项目 · 仓库、发起标签（最新/较早 · 相对时间）与审阅进度。
   * 点击打开来源菜单：切换来源、展开详情（ID、路径、协议版本）、关闭当前/单个/全部来源。
   * 关闭是否需要确认由外壳根据未送回意见与草稿决定；这里只发出意图，不自行选择其他来源。
   */
  interface Props {
    /** 菜单里的全部本地来源（当前来源在最前）。 */
    entries: ReviewSourceEntry[];
    /** 远程审查来源：没有本地来源菜单，只显示主机与路径。 */
    remote?: { host: string; path: string; reviewId: string } | null;
    /** 当前阅读进度（只是阅读记录，不是批准）。 */
    progress?: { reviewed: number; total: number } | null;
    /** 切换或关闭来源不可用的原因（例如正在写入）。 */
    blockedReason?: string | null;
    max?: number;
    /** 恢复来源时的一条说明，可关闭。 */
    notice?: string | null;
    onDismissNotice?: () => void;
    /** 已保留上次返回尝试：接收结果以 Cliora 为准。 */
    lastReturn?: boolean;
    onChoose: (reviewId: string) => void;
    /** 关闭一个或多个来源；scope 区分入口（当前 / 单个 / 全部）。 */
    onClose: (reviewIds: string[], scope: "current" | "single" | "all") => void;
  }

  let {
    entries,
    remote = null,
    progress = null,
    blockedReason = null,
    max = 8,
    notice = null,
    onDismissNotice,
    lastReturn = false,
    onChoose,
    onClose,
  }: Props = $props();

  let open = $state(false);
  let trigger = $state<HTMLButtonElement | null>(null);
  let menu = $state<HTMLDivElement | null>(null);
  let menuStyle = $state("");
  let expanded = $state<string | null>(null);

  let active = $derived(entries.find((entry) => entry.active) ?? null);
  let nearFull = $derived(entries.length >= max - 2);

  function progressText(entry: ReviewSourceEntry): string {
    if (entry.total !== null) return `已审阅 ${entry.reviewed} / ${entry.total}`;
    return entry.reviewed > 0 ? `已审阅 ${entry.reviewed}` : "尚未审阅";
  }

  function commentText(entry: ReviewSourceEntry): string | null {
    const parts: string[] = [];
    if (entry.comments > 0) parts.push(entry.unsent > 0 && entry.unsent < entry.comments ? `${entry.comments} 条意见（${entry.unsent} 条未送回）` : `${entry.comments} 条意见`);
    if (entry.drafts > 0) parts.push(`${entry.drafts} 条草稿`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  function measure(): void {
    if (!trigger || typeof window === "undefined") return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(440, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const top = rect.bottom + 6;
    const maxHeight = Math.max(200, window.innerHeight - top - 8);
    menuStyle = `top:${top}px;left:${left}px;width:${width}px;max-height:${maxHeight}px`;
  }

  function toggle(): void {
    if (open) {
      close(true);
      return;
    }
    measure();
    open = true;
    void tick().then(() => menu?.querySelector<HTMLElement>("[data-review-source-id] .review-source-switch")?.focus({ preventScroll: true }));
  }

  function close(refocus: boolean): void {
    if (!open) return;
    open = false;
    expanded = null;
    if (refocus) trigger?.focus({ preventScroll: true });
  }

  $effect(() => {
    if (!open || typeof window === "undefined") return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || menu?.contains(target) || trigger?.contains(target)) return;
      // 确认对话框等上层弹窗里的点击不算「点外面」。
      if ((target as Element).closest?.(".modal-backdrop, .modal-card")) return;
      close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const onResize = () => measure();
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  });

  function choose(entry: ReviewSourceEntry): void {
    close(false);
    if (!entry.active) onChoose(entry.reviewId);
  }

  function requestClose(ids: string[], scope: "current" | "single" | "all"): void {
    close(false);
    onClose(ids, scope);
  }
</script>

<section class="review-source-card" aria-label="审查来源">
  {#if remote}
    <div class="review-source-face" title={remote.path}>
      <span class="review-source-badge" aria-hidden="true"><Icon name="cloud" size={14} /></span>
      <span class="review-source-main">
        <strong>{remote.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || remote.path}</strong>
        <small>远程审查 · {remote.host}</small>
      </span>
    </div>
  {:else if entries.length > 0}
    <button
      type="button"
      class="review-source-face review-source-trigger"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label="选择 Cliora 审查来源"
      title={active ? `${active.projectLabel} · ${active.repoName}` : "选择审查来源"}
      bind:this={trigger}
      onclick={toggle}
    >
      <span class="review-source-badge" style={active ? `--badge-hue:${active.hue}` : undefined} aria-hidden="true">
        {#if active}{active.badge}{:else}<Icon name="sparkle" size={14} />{/if}
      </span>
      <span class="review-source-main">
        {#if active}
          <strong>{active.projectLabel} · {active.repoName}</strong>
          <small>
            {#if active.order}<span class="review-source-order" data-order={active.order}>{active.order}</span>{/if}
            {#if active.acceptedLabel}<span>{active.acceptedLabel}接受</span>{/if}
            {#if entries.length > 1}<span>共 {entries.length} 个来源</span>{/if}
          </small>
        {:else}
          <strong>未选择审查来源</strong>
          <small>{entries.length} 个来源 · 点此选择</small>
        {/if}
      </span>
      <Icon name="chevron-down" size={13} />
    </button>
  {/if}
  {#if progress && progress.total > 0}
    <div class="review-source-progress" role="group" aria-label={`阅读进度：已审阅 ${progress.reviewed} 个，共 ${progress.total} 个文件`}>
      <span class="review-source-progress-bar" aria-hidden="true">
        <span style={`width:${Math.round((progress.reviewed / progress.total) * 100)}%`}></span>
      </span>
      <span class="review-source-progress-text">
        {progress.reviewed === progress.total ? `已读完全部 ${progress.total} 个文件（仅为阅读进度）` : `已审阅 ${progress.reviewed} / ${progress.total}`}
      </span>
    </div>
  {/if}
  {#if notice}
    <p class="review-source-note" role="status">
      <span>{notice}</span>
      {#if onDismissNotice}
        <button type="button" class="icon-btn sm" aria-label="关闭审查提示" title="关闭这条提示" onclick={onDismissNotice}>
          <Icon name="x" size={12} />
        </button>
      {/if}
    </p>
  {/if}
  {#if lastReturn}<p class="review-source-note">已保留上次返回尝试，接收结果以 Cliora 为准</p>{/if}
</section>

{#if open}
  <div class="review-source-menu" role="dialog" aria-label="审查来源" tabindex="-1" style={menuStyle} bind:this={menu}>
    <ul aria-label="全部审查来源">
      {#each entries as entry (entry.reviewId)}
        {@const comments = commentText(entry)}
        <li data-review-source-id={entry.reviewId} class:current={entry.active}>
          <div class="review-source-row">
            <button
              type="button"
              class="review-source-switch"
              aria-current={entry.active ? "true" : undefined}
              disabled={Boolean(blockedReason)}
              title={blockedReason ?? (entry.active ? "当前审查来源" : `切换到 ${entry.projectLabel} · ${entry.repoName}`)}
              onclick={() => choose(entry)}
            >
              <span class="review-source-badge" style={`--badge-hue:${entry.hue}`} aria-hidden="true">{entry.badge}</span>
              <span class="review-source-main">
                <strong>{entry.repoName}</strong>
                <small>
                  <span>{entry.projectLabel}</span>
                  {#if entry.active}<span class="review-source-tag" data-tag="current">当前</span>{/if}
                  {#if entry.order}<span class="review-source-order" data-order={entry.order}>{entry.order}</span>{/if}
                  {#if entry.acceptedLabel}<span>{entry.acceptedLabel}</span>{/if}
                </small>
                <small>
                  <span>{progressText(entry)}</span>
                  {#if comments}<span>{comments}</span>{/if}
                </small>
              </span>
            </button>
            <button
              type="button"
              class="icon-btn sm"
              aria-expanded={expanded === entry.reviewId}
              aria-label={`${entry.repoName} 的来源详情`}
              title="查看会话 ID、审查 ID、路径与协议版本"
              onclick={() => (expanded = expanded === entry.reviewId ? null : entry.reviewId)}
            ><Icon name="info" size={13} /></button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              disabled={Boolean(blockedReason)}
              title={blockedReason ?? "关闭后仓库与阅读记录保留"}
              aria-label={`关闭审查来源 ${entry.reviewId.slice(0, 8)}`}
              onclick={() => requestClose([entry.reviewId], entry.active ? "current" : "single")}
            >关闭</button>
          </div>
          {#if expanded === entry.reviewId}
            <dl class="review-source-details">
              {#each entry.details as item (item.label)}
                <dt>{item.label}</dt>
                <dd><bdi>{item.value}</bdi></dd>
              {/each}
            </dl>
          {/if}
        </li>
      {/each}
    </ul>
    <div class="review-source-menu-foot">
      <small>
        来源仅在本次运行保留；重启后请从 Cliora 重新发起。
        {#if nearFull}已保留 {entries.length}/{max} 个来源{entries.length >= max ? "，已满：先关闭较早的来源再发起新的审查" : "，接近上限时可关闭较早的来源"}。{/if}
      </small>
      <span class="spacer"></span>
      {#if active}
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          disabled={Boolean(blockedReason)}
          title={blockedReason ?? "关闭当前审查来源；不会自动切到其他来源"}
          onclick={() => active && requestClose([active.reviewId], "current")}
        >关闭此审查来源</button>
      {/if}
      {#if entries.length > 1 || !active}
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          disabled={Boolean(blockedReason)}
          title={blockedReason ?? `关闭全部 ${entries.length} 个审查来源；仓库与阅读记录保留`}
          onclick={() => requestClose(entries.map((entry) => entry.reviewId), "all")}
        >关闭全部来源</button>
      {/if}
    </div>
  </div>
{/if}
