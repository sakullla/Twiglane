<script lang="ts">
  import { tick, untrack } from "svelte";
  import { MODIFIER_LABEL } from "../brand";
  import {
    encodingLabel,
    isDirty,
    saveBlocker,
    type EditSession,
  } from "../file-editor.svelte";
  import { commentPrefix, cursorInfo, detectIndent, indentEdit, newlineEdit, toggleCommentEdit, type TextEdit } from "../editor-keys";
  import { expandReplacement, findMatches, firstEndingAfter, matchAtOrAfter, parseGoto, replaceAllEdit, type FindOptions } from "../editor-find";
  import { visibleRange } from "../layout";
  import { createHighlight } from "../syntax/highlight.svelte";
  import { lineSegments } from "../syntax/segments";
  import ContextMenu, { isContextKey, pointFor, type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";
  import { openModalCount } from "./Modal.svelte";

  /**
   * 轻量文本编辑：原生 textarea（浏览器自带撤销/重做、IME 与选择），不引入 IDE 框架，
   * 不提供运行、调试、终端、诊断或命令执行。只编辑当前工作区的这一个文件。
   *
   * - 保存只在用户明确点击或按 ⌘/Ctrl S 时发生，后端按 baseDigest 在写锁内复核；
   * - 外部修改与保存冲突都保留草稿，只给「复制草稿」「放弃草稿并重新读取」两条明确出路；
   * - 文本输入与组字中的按键不冒泡到工作台，背景的 Git 快捷键不会被触发。
   */
  interface Props {
    session: EditSession;
    /** 文件名（无障碍名称与提示用）。 */
    name: string;
    /** 语法高亮语言（Shiki id）；为空时按纯文本显示。 */
    language?: string | null;
    /** 写入或读取进行中：保存就地禁用并说明原因。 */
    writeLocked?: boolean;
    /** 打开时定位的行与序号：序号变化才重新定位。 */
    line?: number | null;
    lineSerial?: number;
    /** 定位方式：center 把目标行放到视口中部（从差异、查找进来）；top 放在顶部（从查看切过来，保持阅读位置）。 */
    lineAlign?: "center" | "top";
    /** 从差异进来时的返回入口。 */
    returnLabel?: string | null;
    onReturn?: () => void;
    onInput: (text: string) => void;
    onSave: () => void;
    onRevert: () => void;
    onReload: () => void;
    /** 不可编辑（只读原因）时回到查看。 */
    onExit: () => void;
  }

  let {
    session,
    name,
    language = null,
    writeLocked = false,
    line = null,
    lineSerial = 0,
    lineAlign = "center",
    returnLabel = null,
    onReturn,
    onInput,
    onSave,
    onRevert,
    onReload,
    onExit,
  }: Props = $props();

  /** 与 .text-editor-input 的 line-height 一致：行号栏按它虚拟化。 */
  const LINE_HEIGHT = 20;

  let textarea = $state<HTMLTextAreaElement | null>(null);
  let scrollTop = $state(0);
  let viewport = $state(0);
  let confirmRevert = $state(false);
  let copied = $state(false);
  let scrollLeft = $state(0);
  let caret = $state({ line: 1, column: 1, selected: 0 });
  let menu = $state<ContextMenuRequest | null>(null);
  /** Esc 之后的下一次 Tab 把焦点交还给页面，键盘用户不会被困在编辑框里。 */
  let tabFree = false;
  /** 输入法组字时 textarea 自己画候选文本，叠加层让位，避免两份文字错位叠在一起。 */
  let composing = $state(false);
  /** 高亮只是装饰：输入停顿后再重新分词，期间行文本变了的行按纯文本显示。 */
  let hlLines = $state<string[]>(untrack(() => session.draft.split("\n")));
  let hlTimer: ReturnType<typeof setTimeout> | undefined;
  const syntax = createHighlight(() => ({ lang: language, lines: hlLines }));
  let draftLines = $derived(session.draft.split("\n"));

  /* 查找 / 替换 / 跳行：只作用于这份草稿。 */
  const IS_MAC = MODIFIER_LABEL === "⌘";
  let findOpen = $state(false);
  let replaceOpen = $state(false);
  let findQuery = $state("");
  let replaceText = $state("");
  let findOptions = $state<FindOptions>({ caseSensitive: false, regex: false, wholeWord: false });
  /** 当前匹配 = 第一处起点不早于 anchor 的匹配；编辑后仍落在附近，不会跳回开头。 */
  let findAnchor = $state(0);
  let findInput = $state<HTMLInputElement | null>(null);
  let gotoOpen = $state(false);
  let gotoValue = $state("");
  let gotoInput = $state<HTMLInputElement | null>(null);
  let gotoError = $state<string | null>(null);
  let linesLayer = $state<HTMLDivElement | null>(null);

  let found = $derived(findOpen && findQuery ? findMatches(session.draft, findQuery, findOptions) : null);
  let matches = $derived(found?.matches ?? []);
  let currentMatch = $derived(matchAtOrAfter(matches, findAnchor));
  let lineStarts = $derived.by(() => {
    if (matches.length === 0) return [] as number[];
    const starts = [0];
    for (const text of draftLines) starts.push(starts[starts.length - 1] + text.length + 1);
    return starts;
  });
  let findStatus = $derived.by(() => {
    if (!findQuery) return "";
    if (found?.error) return "正则无效";
    if (matches.length === 0) return "没有匹配";
    const total = found?.truncated ? `${matches.length}+` : `${matches.length}`;
    return `${currentMatch + 1}/${total}`;
  });

  let dirty = $derived(isDirty(session));
  let blocker = $derived(saveBlocker(session, writeLocked));
  let lineCount = $derived(draftLines.length);
  let numbers = $derived(visibleRange(lineCount, scrollTop, viewport || 400, LINE_HEIGHT));
  let status = $derived.by(() => {
    if (session.saving) return "正在保存…";
    if (session.reloading) return "正在重新读取…";
    if (session.conflict) return "草稿与文件冲突";
    if (dirty) return "有未保存的修改";
    if (session.savedAt) return "已保存";
    return "未修改";
  });

  $effect(() => {
    const next = draftLines;
    untrack(() => {
      clearTimeout(hlTimer);
      hlTimer = setTimeout(() => (hlLines = next), hlLines.length <= 1 ? 0 : 160);
    });
    return () => clearTimeout(hlTimer);
  });

  /** 某一行上的匹配片段（文字透明，只画底色），没有匹配时为 null。 */
  function markParts(at: number): { t: string; k: string }[] | null {
    if (matches.length === 0 || lineStarts.length === 0) return null;
    const text = draftLines[at] ?? "";
    const start = lineStarts[at];
    const end = start + text.length;
    let index = firstEndingAfter(matches, start);
    if (index >= matches.length || matches[index].start > end) return null;
    const parts: { t: string; k: string }[] = [];
    let cursor = start;
    for (; index < matches.length && matches[index].start < end; index += 1) {
      const from = Math.max(matches[index].start, start);
      const to = Math.min(matches[index].end, end);
      if (from > cursor) parts.push({ t: text.slice(cursor - start, from - start), k: "" });
      if (to > from) parts.push({ t: text.slice(from - start, to - start), k: index === currentMatch ? "text-editor-hit current" : "text-editor-hit" });
      cursor = Math.max(cursor, to);
    }
    return parts.length > 0 ? parts : null;
  }

  /** 让 [start, end) 进入视口：纵向按行号算，横向按渲染出来的当前匹配位置算。 */
  async function revealRange(start: number, end: number): Promise<void> {
    const node = textarea;
    if (!node) return;
    node.setSelectionRange(start, end);
    syncCaret();
    const { line: row } = cursorInfo(node.value, start, start);
    const height = node.clientHeight || 400;
    const top = (row - 1) * LINE_HEIGHT;
    if (top < node.scrollTop || top + LINE_HEIGHT > node.scrollTop + height - LINE_HEIGHT) {
      node.scrollTop = Math.max(0, top - height / 2);
      scrollTop = node.scrollTop;
    }
    await tick();
    const mark = linesLayer?.querySelector<HTMLElement>(".text-editor-hit.current");
    if (!mark) return;
    const width = node.clientWidth || 600;
    const left = mark.offsetLeft;
    const right = left + mark.offsetWidth;
    if (left < node.scrollLeft || right > node.scrollLeft + width - 24) {
      node.scrollLeft = Math.max(0, left - width / 3);
      scrollLeft = node.scrollLeft;
    }
  }

  function selectionSeed(): string {
    const node = textarea;
    if (!node || node.selectionStart === node.selectionEnd) return "";
    const text = node.value.slice(node.selectionStart, node.selectionEnd);
    return text.includes("\n") || text.length > 200 ? "" : text;
  }

  async function openFind(withReplace: boolean): Promise<void> {
    gotoOpen = false;
    const seed = selectionSeed();
    if (seed) findQuery = seed;
    findAnchor = textarea ? Math.min(textarea.selectionStart, textarea.selectionEnd) : 0;
    findOpen = true;
    replaceOpen = withReplace || replaceOpen;
    await tick();
    findInput?.focus();
    findInput?.select();
  }

  function closeFind(): void {
    findOpen = false;
    const match = matches[currentMatch];
    textarea?.focus({ preventScroll: true });
    if (match && textarea) textarea.setSelectionRange(match.start, match.end);
    syncCaret();
  }

  function stepFind(delta: 1 | -1): void {
    if (matches.length === 0) return;
    const index = delta > 0 ? (currentMatch + 1) % matches.length : (currentMatch - 1 + matches.length) % matches.length;
    findAnchor = matches[index].start;
    void revealRange(matches[index].start, matches[index].end);
  }

  /** 改了查找词或选项：从光标处重新找起，并把当前那一处滚进视口。 */
  function refind(): void {
    void tick().then(() => {
      const match = matches[currentMatch];
      if (match) void revealRange(match.start, match.end);
    });
  }

  function replaceBlocked(): string | null {
    if (session.saving || session.reloading) return "正在保存或读取，暂时不能修改";
    if (found?.error) return found.error;
    if (matches.length === 0) return findQuery ? "没有可替换的匹配" : "先输入要查找的内容";
    return null;
  }

  /** 替换后把焦点还给替换框，连续按回车可以一处处替换下去。 */
  function keepFocus(run: () => void): void {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    run();
    if (active && active !== textarea && active.isConnected) active.focus({ preventScroll: true });
  }

  function replaceOne(): void {
    const node = textarea;
    const match = matches[currentMatch];
    if (!node || !match || replaceBlocked()) return;
    const text = expandReplacement(replaceText, match, node.value, findOptions.regex);
    keepFocus(() => applyEdit(node, { from: match.start, to: match.end, text, selStart: match.start + text.length, selEnd: match.start + text.length }));
    findAnchor = match.start + text.length;
    refind();
  }

  function replaceAll(): void {
    const node = textarea;
    if (!node || replaceBlocked()) return;
    const edit = replaceAllEdit(node.value, matches, replaceText, findOptions.regex);
    if (!edit) return;
    keepFocus(() => applyEdit(node, { ...edit, selStart: edit.from, selEnd: edit.from }));
    findAnchor = edit.from;
  }

  function toggleOption(key: keyof FindOptions): void {
    findOptions = { ...findOptions, [key]: !findOptions[key] };
    refind();
    findInput?.focus();
  }

  async function openGoto(): Promise<void> {
    findOpen = false;
    gotoOpen = true;
    gotoError = null;
    gotoValue = "";
    await tick();
    gotoInput?.focus();
  }

  function submitGoto(): void {
    const target = parseGoto(gotoValue);
    if (!target) {
      gotoError = "请输入行号，或「行:列」";
      return;
    }
    gotoOpen = false;
    gotoError = null;
    void revealLine(Math.min(target.line, lineCount), target.column);
  }

  function closeGoto(): void {
    gotoOpen = false;
    textarea?.focus({ preventScroll: true });
  }

  /** 编辑器里的查找类快捷键；在文本框和查找条里都生效。 */
  function findKey(event: KeyboardEvent): boolean {
    const mod = event.ctrlKey || event.metaKey;
    const code = event.code;
    const letter = event.key.toLowerCase();
    if (mod && !event.shiftKey && !event.altKey && (letter === "f" || code === "KeyF")) {
      void openFind(false);
      return true;
    }
    const replaceKey = IS_MAC
      ? event.metaKey && event.altKey && !event.shiftKey && code === "KeyF"
      : event.ctrlKey && !event.altKey && !event.shiftKey && (letter === "h" || code === "KeyH");
    if (replaceKey) {
      void openFind(true);
      return true;
    }
    if (mod && !event.shiftKey && !event.altKey && (letter === "g" || code === "KeyG")) {
      void openGoto();
      return true;
    }
    if (event.key === "F3" && !mod && !event.altKey && findOpen) {
      stepFind(event.shiftKey ? -1 : 1);
      return true;
    }
    return false;
  }

  function syncCaret(): void {
    const node = textarea;
    if (!node) return;
    caret = cursorInfo(node.value, node.selectionStart, node.selectionEnd);
  }

  /* 草稿干净了就收起「确认放弃」，避免下一次误点直接生效。 */
  $effect(() => {
    if (!dirty) confirmRevert = false;
  });

  /** 打开或定位到某一行：光标放到行首并让这一行出现在视口中部。 */
  async function revealLine(target: number, column = 1, align: "center" | "top" = "center"): Promise<void> {
    await tick();
    const node = textarea;
    if (!node) return;
    const text = node.value;
    let offset = 0;
    for (let current = 1; current < target; current += 1) {
      const next = text.indexOf("\n", offset);
      if (next < 0) break;
      offset = next + 1;
    }
    const lineEnd = text.indexOf("\n", offset);
    offset = Math.min(offset + column - 1, lineEnd < 0 ? text.length : lineEnd);
    node.focus({ preventScroll: true });
    node.setSelectionRange(offset, offset);
    syncCaret();
    const top = Math.max(0, (target - 1) * LINE_HEIGHT - (align === "top" ? 0 : (node.clientHeight || 400) / 2));
    node.scrollTop = top;
    scrollTop = top;
  }

  let lastSerial = -1;
  let lastPhase = "";
  $effect(() => {
    const serial = lineSerial;
    const target = line;
    const align = lineAlign;
    const phase = session.phase;
    const id = session.id;
    untrack(() => {
      // 首次可编辑或定位序号变化时才移动光标；输入、保存不会把光标拉回去。
      const key = `${id}:${phase}`;
      if (phase !== "ready") {
        lastPhase = key;
        return;
      }
      if (serial === lastSerial && key === lastPhase) return;
      const fresh = key !== lastPhase;
      lastSerial = serial;
      lastPhase = key;
      if (target && target > 0) void revealLine(target, 1, align);
      else if (fresh) void tick().then(() => textarea?.focus({ preventScroll: true }));
    });
  });

  function save(): void {
    // 确认层打开时背景不能写入：保存快捷键只作用于当前这一个编辑会话。
    if (openModalCount() > 0 || blocker) return;
    onSave();
  }

  /** 编辑器根节点：⌘/Ctrl S 保存；其余按键在文本框内消化，不交给工作台快捷键。 */
  function onKey(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) {
      // 输入法组字：回车、方向键与数字都属于候选，不能被任何外层快捷键接走。
      event.stopPropagation();
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (isContextKey(event) && event.target === textarea && textarea) {
      event.preventDefault();
      event.stopPropagation();
      openMenu(pointFor(textarea));
      return;
    }
    const inEditor = event.target instanceof HTMLElement && Boolean(event.target.closest("textarea, input"));
    if (inEditor && findKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape" && event.target === textarea && (findOpen || gotoOpen)) {
      event.preventDefault();
      event.stopPropagation();
      findOpen = false;
      gotoOpen = false;
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      save();
      return;
    }
    if (event.target === textarea && textarea) {
      event.stopPropagation();
      if (editKey(event, textarea)) return;
    } else if (inEditor) {
      // 查找条里的输入同样不交给工作台快捷键。
      event.stopPropagation();
    }
  }

  /** 用 execCommand 写回，浏览器的撤销栈才认；不支持时退回 setRangeText 并补发 input。 */
  function applyEdit(node: HTMLTextAreaElement, edit: TextEdit): void {
    node.focus({ preventScroll: true });
    node.setSelectionRange(edit.from, edit.to);
    let done = false;
    try {
      done = edit.text !== "" && document.execCommand("insertText", false, edit.text);
    } catch {
      done = false;
    }
    if (!done) {
      node.setRangeText(edit.text, edit.from, edit.to, "end");
      node.dispatchEvent(new Event("input", { bubbles: true }));
    }
    node.setSelectionRange(edit.selStart, edit.selEnd);
    syncCaret();
  }

  function editKey(event: KeyboardEvent, node: HTMLTextAreaElement): boolean {
    if (node.readOnly) return false;
    const mod = event.ctrlKey || event.metaKey;
    const { selectionStart: start, selectionEnd: end, value } = node;
    let edit: TextEdit | null = null;
    if (event.key === "Tab" && !mod && !event.altKey) {
      if (tabFree) {
        tabFree = false;
        return false;
      }
      edit = indentEdit(value, start, end, detectIndent(value), event.shiftKey);
      event.preventDefault();
      if (edit) applyEdit(node, edit);
      return true;
    }
    tabFree = event.key === "Escape";
    if (event.key === "Enter" && !mod && !event.altKey && !event.shiftKey) {
      edit = newlineEdit(value, start, end, detectIndent(value));
    } else if (mod && !event.altKey && !event.shiftKey && event.key === "/") {
      const prefix = commentPrefix(language);
      if (!prefix) return false;
      event.preventDefault();
      edit = toggleCommentEdit(value, start, end, prefix);
      if (edit) applyEdit(node, edit);
      return true;
    }
    if (!edit) return false;
    event.preventDefault();
    applyEdit(node, edit);
    return true;
  }

  function hasSelection(): boolean {
    return Boolean(textarea && textarea.selectionStart !== textarea.selectionEnd);
  }

  function exec(command: "undo" | "redo" | "copy" | "cut"): void {
    textarea?.focus({ preventScroll: true });
    try {
      document.execCommand(command);
    } catch {
      /* 宿主不支持时静默：快捷键仍然可用 */
    }
  }

  async function pasteText(): Promise<void> {
    const node = textarea;
    if (!node || node.readOnly) return;
    try {
      const text = (await navigator.clipboard.readText()).replace(/\r\n?/g, "\n");
      if (text) applyEdit(node, { from: node.selectionStart, to: node.selectionEnd, text, selStart: node.selectionStart + text.length, selEnd: node.selectionStart + text.length });
    } catch {
      /* 剪贴板被拒绝：保持原样，⌘/Ctrl V 仍可用 */
    }
  }

  function openMenu(point: { x: number; y: number }): void {
    const readOnly = Boolean(textarea?.readOnly);
    const selected = hasSelection();
    const noSelection = selected ? undefined : "没有选中的文本";
    const busy = readOnly ? "正在保存或读取，暂时不能修改" : undefined;
    const entries: ContextMenuEntry[] = [
      { id: "undo", label: "撤销", icon: "undo", shortcut: `${MODIFIER_LABEL} Z`, disabledReason: busy, run: () => exec("undo") },
      { id: "redo", label: "重做", shortcut: MODIFIER_LABEL === "⌘" ? "⌘ ⇧ Z" : "Ctrl Y", disabledReason: busy, run: () => exec("redo") },
      { separator: true },
      { id: "cut", label: "剪切", shortcut: `${MODIFIER_LABEL} X`, disabledReason: busy ?? noSelection, run: () => exec("cut") },
      { id: "copy", label: "复制", icon: "copy", shortcut: `${MODIFIER_LABEL} C`, disabledReason: noSelection, run: () => exec("copy") },
      { id: "paste", label: "粘贴", shortcut: `${MODIFIER_LABEL} V`, disabledReason: busy, run: () => void pasteText() },
      { separator: true },
      { id: "select-all", label: "全选", shortcut: `${MODIFIER_LABEL} A`, run: () => { textarea?.focus({ preventScroll: true }); textarea?.select(); syncCaret(); } },
    ];
    entries.push({ separator: true });
    entries.push({ id: "find", label: "查找", icon: "search", shortcut: `${MODIFIER_LABEL} F`, run: () => void openFind(false) });
    entries.push({ id: "replace", label: "替换", shortcut: IS_MAC ? "⌘ ⌥ F" : "Ctrl H", disabledReason: busy, run: () => void openFind(true) });
    entries.push({ id: "goto", label: "跳到行", icon: "arrow-right", shortcut: `${MODIFIER_LABEL} G`, run: () => void openGoto() });
    const prefix = commentPrefix(language);
    if (prefix) {
      entries.push({ separator: true });
      entries.push({
        id: "comment",
        label: "切换行注释",
        shortcut: `${MODIFIER_LABEL} /`,
        disabledReason: busy,
        run: () => {
          const node = textarea;
          if (!node) return;
          const edit = toggleCommentEdit(node.value, node.selectionStart, node.selectionEnd, prefix);
          if (edit) applyEdit(node, edit);
        },
      });
    }
    menu = { ...point, entries, label: "编辑菜单" };
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    openMenu({ x: event.clientX, y: event.clientY });
  }

  async function copyDraft(): Promise<void> {
    try {
      await navigator.clipboard.writeText(session.draft);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }

  function revert(): void {
    if (!confirmRevert) {
      confirmRevert = true;
      return;
    }
    confirmRevert = false;
    onRevert();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="text-editor" data-edit-phase={session.phase} onkeydown={onKey}>
  {#if menu}<ContextMenu request={menu} onClose={() => (menu = null)} />{/if}
  {#if session.phase === "loading"}
    <div class="file-state" role="status" aria-busy="true">
      <span class="empty-icon"><span class="spinner"></span></span>
      <strong>正在读取完整内容</strong>
      <p>编辑需要整份文件与内容摘要，读完后才能输入。</p>
    </div>
  {:else if session.phase === "failed"}
    <div class="file-state" role="alert">
      <span class="empty-icon err"><Icon name="alert-circle" size={22} /></span>
      <strong>无法进入编辑</strong>
      <p>{session.error ?? "无法读取这个文件的完整内容。"}</p>
      <div class="file-state-actions">
        <button type="button" class="btn btn-secondary btn-sm" title={session.reloading ? "正在重新读取" : "按文件当前内容再读一次"} disabled={session.reloading} onclick={onReload}>重新读取</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick={onExit}>回到查看</button>
      </div>
    </div>
  {:else if session.phase === "readonly"}
    <div class="file-state" role="status" data-edit-readonly>
      <span class="empty-icon"><Icon name="eye" size={22} /></span>
      <strong>这个文件保持只读</strong>
      <p>{session.error ?? "这个文件不能在这里编辑。"}</p>
      <div class="file-state-actions">
        <button type="button" class="btn btn-secondary btn-sm" onclick={onExit}>回到查看</button>
      </div>
    </div>
  {:else}
    <div class="text-editor-bar" role="toolbar" aria-label="编辑操作">
      <span
        class="text-editor-status"
        class:dirty
        class:conflict={Boolean(session.conflict)}
        role="status"
        data-edit-status
      >
        {#if session.saving || session.reloading}<span class="spinner" aria-hidden="true"></span>{:else}<span class="text-editor-dot" aria-hidden="true"></span>{/if}
        {status}
      </span>
      <span class="text-editor-meta" data-edit-caret title="光标所在的行与列">行 {caret.line}，列 {caret.column}{caret.selected > 0 ? `（选中 ${caret.selected}）` : ""}</span>
      <span class="text-editor-meta" title="保存时按原文件的行尾与编码写回，不改变其他文件">{encodingLabel(session.snapshot)}</span>
      <span class="spacer"></span>
      {#if returnLabel && onReturn}
        <button type="button" class="btn btn-ghost btn-sm" data-edit-return onclick={onReturn}>
          <Icon name="arrow-left" size={13} /><span>{returnLabel}</span>
        </button>
      {/if}
      {#if dirty}
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          class:btn-danger-soft={confirmRevert}
          aria-label={confirmRevert ? "确认放弃全部未保存的修改" : "放弃未保存的修改"}
          title={confirmRevert ? "再点一次：草稿恢复成读取时的内容，不写入文件" : "把草稿恢复成读取时的内容（需要再确认一次）"}
          disabled={session.saving}
          onclick={revert}
          onblur={() => (confirmRevert = false)}
        ><Icon name="undo" size={13} /><span>{confirmRevert ? "确认放弃" : "放弃修改"}</span></button>
      {/if}
      <button
        type="button"
        class="btn btn-primary btn-sm"
        data-edit-save
        aria-label="保存修改到工作区"
        aria-keyshortcuts={MODIFIER_LABEL === "⌘" ? "Meta+S" : "Control+S"}
        title={blocker ?? `只写入这个工作区文件，不暂存、不提交（${MODIFIER_LABEL} S）`}
        disabled={blocker !== null}
        onclick={save}
      >
        {#if session.saving}<span class="spinner" aria-hidden="true"></span>{:else}<Icon name="check" size={13} />{/if}<span>保存</span>
      </button>
    </div>
    {#if session.conflict}
      <div class="file-note danger text-editor-alert" role="alert" data-edit-conflict>
        <Icon name="alert" size={13} />
        <span>{session.conflict}</span>
        <button type="button" class="link-btn" onclick={() => void copyDraft()}>{copied ? "已复制草稿" : "复制草稿"}</button>
        <button
          type="button"
          class="link-btn"
          title="丢掉这里的草稿，按文件当前内容重新开始编辑"
          disabled={session.reloading}
          onclick={onReload}
        >放弃草稿并重新读取</button>
      </div>
    {:else if session.error}
      <div class="file-note danger text-editor-alert" role="alert" data-edit-error>
        <Icon name="alert-circle" size={13} />
        <span>{session.error}</span>
        <button type="button" class="link-btn" title={blocker ?? "用同一份草稿与基线再保存一次"} disabled={blocker !== null} onclick={save}>重试保存</button>
      </div>
    {/if}
    {#if findOpen}
      <div class="file-findbar text-editor-find" data-edit-find>
        <button
          type="button"
          class="icon-btn sm"
          aria-label={replaceOpen ? "收起替换" : "展开替换"}
          aria-expanded={replaceOpen}
          title={replaceOpen ? "收起替换" : `展开替换（${IS_MAC ? "⌘ ⌥ F" : "Ctrl H"}）`}
          onclick={() => (replaceOpen = !replaceOpen)}
        ><Icon name={replaceOpen ? "chevron-down" : "chevron-right"} size={14} /></button>
        <div class="text-editor-find-rows">
          <div class="text-editor-find-row">
            <div class="field sm">
              <Icon name="search" size={13} />
              <input
                bind:this={findInput}
                aria-label="在草稿中查找"
                placeholder="查找"
                autocomplete="off"
                spellcheck="false"
                bind:value={findQuery}
                oninput={refind}
                onkeydown={(event) => {
                  if (event.isComposing) return;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeFind();
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    stepFind(event.shiftKey ? -1 : 1);
                  }
                }}
              />
              <button type="button" class="text-editor-opt" class:on={findOptions.caseSensitive} aria-pressed={findOptions.caseSensitive} aria-label="区分大小写" title="区分大小写" onclick={() => toggleOption("caseSensitive")}>Aa</button>
              <button type="button" class="text-editor-opt" class:on={findOptions.wholeWord} aria-pressed={findOptions.wholeWord} aria-label="全字匹配" title="全字匹配" onclick={() => toggleOption("wholeWord")}><u>ab</u></button>
              <button type="button" class="text-editor-opt" class:on={findOptions.regex} aria-pressed={findOptions.regex} aria-label="使用正则表达式" title="使用正则表达式（替换可用 $1、$&）" onclick={() => toggleOption("regex")}>.*</button>
            </div>
            <span class="find-count" class:none={Boolean(findQuery) && matches.length === 0} role="status" title={found?.error ?? (found?.truncated ? "匹配过多，只列出前 10000 处" : undefined)}>{findStatus}</span>
            <button type="button" class="icon-btn sm" aria-label="上一处匹配" title="上一处（Shift Enter / Shift F3）" disabled={matches.length === 0} onclick={() => stepFind(-1)}><Icon name="chevron-up" size={14} /></button>
            <button type="button" class="icon-btn sm" aria-label="下一处匹配" title="下一处（Enter / F3）" disabled={matches.length === 0} onclick={() => stepFind(1)}><Icon name="chevron-down" size={14} /></button>
            <button type="button" class="icon-btn sm" aria-label="关闭查找" title="关闭（Esc）" onclick={closeFind}><Icon name="x" size={14} /></button>
          </div>
          {#if replaceOpen}
            <div class="text-editor-find-row">
              <div class="field sm">
                <input
                  aria-label="替换为"
                  placeholder="替换为"
                  autocomplete="off"
                  spellcheck="false"
                  bind:value={replaceText}
                  onkeydown={(event) => {
                    if (event.isComposing) return;
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      closeFind();
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      if (event.ctrlKey || event.metaKey) replaceAll();
                      else replaceOne();
                    }
                  }}
                />
              </div>
              <button type="button" class="btn btn-secondary btn-sm" title={replaceBlocked() ?? "替换当前这一处（Enter）"} disabled={replaceBlocked() !== null} onclick={replaceOne}>替换</button>
              <button type="button" class="btn btn-secondary btn-sm" title={replaceBlocked() ?? `全部替换，可一次撤销（${MODIFIER_LABEL} Enter）`} disabled={replaceBlocked() !== null} onclick={replaceAll}>全部替换</button>
            </div>
          {/if}
        </div>
      </div>
    {/if}
    {#if gotoOpen}
      <div class="file-findbar" data-edit-goto>
        <div class="field sm file-goto">
          <Icon name="arrow-right" size={13} />
          <input
            bind:this={gotoInput}
            aria-label="跳到行号"
            placeholder={`行号或 行:列（共 ${lineCount} 行）`}
            autocomplete="off"
            bind:value={gotoValue}
            oninput={() => (gotoError = null)}
            onkeydown={(event) => {
              if (event.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                submitGoto();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeGoto();
              }
            }}
          />
        </div>
        {#if gotoError}<span class="find-count none" role="alert">{gotoError}</span>{/if}
        <button type="button" class="btn btn-secondary btn-sm" title={gotoValue.trim() ? "跳到这一行（Enter）" : "先输入行号"} disabled={!gotoValue.trim()} onclick={submitGoto}>跳转</button>
        <button type="button" class="icon-btn sm" aria-label="关闭跳行" title="关闭（Esc）" onclick={closeGoto}><Icon name="x" size={14} /></button>
      </div>
    {/if}
    <div class="text-editor-body">
      <div class="text-editor-gutter" aria-hidden="true">
        <div class="text-editor-numbers" style={`transform:translateY(${numbers.start * LINE_HEIGHT - scrollTop}px)`}>
          {#each { length: numbers.end - numbers.start } as _, index (numbers.start + index)}
            <span class:current={numbers.start + index + 1 === caret.line}>{numbers.start + index + 1}</span>
          {/each}
        </div>
      </div>
      <div class="text-editor-stage" class:composing>
      <div class="text-editor-current" aria-hidden="true" style={`transform:translateY(${6 + (caret.line - 1) * LINE_HEIGHT - scrollTop}px)`}></div>
      {#if matches.length > 0}
        <div class="text-editor-highlight text-editor-marks" aria-hidden="true">
          <div class="text-editor-lines" bind:this={linesLayer} style={`transform:translate(${12 - scrollLeft}px, ${6 + numbers.start * LINE_HEIGHT - scrollTop}px)`}>
            {#each { length: numbers.end - numbers.start } as _, index (numbers.start + index)}
              {@const parts = markParts(numbers.start + index)}
              <div class="text-editor-line">{#if parts}{#each parts as part, slot (slot)}<span class={part.k || undefined}>{part.t}</span>{/each}{/if}</div>
            {/each}
          </div>
        </div>
      {/if}
      <div class="text-editor-highlight" aria-hidden="true">
        <div class="text-editor-lines" style={`transform:translate(${12 - scrollLeft}px, ${6 + numbers.start * LINE_HEIGHT - scrollTop}px)`}>
          {#each { length: numbers.end - numbers.start } as _, index (numbers.start + index)}
            {@const at = numbers.start + index}
            <div class="text-editor-line">{#each lineSegments(draftLines[at] ?? "", syntax.at(at)) as segment, part (part)}<span class={segment.k || undefined}>{segment.t}</span>{/each}</div>
          {/each}
        </div>
      </div>
      <textarea
        bind:this={textarea}
        class="text-editor-input"
        aria-label={`${name} 编辑内容`}
        aria-multiline="true"
        wrap="off"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        value={session.draft}
        readonly={session.saving || session.reloading}
        bind:clientHeight={viewport}
        oninput={(event) => onInput(event.currentTarget.value)}
        onscroll={(event) => {
          scrollTop = event.currentTarget.scrollTop;
          scrollLeft = event.currentTarget.scrollLeft;
        }}
        onselect={syncCaret}
        onkeyup={syncCaret}
        onclick={syncCaret}
        onfocus={syncCaret}
        onblur={() => (tabFree = false)}
        oncontextmenu={onContextMenu}
        oncompositionstart={() => (composing = true)}
        oncompositionend={() => (composing = false)}
      ></textarea>
      </div>
    </div>
  {/if}
</div>
