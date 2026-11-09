// 可独立复跑的 UI 验证入口：起 mock 预览 → 核验健康端点 → 跑场景自检 → 出双主题/双尺寸截图。
//
// 用法：node scripts/run-ui-verification.mjs [--skip-shots] [--only <场景名片段>] [--out <目录>]
// 产物：<out>/manifest.json + <out>/after/*.png（截图）、<out>/report.json（本次汇总）。
// 结论边界：这里全部是浏览器 + mock 数据，不代表真实 Git、桌面 WebView 或安装包。
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const base = readArg("--base", "http://127.0.0.1:1430");
const outDir = path.resolve(readArg("--out", "docs/verification/ai-coding-ui-ux-2026-11-09"));
const only = readArg("--only", null);
const skipShots = has("--skip-shots");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portOf(url) {
  const parsed = new URL(url);
  return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function health(url) {
  const parsed = new URL("/__ui-preview/health", url);
  return new Promise((resolve, reject) => {
    const request = http.get({ host: parsed.hostname, port: parsed.port, path: parsed.pathname }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(2000, () => request.destroy(new Error("健康端点超时")));
  });
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
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const report = {
  format: "ui_verification_report",
  createdAt: new Date().toISOString(),
  base,
  runner: "scripts/run-ui-verification.mjs",
  environment: {
    node: process.version,
    platform: process.platform + " " + process.arch,
    temp: os.tmpdir(),
  },
  health: null,
  scenarios: { total: 0, passed: 0, failed: 0, failures: [], output: "" },
  shots: { manifest: null, groups: {}, files: 0 },
  limits: [
    "浏览器 + mock 数据：不代表真实 Git 行为、桌面 WebView、安装包或其它平台。",
    "mock 不注册系统 Cliora 深链协议；返回来源按「手动起点 + 回到提交区」路径验证，深链路径由 tests/cliora-integration.spec.ts 与真实 Git 脚本覆盖。",
    "截图与场景都跑在 Chrome headless，与 Tauri 窗口的标题栏/原生弹层存在差异。",
  ],
  status: "unknown",
};

let server = null;
try {
  const port = portOf(base);
  if (!(await portFree(port))) {
    throw new Error(
      "端口 " + port + " 已被占用（可能是上一次的预览没关）。请先关掉它，或用 --base 指向别的端口。",
    );
  }
  // 与 npm run preview:ui 同一条命令：同一个 vite 配置、同一个 mock 替换与健康端点。
  server = spawn(
    process.execPath,
    [path.join("node_modules", "vite", "bin", "vite.js"), "--config", "scripts/ui-preview/vite.config.mjs"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.resume();
  server.stderr.resume();

  let healthBody = null;
  for (let attempt = 0; attempt < 120 && !healthBody; attempt += 1) {
    try {
      const body = await health(base);
      if (body && body.mockApi === true) healthBody = body;
    } catch {
      // 还没起来：继续等。
    }
    if (!healthBody) await pause(500);
  }
  if (!healthBody) throw new Error("预览没有起来，或健康端点没有确认 mockApi=true（可能连到了非 mock 页面）");
  report.health = {
    mockApi: healthBody.mockApi === true,
    resolvedApi: path.relative(process.cwd(), String(healthBody.resolvedApi ?? "")).split(path.sep).join("/"),
    realApi: path.relative(process.cwd(), String(healthBody.realModule ?? "")).split(path.sep).join("/"),
  };
  console.log("健康端点确认：" + JSON.stringify(report.health));

  const scenarioArgs = ["scripts/ui-preview/check-scenarios.mjs", "--base", base];
  if (only) scenarioArgs.push("--only", only);
  const scenarios = await run(process.execPath, scenarioArgs);
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

  if (!skipShots) {
    const shots = await run(process.execPath, [
      "scripts/ui-preview/baseline-shots.mjs",
      "--base", base,
      "--out", path.join(outDir, "after"),
      "--manifest", path.join(outDir, "manifest.json"),
      "--failure-targets", "dark:1280x840,light:1280x840,dark:900x600,light:900x600",
    ]);
    const manifestPath = path.join(outDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      report.shots.manifest = path.relative(process.cwd(), manifestPath).split(path.sep).join("/");
      report.shots.files = manifest.shots?.length ?? 0;
      for (const shot of manifest.shots ?? []) {
        report.shots.groups[shot.group] = (report.shots.groups[shot.group] ?? 0) + 1;
      }
    } else {
      report.shots.error = "没有生成 manifest： " + shots.stderr.split("\n").filter(Boolean).slice(-3).join(" ");
    }
  }

  const ok = report.scenarios.failed === 0 && (skipShots || report.shots.files > 0);
  report.status = ok ? "passed" : "failed";
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    "UI 验证：" + report.status + "｜场景 " + report.scenarios.passed + "/" + report.scenarios.total +
      "｜截图 " + report.shots.files + "（" + JSON.stringify(report.shots.groups) + "）",
  );
  if (!ok) {
    if (report.scenarios.failures.length > 0) console.log("失败场景：\n" + report.scenarios.failures.join("\n"));
    process.exitCode = 1;
  }
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.error("UI 验证失败：", error.message);
  process.exitCode = 1;
} finally {
  server?.kill();
  await pause(300);
}
