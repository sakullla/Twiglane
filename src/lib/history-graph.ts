/**
 * 提交拓扑：由已加载的 HistoryCommit（oid + parents）和当前顺序推导每行的 lane 与连线。
 *
 * 只做只读推导，不读取 Git、不写状态。父提交只有在「它的 oid 出现在本次加载结果且排在当前行之后」
 * 时才配对连线；其余情况标成 outside（页外/结果外），保留真实父 Hash 供可访问文本使用，
 * 既不画到无关的下一行，也不伪造一个终点。追加载更多页时，调用方把已加载的提交整体再算一次，
 * 页边界两侧的父提交因此按 oid 精确匹配、连线连续。
 */
export interface GraphCommit {
  oid: string;
  parents: string[];
}

export type GraphSegmentKind = "pass" | "merge" | "branch";
export type GraphSegmentSpan = "full" | "top" | "bottom";

export interface GraphSegment {
  /** 行顶部所在的 lane（0 起）。 */
  from: number;
  /** 行底部/节点所在的 lane。 */
  to: number;
  /** 同一血缘固定同一个颜色序号。 */
  color: number;
  /** pass 竖线；merge 从顶部汇入节点；branch 从节点分叉到底部。 */
  kind: GraphSegmentKind;
  /** 竖线的纵向范围：整行、到节点、从节点开始。 */
  span: GraphSegmentSpan;
}

export interface GraphParent {
  oid: string;
  /** 父提交在本行占用的 lane：可见父是继续等待的 lane，结果外父是终止标记的 lane。 */
  lane: number;
  state: "visible" | "outside";
}

export interface GraphRow {
  oid: string;
  /** 提交自己所在的 lane。 */
  lane: number;
  color: number;
  /** 这一行用到的 lane 数（含结果外父的终止标记）。 */
  lanes: number;
  overflow: boolean;
  /** 超出紧凑宽度的 lane 数。 */
  hiddenLanes: number;
  head: boolean;
  segments: GraphSegment[];
  parents: GraphParent[];
}

export interface HistoryGraph {
  rows: GraphRow[];
  /** 整份结果用到的 lane 数。 */
  lanes: number;
  overflow: boolean;
}

export interface GraphOptions {
  /** 紧凑宽度内最多画几条 lane；超出只标记不画。 */
  maxLanes?: number;
  /** 当前 HEAD 的 oid：没有时就以第一行当时的最新提交为准。 */
  headOid?: string | null;
}

export const GRAPH_MAX_LANES = 6;
/** 单条 lane 的横向步长：够画 2px 线宽和节点，不挤压提交说明。 */
export const GRAPH_LANE_WIDTH = 12;

/** 结果外父提交的占位 oid 前缀：只用在本行分配 lane，绝不会与真实 oid 相等。 */
const OUTSIDE_PREFIX = "\u0000outside:";

interface Slot {
  oid: string;
  color: number;
}

/**
 * 按加载顺序推导拓扑。参数只读；返回的每一行都可以单独渲染（每行只需自己的 SVG 片段），
 * 行高由调用方的虚拟化行高决定。
 */
