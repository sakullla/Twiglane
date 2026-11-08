/**
 * 文件视图的当前会话状态：目录缓存、展开节点、选择、过滤与读取代次。
 *
 * 目录一次只读直接子项（后端 repository_directory 的契约），未展开的后代不读取。
 * 所有请求都带仓库路径与 serial：切换仓库、隐藏视图或代次变化后，
 * 迟到的响应既不会写进当前树，也不会被当作当前内容。
 *
 * 这里的逻辑是可单独测试的纯函数 + 一份 rune 状态；组件只负责渲染与事件。
 */
import { api } from "./api";
import { normalizeError } from "./errors";
import { changeLabel } from "./labels";
import { statusMark } from "./ui";
import type {
  FileChange,
  RepositoryContentMatch,
  RepositoryContentSearch,
  RepositoryDirectory,
  RepositoryDirectoryEntry,
  RepositoryEntryKind,
  RepositoryPathEntry,
  RepositoryPathSearch,
  RepositorySearchScope,
} from "./types";

/** 目录行高（像素）：与 components.css 的 .file-tree-row 一致，虚拟化按它算窗口。 */
export const FILE_ROW_HEIGHT = 26;
/** 搜索结果行高（像素）：路径结果与全文结果的每一行都固定这么高，虚拟化按它算窗口。 */
export const SEARCH_ROW_HEIGHT = 26;
/** 一次路径 / 全文搜索的请求上限：后端另有自己的上限，这里只是给界面的显示边界。 */
export const SEARCH_LIMIT = 200;
/** 单链合并的上限：再多就不是「一个目录」而是层级本身，逐级展开更好读。 */
export const MAX_CHAIN = 12;
/** 树过滤里全仓库补齐行的显示上限：再多也没法在树里读，界面必须说明只列了前这些。 */
export const FILTER_EXTRA_LIMIT = 60;

export interface FileNode {
  path: string;
  name: string;
  kind: RepositoryEntryKind;
  ignored: boolean;
  size: number | null;
  version?: string | null;
  error: string | null;
  /** 直接子项；null 表示还没读过（按需读取），[] 表示读过且为空。 */
  children: FileNode[] | null;
  expanded: boolean;
  loading: boolean;
  /** 目录读取失败的说明：就地显示，其他兄弟目录不受影响。 */
  failure: string | null;
  /** 用户要求把单链目录拆成逐级显示。 */
  split: boolean;
  /** 仅改动树里的删除墓碑：工作区没有这个文件，不能当当前文件读取。 */
  deleted?: boolean;
}

export interface FileTreeRow {
  /** 行对应的真实节点（合并行是合并链的最后一级）。 */
  node: FileNode;
  /** 行的真实仓库相对路径。 */
  path: string;
  /** 合并链的显示标签，例如 src/lib/components。 */
  label: string;
  depth: number;
  kind: RepositoryEntryKind;
  ignored: boolean;
  size: number | null;
  error: string | null;
  expanded: boolean;
  expandable: boolean;
  loading: boolean;
  failure: string | null;
  /** 读过但没有任何子项。 */
  empty: boolean;
  /** 这一行合并了几级目录（1 表示没有合并）。 */
  chain: number;
  /** 合并行可以拆回逐级目录。 */
  splittable: boolean;
  /** 链中间层：只占位显示层级，不能再展开或打开。 */
  segment: boolean;
  /** 仅改动树里的删除墓碑：只提供改动与历史，不读取当前文件。 */
  deleted?: boolean;
  /** 树过滤补齐的未展开匹配：不在当前已加载树里，点开时先展开必要的祖先。 */
  extra?: boolean;
}

export function makeNode(entry: RepositoryDirectoryEntry): FileNode {
  return {
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    ignored: entry.ignored,
    size: entry.size,
    version: entry.version,
    error: entry.error,
    // 子项按需读取：任何类型在读到目录内容之前都是 null。
    children: null,
    expanded: false,
    loading: false,
    failure: null,
    split: false,
  };
}

/**
 * 可以按需展开的节点：只有普通目录。
 * 嵌套仓库、子模块、符号链接、特殊文件与错误项都只显示类型，不递归读取。
 */
export function isDirectoryKind(kind: RepositoryEntryKind): boolean {
  return kind === "directory";
}

/**
 * 单链合并：从 node 起，只要唯一子项还是目录，就把显示标签连起来。
 * 只沿已经读到的层级合并，未读的下一级仍保持按需读取。
 */
export function chainOf(node: FileNode): FileNode[] {
  const chain = [node];
  let current = node;
  while (
    chain.length < MAX_CHAIN &&
    current.children !== null &&
    current.children.length === 1 &&
    current.children[0].kind === "directory"
  ) {
    current = current.children[0];
    chain.push(current);
  }
  return chain;
}

function rowOf(node: FileNode, depth: number, chain: FileNode[], segment = false, splittable = false): FileTreeRow {
  const last = chain[chain.length - 1];
  return {
    node: last,
    path: last.path,
    label: chain.map((item) => item.name).join("/"),
    depth,
    kind: last.kind,
    ignored: last.ignored,
    size: last.size,
    error: last.error,
    expanded: last.expanded,
    expandable: !segment && isDirectoryKind(last.kind),
    loading: last.loading,
    failure: last.failure,
    empty: last.children !== null && last.children.length === 0 && last.failure === null,
    chain: chain.length,
    splittable,
    segment,
    deleted: Boolean(last.deleted),
  };
}

