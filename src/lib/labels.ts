import type { BranchInfo, ChangeKind, FileChange, FileRow } from "./types";

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

export function syncLabel(branch: BranchInfo): string {
  if (branch.liveRemoteChecked) {
    return "远程已检查";
  }
  if (!branch.upstream) return "无上游 · 未检查远程";
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  return `相对已记录上游 +${ahead} −${behind} · 未检查远程`;
}

export function groupFiles(files: FileChange[]): { unstaged: FileRow[]; staged: FileRow[] } {
  const unstaged: FileRow[] = [];
  const staged: FileRow[] = [];
  for (const file of files) {
    if (file.untracked || file.unmerged || file.unstaged !== "none") {
      unstaged.push({ ...file, side: "unstaged" });
    }
    if (file.unmerged || file.staged !== "none") {
      staged.push({ ...file, side: "staged" });
    }
  }
  return { unstaged, staged };
}

export function flattenRows(files: FileChange[]): FileRow[] {
  const groups = groupFiles(files);
  return [...groups.unstaged, ...groups.staged];
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
  return flattenRows(files).some((row) => row.path === selected.path && row.side === selected.side)
    ? selected
    : null;
}

export function rowLabel(row: FileRow): string {
  if (row.untracked) return "未跟踪";
  if (row.unmerged) return "冲突";
  const kind = row.side === "staged" ? row.staged : row.unstaged;
  return changeLabel(kind) ?? "变化";
}

export function gitInstallHint(platform: string): string {
  if (platform.includes("Mac") || platform === "macos") {
    return "在 macOS 上可安装 Xcode 命令行工具，或从 git-scm.com 安装 Git。";
  }
  if (platform.includes("Win") || platform === "windows") {
    return "在 Windows 上可从 git-scm.com 安装 Git，并确认安装程序已将其加入 PATH。";
  }
  return "请安装 Git 2.48 或更高版本，并确保应用能找到该可执行文件。";
}
