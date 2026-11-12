<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import { fileTone } from "../file-kind";
  import type { RepositoryDirectoryEntry } from "../types";
  import Icon from "./Icon.svelte";
  import Popover from "./Popover.svelte";

  /**
   * 面包屑的切换弹层：列出某个目录下的子目录与文件。选目录就地进入，选文件交给调用方打开；
   * 第一行是「上一级」（根目录除外）。只读目录，不改工作区。
   */
  interface Props {
    anchor: HTMLElement;
    /** 仓库根（opened.summary.path）。 */
    repository: string;
    /** 起始目录（仓库相对路径，根目录为空串）。 */
    directory: string;
    /** 打开时预选的条目（当前面包屑段或当前文件）。 */
    current: string | null;
    includeIgnored: boolean;
    generation: number;
    nextId: () => number;
    onGeneration: (generation: number) => void;
    onOpen: (path: string) => void;
    onClose: (refocus: boolean) => void;
  }

  let {
    anchor,
    repository,
    directory,
    current,
    includeIgnored,
    generation,
    nextId,
    onGeneration,
    onOpen,
    onClose,
  }: Props = $props();

  type Row =
    | { kind: "up"; path: string; name: string }
    | { kind: "directory" | "file"; path: string; name: string; ignored: boolean };

  let dir = $state(untrack(() => directory));
  let preselect = $state<string | null>(untrack(() => current));
  let entries = $state.raw<RepositoryDirectoryEntry[]>([]);
  let loading = $state(false);
  let failure = $state<string | null>(null);
  let query = $state("");
  let active = $state(0);
  let serial = 0;

  function parentOf(path: string): string {
    const at = path.lastIndexOf("/");
    return at === -1 ? "" : path.slice(0, at);
  }

  function nameOf(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  let rows = $derived.by<Row[]>(() => {
    const needle = query.trim().toLowerCase();
    const listed: Row[] = entries
      .filter((entry) => !needle || entry.name.toLowerCase().includes(needle))
      .map((entry) => ({
        kind: entry.kind === "directory" ? ("directory" as const) : ("file" as const),
        path: entry.path,
        name: entry.name,
        ignored: entry.ignored,
      }))
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === "directory" ? -1 : 1,
      );
    if (dir && !needle) return [{ kind: "up", path: parentOf(dir), name: ".." }, ...listed];
    return listed;
  });

  async function load(target: string): Promise<void> {
    const mine = ++serial;
    loading = true;
    failure = null;
    let want = generation;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await api.repositoryDirectory(repository, target, includeIgnored, want, nextId());
        if (mine !== serial) return;
        if (result.generation > generation) onGeneration(result.generation);
        entries = result.entries;
        if (result.errors.length > 0) failure = result.errors.join("；");
        break;
      } catch (error) {
        if (mine !== serial) return;
        const normalized = normalizeError(error);
        if (normalized.code === "stale" && normalized.generation !== undefined && attempt === 0) {
          onGeneration(normalized.generation);
          want = normalized.generation;
          continue;
        }
        entries = [];
        failure = normalized.message || "无法读取这个目录。";
        break;
      }
    }
    loading = false;
    const index = preselect ? rows.findIndex((row) => row.kind !== "up" && row.path === preselect) : -1;
    active = index === -1 ? 0 : index;
    preselect = null;
  }

  function enter(target: string, from: string | null): void {
    dir = target;
    query = "";
    preselect = from;
    void load(target);
  }

  function choose(index: number): void {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "up") enter(row.path, dir);
    else if (row.kind === "directory") enter(row.path, null);
    else {
      onOpen(row.path);
      onClose(false);
    }
  }

  $effect(() => {
    void query;
    untrack(() => {
      if (active >= rows.length) active = Math.max(0, rows.length - 1);
    });
  });

  untrack(() => void load(dir));
</script>

<Popover
  {anchor}
  label="切换目录或文件"
  placeholder={dir ? `在 ${nameOf(dir)}/ 中筛选` : "在仓库根目录中筛选"}
  width={340}
  bind:query
  bind:active
  count={rows.length}
  onChoose={choose}
  {onClose}
>
  {#snippet notice()}
    <p class="crumb-picker-dir" title={dir || "/"}><Icon name="folder-open" size={12} /><bdi>{dir ? `${dir}/` : "/"}</bdi></p>
  {/snippet}
  {#snippet list(listId)}
    {#if loading && entries.length === 0}
      <p class="branch-popover-empty" role="status">正在读取目录……</p>
    {:else if failure && entries.length === 0}
      <p class="branch-popover-empty danger" role="status">{failure}</p>
    {:else if rows.length === 0}
      <p class="branch-popover-empty">{query ? "没有匹配的条目" : "这个目录是空的"}</p>
    {/if}
    {#each rows as row, index (row.kind + ":" + row.path)}
      <div
        id={`${listId}-${index}`}
        class="branch-option crumb-picker-option"
        class:active={index === active}
        class:special={row.kind === "up"}
        role="option"
        aria-selected={row.kind !== "up" && row.path === current}
        data-index={index}
        data-crumb-entry={row.kind === "up" ? ".." : row.path}
        title={row.kind === "up" ? "上一级目录" : row.path}
        tabindex="-1"
        onmousemove={() => (active = index)}
        onclick={() => choose(index)}
        onkeydown={() => {}}
      >
        {#if row.kind === "up"}
          <span class="branch-option-icon"><Icon name="arrow-up" size={14} /></span>
          <span class="branch-option-name">上一级</span>
        {:else}
          <span class={`branch-option-icon ${row.kind === "directory" ? "ft-dir" : `ft-${fileTone(row.path)}`}`}>
            <Icon name={row.kind === "directory" ? "folder" : "file"} size={14} />
          </span>
          <span class="branch-option-name" class:crumb-picker-ignored={row.ignored}>{row.name}{row.kind === "directory" ? "/" : ""}</span>
          {#if row.kind === "directory"}<Icon name="chevron-right" size={12} />{/if}
        {/if}
      </div>
    {/each}
  {/snippet}
</Popover>
