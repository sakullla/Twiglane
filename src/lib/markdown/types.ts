/** 后端无关的阅读契约。文档身份由消费者包含仓库、来源和内容版本。 */
export interface MarkdownPosition {
  scrollTop: number;
  anchor: string | null;
}

export interface MarkdownImageResult {
  dataUrl: string | null;
  message?: string | null;
}

export type MarkdownImageLoader = (href: string, signal: AbortSignal) => Promise<MarkdownImageResult>;

export interface MarkdownHeading {
  id: string;
  text: string;
  depth: number;
  block: number;
}

export type MarkdownNode =
  | { kind: "text" | "raw" | "codespan"; text: string }
  | { kind: "paragraph" | "strong" | "em" | "del" | "blockquote"; children: MarkdownNode[] }
  | { kind: "heading"; depth: number; id: string; children: MarkdownNode[] }
  | { kind: "link"; href: string; title: string | null; children: MarkdownNode[] }
  | { kind: "image"; href: string; title: string | null; text: string }
  | { kind: "code"; text: string; language: string }
  | { kind: "list"; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { kind: "table"; header: MarkdownNode[][]; rows: MarkdownNode[][][]; align: ("left" | "center" | "right" | null)[] }
  | { kind: "br" | "hr" };

export interface MarkdownListItem {
  task: boolean;
  checked: boolean;
  children: MarkdownNode[];
}

/** 文件头 YAML（`---` 包围）：顶层键值按行列出，嵌套或多行的值保留原文。 */
export interface MarkdownFrontmatterField {
  key: string;
  value: string;
  /** 值跨多行（列表、映射、块文本）：按等宽原文显示。 */
  block: boolean;
}

export interface MarkdownFrontmatter {
  fields: MarkdownFrontmatterField[];
  /** 顶层注释行（去掉 `#`），作为说明显示。 */
  comments: string[];
  raw: string;
}

export interface MarkdownDocument {
  blocks: MarkdownNode[];
  headings: MarkdownHeading[];
  frontmatter?: MarkdownFrontmatter | null;
}

export type MarkdownParseResult =
  | { ok: true; document: MarkdownDocument }
  | { ok: false; message: string };

export interface MarkdownCallbacks {
  onLink?: (href: string) => void | Promise<void>;
  onLoadImage?: MarkdownImageLoader;
}
