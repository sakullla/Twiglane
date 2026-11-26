/**
 * 审查完成栏文案模型（R6）：主次动作、Git 结果与工作区分项、交接/返回状态、禁用原因。
 * 所有组合都不得出现「已发送给 Agent」「已执行」「修复完成」「批准」。
 */
import { describe, expect, it } from "vitest";
import {
  COMPLETION_CONFIRM_NOTE,
  COMPLETION_VERIFY_NOTE,
  completionTexts,
  reviewCompletion,
  type ReviewCompletionInput,
  type ReviewGitResult,
  type ReviewHandoffState,
  type ReviewReturnState,
  type ReviewWorktreeState,
} from "../src/lib/review-completion";

const OID = "0123456789abcdef0123456789abcdef01234567";
const FORBIDDEN = ["已发送给 Agent", "已执行", "修复完成", "批准"];

function input(overrides: Partial<ReviewCompletionInput> = {}): ReviewCompletionInput {
  return {
    source: "local",
    commentCount: 0,
    draftCount: 0,
    staleCount: 0,
    handoff: { state: "idle" },
    gitResult: { kind: "none" },
    worktree: { state: "clean" },
    returnState: { state: "idle" },
    writeLocked: false,
    canFeedback: true,
    ...overrides,
  };
}

function labels(model: ReturnType<typeof reviewCompletion>): string[] {
  return model.statusItems.map((item) => item.label);
}

function expectNoForbidden(model: ReturnType<typeof reviewCompletion>) {
  const text = completionTexts(model).join("\n");
  for (const word of FORBIDDEN) expect(text).not.toContain(word);
}

describe("reviewCompletion 主次动作", () => {
  it("有意见：主动作送回 N 条意见，次动作返回 Cliora", () => {
    const model = reviewCompletion(input({ commentCount: 3 }));
    expect(model.primary).toMatchObject({ id: "feedback", label: "送回 3 条意见", disabled: false });
    expect(model.secondary).toMatchObject({ id: "return", label: "返回 Cliora", disabled: false });
    expect(model.primary?.reason).toContain(COMPLETION_CONFIRM_NOTE);
    expect(labels(model)).toContain("3 条意见");
  });

  it("无意见：主动作返回 Cliora，没有送回动作", () => {
    const model = reviewCompletion(input());
    expect(model.primary).toMatchObject({ id: "return", label: "返回 Cliora", disabled: false });
    expect(model.secondary).toBeNull();
    expect(labels(model)).toContain("没有待送回的意见");
  });

  it("说明行固定保留：先在 Cliora 确认、结果待 Cliora 复核", () => {
    for (const commentCount of [0, 2]) {
      const model = reviewCompletion(input({ commentCount }));
      expect(model.detailItems).toEqual(expect.arrayContaining([COMPLETION_CONFIRM_NOTE, COMPLETION_VERIFY_NOTE]));
    }
  });

  it("全部意见已准备过：返回成为主动作，送回改为再次送回", () => {
    const model = reviewCompletion(input({ commentCount: 2, unsentCount: 0 }));
    expect(model.primary?.id).toBe("return");
    expect(model.secondary).toMatchObject({ id: "feedback", label: "再次送回 2 条意见" });
  });

  it("部分意见未送回时计数分开说明", () => {
    const model = reviewCompletion(input({ commentCount: 3, unsentCount: 1 }));
    expect(model.primary?.id).toBe("feedback");
    expect(labels(model)).toContain("3 条意见（1 条未送回）");
  });

  it("范围不可送回时送回按钮禁用并说明原因", () => {
    const model = reviewCompletion(input({ commentCount: 1, canFeedback: false, feedbackBlockedReason: "先重新读取任务" }));
    expect(model.primary).toMatchObject({ id: "feedback", disabled: true, reason: "先重新读取任务" });
    expect(model.secondary).toMatchObject({ id: "return", disabled: false });
  });
});