function flattenInto(list: FileNode[], depth: number, out: FileTreeRow[]): void {
  for (const node of list) {
    if (node.kind === "directory" && node.split && node.children !== null && node.children.length === 1 && node.children[0].kind === "directory") {
      // 拆回逐级显示：链上每一级各占一行，只有最后一级带子项与展开状态。
      const chain = chainOf(node);
      for (let index = 0; index < chain.length - 1; index += 1) {
        const segment = chain[index];
        out.push({
          node: segment,
          path: segment.path,
          label: segment.name,
          depth: depth + index,
          kind: segment.kind,
          ignored: segment.ignored,
          size: segment.size,
          error: segment.error,
          expanded: true,
          expandable: false,
          loading: segment.loading,
          failure: segment.failure,
          empty: false,
          chain: 1,
          splittable: false,
          segment: true,
          deleted: Boolean(segment.deleted),
        });
      }
      const last = chain[chain.length - 1];
      out.push(rowOf(last, depth + chain.length - 1, [last], false, chain.length > 1));
      if (isDirectoryKind(last.kind) && last.expanded && last.children) {
        flattenInto(last.children, depth + chain.length, out);
      }
      continue;
    }
    const chain = node.kind === "directory" ? chainOf(node) : [node];
    const last = chain[chain.length - 1];
    out.push(rowOf(last, depth, chain, false, chain.length > 1));
    // 只有普通目录会带出后代：嵌套仓库与符号链接即使带着子项也不递归显示。
    if (isDirectoryKind(last.kind) && last.expanded && last.children) {
      flattenInto(last.children, depth + 1, out);
    }
  }
}

/** 把树摊平成固定行高的行列表：目录行的展开状态决定后代是否出现。 */
export function flattenTree(nodes: readonly FileNode[]): FileTreeRow[] {
  const out: FileTreeRow[] = [];
  flattenInto(nodes as FileNode[], 0, out);
  return out;
}

/**
 * 已加载范围的过滤：匹配到的文件保留，目录只在含匹配后代时保留。
 * 这是本地过滤，不补齐未展开的路径（那是后续任务的全仓搜索）。
 */
export function filterRows(rows: readonly FileTreeRow[], query: string): FileTreeRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows as FileTreeRow[];
  const keep = new Set<number>();
  const ancestors = new Set<string>();
  rows.forEach((row, index) => {
    const hit = row.path.toLowerCase().includes(needle) || row.label.toLowerCase().includes(needle);
    if (!hit) return;
    keep.add(index);
    let slash = row.path.lastIndexOf("/");
    while (slash >= 0) {
      const parent = row.path.slice(0, slash);
      if (ancestors.has(parent)) break;
      ancestors.add(parent);
      slash = parent.lastIndexOf("/");
    }
  });
  // 匹配项的一切祖先目录都要留下，否则命中的文件挂在看不见的目录下面。
  rows.forEach((row, index) => {
    if (keep.has(index) || !isDirectoryKind(row.kind)) return;
    if (ancestors.has(row.path)) keep.add(index);
  });
  return rows.filter((_row, index) => keep.has(index));
}

/**
 * 仅看改动时的树：直接由 StatusSnapshot 的路径派生，不读目录。
 * 祖先目录由路径合成；删除的文件保留为墓碑行，只提供改动与历史。
 *
 * forceExpanded 用于「过滤命中」与「定位目标」：这两种情况下分支必须看得见，
 * 折叠状态仍然原样留在 collapsed 里，清掉过滤后照旧折叠。
 */
export function buildChangedTree(
  files: readonly FileChange[],
  collapsed?: ReadonlySet<string>,
  forceExpanded = false,
): FileNode[] {
  const roots: FileNode[] = [];
  const dirs = new Map<string, FileNode>();
  for (const file of files) {
    const parts = file.path.split("/");
    let list = roots;
    let prefix = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
      let dir = dirs.get(prefix);
      if (!dir) {
        dir = makeNode({ name: parts[index], path: prefix, kind: "directory", ignored: false, size: null, error: null });
        // 仅改动树的节点每次都由快照重建：折叠状态只能靠路径集合记住，否则折叠后立刻弹回展开。
        dir.expanded = forceExpanded || !collapsed?.has(prefix);
        dir.children = [];
        dirs.set(prefix, dir);
        list.push(dir);
      }
      list = dir.children as FileNode[];
    }
    const node = makeNode({
      name: parts[parts.length - 1],
      path: file.path,
      kind: "file",
      ignored: false,
      size: null,
      error: null,
    });
    node.deleted = isDeletedChange(file);
    list.push(node);
  }
  sortNodes(roots);
  return roots;
}

/** 目录优先、再按名称排序：改动树是从路径合成的，顺序不能靠快照的偶然次序。 */
function sortNodes(list: FileNode[]): void {
  list.sort((left, right) =>
    isDirectoryKind(left.kind) === isDirectoryKind(right.kind)
      ? left.name.localeCompare(right.name)
      : isDirectoryKind(left.kind)
        ? -1
        : 1,
  );
  for (const node of list) if (node.children) sortNodes(node.children);
}

/**
 * 仅改动模式的过滤：在全部改动路径上匹配，不局限于当前展开出来的可见行。
 * 祖先目录的路径是改动路径的前缀，所以命中目录就等于命中它下面的改动文件。
 */
export function changedFilesMatching(files: readonly FileChange[], query: string): FileChange[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files as FileChange[];
  return files.filter((file) => file.path.toLowerCase().includes(needle));
}

/** 文件树装饰用的单字母标记：与改动列表共用同一套 statusMark 色阶，不新增颜色语义。 */
export interface ChangeMark {
  letter: string;
  tone: string;
  label: string;
}

/** 文件与祖先目录的 Git 装饰：files 按路径给出这一行自己的状态，dirs 是其后代改动的聚合。 */
export interface ChangeDecorations {
  files: Record<string, ChangeMark>;
  dirs: Record<string, ChangeMark & { count: number }>;
}

/** 聚合时的显示优先级：冲突最需要看见，其次是消失的文件，再到普通改动。 */
const MARK_RANK: Record<string, number> = {
  冲突: 0,
  删除: 1,
  修改: 2,
  类型变化: 3,
  重命名: 4,
  复制: 5,
  新增: 6,
  未跟踪: 7,
};

function rankOf(label: string): number {
  return MARK_RANK[label] ?? 99;
}

function markOf(label: string): ChangeMark {
  const mark = statusMark(label);
  return { letter: mark.letter, tone: mark.tone, label };
}

