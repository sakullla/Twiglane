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

export interface MarkdownDocument {
  blocks: MarkdownNode[];
  headings: MarkdownHeading[];
}

export type MarkdownParseResult =
  | { ok: true; document: MarkdownDocument }
  | { ok: false; message: string };

export interface MarkdownCallbacks {
  onLink?: (href: string) => void | Promise<void>;
  onLoadImage?: MarkdownImageLoader;
}
