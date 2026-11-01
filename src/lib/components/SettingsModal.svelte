<script lang="ts">
  import { dependencyNote, gitInstallHint } from "../labels";
  import type { GitInfo, Theme } from "../types";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    theme: Theme;
    git: GitInfo | null;
    disabled: boolean;
    onClose: () => void;
    /** 选择外观；"system" 解析成浅色还是深色由外壳负责。 */
    onTheme: (theme: Theme) => void;
    onRedetect: () => void;
    onChooseGit: () => void;
    onClearGit: () => void;
    /**
     * 打开时定位的分区：Git 不可用的诊断入口指向 "runtime"，
     * 其余入口不传（等价于现在的首屏：外观在运行环境之上）。不改任何按钮行为。
     */
    section?: "appearance" | "runtime" | null;
  }

  let {
    theme,
    git,
    disabled,
    onClose,
    onTheme,
    onRedetect,
    onChooseGit,
    onClearGit,
    section = null,
  }: Props = $props();

  const THEMES: { id: Theme; label: string }[] = [
    { id: "light", label: "浅色" },
    { id: "dark", label: "深色" },
    { id: "system", label: "跟随系统" },
  ];

  let runtimeCard = $state<HTMLDivElement | null>(null);

  /* 诊断入口要真的落到运行环境分区：Modal 的首焦点读 [data-autofocus]，
     这里再补一次滚动，避免那一块在 modal 滚动区之外。 */
  $effect(() => {
    if (section !== "runtime") return;
    const card = runtimeCard;
    if (!card || typeof card.scrollIntoView !== "function") return;
    card.scrollIntoView({ block: "start" });
  });

  let platform = $derived(navigator.platform ?? "");
  let gitLine = $derived(
    git === null
      ? "尚未检测 Git"
      : git.available
        ? `Git ${git.version ?? "已可用"}${git.path ? ` · ${git.path}` : ""}${git.overridden ? " · 手动指定" : ""}`
        : (git.message ?? "Git 不可用"),
  );
</script>

<Modal
  title="设置"
  titleId="settings-modal-title"
  size="lg"
  task="settings"
  description="外观与运行环境集中在这里。"
  onClose={onClose}
>
  <div class="card" data-settings-section="appearance">
    <div class="card-head">
      <span class="ch-icon"><Icon name="sun" size={15} /></span>
      <h2>外观</h2>
      <span class="spacer"></span>
      <span class="hint">默认深色</span>
    </div>
    <div class="card-body">
      <div class="segmented" role="group" aria-label="外观">
        {#each THEMES as option (option.id)}
          <button type="button" aria-pressed={theme === option.id} disabled={disabled} onclick={() => onTheme(option.id)}>
            {option.label}
          </button>
        {/each}
      </div>
      <p class="hint">选择写入设置后重启仍保持；跟随系统时按系统的浅深设置切换。</p>
    </div>
  </div>

  <div
    class="card"
    data-settings-section="runtime"
    tabindex="-1"
    data-autofocus={section === "runtime" ? "" : undefined}
    bind:this={runtimeCard}
  >
    <div class="card-head">
      <span class="ch-icon info"><Icon name="package" size={15} /></span>
      <h2>运行环境</h2>
      <span class="spacer"></span>
      <span class={`chip ${git?.available ? "current" : "skip"}`}>{git?.available ? "Git 可用" : "Git 不可用"}</span>
    </div>
    <div class="card-body">
      <ul class="scope-list" style="max-height: none" aria-label="Git 诊断">
        <li title={gitLine}>{gitLine}</li>
        {#if git && git.belowBaseline}
          <li title={git.message}>{git.message}</li>
        {/if}
        <li title={gitInstallHint(platform)}>{gitInstallHint(platform)}</li>
      </ul>
      <div class="row">
        <button type="button" class="btn btn-secondary btn-sm" disabled={disabled} onclick={onRedetect}>重新检测</button>
        <button type="button" class="btn btn-secondary btn-sm" disabled={disabled} onclick={onChooseGit}>选择 Git</button>
        {#if git?.overridden}
          <button type="button" class="btn btn-ghost btn-sm" disabled={disabled} onclick={onClearGit}>恢复自动检测</button>
        {/if}
      </div>
      <label class="label" for="settings-runtime-note">WebView2 与安装说明</label>
      <textarea id="settings-runtime-note" class="full-value prose" readonly rows={8}>{dependencyNote(platform)}</textarea>
    </div>
  </div>
</Modal>