/**
 * 一个改动文件的装饰：与改动列表同一套状态文字与颜色。
 * 两侧都有改动时先看未暂存一侧（工作区此刻的样子），再看已暂存一侧。
 */
export function changeMarkOf(file: FileChange): ChangeMark {
  if (file.unmerged) return markOf("冲突");
  if (file.untracked) return markOf("未跟踪");
  const side = file.unstaged !== "none" ? file.unstaged : file.staged;
  return markOf(changeLabel(side) ?? "变化");
}

/**
 * 当前 StatusSnapshot 的文件与祖先目录装饰。
 * 只根据快照算，不读目录、不改变任何暂存或提交范围；仅改动的树和完整树共用同一份结果。
 */
export function changeDecorations(files: readonly FileChange[]): ChangeDecorations {
  const out: ChangeDecorations = { files: {}, dirs: {} };
  for (const file of files) {
    if (!file.path) continue;
    const mark = changeMarkOf(file);
    const existing = out.files[file.path];
    if (!existing || rankOf(mark.label) < rankOf(existing.label)) out.files[file.path] = mark;
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join("/");
      const current = out.dirs[directory];
      if (!current) {
        out.dirs[directory] = { ...mark, count: 1 };
        continue;
      }
      const keep = rankOf(mark.label) < rankOf(current.label) ? mark : current;
      out.dirs[directory] = { letter: keep.letter, tone: keep.tone, label: keep.label, count: current.count + 1 };
    }
  }
  return out;
}

/** 工作区里已经没有这个文件：未暂存删除，或只剩已暂存删除而工作区无内容。 */
export function isDeletedChange(file: FileChange): boolean {
  return file.unstaged === "deleted" || (file.staged === "deleted" && file.unstaged === "none");
}

/** 全文结果按文件分组：界面按文件分块显示，不把一条扁平的匹配列表丢给使用者。 */
export interface ContentGroup {
  path: string;
  matches: RepositoryContentMatch[];
}

export function groupContentMatches(matches: readonly RepositoryContentMatch[]): ContentGroup[] {
  const groups: ContentGroup[] = [];
  const byPath = new Map<string, ContentGroup>();
  for (const match of matches) {
    let group = byPath.get(match.path);
    if (!group) {
      group = { path: match.path, matches: [] };
      byPath.set(match.path, group);
      groups.push(group);
    }
    group.matches.push(match);
  }
  return groups;
}

/** 搜索结果虚拟化用的固定行高行：分组标题与匹配行同高，方向键只在可选中的行之间移动。 */
export type SearchRow =
  | { kind: "group"; path: string; count: number }
  | { kind: "match"; path: string; line: number; column: number; text: string };

export function contentSearchRows(result: RepositoryContentSearch | null): SearchRow[] {
  if (!result) return [];
  const rows: SearchRow[] = [];
  for (const group of groupContentMatches(result.matches)) {
    rows.push({ kind: "group", path: group.path, count: group.matches.length });
    for (const match of group.matches) {
      rows.push({ kind: "match", path: match.path, line: match.line, column: match.column, text: match.text });
    }
  }
  return rows;
}

/** 路径结果的展示行：文件与派生目录各自带类型，不把目录伪装成可打开的文件。 */
export interface PathRow {
  kind: "file" | "directory";
  path: string;
  ignored: boolean;
}

export function pathSearchRows(result: RepositoryPathSearch | null): PathRow[] {
  if (!result) return [];
  return result.entries.map((entry: RepositoryPathEntry) => ({
    kind: entry.kind,
    path: entry.path,
    ignored: entry.ignored,
  }));
}

/** 树过滤补齐出来的一行：不在当前树里，点开时先展开必要的祖先。 */
export function extraRow(entry: RepositoryPathEntry): FileTreeRow {
  const name = entry.path.split("/").pop() ?? entry.path;
  return {
    node: makeNode({ name, path: entry.path, kind: entry.kind, ignored: entry.ignored, size: null, error: null }),
    path: entry.path,
    label: entry.path,
    depth: 0,
    kind: entry.kind,
    ignored: entry.ignored,
    size: null,
    error: null,
    expanded: false,
    expandable: entry.kind === "directory",
    loading: false,
    failure: null,
    empty: false,
    chain: 1,
    splittable: false,
    segment: false,
    extra: true,
  };
}

/** 树过滤之外的行内定位：返回 row 在可见行里的下标，用于滚动到目标。 */
export function rowIndex(rows: readonly FileTreeRow[], path: string): number {
  return rows.findIndex((row) => row.path === path);
}

export interface FilesStoreDeps {
  repo: () => string | null;
  generation: () => number;
  active: () => boolean;
  nextId: () => number;
  onGeneration: (generation: number) => void;
  /** 当前 StatusSnapshot 的改动路径：仅改动树与 changed-only 搜索都以它为准。 */
  files?: () => readonly FileChange[];
}

