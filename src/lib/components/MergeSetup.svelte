<script lang="ts">
  import type { BranchRecord, MergePreview, OpenedRepository } from "../types";
  import Icon from "./Icon.svelte";

  interface Props {
    opened: OpenedRepository;
    branches: BranchRecord[];
    source: string;
    preview: MergePreview | null;
    blocked: boolean;
    onSource: (value: string) => void;
    onPreview: () => void;
    onStart: () => void;
    onOpenStash: () => void;
    onOpenChanges?: () => void;
  }

  let { opened, branches, source, preview, blocked, onSource, onPreview, onStart, onOpenStash, onOpenChanges }: Props = $props();

  let choices = $derived(branches.filter((branch) => !branch.current && branch.name !== opened.snapshot.branch.name));
  let target = $derived(opened.snapshot.branch.name ?? "当前分支");
</script>

<div class="merge-guide">
  <div class="merge-guide-intro">
    <span class="merge-guide-icon"><Icon name="merge" size={19} /></span>
    <div><h2>把分支的改动合并进来</h2><p>先选择来源并检查条件，确认后才开始。预览不会修改任何文件。</p></div>
  </div>

  <div class="merge-guide-sentence">
    <span>把</span><strong>{source || "未选择分支"}</strong><span>的改动合并到</span><strong>{target}</strong>
  </div>

  <div class="merge-guide-branches">
    <div class="merge-guide-branch source">
      <span class="merge-guide-step">1. 改动从哪里来？</span>
      <label class="sr-only" for="merge-source">来源分支</label>
      <div class="merge-guide-select"><Icon name="branch" size={16} />
        <select id="merge-source" aria-label="来源分支" value={source} disabled={blocked} onchange={(event) => onSource((event.currentTarget as HTMLSelectElement).value)}>
          {#each choices as branch (branch.name)}<option value={branch.name}>{branch.remote ? `远程 ${branch.name}` : branch.name}</option>{/each}
        </select>
        <Icon name="chevron-down" size={14} />
      </div>
      <small>选择要带入当前工作的分支</small>
    </div>
    <div class="merge-guide-arrow"><Icon name="arrow-left" size={18} /><span>合并到</span></div>
    <div class="merge-guide-branch target">
      <span class="merge-guide-step">2. 合并到哪里？</span>
      <div class="merge-guide-target"><Icon name="branch" size={16} /><strong>{target}</strong><span class="chip current">当前</span></div>
      <small>你正在使用的分支，结果会留在这里</small>
    </div>
  </div>

  {#if preview}
    <div class={`merge-guide-result ${preview.canStart ? "ready" : "blocked"}`} aria-label="合并预览">
      <div class="merge-guide-result-head">
        <span class="merge-result-icon"><Icon name={preview.canStart ? "check-circle" : "alert"} size={17} /></span>
        <div><h3>{preview.canStart ? "可以开始合并" : "先处理本地改动"}</h3><p>来源 {preview.source}，目标 {preview.target}。</p></div>
      </div>
      {#if preview.localPaths.length === 0}
        <div class="merge-check-line ok"><Icon name="check-circle" size={13} />当前没有未提交改动。</div>
      {:else}
        <details class="merge-local-files">
          <summary><Icon name="file-diff" size={13} />查看需要处理的 {preview.localPaths.length} 个本地文件<Icon name="chevron-down" size={12} /></summary>
          <ul class="scope-list" aria-label="本地改动">{#each preview.localPaths as path (path)}<li title={path}>{path}</li>{/each}</ul>
        </details>
      {/if}
      <p class="merge-result-note">{preview.note}</p>
      {#if preview.canStart}
        <div class="merge-result-explain"><Icon name="info" size={13} />点击开始后，如果出现冲突，会进入三列编辑器逐个解决；没有冲突时按 Git 结果完成。</div>
      {/if}
    </div>
  {:else}
    <div class="merge-guide-checklist">
      <div><span>1</span><p><strong>先检查条件</strong>确认本地改动是否会影响合并。</p></div>
      <div><span>2</span><p><strong>再开始合并</strong>确认来源和目标后才执行 Git 操作。</p></div>
      <div><span>3</span><p><strong>最后完成</strong>有冲突就逐个解决，没有冲突就完成合并。</p></div>
    </div>
  {/if}

  <div class="merge-guide-actions">
    {#if preview && !preview.canStart}
      <button type="button" class="btn btn-primary" disabled={blocked} onclick={onOpenChanges ?? onOpenStash}><Icon name="commit" size={14} />去提交改动</button>
      <button type="button" class="btn btn-secondary" disabled={blocked} onclick={onOpenStash}><Icon name="archive" size={14} />临时保存</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-ghost" disabled={blocked} onclick={onPreview}><Icon name="refresh" size={14} />处理后重新检查</button>
    {:else if preview?.canStart}
      <span class="hint"><Icon name="check-circle" size={12} />检查完成，可以开始</span>
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" disabled={blocked} onclick={onPreview}><Icon name="refresh" size={14} />重新检查</button>
      <button type="button" class="btn btn-primary" disabled={blocked} onclick={onStart}><Icon name="merge" size={14} />确认开始合并</button>
    {:else}
      <span class="hint">还不会执行合并</span>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary" aria-label="预览合并" disabled={blocked || !source.trim()} onclick={onPreview}><Icon name="eye" size={14} />检查合并条件</button>
    {/if}
  </div>
</div>
