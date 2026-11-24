// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, closeRemoteRepository, openRemoteRepository } from "../src/lib/api";
import { remoteRepositoryKey, remoteWorktreePort, type RemoteDiffPage } from "../src/lib/remote-worktree";

const location = { kind: "ssh" as const, hostId: "diff-host", hostRevision: "rev", path: "/repo" };
const key = remoteRepositoryKey(location.hostId, location.path);
const baseline = "a".repeat(40);
const head = "b".repeat(40);
const snapshot = {
  repo: "remote-repo", root: location.path, host: location.hostId, head, branch: "main",
  generation: "state-1", files: [],
};

async function openSession(id = "session-1") {
  vi.mocked(remoteWorktreePort.open).mockResolvedValueOnce({
    kind: "open", sessionId: id, snapshot, pendingWrite: null,
  });
  const result = await openRemoteRepository(location, { baseline });
  if (result.kind !== "opened") throw Error("Expected repository to open");
  return result.repository.generation;
}

function diffPage(text: string, nextCursor: string | null = null): RemoteDiffPage {
  return { data: Buffer.from(text).toString("base64"), nextCursor };
}

function waitForDiff() {
  let resolve!: (page: RemoteDiffPage) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<RemoteDiffPage>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.spyOn(remoteWorktreePort, "open");
  vi.spyOn(remoteWorktreePort, "targets").mockResolvedValue([]);
  vi.spyOn(remoteWorktreePort, "close").mockResolvedValue(undefined);
});

afterEach(async () => {
  await closeRemoteRepository(key);
  vi.restoreAllMocks();
});

describe("concurrent SSH diff reads", () => {
  it.each(["unstaged", "staged", "task"])("shares every cursor across distinct %s line windows", async (view) => {
    const generation = await openSession();
    const last = waitForDiff();
    const diff = vi.spyOn(remoteWorktreePort, "diff").mockResolvedValue(diffPage(""))
      .mockResolvedValueOnce(diffPage("@@ -1 +1 @@\n-old\n", "cursor-2"))
      .mockReturnValueOnce(last.promise);
    const read = (offset: number) => view === "task"
      ? api.loadTaskDiff(key, baseline, head, "file", generation, offset, null, offset, 1)
      : api.loadDiff(key, "file", view === "staged", generation, offset, null, offset, 1);

    const firstWindow = read(1);
    await vi.waitFor(() => expect(diff).toHaveBeenCalledTimes(2));
    const secondWindow = read(2);
    last.resolve(diffPage("+new\n"));
    const [first, second] = await Promise.all([firstWindow, secondWindow]);
    expect(first.lines.map((line) => line.text)).toEqual(["old"]);
    expect(second.lines.map((line) => line.text)).toEqual(["new"]);
    await read(0);
    expect(diff.mock.calls.map(([request]) => request.cursor)).toEqual([undefined, "cursor-2"]);
  });

  it("keeps different patch parameters and views independent", async () => {
    const generation = await openSession();
    const last = waitForDiff();
    const diff = vi.spyOn(remoteWorktreePort, "diff").mockReturnValue(last.promise);
    const reads = [
      api.loadDiff(key, "file", false, generation, 1),
      api.loadDiff(key, "file", true, generation, 2),
      api.loadDiff(key, "file", false, generation, 3, "before"),
      api.loadDiff(key, "file", false, generation, 4, null, 0, 0, 8),
      api.loadDiff(key, "file", false, generation, 5, null, 0, 0, undefined, true),
      api.loadTaskDiff(key, baseline, head, "file", generation, 6),
      api.loadTaskDiff(key, baseline, "c".repeat(40), "file", generation, 7),
    ];
    last.resolve(diffPage(""));
    await Promise.all(reads);
    expect(diff).toHaveBeenCalledTimes(reads.length);
    expect(diff.mock.calls.map(([{ view, head }]) => [view, head])).toEqual([
      ["unstaged", undefined], ["staged", undefined], ["unstaged", undefined], ["unstaged", undefined],
      ["unstaged", undefined], ["task", head], ["task", "c".repeat(40)],
    ]);
  });

  it("releases a shared failed request so the next read retries", async () => {
    const generation = await openSession();
    const last = waitForDiff();
    const diff = vi.spyOn(remoteWorktreePort, "diff").mockReturnValueOnce(last.promise)
      .mockResolvedValue(diffPage("@@ -0,0 +1 @@\n+retried\n"));
    const read = () => api.loadDiff(key, "file", false, generation, 1);
    const failures = Promise.all([read(), read()].map((result) => expect(result).rejects.toMatchObject({ code: "stale_patch" })));
    last.reject({ code: "stale_patch", message: "changed while reading" });
    await failures;
    expect((await read()).lines.at(-1)?.text).toBe("retried");
    expect(diff).toHaveBeenCalledTimes(2);
  });

  it.each(["refresh", "reconnect", "late SSH error"])("isolates the replacement read after %s", async (action) => {
    const generation = await openSession();
    const old = waitForDiff();
    const next = waitForDiff();
    const diff = vi.spyOn(remoteWorktreePort, "diff").mockResolvedValue(diffPage(""))
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const read = (g: number) => api.loadDiff(key, "file", false, g, 1);
    const original = read(generation);
    vi.spyOn(remoteWorktreePort, "status").mockResolvedValue({ ...snapshot, generation: "state-2" });
    const current = action === "reconnect" ? await openSession("session-2") : (await api.refreshStatus(key, generation, 2)).generation;
    const fresh = read(current);
    if (action === "late SSH error") old.reject({ code: "remote_timeout", message: "old read timed out" });
    else old.resolve(diffPage("old", "obsolete-cursor"));
    await expect(original).rejects.toMatchObject({ code: action === "reconnect" ? "remote_disconnected" : "stale" });
    const shared = read(current);
    next.resolve(diffPage("@@ -0,0 +1 @@\n+fresh\n"));
    for (const result of await Promise.all([fresh, shared, read(current)])) {
      expect(result.lines.at(-1)?.text).toBe("fresh");
    }
    expect(diff).toHaveBeenCalledTimes(2);
  });
});
