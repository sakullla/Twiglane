import { describe, expect, it } from "vitest";
import {
  buildHistoryGraph,
  clipSegments,
  drawableLanes,
  graphRowLabel,
  visibleNodeLane,
  GRAPH_MAX_LANES,
  type GraphCommit,
  type GraphSegment,
} from "../src/lib/history-graph";

/** 每个用例都检查：竖线两端一致，汇入只指向本行节点，分叉只从本行节点出发，lane 坐标落在行宽内。 */
function expectConsistent(commits: GraphCommit[], graph: ReturnType<typeof buildHistoryGraph>) {
  expect(graph.rows).toHaveLength(commits.length);
  graph.rows.forEach((row, index) => {
    expect(row.oid).toBe(commits[index].oid);
    expect(row.lane).toBeGreaterThanOrEqual(0);
    expect(row.lanes).toBeGreaterThan(row.lane);
    for (const segment of row.segments) {
      expect(segment.from).toBeGreaterThanOrEqual(0);
      expect(segment.to).toBeGreaterThanOrEqual(0);
      expect(segment.from).toBeLessThan(row.lanes);
      expect(segment.to).toBeLessThan(row.lanes);
      if (segment.kind === "pass") expect(segment.from).toBe(segment.to);
      if (segment.kind === "merge") expect(segment.to).toBe(row.lane);
      if (segment.kind === "branch" || segment.kind === "outside") expect(segment.from).toBe(row.lane);
    }
    for (const parent of row.parents) {
      expect(parent.lane).toBeGreaterThanOrEqual(0);
      expect(parent.lane).toBeLessThan(row.lanes);
    }
  });
}

function segmentsOf(kind: GraphSegment["kind"], list: GraphSegment[]): GraphSegment[] {
  return list.filter((segment) => segment.kind === kind);
}

