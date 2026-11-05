import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsModal from "../src/lib/components/SettingsModal.svelte";
import { resetUpdateState, setUpdateOffer, updateState, watchUpdateAvailable } from "../src/lib/update.svelte";

/* ------------------------------------------------------------------ *
 * 应用内更新（R1/R2）：事件 → 共享 offer store → 设置弹窗「应用更新」分区。
 * 手法循 tests/app-shell.spec.ts 的 vi.mock("../src/lib/api") + vi.hoisted
 * 与 tests/modal.spec.ts 的直接 render(SettingsModal)；updater/process 插件
 * 以叶子模块为单位整体 mock，事件负载与下载回调由测试注入。
 * ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => {
  const explicit = {
    getSettings: vi.fn(),
    measureProbe: vi.fn(),
    listenEvent: vi.fn(async (_name: string, _handler: (payload: unknown) => void) => () => {}),
    pickDirectory: vi.fn(async () => null),
    pickFile: vi.fn(async () => null),
    appVersion: vi.fn(async () => "0.2.17"),
  };
  const extra = new Map<string, ReturnType<typeof vi.fn>>();
  const api = new Proxy(explicit as Record<string, unknown>, {
    get: (target, key: string) => {
      if (key in target) return target[key];
      if (!extra.has(key)) extra.set(key, vi.fn(async () => undefined));
      return extra.get(key);
    },
  });
  return {
    ...explicit,
    api,
    check: vi.fn(),
    relaunch: vi.fn(),
  };
});

vi.mock("../src/lib/api", () => ({
  api: mocks.api,
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
  appVersion: mocks.appVersion,
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

import App from "../src/App.svelte";
import * as updateModule from "../src/lib/update.svelte";

/** 非原生环境没有 __TAURI_INTERNALS__，原生分支的测试先补上再渲染。 */
function stubNative() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

function unstubNative() {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

/** installUpdate 传给 downloadAndInstall 的回调形状；事件由测试注入。 */
type InstallFn = (onEvent: (event: unknown) => void) => Promise<void>;

function fakeUpdate(overrides: Partial<{ version: string; body: string; downloadAndInstall: InstallFn }> = {}) {
  return {
    version: "0.3.0",
    body: "修复若干问题\n优化大仓库性能",
    downloadAndInstall: vi.fn(async () => {}),
    ...overrides,
  };
}

/** 直接渲染设置弹窗的最小 props（tests/modal.spec.ts 先例）。 */
function renderSettings(options: { section?: "update" } = {}) {
  const view = render(SettingsModal, {
    props: {
      theme: "dark" as const,
      git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" },
      disabled: false,
      onClose: vi.fn(),
      onTheme: vi.fn(),
      onRedetect: vi.fn(),
      onChooseGit: vi.fn(),
      onClearGit: vi.fn(),
      section: options.section ?? null,
    },
  });
  const section = document.querySelector<HTMLElement>('[data-settings-section="update"]')!;
  expect(section, "设置弹窗要有应用更新分区").toBeTruthy();
  return { view, section };
}

const SETTINGS_DTO = {
  theme: "dark",
  panelWidths: { sidebar: 256, files: 360 },
  git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" },
  recent: [],
  settingsWarning: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetUpdateState();
  unstubNative();
  mocks.getSettings.mockResolvedValue(SETTINGS_DTO);
  mocks.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
  mocks.appVersion.mockResolvedValue("0.2.17");
  mocks.relaunch.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  unstubNative();
});

describe("更新事件与共享 store", () => {
  it("App 挂载时注册更新监听（watchUpdateAvailable 接线）", async () => {
    const spy = vi.spyOn(updateModule, "watchUpdateAvailable");
    render(App);
    await waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    spy.mockRestore();
  });

  it("原生环境注册 twiglane:update-available，事件负载写入共享 store", async () => {
    stubNative();
    const handlers = new Map<string, (payload: unknown) => void>();
    mocks.listenEvent.mockImplementation(async (name: string, handler: (payload: unknown) => void) => {
      handlers.set(name, handler);
      return () => {};
    });
    await watchUpdateAvailable();
    const handler = handlers.get("twiglane:update-available");
    expect(handler, "应注册更新事件监听").toBeTypeOf("function");
    handler!({ version: "0.3.0", notes: "修复若干问题", installSupported: true });
    await tick();
    expect(updateState.offer).toEqual({ version: "0.3.0", notes: "修复若干问题" });
    expect(updateState.installSupported).toBe(true);
  });

  it("非原生环境不注册监听；注册失败也静默不抛错", async () => {
    await expect(watchUpdateAvailable()).resolves.toBeTypeOf("function");
    expect(mocks.listenEvent).not.toHaveBeenCalled();

    stubNative();
    mocks.listenEvent.mockRejectedValueOnce(new Error("listen 不可用"));
    await expect(watchUpdateAvailable()).resolves.toBeTypeOf("function");
  });
});

