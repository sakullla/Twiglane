/** 正文分页窗口：限制保留的行与估算内存；旧行仍可通过跳行或「回到开头」重新读取。 */
export const FILE_WINDOW_LINES = 10_000;
export const FILE_WINDOW_BYTES = 4 * 1024 * 1024;

export function appendFileWindow(current: string[], page: string[]): { lines: string[]; dropped: number } {
  let bytes = 0;
  let count = 0;
  const total = current.length + page.length;
  // 从尾部计数，避免先复制不断增长的整份正文；至少保留最新一行。
  while (count < total && count < FILE_WINDOW_LINES) {
    const index = total - count - 1;
    const line = index < current.length ? current[index] : page[index - current.length];
    const size = line.length * 2 + 32;
    if (count > 0 && bytes + size > FILE_WINDOW_BYTES) break;
    bytes += size;
    count += 1;
  }
  const dropped = total - count;
  return {
    lines: dropped >= current.length ? page.slice(dropped - current.length) : [...current.slice(dropped), ...page],
    dropped,
  };
}
