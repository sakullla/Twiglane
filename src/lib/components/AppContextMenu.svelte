<script lang="ts">
  import {
    classifyContextTarget,
    copyText,
    editActions,
    editableEntries,
    saveSelection,
    selectionEntries,
  } from "../app-context-menu";
  import ContextMenu, { pointFor, type ContextMenuRequest } from "./ContextMenu.svelte";

  /**
   * 全局右键兜底（见 app-context-menu.ts）：挂在 window 冒泡阶段，组件自己的右键菜单与终端先处理；
   * 没人处理的右键不再弹出 WebView 原生菜单，输入框与选中文字换成应用自己的编辑菜单。
   */
  let menu = $state<ContextMenuRequest | null>(null);

  function point(event: MouseEvent): { x: number; y: number } {
    // 菜单键 / Shift+F10 唤起时没有指针坐标，按目标元素定位。
    if (event.clientX === 0 && event.clientY === 0 && event.target instanceof Element) return pointFor(event.target);
    return { x: event.clientX, y: event.clientY };
  }

  function onContextMenu(event: MouseEvent): void {
    const target = classifyContextTarget(event);
    if (target.kind === "pass") return;
    event.preventDefault();
    if (target.kind === "suppress") {
      menu = null;
      return;
    }
    if (target.kind === "editable") {
      const actions = editActions(target.element, saveSelection(target.element));
      menu = { ...point(event), entries: editableEntries(target.element, actions), label: "编辑菜单" };
      return;
    }
    const text = target.text;
    menu = { ...point(event), entries: selectionEntries(() => void copyText(text)), label: "文本菜单" };
  }

  $effect(() => {
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  });
</script>

{#if menu}{#key menu}<ContextMenu request={menu} onClose={() => (menu = null)} />{/key}{/if}