export function buildHistoryGraph(
  commits: readonly GraphCommit[],
  options: GraphOptions = {},
): HistoryGraph {
  const maxLanes = Math.max(1, Math.floor(options.maxLanes ?? GRAPH_MAX_LANES));
  const headOid = options.headOid ?? null;
  const indexOf = new Map<string, number>();
  commits.forEach((commit, index) => {
    if (typeof commit.oid === "string" && commit.oid !== "" && !indexOf.has(commit.oid)) {
      indexOf.set(commit.oid, index);
    }
  });

  const slots: (Slot | null)[] = [];
  const rows: GraphRow[] = [];
  let colorSeq = 0;

  const allocate = (oid: string): number => {
    const free = slots.findIndex((slot) => slot === null);
    const slot: Slot = { oid, color: colorSeq++ };
    if (free >= 0) {
      slots[free] = slot;
      return free;
    }
    slots.push(slot);
    return slots.length - 1;
  };

  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index];
    const oid = commit.oid;
    const parents = Array.isArray(commit.parents) ? commit.parents : [];
    const before = slots.map((slot) => (slot ? { ...slot } : null));

    let lane = -1;
    const merged: number[] = [];
    for (let slot = 0; slot < slots.length; slot += 1) {
      if (slots[slot]?.oid !== oid) continue;
      if (lane < 0) lane = slot;
      else merged.push(slot);
    }

    let color: number;
    if (lane < 0) {
      lane = allocate(oid);
      color = slots[lane]!.color;
    } else {
      color = slots[lane]!.color;
      for (const slot of merged) slots[slot] = null;
    }

    const segmentList: GraphSegment[] = [];
    const mergedSet = new Set(merged);
    for (let slot = 0; slot < Math.max(before.length, slots.length); slot += 1) {
      if (slot === lane || mergedSet.has(slot)) continue;
      const top = before[slot];
      const bottom = slots[slot];
      if (top && bottom && top.oid === bottom.oid) {
        segmentList.push({ from: slot, to: slot, color: top.color, kind: "pass", span: "full" });
      }
    }
    for (const slot of merged) {
      segmentList.push({ from: slot, to: lane, color, kind: "merge", span: "top" });
    }

    const parentOut: GraphParent[] = [];
    const seen = new Set<string>();
    const outside: number[] = [];
    let reused = false;
    for (const parent of parents) {
      if (typeof parent !== "string" || parent === "" || seen.has(parent)) continue;
      seen.add(parent);
      const at = indexOf.get(parent);
      // 只在「出现在本次结果且排在当前行之后」时才连：绝不把数组下一行当成父提交。
      if (at === undefined || at <= index) {
        const stub = allocate(OUTSIDE_PREFIX + parent);
        outside.push(stub);
        segmentList.push({ from: lane, to: stub, color: slots[stub]!.color, kind: "branch", span: "bottom" });
        parentOut.push({ oid: parent, lane: stub, state: "outside" });
        continue;
      }
      const existing = slots.findIndex((slot) => slot?.oid === parent);
      if (existing >= 0) {
        parentOut.push({ oid: parent, lane: existing, state: "visible" });
        if (existing !== lane) {
          segmentList.push({ from: lane, to: existing, color: slots[existing]!.color, kind: "branch", span: "bottom" });
        }
        continue;
      }
      let target: number;
      if (!reused && slots[lane]?.oid === oid) {
        slots[lane] = { oid: parent, color };
        target = lane;
        reused = true;
      } else {
        target = allocate(parent);
      }
      parentOut.push({ oid: parent, lane: target, state: "visible" });
      if (target !== lane) {
        segmentList.push({ from: lane, to: target, color: slots[target]!.color, kind: "branch", span: "bottom" });
      }
    }

    // 根提交或父提交全在结果外：本行不再向下等待。
    if (slots[lane]?.oid === oid) slots[lane] = null;
    for (const stub of outside) slots[stub] = null;
    while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();

    const above = before[lane] !== null && before[lane] !== undefined && before[lane]!.oid === oid;
    const below = slots[lane] !== null && slots[lane] !== undefined;
    if (above && below) segmentList.push({ from: lane, to: lane, color, kind: "pass", span: "full" });
    else if (above) segmentList.push({ from: lane, to: lane, color, kind: "pass", span: "top" });
    else if (below) segmentList.push({ from: lane, to: lane, color, kind: "pass", span: "bottom" });

    let lanes = Math.max(lane + 1, slots.length);
    for (const segment of segmentList) lanes = Math.max(lanes, segment.from + 1, segment.to + 1);
    const hiddenLanes = Math.max(0, lanes - maxLanes);
    rows.push({
      oid,
      lane,
      color,
      lanes,
      overflow: hiddenLanes > 0,
      hiddenLanes,
      head: headOid ? oid === headOid : index === 0,
      segments: segmentList,
      parents: parentOut,
    });
  }

  const lanes = rows.reduce((most, row) => Math.max(most, row.lanes), 0);
  return { rows, lanes, overflow: lanes > maxLanes };
}

/** 单行的可访问说明：父提交按真实 Hash 写出，结果外的父提交写明原因；根提交直接说明。 */
export function graphRowLabel(row: GraphRow): string {
  if (row.parents.length === 0) return "根提交：没有父提交。";
  const parts = row.parents.map((parent) => (
    parent.state === "outside"
      ? `父提交 ${parent.oid}（不在当前结果中）`
      : `父提交 ${parent.oid}`
  ));
  const prefix = row.parents.length > 1 ? "合并提交：" : "";
  return prefix + parts.join("；") + "。";
}

/** 紧凑宽度内的绘图 lane 数：超出部分只留标记，不画到图上。 */
export function drawableLanes(lanes: number, maxLanes: number = GRAPH_MAX_LANES): number {
  return Math.max(1, Math.min(Math.max(1, Math.floor(maxLanes)), Math.max(1, Math.floor(lanes))));
}

/**
 * 绘制前按可见 lane 裁掉越界线段。
 *
 * 越界线段不能用 min 夹到最后一格：那样两条源线会叠成同一条竖线，看起来像真的连在一起。
 * 这里整条丢弃，超出部分由行上的 +N 标记和可访问说明交代。
 */
export function clipSegments(segments: readonly GraphSegment[], lanes: number): GraphSegment[] {
  const limit = Math.max(1, Math.floor(lanes));
  return segments.filter((segment) => segment.from < limit && segment.to < limit);
}

/** 提交自己落在可见 lane 之外时不画节点：只留溢出标记，不在最后一格伪造一个节点。 */
export function visibleNodeLane(row: GraphRow, lanes: number): number | null {
  const limit = Math.max(1, Math.floor(lanes));
  return row.lane < limit ? row.lane : null;
}
