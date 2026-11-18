<script lang="ts">
  import { api, pickDirectories, pickDirectory, pickFile, saveWorkspaceFile } from "../api";
  import { normalizeError } from "../errors";
  import type { RepoHead } from "../types";
  import { hueOf } from "../ui";
  import {
    addCandidates,
    checkoutKey,
    projectInitial,
    type Projects,
    type WorkspaceCandidate,
    type WorkspaceManifest,
    type WorkspacePreview,
    type WorkspaceRepository,
  } from "../workspaces";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import SelectMenu, { type SelectMenuOption } from "./SelectMenu.svelte";

  interface Props {
    data: Projects;
    selectedId: string | null;
    currentPath?: string | null;
    initialPreview?: WorkspacePreview | null;
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
    nextId,
    onData,
    onSelect,
    onOpenRepo,
    onConsumeInitialPreview,
    onClose,
  }: Props = $props();

  let project = $derived(data.projects.find((p) => p.manifest.workspaceId === selectedId) ?? null);
  let name = $state("");
  let query = $state("");
  let memberFilter = $state<"all" | "favorites" | "broken">("all");
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  const busyReason = $derived(busy ? `${busy}，请等待完成后再操作。` : undefined);
  const editReason = $derived(busyReason ?? (project?.error ? "请先刷新或重新预览清单，确认来源后再修改名单。" : undefined));
  let notice = $state<string | null>(null);
  let preview = $state<WorkspacePreview | null>(null);
  let adopt = $state(false);
  let candidates = $state<WorkspaceCandidate[]>([]);
  let candidateQuery = $state("");
  const matchingCandidates = $derived.by(() => {
    const tokens = candidateQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return candidates;
    return candidates.filter((candidate) =>
      tokens.every((token) => [candidate.name, candidate.path].some((text) => text.toLocaleLowerCase().includes(token))),
    );
  });
  let chosen = $state<Set<string>>(new Set());
  let repairId = $state<string | null>(null);
  let cancelRequested = $state(false);
  /** 新建、改名与移除确认都是低频动作：平时收起，只在需要时展开。 */
  let creating = $state(false);
  let renaming = $state(false);
  let confirmDelete = $state(false);
  let memberHeads = $state.raw<Map<string, RepoHead>>(new Map());

  $effect(() => {
    if (data.projects.length === 0) creating = true;
  });

  // 入站 twiglane://workspace 链接只做一次性预览移交：收到后立即消费父层意图，关闭重开不会复现旧预览。
  $effect(() => {
    if (!initialPreview) return;
    preview = initialPreview;
    adopt = false;
    creating = false;
    confirmDelete = false;
    onConsumeInitialPreview?.();
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
  const projectOptions = $derived<SelectMenuOption[]>([
    { value: "", label: "未选择项目", detail: "只用独立打开的仓库，不按项目筛选", icon: "history" },
    ...data.projects.map((item) => ({
      value: item.manifest.workspaceId,
      label: item.manifest.name,
      detail: `${item.manifest.repositories.length} 个仓库 · ${item.sourcePath ? "共享清单" : "仅本机"}${item.error ? " · 名单待处理" : ""}`,
      badge: projectInitial(item.manifest.name),
      hue: hueOf(item.manifest.workspaceId),
    })),
  ]);

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

  async function create() {
    await run("正在创建项目", async () => {
      const next = await api.workspaceCreate(name);
      accept(next);
      onSelect(next.projects.at(-1)?.manifest.workspaceId ?? null);
      name = "";
      creating = false;
      confirmDelete = false;
    });
  }

  async function openManifest() {
    await run("正在预览清单", async () => {
      const path = await pickFile("打开与 Cliora 共用的项目清单");
      if (!path) return;
      preview = await api.workspacePreview(path);
      adopt = false;
    });
  }

  async function attach() {
    const observed = preview;
    if (!observed) return;
    await run("正在关联清单", async () => {
      accept(await api.workspaceAttach(observed, adopt));
      onSelect(observed.manifest.workspaceId);
      preview = null;
      candidates = [];
      confirmDelete = false;
      notice = "已关联。以后打开项目、窗口获焦或刷新会重新读取这份名单。";
    });
  }

  async function removeProject() {
    if (!project) return;
    const current = project;
    const wasShared = Boolean(current.sourcePath);
    await run(wasShared ? "正在取消关联清单" : "正在移除本地项目", async () => {
      const next = await api.workspaceDelete(current.manifest.workspaceId);
      accept(next);
      confirmDelete = false;
      candidates = [];
      query = "";
      renaming = false;
      memberFilter = "all";
      onSelect(next.projects[0]?.manifest.workspaceId ?? null);
      notice = wasShared
        ? "已取消关联清单；磁盘上的 .dev-workspace.json 文件、各仓库与草稿均已保留。"
        : "已移除本地项目；各仓库目录、Git 历史与草稿均已保留。";
    });
  }

  async function save(manifest: WorkspaceManifest) {
    accept(await api.workspaceUpdate(manifest, manifest.revision));
  }

  async function choosePaths(discover: boolean, repositoryId: string | null = null) {
    repairId = repositoryId;
    await run(discover ? "正在发现仓库" : "正在检查仓库", async () => {
      cancelRequested = false;
      if (discover) {
        const root = await pickDirectory("选择发现根目录（只扫描此目录，不跟随目录链接）");
        if (!root) return;
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
      chosen = new Set(candidates.filter((candidate) => !candidate.error).map((candidate) => candidate.path));
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
      chosen = new Set();
      repairId = null;
      notice = "项目名单已保存，源码与 Git 内容未移动。";
    });
  }

  function selectMatching(enabled: boolean) {
    const next = new Set(chosen);
    for (const candidate of matchingCandidates) {
      if (candidate.error) continue;
      if (enabled) next.add(candidate.path);
      else next.delete(candidate.path);
    }
    chosen = next;
  }

  function toggle(path: string) {
    const next = new Set(chosen);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    chosen = next;
  }
</script>

<Modal
  title="业务项目"
  titleId="workspace-manager-title"
  size="xl"
  locked={busy !== null}
  {onClose}
  description="把散落在不同目录的 Git 仓库归到一个项目里。与 Cliora 共用时，两端打开同一份 .dev-workspace.json。"
>
  <div class="projects-manager" data-workspace-manager>
    <div class="pm-bar">
      <SelectMenu
        class="pm-select"
        label="管理业务项目"
        value={selectedId ?? ""}
        options={projectOptions}
        placeholder="选择项目"
        disabled={Boolean(busy)}
        disabledReason={busyReason}
        searchPlaceholder="搜索项目"
        width={420}
        onChange={(value) => {
          onSelect(value || null);
          candidates = [];
          query = "";
          memberFilter = "all";
          renaming = false;
          confirmDelete = false;
        }}
      />
      <button
        class="btn btn-secondary"
        aria-pressed={creating}
        disabled={Boolean(busy)}
        title={busyReason ?? "新建一个只在本机的项目"}
        onclick={() => (creating = !creating)}
      ><Icon name="plus" size={14} />新建项目</button>
      <button
        class="btn btn-secondary"
        disabled={Boolean(busy)}
        title={busyReason ?? "打开与 Cliora 共用的 .dev-workspace.json"}
        onclick={openManifest}
      ><Icon name="folder-open" size={14} />打开项目清单</button>
    </div>
    {#if creating}
      <form
        class="pm-inline"
        onsubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="input"
          aria-label="新项目名称"
          placeholder="项目名称，例如：电商平台"
          maxlength="160"
          bind:value={name}
          disabled={Boolean(busy)}
          title={busyReason}
          autofocus
        />
        <button
          class="btn btn-primary"
          disabled={Boolean(busy) || !name.trim()}
          title={busyReason ?? (!name.trim() ? "请先填写新项目名称。" : undefined)}
          type="submit"
        >创建本地项目</button>
        {#if data.projects.length > 0}
          <button
            class="btn btn-ghost"
            type="button"
            disabled={Boolean(busy)}
            title={busyReason}
            onclick={() => {
              creating = false;
              name = "";
            }}
          >取消</button>
        {/if}
      </form>
    {/if}
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
          <button class="btn btn-ghost" disabled={Boolean(busy)} title={busyReason} onclick={() => (preview = null)}>取消预览</button>
          <button
            class="btn btn-primary"
            disabled={Boolean(busy) || (preview.conflict && !adopt)}
            title={busyReason ?? (preview.conflict && !adopt ? "请先确认用预览名单替换同一项目的本机成员关系。" : undefined)}
            onclick={attach}
          >关联此项目清单</button>
        </div>
      </section>
    {/if}
    {#if project}
      <section class="pm-project" aria-label="项目成员">
        <header class="pm-head">
          <span class="pm-avatar" style={"--hue:" + hueOf(project.manifest.workspaceId)} aria-hidden="true">{initial(project.manifest.name)}</span>
          {#if renaming}
            <form
              class="pm-inline pm-rename"
              onsubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const title = new FormData(form).get("title");
                if (typeof title === "string" && title.trim()) {
                  void run("正在修改名称", async () => {
                    await save({ ...project!.manifest, name: title.trim() });
                    renaming = false;
                  });
                }
              }}
            >
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="input"
                aria-label="项目显示名称"
                name="title"
                value={project.manifest.name}
                maxlength="160"
                disabled={Boolean(busy) || Boolean(project.error)}
                title={editReason}
                autofocus
                onkeydown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    renaming = false;
                  }
                }}
              />
              <button class="btn btn-primary btn-sm" type="submit" disabled={Boolean(busy) || Boolean(project.error)} title={editReason}>保存名称</button>
              <button class="btn btn-ghost btn-sm" type="button" onclick={() => (renaming = false)}>取消</button>
            </form>
          {:else}
            <div class="pm-title">
              <h3>{project.manifest.name}</h3>
              <span class="pm-tag" class:shared={Boolean(project.sourcePath)}>{project.sourcePath ? "共享清单" : "仅本机"}</span>
              <small>版本 {project.manifest.revision} · {project.manifest.repositories.length} 个仓库</small>
              <button
                class="icon-btn sm"
                aria-label="修改项目名称"
                title={editReason ?? "修改项目名称"}
                disabled={Boolean(busy) || Boolean(project.error)}
                onclick={() => (renaming = true)}
              ><Icon name="pencil" size={13} /></button>
            </div>
          {/if}
          <span class="spacer"></span>
          <button
            class="btn btn-ghost btn-sm"
            disabled={Boolean(busy)}
            title={busyReason ?? (project.sourcePath ? "重新读取共享清单" : "重新读取本机名单")}
            onclick={() => void run("正在刷新项目", async () => accept(await api.workspaceRefresh(project!.manifest.workspaceId)))}
          ><Icon name="refresh" size={13} />刷新清单</button>
          {#if project.sourcePath}
            <button
              class="btn btn-ghost btn-sm"
              disabled={Boolean(busy)}
              title={busyReason ?? "在 Cliora 中预览这份共享项目清单"}
              onclick={() =>
                void run("正在唤起 Cliora", async () => {
                  await api.workspaceOpenInCliora(project!.sourcePath!);
                  notice = "已请求在 Cliora 中预览此项目清单。";
                })}
            ><Icon name="link" size={13} />在 Cliora 打开</button>
          {:else}
            <button
              class="btn btn-ghost btn-sm"
              disabled={Boolean(busy)}
              title={busyReason ?? "另存为 .dev-workspace.json，给 Cliora 或同事共用"}
              onclick={() =>
                void run("正在发布清单", async () => {
                  const current = project!;
                  const path = await saveWorkspaceFile();
                  if (path) {
                    accept(await api.workspacePublish(current.manifest.workspaceId, current.manifest.revision, path));
                    notice = "已发布。请在 Cliora 打开这同一份项目清单。";
                  }
                })}
            ><Icon name="upload" size={13} />发布共享清单</button>
          {/if}
          <button
            class="btn btn-ghost btn-sm btn-danger-soft"
            aria-pressed={confirmDelete}
            disabled={Boolean(busy)}
            title={busyReason ?? (project.sourcePath ? "只取消本机关联，不删除磁盘上的清单文件或仓库" : "只移除项目记录，不删除仓库或提交草稿")}
            onclick={() => (confirmDelete = !confirmDelete)}
          ><Icon name="trash" size={13} />{project.sourcePath ? "取消关联清单" : "移除本地项目"}</button>
        </header>
        {#if project.sourcePath}<p class="project-path muted pm-source" title={project.sourcePath}>{project.sourcePath}</p>{/if}
        {#if confirmDelete}
          <section class="pm-panel pm-danger-panel" aria-label={project.sourcePath ? "确认取消关联清单" : "确认移除本地项目"}>
            <p class="pm-danger-copy">
              {#if project.sourcePath}
                确定取消关联共享清单「{project.manifest.name}」吗？磁盘上的 <code>.dev-workspace.json</code> 文件、各仓库源码、Git 历史与提交草稿都保留不变，随时可重新打开关联。
              {:else}
                确定移除本地项目「{project.manifest.name}」吗？各仓库源码、Git 历史、最近打开记录与提交草稿都保留不变。
              {/if}
            </p>
            <div class="pm-actions">
              <button class="btn btn-ghost btn-sm" type="button" disabled={Boolean(busy)} title={busyReason} onclick={() => (confirmDelete = false)}>取消</button>
              <button class="btn btn-danger btn-sm" type="button" disabled={Boolean(busy)} title={busyReason} onclick={removeProject}>{project.sourcePath ? "确认取消关联" : "确认移除项目"}</button>
            </div>
          </section>
        {/if}
        {#if project.error}<p class="pm-msg danger" role="alert"><Icon name="alert-circle" size={14} />最后可读快照：{project.error}。可刷新重试，或重新打开清单预览并明确接收。</p>{/if}
        {#if candidates.length}
          <section class="pm-panel" aria-label="候选仓库">
            <header class="pm-panel-head">
              <h4>{repairId ? "选择一个目录替换此仓库的本机位置" : "选择要纳入的仓库"}</h4>
              <small role="status">显示 {matchingCandidates.length} / {candidates.length} · 已选 {chosen.size}</small>
            </header>
            <div class="pm-inline">
              <div class="field sm pm-search">
                <Icon name="search" size={13} />
                <input
                  aria-label="搜索候选仓库"
                  placeholder="搜索候选名称或完整路径"
                  bind:value={candidateQuery}
                  onkeydown={(e) => {
                    if (e.key === "Escape" && candidateQuery) {
                      e.preventDefault();
                      e.stopPropagation();
                      candidateQuery = "";
                    }
                  }}
                />
                {#if candidateQuery}
                  <button type="button" class="field-clear" aria-label="清空候选搜索" onclick={() => (candidateQuery = "")}>
                    <Icon name="x" size={12} />
                  </button>
                {/if}
              </div>
              {#if !repairId}
                <button
                  class="btn btn-ghost btn-sm"
                  disabled={Boolean(busy) || !matchingCandidates.some((candidate) => !candidate.error)}
                  title={busyReason ?? (!matchingCandidates.some((candidate) => !candidate.error) ? "当前没有可选择的候选仓库。" : "仅选择当前搜索结果，保留筛选外的选择。")}
                  onclick={() => selectMatching(true)}
                >全选当前结果</button>
                <button
                  class="btn btn-ghost btn-sm"
                  disabled={Boolean(busy) || !matchingCandidates.some((candidate) => chosen.has(candidate.path))}
                  title={busyReason ?? (!matchingCandidates.some((candidate) => chosen.has(candidate.path)) ? "当前结果中没有已选候选。" : "仅清除当前搜索结果的选择，保留筛选外的选择。")}
                  onclick={() => selectMatching(false)}
                >清除当前结果的选择</button>
              {/if}
            </div>
            <div class="preview-members candidate-results">
              {#each matchingCandidates as candidate, index (`${candidate.path}:${index}`)}
                <label class="candidate" class:disabled={Boolean(candidate.error)}>
                  <input
                    class="checkbox"
                    type={repairId ? "radio" : "checkbox"}
                    name="candidate"
                    checked={chosen.has(candidate.path)}
                    disabled={Boolean(busy) || Boolean(candidate.error)}
                    title={busyReason ?? candidate.error ?? undefined}
                    onchange={() => {
                      if (repairId) chosen = new Set([candidate.path]);
                      else toggle(candidate.path);
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
            <div class="pm-actions">
              <button
                class="btn btn-ghost"
                disabled={Boolean(busy)}
                title={busyReason}
                onclick={() => {
                  candidates = [];
                  repairId = null;
                }}
              >取消</button>
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
              onkeydown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  query = "";
                }
              }}
            />
            {#if query}
              <button type="button" class="field-clear" aria-label="清空搜索" onclick={() => (query = "")}>
                <Icon name="x" size={12} />
              </button>
            {/if}
          </div>
          {#if project.manifest.repositories.length > 0 && (favoriteCount > 0 || brokenCount > 0)}
            <div class="pm-filters" role="group" aria-label="筛选项目成员">
              <button
                type="button"
                class="pm-filter-pill"
                aria-pressed={memberFilter === "all"}
                onclick={() => (memberFilter = "all")}
              >全部 {project.manifest.repositories.length}</button>
              {#if favoriteCount > 0}
                <button
                  type="button"
                  class="pm-filter-pill"
                  aria-pressed={memberFilter === "favorites"}
                  onclick={() => (memberFilter = memberFilter === "favorites" ? "all" : "favorites")}
                >收藏 {favoriteCount}</button>
              {/if}
              {#if brokenCount > 0}
                <button
                  type="button"
                  class="pm-filter-pill warn"
                  aria-pressed={memberFilter === "broken"}
                  onclick={() => (memberFilter = memberFilter === "broken" ? "all" : "broken")}
                >待处理 {brokenCount}</button>
              {/if}
            </div>
          {/if}
          <button
            class="btn btn-secondary btn-sm"
            disabled={Boolean(busy) || Boolean(project.error)}
            title={editReason ?? "选择一个或多个本机仓库目录"}
            onclick={() => void choosePaths(false)}
          ><Icon name="plus" size={13} />批量选择仓库</button>
          <button
            class="btn btn-secondary btn-sm"
            disabled={Boolean(busy) || Boolean(project.error)}
            title={editReason ?? "扫描一个目录，列出其中的 Git 仓库再挑选"}
            onclick={() => void choosePaths(true)}
          ><Icon name="search" size={13} />从目录发现</button>
        </div>
        <div class="project-members" role="list">
          {#each filtered as repo (repo.id)}
            {@const favorite = favoriteSet.has(repo.id)}
            {@const locals = localLocationsOf(repo)}
            {@const openablePath = validLocalPath(repo)}
            {@const broken = isRepoBroken(repo)}
            {@const isCurrent = isRepoCurrent(repo)}
            <article class="project-member" class:broken role="listitem">
              <span class="pm-badge" style={"--hue:" + hueOf(repo.locations[0]?.path ?? repo.id)} aria-hidden="true">{initial(repo.name)}</span>
              <div class="member-main">
                <div class="member-title">
                  <strong>{repo.name}</strong>
                  {#if isCurrent}<span class="pm-current-badge">当前</span>{/if}
                  {#if repo.locations.length > 1}<small>{repo.locations.length} 个位置</small>{/if}
                </div>
                {#each repo.locations as location}
                  <span class="project-path" title={location.path}>{location.path}{#if location.hostId !== data.hostId}<em> · 其他主机，暂不可用</em>{:else if isLocationMissing(location.path)}<em class="missing-note"> · 目录已缺失</em>{/if}</span>
                {/each}
                {#if locals.length === 0}
                  <span class="project-error">本机没有位置，请重新关联目录。</span>
                {:else if isRepoBroken(repo)}
                  <span class="project-error">目录不存在，请重新关联。</span>
                {/if}
              </div>
              <div class="member-actions">
                {#if !isCurrent && openablePath && onOpenRepo}
                  <button
                    class="btn btn-secondary btn-sm"
                    disabled={Boolean(busy)}
                    title={busyReason ?? `打开 ${openablePath}`}
                    aria-label={`打开 ${repo.name}`}
                    onclick={() => onOpenRepo(openablePath)}
                  >打开</button>
                {/if}
                <button
                  class="btn btn-ghost btn-sm"
                  disabled={Boolean(busy) || Boolean(project.error)}
                  title={editReason ?? "换成本机另一个目录"}
                  onclick={() => void choosePaths(false, repo.id)}
                >重新关联目录</button>
                <button
                  class="btn btn-ghost btn-sm btn-danger-soft"
                  disabled={Boolean(busy) || Boolean(project.error)}
                  title={editReason ?? "只从项目名单移除，不删除文件"}
                  onclick={() =>
                    void run("正在移除关联", () =>
                      save({ ...project!.manifest, repositories: project!.manifest.repositories.filter((item) => item.id !== repo.id) }),
                    )}
                >移除项目关联</button>
              </div>
              <button
                class="icon-btn sm pm-star"
                class:on={favorite}
                aria-pressed={favorite}
                aria-label={`${favorite ? "取消收藏" : "收藏"} ${repo.name}`}
                disabled={Boolean(busy)}
                title={busyReason ?? (favorite ? "取消收藏" : "收藏后排在切换列表前面")}
                onclick={() => void run("正在保存收藏", async () => accept(await api.workspaceFavorite(project!.manifest.workspaceId, repo.id, !favorite)))}
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
    {:else if !preview && data.projects.length > 0}
      <div class="pm-empty"><Icon name="layers" size={20} /><p>从上方选择一个项目查看和整理它的仓库。</p></div>
    {/if}
  </div>
</Modal>

<style>
  .projects-manager { display: grid; gap: 12px; min-width: 0; }
  .pm-bar, .pm-inline { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
  .pm-bar > :global(.pm-select) { flex: 1; min-width: 220px; }
  .pm-inline > .input { flex: 1; min-width: 180px; }
  .pm-search { flex: 1; min-width: 200px; }
  .pm-msg { display: flex; align-items: center; gap: 8px; margin: 0; padding: 8px 10px; border-radius: var(--radius); background: var(--surface-2); color: var(--fg-muted); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .pm-msg.ok { background: var(--success-soft); color: var(--success-text); }
  .pm-msg.danger { background: var(--danger-soft); color: var(--danger-text); }
  .pm-msg > :global(.icon) { flex: none; }
  .pm-project { display: grid; gap: 10px; min-width: 0; padding-top: 4px; border-top: 1px solid var(--border); }
  .pm-head { display: flex; align-items: center; gap: 8px; min-width: 0; padding-top: 10px; flex-wrap: wrap; }
  .pm-avatar, .pm-badge { display: inline-grid; place-items: center; flex: none; border-radius: var(--radius); font-weight: var(--weight-semibold); color: hsl(var(--hue, 238) var(--repo-badge-fg-sat) var(--repo-badge-fg-light)); background: hsl(var(--hue, 238) var(--repo-badge-bg-sat) var(--repo-badge-bg-light)); box-shadow: inset 0 0 0 1px hsl(var(--hue, 238) var(--repo-badge-ring-sat) var(--repo-badge-ring-light) / var(--repo-badge-ring-alpha)); }
  .pm-avatar { width: 32px; height: 32px; font-size: 15px; }
  .pm-badge { width: 26px; height: 26px; font-size: 12px; border-radius: var(--radius-sm); }
  .pm-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .pm-title h3 { margin: 0; font-size: var(--text-lg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pm-rename { flex: 1; }
  .pm-tag, .pm-current-badge { flex: none; height: 20px; padding: 0 7px; display: inline-flex; align-items: center; border-radius: 999px; background: var(--surface-3); color: var(--fg-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .pm-tag.shared, .pm-current-badge { background: var(--accent-soft); color: var(--accent-text); }
  .pm-source { margin: -4px 0 0 40px; }
  .spacer { flex: 1; }
  h3 { margin: 0; font-size: 15px; }
  h4 { margin: 0; font-size: var(--text-base); }
  small { color: var(--fg-subtle); font-size: var(--text-xs); font-weight: 400; white-space: nowrap; }
  .project-path { display: block; font: 12px/1.6 var(--mono); color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .project-path.muted { color: var(--fg-subtle); }
  .project-path em { font-style: normal; font-family: var(--font); color: var(--fg-subtle); }
  .project-path em.missing-note { color: var(--danger-text); }
  .project-note { color: var(--fg-muted); font-size: 12px; margin: 6px 0; }
  .project-error { color: var(--danger-text); font-size: 12px; overflow-wrap: anywhere; }
  .pm-panel { display: grid; gap: 10px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-2); padding: 12px; }
  .pm-danger-panel { background: var(--danger-soft); border-color: var(--border); }
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
  .pm-filter-pill { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--control-border); background: var(--surface); color: var(--fg-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); white-space: nowrap; transition: background var(--duration-fast) var(--ease), border-color var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease); }
  .pm-filter-pill:hover { border-color: var(--control-border-hover); color: var(--fg); }
  .pm-filter-pill[aria-pressed="true"] { border-color: transparent; background: var(--accent-soft); color: var(--accent-text); }
  .pm-filter-pill.warn[aria-pressed="true"] { border-color: transparent; background: var(--warning-soft); color: var(--warning-text); }
  .project-members { max-height: min(420px, 46vh); overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
  .project-member { position: relative; display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  .project-member:last-child { border-bottom: 0; }
  .project-member:hover { background: var(--hover); }
  .member-main { display: grid; flex: 1; min-width: 0; gap: 1px; }
  .member-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .member-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .member-actions { display: flex; align-items: center; gap: 4px; flex: none; opacity: 0; transition: opacity var(--duration-fast) var(--ease); }
  .project-member.broken .member-actions, .project-member:hover .member-actions, .project-member:focus-within .member-actions { opacity: 1; }
  .pm-star { color: var(--fg-subtle); }
  .pm-star.on, .pm-star[aria-pressed="true"] { background: transparent; color: var(--warning); }
  .pm-star:hover:not(:disabled) { background: var(--hover); }
  .pm-star.on :global(svg) { fill: currentColor; }
  .pm-empty { display: grid; justify-items: center; gap: 6px; padding: 28px 16px; color: var(--fg-subtle); text-align: center; }
  .pm-empty p { margin: 0; font-size: var(--text-sm); }
  @media (hover: none) { .member-actions { opacity: 1; } }
</style>
