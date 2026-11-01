import type { Window as TauriWindow } from "@tauri-apps/api/window";

/**
 * 窗口 API 的唯一接触点：自绘标题栏的拖拽、最小化、最大化、关闭与最大化状态。
 * 与 api.ts 一样按需动态引入 @tauri-apps/api，测试与浏览器预览里没有 Tauri 运行时，
 * 此时所有窗口操作降级为空操作，调用方不需要各自判断运行环境。
 */

export type WindowPlatform = "macos" | "windows" | "other";

function platformHint(): string {
  return typeof navigator === "undefined"
    ? ""
    : `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
}

/** 标题栏按平台避让系统按钮区：macOS 留交通灯位置，Windows 自绘控件。 */
export const WINDOW_PLATFORM: WindowPlatform = /Mac|iPhone|iPad/.test(platformHint())
  ? "macos"
  : /Win32|Win64|Windows NT/.test(platformHint())
    ? "windows"
    : "other";

function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function currentWindow(): Promise<TauriWindow | null> {
  if (!hasTauriRuntime()) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** 拖动标题栏空白处移动窗口；交互控件不调用它。 */
export async function startWindowDrag(): Promise<void> {
  const win = await currentWindow();
  await win?.startDragging();
}

export async function minimizeWindow(): Promise<void> {
  const win = await currentWindow();
  await win?.minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  const win = await currentWindow();
  await win?.toggleMaximize();
}

export async function isWindowMaximized(): Promise<boolean> {
  const win = await currentWindow();
  return (await win?.isMaximized()) ?? false;
}

export async function closeWindow(): Promise<void> {
  const win = await currentWindow();
  await win?.close();
}

/** 订阅最大化状态变化，返回取消订阅函数；Windows 自绘按钮靠它跟随系统状态。
 * 退订走 @tauri-apps/api 的 unlisten 命令，capabilities/default.json 已授予
 * core:event:allow-unlisten；窗口销毁时监听由 Tauri 自动清理，不依赖退订。 */
export async function watchWindowMaximized(
  handler: (maximized: boolean) => void,
): Promise<() => void> {
  const win = await currentWindow();
  if (!win) return () => {};
  return win.onResized(() => {
    void win.isMaximized().then(handler);
  });
}
