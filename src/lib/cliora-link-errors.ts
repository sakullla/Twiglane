/**
 * cliora 审查链接打开失败时的本地提示（R1/R7）：先用用户语言说明原因和能做什么，
 * 原生返回的原始诊断（例如 OS 错误）只放进详情。只改展示，不改变错误码与回执语义。
 */
import type { AppFailure } from "./types";

export interface ClioraLinkFailureNotice {
  /** 面向用户的原因与恢复动作。 */
  message: string;
  /** 原始诊断：只在详情里展开。 */
  detail: string | null;
}

/** 回到 Cliora 原会话重新发起：链接失败时用户唯一能做、且不会改动仓库的恢复动作。 */
export const CLIORA_RELAUNCH_ACTION = "请回到 Cliora 原会话，确认工作区还在后重新发起审查。";

const PATH_NOT_FOUND_CODES = new Set(["path_missing", "path_unreadable", "not_directory"]);

/**
 * 只接管路径类失败：路径不存在、无法读取或不是目录，以及路径格式无效。
 * 其他错误码原生文案已经是用户语言，返回 null 交给通用错误提示。
 */
export function clioraLinkFailureNotice(failure: Pick<AppFailure, "code" | "message">): ClioraLinkFailureNotice | null {
  const raw = failure.message?.trim() || null;
  if (PATH_NOT_FOUND_CODES.has(failure.code)) {
    return {
      message: `审查链接里的工作区在这台电脑上找不到或无法读取，没有打开任何仓库，也没有改动文件。${CLIORA_RELAUNCH_ACTION}`,
      detail: raw,
    };
  }
  if (failure.code === "invalid_path") {
    return {
      message: `审查链接里的工作区路径无效，没有打开任何仓库，也没有改动文件。${CLIORA_RELAUNCH_ACTION}`,
      detail: raw,
    };
  }
  return null;
}
