<script lang="ts">
  import { onMount, tick } from "svelte";
  import { BRAND, MODIFIER_LABEL } from "../brand";
  import type { RepoSummary, Theme } from "../types";
  import { BUSY_REASON, hueOf, repoBadgeLetter } from "../ui";
  import {
    WINDOW_PLATFORM,
    closeWindow,
    isWindowMaximized,
    minimizeWindow,
    toggleMaximizeWindow,
    watchWindowMaximized,
    type WindowPlatform,
  } from "../window";
  import { shortOid } from "../history";
  import { formatCheckedAt } from "../labels";
  import BrandMark from "./BrandMark.svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "../icons";

  /**
   * 自绘标题栏：整条为窗口拖拽区（`data-tauri-drag-region` 只落在非交互容器上），
   * 交互控件带 `data-titlebar-control`，因此不会被拖拽命中。
   * R6：常驻交互项不超过 6 个——品牌、仓库、分支、同步组、主题、设置；没有打开仓库时
   * 分支和同步都没有意义，不显示，只留品牌、打开仓库、主题和设置。
   * 刷新、发布分支、只关联上游都不在这里，远程管理收在同步菜单底部。
   * 仓库与分支弹层由外壳挂载，这里只把触发按钮交出去，并显示展开状态。
   */
  /** 来自 cliora 的审查来源；有来源时标题栏给出「返回 cliora」入口。 */
  interface ClioraBadge {
    reviewId: string;
    outcome: "reviewed" | "committed" | "merged";
    /** 仅 committed/merged 有值；只是待复核声明，cliora 会重新读取真实 HEAD。 */
    headOid: string | null;
  }

  interface Props {
    repo: RepoSummary | null;
    branch: string | null;
    upstreamMissing?: boolean;
    ahead?: number;
    behind?: number;
    /**
     * 远程核对状态（R3）：live 是刚读到的远程状态，stale 是缓存已过期，off 是从未核对。
     * 折叠状态下的同步按钮必须自己说明这件事，不能只把缓存数字当成刚刚验证过的结论。
     */
    remoteState?: "live" | "stale" | "off";
    /** 上次核对远程的时间（毫秒）；没有可信时间时不显示。 */
    remoteCheckedAtMs?: number | null;
    pending?: "fetch" | "pull" | "push" | null;
    theme: Theme;
    disabled?: boolean;
    platform?: WindowPlatform;
    openSwitcher?: "repo" | "branch" | null;
    /** 与当前徽标同时可见的仓库名。缺省时只看当前仓库。 */
    repoNames?: string[];
    /** 当前仓库由 cliora 审查链接打开时的来源与最新结果；独立仓库为 null。 */
    cliora?: ClioraBadge | null;
    /** 返回 cliora 原会话。只回送结果，不执行 Git 写入。 */
    onClioraReturn?: () => void;
    onBrand: () => void;
    /** 显式打开命令面板；未传时复用品牌入口行为。 */
    onPalette?: () => void;
    onRepo: (anchor: HTMLElement) => void;
    onBranch: (anchor: HTMLElement) => void;
    onFetch: () => void;
    onPull: () => void;
    onPush: () => void;
    /** 仓库配置的全部远程名；多于一个时菜单提供「推送到其他远程」。 */
    remotes?: string[];
    /** 当前分支的上游（如 origin/main），用来区分默认推送目标。 */
    upstream?: string | null;
    /** 正在进行可取消的远程操作（获取、拉取、推送、发布）。 */
    remoteBusy?: boolean;
    cancelling?: boolean;
    onSyncOpen?: () => void;
    onPushTo?: (remote: string) => void;
    onPushAll?: () => void;
    onCancelSync?: () => void;
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
    remoteState = "off",
    remoteCheckedAtMs = null,
    pending = null,
    theme,
    disabled = false,
    platform = WINDOW_PLATFORM,
    openSwitcher = null,
    repoNames = [],
    cliora = null,
    onClioraReturn,
    onBrand,
    onPalette,
    onRepo,
    onBranch,
    onFetch,
    onPull,
    onPush,
    remotes = [],
    upstream = null,
    remoteBusy = false,
    cancelling = false,
    onSyncOpen,
    onPushTo,
    onPushAll,
    onCancelSync,
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

  let badgeNames = $derived(repoNames.length > 0 ? repoNames : repo ? [repo.name] : []);
  let badgeLetter = $derived(repo ? repoBadgeLetter(repo.name, badgeNames) : "");
  let currentTheme = $derived(THEMES.find((item) => item.id === theme) ?? THEMES[1]);
  let hasWindowControl = $derived(platform === "windows");
  let branchText = $derived(branch ?? "无分支");
  let branchTitle = $derived(
    `当前分支：${branchText}${upstreamMissing ? "（未关联上游）" : ""}\n点击切换分支`,
  );
  let upstreamRemote = $derived(upstream ? upstream.slice(0, Math.max(0, upstream.indexOf("/"))) || null : null);
  let pushTarget = $derived(upstream ?? (remotes[0] ? `${remotes[0]}（发布）` : null));
  let otherRemotes = $derived(remotes.filter((name) => name !== upstreamRemote));
  let clioraSummary = $derived(
    cliora === null
      ? ""
      : cliora.outcome === "reviewed"
        ? ""
        : (cliora.outcome === "committed" ? "已提交 " : "已合入 ") +
          (cliora.headOid ? shortOid(cliora.headOid) : ""),
  );
  /** 上次核对远程的时间；没有可信时间戳时不编造时间。 */
  let checkedText = $derived(
    remoteState !== "off" && remoteCheckedAtMs ? formatCheckedAt(remoteCheckedAtMs) : "",
  );
  /** 计数只代表「相对已记录上游」的对比，核对的时效必须跟着一起说（R3）。 */
  let remoteNote = $derived(
    remoteState === "live"
      ? checkedText
        ? `，已于 ${checkedText} 检查`
        : "，已检查远程"
      : remoteState === "stale"
        ? `，远程状态已过期${checkedText ? `（上次检查 ${checkedText}）` : ""}`
        : "，未核对远程",
  );
  let remoteHint = $derived(
    remoteState === "live"
      ? `远程状态：${checkedText ? `已于 ${checkedText} 检查` : "已检查"}`
      : remoteState === "stale"
        ? `远程状态：已过期${checkedText ? `，上次检查 ${checkedText}` : ""}；计数不代表最新`
        : "远程状态：未核对；计数只反映记录的对比",
  );
  let syncSummary = $derived(
    pending !== null
      ? "进行中"
      : ahead > 0 || behind > 0
        ? `领先 ${ahead}，落后 ${behind}${remoteNote}`
        : `${upstreamMissing ? "未关联上游" : "与上游一致"}${remoteNote}`,
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
    if (openMenu === "sync") onSyncOpen?.();
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

  // 菜单项随菜单卸载，焦点要先回到触发按钮；随后打开的 modal 关闭时才回得来。
  function chooseTheme(next: Theme) {
    openMenu = null;
    themeTrigger?.focus();
    onTheme(next);
  }

  function runSync(action: () => void) {
    openMenu = null;
    syncTrigger?.focus();
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
        <span class="repo-badge" style={`--hue:${hueOf(repo.path)}`} aria-hidden="true">{badgeLetter}</span>
      {/if}
      <span class="repo-switch-text">
        <strong>{repo ? repo.name : "打开仓库"}</strong>
        {#if repo}<span><bdi>{repo.path}</bdi></span>{/if}
      </span>
      <Icon name="chevron-down" size={13} />
    </button>
    {#if repo}
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
    {/if}
  </div>

  <span class="titlebar-spacer" data-tauri-drag-region aria-hidden="true"></span>

  <button
    type="button"
    class="titlebar-palette"
    data-titlebar-control
    aria-label="命令面板"
    title={`搜索命令、切换仓库或分支（${MODIFIER_LABEL}+K）`}
    onclick={() => (onPalette ?? onBrand)()}
  >
    <Icon name="search" size={13} />
    <span class="titlebar-palette-label">搜索或运行命令</span>
    <kbd aria-hidden="true">{MODIFIER_LABEL} K</kbd>
  </button>

  <span class="titlebar-spacer" data-tauri-drag-region aria-hidden="true"></span>

  <div class="titlebar-group titlebar-actions" data-tauri-drag-region>
    {#if repo}
      <div class="menu-anchor" bind:this={syncAnchor}>
        <button
          type="button"
          class="branch-pill sync-pill"
          data-titlebar-control
          class:busy={pending !== null}
            aria-label={`同步 ${syncSummary}`}
          aria-haspopup="menu"
          aria-expanded={syncMenu}
          title={`同步状态：${syncSummary}\n${remoteHint}\n获取、拉取与推送都在这里`}
          bind:this={syncTrigger}
          onclick={() => toggleMenu("sync")}
          onkeydown={(event) => onTriggerKey(event, "sync")}
        >
          <Icon name="cloud" size={15} />
          <span class="truncate">同步</span>
          <!-- 方向由箭头 + 计数一起表达（R3）：只看数字时分不清是待推送还是待拉取。 -->
          {#if ahead > 0}
            <span class="count" data-sync-count="push" title={`待推送 ${ahead} 个提交`} aria-hidden="true">
              <Icon name="arrow-up" size={11} />{ahead}
            </span>
          {/if}
          {#if behind > 0}
            <span class="count subtle-count" data-sync-count="pull" title={`待拉取 ${behind} 个提交`} aria-hidden="true">
              <Icon name="arrow-down" size={11} />{behind}
            </span>
          {/if}
          <!-- 未核对/过期是文字标记，不靠颜色或数字差表达。 -->
          {#if remoteState !== "live"}
            <span class="sync-remote" class:stale={remoteState === "stale"} data-sync-remote={remoteState} title={remoteHint} aria-hidden="true">
              {remoteState === "stale" ? "过期" : "未核"}
            </span>
          {/if}
          {#if pending !== null}<span class="spinner"></span>{/if}
          <Icon name="chevron-down" size={13} />
        </button>
        {#if syncMenu}
          <div class="menu sync-menu" role="menu" aria-label="同步" tabindex="-1" onkeydown={(event) => onMenuKey(event, "sync")}>
            <button type="button" class="menu-item" role="menuitem" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={() => runSync(onFetch)}>
              <Icon name="download" />
              <span>获取更新<small>下载远程分支与提交，不改本地文件</small></span>
            </button>
            <button type="button" class="menu-item" role="menuitem" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={() => runSync(onPull)}>
              <Icon name="arrow-down" />
              <span>拉取{behind > 0 ? ` ${behind} 个提交` : ""}<small>能快进就快进；分叉时再选择合并或变基</small></span>
            </button>
            <button type="button" class="menu-item" role="menuitem" title={disabled ? BUSY_REASON : undefined} disabled={disabled} onclick={() => runSync(onPush)}>
              <Icon name="arrow-up" />
              <span>推送{ahead > 0 ? ` ${ahead} 个提交` : ""}<small>{pushTarget ? `到 ${pushTarget}，` : ""}不会强行推送</small></span>
            </button>
            {#if remotes.length > 1 && branch && otherRemotes.length > 0}
              <div class="menu-sep" role="separator"></div>
              <div class="menu-label" aria-hidden="true">推送到其他远程</div>
              {#each otherRemotes as remote (remote)}
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  title={disabled ? BUSY_REASON : `把 ${branch} 推送到 ${remote}/${branch}，不改变上游`}
                  disabled={disabled}
                  onclick={() => runSync(() => onPushTo?.(remote))}
                >
                  <Icon name="cloud" />
                  <span>推送到 {remote}<small>{remote}/{branch}，上游保持不变</small></span>
                </button>
              {/each}
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                title={disabled ? BUSY_REASON : `依次推送到 ${remotes.join("、")}`}
                disabled={disabled}
                onclick={() => runSync(() => onPushAll?.())}
              >
                <Icon name="layers" />
                <span>推送到全部 {remotes.length} 个远程<small>{remotes.join("、")}；任一失败即停下</small></span>
              </button>
            {/if}
            {#if remoteBusy && onCancelSync}
              <div class="menu-sep" role="separator"></div>
              <button type="button" class="menu-item danger" role="menuitem" disabled={cancelling} title={cancelling ? "已请求取消，正在等待 Git 退出" : undefined} onclick={() => runSync(onCancelSync)}>
                <Icon name="x" />
                <span>{cancelling ? "正在取消…" : "取消正在进行的同步"}<small>网络或凭据卡住时停下；远程可能已收到部分请求</small></span>
              </button>
            {/if}
            <div class="menu-sep" role="separator"></div>
            <button type="button" class="menu-item" role="menuitem" onclick={() => runSync(onRemote)}>
              <Icon name="globe" />
              <span>远程<small>查看与修改远程地址</small></span>
            </button>
          </div>
        {/if}
      </div>
    {/if}

    {#if cliora}
      <div class="cliora-source" role="group" aria-label="cliora 审查来源">
        <span class="cliora-chip" title={`来源 cliora 审查 ${cliora.reviewId}`}>cliora</span>
        <!-- 只有真的提交或合入了才报结果；「什么都没发生」不占标题栏。 -->
        {#if clioraSummary}<span class="cliora-result" title="提交或合入结果以待复核声明发送，cliora 会重新读取真实 HEAD">{clioraSummary}</span>{/if}
        <button
          type="button"
          class="branch-pill cliora-return"
          data-titlebar-control
          aria-label={clioraSummary ? `返回 cliora（${clioraSummary}）` : "返回 cliora"}
          title="返回发起这次审查的 cliora 会话；不修改仓库、不关闭当前仓库"
          onclick={() => onClioraReturn?.()}
        >
          <span>返回 cliora</span>
          <Icon name="arrow-right" size={13} />
        </button>
      </div>
    {/if}

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
<style>
  /* cliora 来源徽标：与仓库/分支徽标同高，常驻交互项仍是品牌、仓库、分支、
     同步、主题、设置六项，来源只在有 cliora 上下文时出现。 */
  .cliora-source {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    height: var(--titlebar-control);
    padding-left: var(--space-6);
  }

  .cliora-chip {
    padding: 0 var(--space-6);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg-muted);
    font-size: var(--text-xs);
    line-height: 18px;
  }

  .cliora-result {
    color: var(--fg-muted);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .cliora-return {
    gap: var(--space-4);
  }
</style>
