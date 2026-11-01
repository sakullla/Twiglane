<script lang="ts">
  import { filterRecent } from "../recent";
  import type { IconName } from "../icons";
  import type { RecentRepo } from "../types";
  import { hueOf, initialOf } from "../ui";
  import Icon from "./Icon.svelte";
  import Popover from "./Popover.svelte";

  /**
   * 标题栏仓库弹层：搜索最近仓库并直接切换，右键或菜单键打开仓库操作，
   * 底部是打开、克隆、新建。切换判定由外壳给出（switchBlocked），这里只负责就地说明原因。
   */
  interface Props {
    anchor: HTMLElement;
    repos: RecentRepo[];
    currentPath: string | null;
    /** 不能切换仓库时的原因；只影响其他仓库，当前仓库不需要切换。 */
    blockedReason: string | null;
    /** 打开、克隆、新建不可用的原因。 */
    actionReason: string | null;
    onSelect: (path: string) => void;
    onForget: (path: string) => void;
    onCopyPath: (path: string) => void;
    onContextMenu: (repo: RecentRepo, point: { x: number; y: number }) => void;
    onCommand: (id: string) => void;
    onClose: (refocus?: boolean) => void;
  }

  let { anchor, repos, currentPath, blockedReason, actionReason, onSelect, onForget, onCopyPath, onContextMenu, onCommand, onClose }: Props = $props();

  const ACTIONS: { id: string; label: string; icon: IconName }[] = [
    { id: "repo.add", label: "打开本地仓库", icon: "folder-open" },
    { id: "repo.clone", label: "克隆远程仓库", icon: "download" },
    { id: "repo.create", label: "新建仓库", icon: "folder-plus" },
  ];

  let query = $state("");
  let active = $state(0);
  let visible = $derived(filterRecent(repos, query));
  /** 同名仓库只能靠路径区分，这些行显示完整路径而不是截断（R6）。 */
  let sameNames = $derived.by(() => {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const repo of repos) (seen.has(repo.name) ? repeated : seen).add(repo.name);
    return repeated;
  });

  /** 打开弹层或换关键词后，默认项落在第一个可切过去的仓库上：一次回车就能切换（R6）。 */
  $effect(() => {
    const first = visible.findIndex((repo) => repo.path !== currentPath);
    active = first >= 0 ? first : 0;
  });

  function reasonFor(repo: RecentRepo): string | null {
    return repo.path === currentPath ? null : blockedReason;
  }

  function choose(repo: RecentRepo | undefined) {
    if (!repo || reasonFor(repo)) return;
    if (repo.path === currentPath) onClose();
    else onSelect(repo.path);
  }
</script>

<Popover
  {anchor}
  label="切换仓库"
  placeholder="搜索仓库名称或路径"
  bind:query
  bind:active
  count={visible.length}
  onChoose={(index) => choose(visible[index])}
  onItemContextMenu={(index, point) => onContextMenu(visible[index], point)}
  {onClose}
>
  {#snippet list(listId)}
    {#if repos.length === 0}
      <p class="branch-popover-empty">还没有最近仓库，从下面打开或克隆一个。</p>
    {:else if visible.length === 0}
      <p class="branch-popover-empty">没有匹配的仓库，试试名称或路径。</p>
    {/if}
    {#each visible as repo, index (repo.path)}
      {@const reason = reasonFor(repo)}
      {@const current = repo.path === currentPath}
      <div class="switcher-row" role="presentation">
        <div
          id={`${listId}-${index}`}
          class="branch-option switcher-option"
          class:active={index === active}
          role="option"
          aria-selected={current}
          aria-disabled={reason ? "true" : undefined}
          data-index={index}
          title={reason ?? repo.path}
          tabindex="-1"
          onmousemove={() => (active = index)}
          onclick={() => choose(repo)}
          oncontextmenu={(event) => {
            event.preventDefault();
            active = index;
            onContextMenu(repo, { x: event.clientX, y: event.clientY });
          }}
          onkeydown={() => {}}
        >
          <span class="repo-badge" style={`--hue:${hueOf(repo.path)}`} aria-hidden="true">{initialOf(repo.name)}</span>
          <span class="repo-text">
            <span class="repo-name">{repo.name}</span>
            <span class={sameNames.has(repo.name) ? "repo-path-full" : "repo-path"}><bdi>{repo.path}</bdi></span>
            {#if reason}<span class="switcher-reason">{reason}</span>{/if}
          </span>
          {#if current}<Icon name="check" size={14} class="switcher-check" />{/if}
        </div>
        <span class="switcher-actions">
          <button type="button" class="icon-btn sm" tabindex="-1" aria-label={`复制 ${repo.name} 的完整路径`} title="复制完整路径" onclick={() => onCopyPath(repo.path)}>
            <Icon name="copy" size={13} />
          </button>
          <button type="button" class="icon-btn sm danger" tabindex="-1" aria-label={`从列表移除 ${repo.name}`} title="从列表移除（不删除文件）" onclick={() => onForget(repo.path)}>
            <Icon name="x" size={13} />
          </button>
        </span>
      </div>
    {/each}
  {/snippet}
  {#snippet foot()}
    {#each ACTIONS as action (action.id)}
      <button type="button" class="menu-item" disabled={actionReason !== null} title={actionReason ?? undefined} onclick={() => onCommand(action.id)}>
        <Icon name={action.icon} size={14} />
        <span>{action.label}</span>
      </button>
    {/each}
  {/snippet}
</Popover>
