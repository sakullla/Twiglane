// @vitest-environment node
import { describe, expect, it } from "vitest";
import { paletteScore, queryTokens, rankPalette } from "../src/lib/palette-match";
import { paletteItems, type CommandState } from "../src/lib/commands";

const items = [
  { id: "merge", group: "任务", title: "分支合并", keywords: "merge rebase 合并分支 变基", hint: "预览影响并处理冲突" },
  { id: "branch", group: "任务", title: "分支与标签", keywords: "branch tag 管理分支 删除分支", hint: "切换、创建、删除与标签同层" },
  { id: "create", group: "任务", title: "新建分支", keywords: "create new branch 创建分支", hint: "从当前分支或指定起点创建" },
  { id: "repo", group: "仓库", title: "新建仓库", keywords: "init 初始化仓库", hint: "在空目录初始化 Git" },
  { id: "push", group: "同步", title: "推送", keywords: "push 上传", hint: "不强行推送" },
  { id: "commitPush", group: "提交", title: "提交并推送", keywords: "commit push", hint: "提交后推送到上游" },
  { id: "remote", group: "任务", title: "远程", keywords: "remote origin url 远端 远程地址", hint: "查看与修改远程地址" },
];
const ids = (query: string) => rankPalette(items, query).map((item) => item.id);

describe("命令面板匹配与排序", () => {
  it("空关键词原样返回，顺序不变", () => {
    expect(queryTokens("   ")).toEqual([]);
    expect(ids("")).toEqual(items.map((item) => item.id));
  });

  it("标题以关键词开头的排在只是包含的前面，再往后才是别名", () => {
    expect(ids("推送")).toEqual(["push", "commitPush"]);
    expect(ids("分支").slice(0, 2)).toEqual(["merge", "branch"]);
    // 别名以关键词开头也算正式命中：排在标题命中之后。
    expect(ids("创建")).toEqual(["create"]);
  });

  it("弱匹配只是兜底：有正式命中时，说明里顺带提到的命令不出现", () => {
    // 「推送」：标题就有两条命中，说明里写着「推送」的命令不跟着出来。
    const withHint = [...items, { id: "publish", group: "同步", title: "发布分支", hint: "推送一次并建立上游关联" }];
    expect(rankPalette(withHint, "推送").map((item) => item.id)).toEqual(["push", "commitPush"]);
    // 「地址」没有任何正式命中：这时别名中间或说明里包含它的命令才作为兜底出现。
    expect(ids("地址")).toEqual(["remote"]);
    // 两个字的中文关键词不做不计字序的匹配：「建新」凑不出「新建分支」。
    expect(ids("建新")).toEqual([]);
  });

  it("中文关键词不计字序：换个说法也能找到，但不会把不相干的命令带出来", () => {
    expect(ids("合并分支")[0]).toBe("merge");
    expect(ids("管理分支")).toEqual(["branch"]);
    // 「新建分支」不会因为都有「新建」两个字就把「新建仓库」带出来。
    expect(ids("新建分支")).toEqual(["create"]);
    // 字不全就不算：别名各自判断，不把所有别名拼成一袋字。
    expect(ids("删除标签")).toEqual([]);
  });

  it("Git 的英文叫法走别名，大小写不敏感", () => {
    expect(ids("MERGE")).toEqual(["merge"]);
    expect(ids("push")).toEqual(["push", "commitPush"]);
    expect(ids("init")).toEqual(["repo"]);
  });

  it("空格分开的多个词须全部命中，任一词不中就不出现", () => {
    expect(ids("提交 推送")).toEqual(["commitPush"]);
    expect(ids("推送 不存在")).toEqual([]);
    expect(paletteScore(items[0], ["分支", "不存在"])).toBeNull();
  });

  it("真实注册表：常见说法都能落到对应命令上", () => {
    const state = {
      hasRepo: true, writeLocked: false, writing: false, reading: false, switchingBlocked: false,
      stagedCount: 0, stageTargets: [], unstageTargets: [], upstreamMissing: false, draft: "",
      theme: "dark", recentRepos: [], workspaceView: "changes",
    } as unknown as CommandState;
    const registry = paletteItems(state);
    const first = (query: string) => rankPalette(registry, query)[0]?.id;
    expect(first("stash")).toBe("task.stash");
    expect(first("贮藏")).toBe("task.stash");
    expect(first("合并分支")).toBe("task.merge");
    expect(first("中止合并")).toBe("task.abortMerge");
    expect(first("新建分支")).toBe("branch.create");
    expect(first("切换分支")).toBe("branch.switch");
    expect(first("checkout")).toBe("branch.switch");
    expect(first("管理分支")).toBe("task.branch");
    expect(first("pull")).toBe("sync.pull");
    expect(first("fetch")).toBe("sync.fetch");
    expect(first("clone")).toBe("repo.clone");
    expect(first("深色")).toBe("theme.dark");
    expect(first("侧边栏")).toBe("rail.toggle");
  });
});
