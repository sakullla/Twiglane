import type { DiffLine, DiffResponse } from "./types";

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

interface TextLine {
  kind: "add" | "del" | "context";
  text: string;
}

export function createTextDiff(path: string, before: string, after: string, generation = 0): DiffResponse {
  const oldLines = diffLines(before);
  const newLines = diffLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const middle: TextLine[] = [];
  if (oldMiddle.length * newMiddle.length <= 500_000) {
    const table = Array.from({ length: oldMiddle.length + 1 }, () => new Uint32Array(newMiddle.length + 1));
    for (let i = oldMiddle.length - 1; i >= 0; i -= 1) {
      for (let j = newMiddle.length - 1; j >= 0; j -= 1) {
        table[i][j] = oldMiddle[i] === newMiddle[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oldMiddle.length && j < newMiddle.length) {
      if (oldMiddle[i] === newMiddle[j]) {
        middle.push({ kind: "context", text: oldMiddle[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        middle.push({ kind: "del", text: oldMiddle[i] });
        i += 1;
      } else {
        middle.push({ kind: "add", text: newMiddle[j] });
        j += 1;
      }
    }
    while (i < oldMiddle.length) {
      middle.push({ kind: "del", text: oldMiddle[i] });
      i += 1;
    }
    while (j < newMiddle.length) {
      middle.push({ kind: "add", text: newMiddle[j] });
      j += 1;
    }
  } else {
    middle.push(...oldMiddle.map((text) => ({ kind: "del" as const, text })));
    middle.push(...newMiddle.map((text) => ({ kind: "add" as const, text })));
  }

  const raw = [
    ...oldLines.slice(0, prefix).map((text) => ({ kind: "context" as const, text })),
    ...middle,
    ...oldLines.slice(oldLines.length - suffix).map((text) => ({ kind: "context" as const, text })),
  ];
  let oldNo = 0;
  let newNo = 0;
  const numbered: DiffLine[] = raw.map((line) => {
    if (line.kind === "del") {
      oldNo += 1;
      return { kind: "del", text: `-${line.text}`, oldNo, newNo: null, hunkIndex: null };
    }
    if (line.kind === "add") {
      newNo += 1;
      return { kind: "add", text: `+${line.text}`, oldNo: null, newNo, hunkIndex: null };
    }
    oldNo += 1;
    newNo += 1;
    return { kind: "context", text: ` ${line.text}`, oldNo, newNo, hunkIndex: null };
  });

  const changed = numbered.some((line) => line.kind !== "context");
  const lines: DiffLine[] = [];
  if (!changed) {
    lines.push(...numbered);
  } else {
    const included = numbered.map((line, index) => {
      if (line.kind !== "context") return true;
      const beforeChanged = numbered.slice(Math.max(0, index - 3), index).some((line) => line.kind !== "context");
      const afterChanged = numbered.slice(index + 1, index + 4).some((line) => line.kind !== "context");
      return beforeChanged || afterChanged;
    });
    let index = 0;
    while (index < numbered.length) {
      if (!included[index]) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < numbered.length && included[index]) index += 1;
      const group = numbered.slice(start, index);
      const oldStart = group.find((line) => line.oldNo !== null)?.oldNo ?? 1;
      const newStart = group.find((line) => line.newNo !== null)?.newNo ?? 1;
      lines.push({ kind: "hunk", text: `@@ -${oldStart} +${newStart} @@`, oldNo: null, newNo: null, hunkIndex: null });
      lines.push(...group);
    }
  }

  const additions = numbered.filter((line) => line.kind === "add").length;
  const deletions = numbered.filter((line) => line.kind === "del").length;
  return {
    generation,
    path,
    staged: false,
    binary: false,
    text: null,
    summary: `新增 ${additions} 行，删除 ${deletions} 行。`,
    additions,
    deletions,
    complete: true,
    truncated: false,
    snapshot: `text-diff-${generation}`,
    hunks: [],
    lines,
    offset: 0,
    totalLines: lines.length,
  };
}
