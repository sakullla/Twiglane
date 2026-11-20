<script module lang="ts">
  /** 从外部（标题栏项目菜单右键）带进来的意图：直接定位到某个项目，并展开对应动作。 */
  export interface ProjectManagerFocus {
    id: string;
    action?: "rename" | "members" | "delete" | null;
  }
</script>

<script lang="ts">
  import { tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { api, pickDirectories, pickDirectory, pickFile, saveWorkspaceFile } from "../api";
  import { normalizeError } from "../errors";
  import type { RepoHead } from "../types";
  import { hueOf } from "../ui";
  import {
    addCandidates,
    checkoutKey,
    projectInitial,
    type Project,
    type Projects,
    type WorkspaceCandidate,
    type WorkspaceManifest,
    type WorkspacePreview,
    type WorkspaceRepository,
  } from "../workspaces";
  import ContextMenu, { type ContextMenuEntry, type ContextMenuRequest } from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  /**
   * 项目管理：左侧是全部项目（搜索、新建、打开共享清单），右侧是选中项目的详情与成员仓库。
   * 管理页里「看哪个项目」与标题栏的「当前范围」分开：浏览、改名、整理成员都不会悄悄切换范围，
   * 只有「设为当前范围」才改变标题栏。项目与成员行都有应用自己的右键菜单。
   */
  interface Props {
    data: Projects;
    /** 标题栏当前选中的项目范围。 */
    selectedId: string | null;
    currentPath?: string | null;
    initialPreview?: WorkspacePreview | null;
    /** 打开时直接定位的项目与动作。 */
    focus?: ProjectManagerFocus | null;
    nextId: () => number;
    onData: (data: Projects) => void;
    onSelect: (id: string | null) => void;
    onOpenRepo?: (path: string) => void;
    onConsumeInitialPreview?: () => void;
    onClose: () => void;
  }

  let {
    data,
    selectedId,
    currentPath = null,
    initialPreview = null,
    focus = null,
    nextId,
    onData,
    onSelect,
    onOpenRepo,
    onConsumeInitialPreview,
    onClose,
  }: Props = $props();

  // 管理页里正在查看的项目：与标题栏范围分开。
  let viewId = $state<string | null>(null);
  let viewSeeded = false;
  $effect(() => {
    if (viewSeeded) return;
    viewSeeded = true;
    viewId = focus?.id ?? selectedId ?? data.projects[0]?.manifest.workspaceId ?? null;
  });
  $effect(() => {
    // 查看中的项目被删除或不存在时，落到第一个项目。
    if (viewId !== null && !data.projects.some((p) => p.manifest.workspaceId === viewId)) {
      viewId = data.projects[0]?.manifest.workspaceId ?? null;
    }
  });
  let project = $derived(data.projects.find((p) => p.manifest.workspaceId === viewId) ?? null);

  let projectQuery = $state("");
  let name = $state("");
  let query = $state("");
  let memberFilter = $state<"all" | "favorites" | "broken">("all");
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  const busyReason = $derived(busy ? `${busy}，请等待完成后再操作。` : undefined);
  const editReason = $derived(busyReason ?? (project?.error ? "请先刷新或重新预览清单，确认来源后再修改名单。" : undefined));
  let notice = $state<string | null>(null);
  let preview = $state<WorkspacePreview | null>(null);
  /** 预览里的来源仓库：只有用户接受关联后才执行一次，取消即作废。 */
  let pendingSourceId = $state<string | null>(null);
  /** 待执行的续接意图；等待项目数据就绪后一次性消费。 */
  let sourceIntent = $state<{ workspaceId: string; repositoryId: string } | null>(null);
  let adopt = $state(false);
  const CANDIDATES_PER_PAGE = 100;
  let candidatePage = $state(0);
  let candidates = $state.raw<WorkspaceCandidate[]>([]);
  let candidateQuery = $state("");
  const matchingCandidates = $derived.by(() => {
    const tokens = candidateQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return candidates;
    return candidates.filter((candidate) =>
      tokens.every((token) => [candidate.name, candidate.path].some((text) => text.toLocaleLowerCase().includes(token))),
    );
  });
  $effect(() => {
    void matchingCandidates;
    candidatePage = 0;
  });
  const pageCount = $derived(Math.ceil(matchingCandidates.length / CANDIDATES_PER_PAGE));
  const pageCandidates = $derived(matchingCandidates.slice(candidatePage * CANDIDATES_PER_PAGE, (candidatePage + 1) * CANDIDATES_PER_PAGE));
  const chosen = new SvelteSet<string>();
  let repairId = $state<string | null>(null);
  let cancelRequested = $state(false);
  let creating = $state(false);
  let renaming = $state(false);
  let renameValue = $state("");
  let confirmDelete = $state(false);
  let memberHeads = $state.raw<Map<string, RepoHead>>(new Map());
  let menu = $state<ContextMenuRequest | null>(null);
  let memberSearch = $state<HTMLInputElement | null>(null);

  let nameInput = $state<HTMLInputElement | null>(null);

  /** 打开新建表单：搜索框里已有、但没匹配到项目的文字直接作为名称带入。 */
  function startCreate(seed = "") {
    preview = null;
    confirmDelete = false;
    renaming = false;
    if (seed.trim() && !name.trim()) name = seed.trim();
    creating = true;
    void tick().then(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  }

  function cancelCreate() {
    creating = false;
    name = "";
  }

  // 外部意图只执行一次：改名、编辑成员或删除确认。
  let focusApplied = false;
  $effect(() => {
    if (focusApplied || !focus || !project || project.manifest.workspaceId !== focus.id) return;
    focusApplied = true;
    if (focus.action === "rename") startRename();
    else if (focus.action === "delete") confirmDelete = true;
    else if (focus.action === "members") void tick().then(() => memberSearch?.focus());
  });

  // 入站 twiglane://workspace 链接只做一次性预览移交：收到后立即消费父层意图，关闭重开不会复现旧预览。
  // v2 链接还带来源仓库：已关联时直接续接，否则在用户接受关联后续接同一仓库。
  $effect(() => {
    const incoming = initialPreview;
    if (!incoming) return;
    onConsumeInitialPreview?.();
    const workspaceId = incoming.manifest.workspaceId;
    if (incoming.attached && !incoming.conflict) {
      // 名单与本机一致：不为同一次交接重复弹预览，直接定位来源仓库。
      view(workspaceId);
      onSelect(workspaceId);
      if (incoming.sourceRepositoryId) sourceIntent = { workspaceId, repositoryId: incoming.sourceRepositoryId };
      return;
    }
    preview = incoming;
    adopt = false;
    creating = false;
    confirmDelete = false;
    pendingSourceId = incoming.sourceRepositoryId ?? null;
  });

  // 来源仓库意图只执行一次：等这份名单出现在最新项目数据里，再续接或进入修复上下文。
  $effect(() => {
    const intent = sourceIntent;
    if (!intent) return;
    if (!data.projects.some((item) => item.manifest.workspaceId === intent.workspaceId)) return;
    sourceIntent = null;
    void resumeSource(intent.workspaceId, intent.repositoryId);
  });

  // 只读各成员本机位置的 HEAD 元数据，立刻标出磁盘上已不存在的目录，不启动 Git 子进程。
  $effect(() => {
    const current = project;
    const host = data.hostId;
    memberHeads = new Map();
    if (!current || typeof api.repoHeads !== "function") return;
    const paths = [
      ...new Set(
        current.manifest.repositories.flatMap((repo) =>
          repo.locations.filter((location) => location.hostId === host).map((location) => location.path),
        ),
      ),
    ];
    if (paths.length === 0) return;
    let alive = true;
    void Promise.resolve(api.repoHeads(paths))
      .then((heads) => {
        if (!alive || !Array.isArray(heads)) return;
        memberHeads = new Map(heads.map((head) => [checkoutKey(head.path), head]));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  });

  const initial = projectInitial;

  const visibleProjects = $derived.by(() => {
    const tokens = projectQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return data.projects;
    return data.projects.filter((item) => {
      const hay = [item.manifest.name, item.sourcePath ?? "", ...item.manifest.repositories.map((repo) => repo.name)].map((text) => text.toLocaleLowerCase());
      return tokens.every((token) => hay.some((text) => text.includes(token)));
    });
  });

  function localLocationsOf(repo: WorkspaceRepository) {
    return repo.locations.filter((location) => location.hostId === data.hostId);
  }

  function isLocationMissing(path: string): boolean {
    return memberHeads.get(checkoutKey(path))?.missing === true;
  }

  function validLocalPath(repo: WorkspaceRepository): string | null {
    return localLocationsOf(repo).find((location) => !isLocationMissing(location.path))?.path ?? null;
  }

  function isRepoBroken(repo: WorkspaceRepository): boolean {
    const locals = localLocationsOf(repo);
    return locals.length === 0 || locals.some((location) => isLocationMissing(location.path));
  }

  function isRepoCurrent(repo: WorkspaceRepository): boolean {
    if (!currentPath) return false;
    const key = checkoutKey(currentPath);
    return localLocationsOf(repo).some((location) => checkoutKey(location.path) === key);
  }

  function branchOf(repo: WorkspaceRepository): string | null {
    for (const location of localLocationsOf(repo)) {
      const head = memberHeads.get(checkoutKey(location.path));
      if (head?.branch) return head.branch;
    }
    return null;
  }

  const favoriteSet = $derived(new Set(project?.favorites ?? []));
  const favoriteCount = $derived(
    project ? project.manifest.repositories.filter((repo) => favoriteSet.has(repo.id)).length : 0,
  );
  const brokenCount = $derived(
    project ? project.manifest.repositories.filter((repo) => isRepoBroken(repo)).length : 0,
  );

  $effect(() => {
    if (memberFilter === "favorites" && favoriteCount === 0) memberFilter = "all";
    else if (memberFilter === "broken" && brokenCount === 0) memberFilter = "all";
  });

  const filtered = $derived.by(() => {
    if (!project) return [];
    const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matching = project.manifest.repositories.filter((repo) => {
      if (memberFilter === "favorites" && !favoriteSet.has(repo.id)) return false;
      if (memberFilter === "broken" && !isRepoBroken(repo)) return false;
      if (tokens.length === 0) return true;
      const haystacks = [repo.name, ...repo.locations.map((location) => location.path)].map((text) =>
        text.toLocaleLowerCase(),
      );
      return tokens.every((token) => haystacks.some((text) => text.includes(token)));
    });
    return [...matching].sort((a, b) => Number(favoriteSet.has(b.id)) - Number(favoriteSet.has(a.id)));
  });

  async function run(label: string, action: () => Promise<void>) {
    if (busy) return;
    busy = label;
    error = null;
    notice = null;
    try {
      await action();
    } catch (failure) {
      error = normalizeError(failure).message;
    } finally {
      busy = null;
    }
  }

  function accept(next: Projects) {
    onData(next);
  }

  function view(id: string | null) {
    if (id === viewId) return;
    viewId = id;
    candidates = [];
    chosen.clear();
    query = "";
    memberFilter = "all";
    renaming = false;
    confirmDelete = false;
    repairId = null;
  }

  async function create() {
    await run("正在创建项目", async () => {
      const next = await api.workspaceCreate(name);
      accept(next);
      const created = next.projects.at(-1)?.manifest.workspaceId ?? null;
      view(created);
      name = "";
      creating = false;
      notice = "已创建项目。用「批量选择仓库」或「从目录发现」纳入仓库。";
    });
  }

  async function openManifest() {
    await run("正在预览清单", async () => {
      const path = await pickFile("打开与 Cliora 共用的项目清单");
      if (!path) return;
      preview = await api.workspacePreview(path);
      pendingSourceId = null;
      creating = false;
      adopt = false;
    });
  }

  /** 取消预览即作废来源仓库意图：离开再回来不会自动打开任何仓库。 */
  function cancelPreview() {
    preview = null;
    pendingSourceId = null;
    adopt = false;
  }

  /**
   * 深链续接：来源仓库本机可用就走既有打开流程；位置失效或没有本机位置时留在该成员行，
   * 说明原因并给出重新关联入口，不用另一个仓库顶替，也不执行任何 Git 写操作。
   */
  async function resumeSource(workspaceId: string, repositoryId: string) {
    view(workspaceId);
    onSelect(workspaceId);
    const target = data.projects.find((item) => item.manifest.workspaceId === workspaceId) ?? null;
    const repo = target?.manifest.repositories.find((item) => item.id === repositoryId) ?? null;
    if (!repo) {
      error = "这份项目名单里没有链接指定的仓库，未打开任何仓库。";
      return;
    }
    const locals = repo.locations.filter((location) => location.hostId === data.hostId);
    const heads = locals.length > 0 && typeof api.repoHeads === "function"
      ? await Promise.resolve(api.repoHeads(locals.map((location) => location.path))).catch(() => [])
      : [];
    const alive = new Set(heads.filter((head) => head && !head.missing).map((head) => checkoutKey(head.path)));
    const path = locals.find((location) => alive.has(checkoutKey(location.path)))?.path ?? null;
    if (!path) {
      error = `来源仓库「${repo.name}」在本机没有可用位置，请在成员行重新关联这个目录。`;
      await tick();
      focusMember(repositoryId);
      return;
    }
    onOpenRepo?.(path);
  }

  /** 定位到成员行并落到它当前可用的主操作：可打开时是「打开」，位置失效时是「重新关联目录」。 */
  function focusMember(repositoryId: string) {
    if (query.trim()) query = "";
    if (memberFilter !== "all") memberFilter = "all";
    const row = document.querySelector<HTMLElement>(`[data-workspace-manager] [data-repository-id="${CSS.escape(repositoryId)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    const target = row.querySelector<HTMLElement>(".member-actions .project-member-primary")
      ?? row.querySelector<HTMLElement>(".member-actions .project-member-repair")
      ?? row.querySelector<HTMLElement>(".member-actions button");
    target?.focus({ preventScroll: true });
  }

  async function attach() {
    const observed = preview;
    if (!observed) return;
    const source = pendingSourceId;
    const workspaceId = observed.manifest.workspaceId;
    await run("正在关联清单", async () => {
      accept(await api.workspaceAttach(observed, adopt));
      view(workspaceId);
      preview = null;
      pendingSourceId = null;
      notice = "已关联。以后打开项目、窗口获焦或刷新会重新读取这份名单。";
      // 接受关联后继续同一来源仓库：不要求用户再搜索一次项目或仓库。
      if (source) sourceIntent = { workspaceId, repositoryId: source };
    });
  }

  async function removeProject(target: Project | null = project) {
    if (!target) return;
    const wasShared = Boolean(target.sourcePath);
    const wasScope = target.manifest.workspaceId === selectedId;
    await run(wasShared ? "正在取消关联清单" : "正在移除本地项目", async () => {
      const next = await api.workspaceDelete(target.manifest.workspaceId);
      accept(next);
      confirmDelete = false;
      candidates = [];
      chosen.clear();
      query = "";
      renaming = false;
      memberFilter = "all";
      const fallback = next.projects[0]?.manifest.workspaceId ?? null;
      viewId = fallback;
      if (wasScope) onSelect(fallback);
      notice = wasShared
        ? "已取消关联清单；磁盘上的 .dev-workspace.json 文件、各仓库与草稿均已保留。"
        : "已移除本地项目；各仓库目录、Git 历史与草稿均已保留。";
    });
  }

  async function save(manifest: WorkspaceManifest) {
    accept(await api.workspaceUpdate(manifest, manifest.revision));
  }

  function startRename() {
    if (!project) return;
    renameValue = project.manifest.name;
    renaming = true;
    confirmDelete = false;
  }

  function submitRename() {
    const current = project;
    const title = renameValue.trim();
    if (!current || !title) return;
    if (title === current.manifest.name) {
      renaming = false;
      return;
    }
    void run("正在修改名称", async () => {
      await save({ ...current.manifest, name: title });
      renaming = false;
    });
  }

  function refreshProject(target: Project) {
    void run("正在刷新项目", async () => accept(await api.workspaceRefresh(target.manifest.workspaceId)));
  }

  function publish(target: Project) {
    void run("正在发布清单", async () => {
      const path = await saveWorkspaceFile();
      if (path) {
        accept(await api.workspacePublish(target.manifest.workspaceId, target.manifest.revision, path));
        notice = "已发布。请在 Cliora 打开这同一份项目清单。";
      }
    });
  }

  /** 来源仓库直达：链接带上这份清单里的成员仓库 ID，项目级入口不再冒充单个仓库。 */
  function openInCliora(target: Project, repositoryId: string) {
    void run("正在唤起 Cliora", async () => {
      await api.workspaceOpenInCliora(target.sourcePath!, repositoryId);
      notice = "已请求在 Cliora 中定位这个来源仓库（只请求预览，不自动关联）。";
    });
  }

  async function choosePaths(discover: boolean, repositoryId: string | null = null) {
    repairId = repositoryId;
    await run(discover ? "正在发现仓库" : "正在检查仓库", async () => {
      cancelRequested = false;
      if (discover) {
        const root = await pickDirectory("选择发现根目录（只扫描此目录，不跟随目录链接）");
        if (!root || cancelRequested) return;
        const result = await api.workspaceDiscover(root, nextId());
        candidates = result.candidates;
        notice = result.cancelled
          ? "已取消发现，未添加任何仓库。"
          : result.partial
            ? "发现未完成全部目录（权限或扫描预算限制），下面仅为已确认候选。"
            : `发现 ${candidates.length} 个候选，选择后再纳入项目。`;
      } else {
        const paths = repositoryId ? [await pickDirectory("重新关联此仓库的本机目录")] : await pickDirectories();
        const valid = paths.filter((path): path is string => Boolean(path));
        if (!valid.length) return;
        candidates = await api.workspaceCandidates(valid, nextId());
      }
      candidateQuery = "";
      chosen.clear();
      for (const candidate of candidates) if (!candidate.error) chosen.add(candidate.path);
    });
  }

  async function add() {
    if (!project) return;
    const current = project;
    await run("正在保存项目成员", async () => {
      const picked = candidates.filter((candidate) => chosen.has(candidate.path) && !candidate.error);
      if (repairId) {
        const candidate = picked[0];
        if (!candidate) return;
        await save({
          ...current.manifest,
          repositories: current.manifest.repositories.map((repo) =>
            repo.id === repairId
              ? {
                  ...repo,
                  locations: [
                    ...repo.locations.filter((location) => location.hostId !== data.hostId),
                    { hostId: data.hostId, path: candidate.path },
                  ],
                }
              : repo,
          ),
        });
      } else {
        await save(addCandidates(current.manifest, picked, data.hostId));
      }
      candidates = [];
      chosen.clear();
      repairId = null;
      notice = "项目名单已保存，源码与 Git 内容未移动。";
    });
  }

  function removeMember(repo: WorkspaceRepository) {
    const current = project;
    if (!current) return;
    void run("正在移除关联", () =>
      save({ ...current.manifest, repositories: current.manifest.repositories.filter((item) => item.id !== repo.id) }),
    );
  }

  function toggleFavorite(repo: WorkspaceRepository) {
    const current = project;
    if (!current) return;
    const favorite = favoriteSet.has(repo.id);
    void run("正在保存收藏", async () => accept(await api.workspaceFavorite(current.manifest.workspaceId, repo.id, !favorite)));
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      notice = `已复制${label}`;
    } catch {
      error = "无法写入剪贴板，请手动复制。";
    }
  }

  function selectMatching(enabled: boolean) {
    for (const candidate of matchingCandidates) {
      if (candidate.error) continue;
      if (enabled) chosen.add(candidate.path);
      else chosen.delete(candidate.path);
    }
  }

  function toggle(path: string) {
    if (chosen.has(path)) chosen.delete(path);
    else chosen.add(path);
  }

  /** 项目行右键：与详情页顶部同一组动作。 */
  function projectMenu(event: MouseEvent, target: Project) {
    event.preventDefault();
    view(target.manifest.workspaceId);
    const id = target.manifest.workspaceId;
    const editBlocked = busyReason ?? (target.error ? "请先刷新或重新预览清单，确认来源后再修改名单。" : undefined);
    const entries: ContextMenuEntry[] = [
      {
        id: "scope",
        label: id === selectedId ? "已是当前范围" : "设为当前范围",
        icon: "check-circle",
        disabledReason: id === selectedId ? "标题栏已经按这个项目筛选仓库" : busyReason,
        run: () => onSelect(id),
      },
      { separator: true },
      { id: "rename", label: "重命名…", icon: "pencil", disabledReason: editBlocked, run: () => startRename() },
      { id: "members", label: "编辑成员…", icon: "folder-plus", disabledReason: editBlocked, run: () => void tick().then(() => memberSearch?.focus()) },
      { id: "refresh", label: "刷新清单", icon: "refresh", disabledReason: busyReason, run: () => refreshProject(target) },
      // 来源仓库直达只挂在具体成员行：项目本身不冒充某一个仓库。
      ...(target.sourcePath
        ? []
        : [{ id: "publish", label: "发布共享清单…", icon: "upload", disabledReason: busyReason, run: () => publish(target) } as ContextMenuEntry]),
      { separator: true },
      {
        id: "delete",
        label: target.sourcePath ? "取消关联清单…" : "删除项目…",
        icon: "trash",
        danger: true,
        disabledReason: busyReason,
        run: () => {
          renaming = false;
          confirmDelete = true;
        },
      },
    ];
    if (target.sourcePath) entries.splice(entries.length - 2, 0, { id: "copy-source", label: "复制清单路径", icon: "copy", run: () => void copyText(target.sourcePath!, "清单路径") });
    menu = { x: event.clientX, y: event.clientY, entries, label: `${target.manifest.name} 的操作` };
  }

  /** 成员行右键：打开、收藏、复制路径、重新关联、移除。 */
  function memberMenu(event: MouseEvent, repo: WorkspaceRepository) {
    event.preventDefault();
    const openable = validLocalPath(repo);
    const favorite = favoriteSet.has(repo.id);
    const entries: ContextMenuEntry[] = [
      {
        id: "open",
        label: isRepoCurrent(repo) ? "当前仓库" : "打开仓库",
        icon: "folder-open",
        disabledReason: isRepoCurrent(repo) ? "已经是当前仓库" : !openable ? "本机没有可用目录" : !onOpenRepo ? "这里不能打开仓库" : busyReason,
        run: () => openable && onOpenRepo?.(openable),
      },
      { id: "favorite", label: favorite ? "取消收藏" : "收藏（排在切换列表前面）", icon: "star", disabledReason: busyReason, run: () => toggleFavorite(repo) },
    ];
    const first = localLocationsOf(repo)[0]?.path;
    if (first) entries.push({ id: "copy", label: "复制完整路径", icon: "copy", run: () => void copyText(first, "完整路径") });
    if (project?.sourcePath) {
      entries.push({ id: "cliora", label: "在 Cliora 中定位这个仓库", icon: "link", disabledReason: editReason, run: () => openInCliora(project!, repo.id) });
    }
    entries.push({ separator: true });
    entries.push({ id: "relink", label: "重新关联目录…", icon: "folder", disabledReason: editReason, run: () => void choosePaths(false, repo.id) });
    entries.push({ id: "remove", label: "从项目移除", icon: "x", danger: true, disabledReason: editReason, run: () => removeMember(repo) });
    menu = { x: event.clientX, y: event.clientY, entries, label: `${repo.name} 的操作` };
  }

  function quietMenu(event: MouseEvent) {
    const target = event.target as Element | null;
    if (target?.closest?.("input, textarea")) return;
    event.preventDefault();
  }

  function escapeClears(event: KeyboardEvent, clear: () => void, has: boolean) {
    if (event.key === "Escape" && has) {
      event.preventDefault();
      event.stopPropagation();
      clear();
    }
  }
</script>

<Modal
  title="管理项目"
  titleId="workspace-manager-title"
  icon="layers"
  size="xl"
  width="min(1080px, 100%)"
  locked={busy !== null}
  {onClose}
  description="把散落在不同目录的 Git 仓库归到一个项目里；标题栏按项目筛选仓库。与 Cliora 共用时，两端打开同一份 .dev-workspace.json。"
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="pmx" data-workspace-manager oncontextmenu={quietMenu}>
    <aside class="pmx-side" aria-label="项目列表">
      <div class="field sm pmx-side-search">
        <Icon name="search" size={13} />
        <input
          aria-label="搜索项目"
          placeholder={`搜索 ${data.projects.length} 个项目`}
          bind:value={projectQuery}
          onkeydown={(e) => escapeClears(e, () => (projectQuery = ""), projectQuery.length > 0)}
        />
        {#if projectQuery}
          <button type="button" class="field-clear" aria-label="清空项目搜索" onclick={() => (projectQuery = "")}><Icon name="x" size={12} /></button>
        {/if}
      </div>
      <div class="pmx-projects" role="group" aria-label="全部项目">
        {#each visibleProjects as item (item.manifest.workspaceId)}
          {@const id = item.manifest.workspaceId}
          <button
            type="button"
            class="pmx-project"
            class:active={id === viewId}
            aria-current={id === viewId ? "true" : undefined}
            data-project-id={id}
            title={`${item.manifest.name} · ${item.manifest.repositories.length} 个仓库${item.sourcePath ? `\n共享清单：${item.sourcePath}` : ""}\n右键查看更多操作`}
            onclick={() => view(id)}
            oncontextmenu={(event) => projectMenu(event, item)}
          >
            <span class="pm-avatar sm" style={"--hue:" + hueOf(id)} aria-hidden="true">{initial(item.manifest.name)}</span>
            <span class="pmx-project-text">
              <span class="pmx-project-name">{item.manifest.name}</span>
              <span class="pmx-project-meta">{item.manifest.repositories.length} 个仓库{item.sourcePath ? " · 共享" : ""}</span>
            </span>
            {#if item.error}<span class="pmx-dot danger" title={`名单待处理：${item.error}`} aria-label="名单待处理"></span>{/if}
            {#if id === selectedId}<span class="pmx-scope" title="标题栏当前按这个项目筛选">当前</span>{/if}
          </button>
        {:else}
          <p class="pmx-side-empty">{data.projects.length === 0 ? "还没有项目" : "没有匹配的项目"}</p>
        {/each}
      </div>
      <div class="pmx-side-foot">
        <button
          class="btn btn-primary btn-sm"
          disabled={Boolean(busy) || creating}
          title={busyReason ?? (creating ? "正在新建项目" : "新建一个只在本机的项目")}
          onclick={() => startCreate(visibleProjects.length === 0 ? projectQuery : "")}
        ><Icon name="plus" size={13} />新建项目</button>
        <button
          class="btn btn-ghost btn-sm"
          disabled={Boolean(busy)}
          title={busyReason ?? "打开与 Cliora 共用的 .dev-workspace.json"}
          onclick={openManifest}
        ><Icon name="folder-open" size={13} />打开项目清单</button>
      </div>
    </aside>

    <section class="pmx-main">
      {#if error}<p class="pm-msg danger" role="alert"><Icon name="alert-circle" size={14} />{error}</p>{/if}
      {#if notice}<p class="pm-msg ok" role="status"><Icon name="check-circle" size={14} />{notice}</p>{/if}
      {#if busy}
        <p class="pm-msg" role="status">
          <span class="spinner" aria-hidden="true"></span>{busy}…{#if busy === "正在发现仓库"}
            <button
              class="btn btn-ghost btn-sm"
              disabled={cancelRequested}
              title={cancelRequested ? "已请求取消，正在等待当前读取结束。" : "取消后不添加任何仓库。"}
              onclick={() => {
                cancelRequested = true;
                void api.workspaceCancelDiscovery().catch((e) => (error = normalizeError(e).message));
              }}
            >取消发现</button>
          {/if}
        </p>
      {/if}

      {#if preview}
        <section class="pm-panel" aria-label="项目清单预览">
          <header class="pm-panel-head">
            <div>
              <h3>{preview.manifest.name}</h3>
              <small>版本 {preview.manifest.revision} · {preview.manifest.repositories.length} 个仓库 · ID {preview.manifest.workspaceId.slice(0, 8)}</small>
            </div>
          </header>
          <p class="project-path muted">{preview.path}</p>
          <div class="preview-members">
            {#each preview.manifest.repositories as repo (repo.id)}
              <div class="pm-preview-row">
                <strong>{repo.name}</strong>
                {#each repo.locations as location}
                  <span class="project-path">{location.path} <em>{location.hostId !== data.hostId ? "· 其他主机，需重新关联" : "· 本机位置，打开时复核 Git"}</em></span>
                {/each}
              </div>
            {/each}
          </div>
          {#if preview.conflict}
            <label class="pm-confirm"><input type="checkbox" class="checkbox" bind:checked={adopt} /> 同一项目 ID 的名单与本机快照不同，确认以此清单替换本机成员关系</label>
          {/if}
          <div class="pm-actions">
            <button class="btn btn-ghost" disabled={Boolean(busy)} title={busyReason} onclick={cancelPreview}>取消预览</button>
            <button
              class="btn btn-primary"
              disabled={Boolean(busy) || (preview.conflict && !adopt)}
              title={busyReason ?? (preview.conflict && !adopt ? "请先确认用预览名单替换同一项目的本机成员关系。" : undefined)}
              onclick={attach}
            >关联此项目清单</button>
          </div>
        </section>
      {/if}

      {#if creating}
        <form
          class="pmx-create"
          aria-label="新建项目"
          onsubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <span class="pmx-create-icon" aria-hidden="true"><Icon name="layers" size={20} /></span>
          <h3>新建项目</h3>
          <p>起个名字，创建后再把本机的 Git 仓库加进来。</p>
          <input
            class="input"
            aria-label="新项目名称"
            placeholder="例如：电商平台"
            maxlength="160"
            bind:this={nameInput}
            bind:value={name}
            disabled={Boolean(busy)}
            title={busyReason}
            onkeydown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelCreate();
              }
            }}
          />
          <div class="pmx-create-actions">
            <button class="btn btn-ghost" type="button" disabled={Boolean(busy)} title={busyReason} onclick={cancelCreate}>取消</button>
            <button class="btn btn-primary" disabled={Boolean(busy) || !name.trim()} title={busyReason ?? (!name.trim() ? "先填写项目名称" : undefined)} type="submit">
              <Icon name="plus" size={14} />创建项目
            </button>
          </div>
        </form>
      {:else if project}
        {@const current = project}
        <section class="pm-project" aria-label="项目成员">
          <header class="pm-head">
            <span class="pm-avatar" style={"--hue:" + hueOf(current.manifest.workspaceId)} aria-hidden="true">{initial(current.manifest.name)}</span>
            {#if renaming}
              <form
                class="pm-inline pm-rename"
                onsubmit={(e) => {
                  e.preventDefault();
                  submitRename();
                }}
              >
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="input"
                  aria-label="项目显示名称"
                  name="title"
                  bind:value={renameValue}
                  maxlength="160"
                  disabled={Boolean(busy) || Boolean(current.error)}
                  title={editReason}
                  autofocus
                  onkeydown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      renaming = false;
                    }
                  }}
                />
                <button class="btn btn-primary btn-sm" type="submit" disabled={Boolean(busy) || Boolean(current.error) || !renameValue.trim()} title={editReason}>保存名称</button>
                <button class="btn btn-ghost btn-sm" type="button" onclick={() => (renaming = false)}>取消</button>
              </form>
            {:else}
              <div class="pm-title-block">
                <div class="pm-title">
                  <h3 title={current.manifest.name}>{current.manifest.name}</h3>
                  <button
                    class="icon-btn sm"
                    aria-label="修改项目名称"
                    title={editReason ?? "修改项目名称"}
                    disabled={Boolean(busy) || Boolean(current.error)}
                    onclick={startRename}
                  ><Icon name="pencil" size={13} /></button>
                </div>
                <div class="pm-sub">
                  <span class="pm-tag" class:shared={Boolean(current.sourcePath)}>{current.sourcePath ? "共享清单" : "仅本机"}</span>
                  <small>{current.manifest.repositories.length} 个仓库 · 版本 {current.manifest.revision}</small>
                  {#if current.sourcePath}<span class="project-path muted pm-source" title={current.sourcePath}><bdi>{current.sourcePath}</bdi></span>{/if}
                </div>
              </div>
            {/if}
            <div class="pm-head-actions">
              {#if current.manifest.workspaceId === selectedId}
                <span class="pm-scope-on" title="标题栏当前按这个项目筛选仓库"><Icon name="check" size={12} />当前范围</span>
              {:else}
                <button class="btn btn-primary btn-sm" disabled={Boolean(busy)} title={busyReason ?? "标题栏改为按这个项目筛选仓库"} onclick={() => onSelect(current.manifest.workspaceId)}>设为当前范围</button>
              {/if}
              {#if current.sourcePath}
              <button class="btn btn-ghost btn-sm" disabled={Boolean(busy)} title={busyReason ?? "重新读取共享清单"} onclick={() => refreshProject(current)}><Icon name="refresh" size={13} />刷新清单</button>
              {:else}
              <button class="btn btn-ghost btn-sm" disabled={Boolean(busy)} title={busyReason ?? "重新读取本机名单"} onclick={() => refreshProject(current)}><Icon name="refresh" size={13} />刷新清单</button>
              <button class="btn btn-ghost btn-sm" disabled={Boolean(busy)} title={busyReason ?? "另存为 .dev-workspace.json，给 Cliora 或同事共用"} onclick={() => publish(current)}><Icon name="upload" size={13} />发布共享清单</button>
              {/if}
              <button
                class="btn btn-ghost btn-sm btn-danger-soft"
                aria-pressed={confirmDelete}
                disabled={Boolean(busy)}
                title={busyReason ?? (current.sourcePath ? "只取消本机关联，不删除磁盘上的清单文件或仓库" : "只移除项目记录，不删除仓库或提交草稿")}
                onclick={() => (confirmDelete = !confirmDelete)}
              ><Icon name="trash" size={13} />{current.sourcePath ? "取消关联清单" : "移除本地项目"}</button>
            </div>
          </header>
          {#if confirmDelete}
            <section class="pm-panel pm-danger-panel" aria-label={current.sourcePath ? "确认取消关联清单" : "确认移除本地项目"}>
              <p class="pm-danger-copy">
                {#if current.sourcePath}
                  确定取消关联共享清单「{current.manifest.name}」吗？磁盘上的 <code>.dev-workspace.json</code> 文件、各仓库源码、Git 历史与提交草稿都保留不变，随时可重新打开关联。
                {:else}
                  确定移除本地项目「{current.manifest.name}」吗？各仓库源码、Git 历史、最近打开记录与提交草稿都保留不变。
                {/if}
              </p>
              <div class="pm-actions">
                <button class="btn btn-ghost btn-sm" type="button" disabled={Boolean(busy)} title={busyReason} onclick={() => (confirmDelete = false)}>取消</button>
                <button class="btn btn-danger btn-sm" type="button" disabled={Boolean(busy)} title={busyReason} onclick={() => void removeProject(current)}>{current.sourcePath ? "确认取消关联" : "确认移除项目"}</button>
              </div>
            </section>
          {/if}
          {#if current.error}<p class="pm-msg danger" role="alert"><Icon name="alert-circle" size={14} />最后可读快照：{current.error}。可刷新重试，或重新打开清单预览并明确接收。</p>{/if}
          {#if candidates.length}
            <section class="pm-panel" aria-label="候选仓库">
              <header class="pm-panel-head">
                <h4>{repairId ? "选择一个目录替换此仓库的本机位置" : "选择要纳入的仓库"}</h4>
                <small role="status">匹配 {matchingCandidates.length} / {candidates.length} · 已选 {chosen.size}</small>
              </header>
              <div class="pm-inline">
                <div class="field sm pm-search">
                  <Icon name="search" size={13} />
                  <input
                    aria-label="搜索候选仓库"
                    placeholder="搜索候选名称或完整路径"
                    bind:value={candidateQuery}
                    onkeydown={(e) => escapeClears(e, () => (candidateQuery = ""), candidateQuery.length > 0)}
                  />
                  {#if candidateQuery}
                    <button type="button" class="field-clear" aria-label="清空候选搜索" onclick={() => (candidateQuery = "")}><Icon name="x" size={12} /></button>
                  {/if}
                </div>
                {#if !repairId}
                  <button
                    class="btn btn-ghost btn-sm"
                    disabled={Boolean(busy) || !matchingCandidates.some((candidate) => !candidate.error)}
                    title={busyReason ?? "仅选择当前搜索结果，保留筛选外的选择。"}
                    onclick={() => selectMatching(true)}
                  >全选当前结果</button>
                  <button
                    class="btn btn-ghost btn-sm"
                    disabled={Boolean(busy) || !matchingCandidates.some((candidate) => chosen.has(candidate.path))}
                    title={busyReason ?? "仅清除当前搜索结果的选择，保留筛选外的选择。"}
                    onclick={() => selectMatching(false)}
                  >清除当前结果的选择</button>
                {/if}
              </div>
              {#key candidatePage}
              <div class="preview-members candidate-results">
                {#each pageCandidates as candidate, index (`${candidate.path}:${index}`)}
                  <label class="candidate" class:disabled={Boolean(candidate.error)}>
                    <input
                      class="checkbox"
                      type={repairId ? "radio" : "checkbox"}
                      name="candidate"
                      checked={chosen.has(candidate.path)}
                      disabled={Boolean(busy) || Boolean(candidate.error)}
                      title={busyReason ?? candidate.error ?? undefined}
                      onchange={() => {
                        if (repairId) {
                          chosen.clear();
                          chosen.add(candidate.path);
                        } else toggle(candidate.path);
                      }}
                    />
                    <span class="candidate-text">
                      <strong>{candidate.name}</strong>
                      <span class="project-path">{candidate.path}</span>
                      {#if candidate.error}<span class="project-error">{candidate.error}</span>{/if}
                    </span>
                  </label>
                {:else}
                  <p class="project-note">没有匹配的候选，换个名称或路径；筛选外的选择仍然保留。</p>
                {/each}
              </div>
              {/key}
              {#if pageCount > 1}
                <nav class="pm-actions" aria-label="候选仓库分页">
                  <button class="btn btn-ghost btn-sm" disabled={candidatePage === 0} title={candidatePage === 0 ? "已是第一页" : "查看上一页候选"} onclick={() => candidatePage--}>上一页</button>
                  <span>{candidatePage + 1} / {pageCount}</span>
                  <button class="btn btn-ghost btn-sm" disabled={candidatePage + 1 >= pageCount} title={candidatePage + 1 >= pageCount ? "已是最后一页" : "查看下一页候选"} onclick={() => candidatePage++}>下一页</button>
                </nav>
              {/if}
              <div class="pm-actions">
                <button class="btn btn-ghost" disabled={Boolean(busy)} title={busyReason} onclick={() => { candidates = []; chosen.clear(); repairId = null; }}>取消</button>
                <button
                  class="btn btn-primary"
                  disabled={Boolean(busy) || !chosen.size}
                  title={busyReason ?? (!chosen.size ? "请先选择至少一个可读取的仓库目录。" : undefined)}
                  onclick={add}
                >确认{repairId ? "重新关联" : `纳入 ${chosen.size} 个位置`}</button>
              </div>
            </section>
          {/if}
          <div class="pm-inline pm-members-bar">
            <div class="field sm pm-search">
              <Icon name="search" size={13} />
              <input
                aria-label="搜索项目仓库"
                placeholder="搜索仓库名称或完整路径"
                bind:value={query}
                bind:this={memberSearch}
                onkeydown={(e) => escapeClears(e, () => (query = ""), query.length > 0)}
              />
              {#if query}
                <button type="button" class="field-clear" aria-label="清空搜索" onclick={() => (query = "")}><Icon name="x" size={12} /></button>
              {/if}
            </div>
            {#if current.manifest.repositories.length > 0 && (favoriteCount > 0 || brokenCount > 0)}
              <div class="pm-filters" role="group" aria-label="筛选项目成员">
                <button type="button" class="pm-filter-pill" aria-pressed={memberFilter === "all"} onclick={() => (memberFilter = "all")}>全部 {current.manifest.repositories.length}</button>
                {#if favoriteCount > 0}
                  <button type="button" class="pm-filter-pill" aria-pressed={memberFilter === "favorites"} onclick={() => (memberFilter = memberFilter === "favorites" ? "all" : "favorites")}>收藏 {favoriteCount}</button>
                {/if}
                {#if brokenCount > 0}
                  <button type="button" class="pm-filter-pill warn" aria-pressed={memberFilter === "broken"} onclick={() => (memberFilter = memberFilter === "broken" ? "all" : "broken")}>待处理 {brokenCount}</button>
                {/if}
              </div>
            {/if}
            <span class="spacer"></span>
            <!-- 两个纳入入口作为一组换行，窄窗口下不会只剩一个按钮掉到下一行。 -->
            <div class="pm-add-group" role="group" aria-label="纳入仓库">
              <button
                class="btn btn-secondary btn-sm"
                disabled={Boolean(busy) || Boolean(current.error)}
                title={editReason ?? "选择一个或多个本机仓库目录"}
                onclick={() => void choosePaths(false)}
              ><Icon name="plus" size={13} />批量选择仓库</button>
              <button
                class="btn btn-secondary btn-sm"
                disabled={Boolean(busy) || Boolean(current.error)}
                title={editReason ?? "扫描一个目录，列出其中的 Git 仓库再挑选"}
                onclick={() => void choosePaths(true)}
              ><Icon name="search" size={13} />从目录发现</button>
            </div>
          </div>
          <div class="project-members" role="list">
            {#each filtered as repo (repo.id)}
              {@const favorite = favoriteSet.has(repo.id)}
              {@const locals = localLocationsOf(repo)}
              {@const openablePath = validLocalPath(repo)}
              {@const broken = isRepoBroken(repo)}
              {@const isCurrent = isRepoCurrent(repo)}
              {@const branch = branchOf(repo)}
              <article class="project-member" class:broken role="listitem" data-repository-id={repo.id} oncontextmenu={(event) => memberMenu(event, repo)} ondblclick={() => !isCurrent && openablePath && onOpenRepo?.(openablePath)}>
                <span class="pm-badge" style={"--hue:" + hueOf(repo.locations[0]?.path ?? repo.id)} aria-hidden="true">{initial(repo.name)}</span>
                <div class="member-main">
                  <div class="member-title">
                    <strong title={repo.name}>{repo.name}</strong>
                    {#if branch}<span class="pm-branch" title={`当前分支 ${branch}`}><Icon name="branch" size={11} /><span>{branch}</span></span>{/if}
                    {#if isCurrent}<span class="pm-current-badge">当前</span>{/if}
                    {#if repo.locations.length > 1}<small>{repo.locations.length} 个位置</small>{/if}
                  </div>
                  {#each repo.locations as location}
                    <!-- 整行失效时由下方一条说明交代原因，路径后不再重复“目录已缺失”。 -->
                    <span class="project-path" title={location.path}><bdi>{location.path}</bdi>{#if location.hostId !== data.hostId}<em> · 其他主机，暂不可用</em>{:else if !broken && isLocationMissing(location.path)}<em class="missing-note"> · 目录已缺失</em>{/if}</span>
                  {/each}
                  {#if locals.length === 0}
                    <span class="project-error">本机没有位置，请重新关联目录。</span>
                  {:else if broken}
                    <span class="project-error">目录不存在，请重新关联。</span>
                  {/if}
                </div>
                <div class="member-actions">
                  {#if !isCurrent && openablePath && onOpenRepo}
                    <button class="btn btn-secondary btn-sm project-member-primary" disabled={Boolean(busy)} title={busyReason ?? `打开 ${openablePath}`} aria-label={`打开 ${repo.name}`} onclick={() => onOpenRepo(openablePath)}>打开</button>
                  {/if}
                  {#if current.sourcePath}
                    <button
                      class="icon-btn sm"
                      disabled={Boolean(busy) || Boolean(current.error)}
                      aria-label={`在 Cliora 中定位 ${repo.name}`}
                      title={editReason ?? "在 Cliora 中定位这个仓库（携带来源仓库，只请求预览）"}
                      onclick={() => openInCliora(current, repo.id)}
                    ><Icon name="link" size={13} /></button>
                  {/if}
                  {#if broken}
                    <!-- 失效成员的主操作就是修复：用文字按钮而不是含义不明的图标。 -->
                    <button class="btn btn-secondary btn-sm project-member-repair" disabled={Boolean(busy) || Boolean(current.error)} aria-label="重新关联目录" title={editReason ?? "选择本机目录，替换这个仓库已失效的位置"} onclick={() => void choosePaths(false, repo.id)}><Icon name="folder" size={13} />重新关联</button>
                  {:else}
                    <button class="icon-btn sm project-member-repair" disabled={Boolean(busy) || Boolean(current.error)} aria-label="重新关联目录" title={editReason ?? "换成本机另一个目录"} onclick={() => void choosePaths(false, repo.id)}><Icon name="folder" size={13} /></button>
                  {/if}
                  <button class="icon-btn sm danger" disabled={Boolean(busy) || Boolean(current.error)} aria-label="移除项目关联" title={editReason ?? "只从项目名单移除，不删除文件"} onclick={() => removeMember(repo)}><Icon name="x" size={13} /></button>
                </div>
                <button
                  class="icon-btn sm pm-star"
                  class:on={favorite}
                  aria-pressed={favorite}
                  aria-label={`${favorite ? "取消收藏" : "收藏"} ${repo.name}`}
                  disabled={Boolean(busy)}
                  title={busyReason ?? (favorite ? "取消收藏" : "收藏后排在切换列表前面")}
                  onclick={() => toggleFavorite(repo)}
                ><Icon name="star" size={14} /></button>
              </article>
            {:else}
              <div class="pm-empty">
                <Icon name={query || memberFilter !== "all" ? "search" : "folder-plus"} size={20} />
                <p>{query || memberFilter !== "all" ? "没有匹配的仓库，换个搜索词或切换筛选。" : "项目还没有仓库。用「批量选择仓库」或「从目录发现」纳入。"}</p>
              </div>
            {/each}
          </div>
        </section>
      {:else if !preview}
        {#if data.projects.length > 0}
          <div class="pm-empty grow">
            <Icon name="layers" size={24} />
            <p>从左侧选择一个项目，查看和整理它的仓库。</p>
          </div>
        {:else}
          <div class="pm-empty grow">
            <Icon name="layers" size={24} />
            <p>还没有项目。点左下角「新建项目」开始，或打开 Cliora 共用的项目清单。</p>
          </div>
        {/if}
      {/if}
    </section>
  </div>
</Modal>

{#if menu}
  <ContextMenu request={menu} onClose={() => (menu = null)} />
{/if}

<style>
  .pmx { display: grid; grid-template-columns: 248px minmax(0, 1fr); gap: 0; height: min(640px, calc(100vh - 200px)); min-height: 360px; border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; background: var(--surface); }
  .pmx-side { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--surface-2); }
  .pmx-side-search { margin: 10px 10px 6px; }
  .pmx-create { display: flex; flex-direction: column; align-items: center; gap: 10px; width: min(420px, 100%); margin: auto; padding: 28px 24px; text-align: center; }
  .pmx-create { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-2); }
  .pmx-create h3 { margin: 0; font-size: var(--text-md, 15px); font-weight: var(--weight-semibold); }
  .pmx-create p { margin: 0 0 4px; color: var(--fg-muted); font-size: var(--text-sm); }
  .pmx-create .input { width: 100%; height: 36px; }
  .pmx-create-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; background: var(--accent-soft); color: var(--accent); }
  .pmx-create-actions { display: flex; justify-content: center; gap: 8px; margin-top: 4px; }
  .pmx-projects { flex: 1; min-height: 0; overflow: auto; padding: 2px 6px 6px; display: grid; align-content: start; gap: 1px; }
  .pmx-project { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding: 6px 8px; border: 0; border-radius: var(--radius); background: transparent; color: var(--fg); text-align: left; cursor: pointer; }
  .pmx-project:hover { background: var(--hover); }
  .pmx-project.active { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
  .pmx-project-text { display: grid; flex: 1; min-width: 0; }
  .pmx-project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-medium); font-size: var(--text-sm); }
  .pmx-project-meta { color: var(--fg-subtle); font-size: var(--text-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pmx-scope { flex: none; height: 18px; padding: 0 6px; display: inline-flex; align-items: center; border-radius: 999px; background: var(--accent); color: var(--accent-fg); font-size: 10px; font-weight: var(--weight-semibold); }
  .pmx-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; }
  .pmx-dot.danger { background: var(--danger); }
  .pmx-side-empty { margin: 12px; color: var(--fg-subtle); font-size: var(--text-sm); text-align: center; }
  .pmx-side-foot { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--border); }
  .pmx-main { display: flex; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; overflow: auto; padding: 14px 16px; }
  .pmx-main > * { flex-shrink: 0; }
  .pm-inline { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
  .pm-inline > .input { flex: 1; min-width: 180px; }
  .pm-search { flex: 1 1 220px; min-width: 180px; }
  .pm-add-group { display: inline-flex; flex: none; align-items: center; gap: 6px; margin-left: auto; }
  .pm-msg { display: flex; align-items: center; gap: 8px; margin: 0; padding: 8px 10px; border-radius: var(--radius); background: var(--surface-2); color: var(--fg-muted); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .pm-msg.ok { background: var(--success-soft); color: var(--success-text); }
  .pm-msg.danger { background: var(--danger-soft); color: var(--danger-text); }
  .pm-msg > :global(.icon) { flex: none; }
  .pm-project { display: flex; flex-direction: column; gap: 10px; min-width: 0; flex: 1 1 auto; min-height: 0; }
  .pm-head { display: flex; align-items: flex-start; gap: 10px; min-width: 0; flex-wrap: wrap; }
  .pm-avatar, .pm-badge { display: inline-grid; place-items: center; flex: none; border-radius: var(--radius); font-weight: var(--weight-semibold); color: hsl(var(--hue, 238) var(--repo-badge-fg-sat) var(--repo-badge-fg-light)); background: hsl(var(--hue, 238) var(--repo-badge-bg-sat) var(--repo-badge-bg-light)); box-shadow: inset 0 0 0 1px hsl(var(--hue, 238) var(--repo-badge-ring-sat) var(--repo-badge-ring-light) / var(--repo-badge-ring-alpha)); }
  .pm-avatar { width: 38px; height: 38px; font-size: 16px; }
  .pm-avatar.sm { width: 26px; height: 26px; font-size: 12px; border-radius: var(--radius-sm); }
  .pm-badge { width: 28px; height: 28px; font-size: 12px; border-radius: var(--radius-sm); }
  .pm-title-block { display: grid; gap: 3px; flex: 1 1 240px; min-width: 0; }
  .pm-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .pm-title h3 { margin: 0; font-size: var(--text-lg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pm-sub { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
  .pm-rename { flex: 1 1 280px; }
  .pm-head-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-left: auto; }
  .pm-scope-on { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-text); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .pm-tag, .pm-current-badge { flex: none; height: 20px; padding: 0 7px; display: inline-flex; align-items: center; border-radius: 999px; background: var(--surface-3); color: var(--fg-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .pm-tag.shared, .pm-current-badge { background: var(--accent-soft); color: var(--accent-text); }
  .pm-source { flex: 1 1 160px; min-width: 0; }
  .spacer { flex: 1; }
  h3 { margin: 0; font-size: 15px; }
  h4 { margin: 0; font-size: var(--text-base); }
  small { color: var(--fg-subtle); font-size: var(--text-xs); font-weight: 400; white-space: nowrap; }
  .project-path { display: block; font: 12px/1.6 var(--mono); color: var(--fg-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .project-path.muted { color: var(--fg-subtle); }
  .project-path em { font-style: normal; font-family: var(--font); color: var(--fg-subtle); }
  .project-path em.missing-note { color: var(--danger-text); }
  .project-note { color: var(--fg-muted); font-size: 12px; margin: 6px 0; }
  .project-error { color: var(--danger-text); font-size: 12px; overflow-wrap: anywhere; }
  .pm-panel { display: grid; gap: 10px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-2); padding: 12px; }
  .pm-danger-panel { background: var(--danger-soft); }
  .pm-danger-copy { margin: 0; color: var(--danger-text); font-size: var(--text-sm); line-height: var(--leading-normal); }
  .pm-danger-copy code { font-family: var(--mono); font-size: var(--text-xs); color: var(--danger-text); }
  .pm-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .pm-panel-head small { display: block; margin-top: 2px; }
  .pm-preview-row { display: grid; gap: 2px; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .pm-preview-row:last-child { border-bottom: 0; }
  .pm-confirm { display: flex; align-items: center; gap: 8px; color: var(--warning-text); font-size: var(--text-sm); }
  .pm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .preview-members { max-height: 220px; overflow: auto; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); padding: 4px 10px; }
  .candidate-results { max-height: min(240px, 28vh); padding: 4px; }
  .candidate { display: flex; gap: 10px; padding: 6px 8px; align-items: flex-start; border-radius: var(--radius-sm); cursor: pointer; }
  .candidate:hover { background: var(--hover); }
  .candidate.disabled { cursor: not-allowed; background: var(--surface-2); color: var(--fg-subtle); }
  .candidate.disabled strong { color: var(--fg-subtle); }
  .candidate > input { margin-top: 2px; }
  .candidate-text { display: grid; min-width: 0; }
  .pm-filters { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .pm-filter-pill { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--control-border); background: var(--surface); color: var(--fg-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); white-space: nowrap; }
  .pm-filter-pill:hover { border-color: var(--control-border-hover); color: var(--fg); }
  .pm-filter-pill[aria-pressed="true"] { border-color: transparent; background: var(--accent-soft); color: var(--accent-text); }
  .pm-filter-pill.warn[aria-pressed="true"] { border-color: transparent; background: var(--warning-soft); color: var(--warning-text); }
  .project-members { flex: 1 1 auto; min-height: 160px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
  /* 几百个成员时只排版视口附近的行。 */
  .project-member { position: relative; display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 10px; border-bottom: 1px solid var(--border); content-visibility: auto; contain-intrinsic-size: auto 54px; }
  .project-member:last-child { border-bottom: 0; }
  .project-member:hover { background: var(--hover); }
  .member-main { display: grid; flex: 1; min-width: 0; gap: 1px; }
  .member-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .member-title strong { flex: 0 10 auto; min-width: 3em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 长仓库名先截断，分支保留可读的长度，而不是被挤成“ma…”。 */
  .pm-branch { display: inline-flex; align-items: center; gap: 3px; flex: 0 1 auto; min-width: min(7em, 100%); max-width: 220px; height: 18px; padding: 0 6px; border-radius: 999px; background: var(--surface-2); color: var(--fg-muted); font: 11px/1 var(--mono); }
  .pm-branch > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .pm-branch > :global(.icon) { flex: none; }
  .member-actions { display: flex; align-items: center; gap: 4px; flex: none; opacity: 0; transition: opacity var(--duration-fast) var(--ease); }
  .project-member.broken .member-actions, .project-member:hover .member-actions, .project-member:focus-within .member-actions { opacity: 1; }
  .pm-star { color: var(--fg-subtle); }
  .pm-star.on, .pm-star[aria-pressed="true"] { background: transparent; color: var(--warning); }
  .pm-star:hover:not(:disabled) { background: var(--hover); }
  .pm-star.on :global(svg) { fill: currentColor; }
  .pm-empty { display: grid; justify-items: center; gap: 6px; padding: 28px 16px; color: var(--fg-subtle); text-align: center; }
  .pm-empty.grow { flex: 1; align-content: center; }
  .pm-empty p { margin: 0; font-size: var(--text-sm); }
  @media (max-width: 760px) {
    .pmx { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); height: calc(100vh - 160px); }
    .pmx-side { border-right: 0; border-bottom: 1px solid var(--border); max-height: 200px; }
  }
  @media (hover: none) { .member-actions { opacity: 1; } }
</style>
