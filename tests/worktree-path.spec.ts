import { afterEach, describe, expect, it } from "vitest";
import {
  joinPath,
  rememberWorktreeParent,
  rememberedWorktreeParent,
  repoParentOf,
  sameDirectory,
  splitWorktreeDir,
  worktreeDirIssue,
  worktreeFolderName,
} from "../src/lib/worktree-path";

afterEach(() => globalThis.localStorage?.clear());

describe("新工作区路径", () => {
  it("默认放在仓库旁边，盘符根与 / 根都能拼出完整路径", () => {
    expect(repoParentOf("/work/demo")).toBe("/work");
    expect(repoParentOf("/demo")).toBe("/");
    expect(repoParentOf("C:\\demo")).toBe("C:\\");
    expect(repoParentOf("C:\\Users\\me\\demo\\")).toBe("C:\\Users\\me");
    expect(joinPath("/", "x")).toBe("/x");
    expect(joinPath("C:\\", "x")).toBe("C:\\x");
    expect(joinPath("D:/trees/", "x")).toBe("D:/trees/x");
    expect(worktreeFolderName("/work/demo", " feature/login ui ")).toBe("demo-feature-login-ui");
    expect(worktreeFolderName("/work/demo", "")).toBe("demo-worktree");
  });

  it("拆分父目录与新文件夹名，拒绝没有文件夹名或指向 . / .. 的路径", () => {
    expect(splitWorktreeDir("/work/demo-x")).toEqual({ parent: "/work", directory: "demo-x" });
    expect(splitWorktreeDir("/demo-x")).toEqual({ parent: "/", directory: "demo-x" });
    expect(splitWorktreeDir("C:\\demo-x")).toEqual({ parent: "C:/", directory: "demo-x" });
    expect(splitWorktreeDir("demo-x")).toBeNull();
    expect(splitWorktreeDir("/work/..")).toBeNull();
  });

  it("相对路径与缺文件夹名时说明原因，示例按仓库平台给", () => {
    expect(worktreeDirIssue("", "/work/demo")).toBe("先填写工作区位置");
    expect(worktreeDirIssue("work/x", "/work/demo")).toContain("/Users/me");
    expect(worktreeDirIssue("/work/x", "/work/demo")).toBeNull();
    expect(worktreeDirIssue("work\\x", "C:\\work\\demo")).toContain("D:\\work");
    expect(worktreeDirIssue("C:", "C:\\work\\demo")).toContain("完整路径");
    expect(worktreeDirIssue("D:\\trees\\x", "C:\\work\\demo")).toBeNull();
    expect(worktreeDirIssue("\\\\server\\share\\x", "C:\\work\\demo")).toBeNull();
  });

  it("记住每个仓库上次用的目录；放回仓库旁边时清掉记录，坏数据不报错", () => {
    rememberWorktreeParent("C:\\work\\demo", "D:\\trees");
    expect(rememberedWorktreeParent("C:\\work\\demo")).toBe("D:\\trees");
    expect(rememberedWorktreeParent("/other")).toBeNull();
    rememberWorktreeParent("C:\\work\\demo", "c:/work/");
    expect(rememberedWorktreeParent("C:\\work\\demo")).toBeNull();
    expect(sameDirectory("C:\\Work\\", "c:/work")).toBe(true);
    globalThis.localStorage?.setItem("twiglane.worktreeParents", "{broken");
    expect(rememberedWorktreeParent("C:\\work\\demo")).toBeNull();
  });
});