describe("reviewCompletion 交接状态", () => {
  const cases: [string, ReviewHandoffState][] = [
    ["idle", { state: "idle" }],
    ["preparing", { state: "preparing" }],
    ["prepared", { state: "prepared", feedbackId: "abcdef0123456789", commentCount: 2 }],
    ["failed", { state: "failed", message: "来源已失效" }],
  ];

  it("准备中：两个动作都禁用，主动作显示正在准备", () => {
    const model = reviewCompletion(input({ commentCount: 2, handoff: { state: "preparing" } }));
    expect(model.primary).toMatchObject({ id: "feedback", label: "正在准备…", disabled: true });
    expect(model.secondary).toMatchObject({ id: "return", disabled: true });
    expect(model.tone).toBe("info");
    expect(labels(model)).toContain("正在准备意见交接…");
  });

  it("准备成功：只说已准备并等待 Cliora 确认", () => {
    const model = reviewCompletion(input({ commentCount: 2, unsentCount: 0, handoff: { state: "prepared", feedbackId: "abcdef0123456789", commentCount: 2 } }));
    expect(labels(model)).toContain("已准备 2 条意见，已打开 Cliora 等待确认");
    expect(model.detailItems.join("\n")).toContain("abcdef01");
    expect(model.tone).toBe("success");
  });

  it("准备失败：保留意见，主动作改为重试，色调为错误", () => {
    const model = reviewCompletion(input({ commentCount: 2, handoff: { state: "failed", message: "来源已失效" } }));
    expect(model.primary).toMatchObject({ id: "feedback", label: "重试送回 2 条意见", disabled: false });
    expect(labels(model).join("\n")).toContain("意见仍保留");
    expect(model.detailItems).toContain("准备失败：来源已失效");
    expect(model.tone).toBe("error");
  });

  it.each(cases)("交接 %s 不出现禁止文案", (_name, handoff) => {
    expectNoForbidden(reviewCompletion(input({ commentCount: 2, handoff })));
  });
});

describe("reviewCompletion 返回状态", () => {
  it("返回中：两个动作都禁用", () => {
    const model = reviewCompletion(input({ commentCount: 1, returnState: { state: "returning" } }));
    expect(model.primary?.disabled).toBe(true);
    expect(model.secondary).toMatchObject({ id: "return", label: "正在返回…", disabled: true });
    expect(model.tone).toBe("info");
  });

  it("返回成功：说明待 Cliora 复核", () => {
    const model = reviewCompletion(input({ returnState: { state: "returned", revision: 3 } }));
    expect(labels(model)).toContain(`已返回 Cliora（第 3 次），${COMPLETION_VERIFY_NOTE}`);
    expect(model.tone).toBe("success");
  });

  it("返回失败：主动作改为重试返回，保留意见与草稿", () => {
    const model = reviewCompletion(input({ returnState: { state: "failed", message: "Cliora 不可用" } }));
    expect(model.primary).toMatchObject({ id: "return", label: "重试返回 Cliora", disabled: false });
    expect(labels(model).join("\n")).toContain("意见与草稿仍保留");
    expect(model.detailItems).toContain("返回失败：Cliora 不可用");
    expect(model.tone).toBe("error");
  });
});

describe("reviewCompletion Git 结果与工作区分项", () => {
  const gits: [string, ReviewGitResult][] = [
    ["none", { kind: "none" }],
    ["committed", { kind: "committed", oid: OID }],
    ["merged", { kind: "merged", oid: OID }],
  ];
  const worktrees: [string, ReviewWorktreeState][] = [
    ["clean", { state: "clean" }],
    ["dirty", { state: "dirty", count: 4 }],
    ["unknown", { state: "unknown" }],
  ];

  for (const [gitName, gitResult] of gits) {
    for (const [treeName, worktree] of worktrees) {
      it(`${gitName} × ${treeName} 分别成项，不互相推断`, () => {
        const model = reviewCompletion(input({ gitResult, worktree }));
        const git = model.statusItems.find((item) => item.id === "git")!;
        const tree = model.statusItems.find((item) => item.id === "worktree")!;
        expect(git.label).toBe(
          gitName === "committed" ? "已提交 0123456（待复核）" : gitName === "merged" ? "已合入 0123456（待复核）" : "本次没有提交或合入",
        );
        expect(tree.label).toBe(
          treeName === "clean" ? "工作区没有未提交的改动" : treeName === "dirty" ? "工作区还有 4 个未提交的改动" : "没有读到工作区状态（按未知处理）",
        );
        // unknown 绝不说成干净。
        if (treeName === "unknown") expect(tree.label).not.toContain("没有未提交");
        if (gitName !== "none") expect(model.detailItems).toContain(`完整提交 ${OID}`);
        expectNoForbidden(model);
      });
    }
  }

  it("reviewed + dirty：没有提交或合入，但如实说出未提交改动", () => {
    const model = reviewCompletion(input({ worktree: { state: "dirty", count: null } }));
    expect(labels(model)).toEqual(expect.arrayContaining(["本次没有提交或合入", "工作区还有未提交的改动"]));
    expect(labels(model).join("\n")).not.toContain("只浏览");
  });
});

