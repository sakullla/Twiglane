<script module lang="ts">
  export type MergeMode = "merge" | "ff-only";
</script>

<script lang="ts">
  import { commitFileLabel, formatAuthoredAt, shortOid } from "../history";
  import type { BranchRecord, MergePreview } from "../types";
  import { BUSY_REASON, hueOf, initialOf, relativeTime, splitPath, statusMark } from "../ui";
  import BranchPicker from "./BranchPicker.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    branches: BranchRecord[];
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
  }

  let {
    branches,
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
  }: Props = $props();

  let tab = $state<"commits" | "files" | "conflicts">("commits");

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
  let shownConflicts = $derived(ready && preview ? preview.conflictPaths : []);

  $effect(() => {
    if (!ready || !preview) return;
    if (tab === "conflicts" && preview.conflictPaths.length === 0) tab = "commits";
    if (tab === "commits" && preview.commits.length === 0 && preview.files.length > 0) tab = "files";
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
</script>

<div class="merge-setup">
  <section class="merge-route-card" aria-label="合并方向">
    <div class="merge-endpoint">
      <span class="merge-endpoint-label"><span class="merge-endpoint-dot source"></span>从这个分支带来改动</span>
      <BranchPicker
        label="来源分支"
        {branches}
        value={source}
        {current}
        exclude={target}
        excludeReason="它已经是合并目标"
        disabled={blocked}
        onChange={onSource}
      />
      <small>{sourceRecord?.remote ? "远程跟踪分支：内容以最近一次获取为准" : source === current ? "你正在使用的分支" : "本地分支"}</small>
    </div>

    <div class="merge-flow" aria-hidden="false">
      <span class="merge-flow-track"><span class="merge-flow-arrow"><Icon name="arrow-right" size={16} /></span></span>
      <button
        type="button"
        class="merge-swap"
        aria-label="交换来源和目标"
        title={swapReason ?? "交换方向：把目标合并到来源"}
        disabled={blocked || Boolean(swapReason)}
        onclick={onSwap}
      ><Icon name="swap" size={14} /></button>
    </div>

    <div class="merge-endpoint target">
      <span class="merge-endpoint-label"><span class="merge-endpoint-dot target"></span>合并结果留在这个分支</span>
      <BranchPicker
        label="目标分支"
        {branches}
        value={target}
        {current}
        localOnly
        exclude={source}
        excludeReason="它已经是合并来源"
        disabled={blocked}
        onChange={onTarget}
      />
      <small class:switch-note={target !== current}>
        {#if target === current}当前分支，合并直接在这里进行{:else}<Icon name="info" size={12} />开始时会先切换到 {target}{/if}
      </small>
    </div>
  </section>

  {#if suggestions.length > 0}
    <div class="merge-suggest" role="group" aria-label="常用合并">
      <span class="merge-suggest-label">常用</span>
      {#each suggestions as item (`${item.source}->${item.target}`)}
        <button
          type="button"
          class="merge-suggest-chip"
          aria-pressed={item.source === source && item.target === target}
          title={item.hint}
          disabled={blocked}
          onclick={() => onPick(item.source, item.target)}
        >{item.title}</button>
      {/each}
    </div>
  {/if}

  <section class="merge-check" aria-label="合并预览" aria-busy={previewing}>
    {#if previewError}
      <div class="merge-verdict blocked">
        <span class="merge-verdict-icon"><Icon name="alert-circle" size={18} /></span>
        <div><strong>没有完成检查</strong><p>{previewError}</p></div>
        <button type="button" class="btn btn-secondary btn-sm" title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={onRecheck}><Icon name="refresh" size={13} />重试</button>
      </div>
    {:else if !source || !target}
      <div class="merge-verdict idle">
        <span class="merge-verdict-icon"><Icon name="merge" size={18} /></span>
        <div><strong>选择两个分支</strong><p>选好后会自动检查：带入哪些提交、改了哪些文件、会不会冲突。检查不会修改任何文件。</p></div>
      </div>
    {:else if !ready || !preview}
      <div class="merge-verdict idle">
        <span class="spinner"></span>
        <div><strong>正在检查 {source} → {target}</strong><p>只读比较，不会修改工作区。</p></div>
      </div>
    {:else}
      {@const conflicts = preview.conflictCheck === "conflicts"}
      {@const tone = preview.canStart ? (conflicts ? "warn" : "ok") : preview.blocker === "up_to_date" ? "idle" : "blocked"}
      <div class={`merge-verdict ${tone}`} role="status">
        <span class="merge-verdict-icon">
          <Icon name={!preview.canStart ? (preview.blocker === "up_to_date" ? "check-circle" : "alert") : conflicts ? "alert" : "check-circle"} size={18} />
        </span>
        <div>
          {#if !preview.canStart}
            <strong>{blockerTitle(preview.blocker)}</strong>
          {:else if conflicts}
            <strong>预计 {preview.conflictPaths.length} 个文件有冲突</strong>
          {:else if preview.conflictCheck === "unknown"}
            <strong>可以合并（无法提前预测冲突）</strong>
          {:else}
            <strong>可以合并，没有冲突</strong>
          {/if}
          <p>{preview.note}{#if preview.canStart && conflicts} 开始后逐处解决，可随时中止。{/if}</p>
        </div>
        {#if previewing}<span class="spinner muted"></span>{/if}
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

      {#if preview.incoming > 0}
        <div class="merge-stats">
          <div class="merge-stat"><strong>{preview.incoming}</strong><span>个提交将带入 {preview.target}</span></div>
          <div class="merge-stat"><strong>{preview.filesTotal}</strong><span>个文件有改动</span></div>
          <div class={`merge-stat ${conflicts ? "warn" : preview.conflictCheck === "clean" ? "ok" : ""}`}>
            <strong>{conflicts ? preview.conflictPaths.length : preview.conflictCheck === "clean" ? "0" : "?"}</strong>
            <span>{conflicts ? "个文件预计冲突" : preview.conflictCheck === "clean" ? "冲突" : "冲突无法预测"}</span>
          </div>
          <div class="merge-stat">
            <strong>{preview.outgoing}</strong>
            <span>{preview.outgoing === 0 ? `${preview.target} 没有新提交，可以快进` : `个提交只在 ${preview.target} 上`}</span>
          </div>
        </div>

      {#if ready && preview?.canStart}
        <section class="merge-options" aria-label="合并方式">
          <div class="merge-mode" role="radiogroup" aria-label="合并方式">
            <button type="button" role="radio" class="merge-mode-card" aria-checked={mode === "merge"} title={blocked ? BUSY_REASON : undefined} disabled={blocked} onclick={() => onMode("merge")}>
              <span class="merge-mode-radio"></span>
              <span><strong>创建合并提交</strong><small>保留分支历史，一眼看出这次合并，推荐</small></span>
            </button>
            <button
              type="button"
              role="radio"
              class="merge-mode-card"
              aria-checked={mode === "ff-only"}
              disabled={blocked || !preview.fastForward}
              title={preview.fastForward ? "" : `${preview.target} 上有来源没有的提交，不能快进`}
              onclick={() => onMode("ff-only")}
            >
              <span class="merge-mode-radio"></span>
              <span><strong>快进</strong><small>{preview.fastForward ? "直接把目标移到来源的最新提交，不产生合并提交" : "两边已经分叉，不能快进"}</small></span>
            </button>
          </div>
          {#if mode === "merge"}
            <label class="merge-message">
              <span>合并说明</span>
              <input class="input" aria-label="合并说明" value={message} title={blocked ? BUSY_REASON : undefined} disabled={blocked} oninput={(event) => onMessage((event.currentTarget as HTMLInputElement).value)} />
            </label>
          {/if}
        </section>
      {/if}

        <div class="merge-tabs" role="tablist" aria-label="合并内容">
          <button type="button" role="tab" aria-selected={tab === "commits"} onclick={() => (tab = "commits")}>提交<span class="count">{preview.incoming}</span></button>
          <button type="button" role="tab" aria-selected={tab === "files"} onclick={() => (tab = "files")}>文件<span class="count">{preview.filesTotal}</span></button>
          {#if shownConflicts.length > 0}
            <button type="button" role="tab" aria-selected={tab === "conflicts"} onclick={() => (tab = "conflicts")}>预计冲突<span class="count warning">{shownConflicts.length}</span></button>
          {/if}
        </div>
        <div class="merge-tab-body" role="tabpanel">
          {#if tab === "commits"}
            <ul class="merge-commit-list" aria-label="将带入的提交">
              {#each preview.commits as commit (commit.oid)}
                <li title={`${commit.summary}\n${commit.authorName} · ${formatAuthoredAt(commit.authoredAt)}`}>
                  <span class="avatar" style={`--hue:${hueOf(commit.authorName)}`} aria-hidden="true">{initialOf(commit.authorName)}</span>
                  <span class="merge-commit-summary">{commit.summary}</span>
                  <span class="merge-commit-meta">{commit.authorName} · {relativeTime(commit.authoredAt)}</span>
                  <code>{shortOid(commit.oid)}</code>
                </li>
              {/each}
              {#if preview.incoming > preview.commits.length}
                <li class="merge-list-more">还有 {preview.incoming - preview.commits.length} 个更早的提交没有列出</li>
              {/if}
            </ul>
          {:else if tab === "files"}
            <ul class="merge-file-list" aria-label="将带入的文件">
              {#each preview.files as file (`${file.status}:${file.path}`)}
                {@const mark = statusMark(commitFileLabel(file.status))}
                {@const parts = splitPath(file.path)}
                {@const hot = preview.conflictPaths.includes(file.path)}
                <li title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}>
                  <span class={`st ${mark.tone}`}>{mark.letter}</span>
                  <span class="merge-file-name">{parts.name}</span>
                  {#if parts.dir}<span class="merge-file-dir">{parts.dir}</span>{/if}
                  {#if hot}<span class="merge-hot">可能冲突</span>{/if}
                </li>
              {/each}
              {#if preview.filesTotal > preview.files.length}
                <li class="merge-list-more">还有 {preview.filesTotal - preview.files.length} 个文件没有列出</li>
              {/if}
            </ul>
          {:else}
            <ul class="merge-file-list" aria-label="预计冲突的文件">
              {#each shownConflicts as path (path)}
                {@const parts = splitPath(path)}
                <li title={path}>
                  <span class="st st-con">!</span>
                  <span class="merge-file-name">{parts.name}</span>
                  {#if parts.dir}<span class="merge-file-dir">{parts.dir}</span>{/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    {/if}
  </section>

</div>
