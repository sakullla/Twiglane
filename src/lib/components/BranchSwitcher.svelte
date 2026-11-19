<script lang="ts">
  import { onMount } from "svelte";
  import { blockTops, blockWindow } from "../ui";
  import { api } from "../api";
  import { bucketBranches, filterBranches, groupIsOpen, isDefaultBranch, mainBranchNames, trackingMap, trackingSummary, trackNameFor } from "../branches";
  import { normalizeError } from "../errors";
  import type { IconName } from "../icons";
  import type { BranchRecord, BranchListing, BranchState, BranchTrack, OpenedRepository, StatusSnapshot } from "../types";
  import BranchOption from "./BranchOption.svelte";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";
  import Popover from "./Popover.svelte";

  /**
   * 标题栏分支弹层：搜索本地和远程分支并直接切换，底部进入新建、合并与管理。
   * 切换与 BranchDialog 走同一个 api.switchBranch 和同一套写锁；失败时不应用任何快照，
   * 原因留在弹层里，工作区保持原样。
   * 右键或菜单键打开分支操作：切换、拉取（非当前分支只快进，不切换）、推送、合并、变基、新建、
   * 重命名、删除、复制名称；菜单叠在弹层上，Esc 只关菜单。重命名与删除的确认就地展开在弹层顶部。
   * 每个本地分支行尾有相对上游的 ↓落后 / ↑领先 小徽标（一次 for-each-ref 读出，不访问远程），
   * 顶部汇总「X 个需要拉取 / Y 个需要推送」，点一下只看这些分支。
   */
  interface Props {
    anchor: HTMLElement;
    opened: OpenedRepository;
    /** 切换被禁止的原因（读取或写入中）。 */
    blockedReason: string | null;
    nextId: () => number;
    onBusy: (name: string | null) => void;
    onGeneration: (generation: number) => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onCommand: (id: string) => void;
    /** 「新建分支」：打开分支 modal 并直接展开新建表单；base 是预选起点，name 是带入的分支名。 */
    onCreateBranch: (base?: string, name?: string) => void;
    /** 删除分支：走分支管理里统一的删除确认（未合入再确认、同名远程、占用的工作区）。 */
    onDeleteBranch?: (branch: BranchRecord) => void;
    /** 把所点分支合并到当前分支：打开分支合并并预选来源。 */
    onMergeBranch?: (name: string) => void;
    /** 把当前分支合并到所点本地分支：打开分支合并并预选目标。 */
    onMergeInto?: (name: string) => void;
    /** 把当前分支变基到所点分支。 */
    onRebaseBranch?: (name: string) => void;
    /** 设置里的分支分组。缺省开启。 */
    branchGroups?: boolean;
    /** 打开其他工作区成功后交给外壳切换当前仓库。 */
    onOpened?: (repo: OpenedRepository) => void;
    /**
     * 打开其他工作区之前的外壳关卡。返回 false 时弹层不读取、不切换：用户取消了，
     * 或外壳已经收起弹层、改由自己走带确认的打开路径（弹层挡不住叠在上面的确认框）。
     */
    beforeOpen?: (path: string) => Promise<boolean>;
    /** 读到全部本地分支的领先/落后后交给外壳：标题栏分支按钮据此汇总提醒。 */
    onTracking?: (tracks: BranchTrack[]) => void;
    onClose: (refocus?: boolean) => void;
  }

  let {
    anchor,
    opened,
    blockedReason,
    nextId,
    onBusy,
    onGeneration,
    onSnapshot,
    onFailure,
    onNotice,
    onCommand,
    onCreateBranch,
    onDeleteBranch,
    onMergeBranch,
    onMergeInto,
    onRebaseBranch,
    branchGroups = true,
    onOpened,
    beforeOpen,
    onTracking,
    onClose,
  }: Props = $props();

  const ACTIONS: { id: string; label: string; icon: IconName; create?: boolean }[] = [
    { id: "task.branch", label: "新建分支", icon: "plus", create: true },
    { id: "task.merge", label: "合并到当前分支", icon: "merge" },
    { id: "task.branch", label: "管理分支与标签", icon: "tag" },
  ];
  const HEIGHTS = { label: 30, group: 30, branch: 36 };
  let scrollTop = $state(0);
  let viewport = $state(0);
  let listHost: HTMLElement | null = null;

  let branches = $state.raw<BranchRecord[]>([]);
  let defaultBranch = $state<string | null>(null);
  let mergeBases = $state<string[]>([]);
  let mainNames = $derived(mainBranchNames({ defaultBranch, mergeBases }));
  let groupOverrides = $state<Record<string, boolean>>({});
  let loading = $state(true);
  let query = $state("");
  let active = $state(0);
  let errorText = $state<string | null>(null);
  let openingWorktree = $state(false);
  let menu = $state<ContextMenuRequest | null>(null);
  /** 领先/落后：独立读取，慢或失败都不挡列表与切换。 */
  let tracks = $state.raw<Map<string, BranchTrack>>(new Map());
  let summary = $derived(trackingSummary([...tracks.values()]));
  /** 只看需要拉取 / 推送的分支。 */
  let syncFilter = $state<"pull" | "push" | null>(null);
  /** 就地展开的重命名；删除统一交给分支管理里的删除确认框。 */
  let editing = $state<{ kind: "rename"; branch: BranchRecord; value: string } | null>(null);
  let working = $state<string | null>(null);
  /** 远程分支的短名被跟踪别处的本地分支占用：给出「切到本地同名分支」或「以新名称检出」两条路。 */
  let mismatch = $state<{ remote: string; local: string; suggested: string } | null>(null);
  /** 切换在途时弹层可能已被收起，甚至换成了别的弹层；那时不能再替它们关闭。 */
  let mounted = true;

  let currentName = $derived(opened.snapshot.branch.name);
  let sorted = $derived(branches
        .filter((branch) => !(branch.remote && branch.name.endsWith("/HEAD")))
        // 本地在前、当前分支最前；数量截断时留下的也是这些。
        .sort((a, b) => Number(a.remote) - Number(b.remote) || Number(isCurrent(b)) - Number(isCurrent(a))));
  let filtered = $derived.by(() => {
    const matched = filterBranches(sorted, query);
    if (!syncFilter) return matched;
    return matched.filter((branch) => {
      const track = branch.remote ? undefined : tracks.get(branch.name);
      return syncFilter === "pull" ? (track?.behind ?? 0) > 0 : (track?.ahead ?? 0) > 0;
    });
  });

  interface SwitchLabel { kind: "label"; key: string; text: string }
  interface SwitchGroup { kind: "group"; key: string; scope: string; prefix: string; open: boolean; count: number }
  interface SwitchBranch { kind: "branch"; key: string; branch: BranchRecord; index: number }
  type SwitchRow = SwitchLabel | SwitchGroup | SwitchBranch;

  let view = $derived.by(() => {
    const grouping = branchGroups !== false && query.trim() === "" && syncFilter === null;
    const options: BranchRecord[] = [];
    const rows: SwitchRow[] = [];
    const rowOf: number[] = [];
    const pushSection = (sectionBranches: BranchRecord[], label: string, scope: string) => {
      if (sectionBranches.length === 0) return;
      rows.push({ kind: "label", key: `label:${scope}`, text: label });
      const buckets = grouping ? bucketBranches(sectionBranches) : { top: sectionBranches, groups: [] };
      const pushBranch = (branch: BranchRecord) => {
        const index = options.length;
        rowOf.push(rows.length);
        options.push(branch);
        rows.push({ kind: "branch", key: `${scope}:${branch.name}`, branch, index });
      };
      for (const branch of buckets.top) pushBranch(branch);
      for (const group of buckets.groups) {
        const key = `${scope}:${group.prefix}`;
        const open = groupIsOpen(group.branches, currentName, groupOverrides, key);
        rows.push({ kind: "group", key, scope, prefix: group.prefix, open, count: group.branches.length });
        if (open) for (const branch of group.branches) pushBranch(branch);
      }
    };
    pushSection(filtered.filter((branch) => !branch.remote), "本地分支", "local");
    pushSection(filtered.filter((branch) => branch.remote), "远程分支", "remote");
    return { options, rows, rowOf };
  });
  let matched = $derived(view.options);
  let tops = $derived(blockTops(view.rows.map((row) => HEIGHTS[row.kind]), 0));
  let span = $derived(blockWindow(tops, scrollTop, viewport || 360, 180, 24));
  let shown = $derived.by(() => {
    const rows = [];
    for (let at = span.start; at < span.end; at++) rows.push({ row: view.rows[at], at });
    const at = view.rowOf[active];
    if (at !== undefined && (at < span.start || at >= span.end)) rows.push({ row: view.rows[at], at });
    return rows;
  });
  $effect(() => {
    query;
    scrollTop = 0;
    if (listHost) listHost.scrollTop = 0;
  });
  function trackList(node: HTMLElement) {
    const host = node.parentElement!;
    listHost = host;
    const read = () => { scrollTop = host.scrollTop; viewport = host.clientHeight; };
    read();
    host.addEventListener("scroll", read, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(host);
    return { destroy() { host.removeEventListener("scroll", read); observer?.disconnect(); listHost = null; } };
  }
  let layoutKey = "";

  $effect(() => {
    const nextKey = `${opened.summary.path}\0${branchGroups !== false}`;
    if (nextKey === layoutKey) return;
    layoutKey = nextKey;
    groupOverrides = {};
  });

  /** 默认项落在第一个可切过去的分支上：一次回车就能切换（R6）。 */
  $effect(() => {
    const first = matched.findIndex((branch) => !isCurrent(branch) && !elsewhere(branch));
    active = first >= 0 ? first : 0;
  });

  function isCurrent(branch: BranchRecord): boolean {
    return !branch.remote && branch.name === currentName;
  }

  function elsewhere(branch: BranchRecord): string | null {
    return branch.worktree && !isCurrent(branch) ? `正被其他工作区使用：${branch.worktree}` : null;
  }

  function reasonFor(branch: BranchRecord): string | null {
    if (isCurrent(branch)) return null;
    return elsewhere(branch) ?? blockedReason;
  }

  /** 列表是只读取：不占写锁，也不改外壳状态，只有 generation 过期时跟上一次。 */
  async function readBranches(): Promise<BranchListing> {
    const path = opened.summary.path;
    try {
      return await api.branchList(path, opened.generation, nextId());
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code !== "stale" || failure.generation === undefined) throw failure;
      if (!mounted || opened.summary.path !== path) throw failure;
      onGeneration(failure.generation);
      return api.branchList(path, failure.generation, nextId());
    }
  }

  /** 列表与领先/落后分开读：领先/落后只是提示，读不出来不影响切换。 */
  async function readTracking(path: string, generation: number) {
    try {
      const result = await api.branchTracking(path, generation, nextId());
      if (!mounted || opened.summary.path !== path) return;
      const list = result?.branches ?? [];
      tracks = trackingMap(list);
      onTracking?.(list);
    } catch {
      // 只是少了徽标。
    }
  }

  function acceptListing(result: Pick<BranchListing, "branches" | "defaultBranch" | "mergeBases"> | null | undefined) {
    branches = result?.branches ?? [];
    defaultBranch = result?.defaultBranch ?? null;
    mergeBases = result?.mergeBases ?? [];
  }

  onMount(() => {
    const path = opened.summary.path;
    void readBranches()
      .then((result) => {
        if (mounted && opened.summary.path === path) {
          acceptListing(result);
          void readTracking(path, result?.generation ?? opened.generation);
        }
      })
      .catch((error) => {
        if (opened.summary.path === path) errorText = normalizeError(error).message;
      })
      .finally(() => {
        loading = false;
      });
    return () => {
      mounted = false;
    };
  });

  function toggleGroup(scope: string, prefix: string) {
    const key = `${scope}:${prefix}`;
    const row = view.rows.find((item) => item.kind === "group" && item.key === key);
    const open = row?.kind === "group" ? row.open : false;
    groupOverrides = { ...groupOverrides, [key]: !open };
  }

  /** 打开占用该分支的工作区。不把那个分支检出到当前工作区。 */
  async function openWorktree(branch: BranchRecord) {
    const path = branch.worktree;
    if (!path || blockedReason || openingWorktree) return;
    const repo = opened;
    errorText = null;
    openingWorktree = true;
    if (beforeOpen) {
      let proceed = false;
      try {
        proceed = await beforeOpen(path);
      } catch {
        proceed = false;
      }
      if (!proceed || !mounted || opened.summary.path !== repo.summary.path) {
        openingWorktree = false;
        return;
      }
    }
    onBusy("open");
    try {
      const next = await api.openRepository(path, nextId());
      if (!mounted || opened.summary.path !== repo.summary.path) return;
      onOpened?.(next);
      onClose();
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      openingWorktree = false;
      onBusy(null);
    }
  }

  async function copyName(name: string) {
    try {
      await navigator.clipboard.writeText(name);
      onNotice(`已复制分支名 ${name}`);
    } catch {
      errorText = "无法写入剪贴板，请手动复制分支名。";
    }
  }

  /** 远程分支名拆成远程与分支：远程名里不含 /。 */
  function splitRemote(name: string): { remote: string; short: string } {
    const slash = name.indexOf("/");
    return slash > 0 ? { remote: name.slice(0, slash), short: name.slice(slash + 1) } : { remote: "", short: name };
  }

  /** 写入完成后：外壳收下快照，弹层就地换成新列表并重读领先/落后，用户可以接着操作下一个分支。 */
  function acceptState(result: BranchState, path: string) {
    if (opened.summary.path !== path) return;
    onSnapshot(result.snapshot);
    if (!mounted) return;
    acceptListing(result);
    void readTracking(path, result.generation);
  }

  /**
   * 不切换分支的写入（拉取、推送、重命名、删除）：占外壳的写锁（onBusy），失败时原因留在弹层里，
   * 也交给外壳统一处理；成功后弹层留着，便于连续处理多个分支。
   */
  async function runWrite(label: string, busy: string, action: (path: string, generation: number) => Promise<BranchState>, done: string) {
    if (working || blockedReason) return;
    const repo = opened;
    errorText = null;
    working = label;
    onBusy(busy);
    try {
      const result = await action(repo.summary.path, repo.generation);
      acceptState(result, repo.summary.path);
      editing = null;
      onNotice(done);
      return true;
    } catch (error) {
      const failure = normalizeError(error);
      if (opened.summary.path !== repo.summary.path) return false;
      if (failure.generation !== undefined) onGeneration(failure.generation);
      if (mounted) errorText = failure.message;
      onFailure(failure);
      return false;
    } finally {
      working = null;
      onBusy(null);
    }
  }

  function pullBranch(branch: BranchRecord) {
    if (isCurrent(branch)) {
      onClose();
      onCommand("sync.pull");
      return;
    }
    const behind = tracks.get(branch.name)?.behind ?? 0;
    void runWrite(
      `正在拉取 ${branch.name}`,
      "pull",
      (path, generation) => api.updateBranch(path, branch.name, generation, nextId()),
      behind > 0 ? `已把 ${branch.name} 快进 ${behind} 个提交，没有切换分支。` : `${branch.name} 已与上游一致，没有切换分支。`,
    );
  }

  function pushLocal(branch: BranchRecord) {
    if (isCurrent(branch)) {
      onClose();
      onCommand("sync.push");
      return;
    }
    void runWrite(
      `正在推送 ${branch.name}`,
      "push",
      (path, generation) => api.pushLocalBranch(path, branch.name, generation, nextId()),
      branch.upstream ? `已推送 ${branch.name}，没有强行推送。` : `已发布 ${branch.name} 并建立上游。`,
    );
  }

  function startRename(branch: BranchRecord) {
    errorText = null;
    editing = { kind: "rename", branch, value: branch.name };
  }

  function submitRename() {
    if (editing?.kind !== "rename") return;
    const { branch, value } = editing;
    const next = value.trim();
    if (!next || next === branch.name) {
      editing = null;
      return;
    }
    void runWrite(
      `正在重命名 ${branch.name}`,
      "branch",
      (path, generation) => api.renameBranch(path, branch.name, next, generation, nextId()),
      `已把 ${branch.name} 重命名为 ${next}。`,
    );
  }

  /** 分支行的操作菜单：拉取 / 推送不切换分支；重命名与删除就地确认。 */
  function openMenu(branch: BranchRecord, point: { x: number; y: number }) {
    const busy = blockedReason ?? (working ? `${working}…` : undefined) ?? (openingWorktree ? "正在打开工作区" : undefined);
    const current = isCurrent(branch);
    const currentReason = current ? "这就是当前分支" : undefined;
    const occupied = elsewhere(branch) ?? undefined;
    const entries: ContextMenuEntry[] = [
      {
        id: "switch",
        label: branch.remote ? "检出为本地分支并切换" : "切换到此分支",
        icon: "check-circle",
        disabledReason: currentReason ?? occupied ?? busy,
        run: () => void choose(branch),
      },
    ];
    if (branch.worktree && !current) {
      entries.push({ id: "open-worktree", label: "打开此工作区", icon: "folder-open", disabledReason: busy, run: () => void openWorktree(branch) });
    }
    if (!branch.remote) {
      const track = tracks.get(branch.name);
      const upstream = track?.upstream ?? branch.upstream;
      const behind = track?.behind ?? 0;
      const ahead = track?.ahead ?? 0;
      const noUpstream = upstream ? undefined : "没有上游分支，无法拉取；可以先推送并建立上游";
      const gone = track?.gone ? `上游 ${upstream} 已从远程删除` : undefined;
      entries.push({ separator: true });
      entries.push({
        id: "pull",
        label: current ? "拉取（快进）" : behind > 0 ? `拉取 ${behind} 个提交（快进，不切换）` : "拉取（快进，不切换）",
        icon: "download",
        disabledReason: noUpstream ?? gone ?? (current ? undefined : occupied) ?? busy,
        run: () => pullBranch(branch),
      });
      entries.push({
        id: "push",
        label: !upstream || track?.gone ? "推送并建立上游" : ahead > 0 ? `推送 ${ahead} 个提交` : "推送",
        icon: "upload",
        disabledReason: busy,
        run: () => pushLocal(branch),
      });
    }
    entries.push({ separator: true });
    if (onMergeBranch) {
      entries.push({
        id: "merge",
        label: `合并到当前分支（${currentName ?? "HEAD"}）…`,
        icon: "merge",
        disabledReason: currentReason ?? busy,
        run: () => onMergeBranch?.(branch.name),
      });
    }
    if (onMergeInto && !branch.remote && currentName) {
      entries.push({
        id: "merge-into",
        label: `把 ${currentName} 合并到此分支…`,
        icon: "merge",
        disabledReason: currentReason ?? occupied ?? busy,
        run: () => onMergeInto?.(branch.name),
      });
    }
    if (onRebaseBranch && currentName) {
      entries.push({
        id: "rebase",
        label: "把当前分支变基到此分支…",
        icon: "branch",
        disabledReason: currentReason ?? occupied ?? busy,
        run: () => onRebaseBranch?.(branch.name),
      });
    }
    entries.push({
      id: "create",
      label: "从此分支新建分支…",
      icon: "plus",
      disabledReason: busy,
      run: () => onCreateBranch(current ? undefined : branch.name),
    });
    entries.push({ separator: true });
    entries.push({ id: "copy", label: "复制分支名", icon: "copy", run: () => void copyName(branch.name) });
    if (!branch.remote) {
      entries.push({
        id: "rename",
        label: "重命名…",
        icon: "pencil",
        disabledReason: (current ? undefined : occupied) ?? busy,
        run: () => startRename(branch),
      });
      entries.push({
        id: "delete",
        label: "删除分支…",
        icon: "trash",
        danger: true,
        disabledReason: (current ? "不能删除当前分支，请先切换到其他分支" : undefined) ?? occupied ?? busy,
        run: () => onDeleteBranch?.(branch),
      });
    } else {
      entries.push({
        id: "delete-remote",
        label: "从远程删除…",
        icon: "trash",
        danger: true,
        disabledReason: busy,
        run: () => onDeleteBranch?.(branch),
      });
    }
    entries.push({ id: "manage", label: "在分支管理中打开…", icon: "settings", run: () => onCommand("task.branch") });
    menu = { x: point.x, y: point.y, entries, label: `${branch.name} 的操作` };
  }

  /** 分组行：展开收起、复制前缀；远程分组可以直接获取更新。 */
  function openGroupMenu(row: SwitchGroup, point: { x: number; y: number }) {
    const entries: ContextMenuEntry[] = [
      { id: "toggle", label: row.open ? "收起分组" : "展开分组", icon: row.open ? "chevron-up" : "chevron-down", run: () => toggleGroup(row.scope, row.prefix) },
      { id: "copy-prefix", label: "复制前缀", icon: "copy", run: () => void copyName(`${row.prefix}/`) },
    ];
    if (row.scope === "remote") {
      entries.push({ separator: true });
      entries.push({
        id: "fetch",
        label: "获取远程更新",
        icon: "refresh",
        disabledReason: blockedReason ?? undefined,
        run: () => {
          onClose();
          onCommand("sync.fetch");
        },
      });
    }
    menu = { x: point.x, y: point.y, entries, label: `分组 ${row.prefix} 的操作` };
  }

  /** 弹层其他位置（分区标题、空白）不出原生菜单。 */
  function quietMenu(event: MouseEvent) {
    const target = event.target as Element | null;
    if (target?.closest?.("input, textarea")) return;
    event.preventDefault();
  }

  async function choose(branch: BranchRecord | undefined) {
    if (!branch || reasonFor(branch)) return;
    if (isCurrent(branch)) {
      onClose();
      return;
    }
    const repo = opened;
    errorText = null;
    mismatch = null;
    onBusy("branch");
    try {
      const result = await api.switchBranch(repo.summary.path, branch.name, repo.generation, nextId());
      if (opened.summary.path !== repo.summary.path) return;
      onSnapshot(result.snapshot);
      onNotice(`已切换到 ${result.snapshot.branch.name ?? branch.name}`);
      if (mounted) onClose();
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code === "branch_upstream_mismatch" && branch.remote) {
        if (failure.generation !== undefined) onGeneration(failure.generation);
        const short = branch.name.slice(branch.name.indexOf("/") + 1);
        mismatch = { remote: branch.name, local: short, suggested: trackNameFor(branch.name, branches) };
        return;
      }
      errorText = failure.message;
      onFailure(failure);
    } finally {
      onBusy(null);
    }
  }

  async function trackAs(remote: string, local: string) {
    const repo = opened;
    errorText = null;
    onBusy("branch");
    try {
      const result = await api.trackRemoteAs(repo.summary.path, remote, local, opened.generation, nextId());
      if (opened.summary.path !== repo.summary.path) return;
      mismatch = null;
      onSnapshot(result.snapshot);
      onNotice(`已检出 ${remote} 为本地分支 ${local} 并切换过去。`);
      if (mounted) onClose();
    } catch (error) {
      const failure = normalizeError(error);
      errorText = failure.message;
      onFailure(failure);
    } finally {
      onBusy(null);
    }
  }
