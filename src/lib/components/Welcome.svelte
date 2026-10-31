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
  let shown = $derived(recent.slice(0, 6));
</script>

<div class="welcome">
  <div class="welcome-inner">
    <div class="welcome-hero">
      <BrandMark large />
      <h1>欢迎使用 {BRAND.name}</h1>
      <p>{BRAND.tagline}</p>
    </div>

    <div class="action-cards">
      <button type="button" class="action-card" {disabled} onclick={onAdd}>
        <span class="ac-icon"><Icon name="folder-open" size={18} /></span>
        <strong>打开本地仓库</strong>
        <span>选择已有目录。只检查它是不是 Git 仓库，不会写入。</span>
      </button>
      <button type="button" class="action-card" {disabled} onclick={onClone}>
        <span class="ac-icon"><Icon name="download" size={18} /></span>
        <strong>克隆远程仓库</strong>
        <span>支持 HTTPS、SSH 与本机路径。不会覆盖已有文件。</span>
      </button>
      <button type="button" class="action-card" {disabled} onclick={onCreate}>
        <span class="ac-icon"><Icon name="folder-plus" size={18} /></span>
        <strong>新建仓库</strong>
        <span>在目录中初始化 Git。确认前不做任何修改。</span>
      </button>
    </div>

    {#if shown.length > 0}
      <section class="welcome-section" aria-label="最近打开">
        <h2>最近打开</h2>
        <div class="welcome-recent">
          {#each shown as repo (repo.path)}
            <button type="button" title={repo.path} onclick={() => onOpen(repo.path)}>
              <span class="repo-badge" style={`--hue:${hueOf(repo.path)}`} aria-hidden="true">{initialOf(repo.name)}</span>
              <span class="repo-text">
                <span class="repo-name">{repo.name}</span>
                <span class="repo-path"><bdi>{repo.path}</bdi></span>
              </span>
              <Icon name="chevron-right" size={16} />
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <div class="shortcuts" aria-label="快捷键">
      <span><kbd>{MODIFIER_LABEL} K</kbd>搜索仓库</span>
      <span><kbd>{MODIFIER_LABEL} 1–4</kbd>切换视图</span>
      <span><kbd>{MODIFIER_LABEL} ↵</kbd>提交到本地</span>
      <span><kbd>空格</kbd>暂存所选文件</span>
    </div>
    <p class="welcome-note">本地查看、暂存、提交和分支操作都不需要登录研发平台。运行所需的 Git 与 WebView2 说明见底部状态栏的「运行依赖」。</p>
  </div>
</div>
