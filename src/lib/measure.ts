import { api } from "./api";

export interface OpenedView {
  path: string;
  head: string | null;
  changes: number;
  generation: number;
}

export interface MeasureActions {
  openRepo: (path: string) => Promise<void>;
  cloneRepo: (url: string, parent: string, name: string) => Promise<string>;
  stageFirstHunk: () => Promise<{ path: string; hunks: number }>;
  commit: (message: string) => Promise<void>;
  push: () => Promise<void>;
  merge: (source: string, content: string) => Promise<string>;
  refreshTimes: (count: number) => Promise<number[]>;
  diffCycle: (paths: string[], count: number) => Promise<{ cached: number[]; uncached: number[]; truncated: boolean[]; samplesMs: number[] }>;
  scrollFrames: (frames: number) => Promise<{ samples: number[]; painted: boolean }>;
  feedbackSamples: (
    count: number,
    plan?: { cloneUrl?: string; cloneParent?: string },
  ) => Promise<{ samples: number[]; painted: boolean; operations: string[]; started: boolean }>;
  keyboardAndTheme: () => Promise<{
    theme: string[];
    keyboard: boolean;
    shortcutFocused: boolean;
    selectionChanged: boolean;
    selectionBefore: string;
    selectionMoved: string;
    selectionAfter: string;
  }>;
  cancelDuringOpen: (
    slowRepo: string,
    nextRepo: string,
  ) => Promise<{ cancelled: boolean; switched: boolean; keyboard: boolean; readStarted: boolean }>;
  sleep: (ms: number) => Promise<void>;
  getOpened: () => OpenedView | null;
}

interface Step {
  op: string;
  [key: string]: unknown;
}

export function largeSummaryContentOk(samplesMs: number[], truncated: boolean[], count: number): boolean {
  return count >= 30 && samplesMs.length === count && truncated.length === count && truncated.every(Boolean);
}

export function feedbackContentOk(
  result: { samples: number[]; painted: boolean; operations: string[]; started: boolean },
  count: number,
): boolean {
  const operations = new Set(result.operations);
  return (
    count >= 30 &&
    result.started &&
    result.painted &&
    result.samples.length === count &&
    operations.has("clone") &&
    operations.has("sync") &&
    operations.has("commit")
  );
}

export function keyboardContentOk(result: {
  theme: string[];
  shortcutFocused?: boolean;
  selectionChanged?: boolean;
  selectionBefore?: string;
  selectionMoved?: string;
  selectionAfter?: string;
}): boolean {
  const before = result.selectionBefore ?? "";
  const moved = result.selectionMoved ?? "";
  const after = result.selectionAfter ?? "";
  return (
    result.shortcutFocused === true &&
    result.selectionChanged === true &&
    moved.length > 0 &&
    after.length > 0 &&
    moved !== before &&
    after !== moved &&
    result.theme.includes("light") &&
    result.theme.includes("dark")
  );
}

export function cancelContentOk(result: {
  cancelled: boolean;
  switched: boolean;
  keyboard: boolean;
  readStarted?: boolean;
}): boolean {
  return result.readStarted === true && result.cancelled && result.switched && result.keyboard;
}

function frames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    let left = count;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, 80);
    const next = () => {
      left -= 1;
      if (left <= 0) {
        clearTimeout(timer);
        finish();
      } else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  });
}

async function sample(name: string, detail: Record<string, unknown>) {
  await api.measureSample(name, detail);
}

export async function startDesktopMeasure(actions: MeasureActions): Promise<void> {
  let probe: { enabled: boolean; script: { steps?: unknown[] } | null };
  try {
    probe = await api.measureProbe();
  } catch {
    return;
  }
  if (!probe.enabled || !probe.script || !Array.isArray(probe.script.steps)) return;
  try {
    await sample("shell-ready", { controls: true });
    for (const entry of probe.script.steps) {
      const step = entry as Step;
      await runStep(step, actions);
    }
    await api.measureFinish();
  } catch (error) {
    const message = error instanceof Error ? error.message : "测量步骤失败";
    try {
      await sample("measure-error", { message });
      await api.measureFinish();
    } catch {
      // 测量进程由外部超时回收。
    }
  }
}

