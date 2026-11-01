<script lang="ts">
  import { onMount, tick } from "svelte";
  import { BRAND } from "../brand";
  import type { RepoSummary, Theme } from "../types";
  import { hueOf, initialOf } from "../ui";
  import {
    WINDOW_PLATFORM,
    closeWindow,
    isWindowMaximized,
    minimizeWindow,
    toggleMaximizeWindow,
    watchWindowMaximized,
    type WindowPlatform,
  } from "../window";
  import BrandMark from "./BrandMark.svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "../icons";

  /**
   * 自绘标题栏：整条为窗口拖拽区（`data-tauri-drag-region` 只落在非交互容器上），
   * 交互控件带 `data-titlebar-control`，因此不会被拖拽命中。
   * R2：常驻交互项恰好 6 个——品牌、仓库、分支、同步组、主题、设置；
   * 刷新、发布分支、只关联上游都不在这里，远程管理收在同步菜单底部。
   * 仓库与分支弹层由外壳挂载，这里只把触发按钮交出去，并显示展开状态。
   */
  interface Props {
    repo: RepoSummary | null;
    branch: string | null;
    upstreamMissing?: boolean;
    ahead?: number;
    behind?: number;
    pending?: "fetch" | "pull" | "push" | null;
    theme: Theme;
    disabled?: boolean;
    platform?: WindowPlatform;
    openSwitcher?: "repo" | "branch" | null;
    onBrand: () => void;
    onRepo: (anchor: HTMLElement) => void;
    onBranch: (anchor: HTMLElement) => void;
    onFetch: () => void;
    onPull: () => void;
    onPush: () => void;
    onRemote: () => void;
    onTheme: (theme: Theme) => void;
    onSettings: () => void;
  }

  let {
    repo,
    branch,
    upstreamMissing = false,
    ahead = 0,
    behind = 0,
    pending = null,
    theme,
    disabled = false,
    platform = WINDOW_PLATFORM,
    openSwitcher = null,
    onBrand,
    onRepo,
    onBranch,
    onFetch,
    onPull,
    onPush,
    onRemote,
    onTheme,
    onSettings,
  }: Props = $props();

  const THEMES: { id: Theme; label: string; icon: IconName }[] = [
    { id: "light", label: "浅色", icon: "sun" },
    { id: "dark", label: "深色", icon: "moon" },
    { id: "system", label: "跟随系统", icon: "eye" },
  ];

  // 两个下拉共用一份关闭逻辑：点外面或按 Esc 都收起，Esc 还把焦点还给触发按钮。
  let openMenu = $state<"theme" | "sync" | null>(null);
  let themeMenu = $derived(openMenu === "theme");
  let syncMenu = $derived(openMenu === "sync");
  let themeAnchor = $state<HTMLDivElement | null>(null);
  let syncAnchor = $state<HTMLDivElement | null>(null);
  let themeTrigger = $state<HTMLButtonElement | null>(null);
  let syncTrigger = $state<HTMLButtonElement | null>(null);
  let maximized = $state(false);

  let currentTheme = $derived(THEMES.find((item) => item.id === theme) ?? THEMES[1]);
  let hasWindowControl = $derived(platform === "windows");
  let branchText = $derived(branch ?? "无分支");
  let branchTitle = $derived(
    `当前分支：${branchText}${upstreamMissing ? "（未关联上游）" : ""}\n点击切换分支`,
  );
  let syncSummary = $derived(
    pending !== null
      ? "进行中"
      : ahead > 0 || behind > 0
        ? `领先 ${ahead}，落后 ${behind}`
        : "与上游一致",
  );

  $effect(() => {
    if (!openMenu) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      const inside =
        (themeAnchor?.contains(target) ?? false) || (syncAnchor?.contains(target) ?? false);
      if (!inside) openMenu = null;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const trigger = openMenu === "sync" ? syncTrigger : themeTrigger;
      openMenu = null;
      trigger?.focus();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  });

  onMount(() => {
    if (platform !== "windows") return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    void isWindowMaximized().then((value) => {
      if (!cancelled) maximized = value;
    });
    void watchWindowMaximized((value) => {
      if (!cancelled) maximized = value;
    }).then((off) => {
      if (cancelled) off();
      else stop = off;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  });

  function menuItems(which: "theme" | "sync"): HTMLElement[] {
    const anchor = which === "sync" ? syncAnchor : themeAnchor;
    return [...(anchor?.querySelectorAll<HTMLElement>(".menu-item:not(:disabled)") ?? [])];
  }

  function toggleMenu(which: "theme" | "sync") {
    openMenu = openMenu === which ? null : which;
    if (openMenu) void tick().then(() => menuItems(which)[0]?.focus());
  }

  function onTriggerKey(event: KeyboardEvent, which: "theme" | "sync") {
    if (event.key !== "ArrowDown" || openMenu === which) return;
    event.preventDefault();
    toggleMenu(which);
  }

  function onMenuKey(event: KeyboardEvent, which: "theme" | "sync") {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = menuItems(which);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[at === -1 ? 0 : (at + step + items.length) % items.length].focus();
  }

  function chooseTheme(next: Theme) {
    openMenu = null;
    onTheme(next);
  }

  function runSync(action: () => void) {
    openMenu = null;
    action();
  }
</script>

<header
  class="titlebar"
  class:titlebar-macos={platform === "macos"}
  aria-label="标题栏"
  data-tauri-drag-region
>
  <div class="titlebar-group titlebar-context" data-tauri-drag-region>
    <button
      type="button"
      class="titlebar-brand"
      data-titlebar-control
      aria-label={`${BRAND.full} 品牌菜单`}
      title={BRAND.tagline}
      onclick={onBrand}
    >
      <BrandMark compact />
    </button>
    <button
      type="button"
      class="repo-switch"
      data-titlebar-control
      aria-label={repo ? `当前仓库 ${repo.name}` : "打开仓库"}
      aria-haspopup="dialog"
      aria-expanded={openSwitcher === "repo"}
      title={repo ? `${repo.path}\n点击切换仓库` : "打开一个仓库"}
      onclick={(event) => onRepo(event.currentTarget)}
    >
      {#if repo}
        <span class="repo-badge" style={`--hue:${hueOf(repo.path)}`} aria-hidden="true">{initialOf(repo.name)}</span>
      {/if}
      <span class="repo-switch-text">
        <strong>{repo ? repo.name : "打开仓库"}</strong>
        {#if repo}<span><bdi>{repo.path}</bdi></span>{/if}
      </span>
      <Icon name="chevron-down" size={13} />
    </button>
    <button
      type="button"
      class="branch-pill"
      data-titlebar-control
      disabled={branch === null}
      aria-label={`当前分支 ${branchText}`}
      aria-haspopup="dialog"
      aria-expanded={openSwitcher === "branch"}
      title={branchTitle}
      onclick={(event) => onBranch(event.currentTarget)}
    >
      <Icon name="branch" size={15} />
      <span class="truncate">{branchText}</span>
      {#if upstreamMissing}<span class="branch-hint">未关联上游</span>{/if}
      <Icon name="chevron-down" size={13} />
    </button>
  </div>

  <span class="titlebar-spacer" data-tauri-drag-region aria-hidden="true"></span>

  <div class="titlebar-group titlebar-actions" data-tauri-drag-region>
    <div class="menu-anchor" bind:this={syncAnchor}>
      <button
        type="button"
        class="branch-pill sync-pill"
        data-titlebar-control
        class:busy={pending !== null}
        disabled={repo === null}
        aria-label={`同步 ${syncSummary}`}
        aria-haspopup="menu"
        aria-expanded={syncMenu}
        title={`同步状态：${syncSummary}\n获取、拉取与推送都在这里`}
        bind:this={syncTrigger}
        onclick={() => toggleMenu("sync")}
        onkeydown={(event) => onTriggerKey(event, "sync")}
      >
        <Icon name="cloud" size={15} />
        <span class="truncate">同步</span>
        {#if ahead > 0}<span class="count">{ahead}</span>{/if}
        {#if behind > 0}<span class="count subtle-count">{behind}</span>{/if}
        {#if pending !== null}<span class="spinner"></span>{/if}
        <Icon name="chevron-down" size={13} />
      </button>
      {#if syncMenu}
        <div class="menu" role="menu" aria-label="同步" tabindex="-1" onkeydown={(event) => onMenuKey(event, "sync")}>
          <button type="button" class="menu-item" role="menuitem" disabled={disabled} onclick={() => runSync(onFetch)}>
            <Icon name="download" />
            <span>获取更新<small>下载远程分支与提交信息，不修改本地文件</small></span>
          </button>
          <button type="button" class="menu-item" role="menuitem" disabled={disabled} onclick={() => runSync(onPull)}>
            <Icon name="arrow-down" />
            <span>拉取{behind > 0 ? ` ${behind} 个提交` : ""}<small>快进拉取，不会自动合并分叉</small></span>
          </button>
          <button type="button" class="menu-item" role="menuitem" disabled={disabled} onclick={() => runSync(onPush)}>
            <Icon name="arrow-up" />
            <span>推送{ahead > 0 ? ` ${ahead} 个提交` : ""}<small>不会强行推送</small></span>
          </button>
          <div class="menu-sep" role="separator"></div>
          <button type="button" class="menu-item" role="menuitem" onclick={() => runSync(onRemote)}>
            <Icon name="globe" />
            <span>远程<small>查看与修改远程地址</small></span>
          </button>
        </div>
      {/if}
    </div>

    <div class="menu-anchor" bind:this={themeAnchor}>
      <button
        type="button"
        class="icon-btn"
        data-titlebar-control
        aria-label={`主题：${currentTheme.label}`}
        aria-haspopup="menu"
        aria-expanded={themeMenu}
        title={`主题：${currentTheme.label}`}
        bind:this={themeTrigger}
        onclick={() => toggleMenu("theme")}
        onkeydown={(event) => onTriggerKey(event, "theme")}
      >
        <Icon name={currentTheme.icon} size={16} />
      </button>
      {#if themeMenu}
        <div class="menu" role="menu" aria-label="主题" tabindex="-1" onkeydown={(event) => onMenuKey(event, "theme")}>
          {#each THEMES as item (item.id)}
            <button
              type="button"
              class="menu-item"
              role="menuitemradio"
              aria-checked={theme === item.id}
              onclick={() => chooseTheme(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {#if theme === item.id}<Icon name="check" size={14} />{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <button
      type="button"
      class="icon-btn titlebar-settings"
      data-titlebar-control
      aria-label="设置"
      title="设置：外观与运行环境"
      onclick={onSettings}
    >
      <Icon name="settings" size={16} />
    </button>

    {#if hasWindowControl}
      <div class="titlebar-window-controls" role="group" aria-label="窗口">
        <button type="button" class="titlebar-win-btn" aria-label="最小化窗口" title="最小化" onclick={() => void minimizeWindow()}>
          <Icon name="minus" size={14} />
        </button>
        <button
          type="button"
          class="titlebar-win-btn"
          aria-label={maximized ? "还原窗口" : "最大化窗口"}
          title={maximized ? "还原" : "最大化"}
          onclick={() => void toggleMaximizeWindow()}
        >
          {#if maximized}<Icon name="split" size={13} />{:else}<Icon name="rows" size={13} />{/if}
        </button>
        <button type="button" class="titlebar-win-btn close" aria-label="关闭窗口" title="关闭" onclick={() => void closeWindow()}>
          <Icon name="x" size={14} />
        </button>
      </div>
    {/if}
  </div>
</header>
