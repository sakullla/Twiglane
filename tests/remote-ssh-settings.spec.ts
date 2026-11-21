import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ *
 * 远程 SSH 主机簿（R3 的前端一半）：
 * 总开关缺省关闭、写回成功后才改界面、逐台启停、可取消测试、
 * 密码只经 setRemoteSshPassword 进入原生，失败保留草稿。
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
  remoteSshSettings: vi.fn(),
  setRemoteSshEnabled: vi.fn(),
  saveRemoteSshTarget: vi.fn(),
  deleteRemoteSshTarget: vi.fn(),
  setRemoteSshPassword: vi.fn(),
  deleteRemoteSshPassword: vi.fn(),
  testRemoteSsh: vi.fn(),
  cancelRemoteSsh: vi.fn(),
  installRemoteSshAgent: vi.fn(),
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

const host = {
  id: "host-a",
  displayName: "构建机",
  host: "build.example.com",
  port: 2222,
  user: "deploy",
  authMethod: "key",
  identityFile: "/home/deploy/.ssh/id_ed25519",
  sshConfig: null,
  defaultPath: "/srv/app",
  enabled: true,
  sharedHostId: null,
  revision: 1,
  hasPassword: false,
};

async function openSettings() {
  render(App);
  await waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
  await fireEvent.click(screen.getByRole("button", { name: "设置" }));
}

async function sshToggle() {
  return (await screen.findByRole("checkbox", { name: "启用远程 SSH" })) as HTMLInputElement;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
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
  mocks.setTheme.mockResolvedValue(undefined);
  mocks.setPullIntegration.mockResolvedValue(undefined);
  mocks.setBranchGroups.mockResolvedValue(undefined);
  mocks.setFilesView.mockResolvedValue(undefined);
  mocks.setChangeRequestsEnabled.mockResolvedValue(undefined);
  mocks.setPanelWidths.mockImplementation(async (widths: unknown) => widths);
  mocks.cancelReads.mockResolvedValue(undefined);
  mocks.remoteSshSettings.mockResolvedValue({ enabled: false, targets: [] });
  mocks.setRemoteSshEnabled.mockResolvedValue(undefined);
  mocks.saveRemoteSshTarget.mockImplementation(async (target: unknown) => ({
    ...(target as object),
    revision: 1,
    hasPassword: false,
  }));
  mocks.deleteRemoteSshTarget.mockResolvedValue(undefined);
  mocks.setRemoteSshPassword.mockResolvedValue(undefined);
  mocks.deleteRemoteSshPassword.mockResolvedValue(undefined);
  mocks.cancelRemoteSsh.mockResolvedValue(undefined);
  mocks.installRemoteSshAgent.mockResolvedValue({ kind: "reused", version: "0.3.40" });
});

afterEach(() => {
  cleanup();
});

