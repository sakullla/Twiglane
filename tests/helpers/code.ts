/**
 * 按「一行代码的完整内容」查找差异行：语法高亮会把代码拆成多个片段，增删符号由伪元素画出，
 * getByText 的默认匹配（只看元素自身的文本节点）因此找不到整行，这里改看 .code 的 textContent。
 */
export function codeLine(text: string) {
  return (_content: string, element: Element | null): boolean =>
    Boolean(element?.classList?.contains("code")) && element?.textContent === text;
}
