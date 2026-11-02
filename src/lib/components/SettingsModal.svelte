<script lang="ts">
  import { BUSY_REASON } from "../ui";
  import { dependencyNote } from "../labels";
  import type { GitInfo, Theme } from "../types";
  import { LANGUAGE_OPTIONS } from "../syntax/languages";
  import { setSyntaxEnabled, syntaxPrefs } from "../syntax/prefs.svelte";
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

  let runtimeSection = $state<HTMLElement | null>(null);

  /* 诊断入口要真的落到运行环境分区：Modal 的首焦点读 [data-autofocus]，
     这里再补一次滚动，避免那一块在 modal 滚动区之外。 */
  $effect(() => {
    if (section !== "runtime") return;
    const target = runtimeSection;
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
</script>

<Modal
  title="设置"
  titleId="settings-modal-title"
  task="settings"
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
</Modal>
