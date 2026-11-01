<script lang="ts">
  import { createTextDiff, toSideRows, type SideCell, type SideRow } from "../diff";
  import type { ConflictView } from "../types";
  import Icon from "./Icon.svelte";

  interface Props {
    view: ConflictView;
    resultText: string;
    disabled: boolean;
    onResult: (value: string) => void;
    onChoice: (choice: "ours" | "theirs" | "both") => void;
    onResolve: (choice: string) => void;
    onReset: () => void;
  }

  let { view, resultText, disabled, onResult, onChoice, onResolve, onReset }: Props = $props();

  let comparison = $derived(createTextDiff(view.path, view.theirs.text ?? "", view.ours.text ?? "", view.generation));
  let rows = $derived(toSideRows(comparison.lines));

  function cell(row: SideRow, side: "ours" | "theirs"): SideCell | null {
    return side === "ours" ? row.right : row.left;
  }
</script>

<div class="three-way-merge">
  <div class="three-way-head">
    <div class="three-way-title ours">
      <span class="dot"></span>
      <div><strong>当前分支</strong><span>Current</span></div>
      {#if view.ours.present && view.kind !== "delete_modify"}
        <button type="button" class="btn btn-ghost btn-sm" disabled={disabled} onclick={() => view.editable ? onChoice("ours") : onResolve("ours")}><Icon name="chevron-right" size={12} />填入当前</button>
      {/if}
    </div>
    <div class="three-way-title result">
      <span class="dot"></span>
      <div><strong>合并结果</strong><span>可编辑</span></div>
      <button type="button" class="btn btn-ghost btn-sm" disabled={disabled} onclick={onReset}><Icon name="undo" size={12} />重置</button>
      {#if view.editable}
        <button type="button" class="btn btn-primary btn-sm" aria-label="标记编辑结果" disabled={disabled} onclick={() => onResolve("text")}><Icon name="check" size={12} />标记为已解决</button>
      {/if}
    </div>
    <div class="three-way-title theirs">
      <span class="dot"></span>
      <div><strong>来源分支</strong><span>Incoming</span></div>
      {#if view.theirs.present && view.kind !== "modify_delete"}
        <button type="button" class="btn btn-ghost btn-sm" disabled={disabled} onclick={() => view.editable ? onChoice("theirs") : onResolve("theirs")}><Icon name="arrow-left" size={12} />填入来源</button>
      {/if}
    </div>
  </div>
  <div class="three-way-body">
    <div class="three-way-pane ours" role="region" aria-label="当前分支版本">
      {#each rows as row, index (index)}
        {@const current = cell(row, "ours")}
        <div class={`three-way-line ${current?.kind ?? "empty"}`} class:hunk={row.span}>
          <span class="ln">{current?.no ?? ""}</span><span class="code">{current?.text ?? " "}</span>
        </div>
      {/each}
    </div>
    <div class="three-way-pane result">
      {#if view.editable}
        <textarea aria-label="合并结果" value={resultText} disabled={disabled} spellcheck="false" oninput={(event) => onResult((event.currentTarget as HTMLTextAreaElement).value)}></textarea>
      {:else}
        <pre>{view.result.text ?? view.result.summary}</pre>
      {/if}
    </div>
    <div class="three-way-pane theirs" role="region" aria-label="来源分支版本">
      {#each rows as row, index (index)}
        {@const incoming = cell(row, "theirs")}
        <div class={`three-way-line ${incoming?.kind ?? "empty"}`} class:hunk={row.span}>
          <span class="ln">{incoming?.no ?? ""}</span><span class="code">{incoming?.text ?? " "}</span>
        </div>
      {/each}
    </div>
  </div>
  <div class="three-way-foot">
    <div class="row">
      {#if view.editable}<button type="button" class="btn btn-secondary btn-sm" disabled={disabled} onclick={() => onChoice("both")}><Icon name="plus" size={12} />保留双方</button>{/if}
      {#if view.kind === "modify_delete" || view.kind === "delete_modify" || view.kind === "both_deleted"}
        <button type="button" class="btn btn-danger-soft btn-sm" disabled={disabled} onclick={() => onResolve("delete")}>接受删除</button>
      {/if}
    </div>
    <span><Icon name="info" size={11} />填入只修改中间结果；保留双方后请检查重复代码，标记时才写入。</span>
  </div>
</div>