describe("设置弹窗应用更新分区", () => {
  it("显示当前版本号与初始状态，手动检查前不出现安装动作", async () => {
    stubNative();
    const { section } = renderSettings();
    await waitFor(() => expect(within(section).getByText("0.2.17"), "当前版本号来自 getVersion").toBeTruthy());
    expect(within(section).getByText("启动后会自动检查新版本，也可以现在手动检查。")).toBeTruthy();
    expect(within(section).getByRole("button", { name: "检查更新" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "下载并安装" })).toBeNull();
  });

  it("手动检查发现新版本：展示版本、更新说明并写入共享 store", async () => {
    stubNative();
    mocks.check.mockResolvedValue(fakeUpdate());
    const { section } = renderSettings();
    await fireEvent.click(within(section).getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(within(section).getByText("发现新版本 0.3.0。")).toBeTruthy());
    expect(within(section).getByText("0.3.0 更新说明"), "说明标题带新版本号").toBeTruthy();
    const notes = section.querySelector(".update-notes")!;
    expect(notes.tagName).toBe("PRE");
    expect(notes.textContent).toBe("修复若干问题\n优化大仓库性能");
    expect(updateState.offer).toEqual({ version: "0.3.0", notes: "修复若干问题\n优化大仓库性能" });
    expect(within(section).getByRole("button", { name: "下载并安装" })).toBeTruthy();
    await waitFor(() => expect(within(section).getByText(/上次检查/)).toBeTruthy());
  });

  it("手动检查无更新：显示已是最新并清空共享 offer", async () => {
    stubNative();
    setUpdateOffer({ version: "0.3.0", notes: "旧提示" });
    mocks.check.mockResolvedValue(null);
    const { section } = renderSettings();
    await fireEvent.click(within(section).getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(within(section).getByText("已是最新版本。")).toBeTruthy());
    expect(updateState.offer).toBeNull();
    expect(within(section).getByText(/上次检查/).textContent, "记录最近检查时间").toMatch(/上次检查/);
    expect(screen.queryByRole("button", { name: "下载并安装" })).toBeNull();
  });

  it("手动检查失败：显示失败原因，可再次检查", async () => {
    stubNative();
    mocks.check.mockRejectedValueOnce(new Error("网络不可用"));
    const { section } = renderSettings();
    await fireEvent.click(within(section).getByRole("button", { name: "检查更新" }));
    const status = await waitFor(() => within(section).getByText("更新失败：网络不可用"));
    expect(status.getAttribute("role")).toBe("alert");
    const retry = within(section).getByRole("button", { name: "检查更新" }) as HTMLButtonElement;
    expect(retry.disabled, "失败后可重试").toBe(false);
    mocks.check.mockResolvedValue(fakeUpdate());
    await fireEvent.click(retry);
    await waitFor(() => expect(within(section).getByText("发现新版本 0.3.0。")).toBeTruthy());
  });
});

