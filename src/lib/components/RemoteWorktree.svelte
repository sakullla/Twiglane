<script lang="ts">
  import { onDestroy, onMount, untrack, type Snippet } from "svelte";
  import { normalizeError } from "../errors";
  import {
    remoteWorktreePort,
    type RemoteConnectionProgress,
    type RemoteDiffView,
    type RemoteOpenResult,
    type RemotePendingWrite,
    type RemoteTarget,
    type RemoteWorkspace,
    type RemoteWorktreeLocation,
    type RemoteWorktreePort,
    type RemoteWorktreeSnapshot,
    type RemoteWriteAction,
    type RemoteWriteResult,
  } from "../remote-worktree";
  import Icon from "./Icon.svelte";

  interface Props {
    port?: RemoteWorktreePort;
    prefill?: RemoteWorktreeLocation;
    onOpened?: (workspace: RemoteWorkspace) => void;
    onWriteResult?: (workspace: RemoteWorkspace, result: RemoteWriteResult) => void;
    actions?: Snippet<[RemoteWorkspace]>;
  }

  interface FileRow {
    path: string;
    view: RemoteDiffView;
    mark: string;
    conflicted?: boolean;
  }

  interface OpenIntent {
    target: RemoteTarget;
    path: string;
    baseline?: string;
    recover: boolean;
  }

  const phaseLabel = {
    connecting: "连接主机",
    installing: "传输并安装 Twiglane agent",
    opening: "打开远端工作树",
  };
  const viewLabel = { staged: "已暂存", unstaged: "未暂存", task: "任务改动" };
  const displayViews = ["task", "unstaged", "staged"] as const;
  const writeLabel = { stage: "暂存", unstage: "取消暂存", commit: "提交" };
  const unmerged = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
  const fileLabel: Record<string, string> = {
    A: "新增",
    D: "删除",
    M: "修改",
    T: "类型变更",
    "?": "未跟踪",
    U: "冲突",
  };

  let { port = remoteWorktreePort, prefill, onOpened, onWriteResult, actions }: Props = $props();
  const initialLocation = untrack(() => prefill);
  let targets = $state<RemoteTarget[]>([]);
  let targetId = $state(initialLocation?.targetId ?? "");
  let path = $state(initialLocation?.path ?? "");
  let usingPrefill = !!initialLocation;
  const target = $derived(targets.find((item) => item.targetId === targetId));
  const validPath = $derived(path.startsWith("/") && !path.includes("\0"));
  let loadingTargets = $state(false);
  let connection = $state<{ requestId: string; progress: RemoteConnectionProgress } | null>(null);
  let install = $state<{ intent: OpenIntent; result: Extract<RemoteOpenResult, { kind: "install_required" }> } | null>(null);
  let workspace = $state<RemoteWorkspace | null>(null);
  let pending = $state<RemotePendingWrite | null>(null);
  let writing = $state<RemotePendingWrite | null>(null);
  let refreshing = $state(false);
  let needsRefresh = $state(false);
  let error = $state("");
  let notice = $state("");
  let message = $state("");

  const files = $derived(workspace ? rows(workspace.snapshot, workspace.baseline) : []);
  const busyReason = $derived(
    connection ? "请等待远端连接完成。" :
    writing ? "远端操作正在处理。" :
    refreshing ? "正在刷新工作树状态。" : ""
  );
  const connectionReason = $derived(busyReason || (install ? "请先确认或取消安装。" : ""));
  const targetReason = $derived(loadingTargets ? "正在读取 Cliora 主机。" : busyReason);
  const openReason = $derived(
    targetReason || connectionReason || target?.unavailableReason ||
    (!target ? "请选择 Cliora 主机。" : !validPath ? "请输入远端绝对路径。" : "")
  );
  const writeReason = $derived(
    pending ? "请先重连并核对原操作。" : connectionReason || (needsRefresh ? "请先刷新工作树状态。" : "")
  );
  const commitReason = $derived(
    writeReason ||
    (files.some((row) => row.conflicted) ? "工作树还有未解决的冲突。" :
      !files.some((row) => row.view === "staged") ? "没有已暂存的改动。" :
      !message.trim() ? "请输入提交说明。" : "")
  );
  let selected = $state<FileRow | null>(null);
  let diff = $state("");
  let nextCursor = $state<string | null>(null);
  let loadingDiff = $state(false);
  let diffError = $state("");
  let decoder = new TextDecoder();
  let readEpoch = 0;
  let destroyed = false;

  function rows(snapshot: RemoteWorktreeSnapshot, baseline?: string): FileRow[] {
    const result: FileRow[] = [];
    if (baseline) {
      for (const path of snapshot.reviewFiles ?? []) result.push({ path, view: "task", mark: "" });
    }
    for (const { path, xy } of snapshot.files) {
      if (unmerged.has(xy)) {
        result.push({ path, view: "unstaged", mark: "U", conflicted: true });
      } else if (xy === "??") {
        result.push({ path, view: "unstaged", mark: "?" });
      } else {
        if (xy[0] !== " ") result.push({ path, view: "staged", mark: xy[0] });
        if (xy[1] !== " ") result.push({ path, view: "unstaged", mark: xy[1] });
      }
    }
    return result;
  }

  function targetAddress(target: RemoteTarget): string {
    const hostname = target.effectiveHost || target.host;
    const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
    return `${target.user}@${host}:${target.port}`;
  }

  function sameRow(a: FileRow | null, b: FileRow) {
    return a?.path === b.path && a.view === b.view;
  }

  function sameWorktree(a: RemoteWorktreeSnapshot, b: RemoteWorktreeSnapshot) {
    return a.repo === b.repo && a.root === b.root;
  }

  async function loadTargets() {
    loadingTargets = true;
    error = "";
    try {
      const list = await port.targets();
      if (destroyed) return;
      targets = list;
      if (usingPrefill && initialLocation) {
        const exact = list.find((item) => item.targetId === initialLocation.targetId);
        if (!exact || exact.unavailableReason || exact.targetRevision !== initialLocation.targetRevision) {
          targetId = "";
          error = exact?.unavailableReason || "原远端主机的配置已变化或不可用，请重新选择主机。";
        } else {
          targetId = exact.targetId;
        }
      } else if (!targetId) {
        const firstAvailable = list.find((item) => !item.unavailableReason);
        targetId = firstAvailable?.targetId ?? "";
        path = firstAvailable?.defaultPath ?? "";
      } else {
        const selected = list.find((item) => item.targetId === targetId);
        if (!selected) error = "所选 Cliora 主机已不可用，请重新选择主机。";
        else if (selected.unavailableReason) error = selected.unavailableReason;
      }
    } catch (failure) {
      if (!destroyed) error = normalizeError(failure).message;
    } finally {
      if (!destroyed) loadingTargets = false;
    }
  }

  function changeTarget(id: string) {
    const selected = targets.find((item) => item.targetId === id && !item.unavailableReason);
    if (!selected) return;
    usingPrefill = false;
    targetId = id;
    path = selected.defaultPath ?? "";
    install = null;
    error = "";
  }

  function resetDiff() {
    readEpoch += 1;
    decoder = new TextDecoder();
    diff = "";
    nextCursor = null;
    loadingDiff = false;
    diffError = "";
  }

  async function readDiff(current: RemoteWorkspace, row: FileRow, cursor?: string) {
    if (cursor && loadingDiff) return;
    const epoch = readEpoch;
    loadingDiff = true;
    diffError = "";
    try {
      const page = await port.diff({
        sessionId: current.sessionId,
        generation: current.snapshot.generation,
        path: row.path,
        view: row.view,
        ...(cursor ? { cursor } : {}),
      });
      if (destroyed || epoch !== readEpoch) return;
      const bytes = Uint8Array.from(atob(page.data), (byte) => byte.charCodeAt(0));
      diff += decoder.decode(bytes, { stream: page.nextCursor !== null });
      nextCursor = page.nextCursor;
    } catch (failure) {
      if (!destroyed && epoch === readEpoch) {
        nextCursor = null;
        diffError = normalizeError(failure).message;
      }
    } finally {
      if (!destroyed && epoch === readEpoch) loadingDiff = false;
    }
  }

  function choose(row: FileRow | null) {
    resetDiff();
    selected = row;
    if (!destroyed && workspace && row && !writing && !connection) void readDiff(workspace, row);
  }

  function chooseFromSnapshot(current: RemoteWorkspace) {
    const available = rows(current.snapshot, current.baseline);
    choose(available.find((row) => sameRow(selected, row)) ??
      available.find((row) => row.view !== "staged") ?? available[0] ?? null);
  }

  function clearConnection() {
    if (!connection) return;
    const { requestId } = connection;
    connection = null;
    void port.cancelOpen(requestId).catch(() => {});
  }

  function closeSession(sessionId: string) {
    void port.close(sessionId).catch(() => {});
  }

  function resetWorkspace() {
    if (workspace) closeSession(workspace.sessionId);
    workspace = null;
    pending = null;
    message = "";
    error = "";
    notice = "";
    needsRefresh = false;
    choose(null);
  }

  onMount(() => { void loadTargets(); });
  onDestroy(() => {
    destroyed = true;
    clearConnection();
    if (workspace) closeSession(workspace.sessionId);
  });

  async function openRemote(intent: OpenIntent, confirmation?: Extract<RemoteOpenResult, { kind: "install_required" }>) {
    if (connection || writing || refreshing) return;
    const requestId = crypto.randomUUID();
    const previous = workspace;
    connection = { requestId, progress: { phase: "connecting" } };
    error = "";
    notice = "";
    install = null;
    try {
      const result = await port.open({
        requestId,
        targetId: intent.target.targetId,
        targetRevision: intent.target.targetRevision,
        path: intent.path,
        baseline: intent.baseline,
        allowInstall: !!confirmation,
        ...(confirmation?.confirmationId ? { installConfirmation: confirmation.confirmationId } : {}),
      }, (progress) => {
        if (connection?.requestId === requestId) connection = { requestId, progress };
      });
      if (destroyed || connection?.requestId !== requestId) {
        if (result.kind === "open") closeSession(result.sessionId);
        return;
      }
      if (result.kind === "install_required") {
        install = { intent, result };
        return;
      }
      if (previous && !sameWorktree(previous.snapshot, result.snapshot)) {
        closeSession(result.sessionId);
        error = "工作树身份已变化，无法在此连接中确认原操作。";
        return;
      }
      if (pending && result.pendingWrite && pending.operationId !== result.pendingWrite.operationId) {
        closeSession(result.sessionId);
        error = "远端连接返回了不同的待确认操作。";
        return;
      }
      if (previous && previous.sessionId !== result.sessionId) closeSession(previous.sessionId);
      const current: RemoteWorkspace = {
        sessionId: result.sessionId,
        target: intent.target,
        snapshot: result.snapshot,
        baseline: intent.baseline,
      };
      workspace = current;
      pending = result.pendingWrite ?? pending;
      connection = null;
      needsRefresh = false;
      if (confirmation) notice = "Twiglane agent 已就绪。";
      onOpened?.(current);
      if (intent.recover && pending) {
        await runWrite(current, pending);
      } else {
        chooseFromSnapshot(current);
      }
    } catch (failure) {
      if (connection?.requestId === requestId) {
        const phase = phaseLabel[connection.progress.phase];
        error = `${phase}失败：${normalizeError(failure).message}`;
      }
    } finally {
      if (connection?.requestId === requestId) connection = null;
    }
  }

  function submitLocation(event: SubmitEvent) {
    event.preventDefault();
    if (!target || openReason) return;
    const baseline = usingPrefill && initialLocation?.targetId === target.targetId &&
      initialLocation.targetRevision === target.targetRevision &&
      initialLocation.path === path ? initialLocation.baseline : undefined;
    void openRemote({ target, path, baseline, recover: false });
  }

  function stopConnecting() {
    const installing = connection?.progress.phase === "installing";
    clearConnection();
    notice = installing ? "已取消安装。可重新连接以检查远端状态。" : "已取消连接。";
  }

  function reconnect() {
    if (!workspace) return;
    void openRemote({
      target: workspace.target,
      path: workspace.snapshot.root,
      baseline: workspace.baseline,
      recover: !!pending,
    });
  }

  async function refresh() {
    if (!workspace || writing || connection || refreshing) return;
    const current = workspace;
    refreshing = true;
    error = "";
    notice = "";
    try {
      const snapshot = await port.status(current.sessionId);
      if (destroyed || workspace?.sessionId !== current.sessionId) return;
      if (!sameWorktree(current.snapshot, snapshot)) {
        needsRefresh = true;
        error = "工作树身份已变化，请重新连接。";
        return;
      }
      workspace = { ...current, snapshot };
      needsRefresh = false;
      if (current.snapshot.generation !== snapshot.generation) chooseFromSnapshot(workspace);
    } catch (failure) {
      if (!destroyed && workspace?.sessionId === current.sessionId) {
        needsRefresh = true;
        error = normalizeError(failure).message;
      }
    } finally {
      if (!destroyed) refreshing = false;
    }
  }

  async function runWrite(current: RemoteWorkspace, operation: RemotePendingWrite, action?: RemoteWriteAction) {
    const recovering = !action;
    writing = operation;
    error = "";
    notice = "";
    resetDiff();
    try {
      const result = action ? await port.write({
        ...action,
        sessionId: current.sessionId,
        generation: current.snapshot.generation,
        operationId: operation.operationId,
      }) : await port.recover(current.sessionId, operation.operationId);
      if (destroyed || workspace?.sessionId !== current.sessionId) return;
      if (result.operationId !== operation.operationId ||
          (result.state === "completed" && !sameWorktree(current.snapshot, result.snapshot))) {
        pending = operation;
        error = "返回的回执与原操作不匹配。";
        return;
      }
      if (result.state === "unknown") {
        pending = operation;
        error = result.message;
        return;
      }
      pending = null;
      if (result.state === "failed") {
        error = result.message;
        needsRefresh = !recovering;
        return;
      }
      if (result.state === "completed") {
        workspace = { ...current, snapshot: result.snapshot };
        needsRefresh = false;
        if (operation.op === "commit") message = "";
        const head = operation.op === "commit" ? result.head ?? result.snapshot.head : null;
        notice = `${writeLabel[operation.op]}已确认${head ? ` · ${head.slice(0, 7)}` : ""}。`;
        onWriteResult?.(workspace, result);
      }
    } catch (failure) {
      if (!destroyed && workspace?.sessionId === current.sessionId) {
        pending = operation;
        error = normalizeError(failure).message;
      }
    } finally {
      if (!destroyed && workspace?.sessionId === current.sessionId) {
        writing = null;
        if (!pending) chooseFromSnapshot(workspace);
      }
    }
  }

  function write(action: RemoteWriteAction) {
    if (!workspace || writeReason) return;
    const operation = { operationId: crypto.randomUUID(), op: action.op };
    void runWrite(workspace, operation, action);
  }