describe("reviewCompletion 来源与写锁", () => {
  it("远程来源：只能返回，送回意见不可用并说明原因", () => {
    const empty = reviewCompletion(input({ source: "remote" }));
    expect(empty.primary).toMatchObject({ id: "return", disabled: false });
    expect(empty.secondary).toBeNull();
    expect(empty.detailItems.join("\n")).toContain("远程审查来源暂不支持送回意见");

    const withComments = reviewCompletion(input({ source: "remote", commentCount: 2 }));
    expect(withComments.primary?.id).toBe("return");
    expect(withComments.secondary).toMatchObject({ id: "feedback", disabled: true });
    expect(withComments.secondary?.reason).toContain("远程审查来源暂不支持送回意见");
  });

  it("没有来源：没有任何动作", () => {
    const model = reviewCompletion(input({ source: "none", commentCount: 2 }));
    expect(model.primary).toBeNull();
    expect(model.secondary).toBeNull();
    expect(labels(model)).toEqual(["没有审查来源"]);
    expectNoForbidden(model);
  });

  it("writeLocked：两个动作都禁用并给出原因", () => {
    const model = reviewCompletion(input({ commentCount: 1, writeLocked: true, writeLockedReason: "正在提交，稍后再试。" }));
    expect(model.primary).toMatchObject({ disabled: true, reason: "正在提交，稍后再试。" });
    expect(model.secondary).toMatchObject({ disabled: true, reason: "正在提交，稍后再试。" });
    const fallback = reviewCompletion(input({ writeLocked: true }));
    expect(fallback.primary?.disabled).toBe(true);
    expect(fallback.primary?.reason).toBeTruthy();
  });

  it("草稿与失效意见：分项提示并以警告色调呈现", () => {
    const model = reviewCompletion(input({ commentCount: 1, draftCount: 1, staleCount: 3 }));
    expect(labels(model)).toEqual(expect.arrayContaining(["1 条草稿未保存", "3 条意见已失效，不会送回"]));
    expect(model.tone).toBe("warn");
  });
});

describe("reviewCompletion 禁止文案（全组合）", () => {
  it("任何状态组合都不出现已发送给 Agent / 已执行 / 修复完成 / 批准", () => {
    const handoffs: ReviewHandoffState[] = [
      { state: "idle" },
      { state: "preparing" },
      { state: "prepared", feedbackId: "abcdef0123456789", commentCount: 1 },
      { state: "failed", message: "x" },
    ];
    const returns: ReviewReturnState[] = [
      { state: "idle" },
      { state: "returning" },
      { state: "returned", revision: 1 },
      { state: "failed", message: "y" },
    ];
    const gits: ReviewGitResult[] = [{ kind: "none" }, { kind: "committed", oid: OID }, { kind: "merged", oid: OID }];
    const trees: ReviewWorktreeState[] = [{ state: "clean" }, { state: "dirty", count: 2 }, { state: "unknown" }];
    let checked = 0;
    for (const source of ["local", "remote", "none"] as const)
      for (const commentCount of [0, 2])
        for (const handoff of handoffs)
          for (const returnState of returns)
            for (const gitResult of gits)
              for (const worktree of trees)
                for (const writeLocked of [false, true]) {
                  expectNoForbidden(reviewCompletion(input({ source, commentCount, handoff, returnState, gitResult, worktree, writeLocked, draftCount: 1, staleCount: 1 })));
                  checked += 1;
                }
    expect(checked).toBe(3 * 2 * 4 * 4 * 3 * 3 * 2);
  });
});

describe("实时工作区与上次返回的快照", () => {
  it("返回后显示实时工作区；返回时的快照只在详情里标为「上次返回时」", () => {
    const model = reviewCompletion(input({
      worktree: { state: "dirty", count: 1 },
      returnState: { state: "returned", revision: 1 },
      returnedWorktree: { state: "dirty", count: 3 },
    }));
    expect(labels(model)).toContain("工作区还有 1 个未提交的改动");
    expect(labels(model)).not.toContain("工作区还有 3 个未提交的改动");
    expect(model.detailItems.some((item) => item.startsWith("上次返回时工作区有 3 个未提交的改动"))).toBe(true);
  });

  it("没有返回过时不出现「上次返回时」", () => {
    const model = reviewCompletion(input({ returnedWorktree: { state: "clean" } }));
    expect(model.detailItems.some((item) => item.includes("上次返回时"))).toBe(false);
  });

  it("范围前进前准备的批次只进详情，不出现等待确认", () => {
    const model = reviewCompletion(input({ staleCount: 1, earlierFeedbackId: "05d1396d-aaaa" }));
    expect(labels(model).some((label) => label.includes("等待确认"))).toBe(false);
    expect(model.detailItems).toContain("范围变化前准备的批次 05d1396d 不属于当前批次；是否发送以 Cliora 预览为准。");
    for (const text of completionTexts(model)) for (const word of FORBIDDEN) expect(text).not.toContain(word);
  });
});
