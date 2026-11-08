export type MarkdownLinkKind = "anchor" | "local" | "remote" | "blocked";

/** 这里只做展示层协议判定；仓库相对路径和版本授权由读取层再次校验。 */
export function markdownLinkKind(href: string): MarkdownLinkKind {
  const value = href.trim();
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return "blocked";
  if (value.startsWith("#")) return "anchor";
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return !url.username && !url.password && url.hostname ? "remote" : "blocked";
    } catch {
      return "blocked";
    }
  }
  if (value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return "blocked";
  return "local";
}

/** 不接受 blob/HTTP/raw SVG；只将原生校验后的图片数据交给 img。 */
export function safeImageDataUrl(value: string | null | undefined): string | null {
  if (!value || !/^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)) return null;
  return value;
}

export function decodeAnchor(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/^#/, ""));
  } catch {
    return null;
  }
}
