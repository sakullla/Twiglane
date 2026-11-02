<script lang="ts">
  import { untrack } from "svelte";
  import { BUSY_REASON } from "../ui";
  import {
    computeMarks,
    exceedsMarkLimit,
    MARK_LINE_LIMIT,
    mapLine,
    markKindAt,
    runsInRange,
    type LineAnchors,
    type MarkKind,
    type ThreeWayMarks,
  } from "../three-way-marks";
  import type { ConflictSide, ConflictView } from "../types";
  import Icon from "./Icon.svelte";

  /**
   * 整文件三栏：当前版本 | 合并结果（可编辑） | 来源版本。
   *
   * 两侧只读栏用单个 <pre> 文本节点呈现（几万行也只是一个节点，不逐行建 DOM），
   * 逐行对比交给「逐处处理」和「两侧差异」。二进制、修改/删除这类不能按文本合并的冲突，
   * 这里只提供「整份使用某一侧」或「接受删除」，选择即写入。
   *
   * 三栏纵向、横向联动，结果栏 textarea 也参与。结果栏的来源标记画在 textarea 下方的
   * 只读层和左侧行号栏里，都不碰文本本身，只渲染视口附近的行。
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

  type Pane = "ours" | "result" | "theirs";

  /** 与 .three-way-text pre、.three-way-pane textarea 的行高和上内边距一致。 */
  const LINE = 20;
  const PAD = 8;
  const OVERSCAN = 8;
  /** 比较耗时随行数增长（10 万行约 0.4 秒），防抖跟着放宽，大文件连续打字时不被比较打断。 */
  const markDebounce = (lines: number) => 160 + lines / 100;

  const KEYS: { kind: Exclude<MarkKind, "marker">; label: string; title: string }[] = [
    { kind: "ours", label: "当前", title: "这一行只来自当前分支" },
    { kind: "theirs", label: "来源", title: "这一行只来自来源分支" },
    { kind: "manual", label: "手动编辑", title: "两侧都没有这一行" },
    { kind: "same", label: "两侧相同", title: "两侧都有这一行，不加底色" },
  ];
  const GLYPHS: Record<MarkKind, string> = { same: "", ours: "当", theirs: "来", manual: "手", marker: "冲" };

  let oursPane = $state<HTMLDivElement | null>(null);
  let theirsPane = $state<HTMLDivElement | null>(null);
  let resultPane = $state<HTMLDivElement | null>(null);
  let resultArea = $state<HTMLTextAreaElement | null>(null);
  /** 正在带动另外两栏的那一栏；写入引起的回声滚动按它识别并忽略。 */
  let leader: Pane | null = null;
  let releaseFrame = 0;
  let resultTop = $state(0);
  let resultHeight = $state(0);
  let marks = $state.raw<ThreeWayMarks | null>(null);

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

  function countLines(text: string): number {
    if (text.length === 0) return 0;
    let count = text.endsWith("\n") ? 0 : 1;
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count += 1;
    return count;
  }

  function scroller(pane: Pane): HTMLElement | null {
    if (pane === "ours") return oursPane;
    if (pane === "theirs") return theirsPane;
    return resultArea ?? resultPane;
  }

  function anchorsOf(pane: Exclude<Pane, "result">, map: ThreeWayMarks): LineAnchors {
    return pane === "ours" ? map.ours : map.theirs;
  }

  /**
   * 纵向按内容对齐：取源栏的「参照行」，经结果栏换算到目标栏。参照行随滚动进度从视口顶滑到
   * 视口底，于是三栏同时到顶、同时到底，行数不同也不会有一栏够不到末尾。
   * 没有对齐数据时（超大文件、缺一侧文本）退回按滚动比例。
   */
  function verticalTarget(from: Pane, to: Pane, source: HTMLElement, target: HTMLElement): number {
    const sourceMax = source.scrollHeight - source.clientHeight;
    const targetMax = target.scrollHeight - target.clientHeight;
    if (targetMax <= 0) return 0;
    const progress = sourceMax > 0 ? Math.min(1, Math.max(0, source.scrollTop / sourceMax)) : 0;
    if (!marks) return progress * targetMax;
    const raw = (source.scrollTop + (source.clientHeight - PAD) * progress - PAD) / LINE;
    const line = Math.max(0, raw);
    const hub = from === "result" ? line : mapLine(anchorsOf(from, marks).side, anchorsOf(from, marks).result, line);
    const mapped = to === "result" ? hub : mapLine(anchorsOf(to, marks).result, anchorsOf(to, marks).side, hub);
    // raw 为负时参照行还在上内边距里，补回这段差，到顶时才是真正的 0。
    const top = (mapped + raw - line) * LINE + PAD - (target.clientHeight - PAD) * progress;
    return Math.min(targetMax, Math.max(0, top));
  }

  /** 任一栏滚动都带动另外两栏。回声在下一帧的滚动步骤才到，所以隔两帧才放开。 */
  function sync(from: Pane) {
    const source = scroller(from);
    if (!source) return;
    if (from === "result" && resultArea) resultTop = resultArea.scrollTop;
    if (leader !== null && leader !== from) return;
    leader = from;
    for (const to of ["ours", "result", "theirs"] as const) {
      if (to === from) continue;
      const target = scroller(to);
      if (!target) continue;
      target.scrollTop = verticalTarget(from, to, source, target);
      target.scrollLeft = source.scrollLeft;
      if (to === "result" && resultArea) resultTop = resultArea.scrollTop;
    }
    cancelAnimationFrame(releaseFrame);
    releaseFrame = requestAnimationFrame(() => {
      releaseFrame = requestAnimationFrame(() => (leader = null));
    });
  }

  /** 关闭标记的原因；null 表示可以标记。 */
  let marksOff = $derived.by(() => {
    if (!view.editable) return "";
    const { ours, theirs } = view;
    if (ours.text === null || theirs.text === null) return "缺少一侧的文本，无法标记来源";
    if (ours.truncated || theirs.truncated) return "两侧内容不完整，已关闭来源标记";
    if (exceedsMarkLimit(resultText, ours.text, theirs.text)) {
      return `文件过大（超过 ${MARK_LINE_LIMIT.toLocaleString()} 行或 8 MB），已关闭来源标记`;
    }
    return null;
  });

  // 打开时立即算一次；之后随编辑防抖更新，打字不被比较拖慢。
  let marksBasis: unknown = null;
  $effect(() => {
    const text = resultText;
    const ours = view.ours.text;
    const theirs = view.theirs.text;
    if (marksOff !== null || ours === null || theirs === null) {
      marks = null;
      marksBasis = null;
      return;
    }
    const basis = `${ours.length}:${theirs.length}:${view.path}`;
    const update = () => {
      marks = computeMarks(text, ours, theirs);
      marksBasis = basis;
    };
    if (untrack(() => marks === null) || marksBasis !== basis) {
      update();
      return;
    }
    const timer = setTimeout(update, markDebounce(resultLines));
    return () => clearTimeout(timer);
  });

  let resultLines = $derived(view.editable ? countLines(resultText) : 0);
  let firstLine = $derived(Math.max(0, Math.floor((resultTop - PAD) / LINE) - OVERSCAN));
  let lastLine = $derived(Math.floor((resultTop + (resultHeight || 720)) / LINE) + OVERSCAN);
  let visibleRuns = $derived(marks ? runsInRange(marks.runs, firstLine, lastLine) : []);
  let gutterRows = $derived.by(() => {
    const rows: { line: number; kind: MarkKind }[] = [];
    const end = Math.min(resultLines - 1, lastLine);
    for (let line = firstLine; line <= end; line += 1) {
      rows.push({ line, kind: marks && line < marks.lines ? markKindAt(marks, line) : "same" });
    }
    return rows;
  });
  let hasMarkers = $derived(marks?.runs.some((run) => run.kind === "marker") ?? false);

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
        <button type="button" class="btn btn-ghost btn-sm" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={onReset}><Icon name="undo" size={12} />重置</button>
        {#if !hideResolve}
          <button type="button" class="btn btn-primary btn-sm" aria-label="标记编辑结果" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={() => onResolve("text")}>
            <Icon name="check" size={12} />标记为已解决
          </button>
        {/if}
        <p class="three-way-legend" data-testid="three-way-legend">
          {#if marksOff}
            <Icon name="info" size={12} /><span>{marksOff}</span>
          {:else}
            {#each KEYS as key (key.kind)}
              <span class={`three-way-key ${key.kind}`} title={key.title}><i></i>{key.label}</span>
            {/each}
            {#if hasMarkers}<span class="three-way-key marker" title="尚未处理的冲突标记行"><i></i>冲突标记</span>{/if}
          {/if}
        </p>
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
      onscroll={() => sync("ours")}
    >
      {#if view.ours.text !== null}
        <div class="three-way-text"><pre class="gutter" aria-hidden="true">{oursNumbers}</pre><pre>{view.ours.text}</pre></div>
      {:else}
        <p class="three-way-summary">{sideText(view.ours)}</p>
      {/if}
    </div>
    <div class="three-way-pane result" class:marked={view.editable} bind:this={resultPane} onscroll={() => sync("result")}>
      {#if view.editable}
        <div class="three-way-gutter" aria-hidden="true">
          <div class="three-way-layer" style={`transform:translateY(${-resultTop}px)`}>
            {#each gutterRows as row (row.line)}
              <div class={`three-way-gutter-row ${row.kind}`} style={`top:${PAD + row.line * LINE}px`}><span>{row.line + 1}</span><i>{GLYPHS[row.kind]}</i></div>
            {/each}
          </div>
        </div>
        <div class="three-way-editor" bind:clientHeight={resultHeight}>
          <div class="three-way-marks" aria-hidden="true">
            <div class="three-way-layer" style={`transform:translateY(${-resultTop}px)`}>
              {#each visibleRuns as run (run.from)}
                <div class={`three-way-mark ${run.kind}`} style={`top:${PAD + run.from * LINE}px;height:${(run.to - run.from) * LINE}px`}></div>
              {/each}
            </div>
          </div>
          <textarea
            aria-label="合并结果"
            value={resultText}
            title={disabled ? BUSY_REASON : undefined}
            disabled={disabled}
            spellcheck="false"
            wrap="off"
            bind:this={resultArea}
            onscroll={() => sync("result")}
            oninput={(event) => onResult((event.currentTarget as HTMLTextAreaElement).value)}
          ></textarea>
        </div>
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
      onscroll={() => sync("theirs")}
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
        <button type="button" class="btn btn-secondary btn-sm" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={() => onChoice("both")}><Icon name="plus" size={12} />保留双方</button>
      {/if}
      {#if deletion}
        <button type="button" class="btn btn-danger-soft btn-sm" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={() => onResolve("delete")}>接受删除</button>
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
