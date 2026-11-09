<script lang="ts">
  import { tick, untrack } from "svelte";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import {
    clampSourceLine,
    createDocumentSession,
    isMarkdownPath,
    resolveDocumentLink,
    type DocumentLinkTarget,
    type DocumentMode,
    type DocumentSession,
  } from "../document-session.svelte";
  import type { MarkdownImageResult, MarkdownPosition } from "../markdown/types";
  import { safeImageDataUrl } from "../markdown/links";
  import type { DocumentSource, FilePreview, RepositoryDocument } from "../types";
  import { documentSourceLabel, formatBytes } from "../ui";
  import Icon from "./Icon.svelte";
  import MarkdownPreview from "./MarkdownPreview.svelte";

  /**
   * 版本明确的只读文档阅读：正文（完整、2 MiB 预算）与源码分页都按同一个来源读取，
   * 相对链接、图片、外链都留在同一版本里。没有编辑、保存或写入入口。
   *
   * 位置与模式由阅读会话按「仓库 + 版本 + 路径」保存；本组件只负责读取、定位与取消。
   */
  interface Props {
    active: boolean;
    /** 仓库根目录：来源会被绑定到它，另一个仓库的来源不会被读成同名文件。 */
    repository: string;
    source: DocumentSource;
    generation: number;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    /** 共享阅读会话；不传时组件自建一份（关闭即丢弃）。 */
    session?: DocumentSession | null;
    mode?: DocumentMode;
    onMode?: (mode: DocumentMode) => void;
    /** 文件本身的元数据版本：有版本时无关仓库变化不重读正文。 */
    contentVersion?: string | null;
    /** 指定源码行：序号变化即进入源码并定位，优先于保存的位置。 */
    line?: number | null;
    lineSerial?: number;
    /** 文档内相对链接的外部导航（文件视图同步文件树）；返回 false 表示目标不存在。 */
    onFollow?: (target: DocumentLinkTarget) => boolean | Promise<boolean>;
    /** 提交缩写的位数；不传按 7 位。 */
    abbrevLength?: number;
    /**
     * 是否画来源/路径头部。文件视图的工具条已经有文件名、复制与前进后退，来源也固定是工作区，
     * 传 false 去掉这一行；独立的阅读窗口仍需要它说明版本。
     */
    header?: boolean;
    /** 目录展开状态与标题数；宿主把目录入口放进自己的工具条时使用。 */
    outlineOpen?: boolean;
    onHeadings?: (count: number) => void;
    /** 正文大小（字节）；不画头部时交给宿主的状态条显示。 */
    onSize?: (size: number | null) => void;
  }

  let {
    active,
    repository,
    source,
    generation,
    nextId,
    onGeneration,
    session = null,
    mode = "preview",
    onMode,
    contentVersion = null,
    line = null,
    lineSerial = 0,
    onFollow,
    abbrevLength = 0,
    header = true,
    outlineOpen = $bindable(false),
    onHeadings,
    onSize,
  }: Props = $props();

  /** 与 components.css 的 .doc-source-line 行高一致。 */
  const SOURCE_ROW = 20;
  /** 源码一页的行数：沿用现有分页口径，超长内容按页继续读取。 */
  const SOURCE_PAGE = 500;

  const ownSession = createDocumentSession({ repository: () => repository });
  const reading = $derived<DocumentSession>(session ?? ownSession);

  // 初始值来自 prop；之后由下面的来源同步 effect 与内部导航（相对链接/返回）维护。
  // svelte-ignore state_referenced_locally
  let activeSource = $state.raw<DocumentSource>(source);
  let documentResult = $state.raw<RepositoryDocument | null>(null);
  let documentLoading = $state(false);
  let documentFailure = $state<string | null>(null);
  let documentNotice = $state<string | null>(null);

  let previewKey = $state("");
  let previewTop = $state(0);
  let previewAnchor = $state<string | null>(null);
  let previewNavigation = $state(0);
  let pendingAnchor: string | null = null;

  let sourceLines = $state.raw<string[]>([]);
  let sourceOffset = $state(0);
  let sourceHasMore = $state(false);
  let sourceKind = $state<string | null>(null);
  let sourceMessage = $state<string | null>(null);
  let sourceFailure = $state<string | null>(null);
  let sourceLoading = $state(false);
  let sourceMore = $state(false);
  let sourceHit = $state<number | null>(null);
  let sourceScroller = $state<HTMLDivElement | null>(null);
  let pendingSourceLine: number | null = null;

  let forcedMode = $state<DocumentMode | null>(null);
  let currentMode = $derived<DocumentMode>(forcedMode ?? mode);

  let resourcePreview = $state.raw<FilePreview | null>(null);
  let resourceLoading = $state(false);
  let resourceError = $state<string | null>(null);
  let resourceSerial = 0;

  let trail = $state.raw<{ source: DocumentSource; mode: DocumentMode }[]>([]);
  let ahead = $state.raw<{ source: DocumentSource; mode: DocumentMode }[]>([]);

  let documentSerial = 0;
  let sourceSerial = 0;
  let lastRead = "";
  let sourceSignature = "";
  let lastPropKey = "";
  let lastLineSerial = 0;

  let boundSource = $derived<DocumentSource>(documentResult?.source ?? activeSource);
  let sourceLabel = $derived(documentSourceLabel(boundSource, abbrevLength));
  let hasTrail = $derived(trail.length > 0);
  let hasAhead = $derived(ahead.length > 0);
  let documentSize = $derived(documentResult?.size ?? null);
  $effect(() => {
    const size = documentSize;
    untrack(() => onSize?.(size));
  });

  function resetTransient(): void {
    documentSerial += 1;
    sourceSerial += 1;
    documentResult = null;
    documentLoading = false;
    documentFailure = null;
    documentNotice = null;
    previewKey = "";
    previewTop = 0;
    previewAnchor = null;
    previewNavigation = 0;
    sourceLines = [];
    sourceOffset = 0;
    sourceHasMore = false;
    sourceKind = null;
    sourceMessage = null;
    sourceFailure = null;
    sourceLoading = false;
    sourceMore = false;
    sourceHit = null;
    sourceSignature = "";
    resourceSerial += 1;
    resourcePreview = null;
    resourceLoading = false;
    resourceError = null;
  }

  /** 外部来源变化：换文档就撤下旧正文、目录与在途结果，并清空本层的返回记录。 */
  $effect(() => {
    const key = JSON.stringify([source.revision, source.path, source.snapshot ?? "", source.repository ?? ""]);
    if (key === lastPropKey) return;
    lastPropKey = key;
    untrack(() => {
      trail = [];
      ahead = [];
      pendingAnchor = null;
      pendingSourceLine = null;
      resetTransient();
      activeSource = { ...source };
      lastRead = "";
    });
  });

  function readDocument(generationAtStart = generation, attempt = 0): void {
    const target = activeSource;
    const repo = repository;
    const token = ++documentSerial;
    documentLoading = true;
    documentFailure = null;
    void (async () => {
      try {
        const result = await api.repositoryDocument(repo, target, generationAtStart, nextId(), "document");
        if (token !== documentSerial || activeSource !== target || repository !== repo || !active) return;
        if (result.generation > generationAtStart) onGeneration(result.generation);
        if (result.generation < generationAtStart && attempt === 0) {
          readDocument(result.generation, attempt + 1);
          return;
        }
        documentResult = result;
        if (result.kind === "text") {
          previewKey = JSON.stringify([repo, result.source.revision, result.source.path, result.version ?? ""]);
          restorePreview(result);
        }
        if (currentMode === "source") void ensureSource();
      } catch (failure) {
        if (token !== documentSerial || activeSource !== target || repository !== repo) return;
        const normalized = normalizeError(failure);
        if (normalized.code === "stale" && normalized.generation !== undefined && attempt === 0) {
          onGeneration(normalized.generation);
          readDocument(normalized.generation, attempt + 1);
          return;
        }
        documentResult = null;
        documentFailure = normalized.message || "无法读取这个版本的文档。";
      } finally {
        if (token === documentSerial) documentLoading = false;
      }
    })();
  }

  function restorePreview(result: RepositoryDocument): void {
    const version = result.version ?? null;
    const stored = reading.recall(result.source, version);
    const anchor = pendingAnchor;
    pendingAnchor = null;
    if (anchor !== null) {
      previewTop = 0;
      previewAnchor = anchor;
    } else if (stored) {
      previewTop = stored.reading.preview.top;
      previewAnchor = stored.reading.preview.anchor;
      if (stored.moved) documentNotice = "内容版本已变化，阅读位置按新内容重新定位。";
    } else {
      previewTop = 0;
      previewAnchor = null;
    }
    // 每次加载完成都要让预览重新应用一次恢复位置：预览内部只在序号变化时恢复。
    previewNavigation += 1;
  }

  /** 正文读取：内容版本已知时无关代次变化不重读；隐藏或换文档立即作废在途结果。 */
  $effect(() => {
    const target = activeSource;
    const visible = active;
    const version = contentVersion ?? null;
    const generationNow = generation;
    untrack(() => {
      if (!visible) {
        documentSerial += 1;
        sourceSerial += 1;
        documentLoading = false;
        sourceLoading = false;
        return;
      }
      const signature = JSON.stringify([repository, target.revision, target.path, target.snapshot ?? null, version ?? generationNow]);
      if (signature === lastRead) return;
      lastRead = signature;
      readDocument();
    });
  });

  function restoreSource(page: RepositoryDocument): void {
    const version = page.version ?? null;
    const stored = reading.recall(activeSource, version);
    const targetLine = pendingSourceLine;
    pendingSourceLine = null;
    const wanted = targetLine ?? (stored ? stored.reading.source.line : null);
    if (wanted === null || wanted <= 0) return;
    const line = clampSourceLine(wanted, page.offset + 1, sourceLines.length);
    if (line === null) {
      if (stored?.moved) documentNotice = "内容版本已变化，源码位置按新内容重新定位。";
      return;
    }
    scrollToLine(line);
    if (stored?.moved) documentNotice = "内容版本已变化，源码位置按新内容重新定位。";
    else if (targetLine === null && line !== wanted) documentNotice = "这个版本比上次短，源码位置已调整到有效范围。";
  }

  function readSource(offset: number, generationAtStart = generation, attempt = 0, append = false): void {
    const target = activeSource;
    const repo = repository;
    const token = ++sourceSerial;
    const expected = documentResult?.version ?? null;
    if (append) sourceMore = true;
    else {
      sourceLoading = true;
      sourceFailure = null;
    }
    void (async () => {
      try {
        const page = await api.repositoryDocument(repo, target, generationAtStart, nextId(), "source", offset, SOURCE_PAGE, expected);
        if (token !== sourceSerial || activeSource !== target || repository !== repo || !active) return;
        if (page.generation > generationAtStart) onGeneration(page.generation);
        if (page.generation < generationAtStart && attempt === 0) {
          readSource(offset, page.generation, attempt + 1, append);
          return;
        }
        if (append && page.version && expected && page.version !== expected) {
          // 内容已变：不把两页拼成一份正文，从头重读。
          readSource(0, page.generation);
          return;
        }
        sourceKind = page.kind;
        sourceMessage = page.message;
        if (page.kind === "text") {
          if (append) sourceLines = [...sourceLines, ...page.lines];
          else {
            sourceLines = page.lines;
            sourceOffset = offset;
            sourceHit = null;
            scrollToTop();
          }
          sourceHasMore = page.hasMore;
          if (!append) restoreSource(page);
        } else {
          sourceLines = [];
          sourceHasMore = false;
          sourceOffset = 0;
        }
      } catch (failure) {
        if (token !== sourceSerial || activeSource !== target || repository !== repo) return;
        const normalized = normalizeError(failure);
        if (normalized.code === "stale" && normalized.generation !== undefined && attempt === 0) {
          onGeneration(normalized.generation);
          readSource(offset, normalized.generation, attempt + 1, append);
          return;
        }
        if (!append) {
          sourceLines = [];
          sourceKind = null;
        }
        sourceFailure = normalized.message || "无法读取这个版本的源码。";
      } finally {
        if (token === sourceSerial) {
          sourceLoading = false;
          sourceMore = false;
        }
      }
    })();
  }

  function scrollToTop(): void {
    if (sourceScroller) sourceScroller.scrollTop = 0;
  }

  /** 正文已给出身份与类型后才读源码页：超过预览上限时源码是唯一退路。 */
  function ensureSource(): void {
    const result = documentResult;
    if (!result || currentMode !== "source" || !active) return;
    if (result.kind !== "text" && result.kind !== "tooLarge") return;
    const signature = JSON.stringify([repository, activeSource.revision, activeSource.path, result.version ?? ""]);
    if (signature === sourceSignature) return;
    sourceSignature = signature;
    // 直接读保存位置所在的那一页：行定位与「回来接着读」都是同一个入口。
    // 版本变了旧行号不再可信，从开头读并让 restoreSource 说明位置已调整。
    const stored = reading.recall(activeSource, result.version ?? null);
    const wanted = pendingSourceLine ?? (stored && !stored.moved ? stored.reading.source.line : 1);
    readSource(Math.max(0, Math.trunc(wanted || 1) - 1));
  }

  $effect(() => {
    const modeNow = currentMode;
    const result = documentResult;
    const visible = active;
    void activeSource;
    untrack(() => {
      if (!visible || modeNow !== "source" || !result) return;
      ensureSource();
    });
  });

  function scrollToLine(line: number): void {
    const index = line - 1 - sourceOffset;
    if (index < 0 || !sourceScroller) return;
    sourceScroller.scrollTop = Math.max(0, index * SOURCE_ROW - 40);
  }

  function jumpToLine(line: number): void {
    const target = Math.max(1, Math.trunc(line));
    if (target - 1 >= sourceOffset && target - 1 < sourceOffset + sourceLines.length) {
      sourceHit = target;
      scrollToLine(target);
      return;
    }
    sourceHit = target;
    readSource(target - 1);
  }

  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  let sourceScroll = $state<{ line: number; top: number } | null>(null);

  function saveSourcePosition(): void {
    const position = sourceScroll;
    if (!position) return;
    reading.remember(activeSource, {
      mode: "source",
      source: position,
      version: documentResult?.version ?? null,
    });
  }

  function sourceScrolled(event: Event): void {
    const target = event.currentTarget as HTMLElement;
    sourceScroll = { line: sourceOffset + Math.floor(target.scrollTop / SOURCE_ROW) + 1, top: target.scrollTop };
    // 滚动位置连续变化：短延迟合并写入，仍落在同一身份的同一个条目上。
    if (scrollTimer !== undefined) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(saveSourcePosition, 120);
  }

  let copiedPath = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(boundSource.path);
      copiedPath = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copiedPath = false), 1500);
    } catch {
      copiedPath = false;
    }
  }

  // 卸载前把最后一次滚动位置落进会话，关闭阅读窗口后位置仍可恢复。
  $effect(() => () => {
    if (scrollTimer !== undefined) clearTimeout(scrollTimer);
    if (copyTimer !== undefined) clearTimeout(copyTimer);
    saveSourcePosition();
  });

  function previewMoved(position: MarkdownPosition): void {
    previewTop = position.scrollTop;
    previewAnchor = position.anchor;
    reading.remember(activeSource, {
      mode: "preview",
      preview: { top: position.scrollTop, anchor: position.anchor },
      version: documentResult?.version ?? null,
    });
  }

  function requestMode(next: DocumentMode): void {
    if (currentMode === next) return;
    forcedMode = null;
    if (onMode) onMode(next);
    else forcedMode = next;
    reading.remember(activeSource, { mode: next, version: documentResult?.version ?? null });
  }

  // 受控模式：外部换模式时撤下本层的临时选择。
  $effect(() => {
    void mode;
    untrack(() => {
      forcedMode = null;
    });
  });

  function navigate(next: DocumentSource, nextMode: DocumentMode | null): void {
    resetTransient();
    activeSource = { ...next };
    lastRead = "";
    if (nextMode) requestMode(nextMode);
  }

  function openLocal(target: DocumentLinkTarget): void {
    trail = [...trail, { source: activeSource, mode: currentMode }];
    ahead = [];
    pendingAnchor = target.anchor;
    pendingSourceLine = null;
    navigate({ ...activeSource, path: target.path }, isMarkdownPath(target.path) ? "preview" : "source");
  }

  function back(): void {
    const previous = trail.at(-1);
    if (!previous) return;
    trail = trail.slice(0, -1);
    ahead = [...ahead, { source: activeSource, mode: currentMode }];
    pendingAnchor = null;
    pendingSourceLine = null;
    navigate(previous.source, previous.mode);
  }

  function forward(): void {
    const next = ahead.at(-1);
    if (!next) return;
    ahead = ahead.slice(0, -1);
    trail = [...trail, { source: activeSource, mode: currentMode }];
    pendingAnchor = null;
    pendingSourceLine = null;
    navigate(next.source, next.mode);
  }

  /** 新行定位优先于保存的位置：搜索命中、跳到行都必须落在源码上。 */
  $effect(() => {
    const serial = lineSerial;
    const target = line;
    if (serial === lastLineSerial) return;
    lastLineSerial = serial;
    untrack(() => {
      if (target === null || target <= 0) return;
      pendingSourceLine = target;
      requestMode("source");
      if (!documentResult) return;
      const ready = sourceSignature !== "";
      if (ready) jumpToLine(target);
    });
  });

  async function openExternal(url: string): Promise<void> {
    await api.openDocumentUrl(url);
  }

  async function follow(href: string): Promise<void> {
    const target = resolveDocumentLink(activeSource.path, href);
    if (target.kind === "anchor" || target.kind === "blocked") return;
    if (target.kind === "remote") {
      await openExternal(target.reason);
      return;
    }
    if (onFollow) {
      const found = await onFollow(target);
      if (!found) throw new Error(`这个版本里没有 ${target.path}。`);
      return;
    }
    openLocal(target);
  }

  /**
   * 图片读取：仓库内图片按同一版本解析，远程图片只在显式点击后才请求；
   * 取消时撤下自己的请求，不让慢响应在换文档后落到界面上。
   */
  async function loadImage(href: string, signal: AbortSignal): Promise<MarkdownImageResult> {
    const target = resolveDocumentLink(activeSource.path, href);
    if (target.kind === "blocked" || target.kind === "anchor") {
      return { dataUrl: null, message: "这个版本里没有可读取的图片。" };
    }
    if (target.kind === "remote") {
      const requestId = nextId();
      const cancel = () => void api.cancelDocumentResources(requestId).catch(() => {});
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await api.documentRemoteImage(target.reason, requestId);
        if (signal.aborted) throw new Error("图片读取已取消。");
        return { dataUrl: result.dataUrl, message: result.message || "远程图片不可用。" };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    const requestId = nextId();
    const cancel = () => void api.cancelDocumentResources(requestId).catch(() => {});
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await api.documentResource(repository, { ...boundSource, path: target.path }, generation, requestId);
      if (signal.aborted) throw new Error("图片读取已取消。");
      if (result.kind !== "image") {
        return { dataUrl: null, message: result.message || "这个版本里没有这张图片。" };
      }
      return { dataUrl: result.dataUrl, message: null };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  async function retry(): Promise<void> {
    if (currentMode === "source" && documentResult?.kind !== "text") {
      sourceSignature = "";
      void ensureSource();
      return;
    }
    resetTransient();
    lastRead = "";
    await tick();
    readDocument();
  }

  /**
   * 相对链接指向图片等资源时的同版本读取：仍是这个版本的 `documentResource`，
   * 缺失、LFS 未下载或尺寸超限都按返回类型就地说明，不回落工作区。
   */
  async function readResource(): Promise<void> {
    const result = documentResult;
    if (!result || result.kind !== "resource" || !active) return;
    const token = ++resourceSerial;
    resourceLoading = true;
    resourceError = null;
    try {
      const preview = await api.documentResource(repository, boundSource, generation, nextId());
      if (token !== resourceSerial || documentResult !== result) return;
      resourcePreview = preview;
    } catch (failure) {
      if (token !== resourceSerial || documentResult !== result) return;
      resourcePreview = null;
      resourceError = normalizeError(failure).message || "无法读取这个版本的资源。";
    } finally {
      if (token === resourceSerial) resourceLoading = false;
    }
  }

  $effect(() => {
    const result = documentResult;
    const visible = active;
    void boundSource;
    untrack(() => {
      if (!visible || !result || result.kind !== "resource") return;
      void readResource();
    });
  });

  function sourceStateTitle(): string {
    if (sourceFailure) return "无法读取源码";
    if (sourceKind === "binary") return "二进制内容";
    if (sourceKind === "invalidUtf8") return "不是有效的 UTF-8 文本";
    if (sourceKind === "special") return "特殊文件";
    if (sourceKind === "missing") return "这个版本里没有这个文件";
    return "没有可显示的源码";
  }

  /** 正文读取已经给出类型（二进制、非法编码、缺失）时，源码侧不再重复请求。 */
  function documentStateTitle(kind: string): string {
    if (kind === "binary") return "二进制内容";
    if (kind === "invalidUtf8") return "不是有效的 UTF-8 文本";
    if (kind === "special") return "特殊文件";
    if (kind === "missing") return "这个版本里没有这个文件";
    if (kind === "resource") return "这是资源文件";
    return "没有可显示的源码";
  }
</script>

<section class="document-reader" aria-label="文档阅读" aria-busy={documentLoading || sourceLoading}>
  <!-- 宿主不要头部时，只有「文档内链接跳转」产生了前进后退记录才把它画出来，否则无法返回。 -->
  {#if header || hasTrail || hasAhead}
  <header class="doc-reader-head">
    <span class="doc-source" title={`来源：${sourceLabel}`}><Icon name="eye" size={13} />{sourceLabel}</span>
    <span class="doc-path" title={boundSource.path}>{boundSource.path}</span>
    <button
      type="button"
      class="icon-btn sm file-copy-btn"
      data-copied={copiedPath ? "true" : undefined}
      aria-label={copiedPath ? "已复制文档路径" : "复制文档路径"}
      title={copiedPath ? "已复制路径" : `复制相对路径：${boundSource.path}`}
      onclick={() => void copyPath()}
    >
      <Icon name={copiedPath ? "check" : "copy"} size={12} />
    </button>
    {#if hasTrail || hasAhead}
      <span class="doc-nav">
        <button type="button" class="icon-btn sm" aria-label="返回上一个文档" title={hasTrail ? "回到上一个文档与位置" : "没有上一个文档"} disabled={!hasTrail} onclick={back}>
          <Icon name="arrow-left" size={14} />
        </button>
        <button type="button" class="icon-btn sm" aria-label="前进到下一个文档" title={hasAhead ? "回到下一个文档与位置" : "没有下一个文档"} disabled={!hasAhead} onclick={forward}>
          <Icon name="arrow-right" size={14} />
        </button>
      </span>
    {/if}
    <span class="spacer"></span>
    {#if documentResult?.size != null}<span class="doc-meta">{formatBytes(documentResult.size)}</span>{/if}
  </header>
  {/if}

  {#if documentNotice}
    <p class="doc-notice" role="status"><Icon name="info" size={13} />{documentNotice}</p>
  {/if}

  {#if documentFailure}
    <div class="doc-state" role="alert">
      <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
      <strong>无法读取这个版本的文档</strong>
      <p>{documentFailure}</p>
      <div class="doc-state-actions">
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => void retry()}>重新读取</button>
        {#if onMode && currentMode === "preview"}
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => requestMode("source")}>查看源码</button>
        {/if}
      </div>
    </div>
  {:else if documentLoading && !documentResult}
    <div class="doc-skeleton" role="status" aria-label="正在读取文档">
      {#each [42, 68, 55, 0, 74, 48, 61, 34] as width, index (index)}
        <span class="sk-line"><span class="sk-ln"></span>{#if width}<span class="sk-code" style={`width:${width}%`}></span>{/if}</span>
      {/each}
    </div>
  {:else if currentMode === "preview"}
    {#if documentResult && documentResult.kind === "text" && documentResult.text !== null}
      <MarkdownPreview
        text={documentResult.text}
        documentKey={previewKey}
        {active}
        anchor={previewAnchor}
        navigationSerial={previewNavigation}
        scrollTop={previewTop}
        onPosition={previewMoved}
        onLink={follow}
        onLoadImage={loadImage}
        onSource={onMode ? () => requestMode("source") : undefined}
        bind:outlineOpen
        showTools={header}
        {onHeadings}
      />
    {:else if documentResult && documentResult.kind === "tooLarge"}
      <div class="doc-state" role="status">
        <span class="empty-icon"><Icon name="file" size={22} /></span>
        <strong>文档超过排版预览上限</strong>
        <p>{documentResult.message ?? "这篇文档超过了 2 MiB 的预览预算，可以继续按源码阅读。"}</p>
        {#if onMode}<button type="button" class="btn btn-secondary btn-sm" onclick={() => requestMode("source")}>查看源码</button>{/if}
      </div>
    {:else if documentResult}
      <div class="doc-state" role="status">
        <span class="empty-icon"><Icon name={documentResult.kind === "missing" ? "alert-circle" : "file"} size={22} /></span>
        <strong>{documentResult.kind === "missing" ? "这个版本里没有这个文件" : documentResult.kind === "resource" ? "这是资源文件" : "这个版本没有可显示的正文"}</strong>
        <p>{documentResult.message ?? "这个版本的文档无法排版显示。"}</p>
        {#if documentResult.kind === "resource"}{@render resourceView()}{/if}
        {#if onMode && documentResult.kind !== "missing" && documentResult.kind !== "resource"}
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => requestMode("source")}>查看源码</button>
        {/if}
      </div>
    {:else}
      <div class="doc-state"><strong>没有可显示的文档</strong></div>
    {/if}
  {:else if sourceFailure}
    <div class="doc-state" role="alert">
      <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
      <strong>{sourceStateTitle()}</strong>
      <p>{sourceFailure}</p>
      <div class="doc-state-actions">
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => void retry()}>重新读取</button>
        {#if onMode}<button type="button" class="btn btn-secondary btn-sm" onclick={() => requestMode("preview")}>查看预览</button>{/if}
      </div>
    </div>
  {:else if sourceLoading && sourceLines.length === 0}
    <div class="doc-skeleton" role="status" aria-label="正在读取源码">
      {#each [40, 66, 52, 0, 72, 46] as width, index (index)}
        <span class="sk-line"><span class="sk-ln"></span>{#if width}<span class="sk-code" style={`width:${width}%`}></span>{/if}</span>
      {/each}
    </div>
  {:else if sourceKind === "text" && sourceLines.length > 0}
    {#if sourceMessage}<p class="doc-notice" role="status"><Icon name="info" size={13} />{sourceMessage}</p>{/if}
    <!-- 可聚焦的只读源码区：长行与长代码在这里滚动，键盘用户也能读全。 -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="doc-source-scroll"
      role="region"
      aria-label="文档源码"
      tabindex="0"
      bind:this={sourceScroller}
      onscroll={sourceScrolled}
    >
      {#each sourceLines as text, index (index)}
        {@const no = sourceOffset + index + 1}
        <div class="doc-source-line" class:hit={sourceHit === no} data-doc-line={no}>
          <span class="ln" aria-hidden="true">{no}</span>
          <span class="code">{text}</span>
        </div>
      {/each}
    </div>
    {#if sourceHasMore}
      <div class="doc-more">
        {#if sourceMore}<span class="spinner" aria-hidden="true"></span>{/if}
        <button type="button" class="link-btn" title={sourceMore ? "正在读取下一页" : "继续读取后面的源码"} disabled={sourceMore} onclick={() => readSource(sourceOffset + sourceLines.length, generation, 0, true)}>
          {sourceMore ? "正在读取…" : `继续读取后续源码（已显示 ${sourceLines.length} 行）`}
        </button>
      </div>
    {/if}
  {:else if sourceKind === "text"}
    <div class="doc-state" role="status">
      <span class="empty-icon"><Icon name="file" size={22} /></span>
      <strong>这个版本的文档是空的</strong>
      <p>空文件仍然可以按源码查看，没有可显示的内容。</p>
      {#if onMode}<button type="button" class="btn btn-secondary btn-sm" onclick={() => requestMode("preview")}>查看预览</button>{/if}
    </div>
  {:else if sourceKind}
    <div class="doc-state" role="status">
      <span class="empty-icon"><Icon name="file" size={22} /></span>
      <strong>{sourceStateTitle()}</strong>
      <p>{sourceMessage ?? "这个版本没有可显示的源码。"}</p>
      {#if onMode}<button type="button" class="btn btn-secondary btn-sm" onclick={() => requestMode("preview")}>查看预览</button>{/if}
    </div>
  {:else if documentResult && documentResult.kind !== "text" && documentResult.kind !== "tooLarge"}
    <div class="doc-state" role="status">
      <span class="empty-icon"><Icon name="file" size={22} /></span>
      <strong>{documentStateTitle(documentResult.kind)}</strong>
      <p>{documentResult.message ?? "这个版本没有可显示的源码。"}</p>
      {#if documentResult.kind === "resource"}{@render resourceView()}{/if}
      {#if onMode && documentResult.kind !== "resource"}<button type="button" class="btn btn-secondary btn-sm" onclick={() => requestMode("preview")}>查看预览</button>{/if}
    </div>
  {:else}
    <div class="doc-state" role="status"><strong>正在准备源码</strong></div>
  {/if}
</section>

{#snippet resourceView()}
  {#if resourceLoading}<p class="doc-notice" role="status">正在读取这个版本的资源…</p>{/if}
  {#if resourceError}<p class="doc-notice danger" role="alert">{resourceError}</p>{/if}
  {#if resourcePreview?.kind === "image" && safeImageDataUrl(resourcePreview.dataUrl)}
    <div class="doc-resource">
      <img src={safeImageDataUrl(resourcePreview.dataUrl) ?? ""} alt={`${boundSource.path}（这个版本）`} />
    </div>
  {/if}
{/snippet}
