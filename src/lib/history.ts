export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

export function formatAuthoredAt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "未知时间";
  return new Date(seconds * 1000).toLocaleString();
}

export function historyStatus(state: string): string | null {
  if (state === "empty_repository") return "这个仓库还没有任何提交。";
  if (state === "no_match") {
    return "没有匹配记录。搜索会查找全部历史中的说明、作者和提交标识，不是只过滤当前页。";
  }
  if (state === "no_file_history") return "这个文件没有可用历史。";
  return null;
}

export function parentCaption(parents: string[], root = false): string {
  if (root || parents.length === 0) return "首个提交，没有父提交，差异相对空树。";
  if (parents.length === 1) return `父提交 ${shortOid(parents[0])}`;
  return `合并提交，父提交 ${parents.map((oid) => shortOid(oid)).join("、")}`;
}

export function refLabel(kind: string, name: string, current: boolean): string {
  const prefix = kind === "remote" ? "远程" : kind === "tag" ? "标签" : kind === "head" ? "HEAD" : "分支";
  return current ? `${prefix} ${name} · 当前` : `${prefix} ${name}`;
}

export function commitFileLabel(status: string): string {
  switch (status) {
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
    default:
      return "变化";
  }
}

export function mergeAbortAvailable(canAbortMerge: boolean): boolean {
  return canAbortMerge;
}

export const HISTORY_SEARCH_DEBOUNCE_MS = 300;

export function preferredCommitFile<T extends { path: string; originalPath: string | null }>(
  files: T[],
  requested: string | null,
): T | null {
  if (requested) {
    const match = files.find((file) => file.path === requested || file.originalPath === requested);
    if (match) return match;
  }
  return files[0] ?? null;
}

export function stashPathBadge(kind: "tracked" | "untracked" | "ignored", includeUntracked: boolean): string {
  if (kind === "tracked") return "将保存";
  if (kind === "ignored") return "忽略不保存";
  return includeUntracked ? "会一并保存" : "不保存";
}

export interface RefPill {
  kind: "branch" | "remote" | "tag" | "head";
  name: string;
  current: boolean;
  /** 同名远程分支指向同一提交时合并成一枚胶囊，这里记远程名（例如 origin）。 */
  remote: string | null;
  /** 完整说明，作为可访问名称与悬停提示。 */
  label: string;
}

const PILL_ORDER: Record<RefPill["kind"], number> = { head: 0, branch: 1, tag: 2, remote: 3 };

/** 把提交上的引用整理成胶囊：本地分支与指向同一提交的同名远程分支合成一枚，当前分支排最前。 */
export function refPills(labels: { name: string; kind: string; current: boolean }[]): RefPill[] {
  const remotes = labels.filter((label) => label.kind === "remote");
  const absorbed = new Set<string>();
  const pills: RefPill[] = [];
  for (const label of labels) {
    if (label.kind !== "branch") continue;
    const twin = remotes.find((remote) => remote.name.slice(remote.name.indexOf("/") + 1) === label.name);
    if (twin) absorbed.add(twin.name);
    const remote = twin ? twin.name.slice(0, twin.name.indexOf("/")) : null;
    const base = refLabel("branch", label.name, label.current);
    pills.push({
      kind: "branch",
      name: label.name,
      current: label.current,
      remote,
      label: remote ? `${base}，与远程 ${twin?.name} 一致` : base,
    });
  }
  for (const label of labels) {
    if (label.kind === "branch" || absorbed.has(label.name)) continue;
    if (label.kind === "remote" && label.name.endsWith("/HEAD")) continue;
    const kind = label.kind === "remote" || label.kind === "tag" || label.kind === "head" ? label.kind : "branch";
    pills.push({ kind, name: label.name, current: label.current, remote: null, label: refLabel(label.kind, label.name, label.current) });
  }
  return pills.sort((left, right) => Number(right.current) - Number(left.current) || PILL_ORDER[left.kind] - PILL_ORDER[right.kind]);
}

/** 提交说明里除去标题行之后的正文（%B 含标题，详情区已单独显示标题）。 */
export function commitBodyRest(body: string, summary: string): string {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const [first, ...rest] = text.split("\n");
  if (first.trim() !== summary.trim()) return text;
  return rest.join("\n").trim();
}
