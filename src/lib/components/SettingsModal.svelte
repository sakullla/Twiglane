<script lang="ts">
  import { untrack } from "svelte";
  import { BUSY_REASON } from "../ui";
  import { dependencyNote } from "../labels";
  import { appVersion } from "../api";
  import type { GitInfo, PullIntegration, Theme } from "../types";
  import { LANGUAGE_OPTIONS } from "../syntax/languages";
  import { setSyntaxEnabled, syntaxPrefs } from "../syntax/prefs.svelte";
  import { checkForUpdates, installUpdate, isNativeRuntime, updateState } from "../update.svelte";
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
    onRedetect: () => void;
    onChooseGit: () => void;
    onClearGit: () => void;
    /**
     * 打开时定位的分区：Git 不可用的诊断入口指向 "runtime"，更新提示入口指向
     * "update"，其余入口不传（等价于现在的首屏：外观在运行环境之上）。不改任何按钮行为。
     */
    section?: "appearance" | "runtime" | "update" | null;
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
    onRedetect,
    onChooseGit,
    onClearGit,
    section = null,
    returnFocus = null,
  }: Props = $props();

  const THEMES: { id: Theme; label: string }[] = [
    { id: "light", label: "浅色" },
    { id: "dark", label: "深色" },
    { id: "system", label: "跟随系统" },
  ];
  const PULLS: { id: PullIntegration; label: string }[] = [
    { id: "merge", label: "合并" },
    { id: "rebase", label: "变基" },
  ];

  let runtimeSection = $state<HTMLElement | null>(null);
  let updateSection = $state<HTMLElement | null>(null);

  /* 诊断入口要真的落到运行环境分区：Modal 的首焦点读 [data-autofocus]，
     这里再补一次滚动，避免那一块在 modal 滚动区之外。 */
  $effect(() => {
    if (section !== "runtime" && section !== "update") return;
    const target = section === "update" ? updateSection : runtimeSection;
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
  /** installSupported 只有后端事件携带；事件未到按可安装渲染，安装失败仍会走 failed 态。 */
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
</script>

<Modal
  title="设置"
  titleId="settings-modal-title"
  icon="settings"
  task="settings"
  {returnFocus}
  onClose={onClose}
>
  <section class="settings-section" data-settings-section="appearance">
    <h2>外观</h2>
    <div class="settings-group">
      <div class="settings-row">
        <span class="settings-label">主题<small>重启后保持</small></span>
        <div class="segmented" role="group" aria-label="外观">
          {#each THEMES as option (option.id)}
            <button type="button" aria-pressed={theme === option.id} title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={() => onTheme(option.id)}>
              {option.label}
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

  <section class="settings-section" data-settings-section="repository">
    <h2>仓库</h2>
    <div class="settings-group">
      <div class="settings-row">
        <span class="settings-label">分叉时的拉取<small>重启后保持</small></span>
        <div class="segmented" role="group" aria-label="分叉时的拉取">
          {#each PULLS as option (option.id)}
            <button type="button" aria-pressed={pullIntegration === option.id} title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={() => onPullIntegration(option.id)}>
              {option.label}
            </button>
          {/each}
        </div>
      </div>
      <label class="settings-row switch">
        <span class="settings-label">按斜杠分组分支<small>重启后保持</small></span>
        <input
          type="checkbox"
          checked={branchGroups}
          title={disabled ? BUSY_REASON : undefined}
          disabled={disabled}
          onchange={(event) => onBranchGroups((event.currentTarget as HTMLInputElement).checked)}
        />
      </label>
    </div>
  </section>

  <section
    class="settings-section"
    data-settings-section="runtime"
    tabindex="-1"
    data-autofocus={section === "runtime" ? "" : undefined}
    bind:this={runtimeSection}
  >
    <div class="settings-section-head">
      <h2>运行环境</h2>
      <span class={`chip ${gitStatus.tone}`}>{gitStatus.label}</span>
    </div>
    <div class="settings-group">
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
    tabindex="-1"
    data-autofocus={section === "update" ? "" : undefined}
    bind:this={updateSection}
  >
    <div class="settings-section-head">
      <h2>应用更新</h2>
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
        <p class="update-status" role={updateStage === "failed" ? "alert" : "status"}>{updateStatus}</p>
        {#if updateCheckedAt}
          <p class="update-meta">上次检查：{updateCheckedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
        {/if}
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
        <div class="settings-actions">
          {#if updateStage === "available" && updateOffer && updateInstallSupported}
            <button type="button" class="btn btn-primary btn-sm" onclick={runUpdateInstall}>下载并安装</button>
          {/if}
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            title={updateBusy ? BUSY_REASON : undefined}
            disabled={updateBusy}
            onclick={runUpdateCheck}
          >
            {updateStage === "checking" ? "正在检查…" : "检查更新"}
          </button>
        </div>
      {/if}
    </div>
  </section>
</Modal>
