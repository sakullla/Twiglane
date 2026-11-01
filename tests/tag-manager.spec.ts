import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenedRepository } from "../src/lib/types";

const tagState = vi.hoisted(() => vi.fn());
const createTag = vi.hoisted(() => vi.fn());
const deleteTag = vi.hoisted(() => vi.fn());
const pushTag = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", () => ({ api: { tagState, createTag, deleteTag, pushTag } }));

import TagManager from "../src/lib/components/TagManager.svelte";

const opened: OpenedRepository = {
  summary: { name: "demo", path: "/repo" },
  generation: 3,
  snapshot: {
    generation: 3,
    branch: {
      name: "main",
      detached: false,
      unborn: false,
      headOid: "a".repeat(40),
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      liveRemoteChecked: true,
      remoteCheckedAtMs: 1,
      remoteCheckStale: false,
    },
    files: [],
  },
  draft: "",
  watchDegraded: false,
};

const existing = {
  name: "v1.0.0",
  targetOid: "a".repeat(40),
  message: "release",
  createdAt: 1_700_000_000,
};

function renderTags(onOpenHistory = vi.fn()) {
  const props = {
    opened,
    disabled: false,
    onBusy: vi.fn(),
    onSnapshot: vi.fn(),
    onFailure: vi.fn(),
    onNotice: vi.fn(),
    onOpenHistory,
    nextId: () => 7,
  };
  render(TagManager, { props });
  return props;
}

describe("标签管理", () => {
  beforeEach(() => {
    tagState.mockReset();
    createTag.mockReset();
    deleteTag.mockReset();
    pushTag.mockReset();
    tagState.mockResolvedValue({ generation: 3, tags: [existing], snapshot: opened.snapshot });
  });

  it("创建标签、推送并跳转到完整目标 Hash", async () => {
    createTag.mockResolvedValue({ generation: 4, tags: [existing, { ...existing, name: "v2.0.0" }], snapshot: { ...opened.snapshot, generation: 4 } });
    pushTag.mockResolvedValue({ generation: 5, tags: [existing], snapshot: { ...opened.snapshot, generation: 5 } });
    const onOpenHistory = vi.fn();
    const props = renderTags(onOpenHistory);
    await fireEvent.click(await screen.findByRole("button", { name: "推送" }));
    await vi.waitFor(() => expect(pushTag).toHaveBeenCalledWith("/repo", "origin", "v1.0.0", 3, 7));
    await fireEvent.click(screen.getByRole("button", { name: "查看提交" }));
    expect(onOpenHistory).toHaveBeenCalledWith("a".repeat(40));
    await fireEvent.input(await screen.findByLabelText("标签名称"), { target: { value: "v2.0.0" } });
    await fireEvent.input(screen.getByLabelText("标签附注"), { target: { value: "second release" } });
    await fireEvent.click(screen.getByRole("button", { name: "创建标签" }));
    await vi.waitFor(() => expect(createTag).toHaveBeenCalledWith("/repo", "v2.0.0", "HEAD", "second release", 3, 7));
    expect(props.onFailure).not.toHaveBeenCalled();
  });

  it("确认后才删除本地标签", async () => {
    deleteTag.mockResolvedValue({ generation: 4, tags: [], snapshot: { ...opened.snapshot, generation: 4 } });
    renderTags();
    await fireEvent.click(await screen.findByRole("button", { name: "删除标签 v1.0.0" }));
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(deleteTag).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "删除标签 v1.0.0" }));
    await fireEvent.click(screen.getByRole("button", { name: "确认删除标签" }));
    await vi.waitFor(() => expect(deleteTag).toHaveBeenCalledWith("/repo", "v1.0.0", true, 3, 7));
    expect(screen.queryByText("v1.0.0")).toBeNull();
  });
});