/** 当前会话的文件树状态。一个仓库一份，由文件视图组件持有。 */
export function createFilesStore(deps: FilesStoreDeps) {
  let repo = $state<string | null>(null);
  let nodes = $state<FileNode[]>([]);
  let selectedPath = $state<string | null>(null);
  let query = $state("");
  let includeIgnored = $state(false);
  let loading = $state(false);
  let failure = $state<string | null>(null);
  let loaded = $state(false);
  /** 文件内容的强制重读凭据：仅手动刷新递增。 */
  let revision = $state(0);
  /** 最近一次按它验证过整棵树的代次；与当前代次不同就说明树可能已经过期。 */
  let verifiedGeneration = deps.generation();
  /**
   * 非 null 表示视图正隐藏，值是隐藏那一刻的代次。
   * 隐藏期间的代次变化只记在仓库状态里，绝不在这里「追上」——否则激活时永远看不出差异。
   */
  let hiddenAt: number | null = null;

  const serials = new Map<string, number>();
  let directorySerial = 0;
  let refreshSerial = 0;

  /* ---- 搜索：路径快速打开、全文搜索与树过滤补齐各有一份请求身份 ---- */
  let pathQuery = $state("");
  let pathResult = $state<RepositoryPathSearch | null>(null);
  let pathError = $state<string | null>(null);
  let pathBusy = $state(false);
  let contentQuery = $state("");
  let contentResult = $state<RepositoryContentSearch | null>(null);
  let contentError = $state<string | null>(null);
  let contentBusy = $state(false);
  let scopeKind = $state<RepositorySearchScope["kind"]>("repository");
  /** 搜索是否包含被忽略的文件：只影响本次请求，不写 .gitignore。 */
  let searchIgnored = $state(false);
  /** 树过滤的全局补齐：已加载节点在本地过滤，未展开的匹配靠路径搜索补上。 */
  let filterEntries = $state<RepositoryPathEntry[]>([]);
  let filterError = $state<string | null>(null);
  /** 补齐结果被后端截断：匹配没有显示全，界面不能说「没有更多匹配」。 */
  let filterTruncated = $state(false);
  /** 全仓库补齐还在飞行中：这时候没有行不等于「没有匹配」，界面必须显示正在补齐。 */
  let filterBusy = $state(false);
  let changedOnly = $state(false);
  /** 仅改动树里被折叠的目录路径：节点每次重建，折叠状态必须按路径记。 */
  let changedCollapsed = $state<ReadonlySet<string>>(new Set());
  /** 定位目标行：路径 + 行号 + 序号，内容区据此读取目标页并滚动。 */
  let lineTarget = $state<{ path: string; line: number; serial: number } | null>(null);
  let locateSerial = 0;
  let pathSerial = 0;
  let contentSerial = 0;
  let filterSerial = 0;
  /** 当前会话的打开历史（路径 + 行）：后退/前进按它走，不写任何持久状态。 */
  let visits = $state<{ path: string; line: number | null }[]>([]);
  let cursor = $state(-1);

  function reset(next: string | null): void {
    refreshSerial += 1;
    repo = next;
    nodes = [];
    selectedPath = null;
    query = "";
    loading = false;
    failure = null;
    loaded = false;
    serials.clear();
    resetSearches();
    changedOnly = false;
    changedCollapsed = new Set();
    lineTarget = null;
    visits = [];
    cursor = -1;
  }

  /** 切仓库或清空视图时撤下全部搜索状态：旧仓库的结果一律不留在界面上。 */
  function resetSearches(): void {
    pathSerial += 1;
    contentSerial += 1;
    filterSerial += 1;
    pathQuery = "";
    pathResult = null;
    pathError = null;
    pathBusy = false;
    contentQuery = "";
    contentResult = null;
    contentError = null;
    contentBusy = false;
    filterEntries = [];
    filterError = null;
    filterTruncated = false;
    filterBusy = false;
  }

  function findNode(list: FileNode[], path: string): FileNode | null {
    for (const node of list) {
      if (node.path === path) return node;
      if (node.children) {
        const found = findNode(node.children, path);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * 用新读到的子项更新节点：同路径的旧节点保留展开状态与已读子项。
   * 根目录那一层用当前 nodes 作已有项，否则重读根目录会把整棵树的展开与缓存丢掉。
   */
  function applyEntries(node: FileNode | null, entries: RepositoryDirectoryEntry[]): void {
    const existing = node ? (node.children ?? []) : nodes;
    const byPath = new Map(existing.map((child) => [child.path, child]));
    const children = entries.map((entry) => {
      const previous = byPath.get(entry.path);
      if (!previous) return makeNode(entry);
      previous.kind = entry.kind;
      previous.ignored = entry.ignored;
      previous.size = entry.size;
      previous.version = entry.version;
      previous.error = entry.error;
      return previous;
    });
    // 条目和顺序未变时保留数组身份；元数据字段自身仍会通知订阅者。
    if ((!node || node.children !== null) && existing.length === children.length && existing.every((child, index) => child === children[index])) return;
    if (node) node.children = children;
    else nodes = children;
  }

  /**
   * 读取一个目录的直接子项。返回值表示这次读取是否按当前代次走到了终点：
   * 隐藏视图、切仓库或新请求取代时返回 false，交给 activate / 刷新再重验。
   *
   * 代次重读在同一个调用里循环，不另起一次调用：这样 loading 始终由本次调用持有，
   * 任何返回路径（含隐藏时短路）都会清理目标路径与节点的 loading，不会锁死视图。
   */
  async function loadDirectory(path: string, node: FileNode | null, retries = 1): Promise<boolean> {
    const current = repo;
    if (!current) return false;
    const token = ++directorySerial;
    serials.set(path, token);
    const owns = () => repo === current && serials.get(path) === token;
    const busy = (value: boolean) => {
      if (node) node.loading = value;
      else loading = value;
    };
    if (!deps.active()) {
      // 隐藏视图不读取：只释放可能残留的 loading，代次变化留给 activate 重验。
      if (owns()) busy(false);
      return false;
    }
    busy(true);
    if (node) node.failure = null;
    else failure = null;
    try {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (!owns() || !deps.active()) return false;
        let directory: RepositoryDirectory;
        try {
          directory = await api.repositoryDirectory(current, path, includeIgnored, deps.generation(), deps.nextId());
        } catch (error) {
          if (!owns()) return false;
          const normalized = normalizeError(error);
          const stale = normalized.code === "stale" && normalized.generation !== undefined;
          if (stale) deps.onGeneration(normalized.generation as number);
          // 树比仓库旧：按当前代次再读一次；第二次仍是 stale 就如实报错。
          if (stale && attempt < retries) continue;
          const message = normalized.message || "无法读取这个目录。";
          if (node) {
            node.children = node.children ?? [];
            node.failure = message;
          } else {
            nodes = [];
            failure = message;
          }
          return true;
        }
        if (!owns()) return false;
        // 隐藏期间返回的结果不算数：不把旧结构写进当前树，等 activate 重验。
        if (!deps.active()) return false;
        if (directory.generation > deps.generation()) deps.onGeneration(directory.generation);
        if (directory.generation < deps.generation() && attempt < retries) continue;
        applyEntries(node, directory.entries);
        if (directory.errors.length > 0) {
          const message = directory.errors.join("；");
          if (node) node.failure = message;
          else failure = message;
        }
        loaded = true;
        return true;
      }
      return false;
    } finally {
      if (owns()) busy(false);
    }
  }

  async function expand(node: FileNode): Promise<void> {
    if (!isDirectoryKind(node.kind)) return;
    node.expanded = true;
    if (node.children === null) await loadDirectory(node.path, node);
  }

  async function toggle(node: FileNode): Promise<void> {
    if (!isDirectoryKind(node.kind)) return;
    // 仅改动树的节点每次重建：折叠按路径记住，否则下一次重算就弹回展开。
    if (changedOnly) {
      const next = new Set(changedCollapsed);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      changedCollapsed = next;
      return;
    }
    if (node.expanded) {
      node.expanded = false;
      return;
    }
    await expand(node);
  }

  /**
   * 全部折叠：只改展开状态，不丢已读子项（再展开不用重读）。
   * 仅改动树按路径记折叠，所以把所有合成目录都记进折叠集合。
   */
  function collapseAll(): void {
    if (changedOnly) {
      const next = new Set<string>();
      for (const file of deps.files?.() ?? []) {
        const parts = file.path.split("/");
        let prefix = "";
        for (let index = 0; index < parts.length - 1; index += 1) {
          prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
          next.add(prefix);
        }
      }
      changedCollapsed = next;
      return;
    }
    const walk = (list: FileNode[]) => {
      for (const node of list) {
        if (node.expanded) node.expanded = false;
        if (node.children) walk(node.children);
      }
    };
    walk(nodes);
  }

  /** 逐级加载 path 的祖先目录，让这一行真的出现在树里（未读过的目录按需读取）。 */
  async function ensureChain(path: string): Promise<boolean> {
    const parts = path.split("/");
    let prefix = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
      let node = findNode(nodes, prefix);
      // 这一级还没读到（从未展开、或树被过滤/重读过）：重读根目录再找一次。
      if (!node || !isDirectoryKind(node.kind)) {
        await loadDirectory("", null);
        node = findNode(nodes, prefix);
      }
      if (!node || !isDirectoryKind(node.kind)) return false;
      if (node.children === null) {
        const ok = await loadDirectory(node.path, node);
        if (!ok) return false;
      }
      node.expanded = true;
    }
    return true;
  }

  /** path 是否落在仅改动树里：改动文件本身或它的祖先目录。 */
  function changedTreeContains(path: string): boolean {
    const files = deps.files?.() ?? [];
    return files.some((file) => file.path === path || file.path.startsWith(`${path}/`));
  }

  /**
   * 仅改动树里的定位：目标自己和它的每一级祖先目录都要展开，否则这一行根本不在行列表里。
   * 只清掉这些路径的折叠记录，别的目录保持折叠。
   */
  function revealChangedBranch(path: string): void {
    const parts = path.split("/");
    let prefix = "";
    let changed = false;
    const next = new Set(changedCollapsed);
    for (let index = 0; index < parts.length; index += 1) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
      if (next.delete(prefix)) changed = true;
    }
    if (changed) changedCollapsed = next;
  }

  /**
   * 退出仅改动树的唯一入口：树覆盖的范围变回完整树，已有查询必须按完整树重跑补齐。
   *
   * 进入仅改动时补齐结果被清空（改动树自己覆盖全部改动路径，不补全仓）。
   * 退出时如果只是把 changedOnly 置假，界面上那个 query 还在、本地行里又没有命中，
   * 补齐既没有结果也不在飞行中——树会确定地说「没有匹配的路径」，直到下一次输入才恢复。
   * 所以这里立即重跑补齐：飞行期间 filterBusy 为真，界面显示「正在全仓库补齐匹配」，
   * 结果回来后与当前 query 一致；用户输入的关键词一律保留，不静默清空。
   */
  function leaveChangedOnly(): void {
    changedOnly = false;
    if (query.trim()) void completeFilter();
  }

  /**
   * 让 path 这一行真的出现在树里，定位与后退/前进共用这一份规则：
   * 目标在仅改动树里就地解除必要祖先的折叠（不读目录），否则按完整树逐级读取。
   * 目标不在改动树里时按 locate 的既有语义退出仅改动——改动树里根本没有这一行。
   */
  async function revealTarget(path: string): Promise<boolean> {
    const staysChanged = changedOnly && changedTreeContains(path);
    if (changedOnly && !staysChanged) leaveChangedOnly();
    if (staysChanged) {
      revealChangedBranch(path);
      return true;
    }
    return ensureChain(path);
  }

  /** 树内定位：展开祖先、选中并（可选）记下要跳转的行。不改动工作区，也不读文件内容。 */
  async function locate(path: string, line: number | null = null): Promise<boolean> {
    if (!repo || !deps.active()) return false;
    if (query) {
      query = "";
      filterSerial += 1;
      filterEntries = [];
      filterError = null;
      filterTruncated = false;
      filterBusy = false;
    }
    // 与后退/前进共用同一份揭示规则：改动树就地解除折叠，完整树逐级读取。
    if (!(await revealTarget(path))) return false;
    const previousDirectory = currentDirectory();
    selectedPath = path;
    remember(path, line);
    retargetDirectoryScope(previousDirectory);
    if (line !== null && line > 0) lineTarget = { path, line, serial: ++locateSerial };
    return true;
  }

  /** 打开过的文件（路径 + 行）：同一路径连续打开不重复占位，最多保留最近 50 条。 */
  function remember(path: string, line: number | null): void {
    const current = visits[cursor];
    if (current && current.path === path && current.line === line) return;
    visits = [...visits.slice(0, cursor + 1), { path, line }].slice(-50);
    cursor = visits.length - 1;
  }

  function select(path: string): void {
    const previousDirectory = currentDirectory();
    selectedPath = path;
    remember(path, null);
    retargetDirectoryScope(previousDirectory);
  }

  function setQuery(next: string): void {
    query = next;
    void completeFilter();
  }

  /**
   * 树过滤的全局补齐：已加载部分本地过滤，其余靠路径搜索补齐未展开的匹配。
   * 仅改动模式不补齐全仓：改动树本身就列出全部改动文件，补全仓只会混进非改动的路径。
   */
  async function completeFilter(retries = 1): Promise<void> {
    const queryNow = query.trim();
    const current = repo;
    const token = ++filterSerial;
    if (!current || !queryNow || !deps.active() || changedOnly) {
      filterEntries = [];
      filterError = null;
      filterTruncated = false;
      filterBusy = false;
      return;
    }
    const owns = () => repo === current && filterSerial === token;
    filterBusy = true;
    try {
      const result = await api.repositoryPathSearch(
        current,
        queryNow,
        null,
        includeIgnored,
        SEARCH_LIMIT,
        deps.generation(),
        deps.nextId(),
      );
      if (!owns()) return;
      if (result.generation > deps.generation()) deps.onGeneration(result.generation);
      // 旧代次的结果不补进树：宁可少显示，也不把过期路径当成当前仓库的。
      if (result.generation < deps.generation() && retries > 0) {
        void completeFilter(retries - 1);
        return;
      }
      if (result.generation < deps.generation()) return;
      filterEntries = result.entries;
      filterError = null;
      // 截断必须一路传到界面：否则「没有更多匹配」会把未显示的结果说成不存在。
      filterTruncated = result.truncated;
    } catch (error) {
      if (!owns()) return;
      const normalized = normalizeError(error);
      if (normalized.code === "stale" && normalized.generation !== undefined && retries > 0) {
        deps.onGeneration(normalized.generation);
        void completeFilter(retries - 1);
        return;
      }
      filterEntries = [];
      filterError = normalized.message || "无法在仓库里查找路径。";
      filterTruncated = false;
    } finally {
      // 只有还是当前这次请求才复位：被新请求取代时，新的那次已经自己置真。
      if (owns()) filterBusy = false;
    }
  }

  function setPathQuery(next: string): void {
    pathQuery = next;
    void searchPaths();
  }

  /** 路径快速打开：只查路径（文件与派生目录），不读任何文件内容。 */
  async function searchPaths(retries = 1): Promise<void> {
    const queryNow = pathQuery.trim();
    const current = repo;
    const token = ++pathSerial;
    if (!current || !queryNow || !deps.active()) {
      pathResult = null;
      pathError = null;
      pathBusy = false;
      return;
    }
    const owns = () => repo === current && pathSerial === token;
    pathBusy = true;
    pathError = null;
    try {
      const result = await api.repositoryPathSearch(
        current,
        queryNow,
        null,
        searchIgnored,
        SEARCH_LIMIT,
        deps.generation(),
        deps.nextId(),
      );
      if (!owns()) return;
      if (result.generation > deps.generation()) deps.onGeneration(result.generation);
      if (result.generation < deps.generation() && retries > 0) {
        void searchPaths(retries - 1);
        return;
      }
      if (result.generation < deps.generation()) return;
      pathResult = result;
    } catch (error) {
      if (!owns()) return;
      const normalized = normalizeError(error);
      if (normalized.code === "stale" && normalized.generation !== undefined && retries > 0) {
        deps.onGeneration(normalized.generation);
        void searchPaths(retries - 1);
        return;
      }
      pathResult = null;
      pathError = normalized.message || "无法按路径搜索。";
    } finally {
      if (owns()) pathBusy = false;
    }
  }

  function setContentQuery(next: string): void {
    contentQuery = next;
    void searchContent();
  }

  function setScopeKind(next: RepositorySearchScope["kind"]): void {
    if (scopeKind === next) return;
    scopeKind = next;
    void searchContent();
  }

  function setSearchIgnored(next: boolean): void {
    if (searchIgnored === next) return;
    searchIgnored = next;
    void searchContent();
    void searchPaths();
    if (query.trim()) void completeFilter();
  }

  function setChangedOnly(next: boolean): void {
    if (changedOnly === next) return;
    if (next) {
      changedOnly = true;
      // 两种树覆盖的范围不同：补齐结果要么作废，要么按新模式重新查一次。
      filterSerial += 1;
      filterEntries = [];
      filterError = null;
      filterTruncated = false;
      filterBusy = false;
      return;
    }
    leaveChangedOnly();
  }

  /** 当前目录 scope 的目录：选中的目录本身，或选中文件所在的目录。 */
  function currentDirectory(): string | null {
    if (!selectedPath) return null;
    const node = findNode(nodes, selectedPath);
    if (node && isDirectoryKind(node.kind)) return selectedPath;
    return selectedPath.includes("/") ? selectedPath.slice(0, selectedPath.lastIndexOf("/")) : "";
  }

  function scopeFor(kind: RepositorySearchScope["kind"]): RepositorySearchScope {
    if (kind === "directory") return { kind: "directory", path: currentDirectory() ?? "" };
    if (kind === "changed") return { kind: "changed" };
    return { kind: "repository" };
  }

  /**
   * 当前目录范围跟着选中项走：选中变化后旧的目录结果不再属于界面显示的范围，
   * 按新目录重查一次，避免结果集与「当前目录」标签各说各话。
   */
  function retargetDirectoryScope(previousDirectory: string | null): void {
    if (scopeKind !== "directory" || !contentQuery.trim()) return;
    if (currentDirectory() === previousDirectory) return;
    void searchContent();
  }

  /**
   * 全文搜索：固定字符串，范围由 scope 决定（全仓 / 当前目录 / 仅改动 / 单文件）。
   * 结果只有在仓库、代次和请求身份都仍是当前值时才写入；旧查询与旧仓库不会覆盖新结果。
   */
  async function searchContent(retries = 1): Promise<void> {
    const queryNow = contentQuery.trim();
    const current = repo;
    const token = ++contentSerial;
    if (!current || !queryNow || !deps.active()) {
      contentResult = null;
      contentError = null;
      contentBusy = false;
      return;
    }
    const owns = () => repo === current && contentSerial === token;
    contentBusy = true;
    contentError = null;
    const scope = scopeFor(scopeKind);
    try {
      const result = await api.repositoryContentSearch(
        current,
        queryNow,
        scope,
        searchIgnored,
        SEARCH_LIMIT,
        deps.generation(),
        deps.nextId(),
      );
      if (!owns()) return;
      if (result.generation > deps.generation()) deps.onGeneration(result.generation);
      if (result.generation < deps.generation() && retries > 0) {
        void searchContent(retries - 1);
        return;
      }
      if (result.generation < deps.generation()) return;
      contentResult = result;
    } catch (error) {
      if (!owns()) return;
      const normalized = normalizeError(error);
      if (normalized.code === "stale" && normalized.generation !== undefined && retries > 0) {
        deps.onGeneration(normalized.generation);
        void searchContent(retries - 1);
        return;
      }
      contentResult = null;
      contentError = normalized.message || "无法完成这次搜索。";
    } finally {
      if (owns()) contentBusy = false;
    }
  }

  /**
   * 后退 / 前进：回到本次会话打开过的路径与行；不重新搜索、不重读其它视图。
   * 树里的揭示规则与定位完全一致：仅改动模式就地解除祖先折叠，行立即出现并选中，
   * 这样回到折叠分支里的文件时树不会停在折叠状态、右侧也不会只剩下空选择。
   */
  async function go(delta: number): Promise<boolean> {
    const visit = visits[cursor + delta];
    if (!visit || !repo || !deps.active()) return false;
    cursor += delta;
    const previousDirectory = currentDirectory();
    await revealTarget(visit.path);
    selectedPath = visit.path;
    retargetDirectoryScope(previousDirectory);
    if (visit.line !== null && visit.line > 0) {
      lineTarget = { path: visit.path, line: visit.line, serial: ++locateSerial };
    }
    return true;
  }

  function clearLineTarget(): void {
    lineTarget = null;
  }

  function back(): void {
    void go(-1);
  }

  function forward(): void {
    void go(1);
  }

  function setIncludeIgnored(next: boolean): void {
    if (includeIgnored === next) return;
    includeIgnored = next;
    nodes = [];
    loaded = false;
    filterSerial += 1;
    filterEntries = [];
    void reload();
    if (query.trim()) void completeFilter();
  }

  /** 手动或代次变化后的重验：重读根目录和所有已经读过的目录，保持展开与选择。 */
  async function revalidate(forceContent = false): Promise<boolean> {
    const refresh = ++refreshSerial;
    const current = repo;
    const owns = () => refresh === refreshSerial && repo === current && deps.active();
    if (forceContent) revision += 1;
    if (!repo || !deps.active()) return false;
    // 根目录本身也是"已加载的目录"：顶层的新增与删除只能靠它发现。
    if (!(await loadDirectory("", null))) return false;
    if (!owns()) return false;
    const targets: FileNode[] = [];
    const enqueue = (list: FileNode[]) => {
      for (const node of list) {
        if (isDirectoryKind(node.kind) && node.children !== null) targets.push(node);
      }
    };
    enqueue(nodes);
    // 每批最多三个读取，父目录刷新后才排入仍存在的子目录。
    // 隐藏或切仓库后，不再把旧树上的路径排进读取通道。
    for (let start = 0; start < targets.length;) {
      if (!owns()) return false;
      const batch = targets.slice(start, start + 3);
      start += batch.length;
      const results = await Promise.all(batch.map((node) => loadDirectory(node.path, node)));
      if (!owns() || !results.every(Boolean)) return false;
      for (const node of batch) if (node.children) enqueue(node.children);
    }
    verifiedGeneration = deps.generation();
    // 树重验完再按当前代次重跑还在显示的搜索：隐藏期间的结果一律不再当作当前。
    if (query.trim()) void completeFilter();
    if (pathQuery.trim()) void searchPaths();
    if (contentQuery.trim()) void searchContent();
    return true;
  }

  async function reload(): Promise<void> {
    if (!repo) return;
    if (!loaded) {
      await loadDirectory("", null);
      return;
    }
    await revalidate();
  }

  /** 仓库身份变化：清空一切再按当前仓库读根目录；隐藏视图不发起读取。 */
  async function sync(next: string | null): Promise<void> {
    if (next !== repo) {
      reset(next);
      verifiedGeneration = deps.generation();
    }
    if (!next || !deps.active()) return;
    if (!loaded && !loading) {
      const done = await loadDirectory("", null);
      if (done && deps.active()) verifiedGeneration = deps.generation();
    }
  }

  /**
   * 视图可见性变化。可见 → 隐藏时只记一次快照；隐藏期间的每次变化都留到激活时重验。
   */
  function setVisible(next: boolean, generation = deps.generation()): void {
    if (!next) {
      if (hiddenAt === null) hiddenAt = generation;
      return;
    }
    hiddenAt = null;
    void activate();
  }

  /**
   * 视图重新激活：按当前代次重验已加载的目录与当前文件；隐藏期间不读取。
   * 同一代次重新激活不重读：滚动位置与已加载内容属于当前会话，不该被一次切视图冲掉。
   */
  async function activate(): Promise<void> {
    if (!repo) return;
    if (!loaded) {
      // 根目录已经在读：那次读取自己会按当前代次重读，这里不重复发起。
      if (loading) return;
      const done = await loadDirectory("", null);
      if (done && deps.active()) verifiedGeneration = deps.generation();
      return;
    }
    if (deps.generation() === verifiedGeneration) return;
    await revalidate();
  }

  /**
   * 仅改动模式的行：过滤在全部改动路径上完成，命中分支强制展开。
   * 折叠目录里的命中仍然显示对应分支，但折叠状态本身不改——清掉过滤后照旧折叠。
   */
  function changedRows(): FileTreeRow[] {
    const files = deps.files?.() ?? [];
    const needle = query.trim();
    if (!needle) return flattenTree(buildChangedTree(files, changedCollapsed));
    return flattenTree(buildChangedTree(changedFilesMatching(files, needle), changedCollapsed, true));
  }

  /** 当前树的可见行：仅改动时来自 StatusSnapshot，否则来自按需读到的目录。 */
  function visibleRows(): FileTreeRow[] {
    return cachedRows;
  }

  // 导航、类型解析和树渲染共享结果；选择文件不应重新展开整棵树。
  const flatRows = $derived(flattenTree(nodes));
  const cachedRows = $derived(changedOnly ? changedRows() : filterRows(flatRows, query));
  const completedRows = $derived(completion(cachedRows));
  const treeRows = $derived(completedRows.rows.length === 0 ? cachedRows : [...cachedRows, ...completedRows.rows]);

  /**
   * 选中路径的类型与真实路径：先看当前可见行，再看已读到的树节点，最后看改动集合。
   * 解析不要求这一行此刻出现在可见行里——折叠与过滤只改变树的显示方式，
   * 不该让正在阅读的文件失去类型，否则右侧内容会被一次折叠清空。
   */
  function resolvePath(path: string): { path: string; kind: RepositoryEntryKind; segment: boolean } | null {
    const row = visibleRows().find((item) => item.path === path);
    if (row) return { path: row.path, kind: row.kind, segment: row.segment };
    const node = findNode(nodes, path);
    if (node) return { path: node.path, kind: node.kind, segment: false };
    // 仅改动树的节点每次重建，折叠后这一行可能既不在可见行里也不在 nodes 里：
    // 改动集合本身仍然证明它是工作区里的一个文件。
    const change = (deps.files?.() ?? []).find((file) => file.path === path);
    return change ? { path: change.path, kind: "file", segment: false } : null;
  }

  /**
   * 树过滤的全仓补齐：只补当前树里还没有的路径，最多显示 FILTER_EXTRA_LIMIT 条。
   * 仅改动模式不补全仓——那会往改动树里塞进非改动文件。
   */
  function completion(base: readonly FileTreeRow[]): { rows: FileTreeRow[]; limited: boolean } {
    if (changedOnly || !query.trim()) return { rows: [], limited: false };
    const seen = new Set(base.map((row) => row.path));
    const entries = filterEntries.filter((entry) => !seen.has(entry.path));
    return {
      rows: entries.slice(0, FILTER_EXTRA_LIMIT).map(extraRow),
      limited: entries.length > FILTER_EXTRA_LIMIT,
    };
  }

  return {
    get repo() {
      return repo;
    },
    get nodes() {
      return nodes;
    },
    get selectedPath() {
      return selectedPath;
    },
    get query() {
      return query;
    },
    get includeIgnored() {
      return includeIgnored;
    },
    get loading() {
      return loading;
    },
    get failure() {
      return failure;
    },
    get loaded() {
      return loaded;
    },
    get revision() {
      return revision;
    },
    get rows() {
      // 仅看改动时行来自 StatusSnapshot：目录没有被读过，但改动文件与墓碑照样能显示。
      return visibleRows();
    },
    /** 树实际渲染的行：已加载范围内的本地匹配 + 全仓库补齐（有上限）。 */
    get treeRows() {
      return treeRows;
    },
    /** 补齐结果超过上限：界面必须说明只列了前 FILTER_EXTRA_LIMIT 条。 */
    get filterLimited() {
      return completedRows.limited;
    },
    get selectedNode() {
      return selectedPath ? findNode(nodes, selectedPath) : null;
    },
    get selectedVersion() {
      return selectedPath ? findNode(nodes, selectedPath)?.version ?? null : null;
    },
    /** 选中路径的类型解析：折叠或过滤把它藏起来也仍然能解析出真实类型。 */
    resolve: resolvePath,
    get changedOnly() {
      return changedOnly;
    },
    get pathQuery() {
      return pathQuery;
    },
    get pathResult() {
      return pathResult;
    },
    get pathError() {
      return pathError;
    },
    get pathBusy() {
      return pathBusy;
    },
    get contentQuery() {
      return contentQuery;
    },
    get contentResult() {
      return contentResult;
    },
    get contentError() {
      return contentError;
    },
    get contentBusy() {
      return contentBusy;
    },
    /** 当前全文结果实际使用的范围路径：界面据此显示，而不是另算一份。 */
    get contentScopePath() {
      return contentResult?.scopePath ?? null;
    },
    /** 结果范围与现在选中的目录已经不一致（选中变了但结果还没回来）。 */
    get contentScopeStale() {
      if (scopeKind !== "directory" || contentResult === null) return false;
      return (contentResult.scopePath ?? "") !== (currentDirectory() ?? "");
    },
    get scopeKind() {
      return scopeKind;
    },
    get searchIgnored() {
      return searchIgnored;
    },
    get filterEntries() {
      return filterEntries;
    },
    get filterError() {
      return filterError;
    },
    /** 补齐结果被后端截断：匹配没有显示全。 */
    get filterTruncated() {
      return filterTruncated;
    },
    /** 全仓库补齐正在飞行中：界面显示「正在补齐」而不是「没有匹配」。 */
    get filterBusy() {
      return filterBusy;
    },
    get lineTarget() {
      return lineTarget;
    },
    get recent() {
      return visits;
    },
    get canBack() {
      return cursor > 0;
    },
    get canForward() {
      return cursor >= 0 && cursor < visits.length - 1;
    },
    get backReason() {
      if (visits.length === 0) return "还没有打开过文件";
      return cursor > 0 ? null : "已经是本次会话的第一个文件";
    },
    get forwardReason() {
      if (visits.length === 0) return "还没有打开过文件";
      return cursor >= 0 && cursor < visits.length - 1 ? null : "已经是最新打开的文件";
    },
    get currentDirectory() {
      return currentDirectory();
    },
    locate,
    setQuery,
    setIncludeIgnored,
    setPathQuery,
    setContentQuery,
    setScopeKind,
    setSearchIgnored,
    setChangedOnly,
    clearLineTarget,
    clearSearches: resetSearches,
    back,
    forward,
    sync,
    activate,
    setVisible,
    revalidate,
    toggle,
    expand,
    collapseAll,
    select,
  };
}

export type FilesStore = ReturnType<typeof createFilesStore>;
