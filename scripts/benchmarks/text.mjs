import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { parseConflictText, composeConflictText, hasConflictMarkers } from "../../src/lib/conflict.ts";
import { computeMarks } from "../../src/lib/three-way-marks.ts";

// Node 22 的类型剥离直接执行真实纯逻辑模块；不注册测试，也不设耗时通过阈值。
const lines = [];
for (let block = 0; block < 120; block += 1) {
  for (let index = 0; index < 400; index += 1) lines.push(`const v${block}_${index} = ${index};`);
  lines.push("<<<<<<< HEAD", `ours ${block}`, "=======", `theirs ${block}`, ">>>>>>> main");
}
const text = `${lines.join("\n")}\n`;
let started = performance.now();
const parsed = parseConflictText(text);
const resolutions = Object.fromEntries(parsed.hunks.map((hunk) => [hunk.index, { choice: "theirs" }]));
const composed = composeConflictText(parsed, resolutions);
console.log(`48,600 lines / 120 conflicts, parse and compose: ${(performance.now() - started).toFixed(2)} ms`);
assert.equal(parsed.hunks.length, 120);
assert.equal(hasConflictMarkers(composed), false);
assert.ok(composed.includes("theirs 119\n"));

const unique = Array.from({ length: 60_000 }, (_, index) => `const value${index} = ${index};`);
const edited = unique.map((line, index) => (index % 500 === 0 ? `${line} // changed` : line));
const repeated = Array.from({ length: 60_000 }, (_, index) => (index % 3 === 0 ? "}" : index % 3 === 1 ? "" : "  x();"));
const shifted = ["first", ...repeated.slice(0, 30_000), "middle", ...repeated.slice(30_000).reverse()];
started = performance.now();
const marks = computeMarks(`${edited.join("\n")}\n`, `${unique.join("\n")}\n`, `${unique.join("\n")}\n`);
computeMarks(`${shifted.join("\n")}\n`, `${repeated.join("\n")}\n`, `${shifted.join("\n")}\n`);
console.log(`60,000 unique/repeated lines, source marks: ${(performance.now() - started).toFixed(2)} ms`);
assert.equal(marks.runs.length, 120);
assert.ok(marks.runs.every((run) => run.kind === "manual"));
