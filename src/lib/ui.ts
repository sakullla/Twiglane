import type { DiffHunk, DiffResponse, FileChange, FileRow, FileSelection } from "./types";
import { filterRows, groupFiles, rowLabel } from "./labels";

/** 控件因为读写在途而不可用时的统一原因，写进 title（R12）。 */
export const BUSY_REASON = "正在读取或写入，稍后再试";

/** 由字符串得到稳定的色相，用于仓库徽标和作者头像。 */
export function hueOf(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** 取名称的首个可见字符。作者头像用它；仓库徽标用 repoBadgeLetters。 */
export function initialOf(value: string): string {
  const trimmed = value.trim().replace(/^[._\-\s]+/, "");
  const first = [...trimmed][0] ?? "?";
  return first.toUpperCase();
}

function repoBadgeChars(name: string): string[] {
  return [...name.trim().replace(/^[._\-\s]+/, "")];
}

/**
 * 同一处可见的仓库名各自的徽标文字。
 * 多个名称时取第一个不完全相同的字符并大写；只有一个名称时取首字符；空名是 ?。
 * 空名不参与比较，避免把别人的首字符当成区分点。
 */
export function repoBadgeLetters(names: readonly string[]): string[] {
  const glyphs = names.map(repoBadgeChars);
  const comparable = glyphs.filter((chars) => chars.length > 0);
  const split = firstDivergentIndex(comparable);
  return names.map((name, index) => {
    const chars = glyphs[index];
    if (chars.length === 0) return "?";
    if (comparable.length < 2 || split < 0) return initialOf(name);
    const glyph = chars[split];
    if (glyph === undefined) return initialOf(name);
    return glyph.toUpperCase();
  });
}

/** 大小写视为相同，这样 Kite-web 与 kite-api 仍能在后缀上分开。 */
function firstDivergentIndex(glyphs: string[][]): number {
  if (glyphs.length < 2) return -1;
  const limit = Math.max(...glyphs.map((chars) => chars.length));
  for (let index = 0; index < limit; index += 1) {
    const sample = glyphs[0][index]?.toUpperCase() ?? "";
    const same = glyphs.every((chars) => (chars[index]?.toUpperCase() ?? "") === sample);
    if (!same) return index;
  }
  return -1;
}

/** 在一组同时可见的名称里取这一个仓库的徽标文字。名称不在组里时按加入该组计算。 */
export function repoBadgeLetter(name: string, names: readonly string[]): string {
  const index = names.indexOf(name);
  if (index >= 0) return repoBadgeLetters(names)[index] ?? "?";
  return repoBadgeLetters([...names, name]).at(-1) ?? "?";
}

/** 把路径拆成目录与文件名，用于“文件名在前、目录弱化”的展示。 */
export function splitPath(path: string): { dir: string; name: string } {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return { dir: "", name: normalized };
  return { dir: normalized.slice(0, slash), name: normalized.slice(slash + 1) };
}

/** 相对时间（秒级时间戳）。超过 30 天显示日期。 */
export function relativeTime(seconds: number, nowMs = Date.now()): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "未知时间";
  const diff = Math.round(nowMs / 1000 - seconds);
  if (diff < 45) return "刚刚";
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} 分钟前`;
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.round(diff / 86400)} 天前`;
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 文件状态的单字母标记与样式。完整文字仍作为可访问名称和提示。 */
export function statusMark(label: string): { letter: string; tone: string } {
  switch (label) {
    case "新增":
      return { letter: "A", tone: "st-add" };
    case "未跟踪":
      return { letter: "U", tone: "st-new" };
    case "修改":
      return { letter: "M", tone: "st-mod" };
    case "删除":
      return { letter: "D", tone: "st-del" };
    case "重命名":
      return { letter: "R", tone: "st-ren" };
    case "复制":
      return { letter: "C", tone: "st-ren" };
    case "类型变化":
      return { letter: "T", tone: "st-mod" };
    case "冲突":
      return { letter: "!", tone: "st-con" };
    default:
      return { letter: "?", tone: "" };
  }
}

export function rowMark(row: FileRow): { letter: string; tone: string; label: string } {
  const label = rowLabel(row);
  return { ...statusMark(label), label };
}

/** 提交说明首行长度提示：超过 72 个字符时提醒。 */
export function summaryLength(message: string): number {
  return [...(message.split("\n")[0] ?? "")].length;
}

/**
 * 提交说明是否可提交：首行（摘要）必须有内容。只写了详细说明、首行为空时，Git 会把正文顶成
 * 摘要，结果与界面上看到的不一致，因此提交区、命令面板与快捷键都按这一条判断。
 */
export function hasCommitSummary(message: string): boolean {
  const newline = message.indexOf("\n");
  const first = newline === -1 ? message : message.slice(0, newline);
  return first.trim().length > 0;
}

/** 列表的展示顺序：冲突、未暂存、已暂存。文件列表、上一个/下一个和多选堆叠都按这一份走（R20）。 */
export function orderedRows(files: FileChange[], query = ""): FileRow[] {
  const groups = groupFiles(files);
  return [
    ...filterRows(groups.conflicted, query),
    ...filterRows(groups.unstaged, query),
    ...filterRows(groups.staged, query),
  ];
}

/** 同一路径可以同时出现在未暂存和已暂存里，选中身份必须是 path+side。 */
export function selectionKey(item: FileSelection): string {
  return `${item.side}:${item.path}`;
}

export function sameSelection(left: FileSelection | null, right: FileSelection | null): boolean {
  return Boolean(left && right && left.path === right.path && left.side === right.side);
}

