import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenedRepository } from "../src/lib/types";

const branchState = vi.hoisted(() => vi.fn());
const switchBranch = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", () => ({
  api: {
    branchState,
    switchBranch,
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
    deleteRemoteBranch: vi.fn(),
  },
}));

import BranchDialog from "../src/lib/components/BranchDialog.svelte";

const opened: OpenedRepository = {
  summary: { name: "demo", path: "/repo" },
  generation: 4,
  snapshot: {
    generation: 4,
    branch: {
      name: "feature/ui",
      detached: false,
      unborn: false,
      headOid: "a".repeat(40),
      upstream: "origin/feature/ui",
      ahead: 2,
      behind: 1,
      liveRemoteChecked: true,
      remoteCheckedAtMs: 1,
      remoteCheckStale: false,
    },
    files: [],
  },
  draft: "",
  watchDegraded: false,
};

function props(overrides: { onClose?: () => void; onSnapshot?: (snapshot: OpenedRepository["snapshot"]) => void } = {}) {
  return {
    opened,
    disabled: false,
    onClose: overrides.onClose ?? vi.fn(),
    onBusy: vi.fn(),
    onSnapshot: overrides.onSnapshot ?? vi.fn(),
    onFailure: vi.fn(),
    onNotice: vi.fn(),
    nextId: () => 9,
  };
}

describe("分支管理", () => {
  beforeEach(() => {
    branchState.mockReset();
    switchBranch.mockReset();
    branchState.mockResolvedValue({
      generation: 4,
      branches: [
        { name: "feature/ui", remote: false, current: true, upstream: "origin/feature/ui", worktree: null },
        { name: "main", remote: false, current: false, upstream: "origin/main", worktree: null },
      ],
      snapshot: opened.snapshot,
    });
  });

  it("切换成功后更新状态并自动关闭", async () => {
    const onClose = vi.fn();
    const onSnapshot = vi.fn();
    const nextSnapshot = {
      ...opened.snapshot,
      generation: 5,
      branch: { ...opened.snapshot.branch, name: "main", upstream: "origin/main", ahead: 0, behind: 0 },
    };
    switchBranch.mockResolvedValue({
      generation: 5,
      branches: [{ name: "main", remote: false, current: true, upstream: "origin/main", worktree: null }],
      snapshot: nextSnapshot,
    });
    const current = props({ onClose, onSnapshot });
    render(BranchDialog, { props: current });
    await fireEvent.click(await screen.findByRole("button", { name: "切换到 main" }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(switchBranch).toHaveBeenCalledWith("/repo", "main", 4, 9);
    expect(onSnapshot).toHaveBeenCalledWith(nextSnapshot);
    expect(current.onNotice).toHaveBeenCalledWith("已切换到 main");
    expect(current.onBusy).toHaveBeenLastCalledWith(null);
  });

  it("关闭按钮始终调用关闭回调", async () => {
    const onClose = vi.fn();
    render(BranchDialog, { props: props({ onClose }) });
    await screen.findByRole("button", { name: "切换到 main" });
    await fireEvent.click(screen.getByRole("button", { name: /^关闭$/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
