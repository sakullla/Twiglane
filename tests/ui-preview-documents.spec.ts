import { describe, expect, it } from "vitest";
import { mockDocument } from "../scripts/ui-preview/mock-files";

describe("浏览器预览的文档 mock", () => {
  it("document 模式也带齐原生字段：暂存区版本改写正文时读得到 lines", () => {
    const document = mockDocument({ revision: "index", path: "README.md" }, "document", 0, undefined, 1);
    expect(document.kind).toBe("text");
    expect(document.text).toBeTruthy();
    // 曾经缺 lines：预览里从差异打开「阅读文档」读暂存区版本会报 reading 'length'。
    expect(Array.isArray(document.lines)).toBe(true);
    expect(document.version).toBeNull();
  });

  it("source 模式按页返回源码行", () => {
    const document = mockDocument({ revision: "index", path: "README.md" }, "source", 0, 2, 1);
    expect(document.lines).toHaveLength(2);
    expect(document.hasMore).toBe(true);
  });
});
