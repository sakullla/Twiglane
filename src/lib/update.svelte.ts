/**
 * 应用内更新的共享状态（Svelte 5 模块级 $state，先例 syntax/prefs.svelte.ts）。
 *
 * 后端在启动 20 秒后静默检查，发现新版本时 emit `twiglane:update-available`
 * （payload 为 camelCase 的 {version, notes, installSupported}），这里统一接收：
 * 设置弹窗的应用更新分区与后续的提示入口共享同一份 offer。
 *
 * 手动检查（plugin-updater 的 check）只带回版本与说明；installSupported 是
 * 后端对安装方式的判定（仅 Linux 非 AppImage 为 false），只有事件携带，
 * 手动检查不覆盖它，事件未到时按可安装渲染，安装失败仍走 failed 态。
 */

import { listenEvent } from "./api";

/** 后端事件与共享 store 里的新版本信息。 */
export interface UpdateOffer {
  version: string;
  notes: string;
}

/** 下载进度：Started 取 contentLength 为总量，Progress 累加 chunkLength。 */
export interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

/** 安装结果：unavailable 表示安装前重新检查时更新已不存在（按已是最新处理）。 */
export type InstallOutcome = "installed" | "unavailable";

/** 最小化 Update 句柄形状，测试与真实插件句柄都可传入。 */
interface UpdateHandle {
  version: string;
  body?: string;
  downloadAndInstall: (onEvent: (event: DownloadEventLike) => void) => Promise<void>;
}

type DownloadEventLike =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export const updateState = $state({
  /** 当前可用的新版本；null 表示没有（尚未发现或最近一次检查为最新）。 */
  offer: null as UpdateOffer | null,
  /** 后端事件判定的安装支持；null 表示事件还没到，按可安装渲染。 */
  installSupported: null as boolean | null,
});

/** 事件或测试写入共享 offer；installSupported 仅由事件路径更新。 */
export function setUpdateOffer(offer: UpdateOffer | null): void {
  updateState.offer = offer;
}

function setEventOffer(payload: UpdateOffer & { installSupported: boolean }): void {
  updateState.offer = { version: payload.version, notes: payload.notes };
  updateState.installSupported = payload.installSupported;
}

/** 是否运行在 Tauri 桌面环境（浏览器预览与测试里没有更新能力）。 */
export function isNativeRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 注册 `twiglane:update-available` 监听。非原生环境不注册（返回空退订）；
 * 注册失败静默，不影响其余功能（R1：自动检查失败不打扰用户）。
 */
export async function watchUpdateAvailable(): Promise<() => void> {
  if (!isNativeRuntime()) return () => {};
  try {
    return await listenEvent<UpdateOffer & { installSupported: boolean }>(
      "twiglane:update-available",
      (payload) => {
        setEventOffer(payload);
      },
    );
  } catch {
    return () => {};
  }
}

/** 测试用：恢复初始状态并丢弃安装句柄。 */
export function resetUpdateState(): void {
  updateState.offer = null;
  updateState.installSupported = null;
  pendingUpdate = null;
}

/** 手动检查得到的安装句柄；模块内持有，不进 $state（插件对象不参与渲染）。 */
let pendingUpdate: UpdateHandle | null = null;

/** 手动检查：取回句柄并同步共享 offer；无更新返回 null。 */
async function fetchUpdate(): Promise<UpdateHandle | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = (await check()) as UpdateHandle | null;
  pendingUpdate = update;
  updateState.offer = update ? { version: update.version, notes: update.body ?? "" } : null;
  return update;
}

/**
 * 手动检查新版本：有更新写入共享 offer 并返回 true；无更新清空 offer 返回 false。
 * 检查失败（离线、端点不可用）抛出，由调用方显示原因。
 */
export async function checkForUpdates(): Promise<boolean> {
  return (await fetchUpdate()) !== null;
}

/**
 * 下载并安装当前 offer 对应的更新：插件写入前强制验签，验签、下载或安装
 * 失败都会抛错，当前版本保持可用（R2）。成功后调用 relaunch 重启；重启失败
 * 不抛错，由调用方保留已安装提示。自动检查只带回版本信息，安装前若没有
 * 句柄则重新检查一次。
 */
export async function installUpdate(onProgress: (progress: DownloadProgress) => void): Promise<InstallOutcome> {
  const current = pendingUpdate ?? (await fetchUpdate());
  if (!current) return "unavailable";
  let downloaded = 0;
  let total: number | null = null;
  await current.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
      downloaded = 0;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
    }
    onProgress({ downloaded, total });
  });
  pendingUpdate = null;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  try {
    await relaunch();
  } catch {
    // 重启失败保留已安装提示，用户手动重新打开即进入新版本（R2）。
  }
  return "installed";
}