/** ⌘/Ctrl+点击：已选的移除，未选的加入。 */
export function toggleSelection(base: FileSelection[], item: FileSelection): FileSelection[] {
  return base.some((entry) => sameSelection(entry, item))
    ? base.filter((entry) => !sameSelection(entry, item))
    : [...base, item];
}

/** Shift+点击：锚点到目标之间的连续范围，方向不限；锚点不在列表里时从目标自身算起。 */
export function rangeSelection(rows: FileSelection[], anchor: FileSelection | null, target: FileSelection): FileSelection[] {
  const end = rows.findIndex((row) => sameSelection(row, target));
  if (end < 0) return [];
  const found = rows.findIndex((row) => sameSelection(row, anchor));
  const start = found < 0 ? end : found;
  return rows.slice(Math.min(start, end), Math.max(start, end) + 1).map(({ path, side }) => ({ path, side }));
}

/** 把选中集合排回列表顺序；已经不在列表里的条目随之消失。 */
export function rowsInSelection(rows: FileRow[], set: FileSelection[]): FileRow[] {
  const keys = new Set(set.map(selectionKey));
  return rows.filter((row) => keys.has(selectionKey(row)));
}

/** 批量动作的精确目标：冲突文件一律排除，同一路径两侧都选中时放弃只算一次。 */
export function batchTargets(rows: FileRow[]): { stage: string[]; unstage: string[]; discard: string[]; conflicts: number } {
  const free = rows.filter((row) => !row.unmerged);
  return {
    stage: free.filter((row) => row.side === "unstaged").map((row) => row.path),
    unstage: free.filter((row) => row.side === "staged").map((row) => row.path),
    discard: [...new Set(free.map((row) => row.path))],
    conflicts: new Set(rows.filter((row) => row.unmerged).map((row) => row.path)).size,
  };
}

/** 批量写入的结论：写清哪些成功保留、哪个文件为什么失败、哪些没有处理。 */
export function batchSummary(
  verb: string,
  done: number,
  failed: { path: string; message: string }[],
  skipped: number,
): string {
  const parts = [done > 0 ? `已${verb} ${done} 个文件，成功的改动已保留` : `没有文件被${verb}`];
  // 后端原因常以句号结尾，拼进来会出现「。；」「。。」。
  const shown = failed.slice(0, 3).map((item) => `${item.path}：${item.message.replace(/[。.\s]+$/u, "")}`);
  if (failed.length > 3) shown.push(`另有 ${failed.length - 3} 个文件失败`);
  if (shown.length > 0) parts.push(`失败 ${shown.join("；")}`);
  if (skipped > 0) parts.push(`${skipped} 个文件未处理`);
  return `${parts.join("。")}。`;
}

/** 上一个/下一个文件：工具栏按钮与 file.prev、file.next 命令共用的状态。 */
export interface FileNavState {
  index: number;
  total: number;
  /** 不可用的原因；可用时为 null。 */
  prevReason: string | null;
  nextReason: string | null;
  onPrev: () => void;
  onNext: () => void;
}

export function fileNavState<T>(items: T[], index: number, go: (item: T) => void, noun = "文件"): FileNavState {
  const prev = index > 0 ? items[index - 1] : undefined;
  const next = index < 0 ? items[0] : items[index + 1];
  const empty = items.length === 0 ? `没有可切换的${noun}` : null;
  return {
    index,
    total: items.length,
    prevReason: empty ?? (index < 0 ? `当前${noun}不在列表里` : index === 0 ? `已经是第一个${noun}` : null),
    nextReason: empty ?? (index >= items.length - 1 ? `已经是最后一个${noun}` : null),
    onPrev: () => {
      if (prev !== undefined) go(prev);
    },
    onNext: () => {
      if (next !== undefined) go(next);
    },
  };
}

/** 每块的累计顶部位置；最后一项是总高度加一个间距，渲染窗口的前后占位都由它算。 */
export function blockTops(heights: number[], gap: number): number[] {
  const tops = [0];
  for (const height of heights) tops.push(tops[tops.length - 1] + height + gap);
  return tops;
}

/** 与视口（含上下余量）相交的块。视口尚未测出时只放少量块，选 100 个文件也不会全部挂载。 */
export function blockWindow(
  tops: number[],
  scrollTop: number,
  viewport: number,
  overscan: number,
  fallback = 6,
): { start: number; end: number; before: number; after: number } {
  const count = tops.length - 1;
  let start = 0;
  let end = Math.min(count, fallback);
  if (viewport > 0) {
    const low = scrollTop - overscan;
    const high = scrollTop + viewport + overscan;
    while (start < count - 1 && tops[start + 1] <= low) start += 1;
    end = start;
    while (end < count && tops[end] < high) end += 1;
    end = Math.max(end, Math.min(count, start + 1));
  }
  return { start, end, before: tops[start] ?? 0, after: count > 0 ? tops[count] - tops[end] : 0 };
}

/** 续读的一页拼到已读内容后面：块标题下标按已读行数平移。 */
export function appendDiffPage(current: DiffResponse, page: DiffResponse): DiffResponse {
  const base = current.lines.length;
  const hunks = new Map<number, DiffHunk>(current.hunks.map((hunk) => [hunk.index, hunk]));
  for (const hunk of page.hunks) {
    if (!hunks.has(hunk.index)) hunks.set(hunk.index, { ...hunk, startLine: hunk.startLine + base });
  }
  return { ...page, offset: current.offset, lines: [...current.lines, ...page.lines], hunks: [...hunks.values()], totalLines: page.totalLines };
}