describe("历史拓扑", () => {
  it("线性历史只用一条 lane，父提交逐行精确配对", () => {
    const commits: GraphCommit[] = [
      { oid: "aaa", parents: ["bbb"] },
      { oid: "bbb", parents: ["ccc"] },
      { oid: "ccc", parents: [] },
    ];
    const graph = buildHistoryGraph(commits);
    expectConsistent(commits, graph);
    expect(graph.lanes).toBe(1);
    expect(graph.overflow).toBe(false);
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(graph.rows.map((row) => row.color)).toEqual([0, 0, 0]);
    expect(graph.rows.every((row) => row.overflow === false)).toBe(true);
    expect(graph.rows.every((row) => segmentsOf("merge", row.segments).length === 0)).toBe(true);
    expect(graph.rows.every((row) => segmentsOf("branch", row.segments).length === 0)).toBe(true);
    expect(graph.rows[0].parents).toEqual([{ oid: "bbb", lane: 0, state: "visible" }]);
    // 最后一行不再向下等待：竖线只画到节点。
    expect(graph.rows[2].segments).toEqual([
      { from: 0, to: 0, color: 0, kind: "pass", span: "top" },
    ]);
    expect(graph.rows[2].parents).toEqual([]);
    expect(graphRowLabel(graph.rows[2])).toBe("根提交：没有父提交。");
  });

  it("两个分支指向同一个父提交时汇入父提交所在 lane，不把相邻行当父提交", () => {
    const commits: GraphCommit[] = [
      { oid: "left", parents: ["base"] },
      { oid: "right", parents: ["base"] },
      { oid: "base", parents: [] },
    ];
    const graph = buildHistoryGraph(commits);
    expectConsistent(commits, graph);
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 1, 0]);
    expect(graph.rows[1].parents).toEqual([{ oid: "base", lane: 0, state: "visible" }]);
    // 第二个分支从自己的 lane 向下接到父提交所在的 lane，父提交那条竖线继续穿过这一行。
    expect(segmentsOf("branch", graph.rows[1].segments)).toEqual([
      { from: 1, to: 0, color: 0, kind: "branch", span: "bottom" },
    ]);
    expect(segmentsOf("pass", graph.rows[1].segments)).toEqual([
      { from: 0, to: 0, color: 0, kind: "pass", span: "full" },
    ]);
    // 第二行自己的 lane 不再向下延续：line 1 只存在于这一行。
    expect(graph.rows[2].segments.every((segment) => segment.from === 0 && segment.to === 0)).toBe(true);
    expect(graph.rows[2].lanes).toBe(1);
  });

  it("合并提交的多父提交各占一条 lane，父提交按真实 Hash 配对", () => {
    const commits: GraphCommit[] = [
      { oid: "merge", parents: ["main1", "side1"] },
      { oid: "side1", parents: [] },
      { oid: "main1", parents: [] },
    ];
    const graph = buildHistoryGraph(commits);
    expectConsistent(commits, graph);
    expect(graph.rows[0].parents).toEqual([
      { oid: "main1", lane: 0, state: "visible" },
      { oid: "side1", lane: 1, state: "visible" },
    ]);
    expect(segmentsOf("branch", graph.rows[0].segments)).toEqual([
      { from: 0, to: 1, color: 1, kind: "branch", span: "bottom" },
    ]);
    // 未匹配到的那条 lane 继续竖着穿过中间那行，而不是连到它的提交节点上。
    expect(graph.rows[1].lane).toBe(1);
    expect(segmentsOf("pass", graph.rows[1].segments)).toContainEqual(
      { from: 0, to: 0, color: 0, kind: "pass", span: "full" },
    );
    expect(graphRowLabel(graph.rows[0])).toBe("合并提交：父提交 main1；父提交 side1。");
  });

  it("第二父提交就是主线的祖先时，主线保持在左侧一条直线，右侧在父提交所在行汇回", () => {
    // merge 的第二父提交 base 同时也是 a 的父提交（常见的「分支合并回主线」形状）。
    const commits: GraphCommit[] = [
      { oid: "merge", parents: ["a", "base"] },
      { oid: "a", parents: ["base"] },
      { oid: "base", parents: ["root"] },
      { oid: "root", parents: [] },
    ];
    const graph = buildHistoryGraph(commits);
    expectConsistent(commits, graph);
    // a 不拐到右侧那条 lane：继续在 lane 0 往下，没有从自己出发的斜线。
    expect(graph.rows[1].lane).toBe(0);
    expect(segmentsOf("branch", graph.rows[1].segments)).toEqual([]);
    expect(graph.rows[1].parents).toEqual([{ oid: "base", lane: 0, state: "visible" }]);
    // base 仍在 lane 0，右侧的第二父提交线在这一行汇入，之后只剩一条 lane。
    expect(graph.rows[2].lane).toBe(0);
    expect(segmentsOf("merge", graph.rows[2].segments)).toEqual([
      { from: 1, to: 0, color: 0, kind: "merge", span: "top" },
    ]);
    expect(graph.rows[3].lane).toBe(0);
    expect(graph.rows[3].lanes).toBe(1);
  });

  it("三个及以上的父提交同样逐条分叉", () => {
    const commits: GraphCommit[] = [
      { oid: "octopus", parents: ["p1", "p2", "p3"] },
      { oid: "p3", parents: [] },
      { oid: "p2", parents: [] },
      { oid: "p1", parents: [] },
    ];
    const graph = buildHistoryGraph(commits);
    expectConsistent(commits, graph);
    expect(graph.rows[0].parents.map((parent) => parent.lane)).toEqual([0, 1, 2]);
    expect(segmentsOf("branch", graph.rows[0].segments).map((segment) => segment.to)).toEqual([1, 2]);
    expect(graph.lanes).toBe(3);
    expect(graph.rows[0].lanes).toBe(3);
  });

  it("父提交不在当前结果里时明确标成结果外，不连到后面的无关行", () => {
    const commits: GraphCommit[] = [
      { oid: "tip", parents: ["gone"] },
      { oid: "other", parents: [] },
    ];
    const graph = buildHistoryGraph(commits);
    expectConsistent(commits, graph);
    expect(graph.rows[0].parents).toEqual([{ oid: "gone", lane: 0, state: "outside" }]);
    // 结果外的第一父提交沿本行 lane 竖直伸出短尾，不斜拐到旁边一条 lane。
    expect(graph.rows[0].segments).toEqual([{ from: 0, to: 0, color: 0, kind: "outside", span: "bottom" }]);
    expect(graph.rows[0].lanes).toBe(1);
    // 终止标记只在本行：下一行从 lane 0 重新开始，和结果外父提交没有任何连线。
    expect(graph.rows[1].lane).toBe(0);
    expect(graph.rows[1].lanes).toBe(1);
    expect(graph.rows[1].segments.some((segment) => segment.from === 1 || segment.to === 1)).toBe(false);
    // 第二行是新起的根提交，没有任何连线（既不回指第一行，也不画出虚假终点）。
    expect(graph.rows[1].segments).toEqual([]);
    const label = graphRowLabel(graph.rows[0]);
    expect(label).toContain("gone");
    expect(label).toContain("不在当前结果中");
    expect(label).not.toContain("根提交");
  });

  it("父提交已出现在更早的行时同样不连：不做环形或回指连接", () => {
    const commits: GraphCommit[] = [
      { oid: "older", parents: [] },
      { oid: "later", parents: ["older"] },
    ];
    const graph = buildHistoryGraph(commits);
    expectConsistent(commits, graph);
    expect(graph.rows[1].parents).toEqual([{ oid: "older", lane: 0, state: "outside" }]);
    expect(graph.rows[1].segments.every((segment) => segment.kind !== "merge")).toBe(true);
  });

  it("搜索或筛选后的结果集重建拓扑：被过滤掉的父提交变成结果外", () => {
    const all: GraphCommit[] = [
      { oid: "a", parents: ["b"] },
      { oid: "b", parents: ["c"] },
      { oid: "c", parents: [] },
    ];
    const filtered: GraphCommit[] = [all[0], all[2]];
    const graph = buildHistoryGraph(filtered);
    expectConsistent(filtered, graph);
    expect(graph.rows[0].parents).toEqual([{ oid: "b", lane: 0, state: "outside" }]);
    expect(graph.rows[1].lane).toBe(0);
    expect(graph.rows[1].segments.some((segment) => segment.from === 1 || segment.to === 1)).toBe(false);
  });

  it("追加页后页边界的父提交重新配对，先前的行与 lane 不变", () => {
    const firstPage: GraphCommit[] = [
      { oid: "a", parents: ["b"] },
      { oid: "b", parents: ["c"] },
    ];
    const before = buildHistoryGraph(firstPage);
    expect(before.rows[1].parents[0].state).toBe("outside");
    const appended = [...firstPage, { oid: "c", parents: [] }];
    const after = buildHistoryGraph(appended);
    expectConsistent(appended, after);
    expect(after.rows[1].parents[0]).toEqual({ oid: "c", lane: 0, state: "visible" });
    expect(after.rows[0].lane).toBe(before.rows[0].lane);
    expect(after.rows[1].lane).toBe(before.rows[1].lane);
    expect(after.rows[0].segments).toEqual(before.rows[0].segments);
    // 页边界两侧仍是同一条 lane，连线连续而不是新起一条。
    expect(after.rows[2].lane).toBe(0);
    expect(segmentsOf("pass", after.rows[2].segments)[0].span).toBe("top");
    expect(after.rows[2].segments.some((segment) => segment.kind === "branch")).toBe(false);
  });

  it("lane 超出紧凑宽度时标记溢出数量，行宽不被撑开", () => {
    const commits: GraphCommit[] = [
      { oid: "root", parents: ["p1", "p2", "p3", "p4"] },
      { oid: "p4", parents: [] },
      { oid: "p3", parents: [] },
      { oid: "p2", parents: [] },
      { oid: "p1", parents: [] },
    ];
    const graph = buildHistoryGraph(commits, { maxLanes: 2 });
    expectConsistent(commits, graph);
    expect(graph.rows[0].lanes).toBe(4);
    expect(graph.rows[0].overflow).toBe(true);
    expect(graph.rows[0].hiddenLanes).toBe(2);
    expect(graph.overflow).toBe(true);
    expect(drawableLanes(graph.lanes, 2)).toBe(2);
    expect(drawableLanes(1, 2)).toBe(1);
    expect(drawableLanes(9, GRAPH_MAX_LANES)).toBe(GRAPH_MAX_LANES);
    // 数据完整保留：超出的 lane 只是不画，不丢父提交。
    expect(graph.rows[0].parents).toHaveLength(4);
  });

  it("HEAD 只标在真实 oid 上，没有 headOid 时以第一行为最新", () => {
    const commits: GraphCommit[] = [
      { oid: "a", parents: [] },
      { oid: "b", parents: [] },
    ];
    expect(buildHistoryGraph(commits).rows.map((row) => row.head)).toEqual([true, false]);
    expect(buildHistoryGraph(commits, { headOid: "b" }).rows.map((row) => row.head)).toEqual([false, true]);
    expect(buildHistoryGraph(commits, { headOid: "missing" }).rows.some((row) => row.head)).toBe(false);
  });

  it("空结果和重复 oid 不产生节点或连线", () => {
    expect(buildHistoryGraph([])).toEqual({ rows: [], lanes: 0, overflow: false });
    const duplicated: GraphCommit[] = [
      { oid: "a", parents: [] },
      { oid: "a", parents: [] },
    ];
    const graph = buildHistoryGraph(duplicated);
    expectConsistent(duplicated, graph);
    // 第二行找不到等待中的同名 lane，只能新开一条，不会连回上一行。
    expect(graph.rows[0].lane).toBe(0);
    expect(graph.rows[1].lane).toBe(0);
    expect(graph.rows[1].segments).toEqual([]);
  });
});

