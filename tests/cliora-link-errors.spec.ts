/** 审查链接失败的本地提示：路径类错误先说原因与恢复动作，原始诊断只进详情。 */
import { describe, expect, it } from "vitest";
import { CLIORA_RELAUNCH_ACTION, clioraLinkFailureNotice } from "../src/lib/cliora-link-errors";

describe("clioraLinkFailureNotice", () => {
  it.each(["path_unreadable", "path_missing", "not_directory"])("%s：用户语言原因 + 重新发起，OS 诊断只在 detail", (code) => {
    const raw = "无法解析路径，未修改文件。No such file or directory (os error 2)";
    const notice = clioraLinkFailureNotice({ code, message: raw })!;
    expect(notice.message).toContain("找不到或无法读取");
    expect(notice.message).toContain(CLIORA_RELAUNCH_ACTION);
    expect(notice.message).not.toContain("os error");
    expect(notice.detail).toBe(raw);
  });

  it("invalid_path：说明路径无效并给出重新发起", () => {
    const notice = clioraLinkFailureNotice({ code: "invalid_path", message: "审查链接里的工作树路径不是绝对路径。" })!;
    expect(notice.message).toContain("路径无效");
    expect(notice.message).toContain(CLIORA_RELAUNCH_ACTION);
    expect(notice.detail).toBe("审查链接里的工作树路径不是绝对路径。");
  });

  it("其他错误码交给通用提示", () => {
    expect(clioraLinkFailureNotice({ code: "not_repository", message: "该目录不是 Git 仓库，未做任何修改。" })).toBeNull();
    expect(clioraLinkFailureNotice({ code: "unsupported_version", message: "x" })).toBeNull();
  });
});
