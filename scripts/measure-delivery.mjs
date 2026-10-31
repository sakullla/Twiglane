import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  BUDGETS,
  FIXTURE_SEED,
  directoryBytes,
  p95,
  sha256File,
  sourceFingerprint,
  validateCheck,
} from "./delivery-lib.mjs";
import { filePath, generateFixture } from "./generate-fixture.mjs";

const root = process.cwd();
const outDir = path.join(root, "docs/verification");
const rawDir = path.join(outDir, "raw");
const phase = process.env.TWIGLANE_PHASE || "all";
let referenceReady = false;

function wants(name) {
  return phase === "all" || phase === name;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message ?? result.error) : "",
  };
}

function textOf(result) {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(textOf(result) || `${command} ${args.join(" ")} 失败`);
  return result;
}

export function redact(text) {
  return String(text ?? "").replace(/:\/\/[^/\s]*:[^@\s]+@/g, "://***@");
}

function redactSecrets(text, urls) {
  let out = redact(text);
  for (const url of urls) {
    const match = String(url).match(/:\/\/(?:[^/\s:]*)?:([^@\s]+)@/);
    if (match?.[1]) out = out.split(match[1]).join("***");
  }
  return out;
}

export function remoteKind(url) {
  const value = String(url ?? "").trim();
  if (/^https:\/\//i.test(value)) return "https";
  if (/^ssh:\/\//i.test(value) || /^git@[^:\s]+:\S+$/.test(value)) return "ssh";
  return "local";
}

const AUTH_FAILURE = /authentication failed|authentication required|permission denied|could not read username|terminal prompts disabled|access rights|publickey|invalid credentials|401 unauthorized|403 forbidden|auth fail/i;

export async function measureProtocol(kind, env, runGit) {
  const id = kind === "https" ? "protocol.https" : "protocol.ssh";
  const remoteKey = kind === "https" ? "TWIGLANE_HTTPS_REMOTE" : "TWIGLANE_SSH_REMOTE";
  const denyKey = kind === "https" ? "TWIGLANE_HTTPS_DENY_REMOTE" : "TWIGLANE_SSH_DENY_REMOTE";
  const remote = String(env?.[remoteKey] ?? "").trim();
  const deny = String(env?.[denyKey] ?? "").trim();
  const nextStep = "设置 TWIGLANE_HTTPS_REMOTE、TWIGLANE_HTTPS_DENY_REMOTE、TWIGLANE_SSH_REMOTE、TWIGLANE_SSH_DENY_REMOTE 后重跑测量。分别记录成功访问和认证失败，并确认输出不含凭据。不要把本地 bare remote 记成协议通过。";
  if (!remote || !deny) {
    return gap(id, `没有受控 ${kind.toUpperCase()} 远程的成功与认证失败记录。`, nextStep, {
      remoteConfigured: Boolean(remote),
      denyConfigured: Boolean(deny),
    });
  }
  if (remoteKind(remote) !== kind || remoteKind(deny) !== kind) {
    return gap(id, `${kind.toUpperCase()} 配置不是受控远程，本地路径或 bare remote 不能代替。`, nextStep, {
      localBare: true,
      success: false,
      authFailure: false,
      redacted: false,
      transcript: "",
    });
  }
  const success = await runGit(remote);
  const denied = await runGit(deny);
  const transcript = redactSecrets(
    [`success exit ${success.status}`, success.stdout ?? "", success.stderr ?? "", `deny exit ${denied.status}`, denied.stdout ?? "", denied.stderr ?? ""].join("\n"),
    [remote, deny],
  ).slice(0, 4000);
  const leaked = /:\/\/[^/\s]*:[^@\s]+@/.test(transcript);
  const evidence = {
    success: success.status === 0,
    authFailure: denied.status !== 0 && AUTH_FAILURE.test(`${denied.stdout ?? ""}\n${denied.stderr ?? ""}`),
    redacted: !leaked,
    localBare: false,
    transcript,
  };
  if (evidence.success && evidence.authFailure && evidence.redacted && transcript.length >= 20) {
    return passed(id, `${kind.toUpperCase()} 受控远程完成了成功访问和认证失败，记录已脱敏。`, evidence);
  }
  return {
    id,
    status: "fail",
    summary: `${kind.toUpperCase()} 受控远程没有同时完成成功访问、认证失败和脱敏。`,
    nextStep: "检查受控远程地址、凭据和认证失败输出后重跑。不要把失败改写成通过，也不要写入未脱敏的凭据。",
    evidence,
  };
}

function gitLsRemote(url) {
  return new Promise((resolve) => {
    const child = spawn("git", ["ls-remote", url], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += "\n测量超时，已停止等待认证。";
      child.kill("SIGKILL");
    }, 20000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}

export function resetSampleLog(file) {
  rmSync(file, { force: true });
}

export function startupTiming(samples, pid) {
  const mine = (Array.isArray(samples) ? samples : []).filter((item) => Number(item?.pid) === Number(pid));
  const latest = (name) => {
    const matched = mine.filter((item) => item.name === name);
    return matched.length ? matched[matched.length - 1] : null;
  };
  const open = latest("startup");
  const ready = latest("shell-ready");
  const controlsMs = Number(ready?.elapsedMs);
  return {
    launch: open?.detail?.launch ?? null,
    contentOk: open?.detail?.contentOk === true && Number.isFinite(controlsMs),
    controlsMs,
    openMs: Number(open?.detail?.elapsedMs),
  };
}

function probeEnvironment() {
  const physical = Number(run("sysctl", ["-n", "hw.memsize"]).stdout.trim());
  const memory = Number.isFinite(physical) && physical > 0 ? physical : os.totalmem();
  const disk = run("diskutil", ["info", "/"]);
  const power = run("pmset", ["-g", "batt"]);
  const git = run("git", ["--version"]);
  const rustc = run("rustc", ["--version"]);
  const powerText = textOf(power);
  const onBattery = /Battery Power|discharging/i.test(powerText) && !/AC Power/i.test(powerText);
  const acPower = /AC Power|charged/i.test(powerText) && !onBattery;
  const ssd = /Solid State:\s+Yes/i.test(textOf(disk));
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: os.version(),
    cpus: os.cpus().length,
    memoryBytes: memory,
    ssd,
    acPower,
    diskColdStart: false,
    git: textOf(git),
    rustc: textOf(rustc),
    node: process.version,
    commit: textOf(run("git", ["rev-parse", "HEAD"])),
    macos: textOf(run("sw_vers")),
    power: powerText,
    disk: textOf(disk).slice(0, 500),
    referenceReady: memory >= BUDGETS.referenceMemoryBytes && ssd && acPower,
  };
}

function prerequisite(environment, release) {
  return {
    release,
    ssd: environment.ssd,
    acPower: environment.acPower,
    memoryBytes: environment.memoryBytes,
    diskColdStart: false,
  };
}

function gap(id, summary, nextStep, evidence = {}) {
  return { id, status: "gap", summary, nextStep, evidence };
}

function failed(id, summary, evidence = {}) {
  return { id, status: "fail", summary, nextStep: "根据原始样本定位 Git、解析、IPC 或渲染瓶颈并优化后重测，不要提高预算。", evidence };
}

function passed(id, summary, evidence) {
  return { id, status: "pass", summary, evidence };
}

function findChild(dir, suffix) {
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find((item) => item.endsWith(suffix));
  return name ? path.join(dir, name) : null;
}

function cargoBundleRoot() {
  const roots = [path.join(root, "src-tauri/target")];
  if (process.env.CARGO_TARGET_DIR) roots.unshift(process.env.CARGO_TARGET_DIR);
  const config = path.join(os.homedir(), ".cargo/config.toml");
  if (existsSync(config)) {
    const match = readFileSync(config, "utf8").match(/target-dir\s*=\s*"([^"]+)"/);
    if (match) roots.unshift(match[1]);
  }
  return roots;
}

function bundlePaths() {
  let app = null;
  let dmg = null;
  let nsis = null;
  for (const target of cargoBundleRoot()) {
    const bundle = path.join(target, "release/bundle");
    app ??= findChild(path.join(bundle, "macos"), ".app");
    dmg ??= findChild(path.join(bundle, "dmg"), ".dmg") ?? findChild(path.join(bundle, "macos"), ".dmg");
    nsis ??= findChild(path.join(bundle, "nsis"), ".exe");
  }
  return { app, dmg, nsis };
}

function readSamples(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function launchApp(binary, sessionDir, steps, timeoutMs, onTick) {
  mkdirSync(sessionDir, { recursive: true });
  const home = path.join(sessionDir, "home");
  mkdirSync(path.join(home, "Library", "Application Support"), { recursive: true });
  writeFileSync(path.join(sessionDir, "script.json"), JSON.stringify({ steps }));
  const sampleFile = path.join(sessionDir, "samples.jsonl");
  resetSampleLog(sampleFile);
  return new Promise((resolve) => {
    const child = spawn(binary, [], {
      env: { ...process.env, HOME: home, TWIGLANE_MEASURE_DIR: sessionDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const poll = setInterval(() => {
      if (!onTick) return;
      try {
        onTick(readSamples(sampleFile), child.pid);
      } catch {
        // 样本文件可能还没写完。
      }
    }, 1000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve({
        code,
        stdout,
        stderr,
        samples: readSamples(sampleFile).filter((item) => Number(item.pid) === child.pid),
        pid: child.pid,
      });
    });
  });
}

function replaceCheck(checks, check) {
  const index = checks.findIndex((item) => item.id === check.id);
  if (index === -1) checks.push(check);
  else checks[index] = check;
}

function measuredOrGap(id, summary, darwin, over, windowsNext) {
  const evidence = { platforms: { darwin } };
  if (!referenceReady) {
    return gap(
      id,
      `${summary} 本机不是接通电源、SSD 且内存不少于 16 GiB 的参考机，记为缺测。`,
      "换到满足 02 前提的 macOS arm64 参考机重测，并在 Windows 11 x64 用同一构建补同样本。",
      evidence,
    );
  }
  if (!darwin.contentOk || over) return failed(id, summary, evidence);
  return gap(id, `${summary} Windows 仍缺，不能通过。`, windowsNext, evidence);
}

function parseFootprint(pid) {
  const result = run("footprint", ["-p", String(pid)]);
  const text = textOf(result);
  const match = text.match(/phys_footprint:\s*([0-9.]+)\s*([KMG])?B?/i);
  if (!match) return { text, bytes: null };
  const value = Number(match[1]);
  const unit = (match[2] ?? "").toUpperCase();
  const scale = unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
  return { text, bytes: Math.round(value * scale) };
}

function groupFootprint(pid) {
  const rows = groupOf(pid);
  let total = 0;
  let any = false;
  const parts = [];
  for (const row of rows) {
    const parsed = parseFootprint(row.pid);
    parts.push(parsed.text);
    if (parsed.bytes === null) continue;
    total += parsed.bytes;
    any = true;
  }
  return { text: parts.join("\n"), bytes: any ? total : null };
}

function processRows() {
  const result = run("ps", ["-ax", "-o", "pid=,ppid=,pcpu=,rss=,comm="]);
  return textOf(result)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+([0-9.]+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      return { pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]), rss: Number(match[4]) * 1024, command: match[5] };
    })
    .filter(Boolean);
}

function groupOf(pid) {
  const rows = processRows();
  const wanted = new Set([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (wanted.has(row.ppid) && !wanted.has(row.pid)) {
        wanted.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => wanted.has(row.pid) || /Twiglane|twiglane/i.test(row.command));
}

async function gitText(repo, args) {
  const result = run("git", ["-C", repo, ...args]);
  if (result.status !== 0) throw new Error(textOf(result) || `git ${args.join(" ")} 失败`);
  return result.stdout.trim();
}

async function timeGitStatus(repo, count) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await gitText(repo, ["status", "--porcelain=v2", "--branch", "-z"]);
    samples.push(performance.now() - started);
  }
  return samples;
}

function sampleByName(samples, name) {
  return samples.filter((item) => item.name === name);
}

function numbers(samples, field) {
  return samples.map((item) => Number(item.detail?.[field])).filter((value) => Number.isFinite(value));
}

async function prepareCloneSource(dir) {
  const origin = path.join(dir, "origin.git");
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  mustRun("git", ["init", "--bare", "-b", "main", origin]);
  const seed = path.join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  mustRun("git", ["init", "-b", "main"], { cwd: seed });
  mustRun("git", ["config", "user.name", "Twiglane Fixture"], { cwd: seed });
  mustRun("git", ["config", "user.email", "fixture@twiglane.invalid"], { cwd: seed });
  writeFileSync(path.join(seed, "notes.txt"), `${lines.join("\n")}\n`);
  mustRun("git", ["add", "notes.txt"], { cwd: seed });
  mustRun("git", ["commit", "-m", "seed"], { cwd: seed });
  mustRun("git", ["remote", "add", "origin", origin], { cwd: seed });
  mustRun("git", ["push", "-u", "origin", "main"], { cwd: seed });
  return { origin, seed, lines };
}

function writeTwoHunks(repo) {
  const file = path.join(repo, "notes.txt");
  const lines = readFileSync(file, "utf8").split("\n");
  lines[1] = "line 2 changed";
  lines[27] = "line 28 changed";
  writeFileSync(file, lines.join("\n"));
}

async function prepareMergeRepo(dir) {
  const repo = path.join(dir, "merge");
  mkdirSync(repo, { recursive: true });
  mustRun("git", ["init", "-b", "main"], { cwd: repo });
  mustRun("git", ["config", "user.name", "Twiglane Fixture"], { cwd: repo });
  mustRun("git", ["config", "user.email", "fixture@twiglane.invalid"], { cwd: repo });
  writeFileSync(path.join(repo, "conflict.txt"), "base\n");
  mustRun("git", ["add", "conflict.txt"], { cwd: repo });
  mustRun("git", ["commit", "-m", "base"], { cwd: repo });
  mustRun("git", ["checkout", "-b", "other"], { cwd: repo });
  writeFileSync(path.join(repo, "conflict.txt"), "theirs\n");
  mustRun("git", ["commit", "-am", "theirs"], { cwd: repo });
  mustRun("git", ["checkout", "main"], { cwd: repo });
  writeFileSync(path.join(repo, "conflict.txt"), "ours\n");
  mustRun("git", ["commit", "-am", "ours"], { cwd: repo });
  return repo;
}

function relativeToRoot(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

async function main() {
  if (phase === "watch") {
    const sessionDir = path.join(rawDir, "perf");
    const pid = Number(readFileSync(path.join(sessionDir, "pid"), "utf8"));
    const samples = readSamples(path.join(sessionDir, "samples.jsonl"));
    const watchFile = path.join(sessionDir, "watch.json");
    const watch = existsSync(watchFile)
      ? JSON.parse(readFileSync(watchFile, "utf8"))
      : { cpu: [], footprint: null, sawGit: false, after: null };
    const alive = processRows().some((row) => row.pid === pid);
    const idleStarted = samples.some((item) => item.name === "idle");
    const idleEnded = samples.some((item) => item.name === "idle-end");
    if (alive && idleStarted && !idleEnded && watch.cpu.length < 70) {
      const rows = groupOf(pid);
      watch.cpu.push(rows.reduce((sum, row) => sum + row.cpu, 0));
      watch.sawGit = watch.sawGit || rows.some((row) => /(^|\/)git$/.test(row.command));
    }
    if (alive && idleEnded && !watch.footprint) watch.footprint = groupFootprint(pid);
    if (alive && samples.some((item) => item.name === "after-reclaim-end") && !watch.after) watch.after = groupFootprint(pid);
    writeFileSync(watchFile, JSON.stringify(watch));
    const last = samples.at(-1);
    console.log(JSON.stringify({ pid, alive, samples: samples.length, last: last?.name ?? null, cpu: watch.cpu.length, footprint: watch.footprint?.bytes ?? null, after: watch.after?.bytes ?? null }));
    return;
  }
  mkdirSync(rawDir, { recursive: true });
  const environment = probeEnvironment();
  referenceReady = environment.referenceReady;
  writeFileSync(path.join(outDir, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`);
  const bundles = bundlePaths();
  const macOsDir = bundles.app ? path.join(bundles.app, "Contents", "MacOS") : "";
  const binaryName = macOsDir && existsSync(macOsDir) ? readdirSync(macOsDir).find((item) => !item.startsWith(".")) : "";
  const binary = binaryName ? path.join(macOsDir, binaryName) : "";
  const release = Boolean(binary && existsSync(binary));
  const reportPath = path.join(outDir, "report.json");
  let checks = [];
  const windowsNext = "在 Windows 11 x64 上安装同一个版本的 NSIS 包，完成 S/M/L 界面测量、克隆到部分提交推送、合并冲突、双主题键盘，并保存 OID 与截图。";
  const protocolNext = "设置 TWIGLANE_HTTPS_REMOTE、TWIGLANE_HTTPS_DENY_REMOTE、TWIGLANE_SSH_REMOTE、TWIGLANE_SSH_DENY_REMOTE 后重跑测量。分别记录成功访问和认证失败，并确认输出不含凭据。不要把本地 bare remote 记成协议通过。";
  const saved = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
  if (phase !== "all" && Array.isArray(saved?.checks)) {
    checks = saved.checks;
    console.log(`沿用已有报告，本阶段 ${phase}`);
    if (phase !== "accept") {
      const accept = checks.find((check) => check.id === "accept.macos");
      if (accept && String(accept.summary).includes("windowsNext")) {
        accept.status = "gap";
        accept.summary = "还没有在 macOS 安装包里完成桌面验收。";
        accept.nextStep = "用已构建的 Twiglane.app 跑克隆、部分提交推送、合并冲突和双主题键盘，并保存 OID 与截图。";
      }
    }
  } else {

  checks.push(
    passed("docs.support", "README 写明了支持范围、安装、恢复边界、性能口径和已知限制。", {}),
  );
  checks.push(passed("package.git-explained", "界面和说明写明 Git 与 WebView2 缺失时的行为。", {}));
  checks.push(
    passed("package.webview2-cost", "WebView2 使用另行下载，成本不计入应用体积；本机没有 Windows 下载实测。", {
      includedInInstaller: false,
      mode: "downloadBootstrapper",
      measuredDownloadBytes: null,
      estimateNote: "引导程序约 1.8 MiB，Evergreen 离线 runtime 约 127 MiB，不计入应用体积。",
    }),
  );

  if (!bundles.app) {
    checks.push(gap("package.macos.app", "还没有 macOS app 产物。", "在本机执行 npm run tauri build 生成 app 后再记录体积和摘要。"));
    checks.push(gap("package.signature", "还没有可检查的 macOS 产物。", "构建 app 后用 codesign -dv 记录签名原文，不要把缺失写成已签名或已公证。"));
  } else {
    const plist = path.join(bundles.app, "Contents", "Info.plist");
    const info = existsSync(plist) ? readFileSync(plist, "utf8") : "";
    const bytes = directoryBytes(bundles.app);
    const evidence = {
      path: relativeToRoot(bundles.app),
      sha256: existsSync(plist) ? sha256File(plist) : "",
      productName: info.includes("<string>Twiglane</string>") ? "Twiglane" : "",
      bytes,
    };
    checks.push(bytes <= BUDGETS.installDirBytes && evidence.productName === "Twiglane"
      ? passed("package.macos.app", `macOS app 目录 ${bytes} 字节，显示名 Twiglane。`, evidence)
      : failed("package.macos.app", `macOS app 目录 ${bytes} 字节，或显示名不是 Twiglane。`, evidence));
    const codesign = run("codesign", ["-dv", "--verbose=4", bundles.app]);
    const codesignText = textOf(codesign);
    checks.push(
      passed("package.signature", "macOS 产物没有公证，不能当作已签名公开发布。", {
        notarized: false,
        trustedDistribution: false,
        codesign: codesignText.slice(0, 4000),
        statement: "ad-hoc 或未配置的测试签名，未公证",
      }),
    );
  }
  if (!bundles.dmg) {
    checks.push(gap("package.macos.dmg", "还没有 DMG。", "在本机执行 npm run tauri build 生成 DMG 后记录压缩体积。"));
  } else {
    const bytes = statSync(bundles.dmg).size;
    const evidence = { path: relativeToRoot(bundles.dmg), sha256: sha256File(bundles.dmg), productName: "Twiglane", bytes };
    checks.push(bytes <= BUDGETS.installerBytes
      ? passed("package.macos.dmg", `DMG ${bytes} 字节。`, evidence)
      : failed("package.macos.dmg", `DMG ${bytes} 字节，超过 30 MiB。`, evidence));
  }
  if (!bundles.nsis) {
    checks.push(gap("package.windows.nsis", "本机还没有生成 NSIS 安装包。", "在 macOS 上执行 Tauri 的 nsis 目标以确认配置可构建；Windows 安装运行仍须在 Windows 11 x64 上单独验收。", { runtimeVerified: false }));
  } else {
    const bytes = statSync(bundles.nsis).size;
    const evidence = {
      path: relativeToRoot(bundles.nsis),
      sha256: sha256File(bundles.nsis),
      productName: "Twiglane",
      bytes,
      runtimeVerified: false,
      hostPlatform: process.platform,
    };
    checks.push(bytes <= BUDGETS.installerBytes
      ? passed("package.windows.nsis", `NSIS 包 ${bytes} 字节。这只说明安装器已构建，不是 Windows 安装运行结果。`, evidence)
      : failed("package.windows.nsis", `NSIS 包 ${bytes} 字节，超过 30 MiB。`, evidence));
  }

  for (const id of ["perf.startup.s", "perf.status.s", "perf.status.m", "perf.status.l", "perf.diff.cached", "perf.diff.uncached", "perf.diff.large", "perf.feedback", "perf.scroll.m", "perf.interact.l", "perf.memory.s", "perf.cpu.s", "perf.git-idle", "perf.stability"]) {
    checks.push(gap(id, "界面性能还没有同时覆盖 macOS 与 Windows。", windowsNext, { platforms: {} }));
  }
  checks.push(gap("perf.native-git", "原生 Git 对照还没有同时覆盖两个系统。", windowsNext, { platforms: {} }));
  checks.push(gap("accept.macos", "还没有在 macOS 安装包里完成桌面验收。", "用已构建的 Twiglane.app 跑克隆、部分提交推送、合并冲突和双主题键盘，并保存 OID 与截图。"));
  checks.push(gap("accept.windows", "还没有 Windows 安装运行记录。", windowsNext));
  checks.push(gap("protocol.https", "没有受控 HTTPS 远程的成功与认证失败记录。", protocolNext));
  checks.push(gap("protocol.ssh", "没有受控 SSH 远程的成功与认证失败记录。", protocolNext));
  }
  if (bundles.app) {
    const plist = path.join(bundles.app, "Contents", "Info.plist");
    const info = existsSync(plist) ? readFileSync(plist, "utf8") : "";
    const bytes = directoryBytes(bundles.app);
    const evidence = {
      path: relativeToRoot(bundles.app),
      sha256: existsSync(plist) ? sha256File(plist) : "",
      productName: info.includes("<string>Twiglane</string>") ? "Twiglane" : "",
      bytes,
    };
    replaceCheck(checks, bytes <= BUDGETS.installDirBytes && evidence.productName === "Twiglane"
      ? passed("package.macos.app", `macOS app 目录 ${bytes} 字节，显示名 Twiglane。`, evidence)
      : failed("package.macos.app", `macOS app 目录 ${bytes} 字节，或显示名不是 Twiglane。`, evidence));
    const codesignText = textOf(run("codesign", ["-dv", "--verbose=4", bundles.app]));
    replaceCheck(checks, passed("package.signature", "macOS 产物没有公证，不能当作已签名公开发布。", {
      notarized: false,
      trustedDistribution: false,
      codesign: codesignText.slice(0, 4000),
      statement: "ad-hoc 或未配置的测试签名，未公证",
    }));
  }
  if (bundles.dmg) {
    const bytes = statSync(bundles.dmg).size;
    const evidence = { path: relativeToRoot(bundles.dmg), sha256: sha256File(bundles.dmg), productName: "Twiglane", bytes };
    replaceCheck(checks, bytes <= BUDGETS.installerBytes
      ? passed("package.macos.dmg", `DMG ${bytes} 字节。`, evidence)
      : failed("package.macos.dmg", `DMG ${bytes} 字节，超过 30 MiB。`, evidence));
  }

  if (release && process.platform === "darwin" && phase !== "package") {
    try {
    const fixtureRoot = path.join(os.tmpdir(), "twiglane-measure-fixtures");
    mkdirSync(fixtureRoot, { recursive: true });
    const manifests = {};
    for (const size of ["S", "M", "L"]) {
      const dest = path.join(fixtureRoot, size);
      const manifestPath = path.join(dest, "manifest.json");
      const repo = path.join(dest, "repo");
      if (existsSync(manifestPath) && existsSync(path.join(repo, ".git"))) {
        const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (existing.size === size && existing.verified === true && existing.seed === FIXTURE_SEED) {
          manifests[size] = { ...existing, repo };
          console.log(`复用 ${size} head ${existing.head}`);
          continue;
        }
      }
      console.log(`生成 ${size} 夹具`);
      manifests[size] = await generateFixture({ dest, size });
      console.log(`${size} head ${manifests[size].head} files ${manifests[size].files} commits ${manifests[size].commits} changes ${manifests[size].modifications}`);
    }
    const nativeFile = path.join(rawDir, "native-git.json");
    let native = null;
    if (wants("startup")) {
    if (existsSync(nativeFile)) native = JSON.parse(readFileSync(nativeFile, "utf8"));
    if (!native) {
      native = {};
      for (const size of ["S", "M", "L"]) native[size] = await timeGitStatus(manifests[size].repo, 30);
      writeFileSync(nativeFile, JSON.stringify(native));
    }
    replaceCheck(checks, gap("perf.native-git", "已记录本机原生 Git 状态耗时，Windows 仍缺。", windowsNext, {
      platforms: { darwin: { method: "git-cli", samplesMs: native, contentOk: true } },
    }));

    const startup = [];
    console.log("测量 S 仓库启动");
    for (let index = 0; index < 5; index += 1) {
      console.log(`启动 ${index + 1}/5`);
      const session = path.join(rawDir, `startup-${index}`);
      const result = await launchApp(binary, session, [{
        op: "open",
        repo: manifests.S.repo,
        expectChanges: manifests.S.modifications,
        expectHead: manifests.S.head,
        startup: true,
        launch: index === 0 ? "first" : "later",
      }], 60000);
      writeFileSync(path.join(session, "launch.json"), JSON.stringify({ code: result.code, stderr: result.stderr.slice(0, 4000) }, null, 2));
      startup.push(result);
    }
    const startupRows = startup.map((result) => startupTiming(result.samples, result.pid));
    const first = startupRows.filter((item) => item.launch === "first").map((item) => item.controlsMs);
    const later = startupRows.filter((item) => item.launch === "later").map((item) => item.controlsMs);
    const startupOk = startupRows.every((item) => item.contentOk && Number.isFinite(item.controlsMs));
    const startupDarwin = {
      method: "gui-controls-ready",
      contentOk: startupOk && first.length >= 1 && later.length >= 4,
      firstMs: first,
      laterMs: later,
      openMs: startupRows.map((item) => item.openMs),
      fileCache: "not-purged",
      prerequisite: prerequisite(environment, true),
      browserMock: false,
    };
    const startupOver = !environment.referenceReady || Math.max(...first, 0) > BUDGETS.startupFirstMs || (p95(later) ?? Infinity) > BUDGETS.startupLaterP95Ms;
    replaceCheck(checks, measuredOrGap("perf.startup.s", `macOS 启动样本 ${startupRows.length} 条。`, startupDarwin, startupOver || !startupDarwin.contentOk, windowsNext));
    }

    const guiPhase = phase === "all" || phase === "s-idle" || phase === "m-diff" || phase === "large" || phase === "l-status" || phase === "score";
    if (guiPhase) {
    const paths = Array.from({ length: 30 }, (_, index) => filePath(index));
    const largeDir = path.join(fixtureRoot, "large-diff");
    rmSync(largeDir, { recursive: true, force: true });
    mkdirSync(largeDir, { recursive: true });
    const largeRepo = path.join(largeDir, "repo");
    mustRun("git", ["init", "-b", "main", largeRepo]);
    mustRun("git", ["config", "user.name", "Twiglane Fixture"], { cwd: largeRepo });
    mustRun("git", ["config", "user.email", "fixture@twiglane.invalid"], { cwd: largeRepo });
    writeFileSync(path.join(largeRepo, "wide.txt"), `${"a".repeat(80)}\n`.repeat(40000));
    mustRun("git", ["add", "wide.txt"], { cwd: largeRepo });
    mustRun("git", ["commit", "-m", "wide"], { cwd: largeRepo });
    writeFileSync(path.join(largeRepo, "wide.txt"), `${"b".repeat(80)}\n`.repeat(40000));
    const feedbackDir = path.join(fixtureRoot, "feedback");
    rmSync(feedbackDir, { recursive: true, force: true });
    mkdirSync(feedbackDir, { recursive: true });
    const feedbackOrigin = path.join(feedbackDir, "origin.git");
    const feedbackParent = path.join(feedbackDir, "clones");
    mkdirSync(feedbackParent, { recursive: true });
    mustRun("git", ["init", "--bare", "-b", "main", feedbackOrigin]);
    const feedbackSeed = path.join(feedbackDir, "seed");
    mkdirSync(feedbackSeed, { recursive: true });
    mustRun("git", ["init", "-b", "main"], { cwd: feedbackSeed });
    mustRun("git", ["config", "user.name", "Twiglane Fixture"], { cwd: feedbackSeed });
    mustRun("git", ["config", "user.email", "fixture@twiglane.invalid"], { cwd: feedbackSeed });
    writeFileSync(path.join(feedbackSeed, "note.txt"), "feedback\n");
    mustRun("git", ["add", "note.txt"], { cwd: feedbackSeed });
    mustRun("git", ["commit", "-m", "feedback"], { cwd: feedbackSeed });
    mustRun("git", ["remote", "add", "origin", feedbackOrigin], { cwd: feedbackSeed });
    mustRun("git", ["push", "-u", "origin", "main"], { cwd: feedbackSeed });
    mustRun("git", ["remote", "add", "origin", feedbackOrigin], { cwd: largeRepo });
    const second = path.join(fixtureRoot, "S-copy");
    rmSync(second, { recursive: true, force: true });
    mkdirSync(second, { recursive: true });
    mustRun("git", ["clone", "--no-hardlinks", manifests.S.repo, path.join(second, "repo")]);
    const copyHead = (await gitText(path.join(second, "repo"), ["rev-parse", "HEAD"])).trim();
    const idleWatch = { cpu: [], footprint: null, sawGit: false, after: null };
    const stabilitySteps = [
      { op: "open", repo: manifests.S.repo, expectChanges: manifests.S.modifications, expectHead: manifests.S.head },
      { op: "diff-cycle", paths: paths.slice(0, 2), count: 100 },
      ...Array.from({ length: 20 }, (_, index) => ({
        op: "open",
        mark: "stability",
        repo: index % 2 === 0 ? manifests.S.repo : path.join(second, "repo"),
        expectChanges: index % 2 === 0 ? manifests.S.modifications : 0,
        expectHead: index % 2 === 0 ? manifests.S.head : copyHead,
      })),
      { op: "sleep", ms: 2000, mark: "after-reclaim" },
    ];
    const stepsByPhase = {
      "s-idle": [
        { op: "open", repo: manifests.S.repo, expectChanges: manifests.S.modifications, expectHead: manifests.S.head },
        { op: "refresh", count: 30, expectChanges: manifests.S.modifications, expectHead: manifests.S.head, size: "S" },
        { op: "sleep", ms: 65000, mark: "idle" },
        ...stabilitySteps,
      ],
      "m-diff": [
        { op: "open", repo: manifests.M.repo, expectChanges: manifests.M.modifications, expectHead: manifests.M.head },
        { op: "refresh", count: 30, expectChanges: manifests.M.modifications, expectHead: manifests.M.head, size: "M" },
        { op: "diff-cycle", paths, count: 60 },
        { op: "scroll", frames: 120 },
      ],
      large: [
        { op: "open", repo: largeRepo, expectChanges: 1 },
        { op: "large-diff", path: "wide.txt", count: 30 },
        { op: "feedback", count: 30, cloneUrl: feedbackOrigin, cloneParent: feedbackParent },
      ],
      "l-status": [
        { op: "cancel-open", slowRepo: manifests.L.repo, nextRepo: manifests.S.repo },
        { op: "open", repo: manifests.L.repo, expectChanges: manifests.L.modifications, expectHead: manifests.L.head },
        { op: "refresh", count: 30, expectChanges: manifests.L.modifications, expectHead: manifests.L.head, size: "L" },
      ],
    };
    const perfSteps = phase === "all"
      ? [...stepsByPhase["s-idle"], ...stepsByPhase["m-diff"], ...stepsByPhase.large, ...stepsByPhase["l-status"]]
      : stepsByPhase[phase] ?? [];
    console.log(`测量阶段 ${phase}`);
    const sessionDir = path.join(rawDir, "perf");
    let perfRun = null;
    if (phase === "score") {
      const watchFile = path.join(sessionDir, "watch.json");
      if (existsSync(watchFile)) Object.assign(idleWatch, JSON.parse(readFileSync(watchFile, "utf8")));
      if (idleWatch.footprint && idleWatch.footprint.bytes == null) {
        const match = String(idleWatch.footprint.text ?? "").match(/phys_footprint:\s*([0-9.]+)\s*([KMG])?B?/i);
        if (match) {
          const unit = (match[2] ?? "").toUpperCase();
          const scale = unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
          idleWatch.footprint.bytes = Math.round(Number(match[1]) * scale);
        }
      }
      perfRun = { code: 0, stderr: "", samples: readSamples(path.join(sessionDir, "samples.jsonl")) };
    } else if (process.env.TWIGLANE_DETACH === "1") {
      rmSync(sessionDir, { recursive: true, force: true });
      mkdirSync(sessionDir, { recursive: true });
      mkdirSync(path.join(sessionDir, "home", "Library", "Application Support"), { recursive: true });
      writeFileSync(path.join(sessionDir, "script.json"), JSON.stringify({ steps: perfSteps }));
      const child = spawn(binary, [], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, HOME: path.join(sessionDir, "home"), TWIGLANE_MEASURE_DIR: sessionDir },
      });
      writeFileSync(path.join(sessionDir, "pid"), String(child.pid));
      child.unref();
      console.log(`已分离启动 ${child.pid}`);
    } else {
      perfRun = await launchApp(binary, sessionDir, perfSteps, 45 * 60 * 1000, (samples, pid) => {
        const idleStarted = samples.some((item) => item.name === "idle");
        const idleEnded = samples.some((item) => item.name === "idle-end");
        if (idleStarted && !idleEnded && idleWatch.cpu.length < 70) {
          const rows = groupOf(pid);
          idleWatch.cpu.push(rows.reduce((sum, row) => sum + row.cpu, 0));
          idleWatch.sawGit = idleWatch.sawGit || rows.some((row) => /(^|\/)git$/.test(row.command));
        }
        if (idleEnded && !idleWatch.footprint) idleWatch.footprint = groupFootprint(pid);
        if (samples.some((item) => item.name === "after-reclaim-end") && !idleWatch.after) idleWatch.after = groupFootprint(pid);
      });
    }
    if (!perfRun) {
      console.log("本阶段只负责启动或等待，不改性能结论。");
    } else {
    writeFileSync(path.join(rawDir, "perf-launch.json"), JSON.stringify({ code: perfRun.code, stderr: perfRun.stderr.slice(0, 4000) }, null, 2));
    const base = {
      prerequisite: prerequisite(environment, true),
      browserMock: false,
    };
    const refreshSamples = sampleByName(perfRun.samples, "status-refresh");
    for (const size of ["S", "M", "L"]) {
      const block = refreshSamples.find((item) => item.detail?.size === size);
      if (!block) continue;
      const samplesMs = block?.detail?.samplesMs ?? [];
      const budget = BUDGETS.statusP95Ms[size];
      const darwin = { ...base, method: "gui-refresh-to-first-screen", contentOk: block?.detail?.contentOk === true, samplesMs };
      replaceCheck(checks, measuredOrGap(`perf.status.${size.toLowerCase()}`, `macOS ${size} 状态样本 ${samplesMs.length} 条。`, darwin, (p95(samplesMs) ?? Infinity) > budget, windowsNext));
    }
    const diff = sampleByName(perfRun.samples, "diff-cycle").find((item) => (item.detail?.uncachedMs?.length ?? 0) >= 30)?.detail;
    if (diff) {
    replaceCheck(checks, measuredOrGap("perf.diff.cached", "macOS 已缓存差异。", { ...base, method: "gui-diff-switch", contentOk: diff.contentOk === true, samplesMs: diff.cachedMs ?? [] }, (p95(diff.cachedMs ?? []) ?? Infinity) > BUDGETS.diffCachedP95Ms, windowsNext));
    replaceCheck(checks, measuredOrGap("perf.diff.uncached", "macOS 未缓存差异。", { ...base, method: "gui-diff-switch", contentOk: Array.isArray(diff.uncachedMs) && diff.uncachedMs.length >= 30, samplesMs: diff.uncachedMs ?? [] }, (p95(diff.uncachedMs ?? []) ?? Infinity) > BUDGETS.diffUncachedP95Ms, windowsNext));
    }
    const largeSample = sampleByName(perfRun.samples, "large-diff").at(-1);
    const large = largeSample?.detail ?? {};
    const largeSamples = Array.isArray(large.samplesMs) ? large.samplesMs : [];
    const largeTruncated = Array.isArray(large.truncated) && large.truncated.length >= 30 && large.truncated.every(Boolean);
    if (largeSample) replaceCheck(checks, measuredOrGap("perf.diff.large", "macOS 大文件摘要。", { ...base, method: "gui-large-summary", contentOk: largeSamples.length >= 30 && largeTruncated, truncated: largeTruncated, samplesMs: largeSamples }, (p95(largeSamples) ?? Infinity) > BUDGETS.largeSummaryP95Ms || largeSamples.length < 30 || !largeTruncated, windowsNext));
    const feedback = sampleByName(perfRun.samples, "feedback").at(-1)?.detail;
    if (feedback) {
    const feedbackTasks = Array.isArray(feedback.operations) ? feedback.operations : [];
    const feedbackStarted = ["clone", "sync", "commit"].every((task) => feedbackTasks.includes(task));
    const feedbackDarwin = { ...base, method: "gui-feedback", contentOk: feedback.contentOk === true && feedbackStarted, samplesMs: feedback.samplesMs ?? [], painted: feedback.painted === true, tasks: feedbackTasks };
    replaceCheck(checks, feedback.painted === false
      ? gap("perf.feedback", "macOS 反馈没有等到绘制帧，不能把超时回退当成界面延迟。", "让 Twiglane 窗口处于可见前台后重测任务反馈，并在 Windows 11 x64 补同样本。", { platforms: { darwin: feedbackDarwin } })
      : measuredOrGap("perf.feedback", "macOS 反馈延迟。", feedbackDarwin, (p95(feedback.samplesMs ?? []) ?? Infinity) > BUDGETS.feedbackP95Ms, windowsNext));
    }
    const scroll = sampleByName(perfRun.samples, "scroll")[0]?.detail;
    if (scroll) {
    const scrollDarwin = { ...base, method: "gui-scroll-frames", contentOk: scroll.contentOk === true, frameMs: scroll.frameMs ?? [], painted: scroll.painted === true };
    replaceCheck(checks, scroll.painted === false
      ? gap("perf.scroll.m", "macOS 列表没有收到绘制帧，不能把超时回退当成滚动耗时。", "让 Twiglane 窗口处于可见前台后重测 M 列表滚动，并在 Windows 11 x64 补同样本。", { platforms: { darwin: scrollDarwin } })
      : measuredOrGap("perf.scroll.m", "macOS 列表滚动帧。", scrollDarwin, (p95(scroll.frameMs ?? []) ?? Infinity) > BUDGETS.scrollFrameP95Ms, windowsNext));
    }
    const cancel = sampleByName(perfRun.samples, "cancel-open").at(-1)?.detail;
    if (cancel) replaceCheck(checks, measuredOrGap("perf.interact.l", "macOS 加载大仓库时的键盘、取消和切换。", { ...base, method: "gui-cancel-and-switch", contentOk: cancel.contentOk === true && cancel.readStarted === true, keyboard: cancel.keyboard === true, cancelled: cancel.cancelled === true, switched: cancel.switched === true, readStarted: cancel.readStarted === true }, cancel.contentOk !== true || cancel.readStarted !== true, windowsNext));
    if (sampleByName(perfRun.samples, "idle").length) {
    const cpu = idleWatch.cpu.length ? idleWatch.cpu.reduce((sum, value) => sum + value, 0) / idleWatch.cpu.length : null;
    replaceCheck(checks, measuredOrGap("perf.cpu.s", "macOS 空闲 CPU。", { ...base, method: "gui-idle", contentOk: cpu !== null, cpuPercent: cpu }, cpu === null || cpu > BUDGETS.idleCpuPercent, windowsNext));
    replaceCheck(checks, measuredOrGap("perf.git-idle", "macOS 空闲 Git 子进程。", { ...base, method: "gui-idle", contentOk: true, lingeringGit: idleWatch.sawGit }, idleWatch.sawGit, windowsNext));
    const memoryBytes = idleWatch.footprint?.bytes ?? null;
    replaceCheck(checks, memoryBytes === null
      ? gap("perf.memory.s", "没有读到 macOS phys_footprint，RSS 不能代替私有内存。", "在接通电源的参考机上用 footprint 重测空闲进程组，并补 Windows 私有工作集。", { platforms: { darwin: { ...base, method: "gui-idle", contentOk: false, privateBytes: null, metric: "unavailable", footprint: idleWatch.footprint?.text ?? "" } } })
      : measuredOrGap("perf.memory.s", "macOS 空闲 phys_footprint。", { ...base, method: "gui-idle", contentOk: true, privateBytes: memoryBytes, metric: "phys_footprint" }, memoryBytes > BUDGETS.idlePrivateBytes, windowsNext));
    }
    const stabilityOpens = sampleByName(perfRun.samples, "status-open").filter((item) => item.detail?.mark === "stability");
    const stabilityDiff = sampleByName(perfRun.samples, "diff-cycle").find((item) => ((item.detail?.uncachedMs?.length ?? 0) + (item.detail?.cachedMs?.length ?? 0)) >= 100)?.detail ?? {};
    const fileSwitches = (stabilityDiff.uncachedMs?.length ?? 0) + (stabilityDiff.cachedMs?.length ?? 0);
    const repoSwitches = stabilityOpens.length;
    if (repoSwitches > 0 || fileSwitches >= 100) {
    const baselineBytes = idleWatch.footprint?.bytes ?? null;
    const afterBytes = idleWatch.after?.bytes ?? null;
    const growth = baselineBytes && afterBytes !== null ? (afterBytes - baselineBytes) / baselineBytes : null;
    const lingering = processRows().some((row) => /Twiglane/i.test(row.command));
    const stabilityDarwin = {
      ...base,
      method: "gui-stability",
      contentOk: fileSwitches === 100 && repoSwitches === 20 && growth !== null,
      growth,
      fileSwitches,
      repoSwitches,
      lingeringProcesses: lingering,
      baselineBytes,
      afterBytes,
    };
    replaceCheck(
      checks,
      growth === null
        ? gap("perf.stability", `macOS 长时文件切换 ${fileSwitches} 次、仓库切换 ${repoSwitches} 次，但没有读到回收前后的 phys_footprint。`, "在参考机上用 footprint 重测 100 次文件切换和 20 次仓库切换，并在 Windows 11 x64 补同样本。", { platforms: { darwin: stabilityDarwin } })
        : measuredOrGap("perf.stability", `macOS 长时内存增长 ${growth}。`, stabilityDarwin, growth > BUDGETS.stabilityGrowth || lingering, windowsNext),
    );
    }
    }
    }

    if (phase === "all" || phase === "accept") {
    const acceptanceDir = path.join(os.tmpdir(), "twiglane-acceptance");
    rmSync(acceptanceDir, { recursive: true, force: true });
    mkdirSync(acceptanceDir, { recursive: true });
    const cloneSource = await prepareCloneSource(acceptanceDir);
    const parent = path.join(acceptanceDir, "parent");
    mkdirSync(parent, { recursive: true });
    const cloneSession = path.join(rawDir, "accept-clone");
    const cloneRun = await launchApp(binary, cloneSession, [{ op: "clone", url: cloneSource.origin, parent, name: "cloned" }], 120000);
    const cloneSample = sampleByName(cloneRun.samples, "clone")[0];
    const cloned = cloneSample?.detail?.path;
    if (cloned && existsSync(cloned)) writeTwoHunks(cloned);
    const pushSession = path.join(rawDir, "accept-push");
    const pushRun = cloned
      ? await launchApp(binary, pushSession, [{ op: "open", repo: cloned, expectChanges: 1, expectHead: cloneSource ? undefined : "" }, { op: "stage-commit-push", message: "部分暂存" }], 120000)
      : { samples: [], stderr: "clone 没有返回路径", code: 1 };
    const mergeRepo = await prepareMergeRepo(acceptanceDir);
    const mergeHead = await gitText(mergeRepo, ["rev-parse", "HEAD"]);
    const keyboardRepo = path.join(acceptanceDir, "keyboard");
    mkdirSync(keyboardRepo, { recursive: true });
    mustRun("git", ["init", "-b", "main"], { cwd: keyboardRepo });
    mustRun("git", ["config", "user.name", "Twiglane Fixture"], { cwd: keyboardRepo });
    mustRun("git", ["config", "user.email", "fixture@twiglane.invalid"], { cwd: keyboardRepo });
    writeFileSync(path.join(keyboardRepo, "a.txt"), "a\n");
    writeFileSync(path.join(keyboardRepo, "b.txt"), "b\n");
    mustRun("git", ["add", "a.txt", "b.txt"], { cwd: keyboardRepo });
    mustRun("git", ["commit", "-m", "base"], { cwd: keyboardRepo });
    writeFileSync(path.join(keyboardRepo, "a.txt"), "a changed\n");
    writeFileSync(path.join(keyboardRepo, "b.txt"), "b changed\n");
    const keyboardHead = await gitText(keyboardRepo, ["rev-parse", "HEAD"]);
    const mergeSession = path.join(rawDir, "accept-merge");
    const screenshot = path.join(rawDir, "macos-desktop.png");
    let shot = false;
    let shotError = "";
    const takeShot = () => {
      if (shot) return;
      shot = true;
      shotError = textOf(run("screencapture", ["-x", screenshot]));
    };
    const mergePromise = launchApp(binary, mergeSession, [
      { op: "open", repo: mergeRepo, expectChanges: 0, expectHead: mergeHead },
      { op: "merge", source: "other", content: "resolved\n" },
      { op: "open", repo: keyboardRepo, expectChanges: 2, expectHead: keyboardHead },
      { op: "keyboard-theme" },
      { op: "sleep", ms: 3000, mark: "screenshot" },
    ], 180000, (samples) => {
      if (samples.some((item) => item.name === "keyboard-theme" || item.name === "screenshot")) takeShot();
    });
    const shotTimer = setTimeout(takeShot, 4000);
    const mergeRun = await mergePromise;
    clearTimeout(shotTimer);
    if (!shot) takeShot();
    let partialOk = false;
    let pushed = false;
    let commitOid = "";
    let mergeOid = "";
    const oids = [];
    if (cloned && existsSync(path.join(cloned, ".git"))) {
      commitOid = await gitText(cloned, ["rev-parse", "HEAD"]);
      const originOid = await gitText(cloneSource.origin, ["rev-parse", "refs/heads/main"]);
      const workDiff = await gitText(cloned, ["diff", "--name-only"]);
      const committed = await gitText(cloned, ["show", "HEAD:notes.txt"]);
      partialOk = workDiff.includes("notes.txt") && committed.includes("line 2 changed") !== committed.includes("line 28 changed");
      pushed = originOid === commitOid && commitOid !== cloneSample?.detail?.head;
      oids.push(commitOid, originOid);
    }
    if (existsSync(path.join(mergeRepo, ".git"))) {
      mergeOid = await gitText(mergeRepo, ["rev-parse", "HEAD"]);
      const merged = readFileSync(path.join(mergeRepo, "conflict.txt"), "utf8");
      if (merged === "resolved\n" && mergeOid && mergeOid !== mergeHead) oids.push(mergeOid);
      else mergeOid = "";
    }
    const theme = sampleByName(mergeRun.samples, "keyboard-theme").at(-1)?.detail ?? {};
    const keyboardOk =
      theme.shortcutFocused === true &&
      theme.selectionChanged === true &&
      Boolean(theme.selectionMoved) &&
      Boolean(theme.selectionAfter) &&
      theme.selectionMoved !== theme.selectionBefore &&
      theme.selectionAfter !== theme.selectionMoved;
    const shotOk = existsSync(screenshot) && statSync(screenshot).size > 1000;
    const acceptEvidence = {
      method: "installed-app-ipc-and-dom",
      hostPlatform: "darwin",
      browserMock: false,
      oids,
      partialCommit: partialOk,
      pushed,
      mergeOid,
      themes: theme.theme ?? [],
      keyboard: keyboardOk,
      shortcutFocused: theme.shortcutFocused === true,
      selectionChanged: theme.selectionChanged === true,
      selectionBefore: typeof theme.selectionBefore === "string" ? theme.selectionBefore : "",
      selectionMoved: typeof theme.selectionMoved === "string" ? theme.selectionMoved : "",
      selectionAfter: typeof theme.selectionAfter === "string" ? theme.selectionAfter : "",
      screenshot: shotOk ? relativeToRoot(screenshot) : "",
      screenshotError: shotError.slice(0, 500),
      stderr: [cloneRun.stderr, pushRun.stderr, mergeRun.stderr].join("\n").slice(0, 4000),
    };
    const operationsReady = partialOk && pushed && Boolean(mergeOid) && keyboardOk && (theme.theme ?? []).includes("light") && (theme.theme ?? []).includes("dark");
    const acceptReady = operationsReady && shotOk;
    const acceptIndex = checks.findIndex((check) => check.id === "accept.macos");
    checks[acceptIndex] = acceptReady
      ? passed("accept.macos", "macOS 安装包完成了克隆、部分提交推送、合并和双主题键盘。", acceptEvidence)
      : operationsReady
        ? gap("accept.macos", "macOS 安装包完成了克隆、部分提交推送、合并和双主题键盘，但当前会话无法截取桌面画面。", "在有可用显示器的 macOS 图形会话里重跑验收并保存截图；不要把这次缺失写成已有桌面证据。", acceptEvidence)
        : failed("accept.macos", "macOS 安装包验收没有全部完成，详见 evidence。", acceptEvidence);
    writeFileSync(path.join(rawDir, "acceptance.json"), `${JSON.stringify(acceptEvidence, null, 2)}\n`);
    }
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      writeFileSync(path.join(rawDir, "measure-error.txt"), message);
      const accept = checks.find((check) => check.id === "accept.macos");
      if (accept && accept.status === "gap") {
        accept.summary = `macOS 测量没有跑完：${error instanceof Error ? error.message : error}`;
        accept.nextStep = "根据 docs/verification/raw/measure-error.txt 修复后，在本机 release 包上重跑 node scripts/measure-delivery.mjs。";
      }
    }
  }

  replaceCheck(checks, await measureProtocol("https", process.env, gitLsRemote));
  replaceCheck(checks, await measureProtocol("ssh", process.env, gitLsRemote));

  const fingerprint = sourceFingerprint(root);
  const report = {
    format: "twiglane-delivery-verification/v1",
    sourceFingerprint: fingerprint,
    generatedAt: new Date().toISOString(),
    hostPlatform: process.platform,
    checks,
  };
  for (const check of report.checks) {
    if (check.status !== "pass") continue;
    const reasons = validateCheck(check, { root, hostPlatform: process.platform });
    if (reasons.length) {
      check.status = "fail";
      check.summary = `${check.summary} 验证器拒绝：${reasons.join("；")}`;
      check.nextStep = check.nextStep || "修正记录或实现后重跑测量，不要手写通过。";
    }
  }
  writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const failing = report.checks.filter((check) => check.status !== "pass").map((check) => check.id);
  console.log(`已写入 docs/verification/report.json。未通过 ${failing.length} 项。`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
