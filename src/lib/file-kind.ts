/**
 * 文件类型色调：只按扩展名把图标分成几类，帮助在长目录里扫视。
 * 颜色只落在图标上，不承载 Git 状态语义（状态色在名称与右侧标记上）。
 */
export type FileTone = "code" | "markup" | "data" | "doc" | "media" | "plain";

const TONES: Record<string, FileTone> = {};

function register(tone: FileTone, extensions: string): void {
  for (const extension of extensions.split(" ")) TONES[extension] = tone;
}

register("code", "ts tsx js jsx mjs cjs rs go py rb java kt kts c h cc cpp hpp cs swift php lua dart scala sh bash zsh ps1 sql zig");
register("markup", "html htm svelte vue astro css scss sass less xml svg");
register("data", "json jsonc json5 yaml yml toml ini conf cfg env lock csv tsv");
register("doc", "md mdx markdown txt rst adoc org");
register("media", "png jpg jpeg gif webp avif bmp ico icns tif tiff mp3 wav ogg mp4 mov webm pdf ttf otf woff woff2 zip gz tar 7z");

/** 特殊文件名：没有扩展名也能看出用途。 */
const NAMES: Record<string, FileTone> = {
  dockerfile: "code",
  makefile: "code",
  license: "doc",
  readme: "doc",
  ".gitignore": "data",
  ".gitattributes": "data",
  ".editorconfig": "data",
  ".npmrc": "data",
};

export function fileTone(path: string): FileTone {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (NAMES[name]) return NAMES[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "plain";
  return TONES[name.slice(dot + 1)] ?? "plain";
}

/**
 * 在文本里找出查询词（不区分大小写）的第一处位置，用来在结果里把命中部分加粗。
 * 找不到时只返回整段文本，调用方按普通文本渲染。
 */
export function highlightParts(text: string, query: string): { before: string; match: string; after: string } | null {
  const needle = query.trim();
  if (!needle) return null;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return null;
  return { before: text.slice(0, at), match: text.slice(at, at + needle.length), after: text.slice(at + needle.length) };
}

/** 命中前默认最多保留的字符数：再长就把前段换成省略号，保证窄栏里命中也落在可见范围内。 */
const LEAD = 16;

/**
 * 匹配行的显示片段：去掉行首缩进，命中太靠右时裁掉前段，并拆出命中部分用于加亮。
 * column 是后端给的 1 起始列；它对不上查询词时退回到不区分大小写的查找。
 */
export function matchSnippet(text: string, query: string, column = 0, lead = LEAD): { before: string; match: string; after: string } {
  const needle = query.trim();
  const lower = text.toLowerCase();
  let at = -1;
  if (needle) {
    const fromColumn = column - 1;
    if (fromColumn >= 0 && lower.startsWith(needle.toLowerCase(), fromColumn)) at = fromColumn;
    else at = lower.indexOf(needle.toLowerCase());
  }
  if (at < 0) return { before: text.trim() || " ", match: "", after: "" };
  let before = text.slice(0, at).replace(/^\s+/, "");
  if (before.length > lead) before = `…${before.slice(before.length - lead)}`;
  return { before, match: text.slice(at, at + needle.length), after: text.slice(at + needle.length) };
}