describe("远程 SSH 总开关", () => {
  it("新安装与旧响应都读成关闭，加载时不写回", async () => {
    await openSettings();
    const toggle = await sshToggle();
    expect(toggle.checked).toBe(false);
    expect(mocks.setRemoteSshEnabled).not.toHaveBeenCalled();
  });

  it("已保存开启时显示开启", async () => {
    mocks.remoteSshSettings.mockResolvedValue({ enabled: true, targets: [host] });
    await openSettings();
    expect((await sshToggle()).checked).toBe(true);
  });

  it("写回成功后才显示开启", async () => {
    const pending = deferred();
    mocks.setRemoteSshEnabled.mockReturnValue(pending.promise);
    await openSettings();
    const toggle = await sshToggle();
    await fireEvent.click(toggle);
    expect(mocks.setRemoteSshEnabled).toHaveBeenCalledWith(true);
    expect(toggle.checked).toBe(false);
    pending.resolve();
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it("写回失败保留关闭并给出原因", async () => {
    mocks.setRemoteSshEnabled.mockRejectedValue({
      code: "settings_write",
      message: "无法保存设置：磁盘写入被拒绝。",
    });
    await openSettings();
    const toggle = await sshToggle();
    await fireEvent.click(toggle);
    await waitFor(() =>
      expect(document.querySelector('[data-ssh-message="error"]')?.textContent ?? "").toContain(
        "无法保存设置：磁盘写入被拒绝。",
      ),
    );
    expect(toggle.checked).toBe(false);
  });

  it("关闭时不能测试连接，主机列表仍然可见", async () => {
    mocks.remoteSshSettings.mockResolvedValue({ enabled: false, targets: [host] });
    await openSettings();
    const button = await screen.findByRole("button", { name: "测试连接" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-ssh-target="host-a"]')?.textContent ?? "").toContain("构建机");
  });
});

describe("主机增删改与密码", () => {
  it("添加主机按 camelCase 提交，成功后才关掉草稿", async () => {
    mocks.remoteSshSettings.mockResolvedValue({ enabled: true, targets: [] });
    await openSettings();
    await fireEvent.click(await screen.findByRole("button", { name: "添加主机" }));
    await fireEvent.input(screen.getByLabelText("显示名"), { target: { value: "新主机" } });
    await fireEvent.input(screen.getByLabelText("主机"), { target: { value: "new.example.com" } });
    await fireEvent.input(screen.getByLabelText("用户名"), { target: { value: "ops" } });
    await fireEvent.click(screen.getByRole("button", { name: "保存主机" }));

    await waitFor(() => expect(mocks.saveRemoteSshTarget).toHaveBeenCalledTimes(1));
    const submitted = mocks.saveRemoteSshTarget.mock.calls[0][0] as Record<string, unknown>;
    expect(submitted.displayName).toBe("新主机");
    expect(submitted.host).toBe("new.example.com");
    expect(submitted.user).toBe("ops");
    expect(submitted.port).toBe(22);
    expect(submitted.enabled).toBe(true);
    // 修订由存储推进，前端不提交。
    expect(submitted.revision).toBeUndefined();
    await waitFor(() => expect(screen.getByText("新主机")).toBeTruthy());
  });

  it("保存失败保留草稿，字段不丢", async () => {
    mocks.remoteSshSettings.mockResolvedValue({ enabled: true, targets: [] });
    mocks.saveRemoteSshTarget.mockRejectedValue({
      code: "ssh_target_invalid",
      message: "主机记录无效：请填写主机、用户名与 1-65535 之间的端口。",
    });
    await openSettings();
    await fireEvent.click(await screen.findByRole("button", { name: "添加主机" }));
    await fireEvent.input(screen.getByLabelText("显示名"), { target: { value: "草稿机" } });
    await fireEvent.input(screen.getByLabelText("主机"), { target: { value: "draft.example.com" } });
    await fireEvent.click(screen.getByRole("button", { name: "保存主机" }));

    await waitFor(() =>
      expect(document.querySelector('[data-ssh-message="error"]')?.textContent ?? "").toContain(
        "主机记录无效",
      ),
    );
    expect((screen.getByLabelText("显示名") as HTMLInputElement).value).toBe("草稿机");
    expect((screen.getByLabelText("主机") as HTMLInputElement).value).toBe("draft.example.com");
  });

  it("密码只经专用命令写入，列表仍只显示是否有密码", async () => {
    mocks.remoteSshSettings.mockResolvedValue({ enabled: true, targets: [host] });
    await openSettings();
    await fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    await fireEvent.change(screen.getByLabelText("认证方式"), { target: { value: "password" } });
    await fireEvent.input(screen.getByLabelText("SSH 密码"), { target: { value: "hunter2" } });
    await fireEvent.click(screen.getByRole("button", { name: "保存密码" }));

    await waitFor(() =>
      expect(mocks.setRemoteSshPassword).toHaveBeenCalledWith("host-a", "hunter2"),
    );
    // 前端不回读密码：列表只有布尔状态。
    expect(document.body.textContent ?? "").not.toContain("hunter2");
    await waitFor(() =>
      expect(document.querySelector('[data-ssh-target="host-a"]')?.textContent ?? "").toContain(
        "已保存密码",
      ),
    );
  });

  it("逐台启停走同一条保存命令", async () => {
    mocks.remoteSshSettings.mockResolvedValue({ enabled: true, targets: [host] });
    await openSettings();
    await fireEvent.click(await screen.findByRole("button", { name: "停用" }));
    await waitFor(() => expect(mocks.saveRemoteSshTarget).toHaveBeenCalledTimes(1));
    const submitted = mocks.saveRemoteSshTarget.mock.calls[0][0] as Record<string, unknown>;
    expect(submitted.id).toBe("host-a");
    expect(submitted.enabled).toBe(false);
  });
});

describe("连接测试与远端组件", () => {
  it("测试走 requestId，可取消，失败时提示真实原因", async () => {
    mocks.remoteSshSettings.mockResolvedValue({ enabled: true, targets: [host] });
    const pending = deferred();
    mocks.testRemoteSsh.mockReturnValue(pending.promise);
    await openSettings();
    await fireEvent.click(await screen.findByRole("button", { name: "测试连接" }));

    await waitFor(() => expect(mocks.testRemoteSsh).toHaveBeenCalledTimes(1));
    const requestId = mocks.testRemoteSsh.mock.calls[0][0] as string;
    expect(requestId.length).toBeGreaterThan(8);
    expect(mocks.testRemoteSsh.mock.calls[0][1]).toBe("host-a");

    await fireEvent.click(await screen.findByRole("button", { name: "取消测试" }));
    expect(mocks.cancelRemoteSsh).toHaveBeenCalledWith(requestId);

    pending.reject({ code: "remote_cancelled", message: "连接测试已取消。" });
    await waitFor(() =>
      expect(document.querySelector('[data-ssh-test="failed"]')?.textContent ?? "").toContain(
        "连接测试已取消。",
      ),
    );
  });

  it("迟到的成功结果被丢弃，不覆盖当前请求", async () => {
    const other = { ...host, id: "host-b", displayName: "第二台", host: "second.example.com" };
    mocks.remoteSshSettings.mockResolvedValue({ enabled: true, targets: [host, other] });
    const stale = deferred<unknown>();
    const current = deferred<unknown>();
    mocks.testRemoteSsh
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    await openSettings();

    const testButtons = async () =>
      (await screen.findAllByRole("button", { name: "测试连接" })) as HTMLButtonElement[];
    await fireEvent.click((await testButtons())[0]);
    await waitFor(() => expect(mocks.testRemoteSsh).toHaveBeenCalledTimes(1));
    const staleRequestId = mocks.testRemoteSsh.mock.calls[0][0] as string;

    // 真实界面在测试进行中禁用按钮；这里先确认它确实被禁用，再临时去掉该属性派发一次
    // 点击，模拟两次请求重叠（例如取消赢了竞争、原生又回包一次），以覆盖归属校验。
    const second = (await testButtons())[1];
    expect(second.disabled).toBe(true);
    second.disabled = false;
    second.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(mocks.testRemoteSsh).toHaveBeenCalledTimes(2));
    const currentRequestId = mocks.testRemoteSsh.mock.calls[1][0] as string;
    expect(currentRequestId).not.toBe(staleRequestId);

    // 旧的请求成功了，但它已经不属于当前状态：不能显示"连接成功"。
    stale.resolve({
      targetId: "host-a",
      displayName: "构建机",
      effectiveHost: "10.9.0.4",
      configRevision: "a".repeat(64),
      peerRevision: "b".repeat(64),
      peerIdentity: "c".repeat(64),
      system: "Linux",
      architecture: "x86_64",
      git: "git version 2.45.0",
      agentInstalled: true,
      agentVersion: "0.3.40",
      agentDigest: "d".repeat(64),
      agentCompatible: true,
      hops: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(staleRequestId.length).toBeGreaterThan(8);
    expect(document.querySelector('[data-ssh-test="ok"]')).toBeNull();
    expect(document.querySelector('[data-ssh-test="running"]')?.textContent ?? "").toContain(
      "正在测试连接",
    );

    // 当前的请求成功后照常显示，证明丢弃只针对过期请求。
    current.resolve({
      targetId: "host-b",
      displayName: "第二台",
      effectiveHost: "10.9.0.5",
      configRevision: "e".repeat(64),
      peerRevision: "f".repeat(64),
      peerIdentity: "1".repeat(64),
      system: "Linux",
      architecture: "aarch64",
      git: "git version 2.45.0",
      agentInstalled: false,
      agentVersion: null,
      agentDigest: null,
      agentCompatible: false,
      hops: [],
    });
    await waitFor(() =>
      expect(document.querySelector('[data-ssh-test="ok"]')?.textContent ?? "").toContain(
        "连接成功",
      ),
    );
  });

  it("兼容的远端组件只报告可复用，不触发传输", async () => {
    mocks.remoteSshSettings.mockResolvedValue({ enabled: true, targets: [host] });
    mocks.testRemoteSsh.mockResolvedValue({
      targetId: "host-a",
      displayName: "构建机",
      effectiveHost: "10.9.0.4",
      configRevision: "a".repeat(64),
      peerRevision: "b".repeat(64),
      peerIdentity: "c".repeat(64),
      system: "Linux",
      architecture: "x86_64",
      git: "git version 2.45.0",
      agentInstalled: true,
      agentVersion: "0.3.40",
      agentDigest: "d".repeat(64),
      agentCompatible: true,
      hops: [],
    });
    await openSettings();
    await fireEvent.click(await screen.findByRole("button", { name: "测试连接" }));
    await waitFor(() =>
      expect(document.querySelector('[data-ssh-test="ok"]')?.textContent ?? "").toContain(
        "可复用",
      ),
    );
    expect(screen.queryByRole("button", { name: "安装远端组件" })).toBeNull();
    expect(mocks.installRemoteSshAgent).not.toHaveBeenCalled();
  });

  it("缺少匹配组件时提示需要安装，而不是假装连接成功", async () => {
    mocks.remoteSshSettings.mockResolvedValue({ enabled: true, targets: [host] });
    mocks.testRemoteSsh.mockResolvedValue({
      targetId: "host-a",
      displayName: "构建机",
      effectiveHost: "10.9.0.4",
      configRevision: "a".repeat(64),
      peerRevision: "b".repeat(64),
      peerIdentity: "c".repeat(64),
      system: "Linux",
      architecture: "aarch64",
      git: "git version 2.45.0",
      agentInstalled: false,
      agentVersion: null,
      agentDigest: null,
      agentCompatible: false,
      hops: [],
    });
    await openSettings();
    await fireEvent.click(await screen.findByRole("button", { name: "测试连接" }));
    const install = await screen.findByRole("button", { name: "安装远端组件" });
    expect(install).toBeTruthy();
  });
});
