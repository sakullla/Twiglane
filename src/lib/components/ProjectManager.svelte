<script lang="ts">
  import { api, pickDirectories, pickDirectory, pickFile, saveWorkspaceFile } from "../api";
  import { normalizeError } from "../errors";
  import { addCandidates, type Projects, type WorkspaceCandidate, type WorkspaceManifest, type WorkspacePreview } from "../workspaces";
  import Modal from "./Modal.svelte";
  interface Props {
    data: Projects;
    selectedId: string | null;
    nextId: () => number;
    onData: (data: Projects) => void;
    onSelect: (id: string | null) => void;
    onClose: () => void;
  }
  let { data, selectedId, nextId, onData, onSelect, onClose }: Props = $props();
  let project = $derived(data.projects.find((p) => p.manifest.workspaceId === selectedId) ?? null);
  let name = $state("");
  let query = $state("");
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  const busyReason = $derived(busy ? `${busy}，请等待完成后再操作。` : undefined);
  const editReason = $derived(busyReason ?? (project?.error ? "请先刷新或重新预览清单，确认来源后再修改名单。" : undefined));
  let notice = $state<string | null>(null);
  let preview = $state<WorkspacePreview | null>(null);
  let adopt = $state(false);
  let candidates = $state<WorkspaceCandidate[]>([]);
  let chosen = $state<Set<string>>(new Set());
  let repairId = $state<string | null>(null);
  let cancelRequested = $state(false);
  let filtered = $derived(project?.manifest.repositories.filter((repo) => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || [repo.name, ...repo.locations.map((l) => l.path)].some((text) => text.toLocaleLowerCase().includes(needle));
  }) ?? []);
  async function run(label: string, action: () => Promise<void>) {
    if (busy) return;
    busy = label;
    error = null;
    notice = null;
    try { await action(); } catch (failure) { error = normalizeError(failure).message; }
    finally { busy = null; }
  }
  function accept(data: Projects) { onData(data); }
  async function create() {
    await run("正在创建项目", async () => {
      const next = await api.workspaceCreate(name);
      accept(next);
      onSelect(next.projects.at(-1)?.manifest.workspaceId ?? null);
      name = "";
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
      notice = "已关联。以后打开项目、窗口获焦或刷新会重新读取这份名单。";
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
        notice = result.cancelled ? "已取消发现，未添加任何仓库。" : result.partial ? "发现未完成全部目录（权限或扫描预算限制），下面仅为已确认候选。" : `发现 ${candidates.length} 个候选，选择后再纳入项目。`;
      } else {
        const paths = repositoryId ? [await pickDirectory("重新关联此仓库的本机目录")] : await pickDirectories();
        const valid = paths.filter((path): path is string => Boolean(path));
        if (!valid.length) return;
        candidates = await api.workspaceCandidates(valid, nextId());
      }
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
        await save({ ...current.manifest, repositories: current.manifest.repositories.map((repo) => repo.id === repairId ? {
          ...repo, locations: [...repo.locations.filter((l) => l.hostId !== data.hostId), { hostId: data.hostId, path: candidate.path }],
        } : repo) });
      } else { await save(addCandidates(current.manifest, picked, data.hostId)); }
      candidates = [];
      chosen = new Set();
      repairId = null;
      notice = "项目名单已保存，源码与 Git 内容未移动。";
    });
  }
  function toggle(path: string) {
    const next = new Set(chosen);
    if (next.has(path)) next.delete(path); else next.add(path);
    chosen = next;
  }
</script>

