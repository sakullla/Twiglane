// 可独立复跑的 UI 验证入口：起 mock 预览 → 核验健康端点 → 跑场景自检 → 出双主题/双尺寸截图。
//
// 用法：node scripts/run-ui-verification.mjs [--skip-shots | --shots-only] [--full] [--only <场景名片段>] [--out <目录>]
//       [--workflow <id>] [--task <id>]
// 产物：<out>/manifest.json + <out>/after/*.png（截图）、<out>/report.json（本次汇总）。
// 默认写到操作系统临时目录：正式交付验证不得改写候选输入。只有显式 --out 才写调用者目录（归档证据）。
// 结论边界：这里全部是浏览器 + mock 数据，不代表真实 Git、桌面 WebView 或安装包。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer as createViteServer } from "vite";

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
/**
 * 本次批次身份：唯一来源就在这里。runner 把它显式传给截图脚本（--workflow/--task），
 * 截图脚本不再自带上一个批次的默认 ID；下面的核对读 manifest 并与这里的期望值逐项比较，
 * 因此「manifest 写了别的批次」会直接失败，而不是由同一个常量自己对自己成立。
 * --workflow/--task 可按批次覆盖；跨多个 task 的交付图集应显式传 --task delivery，
 * 不要借某个实现 task 的名义归档。
 */
const IDENTITY = {
  workflow: readArg(
    "--workflow",
    has("--projects") ? "2026-11-20-project-ui-ux-optimization" : "2026-11-13-modern-ui-ux-redesign",
  ),
  task: readArg("--task", has("--projects") ? "delivery" : "T6"),
};
let base = readArg("--base", null);
const explicitOut = has("--out");
// 没有 --out 时绝不落到仓库里的归档目录：临时目录每次新建，跑完把路径打在终端与 report 里。
const outDir = explicitOut
  ? path.resolve(readArg("--out"))
  : fs.mkdtempSync(path.join(os.tmpdir(), "twiglane-ui-verification-"));
