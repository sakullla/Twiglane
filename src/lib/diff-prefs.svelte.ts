/**
 * 差异显示偏好（本机）：显示不可见空白字符、隐藏只改了空白的改动块。
 *
 * 与 syntax/prefs 一样只做容错读写：localStorage 不可用或内容坏掉时退回默认值，
 * 之后的修改仍然在当前会话里生效。真实差异、snapshot、hunk.index 和暂存内容都不经过这里，
 * 这些偏好只决定「怎么显示」。
 */

const STORAGE_KEY = "twiglane.diffPrefs";

interface Stored {
  /** 把空格、制表符画成可见标记。 */
  showWhitespace: boolean;
  /** 隐藏只改了空白的改动块。 */
  hideWhitespaceOnly: boolean;
}

const DEFAULTS: Stored = { showWhitespace: false, hideWhitespaceOnly: false };

/** 解析本机存下的值：缺字段、类型不对或整段坏掉都退回默认，不让一条脏数据卡住差异视图。 */
export function parseStoredDiffPrefs(raw: string | null | undefined): Stored {
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      showWhitespace: parsed.showWhitespace === true,
      hideWhitespaceOnly: parsed.hideWhitespaceOnly === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function load(): Stored {
  try {
    return parseStoredDiffPrefs(globalThis.localStorage?.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULTS };
  }
}

export const diffPrefs = $state<Stored>(load());

function save() {
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ showWhitespace: diffPrefs.showWhitespace, hideWhitespaceOnly: diffPrefs.hideWhitespaceOnly }),
    );
  } catch {
    // 存储不可用时只在本次会话里生效。
  }
}

export function setShowWhitespace(next: boolean): void {
  diffPrefs.showWhitespace = next;
  save();
}

export function setHideWhitespaceOnly(next: boolean): void {
  diffPrefs.hideWhitespaceOnly = next;
  save();
}

export function toggleShowWhitespace(): void {
  setShowWhitespace(!diffPrefs.showWhitespace);
}

export function toggleHideWhitespaceOnly(): void {
  setHideWhitespaceOnly(!diffPrefs.hideWhitespaceOnly);
}

/** 测试用：恢复默认偏好。 */
export function resetDiffPrefs(): void {
  diffPrefs.showWhitespace = DEFAULTS.showWhitespace;
  diffPrefs.hideWhitespaceOnly = DEFAULTS.hideWhitespaceOnly;
  save();
}
