import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import RemoteWorktree from "../src/lib/components/RemoteWorktree.svelte";
import type {
  RemoteDiffPage,
  RemoteOpenResult,
  RemoteTarget,
  RemoteWorktreePort,
  RemoteWorktreeSnapshot,
  RemoteWriteResult,
} from "../src/lib/remote-worktree";

const hostA: RemoteTarget = {
  targetId: "host-a",
  targetRevision: "a".repeat(64),
  name: "构建主机 A",
  host: "build-alias",
  effectiveHost: "builder-a.example",
  user: "dev",
  port: 22,
  authMethod: "key",
  defaultPath: "/srv/repo",
};
const hostB: RemoteTarget = { ...hostA, targetId: "host-b", targetRevision: "b".repeat(64), name: "构建主机 B", host: "builder-b.example", effectiveHost: undefined };
const snapshot: RemoteWorktreeSnapshot = {
  repo: "repo-a",
  root: "/srv/repo",
  host: "build-a",
  head: "a".repeat(40),
  branch: "feature",
  generation: "g1",
  files: [
    { path: "large.txt", xy: " M" },
    { path: "small.txt", xy: " M" },
    { path: "unopened.txt", xy: "??" },
  ],
};

function opened(sessionId = "session-a", value = snapshot): RemoteOpenResult {
  return { kind: "open", sessionId, snapshot: value, pendingWrite: null };
}

