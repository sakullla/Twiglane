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
   * - 新建用单个名称，复制/移动用仓库相对目标路径，删除只做影响确认；
   * - 校验、错误与输入都留在本地，失败不关闭表单，也不清空已填内容；
   * - 写入在途时锁住关闭与提交，避免同一次操作被重复发送；
   * - 删除确认明确说明进入系统回收站，不做永久删除。
   * 真正的命令调用、草稿检查与状态应用都由外壳负责。
   */
  interface Props {
    action: FileEntryAction;
    /** 右键目标：新建时是所在目录或其中一个文件，复制/移动/删除时是源路径。 */
    path: string;
    kind: RepositoryEntryKind;
    /** 写入或读取在途：整个表单不可提交。 */
    disabled: boolean;
    /** 该仓库里未保存草稿的路径：移动或删除会改变它们的位置，必须先处理。 */
    draftPaths?: string[];
    onClose: () => void;
    onSubmit: (request: FileEntryRequest) => Promise<FileEntryResult>;
  }

  let { action, path, kind, disabled, draftPaths = [], onClose, onSubmit }: Props = $props();

  const creating = $derived(action === "createFile" || action === "createDirectory");
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
      : (draftPaths ?? []).filter((draft) => draft === path || draft.startsWith(`${path}/`)),
  );

  const title = $derived(
    action === "createFile"
      ? "新建文件"
      : action === "createDirectory"
        ? "新建目录"
        : action === "copy"
          ? "复制"
          : action === "move"
            ? "移动或重命名"
            : "移到回收站",
  );

  const preview = $derived.by(() => {
    if (action === "createFile" || action === "createDirectory") {
      const value = name.trim();
      return value ? joinRelative(directory, value) : "";
    }
    return target.trim();
  });

  function fieldProblem(): string | null {
    if (action === "createFile" || action === "createDirectory") return validateEntryName(name);
    if (action === "copy" || action === "move") {
      const problem = validateEntryPath(target);
      if (problem) return problem;
      const value = target.trim();
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

  function request(): FileEntryRequest {
    const value = name.trim();
    const source = creating ? "" : path;
    const destination = creating ? joinRelative(directory, value) : target.trim();
    return {
      action,
      source,
      target: action === "delete" ? "" : destination,
      kind: newKind,
    };
  }

  async function submit(): Promise<void> {
    if (busy || disabled) return;
    touched = true;
    if (action !== "delete" && problem) {
      error = problem;
      return;
    }
    busy = true;
    error = null;
    try {
      const result = await onSubmit(request());
      if (result.ok) {
        onClose();
        return;
      }
      // 失败保留原因与已填内容：用户改一处再提交，不用从头再来。
      error = result.message || "操作没有完成。";
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "操作没有完成。";
    } finally {
      busy = false;
    }
  }

  const blockedByDrafts = $derived(
    affectedDrafts.length > 0
      ? `有未保存的草稿：${affectedDrafts.join("、")}。先回到编辑器保存或放弃草稿，再${action === "delete" ? "删除" : "移动或重命名"}。`
      : null,
  );
</script>

{#if action === "delete"}
  <ConfirmDialog
    title="移到回收站"
    titleId="entry-delete-title"
    icon="trash"
    tone="danger"
    size="sm"
    impact="entry-delete"
    message={`将 ${path} 移入系统回收站。这个动作只改变工作区，不会暂存、提交或推送，也不会永久删除。`}
    targets={[{ icon: kind === "directory" ? "folder" : "file", name: path, detail: kind === "directory" ? "目录及其内容会一起移入回收站。" : "文件会整体移入回收站。" }]}
    notes={[
      { tone: "info", text: "回收站里的内容可以稍后从系统回收站恢复；本应用不提供永久删除。" },
      ...(affectedDrafts.length > 0
        ? [{ tone: "warn" as const, text: blockedByDrafts ?? "" }]
        : []),
    ]}
    confirmLabel={busy ? "正在移入回收站" : "移到回收站"}
    confirmIcon="trash"
    confirmBlocked={blockedByDrafts ?? (disabled ? BUSY_REASON : null)}
    {busy}
    {error}
    onConfirm={() => void submit()}
    onCancel={onClose}
  />
{:else}
  <Modal
    {title}
    titleId="entry-form-title"
    icon={action === "copy" ? "copy" : action === "move" ? "pencil" : newKind === "directory" ? "folder-plus" : "file"}
    tone="default"
    size="sm"
    description={creating
      ? `在 ${directory || "仓库根目录"} 下新建${newKind === "directory" ? "空目录" : "空文件"}。只写工作区，不暂存、不提交。`
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
        <p class="entry-source">源路径：<code>{path}</code></p>
        <label class="label" for="entry-target">目标路径（仓库相对）</label>
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