describe("拓扑绘制裁剪", () => {
  const commits: GraphCommit[] = [
    { oid: "root", parents: ["p1", "p2", "p3"] },
    { oid: "p3", parents: [] },
    { oid: "p2", parents: [] },
    { oid: "p1", parents: [] },
  ];

  it("越界 lane 的线段整条丢弃，不夹到最后一格", () => {
    const graph = buildHistoryGraph(commits, { maxLanes: 2 });
    const lanes = drawableLanes(graph.lanes, 2);
    expect(lanes).toBe(2);
    const kept = clipSegments(graph.rows[0].segments, lanes);
    expect(kept.every((segment) => segment.from < lanes && segment.to < lanes)).toBe(true);
    // 两条源线不会被读成一条：留下的分叉各自落在不同的 lane 上。
    const targets = kept.filter((segment) => segment.kind === "branch").map((segment) => segment.to);
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets).size).toBe(targets.length);
    // 越界线段仍在数据里，只是不画。
    expect(graph.rows[0].segments.length).toBeGreaterThan(kept.length);
    expect(graph.rows[0].segments.some((segment) => segment.to >= lanes)).toBe(true);
  });

  it("提交自己在可见区外时不画节点", () => {
    const graph = buildHistoryGraph(commits, { maxLanes: 2 });
    expect(visibleNodeLane(graph.rows[0], 2)).toBe(0);
    expect(visibleNodeLane(graph.rows[0], 1)).toBe(0);
    expect(visibleNodeLane({ ...graph.rows[0], lane: 3 }, 2)).toBeNull();
  });
});

