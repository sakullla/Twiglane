import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

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
      staged: false,
      generation: 8,
      requestId: 9,
    });
    for (const call of invoke.mock.calls) {
      expect(call[1]).not.toHaveProperty("request_id");
    }
  });
});
