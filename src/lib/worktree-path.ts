/**
 * 新建附属工作区（git worktree）时的路径拼装与校验。只用于本机仓库：
 * 远端仓库不提供新工作区选项。这里只做界面层的预判，最终仍以后端校验为准。
 */

/** 路径里实际用的分隔符：Windows 路径可能是反斜杠，其余用正斜杠。 */
export function separatorOf(path: string): string {
  return path.lastIndexOf("\\") > path.lastIndexOf("/") ? "\\" : "/";
}

/** 是不是 Windows 风格的路径（盘符或 UNC）：决定「完整路径」的判定和示例。 */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(path) || /^\\\\/.test(path);
}

/** 仓库所在的目录：默认的新工作区就放在仓库旁边。 */
export function repoParentOf(repoPath: string): string {
  const root = repoPath.replace(/[\\/]+$/, "");
  const cut = Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\"));
  if (cut < 0) return root;
  const parent = root.slice(0, cut);
  if (cut === 0) return root.slice(0, 1);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}${separatorOf(root)}` : parent;
}

function repoNameOf(repoPath: string): string {
  const root = repoPath.replace(/[\\/]+$/, "");
  const cut = Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\"));
  return cut >= 0 ? root.slice(cut + 1) : root;
}

/** 新工作区的文件夹名：<仓库名>-<分支名>，分支名里的 / 与非法字符换成 -。 */
export function worktreeFolderName(repoPath: string, branchName: string): string {
  const slug = branchName.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return `${repoNameOf(repoPath)}-${slug || "worktree"}`;
}

/** 在目录下拼一层子目录，沿用目录自己的分隔符；盘符根、/ 根不重复分隔符。 */
export function joinPath(directory: string, name: string): string {
  const sep = separatorOf(directory);
  const base = directory.replace(/[\\/]+$/, "");
  return `${base}${sep}${name}`;
}

/** 把完整路径拆成已存在的父目录与新目录名：后端只在父目录下新建这一层。 */
export function splitWorktreeDir(path: string): { parent: string; directory: string } | null {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0 || cut === trimmed.length - 1) return null;
  const directory = trimmed.slice(cut + 1);
  if (directory === "." || directory === "..") return null;
  // 「/」根和「C:」都要带上分隔符：「C:」本身是该盘的当前目录，不是盘符根。
  const parent = cut === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, cut);
  return { parent: /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent, directory };
}

/**
 * 工作区位置现在为什么还不能用；能用时返回 null。
 * 只挡明显不是完整路径的输入（相对路径、没有文件夹名）；盘符/UNC 或 / 开头都放行，
 * 平台相关的细节交给后端判定。示例按仓库所在平台给。
 */
export function worktreeDirIssue(path: string, repoPath: string): string | null {
  const value = path.trim();
  const windows = isWindowsPath(repoPath);
  const example = windows ? "D:\\work\\app-feature" : "/Users/me/work/app-feature";
  if (!value) return "先填写工作区位置";
  const absolute = isWindowsPath(value) || value.startsWith("/");
  if (!absolute || !splitWorktreeDir(value)) return `需要一个完整路径，例如 ${example}`;
  return null;
}

/** 两个目录是不是同一个：忽略末尾分隔符；Windows 下不分大小写、不分斜杠方向。 */
export function sameDirectory(left: string, right: string): boolean {
  const normalize = (path: string) => {
    const trimmed = path.trim().replace(/[\\/]+$/, "");
    return isWindowsPath(path) ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
  };
  return normalize(left) === normalize(right);
}

const PARENT_KEY = "twiglane.worktreeParents";
const PARENT_LIMIT = 50;

function readParents(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(PARENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/** 这个仓库上次把新工作区放在哪个目录（不是仓库旁边时才记）；没有记录返回 null。 */
export function rememberedWorktreeParent(repoPath: string): string | null {
  return readParents()[repoPath] ?? null;
}

/** 记下这次用的父目录；放回仓库旁边时清掉记录。存储不可用时静默放弃，只是下次不预填。 */
export function rememberWorktreeParent(repoPath: string, parent: string): void {
  try {
    const parents = readParents();
    delete parents[repoPath];
    if (!sameDirectory(parent, repoParentOf(repoPath))) parents[repoPath] = parent;
    const entries = Object.entries(parents).slice(-PARENT_LIMIT);
    globalThis.localStorage?.setItem(PARENT_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 偏好写不进去不影响本次创建。
  }
}
