<script lang="ts">
  import { tick } from "svelte";
  import { detectLanguage, languageName, LANGUAGE_OPTIONS } from "../syntax/languages";
  import { effectiveLanguage, languageOverride, PLAIN, setLanguageOverride, setSyntaxEnabled, syntaxPrefs } from "../syntax/prefs.svelte";
  import Icon from "./Icon.svelte";

  /**
   * 语法高亮语言选择：显示当前文件按什么语言着色，点开可以搜索全部语言、改回自动推断或按纯文本显示。
   * 选择按扩展名记住（同类文件处处生效），总开关关闭时这里给出一键打开。
   */
  interface Props {
    path: string;
  }

  let { path }: Props = $props();

  let open = $state(false);
  let query = $state("");
  let anchor = $state<HTMLDivElement | null>(null);
  let button = $state<HTMLButtonElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);
  let menuStyle = $state("");
  let active = $state(0);

  let detected = $derived(detectLanguage(path));
  let override = $derived(languageOverride(path));
  let current = $derived(effectiveLanguage(path));
  let label = $derived(!syntaxPrefs.enabled ? "高亮已关闭" : languageName(current));
  let ext = $derived((path.split(/[\\/]/).pop() ?? path).includes(".") ? `.${(path.split(".").pop() ?? "").toLowerCase()}` : "这类文件");

  type Choice = { id: string | null; name: string; hint?: string };
  let choices = $derived.by<Choice[]>(() => {
    const needle = query.trim().toLowerCase();
    const fixed: Choice[] = [
      { id: null, name: "自动推断", hint: detected ? languageName(detected) : "按扩展名，推断不到时为纯文本" },
      { id: PLAIN, name: "纯文本", hint: "不着色" },
    ];
    const all = LANGUAGE_OPTIONS.filter(
      (option) =>
        !needle ||
        option.name.toLowerCase().includes(needle) ||
        option.id.includes(needle) ||
        option.aliases.some((alias) => alias.includes(needle)),
    ).map((option) => ({ id: option.id, name: option.name, hint: option.id }));
    return needle ? [...fixed.filter((choice) => choice.name.includes(needle)), ...all] : [...fixed, ...all];
  });

  $effect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (anchor && !anchor.contains(event.target as Node)) open = false;
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  });

  async function toggle() {
    if (open) {
      open = false;
      return;
    }
    const rect = button?.getBoundingClientRect();
    if (rect && typeof window !== "undefined") {
      const right = Math.max(8, window.innerWidth - rect.right);
      const room = Math.max(200, window.innerHeight - rect.bottom - 16);
      menuStyle = `position:fixed;left:auto;bottom:auto;top:${rect.bottom + 6}px;right:${right}px;max-height:${Math.min(420, room)}px`;
    }
    query = "";
    active = Math.max(0, choices.findIndex((choice) => choice.id === (override ?? null)));
    open = true;
    await tick();
    search?.focus();
    scrollActive();
  }

  function pick(choice: Choice) {
    if (!syntaxPrefs.enabled) setSyntaxEnabled(true);
    setLanguageOverride(path, choice.id);
    open = false;
    button?.focus();
  }

  function scrollActive() {
    void tick().then(() => anchor?.querySelector(".lang-option.active")?.scrollIntoView?.({ block: "nearest" }));
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      open = false;
      button?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = Math.min(choices.length - 1, Math.max(0, active + step));
      scrollActive();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = choices[active];
      if (choice) pick(choice);
    }
  }
</script>

<div class="menu-anchor lang-picker" bind:this={anchor}>
  <button
    type="button"
    class="lang-chip"
    class:off={!syntaxPrefs.enabled || current === null}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={`语法高亮语言：${label}`}
    title={override ? `已为 ${ext} 手动指定语言，点击修改` : "语法高亮语言（按扩展名自动推断），点击修改"}
    bind:this={button}
    onclick={toggle}
  >
    <Icon name="code" size={12} />
    <span class="truncate">{label}</span>
    {#if override}<span class="lang-pin" aria-hidden="true"></span>{/if}
  </button>
  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="menu lang-menu" style={menuStyle} onkeydown={onKey}>
      <div class="lang-search field sm">
        <Icon name="search" size={13} />
        <input
          bind:this={search}
          aria-label="搜索语言"
          placeholder={`为 ${ext} 选择语言…`}
          autocomplete="off"
          spellcheck="false"
          bind:value={query}
          oninput={() => (active = 0)}
        />
      </div>
      {#if !syntaxPrefs.enabled}
        <button type="button" class="lang-enable" onclick={() => { setSyntaxEnabled(true); open = false; }}>
          <Icon name="check-circle" size={13} />打开语法高亮
        </button>
      {/if}
      <div class="lang-list" role="listbox" aria-label="语言">
        {#each choices as choice, index (choice.id ?? "auto")}
          <button
            type="button"
            class="lang-option"
            class:active={index === active}
            role="option"
            aria-selected={(override ?? null) === choice.id}
            onmousemove={() => (active = index)}
            onclick={() => pick(choice)}
          >
            <span class="lang-name">{choice.name}</span>
            {#if choice.hint}<small>{choice.hint}</small>{/if}
            {#if (override ?? null) === choice.id}<Icon name="check" size={13} />{/if}
          </button>
        {:else}
          <p class="lang-empty">没有匹配的语言</p>
        {/each}
      </div>
    </div>
  {/if}
</div>
