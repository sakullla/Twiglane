export interface DiffAttempt {
  token: number;
  repo: string;
  path: string;
  side: string;
}

export interface DiffViewTarget {
  token: number;
  repo: string | null;
  path: string | null;
  side: string | null;
}

export function diffResultApplies(attempt: DiffAttempt, current: DiffViewTarget): boolean {
  return (
    attempt.token === current.token &&
    current.repo === attempt.repo &&
    current.path === attempt.path &&
    current.side === attempt.side
  );
}

export async function finishDiffAttempt<T>(
  attempt: DiffAttempt,
  current: () => DiffViewTarget,
  run: () => Promise<T>,
): Promise<{ state: "applied"; value: T } | { state: "discarded" } | { state: "failed"; error: unknown }> {
  try {
    const value = await run();
    if (!diffResultApplies(attempt, current())) return { state: "discarded" };
    return { state: "applied", value };
  } catch (error) {
    if (!diffResultApplies(attempt, current())) return { state: "discarded" };
    return { state: "failed", error };
  }
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("---") ||
    line.startsWith("+++") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("Binary files")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

export function diffLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export interface SideCell {
  text: string;
  kind: DiffLineKind | "empty";
  no: number | null;
}

export interface SideRow {
  left: SideCell | null;
  right: SideCell | null;
  span: boolean;
  hunkIndex: number | null;
  showStage: boolean;
}

export interface ViewLine {
  kind: string;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  hunkIndex: number | null;
}

export function toSideRows(lines: ViewLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let pending: SideRow[] = [];
  const flush = () => {
    rows.push(...pending);
    pending = [];
  };
  for (const line of lines) {
    if (line.kind === "hunk" || line.kind === "meta" || line.kind === "nonewline") {
      flush();
      rows.push({
        left: { text: line.text, kind: line.kind === "nonewline" ? "meta" : (line.kind as DiffLineKind), no: line.oldNo },
        right: { text: line.text, kind: line.kind === "nonewline" ? "meta" : (line.kind as DiffLineKind), no: line.newNo },
        span: true,
        hunkIndex: line.hunkIndex,
        showStage: line.kind === "hunk",
      });
      continue;
    }
    if (line.kind === "del") {
      pending.push({
        left: { text: line.text, kind: "del", no: line.oldNo },
        right: null,
        span: false,
        hunkIndex: line.hunkIndex,
        showStage: false,
      });
      continue;
    }
    if (line.kind === "add") {
      const slot = pending.find((row) => row.right === null);
      if (slot) {
        slot.right = { text: line.text, kind: "add", no: line.newNo };
      } else {
        rows.push({
          left: null,
          right: { text: line.text, kind: "add", no: line.newNo },
          span: false,
          hunkIndex: line.hunkIndex,
          showStage: false,
        });
      }
      continue;
    }
    flush();
    rows.push({
      left: { text: line.text, kind: "context", no: line.oldNo },
      right: { text: line.text, kind: "context", no: line.newNo },
      span: false,
      hunkIndex: line.hunkIndex,
      showStage: false,
    });
  }
  flush();
  return rows;
}
