/**
 * 任务审阅意见（R5 的准备侧）：添加、编辑、删除、预览与范围失效。
 *
 * 这里只验前端运行期状态：什么算一条意见、上限、范围变化后旧意见不再对应新行号。
 * 真实交接文件、权限、digest 与深链由 Rust 侧（src-tauri/src/cliora_feedback.rs）覆盖。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BODY_BYTES,
  MAX_COMMENTS,
  addComment,
  adoptCommentScope,
  anchorKey,
  anchorLabel,
  clearCommentDraft,
  commentDraft,
  commentDraftCount,
  commentsSignature,
  commentLineKey,
  commentLines,
  commentsIn,
  deleteComment,
  editComment,
  feedbackComments,
  forgetComments,
  hasCommentDraft,
  preparedSignature,
  previewComments,
  previewText,
  recordPreparedComments,
  resetReviewComments,
  setCommentDraft,
  staleBatches,
  unsentCommentCount,
  unsentComments,
  type CommentScope,
  type ReviewCommentAnchor,
} from "../src/lib/review-comments.svelte";

const REVIEW = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";

function scope(overrides: Partial<CommentScope> = {}): CommentScope {
  return {
    reviewId: REVIEW,
    sessionId: "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0",
    worktree: "/work/team/demo",
    baselineOid: "a".repeat(40),
    headOid: "c".repeat(40),
    rangeVersion: "range-7",
    generation: 4,
    ...overrides,
  };
}

function anchor(overrides: Partial<ReviewCommentAnchor> = {}): ReviewCommentAnchor {
  return {
    path: "src/lib/api.ts",
    hunkIndex: 0,
    kind: "add",
    oldNo: null,
    newNo: 12,
    quote: "prepareReviewFeedback: (request) => invoke(...)",
    ...overrides,
  };
}

beforeEach(() => {
  resetReviewComments();
});

describe("意见生命周期", () => {
  it("整块意见仍是单行锚点，区间写进标签和送出的正文开头", () => {
    const current = scope();
    addComment(current, anchor({ newNo: 12, range: { from: 12, to: 18 } }), "这一块的失败分支要保留旧结果。");
    expect(anchorLabel(commentsIn(current)[0].anchor)).toBe("第 12–18 行这一块");
    const [sent] = feedbackComments(current);
    expect(sent).toMatchObject({ hunkIndex: 0, kind: "add", oldNo: null, newNo: 12 });
    expect(sent.body).toBe("（第 12–18 行这一块）\n这一块的失败分支要保留旧结果。");
    // 本地保存的正文不带前缀，编辑时看到的是自己写的原话。
    expect(commentsIn(current)[0].body).toBe("这一块的失败分支要保留旧结果。");
    // 单行意见不加任何前缀。
    addComment(current, anchor({ newNo: 30 }), "只改这一行。");
    expect(feedbackComments(current)[1].body).toBe("只改这一行。");
  });

  it("添加、编辑、删除都只改当前范围的这一批", () => {
    const current = scope();
    const first = addComment(current, anchor(), "这里要在失败时保留上一份结果。");
    const second = addComment(current, anchor({ kind: "del", oldNo: 4, newNo: null }), "删掉这行说明。");
    expect(first.id).not.toBe(second.id);
    expect(commentsIn(current).map((comment) => comment.body)).toEqual([
      "这里要在失败时保留上一份结果。",
      "删掉这行说明。",
    ]);

    const edited = editComment(current, first.id, "失败时保留上一份结果，不要显示零改动。");
    expect(edited?.body).toBe("失败时保留上一份结果，不要显示零改动。");
    expect(commentsIn(current).find((comment) => comment.id === first.id)?.updatedAt).toBeGreaterThanOrEqual(
      first.updatedAt,
    );

    expect(deleteComment(current, second.id)).toBe(true);
    expect(commentsIn(current)).toHaveLength(1);
    expect(deleteComment(current, second.id)).toBe(false);
    expect(editComment(current, "missing", "x")).toBeNull();
  });

  it("正文 trim 后为空、超过 16 KiB、批次超过 64 条都明确失败", () => {
    const current = scope();
    expect(() => addComment(current, anchor(), "   ")).toThrow(/不能为空/);
    expect(() => addComment(current, anchor(), "x".repeat(MAX_BODY_BYTES + 1))).toThrow(/16 KiB/);
    for (let index = 0; index < MAX_COMMENTS; index += 1) {
      addComment(current, anchor({ newNo: 100 + index }), "第 " + (index + 1) + " 条");
    }
    expect(commentsIn(current)).toHaveLength(MAX_COMMENTS);
    expect(() => addComment(current, anchor({ newNo: 999 }), "第 65 条")).toThrow(/64 条/);
  });

  it("路径与行类型不合规的意见不会被保存", () => {
    const current = scope();
    expect(() => addComment(current, anchor({ path: "/etc/passwd" }), "绝对路径")).toThrow(/仓库相对路径/);
    expect(() => addComment(current, { ...anchor(), kind: "meta" as unknown as "add" }, "坏类型")).toThrow(/行类型/);
    expect(() => addComment(current, anchor({ oldNo: null, newNo: null }), "没有行号")).toThrow(/行号/);
  });
});

describe("范围身份与失效", () => {
  it("行身份由路径、块号、行类型与两个行号共同决定", () => {
    const line = { hunkIndex: 3, kind: "context", oldNo: 7, newNo: 7 };
    expect(commentLineKey("docs/guide.md", line)).toBe("docs/guide.md|3|context|7|7");
    expect(anchorKey(anchor())).toBe("src/lib/api.ts|0|add||12");
    expect(commentLines(scope())).toEqual(new Set());
    addComment(scope(), anchor(), "一条意见");
    expect(commentLines(scope()).has("src/lib/api.ts|0|add||12")).toBe(true);
  });

  it("任务范围变化后旧意见整批失效，不映射到新行号", () => {
    const before = scope();
    addComment(before, anchor(), "旧范围内的意见");
    adoptCommentScope(before);
    // 同一范围重复读取（文件监听、刷新）不会清空正在写的意见。
    adoptCommentScope(scope());
    expect(commentsIn(before)).toHaveLength(1);

    const after = scope({ rangeVersion: "range-8", headOid: "d".repeat(40) });
    adoptCommentScope(after);
    expect(commentsIn(after)).toEqual([]);
    const stale = staleBatches(REVIEW);
    expect(stale).toHaveLength(1);
    expect(stale[0].comments.map((comment) => comment.body)).toEqual(["旧范围内的意见"]);
    expect(stale[0].reason).toMatch(/不会自动对应到新行号/);
    // 旧范围自己也不再持有意见：它们只作为失效记录存在。
    expect(commentsIn(before)).toEqual([]);
  });

  it("内容变化但范围形状不变：读取代次前进后旧意见同样整批失效", () => {
    const before = scope();
    addComment(before, anchor(), "内容变之前的意见");
    adoptCommentScope(before);
    // 同一个范围形状（起点、HEAD、rangeVersion 都没变）重复读取：意见还在。
    adoptCommentScope(scope());
    expect(commentsIn(scope())).toHaveLength(1);

    // 已修改文件只改了内容：状态形状不变，所以 rangeVersion 不变，只有代次前进。
    const reread = scope({ generation: 5 });
    adoptCommentScope(reread);
    expect(commentsIn(reread)).toEqual([]);
    const stale = staleBatches(REVIEW);
    expect(stale).toHaveLength(1);
    expect(stale[0].comments.map((comment) => comment.body)).toEqual(["内容变之前的意见"]);
    // 说明必须讲清是「内容被重新读过」，不能含糊成范围变化。
    expect(stale[0].reason).toContain("任务范围没变");
    expect(stale[0].reason).toContain("读取代次 4 → 5");
    expect(stale[0].reason).toContain("不会自动对应到新行号");
  });

  it("失效批次不再属于当前范围，不能被当成交接内容送出", () => {
    const before = scope();
    addComment(before, anchor(), "过期意见");
    addComment(before, anchor({ kind: "del", oldNo: 4, newNo: null }), "另一条过期意见");
    adoptCommentScope(before);
    const reread = scope({ generation: 5 });
    adoptCommentScope(reread);
    // 准备送回读的就是当前范围：批量为空，等于没有可送的内容。
    expect(feedbackComments(reread)).toEqual([]);
    expect(previewText(reread)).toBe("");
    expect(commentLines(reread).size).toBe(0);
    // 失效批次只保留说明，不回到任何可送出的路径。
    expect(staleBatches(REVIEW)[0].comments).toHaveLength(2);
  });

  it("关闭来源时丢掉它的意见与失效记录", () => {
    const current = scope();
    addComment(current, anchor(), "一条意见");
    adoptCommentScope(current);
    forgetComments(REVIEW);
    expect(commentsIn(current)).toEqual([]);
    expect(staleBatches(REVIEW)).toEqual([]);
    // 同 reviewId 重新进入时是干净的，不会复活旧意见。
    adoptCommentScope(current);
    expect(commentsIn(current)).toEqual([]);
  });
});

describe("预览与交接内容", () => {
  it("整批预览与交接请求只包含行定位与正文", () => {
    const current = scope();
    addComment(current, anchor(), "第一行意见");
    addComment(current, anchor({ path: "docs/guide.md", hunkIndex: 2, kind: "context", oldNo: 9, newNo: 9 }), "第二行意见");

    expect(anchorLabel(anchor())).toBe("新增第 12 行");
    expect(anchorLabel(anchor({ kind: "del", oldNo: 4, newNo: null }))).toBe("删除第 4 行");
    expect(anchorLabel(anchor({ kind: "context", oldNo: 9, newNo: 9 }))).toBe("第 9 行");

    const preview = previewText(current);
    expect(preview).toContain("1. src/lib/api.ts（新增第 12 行）");
    expect(preview).toContain("2. docs/guide.md（第 9 行）");
    expect(preview).toContain("第一行意见");
    expect(previewComments([])).toBe("");

    const comments = feedbackComments(current);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      path: "src/lib/api.ts",
      hunkIndex: 0,
      kind: "add",
      oldNo: null,
      newNo: 12,
      body: "第一行意见",
    });
    // 交接内容里没有 URL、绝对路径或任何 Git 语义。
    expect(JSON.stringify(comments)).not.toContain("/work/team/demo");
  });
});

describe("按来源的意见草稿槽", () => {
  it("保存锚点、正文与编辑 id，按 reviewId 隔离，读取得到副本", () => {
    const other = "0f0e0d0c-0b0a-4908-8706-050403020100";
    expect(commentDraft(REVIEW)).toBeNull();
    setCommentDraft(REVIEW, { anchor: anchor(), body: "还没写完" });
    setCommentDraft(other, { anchor: anchor({ path: "docs/guide.md", newNo: 3 }), body: "另一个来源" });

    const draft = commentDraft(REVIEW)!;
    expect(draft).toEqual({ anchor: anchor(), body: "还没写完", editingId: null });
    expect(commentDraft(other)?.anchor?.path).toBe("docs/guide.md");
    // 读取得到的是副本：改它不会影响槽里的内容。
    draft.anchor!.path = "mutated";
    draft.body = "mutated";
    expect(commentDraft(REVIEW)?.anchor?.path).toBe("src/lib/api.ts");
    expect(commentDraft(REVIEW)?.body).toBe("还没写完");

    // 合并写入：只改正文，锚点保留。
    setCommentDraft(REVIEW, { body: "写完了" });
    expect(commentDraft(REVIEW)).toEqual({ anchor: anchor(), body: "写完了", editingId: null });
    expect(hasCommentDraft(REVIEW)).toBe(true);
    expect(commentDraftCount(REVIEW)).toBe(1);

    clearCommentDraft(REVIEW);
    expect(commentDraft(REVIEW)).toBeNull();
    expect(commentDraft(other)?.body).toBe("另一个来源");
  });

  it("只有正文不为空才算会丢失的草稿；全部清空等同删除", () => {
    setCommentDraft(REVIEW, { anchor: anchor(), body: "   " });
    expect(hasCommentDraft(REVIEW)).toBe(false);
    expect(commentDraftCount(REVIEW)).toBe(0);
    setCommentDraft(REVIEW, { editingId: "x", anchor: null, body: "改一下" });
    expect(commentDraft(REVIEW)).toEqual({ anchor: null, body: "改一下", editingId: "x" });
    setCommentDraft(REVIEW, { editingId: null, body: "" });
    expect(commentDraft(REVIEW)).toBeNull();
  });

  it("草稿不参与上限校验，也不进入交接批次", () => {
    const current = scope();
    setCommentDraft(REVIEW, { anchor: anchor(), body: "x".repeat(MAX_BODY_BYTES + 10) });
    expect(commentsIn(current)).toEqual([]);
    expect(feedbackComments(current)).toEqual([]);
    // 保存时才走原校验：超过 16 KiB 照旧拒绝，草稿正文不被清空。
    expect(() => addComment(current, anchor(), commentDraft(REVIEW)!.body)).toThrow("16 KiB");
    expect(commentDraft(REVIEW)?.body.length).toBe(MAX_BODY_BYTES + 10);
  });

  it("关闭来源与测试重置会一起清掉草稿", () => {
    setCommentDraft(REVIEW, { anchor: anchor(), body: "草稿" });
    forgetComments(REVIEW);
    expect(commentDraft(REVIEW)).toBeNull();
    setCommentDraft(REVIEW, { anchor: anchor(), body: "草稿" });
    resetReviewComments();
    expect(commentDraft(REVIEW)).toBeNull();
  });
});

describe("最近成功准备的签名与未送回意见", () => {
  it("从未准备时整批都未送回；准备后只有新增或改过的意见算未送回", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const current = scope();
      adoptCommentScope(current);
      const first = addComment(current, anchor(), "第一条");
      const second = addComment(current, anchor({ newNo: 13 }), "第二条");
      expect(preparedSignature(REVIEW)).toBeNull();
      expect(unsentCommentCount(current)).toBe(2);
      expect(unsentCommentCount(null)).toBe(0);

      recordPreparedComments(current);
      expect(preparedSignature(REVIEW)).toBe(commentsSignature(current));
      expect(unsentComments(current)).toEqual([]);

      vi.setSystemTime(2_000);
      editComment(current, first.id, "第一条（改过）");
      const third = addComment(current, anchor({ newNo: 14 }), "第三条");
      expect(unsentComments(current).map((comment) => comment.id).sort()).toEqual([first.id, third.id].sort());
      expect(preparedSignature(REVIEW)).not.toBe(commentsSignature(current));
      // 删掉一条已送回的意见不会让别的意见变成未送回。
      deleteComment(current, second.id);
      expect(unsentCommentCount(current)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("批次身份变化后，之前的准备不代表新批次", () => {
    const current = scope();
    adoptCommentScope(current);
    addComment(current, anchor(), "第一条");
    recordPreparedComments(current);
    expect(unsentCommentCount(current)).toBe(0);

    const next = scope({ generation: 5 });
    adoptCommentScope(next);
    // 旧批次照原规则整批失效，新批次为空。
    expect(staleBatches(REVIEW)).toHaveLength(1);
    expect(commentsIn(next)).toEqual([]);
    addComment(next, anchor(), "按新内容重写");
    expect(unsentCommentCount(next)).toBe(1);
  });

  it("关闭来源时清掉签名", () => {
    const current = scope();
    addComment(current, anchor(), "第一条");
    recordPreparedComments(current);
    forgetComments(REVIEW);
    expect(preparedSignature(REVIEW)).toBeNull();
  });
});
