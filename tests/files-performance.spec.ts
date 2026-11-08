import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFilesStore, filterRows, flattenTree, makeNode } from "../src/lib/files.svelte";
import type { RepositoryDirectory, RepositoryDirectoryEntry } from "../src/lib/types";

const repositoryDirectory = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/api", () => ({ api: { repositoryDirectory } }));

function entry(path: string, kind: "file" | "directory" = "directory"): RepositoryDirectoryEntry {
  return { path, name: path.split("/").at(-1)!, kind, ignored: false, size: null, error: null };
}

function page(path: string, entries: RepositoryDirectoryEntry[] = []): RepositoryDirectory {
  return { path, entries, generation: 1, errors: [] };
}

function setup(active = () => true) {
  return createFilesStore({ repo: () => "/repo", generation: () => 1, active, nextId: () => 1, onGeneration: vi.fn() });
}

beforeEach(() => { repositoryDirectory.mockReset(); });

describe("文件树的计算与读取预算", () => {
  it("多个读取方共享行数组，选择文件不重建，展开仍更新", async () => {
    repositoryDirectory.mockImplementation((_repo, path) => Promise.resolve(
      path === "" ? page("", [entry("src"), entry("readme", "file")]) : page(path, [entry("src/app.ts", "file")]),
    ));
    const store = setup();
    await store.sync("/repo");
    const initial = store.rows;
    expect(store.treeRows).toBe(initial);
    store.select("readme");
    expect(store.rows).toBe(initial);
    expect(store.resolve("readme")?.kind).toBe("file");
    expect(store.rows).toBe(initial);
    await store.expand(store.nodes[0]);
    expect(store.rows).not.toBe(initial);
    expect(store.rows.map((row) => row.path)).toContain("src/app.ts");
  });

  it("刷新最多并行读取三个目录，隐藏后停止排队", async () => {
    const roots = Array.from({ length: 12 }, (_, index) => entry(`dir-${index}`));
    repositoryDirectory.mockImplementation((_repo, path) => Promise.resolve(page(path, path ? [] : roots)));
    let active = true;
    const store = setup(() => active);
    await store.sync("/repo");
    for (const node of store.nodes) await store.expand(node);
    const pending: Array<() => void> = [];
    repositoryDirectory.mockClear();
    repositoryDirectory.mockImplementation((_repo, path) => path === ""
      ? Promise.resolve(page(path, roots))
      : new Promise((resolve) => pending.push(() => resolve(page(path)))));
    const refresh = store.revalidate();
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(repositoryDirectory).toHaveBeenCalledTimes(4);
    active = false;
    pending.forEach((finish) => finish());
    expect(await refresh).toBe(false);
    expect(repositoryDirectory).toHaveBeenCalledTimes(4);
  });

  it("父目录删除的已加载子目录不再参与刷新", async () => {
    repositoryDirectory.mockImplementation((_repo, path) => Promise.resolve(
      page(path, path === "" ? [entry("src")] : path === "src" ? [entry("src/gone")] : []),
    ));
    const store = setup();
    await store.sync("/repo");
    await store.expand(store.nodes[0]);
    await store.expand(store.nodes[0].children![0]);
    repositoryDirectory.mockClear();
    repositoryDirectory.mockImplementation((_repo, path) => Promise.resolve(page(path, path === "" ? [entry("src")] : [])));
    expect(await store.revalidate()).toBe(true);
    expect(repositoryDirectory.mock.calls.map((call) => call[1])).toEqual(["", "src"]);
  });

  it("切走再回到同一路径，旧根目录响应仍被丢弃", async () => {
    let finish!: (value: RepositoryDirectory) => void;
    repositoryDirectory.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    repositoryDirectory.mockResolvedValue(page("", [entry("current", "file")]));
    const store = setup();
    const old = store.sync("/repo");
    await store.sync("/other");
    await store.sync("/repo");
    finish(page("", [entry("old", "file")]));
    await old;
    expect(store.rows.map((row) => row.path)).toEqual(["current"]);
  });

  it("目录重验更新选中文件版本，仅手动刷新强制重读", async () => {
    repositoryDirectory.mockResolvedValue(page("", [{ ...entry("app.ts", "file"), version: "before" }]));
    const store = setup();
    await store.sync("/repo");
    store.select("app.ts");
    expect(store.selectedVersion).toBe("before");
    const rows = store.rows;
    const revision = store.revision;
    await store.revalidate();
    expect(store.revision).toBe(revision);
    expect(store.rows).toBe(rows);
    expect(store.selectedVersion).toBe("before");
    repositoryDirectory.mockResolvedValue(page("", [{ ...entry("app.ts", "file"), version: "after" }]));
    await store.revalidate();
    expect(store.selectedVersion).toBe("after");
    expect(store.revision).toBe(revision);
    await store.revalidate(true);
    expect(store.revision).toBe(revision + 1);
  });

  it("大量匹配保留准确祖先，不把相似目录名前缀当成祖先", () => {
    const roots = Array.from({ length: 2000 }, (_, index) => {
      const path = `dir-${index}`;
      return { ...makeNode(entry(path)), expanded: true, children: [makeNode(entry(`${path}/hit.ts`, "file"))] };
    });
    roots.push({ ...makeNode(entry("dir")), expanded: true, children: [] });
    const rows = filterRows(flattenTree(roots), "hit.ts");
    expect(rows).toHaveLength(4000);
    expect(rows.some((row) => row.path === "dir")).toBe(false);
  });
});
