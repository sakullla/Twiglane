import type { FileRow } from "./types";
import { rowLabel } from "./labels";

/** 由字符串得到稳定的色相，用于仓库徽标和作者头像。 */
/** 控件因为读写在途而不可用时的统一原因，写进 title（R12）。 */
export const BUSY_REASON = "正在读取或写入，稍后再试";

export function hueOf(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** 取名称的首个可见字符作为徽标。 */
export function initialOf(value: string): string {
  const trimmed = value.trim().replace(/^[._\-\s]+/, "");
  const first = [...trimmed][0] ?? "?";
  return first.toUpperCase();
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