</script>

{#snippet connectionStatus()}
  {#if connection}
    <div class="remote-feedback">
      <div role="status" class="remote-progress">
        <span>正在{phaseLabel[connection.progress.phase]}…</span>
        {#if connection.progress.phase === "installing"}
          <progress
            aria-label="Agent 安装进度"
            max={connection.progress.totalBytes || 1}
            value={connection.progress.totalBytes ? connection.progress.sentBytes ?? 0 : undefined}
          ></progress>
          {#if connection.progress.totalBytes}
            <span>{Math.floor(100 * (connection.progress.sentBytes ?? 0) / connection.progress.totalBytes)}%</span>
          {/if}
        {/if}
      </div>
      <button type="button" class="btn btn-secondary btn-sm" onclick={stopConnecting}>取消</button>
    </div>
  {/if}
  {#if install}
    {@const confirm = install}
    <section class="remote-feedback remote-install" aria-label="安装 Twiglane agent">
      <div>
        <strong>安装 Twiglane agent</strong>
        <p>目标主机：{confirm.intent.target.name} · {targetAddress(confirm.intent.target)}</p>
        <p>{confirm.result.version} · {(confirm.result.size / 1024).toFixed(1)} KiB</p>
      </div>
      <div class="remote-actions">
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => (install = null)}>取消</button>
        <button type="button" class="btn btn-primary btn-sm" onclick={() => void openRemote(confirm.intent, confirm.result)}>确认安装</button>
      </div>
    </section>
  {/if}
  {#if error}<p class="remote-error" role="alert">{error}</p>{/if}
  {#if notice}<p class="remote-notice" role="status">{notice}</p>{/if}
{/snippet}

<section class="remote-worktree" aria-label="远端工作树">
  {#if !workspace}
    <div class="remote-picker">
      <h1>打开远端仓库</h1>
      <form onsubmit={submitLocation}>
        <label>
          <span>Cliora 主机</span>
          <select class="input" value={targetId} disabled={!!targetReason} title={targetReason || undefined} onchange={(event) => changeTarget(event.currentTarget.value)}>
            <option value="" disabled>选择主机</option>
            {#each targets as item (item.targetId)}
              <option value={item.targetId} disabled={!!item.unavailableReason}>
                {item.name} · {item.unavailableReason || targetAddress(item)}
              </option>
            {/each}
          </select>
        </label>
        <label>
          <span>远端工作树路径</span>
          <input
            type="text"
            class="input code"
            bind:value={path}
            disabled={!!connection}
            title={connection ? busyReason : undefined}
            oninput={() => { install = null; error = ""; }}
            placeholder="/home/me/project"
          />
        </label>
        {#if path && !validPath}<p class="hint">请输入远端绝对路径。</p>{/if}
        <div class="remote-actions">
          <button type="button" class="btn btn-secondary" disabled={!!(targetReason || connectionReason)} title={targetReason || connectionReason || undefined} onclick={() => void loadTargets()}>
            <Icon name="refresh" />刷新主机
          </button>
          <button type="submit" class="btn btn-primary" disabled={!!openReason} title={openReason || undefined}>
            <Icon name="folder-open" />打开仓库
          </button>
        </div>
      </form>
      {#if loadingTargets}
        <p class="hint" role="status">正在读取 Cliora 主机…</p>
      {:else if !targets.length && !error}
        <p class="hint" role="status">没有启用的 Cliora 主机。</p>
      {:else if !targets.some((item) => !item.unavailableReason) && !error}
        <p class="hint" role="status">已配置的 Cliora 主机当前均不可用。</p>
      {/if}
      {@render connectionStatus()}
    </div>
  {:else}
    <header class="remote-toolbar">
      <div class="remote-identity">
        <h1>{workspace.target.name} <span class="remote-address">{targetAddress(workspace.target)}</span></h1>
        <div class="remote-location">
          <code title={workspace.snapshot.root}>{workspace.snapshot.root}</code>
          <span class="remote-branch">
            <Icon name="branch" size={14} />
            <span>{workspace.snapshot.branch ?? (workspace.snapshot.head?.slice(0, 7) || "无分支")}</span>
          </span>
        </div>
      </div>
      <div class="remote-actions">
        {@render actions?.(workspace)}
        {#if needsRefresh && !pending}
          <button type="button" class="btn btn-secondary btn-sm" disabled={!!connectionReason} title={connectionReason || undefined} onclick={reconnect}>重连</button>
        {/if}
        <button type="button" class="btn btn-secondary btn-sm" disabled={!!connectionReason} title={connectionReason || undefined} onclick={() => void refresh()}>
          <Icon name="refresh" size={14} />{refreshing ? "刷新中…" : "刷新状态"}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" disabled={!!busyReason} title={busyReason || undefined} onclick={() => { install = null; resetWorkspace(); }}>
          更换仓库
        </button>
      </div>
    </header>
    {#if pending}
      <div class="remote-feedback remote-pending">
        <span role="status"><strong>结果待确认</strong> · {writeLabel[pending.op]}</span>
        <button type="button" class="btn btn-secondary btn-sm" disabled={!!connectionReason} title={connectionReason || undefined} onclick={reconnect}>
          {writing ? "核对中…" : "重连并核对"}
        </button>
      </div>
    {/if}
    {@render connectionStatus()}
    <div class="remote-layout">
      <aside class="remote-sidebar" aria-label="改动文件">
        <div class="remote-files">
          {#each displayViews as view}
            {@const group = files.filter((row) => row.view === view)}
            {#if group.length}
              <h2>{viewLabel[view]} <span>{group.length}</span></h2>
              <ul>
                {#each group as row (row.path)}
                  <li class:current={sameRow(selected, row)}>
                    <button
                      type="button"
                      class="remote-file"
                      title={row.path}
                      aria-pressed={sameRow(selected, row)}
                      aria-label={`${viewLabel[row.view]} · ${row.path}`}
                      onclick={() => { if (!sameRow(selected, row)) choose(row); }}
                    >
                      <Icon name="file" size={15} />
                      <span>{row.path}</span>
                      {#if row.mark}<span class="st" title={fileLabel[row.mark]}>{row.mark}</span>{/if}
                    </button>
                    {#if row.view !== "task" && !row.conflicted}
                      {@const op = row.view === "staged" ? "unstage" : "stage"}
                      <button
                        type="button"
                        class="btn btn-ghost btn-sm"
                        title={writeReason || writeLabel[op]}
                        aria-label={`${writeLabel[op]} ${row.path}`}
                        disabled={!!writeReason}
                        onclick={() => write({ op, path: row.path })}
                      >
                        <Icon name={op === "stage" ? "plus" : "minus"} size={15} />
                      </button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          {/each}
          {#if !files.length}<p class="hint">工作树没有改动。</p>{/if}
        </div>
        <form class="remote-commit" onsubmit={(event) => { event.preventDefault(); if (!commitReason) write({ op: "commit", message }); }}>
          <label>
            <span>提交说明</span>
            <textarea class="textarea" rows={3} bind:value={message} disabled={!!writing} title={writing ? busyReason : undefined} required></textarea>
          </label>
          <button
            type="submit"
            class="btn btn-primary"
            disabled={!!commitReason}
            title={commitReason || undefined}
          >
            <Icon name="check" />{writing?.op === "commit" && !pending ? "提交中…" : "提交已暂存改动"}
          </button>
        </form>
      </aside>
      <section class="remote-diff" aria-label="远端文件差异">
        {#if selected}
          <header><Icon name="file" /> <strong title={selected.path}>{selected.path}</strong><span>{viewLabel[selected.view]}</span></header>
          {#if diff}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (键盘用户需要滚动长差异) -->
            <div class="remote-patch" role="region" tabindex="0" aria-label="差异内容"><pre>{diff}</pre></div>
          {:else if !loadingDiff && !diffError}
            <p class="hint">没有可显示的文本差异。</p>
          {/if}
          {#if loadingDiff}
            <p class="hint" role="status">正在读取差异…</p>
          {:else if diffError}
            <div class="remote-feedback">
              <span class="remote-error" role="alert">{diffError}</span>
              <button type="button" class="btn btn-secondary btn-sm" onclick={() => choose(selected)}>重新读取差异</button>
            </div>
          {:else if nextCursor}
            <div class="remote-feedback">
              <button type="button" class="btn btn-secondary btn-sm" onclick={() => {
                if (workspace && selected && nextCursor) void readDiff(workspace, selected, nextCursor);
              }}>加载更多差异</button>
            </div>
          {/if}
        {:else}
          <p class="hint">选择文件查看差异。</p>
        {/if}
      </section>
    </div>
  {/if}
</section>

<style>
  .remote-worktree { min-width: 0; min-height: 0; height: 100%; display: flex; flex-direction: column; background: var(--surface); }
  .remote-picker { width: min(100%, 480px); margin: auto; padding: var(--space-24); overflow: auto; }
  h1 { margin: 0; font-size: var(--text-md); }
  .remote-picker h1 { margin-bottom: var(--space-16); font-size: var(--text-lg); }
  .remote-picker form, label { display: grid; gap: var(--space-8); }
  .remote-picker form { gap: var(--space-16); }
  .remote-picker .input { width: 100%; }
  .remote-actions { display: flex; flex-wrap: wrap; gap: var(--space-8); align-items: center; justify-content: flex-end; }
  .remote-picker .remote-actions { margin-top: var(--space-4); }
  .remote-feedback { padding: var(--space-8) var(--space-12); display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: var(--space-8); background: var(--surface-2); }
  .remote-picker .remote-feedback { margin-top: var(--space-12); border-radius: var(--radius); }
  .remote-feedback p { margin: var(--space-4) 0 0; color: var(--fg-muted); overflow-wrap: anywhere; }
  .remote-progress { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-8); }
  progress { accent-color: var(--accent); }
  .remote-pending { background: var(--warning-soft); color: var(--warning-text); }
  .remote-error, .remote-notice { margin: 0; padding: var(--space-8) var(--space-12); overflow-wrap: anywhere; }
  .remote-error { color: var(--danger-text); }
  .remote-notice { color: var(--fg-muted); }
  .remote-toolbar, .remote-diff > header { display: flex; align-items: center; gap: var(--space-12); padding: var(--space-12) var(--space-16); background: var(--surface-2); }
  .remote-toolbar { justify-content: space-between; flex-wrap: wrap; }
  .remote-identity { min-width: 0; }
  .remote-address { margin-left: var(--space-4); color: var(--fg-muted); font-size: var(--text-sm); font-weight: var(--weight-normal); }
  .remote-location, .remote-branch { display: flex; align-items: center; min-width: 0; gap: var(--space-8); }
  .remote-location { margin-top: var(--space-4); color: var(--fg-muted); }
  .remote-location code, .remote-diff header strong { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .remote-branch, .remote-diff header span { flex: none; font-size: var(--text-sm); }
  .remote-branch { background: var(--surface-3); border-radius: var(--radius-xs); padding: var(--space-2) var(--space-6); }
  .remote-layout { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(210px, 30%) minmax(0, 1fr); gap: 1px; background: var(--surface-3); }
  .remote-sidebar, .remote-diff { min-height: 0; min-width: 0; display: flex; flex-direction: column; background: var(--surface); }
  .remote-files { flex: 1; overflow: auto; padding: var(--space-8); }
  .remote-files h2 { display: flex; align-items: center; gap: var(--space-6); font-size: var(--text-sm); margin: var(--space-4) var(--space-8); color: var(--fg-muted); }
  .remote-files h2 span { font-weight: var(--weight-normal); }
  .remote-files ul { margin: 0 0 var(--space-8); padding: 0; list-style: none; }
  .remote-files li { display: flex; align-items: center; border-radius: var(--radius-sm); padding-right: var(--space-4); }
  .remote-files li:hover { background: var(--hover); }
  .remote-files li.current { background: var(--accent-soft); }
  .remote-file { display: flex; align-items: center; flex: 1; min-width: 0; gap: var(--space-6); padding: var(--space-8); text-align: left; }
  .remote-file span:first-of-type { min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .remote-commit { display: flex; flex-direction: column; gap: var(--space-8); padding: var(--space-12); background: var(--surface-2); }
  .remote-commit textarea { width: 100%; resize: vertical; max-height: 30vh; }
  .remote-diff header strong { flex: 1; }
  .remote-diff > .hint { padding: var(--space-8) var(--space-16); }
  .remote-patch { flex: 1; min-height: 0; overflow: auto; }
  pre { margin: 0; padding: var(--space-12) var(--space-16); font: var(--text-sm)/var(--leading-relaxed) var(--mono); }
</style>
