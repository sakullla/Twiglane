import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ *
 * 「创建 MR / PR」设置开关（R1 的前端一半）：
 * 默认关闭、旧响应缺字段按关闭、setter 成功后才改界面、写回失败保留旧值。
 * 平台命令与令牌副作用属于 T2，这里不假设存在任何平台调用。
 * ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setChangeRequestsEnabled: vi.fn(),
  setTheme: vi.fn(),
  setPanelWidths: vi.fn(),
  setPullIntegration: vi.fn(),
  setBranchGroups: vi.fn(),
  setFilesView: vi.fn(),
  openRepository: vi.fn(),
  mergeSession: vi.fn(),
  refreshStatus: vi.fn(),
  cancelReads: vi.fn(),
  loadDiff: vi.fn(),
  commitChanges: vi.fn(),
  measureProbe: vi.fn(),
  measureSample: vi.fn(),
  measureFinish: vi.fn(),
  measureWait: vi.fn(),
  listenEvent: vi.fn(),
  pickDirectory: vi.fn(),
  pickFile: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  api: { ...mocks },
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));

import App from "../src/App.svelte";

const baseSettings = {
  theme: "dark",
  panelWidths: { sidebar: 256, files: 360 },
  git: {
    available: true,
    path: "git",
    version: "2.49.0",
    overridden: false,
    belowBaseline: false,
    message: "Git 可用",
  },
  recent: [],
  settingsWarning: null,
};

async function openSettings() {
  render(App);
  await waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
  await fireEvent.click(screen.getByRole("button", { name: "设置" }));
  return (await screen.findByRole("checkbox", { name: /创建 MR \/ PR/ })) as HTMLInputElement;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listenEvent.mockResolvedValue(() => {});
  mocks.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
  mocks.getSettings.mockResolvedValue(baseSettings);
  mocks.setChangeRequestsEnabled.mockResolvedValue(undefined);
  mocks.setTheme.mockResolvedValue(undefined);
  mocks.setPullIntegration.mockResolvedValue(undefined);
  mocks.setBranchGroups.mockResolvedValue(undefined);
  mocks.setFilesView.mockResolvedValue(undefined);
  mocks.setPanelWidths.mockImplementation(async (widths: unknown) => widths);
  mocks.cancelReads.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("创建 MR / PR 设置开关", () => {
  it("新安装与旧响应都没有这个字段时开关关闭，加载不写回", async () => {
    const toggle = await openSettings();
    expect(toggle.checked).toBe(false);
    // 只是读设置：加载过程不触发任何 setter，也不产生平台侧调用。
    expect(mocks.setChangeRequestsEnabled).not.toHaveBeenCalled();
  });

  it("已保存开启时重新打开设置仍显示开启", async () => {
    mocks.getSettings.mockResolvedValue({ ...baseSettings, changeRequestsEnabled: true });
    const toggle = await openSettings();
    expect(toggle.checked).toBe(true);
  });

  it("setter 成功后才把开关显示为开启", async () => {
    const pending = deferred();
    mocks.setChangeRequestsEnabled.mockReturnValue(pending.promise);
    const toggle = await openSettings();

    await fireEvent.click(toggle);
    expect(mocks.setChangeRequestsEnabled).toHaveBeenCalledWith(true);
    // 写入还没回来：界面保持旧值，不能提前表现为已持久化。
    expect(toggle.checked).toBe(false);

    pending.resolve();
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it("写回失败保留旧值并提示，不把未保存的开启当成已持久化", async () => {
    const failure = { code: "settings_write", message: "无法保存设置：磁盘写入被拒绝。" };
    mocks.setChangeRequestsEnabled.mockRejectedValue(failure);
    const toggle = await openSettings();

    await fireEvent.click(toggle);
    // 设置弹窗把背板设为 inert，提示条本身仍在页面上：按文字断言可见的失败说明。
    await waitFor(() =>
      expect(document.querySelector(".toast-text")?.textContent ?? "").toContain(
        "无法保存设置：磁盘写入被拒绝。",
      ),
    );
    expect(toggle.checked).toBe(false);
    expect(mocks.setChangeRequestsEnabled).toHaveBeenCalledTimes(1);
    // 再点一次仍按当前（未保存）的关闭状态请求开启，不会悄悄记成已开启。
    await fireEvent.click(toggle);
    expect(mocks.setChangeRequestsEnabled).toHaveBeenCalledTimes(2);
    expect(mocks.setChangeRequestsEnabled).toHaveBeenLastCalledWith(true);
  });

  it("关闭时只写回开关，不调用平台命令", async () => {
    mocks.getSettings.mockResolvedValue({ ...baseSettings, changeRequestsEnabled: true });
    const toggle = await openSettings();
    expect(toggle.checked).toBe(true);
    await fireEvent.click(toggle);
    expect(mocks.setChangeRequestsEnabled).toHaveBeenCalledWith(false);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(mocks.setTheme).not.toHaveBeenCalled();
    expect(mocks.setFilesView).not.toHaveBeenCalled();
  });
});

describe("原生契约与注册", () => {
  it("前端只经这一个命令写回，且命名保持 camelCase", () => {
    const apiSource = readFileSync("src/lib/api.ts", "utf8");
    expect(apiSource).toContain(
      'invoke<void>("set_change_requests_enabled", { changeRequestsEnabled })',
    );
    const typesSource = readFileSync("src/lib/types.ts", "utf8");
    expect(typesSource).toContain("changeRequestsEnabled?: boolean;");
  });

  it("命令在 build.rs 与主窗口 capability 中登记", () => {
    expect(readFileSync("src-tauri/build.rs", "utf8")).toContain('"set_change_requests_enabled"');
    expect(readFileSync("src-tauri/capabilities/default.json", "utf8")).toContain(
      '"allow-set-change-requests-enabled"',
    );
  });
});
