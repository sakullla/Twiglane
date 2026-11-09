<script module lang="ts">
  export type MergeMode = "merge" | "ff-only" | "rebase";
</script>

<script lang="ts">
  import type { BranchRecord, MergePreview, OpenedRepository } from "../types";
  import { BUSY_REASON } from "../ui";
  import { portal } from "../portal";
  import BranchPicker from "./BranchPicker.svelte";
  import Icon from "./Icon.svelte";
  import MergeReview from "./MergeReview.svelte";
  import ContextMenu, { type ContextMenuRequest } from "./ContextMenu.svelte";

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
    /** 合并方式与说明的落点（宿主底部操作条）；不给时留在本组件末尾。 */
    optionsTarget?: HTMLElement | null;
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
    optionsTarget = null,
  }: Props = $props();

  /** 合并说明默认收成一行摘要：多数人用默认说明就好，需要时再展开改。 */
  let editingMessage = $state(false);

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
      list.push({ source: upstreamOfBase, target: current, title: `用 ${upstreamOfBase} 更新 ${current}`, hint: "直接取远程主干（先在同步里获取）" });
    }
    return list;
  });

  let ready = $derived(Boolean(preview && preview.source === source && preview.target === target));
  /** 目标上没有来源缺少的提交：只能快进，合并与变基都没有意义，方式选择整块不出现。 */
  let ffOnly = $derived(Boolean(ready && preview?.fastForward));
  /** 变基只改写当前分支：目标不是当前分支时这个选择不成立，不作为可选项。 */
  let rebaseReady = $derived(Boolean(current) && target === current);
  /** 有内容可审阅时下半部分整块交给审阅区，配置区收紧。 */
  let reviewing = $derived(Boolean(ready && preview && preview.incoming > 0));
  /** 每种结论只给一句“下一步”，底部主操作和当前选择才是同一件事。 */
  let nextStep = $derived.by(() => {
    if (previewError) return "重试检查不会修改任何文件；检查通过前，底部主操作保持不可用。";
    if (!source || !target || !ready || !preview) return null;
    if (!preview.canStart) {
      return preview.blocker === "dirty"
        ? null
        : "按上面的原因调整选择；修正后会自动重新检查。";
    }
    if (ffOnly) return `开始后会把 ${preview.target} 直接快进到 ${preview.source}：目标没有自己的新提交，不产生合并记录，也不会推送。`;
    if (preview.conflictCheck === "conflicts") {
      return `开始后逐处解决 ${preview.conflictPaths.length} 个文件里的冲突，全部标记为已解决后才能完成。`;
    }
    if (preview.conflictCheck === "unknown") return "无法提前预测冲突；开始后如果出现冲突，仍可逐处处理或中止。";
    return "确认内容和方式后开始合并；合并只写本地，不会推送。";
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

  let suggestMenu = $state<ContextMenuRequest | null>(null);

  function openSuggestions(anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    suggestMenu = {
      x: rect.left,
      y: rect.bottom + 4,
      label: "常用合并",
      entries: suggestions.map((item) => ({
        id: `${item.source}->${item.target}`,
        label: item.title,
        icon: "merge" as const,
        checked: item.source === source && item.target === target,
        run: () => choosePair(item.source, item.target),
      })),
    };
  }

  /** 句尾的一条方向提醒：会先切换分支最要紧，其次是来源只是远程跟踪分支。 */
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

<div class="merge-setup" class:reviewing>
  <!-- 方向读成一句话：「把 A 合并到 B」。两端都可选、可互换；与方向有关的提醒（会先切换分支、
       来源是远程跟踪分支）跟在句尾，常用组合排在同一行的右侧，整块只占一行。 -->
  <section class="merge-bar" aria-label="合并方向">
    <span class="merge-bar-word">把</span>
    <div class="merge-bar-picker source">
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
    <span class="merge-bar-word">{mode === "rebase" && !ffOnly ? "作为基底，变基" : "合并到"}</span>
    <div class="merge-bar-picker target">
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
    <button
      type="button"
      class="merge-swap"
      aria-label="交换来源和目标"
      title={swapReason ?? "交换方向：把目标合并到来源"}
      disabled={blocked || Boolean(swapReason)}
      onclick={swapDirection}
    ><Icon name="swap" size={14} /></button>
    {#if barNote}
      <span class={`merge-bar-note ${barNote.tone}`} title={barNote.text}><Icon name={barNote.tone === "info" ? "info" : "cloud"} size={12} /><span class="truncate">{barNote.text}</span></span>
    {/if}
    {#if suggestions.length > 0}
      <!-- 常用组合收进一个菜单：方向条保持一行，长分支名也不会把它们挤到第二行。 -->
      <button
        type="button"
        class="btn btn-ghost btn-sm merge-suggest"
        aria-haspopup="menu"
        aria-expanded={suggestMenu !== null}
        title={blocked ? BUSY_REASON : "常用的合并方向"}
        disabled={blocked}
        onclick={(event) => openSuggestions(event.currentTarget as HTMLElement)}
      ><Icon name="list" size={13} />常用<Icon name="chevron-down" size={12} /></button>
    {/if}
  </section>

  <!-- 检查结论：有内容可审阅时收成一条状态行，把高度留给下面的提交与文件；
       不能合并或已经是最新时，它就是这一页的主体，居中放大。 -->
  <section class="merge-check" class:solo={!reviewing} aria-label="合并预览" aria-busy={previewing}>
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
        <div class="merge-verdict-copy"><strong>选择两个分支</strong><p>选好后会自动检查：带入哪些提交、改了哪些文件、会不会冲突。检查不会修改任何文件。</p></div>
      </div>
    {:else if !ready || !preview}
      <div class="merge-verdict idle">
        <span class="merge-verdict-icon"><span class="spinner"></span></span>
        <div class="merge-verdict-copy"><strong>正在检查 {source} → {target}</strong><p>只读比较，不会修改工作区。</p></div>
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
        {#if preview.incoming > 0}
          <span class="merge-verdict-stats" aria-label={`将带入 ${preview.incoming} 个提交、${preview.filesTotal} 个文件`}>
            <span><strong>{preview.incoming}</strong>个提交</span>
            <span><strong>{preview.filesTotal}</strong>个文件</span>
            {#if preview.conflictPaths.length > 0}<span class="warn"><strong>{preview.conflictPaths.length}</strong>处可能冲突</span>{/if}
          </span>
        {/if}
      </div>

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
    {/if}
  </section>

  {#if suggestMenu}
    <ContextMenu request={suggestMenu} onClose={() => (suggestMenu = null)} />
  {/if}

  {#if reviewing && preview}
    <MergeReview {opened} {preview} disabled={blocked} {nextId} {onGeneration} {onFailure} />
  {/if}

  <!-- 合并方式与说明是「怎么执行」的决定，和主操作放在一起：宿主给了落点（底部操作条）就搬过去，
       单独渲染时留在原处。搬走的必须是这个常驻节点，见 MergePanel 头部的同一条说明。 -->
  <div class="merge-options-host" use:portal={optionsTarget}>
    {#if ready && preview && preview.incoming > 0 && preview.canStart}
      {#if ffOnly}
        <span class="merge-options-ff"><Icon name="arrow-right" size={13} />快进：直接前移 {preview.target}，不产生合并记录</span>
      {:else}
        <section class="merge-options" aria-label="合并方式与说明">
          <div class="segmented merge-mode" role="radiogroup" aria-label="方式">
            <button type="button" role="radio" aria-checked={mode !== "rebase"} title={blocked ? BUSY_REASON : "保留两边的历史，多一条合并记录"} disabled={blocked} onclick={() => onMode("merge")}>创建合并提交<span class="merge-mode-tag">推荐</span></button>
            <button type="button" role="radio" aria-checked={mode === "rebase"} title={blocked ? BUSY_REASON : rebaseReady ? "把当前分支的提交接到来源之后，会改写历史" : `变基只改写当前分支，请先把目标设为当前分支${current ? `（${current}）` : ""}`} disabled={blocked || !rebaseReady} onclick={() => onMode("rebase")}>变基</button>
          </div>
          {#if mode === "rebase"}
            <span class="merge-mode-note warn" title={`将改写当前分支上尚未进入 ${source} 的提交。远程不会改变，也不会推送。`}>
              <Icon name="alert" size={13} /><span class="truncate">将改写当前分支上尚未进入 {source} 的提交，不会推送</span>
            </span>
          {:else if editingMessage}
            <label class="merge-message">
              <span class="merge-message-label">说明</span>
              <!-- svelte-ignore a11y_autofocus -->
              <input class="input" aria-label="合并说明" value={message} autofocus title={blocked ? BUSY_REASON : undefined} disabled={blocked} oninput={(event) => onMessage((event.currentTarget as HTMLInputElement).value)} onkeydown={(event) => { if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); event.stopPropagation(); editingMessage = false; } }} onblur={() => (editingMessage = false)} />
            </label>
          {:else}
            <span class="merge-message-label">说明</span>
            <button type="button" class="merge-message-preview" aria-label="编辑合并说明" disabled={blocked} title={blocked ? BUSY_REASON : `${message}
点击编辑合并说明`} onclick={() => (editingMessage = true)}>
              <code>{message || "（空）"}</code><Icon name="pencil" size={12} />
            </button>
          {/if}
        </section>
      {/if}
    {/if}
  </div>
</div>