describe("结果外父提交的短尾", () => {
  it("合并提交的第二父提交在结果外时另占一条 lane 画斜向短尾，主线父提交仍直连", () => {
    const commits: GraphCommit[] = [
      { oid: "merge", parents: ["main", "gone"] },
      { oid: "main", parents: [] },
    ];
    const graph = buildHistoryGraph(commits);
    expectConsistent(commits, graph);
    expect(graph.rows[0].parents).toEqual([
      { oid: "main", lane: 0, state: "visible" },
      { oid: "gone", lane: 1, state: "outside" },
    ]);
    expect(segmentsOf("outside", graph.rows[0].segments)).toEqual([{ from: 0, to: 1, color: 1, kind: "outside", span: "bottom" }]);
    expect(graph.rows[1].lanes).toBe(1);
  });

  it("第一父提交在结果外、第二父提交可见时，可见父另起一条 lane，两者不叠在同一条线上", () => {
    const commits: GraphCommit[] = [
      { oid: "merge", parents: ["gone", "side"] },
      { oid: "side", parents: [] },
    ];
    const graph = buildHistoryGraph(commits);
    expectConsistent(commits, graph);
    expect(graph.rows[0].parents).toEqual([
      { oid: "gone", lane: 0, state: "outside" },
      { oid: "side", lane: 1, state: "visible" },
    ]);
    expect(graph.rows[1].lane).toBe(1);
  });
});