<Modal title="业务项目" titleId="workspace-manager-title" size="xl" locked={busy !== null} {onClose}
  description="一个项目可以组织不同目录的独立 Git 仓库。与 Cliora 复用时，两端打开同一份 .dev-workspace.json 文件。">
  <div class="projects-manager" data-workspace-manager>
    <div class="project-toolbar">
      <label>当前项目
        <select aria-label="管理业务项目" value={selectedId ?? ""} disabled={Boolean(busy)} title={busyReason} onchange={(e) => { onSelect(e.currentTarget.value || null); candidates = []; query = ""; }}>
          <option value="">独立仓库 / 最近使用</option>
          {#each data.projects as item (item.manifest.workspaceId)}
            <option value={item.manifest.workspaceId}>{item.manifest.name} · {item.manifest.repositories.length} 个仓库 · {item.manifest.workspaceId.slice(0, 8)}</option>
          {/each}
        </select>
      </label>
      <button class="btn" disabled={Boolean(busy)} title={busyReason} onclick={openManifest}>打开项目清单</button>
    </div>
    <form class="project-toolbar" onsubmit={(e) => { e.preventDefault(); void create(); }}>
      <input aria-label="新项目名称" placeholder="新项目名称" maxlength="160" bind:value={name} disabled={Boolean(busy)} title={busyReason} />
      <button class="btn" disabled={Boolean(busy) || !name.trim()} title={busyReason ?? (!name.trim() ? "请先填写新项目名称。" : undefined)} type="submit">创建本地项目</button>
    </form>
    {#if error}<p class="project-error" role="alert">{error}</p>{/if}
    {#if notice}<p class="project-note" role="status">{notice}</p>{/if}
    {#if busy}<p role="status">{busy}… {#if busy === "正在发现仓库"}<button class="btn" disabled={cancelRequested} title={cancelRequested ? "已请求取消，正在等待当前读取结束。" : "取消后不添加任何仓库。"} onclick={() => { cancelRequested = true; void api.workspaceCancelDiscovery().catch((e) => error = normalizeError(e).message); }}>取消发现</button>{/if}</p>{/if}
    {#if preview}
      <section class="manifest-preview" aria-label="项目清单预览">
        <h3>{preview.manifest.name} · 版本 {preview.manifest.revision}</h3>
        <p class="project-path">{preview.path}</p>
        <p>项目 ID：{preview.manifest.workspaceId} · {preview.manifest.repositories.length} 个仓库</p>
        <div class="preview-members">
          {#each preview.manifest.repositories as repo (repo.id)}
            <div><strong>{repo.name}</strong>{#each repo.locations as location}<p class="project-path">{location.path} {location.hostId !== data.hostId ? "· 其他主机，需重新关联" : "· 本机位置提示，打开时复核 Git"}</p>{/each}</div>
          {/each}
        </div>
        {#if preview.conflict}<label class="project-error"><input type="checkbox" bind:checked={adopt} /> 同一项目 ID 的名单与本机快照不同，确认以此清单替换本机成员关系</label>{/if}
        <div class="project-toolbar"><button class="btn primary" disabled={Boolean(busy) || (preview.conflict && !adopt)} title={busyReason ?? (preview.conflict && !adopt ? "请先确认用预览名单替换同一项目的本机成员关系。" : undefined)} onclick={attach}>关联此项目清单</button><button class="btn" disabled={Boolean(busy)} title={busyReason} onclick={() => preview = null}>取消预览</button></div>
      </section>
    {/if}
    {#if project}
      <section aria-label="项目成员">
        <h3>{project.manifest.name} <small>版本 {project.manifest.revision} · {project.manifest.repositories.length} 个仓库</small></h3>
        <p class="project-path">{project.sourcePath ?? "本地项目，尚未发布共享清单"}</p>
        {#if project.error}<p class="project-error" role="alert">最后可读快照：{project.error}。可刷新重试，或重新打开清单预览并明确接收。</p>{/if}
        <div class="project-toolbar">
          <button class="btn" disabled={Boolean(busy)} title={busyReason} onclick={() => void run("正在刷新项目", async () => accept(await api.workspaceRefresh(project!.manifest.workspaceId)))}>刷新清单</button>
          {#if !project.sourcePath}<button class="btn" disabled={Boolean(busy)} title={busyReason} onclick={() => void run("正在发布清单", async () => {
            const current = project!; const path = await saveWorkspaceFile();
            if (path) { accept(await api.workspacePublish(current.manifest.workspaceId, current.manifest.revision, path)); notice = "已发布。请在 Cliora 打开这同一份项目清单。"; }
          })}>发布共享清单</button>{/if}
          <button class="btn" disabled={Boolean(busy) || Boolean(project.error)} title={editReason} onclick={() => void choosePaths(false)}>批量选择仓库</button>
          <button class="btn" disabled={Boolean(busy) || Boolean(project.error)} title={editReason} onclick={() => void choosePaths(true)}>从目录发现</button>
        </div>
        <form class="project-toolbar" onsubmit={(e) => {
          e.preventDefault(); const form = e.currentTarget; const title = new FormData(form).get("title");
          if (typeof title === "string") void run("正在修改名称", () => save({ ...project!.manifest, name: title }));
        }}><input aria-label="项目显示名称" name="title" value={project.manifest.name} maxlength="160" disabled={Boolean(busy) || Boolean(project.error)} title={editReason} /><button class="btn" type="submit" disabled={Boolean(busy) || Boolean(project.error)} title={editReason}>修改名称</button></form>
        {#if candidates.length}
          <section class="manifest-preview" aria-label="候选仓库">
            <h4>{repairId ? "选择一个目录替换此仓库的本机位置" : "选择要纳入的仓库"}</h4>
            <div class="preview-members">
              {#each candidates as candidate, index (`${candidate.path}:${index}`)}
                <label class="candidate"><input type={repairId ? "radio" : "checkbox"} name="candidate" checked={chosen.has(candidate.path)} disabled={Boolean(candidate.error)} title={candidate.error ?? undefined} onchange={() => { if (repairId) chosen = new Set([candidate.path]); else toggle(candidate.path); }} /><span>{candidate.name}<span class="project-path">{candidate.path}</span>{#if candidate.error}<span class="project-error">{candidate.error}</span>{/if}</span></label>
              {/each}
            </div>
            <div class="project-toolbar"><button class="btn primary" disabled={Boolean(busy) || !chosen.size} title={busyReason ?? (!chosen.size ? "请先选择至少一个可读取的仓库目录。" : undefined)} onclick={add}>确认{repairId ? "重新关联" : `纳入 ${chosen.size} 个位置`}</button><button class="btn" disabled={Boolean(busy)} title={busyReason} onclick={() => { candidates = []; repairId = null; }}>取消</button></div>
          </section>
        {/if}
        <input aria-label="搜索项目仓库" placeholder="搜索仓库名称或完整路径" bind:value={query} />
        <div class="project-members">
          {#each filtered as repo (repo.id)}
            <article class="project-member">
              <div class="member-title"><strong>{repo.name}</strong><button class="btn" aria-label={`${project.favorites.includes(repo.id) ? "取消收藏" : "收藏"} ${repo.name}`} disabled={Boolean(busy)} title={busyReason} onclick={() => void run("正在保存收藏", async () => accept(await api.workspaceFavorite(project!.manifest.workspaceId, repo.id, !project!.favorites.includes(repo.id))))}>{project.favorites.includes(repo.id) ? "★ 已收藏" : "☆ 收藏"}</button></div>
              {#each repo.locations as location}<p class="project-path">{location.path}{#if location.hostId !== data.hostId}<span class="project-note"> · 其他主机，暂不可用</span>{/if}</p>{/each}
              {#if !repo.locations.length}<p class="project-note">尚无工作位置，请重新关联本机目录。</p>{/if}
              <div class="project-toolbar"><button class="btn" disabled={Boolean(busy) || Boolean(project.error)} title={editReason} onclick={() => void choosePaths(false, repo.id)}>重新关联目录</button><button class="btn" disabled={Boolean(busy) || Boolean(project.error)} title={editReason} onclick={() => void run("正在移除关联", () => save({ ...project!.manifest, repositories: project!.manifest.repositories.filter((item) => item.id !== repo.id) }))}>移除项目关联</button></div>
            </article>
          {:else}<p class="project-note">{query ? "没有匹配的仓库。" : "项目还没有仓库，批量选择或从目录发现后纳入。"}</p>{/each}
        </div>
      </section>
    {/if}
  </div>
</Modal>

<style>
  .projects-manager { display: grid; gap: 14px; min-width: 0; }
  .project-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .project-toolbar label { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; }
  .project-toolbar input, .project-toolbar select { flex: 1; min-width: 180px; }
  input:not([type="checkbox"]):not([type="radio"]), select { padding: 7px 10px; color: var(--fg); background: var(--surface); border: 1px solid var(--control-border); border-radius: 6px; max-width: 100%; }
  h3 { margin: 6px 0; font-size: 15px; } h4 { margin: 0 0 8px; } small { color: var(--fg-muted); font-size: 12px; font-weight: 400; }
  .project-path { display: block; margin: 4px 0; font: 12px/1.5 var(--mono); overflow-wrap: anywhere; }
  .project-note { color: var(--fg-muted); font-size: 12px; }
  .project-error { color: var(--danger-text); font-size: 12px; overflow-wrap: anywhere; }
  .manifest-preview { border: 1px solid var(--control-border); border-radius: 8px; padding: 12px; margin: 12px 0; }
  .preview-members { max-height: 220px; overflow: auto; margin: 10px 0; }
  .candidate { display: flex; gap: 10px; padding: 7px 0; align-items: start; }
  .project-members { max-height: 360px; overflow: auto; margin-top: 10px; }
  .project-member { border-top: 1px solid var(--control-border); padding: 12px 0; }
  .member-title { display: flex; justify-content: space-between; gap: 10px; }
</style>