async function runStep(step: Step, actions: MeasureActions) {
  if (step.op === "sleep") {
    const ms = Number(step.ms ?? 0);
    await sample(String(step.mark ?? "sleep"), { phase: "start", ms });
    if (ms >= 1000) await api.measureWait(ms);
    else await actions.sleep(ms);
    await sample(`${String(step.mark ?? "sleep")}-end`, { phase: "end", ms });
    return;
  }
  if (step.op === "open") {
    const started = performance.now();
    await actions.openRepo(String(step.repo));
    await frames();
    const opened = actions.getOpened();
    const elapsed = performance.now() - started;
    const changesOk = opened?.changes === Number(step.expectChanges);
    const headOk = !step.expectHead || opened?.head === step.expectHead;
    await sample(step.startup === true ? "startup" : "status-open", {
      method: "gui-open-to-first-screen",
      elapsedMs: elapsed,
      contentOk: Boolean(opened && changesOk && headOk),
      head: opened?.head ?? null,
      changes: opened?.changes ?? null,
      expectChanges: step.expectChanges ?? null,
      expectHead: step.expectHead ?? null,
      launch: step.launch ?? null,
      mark: step.mark ?? null,
    });
    return;
  }
  if (step.op === "refresh") {
    const samples = await actions.refreshTimes(Number(step.count ?? 1));
    const opened = actions.getOpened();
    await sample("status-refresh", {
      method: "gui-refresh-to-first-screen",
      samplesMs: samples,
      contentOk: opened?.changes === Number(step.expectChanges) && (!step.expectHead || opened?.head === step.expectHead),
      head: opened?.head ?? null,
      changes: opened?.changes ?? null,
      size: step.size ?? null,
    });
    return;
  }
  if (step.op === "diff-cycle") {
    const paths = Array.isArray(step.paths) ? step.paths.map(String) : [];
    const result = await actions.diffCycle(paths, Number(step.count ?? 30));
    await sample("diff-cycle", {
      method: "gui-diff-switch",
      cachedMs: result.cached,
      uncachedMs: result.uncached,
      contentOk: result.uncached.length > 0 && result.cached.length > 0,
      truncated: result.truncated,
    });
    return;
  }
  if (step.op === "large-diff") {
    const count = Number(step.count ?? 30);
    const started = performance.now();
    const result = await actions.diffCycle([String(step.path)], count);
    const samplesMs = result.samplesMs;
    await sample("large-diff", {
      method: "gui-large-summary",
      elapsedMs: performance.now() - started,
      samplesMs,
      uncachedMs: result.uncached,
      cachedMs: result.cached,
      contentOk: largeSummaryContentOk(samplesMs, result.truncated, count),
      truncated: result.truncated,
    });
    return;
  }
  if (step.op === "scroll") {
    const result = await actions.scrollFrames(Number(step.frames ?? 120));
    await sample("scroll", {
      method: "gui-scroll-frames",
      frameMs: result.samples,
      painted: result.painted,
      contentOk: result.painted && result.samples.length > 0,
    });
    return;
  }
  if (step.op === "feedback") {
    const count = Number(step.count ?? 30);
    const result = await actions.feedbackSamples(count, {
      cloneUrl: String(step.cloneUrl ?? ""),
      cloneParent: String(step.cloneParent ?? ""),
    });
    await sample("feedback", {
      method: "gui-feedback",
      samplesMs: result.samples,
      painted: result.painted,
      operations: result.operations,
      started: result.started,
      contentOk: feedbackContentOk(result, count),
    });
    return;
  }
  if (step.op === "keyboard-theme") {
    const result = await actions.keyboardAndTheme();
    await sample("keyboard-theme", { method: "gui-keyboard-theme", ...result, contentOk: keyboardContentOk(result) });
    return;
  }
  if (step.op === "cancel-open") {
    const result = await actions.cancelDuringOpen(String(step.slowRepo), String(step.nextRepo));
    await sample("cancel-open", { method: "gui-cancel-and-switch", ...result, contentOk: cancelContentOk(result) });
    return;
  }
  if (step.op === "clone") {
    const dest = await actions.cloneRepo(String(step.url), String(step.parent), String(step.name));
    const opened = actions.getOpened();
    await sample("clone", {
      method: "gui-clone",
      path: dest,
      head: opened?.head ?? null,
      contentOk: Boolean(dest && opened?.head),
    });
    return;
  }
  if (step.op === "stage-commit-push") {
    const staged = await actions.stageFirstHunk();
    await actions.commit(String(step.message ?? "部分暂存"));
    await actions.push();
    const opened = actions.getOpened();
    await sample("stage-commit-push", {
      method: "gui-partial-commit-push",
      path: staged.path,
      hunks: staged.hunks,
      head: opened?.head ?? null,
      contentOk: staged.hunks >= 2 && Boolean(opened?.head),
    });
    return;
  }
  if (step.op === "merge") {
    const oid = await actions.merge(String(step.source), String(step.content ?? "resolved\n"));
    await sample("merge", { method: "gui-merge", oid, contentOk: Boolean(oid) });
    return;
  }
  throw new Error(`未知测量步骤 ${step.op}`);
}
