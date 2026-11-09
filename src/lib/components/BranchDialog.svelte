<script lang="ts">
  import { BUSY_REASON } from "../ui";
  import { tick, untrack } from "svelte";
  import { api } from "../api";
  import { bucketBranches, filterBranches, groupIsOpen, isDefaultBranch, mainBranchNames, trackNameFor } from "../branches";
  import { normalizeError } from "../errors";
  import type { BranchRecord, BranchState, OpenedRepository, RecentRepo, RepoHead, StatusSnapshot } from "../types";
  import ConfirmDialog, { type ConfirmNote, type ConfirmTarget } from "./ConfirmDialog.svelte";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest, isContextKey, pointFor } from "./ContextMenu.svelte";
  import BranchPicker from "./BranchPicker.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import TagManager from "./TagManager.svelte";

  type BranchTab = "local" | "remote" | "tags";

  interface Props {
    opened: OpenedRepository;
    disabled: boolean;
    onClose: () => void;
    onBusy: (name: string | null) => void;
    onSnapshot: (snapshot: StatusSnapshot) => void;
    onFailure: (error: unknown) => void;
    onNotice: (message: string) => void;
    onOpenHistory?: (query: string) => void;
    /** 把某个分支合并到当前分支：关闭本 modal，打开分支合并并预选来源。 */
    onMergeBranch?: (name: string) => void;
    /** 把当前分支合并到某个本地分支：打开分支合并并预选目标。 */
    onMergeInto?: (name: string) => void;
    /** 把当前分支变基到所点分支：所点分支是基底，当前分支会被改写。 */
    onRebaseBranch?: (name: string) => void;
    /** 打开意图：入口本身就是「新建分支」时，打开即展开表单并聚焦名称，不必再点一次。 */
    startCreating?: boolean;
    /** 和 startCreating 一起给出的起点（例如分支弹层里右键「从此分支新建」）；空串表示当前分支。 */
    startBase?: string;
    /** 写锁来自后台克隆：它不碰当前仓库，读取照常，写入仍被拦住。 */
    backgroundClone?: boolean;
    /** 设置里的分支分组。缺省开启，与持久化缺省一致。 */
    branchGroups?: boolean;
    /** 写入或读取进行中时，打开其他工作区被拒绝的原因。 */
    blockedReason?: string | null;
    /** 打开其他工作区成功后交给外壳切换当前仓库。 */
    onOpened?: (repo: OpenedRepository) => void;
    /** 删除附属工作区后，后端返回的最新「最近仓库」列表交给外壳。 */
    onRecent?: (recent: RecentRepo[]) => void;
    /** 关闭后焦点去处（命令面板打开时由外壳传入）。 */
    returnFocus?: HTMLElement | null;
    nextId: () => number;
  }

  let {
    opened,
    disabled,
    onClose,
    onBusy,
    onSnapshot,
    onFailure,
    onNotice,
    onOpenHistory,
    onMergeBranch,
    onMergeInto,
    onRebaseBranch,
    startCreating = false,
    startBase = "",
    backgroundClone = false,
    branchGroups = true,
    blockedReason = null,
    onOpened,
    onRecent,
    returnFocus = null,
    nextId,
  }: Props = $props();

  let branches = $state<BranchRecord[]>([]);
  let defaultBranch = $state<string | null>(null);
  let groupOverrides = $state<Record<string, boolean>>({});
  let openingWorktree = $state(false);
  /**
   * 被其他工作区占用的分支所在目录的身份：是不是 `git worktree add` 建的附属工作区、目录还在不在。
   * 只有附属工作区能在这里删除；主工作区和已经不存在的目录给出原因，不发请求。
   */
  let worktreeHeads = $state<Record<string, RepoHead>>({});
  /** 删除工作区的确认：force 在 Git 报告有未提交改动后才置真，由用户再确认一次。 */
  let worktreePrompt = $state<{ branch: BranchRecord; path: string; force: boolean; error: string | null } | null>(null);
  /** 删除工作区后顺手删掉这个本地分支。默认不勾：分支和工作区是两件事。 */
  let alsoDeleteBranch = $state(false);
  let branchQuery = $state("");
  /** 新建表单按需展开，展开时替换搜索和列表（R10：不和列表同时铺开）。 */
  let creating = $state(untrack(() => startCreating));
  let branchName = $state("");
  /** 新分支的起点：空串表示当前分支（或游离 HEAD 的当前提交）。 */
  let createBase = $state(untrack(() => (startCreating ? startBase : "")));
  let createCheckout = $state(true);
  let renaming = $state<{ name: string; value: string } | null>(null);
  let menu = $state<ContextMenuRequest | null>(null);
  let nameInput = $state<HTMLInputElement | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);
  let createToggle = $state<HTMLButtonElement | null>(null);
  let listBox = $state<HTMLDivElement | null>(null);
  let renameInput = $state<HTMLInputElement | null>(null);
  /** 写入在途：取消按钮禁用、Esc 不收起，结果未定时不能让界面看起来已经放弃。 */
  let writing = $state(false);
  /** 标签分区的写入在途：结果未定时同样不能切走或关闭。 */
  let tagWriting = $state(false);
  /** 确认区打开前的焦点和列表滚动位置，收起时原样还回去。 */
  let promptOrigin: { focus: HTMLElement | null; scrollTop: number } | null = null;
  let tab = $state<BranchTab>("local");
  let localBusy = $state(false);
  let errorText = $state<string | null>(null);
  /**
   * 最近一次失败的 code。删除本地分支后是否给出「强删」引导必须看它：
   * 只有 Git 明确回报 branch_unmerged 才说明是「未合入」，
   * 认证、网络、权限等失败不能把用户带向更危险的动作。
   */
  let lastFailureCode = $state<string | null>(null);
  /**
   * 列表读取的结果：只有真正读完才写入，写锁期间跳过的那次不算。
   * ok 为假时不再自动重读（失败也会释放锁，否则会循环），由「重试」清空。
   * generation 过期不算失败：readBranches 内部跟上后重读一次，只有重读也失败才记 ok 为假。
   */
  let loaded = $state<{ key: string; ok: boolean } | null>(null);
  /** 本地同名远程分支：remote 是远程名，name 是去掉远程名的分支名，full 是 remote/name。 */
  type RemoteTwin = { remote: string; name: string; full: string };
  let confirmDelete = $state<
    | { kind: "local"; name: string; force: boolean; twin: RemoteTwin | null; branch: BranchRecord }
    | { kind: "remote"; remote: string; name: string; force: false; branch: BranchRecord }
    | null
  >(null);
  /** 删除本地分支时是否同时删除同名远程分支。默认不勾：远程删除会影响别人，要用户明确选择。 */
  let alsoRemote = $state(false);
  /** 判定「已合入主干」的主干分支（后端给出），用在标记和提示里。 */
  let mergeBases = $state<string[]>([]);
  /** 主干分支：本地默认分支及其远程对应分支，列表里用星标。 */
  let mainNames = $derived(mainBranchNames({ defaultBranch, mergeBases }));

  const TABS: { id: BranchTab; label: string; icon: "branch" | "cloud" | "tag" }[] = [
    { id: "local", label: "本地分支", icon: "branch" },
    { id: "remote", label: "远程分支", icon: "cloud" },
    { id: "tags", label: "标签", icon: "tag" },
  ];

  let blocked = $derived(disabled || localBusy);
  let readBlocked = $derived(localBusy || (disabled && !backgroundClone));
  let writeInFlight = $derived(writing || tagWriting);
  /** 确认区和重命名区替换搜索与列表，不用算高度，也不必滚动就能看全说明和按钮。 */
  let prompting = $derived(renaming !== null);
  /** 删除确认框的内容：一句话、受影响的分支、后果和按钮文字都按这次要删的东西生成。 */
  let deletePrompt = $derived.by(() => {
    const target = confirmDelete;
    if (!target) return null;
    if (target.kind === "remote") {
      const full = `${target.remote}/${target.name}`;
      return {
        title: "删除远程分支",
        message: `从远程 ${target.remote} 删除分支 ${target.name}？`,
        targets: [{ icon: "cloud", name: full, detail: "远程分支", tag: target.branch.merged ? "已合入主干" : undefined, tagTone: "ok" }] as ConfirmTarget[],
        notes: [
          ...(target.branch.merged ? [{ tone: "ok", text: mergedNote() } as ConfirmNote] : []),
          { tone: "warn", text: "远程上的这个分支会被移除，其他协作者也将看不到它。" },
          { tone: "info", text: "不会强行推送；本地分支不受影响。" },
        ] as ConfirmNote[],
        confirm: "从远程删除",
      };
    }
    const twin = alsoRemote ? target.twin : null;
    const local: ConfirmTarget = {
      icon: "branch",
      name: target.name,
      detail: target.branch.upstream ? `本地分支 · 跟踪 ${target.branch.upstream}` : "本地分支 · 仅存在于本地",
      tag: target.branch.merged ? "已合入主干" : undefined,
      tagTone: "ok",
    };
    const notes: ConfirmNote[] = [];
    if (target.force) notes.push({ tone: "warn", text: "它含有尚未合入当前分支的提交，删除后这些提交不能由这里自动恢复。" });
    else if (target.branch.merged) notes.push({ tone: "ok", text: `${mergedNote()}。` });
    else notes.push({ tone: "info", text: "如果它还有未合入当前分支的提交，会再请你确认一次。" });
    if (twin) notes.push({ tone: "warn", text: `远程分支 ${twin.full} 会从远程移除，其他协作者也将看不到它。` });
    return {
      title: target.force ? "删除未合入的分支" : twin ? "删除本地和远程分支" : "删除本地分支",
      message: target.force
        ? `分支 ${target.name} 还有未合入的提交，仍要删除吗？`
        : twin
          ? `删除本地分支 ${target.name}，并从远程删除 ${twin.full}？`
          : `删除本地分支 ${target.name}？`,
      targets: twin ? [local, { icon: "cloud", name: twin.full, detail: "远程分支" } as ConfirmTarget] : [local],
      notes,
      confirm: target.force ? "仍然删除" : twin ? "删除本地和远程" : "删除分支",
    };
  });
  let localCount = $derived(branches.filter((branch) => !branch.remote).length);
  let remoteCount = $derived(branches.filter((branch) => branch.remote).length);
  let listScope = $derived(tab === "remote" ? "remote" : "local");
  let visibleBranches = $derived(
    filterBranches(
      branches.filter((branch) => (listScope === "local" ? !branch.remote : branch.remote)),
      branchQuery,
    ),
  );
  let current = $derived(opened.snapshot.branch);
  let listReady = $derived(loaded?.key === opened.summary.path && loaded.ok);
  let listFailed = $derived(loaded?.key === opened.summary.path && !loaded.ok);
  let grouping = $derived(branchGroups !== false && branchQuery.trim() === "");
  let buckets = $derived(grouping ? bucketBranches(visibleBranches) : { top: visibleBranches, groups: [] });
  /** 换仓库或重新打开分组时回到「当前分支所在组展开」。 */
  let layoutKey = "";

  $effect(() => {
    const nextKey = `${opened.summary.path}\0${branchGroups !== false}`;
    if (nextKey === layoutKey) return;
    layoutKey = nextKey;
    groupOverrides = {};
  });

  $effect(() => {
    if (loaded?.key === opened.summary.path || readBlocked) return;
    confirmDelete = null;
    void loadBranches();
  });

  /** 列表读取只占本组件的读取状态；只有实际写入才占宿主写锁。 */
  async function run<T>(action: () => Promise<T>, reading = false): Promise<T | undefined> {
    if (reading ? readBlocked : blocked) return undefined;
    const quiet = reading;
    localBusy = true;
    errorText = null;
    lastFailureCode = null;
    if (!quiet) onBusy("branch");
    try {
      return await action();
    } catch (error) {
      const failure = normalizeError(error);
      lastFailureCode = failure.code;
      // 用户主动取消的远程删除不算失败：结果在确认框关闭后用提示说明，不弹错误。
      if (failure.code === "cancelled" && abortingRemoval) return undefined;
      errorText = failure.message;
      onFailure(failure);
      return undefined;
    } finally {
      localBusy = false;
      if (!quiet) onBusy(null);
    }
  }

  /** 被拦下的重复动作不能碰 writing：它属于正在途中的那次写入，复位会让取消重新可用。 */
  async function write<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (blocked) return undefined;
    writing = true;
    try {
      return await run(action);
    } finally {
      writing = false;
    }
  }

  function rememberOrigin() {
    promptOrigin = {
      focus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      scrollTop: listBox?.scrollTop ?? 0,
    };
  }

  /** 列表显示回来后还原滚动，焦点回到触发按钮；它已不存在（行被删、被改名）时落在搜索框。 */
  async function restoreOrigin() {
    const origin = promptOrigin;
    promptOrigin = null;
    await tick();
    if (listBox && origin) listBox.scrollTop = origin.scrollTop;
    const target = origin?.focus;
    if (target?.isConnected && !target.matches(":disabled")) target.focus({ preventScroll: true });
    else searchInput?.focus();
  }

  function cancelPrompt() {
    if (writing) return;
    confirmDelete = null;
    renaming = null;
    void restoreOrigin();
  }

  function onPromptKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancelPrompt();
  }

  function applyBranches(result: BranchState) {
    branches = result.branches;
    defaultBranch = result.defaultBranch ?? null;
    mergeBases = result.mergeBases ?? [];
    onSnapshot(result.snapshot);
    void readWorktreeHeads(result.branches);
  }

  /** 读一次占用分支的目录身份（只读本地文件，不跑 Git）；失败时菜单按「未知」处理，删除时由后端再判一次。 */
  async function readWorktreeHeads(list: BranchRecord[]) {
    const paths = [...new Set(list.filter((branch) => branch.worktree && !branch.current).map((branch) => branch.worktree as string))];
    if (paths.length === 0) {
      worktreeHeads = {};
      return;
    }
    try {
      const heads = await api.repoHeads(paths);
      worktreeHeads = Object.fromEntries(heads.map((head) => [head.path, head]));
    } catch {
      worktreeHeads = {};
    }
  }

  /** 这个工作区为什么不能在这里删除；能删时返回 undefined。 */
  function worktreeRemoveReason(path: string): string | undefined {
    const head = worktreeHeads[path];
    if (!head) return undefined;
    if (head.missing) return "目录已经不存在；在命令行运行 git worktree prune 可以清掉这条记录";
    if (!head.worktree) return "这是主工作区，不能删除；只能删除 git worktree add 建出来的附属工作区";
    return undefined;
  }

  function worktreeName(path: string): string {
    const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || path;
  }

  function isDefault(branch: BranchRecord): boolean {
    return isDefaultBranch(branch, defaultBranch);
  }

  /** 已合入主干的说明：标记的提示与删除确认里共用。 */
  function mergedNote(): string {
    return mergeBases.length > 0 ? `已完整包含在 ${mergeBases.join(" 和 ")} 中，删除不会丢失提交` : "已完整包含在主干中，删除不会丢失提交";
  }

  /**
   * 与本地分支同名的远程分支：优先它跟踪的上游（名称相同时），否则 origin/同名。
   * 名称不同的上游不算——删除本地时顺手删掉一个别名的远程分支太容易出意外。
   */
  function remoteTwin(branch: BranchRecord): RemoteTwin | null {
    if (branch.remote) return null;
    const exists = (full: string) => branches.some((item) => item.remote && item.name === full);
    const candidates: string[] = [];
    if (branch.upstream) candidates.push(branch.upstream);
    candidates.push(`origin/${branch.name}`);
    for (const full of candidates) {
      const slash = full.indexOf("/");
      if (slash <= 0 || full.slice(slash + 1) !== branch.name || !exists(full)) continue;
      return { remote: full.slice(0, slash), name: full.slice(slash + 1), full };
    }
    return null;
  }

  /** 别的工作区正在用这个分支。这时只打开那个工作区，不在当前工作区检出。 */
  function elsewhereReason(branch: BranchRecord): string | undefined {
    return branch.worktree && !branch.current ? `正被其他工作区使用：${branch.worktree}` : undefined;
  }

  function rowLabel(branch: BranchRecord): string {
    const base = branch.current
      ? `当前分支 ${branch.name}`
      : elsewhereReason(branch)
        ? `${branch.name}，已在其他工作区检出`
        : `切换到 ${branch.name}`;
    return isDefault(branch) ? `${base}，默认分支` : base;
  }

  function groupKey(prefix: string): string {
    return `${listScope}:${prefix}`;
  }

  function groupOpen(prefix: string, members: BranchRecord[]): boolean {
    return groupIsOpen(members, current.name, groupOverrides, groupKey(prefix));
  }

  function toggleGroup(prefix: string, members: BranchRecord[]) {
    const open = groupOpen(prefix, members);
    groupOverrides = { ...groupOverrides, [groupKey(prefix)]: !open };
  }

  /** 过期时用后端给的 generation 重读一次；成功后由 onSnapshot 让外壳跟上，再过期就按失败处理。 */
  async function readBranches(path: string): Promise<BranchState> {
    try {
      return await api.branchState(path, opened.generation, nextId());
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code !== "stale" || failure.generation === undefined) throw failure;
      return api.branchState(path, failure.generation, nextId());
    }
  }

  async function loadBranches() {
    const path = opened.summary.path;
    const result = await run(async () => {
      try {
        const state = await readBranches(path);
        loaded = { key: path, ok: true };
        return state;
      } catch (error) {
        loaded = { key: path, ok: false };
        throw error;
      }
    }, true);
    if (!result || opened.summary.path !== path) return;
    applyBranches(result);
  }

  /** 刷新：列表留在原处，只在按钮上转圈；读完替换成新列表（含「已合入主干」标记）。 */
  let refreshing = $state(false);
  async function refresh() {
    if (refreshing || readBlocked) return;
    refreshing = true;
    try {
      await loadBranches();
    } finally {
      refreshing = false;
    }
  }

  /** 重试会把按钮换成加载态：先把焦点放到常驻的搜索框，否则焦点掉到 body，Esc 就到不了 Modal。 */
  function retryLoad() {
    searchInput?.focus();
    loaded = null;
  }

  /** 起点的实际值：选了分支就用分支名；默认用当前分支，游离 HEAD 时用当前提交。 */
  function startPoint(): string {
    return createBase || current.name || current.headOid || "HEAD";
  }

  async function createNamedBranch() {
    const currentRepo = opened;
    const name = branchName.trim();
    if (!name) return;
    const start = startPoint();
    const checkout = createCheckout;
    // 提交按钮在途时会被禁用，先把焦点放回一直可用的名称框。
    nameInput?.focus();
    const result = await write(() =>
      api.createBranchFrom(currentRepo.summary.path, name, start, checkout, currentRepo.generation, nextId()),
    );
    if (opened.summary.path !== currentRepo.summary.path) return;
    // 失败时表单和焦点都留着，让用户直接改名重试。
    if (!result) return;
    applyBranches(result);
    void closeCreate();
    if (checkout) {
      onNotice(`已从 ${start} 创建并切换到 ${name}。`);
      onClose();
    } else {
      onNotice(`已从 ${start} 创建分支 ${name}，当前分支没有切换。`);
    }
  }

  /** 新分支总是本地分支：在远程分区点新建也落到本地分区，高亮和内容一致。 */
  async function openCreate(base = "") {
    tab = "local";
    creating = true;
    createBase = base;
    await tick();
    nameInput?.focus();
  }

  function resetCreate() {
    creating = false;
    branchName = "";
    createBase = "";
  }

  /** 创建或取消后收起并清空；表单节点随之消失，焦点交还给「新建分支」按钮。 */
  async function closeCreate() {
    resetCreate();
    await tick();
    createToggle?.focus();
  }

  function createFrom(branch: BranchRecord) {
    menu = null;
    // 起点下拉不列当前分支本身，它由空值代表。
    void openCreate(branch.current ? "" : branch.name);
  }

  async function askRename(branch: BranchRecord) {
    rememberOrigin();
    renaming = { name: branch.name, value: branch.name };
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  async function confirmRename() {
    const target = renaming;
    const currentRepo = opened;
    if (!target || blocked) return;
    const next = target.value.trim();
    if (!next || next === target.name) {
      cancelPrompt();
      return;
    }
    const result = await write(() =>
      api.renameBranch(currentRepo.summary.path, target.name, next, currentRepo.generation, nextId()),
    );
    if (!result || opened.summary.path !== currentRepo.summary.path) return;
    renaming = null;
    void restoreOrigin();
    applyBranches(result);
    onNotice(`已把分支 ${target.name} 重命名为 ${next}。远程上的同名分支不受影响。`);
  }

  async function copyName(name: string) {
    try {
      await navigator.clipboard.writeText(name);
      onNotice(`已复制分支名 ${name}`);
    } catch {
      onFailure({ code: "clipboard", message: "无法写入剪贴板，请手动复制分支名。" });
    }
  }

  /** 分支行的操作菜单：右键、菜单键或行尾的「⋯」都打开这一份。 */
  function branchMenu(branch: BranchRecord, point: { x: number; y: number }) {
    if (elsewhereReason(branch)) {
      worktreeMenu(branch, point);
      return;
    }
    const busy = blocked || openingWorktree ? (blockedReason ?? BUSY_REASON) : undefined;
    const currentReason = branch.current ? "这就是当前分支" : undefined;
    const elsewhere = elsewhereReason(branch);
    const entries: ContextMenuEntry[] = [
      {
        id: "switch",
        label: branch.remote ? "检出为本地分支并切换" : "切换到此分支",
        icon: "check-circle",
        disabledReason: currentReason ?? elsewhere ?? busy,
        run: () => void switchTo(branch.name),
      },
    ];
    if (branch.worktree && !branch.current) {
      entries.push({
        id: "open-worktree",
        label: "打开此工作区",
        icon: "folder-open",
        disabledReason: busy,
        run: () => void openWorktree(branch.worktree ?? ""),
      });
    }
    entries.push(
      {
        id: "create",
        label: "从此分支新建分支…",
        icon: "plus",
        disabledReason: busy,
        run: () => createFrom(branch),
      },
    );
    if (onMergeBranch) {
      entries.push({
        id: "merge",
        label: `合并到当前分支（${current.name ?? "HEAD"}）…`,
        icon: "merge",
        disabledReason: currentReason ?? busy,
        run: () => onMergeBranch?.(branch.name),
      });
    }
    if (onMergeInto && !branch.remote && current.name) {
      entries.push({
        id: "merge-into",
        label: `把 ${current.name} 合并到此分支…`,
        icon: "merge",
        disabledReason: currentReason ?? elsewhere ?? busy,
        run: () => onMergeInto?.(branch.name),
      });
    }
    if (onRebaseBranch && current.name) {
      entries.push({
        id: "rebase",
        label: "把当前分支变基到此分支…",
        icon: "branch",
        disabledReason: currentReason ?? elsewhere ?? busy,
        run: () => onRebaseBranch?.(branch.name),
      });
    }
    entries.push({ separator: true });
    if (!branch.remote) {
      entries.push({ id: "rename", label: "重命名…", icon: "pencil", disabledReason: elsewhere ?? busy, run: () => void askRename(branch) });
    }
    entries.push({ id: "copy", label: "复制分支名", icon: "copy", run: () => void copyName(branch.name) });
    entries.push({ separator: true });
    entries.push({
      id: "delete",
      label: branch.remote ? "从远程删除…" : "删除…",
      icon: "trash",
      danger: true,
      disabledReason: branch.current ? "不能删除当前分支，先切换到其他分支" : (elsewhere ?? busy),
      run: () => void askDelete(branch),
    });
    menu = { x: point.x, y: point.y, entries, label: `${branch.name} 的操作` };
  }

  /**
   * 被其他工作区占用的分支：切换、合并进它、重命名、删除都要先把它从那个工作区里放出来，
   * 这里不再逐条列出灰掉的同一个原因，而是直接给能做的事——打开那个工作区，或删除它。
   * 以它为基底的动作（新建分支、合并到当前分支、把当前分支变基到它上面）不碰它，照常可用。
   */
  function worktreeMenu(branch: BranchRecord, point: { x: number; y: number }) {
    const busy = blocked || openingWorktree ? (blockedReason ?? BUSY_REASON) : undefined;
    const path = branch.worktree ?? "";
    const entries: ContextMenuEntry[] = [
      { heading: `已在工作区 ${worktreeName(path)} 中检出` },
      { id: "open-worktree", label: "打开此工作区", icon: "folder-open", disabledReason: busy, run: () => void openWorktree(path) },
      { id: "create", label: "从此分支新建分支…", icon: "plus", disabledReason: busy, run: () => createFrom(branch) },
    ];
    if (onMergeBranch) {
      entries.push({
        id: "merge",
        label: `合并到当前分支（${current.name ?? "HEAD"}）…`,
        icon: "merge",
        disabledReason: busy,
        run: () => onMergeBranch?.(branch.name),
      });
    }
    if (onRebaseBranch && current.name) {
      entries.push({
        id: "rebase",
        label: "把当前分支变基到此分支…",
        icon: "branch",
        disabledReason: busy,
        run: () => onRebaseBranch?.(branch.name),
      });
    }
    entries.push(
      { separator: true },
      { id: "copy", label: "复制分支名", icon: "copy", run: () => void copyName(branch.name) },
      { id: "copy-worktree", label: "复制工作区路径", icon: "copy", run: () => void copyText(path, "工作区路径") },
      { separator: true },
      {
        id: "remove-worktree",
        label: "删除工作区…",
        icon: "trash",
        danger: true,
        disabledReason: worktreeRemoveReason(path) ?? busy,
        run: () => askRemoveWorktree(branch),
      },
    );
    menu = { x: point.x, y: point.y, entries, label: `${branch.name} 的操作` };
  }

  async function copyText(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      onNotice(`已复制${what}`);
    } catch {
      onFailure({ code: "clipboard", message: `无法写入剪贴板，请手动复制${what}。` });
    }
  }

  function askRemoveWorktree(branch: BranchRecord) {
    const path = branch.worktree;
    if (!path || worktreeRemoveReason(path) || blocked) return;
    menu = null;
    alsoDeleteBranch = false;
    rememberOrigin();
    worktreePrompt = { branch, path, force: false, error: null };
  }

  function cancelWorktreePrompt() {
    if (writing) return;
    worktreePrompt = null;
    void restoreOrigin();
  }

  /** 删工作区由主仓库执行 git worktree remove；有未提交改动时 Git 拒绝，再确认一次才带 --force。 */
  async function confirmRemoveWorktree() {
    const prompt = worktreePrompt;
    const currentRepo = opened;
    if (!prompt || blocked) return;
    const dropBranch = alsoDeleteBranch && !prompt.branch.remote;
    let branchNote: string | null = null;
    let failure: { code: string; message: string } | null = null;
    writing = true;
    localBusy = true;
    onBusy("branch");
    worktreePrompt = { ...prompt, error: null };
    try {
      const recent = await api.removeWorktree(prompt.path, prompt.force, nextId());
      onRecent?.(recent);
      if (dropBranch) {
        try {
          const ask = (generation: number) => api.deleteBranch(currentRepo.summary.path, prompt.branch.name, false, generation, nextId());
          try {
            await ask(currentRepo.generation);
          } catch (error) {
            const stale = normalizeError(error);
            if (stale.code !== "stale" || stale.generation === undefined) throw stale;
            await ask(stale.generation);
          }
        } catch (error) {
          const branchFailure = normalizeError(error);
          branchNote = branchFailure.code === "branch_unmerged"
            ? `分支 ${prompt.branch.name} 还有未合入当前分支的提交，没有删除；需要时可以在列表里再删。`
            : `分支 ${prompt.branch.name} 没有删除：${branchFailure.message}`;
        }
      }
    } catch (error) {
      failure = normalizeError(error);
    } finally {
      writing = false;
      localBusy = false;
      onBusy(null);
    }
    if (opened.summary.path !== currentRepo.summary.path) return;
    if (failure) {
      if (failure.code === "worktree_dirty" && !prompt.force) {
        worktreePrompt = { ...prompt, force: true, error: null };
      } else {
        worktreePrompt = { ...prompt, error: failure.message };
      }
      return;
    }
    worktreePrompt = null;
    void restoreOrigin();
    if (branchNote) errorText = `已删除工作区 ${worktreeName(prompt.path)}。${branchNote}`;
    else onNotice(
      dropBranch
        ? `已删除工作区 ${worktreeName(prompt.path)} 和分支 ${prompt.branch.name}。`
        : `已删除工作区 ${worktreeName(prompt.path)}，分支 ${prompt.branch.name} 和提交都保留。`,
    );
    // 列表留在原处重读：占用标记随之消失，不闪回「正在读取」。
    void loadBranches();
  }

  /** 打开占用该分支的工作区。不检出到当前工作区，也不改两边的提交和文件。 */
  async function openWorktree(path: string) {
    if (!path || blocked || openingWorktree) {
      if (blocked) errorText = blockedReason ?? BUSY_REASON;
      return;
    }
    const currentRepo = opened;
    menu = null;
    openingWorktree = true;
    errorText = null;
    onBusy("open");
    try {
      const next = await api.openRepository(path, nextId());
      if (opened.summary.path !== currentRepo.summary.path) return;
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

  /** 远程分支的短名已被跟踪别处的本地分支占用时，提供以新名称检出。 */
  let mismatch = $state<{ remote: string; local: string; suggested: string } | null>(null);

  async function switchTo(name: string) {
    const currentRepo = opened;
    mismatch = null;
    const result = await write(() => api.switchBranch(currentRepo.summary.path, name, currentRepo.generation, nextId()));
    if (!result && lastFailureCode === "branch_upstream_mismatch" && opened.summary.path === currentRepo.summary.path) {
      const short = name.slice(name.indexOf("/") + 1);
      mismatch = { remote: name, local: short, suggested: trackNameFor(name, branches) };
      return;
    }
    if (!result || opened.summary.path !== currentRepo.summary.path) return;
    applyBranches(result);
    onNotice(`已切换到 ${result.snapshot.branch.name ?? name}`);
    onClose();
  }

  async function trackAs(remote: string, local: string) {
    const currentRepo = opened;
    const result = await write(() => api.trackRemoteAs(currentRepo.summary.path, remote, local, currentRepo.generation, nextId()));
    if (!result || opened.summary.path !== currentRepo.summary.path) return;
    mismatch = null;
    applyBranches(result);
    onNotice(`已检出 ${remote} 为本地分支 ${local} 并切换过去。`);
    onClose();
  }

  function askDelete(branch: BranchRecord) {
    let prompt: typeof confirmDelete;
    if (branch.remote) {
      const slash = branch.name.indexOf("/");
      if (slash <= 0) return;
      prompt = { kind: "remote", remote: branch.name.slice(0, slash), name: branch.name.slice(slash + 1), force: false, branch };
    } else {
      prompt = { kind: "local", name: branch.name, force: false, twin: remoteTwin(branch), branch };
    }
    alsoRemote = false;
    rememberOrigin();
    // 确认框默认把焦点放在安全的「取消」上，破坏性操作必须多走一步。
    confirmDelete = prompt;
  }

  /** 这次删除会访问远程：网络或凭据卡住时允许取消。 */
  let removalRemote = $state(false);
  let abortingRemoval = $state(false);

  function abortRemoval() {
    if (!removalRemote || abortingRemoval) return;
    abortingRemoval = true;
    void api.cancelRemote(opened.summary.path).catch((error: unknown) => {
      abortingRemoval = false;
      onFailure(error);
    });
  }

  async function confirmRemoval() {
    const currentRepo = opened;
    const target = confirmDelete;
    if (!target || blocked) return;
    const twin = target.kind === "local" && alsoRemote ? target.twin : null;
    let remoteFailure: string | null = null;
    removalRemote = target.kind === "remote" || Boolean(twin);
    abortingRemoval = false;
    const result = await write(async () => {
      if (target.kind === "remote") {
        return api.deleteRemoteBranch(currentRepo.summary.path, target.remote, target.name, true, currentRepo.generation, nextId());
      }
      const local = await api.deleteBranch(currentRepo.summary.path, target.name, target.force, currentRepo.generation, nextId());
      if (!twin) return local;
      // 本地已经删掉：远程失败时不回滚，也不把整次操作算作失败，只如实说明哪一半没完成。
      try {
        return await api.deleteRemoteBranch(currentRepo.summary.path, twin.remote, twin.name, true, local.generation, nextId());
      } catch (error) {
        const failure = normalizeError(error);
        remoteFailure = failure.code === "cancelled" ? "已取消。远程可能已经收到请求，请刷新后确认。" : failure.message;
        return local;
      }
    });
    const cancelled = abortingRemoval && (lastFailureCode === "cancelled" || remoteFailure !== null);
    removalRemote = false;
    abortingRemoval = false;
    if (cancelled && !result) {
      confirmDelete = null;
      void restoreOrigin();
      onNotice(
        target.kind === "remote"
          ? `已取消删除远程分支 ${target.remote}/${target.name}。远程可能已经收到请求，列表已刷新为实际状态。`
          : `已取消删除。列表已刷新为实际状态。`,
      );
      void loadBranches();
      return;
    }
    // 只有「未合入」这一种失败才升级为强删确认；其它失败按普通错误处理并收起确认层。
    if (!result && target.kind === "local" && !target.force && lastFailureCode === "branch_unmerged") {
      confirmDelete = { ...target, force: true };
      return;
    }
    confirmDelete = null;
    void restoreOrigin();
    if (!result) return;
    applyBranches(result);
    if (target.kind === "remote") {
      onNotice(`已删除远程分支 ${target.remote}/${target.name}`);
    } else if (twin && remoteFailure) {
      errorText = `本地分支 ${target.name} 已删除；远程分支 ${twin.full} 没有删除：${remoteFailure}`;
    } else if (twin) {
      onNotice(`已删除本地分支 ${target.name} 和远程分支 ${twin.full}`);
    } else {
      onNotice(`已删除本地分支 ${target.name}`);
    }
  }

  /** 切分区统一放弃当前的表单和确认区，切回时不残留；写入在途时结果未定，先不让切。 */
  function selectTab(next: BranchTab) {
    if (next === tab || writeInFlight) return;
    resetCreate();
    confirmDelete = null;
    renaming = null;
    promptOrigin = null;
    tab = next;
  }

  /** 行内按钮的 Enter/空格只属于按钮本身，不能冒泡成切换分支；Esc 等其它键照常上浮到 Modal。 */
  function keepRowKeys(event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }

  function focusTab(key: string) {
    const order = TABS.map((entry) => entry.id);
    const index = order.indexOf(tab);
    const next = key === "ArrowRight" ? (index + 1) % order.length : (index - 1 + order.length) % order.length;
    selectTab(order[next]);
    document.getElementById(`branch-tab-${tab}`)?.focus();
  }
</script>

<Modal
  title="分支与标签"
  titleId="repo-dialog-title"
  icon="branch"
  size="xl"
  task="branch"
  locked={writeInFlight}
  {returnFocus}
  {onClose}
>
  <div class="branch-status" data-branch-status>
    <Icon name="branch" size={13} />
    <span>当前分支</span>
    <strong title={current.name ?? "游离 HEAD"}>{current.name ?? "游离 HEAD"}</strong>
    <span class="branch-status-upstream" title={current.upstream ?? undefined}>{current.upstream ? `跟踪 ${current.upstream}` : "尚未关联上游分支"}</span>
    {#if current.upstream}
      <span class="branch-status-sync" title={`待推送 ${current.ahead ?? 0} 个提交`}><Icon name="arrow-up" size={12} />{current.ahead ?? 0}</span>
      <span class="branch-status-sync" title={`待拉取 ${current.behind ?? 0} 个提交`}><Icon name="arrow-down" size={12} />{current.behind ?? 0}</span>
    {/if}
  </div>

  <div class="segmented" role="tablist" aria-label="分支与标签分区">
    {#each TABS as entry (entry.id)}
      <button
        type="button"
        role="tab"
        id={`branch-tab-${entry.id}`}
        aria-selected={tab === entry.id}
        aria-disabled={writeInFlight && tab !== entry.id ? "true" : undefined}
        title={writeInFlight && tab !== entry.id ? "写入完成后才能切换分区" : undefined}
        aria-controls="branch-tab-panel"
        tabindex={tab === entry.id ? 0 : -1}
        onclick={() => selectTab(entry.id)}
        onkeydown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          focusTab(event.key);
        }}
      >
        <Icon name={entry.icon} size={12} />{entry.label}
        {#if entry.id === "local" && listReady}<span class="count">{localCount}</span>{/if}
        {#if entry.id === "remote" && listReady}<span class="count">{remoteCount}</span>{/if}
      </button>
    {/each}
  </div>

  <div id="branch-tab-panel" class="branch-panel" role="tabpanel" aria-labelledby={`branch-tab-${tab}`} data-branch-panel={tab}>
    {#if tab === "tags"}
      <TagManager
        bind:writing={tagWriting}
        {opened}
        disabled={blocked}
        {backgroundClone}
        {onBusy}
        {onSnapshot}
        {onFailure}
        {onNotice}
        onOpenHistory={(query) => {
          onClose();
          onOpenHistory?.(query);
        }}
        {nextId}
      />
    {:else if creating}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <form
        id="branch-create-form"
        class="branch-create"
        data-branch-create
        onsubmit={(event) => {
          event.preventDefault();
          void createNamedBranch();
        }}
        onkeydown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (!writing) void closeCreate();
        }}
      >
        <label class="label" for="branch-name">新建分支</label>
        <!-- 不随 blocked 禁用：打开时列表正在读取，禁用会把刚给的焦点弄丢；提交本身由 run 拦住。 -->
        <input
          id="branch-name"
          class="input"
          data-autofocus
          readonly={writing}
          bind:this={nameInput}
          bind:value={branchName}
          placeholder="例如 feature/login"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="branch-create-options">
          <div class="branch-base">
            <span id="branch-base-label">起点</span>
            <BranchPicker
              label="新分支的起点"
              size="md"
              branches={branches.filter((branch) => !branch.current)}
              value={createBase}
              current={null}
              {defaultBranch}
              mainBranches={[...mainNames]}
              extras={[{ value: "", label: `当前${current.name ? "分支" : "提交"}（${current.name ?? "游离 HEAD"}）`, icon: "branch" }]}
              disabled={blocked}
              {branchGroups}
              onChange={(name) => (createBase = name)}
            />
          </div>
          <label class="switch branch-checkout">
            <input type="checkbox" bind:checked={createCheckout} title={blocked ? BUSY_REASON : undefined} disabled={blocked} />
            <span>创建后切换过去</span>
          </label>
        </div>
        <p class="hint">{createCheckout ? "切换沿用分支切换的保护：会覆盖未提交修改时停下，工作区保持原样。" : "只创建分支，当前分支和工作区都不变。"}</p>
        <div class="create-form-actions">
          <button type="button" class="btn btn-secondary" title={writing ? BUSY_REASON : undefined} disabled={writing} onclick={closeCreate}>取消</button>
          <button type="submit" class="btn btn-primary" title={blocked ? BUSY_REASON : branchName.trim().length === 0 ? "先填写分支名称" : undefined} disabled={blocked || branchName.trim().length === 0}>
            <Icon name="plus" size={14} />{createCheckout ? "创建并切换" : "创建分支"}
          </button>
        </div>
      </form>
    {:else}
      <div class="branch-manager-tools" hidden={prompting}>
        <div class="field branch-search">
          <Icon name="search" size={14} />
          <label class="sr-only" for="branch-search">搜索分支</label>
          <input
            id="branch-search"
            data-autofocus
            bind:this={searchInput}
            bind:value={branchQuery}
            placeholder={`搜索${listScope === "local" ? "本地" : "远程"}分支`}
            autocomplete="off"
            spellcheck="false"
            onkeydown={(event) => {
              if (event.key === "Escape" && branchQuery) {
                event.preventDefault();
                event.stopPropagation();
                branchQuery = "";
              }
            }}
          />
          {#if branchQuery}
            <button type="button" class="field-clear" aria-label="清空分支搜索" onclick={() => { branchQuery = ""; searchInput?.focus(); }}><Icon name="x" size={12} /></button>
          {/if}
        </div>
        <button
          type="button"
          class="btn btn-secondary branch-refresh"
          aria-label="刷新分支列表"
          title={readBlocked ? BUSY_REASON : "重新读取本地和远程分支（远程分支以最近一次获取为准）"}
          disabled={readBlocked || !listReady || refreshing}
          onclick={refresh}
        >
          {#if refreshing || (!listReady && !listFailed)}<span class="spinner"></span>{:else}<Icon name="refresh" size={14} />{/if}
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          aria-expanded="false"
          aria-controls="branch-create-form"
          bind:this={createToggle}
          onclick={() => openCreate()}
        >
          <Icon name="plus" size={14} />新建分支
        </button>
      </div>

      <div class="list-box branch-list" aria-label={listScope === "local" ? "本地分支" : "远程分支"} bind:this={listBox} hidden={prompting}>
        <div class="list-section">
          <span>{listScope === "local" ? "本地分支" : "远程分支"}</span>
          <span class="spacer"></span>
          {#if listReady}<span>{visibleBranches.length} 个结果</span>{/if}
        </div>
        {#if listFailed}
          <div class="empty compact branch-empty">
            <span class="empty-icon"><Icon name="alert-circle" size={20} /></span>
            <strong>没有读到分支列表</strong>
            <button type="button" class="btn btn-secondary btn-sm" title={readBlocked ? BUSY_REASON : undefined} disabled={readBlocked} onclick={retryLoad}>重试</button>
          </div>
        {:else if !listReady}
          <div class="empty compact branch-empty" data-branch-loading>
            <span class="empty-icon"><span class="spinner"></span></span>
            <strong>正在读取分支</strong>
          </div>
        {:else if visibleBranches.length === 0}
          <div class="empty compact branch-empty">
            <span class="empty-icon"><Icon name="search" size={20} /></span>
            <strong>没有匹配的分支</strong>
            <p>换一个关键词，或清空搜索后再试。</p>
          </div>
        {:else}
          {#snippet branchRow(branch: BranchRecord)}
            {@const occupied = elsewhereReason(branch)}
            <div
              class="list-row branch-row"
              class:current={branch.current}
              role="button"
              tabindex="0"
              aria-label={rowLabel(branch)}
              aria-disabled={branch.current || (blocked && !occupied) ? "true" : undefined}
              aria-haspopup={occupied ? "menu" : undefined}
              title={branch.current ? "当前正在使用的分支" : occupied ? `${occupied}
点击查看可用操作：打开或删除这个工作区` : blocked ? (blockedReason ?? BUSY_REASON) : `点击切换到 ${branch.name}`}
              onclick={(event) => {
                // 被其他工作区占用的分支切不过来：点它直接给出能做的事，而不是什么也不发生。
                if (occupied) {
                  const rect = event.currentTarget.getBoundingClientRect();
                  branchMenu(branch, { x: Math.max(rect.left + 24, rect.right - 280), y: rect.bottom - 4 });
                  return;
                }
                if (!branch.current) void switchTo(branch.name);
              }}
              oncontextmenu={(event) => {
                event.preventDefault();
                branchMenu(branch, { x: event.clientX, y: event.clientY });
              }}
              onkeydown={(event) => {
                if (isContextKey(event)) {
                  event.preventDefault();
                  branchMenu(branch, pointFor(event.currentTarget));
                  return;
                }
                if (occupied && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  branchMenu(branch, pointFor(event.currentTarget));
                  return;
                }
                if (!branch.current && !occupied && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  void switchTo(branch.name);
                }
              }}
            >
              <span class="branch-row-icon" class:main={mainNames.has(branch.name)} title={mainNames.has(branch.name) ? "主干分支" : undefined}>
                <Icon name={mainNames.has(branch.name) ? "star" : branch.current ? "check-circle" : branch.remote ? "cloud" : occupied ? "folder" : "branch"} size={16} />
              </span>
              <div class="lr-main">
                <span class="lr-title">
                  <span title={branch.name}>{branch.name}</span>
                  {#if branch.merged}<span class="merged-badge" data-merged-branch role="img" aria-label="已合入主干" title={`已合入主干：${mergedNote()}`}><Icon name="check" size={10} /></span>{/if}
                  {#if isDefault(branch)}<span class="chip default-branch" data-default-branch>默认</span>{/if}
                  {#if branch.current}<span class="chip current">当前</span>{/if}
                  {#if branch.worktree && !branch.current}<span class="chip">其他工作区</span>{/if}

                </span>
                <span class="lr-sub">
                  {#if branch.upstream}上游 {branch.upstream}{:else if branch.worktree}工作区 {branch.worktree}{:else if branch.remote}远程跟踪分支{:else}仅存在于本地{/if}
                </span>
              </div>
              <span class="lr-actions">
                <button
                  type="button"
                  class="icon-btn sm"
                  aria-label={`${branch.name} 的更多操作`}
                  aria-haspopup="menu"
                  title="更多操作：新建、合并、重命名、复制、删除"
                  onclick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    branchMenu(branch, { x: rect.right - 232, y: rect.bottom + 4 });
                  }}
                  onkeydown={keepRowKeys}
                >
                  <Icon name="more" size={14} />
                </button>
                {#if occupied && branch.worktree}
                  {@const removeReason = worktreeRemoveReason(branch.worktree)}
                  <!-- 占用中的分支删不掉；行尾的删除换成「删除它所在的工作区」，原因写在提示里。 -->
                  <button
                    type="button"
                    class="icon-btn sm danger"
                    aria-label={`删除工作区 ${worktreeName(branch.worktree)}`}
                    title={removeReason ?? (blocked ? (blockedReason ?? BUSY_REASON) : `删除工作区 ${branch.worktree}（分支和提交保留）`)}
                    disabled={blocked || Boolean(removeReason)}
                    onclick={(event) => {
                      event.stopPropagation();
                      askRemoveWorktree(branch);
                    }}
                    onkeydown={keepRowKeys}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                {:else if !branch.current}
                  <button
                    type="button"
                    class="icon-btn sm danger"
                    aria-label={branch.remote ? `删除远程 ${branch.name}` : `删除 ${branch.name}`}
                    title={branch.remote ? "删除远程分支" : "删除本地分支"}
                    disabled={blocked}
                    onclick={(event) => {
                      event.stopPropagation();
                      void askDelete(branch);
                    }}
                    onkeydown={keepRowKeys}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                {/if}
              </span>
            </div>
          {/snippet}
          {#each buckets.top as branch (branch.name)}
            {@render branchRow(branch)}
          {/each}
          {#each buckets.groups as group (group.prefix)}
            {@const open = groupOpen(group.prefix, group.branches)}
            <button
              type="button"
              class="branch-group"
              data-branch-group={group.prefix}
              aria-expanded={open}
              aria-label={`${open ? "收起" : "展开"}分组 ${group.prefix}`}
              onclick={() => toggleGroup(group.prefix, group.branches)}
            >
              <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
              <span>{group.prefix}</span>
              <span class="count">{group.branches.length}</span>
            </button>
            {#if open}
              {#each group.branches as branch (branch.name)}
                {@render branchRow(branch)}
              {/each}
            {/if}
          {/each}
        {/if}
      </div>

      {#if renaming}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="callout branch-rename" data-branch-rename onkeydown={onPromptKey}>
          <Icon name="pencil" size={15} />
          <div class="callout-body">
            <label class="label" for="branch-rename">重命名本地分支 {renaming.name}</label>
            <div class="row">
              <input
                id="branch-rename"
                class="input"
                bind:this={renameInput}
                bind:value={renaming.value}
                autocomplete="off"
                spellcheck="false"
                readonly={writing}
                onkeydown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void confirmRename();
                  }
                }}
              />
              <button type="button" class="btn btn-secondary btn-sm" title={writing ? BUSY_REASON : undefined} disabled={writing} onclick={cancelPrompt}>取消</button>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                title={blocked ? BUSY_REASON : renaming.value.trim().length === 0 || renaming.value.trim() === renaming.name ? "先填写新的分支名称" : undefined}
                disabled={blocked || renaming.value.trim().length === 0 || renaming.value.trim() === renaming.name}
                onclick={() => {
                  renameInput?.focus();
                  void confirmRename();
                }}
              >确认重命名</button>
            </div>
            <p class="hint">只改本地分支名；已关联的上游配置随之保留，远程上的同名分支不会改动。</p>
          </div>
        </div>
      {/if}

    {/if}
    {#if errorText}
      <div class="callout error" role="alert"><Icon name="alert-circle" size={15} /><span>{errorText}</span></div>
    {/if}
    {#if mismatch && errorText}
      {@const info = mismatch}
      <div class="branch-mismatch-actions">
        <span>可以用新的本地名检出 <code>{info.remote}</code>，原来的 <code>{info.local}</code> 不受影响。</span>
        <button type="button" class="btn btn-primary btn-sm" disabled={blocked} title={blocked ? (blockedReason ?? BUSY_REASON) : `新建本地分支 ${info.suggested} 并跟踪 ${info.remote}`} onclick={() => void trackAs(info.remote, info.suggested)}><Icon name="branch" size={13} />检出为 {info.suggested}</button>
      </div>
    {/if}
  </div>
  {#if menu}
    <ContextMenu request={menu} onClose={() => (menu = null)} />
  {/if}
  {#if confirmDelete && deletePrompt}
    {@const target = confirmDelete}
    <ConfirmDialog
      title={deletePrompt.title}
      titleId="branch-delete-title"
      message={deletePrompt.message}
      targets={deletePrompt.targets}
      targetsLabel="要删除的分支"
      notes={deletePrompt.notes}
      confirmLabel={deletePrompt.confirm}
      confirmIcon="trash"
      busy={writing}
      confirmBlocked={blocked && !writing ? (blockedReason ?? BUSY_REASON) : null}
      focusKey={target.force}
      impact="branch-delete"
      onConfirm={() => void confirmRemoval()}
      onCancel={cancelPrompt}
      onAbort={removalRemote ? abortRemoval : undefined}
      aborting={abortingRemoval}
    >
      {#if target.kind === "local" && target.twin}
        <label class="confirm-option">
          <input type="checkbox" class="checkbox" bind:checked={alsoRemote} title={writing ? BUSY_REASON : undefined} disabled={writing} />
          <span>同时删除远程分支 <code>{target.twin.full}</code><small>本地和远程同名；勾选后也会从远程移除，其他协作者将看不到它</small></span>
        </label>
      {/if}
    </ConfirmDialog>
  {/if}
  {#if worktreePrompt}
    {@const prompt = worktreePrompt}
    <ConfirmDialog
      title={prompt.force ? "强制删除工作区" : "删除工作区"}
      titleId="branch-worktree-remove-title"
      message={prompt.force
        ? "这个工作区里有未提交的改动或未跟踪文件。强制删除会把它们一起删掉。"
        : `删除分支 ${prompt.branch.name} 所在的工作区目录？`}
      targets={[{ icon: "folder", name: worktreeName(prompt.path), detail: prompt.path, tag: prompt.branch.name, tagTone: "info" }]}
      targetsLabel="要删除的工作区"
      notes={[
        ...(prompt.force ? [{ tone: "warn" as const, text: "未提交的改动和未跟踪文件会被永久删除，本应用不能恢复。" }] : []),
        alsoDeleteBranch
          ? { tone: "info" as const, text: `随后删除本地分支 ${prompt.branch.name}；它有未合入当前分支的提交时会保留并说明。` }
          : { tone: "ok" as const, text: `分支 ${prompt.branch.name} 和已有提交都保留在仓库里，可以随时重新检出。` },
        { tone: "info" as const, text: "由仓库执行 git worktree remove；锁定的工作区不会被删除。" },
      ]}
      confirmLabel={prompt.force ? "强制删除" : alsoDeleteBranch ? "删除工作区和分支" : "删除工作区"}
      confirmIcon="trash"
      busy={writing}
      error={prompt.error}
      confirmBlocked={blocked && !writing ? (blockedReason ?? BUSY_REASON) : null}
      focusKey={prompt.force}
      impact="worktree-remove"
      onConfirm={() => void confirmRemoveWorktree()}
      onCancel={cancelWorktreePrompt}
    >
      {#if !prompt.branch.remote}
        <label class="confirm-option">
          <input type="checkbox" class="checkbox" bind:checked={alsoDeleteBranch} title={writing ? BUSY_REASON : undefined} disabled={writing} />
          <span>同时删除本地分支 <code>{prompt.branch.name}</code><small>只删除已合入当前分支的分支；有未合入提交时保留并说明</small></span>
        </label>
      {/if}
    </ConfirmDialog>
  {/if}
  {#snippet footer()}
    <span class="spacer"></span>
    <button type="button" class="btn btn-secondary" disabled={writeInFlight} title={writeInFlight ? "写入完成后才能关闭" : undefined} onclick={onClose}>关闭</button>
  {/snippet}
</Modal>
