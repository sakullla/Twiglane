/**
 * 语法高亮偏好（本机）：总开关 + 按扩展名记住的手动语言。
 * 手动语言用于推断不准的场景（.h 当 C++、.inc、无扩展名脚本），一次选定，同类文件处处生效。
 */

import { canonicalLanguage, detectLanguage, extensionKey } from "./languages";

const STORAGE_KEY = "twiglane.syntax";
/** 手动选「纯文本」时记录的值。 */
export const PLAIN = "text";

interface Stored {
  enabled: boolean;
  overrides: Record<string, string>;
}

function load(): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { enabled: true, overrides: {} };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      enabled: parsed.enabled !== false,
      overrides: parsed.overrides && typeof parsed.overrides === "object" ? { ...parsed.overrides } : {},
    };
  } catch {
    return { enabled: true, overrides: {} };
  }
}

export const syntaxPrefs = $state<Stored>(load());

function save() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ enabled: syntaxPrefs.enabled, overrides: syntaxPrefs.overrides }));
  } catch {
    // 存储不可用时只在本次会话里生效。
  }
}

export function setSyntaxEnabled(enabled: boolean): void {
  syntaxPrefs.enabled = enabled;
  save();
}

/** 为某类文件指定语言；传 null 恢复自动推断，传 PLAIN 表示按纯文本显示。 */
export function setLanguageOverride(path: string, lang: string | null): void {
  const key = extensionKey(path);
  const next = { ...syntaxPrefs.overrides };
  if (lang === null) delete next[key];
  else next[key] = lang;
  syntaxPrefs.overrides = next;
  save();
}

export function languageOverride(path: string): string | null {
  return syntaxPrefs.overrides[extensionKey(path)] ?? null;
}

/**
 * 某个路径最终使用的语言：总开关关闭或选了纯文本时为 null。
 * 读取 syntaxPrefs，因此在 $derived 里调用会随偏好变化而更新。
 */
export function effectiveLanguage(path: string | null | undefined): string | null {
  if (!path || !syntaxPrefs.enabled) return null;
  const override = syntaxPrefs.overrides[extensionKey(path)];
  if (override === PLAIN) return null;
  return canonicalLanguage(override) ?? detectLanguage(path);
}

/** 测试用：恢复默认偏好。 */
export function resetSyntaxPrefs(): void {
  syntaxPrefs.enabled = true;
  syntaxPrefs.overrides = {};
  save();
}
