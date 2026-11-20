/**
 * 差异显示与比对规则偏好（本机）：
 * - 显示不可见字符（空格、制表符、CRLF/LF、BOM、零宽字符）
 * - 空白与换行符忽略模式（精确 / 忽略 CRLF↔LF / 忽略行尾空白 / 忽略空白数量变化 / 忽略所有空白）
 * - 忽略纯空行增删、忽略大小写差异
 *
 * 与 syntax/prefs 一样只做容错读写：localStorage 不可用或内容坏掉时退回默认值，
 * 之后的修改仍然在当前会话里生效。真实差异、snapshot、hunk.index 和暂存内容都不经过这里，
 * 这些偏好只决定「怎么显示与过滤」。
 */

const STORAGE_KEY = "twiglane.diffPrefs";

export type WhitespaceIgnoreMode = "none" | "eol" | "trailing" | "change" | "all";

const VALID_MODES = new Set<WhitespaceIgnoreMode>(["none", "eol", "trailing", "change", "all"]);

interface Stored {
  /** 把空格、制表符、换行符与不可见字符画成可见标记。 */
  showWhitespace: boolean;
  /** 隐藏只改了空白的改动块（兼容旧开关，与 whitespaceMode === "all" 同步）。 */
  hideWhitespaceOnly: boolean;
  /** 空白与换行符比对规则。 */
  whitespaceMode: WhitespaceIgnoreMode;
  /** 忽略只增删纯空行的改动块。 */
  ignoreBlankLines: boolean;
  /** 忽略仅大小写变化的改动块。 */
  ignoreCase: boolean;
}

const DEFAULTS: Stored = {
  showWhitespace: false,
  hideWhitespaceOnly: false,
  whitespaceMode: "none",
  ignoreBlankLines: false,
  ignoreCase: false,
};

/** 解析本机存下的值：缺字段、类型不对或整段坏掉都退回默认，不让一条脏数据卡住差异视图。 */
export function parseStoredDiffPrefs(raw: string | null | undefined): Stored {
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    const legacyHide = parsed.hideWhitespaceOnly === true;
    const mode: WhitespaceIgnoreMode =
      typeof parsed.whitespaceMode === "string" && VALID_MODES.has(parsed.whitespaceMode as WhitespaceIgnoreMode)
        ? (parsed.whitespaceMode as WhitespaceIgnoreMode)
        : legacyHide
          ? "all"
          : "none";
    return {
      showWhitespace: parsed.showWhitespace === true,
      hideWhitespaceOnly: mode === "all",
      whitespaceMode: mode,
      ignoreBlankLines: parsed.ignoreBlankLines === true,
      ignoreCase: parsed.ignoreCase === true,
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
      JSON.stringify({
        showWhitespace: diffPrefs.showWhitespace,
        hideWhitespaceOnly: diffPrefs.hideWhitespaceOnly,
        whitespaceMode: diffPrefs.whitespaceMode,
        ignoreBlankLines: diffPrefs.ignoreBlankLines,
        ignoreCase: diffPrefs.ignoreCase,
      }),
    );
  } catch {
    // 存储不可用时只在本次会话里生效。
  }
}

export function setShowWhitespace(next: boolean): void {
  diffPrefs.showWhitespace = next;
  save();
}

export function setWhitespaceMode(mode: WhitespaceIgnoreMode): void {
  diffPrefs.whitespaceMode = mode;
  diffPrefs.hideWhitespaceOnly = mode === "all";
  save();
}

export function setHideWhitespaceOnly(next: boolean): void {
  diffPrefs.hideWhitespaceOnly = next;
  diffPrefs.whitespaceMode = next ? "all" : diffPrefs.whitespaceMode === "all" ? "none" : diffPrefs.whitespaceMode;
  save();
}

export function setIgnoreBlankLines(next: boolean): void {
  diffPrefs.ignoreBlankLines = next;
  save();
}

export function setIgnoreCase(next: boolean): void {
  diffPrefs.ignoreCase = next;
  save();
}

export function toggleShowWhitespace(): void {
  setShowWhitespace(!diffPrefs.showWhitespace);
}

export function toggleHideWhitespaceOnly(): void {
  setHideWhitespaceOnly(!diffPrefs.hideWhitespaceOnly);
}

export function toggleIgnoreEol(): void {
  setWhitespaceMode(diffPrefs.whitespaceMode === "eol" ? "none" : "eol");
}

export function toggleIgnoreBlankLines(): void {
  setIgnoreBlankLines(!diffPrefs.ignoreBlankLines);
}

export function toggleIgnoreCase(): void {
  setIgnoreCase(!diffPrefs.ignoreCase);
}

/** 一键清除所有差异过滤规则（保留显示空白字符偏好）。 */
export function clearDiffFilterRules(): void {
  diffPrefs.whitespaceMode = "none";
  diffPrefs.hideWhitespaceOnly = false;
  diffPrefs.ignoreBlankLines = false;
  diffPrefs.ignoreCase = false;
  save();
}

export function hasActiveDiffFilters(prefs: Pick<Stored, "whitespaceMode" | "ignoreBlankLines" | "ignoreCase"> = diffPrefs): boolean {
  return prefs.whitespaceMode !== "none" || prefs.ignoreBlankLines || prefs.ignoreCase;
}

/** 测试用：恢复默认偏好。 */
export function resetDiffPrefs(): void {
  diffPrefs.showWhitespace = DEFAULTS.showWhitespace;
  diffPrefs.hideWhitespaceOnly = DEFAULTS.hideWhitespaceOnly;
  diffPrefs.whitespaceMode = DEFAULTS.whitespaceMode;
  diffPrefs.ignoreBlankLines = DEFAULTS.ignoreBlankLines;
  diffPrefs.ignoreCase = DEFAULTS.ignoreCase;
  save();
}
