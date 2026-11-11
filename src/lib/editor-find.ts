/**
 * 编辑器内查找 / 替换的纯逻辑：在草稿文本上找出全部匹配区间，并按 JS 的 $ 替换规则展开替换文本。
 * 只处理当前草稿，不读文件、不跨文件；结果超过上限时截断并如实告知。
 */

export interface FindOptions {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

export interface FindMatch {
  start: number;
  end: number;
  /** 正则捕获组（替换时展开 $1、$<name> 用）；字面查找时为空。 */
  groups: (string | undefined)[];
  named?: Record<string, string | undefined>;
}

export interface FindResult {
  matches: FindMatch[];
  truncated: boolean;
  /** 正则写错时的说明；有值时 matches 为空。 */
  error: string | null;
}

export const MAX_FIND_MATCHES = 10_000;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildPattern(query: string, options: FindOptions): RegExp {
  let source = options.regex ? query : escapeRegex(query);
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  return new RegExp(source, `gmu${options.caseSensitive ? "" : "i"}`);
}

export function findMatches(text: string, query: string, options: FindOptions, limit = MAX_FIND_MATCHES): FindResult {
  if (!query) return { matches: [], truncated: false, error: null };
  let pattern: RegExp;
  try {
    pattern = buildPattern(query, options);
  } catch (failure) {
    return { matches: [], truncated: false, error: failure instanceof Error ? `正则表达式无效：${failure.message}` : "正则表达式无效" };
  }
  const matches: FindMatch[] = [];
  let found: RegExpExecArray | null;
  while ((found = pattern.exec(text)) !== null) {
    const start = found.index;
    const end = start + found[0].length;
    if (end === start) {
      // 空匹配（如 ^、\b）没法选中也没法替换成有意义的结果：跳过，同时推进位置避免死循环。
      pattern.lastIndex = start + 1;
      continue;
    }
    if (matches.length >= limit) return { matches, truncated: true, error: null };
    matches.push({ start, end, groups: options.regex ? found.slice(1) : [], named: options.regex ? found.groups : undefined });
  }
  return { matches, truncated: false, error: null };
}

/** 按 String.prototype.replace 的规则展开 $$ $& $1..$99 $<name>；字面模式原样返回。 */
export function expandReplacement(template: string, match: FindMatch, text: string, regex: boolean): string {
  if (!regex) return template;
  const whole = text.slice(match.start, match.end);
  return template.replace(/\$(\$|&|`|'|<([^>]*)>|(\d{1,2}))/g, (token, kind: string, name: string | undefined, digits: string | undefined) => {
    if (kind === "$") return "$";
    if (kind === "&") return whole;
    if (kind === "`") return text.slice(0, match.start);
    if (kind === "'") return text.slice(match.end);
    if (name !== undefined) return match.named ? (match.named[name] ?? "") : token;
    if (digits !== undefined) {
      const index = Number(digits);
      if (index >= 1 && index <= match.groups.length) return match.groups[index - 1] ?? "";
      // 只有 1 组时 $12 按 $1 加字符 2 处理，与 JS 一致。
      if (digits.length === 2) {
        const first = Number(digits[0]);
        if (first >= 1 && first <= match.groups.length) return (match.groups[first - 1] ?? "") + digits[1];
      }
    }
    return token;
  });
}

/** 把首尾匹配之间这一段整体替换：只改这一段，撤销时也是一步。 */
export function replaceAllEdit(text: string, matches: FindMatch[], template: string, regex: boolean): { from: number; to: number; text: string } | null {
  if (matches.length === 0) return null;
  const from = matches[0].start;
  const to = matches[matches.length - 1].end;
  let out = "";
  let cursor = from;
  for (const match of matches) {
    out += text.slice(cursor, match.start) + expandReplacement(template, match, text, regex);
    cursor = match.end;
  }
  return { from, to, text: out };
}

/** 第一处 start >= offset 的匹配；都在前面时回到第一处。 */
export function matchAtOrAfter(matches: FindMatch[], offset: number): number {
  if (matches.length === 0) return -1;
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (matches[middle].start < offset) low = middle + 1;
    else high = middle;
  }
  return low < matches.length ? low : 0;
}

/** 第一处 end > offset 的匹配下标（渲染某一行的标记时从这里开始找）。 */
export function firstEndingAfter(matches: FindMatch[], offset: number): number {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (matches[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** 「行」或「行:列」，1 起；无效时返回 null。 */
export function parseGoto(value: string): { line: number; column: number } | null {
  const found = /^\s*(\d+)\s*(?:[:：,，]\s*(\d+)\s*)?$/.exec(value);
  if (!found) return null;
  const line = Number(found[1]);
  const column = found[2] ? Number(found[2]) : 1;
  if (line < 1 || column < 1) return null;
  return { line, column };
}
