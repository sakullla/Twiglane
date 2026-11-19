<script module lang="ts">
  export type MergeMode = "merge" | "ff-only" | "rebase";
</script>

<script lang="ts">
  import type { BranchRecord, MergePreview, OpenedRepository } from "../types";
  import { BUSY_REASON, splitPath } from "../ui";
  import BranchPicker from "./BranchPicker.svelte";
  import Icon from "./Icon.svelte";
  import MergeReview from "./MergeReview.svelte";

  /**
   * 合并第一步：选两个分支、看检查结论、决定方式。整页是一列居中的卡片，从上往下读就是要做的事：
   * ① 方向（来源 → 目标，可互换，常用组合一键填入）；② 检查结论（能不能合、会不会冲突、要带入多少）；
   * ③ 方式与说明（只在分叉时出现）。将带入的提交和文件明细默认收起，需要时再展开。
   * 主操作在宿主底栏，点下去的就是这里描述的那件事。
   */
  interface Props {
    opened: OpenedRepository;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onFailure: (error: unknown) => void;
    branches: BranchRecord[];
    /** 主干分支，两个分支下拉框里用星标。 */
    mainBranches?: string[];
    current: string | null;
    source: string;
    target: string;
    mode: MergeMode;
    message: string;
    preview: MergePreview | null;
    previewing: boolean;
    previewError: string | null;
    blocked: boolean;
    onSource: (value: string) => void;
    onTarget: (value: string) => void;
    onSwap: () => void;
    onPick: (source: string, target: string) => void;
    onMode: (mode: MergeMode) => void;
    onMessage: (value: string) => void;
    onRecheck: () => void;
    onOpenStash: () => void;
    onOpenChanges?: () => void;
    /** 设置里的分支分组：两个分支选择器按它显示目录或平铺。 */
    branchGroups?: boolean;
  }

  let {
    opened,
    nextId,
    onGeneration,
    onFailure,
    branches,
    mainBranches = [],
    current,
    source,
    target,
    mode,
    message,
    preview,
    previewing,
    previewError,
    blocked,
    onSource,
    onTarget,
    onSwap,
    onPick,
    onMode,
    onMessage,
    onRecheck,
    onOpenStash,
    onOpenChanges,
    branchGroups = true,
  }: Props = $props();

  /** 合并说明默认收成一行摘要：多数人用默认说明就好，需要时再展开改。 */
  let editingMessage = $state(false);
  /** 将带入内容的明细默认收起：结论和数字已经够做决定。 */
  let detailsOpen = $state(false);

  let sourceRecord = $derived(branches.find((branch) => branch.name === source) ?? null);
  let swapReason = $derived(
    sourceRecord?.remote ? "来源是远程分支，不能作为合并目标" : !source || !target ? "先选择两端的分支" : null,
  );
  /** 默认基线分支：常见的主干名里第一个存在的本地分支。 */
  let base = $derived(
    ["main", "master", "develop", "dev", "trunk"].find((name) => branches.some((branch) => !branch.remote && branch.name === name)) ?? null,
  );
  let upstreamOfBase = $derived(
    base ? (branches.find((branch) => !branch.remote && branch.name === base)?.upstream ?? null) : null,
  );
  let suggestions = $derived.by(() => {
    const list: { source: string; target: string; title: string; hint: string }[] = [];
    if (!current) return list;
    if (base && base !== current) {
      list.push({ source: base, target: current, title: `用 ${base} 更新 ${current}`, hint: "把主干的新提交带进当前分支" });
      list.push({ source: current, target: base, title: `把 ${current} 合并到 ${base}`, hint: "功能完成后交付到主干" });
    }
    if (upstreamOfBase && base !== current && branches.some((branch) => branch.name === upstreamOfBase)) {
      list.push({ source: upstreamOfBase, target: current, title: `用 ${upstreamOfBase} 更新 ${current}`, hint: "直接取远程主干（以最近一次获取为准）" });
    }
    return list;
  });

  let ready = $derived(Boolean(preview && preview.source === source && preview.target === target));
  /** 目标上没有来源缺少的提交：只能快进，合并与变基都没有意义，方式选择整块不出现。 */
  let ffOnly = $derived(Boolean(ready && preview?.fastForward));
  /** 变基只改写当前分支：目标不是当前分支时这个选择不成立，不作为可选项。 */
  let rebaseReady = $derived(Boolean(current) && target === current);
  let hasContent = $derived(Boolean(ready && preview && preview.incoming > 0));
  let showMethod = $derived(Boolean(ready && preview && preview.incoming > 0 && preview.canStart && !ffOnly));
  /** 每种结论只给一句“下一步”，底部主操作和当前选择是同一件事。 */
  let nextStep = $derived.by(() => {
    if (previewError) return "重试检查不会修改任何文件；检查通过前，底部主操作保持不可用。";
    if (!source || !target || !ready || !preview) return null;
    if (!preview.canStart) {
      return preview.blocker === "dirty" ? null : "按上面的原因调整选择；修正后会自动重新检查。";
    }
    if (ffOnly) return `开始后会把 ${preview.target} 直接快进到 ${preview.source}，不产生合并记录，也不会推送。`;
    if (preview.conflictCheck === "conflicts") {
      return `开始后逐处解决 ${preview.conflictPaths.length} 个文件里的冲突，全部解决后才能完成。`;
    }
    if (preview.conflictCheck === "unknown") return "无法提前预测冲突；如果出现冲突，可以逐处处理或中止。";
    return "合并只写本地，不会推送。";
  });

  function blockerTitle(code: string | null): string {
    switch (code) {
      case "dirty":
        return "先处理本地改动";
      case "up_to_date":
        return "已经是最新，不需要合并";
      case "same":
        return "来源和目标是同一个分支";
      case "remote_target":
        return "只能合并到本地分支";
      case "detached":
        return "当前不在本地分支上";
      case "operation":
        return "仓库里有未完成的操作";
      default:
        return "暂时不能合并";
    }
  }

  /** 方向下面的一条提醒：会先切换分支最要紧，其次是来源只是远程跟踪分支。 */
  let barNote = $derived.by<{ tone: "info" | "muted"; text: string } | null>(() => {
    if (!source || !target) return null;
    if (mode === "rebase" && !ffOnly) return { tone: "muted", text: "变基只改写当前分支，不会切换" };
    if (target !== current) return { tone: "info", text: `开始时会先切换到 ${target}` };
    if (sourceRecord?.remote) return { tone: "muted", text: "来源是远程跟踪分支，以最近一次获取为准" };
    return null;
  });

  // 目标被换成别的分支时，变基选择不再适用：退回合并方式，而不是留下一个点不动的选项。
  function chooseTarget(value: string) {
    if (mode === "rebase" && value !== current) onMode("merge");
    onTarget(value);
  }

  function choosePair(from: string, into: string) {
    if (mode === "rebase" && into !== current) onMode("merge");
    onPick(from, into);
  }

  function swapDirection() {
    if (mode === "rebase" && source !== current) onMode("merge");
    onSwap();
  }