</script>

<Popover
  {anchor}
  label="切换分支"
  placeholder="搜索本地或远程分支"
  bind:query
  bind:active
  count={matched.length}
  onChoose={(index) => void choose(matched[index])}
  onItemContextMenu={(index, point) => {
    const branch = matched[index];
    if (branch) openMenu(branch, point);
  }}
  {onClose}
>
  {#snippet notice()}
    {#if summary.pull > 0 || summary.push > 0 || syncFilter}
      <div class="branch-sync-summary" role="group" aria-label="需要同步的分支" data-branch-sync-summary>
        {#if summary.pull > 0 || syncFilter === "pull"}
          <button
            type="button"
            class="branch-sync-chip"
            aria-pressed={syncFilter === "pull"}
            title="只看落后上游、可以拉取的分支（数字来自上次获取远程）"
            onmousedown={(event) => event.stopPropagation()}
            onclick={() => (syncFilter = syncFilter === "pull" ? null : "pull")}
          ><Icon name="arrow-down" size={12} /><span class="num">{summary.pull}</span> 个需要拉取</button>
        {/if}
        {#if summary.push > 0 || syncFilter === "push"}
          <button
            type="button"
            class="branch-sync-chip"
            aria-pressed={syncFilter === "push"}
            title="只看领先上游、可以推送的分支"
            onmousedown={(event) => event.stopPropagation()}
            onclick={() => (syncFilter = syncFilter === "push" ? null : "push")}
          ><Icon name="arrow-up" size={12} /><span class="num">{summary.push}</span> 个需要推送</button>
        {/if}
      </div>
    {/if}
    {#if editing?.kind === "rename"}
      {@const target = editing.branch}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <form
        class="branch-inline-form"
        aria-label={`重命名 ${target.name}`}
        onmousedown={(event) => event.stopPropagation()}
        onsubmit={(event) => {
          event.preventDefault();
          submitRename();
        }}
      >
        <p>重命名本地分支 <code>{target.name}</code>{#if target.upstream}；上游 <code>{target.upstream}</code> 保持不变{/if}</p>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="input"
          aria-label="新的分支名称"
          spellcheck="false"
          autocomplete="off"
          autofocus
          bind:value={editing.value}
          onkeydown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              editing = null;
            }
          }}
        />
        <div class="row">
          <button type="button" class="btn btn-ghost btn-sm" onclick={() => (editing = null)}>取消</button>
          <button type="submit" class="btn btn-primary btn-sm" disabled={working !== null || blockedReason !== null || !editing.value.trim()} title={blockedReason ?? undefined}>重命名</button>
        </div>
      </form>
    {/if}
    {#if working}
      <p class="switcher-notice" role="status"><span class="spinner"></span><span>{working}…</span></p>
    {:else if blockedReason && !errorText}
      <p class="switcher-notice" role="status">
        <Icon name="info" size={14} />
        <span>{blockedReason}</span>
      </p>
    {/if}
    {#if mismatch}
      {@const info = mismatch}
      {@const localRecord = branches.find((item) => !item.remote && item.name === info.local)}
      <div class="switcher-choice" role="alert">
        <p>
          <Icon name="info" size={14} />
          <span>本地已有 <code>{info.local}</code>{#if localRecord?.upstream}（跟踪 <code>{localRecord.upstream}</code>）{/if}，不能直接用这个名字检出 <code>{info.remote}</code>。</span>
        </p>
        <div class="switcher-choice-actions">
          <button type="button" class="btn btn-primary btn-sm" disabled={blockedReason !== null} title={blockedReason ?? `新建本地分支 ${info.suggested} 并跟踪 ${info.remote}`} onclick={() => void trackAs(info.remote, info.suggested)}>
            <Icon name="branch" size={13} />检出为 {info.suggested}
          </button>
          {#if localRecord && !isCurrent(localRecord)}
            <button type="button" class="btn btn-secondary btn-sm" disabled={blockedReason !== null} title={blockedReason ?? `切换到本地分支 ${info.local}`} onclick={() => void choose(localRecord)}>切到本地 {info.local}</button>
          {/if}
          <button type="button" class="btn btn-ghost btn-sm" onclick={() => onCreateBranch(info.remote)}>自定义名称…</button>
        </div>
      </div>
    {/if}
    {#if errorText}
      <p class="switcher-error" role="alert">
        <Icon name="alert-circle" size={14} />
        <span>{errorText}</span>
      </p>
    {/if}
  {/snippet}
  {#snippet list(listId)}
    {#if loading}
      <p class="branch-popover-empty"><span class="spinner"></span> 正在读取分支</p>
    {:else if filtered.length === 0}
      {@const candidate = query.trim()}
      <div class="branch-popover-empty">
        <p>没有匹配的分支</p>
        {#if candidate && !syncFilter}
          <button
            type="button"
            class="btn btn-secondary btn-sm branch-create-match"
            disabled={blockedReason !== null}
            title={blockedReason ?? `打开新建分支并带入名称「${candidate}」`}
            onmousedown={(event) => event.stopPropagation()}
            onclick={() => onCreateBranch(undefined, candidate)}
          >
            <Icon name="plus" size={13} />
            <span class="truncate">以「{candidate}」新建分支</span>
          </button>
        {/if}
      </div>
    {/if}
    <div class="branch-picker-space" role="presentation" style={`height:${tops[view.rows.length]}px`} use:trackList oncontextmenu={quietMenu}>
    {#each shown as { row, at } (row.key)}
      {#if row.kind === "label"}
        <div class="branch-popover-group" style={`top:${tops[at]}px`}>{row.text}</div>
      {:else if row.kind === "group"}
        <button
          type="button"
          class="branch-group"
          style={`top:${tops[at]}px`}
          data-branch-group={row.prefix}
          aria-expanded={row.open}
          aria-label={`${row.open ? "收起" : "展开"}分组 ${row.prefix}`}
          tabindex="-1"
          onmousedown={(event) => event.stopPropagation()}
          onclick={() => toggleGroup(row.scope, row.prefix)}
          oncontextmenu={(event) => {
            event.preventDefault();
            openGroupMenu(row, { x: event.clientX, y: event.clientY });
          }}
        >
          <Icon name={row.open ? "chevron-down" : "chevron-right"} size={12} />
          <span>{row.prefix}</span>
          <span class="count">{row.count}</span>
        </button>
      {:else}
        {@const branch = row.branch}
        {@const track = branch.remote ? undefined : tracks.get(branch.name)}
        <BranchOption
          id={`${listId}-${row.index}`}
          style={`top:${tops[at]}px`}
          index={row.index}
          setsize={matched.length}
          name={branch.name}
          query={query}
          remote={branch.remote}
          active={row.index === active}
          selected={isCurrent(branch)}
          current={isCurrent(branch)}
          isDefault={isDefaultBranch(branch, defaultBranch)}
          main={mainNames.has(branch.name)}
          merged={branch.merged === true}
          mergedTitle={`已合入主干：已完整包含在 ${[...mainNames].join(" 和 ")} 中，删除不会丢失提交`}
          reason={reasonFor(branch)}
          note={branch.worktree && !isCurrent(branch) ? "其他工作区" : null}
          check={false}
          ahead={track?.ahead ?? 0}
          behind={track?.behind ?? 0}
          gone={track?.gone ?? false}
          onHover={() => (active = row.index)}
          onChoose={() => void choose(branch)}
          onContextMenu={(point) => openMenu(branch, point)}
        >
          {#snippet trailing()}
            {#if branch.worktree && !isCurrent(branch)}
              <button
                type="button"
                class="icon-btn sm branch-open-worktree"
                data-open-worktree={branch.worktree}
                aria-label="打开此工作区"
                disabled={blockedReason !== null || openingWorktree}
                title={blockedReason ?? `打开工作区 ${branch.worktree}`}
                onmousedown={(event) => event.stopPropagation()}
                onclick={(event) => {
                  event.stopPropagation();
                  void openWorktree(branch);
                }}
              ><Icon name="folder-open" size={13} /></button>
            {/if}
          {/snippet}
        </BranchOption>
      {/if}
    {/each}
    </div>
  {/snippet}
  {#snippet foot()}
    {#each ACTIONS as action (action.label)}
      <button type="button" class="menu-item" onclick={() => (action.create ? onCreateBranch() : onCommand(action.id))}>
        <Icon name={action.icon} size={14} />
        <span>{action.label}</span>
      </button>
    {/each}
  {/snippet}
</Popover>

{#if menu}
  <ContextMenu request={menu} onClose={() => (menu = null)} />
{/if}
