<script module lang="ts">
  import type { RepositoryEntryKind } from "../types";

  /** 文件操作表单的纯校验：组件与测试共用同一份规则，不依赖 DOM。 */

  const INVALID_NAME = "名称里不能包含路径分隔符，目录请在目标路径里指定。";

  /** 路径里的空层级、. 与 .. 都会被后端拒绝；在这里先就地说明，避免一次无效写入。 */
  function invalidSegment(segment: string): string | null {
    if (segment === "") return "路径中不能有空层级：不要以 / 开头或结尾，也不要出现 //。";
    if (segment === "." || segment === "..") return "路径里不能包含 . 或 ..，只能用仓库内的相对路径。";
    if (segment === ".git") return "不能操作 .git 目录里的内容。";
    return null;
  }

  function hasControlChars(text: string): boolean {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
  }

  /** 新建表单只接受单个名称：路径分隔符、. / .. 与控制字符都不行。 */
  export function validateEntryName(name: string): string | null {
    const value = name.trim();
    if (!value) return "先填写名称。";
    if (value.includes("/") || value.includes("\\")) return INVALID_NAME;
    if (value === "." || value === "..") return "名称不能是 . 或 ..。";
    if (value === ".git") return "不能新建 .git。";
    if (hasControlChars(value)) return "名称里不能包含控制字符。";
    if (value.length > 255) return "名称过长，请改用更短的名称。";
    return null;
  }

  /** 复制与移动的目标是仓库相对路径：必须是仓库内的新路径，不能为空或越出仓库。 */
  export function validateEntryPath(path: string): string | null {
    const value = path.trim();
    if (!value) return "先填写目标路径。";
    if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\")) {
      return "只接受仓库内的相对路径，不能使用绝对路径。";
    }
    if (value.includes("\\")) return "请用 / 分隔路径层级。";
    if (hasControlChars(value)) return "路径里不能包含控制字符。";
    for (const segment of value.split("/")) {
      const problem = invalidSegment(segment);
      if (problem) return problem;
    }
    return null;
  }

  export function parentDirectory(path: string): string {
    return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  }

  export function joinRelative(directory: string, name: string): string {
    return directory ? `${directory}/${name}` : name;
  }

  /** 复制默认目标：同目录下的「原名-副本」，文件保留扩展名。 */
  export function suggestCopyPath(source: string, kind: RepositoryEntryKind): string {
    const directory = parentDirectory(source);
    const name = directory ? source.slice(directory.length + 1) : source;
    if (kind === "directory") return joinRelative(directory, `${name}-副本`);
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    return joinRelative(directory, `${base}-副本${extension}`);
  }

  /** 移动/重命名不能把目录挪进它自己或它的后代里。 */
  export function insideItself(source: string, target: string): boolean {
    return target.startsWith(`${source}/`);
  }

  export interface EntryTarget {
    path: string;
    kind: RepositoryEntryKind;
  }
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { BUSY_REASON } from "../ui";
  import type { FileEntryAction, FileEntryRequest, FileEntryResult } from "../types";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  /**
   * 结构操作的表单与确认：
   * - 新建用单个名称，单项复制/移动用目标路径，批量复制/移动用目标目录并保留名称，删除只做影响确认；
   * - 校验、错误与输入都留在本地，失败不关闭表单，也不清空已填内容；批量在首个失败处停下并报告进度；
   * - 写入在途时锁住关闭与提交，避免同一次操作被重复发送；
   * - 删除只有一个入口：确认框里勾选「移到系统回收站」（默认勾选）决定落点，不另设快捷键；
   * - 多选删除交给外壳一次提交（几千个文件也只取一次写锁），这里只负责确认与报告。
   * 真正的命令调用、草稿检查与状态应用都由外壳负责。
   */
  interface Props {
    action: FileEntryAction;
    /** 右键目标：新建时是所在目录或其中一个文件，复制/移动/删除时是源路径。 */
    path: string;
    kind: RepositoryEntryKind;
    /** 多选复制/移动/删除：目标输入是存放这些项目的目录，名称保持不变。 */
    entries?: EntryTarget[];
    /** 只对删除有意义：多选时外壳把这些路径一次提交，而不是逐项等待。 */
    batchSources?: string[];
    /** 写入或读取在途：整个表单不可提交。 */
    disabled: boolean;
    /** 该仓库里未保存草稿的路径：移动或删除会改变它们的位置，必须先处理。 */
    draftPaths?: string[];
    onClose: () => void;
    /** 第二个参数只在多选删除时出现：整批路径一次交给外壳。 */
    onSubmit: (request: FileEntryRequest, batchSources?: string[]) => Promise<FileEntryResult>;
  }

  let { action, path, kind, entries = [], batchSources = [], disabled, draftPaths = [], onClose, onSubmit }: Props = $props();

  const creating = $derived(action === "createFile" || action === "createDirectory");
  const deleting = $derived(action === "delete");
  const batch = $derived(entries.length > 1);
  const batchTotal = $derived(batchSources.length > 0 ? batchSources.length : entries.length);
  /** 默认进回收站：勾选是"安全"的一侧，取消勾选才变成不可恢复的永久删除。 */
  let recycle = $state(true);
  const permanent = $derived(deleting && !recycle);
  const sources = $derived(entries.length > 0 ? entries : [{ path, kind }]);
  /**
   * 清单最多逐行渲染这么多条：几千个条目只列出前面一小段，其余按数量汇总，
   * 否则确认框会一次铺开几千行 DOM，打开就要卡住。
   */
  const LIST_LIMIT = 8;
  const listed = $derived(sources.slice(0, LIST_LIMIT));
  const hiddenCount = $derived(batchTotal - listed.length);
  /**
   * 新建的实际类型只由动作决定：目录行上的「新建文件」是文件，行的 kind 只用来决定
   * 新建位置与复制/移动/删除的目标类型，不能反过来改写新建要建什么。
   */
  const newKind: "file" | "directory" = $derived(
    action === "createFile"
      ? "file"
      : action === "createDirectory"
        ? "directory"
        : kind === "directory"
          ? "directory"
          : "file",
  );
  /** 新建的所在目录：目录行本身，或文件所在的父目录。 */
  const directory = $derived(kind === "directory" ? path : parentDirectory(path));

  let name = $state("");
  /* 打开时按动作给一次默认值：之后输入由用户掌握，组件重建才重新取默认。 */
  let target = $state(
    untrack(() => (action === "copy" ? suggestCopyPath(path, kind) : action === "move" ? path : "")),
  );
  let error = $state<string | null>(null);
  let busy = $state(false);
  /** 用户已经动过表单或提交过一次：这时才把校验结果铺开，打开即红字会显得已经出错。 */
  let touched = $state(false);

  /** 会被移动或删除影响到的未保存草稿：文件本身或目录后代。 */
  const affectedDrafts = $derived(
    creating || action === "copy"
      ? []
      : (draftPaths ?? []).filter((draft) => sources.some((entry) => draft === entry.path || draft.startsWith(`${entry.path}/`))),
  );

  const title = $derived(
    action === "createFile"
      ? "新建文件"
      : action === "createDirectory"
        ? "新建目录"
        : batch
          ? `${action === "copy" ? "复制" : action === "move" ? "移动" : "删除"} ${batchTotal} 个项目`
          : action === "copy"
            ? "复制"
            : action === "move"
              ? "移动或重命名"
              : "删除",
  );

  const preview = $derived.by(() => {
    if (action === "createFile" || action === "createDirectory") {
      const value = name.trim();
      return value ? joinRelative(directory, value) : "";
    }
    if (batch) return `${sources.length} 个项目 → ${target.trim() || "仓库根目录"}`;
    return target.trim();
  });

  function fieldProblem(): string | null {
    if (action === "createFile" || action === "createDirectory") return validateEntryName(name);
    if (action === "copy" || action === "move") {
      const value = target.trim();
      if (batch) {
        if (value) {
          const problem = validateEntryPath(value);
          if (problem) return problem;
        }
        const names = sources.map((entry) => entry.path.split("/").pop() ?? entry.path);
        if (new Set(names).size !== names.length) return "所选项目里有同名条目，无法放进同一个目录；请分批操作。";
        for (const entry of sources) {
          const destination = joinRelative(value, entry.path.split("/").pop() ?? entry.path);
          if (destination === entry.path) return `${entry.path} 已经在这个目录里。`;
          if (action === "move" && entry.kind === "directory" && (value === entry.path || insideItself(entry.path, value))) {
            return `不能把 ${entry.path} 移动到它自己或它的子目录里。`;
          }
        }
        return null;
      }
      const problem = validateEntryPath(target);
      if (problem) return problem;
      if (value === path) return action === "copy" ? "复制目标不能与源路径相同。" : "移动目标不能与源路径相同；只改名称时请修改路径的最后一段。";
      if (action === "move" && insideItself(path, value)) return "不能把目录移动到它自己或它的子目录里。";
      return null;
    }
    return null;
  }

  const problem = $derived(fieldProblem());
  /** 一打开就显示「先填写名称」只会制造噪声：输入非空或提交过一次之后再显示。 */
  const visibleProblem = $derived(
    problem && (touched || (creating ? name.trim() : target.trim()) !== "") ? problem : null,
  );

  function requests(): FileEntryRequest[] {
    const value = name.trim();
    if (batch) {
      return sources.map((entry) => ({
        action,
        source: entry.path,
        target: deleting ? "" : joinRelative(target.trim(), entry.path.split("/").pop() ?? entry.path),
        kind: entry.kind === "directory" ? "directory" : "file",
      }));
    }
    const source = creating ? "" : path;
    const destination = creating ? joinRelative(directory, value) : target.trim();
    return [{
      action,
      source,
      target: deleting ? "" : destination,
      kind: newKind,
      // 回收站是默认；只有明确取消勾选才把永久删除写进请求，避免调用方误改默认行为。
      ...(deleting && permanent ? { permanent: true } : {}),
    }];
  }

  async function submit(): Promise<void> {
    if (busy || disabled) return;
    touched = true;
    if (!deleting && problem) {
      error = problem;
      return;
    }
    busy = true;
    error = null;
    try {
      // 多选删除一次提交整批路径：外壳据此发一条命令，后端一次取锁、一次刷新。
      if (deleting && batchSources.length > 1) {
        const head: FileEntryRequest = {
          action,
          source: batchSources[0] ?? path,
          target: "",
          kind: newKind,
          ...(permanent ? { permanent: true } : {}),
        };
        const result = await onSubmit(head, batchSources);
        if (!result.ok) {
          error = result.message || "部分条目没有完成。";
          return;
        }
        onClose();
        return;
      }
      const pending = requests();
      for (const [index, item] of pending.entries()) {
        const result = await onSubmit(item);
        if (!result.ok) {
          const progress = batch && index > 0 ? `已完成 ${index} 项，其余 ${pending.length - index} 项未处理。` : "";
          error = `${batch ? `${item.source}：` : ""}${result.message || "操作没有完成。"}${progress}`;
          return;
        }
      }
      onClose();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "操作没有完成。";
    } finally {
      busy = false;
    }
  }

  const blockedByDrafts = $derived(
    affectedDrafts.length > 0
      ? `有未保存的草稿：${affectedDrafts.join("、")}。先回到编辑器保存或放弃草稿，再${deleting ? "删除" : "移动或重命名"}。`
      : null,
  );
