<script module lang="ts">
  import { MODIFIER_LABEL } from "../brand";
  import { COMMANDS } from "../commands";

  export interface ShortcutEntry {
    id: string;
    title: string;
    hint: string;
    /** 一组或多组可选快捷键组合；组间以「或」分隔，组内键帽按字面渲染（例如 ⌘ / 中的 /）。 */
    keyGroups: string[][];
    keywords?: string;
  }

  export interface ShortcutSection {
    id: string;
    title: string;
    items: ShortcutEntry[];
  }

  function formatCommandKeys(shortcut: string, modifierLabel: string): string[] {
    const altLabel = modifierLabel === "⌘" ? "⌥" : "Alt";
    return shortcut
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => {
        if (part === "⌘" || part === "Ctrl") return modifierLabel;
        if (part === "⌥" || part === "Alt") return altLabel;
        return part;
      });
  }

  /**
   * 从命令注册表（COMMANDS）与视图局部声明表同源生成快捷键分组：
   * - 全局命令直接读取 COMMANDS，避免文档与实际注册表漂移；
   * - 视图/编辑器/弹层内的局部快捷键按平台修饰键自适应展示。
   */
  export function buildShortcutSections(modifierLabel = MODIFIER_LABEL): ShortcutSection[] {
    const altLabel = modifierLabel === "⌘" ? "⌥" : "Alt";
    const groupOrder: string[] = [];
    const grouped = new Map<string, ShortcutEntry[]>();

    for (const command of COMMANDS) {
      if (!command.shortcut) continue;
      if (!grouped.has(command.group)) {
        groupOrder.push(command.group);
        grouped.set(command.group, []);
      }
      const keys = formatCommandKeys(command.shortcut, modifierLabel);
      grouped.get(command.group)!.push({
        id: command.id,
        title: command.title,
        hint: command.hint,
        keyGroups: [keys],
        keywords: command.keywords,
      });
      if (command.id === "dialog.shortcuts") {
        grouped.get(command.group)!.push({
          id: "dialog.shortcuts.question",
          title: "快捷键一览（非输入态）",
          hint: "焦点不在输入框或终端时按 ? 快速打开",
          keyGroups: [["?"]],
          keywords: "help shortcuts 帮助 键盘",
        });
      }
    }

    const sections: ShortcutSection[] = groupOrder.map((group) => ({
      id: `cmd:${group}`,
      title: group,
      items: grouped.get(group) ?? [],
    }));

    sections.push(
      {
        id: "local:files",
        title: "改动列表与多选",
        items: [
          {
            id: "files.nav",
            title: "上下移动文件选择",
            hint: "在文件列表与提交列表中切换当前焦点项",
            keyGroups: [["↑"], ["↓"]],
            keywords: "list navigate 导航",
          },
          {
            id: "files.stage",
            title: "暂存 / 取消暂存当前文件",
            hint: "在改动列表中快速切换当前行或已多选文件的暂存状态",
            keyGroups: [["Space"]],
            keywords: "stage unstage 空格",
          },
          {
            id: "files.multi",
            title: "多选与范围连选",
            hint: "组合点击文件或提交进行多选批量操作",
            keyGroups: [[modifierLabel, "点击"], ["⇧", "点击"]],
            keywords: "multi select batch 批量",
          },
          {
            id: "files.clearMulti",
            title: "退出多选模式",
            hint: "改动视图多选时回到单个焦点文件",
            keyGroups: [["Esc"]],
            keywords: "clear multi selection 取消多选",
          },
        ],
      },
      {
        id: "local:diff",
        title: "差异阅读与编辑",
        items: [
          {
            id: "diff.find",
            title: "差异 / 文件内查找",
            hint: "在差异代码或只读文件视图内搜索文本并跳转命中",
            keyGroups: [[modifierLabel, "F"]],
            keywords: "find search 查找",
          },
          {
            id: "diff.pickLine",
            title: "行号直点选行 / 范围连选",
            hint: "点击差异行号列自动进入选行模式，按住 Shift 连续勾选",
            keyGroups: [["⇧", "点击行号"]],
            keywords: "pick line stage discard 选行 逐行",
          },
          {
            id: "editor.save",
            title: "保存文件编辑",
            hint: "在文件视图编辑器中保存当前工作区修改",
            keyGroups: [[modifierLabel, "S"]],
            keywords: "save edit 保存 编辑",
          },
          {
            id: "terminal.clear",
            title: "打开 / 收起并聚焦终端",
            hint: "与命令面板共用同一条终端命令，支持新建标签页",
            keyGroups: [[modifierLabel, "`"], [modifierLabel, "⇧", "`"]],
            keywords: "terminal shell 命令行",
          },
          {
            id: "dialog.close",
            title: "关闭最上层弹层或对话框",
            hint: "按层级依次关闭菜单、弹层与弹窗并归还焦点",
            keyGroups: [["Esc"]],
            keywords: "close cancel escape 取消",
          },
          {
            id: "nav.review",
            title: "审阅队列导航",
            hint: `配合 ${altLabel}+⇧+←/→ 跳转未审阅文件，${altLabel}+M 标记已审阅`,
            keyGroups: [[altLabel, "M"]],
            keywords: "review unreviewed 审阅",
          },
        ],
      },
    );

    return sections;
  }

  export function filterShortcutSections(sections: readonly ShortcutSection[], rawQuery: string): ShortcutSection[] {
    const terms = rawQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [...sections];
    const result: ShortcutSection[] = [];
    for (const section of sections) {
      const sectionHaystack = section.title.toLowerCase();
      const items = section.items.filter((item) => {
        const haystack = [
          sectionHaystack,
          item.title,
          item.hint,
          item.keywords ?? "",
          item.keyGroups.flat().join(" "),
        ]
          .join(" ")
          .toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
      if (items.length > 0) result.push({ ...section, items });
    }
    return result;
  }
</script>

<script lang="ts">
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    onClose: () => void;
    returnFocus?: HTMLElement | null;
    modifierLabel?: string;
  }

  let { onClose, returnFocus = null, modifierLabel = MODIFIER_LABEL }: Props = $props();

  let query = $state("");
  let sections = $derived(buildShortcutSections(modifierLabel));
  let filtered = $derived(filterShortcutSections(sections, query));
  let totalMatches = $derived(filtered.reduce((sum, section) => sum + section.items.length, 0));
</script>

<Modal
  title="快捷键一览"
  titleId="shortcut-help-title"
  icon="keyboard"
  size="lg"
  description={`当前平台键帽：${modifierLabel === "⌘" ? "macOS（⌘ / ⌥）" : "Windows / Linux（Ctrl / Alt）"}；全部全局条目与命令注册表同源`}
  {returnFocus}
  {onClose}
>
  <div class="shortcut-help">
    <div class="shortcut-help-search">
      <div class="field sm">
        <Icon name="search" size={14} />
        <input
          type="search"
          data-autofocus
          aria-label="搜索快捷键"
          placeholder="搜索动作名称、分组或按键（如 暂存、终端、Alt）"
          autocomplete="off"
          spellcheck="false"
          bind:value={query}
          onkeydown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              query = "";
            }
          }}
        />
        {#if query}
          <button
            type="button"
            class="field-clear"
            aria-label="清除搜索"
            onclick={() => (query = "")}
          >
            <Icon name="x" size={12} />
          </button>
        {/if}
      </div>
      <span class="shortcut-help-count" aria-live="polite">
        {query.trim() ? `匹配 ${totalMatches} 项` : `共 ${totalMatches} 项`}
      </span>
    </div>

    {#if filtered.length === 0}
      <div class="empty compact" role="status" data-shortcut-empty>
        <span class="empty-icon"><Icon name="search" size={20} /></span>
        <strong>没有匹配的快捷键</strong>
        <p>试试更短的关键词，或按分组名（如「视图」「提交」「终端」）筛选。</p>
        <button type="button" class="btn btn-secondary btn-sm" onclick={() => (query = "")}>清除搜索</button>
      </div>
    {:else}
      <div class="shortcut-sections" data-shortcut-sections>
        {#each filtered as section (section.id)}
          <section class="shortcut-section" aria-label={section.title}>
            <h3 class="shortcut-section-title">{section.title}</h3>
            <ul class="shortcut-list">
              {#each section.items as item (item.id)}
                <li class="shortcut-row" data-shortcut-id={item.id}>
                  <div class="shortcut-meta">
                    <span class="shortcut-title">{item.title}</span>
                    <span class="shortcut-hint">{item.hint}</span>
                  </div>
                  <span class="shortcut-keys" aria-label={`快捷键 ${item.keyGroups.map((group) => group.join(" ")).join(" 或 ")}`}>
                    {#each item.keyGroups as group, groupIndex (`${item.id}:g${groupIndex}`)}
                      {#if groupIndex > 0}<span class="shortcut-or" aria-hidden="true">或</span>{/if}
                      {#each group as key, keyIndex (`${item.id}:g${groupIndex}:k${keyIndex}`)}
                        <kbd>{key}</kbd>
                      {/each}
                    {/each}
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <span class="hint">按 <kbd>Esc</kbd> 关闭并回到原焦点</span>
    <span class="spacer"></span>
    <button type="button" class="btn btn-secondary" onclick={onClose}>关闭</button>
  {/snippet}
</Modal>
