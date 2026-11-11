/**
 * 轻量编辑器的纯文本编辑规则：缩进 / 反缩进、回车自动缩进、行注释切换、光标位置。
 * 只算「把 [from, to) 换成 text，并把选区放到 [selStart, selEnd]」，不碰 DOM——
 * 由组件用 execCommand 写回，这样浏览器自带的撤销栈仍然有效。
 */

export interface TextEdit {
  from: number;
  to: number;
  text: string;
  /** 替换后的选区（新文本坐标）。 */
  selStart: number;
  selEnd: number;
}

function lineStartOf(text: string, offset: number): number {
  return offset <= 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEndOf(text: string, offset: number): number {
  const index = text.indexOf("\n", offset);
  return index < 0 ? text.length : index;
}

/** 看前 500 行的缩进习惯：Tab 居多用 Tab，否则取最小的 2 / 3 空格缩进，默认 4 空格。 */
export function detectIndent(text: string): string {
  let tabs = 0;
  let spaced = 0;
  let min = 0;
  let position = 0;
  for (let seen = 0; seen < 500 && position < text.length; seen += 1) {
    const end = lineEndOf(text, position);
    const first = text.charCodeAt(position);
    if (first === 9) tabs += 1;
    else if (first === 32) {
      let cursor = position;
      while (cursor < end && text.charCodeAt(cursor) === 32) cursor += 1;
      if (cursor < end) {
        const width = cursor - position;
        spaced += 1;
        if (width >= 2 && (min === 0 || width < min)) min = width;
      }
    }
    position = end + 1;
  }
  if (tabs > spaced) return "\t";
  return min === 2 || min === 3 ? " ".repeat(min) : "    ";
}

/** 选区覆盖的整行范围；选区末尾恰好停在行首时不算那一行。 */
function blockOf(text: string, start: number, end: number): { first: number; last: number } {
  const first = lineStartOf(text, start);
  const tail = end > start && text[end - 1] === "\n" ? end - 1 : end;
  return { first, last: lineEndOf(text, tail) };
}

function blockEdit(text: string, start: number, end: number, first: number, last: number, lines: string[], deltas: number[]): TextEdit | null {
  const next = lines.join("\n");
  if (next === text.slice(first, last)) return null;
  const total = deltas.reduce((sum, value) => sum + value, 0);
  const selStart = Math.max(first, start + deltas[0]);
  return { from: first, to: last, text: next, selStart, selEnd: Math.max(selStart, end + total) };
}

/** Tab / Shift+Tab。无选区的 Tab 直接插入一个缩进单位；跨行选区整行缩进。 */
export function indentEdit(text: string, start: number, end: number, unit: string, outdent: boolean): TextEdit | null {
  if (!outdent && !text.slice(start, end).includes("\n")) {
    return { from: start, to: end, text: unit, selStart: start + unit.length, selEnd: start + unit.length };
  }
  const { first, last } = blockOf(text, start, end);
  const lines = text.slice(first, last).split("\n");
  const deltas: number[] = [];
  const next = lines.map((line) => {
    if (!outdent) {
      if (line.trim() === "") {
        deltas.push(0);
        return line;
      }
      deltas.push(unit.length);
      return unit + line;
    }
    let remove = 0;
    if (line.startsWith("\t")) remove = 1;
    else {
      const limit = unit === "\t" ? 4 : unit.length;
      while (remove < limit && line[remove] === " ") remove += 1;
    }
    deltas.push(-remove);
    return line.slice(remove);
  });
  return blockEdit(text, start, end, first, last, next, deltas);
}

const CLOSERS: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

/** 回车沿用当前行缩进；停在 { [ ( 后再多缩一级，紧贴配对的右括号时把它挪到下一行。 */
export function newlineEdit(text: string, start: number, end: number, unit: string): TextEdit | null {
  const head = text.slice(lineStartOf(text, start), start);
  const indent = /^[ \t]*/.exec(head)?.[0] ?? "";
  const before = text[start - 1];
  const opener = before !== undefined && before in CLOSERS;
  if (!opener && indent === "") return null;
  if (!opener) {
    const insert = `\n${indent}`;
    return { from: start, to: end, text: insert, selStart: start + insert.length, selEnd: start + insert.length };
  }
  const inner = `\n${indent}${unit}`;
  if (text[end] === CLOSERS[before]) {
    const insert = `${inner}\n${indent}`;
    return { from: start, to: end, text: insert, selStart: start + inner.length, selEnd: start + inner.length };
  }
  return { from: start, to: end, text: inner, selStart: start + inner.length, selEnd: start + inner.length };
}

/** 语言 id（Shiki 命名）→ 行注释前缀；没有行注释的语言返回 null。 */
export function commentPrefix(language: string | null): string | null {
  if (!language) return null;
  if (/^(javascript|typescript|jsx|tsx|jsonc|json5|java|c|cpp|csharp|go|rust|swift|kotlin|scala|dart|php|svelte|groovy|objective-c|zig|glsl|hlsl|proto|solidity)$/.test(language)) return "//";
  if (/^(python|ruby|shellscript|bash|sh|zsh|fish|yaml|toml|dockerfile|makefile|perl|r|powershell|nix|elixir|julia|cmake|gitignore|properties|ini|dotenv)$/.test(language)) return "#";
  if (/^(sql|lua|haskell|plsql)$/.test(language)) return "--";
  if (/^(latex|tex|erlang|matlab)$/.test(language)) return "%";
  return null;
}

/** Ctrl/⌘ + /：选中行全部已注释则取消，否则按最小缩进列统一加上。 */
export function toggleCommentEdit(text: string, start: number, end: number, prefix: string): TextEdit | null {
  const { first, last } = blockOf(text, start, end);
  const lines = text.slice(first, last).split("\n");
  const filled = lines.filter((line) => line.trim() !== "");
  if (filled.length === 0) return null;
  const allCommented = filled.every((line) => line.trimStart().startsWith(prefix));
  const deltas: number[] = [];
  let next: string[];
  if (allCommented) {
    next = lines.map((line) => {
      if (line.trim() === "") {
        deltas.push(0);
        return line;
      }
      const indent = line.length - line.trimStart().length;
      const rest = line.slice(indent + prefix.length);
      const trimmed = rest.startsWith(" ") ? rest.slice(1) : rest;
      deltas.push(trimmed.length - (line.length - indent - prefix.length) - prefix.length);
      return line.slice(0, indent) + trimmed;
    });
  } else {
    const column = Math.min(...filled.map((line) => line.length - line.trimStart().length));
    next = lines.map((line) => {
      if (line.trim() === "") {
        deltas.push(0);
        return line;
      }
      deltas.push(prefix.length + 1);
      return `${line.slice(0, column)}${prefix} ${line.slice(column)}`;
    });
  }
  return blockEdit(text, start, end, first, last, next, deltas);
}

/** 状态栏用：1 起的行 / 列与选中字符数。 */
export function cursorInfo(text: string, start: number, end: number): { line: number; column: number; selected: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = text.indexOf("\n"); index >= 0 && index < start; index = text.indexOf("\n", index + 1)) {
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: start - lineStart + 1, selected: Math.abs(end - start) };
}