describe("下载并安装", () => {
  async function arriveAtOffer(downloadAndInstall: InstallFn) {
    mocks.check.mockResolvedValue(fakeUpdate({ downloadAndInstall }));
    stubNative();
    const { section } = renderSettings();
    await fireEvent.click(within(section).getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(within(section).getByRole("button", { name: "下载并安装" })).toBeTruthy());
    return { section };
  }

  it("下载进度累加（Started 总量 + Progress 增量），完成后调用 relaunch", async () => {
    let finish!: () => void;
    const downloadAndInstall = vi.fn(async (onEvent: (event: unknown) => void) => {
      onEvent({ event: "Started", data: { contentLength: 20_000_000 } });
      onEvent({ event: "Progress", data: { chunkLength: 10_000_000 } });
      onEvent({ event: "Progress", data: { chunkLength: 5_000_000 } });
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    const { section } = await arriveAtOffer(downloadAndInstall);
    await fireEvent.click(within(section).getByRole("button", { name: "下载并安装" }));
    const bar = await waitFor(() => within(section).getByRole("progressbar", { name: "下载进度" }));
    await waitFor(() => expect(bar.getAttribute("aria-valuenow")).toBe("75"));
    expect(within(section).getByText(/75%/)).toBeTruthy();
    expect(within(section).getByText(/14\.3 MB \/ 19\.1 MB/)).toBeTruthy();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(mocks.relaunch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(section).getByText("已安装新版本，即将重启…")).toBeTruthy());
  });

  it("relaunch 失败保留已安装提示", async () => {
    mocks.relaunch.mockRejectedValue(new Error("重启失败"));
    const { section } = await arriveAtOffer(vi.fn(async () => {}));
    await fireEvent.click(within(section).getByRole("button", { name: "下载并安装" }));
    await waitFor(() => expect(mocks.relaunch).toHaveBeenCalledTimes(1));
    expect(within(section).getByText("已安装新版本，即将重启…"), "重启失败仍显示已安装").toBeTruthy();
  });

  it("安装失败显示原因，当前版本保持可用且可重试", async () => {
    const downloadAndInstall = vi.fn()
      .mockRejectedValueOnce(new Error("验签失败"))
      .mockResolvedValueOnce(undefined);
    const { section } = await arriveAtOffer(downloadAndInstall as unknown as InstallFn);
    await fireEvent.click(within(section).getByRole("button", { name: "下载并安装" }));
    await waitFor(() => expect(within(section).getByText("更新失败：验签失败")).toBeTruthy());
    expect(within(section).getByText("0.2.17"), "当前版本号仍展示").toBeTruthy();
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);

    // 重试路径：再检查一次拿到句柄，安装第二次成功
    mocks.check.mockResolvedValue(fakeUpdate({ downloadAndInstall: downloadAndInstall as unknown as InstallFn }));
    await fireEvent.click(within(section).getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(within(section).getByRole("button", { name: "下载并安装" })).toBeTruthy());
    await fireEvent.click(within(section).getByRole("button", { name: "下载并安装" }));
    await waitFor(() => expect(downloadAndInstall).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(section).getByText("已安装新版本，即将重启…")).toBeTruthy());
  });

  it("下载中防重入：安装不重复触发，检查按钮禁用", async () => {
    let finish!: () => void;
    const downloadAndInstall = vi.fn(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    const { section } = await arriveAtOffer(downloadAndInstall);
    await fireEvent.click(within(section).getByRole("button", { name: "下载并安装" }));
    await waitFor(() => expect(within(section).getByText("正在下载更新…")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "下载并安装" }), "下载中不保留安装入口").toBeNull();
    expect((within(section).getByRole("button", { name: /检查更新|正在检查/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(mocks.relaunch).toHaveBeenCalledTimes(1));
  });

  it("安装前句柄已失效（更新消失）时按已是最新处理", async () => {
    // 共享 offer 由事件写入（不带句柄），安装时重新检查发现已无更新
    setUpdateOffer({ version: "0.3.0", notes: "事件带来的" });
    mocks.check.mockResolvedValue(null);
    stubNative();
    const { section } = renderSettings();
    const install = await waitFor(() => within(section).getByRole("button", { name: "下载并安装" }));
    await fireEvent.click(install);
    await waitFor(() => expect(within(section).getByText("已是最新版本。")).toBeTruthy());
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
});

describe("installSupported 与非原生模式", () => {
  it("事件 installSupported=false：不出现安装动作，显示不支持说明", async () => {
    stubNative();
    const handlers = new Map<string, (payload: unknown) => void>();
    mocks.listenEvent.mockImplementation(async (name: string, handler: (payload: unknown) => void) => {
      handlers.set(name, handler);
      return () => {};
    });
    await watchUpdateAvailable();
    handlers.get("twiglane:update-available")!({ version: "0.3.0", notes: "修复", installSupported: false });
    await tick();
    expect(updateState.installSupported).toBe(false);

    const { section } = renderSettings();
    expect(within(section).getByText("发现新版本 0.3.0。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "下载并安装" }), "deb 安装不渲染安装动作").toBeNull();
    expect(within(section).getByText(/不支持应用内安装/)).toBeTruthy();
    expect(within(section).getByRole("button", { name: "检查更新" }), "手动检查仍可用").toBeTruthy();
  });

  it("非原生（浏览器/预览 mock）模式：更新分区不可用", async () => {
    const { section } = renderSettings();
    expect(within(section).getByText("更新功能仅在桌面应用中可用。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下载并安装" })).toBeNull();
  });
});

describe("update 分区定位", () => {
  const scrolled: HTMLElement[] = [];
  const originalScroll = Element.prototype.scrollIntoView;

  beforeEach(() => {
    Element.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = originalScroll;
  });

  it("section=update 时滚动定位并把首焦点放进分区", async () => {
    stubNative();
    renderSettings({ section: "update" as const });
    const section = document.querySelector<HTMLElement>('[data-settings-section="update"]')!;
    await waitFor(() => expect(scrolled).toContain(section));
    expect(section.contains(document.activeElement), "首焦点落在应用更新分区").toBe(true);
    expect(scrolled).not.toContain(document.querySelector('[data-settings-section="runtime"]'));
  });
});
