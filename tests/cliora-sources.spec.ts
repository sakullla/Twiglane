import { afterEach, describe, expect, it } from "vitest";
import {
  beginClioraReview, captureClioraReview, clioraSourceAcceptedAt, clioraSourceEpoch, clioraBaseline, clioraReview, clioraReturnOutcome,
  forgetClioraReview, forgetClioraSourceUnless, hydrateClioraReviews, recordClioraCommit, resetClioraReview,
  sameWorktreePath, selectClioraSource,
} from "../src/lib/cliora-review.svelte";
import { CHANGES_SCOPE, beginReviewProgress, markReviewedIn, resetReviewProgress, reviewTokenOf } from "../src/lib/review-progress.svelte";
const source = (reviewId: string, worktreePath: string, baseline = "a".repeat(40)) => ({
  protocolVersion: 3 as const, reviewId, sessionId: `session-${reviewId}`, worktreePath, baseline,
  workspaceId: `project-${reviewId}`, repositoryId: `repository-${reviewId}`, workspaceName: `项目 ${reviewId}`,
});
afterEach(() => { resetClioraReview(); resetReviewProgress(); });
describe("multiple Cliora sources", () => {
  it("restores A after B with independent baselines, project identity and results", () => {
    beginClioraReview(source("A", "/work/a"));
    recordClioraCommit("/work/a", "c".repeat(40));
    beginClioraReview(source("B", "/work/b", "b".repeat(40)));
    expect(clioraReturnOutcome().outcome).toBe("reviewed");
    recordClioraCommit("/work/a", "d".repeat(40));
    expect(clioraReview.result).toBeNull();
    forgetClioraSourceUnless("/work/a");
    expect(clioraReview.source?.workspaceId).toBe("project-A");
    expect(clioraBaseline()).toBe("a".repeat(40));
    expect(clioraReturnOutcome()).toEqual({ outcome: "committed", headOid: "c".repeat(40) });
    expect(clioraReview.sources).toHaveLength(2);
    forgetClioraSourceUnless("/work/b");
    expect(clioraBaseline()).toBe("b".repeat(40));
    expect(clioraReturnOutcome().outcome).toBe("reviewed");
  });
  it("selects one source on a shared checkout and rejects late writes captured for the other", () => {
    beginClioraReview(source("A", "/work/shared"));
    const captured = captureClioraReview("/work/shared");
    beginClioraReview(source("B", "/work/shared", "b".repeat(40)));
    recordClioraCommit("/work/shared", "c".repeat(40), captured);
    expect(clioraReview.result).toBeNull();
    recordClioraCommit("/work/shared", "d".repeat(40));
    selectClioraSource("A");
    expect(clioraBaseline()).toBe("a".repeat(40));
    expect(clioraReview.result?.headOid).toBe("c".repeat(40));
    selectClioraSource(null);
    recordClioraCommit("/work/shared", "e".repeat(40));
    expect(clioraReview.source).toBeNull();
    selectClioraSource("B");
    expect(clioraReview.result?.headOid).toBe("d".repeat(40));
    beginClioraReview(source("B", "/work/shared", "b".repeat(40)));
    expect(clioraReview.result?.headOid).toBe("d".repeat(40));
  });
  it("refuses capacity without evicting and releases only the explicitly closed source", () => {
    for (let index = 0; index < 8; index++) beginClioraReview(source(String(index), `/work/${index}`));
    expect(() => beginClioraReview(source("overflow", "/work/overflow"))).toThrow(/已满/);
    expect(clioraReview.sources.map((item) => item.reviewId)).toContain("0");
    forgetClioraReview("3");
    expect(clioraReview.source?.reviewId).toBe("7");
    beginClioraReview(source("overflow", "/work/overflow"));
    expect(clioraReview.sources).toHaveLength(8);
  });
  it("rejects a late native snapshot after close or a newer Git success", () => {
    const a = source("A", "/work/a");
    beginClioraReview(a); const beforeClose = clioraSourceEpoch();
    forgetClioraReview("A");
    expect(hydrateClioraReviews([{ source: a, result: null, lastReturn: null }], beforeClose)).toBe(false);
    expect(clioraReview.sources).toHaveLength(0);
    beginClioraReview(a); const beforeWrite = clioraSourceEpoch();
    recordClioraCommit("/work/a", "c".repeat(40));
    expect(hydrateClioraReviews([{ source: a, result: null, lastReturn: null }], beforeWrite)).toBe(false);
    expect(clioraReview.result?.headOid).toBe("c".repeat(40));
    selectClioraSource(null); forgetClioraSourceUnless("/work/other"); forgetClioraSourceUnless("/work/a");
    expect(clioraReview.source).toBeNull();
  });

  it("hydrates the running native process without inventing an active source or merging results", () => {
    const a = source("A", "/work/shared"); const b = source("B", "/work/shared", "b".repeat(40));
    hydrateClioraReviews([
      { source: a, result: { outcome: "committed", headOid: "c".repeat(40), recordedAt: 1 }, lastReturn: { revision: 2, declaration: { reviewId: "A", sessionId: a.sessionId, outcome: "committed", headOid: "c".repeat(40), worktreeState: "dirty", meta: [] } } },
      { source: b, result: null, lastReturn: null },
    ]);
    expect(clioraReview.sources).toHaveLength(2);
    expect(clioraReview.source).toBeNull();
    forgetClioraSourceUnless("/work/shared");
    expect(clioraReview.source).toBeNull();
    selectClioraSource("A"); expect(clioraReview.result?.headOid).toBe("c".repeat(40)); expect(clioraReview.lastReturn?.revision).toBe(2);
    selectClioraSource("B"); expect(clioraReview.result).toBeNull(); expect(clioraBaseline()).toBe("b".repeat(40));
    hydrateClioraReviews([]); expect(clioraReview.sources).toHaveLength(0);
  });

  it("keeps native acceptedAt per source and treats a missing or invalid value as null", () => {
    const a = source("A", "/work/shared"); const b = source("B", "/work/shared", "b".repeat(40)); const c = source("C", "/work/c");
    hydrateClioraReviews([
      { source: a, result: null, lastReturn: null, acceptedAt: 1_700_000_000_000 },
      { source: b, result: null, lastReturn: null, acceptedAt: 1_700_000_500_000 },
      { source: c, result: null, lastReturn: null },
    ]);
    expect(clioraSourceAcceptedAt("A")).toBe(1_700_000_000_000);
    expect(clioraSourceAcceptedAt("B")).toBe(1_700_000_500_000);
    expect(clioraSourceAcceptedAt("C")).toBeNull();
    expect(clioraSourceAcceptedAt("missing")).toBeNull();
    expect(clioraReview.acceptedAt).toBeNull();
    forgetClioraSourceUnless("/work/shared");
    selectClioraSource("B"); expect(clioraReview.acceptedAt).toBe(1_700_000_500_000);
    selectClioraSource("A"); expect(clioraReview.acceptedAt).toBe(1_700_000_000_000);
    expect(clioraReview.source).not.toHaveProperty("acceptedAt");
    hydrateClioraReviews([{ source: a, result: null, lastReturn: null, acceptedAt: Number.NaN }, { source: c, result: null, lastReturn: null, acceptedAt: null }]);
    expect(clioraSourceAcceptedAt("A")).toBeNull();
    expect(clioraSourceAcceptedAt("C")).toBeNull();
  });

  it("stamps a newly accepted source locally without resetting a known one", () => {
    beginClioraReview({ ...source("A", "/work/a"), acceptedAt: 42 });
    expect(clioraSourceAcceptedAt("A")).toBe(42);
    expect(clioraReview.source).not.toHaveProperty("acceptedAt");
    beginClioraReview({ ...source("A", "/work/a"), acceptedAt: 99 });
    expect(clioraSourceAcceptedAt("A")).toBe(42);
    const before = Date.now();
    beginClioraReview(source("B", "/work/b"));
    expect(clioraSourceAcceptedAt("B")).toBeGreaterThanOrEqual(before);
  });

  it("uses the same platform-aware path identity for sources and local review progress", () => {
    expect(sameWorktreePath("C:\\Work\\Repo", "c:/work/repo/")).toBe(true);
    expect(sameWorktreePath("/work/Repo", "/work/repo")).toBe(false);
    expect(sameWorktreePath("/work/a\\b", "/work/a/b")).toBe(false);
    beginClioraReview(source("A", "/work/Repo"));
    forgetClioraSourceUnless("/work/repo");
    expect(clioraReview.source).toBeNull();
    const target = { worktree: "/work/a\\b", scope: CHANGES_SCOPE };
    beginReviewProgress(target.worktree); markReviewedIn(target, "file", "token");
    expect(reviewTokenOf({ ...target, worktree: "/work/a/b" }, "file")).toBeNull();
    expect(reviewTokenOf(target, "file")).toBe("token");
  });
});
