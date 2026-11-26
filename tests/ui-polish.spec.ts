import { readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import BranchSwitcher from "../src/lib/components/BranchSwitcher.svelte";
import CommandPalette from "../src/lib/components/CommandPalette.svelte";
import DiffView from "../src/lib/components/DiffView.svelte";
import FileList from "../src/lib/components/FileList.svelte";
import StashPanel from "../src/lib/components/StashPanel.svelte";
import InlineCommentEditor from "../src/lib/components/review/InlineCommentEditor.svelte";
import ReviewCommentsDrawer from "../src/lib/components/review/ReviewCommentsDrawer.svelte";
import ReviewCompletionBar from "../src/lib/components/review/ReviewCompletionBar.svelte";
import ReviewSourceCard from "../src/lib/components/review/ReviewSourceCard.svelte";
import ReviewStatePanel from "../src/lib/components/review/ReviewStatePanel.svelte";
import type { ReviewSourceEntry } from "../src/lib/review-actions.svelte";
import type { ReviewComment, StaleCommentBatch } from "../src/lib/review-comments.svelte";
import { reviewCompletion } from "../src/lib/review-completion";
import type { DiffResponse, FileChange, OpenedRepository, StashState } from "../src/lib/types";
import {
  REMOTE_CONTEXT_EXPAND_UNSUPPORTED_REASON,
  REMOTE_DISCARD_PATCH_UNSUPPORTED_REASON,
  REMOTE_STASH_EXTENDED_UNSUPPORTED_REASON,
} from "../src/lib/types";

const styles = path.resolve(__dirname, "../src/styles");
/** 去掉注释后的样式文本：只按真实规则判定。 */
const css = (name: string) => readFileSync(path.join(styles, name), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
/** 选择器对应的全部声明块（同一选择器可能出现在多条规则或逗号列表里），合并后返回。 */
function declarations(sheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bodies = [...sheet.matchAll(new RegExp(`(?:^|[}\\n,])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "g"))].map((match) => match[1]);
  if (bodies.length === 0) throw new Error(`缺少样式规则：${selector}`);
  return bodies.join(";");
}
/** svg 图标的路径签名：同一个图标名渲染出同一组 path。 */
const iconOf = (node: Element | null) => [...(node?.querySelectorAll("svg.icon path") ?? [])].map((item) => item.getAttribute("d")).join("|");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UI/UX 交互与视觉细节", () => {
  it("命令面板高亮命中片段、显示底部提示与匹配计数，并支持 Ctrl+N/Ctrl+P 导航", async () => {
    const runFirst = vi.fn();
    const runSecond = vi.fn();
    render(CommandPalette, {
      props: {
        open: true,
        commands: [
          { id: "a", group: "同步", title: "推送到远程", run: runFirst },
          { id: "b", group: "提交", title: "提交并推送", run: runSecond },
        ],
        onClose: vi.fn(),
      },
    });

    const input = screen.getByRole("combobox", { name: "搜索命令" });
    await fireEvent.input(input, { target: { value: "推送" } });

    const marks = [...document.querySelectorAll(".palette-item mark")].map((node) => node.textContent);
    expect(marks).toEqual(["推送", "推送"]);
    expect(document.querySelector(".palette-foot-count")?.textContent).toBe("共 2 项");

    await fireEvent.keyDown(input, { key: "n", ctrlKey: true });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");

    await fireEvent.keyDown(input, { key: "p", ctrlKey: true });
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("改动文件列表在筛选时高亮文件名与目录、显示匹配数，并支持 / 键聚焦搜索", async () => {
    const files: FileChange[] = [
      {
        path: "src/lib/AppShell.svelte",
        originalPath: null,
        staged: "none",
        unstaged: "modified",
        untracked: false,
        unmerged: false,
      },
      {
        path: "docs/readme.md",
        originalPath: null,
        staged: "none",
        unstaged: "modified",
        untracked: false,
        unmerged: false,
      },
    ];
    let query = "lib";
    const onQuery = vi.fn((next: string) => {
      query = next;
    });
    render(FileList, {
      props: {
        files,
        selected: { path: "src/lib/AppShell.svelte", side: "unstaged" },
        query,
        disabled: false,
        onQuery,
        onSelect: vi.fn(),
        onStage: vi.fn(),
        onUnstage: vi.fn(),
      },
    });

    expect(document.querySelector(".field-count")?.textContent).toBe("1/2");
    expect(document.querySelector(".file-name mark")?.textContent).toBe("lib");

    const listbox = screen.getByRole("listbox", { name: "改动文件" });
    listbox.focus();
    await fireEvent.keyDown(listbox, { key: "/" });
    expect(document.activeElement?.id).toBe("file-search");
  });

  it("分支弹层搜索无匹配时提供带入搜索词的新建分支入口，并高亮匹配分支名", async () => {
    const opened = {
      generation: 1,
      summary: { name: "twiglane", path: "/repo/twiglane", isWorktree: false },
      snapshot: {
        branch: { name: "main", headOid: "abc1234", detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 },
        files: [],
        mergeInProgress: false,
      },
    } as unknown as OpenedRepository;

    vi.spyOn(api, "branchList").mockResolvedValue({
      generation: 1,
      defaultBranch: "main",
      mergeBases: ["main"],
      branches: [
        { name: "main", remote: false, current: true, upstream: null, oid: "abc1234", merged: false, worktree: null },
        { name: "feature/ux-polish", remote: false, current: false, upstream: null, oid: "def5678", merged: false, worktree: null },
      ],
    } as never);
    vi.spyOn(api, "branchTracking").mockResolvedValue({ generation: 1, branches: [] } as never);

    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const onCreateBranch = vi.fn();
    const onCreateWorktree = vi.fn();

    render(BranchSwitcher, {
      props: {
        anchor,
        opened,
        blockedReason: null,
        nextId: () => 1,
        onBusy: vi.fn(),
        onGeneration: vi.fn(),
        onSnapshot: vi.fn(),
        onFailure: vi.fn(),
        onNotice: vi.fn(),
        onCommand: vi.fn(),
        onCreateBranch,
        onCreateWorktree,
        onClose: vi.fn(),
      },
    });

    const input = await screen.findByPlaceholderText("搜索本地或远程分支");
    await waitFor(() => expect(document.querySelectorAll(".branch-option").length).toBeGreaterThanOrEqual(1));

    await fireEvent.input(input, { target: { value: "ux" } });
    await waitFor(() => expect(document.querySelector(".branch-option-name mark")?.textContent).toBe("ux"));

    await fireEvent.input(input, { target: { value: "feature/new-flow" } });
    const createBtn = await screen.findByRole("button", { name: "以「feature/new-flow」新建分支" });
    await fireEvent.click(createBtn);
    expect(onCreateBranch).toHaveBeenCalledWith(undefined, "feature/new-flow");
    // 同一个名字也可以直接放进新工作区（本机仓库才传这个回调）。
    await fireEvent.click(screen.getByRole("button", { name: "在新工作区新建" }));
    expect(onCreateWorktree).toHaveBeenCalledWith("feature/new-flow");
    anchor.remove();
  });

  it("差异区支持 ] 与 [ 键跳转改动块，并在滚动后为工具栏添加 scrolled 状态", async () => {
    const diff: DiffResponse = {
      generation: 1,
      path: "src/app.ts",
      staged: false,
      binary: false,
      truncated: false,
      text: "",
      summary: "",
      complete: true,
      snapshot: "",
      offset: 0,
      totalLines: 8,
      additions: 2,
      deletions: 0,
      lines: [
        { kind: "hunk", text: "@@ -1,2 +1,3 @@", oldNo: null, newNo: null, hunkIndex: 0 },
        { kind: "context", text: " a", oldNo: 1, newNo: 1, hunkIndex: 0 },
        { kind: "add", text: "+b", oldNo: null, newNo: 2, hunkIndex: 0 },
        { kind: "context", text: " c", oldNo: 2, newNo: 3, hunkIndex: 0 },
        { kind: "hunk", text: "@@ -10,2 +11,3 @@", oldNo: null, newNo: null, hunkIndex: 1 },
        { kind: "context", text: " x", oldNo: 10, newNo: 11, hunkIndex: 1 },
        { kind: "add", text: "+y", oldNo: null, newNo: 12, hunkIndex: 1 },
        { kind: "context", text: " z", oldNo: 11, newNo: 13, hunkIndex: 1 },
      ],
      hunks: [
        { index: 0, header: "@@ -1,2 +1,3 @@", complete: true, stageable: true, startLine: 0, lineCount: 4 },
        { index: 1, header: "@@ -10,2 +11,3 @@", complete: true, stageable: true, startLine: 4, lineCount: 4 },
      ],
    };

    render(DiffView, {
      props: {
        selection: { path: "src/app.ts", side: "unstaged" },
        diff,
        error: null,
        loading: false,
        disabled: false,
        onStageHunk: vi.fn(),
        onLoadMore: vi.fn(),
      },
    });

    const scroller = document.querySelector<HTMLElement>(".diff-scroll")!;
    const toolbar = document.querySelector<HTMLElement>(".diff-toolbar")!;
    expect(toolbar.classList.contains("scrolled")).toBe(false);

    scroller.focus();
    await fireEvent.keyDown(scroller, { key: "]" });
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(toolbar.classList.contains("scrolled")).toBe(true);

    await fireEvent.keyDown(scroller, { key: "[" });
    expect(scroller.scrollTop).toBe(0);
    expect(toolbar.classList.contains("scrolled")).toBe(false);
  });

  describe("审查工作台：状态除颜色外都有图标、文字或形状提示", () => {
    const entry = (overrides: Partial<ReviewSourceEntry>): ReviewSourceEntry => ({
      reviewId: "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8",
      repoName: "twiglane",
      projectLabel: "独立仓库",
      active: false,
      inCurrentRepo: true,
      order: null,
      acceptedLabel: "刚刚",
      acceptedAt: 1,
      comments: 0,
      unsent: 0,
      drafts: 0,
      reviewed: 0,
      total: null,
      hue: 238,
      badge: "T",
      details: [],
      ...overrides,
    });

    it("完成栏的警告、错误与成功分项各有不同图标与文字，不只是换颜色", () => {
      const model = reviewCompletion({
        source: "local",
        commentCount: 2,
        draftCount: 1,
        staleCount: 1,
        handoff: { state: "failed", message: "无法写入意见交接文件" },
        gitResult: { kind: "committed", oid: "abcdef1234567890" },
        worktree: { state: "unknown" },
        returnState: { state: "returned", revision: 1 },
        writeLocked: false,
        canFeedback: true,
      });
      render(ReviewCompletionBar, { props: { model } });
      const items = [...document.querySelectorAll(".review-completion-item")];
      for (const item of items) {
        expect(item.querySelector("svg.icon"), item.textContent ?? "").not.toBeNull();
        expect(item.textContent?.trim().length ?? 0).toBeGreaterThan(2);
      }
      const byTone = (tone: string) => items.filter((item) => item.getAttribute("data-tone") === tone);
      const neutral = iconOf(byTone("neutral")[0]);
      const warn = iconOf(byTone("warn")[0]);
      const error = iconOf(byTone("error")[0]);
      const success = iconOf(byTone("success")[0]);
      expect(new Set([neutral, warn, error, success]).size).toBe(4);
      expect(byTone("warn").map((item) => item.textContent?.trim())).toEqual(
        expect.arrayContaining(["1 条草稿未保存", "1 条意见已失效，不会送回", "没有读到工作区状态（按未知处理）"]),
      );
      expect(byTone("error")[0].textContent).toContain("没有被唤起");
      expect(document.querySelector(".review-completion")?.getAttribute("data-tone")).toBe("error");
    });

    it("整页错误态是 alert 并带错误图标，警告态与正常态的图标不同", () => {
      const { unmount } = render(ReviewStatePanel, { props: { kind: "read-failed", title: "读取任务范围失败", message: "起点不可用。", detail: "错误码 baseline_missing" } });
      const failed = document.querySelector("[data-review-state=read-failed]");
      expect(failed?.getAttribute("role")).toBe("alert");
      expect(failed?.querySelector(".empty-icon.err svg.icon")).not.toBeNull();
      const errorIcon = iconOf(failed);
      unmount();
      render(ReviewStatePanel, { props: { kind: "source-expired", title: "审查来源已失效", message: "请重新发起。" } });
      const expired = document.querySelector("[data-review-state=source-expired]");
      expect(expired?.getAttribute("role")).toBe("status");
      expect(expired?.querySelector(".empty-icon.warn svg.icon")).not.toBeNull();
      expect(iconOf(expired)).not.toBe(errorIcon);
    });

    it("来源菜单用文字标出当前来源与最新/较早发起，当前项带 aria-current", async () => {
      render(ReviewSourceCard, {
        props: {
          entries: [
            entry({ active: true, order: "最新发起" }),
            entry({ reviewId: "7a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9", repoName: "review", badge: "R", order: "较早发起", comments: 2, unsent: 1 }),
          ],
          onChoose: vi.fn(),
          onClose: vi.fn(),
        },
      });
      await fireEvent.click(screen.getByRole("button", { name: "选择 Cliora 审查来源" }));
      const rows = [...document.querySelectorAll(".review-source-menu li")];
      expect(rows[0].querySelector("[data-tag=current]")?.textContent).toBe("当前");
      expect(rows[0].querySelector(".review-source-switch")?.getAttribute("aria-current")).toBe("true");
      expect(rows[0].querySelector("[data-order]")?.textContent).toBe("最新发起");
      expect(rows[1].querySelector("[data-tag=current]")).toBeNull();
      expect(rows[1].querySelector("[data-order]")?.textContent).toBe("较早发起");
      expect(rows[1].textContent).toContain("2 条意见（1 条未送回）");
    });

    it("意见编辑器的错误带图标与 alert，失效意见带「已失效」文字标签", () => {
      const anchor = { path: "src/App.svelte", hunkIndex: 0, kind: "del" as const, oldNo: 3, newNo: null, quote: "import x" };
      const { unmount } = render(InlineCommentEditor, { props: { anchor, body: "", error: "意见正文不能为空。", onInput: vi.fn(), onSave: vi.fn(), onCancel: vi.fn() } });
      const error = document.querySelector(".inline-comment-error");
      expect(error?.getAttribute("role")).toBe("alert");
      expect(error?.querySelector("svg.icon")).not.toBeNull();
      expect(document.querySelector(".inline-comment-editor textarea")?.getAttribute("aria-invalid")).toBe("true");
      unmount();
      const comment: ReviewComment = { id: "c1", anchor, body: "旧意见", createdAt: 1, updatedAt: 1 };
      const stale: StaleCommentBatch[] = [{
        scope: { reviewId: "r", sessionId: "s", worktree: "/w", baselineOid: "a", headOid: "b", rangeVersion: "v", generation: 1 },
        comments: [comment],
        reason: "任务范围已经变化。",
      }];
      render(ReviewCommentsDrawer, { props: { comments: [], stale } });
      const section = document.querySelector(".review-comment-stale");
      expect(section?.querySelector(".review-comment-group-head svg.icon")).not.toBeNull();
      expect(section?.querySelector(".review-stale-tag")?.textContent).toContain("已失效");
      expect(section?.querySelector(".review-comment-card.stale")).not.toBeNull();
    });

    it("当前选择、已审阅与已有意见在样式上有形状提示（选中条、描边、常显）", () => {
      const components = css("components.css");
      // 当前选择：选中行左侧的实心条。
      expect(declarations(components, '.file-row[aria-selected="true"]::before')).toMatch(/content:\s*""/);
      expect(declarations(components, '.file-row[aria-selected="true"]::before')).toMatch(/width:\s*2\.5px/);
      // 已审阅：勾选按钮多一圈描边，选中行上的未审阅勾只有图标没有描边。
      expect(declarations(components, ".review-toggle.on")).toMatch(/box-shadow:\s*inset 0 0 0 1px currentColor/);
      // 已有意见：行标记与块标记都有描边，行标记常显、未挂意见的只在悬停/聚焦时出现。
      expect(declarations(components, ".hunk-btn.line-comment.commented")).toMatch(/box-shadow:\s*inset 0 0 0 1px currentColor/);
      expect(declarations(components, ".hunk-btn.hunk-comment.commented")).toMatch(/box-shadow:\s*inset 0 0 0 1px currentColor/);
      expect(components).toMatch(/\.diff-line \.line-comment:not\(\.commented\)[^{]*\{[^}]*opacity:\s*0/);
      // 审查视图的状态点：警告时从圆点换成方块（形状），不只换颜色。
      const review = css("review.css");
      expect(declarations(review, ".view-review-dot")).toMatch(/border-radius:\s*50%/);
      expect(declarations(review, '.view-review-dot[data-tone="warn"]')).toMatch(/border-radius:\s*3px/);
    });
  });

  describe("临时保存预览、筛选、恢复并删除与远端降级", () => {
    const baseOpened = {
      generation: 5,
      summary: { name: "twiglane", path: "/repo/twiglane" },
      draft: "",
      watchDegraded: false,
      snapshot: {
        generation: 5,
        branch: {
          name: "main",
          detached: false,
          unborn: false,
          headOid: "a".repeat(40),
          upstream: null,
          ahead: 0,
          behind: 0,
          liveRemoteChecked: false,
          remoteCheckedAtMs: null,
          remoteCheckStale: false,
        },
        files: [],
      },
    } as OpenedRepository;

    const stashStateData: StashState = {
      generation: 5,
      preview: {
        trackedCount: 0,
        untrackedCount: 0,
        ignoredCount: 0,
        trackedPaths: [],
        untrackedPaths: [],
        ignoredPaths: [],
        includeUntracked: false,
        canSave: false,
        summary: "没有可保存的改动。",
      },
      records: [
        { oid: "1111111111111111111111111111111111111111", message: "实验性重构", committedAt: 1_700_000_100 },
        { oid: "2222222222222222222222222222222222222222", message: "修样式细节", committedAt: 1_700_000_000 },
      ],
      snapshot: baseOpened.snapshot,
    };

    it("支持记录筛选、展开预览已跟踪与未跟踪文件及只读差异，以及恢复并删除（含冲突保留记录）", async () => {
      vi.spyOn(api, "stashState").mockResolvedValue(stashStateData);
      const detailSpy = vi.spyOn(api, "stashDetail").mockResolvedValue({
        generation: 5,
        oid: stashStateData.records[0].oid,
        message: stashStateData.records[0].message,
        committedAt: stashStateData.records[0].committedAt,
        files: [
          { path: "src/app.ts", originalPath: null, status: "modified", untracked: false, additions: 2, deletions: 1, binary: false },
          { path: "notes/draft.md", originalPath: null, status: "added", untracked: true, additions: 1, deletions: 0, binary: false },
        ],
      });
      const diffSpy = vi.spyOn(api, "stashFileDiff").mockImplementation(async (_repo, _oid, rel, untracked) => ({
        generation: 5,
        path: rel,
        staged: false,
        binary: false,
        text: null,
        summary: untracked ? "未跟踪新增" : "修改",
        additions: 1,
        deletions: 0,
        complete: true,
        truncated: false,
        snapshot: `stash-${rel}`,
        hunks: [{ index: 0, header: "@@ -1,1 +1,2 @@", complete: true, stageable: false, startLine: 0, lineCount: 2 }],
        lines: [
          { kind: "hunk", text: "@@ -1,1 +1,2 @@", oldNo: null, newNo: null, hunkIndex: 0 },
          { kind: "add", text: untracked ? "+草稿内容" : "+const ok = true;", oldNo: null, newNo: 1, hunkIndex: 0 },
        ],
        offset: 0,
        totalLines: 2,
      }));
      const popSpy = vi.spyOn(api, "popStash").mockResolvedValue({
        generation: 6,
        oid: stashStateData.records[0].oid,
        kept: true,
        operation: "stash",
        conflicted: true,
        conflictPaths: ["src/app.ts"],
        canAbortMerge: false,
        note: "恢复发生冲突，原保存记录仍保留。",
        snapshot: baseOpened.snapshot,
      });
      const onOpenChanges = vi.fn();

      render(StashPanel, {
        props: {
          opened: baseOpened,
          disabled: false,
          nextId: () => 1,
          onGeneration: vi.fn(),
          onSnapshot: vi.fn(),
          onFailure: vi.fn(),
          onNotice: vi.fn(),
          onOpenChanges,
        },
      });

      expect(await screen.findByText("实验性重构")).toBeTruthy();
      expect(screen.getByText("修样式细节")).toBeTruthy();

      // 筛选记录
      const filterInput = screen.getByLabelText("筛选临时保存记录");
      await fireEvent.input(filterInput, { target: { value: "重构" } });
      expect(screen.queryByText("修样式细节")).toBeNull();
      expect(screen.getByText("实验性重构")).toBeTruthy();

      // 展开预览已跟踪与未跟踪文件及只读 DiffView
      await fireEvent.click(screen.getByRole("button", { name: /预览临时保存 1111111 内容/ }));
      await waitFor(() => expect(detailSpy).toHaveBeenCalledWith("/repo/twiglane", stashStateData.records[0].oid, 5, 1));
      expect(await screen.findByText("未跟踪")).toBeTruthy();
      await waitFor(() => expect(diffSpy).toHaveBeenCalledWith("/repo/twiglane", stashStateData.records[0].oid, "src/app.ts", false, 5, 1, null, 0, 0));
      expect(document.body.textContent).toContain("const ok = true;");

      // 切换到未跟踪文件预览
      await fireEvent.click(screen.getByRole("button", { name: /draft\.md/ }));
      await waitFor(() => expect(diffSpy).toHaveBeenCalledWith("/repo/twiglane", stashStateData.records[0].oid, "notes/draft.md", true, 5, 1, null, 0, 0));
      expect(document.body.textContent).toContain("草稿内容");

      // 恢复并删除（冲突时保留记录并提供冲突文件入口）
      await fireEvent.click(screen.getByRole("button", { name: "恢复并删除" }));
      await waitFor(() => expect(popSpy).toHaveBeenCalledWith("/repo/twiglane", stashStateData.records[0].oid, 5, 1));
      const conflictBtn = await screen.findByRole("button", { name: "查看冲突 src/app.ts" });
      await fireEvent.click(conflictBtn);
      expect(onOpenChanges).toHaveBeenCalledWith("src/app.ts");
    });

    it("远端 SSH 仓库对新增补丁/上下文/Stash 扩展命令明确返回中文限制说明", async () => {
      const remoteKey = "ssh://host-1/srv/app";
      await expect(api.diffContextLines(remoteKey, "a.ts", false, 1, 20, 1, 1)).rejects.toMatchObject({
        code: "remote_unsupported",
        message: REMOTE_CONTEXT_EXPAND_UNSUPPORTED_REASON,
      });
      await expect(api.discardHunks(remoteKey, "a.ts", false, [0], "snap", 1, 1)).rejects.toMatchObject({
        code: "remote_unsupported",
        message: REMOTE_DISCARD_PATCH_UNSUPPORTED_REASON,
      });
      await expect(api.discardLines(remoteKey, "a.ts", false, [], "snap", 1, 1)).rejects.toMatchObject({
        code: "remote_unsupported",
        message: REMOTE_DISCARD_PATCH_UNSUPPORTED_REASON,
      });
      await expect(api.stashDetail(remoteKey, "a".repeat(40), 1, 1)).rejects.toMatchObject({
        code: "remote_unsupported",
        message: REMOTE_STASH_EXTENDED_UNSUPPORTED_REASON,
      });
      await expect(api.stashFileDiff(remoteKey, "a".repeat(40), "a.ts", false, 1, 1)).rejects.toMatchObject({
        code: "remote_unsupported",
        message: REMOTE_STASH_EXTENDED_UNSUPPORTED_REASON,
      });
      await expect(api.popStash(remoteKey, "a".repeat(40), 1, 1)).rejects.toMatchObject({
        code: "remote_unsupported",
        message: REMOTE_STASH_EXTENDED_UNSUPPORTED_REASON,
      });
    });
  });
});
