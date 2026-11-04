import type { BranchInfo, ChangeKind, FileChange, FileRow, FileSelection } from "./types";

export function changeLabel(kind: ChangeKind): string | null {
  switch (kind) {
    case "added":
      return "新增";
    case "modified":
      return "修改";
    case "deleted":
      return "删除";
    case "renamed":
      return "重命名";
    case "copied":
      return "复制";
    case "typeChanged":
      return "类型变化";
    case "unmerged":
      return "冲突";
    case "unknown":
      return "未知变化";
    default:
      return null;
  }
}

export function branchLabel(branch: BranchInfo): string {
  if (branch.detached) {
    const short = branch.headOid ? branch.headOid.slice(0, 7) : "";
    return short ? `游离 HEAD ${short}` : "游离 HEAD";
  }
  if (branch.unborn) {
    return branch.name ? `${branch.name}（尚无提交）` : "尚无提交";
  }
  return branch.name ?? "未知分支";
}

export function formatCheckedAt(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function syncLabel(branch: BranchInfo): string {
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  const when = branch.remoteCheckedAtMs ? formatCheckedAt(branch.remoteCheckedAtMs) : "";
  if (!branch.upstream) {
    if (branch.liveRemoteChecked) return when ? `无上游 · 已于 ${when} 检查` : "无上游 · 已检查远程";
    if (branch.remoteCheckStale) return when ? `无上游 · 检查已于 ${when} 过期` : "无上游 · 检查已过期";
    return "无上游 · 未检查远程";
  }
  if (branch.liveRemoteChecked) {
    return when ? `领先 ${ahead} · 落后 ${behind} · 已于 ${when} 检查` : `领先 ${ahead} · 落后 ${behind} · 已检查远程`;
  }
  if (branch.remoteCheckStale) {
    return when
      ? `领先 ${ahead} · 落后 ${behind} · 检查已于 ${when} 过期`
      : `领先 ${ahead} · 落后 ${behind} · 检查已过期`;
  }
  return `相对已记录上游 +${ahead} −${behind} · 未检查远程`;
}

/**
 * 改动分组：冲突 / 未暂存 / 已暂存。
 *
 * 冲突文件只出现在「冲突」组：它的索引里有多份版本，既不能当作已暂存提交，也不能按普通未暂存
 * 文件暂存。以前它同时出现在未暂存与已暂存两组，「已暂存 6」与提交区「3 个文件」对不上——
 * 后者本来就不含冲突文件（见 stagedFiles）。冲突行沿用 unstaged 侧，读取差异与定位都不变。
 */
export function groupFiles(files: FileChange[]): { conflicted: FileRow[]; unstaged: FileRow[]; staged: FileRow[] } {
  const conflicted: FileRow[] = [];
  const unstaged: FileRow[] = [];
  const staged: FileRow[] = [];
  for (const file of files) {
    if (file.unmerged) {
      conflicted.push({ ...file, side: "unstaged" });
      continue;
    }
    if (file.untracked || file.unstaged !== "none") {
      unstaged.push({ ...file, side: "unstaged" });
    }
    if (file.staged !== "none") {
      staged.push({ ...file, side: "staged" });
    }
  }
  return { conflicted, unstaged, staged };
}

export function flattenRows(files: FileChange[]): FileRow[] {
  const groups = groupFiles(files);
  return [...groups.conflicted, ...groups.unstaged, ...groups.staged];
}

export function filterRows<T extends { path: string; originalPath: string | null }>(
  rows: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) =>
      row.path.toLowerCase().includes(needle) ||
      (row.originalPath ?? "").toLowerCase().includes(needle),
  );
}

/** 文件所在目录。仓库根下的文件没有父目录，返回空字符串。 */
export function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** 按父目录分桶。目录名排序，桶内保持调用方给出的顺序。 */
export function bucketByDirectory<T extends { path: string }>(rows: T[]): { directory: string; rows: T[] }[] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const directory = parentDirectory(row.path);
    const existing = groups.get(directory);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(directory, [row]);
      order.push(directory);
    }
  }
  order.sort((left, right) => left.localeCompare(right));
  return order.map((directory) => ({ directory, rows: groups.get(directory) ?? [] }));
}

