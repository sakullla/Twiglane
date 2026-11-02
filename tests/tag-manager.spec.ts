import { tick } from "svelte";
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
    await fireEvent.click(screen.getByRole("button", { name: "新建标签" }));
    await fireEvent.input(await screen.findByLabelText("标签名称"), { target: { value: "v2.0.0" } });
    await fireEvent.input(screen.getByLabelText("标签附注"), { target: { value: "second release" } });
    await fireEvent.click(screen.getByRole("button", { name: "创建标签" }));
    await vi.waitFor(() => expect(createTag).toHaveBeenCalledWith("/repo", "v2.0.0", "HEAD", "second release", 3, 7));
    expect(props.onFailure).not.toHaveBeenCalled();
  });

  it("新建表单按需展开：打开时不显示，创建或取消后收起，焦点回到新建按钮", async () => {
    createTag.mockResolvedValue({ generation: 4, tags: [existing], snapshot: { ...opened.snapshot, generation: 4 } });
    renderTags();
    await screen.findByText("v1.0.0");
    expect(screen.queryByLabelText("标签名称")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "新建标签" }));
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("标签名称")));
    expect(screen.queryByText("v1.0.0"), "表单替换列表，不同时铺开").toBeNull();
    await fireEvent.input(screen.getByLabelText("标签名称"), { target: { value: "draft" } });
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "新建标签" })));
    expect(screen.queryByLabelText("标签名称")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "新建标签" }));
    expect((screen.getByLabelText("标签名称") as HTMLInputElement).value, "取消后不留草稿").toBe("");
    await fireEvent.input(screen.getByLabelText("标签名称"), { target: { value: "v2.0.0" } });
    await fireEvent.click(screen.getByRole("button", { name: "创建标签" }));
    await vi.waitFor(() => expect(screen.queryByLabelText("标签名称")).toBeNull());
    expect(createTag).toHaveBeenCalledTimes(1);
  });

  it("创建在途再次提交不会复位写入状态", async () => {
    let finish: (value: unknown) => void = () => {};
    createTag.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderTags();
    await screen.findByText("v1.0.0");
    await fireEvent.click(screen.getByRole("button", { name: "新建标签" }));
    await fireEvent.input(await screen.findByLabelText("标签名称"), { target: { value: "v2" } });
    const form = document.querySelector<HTMLFormElement>("[data-tag-create]")!;
    await fireEvent.submit(form);
    await tick();
    await fireEvent.submit(form);
    await tick();
    expect(createTag).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "取消" }).hasAttribute("disabled")).toBe(true);
    finish({ generation: 4, tags: [existing], snapshot: opened.snapshot });
    await vi.waitFor(() => expect(document.querySelector("[data-tag-create]")).toBeNull());
  });

  it("创建失败时表单留着，焦点回到名称", async () => {
    createTag.mockRejectedValue({ code: "unknown", message: "已存在" });
    const props = renderTags();
    await screen.findByText("v1.0.0");
    await fireEvent.click(screen.getByRole("button", { name: "新建标签" }));
    await fireEvent.input(screen.getByLabelText("标签名称"), { target: { value: "v1.0.0" } });
    await fireEvent.click(screen.getByRole("button", { name: "创建标签" }));
    await vi.waitFor(() => expect(props.onFailure).toHaveBeenCalled());
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("标签名称")));
    expect((screen.getByLabelText("标签名称") as HTMLInputElement).value).toBe("v1.0.0");
  });

  it("创建写入在途时取消禁用、Esc 不收起", async () => {
    let finish: (value: unknown) => void = () => {};
    createTag.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    renderTags();
    await screen.findByText("v1.0.0");
    await fireEvent.click(screen.getByRole("button", { name: "新建标签" }));
    const input = screen.getByLabelText("标签名称");
    await fireEvent.input(input, { target: { value: "v2.0.0" } });
    await fireEvent.click(screen.getByRole("button", { name: "创建标签" }));
    await vi.waitFor(() => expect(createTag).toHaveBeenCalled());
    await tick();
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.keyDown(input, { key: "Escape" });
    await tick();
    expect(screen.queryByLabelText("标签名称")).toBeTruthy();
    finish({ generation: 4, tags: [existing], snapshot: { ...opened.snapshot, generation: 4 } });
    await vi.waitFor(() => expect(screen.queryByLabelText("标签名称")).toBeNull());
  });

  it("删除确认替换列表，焦点在取消上；Esc 和取消后回到触发按钮", async () => {
    renderTags();
    await screen.findByText("v1.0.0");
    const trigger = screen.getByRole("button", { name: "删除标签 v1.0.0" });
    const list = document.querySelector<HTMLElement>(".tag-list")!;
    trigger.focus();
    await fireEvent.click(trigger);
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("取消"));
    expect(list.hidden).toBe(true);
    await fireEvent.click(document.activeElement!);
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(list.hidden).toBe(false);

    await fireEvent.click(trigger);
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("取消"));
    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("删除写入在途时取消禁用、Esc 不收起，失败后回到触发按钮", async () => {
    let fail: (reason: unknown) => void = () => {};
    deleteTag.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    renderTags();
    await screen.findByText("v1.0.0");
    const trigger = screen.getByRole("button", { name: "删除标签 v1.0.0" });
    trigger.focus();
    await fireEvent.click(trigger);
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("取消"));
    await fireEvent.click(screen.getByRole("button", { name: "确认删除标签" }));
    await vi.waitFor(() => expect(deleteTag).toHaveBeenCalled());
    await tick();
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
    const box = document.querySelector<HTMLElement>(".tag-manager [role='alert']")!;
    expect(document.activeElement).toBe(box);
    await fireEvent.keyDown(box, { key: "Escape" });
    await tick();
    expect(document.querySelector(".tag-manager [role='alert'] .btn-danger")).toBeTruthy();
    fail({ code: "unknown", message: "删不掉" });
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("重试后焦点落在搜索框，不随按钮一起消失", async () => {
    tagState.mockReset();
    tagState.mockRejectedValueOnce({ code: "unknown", message: "读不到" });
    renderTags();
    const retry = await screen.findByRole("button", { name: "重试" });
    retry.focus();
    tagState.mockResolvedValueOnce({ generation: 3, tags: [existing], snapshot: opened.snapshot });
    await fireEvent.click(retry);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "搜索标签" }));
    await screen.findByText("v1.0.0");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "搜索标签" }));
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
    await vi.waitFor(() => expect(screen.queryByText("v1.0.0")).toBeNull());
  });

  it("自身不创建 dialog，因此可以嵌在分支 modal 的同一层里", async () => {
    renderTags();
    await screen.findByText("v1.0.0");
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });
});
