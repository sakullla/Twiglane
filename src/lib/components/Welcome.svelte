<script lang="ts">
  import { BRAND, MODIFIER_LABEL } from "../brand";
  import type { RecentRepo } from "../types";
  import { hueOf, initialOf } from "../ui";
  import BrandMark from "./BrandMark.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    recent: RecentRepo[];
    disabled: boolean;
    onAdd: () => void;
    onClone: () => void;
    onCreate: () => void;
    onOpen: (path: string) => void;
  }
  let { recent, disabled, onAdd, onClone, onCreate, onOpen }: Props = $props();
  let shown = $derived(recent.slice(0, 5));
</script>

<div class="welcome">
  <div class="welcome-inner">
    <section class="welcome-hero" aria-labelledby="welcome-title">
      <div class="welcome-copy">
        <span class="welcome-eyebrow"><span class="local-dot"></span>你的本地 Git 工作区</span>
        <h1 id="welcome-title">让每一次改动，<br /><span>都清晰有序。</span></h1>
        <p>专注于代码，而不是命令。查看差异、整理提交、管理分支，<br class="desktop-break" />所有操作都在一个安静、直观的工作区里完成。</p>
        <div class="welcome-assurances">
          <span><Icon name="check-circle" size={14} />无需登录</span>
          <span><Icon name="check-circle" size={14} />数据留在本机</span>
          <span><Icon name="check-circle" size={14} />危险操作先确认</span>
        </div>
      </div>
      <div class="welcome-art" aria-hidden="true">
        <div class="art-glow"></div>
        <div class="art-card art-card-back">
          <span></span><span></span><span></span>
        </div>
        <div class="art-card art-card-front">
          <div class="art-card-head"><BrandMark compact /><span class="art-chip">准备就绪</span></div>
          <div class="art-branch-line"><span class="art-node"></span><span></span></div>
          <strong>一个清晰的提交</strong>
          <span class="art-path">src/components/App.svelte</span>
          <div class="art-diff add">+ 让工作流更简单</div>
          <div class="art-diff del">− 减少不必要的复杂</div>
          <div class="art-commit"><Icon name="check" size={13} />已整理，随时可以提交</div>
        </div>
      </div>
    </section>

    <section class="welcome-actions" aria-label="开始使用">
      <button type="button" class="action-card primary" {disabled} onclick={onAdd}>
        <span class="ac-icon"><Icon name="folder-open" size={21} /></span>
        <span class="ac-copy"><strong>打开本地仓库</strong><span>选择已有目录，开始查看和整理改动</span></span>
        <Icon name="arrow-up" size={17} class="action-arrow" />
      </button>
      <button type="button" class="action-card" {disabled} onclick={onClone}>
        <span class="ac-icon"><Icon name="download" size={20} /></span>
        <span class="ac-copy"><strong>克隆远程仓库</strong><span>支持 HTTPS、SSH 与本机路径</span></span>
        <Icon name="chevron-right" size={17} />
      </button>
      <button type="button" class="action-card" {disabled} onclick={onCreate}>
        <span class="ac-icon"><Icon name="folder-plus" size={20} /></span>
        <span class="ac-copy"><strong>新建仓库</strong><span>在空目录或已有项目中初始化 Git</span></span>
        <Icon name="chevron-right" size={17} />
      </button>
    </section>

    {#if shown.length > 0}
      <section class="welcome-section" aria-label="最近打开">
        <div class="welcome-section-head">
          <div><span class="section-kicker">继续之前的工作</span><h2>最近打开</h2></div>
          <span class="hint">{recent.length} 个仓库</span>
        </div>
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
      </section>
    {/if}

    <footer class="welcome-footer">
      <div class="shortcuts" aria-label="快捷键">
        <span><kbd>{MODIFIER_LABEL} K</kbd>搜索仓库</span>
        <span><kbd>{MODIFIER_LABEL} 1–4</kbd>切换视图</span>
        <span><kbd>{MODIFIER_LABEL} ↵</kbd>提交到本地</span>
      </div>
      <p class="welcome-note">{BRAND.full} · 本地查看、暂存、提交和分支操作都不需要登录研发平台。</p>
    </footer>
  </div>
</div>