export function stagedFiles(files: FileChange[]): FileChange[] {
  return files.filter((file) => !file.unmerged && file.staged !== "none");
}

export function commitScope(branch: string, files: FileChange[]): { label: string; paths: string[] } {
  const staged = stagedFiles(files);
  const paths = staged.map((file) =>
    file.originalPath ? `${file.originalPath} → ${file.path}` : file.path,
  );
  if (paths.length === 0) {
    return { label: `提交到 ${branch} · 暂存区是空的`, paths };
  }
  return { label: `提交到 ${branch} · ${paths.length} 个已暂存文件`, paths };
}

export function selectionAfterEdit(
  files: FileChange[],
  selected: { path: string; side: FileRow["side"] } | null,
): { path: string; side: FileRow["side"] } | null {
  if (!selected) return null;
  return (
    retainSelection(files, selected) ??
    retainSelection(files, {
      path: selected.path,
      side: selected.side === "staged" ? "unstaged" : "staged",
    })
  );
}

export function retainSelection(
  files: FileChange[],
  selected: { path: string; side: FileRow["side"] } | null,
): { path: string; side: FileRow["side"] } | null {
  if (!selected) return null;
  return files.some((file) => file.path === selected.path && hasSide(file, selected.side))
    ? selected
    : null;
}

function hasSide(file: FileChange, side: FileRow["side"]): boolean {
  if (file.unmerged) return side === "unstaged";
  return side === "staged" ? file.staged !== "none" : file.untracked || file.unstaged !== "none";
}

/** 一次刷新只索引一次文件，多选校验为 O(文件数 + 选中数)，不逐项重建全量行。 */
export function createSelectionResolver(files: FileChange[], afterEdit: boolean): (item: FileSelection) => FileSelection | null {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return (item) => {
    const file = byPath.get(item.path);
    if (!file) return null;
    if (hasSide(file, item.side)) return item;
    const side = item.side === "staged" ? "unstaged" : "staged";
    return afterEdit && hasSide(file, side) ? { path: item.path, side } : null;
  };
}

export function rowLabel(row: FileRow): string {
  if (row.untracked) return "未跟踪";
  if (row.unmerged) return "冲突";
  const kind = row.side === "staged" ? row.staged : row.unstaged;
  return changeLabel(kind) ?? "变化";
}

export function gitInstallHint(platform: string): string {
  if (platform.includes("Mac") || platform === "macos") {
    return "在 macOS 上可安装 Xcode 命令行工具，或从 git-scm.com 安装 Git。Twiglane 不包含 Git，使用系统 WebKit，不会下载 WebView2。";
  }
  if (platform.includes("Win") || platform === "windows") {
    return "在 Windows 上可从 git-scm.com 安装 Git，并确认安装程序已将其加入 PATH。Twiglane 不包含 Git，也不包含 WebView2。安装器只在缺失时另行下载引导程序和 Evergreen runtime，该下载不计入应用体积；没有 WebView2 时应用无法启动。";
  }
  return "请安装 Git 2.48 或更高版本，并确保应用能找到该可执行文件。Twiglane 不包含 Git。";
}

export function dependencyNote(platform: string): string {
  return [
    gitInstallHint(platform),
    "应用安装包和安装目录的体积不包含 Git，也不包含 WebView2。Windows 首次下载成本单列：引导程序约 1.8 MiB，Evergreen 离线 runtime 约 127 MiB（均来自 Tauri 对安装器增量的说明，不是本机实测下载字节）。",
    "安装显示名是 Twiglane。当前构建使用 ad-hoc 或未配置的测试签名，没有公证，不能当作已签名的公开发布。",
    "首版不包含研发平台业务、游戏资源专用管理或 AI 聊天。",
  ].join("\n");
}
