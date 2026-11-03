import type { CommitDetail, DiffResponse, OpenedRepository } from "../../src/lib/types";

/** 独立压力测试的数据工具，不由普通测试导入。 */
export class PerformanceFixture {
  readonly opened: OpenedRepository = {
    summary: { path: "/fixture", name: "fixture" }, generation: 1, draft: "", watchDegraded: false,
    snapshot: { generation: 1, files: [], branch: {
      name: "main", detached: false, unborn: false, headOid: "a".repeat(40), upstream: null,
      ahead: null, behind: null, liveRemoteChecked: false, remoteCheckedAtMs: null, remoteCheckStale: false,
    } },
  };
  readonly detail: CommitDetail = {
    generation: 1, root: false, merge: false, selectedParent: "b".repeat(40), body: "",
    commit: { oid: "a".repeat(40), parents: ["b".repeat(40)], summary: "large", authorName: "Test", authorEmail: "test@example.com", authoredAt: 0, labels: [] },
    files: Array.from({ length: 20_000 }, (_, i) => ({ path: `file-${i}.txt`, originalPath: null, status: "modified" })),
  };
  readonly diff: DiffResponse = {
    generation: 1, path: "file-0.txt", staged: false, binary: false, text: null, summary: "", additions: 1, deletions: 0,
    complete: true, truncated: false, snapshot: "1", hunks: [], offset: 0, totalLines: 5000,
    lines: Array.from({ length: 5000 }, (_, i) => ({ kind: "add", oldNo: null, newNo: i + 1, text: `+line ${i}`, hunkIndex: null })),
  };

}