const only = readArg("--only", has("--projects") ? "项目：" : null);
const skipShots = has("--skip-shots");
const shotsOnly = has("--shots-only");
if (skipShots && shotsOnly) throw new Error("--skip-shots 和 --shots-only 只能选一个");
const startedAt = new Date();
/** 终端与 report 里展示路径：仓库内的写相对路径，临时目录写绝对路径。 */
const show = (target) => {
  const relative = path.relative(process.cwd(), target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : target;
};

function portOf(url) {
  const parsed = new URL(url);
  return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
}

/** 跑一个子进程并把输出同时回显与收集：失败要能落进 report，不能只打在终端上。 */
function run(command, commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: stderr + String(error.message) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const failures = [];
const report = {
  format: "ui_verification_report",
  workflow: IDENTITY.workflow,
  task: IDENTITY.task,
  createdAt: new Date().toISOString(),
  startedAt: startedAt.toISOString(),
  base,
  runner: "scripts/run-ui-verification.mjs",
  output: {
    dir: show(outDir),
    kind: explicitOut ? "explicit" : "temp",
    note: explicitOut ? "显式 --out：写入调用者目录（归档证据）" : "默认写操作系统临时目录，不改写候选输入",
  },
  environment: {
    node: process.version,
    platform: process.platform + " " + process.arch,
    temp: os.tmpdir(),
  },
  health: null,
  scenarios: { skipped: shotsOnly, total: 0, passed: 0, failed: 0, failures: [], exitCode: null, output: "" },
  shots: { manifest: null, workflow: null, task: null, capturedAt: null, fresh: false, groups: {}, files: 0, exitCode: null },
  limits: [
    "浏览器 + mock 数据：不代表真实 Git 行为、桌面 WebView、安装包或其它平台。",
    has("--projects") ? "项目模式只验证项目导航、草稿和关联快照；不验证审查协议或系统深链往返。" : "mock 不注册系统 Cliora 深链协议；返回来源按「手动起点 + 回到提交区」路径验证，深链路径由 tests/cliora-integration.spec.ts 与真实 Git 脚本覆盖。",
    "截图与场景都跑在 Chrome headless，与 Tauri 窗口的标题栏/原生弹层存在差异。",
  ],
  failures,
  status: "unknown",
};

let vite;
let server;
try {
  // 由操作系统原子分配端口，监听事件与健康端点分别确认服务和 mock 接线。
  vite = await createViteServer({
    configFile: "scripts/ui-preview/vite.config.mjs",
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  server = http.createServer(vite.middlewares);
  const listening = once(server, "listening");
  server.listen(base ? portOf(base) : 0, "127.0.0.1");
  await listening;
  base ??= `http://127.0.0.1:${server.address().port}`;
  report.base = base;
  const response = await fetch(new URL("/__ui-preview/health", base), { signal: AbortSignal.timeout(2000) });
  const healthBody = await response.json();
  if (!response.ok || healthBody.mockApi !== true) throw new Error("健康端点没有确认 mockApi=true");
  report.health = {
    mockApi: healthBody.mockApi === true,
    resolvedApi: path.relative(process.cwd(), String(healthBody.resolvedApi ?? "")).split(path.sep).join("/"),
    realApi: path.relative(process.cwd(), String(healthBody.realModule ?? "")).split(path.sep).join("/"),
  };
  console.log("健康端点确认：" + JSON.stringify(report.health));

  // ---- 场景自检 ----
  if (!shotsOnly) {
    const scenarioArgs = ["scripts/ui-preview/check-scenarios.mjs", "--base", base];
    if (only) scenarioArgs.push("--only", only);
    const scenarios = await run(process.execPath, scenarioArgs);
    report.scenarios.exitCode = scenarios.code;
    report.scenarios.output = scenarios.stdout.trim();
    const summary = /场景自检：(\d+)\/(\d+) 通过/.exec(scenarios.stdout);
    if (summary) {
      report.scenarios.passed = Number(summary[1]);
      report.scenarios.total = Number(summary[2]);
      report.scenarios.failed = report.scenarios.total - report.scenarios.passed;
    }
    report.scenarios.failures = scenarios.stdout
      .split("\n")
      .filter((line) => line.startsWith("FAIL"))
      .map((line) => line.trim());
    if (scenarios.code !== 0) failures.push("场景子进程退出码 " + scenarios.code + "（有失败场景或自检没跑完）");
    if (report.scenarios.total === 0) failures.push("场景自检没有产出任何场景结果（零场景不算通过）");
    else if (report.scenarios.failed !== 0) failures.push("失败场景 " + report.scenarios.failed + " 个");
  }

  // ---- 截图与 manifest ----
  if (!skipShots) {
    const manifestPath = path.join(outDir, "manifest.json");
    let previousFiles = [];
    if (fs.existsSync(manifestPath)) {
      try {
        const previous = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (previous.workflow === IDENTITY.workflow) previousFiles = previous.shots
          .filter((shot) => (!has("--projects") || shot.group === "projects") && /^after\/(dark|light)-\d+x\d+-[a-z0-9-]+\.png$/.test(shot.file))
          .map((shot) => shot.file);
      } catch { /* An incomplete prior gallery has no file list to clean up. */ }
    }
    // 先移走旧 manifest：这次运行必须自己写出新的一份，不能拿上一批的结果冒充。
    fs.rmSync(manifestPath, { force: true });
    const shots = await run(process.execPath, [
      ...(has("--projects") ? ["scripts/ui-preview/baseline-shots.mjs", "--projects"] : ["scripts/ui-preview/baseline-shots.mjs"]),
      "--base", base,
      // 身份只由 runner 提供：截图脚本没有默认工作流，manifest 不允许出现别的批次。
      "--workflow", IDENTITY.workflow,
      "--task", IDENTITY.task,
      "--out", path.join(outDir, "after"),
      "--manifest", manifestPath,
      ...(has("--full") ? ["--full"] : []),
      ...(has("--failure-targets")
        ? ["--failure-targets", readArg("--failure-targets", "none")]
        : has("--full") ? ["--failure-targets", "dark:1280x840,light:1280x840,dark:900x600,light:900x600"] : []),
    ]);
    report.shots.exitCode = shots.code;
    if (shots.code !== 0) {
      failures.push("截图子进程退出码 " + shots.code + "：" + shots.stderr.split("\n").filter(Boolean).slice(-2).join(" "));
    }
    if (!fs.existsSync(manifestPath)) {
      failures.push("没有生成 manifest：" + (shots.stderr.split("\n").filter(Boolean).slice(-2).join(" ") || "原因未记录"));
    } else {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      report.shots.manifest = show(manifestPath);
      report.shots.workflow = manifest.workflow ?? null;
      report.shots.task = manifest.task ?? null;
      report.shots.capturedAt = manifest.capturedAt ?? null;
      report.shots.files = manifest.shots?.length ?? 0;
      for (const shot of manifest.shots ?? []) {
        report.shots.groups[shot.group] = (report.shots.groups[shot.group] ?? 0) + 1;
      }
      const capturedMs = Date.parse(String(manifest.capturedAt ?? ""));
      report.shots.fresh = Number.isFinite(capturedMs) && capturedMs >= startedAt.getTime();
      if (!report.shots.fresh) failures.push("manifest 的 capturedAt 不是本次运行写出的（旧 manifest 不算证据）");
      // 读 manifest 的字段与 runner 的期望值比较：截图脚本拿到的身份就是这里传下去的，
      // 任何一边写错、或截图脚本改回自己的常量，都会在这里失败。
      if (manifest.workflow !== IDENTITY.workflow) {
        failures.push("manifest workflow 是 " + JSON.stringify(manifest.workflow ?? null) + "，不是本次 " + JSON.stringify(IDENTITY.workflow));
      }
      if (manifest.task !== IDENTITY.task) {
        failures.push("manifest task 是 " + JSON.stringify(manifest.task ?? null) + "，不是本次 " + JSON.stringify(IDENTITY.task));
      }
      if (report.shots.files === 0) failures.push("manifest 里没有任何截图");
      const files = new Set();
      for (const shot of manifest.shots ?? []) {
        if (typeof shot.file !== "string" || !/^after\/(dark|light)-\d+x\d+-[a-z0-9-]+\.png$/.test(shot.file) || files.has(shot.file)) {
          failures.push("manifest 截图路径无效或重复：" + shot.file);
          continue;
        }
        files.add(shot.file);
        try {
          const buffer = fs.readFileSync(path.join(outDir, shot.file));
          if (buffer.length !== shot.bytes || createHash("sha256").update(buffer).digest("hex") !== shot.sha256) {
            failures.push("截图的字节数或 SHA-256 不一致：" + shot.file);
          }
        } catch (error) {
          failures.push("截图无法读取：" + shot.file + "（" + error.code + "）");
        }
      }
      if (!failures.length && previousFiles.length) {
        const written = new Set(manifest.shots.map((shot) => shot.file));
        for (const file of previousFiles) {
          if (!written.has(file)) fs.rmSync(path.join(outDir, file), { force: true });
        }
      }
    }
  }

  report.status = failures.length === 0 ? "passed" : "failed";
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    "UI 验证：" + report.status + (shotsOnly ? "｜仅截图" : "｜场景 " + report.scenarios.passed + "/" + report.scenarios.total) +
      "｜截图 " + report.shots.files + "（" + JSON.stringify(report.shots.groups) + "）" +
      "｜输出 " + report.output.dir,
  );
  if (failures.length > 0) {
    if (report.scenarios.failures.length > 0) console.log("失败场景：\n" + report.scenarios.failures.join("\n"));
    console.log("失败原因：\n- " + failures.join("\n- "));
    process.exitCode = 1;
  }
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  if (failures.length === 0) failures.push(error.message);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.error("UI 验证失败：", error.message);
  process.exitCode = 1;
} finally {
  try {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  } finally {
    await vite?.close();
  }
}
