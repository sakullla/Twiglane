<script lang="ts">
  import type { ConflictSide, ConflictView } from "../types";
  import Icon from "./Icon.svelte";

  /**
   * 整文件三栏：当前版本 | 合并结果（可编辑） | 来源版本。
   *
   * 两侧只读栏用单个 <pre> 文本节点呈现（几万行也只是一个节点，不逐行建 DOM），
   * 逐行对比交给「逐处处理」和「两侧差异」。二进制、修改/删除这类不能按文本合并的冲突，
   * 这里只提供「整份使用某一侧」或「接受删除」，选择即写入。
   */
  interface Props {
    view: ConflictView;
    resultText: string;
    disabled: boolean;
    currentLabel?: string;
    incomingLabel?: string;
    /** 由外层统一提供「标记为已解决」时隐藏本栏头部的标记按钮。 */
    hideResolve?: boolean;
    onResult: (value: string) => void;
    onChoice: (choice: "ours" | "theirs" | "both") => void;
    onResolve: (choice: string) => void;
    onReset: () => void;
  }

  let {
    view,
    resultText,
    disabled,
    currentLabel = "",
    incomingLabel = "",
    hideResolve = false,
    onResult,
    onChoice,
    onResolve,
    onReset,
  }: Props = $props();

  let oursPane = $state<HTMLDivElement | null>(null);
  let theirsPane = $state<HTMLDivElement | null>(null);
  let syncing = false;

  function numbers(text: string | null): string {
    if (!text) return "";
    let count = 1;
    for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) count += 1;
    if (text.endsWith("\n")) count -= 1;
    const out: string[] = [];
    for (let line = 1; line <= count; line += 1) out.push(String(line));
    return out.join("\n");
  }

  function sideText(side: ConflictSide): string {
    return side.text ?? side.summary;
  }

  /** 两侧只读栏同步滚动，方便对照同一位置。 */
  function sync(from: HTMLDivElement | null, to: HTMLDivElement | null) {
    if (!from || !to || syncing) return;
    syncing = true;
    to.scrollTop = from.scrollTop;
    requestAnimationFrame(() => (syncing = false));
  }

  let oursNumbers = $derived(numbers(view.ours.text));
  let theirsNumbers = $derived(numbers(view.theirs.text));
  let deletion = $derived(view.kind === "modify_delete" || view.kind === "delete_modify" || view.kind === "both_deleted");
</script>

<div class="three-way-merge" class:readonly={!view.editable}>
  <div class="three-way-head">
    <div class="three-way-title ours">
      <span class="dot"></span>
      <div><strong>当前分支</strong><span>{currentLabel || "Current"}</span></div>
      {#if view.ours.present && view.kind !== "delete_modify"}
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          disabled={disabled}
          title={view.editable ? "把当前版本整份填入中间结果（不写入）" : "整份使用当前版本并标记"}
          onclick={() => (view.editable ? onChoice("ours") : onResolve("ours"))}
        >
          <Icon name="chevron-right" size={12} />{view.editable ? "填入当前" : "使用当前版本"}
        </button>
      {/if}
    </div>
    <div class="three-way-title result">
      <span class="dot"></span>
      <div><strong>合并结果</strong><span>{view.editable ? "可编辑，标记时才写入" : "只读"}</span></div>
      {#if view.editable}
        <button type="button" class="btn btn-ghost btn-sm" disabled={disabled} onclick={onReset}><Icon name="undo" size={12} />重置</button>
        {#if !hideResolve}
          <button type="button" class="btn btn-primary btn-sm" aria-label="标记编辑结果" disabled={disabled} onclick={() => onResolve("text")}>
            <Icon name="check" size={12} />标记为已解决
          </button>
        {/if}
      {/if}
    </div>
    <div class="three-way-title theirs">
      <span class="dot"></span>
      <div><strong>来源分支</strong><span>{incomingLabel || "Incoming"}</span></div>
      {#if view.theirs.present && view.kind !== "modify_delete"}
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          disabled={disabled}
          title={view.editable ? "把来源版本整份填入中间结果（不写入）" : "整份使用来源版本并标记"}
          onclick={() => (view.editable ? onChoice("theirs") : onResolve("theirs"))}
        >
          <Icon name="arrow-left" size={12} />{view.editable ? "填入来源" : "使用来源版本"}
        </button>
      {/if}
    </div>
  </div>
  <div class="three-way-body">
    <div
      class="three-way-pane ours"
      role="region"
      aria-label="当前分支版本"
      bind:this={oursPane}
      onscroll={() => sync(oursPane, theirsPane)}
    >
      {#if view.ours.text !== null}
        <div class="three-way-text"><pre class="gutter" aria-hidden="true">{oursNumbers}</pre><pre>{view.ours.text}</pre></div>
      {:else}
        <p class="three-way-summary">{sideText(view.ours)}</p>
      {/if}
    </div>
    <div class="three-way-pane result">
      {#if view.editable}
        <textarea
          aria-label="合并结果"
          value={resultText}
          disabled={disabled}
          spellcheck="false"
          oninput={(event) => onResult((event.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
      {:else if view.result.text !== null}
        <pre>{view.result.text}</pre>
      {:else}
        <p class="three-way-summary">{view.result.summary}</p>
      {/if}
    </div>
    <div
      class="three-way-pane theirs"
      role="region"
      aria-label="来源分支版本"
      bind:this={theirsPane}
      onscroll={() => sync(theirsPane, oursPane)}
    >
      {#if view.theirs.text !== null}
        <div class="three-way-text"><pre class="gutter" aria-hidden="true">{theirsNumbers}</pre><pre>{view.theirs.text}</pre></div>
      {:else}
        <p class="three-way-summary">{sideText(view.theirs)}</p>
      {/if}
    </div>
  </div>
  <div class="three-way-foot">
    <div class="row">
      {#if view.editable}
        <button type="button" class="btn btn-secondary btn-sm" disabled={disabled} onclick={() => onChoice("both")}><Icon name="plus" size={12} />保留双方</button>
      {/if}
      {#if deletion}
        <button type="button" class="btn btn-danger-soft btn-sm" disabled={disabled} onclick={() => onResolve("delete")}>接受删除</button>
      {/if}
    </div>
    <span>
      <Icon name="info" size={12} />
      {#if view.editable}
        填入只修改中间结果；保留双方后请检查重复代码，标记时才写入。
      {:else if deletion}
        一侧删除了文件：选择保留哪一侧的完整版本，或接受删除。选择即写入。
      {:else}
        这类冲突不能按文本合并，只能整份使用某一侧。选择即写入。
      {/if}
    </span>
  </div>
</div>