function page(text: string | Uint8Array, nextCursor: string | null = null): RemoteDiffPage {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return { data: btoa(String.fromCharCode(...bytes)), nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  return {
    targets: vi.fn<RemoteWorktreePort["targets"]>().mockResolvedValue([hostA, hostB]),
    open: vi.fn<RemoteWorktreePort["open"]>().mockResolvedValue(opened()),
    cancelOpen: vi.fn<RemoteWorktreePort["cancelOpen"]>().mockResolvedValue(undefined),
    close: vi.fn<RemoteWorktreePort["close"]>().mockResolvedValue(undefined),
    status: vi.fn<RemoteWorktreePort["status"]>().mockResolvedValue(snapshot),
    diff: vi.fn<RemoteWorktreePort["diff"]>().mockResolvedValue(page("差异\n")),
    write: vi.fn<RemoteWorktreePort["write"]>(),
    recover: vi.fn<RemoteWorktreePort["recover"]>(),
  };
}

async function openFromPicker() {
  await screen.findByRole("option", { name: /构建主机 A/ });
  await fireEvent.click(screen.getByRole("button", { name: "打开仓库" }));
}

afterEach(cleanup);

describe("远端工作树页面", () => {
  it("由用户确认交付到哪台主机，并取消仍在传输的安装", async () => {
    const port = fixture();
    const transfer = deferred<RemoteOpenResult>();
    port.open
      .mockResolvedValueOnce({ kind: "install_required", version: "v1", size: 2048, confirmationId: "abandoned-confirmation" })
      .mockResolvedValueOnce({ kind: "install_required", version: "v1", size: 2048, confirmationId: "current-confirmation" })
      .mockImplementationOnce((_, progress) => {
        progress({ phase: "installing", sentBytes: 1024, totalBytes: 2048 });
        return transfer.promise;
      });
    const onOpened = vi.fn();
    render(RemoteWorktree, { port, onOpened });

    await openFromPicker();
    await screen.findByText("目标主机：构建主机 A · dev@builder-a.example:22");
    expect(port.open.mock.calls[0][0]).toMatchObject({ targetId: hostA.targetId, path: "/srv/repo", allowInstall: false });
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(port.open).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("确认安装")).toBeNull();

    await openFromPicker();
    await fireEvent.click(await screen.findByRole("button", { name: "确认安装" }));
    expect(port.open.mock.calls[2][0]).toMatchObject({
      targetId: hostA.targetId, targetRevision: hostA.targetRevision, path: "/srv/repo", allowInstall: true,
      installConfirmation: "current-confirmation",
    });
    expect(screen.getByRole("progressbar", { name: "Agent 安装进度" })).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(port.cancelOpen).toHaveBeenCalledWith(port.open.mock.calls[2][0].requestId);
    transfer.resolve(opened("old-session"));
    await waitFor(() => expect(port.close).toHaveBeenCalledWith("old-session"));
    expect(onOpened).not.toHaveBeenCalled();
    expect(screen.getByText(/已取消安装/)).toBeTruthy();

    await openFromPicker();
    expect(await screen.findByRole("heading", { name: /构建主机 A/ })).toBeTruthy();
    expect(port.open.mock.calls[3][0].allowInstall).toBe(false);
  });

  it("先显示改动列表，切换文件不等待迟到的差异", async () => {
    const port = fixture();
    const oldDiff = deferred<RemoteDiffPage>();
    port.diff
      .mockReturnValueOnce(oldDiff.promise)
      .mockResolvedValueOnce(page("+new selection\n"));
    render(RemoteWorktree, { port });
    await openFromPicker();
    expect(await screen.findByText("feature")).toBeTruthy();
    const small = screen.getByRole("button", { name: "未暂存 · small.txt" });
    expect(port.diff.mock.calls.map(([request]) => request.path)).toEqual(["large.txt"]);

    await fireEvent.click(small);
    expect(await screen.findByText("+new selection")).toBeTruthy();
    oldDiff.resolve(page("-stale diff\n", "old-cursor"));
    await tick();
    expect(screen.queryByText("-stale diff")).toBeNull();
    expect(screen.queryByRole("button", { name: "加载更多差异" })).toBeNull();
    expect(port.diff.mock.calls.map(([request]) => request.path)).toEqual(["large.txt", "small.txt"]);
    expect(port.status).not.toHaveBeenCalled();
  });

  it("不同主机的同名工作树路径和文件分别显示各自差异", async () => {
    const port = fixture();
    const oldDiff = deferred<RemoteDiffPage>();
    port.open.mockResolvedValueOnce(opened("session-a", snapshot))
      .mockResolvedValueOnce(opened("session-b", {
        ...snapshot, repo: "repo-b", host: "build-b", branch: "other-branch",
      }));
    port.diff.mockReturnValueOnce(oldDiff.promise).mockResolvedValueOnce(page("+only on B\n"));
    render(RemoteWorktree, { port });
    await openFromPicker();
    await screen.findByRole("heading", { name: /构建主机 A/ });

    await fireEvent.click(screen.getByRole("button", { name: "更换仓库" }));
    await fireEvent.change(screen.getByRole("combobox", { name: "Cliora 主机" }), { target: { value: hostB.targetId } });
    await openFromPicker();
    expect(await screen.findByRole("heading", { name: /构建主机 B/ })).toBeTruthy();
    expect(screen.getByText("other-branch")).toBeTruthy();
    expect(await screen.findByText("+only on B")).toBeTruthy();
    expect(port.close).toHaveBeenCalledWith("session-a");
    expect(port.open.mock.calls.map(([request]) => [request.targetId, request.path]))
      .toEqual([[hostA.targetId, snapshot.root], [hostB.targetId, snapshot.root]]);
    expect(port.diff.mock.calls.map(([request]) => [request.sessionId, request.path]))
      .toEqual([["session-a", "large.txt"], ["session-b", "large.txt"]]);

    oldDiff.resolve(page("-only on A\n", "stale-a"));
    await tick();
    expect(screen.queryByText("-only on A")).toBeNull();
    expect(screen.queryByRole("button", { name: "加载更多差异" })).toBeNull();
  });

  it("续读仅在用户请求时发出，并保留跨页 UTF-8 字符", async () => {
    const port = fixture();
    const bytes = new TextEncoder().encode("+首段内容\n");
    port.diff.mockResolvedValueOnce(page(bytes.slice(0, 2), "page-2"))
      .mockResolvedValueOnce(page(bytes.slice(2)));
    render(RemoteWorktree, { port });
    await openFromPicker();
    const more = await screen.findByRole("button", { name: "加载更多差异" });
    expect(port.diff).toHaveBeenCalledTimes(1);
    await fireEvent.click(more);
    expect(await screen.findByText("+首段内容")).toBeTruthy();
    expect(port.diff.mock.calls[1][0]).toEqual({
      sessionId: "session-a", generation: "g1", path: "large.txt", view: "unstaged", cursor: "page-2",
    });
  });

  it("分别读取同一路径的已暂存删除和未跟踪内容", async () => {
    const port = fixture();
    port.open.mockResolvedValueOnce(opened("session-a", {
      ...snapshot, files: [{ path: "same.txt", xy: "D?" }],
    }));
    port.write.mockImplementation(async ({ operationId }) => ({
      state: "completed", operationId, snapshot: { ...snapshot, generation: "g2", files: [{ path: "same.txt", xy: " M" }] },
    }));
    render(RemoteWorktree, { port });
    await openFromPicker();
    const staged = await screen.findByRole("button", { name: "已暂存 · same.txt" });
    expect(screen.getByRole("button", { name: "未暂存 · same.txt" })).toBeTruthy();
    await fireEvent.click(staged);
    expect(port.diff.mock.calls.at(-1)?.[0]).toMatchObject({ path: "same.txt", view: "staged" });
    await fireEvent.click(screen.getByRole("button", { name: "取消暂存 same.txt" }));
    expect(await screen.findByText("取消暂存已确认。")).toBeTruthy();
    expect(port.write.mock.calls[0][0]).toMatchObject({ sessionId: "session-a", generation: "g1", op: "unstage", path: "same.txt" });
    expect(screen.queryByRole("button", { name: "已暂存 · same.txt" })).toBeNull();
  });

  it("提交回执丢失后重连原主机和规范路径，只核对同一个操作 ID", async () => {
    const port = fixture();
    const staged = { ...snapshot, files: [{ path: "small.txt", xy: "M " }] };
    const committed = { ...staged, generation: "g2", files: [], head: "b".repeat(40) };
    port.open.mockResolvedValueOnce(opened("before", staged))
      .mockResolvedValueOnce(opened("after", committed));
    port.write.mockRejectedValueOnce({ code: "transport", message: "SSH 已断开" });
    port.recover.mockImplementationOnce(async (_, operationId): Promise<RemoteWriteResult> => ({
      state: "completed", operationId, snapshot: committed, head: committed.head,
    }));
    const onWriteResult = vi.fn();
    render(RemoteWorktree, { port, onWriteResult });

    await openFromPicker();
    await fireEvent.input(await screen.findByRole("textbox", { name: "提交说明" }), { target: { value: "Update remote" } });
    await fireEvent.click(screen.getByRole("button", { name: "提交已暂存改动" }));
    expect(await screen.findByText("结果待确认")).toBeTruthy();
    expect(screen.getByText("SSH 已断开")).toBeTruthy();
    expect((screen.getByRole("button", { name: "提交已暂存改动" }) as HTMLButtonElement).disabled).toBe(true);
    const { operationId } = port.write.mock.calls[0][0];
    await fireEvent.click(screen.getByRole("button", { name: "重连并核对" }));
    expect(await screen.findByText("提交已确认 · bbbbbbb。")).toBeTruthy();
    expect(port.open.mock.calls[1][0]).toMatchObject({
      targetId: hostA.targetId, targetRevision: hostA.targetRevision, path: staged.root, allowInstall: false,
    });
    expect(port.recover).toHaveBeenCalledExactlyOnceWith("after", operationId);
    expect(port.write).toHaveBeenCalledTimes(1);
    expect(onWriteResult).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "after", snapshot: committed }),
      expect.objectContaining({ state: "completed", operationId }),
    );
  });

  it("打开后的持久待确认操作不会向同名的另一台主机或新工作树查询", async () => {
    const port = fixture();
    const pendingWrite = { op: "commit", operationId: "5d751ed7-c132-4ae8-b48f-b801db4db2ba" } as const;
    port.open.mockResolvedValueOnce({ kind: "open", sessionId: "before", snapshot, pendingWrite })
      .mockResolvedValueOnce(opened("wrong-session", { ...snapshot, repo: "different-identity" }));
    render(RemoteWorktree, { port });
    await openFromPicker();
    await fireEvent.click(await screen.findByRole("button", { name: "重连并核对" }));
    expect((await screen.findByRole("alert")).textContent).toContain("工作树身份已变化");
    expect(screen.getByText("结果待确认")).toBeTruthy();
    expect(port.recover).not.toHaveBeenCalled();
    expect(port.close).toHaveBeenCalledWith("wrong-session");
    expect(port.open.mock.calls[1][0].targetId).toBe(hostA.targetId);
  });

  it("保留安装阶段的失败原因，用户可再次确认安装", async () => {
    const port = fixture();
    port.open.mockResolvedValueOnce({ kind: "install_required", version: "v1", size: 4096 })
      .mockImplementationOnce(async (_, progress) => {
        progress({ phase: "installing", sentBytes: 1024, totalBytes: 4096 });
        throw { code: "install_failed", message: "SSH 连接超时" };
      })
      .mockResolvedValueOnce({ kind: "install_required", version: "v1", size: 4096 });
    render(RemoteWorktree, { port });
    await openFromPicker();
    await fireEvent.click(await screen.findByRole("button", { name: "确认安装" }));
    expect((await screen.findByRole("alert")).textContent).toContain("安装 Twiglane agent失败：SSH 连接超时");
    expect((screen.getByRole("textbox", { name: "远端工作树路径" }) as HTMLInputElement).value).toBe("/srv/repo");
    await openFromPicker();
    expect(await screen.findByRole("button", { name: "确认安装" })).toBeTruthy();
    expect(port.open.mock.calls.map(([request]) => request.allowInstall)).toEqual([false, true, false]);
  });

  it("将任务基线绑定原主机与路径，已变化的配置须显式重新选择", async () => {
    const port = fixture();
    const baseline = "d".repeat(40);
    const prefill = { targetId: hostB.targetId, targetRevision: "old", path: "/srv/repo", baseline };
    render(RemoteWorktree, { port, prefill });
    expect((await screen.findByRole("alert")).textContent).toContain("原远端主机的配置已变化");
    expect((screen.getByRole("button", { name: "打开仓库" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "刷新主机" }));
    expect((screen.getByRole("button", { name: "打开仓库" }) as HTMLButtonElement).disabled).toBe(true);
    const select = screen.getByRole("combobox", { name: "Cliora 主机" });
    await fireEvent.change(select, { target: { value: hostB.targetId } });
    await openFromPicker();
    expect(port.open.mock.calls[0][0]).toMatchObject({ targetId: hostB.targetId, targetRevision: hostB.targetRevision, baseline: undefined });
  });

  it("刷新后保留不可用原因，不自动改用另一台主机", async () => {
    const port = fixture();
    port.targets.mockResolvedValueOnce([hostA, hostB]).mockResolvedValueOnce([
      { ...hostA, host: "", effectiveHost: undefined, user: "", unavailableReason: "SSH 配置无法读取" },
      hostB,
    ]);
    render(RemoteWorktree, { port });
    await screen.findByRole("option", { name: /构建主机 A/ });
    await fireEvent.click(screen.getByRole("button", { name: "刷新主机" }));
    const unavailable = await screen.findByRole("option", { name: "构建主机 A · SSH 配置无法读取" }) as HTMLOptionElement;
    expect(unavailable.disabled).toBe(true);
    expect((await screen.findByRole("alert")).textContent).toContain("SSH 配置无法读取");
    const open = screen.getByRole("button", { name: "打开仓库" }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(port.open).not.toHaveBeenCalled();
    await fireEvent.change(screen.getByRole("combobox", { name: "Cliora 主机" }), { target: { value: hostB.targetId } });
    await fireEvent.click(open);
    expect(port.open.mock.calls[0][0].targetId).toBe(hostB.targetId);
  });
});
