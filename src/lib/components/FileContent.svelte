<script lang="ts">
  import { tick, untrack } from "svelte";
  import { api } from "../api";
  import { MODIFIER_LABEL } from "../brand";
  import { fileTone, matchSnippet } from "../file-kind";
  import { trackCodeScroll } from "../codeScroll.svelte";
  import { normalizeError } from "../errors";
  import { fileEditor, isDirty, type EditContext, type FileEditor } from "../file-editor.svelte";
  import {
    createDocumentSession,
    initialDocumentMode,
    isMarkdownPath,
    type DocumentLinkTarget,
    type DocumentMode,
    type DocumentSession,
  } from "../document-session.svelte";
  import { codeContentSize, codeRuler, rulerPadding, visibleRange } from "../layout";
  import { languageName } from "../syntax/languages";
  import { createHighlight } from "../syntax/highlight.svelte";
  import { effectiveLanguage } from "../syntax/prefs.svelte";
  import { lineSegments } from "../syntax/segments";
  import type {
    OpenedRepository,
    RepositoryContentSearch,
    RepositoryEditSnapshot,
    RepositoryFileContent,
    RepositorySearchScope,
    DocumentSource,
  } from "../types";
  import { BUSY_REASON, documentSourceLabel, formatBytes, rowMark, splitPath, type FileNavState } from "../ui";
  import type { DiffSide } from "../types";
  import BinaryPreview from "./BinaryPreview.svelte";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import DocumentReader from "./DocumentReader.svelte";
  import FileNav from "./FileNav.svelte";
  import Icon from "./Icon.svelte";
  import LanguagePicker from "./LanguagePicker.svelte";
  import RepositoryTextEditor from "./RepositoryTextEditor.svelte";

  /**
   * 文件内容：查看模式只读，文本分页按需读取，代码页复用现有的语言推断、语言选择器与分词；
   * 资源文件交给 file_preview（worktree 版本）。
   *
   * 编辑模式只针对当前工作区的这一个文件：完整快照 + 原生文本输入 + 手动保存，
   * 能不能编辑由后端快照决定（不按扩展名猜）。没有运行、终端、命令执行或 IDE 入口。
   */
  interface Props {
    /** 视图可见：隐藏时不发起新读取，重新激活时按当前代次重验。 */
    active: boolean;
    opened: OpenedRepository;
    path: string | null;
    /** 选中但已从工作区删除的文件：不读当前内容，只提供改动与历史。 */
    missingPath?: string | null;
    /** 统一文件定位的目标行与序号：序号变化时读取目标附近页并滚动过去。 */
    line?: number | null;
    lineSerial?: number;
    generation: number;
    /** 文件本身的元数据版本；有版本时，无关仓库变化不重读。 */
    contentVersion?: string | null;
    /** 手动刷新等无代次变化的强制重读信号。 */
    reloadKey?: number;
    disabled: boolean;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onFileHistory?: (path: string) => void;
    /** 进入这个文件的 staged / unstaged 改动（由外壳切换视图）。 */
    onOpenDiff?: (path: string, side: DiffSide) => void;
    /** 文件切换条：上一个/下一个、后退/前进与最近打开。 */
    nav?: FileNavState | null;
    /** 文档内相对链接：在工作区里同步文件树并选中目标（历史/暂存区阅读不使用）。 */
    onRevealPath?: (path: string, line: number | null) => boolean | Promise<boolean>;
    /** 编辑会话表；不传时用应用内唯一的那一份。 */
    editor?: FileEditor;
    /** 外部（差异、任务净差异）要求进入编辑：序号变化且路径已选中时生效。 */
    editRequest?: { path: string; line: number | null; serial: number } | null;
    /** 从差异进来的返回入口：只在同一路径上显示。 */
    editReturn?: { path: string; label: string; run: () => void } | null;
    /** 保存成功：外壳按新快照刷新状态、差异与审阅标记。 */
    onEditSaved?: (snapshot: RepositoryEditSnapshot) => void;
    /** 保存失败：外壳按真实状态重读（写入可能部分发生）。 */
    onEditFailed?: (code: string) => void;
  }

  let {
    active,
    opened,
    path,
    missingPath = null,
    line = null,
    lineSerial = 0,
    generation,
    contentVersion = null,
    reloadKey = 0,
    disabled,
    nextId,
    onGeneration,
    onFileHistory,
    onOpenDiff,
    nav = null,
    onRevealPath,
    editor = fileEditor,
    editRequest = null,
    editReturn = null,
    onEditSaved,
    onEditFailed,
  }: Props = $props();

  /** 与 components.css 的 .file-line 行高一致：虚拟窗口按它算，行号与代码同高。 */
  const ROW_HEIGHT = 20;
  /** 距离已读末尾不足这么多行时自动续读：滚动到底之前就把下一页接上。 */
  const PREFETCH_ROWS = 40;
  /** 换行模式下不做虚拟化：超过这个行数只提示，不把整份文件排进 DOM。 */
  const WRAP_LIMIT = 2000;

  let content = $state.raw<RepositoryFileContent | null>(null);
  let lines = $state.raw<string[]>([]);
  let pageOffset = $state(0);
  let hasMore = $state(false);
  let loading = $state(false);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let wrap = $state(false);
  let view = $state<"source" | "image">("source");
  let hitLine = $state<number | null>(null);
  /**
   * ⌘/Ctrl A 只选这个文件的正文。代码区是虚拟滚动的，屏幕外的行不在 DOM 里，浏览器原生全选
   * 只会选中可见的几十行（并且会连同整个窗口一起选中）；这里改成「整份已读内容」的选中态，
   * 用样式画出选区，复制时写入全部已读行。点一下、按 Esc 或换文件就取消。
   */
  let allSelected = $state(false);
  $effect(() => {
    void path;
    void wrap;
    allSelected = false;
  });
  let copied = $state(false);

  let searchOpen = $state(false);
  let searchQuery = $state("");
  let searchResult = $state<RepositoryContentSearch | null>(null);
  let searchError = $state<string | null>(null);
  /** 这份匹配对应的文件版本与强制重读信号。 */
  let resultVersion = $state<string | number | null>(null);
  let resultKey = $state(-1);
  let searching = $state(false);
  let searchInput = $state<HTMLInputElement | null>(null);

  let gotoOpen = $state(false);
  let gotoValue = $state("");
  let gotoInput = $state<HTMLInputElement | null>(null);
  /** 当前停在第几处匹配：上一处/下一处按它循环，结果换了就回到 -1。 */
  let matchCursor = $state(-1);
  let menu = $state<ContextMenuRequest | null>(null);
  let moreButton = $state<HTMLButtonElement | null>(null);
  let moreClosedAt = 0;

  let scrollTop = $state(0);
  let viewport = $state(0);
  let scroller = $state<HTMLDivElement | null>(null);
  let searchSerial = 0;
  let fileVersion = $derived(contentVersion ?? generation);

  let parts = $derived(path ? splitPath(path) : null);
  let language = $derived(path ? effectiveLanguage(path) : null);
  let languageLabel = $derived(languageName(language));
  let change = $derived(path ? opened.snapshot.files.find((file) => file.path === path) ?? null : null);
  /** 删除墓碑的改动来源：只用于给「查看改动」判断两侧是否存在。 */
  let deletedChange = $derived(
    missingPath ? opened.snapshot.files.find((file) => file.path === missingPath) ?? null : null,
  );
  let mark = $derived.by(() => {
    if (!change) return null;
    const side = change.unstaged !== "none" || change.untracked ? "unstaged" : "staged";
    return rowMark({ ...change, side });
  });
  /** 这个文件有哪几侧改动：工具条主按钮去未暂存一侧（工作区此刻的样子），另一侧在「更多」里。 */
  let hasUnstaged = $derived(Boolean(change && (change.unstaged !== "none" || change.untracked)));
  let hasStaged = $derived(Boolean(change && change.staged !== "none"));
  let primarySide = $derived<DiffSide | null>(hasUnstaged ? "unstaged" : hasStaged ? "staged" : null);
  let matchCount = $derived(searchResult?.matches.length ?? 0);
  let isSvg = $derived(Boolean(path && path.toLowerCase().endsWith(".svg")));
  let showImage = $derived(view === "image" || content?.kind === "resource");
  let previewSources = $derived(
    path ? { repository: opened.summary.path, old: null, new: { revision: "worktree", path } } : null,
  );

  /*
   * 编辑模式：这个文件有编辑会话就是在编辑。会话按「仓库 + 路径」留在内存里，
   * 换文件再回来草稿还在；删除的文件与历史版本不会走到这里。
   */
  let editSession = $derived(path && !missingPath ? editor.session(opened.summary.path, path) : null);
  let editing = $derived(editSession !== null);
  let editDirty = $derived(isDirty(editSession));
  /** 只有当前工作区的文本才给编辑入口；最终能否编辑仍以后端完整快照为准。 */
  let canEdit = $derived(Boolean(path && !missingPath && (editing || content?.kind === "text")));
  let editLine = $state<number | null>(null);
  let editLineSerial = $state(0);
  let showReturn = $derived(Boolean(editReturn && path && editReturn.path === path));

  function editContext(): EditContext {
    return { generation: opened.generation, nextId, onGeneration };
  }

  function startEdit(line: number | null = null): void {
    if (!path || missingPath) return;
    editLine = line;
    editLineSerial += 1;
    // 从查看切过来：文件内查找、跳行与整份选中都属于只读视图，先收起。
    searchOpen = false;
    gotoOpen = false;
    allSelected = false;
    void editor.open(opened.summary.path, path, editContext());
  }

  /** 回到查看：有未保存修改时不允许（按钮就地禁用并说明），干净会话直接结束并重读当前内容。 */
  function stopEdit(): void {
    if (!path || !editSession || isDirty(editSession)) return;
    editor.close(opened.summary.path, path);
    void read(path, 0, false, generation);
  }

  async function saveEdit(): Promise<void> {
    if (!path) return;
    const outcome = await editor.save(opened.summary.path, path, editContext());
    if (outcome.ok) onEditSaved?.(outcome.snapshot);
    else onEditFailed?.(outcome.code);
  }

  function reloadEdit(): void {
    if (!path) return;
    void editor.reload(opened.summary.path, path, editContext());
  }

  /* 外部要求进入编辑（差异里的「编辑」）：等文件树选中同一路径后生效，同一序号只生效一次。 */
  let lastEditRequest = 0;
  $effect(() => {
    const request = editRequest;
    const target = path;
    if (!request || request.serial === lastEditRequest || request.path !== target || missingPath) return;
    untrack(() => {
      lastEditRequest = request.serial;
      startEdit(request.line);
    });
  });

  /*
   * 文件版本变化或重新回到有会话的文件：按完整内容摘要复核。
   * 干净会话换到新基线，dirty 草稿保留并标出冲突，绝不被外部内容覆盖。
   * 本组件刚打开、正在读取的会话不重复复核。
   */
  let lastEditCheck = "";
  $effect(() => {
    const target = path;
    const repoPath = opened.summary.path;
    const version = fileVersion;
    const key = reloadKey;
    const visible = active;
    const phase = editSession?.phase ?? null;
    if (!target || phase === null || !visible) {
      if (phase === null) lastEditCheck = "";
      return;
    }
    const signature = JSON.stringify([repoPath, target, version, key]);
    if (signature === lastEditCheck) return;
    const previous = lastEditCheck;
    lastEditCheck = signature;
    if (previous === "" && phase === "loading") return;
    untrack(() => void editor.checkExternal(repoPath, target, editContext()));
  });

  /*
   * Markdown 阅读：普通打开默认排版预览，搜索命中或指定行进入源码。
   * 模式与两个视图的位置都按「仓库 + 版本 + 路径」存在会话里，切走再回来接着读。
   */
  let isMarkdown = $derived(Boolean(path && isMarkdownPath(path)));
  let documentMode = $state<DocumentMode>("preview");
  /* 预览的目录入口放在文件工具条上（不另占一行）；展开状态跨文档保留，按阅读习惯来。 */
  let outlineOpen = $state(false);
  let headingCount = $state(0);
  /** 预览正文的大小：预览不走代码读取，由阅读器上报给状态条。 */
  let documentSize = $state<number | null>(null);
  let documentNotice = $state<string | null>(null);
  /** 上一次恢复用的签名：同一个签名不重复恢复。 */
  let restoreSignature = "";
  /** 本次打开已经落地的显式行定位序号：同一序号再回到源码时应当按会话位置恢复。 */
  let appliedLineSerial: number | null = null;
  const documentSession: DocumentSession = createDocumentSession({ repository: () => opened.summary.path });
  let documentSource = $derived<DocumentSource>({
    revision: "worktree",
    path: path ?? "",
    repository: opened.summary.path,
  });

  const syntax = createHighlight(() => ({ lang: active && !showImage ? language : null, lines }));
  const codeTexts = $derived(lines);
  const ruler = $derived(codeRuler(codeTexts));
  const codeSize = $derived(codeContentSize(codeTexts));
  let range = $derived(visibleRange(lines.length, scrollTop, viewport, ROW_HEIGHT));
  let canWrap = $derived(lines.length <= WRAP_LIMIT);

  trackCodeScroll(
    () => (wrap ? null : scroller),
    () => ruler,
    () => range,
    () => codeSize,
  );

  function segmentsAt(index: number) {
    const text = lines[index] ?? "";
    return lineSegments(text, syntax.at(index), null, false);
  }

  function resetContent(): void {
    matchCursor = -1;
    content = null;
    lines = [];
    pageOffset = 0;
    hasMore = false;
    error = null;
    hitLine = null;
    searchResult = null;
    searchError = null;
    searchQuery = "";
    searchOpen = false;
    wrap = false;
    view = "source";
    scrollTop = 0;
    if (scroller) scroller.scrollTop = 0;
  }

  let serial = 0;

  async function read(target: string, offset: number, append: boolean, generationAtStart: number, attempt = 0): Promise<void> {
    const repoPath = opened.summary.path;
    const token = ++serial;
    if (append) loadingMore = true;
    else {
      loading = true;
      // 文件变化或主动重读时撤下旧正文，防止把旧版本当成当前文件。
      content = null;
      lines = [];
      error = null;
    }
    try {
      const page = await api.repositoryFileContent(repoPath, target, offset, undefined, generationAtStart, nextId());
      if (token !== serial || path !== target || opened.summary.path !== repoPath) return;
      if (page.generation > generationAtStart) onGeneration(page.generation);
      if (page.generation < opened.generation && attempt === 0) {
        void read(target, offset, append, page.generation, attempt + 1);
        return;
      }
      // 目录监听尚未更新时文件也可能已变；不能把新版本的下一页接到旧正文上。
      if (append && content?.version && page.version && content.version !== page.version) {
        void read(target, 0, false, page.generation);
        return;
      }
      content = page;
      if (page.kind === "text") {
        lines = append ? [...lines, ...page.lines] : page.lines;
        pageOffset = append ? pageOffset : offset;
        hasMore = page.hasMore;
        if (!append) {
          scrollTop = 0;
          if (scroller) scroller.scrollTop = 0;
        }
      } else {
        lines = [];
        hasMore = false;
        pageOffset = 0;
      }
    } catch (failure) {
      if (token !== serial || path !== target || opened.summary.path !== repoPath) return;
      const normalized = normalizeError(failure);
      if (normalized.code === "stale" && normalized.generation !== undefined && attempt === 0) {
        onGeneration(normalized.generation);
        void read(target, offset, append, normalized.generation, attempt + 1);
        return;
      }
      if (!append) {
        content = null;
        lines = [];
      }
      error = normalized.message || "无法读取这个文件。";
    } finally {
      if (token === serial) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  /**
   * 有元数据版本时只跟随当前文件变化；没有版本则按仓库代次保守重读。
   * 无关文件变化不清空分页、滚动位置、选择或高亮，也不重发正在读取的请求。
   */
  let lastRead = "";
  $effect(() => {
    const target = path;
    const repoPath = opened.summary.path;
    const version = fileVersion;
    const generationNow = generation;
    const key = reloadKey;
    const visible = active;
    untrack(() => {
      if (!target) {
        lastRead = "";
        resetContent();
        return;
      }
      if (!visible) return;
      const signature = JSON.stringify([repoPath, target, version, key]);
      if (signature === lastRead && (content?.path === target || loading)) return;
      lastRead = signature;
      void read(target, 0, false, generationNow);
    });
  });

  /* 路径变化时清空上一份内容与搜索，避免把上一个文件的结果当成当前文件的。 */
  let lastPath: string | null = null;
  $effect(() => {
    const target = path;
    if (target === lastPath) return;
    lastPath = target;
    untrack(() => {
      // 换文件即取消旧搜索：迟到的匹配属于上一个文件，不能显示、也不能跳行。
      searchSerial += 1;
      searching = false;
      resetContent();
      documentNotice = null;
      // 排队中的位置属于上一个文件：按排队时的身份落定，不能写进新文件的会话条目。
      commitQueuedSourceSave();
      // 上一个文件的位置恢复签名与已落地的行定位都不再适用于这个文件。
      restoreSignature = "";
      appliedLineSerial = null;
      // Markdown 沿用同身份上一次的阅读模式；其它文件只有源码一种显示方式。
      documentMode = target && isMarkdownPath(target)
        ? initialDocumentMode(null, documentSession.recall({ revision: "worktree", path: target }))
        : "source";
    });
  });

  /*
   * 文件版本或重读信号前进：旧命中的行号不再可信。
   * 这里必须把结果显示一起撤下——只收起行号、留着旧匹配列表，
   * 会让使用者按旧行号跳到新内容的错误位置。
   */
  $effect(() => {
    const version = fileVersion;
    const key = reloadKey;
    if (searchResult === null) return;
    if (resultVersion === version && resultKey === key) return;
    untrack(() => {
      searchSerial += 1;
      searching = false;
      searchResult = null;
      searchError = null;
      hitLine = null;
    });
  });

  /** 统一文件定位的目标行：序号变化即按偏移读取并滚过去，不改动其它状态。 */
  let lastLineSerial = 0;
  $effect(() => {
    const serial = lineSerial;
    const target = line;
    if (serial === lastLineSerial) return;
    lastLineSerial = serial;
    untrack(() => {
      if (target === null || target <= 0 || !path) return;
      // 这次打开的位置恢复要让位给新的显式定位；序号被记下后，
      // 同一序号在往返/再访问时不再代表「新的定位」。
      appliedLineSerial = serial;
      // 搜索命中、跳到行都要落在源码上：显式行定位优先于保存的阅读模式。
      if (isMarkdownPath(path)) setDocumentMode("source");
      void jumpTo(target);
    });
  });

  /* ---- Markdown 阅读：模式切换、位置保存与恢复 ---- */

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** 排队中的源码位置写入：身份与位置在排队时快照，延迟触发不会读到别的文件。 */
  let queuedSourceCommit: (() => void) | undefined;

  function cancelQueuedSourceSave(): void {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = undefined;
    queuedSourceCommit = undefined;
  }

  /** 立即落定排队中的位置写入（换文件、离开源码时），不再按触发时的实时状态写。 */
  function commitQueuedSourceSave(): void {
    const commit = queuedSourceCommit;
    cancelQueuedSourceSave();
    commit?.();
  }

  function saveSourcePosition(): void {
    if (!isMarkdown || !path || !content || content.kind !== "text") return;
    const line = pageOffset + Math.floor(scrollTop / ROW_HEIGHT) + 1;
    documentSession.remember(documentSource, {
      mode: "source",
      source: { line, top: scrollTop },
      version: content.version ?? null,
    });
  }

  function queueSaveSourcePosition(): void {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!path || !isMarkdown || !content || content.kind !== "text") return;
    // 排队时把目标和位置一起快照：定时器触发时可能已经换了文件或版本，
    // 读实时状态会把上一次滚动写成新文件的源码位置、清掉它的预览行。
    const repository = opened.summary.path;
    const source = { revision: "worktree", path };
    const version = content.version ?? null;
    const line = pageOffset + Math.floor(scrollTop / ROW_HEIGHT) + 1;
    const top = scrollTop;
    const commit = () => {
      // 仓库换了就不再写：会话按「仓库 + 版本 + 路径」分条目，旧仓库的位置不能落到新仓库。
      if (opened.summary.path !== repository) return;
      documentSession.remember(source, { mode: "source", source: { line, top }, version });
    };
    queuedSourceCommit = commit;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      queuedSourceCommit = undefined;
      commit();
    }, 120);
  }

  // 卸载前把最后一处源码位置落进会话。
  $effect(() => () => {
    cancelQueuedSourceSave();
    saveSourcePosition();
  });

  function setDocumentMode(next: DocumentMode): void {
    if (documentMode === next) return;
    if (next === "source") saveSourcePosition();
    // 离开源码：先落定排队中的位置，再清恢复签名与已落地的行定位——
    // 再切回源码要按会话里的位置重新定位，不能一直被上一次行定位挡住。
    if (next === "preview") {
      commitQueuedSourceSave();
      restoreSignature = "";
      appliedLineSerial = null;
    }
    documentMode = next;
    documentNotice = null;
    if (path && isMarkdownPath(path)) {
      documentSession.remember(documentSource, { mode: next, version: content?.version ?? null });
    }
  }

  /**
   * 回到这个版本上次的源码位置：目标不在已读页时按偏移读取，读到更短的内容就夹到有效范围。
   * 分页起点没变时按保存的精确偏移写回，避免只按行居中把位置挪走。
   */
  async function restoreSourcePosition(target: string): Promise<void> {
    const stored = documentSession.recall({ revision: "worktree", path: target }, content?.version ?? null);
    if (!stored) return;
    const line = Math.max(1, Math.trunc(stored.reading.source.line));
    if (!Number.isFinite(line) || line <= 1) return;
    const top = Math.max(0, Math.trunc(stored.reading.source.top));
    if (line - 1 < pageOffset || line - 1 >= pageOffset + lines.length) {
      await read(target, line - 1, false, generation);
      if (path !== target) return;
      // 等这一页真的挂进 DOM 再滚：否则 scrollTop 会被旧高度夹住。
      await tick();
    }
    if (alignedSourceTop(line, top)) {
      scrollTop = top;
      if (scroller) scroller.scrollTop = top;
    } else {
      revealLine(line);
    }
    if (stored.moved) documentNotice = "文件内容已变化，阅读位置按新内容重新定位。";
    else if (line > pageOffset + lines.length) documentNotice = "这个版本比上次短，阅读位置已调整到有效范围。";
  }

  /** 保存的 top 与行号是否还落在同一分页坐标里：页面起点变了就只按行恢复。 */
  function alignedSourceTop(line: number, top: number): boolean {
    if (top <= 0 || wrap) return false;
    return pageOffset + Math.floor(top / ROW_HEIGHT) + 1 === line;
  }

  /*
   * 恢复时机：源码正文已经就绪、当前是源码模式、且没有新的行定位。
   * 版本变化或重新切换到源码都会重新走一次，签名相同则不重复恢复。
   */
  $effect(() => {
    const loaded = content;
    const target = path;
    const mode = documentMode;
    const explicit = line;
    const serial = lineSerial;
    if (!loaded || loaded.kind !== "text" || !target || !isMarkdownPath(target)) return;
    const signature = JSON.stringify([opened.summary.path, target, mode, loaded.version ?? "", serial, explicit]);
    if (mode !== "source" || signature === restoreSignature) return;
    untrack(() => {
      restoreSignature = signature;
      // 只有这次打开尚未落地的新行定位才优先于恢复；同一序号在往返/换文件回来后
      // 已是「上一次的定位」，必须恢复会话位置，否则会一直回到文件开头。
      if (explicit !== null && explicit > 0 && appliedLineSerial === serial) return;
      void restoreSourcePosition(target);
    });
  });

  /*
   * 源码分支按条件渲染：从预览切回来或换行模式切回时，滚动容器是新挂载的，
   * 它的 scrollTop 从 0 开始，而虚拟窗口仍按同一份状态取行。挂载即写回，
   * 避免正文回到首页并出现顶部空白/行缺失的窗口错位。
   */
  $effect(() => {
    const node = scroller;
    if (!node) return;
    untrack(() => {
      if (scrollTop > 0 && node.scrollTop !== scrollTop) node.scrollTop = scrollTop;
    });
  });

  async function loadMore(): Promise<void> {
    if (!path || !hasMore || loading || loadingMore) return;
    await read(path, pageOffset + lines.length, true, generation);
  }

  /** 滚到接近已读末尾时自动续读下一页；续读失败仍留着底部按钮可以手动重试。 */
  function onCodeScroll(event: Event): void {
    const target = event.currentTarget as HTMLElement;
    scrollTop = target.scrollTop;
    if (isMarkdown) queueSaveSourcePosition();
    if (!hasMore || loading || loadingMore || error || viewport <= 0) return;
    if (scrollTop + viewport >= (lines.length - PREFETCH_ROWS) * ROW_HEIGHT) void loadMore();
  }

  /** 跳到指定行：目标不在已加载页时按偏移重新读取，而不是只滚动 DOM。 */
  async function jumpTo(line: number): Promise<void> {
    if (!path) return;
    const target = Math.max(1, Math.trunc(line));
    if (target - 1 >= pageOffset && target - 1 < pageOffset + lines.length) {
      hitLine = target;
      revealLine(target);
      return;
    }
    hitLine = target;
    await read(path, target - 1, false, generation);
    // 读取完成后滚动到命中行。
    queueMicrotask(() => revealLine(target));
  }

  function revealLine(line: number): void {
    if (wrap) {
      document.querySelector<HTMLElement>(`[data-file-line="${line}"]`)?.scrollIntoView({ block: "center" });
      return;
    }
    const index = line - 1 - pageOffset;
    if (index < 0) return;
    const next = Math.max(0, index * ROW_HEIGHT - (viewport || 400) / 2);
    scrollTop = next;
    if (scroller) scroller.scrollTop = next;
  }

  function submitGoto(): void {
    const value = Number.parseInt(gotoValue.trim(), 10);
    if (!Number.isFinite(value) || value < 1) return;
    gotoOpen = false;
    gotoValue = "";
    void jumpTo(value);
  }

  async function openGoto(): Promise<void> {
    // 跳行同样只在源码上有意义：从预览发起时先切到源码。
    if (isMarkdown) setDocumentMode("source");
    gotoOpen = true;
    await tick();
    gotoInput?.focus();
    gotoInput?.select();
  }

  /** 在匹配之间循环：delta=1 下一处，-1 上一处；还没停在任何一处时从头或尾开始。 */
  function stepMatch(delta: 1 | -1): void {
    const matches = searchResult?.matches ?? [];
    if (matches.length === 0) return;
    const next = matchCursor < 0
      ? (delta > 0 ? 0 : matches.length - 1)
      : (matchCursor + delta + matches.length) % matches.length;
    pickMatch(next);
  }

  function pickMatch(index: number): void {
    const match = searchResult?.matches[index];
    if (!match) return;
    matchCursor = index;
    void jumpTo(match.line);
    // 匹配列表跟着滚到当前那一条，键盘走动时也看得见位置。
    void tick().then(() =>
      document.querySelector<HTMLElement>(`[data-match-index="${index}"]`)?.scrollIntoView?.({ block: "nearest" }),
    );
  }

  /**
   * 文件内搜索：发起时记下路径、代次与 serial，结果只有在三者都仍是当前值时才写入。
   * 换文件就递增 searchSerial 取消旧搜索；否则旧文件的匹配会按错误行号跳到当前文件。
   */
  async function runSearch(): Promise<void> {
    const query = searchQuery.trim();
    if (!path || !query) {
      searchResult = null;
      searchError = null;
      return;
    }
    const token = ++searchSerial;
    const repoPath = opened.summary.path;
    const targetPath = path;
    const targetGeneration = generation;
    const targetVersion = fileVersion;
    const targetKey = reloadKey;
    const scope: RepositorySearchScope = { kind: "file", path: targetPath };
    searching = true;
    searchError = null;
    try {
      const result = await api.repositoryContentSearch(repoPath, query, scope, false, 200, targetGeneration, nextId());
      if (token !== searchSerial) return;
      if (path !== targetPath || opened.summary.path !== repoPath) return;
      // 当前文件变化才撤下命中；无关文件的代次变化不打断搜索阅读。
      if (targetVersion !== fileVersion || targetKey !== reloadKey || result.generation < targetGeneration) {
        searchResult = null;
        return;
      }
      if (result.generation > generation) onGeneration(result.generation);
      resultVersion = targetVersion;
      resultKey = targetKey;
      searchResult = result;
      matchCursor = -1;
    } catch (failure) {
      if (token !== searchSerial) return;
      if (path !== targetPath || opened.summary.path !== repoPath) return;
      const normalized = normalizeError(failure);
      searchResult = null;
      searchError = normalized.message || "无法在这个文件里搜索。";
    } finally {
      if (token === searchSerial) searching = false;
    }
  }

  /**
   * 文件内查找失败的第二个恢复入口：先按当前内容重读这个文件，再按新内容重找一次。
   * 只重读不重找会把搜索框留在手里却什么都不显示，等于又让用户自己再点一次。
   */
  async function reloadAndSearch(): Promise<void> {
    if (!path) return;
    await read(path, 0, false, generation);
    if (searchQuery.trim()) await runSearch();
  }

  /**
   * 恢复入口点击后失败块会先被撤下、失败返回后再重建，焦点不能掉到 body。
   * 重试期间把焦点留在查找框：键盘用户不必从页面开头重新 Tab，失败再次出现时
   * role="alert" 会播报原因，「重试查找 / 重新读取文件」也仍可 Tab 回去。
   */
  async function retrySearch(): Promise<void> {
    await runSearch();
    searchInput?.focus();
  }

  async function retryReloadAndSearch(): Promise<void> {
    await reloadAndSearch();
    searchInput?.focus();
  }

  function openSearch(): void {
    // 文件内查找只在源码上有意义：从预览发起时先切到源码，搜索框才不会被预览盖住。
    if (isMarkdown) setDocumentMode("source");
    searchOpen = true;
    gotoOpen = false;
    queueMicrotask(() => {
      searchInput?.focus();
      searchInput?.select();
    });
  }

  /**
   * 工作区文档里的相对链接：同步文件树并选中目标（同版本工作区内容）。
   * 目标是另一篇 Markdown 时把锚点写进目标身份的会话，选中后由预览恢复到那个标题。
   */
  async function followWorktreeLink(target: DocumentLinkTarget): Promise<boolean> {
    if (target.kind !== "local" || !target.path || !onRevealPath) return false;
    if (target.anchor && isMarkdownPath(target.path)) {
      documentSession.remember(
        { revision: "worktree", path: target.path },
        { mode: "preview", preview: { top: 0, anchor: target.anchor } },
      );
    }
    return onRevealPath(target.path, null);
  }

  function closeSearch(): void {
    searchOpen = false;
    searchQuery = "";
    searchResult = null;
    searchError = null;
    matchCursor = -1;
    hitLine = null;
    // 只有焦点本来就在搜索框里（键盘关闭）才交还给代码区；鼠标点关闭不抢焦点。
    if (searchInput && document.activeElement === searchInput) scroller?.focus({ preventScroll: true });
  }

  /**
   * 内容区自己的快捷键：焦点在内容区时 ⌘/Ctrl F 是文件内搜索、⌘/Ctrl G 是跳行。
   * 在这里拦下并停止冒泡，全局的 ⌘/Ctrl F（聚焦文件树筛选）只在内容区之外生效。
   */
  function onContentKey(event: KeyboardEvent): void {
    // 编辑模式的按键归编辑器：只读视图的查找、跳行与整份选中都不在这里接管。
    if (editing) return;
    const mod = event.metaKey || event.ctrlKey;
    if (allSelected && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      allSelected = false;
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a" && !isEditable(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      selectAllContent(event.currentTarget as HTMLElement);
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c" && allSelected && !isEditable(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      void copyAll();
      return;
    }
    if (content?.kind !== "text") return;
    if (!mod || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === "f") {
      event.preventDefault();
      event.stopPropagation();
      openSearch();
    } else if (key === "g") {
      event.preventDefault();
      event.stopPropagation();
      searchOpen = false;
      void openGoto();
    }
  }

  function isEditable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || Boolean(target.closest("input, textarea, select"));
  }

  /**
   * 全选的范围只到这个文件的正文：排版预览与源码阅读选中正文节点本身；代码区（含自动换行）
   * 进入「整份已读内容」选中态。都不是时（例如二进制、读取失败）什么也不选，绝不外溢到整个窗口。
   */
  function selectAllContent(root: HTMLElement): void {
    const scope = root.querySelector<HTMLElement>("[data-select-scope]");
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (scope) {
      allSelected = false;
      selection?.selectAllChildren(scope);
      return;
    }
    if (content?.kind === "text" && lines.length > 0) {
      selection?.removeAllRanges();
      allSelected = true;
    }
  }

  async function copyAll(): Promise<void> {
    try {
      await navigator.clipboard.writeText(allText());
    } catch {
      // 剪贴板不可用时保留选中态，用户还能再试；不弹错误打断阅读。
    }
  }

  /** 复制事件（右键菜单、系统菜单）走同一份内容：选中态下写入全部已读行，而不是可见那几行。 */
  function onContentCopy(event: ClipboardEvent): void {
    if (!allSelected || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", allText());
  }

  function allText(): string {
    return lines.join("\n");
  }

  function moreEntries(): ContextMenuEntry[] {
    if (!path) return [];
    const target = path;
    const entries: ContextMenuEntry[] = [];
    if (content?.kind === "text") {
      entries.push({ id: "goto", label: "跳到行", icon: "arrow-right", shortcut: `${MODIFIER_LABEL} G`, run: () => void openGoto() });
    }
    if (onOpenDiff && hasUnstaged && hasStaged) {
      entries.push({ id: "staged", label: "查看已暂存的改动", icon: "file-diff", run: () => onOpenDiff?.(target, "staged") });
    }
    if (onFileHistory) {
      entries.push({ id: "history", label: "查看文件历史", icon: "history", run: () => onFileHistory?.(target) });
    }
    if (entries.length > 0) entries.push({ separator: true });
    entries.push({ id: "copy", label: "复制路径", icon: "copy", run: () => void copyPath() });
    return entries;
  }

  function toggleMore(): void {
    if (menu || performance.now() - moreClosedAt < 250) return;
    const rect = moreButton?.getBoundingClientRect();
    menu = {
      x: rect ? rect.right - 232 : 120,
      y: rect ? rect.bottom + 4 : 120,
      entries: moreEntries(),
      label: "更多文件操作",
    };
  }

  function closeMenu(): void {
    moreClosedAt = performance.now();
    menu = null;
  }

  /** 最近打开（按路径去重，最新的在前）：空状态里直接给出回去的入口。 */
  let recentFiles = $derived.by(() => {
    const visits = nav?.history?.recent ?? [];
    const seen = new Set<string>();
    const out: { path: string; line: number | null }[] = [];
    for (let index = visits.length - 1; index >= 0 && out.length < 6; index -= 1) {
      const visit = visits[index];
      if (seen.has(visit.path)) continue;
      seen.add(visit.path);
      out.push(visit);
    }
    return out;
  });

  async function copyPath(): Promise<void> {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }

  function stateTitle(): string {
    if (content?.kind === "binary") return "二进制文件";
    if (content?.kind === "invalidUtf8") return "不是有效的 UTF-8 文本";
    if (content?.kind === "special") return "特殊文件";
    if (content?.kind === "missing") return "文件不存在";
    return "无法读取文件";
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="file-content"
  onkeydown={onContentKey}
  oncopy={onContentCopy}
  onpointerdown={() => {
    if (allSelected) allSelected = false;
  }}
>
  {#if path && parts}
    <header class="diff-toolbar file-head">
      {#if nav}<FileNav {nav} steps={false} />{/if}
      <div class="file-title" title={path}>
        <span class="breadcrumb">
          {#each (parts.dir ? parts.dir.split("/") : []) as segment, index (index)}
            <span class="crumb">{segment}</span><span class="crumb-sep" aria-hidden="true">/</span>
          {/each}
          <strong class="crumb-name">{parts.name}</strong>
        </span>
        {#if mark}
          <span class={`st ${mark.tone}`} title={mark.label} aria-label={`Git 状态：${mark.label}`}>{mark.letter}</span>
        {/if}
        <button
          type="button"
          class="icon-btn sm file-copy-btn"
          data-copied={copied ? "true" : undefined}
          aria-label={copied ? "已复制文件路径" : "复制文件路径"}
          title={copied ? "已复制路径" : `复制相对路径：${path}`}
          onclick={() => void copyPath()}
        >
          <Icon name={copied ? "check" : "copy"} size={13} />
        </button>
      </div>
      <div class="file-actions">
        {#if canEdit}
          <!-- 查看是只读的分页阅读；编辑只改当前工作区这一个文件，保存需要明确操作。 -->
          <div class="segmented file-view-mode file-edit-mode" role="group" aria-label="查看或编辑">
            <button
              type="button"
              aria-pressed={!editing}
              aria-label="只读查看这个文件"
              title={editDirty ? "有未保存的修改：先保存或放弃修改，再回到查看" : "只读查看，不会改动工作区"}
              disabled={editing && (editDirty || Boolean(editSession?.saving))}
              onclick={stopEdit}
            >查看</button>
            <button
              type="button"
              aria-pressed={editing}
              aria-label="编辑这个工作区文件"
              title="在这里修改当前工作区的这个文件；只在点「保存」时写入，不暂存、不提交"
              onclick={() => {
                if (!editing) startEdit();
              }}
            ><Icon name="pencil" size={12} />编辑</button>
          </div>
        {/if}
        {#if isMarkdown && !showImage && !editing}
          <div class="segmented file-view-mode" role="group" aria-label="Markdown 显示方式">
            <button
              type="button"
              aria-pressed={documentMode === "preview"}
              aria-label="预览这个 Markdown 文档"
              title="排版预览（只读）"
              onclick={() => setDocumentMode("preview")}
            >预览</button>
            <button
              type="button"
              aria-pressed={documentMode === "source"}
              aria-label="查看这个 Markdown 的源码"
              title="显示源码文本"
              onclick={() => setDocumentMode("source")}
            >源码</button>
          </div>
          {#if documentMode === "preview" && headingCount > 0}
            <!-- 目录入口与阅读器自己的工具行同一套控件外观（.md-small-button），不另占一行。 -->
            <button
              type="button"
              class="md-small-button file-outline-btn"
              aria-pressed={outlineOpen}
              aria-label="文档目录"
              title={outlineOpen ? "收起目录" : `显示目录（${headingCount} 个标题）`}
              onclick={() => (outlineOpen = !outlineOpen)}
            ><Icon name="list" size={13} /><span>目录</span></button>
          {/if}
        {/if}
        {#if isSvg && content?.kind === "text" && !editing}
          <div class="segmented file-view-mode" role="group" aria-label="SVG 显示方式">
            <button
              type="button"
              aria-pressed={!showImage}
              aria-label="查看这个 SVG 的源码"
              title="源码文本"
              onclick={() => (view = "source")}
            >源码</button>
            <button
              type="button"
              aria-pressed={showImage}
              aria-label="预览这个 SVG 的图片"
              title="按图片预览"
              onclick={() => (view = "image")}
            >预览</button>
          </div>
        {/if}
        {#if onOpenDiff && primarySide}
          <button
            type="button"
            class="btn btn-ghost btn-sm file-diff-btn"
            aria-label={primarySide === "unstaged" ? "查看未暂存的改动" : "查看已暂存的改动"}
            title={primarySide === "unstaged" ? "回到改动视图，定位到这个文件未暂存的一侧" : "回到改动视图，定位到这个文件已暂存的一侧"}
            onclick={() => onOpenDiff?.(path, primarySide!)}
          ><Icon name="file-diff" size={13} /><span>查看改动</span></button>
        {/if}
        {#if content?.kind === "text" && !showImage && !editing}
          <button
            type="button"
            class="icon-btn sm"
            aria-pressed={searchOpen}
            aria-label="在文件内搜索"
            title={`在文件内搜索（${MODIFIER_LABEL} F）；只查当前文件，不是全仓库搜索`}
            onclick={() => (searchOpen ? closeSearch() : openSearch())}
          ><Icon name="search" size={14} /></button>
          {#if !(isMarkdown && documentMode === "preview")}
            <button
              type="button"
              class="icon-btn sm"
              aria-pressed={wrap}
              aria-label="自动换行"
              title={canWrap ? (wrap ? "关闭自动换行" : "自动换行") : `超过 ${WRAP_LIMIT} 行时不自动换行，避免整份文件排进 DOM`}
              disabled={!canWrap && !wrap}
              onclick={() => (wrap = !wrap)}
            ><Icon name="rows" size={14} /></button>
          {/if}
        {/if}
        <button
          type="button"
          class="icon-btn sm"
          aria-label="更多文件操作"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          title="更多：跳到行、文件历史、复制路径"
          bind:this={moreButton}
          onclick={toggleMore}
        ><Icon name="more" size={15} /></button>
      </div>
    </header>

    {#if searchOpen && content?.kind === "text" && !editing}
      <div class="file-findbar">
        <div class="field sm">
          <Icon name="search" size={13} />
          <input
            bind:this={searchInput}
            data-search-scope="file"
            aria-label="文件内搜索关键词"
            placeholder="在文件中查找"
            title="范围：只在这个文件的当前内容里查找，不搜其他文件，也不筛目录树"
            autocomplete="off"
            spellcheck="false"
            bind:value={searchQuery}
            oninput={() => void runSearch()}
            onkeydown={(event) => {
              if (event.isComposing) return;
              if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              } else if (event.key === "Enter") {
                event.preventDefault();
                stepMatch(event.shiftKey ? -1 : 1);
              }
            }}
          />
          {#if searching}<span class="spinner" aria-hidden="true"></span>{/if}
          {#if searchResult}
            <span class="find-count" class:none={matchCount === 0} role="status">
              {matchCount === 0 ? "没有匹配" : `${matchCursor >= 0 ? `${matchCursor + 1}/` : ""}${matchCount} 处匹配`}
            </span>
            {#if searchResult.truncated}<span class="file-tag" title={searchResult.message ?? "结果被截断"}>已截断</span>{/if}
          {/if}
        </div>
        <button type="button" class="icon-btn sm" aria-label="上一处匹配" title="上一处（Shift Enter）" disabled={matchCount === 0} onclick={() => stepMatch(-1)}>
          <Icon name="chevron-up" size={14} />
        </button>
        <button type="button" class="icon-btn sm" aria-label="下一处匹配" title="下一处（Enter）" disabled={matchCount === 0} onclick={() => stepMatch(1)}>
          <Icon name="chevron-down" size={14} />
        </button>
        <button type="button" class="icon-btn sm" aria-label="关闭文件内搜索" title="关闭（Esc）" onclick={closeSearch}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {#if searchError}
        <p class="file-note danger" role="alert">
          <span>{searchError}</span>
          <button
            type="button"
            class="link-btn"
            data-search-retry="file"
            title="用同一个关键词在这个文件的当前内容里重新查找一次"
            disabled={searching}
            onclick={() => void retrySearch()}
          >重试查找</button>
          <button
            type="button"
            class="link-btn"
            data-search-reload="file"
            title="重新读取当前文件内容，读完后按当前内容重新查找"
            onclick={() => void retryReloadAndSearch()}
          >重新读取文件</button>
        </p>
      {/if}
      {#if searchResult && searchResult.matches.length > 0}
        <div class="file-search-results" role="listbox" aria-label="文件内匹配">
          {#each searchResult.matches as match, index (index)}
            {@const snippet = matchSnippet(match.text, searchQuery, match.column, 48)}
            <button
              type="button"
              class="file-search-hit"
              role="option"
              aria-selected={matchCursor === index}
              data-match-index={index}
              aria-label={`第 ${match.line} 行 ${match.text.trim()}`}
              onclick={() => pickMatch(index)}
            >
              <span class="hit-line">{match.line}</span>
              <span class="hit-text" title={match.text}>{snippet.before}{#if snippet.match}<mark>{snippet.match}</mark>{/if}{snippet.after}</span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}

    {#if gotoOpen && content?.kind === "text" && !editing}
      <div class="file-findbar">
        <div class="field sm file-goto">
          <Icon name="arrow-right" size={13} />
          <input
            bind:this={gotoInput}
            aria-label="跳到行号"
            placeholder="输入行号，回车跳转"
            inputmode="numeric"
            autocomplete="off"
            bind:value={gotoValue}
            onkeydown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitGoto();
              } else if (event.key === "Escape") {
                event.preventDefault();
                gotoOpen = false;
                scroller?.focus({ preventScroll: true });
              }
            }}
          />
        </div>
        <button type="button" class="btn btn-secondary btn-sm" title={gotoValue.trim() ? undefined : "先输入行号"} disabled={!gotoValue.trim()} onclick={submitGoto}>跳转</button>
        <button type="button" class="icon-btn sm" aria-label="关闭跳行" title="关闭（Esc）" onclick={() => (gotoOpen = false)}>
          <Icon name="x" size={14} />
        </button>
      </div>
    {/if}

    {#if documentNotice && !editing}
      <p class="file-note" role="status"><Icon name="info" size={13} />{documentNotice}</p>
    {/if}

    {#if editing && editSession}
      <RepositoryTextEditor
        session={editSession}
        name={parts.name}
        writeLocked={disabled}
        line={editLine}
        lineSerial={editLineSerial}
        returnLabel={showReturn ? editReturn?.label ?? null : null}
        onReturn={() => editReturn?.run()}
        onInput={(next) => path && editor.input(opened.summary.path, path, next)}
        onSave={() => void saveEdit()}
        onRevert={() => path && editor.revert(opened.summary.path, path)}
        onReload={reloadEdit}
        onExit={stopEdit}
      />
    {:else if isMarkdown && documentMode === "preview" && path}
      <!-- 普通打开 Markdown 默认进排版预览；源码仍是同一个工作区版本，切换不离开这个文件。 -->
      <DocumentReader
        {active}
        repository={opened.summary.path}
        source={documentSource}
        {generation}
        {nextId}
        {onGeneration}
        session={documentSession}
        contentVersion={contentVersion}
        onMode={setDocumentMode}
        onFollow={followWorktreeLink}
        header={false}
        bind:outlineOpen
        onHeadings={(count) => (headingCount = count)}
        onSize={(size) => (documentSize = size)}
      />
    {:else if error}
      <div class="file-state" role="alert">
        <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
        <strong>{stateTitle()}</strong>
        <p>{error}</p>
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => void read(path, 0, false, generation)}>重新读取</button>
      </div>
    {:else if loading}
      <div class="file-skeleton" role="status" aria-label="正在读取文件">
        {#each [38, 64, 52, 0, 71, 45, 58, 30] as width, index (index)}
          <span class="sk-line"><span class="sk-ln"></span>{#if width}<span class="sk-code" style={`width:${width}%`}></span>{/if}</span>
        {/each}
      </div>
    {:else if showImage && previewSources}
      <BinaryPreview
        sources={previewSources}
        generation={content?.generation ?? generation}
        {disabled}
        onGeneration={onGeneration}
      />
    {:else if content && content.kind !== "text"}
      <div class="file-state" role="status">
        <span class="empty-icon"><Icon name={content.kind === "missing" ? "alert-circle" : "file"} size={22} /></span>
        <strong>{stateTitle()}</strong>
        <p>{content.message ?? "这个文件没有可显示的文本内容。"}</p>
      </div>
    {:else if content}
      {#if content.truncated && content.message}
        <p class="file-note" role="status">{content.message}</p>
      {/if}
      {#if pageOffset > 0}
        <div class="file-note" role="status">
          <Icon name="info" size={13} />
          <span>正在显示第 {pageOffset + 1} 行起的内容</span>
          <button type="button" class="link-btn" onclick={() => void read(path, 0, false, generation)}>回到开头</button>
        </div>
      {/if}
      {#if wrap}
        <div class="file-code-wrap" class:select-all={allSelected} role="textbox" aria-readonly="true" aria-multiline="true" aria-label={`${parts.name} 内容`} tabindex="0">
          {#each lines as line, index (index)}
            {@const no = pageOffset + index + 1}
            <div class="file-wrap-line" class:hit={hitLine === no} data-file-line={no}>
              <span class="ln" aria-hidden="true">{no}</span>
              <span class="code">{#each segmentsAt(index) as seg, i (i)}{#if !seg.k}{seg.t}{:else}<span class={seg.k}>{seg.t}</span>{/if}{/each}</span>
            </div>
          {/each}
        </div>
      {:else}
        <div
          class="diff-scroll file-code"
          class:select-all={allSelected}
          role="textbox"
          aria-readonly="true"
          aria-multiline="true"
          aria-label={`${parts.name} 内容`}
          tabindex="0"
          bind:this={scroller}
          onscroll={onCodeScroll}
          bind:clientHeight={viewport}
        >
          <div class="virtual-space" style={`height:${lines.length * ROW_HEIGHT}px`}>
            <div class="code-ruler" aria-hidden="true">{#each ruler as line, i (i)}<span data-text={line.text} style={rulerPadding(line)}></span>{/each}</div>
            <div class="code-stage">
              {#each lines.slice(range.start, range.end) as line, index (`${pageOffset}-${range.start + index}`)}
                {@const absolute = range.start + index}
                {@const no = pageOffset + absolute + 1}
                <div
                  class="diff-line file-line"
                  class:hit={hitLine === no}
                  data-file-line={no}
                  style={`top:${absolute * ROW_HEIGHT}px;height:${ROW_HEIGHT}px`}
                >
                  <span class="ln" aria-hidden="true">{no}</span>
                  <span class="code"><span class="code-in" data-len={line.length || 1}>{#each segmentsAt(absolute) as seg, i (i)}{#if !seg.k}{seg.t}{:else}<span class={seg.k}>{seg.t}</span>{/if}{/each}</span></span>
                </div>
              {/each}
            </div>
          </div>
        </div>
      {/if}
      {#if hasMore}
        <div class="file-more">
          {#if loadingMore}<span class="spinner" aria-hidden="true"></span>{/if}
          <button type="button" class="link-btn" title={loadingMore ? "正在读取下一页" : "继续读取后面的内容"} disabled={loadingMore} onclick={() => void loadMore()}>
            {loadingMore ? "正在读取…" : `继续读取后续内容（已显示 ${lines.length} 行）`}
          </button>
        </div>
      {/if}
    {:else}
      <div class="file-state"><strong>选择左侧的一个文件</strong><p>查看模式只读，不会改动工作区。</p></div>
    {/if}

    {#if editing}
      <!-- 编辑器自带状态栏：未保存/已保存、行尾与编码都在它的工具条上。 -->
    {:else if isMarkdown && documentMode === "preview"}
      <footer class="file-status" aria-label="文件信息">
        <!-- 与阅读器的来源标识一致：排版预览看的是工作区当前内容，不是某个历史版本。 -->
        <span class="file-status-item doc-source" title={`来源：${documentSourceLabel(documentSource)}`}>
          <Icon name="eye" size={12} />{documentSourceLabel(documentSource)}
        </span>
        <span class="file-status-item doc-path" title={path}>{path}</span>
        <span class="file-status-item" class:changed={Boolean(mark)}>
          {#if mark}
            <span class={`tree-dot ${mark.tone}`} aria-hidden="true"></span>{mark.label}{hasStaged && hasUnstaged ? " · 部分已暂存" : hasStaged ? " · 已暂存" : ""}
          {:else}
            无本地改动
          {/if}
        </span>
        <span class="spacer"></span>
        {#if documentSize != null}<span class="file-status-item" title={`${documentSize} 字节`}>{formatBytes(documentSize)}</span>{/if}
        <span class="file-status-item" title="查看模式只读，不会改动工作区；切到「编辑」才会修改这个文件"><Icon name="eye" size={12} />只读</span>
      </footer>
    {:else if content && !error && !loading}
      <footer class="file-status" aria-label="文件信息">
        <span class="file-status-item" class:changed={Boolean(mark)}>
          {#if copied}
            <Icon name="check" size={12} />已复制路径
          {:else if mark}
            <span class={`tree-dot ${mark.tone}`} aria-hidden="true"></span>{mark.label}{hasStaged && hasUnstaged ? " · 部分已暂存" : hasStaged ? " · 已暂存" : ""}
          {:else}
            无本地改动
          {/if}
        </span>
        {#if content.kind === "text"}
          <span class="file-status-item">
            {#if pageOffset > 0 || hasMore}
              第 {pageOffset + 1}–{pageOffset + lines.length} 行{hasMore ? " · 还有更多" : ""}
            {:else}
              {lines.length} 行
            {/if}
          </span>
        {/if}
        <span class="spacer"></span>
        {#if content.kind === "text"}
          <LanguagePicker path={path} />
        {:else}
          <span class="lang-chip off" title="这类文件不按代码着色"><Icon name="code" size={12} /><span>{languageLabel}</span></span>
        {/if}
        {#if content.size != null}<span class="file-status-item" title={`${content.size} 字节`}>{formatBytes(content.size)}</span>{/if}
        <span class="file-status-item" title="查看模式只读，不会改动工作区；切到「编辑」才会修改这个文件"><Icon name="eye" size={12} />只读</span>
      </footer>
    {/if}
  {:else if missingPath}
    <div class="file-state" role="status">
      <span class="empty-icon err"><Icon name="trash" size={22} /></span>
      <strong>文件已删除</strong>
      <p><code>{missingPath}</code> 已不在工作区里，可以从改动或历史查看旧版本。</p>
      <div class="file-state-actions">
        {#if onOpenDiff && deletedChange && deletedChange.unstaged !== "none"}
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => onOpenDiff?.(missingPath, "unstaged")}>
            查看未暂存的改动
          </button>
        {/if}
        {#if onOpenDiff && deletedChange && deletedChange.staged !== "none"}
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => onOpenDiff?.(missingPath, "staged")}>
            查看已暂存的改动
          </button>
        {/if}
        {#if onFileHistory}
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => onFileHistory?.(missingPath)}>
            查看文件历史
          </button>
        {/if}
      </div>
    </div>
  {:else}
    <div class="file-welcome">
      <span class="empty-icon"><Icon name="folder-open" size={22} /></span>
      <strong>选择一个文件开始浏览</strong>
      <p>在左侧目录树中点选文件，或直接按路径打开。</p>
      <ul class="file-welcome-keys">
        <li><span>按路径打开</span><kbd>{MODIFIER_LABEL} P</kbd></li>
        <li><span>筛选文件树</span><kbd>{MODIFIER_LABEL} F</kbd></li>
        <li><span>后退 / 前进</span><kbd>{MODIFIER_LABEL} ⇧ ← →</kbd></li>
      </ul>
      {#if recentFiles.length > 0 && nav?.history}
        <section class="file-recent" aria-label="最近打开">
          <h3>最近打开</h3>
          {#each recentFiles as visit (visit.path)}
            {@const recentParts = splitPath(visit.path)}
            <button type="button" class="file-recent-item" title={visit.path} onclick={() => nav?.history?.onOpen(visit.path, visit.line)}>
              <span class={`tree-icon ft-${fileTone(visit.path)}`}><Icon name="file" size={14} /></span>
              <span class="search-name">{recentParts.name}</span>
              {#if recentParts.dir}<span class="search-dir">{recentParts.dir}</span>{/if}
            </button>
          {/each}
        </section>
      {/if}
    </div>
  {/if}
</div>

{#if menu}
  <ContextMenu request={menu} onClose={closeMenu} />
{/if}