</script>

{#if deleting}
  <ConfirmDialog
    {title}
    titleId="entry-delete-title"
    icon="trash"
    tone="danger"
    size="sm"
    impact="entry-delete"
    message={permanent
      ? `将永久删除${batch ? `选中的 ${batchTotal} 个项目` : ` ${path}`}。此操作无法撤销，也不会经过系统回收站。`
      : `将${batch ? `选中的 ${batchTotal} 个项目` : ` ${path}`}移入系统回收站。这个动作只改变工作区，不会暂存、提交或推送。`}
    targets={listed.map((entry) => ({
      icon: entry.kind === "directory" ? "folder" : "file",
      name: entry.path,
      detail: entry.kind === "directory"
        ? permanent ? "目录及其全部内容会被永久删除。" : "目录及其内容会一起移入回收站。"
        : permanent ? "文件会被永久删除，无法从回收站恢复。" : "文件会整体移入回收站。",
    }))}
    notes={[
      // 回收站那条不再重复：落点选项下面已经写了"可以稍后从系统回收站恢复"。
      ...(permanent
        ? [{ tone: "warn" as const, text: "永久删除不会暂存、提交或推送；Git 历史中已有的版本不受影响，但当前工作区内容无法由本应用恢复。" }]
        : []),
      ...(affectedDrafts.length > 0
        ? [{ tone: "warn" as const, text: blockedByDrafts ?? "" }]
        : []),
    ]}
    confirmLabel={busy
      ? permanent ? "正在永久删除" : "正在移入回收站"
      : permanent
        ? batch ? `永久删除 ${batchTotal} 个项目` : "永久删除"
        : batch ? `删除 ${batchTotal} 个项目` : "移到回收站"}
    confirmIcon="trash"
    confirmBlocked={blockedByDrafts ?? (disabled ? BUSY_REASON : null)}
    focus="cancel"
    {busy}
    {error}
    onConfirm={() => void submit()}
    onCancel={onClose}
  >
    {#if hiddenCount > 0}
      <p class="entry-batch-more">另有 {hiddenCount} 个项目，确认后会一并处理。</p>
    {/if}
    <!-- 落点选项：默认勾选，回车仍落在「取消」上；取消勾选立刻变成不可恢复的永久删除。
         这一项是"安全"的默认值，不能套用危险选项的红色底。 -->
    <label class="confirm-option entry-recycle" class:recycle-off={permanent}>
      <input
        type="checkbox"
        class="checkbox"
        data-entry-recycle
        bind:checked={recycle}
        disabled={busy || Boolean(blockedByDrafts)}
        title={busy ? BUSY_REASON : blockedByDrafts ? "目标还有未保存的草稿，确认操作已停用" : "取消勾选后删除不经过回收站，无法恢复"}
        onchange={() => (error = null)}
      />
      <span>
        移到系统回收站
        <small>{permanent ? "未勾选：删除后无法恢复" : "可以稍后从系统回收站恢复"}</small>
      </span>
    </label>
  </ConfirmDialog>
{:else}
  <Modal
    {title}
    titleId="entry-form-title"
    icon={action === "copy" ? "copy" : action === "move" ? "pencil" : newKind === "directory" ? "folder-plus" : "file"}
    tone="default"
    size="sm"
    description={creating
      ? `在 ${directory || "仓库根目录"} 下新建${newKind === "directory" ? "空目录" : "空文件"}。只写工作区，不暂存、不提交。`
      : batch
        ? `把选中的 ${sources.length} 个项目${action === "copy" ? "复制" : "移动"}到同一目录，保留各自名称。已有目标不会被覆盖。`
        : action === "copy"
          ? `把 ${path} 复制到仓库内的另一个路径。已有目标不会被覆盖。`
          : `把 ${path} 移动或重命名；只改最后一段就是重命名。已有目标不会被覆盖。`}
    locked={busy || disabled}
    onClose={onClose}
  >
    <form
      class="entry-form"
      data-entry-form={action}
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {#if creating}
        <label class="label" for="entry-name">名称</label>
        <input
          id="entry-name"
          class="input"
          data-entry-input="name"
          data-autofocus
          autocomplete="off"
          spellcheck="false"
          readonly={busy || disabled}
          bind:value={name}
          oninput={() => {
            touched = true;
            error = null;
          }}
          placeholder={newKind === "directory" ? "例如 components" : "例如 notes.md"}
          aria-invalid={visibleProblem ? "true" : undefined}
          aria-describedby={visibleProblem ? "entry-problem" : undefined}
        />
      {:else}
        {#if batch}
          <ul class="entry-batch-sources" aria-label="所选项目">
            {#each sources.slice(0, 4) as entry (entry.path)}
              <li><Icon name={entry.kind === "directory" ? "folder" : "file"} size={13} /><code>{entry.path}</code></li>
            {/each}
            {#if sources.length > 4}<li class="entry-batch-more">另有 {sources.length - 4} 个项目</li>{/if}
          </ul>
        {:else}
          <p class="entry-source">源路径：<code>{path}</code></p>
        {/if}
        <label class="label" for="entry-target">{batch ? "目标目录（留空为仓库根目录）" : "目标路径（仓库相对）"}</label>
        <input
          id="entry-target"
          class="input"
          data-entry-input="target"
          data-autofocus
          autocomplete="off"
          spellcheck="false"
          readonly={busy || disabled}
          bind:value={target}
          oninput={() => {
            touched = true;
            error = null;
          }}
          placeholder={batch ? "例如 archive" : undefined}
          aria-invalid={visibleProblem ? "true" : undefined}
          aria-describedby={visibleProblem ? "entry-problem" : undefined}
        />
      {/if}
      {#if preview}
        <p class="entry-preview" data-entry-preview>目标：<code>{preview}</code></p>
      {/if}
      {#if visibleProblem}
        <p class="hint danger" id="entry-problem" data-entry-problem>{visibleProblem}</p>
      {/if}
      {#if blockedByDrafts}
        <p class="hint danger" data-entry-drafts>{blockedByDrafts}</p>
      {/if}
      {#if error}
        <div class="callout error" role="alert" data-entry-error><Icon name="alert-circle" size={15} /><span>{error}</span></div>
      {/if}
      <div class="create-form-actions">
        <button type="button" class="btn btn-secondary" disabled={busy} title={busy ? BUSY_REASON : undefined} onclick={onClose}>取消</button>
        <!-- 校验未通过时不禁用提交：点一次就能看到具体原因，而不是面对一个点不动的按钮。 -->
        <button
          type="submit"
          class="btn btn-primary"
          data-entry-submit
          disabled={busy || disabled}
          aria-busy={busy}
          title={disabled ? BUSY_REASON : undefined}
        >
          {#if busy}<span class="spinner"></span>{:else}<Icon name={action === "copy" ? "copy" : action === "move" ? "pencil" : "plus"} size={14} />{/if}
          {action === "copy" ? "复制" : action === "move" ? "移动" : "新建"}
        </button>
      </div>
    </form>
  </Modal>
{/if}
