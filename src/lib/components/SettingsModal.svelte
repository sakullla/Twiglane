<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { BUSY_REASON } from "../ui";
  import { dependencyNote } from "../labels";
  import { api, appVersion, pickFile } from "../api";
  import type {
    GitInfo,
    GitLabInstanceEntry,
    PullIntegration,
    RemoteSshSettings,
    SshProbe,
    SshTarget,
    SshTargetInput,
    TerminalPrefs,
    TerminalProfile,
    Theme,
  } from "../types";
  import { TERMINAL_FONT_DEFAULT, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, clampFontSize } from "../terminal";
  import { LANGUAGE_OPTIONS } from "../syntax/languages";
  import { setSyntaxEnabled, syntaxPrefs } from "../syntax/prefs.svelte";
  import { checkForUpdates, installUpdate, isNativeRuntime, updateState } from "../update.svelte";
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    theme: Theme;
    git: GitInfo | null;
    disabled: boolean;
    onClose: () => void;
    /** 选择外观；"system" 解析成浅色还是深色由外壳负责。 */
    onTheme: (theme: Theme) => void;
    /** 分叉拉取的预选方式。缺省合并，与旧设置文件一致。 */
    pullIntegration?: PullIntegration;
    branchGroups?: boolean;
    onPullIntegration?: (mode: PullIntegration) => void;
    onBranchGroups?: (enabled: boolean) => void;
    /** 左栏是否显示「文件」视图。 */
    filesView?: boolean;
    onFilesView?: (enabled: boolean) => void;
    /** 「创建 MR / PR」功能开关；缺省关闭，与原生默认一致。 */
    changeRequestsEnabled?: boolean;
    onChangeRequests?: (enabled: boolean) => void;
    /** 终端偏好与本机探测到的终端类型；打开设置时由外壳探测一次。 */
    terminalPrefs?: TerminalPrefs;
    terminalProfiles?: TerminalProfile[];
    onTerminalPrefs?: (prefs: TerminalPrefs) => void;
    onLoadTerminalProfiles?: () => void;
    onRedetect: () => void;
    onChooseGit: () => void;
    onClearGit: () => void;
    /**
     * 打开时定位的分区：Git 不可用的诊断入口指向 "runtime"，更新提示入口指向
     * "update"，其余入口不传（等价于现在的首屏：外观在运行环境之上）。不改任何按钮行为。
     */
    section?: "appearance" | "runtime" | "update" | "terminal" | "changeRequest" | null;
    /** 关闭后焦点去处（命令面板打开时由外壳传入）。 */
    returnFocus?: HTMLElement | null;
  }

  let {
    theme,
    git,
    disabled,
    onClose,
    onTheme,
    pullIntegration = "merge",
    branchGroups = true,
    onPullIntegration = () => {},
    onBranchGroups = () => {},
    filesView = true,
    onFilesView = () => {},
    changeRequestsEnabled = false,
    onChangeRequests = () => {},
    terminalPrefs = { profile: null, fontSize: TERMINAL_FONT_DEFAULT },
    terminalProfiles = [],
    onTerminalPrefs = () => {},
    onLoadTerminalProfiles = () => {},
    onRedetect,
    onChooseGit,
    onClearGit,
    section = null,
    returnFocus = null,
  }: Props = $props();

  const THEMES: { id: Theme; label: string; icon: IconName }[] = [
    { id: "light", label: "浅色", icon: "sun" },
    { id: "dark", label: "深色", icon: "moon" },
    { id: "system", label: "跟随系统", icon: "maximize" },
  ];
  const PULLS: { id: PullIntegration; label: string }[] = [
    { id: "merge", label: "合并" },
    { id: "rebase", label: "变基" },
  ];

  let runtimeSection = $state<HTMLElement | null>(null);
  let updateSection = $state<HTMLElement | null>(null);
  let terminalSection = $state<HTMLElement | null>(null);
  let changeRequestSection = $state<HTMLElement | null>(null);

  /* ---- 分区导航：左侧目录 + 右侧单页滚动；搜索按关键词收窄分区 ---- */

  type SectionId = "appearance" | "repository" | "change-request" | "terminal" | "remote" | "runtime" | "update";
  const SECTIONS: { id: SectionId; label: string; icon: IconName; keywords: string }[] = [
    { id: "appearance", label: "外观", icon: "sun", keywords: "外观 主题 浅色 深色 跟随系统 语法高亮 代码 颜色 theme" },
    { id: "repository", label: "仓库", icon: "folder", keywords: "仓库 拉取 合并 变基 分叉 分支 分组 斜杠 文件视图 左栏 pull rebase" },
    { id: "change-request", label: "合并请求", icon: "merge", keywords: "合并请求 MR PR 创建 GitLab GitHub Gitea 自建 实例 地址 令牌 token 钥匙串" },
    { id: "terminal", label: "终端", icon: "terminal", keywords: "终端 默认终端 shell 字号 字体 terminal" },
    { id: "remote", label: "远程 SSH", icon: "cloud", keywords: "远程 SSH 主机 密钥 密码 ssh-agent 远端组件 连接" },
    { id: "runtime", label: "运行环境", icon: "code", keywords: "运行环境 Git 版本 检测 路径 WebView2 安装 诊断" },
    { id: "update", label: "应用更新", icon: "download", keywords: "应用更新 版本 检查更新 下载 安装 update" },
  ];

  let search = $state("");
  let scroller = $state<HTMLElement | null>(null);
  function sectionIdOf(entry: typeof section): SectionId {
    if (entry === "runtime" || entry === "update" || entry === "terminal") return entry;
    return entry === "changeRequest" ? "change-request" : "appearance";
  }
  let activeSection = $state<SectionId>(untrack(() => sectionIdOf(section)));
  let visibleSections = $derived.by(() => {
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return new Set(SECTIONS.map((item) => item.id));
    return new Set(
      SECTIONS.filter((item) => {
        const haystack = `${item.label} ${item.keywords}`.toLocaleLowerCase();
        return terms.every((term) => haystack.includes(term));
      }).map((item) => item.id),
    );
  });

  function sectionNode(id: SectionId): HTMLElement | null {
    return scroller?.querySelector<HTMLElement>(`[data-settings-section="${id}"]`) ?? null;
  }

  /** 点目录：滚到分区顶部（不用 scrollIntoView，避免整个弹窗跟着滚）。 */
  /** 点目录后的平滑滚动期间不让滚动监听改写高亮，否则滚到底时会跳到最后一个分区。 */
  let spyPausedUntil = 0;

  function goTo(id: SectionId) {
    activeSection = id;
    spyPausedUntil = Date.now() + 800;
    const node = sectionNode(id);
    if (!scroller || !node) return;
    const top = node.offsetTop - scroller.offsetTop - 12;
    if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    else scroller.scrollTop = Math.max(0, top);
  }

  /** 滚动时高亮当前分区：取顶端已经越过视口上沿的最后一个分区。 */
  function spy() {
    if (!scroller || Date.now() < spyPausedUntil) return;
    const limit = scroller.scrollTop + scroller.offsetTop + 48;
    let current: SectionId | null = null;
    for (const item of SECTIONS) {
      if (!visibleSections.has(item.id)) continue;
      const node = sectionNode(item.id);
      if (!node) continue;
      if (node.offsetTop <= limit || current === null) current = item.id;
    }
    // 滚到底时最后一个分区可能永远越不过上沿：直接认它。
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
      const last = [...SECTIONS].reverse().find((item) => visibleSections.has(item.id));
      if (last) current = last.id;
    }
    if (current) activeSection = current;
  }

  $effect(() => {
    void visibleSections;
    if (!visibleSections.has(activeSection)) {
      const first = SECTIONS.find((item) => visibleSections.has(item.id));
      if (first) activeSection = first.id;
    }
  });

  /* ---- 合并请求：记住的自建 GitLab 实例 ---- */

  let instances = $state<GitLabInstanceEntry[]>([]);
  let instancesLoaded = $state(false);
  let instanceMessage = $state<{ tone: "error" | "info"; text: string } | null>(null);
  let instanceBusy = $state(false);
  let instanceDraft = $state<{ host: string; url: string; editing: string | null } | null>(null);
  let instanceDeleting = $state<string | null>(null);
  const instancesSupported = typeof api.changeRequestInstances === "function";

  async function loadInstances() {
    if (!instancesSupported) {
      instancesLoaded = true;
      return;
    }
    try {
      const loaded = await api.changeRequestInstances();
      if (Array.isArray(loaded)) instances = loaded;
    } catch (error) {
      instanceMessage = { tone: "error", text: sshErrorText(error) };
    } finally {
      instancesLoaded = true;
    }
  }

  void loadInstances();

  async function saveInstance() {
    const draft = instanceDraft;
    if (!draft || instanceBusy) return;
    const host = draft.host.trim();
    const url = draft.url.trim();
    if (!host || !url) return;
    instanceBusy = true;
    instanceMessage = null;
    try {
      // 改了主机名：先删旧条目，再按新主机保存。
      if (draft.editing && draft.editing !== host.toLowerCase()) {
        await api.deleteChangeRequestInstance(draft.editing, false);
      }
      instances = await api.saveChangeRequestInstance(host, url);
      instanceDraft = null;
      instanceMessage = { tone: "info", text: `已保存 ${host.toLowerCase()} 的 GitLab 实例地址。` };
    } catch (error) {
      instanceMessage = { tone: "error", text: sshErrorText(error) };
    } finally {
      instanceBusy = false;
    }
  }

  async function removeInstance(host: string, withToken: boolean) {
    if (instanceBusy) return;
    instanceBusy = true;
    instanceMessage = null;
    try {
      instances = await api.deleteChangeRequestInstance(host, withToken);
      instanceDeleting = null;
      if (instanceDraft?.editing === host) instanceDraft = null;
      instanceMessage = { tone: "info", text: withToken ? `已删除 ${host} 的实例配置与令牌。` : `已删除 ${host} 的实例配置；下次创建会重新识别。` };
    } catch (error) {
      instanceMessage = { tone: "error", text: sshErrorText(error) };
    } finally {
      instanceBusy = false;
    }
  }

  function savedAtText(ms: number): string {
    if (!ms) return "";
    try {
      return new Date(ms).toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      return "";
    }
  }

  // 打开设置时探测一次本机终端类型（外壳缓存结果，重复打开不再探测）。
  onMount(() => onLoadTerminalProfiles());

  /** 设置里的默认终端已不在本机时如实说明，启动时后端会退回平台默认。 */
  let terminalProfileMissing = $derived(
    Boolean(terminalPrefs.profile) &&
      terminalProfiles.length > 0 &&
      !terminalProfiles.some((profile) => profile.id === terminalPrefs.profile),
  );
  let terminalSelected = $derived(
    terminalProfiles.find((profile) => profile.id === terminalPrefs.profile) ?? terminalProfiles[0] ?? null,
  );

  function setTerminalProfile(id: string) {
    onTerminalPrefs({ ...terminalPrefs, profile: id || null });
  }

  function stepTerminalFont(delta: number) {
    onTerminalPrefs({ ...terminalPrefs, fontSize: clampFontSize(terminalPrefs.fontSize + delta) });
  }

  /* 诊断入口要真的落到运行环境分区：Modal 的首焦点读 [data-autofocus]，
     这里再补一次滚动，避免那一块在 modal 滚动区之外。 */
  $effect(() => {
    if (section !== "runtime" && section !== "update" && section !== "terminal" && section !== "changeRequest") return;
    const target =
      section === "update"
        ? updateSection
        : section === "terminal"
          ? terminalSection
          : section === "changeRequest"
            ? changeRequestSection
            : runtimeSection;
    if (!target || typeof target.scrollIntoView !== "function") return;
    target.scrollIntoView({ block: "start" });
  });

  let platform = $derived(navigator.platform ?? "");
  let gitLine = $derived(
    git === null
      ? "尚未检测 Git"
      : git.available
        ? `Git ${git.version ?? "已可用"}${git.path ? ` · ${git.path}` : ""}${git.overridden ? " · 手动指定" : ""}`
        : (git.message ?? "Git 不可用"),
  );
  /** Git 缺失或低于基线时用户正需要这些说明，默认展开，不让人再去找（R11）。 */
  let needsHelp = $derived(git !== null && (!git.available || git.belowBaseline));
  let gitStatus = $derived.by(() => {
    if (git === null) return { tone: "skip", label: "尚未检测" };
    if (!git.available) return { tone: "danger", label: "Git 不可用" };
    if (git.belowBaseline) return { tone: "warn", label: "版本过低" };
    return { tone: "ok", label: "Git 可用" };
  });
  /** 诊断不只说哪里出错，还要给出当前入口能执行的下一步。 */
  let gitNextStep = $derived.by(() => {
    if (git === null) return "点「重新检测」读取本机 Git 状态。";
    if (!git.available) {
      return git.overridden
        ? "下一步：重新选择可执行的 Git，或「恢复自动检测」后再点「重新检测」。"
        : "下一步：安装 Git 后点「重新检测」，或用「选择 Git」指定已安装的可执行文件。";
    }
    if (git.belowBaseline) {
      return "下一步：建议升级到 2.48 或更新版本；当前版本仍会继续使用，也可以用「选择 Git」指定其他版本。";
    }
    return null;
  });

  /* ---- 应用更新分区（R1/R2）：七态状态机对齐 cliora，共享 offer 来自 update.svelte.ts ---- */

  type UpdateStage = "idle" | "checking" | "latest" | "available" | "downloading" | "installed" | "failed";

  /** 浏览器预览/测试里没有 Tauri 运行时：不显示检查与安装，只说明不可用。 */
  const updateNative = isNativeRuntime();
  let updateStage = $state<UpdateStage>(updateState.offer ? "available" : "idle");
  let updateFailure = $state("");
  let updateCheckedAt = $state<Date | null>(null);
  let updateVersionText = $state("");
  let updateProgress = $state<{ downloaded: number; total: number | null }>({ downloaded: 0, total: null });
  /** 安装防重入；进入 $state 让「下载中禁用检查按钮」跟随它即时变化。 */
  let updateInstalling = $state(false);

  if (updateNative) {
    void appVersion().then(
      (value: string | null) => {
        updateVersionText = value ?? "";
      },
      () => {
        updateVersionText = "";
      },
    );
  }

  /* 共享 offer 到达（启动自动检查的事件）时补上 available 态；不读取当前 stage，
     避免手动检查/安装失败展示的 failed 态被同一个 offer 反复冲掉。 */
  $effect(() => {
    const offer = updateState.offer;
    if (!offer) return;
    untrack(() => {
      if (updateStage === "idle" || updateStage === "latest" || updateStage === "failed") updateStage = "available";
    });
  });

  function updateErrorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function runUpdateCheck() {
    if (updateInstalling || updateStage === "checking" || updateStage === "downloading" || updateStage === "installed") return;
    updateFailure = "";
    updateStage = "checking";
    try {
      const found = await checkForUpdates();
      updateCheckedAt = new Date();
      updateStage = found ? "available" : "latest";
    } catch (error) {
      updateFailure = updateErrorText(error);
      updateStage = "failed";
    }
  }

  async function runUpdateInstall() {
    if (updateInstalling) return;
    updateInstalling = true;
    updateFailure = "";
    updateProgress = { downloaded: 0, total: null };
    try {
      updateStage = "downloading";
      const outcome = await installUpdate((progress) => {
        updateProgress = progress;
      });
      if (outcome === "unavailable") {
        updateCheckedAt = new Date();
        updateStage = "latest";
        return;
      }
      updateStage = "installed";
    } catch (error) {
      updateFailure = updateErrorText(error);
      updateStage = "failed";
    } finally {
      updateInstalling = false;
    }
  }

  let updateOffer = $derived(updateState.offer);
  /** installSupported 由事件或手动检查的命令查询同源写入；null（两处都未到）按可安装渲染。 */
  let updateInstallSupported = $derived(updateState.installSupported !== false);
  let updatePercent = $derived(
    updateProgress.total ? Math.min(100, Math.round((updateProgress.downloaded / updateProgress.total) * 100)) : null,
  );
  let updateBusy = $derived(
    updateInstalling || updateStage === "checking" || updateStage === "downloading" || updateStage === "installed",
  );
  let updateStatus = $derived.by(() => {
    if (!updateNative) return "";
    switch (updateStage) {
      case "checking":
        return "正在检查更新…";
      case "latest":
        return "已是最新版本。";
      case "available":
        return updateOffer ? `发现新版本 ${updateOffer.version}。` : "有可用更新。";
      case "downloading":
        return "正在下载更新…";
      case "installed":
        return "已安装新版本，即将重启…";
      case "failed":
        return `更新失败：${updateFailure}`;
      default:
        return "启动后会自动检查新版本，也可以现在手动检查。";
    }
  });
  let updateChip = $derived.by(() => {
    if (!updateOffer) return null;
    if (updateStage === "failed") return { tone: "danger", label: "更新失败" };
    if (updateStage === "installed") return { tone: "ok", label: "已安装" };
    return { tone: "save", label: `新版本 ${updateOffer.version}` };
  });
  const updateMb = (bytes: number) => `${(bytes / 1048576).toFixed(1)}`;

  /* ---- 远程 SSH 主机簿（R3） --------------------------------------------
     这一节自己读取并写回主机簿，外壳的设置接口不变：主机记录不是外壳状态。
     三条不变量在这里可见：总开关缺省关闭、密码只有布尔状态、失败保留草稿。 */

  type SshDraft = SshTargetInput;

  let ssh = $state<RemoteSshSettings>({ enabled: false, targets: [] });
  let sshLoaded = $state(false);
  let sshMessage = $state<{ tone: "error" | "info"; text: string } | null>(null);
  let sshSaving = $state(false);
  let sshDraft = $state<SshDraft | null>(null);
  let sshDraftPassword = $state("");
  let sshTest = $state<{
    requestId: string;
    targetId: string;
    status: "running" | "ok" | "failed";
    text: string;
    probe?: SshProbe;
  } | null>(null);
  let sshInstall = $state<{
    targetId: string;
    peerRevision: string;
    version: string;
    size: number;
    confirmationId: string;
    progress: number | null;
  } | null>(null);

  function sshErrorText(error: unknown): string {
    const value = error as { message?: string } | null;
    if (value && typeof value.message === "string" && value.message.length > 0) return value.message;
    return "操作未完成，请检查后重试。";
  }

  function sshDraftId(): string {
    const source = typeof crypto !== "undefined" ? crypto : undefined;
    if (source && "randomUUID" in source) return source.randomUUID();
    return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function replaceTarget(targets: SshTarget[], saved: SshTarget): SshTarget[] {
    const next = targets.filter((item) => item.id !== saved.id);
    next.push(saved);
    return next;
  }

  async function loadSsh() {
    // 浏览器预览与未接这一节的宿主没有原生命令：保持关闭，不把读取失败当成已启用。
    if (typeof api.remoteSshSettings !== "function") {
      sshLoaded = true;
      return;
    }
    try {
      const loaded = await api.remoteSshSettings();
      // 只接受形状正确的响应：老宿主或缺这一节的 mock 返回 undefined，
      // 不能把它当成"已启用"，也不能让界面读一个 undefined。
      if (loaded && typeof loaded === "object" && Array.isArray(loaded.targets)) {
        ssh = { enabled: loaded.enabled === true, targets: loaded.targets };
      }
    } catch (error) {
      sshMessage = { tone: "error", text: sshErrorText(error) };
    } finally {
      sshLoaded = true;
    }
  }

  void loadSsh();

  async function toggleSsh(enabled: boolean) {
    sshMessage = null;
    try {
      await api.setRemoteSshEnabled(enabled);
      // 写回成功后才改变显示：失败时界面仍读作原来的关闭状态。
      ssh = { ...ssh, enabled };
    } catch (error) {
      sshMessage = { tone: "error", text: sshErrorText(error) };
    }
  }

  function beginCreate() {
    sshMessage = null;
    sshDraftPassword = "";
    sshDraft = {
      id: sshDraftId(),
      displayName: "",
      host: "",
      port: 22,
      user: "",
      authMethod: "key",
      identityFile: null,
      sshConfig: null,
      defaultPath: null,
      enabled: true,
      sharedHostId: null,
    };
  }

  function beginEdit(target: SshTarget) {
    sshMessage = null;
    sshDraftPassword = "";
    sshDraft = {
      id: target.id,
      displayName: target.displayName,
      host: target.host,
      port: target.port,
      user: target.user,
      authMethod: target.authMethod,
      identityFile: target.identityFile,
      sshConfig: target.sshConfig,
      defaultPath: target.defaultPath,
      enabled: target.enabled,
      sharedHostId: target.sharedHostId,
    };
  }

  function editDraft(patch: Partial<SshDraft>) {
    if (!sshDraft) return;
    sshDraft = { ...sshDraft, ...patch };
  }

  async function saveDraft() {
    if (!sshDraft || sshSaving) return;
    const draft = sshDraft;
    sshSaving = true;
    sshMessage = null;
    try {
      const saved = await api.saveRemoteSshTarget({ ...draft });
      let next = replaceTarget(ssh.targets, saved);
      // 密码只在用户填了内容时写入钥匙串；留空表示不改动已保存的密码。
      if (draft.authMethod === "password" && sshDraftPassword.length > 0) {
        await api.setRemoteSshPassword(saved.id, sshDraftPassword);
        next = replaceTarget(next, { ...saved, hasPassword: true });
      }
      ssh = { ...ssh, targets: next };
      sshDraft = null;
      sshDraftPassword = "";
    } catch (error) {
      // 失败保留草稿：已填的字段还在，用户不必重填。
      sshMessage = { tone: "error", text: sshErrorText(error) };
    } finally {
      sshSaving = false;
    }
  }

  async function toggleTarget(target: SshTarget) {
    sshMessage = null;
    try {
      const saved = await api.saveRemoteSshTarget({
        id: target.id,
        displayName: target.displayName,
        host: target.host,
        port: target.port,
        user: target.user,
        authMethod: target.authMethod,
        identityFile: target.identityFile,
        sshConfig: target.sshConfig,
        defaultPath: target.defaultPath,
        enabled: !target.enabled,
        sharedHostId: target.sharedHostId,
      });
      ssh = { ...ssh, targets: replaceTarget(ssh.targets, { ...saved, hasPassword: target.hasPassword }) };
    } catch (error) {
      sshMessage = { tone: "error", text: sshErrorText(error) };
    }
  }

  async function removeTarget(target: SshTarget) {
    sshMessage = null;
    try {
      await api.deleteRemoteSshTarget(target.id);
      ssh = { ...ssh, targets: ssh.targets.filter((item) => item.id !== target.id) };
      if (sshDraft?.id === target.id) sshDraft = null;
    } catch (error) {
      sshMessage = { tone: "error", text: sshErrorText(error) };
    }
  }

  async function savePasswordForDraft() {
    if (!sshDraft || sshDraftPassword.length === 0) return;
    sshMessage = null;
    try {
      await api.setRemoteSshPassword(sshDraft.id, sshDraftPassword);
      sshDraftPassword = "";
      ssh = {
        ...ssh,
        targets: ssh.targets.map((item) => (item.id === sshDraft?.id ? { ...item, hasPassword: true } : item)),
      };
    } catch (error) {
      sshMessage = { tone: "error", text: sshErrorText(error) };
    }
  }

  async function deletePasswordForDraft() {
    if (!sshDraft) return;
    sshMessage = null;
    try {
      await api.deleteRemoteSshPassword(sshDraft.id);
      ssh = {
        ...ssh,
        targets: ssh.targets.map((item) => (item.id === sshDraft?.id ? { ...item, hasPassword: false } : item)),
      };
    } catch (error) {
      sshMessage = { tone: "error", text: sshErrorText(error) };
    }
  }

  async function pickIdentityFile() {
    if (!sshDraft) return;
    const picked = await pickFile("选择私钥文件");
    if (picked) editDraft({ identityFile: picked });
  }

  async function pickSshConfig() {
    if (!sshDraft) return;
    const picked = await pickFile("选择 SSH 配置文件");
    if (picked) editDraft({ sshConfig: picked });
  }

  async function runSshTest(target: SshTarget, peerRevision?: string) {
    const requestId = sshDraftId();
    sshTest = { requestId, targetId: target.id, status: "running", text: "正在测试连接…" };
    sshInstall = null;
    sshMessage = null;
    try {
      const probe = await api.testRemoteSsh(requestId, target.id);
      // 与失败分支一致：只有仍属于当前请求的结果才更新界面。
      // 已经被取消或被新一次测试取代的迟到成功结果直接丢弃，
      // 不能把旧请求的"连接成功"盖在当前状态上。
      if (sshTest?.requestId !== requestId) return;
      sshTest = {
        requestId,
        targetId: target.id,
        status: "ok",
        text: probe.agentCompatible
          ? `连接成功：${probe.system}/${probe.architecture}，远端组件 ${probe.agentVersion ?? ""} 可复用。`
          : `连接成功：${probe.system}/${probe.architecture}，远端组件需要安装。`,
        probe,
      };
      void peerRevision;
    } catch (error) {
      // 取消与失败都落在这里；提示按真实原因显示，不把"已取消"说成"失败"。
      if (sshTest?.requestId === requestId) {
        sshTest = { requestId, targetId: target.id, status: "failed", text: sshErrorText(error) };
      }
    }
  }

  async function cancelSshTest() {
    if (!sshTest || sshTest.status !== "running") return;
    // 取消由原生中止进程树；这里只发请求，状态等真实结果回来再改。
    await api.cancelRemoteSsh(sshTest.requestId);
  }

  async function prepareInstall(target: SshTarget) {
    const probe = sshTest?.targetId === target.id ? sshTest.probe : undefined;
    if (!probe) return;
    sshMessage = null;
    try {
      const outcome = await api.installRemoteSshAgent(
        { requestId: sshDraftId(), targetId: target.id, peerRevision: probe.peerRevision },
        () => {},
      );
      if (outcome.kind === "reused") {
        sshMessage = { tone: "info", text: `远端组件 ${outcome.version ?? ""} 已可复用，未传输任何字节。` };
        return;
      }
      if (outcome.kind === "install_required" && outcome.confirmationId) {
        sshInstall = {
          targetId: target.id,
          peerRevision: probe.peerRevision,
          version: outcome.version ?? "",
          size: outcome.size ?? 0,
          confirmationId: outcome.confirmationId,
          progress: null,
        };
        return;
      }
      sshMessage = { tone: "error", text: "远端组件安装没有返回可核实的信息。" };
    } catch (error) {
      sshMessage = { tone: "error", text: sshErrorText(error) };
    }
  }

  async function confirmInstall() {
    if (!sshInstall) return;
    const pending = sshInstall;
    sshMessage = null;
    try {
      const outcome = await api.installRemoteSshAgent(
        {
          requestId: sshDraftId(),
          targetId: pending.targetId,
          peerRevision: pending.peerRevision,
          confirmationId: pending.confirmationId,
        },
        (progress) => {
          const percent =
            progress.totalBytes > 0
              ? Math.min(100, Math.round((progress.sentBytes / progress.totalBytes) * 100))
              : null;
          if (sshInstall && sshInstall.confirmationId === pending.confirmationId) {
            sshInstall = { ...pending, progress: percent };
          }
        },
      );
      sshInstall = null;
      sshMessage = { tone: "info", text: `已安装远端组件 ${outcome.version ?? ""}。` };
    } catch (error) {
      // 失败或取消都不留下"已安装"的印象，也不假装进度完成。
      sshInstall = null;
      sshMessage = { tone: "error", text: sshErrorText(error) };
    }
  }

  let sshTestRunning = $derived(sshTest?.status === "running");

</script>

{#snippet sectionHead(id: SectionId, description: string)}
  {@const meta = SECTIONS.find((item) => item.id === id)!}
  <div class="settings-section-head">
    <span class="settings-section-icon" aria-hidden="true"><Icon name={meta.icon} size={15} /></span>
    <div class="settings-section-titles">
      <h2 id={`settings-${id}-title`}>{meta.label}</h2>
      <p>{description}</p>
    </div>
  </div>
{/snippet}

<Modal
  title="设置"
  titleId="settings-modal-title"
  icon="settings"
  task="settings"
  {returnFocus}
  onClose={onClose}
>
  <div class="st-shell">
    <nav class="st-nav" aria-label="设置分区">
      <label class="st-search">
        <Icon name="search" size={13} />
        <input
          type="search"
          placeholder="搜索设置"
          aria-label="搜索设置"
          autocomplete="off"
          spellcheck="false"
          bind:value={search}
          onkeydown={(event) => {
            if (event.key === "Escape" && search) {
              event.stopPropagation();
              search = "";
            }
          }}
        />
      </label>
      <div class="st-nav-list">
        {#each SECTIONS as item (item.id)}
          {#if visibleSections.has(item.id)}
            <button
              type="button"
              class="st-nav-item"
              aria-current={activeSection === item.id ? "true" : undefined}
              data-settings-nav={item.id}
              onclick={() => goTo(item.id)}
            >
              <span class="st-nav-icon"><Icon name={item.icon} size={14} /></span>
              <span class="st-nav-label">{item.label}</span>
              {#if item.id === "update" && updateOffer}
                <span class="st-nav-dot" aria-hidden="true"></span>
              {:else if item.id === "runtime" && (gitStatus.tone === "danger" || gitStatus.tone === "warn")}
                <span class={`st-nav-dot ${gitStatus.tone}`} aria-hidden="true"></span>
              {:else if item.id === "remote" && ssh.enabled}
                <span class="st-nav-meta" aria-hidden="true">开</span>
              {/if}
            </button>
          {/if}
        {/each}
        {#if visibleSections.size === 0}
          <p class="st-nav-empty">没有匹配「{search.trim()}」的设置</p>
        {/if}
      </div>
      <div class="st-nav-foot">
        <span>Twiglane{updateVersionText ? ` ${updateVersionText}` : ""}</span>
      </div>
    </nav>

    <div class="st-content" bind:this={scroller} onscroll={spy}>
      <section class="settings-section" data-settings-section="appearance" hidden={!visibleSections.has("appearance")} aria-labelledby="settings-appearance-title">
        {@render sectionHead("appearance", "主题与代码显示。")}
        <div class="settings-group">
          <div class="settings-row">
            <span class="settings-label">主题<small>跟随系统时随系统的浅色/深色切换</small></span>
            <div class="segmented st-theme" role="group" aria-label="外观">
              {#each THEMES as option, index (option.id)}
                <button
                  type="button"
                  aria-pressed={theme === option.id}
                  title={disabled ? BUSY_REASON : undefined}
                  disabled={disabled}
                  data-autofocus={index === 0 && !section ? "" : undefined}
                  onclick={() => onTheme(option.id)}
                >
                  <Icon name={option.icon} size={13} />{option.label}
                </button>
              {/each}
            </div>
          </div>
          <label class="settings-row switch">
            <span class="settings-label">代码语法高亮<small>支持 {LANGUAGE_OPTIONS.length} 种语言，可在差异工具条上按文件类型改用别的语言</small></span>
            <input
              type="checkbox"
              checked={syntaxPrefs.enabled}
              onchange={(event) => setSyntaxEnabled((event.currentTarget as HTMLInputElement).checked)}
            />
          </label>
        </div>
      </section>

      <section class="settings-section" data-settings-section="repository" hidden={!visibleSections.has("repository")} aria-labelledby="settings-repository-title">
        {@render sectionHead("repository", "拉取方式与左栏的显示。")}
        <div class="settings-group">
          <div class="settings-row">
            <span class="settings-label">分叉时的拉取<small>本地与远程各有新提交时，用合并还是变基来整合</small></span>
            <div class="segmented" role="group" aria-label="分叉时的拉取">
              {#each PULLS as option (option.id)}
                <button type="button" aria-pressed={pullIntegration === option.id} title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={() => onPullIntegration(option.id)}>
                  {option.label}
                </button>
              {/each}
            </div>
          </div>
          <label class="settings-row switch">
            <span class="settings-label">按斜杠分组分支<small>feature/login 归到 feature 组下，可逐组折叠</small></span>
            <input
              type="checkbox"
              checked={branchGroups}
              title={disabled ? BUSY_REASON : undefined}
              disabled={disabled}
              onchange={(event) => onBranchGroups((event.currentTarget as HTMLInputElement).checked)}
            />
          </label>
          <label class="settings-row switch">
            <span class="settings-label">显示文件视图<small>关闭后左栏只保留改动与历史</small></span>
            <input
              type="checkbox"
              checked={filesView}
              onchange={(event) => onFilesView((event.currentTarget as HTMLInputElement).checked)}
            />
          </label>
        </div>
      </section>

      <section
        class="settings-section"
        data-settings-section="change-request"
        hidden={!visibleSections.has("change-request")}
        aria-labelledby="settings-change-request-title"
        tabindex="-1"
        data-autofocus={section === "changeRequest" ? "" : undefined}
        bind:this={changeRequestSection}
      >
        {@render sectionHead("change-request", "在当前分支发起 MR / PR，管理自建 GitLab 实例。令牌只保存在系统钥匙串。")}
        <div class="settings-group">
          <label class="settings-row switch">
            <span class="settings-label">
              创建 MR / PR<small>开启后可在当前分支发起合并请求；关闭时不读取平台令牌、不发起平台请求</small>
            </span>
            <input
              type="checkbox"
              checked={changeRequestsEnabled}
              title={disabled ? BUSY_REASON : undefined}
              disabled={disabled}
              onchange={(event) => {
                const input = event.currentTarget as HTMLInputElement;
                // 复选框会先自行变成用户点的状态。写回成功后由 checked 的新值更新，
                // 写回失败时外壳不会改这个值，这里先退回已保存状态，避免看起来已持久化。
                input.checked = changeRequestsEnabled;
                onChangeRequests(!changeRequestsEnabled);
              }}
            />
          </label>
        </div>

        <div class="settings-subhead">
          <div>
            <h3>自建 GitLab 实例</h3>
            <p>自动识别失败时在创建对话框里填写的地址会记在这里，下次同一远程主机自动使用。</p>
          </div>
          {#if instancesSupported && !instanceDraft}
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              onclick={() => {
                instanceMessage = null;
                instanceDraft = { host: "", url: "", editing: null };
              }}
            ><Icon name="plus" size={13} />添加实例</button>
          {/if}
        </div>

        {#if instanceMessage}
          <p class={`settings-inline-note ${instanceMessage.tone}`} role={instanceMessage.tone === "error" ? "alert" : "status"} data-instance-message={instanceMessage.tone}>
            <Icon name={instanceMessage.tone === "error" ? "alert-circle" : "check-circle"} size={13} />{instanceMessage.text}
          </p>
        {/if}

        {#if instanceDraft}
          <div class="settings-group settings-editor" data-instance-editor>
            <div class="settings-row stacked">
              <label class="settings-label" for="settings-instance-host">远程主机名<small>Git 远程地址里的主机，例如 git.example.com（SSH 别名也可以）</small></label>
              <input
                id="settings-instance-host"
                class="input"
                autocomplete="off"
                spellcheck="false"
                placeholder="git.example.com"
                value={instanceDraft.host}
                oninput={(event) => instanceDraft && (instanceDraft = { ...instanceDraft, host: event.currentTarget.value })}
              />
            </div>
            <div class="settings-row stacked">
              <label class="settings-label" for="settings-instance-url">实例地址<small>浏览器访问 GitLab 的根地址，可带端口与部署子路径；http:// 只建议在可信内网使用</small></label>
              <input
                id="settings-instance-url"
                class="input"
                type="url"
                autocomplete="off"
                spellcheck="false"
                placeholder="https://git.example.com:8443/gitlab"
                value={instanceDraft.url}
                oninput={(event) => instanceDraft && (instanceDraft = { ...instanceDraft, url: event.currentTarget.value })}
              />
            </div>
            <div class="settings-actions end">
              <button type="button" class="btn btn-ghost btn-sm" onclick={() => (instanceDraft = null)}>取消</button>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                disabled={instanceBusy || !instanceDraft.host.trim() || !instanceDraft.url.trim()}
                title={instanceBusy ? BUSY_REASON : !instanceDraft.host.trim() ? "先填写远程主机名" : !instanceDraft.url.trim() ? "先填写实例地址" : undefined}
                onclick={() => void saveInstance()}
              >保存实例</button>
            </div>
          </div>
        {/if}

        {#if !instancesSupported}
          <p class="settings-empty">当前环境不支持管理实例。</p>
        {:else if instancesLoaded && instances.length === 0 && !instanceDraft}
          <div class="settings-empty">
            <Icon name="globe" size={16} />
            <span>还没有记住任何实例。GitHub、Gitea 与可以自动识别的 GitLab 不需要在这里配置。</span>
          </div>
        {:else if instances.length > 0}
          <ul class="settings-list" aria-label="记住的 GitLab 实例">
            {#each instances as entry (entry.host)}
              <li class="settings-list-item" data-instance-host={entry.host}>
                <span class="settings-list-icon"><Icon name="merge" size={14} /></span>
                <span class="settings-list-text">
                  <strong>{entry.host}</strong>
                  <code title={entry.url}>{entry.url}</code>
                </span>
                <span class="chip-row">
                  {#if entry.tokenConfigured === true}
                    <span class="chip ok">令牌已保存</span>
                  {:else if entry.tokenConfigured === false}
                    <span class="chip skip">未保存令牌</span>
                  {/if}
                  {#if savedAtText(entry.savedAtMs)}<span class="settings-list-meta">{savedAtText(entry.savedAtMs)}</span>{/if}
                </span>
                {#if instanceDeleting === entry.host}
                  <span class="settings-list-actions confirm" role="group" aria-label={`删除 ${entry.host}`}>
                    <button type="button" class="btn btn-ghost btn-sm" disabled={instanceBusy} title={instanceBusy ? BUSY_REASON : undefined} onclick={() => (instanceDeleting = null)}>取消</button>
                    <button type="button" class="btn btn-secondary btn-sm" disabled={instanceBusy} title={instanceBusy ? BUSY_REASON : "只删除地址，钥匙串里的令牌保留"} onclick={() => void removeInstance(entry.host, false)}>仅删除配置</button>
                    {#if entry.tokenConfigured !== false}
                      <button type="button" class="btn btn-danger btn-sm" disabled={instanceBusy} title={instanceBusy ? BUSY_REASON : "同时删除钥匙串里这个实例的令牌"} onclick={() => void removeInstance(entry.host, true)}>连同令牌删除</button>
                    {/if}
                  </span>
                {:else}
                  <span class="settings-list-actions">
                    <button
                      type="button"
                      class="icon-btn sm"
                      aria-label={`编辑 ${entry.host}`}
                      title="编辑实例地址"
                      onclick={() => {
                        instanceMessage = null;
                        instanceDraft = { host: entry.host, url: entry.url, editing: entry.host };
                      }}
                    ><Icon name="pencil" size={13} /></button>
                    <button
                      type="button"
                      class="icon-btn sm danger"
                      aria-label={`删除 ${entry.host}`}
                      title="删除这个实例配置"
                      onclick={() => (instanceDeleting = entry.host)}
                    ><Icon name="trash" size={13} /></button>
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section
        class="settings-section"
        data-settings-section="terminal"
        hidden={!visibleSections.has("terminal")}
        aria-labelledby="settings-terminal-title"
        tabindex="-1"
        data-autofocus={section === "terminal" ? "" : undefined}
        bind:this={terminalSection}
      >
        {@render sectionHead("terminal", "底部终端的默认类型与字号。")}
        <div class="settings-group">
          <div class="settings-row">
            <span class="settings-label">
              默认终端<small>新建终端时使用；底部终端的「▾」菜单里仍可临时选择其他类型</small>
              {#if terminalSelected}
                <span class="settings-terminal-path" title={terminalSelected.path}>{terminalSelected.path}</span>
              {/if}
            </span>
            <select
              class="select settings-terminal-select"
              aria-label="默认终端"
              data-settings-terminal-profile
              value={terminalProfileMissing ? "" : (terminalPrefs.profile ?? "")}
              onchange={(event) => setTerminalProfile((event.currentTarget as HTMLSelectElement).value)}
            >
              <option value="">自动{terminalProfiles[0] ? `（${terminalProfiles[0].label}）` : ""}</option>
              {#each terminalProfiles as profile (profile.id)}
                <option value={profile.id}>{profile.label}</option>
              {/each}
            </select>
          </div>
          {#if terminalProfileMissing}
            <p class="settings-note" role="status">之前选择的终端在本机已不可用，新建终端会使用平台默认。</p>
          {/if}
          <div class="settings-row">
            <span class="settings-label">字号<small>终端里也可以用 Ctrl/⌘ 加 = 、- 、0 缩放与还原</small></span>
            <div class="settings-stepper" role="group" aria-label="终端字号">
              <button
                type="button"
                class="icon-btn sm"
                aria-label="减小终端字号"
                title={terminalPrefs.fontSize <= TERMINAL_FONT_MIN ? "已是最小字号" : "减小字号"}
                disabled={terminalPrefs.fontSize <= TERMINAL_FONT_MIN}
                onclick={() => stepTerminalFont(-1)}
              >
                <Icon name="minus" size={12} />
              </button>
              <output aria-live="polite">{terminalPrefs.fontSize} px</output>
              <button
                type="button"
                class="icon-btn sm"
                aria-label="增大终端字号"
                title={terminalPrefs.fontSize >= TERMINAL_FONT_MAX ? "已是最大字号" : "增大字号"}
                disabled={terminalPrefs.fontSize >= TERMINAL_FONT_MAX}
                onclick={() => stepTerminalFont(1)}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section
        class="settings-section"
        data-settings-section="remote"
        hidden={!visibleSections.has("remote")}
        aria-labelledby="settings-remote-title"
      >
        <div class="settings-section-head">
          <span class="settings-section-icon" aria-hidden="true"><Icon name="cloud" size={15} /></span>
          <div class="settings-section-titles">
            <h2 id="settings-remote-title">远程 SSH</h2>
            <p>通过 SSH 打开远端主机上的仓库。密码只保存在系统钥匙串。</p>
          </div>
          {#if ssh.enabled}
            <span class="chip ok">已开启</span>
          {:else}
            <span class="chip skip">已关闭</span>
          {/if}
        </div>
        <div class="settings-group">
          <label class="settings-row switch">
            <span class="settings-label">
              启用远程 SSH
              <small>关闭时不建立任何新的 SSH 连接；已保存的主机与密码仍保留，活动会话不受影响</small>
            </span>
            <input
              type="checkbox"
              checked={ssh.enabled}
              aria-label="启用远程 SSH"
              title={disabled || !sshLoaded ? BUSY_REASON : "关闭后不建立新的 SSH 连接，主机与密码保留"}
              disabled={disabled || !sshLoaded}
              onchange={(event) => {
                const input = event.currentTarget as HTMLInputElement;
                // 复选框会先变成用户点的状态；写回成功后由 checked 的新值更新。
                input.checked = ssh.enabled;
                void toggleSsh(!ssh.enabled);
              }}
            />
          </label>
        </div>

        <div class="settings-subhead">
          <div>
            <h3>主机簿</h3>
            <p>逐台启停，并单独测试连接与远端组件。</p>
          </div>
          {#if !sshDraft}
            <button type="button" class="btn btn-secondary btn-sm" onclick={beginCreate}>
              <Icon name="plus" size={13} />添加主机
            </button>
          {/if}
        </div>

        {#if sshMessage}
          <p
            class={`settings-inline-note ${sshMessage.tone}`}
            role={sshMessage.tone === "error" ? "alert" : "status"}
            data-ssh-message={sshMessage.tone}
          >
            {sshMessage.text}
          </p>
        {/if}

        {#if ssh.targets.length === 0 && !sshDraft}
          <div class="settings-empty">
            <Icon name="cloud" size={16} />
            <span>主机簿还是空的。添加主机后可以逐台启停，并单独测试连接与远端组件。</span>
          </div>
        {/if}

        {#if ssh.targets.length > 0}
          <ul class="settings-list" aria-label="SSH 主机">
            {#each ssh.targets as target (target.id)}
              <li class="settings-list-item ssh" data-ssh-target={target.id} class:off={!target.enabled}>
                <div class="settings-list-main">
                  <span class="settings-list-icon"><Icon name="terminal" size={14} /></span>
                  <span class="settings-list-text">
                    <strong>{target.displayName}</strong>
                    <code>{target.user}@{target.host}:{target.port}{target.defaultPath ? ` · ${target.defaultPath}` : ""}</code>
                    <span class="chip-row">
                      <span class="chip">
                        {target.authMethod === "password"
                          ? "密码认证"
                          : target.authMethod === "agent"
                            ? "ssh-agent"
                            : "密钥认证"}
                      </span>
                      <span class={`chip ${target.hasPassword ? "ok" : "skip"}`}>
                        {target.hasPassword ? "已保存密码" : "未保存密码"}
                      </span>
                      <span class={`chip ${target.enabled ? "ok" : "skip"}`}>
                        {target.enabled ? "已启用" : "已停用"}
                      </span>
                    </span>
                  </span>
                  <span class="settings-list-actions wrap">
                    <button
                      type="button"
                      class="btn btn-secondary btn-sm"
                      disabled={!ssh.enabled || !target.enabled || sshTestRunning}
                      title={!ssh.enabled ? "远程 SSH 已关闭" : !target.enabled ? "这台主机已停用" : sshTestRunning ? "正在测试另一台主机" : undefined}
                      onclick={() => void runSshTest(target)}
                    >
                      测试连接
                    </button>
                    <button type="button" class="btn btn-ghost btn-sm" onclick={() => beginEdit(target)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      aria-pressed={target.enabled}
                      onclick={() => void toggleTarget(target)}
                    >
                      {target.enabled ? "停用" : "启用"}
                    </button>
                    <button type="button" class="btn btn-ghost btn-sm st-danger-text" onclick={() => void removeTarget(target)}>
                      删除
                    </button>
                  </span>
                </div>
                {#if sshTest && sshTest.targetId === target.id}
                  <div class={`settings-list-detail ${sshTest.status}`}>
                    <p
                      role={sshTest.status === "failed" ? "alert" : "status"}
                      data-ssh-test={sshTest.status}
                    >
                      {#if sshTest.status === "running"}<span class="spinner"></span>{:else if sshTest.status === "ok"}<Icon name="check-circle" size={13} />{:else}<Icon name="alert-circle" size={13} />{/if}
                      {sshTest.text}
                    </p>
                    {#if sshTest.status === "running"}
                      <button type="button" class="btn btn-ghost btn-sm" onclick={() => void cancelSshTest()}>
                        取消测试
                      </button>
                    {/if}
                    {#if sshTest.status === "ok" && sshTest.probe && !sshTest.probe.agentCompatible}
                      <button
                        type="button"
                        class="btn btn-primary btn-sm"
                        onclick={() => void prepareInstall(target)}
                      >
                        安装远端组件
                      </button>
                    {/if}
                  </div>
                {/if}
                {#if sshInstall && sshInstall.targetId === target.id}
                  <div class="settings-list-detail">
                    <p role="status">
                      将向该主机安装 Twiglane 远端组件 {sshInstall.version}（{sshInstall.size} 字节）。安装会先写入临时文件并核对摘要，通过后才原子替换。
                    </p>
                    {#if sshInstall.progress !== null}
                      <div class="update-progress-row">
                        <div
                          class="update-progress"
                          role="progressbar"
                          aria-label="远端组件传输进度"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={sshInstall.progress}
                        >
                          <div style={`width: ${sshInstall.progress}%;`}></div>
                        </div>
                        <small>{sshInstall.progress}%</small>
                      </div>
                    {/if}
                    <div class="settings-actions">
                      <button type="button" class="btn btn-primary btn-sm" onclick={() => void confirmInstall()}>
                        确认安装
                      </button>
                      <button
                        type="button"
                        class="btn btn-ghost btn-sm"
                        onclick={() => {
                          sshInstall = null;
                        }}
                      >
                        取消安装
                      </button>
                    </div>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if sshDraft}
          <div class="settings-group settings-editor" data-ssh-editor>
            <div class="settings-row">
              <span class="settings-label">显示名<small>只用于界面；改名不改变连接身份</small></span>
              <input
                class="input"
                aria-label="显示名"
                value={sshDraft.displayName}
                oninput={(event) => editDraft({ displayName: (event.currentTarget as HTMLInputElement).value })}
              />
            </div>
            <div class="settings-row">
              <span class="settings-label">主机<small>Host 别名或地址，由 ssh -G 解析成有效配置</small></span>
              <input
                class="input"
                aria-label="主机"
                value={sshDraft.host}
                oninput={(event) => editDraft({ host: (event.currentTarget as HTMLInputElement).value })}
              />
            </div>
            <div class="settings-row">
              <span class="settings-label">端口</span>
              <input
                class="input st-short"
                aria-label="端口"
                inputmode="numeric"
                value={String(sshDraft.port)}
                oninput={(event) => {
                  const parsed = Number.parseInt((event.currentTarget as HTMLInputElement).value, 10);
                  editDraft({ port: Number.isFinite(parsed) ? parsed : 0 });
                }}
              />
            </div>
            <div class="settings-row">
              <span class="settings-label">用户名</span>
              <input
                class="input"
                aria-label="用户名"
                value={sshDraft.user}
                oninput={(event) => editDraft({ user: (event.currentTarget as HTMLInputElement).value })}
              />
            </div>
            <div class="settings-row">
              <span class="settings-label">
                认证方式<small>密钥与 ssh-agent 不使用 askpass；密码保存在系统钥匙串</small>
              </span>
              <select
                class="select"
                aria-label="认证方式"
                value={sshDraft.authMethod}
                onchange={(event) => editDraft({ authMethod: (event.currentTarget as HTMLSelectElement).value })}
              >
                <option value="key">密钥</option>
                <option value="agent">ssh-agent</option>
                <option value="password">密码</option>
              </select>
            </div>
            {#if sshDraft.authMethod === "key"}
              <div class="settings-row">
                <span class="settings-label">私钥文件<small>{sshDraft.identityFile ?? "可选；留空时使用 ssh-agent 或默认身份文件"}</small></span>
                <div class="settings-actions">
                  <button type="button" class="btn btn-secondary btn-sm" onclick={() => void pickIdentityFile()}>
                    选择私钥
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    onclick={() => editDraft({ identityFile: null })}
                  >
                    清除
                  </button>
                </div>
              </div>
              {#if sshDraft.identityFile}
                <p class="settings-note sr-only" data-ssh-identity>{sshDraft.identityFile}</p>
              {/if}
            {/if}
            {#if sshDraft.authMethod === "password"}
              <div class="settings-row">
                <span class="settings-label">
                  SSH 密码<small>只写入 twiglane.remote-ssh 钥匙串；设置文件里不保存密码</small>
                </span>
                <input
                  class="input"
                  type="password"
                  aria-label="SSH 密码"
                  value={sshDraftPassword}
                  oninput={(event) => (sshDraftPassword = (event.currentTarget as HTMLInputElement).value)}
                />
              </div>
              <div class="settings-actions end">
                <button type="button" class="btn btn-ghost btn-sm" onclick={() => void deletePasswordForDraft()}>
                  删除已保存密码
                </button>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  title={sshDraftPassword.length === 0 ? "先填写要保存的密码" : "保存到系统钥匙串"}
                  disabled={sshDraftPassword.length === 0}
                  onclick={() => void savePasswordForDraft()}
                >
                  保存密码
                </button>
              </div>
            {/if}
            <div class="settings-row">
              <span class="settings-label">SSH 配置文件<small>{sshDraft.sshConfig ?? "可选；指定后只用该文件解析有效配置"}</small></span>
              <div class="settings-actions">
                <button type="button" class="btn btn-secondary btn-sm" onclick={() => void pickSshConfig()}>
                  选择配置
                </button>
                <button type="button" class="btn btn-ghost btn-sm" onclick={() => editDraft({ sshConfig: null })}>
                  清除
                </button>
              </div>
            </div>
            {#if sshDraft.sshConfig}
              <p class="settings-note sr-only" data-ssh-config>{sshDraft.sshConfig}</p>
            {/if}
            <div class="settings-row">
              <label class="settings-label" for="ssh-default-path">默认目录<small>远端仓库的默认绝对路径</small></label>
              <input
                id="ssh-default-path"
                class="input"
                value={sshDraft.defaultPath ?? ""}
                placeholder="/srv/repo 或 C:/repo"
                oninput={(event) => editDraft({ defaultPath: event.currentTarget.value || null })}
              />
            </div>
            <div class="settings-actions end">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                onclick={() => {
                  sshDraft = null;
                  sshDraftPassword = "";
                }}
              >
                取消
              </button>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                title={sshSaving ? BUSY_REASON : undefined}
                disabled={sshSaving}
                onclick={() => void saveDraft()}
              >
                保存主机
              </button>
            </div>
          </div>
        {/if}
      </section>

      <section
        class="settings-section"
        data-settings-section="runtime"
        hidden={!visibleSections.has("runtime")}
        aria-labelledby="settings-runtime-title"
        tabindex="-1"
        data-autofocus={section === "runtime" ? "" : undefined}
        bind:this={runtimeSection}
      >
        <div class="settings-section-head">
          <span class="settings-section-icon" aria-hidden="true"><Icon name="code" size={15} /></span>
          <div class="settings-section-titles">
            <h2 id="settings-runtime-title">运行环境</h2>
            <p>本机 Git 的检测结果与安装说明。</p>
          </div>
          <span class={`chip ${gitStatus.tone}`}>{gitStatus.label}</span>
        </div>
        <div class="settings-group">
          <div class="settings-row top">
            <ul class="settings-diagnostics" aria-label="Git 诊断">
              <li>{gitLine}</li>
              {#if git?.belowBaseline}
                <li>{git.message}</li>
              {/if}
            </ul>
            <div class="settings-actions">
              <button type="button" class="btn btn-secondary btn-sm" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={onRedetect}>重新检测</button>
              <button type="button" class="btn btn-secondary btn-sm" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={onChooseGit}>选择 Git</button>
              {#if git?.overridden}
                <button type="button" class="btn btn-ghost btn-sm" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={onClearGit}>恢复自动检测</button>
              {/if}
            </div>
          </div>
          {#if gitNextStep}
            <p class="settings-note" data-git-next-step>{gitNextStep}</p>
          {/if}
          <details class="scope-details settings-details" open={needsHelp}>
            <summary><Icon name="chevron-right" size={13} />WebView2 与安装说明</summary>
            <div class="settings-note">
              {#each dependencyNote(platform).split("\n") as line (line)}
                <p>{line}</p>
              {/each}
            </div>
          </details>
        </div>
      </section>

      <section
        class="settings-section"
        data-settings-section="update"
        hidden={!visibleSections.has("update")}
        aria-labelledby="settings-update-title"
        tabindex="-1"
        data-autofocus={section === "update" ? "" : undefined}
        bind:this={updateSection}
      >
        <div class="settings-section-head">
          <span class="settings-section-icon" aria-hidden="true"><Icon name="download" size={15} /></span>
          <div class="settings-section-titles">
            <h2 id="settings-update-title">应用更新</h2>
            <p>启动时自动检查，安装后重启生效。</p>
          </div>
          {#if updateChip}
            <span class={`chip ${updateChip.tone}`}>{updateChip.label}</span>
          {/if}
        </div>
        <div class="settings-group">
          {#if !updateNative}
            <p class="settings-note">更新功能仅在桌面应用中可用。</p>
          {:else}
            <div class="settings-row">
              <span class="settings-label">当前版本<small>应用安装包内的版本号，重启进入新版本后变化</small></span>
              <span class="update-version">{updateVersionText || "—"}</span>
            </div>
            <div class="settings-row top">
              <div class="settings-label">
                <p class="update-status" role={updateStage === "failed" ? "alert" : "status"}>{updateStatus}</p>
                {#if updateCheckedAt}
                  <p class="update-meta">上次检查：{updateCheckedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
                {/if}
              </div>
              <div class="settings-actions">
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  title={updateBusy ? BUSY_REASON : undefined}
                  disabled={updateBusy}
                  onclick={runUpdateCheck}
                >
                  {updateStage === "checking" ? "正在检查…" : "检查更新"}
                </button>
                {#if updateStage === "available" && updateOffer && updateInstallSupported}
                  <button type="button" class="btn btn-primary btn-sm" onclick={runUpdateInstall}>下载并安装</button>
                {/if}
              </div>
            </div>
            {#if updateStage === "downloading"}
              <div class="update-progress-row">
                <div
                  class="update-progress"
                  role="progressbar"
                  aria-label="下载进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={updatePercent ?? undefined}
                >
                  <div style={updatePercent === null ? undefined : `width: ${updatePercent}%;`}></div>
                </div>
                <small>
                  {updateMb(updateProgress.downloaded)} MB{updateProgress.total ? ` / ${updateMb(updateProgress.total)} MB` : ""}{updatePercent !== null ? ` · ${updatePercent}%` : ""}
                </small>
              </div>
            {/if}
            {#if (updateStage === "available" || updateStage === "downloading") && updateOffer}
              {#if updateOffer.notes.trim()}
                <div class="update-notes-block">
                  <strong>{updateOffer.version} 更新说明</strong>
                  <pre class="update-notes">{updateOffer.notes}</pre>
                </div>
              {/if}
              {#if !updateInstallSupported}
                <p class="settings-note">当前安装方式不支持应用内安装（例如 Linux 的 deb 安装），请手动下载新版本。</p>
              {/if}
            {/if}
          {/if}
        </div>
      </section>

      {#if visibleSections.size === 0}
        <div class="settings-empty large">
          <Icon name="search" size={18} />
          <span>没有匹配「{search.trim()}」的设置。试试「主题」「GitLab」「终端」「SSH」。</span>
        </div>
      {/if}
    </div>
  </div>
</Modal>
