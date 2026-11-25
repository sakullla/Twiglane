<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../api";
  import { draftChangeRequest } from "../change-request-draft";
  import { normalizeError } from "../errors";
  import type {
    ChangeRequestDraftCommit,
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
   * 平台判断、远程解析、钥匙串读写、HTTP 请求与网页打开都在原生侧；这里负责
   * 「选远程 → 确认目标/标题/描述 → 直接创建或在浏览器里创建 → 如实展示结果」。
   *
   * - 标题与描述默认按来源相对目标多出的提交自动生成；用户改过就不再覆盖，
   *   需要时可以显式「根据提交重新生成」。
   * - 没有访问令牌时不能直接创建，但可以在浏览器里打开预填好的新建页面提交。
   * - 自建 GitLab 识别失败时手填实例地址；确认成功后原生会按远程主机记住它，
   *   下次自动沿用，可在设置里删除。
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
    onNotice?: (message: string) => void;
    /** 打开设置里的「合并请求」分区（管理记住的 GitLab 实例）。 */
    onOpenSettings?: () => void;
  }

  let { opened, nextId, returnFocus = null, onClose, onNotice, onOpenSettings }: Props = $props();

  type Phase =
    | { kind: "preparing" }
    | { kind: "choice"; choices: ChangeRequestRemoteChoice[] }
    | { kind: "ready" }
    | { kind: "submitting"; via: "api" | "web" }
    | { kind: "created"; outcome: ChangeRequestOutcome }
    | { kind: "fallback"; outcome: ChangeRequestOutcome; via: "api" | "web" }
    /** failed 保留表单，可显式重试；unknown 是结果未知，只提示去平台核对。 */
    | { kind: "failed"; code: string; message: string }
    | { kind: "unknown"; message: string };

  let phase = $state<Phase>({ kind: "preparing" });
  let prepared = $state<ChangeRequestPrepare | null>(null);
  let requestedRemote = $state<string | null>(null);
  let gitlabInstanceDraft = $state("");
  /** 用户主动展开「更改实例地址」。 */
  let instanceEditing = $state(false);
  /** 本次挂载里用户手填并确认过的实例：原生已经按远程主机记住它。 */
  let instanceRemembered = $state(false);
  /** 令牌状态：读取中 / 已配置 / 未配置 / 读不到（钥匙串不可用）。 */
  let token = $state<"checking" | "configured" | "missing" | "unavailable">("checking");
  let tokenEditing = $state(false);
  let tokenDraft = $state("");
  let tokenBusy = $state(false);
  let tokenError = $state<string | null>(null);

  let target = $state("");
  let title = $state("");
  let body = $state("");
  /** 用户动过目标分支（含清空）后，重新准备不再用平台默认值覆盖它。 */
  let targetTouched = $state(false);
  /** 用户改过标题/描述后，自动草稿不再覆盖。 */
  let titleTouched = $state(false);
  let bodyTouched = $state(false);

  /** 草稿原料：来源相对目标多出的提交。null 表示还没读到或读不到。 */
  let commits = $state<ChangeRequestDraftCommit[] | null>(null);
  let commitsTruncated = $state(false);
  let draftLoading = $state(false);
  let draftFor = $state("");
  /** 最近一次自动填入的内容：用来说明「已根据 N 个提交生成」。 */
  let generatedFrom = $state<number | null>(null);

  /** 请求序号：任何更晚发出的请求或关闭都会让更早的响应失效。 */
  let serial = 0;
  let draftSerial = 0;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let alive = true;

  const submitting = $derived(phase.kind === "submitting");
  const canConfigureGitLab = $derived(phase.kind === "failed" && (
    phase.code === "change_request_gitlab_instance" || phase.code === "change_request_gitlab_project" ||
    phase.code === "change_request_insecure" ||
    ((!prepared || prepared.gitlabInstance) &&
      (phase.code === "change_request_network" || phase.code === "change_request_platform_unknown"))
  ));
  const showInstanceForm = $derived(canConfigureGitLab || (instanceEditing && !submitting));
  const formPhase = $derived(
    phase.kind === "ready" || phase.kind === "submitting" || phase.kind === "failed" || phase.kind === "unknown",
  );
  const editable = $derived(phase.kind === "ready" || phase.kind === "failed");
  const tokenMissing = $derived(token === "missing");
  /**
   * 可以直接创建的阶段：首次填写（ready）与普通失败后由用户再点一次（failed）。
   * submitting 期间、unknown（结果未知）与没有令牌时都不提供直接创建。
   */
  const canSubmit = $derived(
    editable && !tokenMissing && target.trim().length > 0 && title.trim().length > 0,
  );
  const submitReason = $derived(
    submitting
      ? "正在处理，完成后才能再次提交"
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
                : tokenMissing
                  ? "还没有配置访问令牌：可以先在浏览器中创建，或配置令牌后直接创建"
                  : undefined,
  );
  const canOpenWeb = $derived(editable && prepared !== null && target.trim().length > 0);
  const webReason = $derived(
    submitting
      ? "正在处理，完成后才能再次提交"
      : !prepared
        ? "先读取远程与平台信息"
        : !editable
          ? "结果未知，请先在平台核对"
          : target.trim().length === 0
            ? "先填写目标分支"
            : "用系统浏览器打开预填好的新建页面，在网页里确认并提交（不需要令牌）",
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
      draftSerial += 1;
      if (draftTimer) clearTimeout(draftTimer);
    };
  });

  /** 准备：remote 为空时由原生按上游/唯一远程推断，多远程返回候选。 */
  async function start(remote: string | null, instanceUrl?: string) {
    if (tokenBusy) return;
    requestedRemote = remote;
    const path = opened.summary.path;
    const ticket = ++serial;
    phase = { kind: "preparing" };
    tokenError = null;
    tokenDraft = "";
    tokenEditing = false;
    try {
      const args = [path, remote, opened.generation, nextId()] as const;
      const result = instanceUrl
        ? await api.prepareChangeRequest(...args, instanceUrl)
        : await api.prepareChangeRequest(...args);
      if (!current(path, ticket)) return;
      if (result.status === "remoteChoice") {
        prepared = null;
        phase = { kind: "choice", choices: result.choices ?? [] };
        return;
      }
      prepared = result;
      token = "checking";
      instanceEditing = false;
      if (instanceUrl && result.gitlabInstance) {
        instanceRemembered = Boolean(result.remoteHost);
        if (result.remoteHost) {
          onNotice?.(`已记住 ${result.remoteHost} 的 GitLab 实例，下次自动使用；可在设置里删除。`);
        }
      }
      // 目标分支以平台元数据为准，只在用户还没动过时预选：清空过的输入不被覆盖。
      if (!targetTouched) target = result.targetBranch;
      phase = { kind: "ready" };
      void readToken(result);
      void loadDraft(result, target.trim(), false);
    } catch (error) {
      if (!current(path, ticket)) return;
      prepared = null;
      const failure = normalizeError(error);
      if (failure.code === "change_request_unknown") {
        phase = { kind: "unknown", message: failure.message };
        return;
      }
      phase = { kind: "failed", code: failure.code, message: failure.message };
    }
  }

  /** 令牌状态只读布尔值；读不到时如实说明，不禁用创建（原生会给准确原因）。 */
  async function readToken(request: ChangeRequestPrepare) {
    const { remote, generation } = request;
    const path = opened.summary.path;
    const ticket = serial;
    try {
      const status = await api.changeRequestTokenStatus(path, remote, generation, nextId(), request);
      if (!current(path, ticket)) return;
      if (prepared?.remote !== remote) return;
      token = status.configured ? "configured" : "missing";
    } catch {
      if (!current(path, ticket)) return;
      token = "unavailable";
    }
  }

  /**
   * 读取来源相对目标多出的提交并生成草稿。force 为真（用户点「重新生成」）时覆盖已改过的内容；
   * 否则只填用户还没动过的字段。原生不支持这项读取时静默跳过。
   */
  async function loadDraft(request: ChangeRequestPrepare, targetBranch: string, force: boolean) {
    if (typeof api.changeRequestDraft !== "function") return;
    if (!targetBranch) return;
    const path = opened.summary.path;
    const ticket = ++draftSerial;
    draftLoading = true;
    try {
      const result = await api.changeRequestDraft(
        path,
        request.remote,
        request.sourceBranch,
        targetBranch,
        request.generation,
        nextId(),
      );
      if (!alive || ticket !== draftSerial || opened.summary.path !== path) return;
      if (!result || !Array.isArray(result.commits)) return;
      commits = result.commits;
      commitsTruncated = result.truncated === true;
      draftFor = targetBranch;
      applyDraft(force);
    } catch {
      if (!alive || ticket !== draftSerial) return;
      commits = null;
    } finally {
      if (alive && ticket === draftSerial) draftLoading = false;
    }
  }

  function applyDraft(force: boolean) {
    const request = prepared;
    if (!request || commits === null || !editable) return;
    const draft = draftChangeRequest(commits, request.sourceBranch, commitsTruncated);
    // 没有任何提交、也整理不出分支名时不填空内容，保留用户已有输入。
    if (!draft.title && !draft.body) return;
    let changed = false;
    if ((force || !titleTouched) && draft.title) {
      title = draft.title;
      titleTouched = false;
      changed = true;
    }
    if ((force || !bodyTouched) && (draft.body || force)) {
      body = draft.body;
      bodyTouched = false;
      changed = true;
    }
    if (changed) generatedFrom = commits.length;
  }

  /** 目标分支变了：稍等输入停顿后按新目标重新读取草稿原料。 */
  function onTargetInput() {
    targetTouched = true;
    if (draftTimer) clearTimeout(draftTimer);
    const request = prepared;
    if (!request) return;
    draftTimer = setTimeout(() => {
      draftTimer = null;
      const next = target.trim();
      if (next && next !== draftFor) void loadDraft(request, next, false);
    }, 450);
  }

  function regenerate() {
    const request = prepared;
    if (!request) return;
    const next = target.trim();
    if (next && next === draftFor && commits !== null) applyDraft(true);
    else void loadDraft(request, next, true);
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
        request,
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
        request,
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
    phase = { kind: "submitting", via: "api" };
    try {
      const outcome = await api.createChangeRequest(
        path,
        request.remote,
        target.trim(),
        title.trim(),
        body,
        request.generation,
        nextId(),
        request,
      );
      if (!current(path, ticket)) return;
      if (outcome.status === "created") phase = { kind: "created", outcome };
      else if (outcome.status === "fallbackOpened") phase = { kind: "fallback", outcome, via: "api" };
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

  /** 不用令牌：原生打开预填好的新建网页，用户在网页里确认并提交。 */
  async function openWeb() {
    const request = prepared;
    if (!request || !canOpenWeb || typeof api.openChangeRequestWeb !== "function") return;
    const path = opened.summary.path;
    const ticket = ++serial;
    phase = { kind: "submitting", via: "web" };
    try {
      const outcome = await api.openChangeRequestWeb(
        path,
        request.remote,
        target.trim(),
        title.trim(),
        body,
        request.generation,
        nextId(),
        request,
      );
      if (!current(path, ticket)) return;
      phase = { kind: "fallback", outcome, via: "web" };
    } catch (error) {
      if (!current(path, ticket)) return;
      const failure = normalizeError(error);
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

  function beginInstanceEdit() {
    gitlabInstanceDraft = prepared?.gitlabInstance?.url ?? "";
    instanceEditing = true;
  }

  function useInstance() {
    const url = gitlabInstanceDraft.trim();
    if (!url || tokenBusy) return;
    void start(prepared?.remote ?? requestedRemote, url);
  }

  const providerIcon = $derived(prepared?.provider === "gitlab" ? "merge" : "branch");

  let tokenCard = $state<HTMLElement | null>(null);

  /** 底部的令牌状态：一眼看到能不能直接创建，点一下跳到令牌区。 */
  function revealToken() {
    if (token !== "configured" && !submitting) {
      tokenEditing = true;
      tokenDraft = "";
      tokenError = null;
    }
    tokenCard?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    queueMicrotask(() => document.getElementById("change-request-token")?.focus());
  }
</script>

<Modal
  title="创建 MR / PR"
  titleId="change-request-modal-title"
  icon="upload"
  size="lg"
  task="changeRequest"
  description="把当前分支提交为合并请求。不会自动推送，也不会改变本地 Git 状态。"
  locked={submitting}
  lockedAction={phase.kind === "submitting" && phase.via === "web" ? "打开网页" : "创建"}
  {returnFocus}
  onClose={onClose}
>
  {#if phase.kind === "preparing"}
    <div class="cr-loading" role="status">
      <span class="spinner"></span>
      <div>
        <strong>正在读取远程与平台信息…</strong>
        <span>识别平台、仓库与来源分支，不会发出任何写请求。</span>
      </div>
    </div>
  {:else if phase.kind === "choice"}
    <p class="cr-lead">这个仓库有多个远程，无法自动确定在哪里创建。请先选择远程；选择前不会向任何实例发请求。</p>
    <ul class="cr-choices" aria-label="选择远程">
      {#each phase.choices as choice (choice.remote)}
        <li>
          <button type="button" class="cr-choice" onclick={() => void start(choice.remote)}>
            <span class="cr-choice-icon"><Icon name="cloud" size={15} /></span>
            <span class="cr-choice-text">
              <span class="cr-choice-main">{choice.remote}</span>
              <span class="cr-choice-detail">
                {choice.host}{choice.repository ? ` · ${choice.repository}` : ""}{choice.provider ? ` · ${choice.provider}` : ""}
              </span>
            </span>
            <Icon name="chevron-right" size={14} />
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    {#if prepared}
      {@const info = prepared}
      <section class="cr-route" aria-label="合并路线">
        <div class="cr-route-head">
          <span class="cr-provider" data-provider={info.provider}>
            <Icon name={providerIcon} size={13} />{info.providerLabel || info.provider}
          </span>
          <span class="cr-repo" title={info.repositoryWeb}>{info.repository}</span>
          <span class="spacer"></span>
          <span class="cr-remote" title={`远程 ${info.remote}（${info.host}）`}><Icon name="cloud" size={12} />{info.remote}</span>
        </div>
        <div class="cr-flow">
          <div class="cr-branch cr-source" title="来源分支由当前分支决定（只读）">
            <span class="cr-branch-label">来源</span>
            <span class="cr-branch-name"><Icon name="branch" size={12} />{info.sourceBranch}</span>
          </div>
          <span class="cr-arrow" aria-hidden="true"><Icon name="arrow-right" size={14} /></span>
          <div class="cr-branch cr-target">
            <label class="cr-branch-label" for="change-request-target">目标分支</label>
            <input
              id="change-request-target"
              class="input cr-target-input"
              autocomplete="off"
              spellcheck="false"
              readonly={!formPhase || !editable}
              oninput={onTargetInput}
              bind:value={target}
            />
          </div>
        </div>
        {#if info.gitlabInstance}
          <ul class="cr-facts" aria-label="创建范围">
            <li class="cr-instance">
              <span>GitLab 实例</span><code>{info.gitlabInstance.url}</code>
              {#if info.instanceSaved || instanceRemembered}<em class="chip ok">已记住</em>{/if}
              {#if editable && !instanceEditing}
                <button type="button" class="cr-link" onclick={beginInstanceEdit}>更改</button>
              {/if}
            </li>
          </ul>
        {/if}
      </section>
    {/if}

    {#if showInstanceForm}
      <section class="cr-card cr-instance-card">
        <div class="cr-card-head">
          <span class="cr-card-icon"><Icon name="globe" size={14} /></span>
          <div>
            <strong>自建 GitLab？填写实例地址</strong>
            <p>确认成功后会按远程主机记住，下次自动使用{#if onOpenSettings}；可在 <button type="button" class="cr-link" onclick={onOpenSettings}>设置 › 合并请求</button> 中删除{/if}。</p>
          </div>
        </div>
        <label class="label" for="change-request-gitlab-instance">自建 GitLab 实例地址</label>
        <div class="cr-inline">
          <input
            id="change-request-gitlab-instance"
            class="input"
            type="url"
            autocomplete="off"
            spellcheck="false"
            placeholder="https://git.example.com:8443/gitlab"
            bind:value={gitlabInstanceDraft}
            onkeydown={(event) => {
              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault();
                useInstance();
              }
            }}
          />
          <button
            type="button"
            class="btn btn-primary"
            disabled={tokenBusy || gitlabInstanceDraft.trim() === ""}
            title={tokenBusy ? "正在写入钥匙串" : !gitlabInstanceDraft.trim() ? "先填写 GitLab 实例地址" : "用这个地址重新识别并记住"}
            onclick={useInstance}
          >使用此 GitLab 实例</button>
          {#if instanceEditing && !canConfigureGitLab}
            <button type="button" class="btn btn-ghost" onclick={() => (instanceEditing = false)}>取消</button>
          {/if}
        </div>
        <p class="cr-hint">
          填写浏览器访问 GitLab 的实例根地址，保留实际端口和部署子路径；支持 http:// 与 https://。
          {#if /^\s*http:\/\//i.test(gitlabInstanceDraft)}<br /><span class="cr-warn">明文 HTTP：令牌会以明文发送，只建议在可信内网使用。</span>{/if}
        </p>
      </section>
    {/if}

    <!-- 结果提示与表单分开渲染：prepare 阶段失败时没有 prepared，正文也不能是空的。 -->
    {#if phase.kind === "created"}
      <div class="cr-result ok" role="status" data-change-request-result="created">
        <span class="cr-result-icon"><Icon name="check-circle" size={18} /></span>
        <div>
          <strong>已在 {phase.outcome.providerLabel} 创建</strong>
          <span>
            {phase.outcome.repository}（{phase.outcome.sourceBranch} → {phase.outcome.targetBranch}）。
            链接由平台返回并已校验；这不表示评审、测试或合并已经完成。
          </span>
          <code data-change-request-url>{phase.outcome.url}</code>
        </div>
      </div>
    {:else if phase.kind === "fallback"}
      <div class="cr-result warn" role="status" data-change-request-result="fallback">
        <span class="cr-result-icon"><Icon name="globe" size={18} /></span>
        <div>
          <strong>{phase.via === "web" ? "已在浏览器打开新建页面" : "需要在网页里完成"}</strong>
          <span>
            {phase.via === "web" ? "" : "这个实例无法通过 API 创建，"}已用系统浏览器打开新建页面。请在那里确认范围并提交；
            在网页里完成之前，这里不认为已经创建。
            {phase.outcome.webPrefilled ? "标题、描述与目标分支已预填。" : "标题、描述与目标分支需要在网页里填写。"}
          </span>
          <code data-change-request-url>{phase.outcome.url}</code>
        </div>
      </div>
    {:else if phase.kind === "unknown"}
      <div class="callout warn" role="alert" data-change-request-result="unknown">
        <Icon name="alert-circle" size={15} />
        <span>{phase.message}</span>
      </div>
    {:else if phase.kind === "failed"}
      <div class="callout error cr-error" role="alert" data-change-request-result="failed">
        <Icon name="alert-circle" size={15} />
        <span>{phase.message}</span>
      </div>
    {/if}

    <!-- 结果未知时也保留表单：用户要照着界面内容去平台核对，不能把输入收走。 -->
    {#if prepared && formPhase}
      {@const info = prepared}
      <section class="cr-form">
        <div class="cr-field">
          <div class="cr-field-head">
            <label class="label" for="change-request-title">标题</label>
            <span class="spacer"></span>
            {#if draftLoading}
              <span class="cr-draft-status"><span class="spinner"></span>正在读取提交…</span>
            {:else if generatedFrom !== null && generatedFrom > 0}
              <span class="cr-draft-status">已根据 {generatedFrom}{commitsTruncated ? "+" : ""} 个提交生成</span>
            {/if}
            {#if commits !== null || typeof api.changeRequestDraft === "function"}
              <button
                type="button"
                class="btn btn-ghost btn-sm cr-regen"
                disabled={!editable || draftLoading || target.trim() === ""}
                title={!editable ? "当前状态不能修改内容" : draftLoading ? "正在读取提交" : target.trim() === "" ? "先填写目标分支" : "按来源相对目标的提交重新生成标题与描述（会覆盖已改的内容）"}
                onclick={regenerate}
              ><Icon name="sparkle" size={13} />根据提交生成</button>
            {/if}
          </div>
          <input
            id="change-request-title"
            class="input cr-title-input"
            data-autofocus
            autocomplete="off"
            readonly={!editable}
            placeholder="一句话说明这个合并请求要做什么"
            oninput={() => (titleTouched = true)}
            bind:value={title}
          />
        </div>
        <div class="cr-field">
          <label class="label" for="change-request-body">描述</label>
          <textarea
            id="change-request-body"
            class="textarea cr-body"
            rows="6"
            readonly={!editable}
            placeholder="可以留空；也可以点「根据提交生成」整理提交列表"
            oninput={() => (bodyTouched = true)}
            bind:value={body}
          ></textarea>
        </div>
        {#if commits !== null && commits.length > 0}
          <details class="cr-commits">
            <summary><Icon name="chevron-right" size={12} />包含 {commits.length}{commitsTruncated ? "+" : ""} 个提交（{info.sourceBranch} → {draftFor}）</summary>
            <ol>
              {#each [...commits].reverse() as commit, index (index)}
                <li><Icon name="commit" size={12} /><span>{commit.subject}</span></li>
              {/each}
            </ol>
          </details>
        {:else if commits !== null && draftFor}
          <p class="cr-hint">远程跟踪分支里没有找到 {info.sourceBranch} 相对 {draftFor} 的新提交；如果刚推送过，可先拉取再重新生成。</p>
        {/if}
      </section>

      <section class="cr-card cr-token" aria-label="访问令牌" bind:this={tokenCard}>
        <div class="cr-token-row">
          <span class="cr-card-icon"><Icon name="info" size={14} /></span>
          <p class="cr-token-text">
            <strong>访问令牌</strong>
            <span>
              {info.providerLabel} · {info.host}：
              {#if token === "configured"}已保存到系统钥匙串，可以直接创建
              {:else if token === "missing"}未配置。可以先「在浏览器中创建」，或配置令牌后直接创建
              {:else if token === "checking"}正在读取…
              {:else}状态未知（钥匙串不可用）{/if}
            </span>
          </p>
          {#if !tokenEditing && phase.kind !== "unknown"}
            <div class="cr-token-actions">
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                title={submitting ? "正在处理，完成后才能修改令牌" : undefined}
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
        </div>
        {#if tokenEditing && phase.kind !== "unknown"}
          <div class="cr-token-edit">
            <label class="label" for="change-request-token">Personal Access Token</label>
            <div class="cr-inline">
              <input
                id="change-request-token"
                class="input"
                type="password"
                autocomplete="off"
                spellcheck="false"
                placeholder={info.provider === "gitlab" ? "需要 api 权限" : info.provider === "github" ? "需要 repo / pull requests 写权限" : "需要创建合并请求的权限"}
                bind:value={tokenDraft}
              />
              <button
                type="button"
                class="btn btn-ghost btn-sm"
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
            <p class="cr-hint">只写入系统钥匙串；不会出现在设置、日志或这个界面上。</p>
          </div>
        {/if}
        {#if tokenError}
          <p class="cr-token-error" role="alert">{tokenError}</p>
        {/if}
      </section>
    {/if}
  {/if}

  {#snippet footer()}
    {#if phase.kind === "created" || phase.kind === "fallback"}
      {@const link = phase.outcome.url}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" onclick={() => void openLink(link)}>
        <Icon name="link" size={14} />在浏览器打开
      </button>
      <button type="button" class="btn btn-primary" onclick={onClose}>完成</button>
    {:else if phase.kind === "unknown"}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
    {:else}
      {#if prepared && (editable || submitting) && phase.kind !== "failed"}
        <button
          type="button"
          class="cr-token-pill"
          data-token-state={token}
          title={token === "configured" ? "访问令牌已保存：可以直接创建" : token === "missing" ? "未配置访问令牌：点此配置，或直接在浏览器中创建" : token === "checking" ? "正在读取令牌状态" : "钥匙串不可用"}
          onclick={revealToken}
        >
          <span class="cr-token-dot" aria-hidden="true"></span>
          {token === "configured" ? "令牌已就绪" : token === "missing" ? "缺少令牌" : token === "checking" ? "读取令牌…" : "令牌状态未知"}
        </button>
      {/if}
      {#if phase.kind === "failed"}
        <button
          type="button"
          class="btn btn-ghost"
          title={tokenBusy ? "正在写入钥匙串" : prepared ? "重新读取远程与平台信息" : "重新读取远程与平台信息后再决定"}
          disabled={tokenBusy}
          onclick={() => void start(prepared?.remote ?? requestedRemote, prepared?.gitlabInstance?.url)}
        ><Icon name="refresh" size={13} />重新读取</button>
      {/if}
      <span class="spacer"></span>
      <button
        type="button"
        class="btn btn-secondary"
        title={submitting ? "请求已发出，完成后才能关闭" : undefined}
        disabled={submitting}
        onclick={onClose}>取消</button>
      {#if prepared && (phase.kind === "ready" || phase.kind === "failed" || phase.kind === "submitting")}
        <!-- 没有可信上下文（prepare 失败）时不提供创建：先重新读取。 -->
        {#if typeof api.openChangeRequestWeb === "function"}
          <button
            type="button"
            class={`btn ${tokenMissing ? "btn-primary" : "btn-secondary"}`}
            title={webReason}
            disabled={!canOpenWeb}
            onclick={() => void openWeb()}>
            {#if phase.kind === "submitting" && phase.via === "web"}<span class="spinner"></span>{:else}<Icon name="globe" size={14} />{/if}在浏览器中创建
          </button>
        {/if}
        <button
          type="button"
          class={`btn ${tokenMissing ? "btn-secondary" : "btn-primary"}`}
          title={submitReason}
          disabled={!canSubmit}
          onclick={() => void submit()}>
          {#if phase.kind === "submitting" && phase.via === "api"}<span class="spinner"></span>{/if}{phase.kind === "failed" ? "再次创建" : "创建 MR / PR"}
        </button>
      {/if}
    {/if}
  {/snippet}
</Modal>

<style>
  .cr-loading { display: flex; align-items: center; gap: var(--space-12); padding: var(--space-16); border-radius: var(--radius-lg); background: var(--surface-2); }
  .cr-loading > div { display: flex; flex-direction: column; gap: 2px; }
  .cr-loading strong { font-size: var(--text-base); font-weight: var(--weight-semibold); }
  .cr-loading span:not(.spinner) { color: var(--fg-muted); font-size: var(--text-sm); }
  .cr-lead { margin: 0; color: var(--fg-muted); line-height: var(--leading-relaxed); }

  .cr-choices { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-6); }
  .cr-choice { width: 100%; display: flex; align-items: center; gap: var(--space-12); padding: 10px var(--space-12); border-radius: var(--radius); border: 1px solid var(--control-border); background: var(--surface); color: var(--fg); text-align: left; transition: border-color var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease); }
  .cr-choice:hover { border-color: var(--accent); background: var(--accent-softer); }
  .cr-choice-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--accent-text); flex: none; }
  .cr-choice-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .cr-choice-main { font-weight: var(--weight-semibold); }
  .cr-choice-detail { color: var(--fg-muted); font-size: var(--text-xs); overflow-wrap: anywhere; }

  .cr-route { display: flex; flex-direction: column; gap: var(--space-12); padding: var(--space-12) var(--space-16) var(--space-12); border-radius: var(--radius-lg); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border); }
  .cr-route-head { display: flex; align-items: center; gap: var(--space-8); min-width: 0; }
  .cr-provider { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 var(--space-8); border-radius: 999px; background: var(--accent-soft); color: var(--accent-text); font-size: var(--text-xs); font-weight: var(--weight-semibold); flex: none; }
  .cr-provider[data-provider="gitlab"] { background: var(--warning-soft); color: var(--warning-text); }
  .cr-repo { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-semibold); font-size: var(--text-base); }
  .cr-remote { display: inline-flex; align-items: center; gap: 4px; flex: none; color: var(--fg-muted); font-size: var(--text-xs); }
  .cr-flow { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: end; gap: var(--space-8); }
  .cr-branch { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .cr-branch-label { color: var(--fg-subtle); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .cr-branch-name { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: var(--radius-sm); background: var(--surface-3); color: var(--fg); font: var(--weight-medium) var(--text-sm) / 1 var(--mono); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .cr-branch-name :global(.icon) { flex: none; color: var(--accent-text); }
  .cr-arrow { display: grid; place-items: center; width: 28px; height: 32px; color: var(--fg-subtle); }
  .cr-target-input { height: 32px; font-family: var(--mono); font-size: var(--text-sm); }
  .cr-facts { list-style: none; margin: 0; padding: var(--space-8) 0 0; display: flex; flex-wrap: wrap; gap: 4px var(--space-16); box-shadow: inset 0 1px 0 var(--border); color: var(--fg-muted); font-size: var(--text-xs); }
  .cr-facts li { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
  .cr-facts li > span:first-child { color: var(--fg-subtle); }
  .cr-facts code { font-size: var(--text-xs); color: var(--fg); overflow-wrap: anywhere; }
  .cr-facts .chip { height: 18px; font-style: normal; }

  .cr-link { padding: 0; border: 0; background: none; color: var(--accent-text); font: inherit; font-weight: var(--weight-medium); cursor: pointer; }
  .cr-link:hover { text-decoration: underline; }

  .cr-card { display: flex; flex-direction: column; gap: var(--space-8); padding: var(--space-12); border-radius: var(--radius-lg); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border); }
  .cr-card-head { display: flex; gap: 10px; align-items: flex-start; }
  .cr-card-head strong { display: block; font-size: var(--text-base); font-weight: var(--weight-semibold); }
  .cr-card-head p { margin: 2px 0 0; color: var(--fg-muted); font-size: var(--text-sm); line-height: var(--leading-normal); }
  .cr-card-icon { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--accent-text); flex: none; }
  .cr-instance-card { box-shadow: inset 0 0 0 1px var(--accent-soft); background: var(--accent-softer); }
  .cr-inline { display: flex; gap: var(--space-8); align-items: center; }
  .cr-inline > .input { flex: 1; min-width: 0; }
  .cr-hint { margin: 0; color: var(--fg-subtle); font-size: var(--text-xs); line-height: var(--leading-normal); }
  .cr-warn { color: var(--warning-text); }

  .cr-result { display: flex; gap: var(--space-12); align-items: flex-start; padding: var(--space-12) var(--space-16); border-radius: var(--radius-lg); }
  .cr-result.ok { background: var(--success-soft); color: var(--success-text); }
  .cr-result.warn { background: var(--info-soft); color: var(--info-text); }
  .cr-result > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .cr-result strong { font-size: var(--text-md); font-weight: var(--weight-semibold); }
  .cr-result span { font-size: var(--text-sm); line-height: var(--leading-relaxed); }
  .cr-result code { margin-top: 4px; padding: 6px var(--space-8); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg-muted); font-size: var(--text-xs); overflow-wrap: anywhere; user-select: text; }
  .cr-result-icon { flex: none; margin-top: 2px; }

  .cr-form { display: flex; flex-direction: column; gap: var(--space-12); }
  .cr-field { display: flex; flex-direction: column; gap: 6px; }
  .cr-field-head { display: flex; align-items: center; gap: var(--space-8); min-height: 24px; }
  .cr-draft-status { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-subtle); font-size: var(--text-xs); }
  .cr-draft-status .spinner { width: 11px; height: 11px; border-width: 1.5px; }
  .cr-regen { color: var(--accent-text); }
  .cr-title-input { height: 36px; font-size: var(--text-base); font-weight: var(--weight-medium); }
  .cr-body { min-height: 140px; font-family: var(--mono); font-size: var(--text-sm); line-height: var(--leading-relaxed); resize: vertical; }
  .cr-commits { border-radius: var(--radius); background: var(--surface-2); }
  .cr-commits summary { display: flex; align-items: center; gap: 6px; padding: 7px 10px; color: var(--fg-muted); font-size: var(--text-xs); cursor: pointer; list-style: none; }
  .cr-commits summary::-webkit-details-marker { display: none; }
  .cr-commits summary :global(.icon) { transition: transform var(--duration-fast) var(--ease); }
  .cr-commits[open] summary :global(.icon) { transform: rotate(90deg); }
  .cr-commits ol { list-style: none; margin: 0; padding: 0 10px 8px; display: flex; flex-direction: column; gap: 3px; max-height: 160px; overflow: auto; }
  .cr-commits li { display: flex; align-items: center; gap: 6px; color: var(--fg); font-size: var(--text-xs); min-width: 0; }
  .cr-commits li :global(.icon) { flex: none; color: var(--fg-subtle); }
  .cr-commits li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .cr-token { gap: var(--space-8); }
  .cr-token-row { display: flex; align-items: center; gap: 10px; }
  .cr-token-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; margin: 0; font-size: var(--text-sm); }
  .cr-token-text strong { font-weight: var(--weight-semibold); }
  .cr-token-text span { color: var(--fg-muted); font-size: var(--text-xs); }
  .cr-token-actions { display: flex; gap: var(--space-6); flex: none; }
  .cr-token-edit { display: flex; flex-direction: column; gap: 6px; padding-top: var(--space-8); box-shadow: inset 0 1px 0 var(--border); }
  .cr-token-pill { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; background: var(--surface-3); color: var(--fg-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .cr-token-pill:hover { color: var(--fg); }
  .cr-token-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-subtle); }
  .cr-token-pill[data-token-state="configured"] .cr-token-dot { background: var(--success); }
  .cr-token-pill[data-token-state="missing"] { background: var(--warning-soft); color: var(--warning-text); }
  .cr-token-pill[data-token-state="missing"] .cr-token-dot { background: var(--warning); }
  .cr-token-error { margin: 0; color: var(--danger-text); font-size: var(--text-sm); }
</style>
