<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../api";
  import { normalizeError } from "../errors";
  import type {
    ChangeRequestOutcome,
    ChangeRequestPrepare,
    ChangeRequestRemoteChoice,
    OpenedRepository,
  } from "../types";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  /**
   * 为当前分支创建 MR/PR：一次只处理一个仓库实例。
   *
   * 平台判断、远程解析、钥匙串读写、HTTP 请求与网页回退都在原生侧；这里只负责
   * 「选远程 → 确认目标/标题/描述 → 显式创建 → 如实展示结果」这条用户流程。
   *
   * 结果只有平台证实才算成功：created 是原生已验证的链接，fallbackOpened 只是打开了
   * 新建网页（需要在网页继续），failed / unknown 都不显示成功字样。请求发出后拿不到
   * 完整响应时是 unknown（结果未知），不鼓励盲目重试。失败保留表单内容，且不自动重试。
   *
   * 每个响应都带请求序号与仓库路径核对：切换仓库或关闭对话框后，迟到响应不再作用于
   * 新上下文（对话框由外壳按当前仓库重挂，这里再挡一次同一次挂载内的竞态）。
   */
  interface Props {
    /** 当前打开的仓库：路径与 generation 是请求上下文，切换仓库后旧响应会被丢弃。 */
    opened: OpenedRepository;
    nextId: () => number;
    /** 关闭后焦点去处：由外壳在打开前记下。 */
    returnFocus?: HTMLElement | null;
    onClose: () => void;
    /** 打开系统浏览器查看平台链接（复用既有外链打开命令，仍是原生校验）。 */
    onNotice?: (message: string) => void;
  }

  let { opened, nextId, returnFocus = null, onClose, onNotice }: Props = $props();

  type Phase =
    | { kind: "preparing" }
    | { kind: "choice"; choices: ChangeRequestRemoteChoice[] }
    | { kind: "ready" }
    | { kind: "submitting" }
    | { kind: "created"; outcome: ChangeRequestOutcome }
    | { kind: "fallback"; outcome: ChangeRequestOutcome }
    /** failed 保留表单，可显式重试；unknown 是结果未知，只提示去平台核对。 */
    | { kind: "failed"; code: string; message: string }
    | { kind: "unknown"; message: string };

  let phase = $state<Phase>({ kind: "preparing" });
  let prepared = $state<ChangeRequestPrepare | null>(null);
  /** 令牌状态只有三种：已配置 / 未配置 / 读不到（钥匙串不可用）。 */
  let token = $state<"configured" | "missing" | "unavailable">("missing");
  let tokenEditing = $state(false);
  let tokenDraft = $state("");
  let tokenBusy = $state(false);
  let tokenError = $state<string | null>(null);

  let target = $state("");
  let title = $state("");
  let body = $state("");
  /** 用户动过目标分支（含清空）后，重新准备不再用平台默认值覆盖它。 */
  let targetTouched = $state(false);

  /** 请求序号：任何更晚发出的请求或关闭都会让更早的响应失效。 */
  let serial = 0;
  let alive = true;

  const submitting = $derived(phase.kind === "submitting");
  /**
   * 可以提交的阶段：首次填写（ready）与普通失败后由用户再点一次（failed）。
   * submitting 期间与 unknown（结果未知）都不提供再次创建。
   */
  const canSubmit = $derived(
    (phase.kind === "ready" || phase.kind === "failed") &&
      target.trim().length > 0 &&
      title.trim().length > 0,
  );
  const submitReason = $derived(
    submitting
      ? "正在创建，完成后才能再次提交"
      : phase.kind === "preparing"
        ? "正在读取远程与平台信息"
        : phase.kind === "choice"
          ? "先在上方选择远程"
          : phase.kind === "unknown"
            ? "结果未知，请先在平台核对"
            : target.trim().length === 0
              ? "先填写目标分支"
              : title.trim().length === 0
                ? "先填写标题"
                : undefined,
  );

  /** 同一个仓库、同一次挂载才有权更新界面；切仓或关闭后一律丢弃。 */
  function current(path: string, ticket: number): boolean {
    return alive && ticket === serial && opened.summary.path === path;
  }

  onMount(() => {
    void start(null);
    return () => {
      alive = false;
      // 关闭即让在途请求失效：它返回后不再改这里的状态。
      serial += 1;
    };
  });

  /** 准备：remote 为空时由原生按上游/唯一远程推断，多远程返回候选。 */
  async function start(remote: string | null) {
    const path = opened.summary.path;
    const ticket = ++serial;
    phase = { kind: "preparing" };
    tokenError = null;
    try {
      const result = await api.prepareChangeRequest(path, remote, opened.generation, nextId());
      if (!current(path, ticket)) return;
      if (result.status === "remoteChoice") {
        prepared = null;
        phase = { kind: "choice", choices: result.choices ?? [] };
        return;
      }
      prepared = result;
      // 目标分支以平台元数据为准，只在用户还没动过时预选：清空过的输入不被覆盖。
      if (!targetTouched) target = result.targetBranch;
      phase = { kind: "ready" };
      void readToken(result.remote, result.generation);
    } catch (error) {
      if (!current(path, ticket)) return;
      const failure = normalizeError(error);
      if (failure.code === "change_request_unknown") {
        phase = { kind: "unknown", message: failure.message };
        return;
      }
      phase = { kind: "failed", code: failure.code, message: failure.message };
    }
  }

  /** 令牌状态只读布尔值；读不到时按「未配置」提示，但不禁用创建（原生会给准确原因）。 */
  async function readToken(remote: string, generation: number) {
    const path = opened.summary.path;
    const ticket = serial;
    try {
      const status = await api.changeRequestTokenStatus(path, remote, generation, nextId());
      if (!current(path, ticket)) return;
      if (prepared?.remote !== remote) return;
      token = status.configured ? "configured" : "missing";
    } catch {
      if (!current(path, ticket)) return;
      token = "unavailable";
    }
  }

  async function saveToken() {
    const request = prepared;
    if (!request || tokenBusy || tokenDraft.trim() === "") return;
    const path = opened.summary.path;
    tokenBusy = true;
    tokenError = null;
    try {
      const status = await api.setChangeRequestToken(
        path,
        request.remote,
        tokenDraft,
        request.generation,
        nextId(),
      );
      if (!alive || opened.summary.path !== path) return;
      token = status.configured ? "configured" : "missing";
      // 明文只经过这次 IPC：保存后立刻清空输入框，界面不留令牌。
      tokenDraft = "";
      tokenEditing = false;
      onNotice?.("已把令牌保存到系统钥匙串。");
    } catch (error) {
      if (!alive || opened.summary.path !== path) return;
      tokenError = normalizeError(error).message;
    } finally {
      tokenBusy = false;
    }
  }

  async function deleteToken() {
    const request = prepared;
    if (!request || tokenBusy) return;
    const path = opened.summary.path;
    tokenBusy = true;
    tokenError = null;
    try {
      const status = await api.deleteChangeRequestToken(
        path,
        request.remote,
        request.generation,
        nextId(),
      );
      if (!alive || opened.summary.path !== path) return;
      token = status.configured ? "configured" : "missing";
      onNotice?.("已从系统钥匙串删除这个实例的令牌。");
    } catch (error) {
      if (!alive || opened.summary.path !== path) return;
      tokenError = normalizeError(error).message;
    } finally {
      tokenBusy = false;
    }
  }

  /** 显式创建：submitting 期间按钮不可再点，函数自身也拦住重复提交。 */
  async function submit() {
    const request = prepared;
    if (!request || !canSubmit) return;
    const path = opened.summary.path;
    const ticket = ++serial;
    phase = { kind: "submitting" };
    try {
      const outcome = await api.createChangeRequest(
        path,
        request.remote,
        target.trim(),
        title.trim(),
        body,
        request.generation,
        nextId(),
      );
      if (!current(path, ticket)) return;
      if (outcome.status === "created") phase = { kind: "created", outcome };
      else if (outcome.status === "fallbackOpened") phase = { kind: "fallback", outcome };
      else
        phase = {
          kind: "unknown",
          message: "平台返回了无法确认的结果：请先在平台核对是否已创建，不要直接重复创建。",
        };
    } catch (error) {
      if (!current(path, ticket)) return;
      const failure = normalizeError(error);
      if (failure.code === "change_request_unknown") {
        // 请求可能已经发出：只提示核对，不给再次创建的按钮。
        phase = { kind: "unknown", message: failure.message };
        return;
      }
      if (failure.code === "change_request_token_missing") token = "missing";
      phase = { kind: "failed", code: failure.code, message: failure.message };
    }
  }

  async function openLink(url: string) {
    try {
      await api.openDocumentUrl(url);
    } catch (error) {
      onNotice?.(normalizeError(error).message);
    }
  }
