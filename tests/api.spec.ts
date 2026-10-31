import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() =>
  vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({ ok: true })),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
}));

import { api } from "../src/lib/api";

describe("Tauri 命令参数", () => {
  beforeEach(() => {
    invoke.mockClear();
  });

  it("仓库操作使用 requestId，匹配 command 的 camelCase", async () => {
    await api.addRepository("/repo", 4);
    await api.createRepository("/repo", 5);
    await api.openRepository("/repo", 6);
    await api.refreshStatus("/repo", 8, 7);
    await api.loadDiff("/repo", "a b.txt", false, 8, 9);
    await api.cloneRepository("https://example.com/app.git", "/parent", "app", 10);
    await api.fetchRemote("/repo", 8, 11);
    await api.commitAndPush("/repo", "note", 8, 12);
    await api.deleteBranch("/repo", "topic", false, 8, 13);

    expect(invoke).toHaveBeenNthCalledWith(1, "add_repository", { path: "/repo", requestId: 4 });
    expect(invoke).toHaveBeenNthCalledWith(2, "create_repository", { path: "/repo", requestId: 5 });
    expect(invoke).toHaveBeenNthCalledWith(3, "open_repository", { path: "/repo", requestId: 6 });
    expect(invoke).toHaveBeenNthCalledWith(4, "refresh_status", {
      path: "/repo",
      generation: 8,
      requestId: 7,
    });
    expect(invoke).toHaveBeenNthCalledWith(5, "load_diff", {
      path: "/repo",
      relative: "a b.txt",
      original: null,
      staged: false,
      generation: 8,
      requestId: 9,
      offset: 0,
      limit: 0,
    });
    expect(invoke).toHaveBeenNthCalledWith(6, "clone_repository", {
      url: "https://example.com/app.git",
      parent: "/parent",
      name: "app",
      requestId: 10,
    });
    expect(invoke).toHaveBeenNthCalledWith(7, "fetch_remote", {
      path: "/repo",
      generation: 8,
      requestId: 11,
    });
    expect(invoke).toHaveBeenNthCalledWith(8, "commit_and_push", {
      path: "/repo",
      message: "note",
      generation: 8,
      requestId: 12,
    });
    expect(invoke).toHaveBeenNthCalledWith(9, "delete_branch", {
      path: "/repo",
      name: "topic",
      confirmUnmerged: false,
      generation: 8,
      requestId: 13,
    });
    for (const call of invoke.mock.calls) {
      expect(call[1]).not.toHaveProperty("request_id");
    }
  });

  it("历史和临时保存使用 requestId", async () => {
    await api.historyPage("/repo", "needle", 100, 8, 20);
    await api.commitDetail("/repo", "abc123", null, 8, 21);
    await api.commitFileDiff("/repo", "abc123", "def456", "old/name.txt", 8, 22, 0, 0);
    await api.fileHistory("/repo", "old/name.txt", 0, 8, 23);
    await api.stashState("/repo", false, 8, 24);
    await api.saveStash("/repo", true, "wip", 8, 25);
    await api.applyStash("/repo", "abc123", 8, 26);
    await api.deleteStash("/repo", "abc123", true, 8, 27);

    expect(invoke).toHaveBeenNthCalledWith(1, "history_page", {
      path: "/repo",
      query: "needle",
      offset: 100,
      generation: 8,
      requestId: 20,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "commit_detail", {
      path: "/repo",
      oid: "abc123",
      parent: null,
      generation: 8,
      requestId: 21,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "commit_file_diff", {
      path: "/repo",
      oid: "abc123",
      parent: "def456",
      relative: "old/name.txt",
      generation: 8,
      requestId: 22,
      offset: 0,
      limit: 0,
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "file_history", {
      path: "/repo",
      relative: "old/name.txt",
      offset: 0,
      generation: 8,
      requestId: 23,
    });
    expect(invoke).toHaveBeenNthCalledWith(5, "stash_state", {
      path: "/repo",
      includeUntracked: false,
      generation: 8,
      requestId: 24,
    });
    expect(invoke).toHaveBeenNthCalledWith(6, "save_stash", {
      path: "/repo",
      includeUntracked: true,
      message: "wip",
      generation: 8,
      requestId: 25,
    });
    expect(invoke).toHaveBeenNthCalledWith(7, "apply_stash", {
      path: "/repo",
      oid: "abc123",
      generation: 8,
      requestId: 26,
    });
    expect(invoke).toHaveBeenNthCalledWith(8, "delete_stash", {
      path: "/repo",
      oid: "abc123",
      confirm: true,
      generation: 8,
      requestId: 27,
    });
    for (const call of invoke.mock.calls) {
      expect(call[1]).not.toHaveProperty("request_id");
    }
  });
});
