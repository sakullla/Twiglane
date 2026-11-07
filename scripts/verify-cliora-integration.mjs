#!/usr/bin/env node
/**
 * cliora × Twiglane 真实联动证据校验。
 *
 * 只接受“真机安装的两端应用 + 真实本地 Git”的记录：安装包构建成功、Vitest、
 * Playwright、开发模式的 register_all 都不能当作联动证据。报告缺失、字段缺失、
 * 状态自称通过但缺少实测支撑时一律失败，退出码 1（参数或文件问题为 2）。
 *
 * 用法：node scripts/verify-cliora-integration.mjs [--report <path>] [--json]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_REPORT = "docs/verification/cliora-integration.json";
const FORMAT = "cliora-integration-evidence";
const VERSION = 1;

/** 03 的执行计划列出的五个真实场景：缺任何一个都算证据不完整。 */
const SCENARIOS = [
  { id: "cold-start-review", title: "cliora 冷启动唤起 Twiglane 并打开指定 worktree" },
  { id: "commit-and-return", title: "Twiglane 提交后返回原 cliora 会话并复核提交" },
  { id: "merge-and-stale-head", title: "合入复核，以及返回后 HEAD 变化显示未确认" },
  { id: "invalid-links", title: "路径失效、无效协议、旧 reviewId、原会话失效、未注册 handler" },
  { id: "standalone-repository", title: "无来源仓库的现有提交与取消行为" },
];

/** 这些词出现在“已通过”的记录里说明证据不是实机联动。 */
const NON_EVIDENCE = ["vitest", "playwright", "happy-dom", "mock", "register_all", "构建成功", "build only"];

function parseArgs(argv) {
  const options = { report: DEFAULT_REPORT, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--report") {
      options.report = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--report=")) {
      options.report = arg.slice("--report=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      options.unknown = arg;
    }
  }
  return options;
}

function fail(message, code = 1) {
  console.error("cliora 联动证据校验失败：" + message);
  process.exit(code);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isInstalledBuild(build) {
  return (
    build &&
    isNonEmptyString(build.version) &&
    build.bundle === "nsis" &&
    build.installed === true &&
    isNonEmptyString(build.installerSha256) &&
    /^[0-9a-f]{64}$/.test(build.installerSha256)
  );
}

/** 逐条检查声称通过的场景：必须有真实时间、真实应用、真实 Git 与可读观察结果。 */
function scenarioProblems(scenario, builds) {
  const problems = [];
  const text = [scenario.notes, JSON.stringify(scenario.observations ?? {})].join(" ").toLowerCase();
  for (const word of NON_EVIDENCE) {
    if (text.includes(word)) problems.push("observation 提到 " + word + "，不能当作实机联动");
  }
  if (!isNonEmptyString(scenario.executedAt) || Number.isNaN(Date.parse(scenario.executedAt))) {
    problems.push("缺少可解析的 executedAt");
  }
  if (scenario.realApp !== true) problems.push("realApp 不是 true");
  if (scenario.realGit !== true) problems.push("realGit 不是 true");
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    problems.push("缺少实际操作步骤");
  }
  if (!scenario.observations || Object.keys(scenario.observations).length === 0) {
    problems.push("缺少观察结果");
  }
  if (!isInstalledBuild(builds.twiglane) || !isInstalledBuild(builds.cliora)) {
    problems.push("两端安装包与安装记录不完整");
  }
  return problems;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("用法：node scripts/verify-cliora-integration.mjs [--report <path>] [--json]");
    return;
  }
  if (options.unknown) fail("未知参数 " + options.unknown, 2);
  const path = resolve(process.cwd(), options.report);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail("找不到报告 " + options.report + "（真实联动尚未执行）");
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    fail("报告不是合法 JSON：" + error.message);
  }
  if (report.format !== FORMAT || report.version !== VERSION) {
    fail("报告格式或版本不对，期望 " + FORMAT + " v" + VERSION);
  }
  if (report.host?.platform !== "windows") {
    fail("真实联动证据只接受 Windows 主机记录（macOS/Linux 请写在 limitations）");
  }
  const builds = report.builds ?? {};
  const recorded = new Map();
  for (const scenario of report.scenarios ?? []) {
    if (!isNonEmptyString(scenario?.id)) fail("场景缺少 id");
    if (recorded.has(scenario.id)) fail("场景重复：" + scenario.id);
    recorded.set(scenario.id, scenario);
  }
  const problems = [];
  for (const expected of SCENARIOS) {
    const scenario = recorded.get(expected.id);
    if (!scenario) {
      problems.push("缺少场景 " + expected.id + "（" + expected.title + "）");
      continue;
    }
    if (scenario.status !== "passed") {
      problems.push("场景 " + expected.id + " 未通过（status=" + (scenario.status ?? "缺失") + "）");
      continue;
    }
    for (const problem of scenarioProblems(scenario, builds)) {
      problems.push("场景 " + expected.id + "：" + problem);
    }
  }
  const limitations = report.limitations;
  if (!Array.isArray(limitations) || limitations.length === 0) {
    problems.push("缺少 limitations：未实测的平台必须写明");
  } else if (limitations.some((item) => item?.verified === true)) {
    problems.push("limitations 里不能把未实测平台写成已验证");
  }
  if (problems.length > 0) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, problems }, null, 2));
    } else {
      console.error("cliora 联动证据不完整，未通过：");
      for (const problem of problems) console.error(" - " + problem);
    }
    process.exit(1);
  }
  if (options.json) {
    console.log(JSON.stringify({ ok: true, scenarios: SCENARIOS.map((item) => item.id) }, null, 2));
  } else {
    console.log("cliora 联动证据通过：" + SCENARIOS.map((item) => item.id).join("、"));
  }
}

main();