</script>

<Modal
  title="创建 MR / PR"
  titleId="change-request-modal-title"
  icon="upload"
  size="lg"
  task="changeRequest"
  description="来源分支由当前分支决定，应用不会自动推送，也不会改变本地 Git 状态。"
  locked={submitting}
  {returnFocus}
  onClose={onClose}
>
  {#if phase.kind === "preparing"}
    <p class="change-request-status" role="status"><span class="spinner"></span> 正在读取远程与平台信息…</p>
  {:else if phase.kind === "choice"}
    <p>这个仓库有多个远程，无法自动确定在哪里创建。请先选择远程；选择前不会向任何实例发请求。</p>
    <ul class="change-request-choices" aria-label="选择远程">
      {#each phase.choices as choice (choice.remote)}
        <li>
          <button
            type="button"
            class="change-request-choice"
            onclick={() => void start(choice.remote)}
          >
            <Icon name="branch" size={14} />
            <span class="change-request-choice-main">{choice.remote}</span>
            <span class="change-request-choice-detail">
              {choice.host}{choice.repository ? ` · ${choice.repository}` : ""}{choice.provider ? ` · ${choice.provider}` : ""}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    {#if prepared}
      {@const info = prepared}
      <ul class="scope-list" aria-label="创建范围">
        <li>平台 · {info.providerLabel || info.provider}</li>
        <li>远程 · {info.remote}（{info.host}）</li>
        <li>仓库 · {info.repository}</li>
        <li>来源分支 · {info.sourceBranch}（只读，来自当前分支）</li>
      </ul>
    {/if}

    <!-- 结果提示与表单分开渲染：prepare 阶段失败时没有 prepared，正文也不能是空的。 -->
    {#if phase.kind === "created"}
      <div class="callout info" role="status" data-change-request-result="created">
        <Icon name="check-circle" size={15} />
        <span>
          已在 {phase.outcome.providerLabel} 创建：{phase.outcome.repository}（{phase.outcome.sourceBranch} → {phase.outcome.targetBranch}）。
          链接由平台返回并已校验；这不表示评审、测试或合并已经完成。
        </span>
      </div>
      <p class="change-request-link">
        <code data-change-request-url>{phase.outcome.url}</code>
      </p>
    {:else if phase.kind === "fallback"}
      <div class="callout warn" role="status" data-change-request-result="fallback">
        <Icon name="info" size={15} />
        <span>
          这个实例无法通过 API 创建，已用系统浏览器打开新建页面。请在那里确认范围并提交；
          在网页里完成之前，这里不认为已经创建。
          {phase.outcome.webPrefilled ? "标题与描述已预填。" : "标题、描述与目标分支需要在网页里填写。"}
        </span>
      </div>
      <p class="change-request-link">
        <code data-change-request-url>{phase.outcome.url}</code>
      </p>
    {:else if phase.kind === "unknown"}
      <div class="callout warn" role="alert" data-change-request-result="unknown">
        <Icon name="alert-circle" size={15} />
        <span>{phase.message}</span>
      </div>
    {:else if phase.kind === "failed"}
      <p class="change-request-error" role="alert" data-change-request-result="failed">
        <Icon name="alert-circle" size={14} />
        <span>{phase.message}</span>
      </p>
    {/if}

    <!-- 结果未知时也保留表单：用户要照着界面内容去平台核对，不能把输入收走。 -->
    {#if prepared && (phase.kind === "ready" || phase.kind === "submitting" || phase.kind === "failed" || phase.kind === "unknown")}
      {@const info = prepared}
      <div class="change-request-form">
        <label class="label" for="change-request-target">目标分支</label>
        <input
          id="change-request-target"
          class="input"
          autocomplete="off"
          spellcheck="false"
          readonly={submitting}
          oninput={() => (targetTouched = true)}
          bind:value={target}
        />
        <label class="label" for="change-request-title">标题</label>
        <input
          id="change-request-title"
          class="input"
          data-autofocus
          autocomplete="off"
          readonly={submitting}
          placeholder="一句话说明这个合并请求要做什么"
          bind:value={title}
        />
        <label class="label" for="change-request-body">描述</label>
        <textarea
          id="change-request-body"
          class="textarea"
          rows="4"
          readonly={submitting}
          placeholder="可以留空；应用不会替你编造描述"
          bind:value={body}
        ></textarea>
      </div>

      <div class="change-request-token" aria-label="访问令牌">
        <p class="change-request-token-head">
          <Icon name="info" size={14} />
          <span>
            访问令牌（{info.providerLabel} · {info.host}）：
            {#if token === "configured"}已保存到系统钥匙串
            {:else if token === "missing"}未配置
            {:else}状态未知（钥匙串不可用）{/if}
          </span>
        </p>
        {#if tokenEditing && phase.kind !== "unknown"}
          <label class="label" for="change-request-token">Personal Access Token</label>
          <input
            id="change-request-token"
            class="input"
            type="password"
            autocomplete="off"
            spellcheck="false"
            bind:value={tokenDraft}
          />
          <p class="change-request-hint">只写入系统钥匙串；不会出现在设置、日志或这个界面上。</p>
          <div class="change-request-token-actions">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              title={tokenBusy ? "正在写入钥匙串" : undefined}
              disabled={tokenBusy}
              onclick={() => {
                tokenEditing = false;
                tokenDraft = "";
                tokenError = null;
              }}>取消</button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              title={tokenBusy ? "正在写入钥匙串" : tokenDraft.trim() === "" ? "先粘贴令牌" : undefined}
              disabled={tokenBusy || tokenDraft.trim() === ""}
              onclick={() => void saveToken()}>
              {#if tokenBusy}<span class="spinner"></span>{/if}保存令牌
            </button>
          </div>
        {:else if phase.kind !== "unknown"}
          <div class="change-request-token-actions">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              title={submitting ? "正在创建，完成后才能修改令牌" : undefined}
              disabled={submitting}
              onclick={() => {
                tokenEditing = true;
                tokenDraft = "";
                tokenError = null;
              }}>{token === "configured" ? "替换令牌…" : "配置令牌…"}</button>
            {#if token === "configured"}
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                title={submitting || tokenBusy ? "正在创建或写入钥匙串" : "只删除这个实例的令牌，不影响其它实例"}
                disabled={submitting || tokenBusy}
                onclick={() => void deleteToken()}>删除令牌</button>
            {/if}
          </div>
        {/if}
        {#if tokenError}
          <p class="change-request-error" role="alert">{tokenError}</p>
        {/if}
        {#if token === "missing"}
          <p class="change-request-hint">没有令牌时不会创建，也不会自动打开网页。</p>
        {/if}
      </div>
    {/if}
  {/if}

  {#snippet footer()}
    <span class="spacer"></span>
    {#if phase.kind === "created" || phase.kind === "fallback"}
      {@const link = phase.outcome.url}
      <button type="button" class="btn btn-secondary" onclick={() => void openLink(link)}>
        <Icon name="link" size={14} />在浏览器打开
      </button>
      <button type="button" class="btn btn-primary" onclick={onClose}>完成</button>
    {:else if phase.kind === "unknown"}
      <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
    {:else if phase.kind === "failed"}
      <button type="button" class="btn btn-secondary" onclick={onClose}>取消</button>
      <button
        type="button"
        class="btn btn-secondary"
        title={prepared ? undefined : "重新读取远程与平台信息后再决定"}
        onclick={() => void start(prepared?.remote ?? null)}
      >重新读取</button>
      {#if prepared}
        <!-- 没有可信上下文（prepare 失败）时不提供创建：先重新读取。 -->
        <button
          type="button"
          class="btn btn-primary"
          title={submitReason}
          disabled={submitting || !canSubmit}
          onclick={() => void submit()}>再次创建</button>
      {/if}
    {:else}
      <button
        type="button"
        class="btn btn-secondary"
        title={submitting ? "创建请求已发出，完成后才能关闭" : undefined}
        disabled={submitting}
        onclick={onClose}>取消</button>
      <button
        type="button"
        class="btn btn-primary"
        title={submitReason}
        disabled={!canSubmit}
        onclick={() => void submit()}>
        {#if submitting}<span class="spinner"></span>{/if}创建 MR / PR
      </button>
    {/if}
  {/snippet}
</Modal>

<style>
  .change-request-status {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .change-request-choices {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .change-request-choice {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--fg);
    text-align: left;
  }
  .change-request-choice:hover {
    border-color: var(--control-border-hover);
  }
  .change-request-choice-main {
    font-weight: var(--weight-semibold);
  }
  .change-request-choice-detail {
    color: var(--fg-muted);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }
  .change-request-form {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .change-request-form .label:not(:first-child) {
    margin-top: 6px;
  }
  .change-request-hint {
    margin: 0;
    color: var(--fg-subtle);
    font-size: var(--text-xs);
  }
  .change-request-link {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: var(--text-xs);
  }
  .change-request-link code {
    color: var(--fg-muted);
  }
  .change-request-error {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin: 0;
    color: var(--danger-text);
    line-height: var(--leading-relaxed);
  }
  .change-request-token {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px var(--space-12);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .change-request-token-head {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
  }
  .change-request-token-actions {
    display: flex;
    gap: 8px;
  }
</style>