</script>

<div class="merge-setup">
  <!-- ① 方向：来源 → 目标，两端都可选、可互换；常用组合一键填入。 -->
  <section class="ms-card" aria-label="合并方向">
    <div class="ms-card-head">
      <h3>要合并哪两个分支</h3>
    </div>
    <div class="ms-pair">
      <div class="ms-end">
        <span class="ms-end-label">来源 · 带入改动</span>
        <BranchPicker
          label="来源分支"
          {branches}
          value={source}
          {current}
          exclude={target}
          excludeReason="它已经是合并目标"
          disabled={blocked}
          {branchGroups}
          {mainBranches}
          onChange={onSource}
        />
      </div>
      <button
        type="button"
        class="merge-swap"
        aria-label="交换来源和目标"
        title={swapReason ?? "交换方向"}
        disabled={blocked || Boolean(swapReason)}
        onclick={swapDirection}
      ><Icon name="swap" size={14} /></button>
      <div class="ms-end">
        <span class="ms-end-label">{mode === "rebase" && !ffOnly ? "变基 · 改写这个分支" : "目标 · 合并到"}</span>
        <BranchPicker
          label="目标分支"
          {branches}
          value={target}
          {current}
          localOnly
          exclude={source}
          excludeReason="它已经是合并来源"
          disabled={blocked}
          {branchGroups}
          {mainBranches}
          onChange={chooseTarget}
        />
      </div>
    </div>
    {#if barNote || suggestions.length > 0}
      <div class="ms-meta">
        {#if barNote}
          <span class={`merge-bar-note ${barNote.tone}`} title={barNote.text}><Icon name={barNote.tone === "info" ? "info" : "cloud"} size={12} /><span class="truncate">{barNote.text}</span></span>
        {/if}
        {#if suggestions.length > 0}
          <div class="ms-quick" role="group" aria-label="常用合并">
            <span class="ms-quick-label">常用</span>
            {#each suggestions as item (`${item.source}->${item.target}`)}
              <button
                type="button"
                class="ms-chip"
                aria-pressed={item.source === source && item.target === target}
                title={blocked ? BUSY_REASON : item.hint}
                disabled={blocked}
                onclick={() => choosePair(item.source, item.target)}
              >{item.title}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- ② 检查结论：一眼看出能不能合、会不会冲突；明细默认收起。 -->
  <section class="ms-card merge-check" aria-label="合并预览" aria-busy={previewing}>
    {#if previewError}
      <div class="merge-verdict blocked">
        <span class="merge-verdict-icon"><Icon name="alert-circle" size={16} /></span>
        <div class="merge-verdict-copy">
          <strong>没有完成检查</strong>
          <p>{previewError}{#if nextStep}<span class="merge-next"> {nextStep}</span>{/if}</p>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={onRecheck}><Icon name="refresh" size={13} />重试</button>
      </div>
    {:else if !source || !target}
      <div class="merge-verdict idle">
        <span class="merge-verdict-icon"><Icon name="merge" size={16} /></span>
        <div class="merge-verdict-copy"><strong>选择两个分支</strong><p>选好后自动检查要带入的提交、文件和可能的冲突。</p></div>
      </div>
    {:else if !ready || !preview}
      <div class="merge-verdict idle">
        <span class="merge-verdict-icon"><span class="spinner"></span></span>
        <div class="merge-verdict-copy"><strong>正在检查 {source} → {target}</strong><p>只读检查，不会修改任何文件。</p></div>
      </div>
    {:else}
      {@const conflicts = preview.conflictCheck === "conflicts"}
      {@const tone = preview.canStart ? (conflicts ? "warn" : "ok") : preview.blocker === "up_to_date" ? "idle" : "blocked"}
      <div class={`merge-verdict ${tone}`} role="status">
        <span class="merge-verdict-icon">
          <Icon name={!preview.canStart ? (preview.blocker === "up_to_date" ? "check-circle" : "alert") : conflicts ? "alert" : "check-circle"} size={16} />
        </span>
        <div class="merge-verdict-copy">
          {#if !preview.canStart}
            <strong>{blockerTitle(preview.blocker)}</strong>
          {:else if conflicts}
            <strong>预计 {preview.conflictPaths.length} 个文件有冲突</strong>
          {:else if preview.conflictCheck === "unknown"}
            <strong>可以合并（无法提前预测冲突）</strong>
          {:else if ffOnly}
            <strong>可以快进，没有冲突</strong>
          {:else}
            <strong>可以合并，没有冲突</strong>
          {/if}
          <p>
            {preview.note}{#if nextStep}<span class="merge-next"> {nextStep}</span>{/if}{#if previewing}<span class="hint"> 正在按最新状态重新检查…</span>{/if}
          </p>
        </div>
        {#if previewing}<span class="spinner muted"></span>{/if}
      </div>

      {#if preview.incoming > 0}
        <div class="ms-stats" aria-label={`将带入 ${preview.incoming} 个提交、${preview.filesTotal} 个文件`}>
          <div class="ms-stat" title={`来源分支 ${preview.source} 将带入 ${preview.incoming} 个提交`}><strong>{preview.incoming}</strong><span>个提交带入</span></div>
          <div class="ms-stat"><strong>{preview.filesTotal}</strong><span>个文件变化</span></div>
          <div class="ms-stat" class:warn={preview.conflictPaths.length > 0}><strong>{preview.conflictPaths.length}</strong><span>个可能冲突</span></div>
          {#if preview.outgoing > 0}
            <div class="ms-stat muted" title={`目标分支 ${preview.target} 自分叉以来独有 ${preview.outgoing} 个提交`}><strong>{preview.outgoing}</strong><span>个目标独有提交</span></div>
          {/if}
        </div>
      {/if}

      {#if conflicts && preview.canStart && preview.conflictPaths.length > 0}
        <ul class="ms-conflicts" aria-label="预计冲突的文件">
          {#each preview.conflictPaths.slice(0, 5) as path (path)}
            {@const parts = splitPath(path)}
            <li title={path}><Icon name="alert" size={12} /><span class="ms-conflict-name">{parts.name}</span>{#if parts.dir}<bdi class="ms-conflict-dir">{parts.dir}</bdi>{/if}</li>
          {/each}
          {#if preview.conflictPaths.length > 5}<li class="ms-conflicts-more">还有 {preview.conflictPaths.length - 5} 个文件</li>{/if}
        </ul>
      {/if}

      {#if preview.blocker === "dirty"}
        <div class="merge-dirty">
          <ul class="merge-dirty-list" aria-label="本地改动">
            {#each preview.localPaths as path (path)}<li title={path}><Icon name="file-diff" size={12} />{path}</li>{/each}
          </ul>
          <div class="merge-dirty-actions">
            <button type="button" class="btn btn-primary btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={onOpenChanges ?? onOpenStash}><Icon name="commit" size={13} />去提交改动</button>
            <button type="button" class="btn btn-secondary btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={onOpenStash}><Icon name="archive" size={13} />临时保存</button>
            <span class="spacer"></span>
            <button type="button" class="btn btn-ghost btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={onRecheck}><Icon name="refresh" size={13} />处理后重新检查</button>
          </div>
          <p class="merge-dirty-note">未跟踪的新文件不会阻止合并；只有已跟踪文件的未提交改动需要先处理。</p>
        </div>
      {/if}

      {#if hasContent}
        <button
          type="button"
          class="ms-disclosure"
          aria-expanded={detailsOpen}
          aria-controls="merge-setup-details"
          onclick={() => (detailsOpen = !detailsOpen)}
        >
          <Icon name="chevron-right" size={13} class={detailsOpen ? "ms-rot" : ""} />
          {detailsOpen ? "收起改动明细" : "查看改动明细"}
          <span class="ms-disclosure-hint">逐个文件、逐个提交对照</span>
        </button>
      {/if}
    {/if}
  </section>

  {#if hasContent && detailsOpen && preview}
    <div class="ms-review" id="merge-setup-details">
      <MergeReview {opened} {preview} disabled={blocked} {nextId} {onGeneration} {onFailure} />
    </div>
  {/if}

  <!-- ③ 方式与说明：只在分叉时出现；快进只有一句结论。 -->
  {#if ready && preview && preview.incoming > 0 && preview.canStart && ffOnly}
    <section class="ms-card ms-method" aria-label="合并方式与说明">
      <span class="merge-options-ff"><Icon name="arrow-right" size={13} />快进：直接前移 {preview.target}，不产生合并记录</span>
    </section>
  {:else if showMethod}
    <section class="ms-card ms-method" aria-label="合并方式与说明">
      <div class="ms-card-head"><h3>怎么合并</h3></div>
      <div class="ms-modes" role="radiogroup" aria-label="方式">
        <button type="button" class="ms-mode" role="radio" aria-checked={mode !== "rebase"} title={blocked ? BUSY_REASON : "保留两边的历史，多一条合并记录"} disabled={blocked} onclick={() => onMode("merge")}>
          <span class="ms-mode-dot" aria-hidden="true"></span>
          <span class="ms-mode-copy"><strong>创建合并提交<span class="merge-mode-tag">推荐</span></strong><small>保留两边的历史，多一条合并记录</small></span>
        </button>
        <button type="button" class="ms-mode" role="radio" aria-checked={mode === "rebase"} aria-label="变基" title={blocked ? BUSY_REASON : rebaseReady ? "把当前分支的提交接到来源之后，会改写历史" : `变基只改写当前分支，请先把目标设为当前分支${current ? `（${current}）` : ""}`} disabled={blocked || !rebaseReady} onclick={() => onMode("rebase")}>
          <span class="ms-mode-dot" aria-hidden="true"></span>
          <span class="ms-mode-copy"><strong>变基</strong><small>{rebaseReady ? "历史保持一条直线，会改写当前分支" : "只能改写当前分支"}</small></span>
        </button>
      </div>
      {#if mode === "rebase"}
        <p class="merge-mode-note warn" title={`将改写当前分支上尚未进入 ${source} 的提交。远程不会改变，也不会推送。`}>
          <Icon name="alert" size={13} /><span>将改写当前分支上尚未进入 {source} 的提交，不会推送。</span>
        </p>
      {:else}
        <div class="ms-message">
          <span class="merge-message-label">合并说明</span>
          {#if editingMessage}
            <!-- svelte-ignore a11y_autofocus -->
            <input class="input" aria-label="合并说明" value={message} autofocus title={blocked ? BUSY_REASON : undefined} disabled={blocked} oninput={(event) => onMessage((event.currentTarget as HTMLInputElement).value)} onkeydown={(event) => { if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); event.stopPropagation(); editingMessage = false; } }} onblur={() => (editingMessage = false)} />
          {:else}
            <button type="button" class="merge-message-preview" aria-label="编辑合并说明" disabled={blocked} title={blocked ? BUSY_REASON : `${message}\n点击编辑合并说明`} onclick={() => (editingMessage = true)}>
              <code>{message || "（空）"}</code><Icon name="pencil" size={12} />
            </button>
          {/if}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .merge-setup {
    width: min(820px, 100%);
    height: auto;
    margin: 0 auto;
    padding: var(--space-24) var(--space-16) var(--space-32);
    display: flex;
    flex-direction: column;
    gap: var(--space-12);
  }
  .ms-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-12);
    padding: var(--space-16);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow-sm), inset 0 0 0 1px var(--border);
    min-width: 0;
  }
  .ms-card-head { display: flex; align-items: center; gap: var(--space-8); }
  .ms-card-head h3 { margin: 0; font-size: var(--text-base); font-weight: var(--weight-semibold); color: var(--fg); }
  .ms-pair { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: end; gap: var(--space-12); }
  .ms-end { display: flex; flex-direction: column; gap: var(--space-6); min-width: 0; }
  .ms-end-label { color: var(--fg-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .ms-pair .merge-swap { margin-bottom: 8px; }
  .ms-meta { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-8); min-width: 0; }
  .ms-quick { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-6); margin-left: auto; min-width: 0; }
  .ms-quick-label { color: var(--fg-subtle); font-size: var(--text-xs); }
  .ms-chip {
    height: 24px;
    padding: 0 var(--space-8);
    border-radius: 999px;
    border: 1px solid var(--control-border);
    background: var(--surface);
    color: var(--fg-muted);
    font-size: var(--text-xs);
    white-space: nowrap;
    transition: border-color var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease);
  }
  .ms-chip:hover:not(:disabled) { border-color: var(--control-border-hover); color: var(--fg); }
  .ms-chip[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); }
  .ms-chip:disabled { opacity: var(--opacity-disabled); cursor: not-allowed; }

  .merge-check .merge-verdict { box-shadow: none; }
  .ms-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--space-8); }
  .ms-stat { display: flex; align-items: baseline; gap: var(--space-6); padding: var(--space-8) var(--space-12); border-radius: var(--radius); background: var(--surface-2); color: var(--fg-muted); font-size: var(--text-xs); }
  .ms-stat strong { color: var(--fg); font-size: var(--text-lg); font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; }
  .ms-stat.warn strong { color: var(--warning-text); }
  .ms-stat.muted strong { color: var(--fg-muted); }
  .ms-conflicts { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
  .ms-conflicts li { display: flex; align-items: center; gap: var(--space-6); min-height: 24px; min-width: 0; font-size: var(--text-sm); }
  .ms-conflicts li > :global(.icon) { flex: none; color: var(--warning-text); }
  .ms-conflict-name { flex: none; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); color: var(--fg); }
  .ms-conflict-dir { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-subtle); font-size: var(--text-xs); direction: rtl; text-align: left; }
  .ms-conflicts-more { color: var(--fg-subtle); font-size: var(--text-xs); padding-left: 18px; }
  .ms-disclosure { align-self: flex-start; display: inline-flex; align-items: center; gap: var(--space-6); height: 28px; padding: 0 var(--space-8); margin-left: calc(var(--space-8) * -1); border-radius: var(--radius-sm); color: var(--accent-text); font-size: var(--text-sm); font-weight: var(--weight-medium); }
  .ms-disclosure:hover { background: var(--hover); }
  .ms-disclosure :global(.icon) { transition: transform var(--duration-fast) var(--ease); }
  .ms-disclosure :global(.ms-rot) { transform: rotate(90deg); }
  .ms-disclosure-hint { color: var(--fg-subtle); font-size: var(--text-xs); font-weight: var(--weight-normal); }
  .ms-review { display: flex; align-self: center; width: min(1180px, calc(100vw - 96px)); height: min(560px, 62vh); min-height: 320px; }
  .ms-review > :global(.merge-review) { flex: 1; }

  .ms-modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-8); }
  .ms-mode {
    display: flex;
    align-items: flex-start;
    gap: var(--space-8);
    padding: var(--space-12);
    border-radius: var(--radius);
    border: 1px solid var(--control-border);
    background: var(--surface);
    text-align: left;
    transition: border-color var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease);
  }
  .ms-mode:hover:not(:disabled) { border-color: var(--control-border-hover); }
  .ms-mode[aria-checked="true"] { border-color: var(--accent); background: var(--accent-softer); box-shadow: 0 0 0 1px var(--accent); }
  .ms-mode:disabled { opacity: var(--opacity-disabled); cursor: not-allowed; }
  .ms-mode-dot { flex: none; width: 14px; height: 14px; margin-top: 2px; border-radius: 50%; border: 1.5px solid var(--control-border-hover); background: var(--surface); }
  .ms-mode[aria-checked="true"] .ms-mode-dot { border: 4px solid var(--accent); }
  .ms-mode-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ms-mode-copy strong { display: inline-flex; align-items: center; color: var(--fg); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  .ms-mode-copy small { color: var(--fg-muted); font-size: var(--text-xs); }
  .ms-message { display: flex; align-items: center; gap: var(--space-8); min-width: 0; }
  .ms-message .input { flex: 1; min-width: 0; height: 30px; font-family: var(--mono); font-size: var(--text-sm); }

  @media (max-width: 720px) {
    .ms-pair { grid-template-columns: minmax(0, 1fr); }
    .ms-pair .merge-swap { justify-self: center; margin: 0; transform: rotate(90deg); }
    .ms-modes { grid-template-columns: minmax(0, 1fr); }
  }
</style>
