import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ *
 * 设置：左侧分区目录 + 搜索收窄；「合并请求」分区管理记住的自建 GitLab 实例。
 * ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
  remoteSshSettings: vi.fn(),
  changeRequestInstances: vi.fn(),
  saveChangeRequestInstance: vi.fn(),
  deleteChangeRequestInstance: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  api: mocks,
  appVersion: () => Promise.resolve("0.3.48"),
  pickFile: vi.fn(),
}));

import SettingsModal from "../src/lib/components/SettingsModal.svelte";

const entry = { host: "git.dev.example.com", url: "http://git.dev.example.com", savedAtMs: 1, tokenConfigured: true };

function show(section: string | null = null) {
  return render(SettingsModal, {
    props: {
      theme: "dark",
      git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "ok" },
      disabled: false,
      section,
      onClose: vi.fn(),
      onTheme: vi.fn(),
      onRedetect: vi.fn(),
      onChooseGit: vi.fn(),
      onClearGit: vi.fn(),
    } as never,
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.remoteSshSettings.mockResolvedValue({ enabled: false, targets: [] });
  mocks.changeRequestInstances.mockResolvedValue([entry]);
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("设置分区目录", () => {
  it("目录列出全部分区，搜索只留下匹配的分区", async () => {
    show();
    const nav = await screen.findByRole("navigation", { name: "设置分区" });
    expect(within(nav).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "外观", "仓库", "合并请求", "终端", "远程 SSH", "运行环境", "应用更新",
    ]);
    await fireEvent.input(screen.getByLabelText("搜索设置"), { target: { value: "gitlab" } });
    await waitFor(() => expect(within(nav).getAllByRole("button")).toHaveLength(1));
    expect(document.querySelector<HTMLElement>('[data-settings-section="change-request"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-settings-section="appearance"]')!.hidden).toBe(true);
  });

  it("section=changeRequest 时首焦点落在合并请求分区", async () => {
    show("changeRequest");
    const section = document.querySelector<HTMLElement>('[data-settings-section="change-request"]')!;
    await waitFor(() => expect(section.contains(document.activeElement)).toBe(true));
  });
});

describe("记住的自建 GitLab 实例", () => {
  it("列出实例，删除时可以选择是否连同令牌删除", async () => {
    mocks.deleteChangeRequestInstance.mockResolvedValue([]);
    show();
    const list = await screen.findByRole("list", { name: "记住的 GitLab 实例" });
    expect(list.textContent).toContain("git.dev.example.com");
    expect(list.textContent).toContain("令牌已保存");

    await fireEvent.click(within(list).getByRole("button", { name: "删除 git.dev.example.com" }));
    await fireEvent.click(within(list).getByRole("button", { name: "连同令牌删除" }));
    await waitFor(() => expect(mocks.deleteChangeRequestInstance).toHaveBeenCalledWith("git.dev.example.com", true));
    await waitFor(() => expect(screen.queryByRole("list", { name: "记住的 GitLab 实例" })).toBeNull());
  });

  it("可以手动添加实例", async () => {
    mocks.changeRequestInstances.mockResolvedValue([]);
    mocks.saveChangeRequestInstance.mockResolvedValue([entry]);
    show();
    await fireEvent.click(await screen.findByRole("button", { name: "添加实例" }));
    await fireEvent.input(screen.getByLabelText(/远程主机名/), { target: { value: "git.dev.example.com" } });
    await fireEvent.input(screen.getByLabelText(/实例地址/), { target: { value: "http://git.dev.example.com" } });
    await fireEvent.click(screen.getByRole("button", { name: "保存实例" }));
    await waitFor(() => expect(mocks.saveChangeRequestInstance).toHaveBeenCalledWith("git.dev.example.com", "http://git.dev.example.com"));
    expect(await screen.findByRole("list", { name: "记住的 GitLab 实例" })).toBeTruthy();
  });
});
