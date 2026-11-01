<script lang="ts">
  import type { RecentRepo } from "../types";
  import { hueOf, initialOf } from "../ui";
  import { BRAND, MODIFIER_LABEL } from "../brand";
  import BrandMark from "./BrandMark.svelte";
  import Icon from "./Icon.svelte";

  /**
   * 起始页：hero（一句话价值 + 产品插画）+ 单屏三入口（打开 / 克隆 / 新建）+ 最近仓库，
   * 不堆营销段落。Git 不可用时只多一行诊断入口，不展开说明。
   */
  interface Props {
    recent: RecentRepo[];
    disabled: boolean;
    onAdd: () => void;
    onClone: () => void;
    onCreate: () => void;
    onOpen: (path: string) => void;
    diagnostic?: string | null;
    onDiagnose?: () => void;
  }
  let {
    recent,
    disabled,
    onAdd,
    onClone,
    onCreate,
    onOpen,
    diagnostic = null,
    onDiagnose,
  }: Props = $props();
  let shown = $derived(recent.slice(0, 5));
</script>

<div class="welcome">
  <div class="welcome-inner">
    <section class="welcome-hero">
      <div class="welcome-copy">
        <span class="welcome-eyebrow"><BrandMark compact />{BRAND.full}</span>
        <h1>把 <span>Git 工作流</span><br />装进一个安静的窗口</h1>
        <p>改动暂存、差异审阅、提交历史、分支合并与临时保存都在手边；<br />本地优先，打开即用。</p>
        <div class="welcome-assurances">
          <span><Icon name="check-circle" size={13} />本地优先，无需登录</span>
          <span><Icon name="keyboard" size={13} />命令面板与快捷键</span>
          <span><Icon name="commit" size={13} />基于系统 Git</span>
          <span><Icon name="layers" size={13} />多仓库并行</span>
        </div>
      </div>
      <div class="welcome-art" aria-hidden="true">
        <span class="art-glow"></span>
        <div class="art-card art-card-back"><span></span><span></span><span></span></div>
        <div class="art-card art-card-front">
          <div class="art-card-head">
            <BrandMark compact />
            <span class="art-chip">feature/modern-ui</span>
          </div>
          <div class="art-branch-line"><span class="art-node"></span><span></span></div>
          <strong>twiglane</strong>
          <span class="art-path">C:/Users/dev/project/twiglane</span>
          <div class="art-diff add">+ const view = render("src/App.svelte", {"{"} theme: "modern" {"}"});</div>
          <div class="art-diff del">- return legacyRender("src/App.svelte", value0);</div>
          <div class="art-commit"><Icon name="commit" size={11} />2 个提交待推送</div>
        </div>
      </div>
    </section>

    <section class="welcome-actions" aria-label="开始使用">
      <button type="button" class="action-card primary" {disabled} onclick={onAdd}>
        <span class="ac-icon"><Icon name="folder-open" size={21} /></span>
        <span class="ac-copy"><strong>打开本地仓库</strong><span>选择已有目录</span></span>
        <Icon name="arrow-up" size={17} class="action-arrow" />
      </button>
      <button type="button" class="action-card" {disabled} onclick={onClone}>
        <span class="ac-icon"><Icon name="download" size={20} /></span>
        <span class="ac-copy"><strong>克隆远程仓库</strong><span>HTTPS、SSH 或本机路径</span></span>
        <Icon name="chevron-right" size={17} />
      </button>
      <button type="button" class="action-card" {disabled} onclick={onCreate}>
        <span class="ac-icon"><Icon name="folder-plus" size={20} /></span>
        <span class="ac-copy"><strong>新建仓库</strong><span>在空目录初始化 Git</span></span>
        <Icon name="chevron-right" size={17} />
      </button>
    </section>

    {#if diagnostic}
      {#if onDiagnose}
        <button type="button" class="welcome-diagnostic" onclick={onDiagnose}>
          <Icon name="alert-circle" size={15} />
          <span>{diagnostic}</span>
          <Icon name="chevron-right" size={14} />
        </button>
      {:else}
        <p class="welcome-diagnostic">{diagnostic}</p>
      {/if}
    {/if}

    <section class="welcome-section" aria-label="最近仓库">
      <div class="welcome-section-head">
        <div><span class="section-kicker">继续之前的工作</span><h2>最近仓库</h2></div>
        {#if recent.length > 0}<span class="hint">{recent.length} 个仓库</span>{/if}
      </div>
      {#if shown.length === 0}
        <p class="hint welcome-empty">还没有最近仓库，先打开或克隆一个。</p>
      {:else}
        <div class="welcome-recent">
          {#each shown as repo (repo.path)}
            <button type="button" title={repo.path} onclick={() => onOpen(repo.path)}>
              <span class="repo-badge" style={`--hue:${hueOf(repo.path)}`} aria-hidden="true">{initialOf(repo.name)}</span>
              <span class="repo-text">
                <span class="repo-name">{repo.name}</span>
                <span class="repo-path"><bdi>{repo.path}</bdi></span>
              </span>
              <span class="recent-open">打开<Icon name="arrow-up" size={13} /></span>
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <footer class="welcome-footer">
      <div class="shortcuts">
        <span><kbd>{MODIFIER_LABEL}</kbd><kbd>K</kbd>命令面板</span>
        <span><kbd>{MODIFIER_LABEL}</kbd><kbd>1</kbd>改动</span>
        <span><kbd>{MODIFIER_LABEL}</kbd><kbd>2</kbd>提交历史</span>
      </div>
      <p class="welcome-note">{BRAND.full} · 本地优先的 Git 客户端<br />危险操作先确认，不会覆盖或强推</p>
    </footer>
  </div>
</div>
