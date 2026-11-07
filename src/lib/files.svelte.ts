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
import type { RepositoryDirectoryEntry, RepositoryEntryKind } from "./types";

/** 目录行高（像素）：与 components.css 的 .file-tree-row 一致，虚拟化按它算窗口。 */
export const FILE_ROW_HEIGHT = 26;
/** 单链合并的上限：再多就不是「一个目录」而是层级本身，逐级展开更好读。 */
export const MAX_CHAIN = 12;

export interface FileNode {
  path: string;
  name: string;
  kind: RepositoryEntryKind;
  ignored: boolean;
  size: number | null;
  error: string | null;
  /** 直接子项；null 表示还没读过（按需读取），[] 表示读过且为空。 */
  children: FileNode[] | null;
  expanded: boolean;
  loading: boolean;
  /** 目录读取失败的说明：就地显示，其他兄弟目录不受影响。 */
  failure: string | null;
  /** 用户要求把单链目录拆成逐级显示。 */
  split: boolean;
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
}

export function makeNode(entry: RepositoryDirectoryEntry): FileNode {
  return {
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    ignored: entry.ignored,
    size: entry.size,
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
  const matched: string[] = [];
  rows.forEach((row, index) => {
    const hit = row.path.toLowerCase().includes(needle) || row.label.toLowerCase().includes(needle);
    if (!hit) return;
    keep.add(index);
    matched.push(row.path);
  });
  // 匹配项的一切祖先目录都要留下，否则命中的文件挂在看不见的目录下面。
  rows.forEach((row, index) => {
    if (keep.has(index) || !isDirectoryKind(row.kind)) return;
    const prefix = `${row.path}/`;
    if (matched.some((path) => path.startsWith(prefix))) keep.add(index);
  });
  return rows.filter((_row, index) => keep.has(index));
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
  /** 文件内容的重新读取凭据：重新激活、代次变化与手动刷新时递增。 */
  let revision = $state(0);

  const serials = new Map<string, number>();

  function reset(next: string | null): void {
    repo = next;
    nodes = [];
    selectedPath = null;
    query = "";
    loading = false;
    failure = null;
    loaded = false;
    serials.clear();
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

  /** 用新读到的子项更新节点：同路径的旧节点保留展开状态与已读子项。 */
  function applyEntries(node: FileNode | null, entries: RepositoryDirectoryEntry[]): void {
    const existing = node?.children ?? [];
    const byPath = new Map(existing.map((child) => [child.path, child]));
    const children = entries.map((entry) => {
      const previous = byPath.get(entry.path);
      if (!previous) return makeNode(entry);
      previous.kind = entry.kind;
      previous.ignored = entry.ignored;
      previous.size = entry.size;
      previous.error = entry.error;
      return previous;
    });
    if (node) node.children = children;
    else nodes = children;
  }

  async function loadDirectory(path: string, node: FileNode | null, attempt = 0): Promise<void> {
    const current = repo;
    if (!current || !deps.active()) return;
    const token = (serials.get(path) ?? 0) + 1;
    serials.set(path, token);
    if (node) {
      node.loading = true;
      node.failure = null;
    } else {
      loading = true;
      failure = null;
    }
    try {
      const directory = await api.repositoryDirectory(current, path, includeIgnored, deps.generation(), deps.nextId());
      if (repo !== current || serials.get(path) !== token) return;
      if (directory.generation < deps.generation() && attempt === 0) {
        // 树比仓库旧：按当前代次重读一次，读到的仍是旧代次就如实标出来。
        void loadDirectory(path, node, attempt + 1);
        return;
      }
      if (directory.generation > deps.generation()) deps.onGeneration(directory.generation);
      applyEntries(node, directory.entries);
      if (directory.errors.length > 0) {
        const message = directory.errors.join("；");
        if (node) node.failure = message;
        else failure = message;
      }
      loaded = true;
    } catch (error) {
      if (repo !== current || serials.get(path) !== token) return;
      const normalized = normalizeError(error);
      if (normalized.code === "stale" && normalized.generation !== undefined) {
        deps.onGeneration(normalized.generation);
        if (attempt === 0) {
          void loadDirectory(path, node, attempt + 1);
          return;
        }
      }
      const message = normalized.message || "无法读取这个目录。";
      if (node) {
        node.children = node.children ?? [];
        node.failure = message;
      } else {
        nodes = [];
        failure = message;
      }
    } finally {
      if (serials.get(path) === token) {
        if (node) node.loading = false;
        else loading = false;
      }
    }
  }

  async function expand(node: FileNode): Promise<void> {
    if (!isDirectoryKind(node.kind)) return;
    node.expanded = true;
    if (node.children === null) await loadDirectory(node.path, node);
  }

  async function toggle(node: FileNode): Promise<void> {
    if (!isDirectoryKind(node.kind)) return;
    if (node.expanded) {
      node.expanded = false;
      return;
    }
    await expand(node);
  }

  /** 展开到 path 的所有祖先并选中它（这里只做树内定位，不新增读取未展开目录）。 */
  async function reveal(path: string): Promise<void> {
    const parts = path.split("/");
    let list = nodes;
    let prefix = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
      let node = list.find((item) => item.path === prefix) ?? null;
      if (!node) break;
      if (!node.expanded) await expand(node);
      list = node.children ?? [];
    }
    selectedPath = path;
  }

  function select(path: string): void {
    selectedPath = path;
  }

  function setQuery(next: string): void {
    query = next;
  }

  function setIncludeIgnored(next: boolean): void {
    if (includeIgnored === next) return;
    includeIgnored = next;
    nodes = [];
    loaded = false;
    void reload();
  }

  /** 手动或代次变化后的重验：只重读已经读过的目录，保持展开与选择。 */
  async function revalidate(): Promise<void> {
    revision += 1;
    if (!repo || !deps.active()) return;
    const targets: FileNode[] = [];
    const walk = (list: FileNode[]) => {
      for (const node of list) {
        if (isDirectoryKind(node.kind) && node.children !== null) targets.push(node);
        if (node.children) walk(node.children);
      }
    };
    walk(nodes);
    if (nodes.length === 0 || targets.length === 0) {
      await loadDirectory("", null);
      return;
    }
    await Promise.all(targets.map((node) => loadDirectory(node.path, node)));
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
    if (next !== repo) reset(next);
    if (!next || !deps.active()) return;
    if (!loaded && !loading) await loadDirectory("", null);
  }

  let lastGeneration = deps.generation();

  /** 视图重新激活：代次变了才重验，隐藏期间不读取。 */
  async function activate(): Promise<void> {
    if (!repo || loading) return;
    if (!loaded) {
      await loadDirectory("", null);
      lastGeneration = deps.generation();
      return;
    }
    if (deps.generation() !== lastGeneration) {
      lastGeneration = deps.generation();
      await revalidate();
    }
    // 同一代次重新激活不重读：滚动位置与已加载内容都属于当前会话，不该被一次切视图冲掉。
  }

  function markGeneration(): void {
    lastGeneration = deps.generation();
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
      return filterRows(flattenTree(nodes), query);
    },
    get selectedNode() {
      return selectedPath ? findNode(nodes, selectedPath) : null;
    },
    sync,
    activate,
    markGeneration,
    revalidate,
    toggle,
    expand,
    reveal,
    select,
    setQuery,
    setIncludeIgnored,
  };
}

export type FilesStore = ReturnType<typeof createFilesStore>;
