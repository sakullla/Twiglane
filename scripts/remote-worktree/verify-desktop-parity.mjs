import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { machine } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const format = "twiglane-remote-worktree-evidence/v2";
export const scope = "development-native-ssh-smoke";
export const testName = "real_v2_opens_native_and_cliora_task";
export const testSource = "src-tauri/src/remote_worktree/live.rs";
const cargoArgs = [
  "test", "--locked", "--manifest-path", "src-tauri/Cargo.toml",
  "--lib", testName, "--", "--nocapture",
];
export const command = ["cargo", ...cargoArgs].join(" ");
export const sourcePaths = {
  twiglane: ["src", "src-tauri", "remote-agent", "package.json", "package-lock.json"],
  cliora: ["src", "src-tauri", "package.json", "package-lock.json"],
};
const inputs = [
  "TWIGLANE_T4_SSH_CONFIG",
  "TWIGLANE_T4_SSH_REPO",
  "TWIGLANE_T4_SSH_HOST",
  "TWIGLANE_T4_SSH_USER",
  "TWIGLANE_T4_SSH_PORT",
  "TWIGLANE_AGENT_V2_DIR",
  "TWIGLANE_CLIORA_CONNECTOR",
  "CLIORA_TWIGLANE_TEST_DB",
];
const platforms = ["linux", "macos", "windows"];
const remoteTargets = [
  { platform: "linux", architecture: "x86_64" },
  { platform: "linux", architecture: "aarch64" },
  { platform: "macos", architecture: "x86_64" },
  { platform: "macos", architecture: "aarch64" },
  { platform: "windows", architecture: "x86_64" },
];
const commitId = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const flag = "--twiglane-remote-v1";
const usage = `Usage
  node scripts/remote-worktree/verify-desktop-parity.mjs --run [--output NEW.json]

Run against an operator-approved disposable SSH fixture. Use a debug Cliora
connector and keep its isolated database and agent manifest beside the SSH
config or in its subdirectories. The test may install the fixture agent.

Required environment variables
  ${inputs.join("\n  ")}

TWIGLANE_VERIFY_CLIORA optionally points at the Cliora checkout (default ../cliora).
Keep CLIORA_TWIGLANE_TEST_V2_PUBLISHER when the fixture uses a development signer.
Without --output the sanitized JSON record goes to stdout. Skips exit nonzero.
`;

export function unverifiedFor(status, desktop, remote) {
  const passed = status === "passed";
  return {
    desktopPlatforms: platforms.filter((platform) => !passed || platform !== desktop?.platform),
    remoteTargets: remoteTargets.filter(({ platform, architecture }) =>
      !passed || platform !== remote?.platform || architecture !== remote?.architecture),
    releaseUi: true,
    releaseSignatures: true,
    connectorBuildProvenance: true,
    operatingSystemDeepLinksAndReviewReturn: true,
    completeFeatureParity: true,
  };
}

function platformName(value) {
  switch (String(value).toLowerCase()) {
    case "linux": return "linux";
    case "darwin": return "macos";
    case "win32":
    case "windows": return "windows";
    default: return null;
  }
}

function architectureName(value) {
  switch (String(value).toLowerCase()) {
    case "amd64":
    case "x64":
    case "x86_64": return "x86_64";
    case "arm64":
    case "aarch64": return "aarch64";
    default: return null;
  }
}

function run(program, args, cwd, env = process.env, timeout) {
  return spawnSync(program, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    timeout,
  });
}

function cleanRef(repo, paths) {
  const gitFlags = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
  const head = run("git", [...gitFlags, "rev-parse", "--verify", "HEAD"], repo);
  const changes = run("git", [...gitFlags, "status", "--porcelain", "--untracked-files=all", "--", ...paths], repo);
  const ref = head.stdout?.trim();
  if (head.status !== 0 || !commitId.test(ref ?? "") || changes.status !== 0 || changes.stdout !== "") {
    throw new Error("source unavailable or dirty");
  }
  return ref;
}

function file(value) {
  const path = realpathSync(resolve(value));
  if (!statSync(path).isFile()) throw new Error("fixture input must be a file");
  return path;
}

function inside(directory, path) {
  const suffix = relative(directory, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureEnvironment(environment) {
  const config = file(environment.TWIGLANE_T4_SSH_CONFIG);
  const fixtureRoot = dirname(config);
  const database = file(environment.CLIORA_TWIGLANE_TEST_DB);
  const artifacts = realpathSync(resolve(environment.TWIGLANE_AGENT_V2_DIR));
  const manifest = file(resolve(artifacts, "manifest.json"));
  if ((fixtureRoot !== artifacts && !inside(fixtureRoot, artifacts))
      || !inside(fixtureRoot, database) || !inside(fixtureRoot, manifest)) {
    throw new Error("fixture paths must be contained by the SSH config directory");
  }
  const port = Number(environment.TWIGLANE_T4_SSH_PORT);
  if (!/^\d{1,5}$/.test(environment.TWIGLANE_T4_SSH_PORT) || port < 1 || port > 65535) {
    throw new Error("invalid fixture port");
  }
  const connector = file(environment.TWIGLANE_CLIORA_CONNECTOR);
  const connectorBytes = readFileSync(connector);
  // Release builds ignore the test database override. Check for both
  // development-only inputs before asking the connector to open a database.
  if (!connectorBytes.includes("CLIORA_TWIGLANE_TEST_DB")
      || !connectorBytes.includes("CLIORA_TWIGLANE_TEST_V2_PUBLISHER")) {
    throw new Error("debug connector with fixture database support required");
  }
  return {
    env: {
      ...environment,
      TWIGLANE_T4_SSH_CONFIG: config,
      TWIGLANE_AGENT_V2_DIR: artifacts,
      TWIGLANE_CLIORA_CONNECTOR: connector,
      CLIORA_TWIGLANE_TEST_DB: database,
      CLIORA_SSH_PROXY: "off",
      CARGO_TERM_COLOR: "never",
    },
    artifacts: {
      connectorSha256: digest(connectorBytes),
      agentManifestSha256: digest(readFileSync(manifest)),
    },
  };
}

function connectorJson(args, cwd, env) {
  const output = run(env.TWIGLANE_CLIORA_CONNECTOR, [flag, ...args], cwd, env, 45_000);
  if (output.status !== 0 || output.error) throw new Error("fixture connector failed");
  return JSON.parse(output.stdout);
}

function probeFixture(cwd, env) {
  const catalog = connectorJson(["list"], cwd, env);
  const matches = catalog.targets?.filter((target) => target.defaultPath === env.TWIGLANE_T4_SSH_REPO);
  if (catalog.protocol !== 1 || matches?.length !== 1) throw new Error("fixture path must identify one target");
  const target = matches[0];
  if (target.host !== env.TWIGLANE_T4_SSH_HOST || target.user !== env.TWIGLANE_T4_SSH_USER
      || target.port !== Number(env.TWIGLANE_T4_SSH_PORT)
      || typeof target.targetId !== "string" || target.targetId.length === 0
      || !sha256.test(target.targetRevision ?? "")) {
    throw new Error("fixture connector target differs from the direct target");
  }
  const reply = connectorJson(["probe-v2", target.targetId, target.targetRevision], cwd, env);
  const platform = platformName(reply.system);
  const architecture = architectureName(reply.architecture);
  if (!platform || !architecture || !sha256.test(reply.peerIdentity ?? "") || !sha256.test(reply.peerRevision ?? "")) {
    throw new Error("fixture platform or authentication unavailable");
  }
  return { platform, architecture, probe: "cliora-connector/probe-v2", authenticated: true };
}

export function parseGate({ error, status, stdout }) {
  const output = stdout ?? "";
  const tests = output.match(/^running 1 test\r?$/gm);
  const result = output.match(/^test result: ok\. 1 passed; 0 failed; 0 ignored;/gm);
  const success = new RegExp(`^test (?:\\w+::)*${testName} \\.\\.\\. ok\\r?$`, "gm");
  const cases = output.match(success);
  const commits = [...output.matchAll(/^Direct v2 route opened the fixture and returned ([1-9]\d*) historical commits\r?$/gm)];
  const baseline = output.match(/^Cliora v2 route reopened the same authenticated worktree with a checked task baseline\r?$/gm);
  const historyCommits = commits.length === 1 ? Number(commits[0][1]) : null;
  const checks = {
    directV2History: Number.isSafeInteger(historyCommits) && historyCommits > 0 ? historyCommits : null,
    clioraV2Baseline: baseline?.length === 1,
  };
  if (error || status !== 0) return { status: "failed", reason: "cargo_failed", checks };
  if (/^Skipped real SSH:/m.test(output) || /^running 0 tests\r?$/m.test(output)) {
    return { status: "skipped", reason: "rust_gate_skipped", checks };
  }
  if (tests?.length !== 1 || result?.length !== 1 || cases?.length !== 1
      || checks.directV2History === null || !checks.clioraV2Baseline) {
    return { status: "failed", reason: "missing_gate_evidence", checks };
  }
  return { status: "passed", reason: null, checks };
}

function collect() {
  const root = process.cwd();
  const cliora = resolve(process.env.TWIGLANE_VERIFY_CLIORA ?? "../cliora");
  const report = {
    format,
    scope,
    status: "skipped",
    reason: "missing_environment",
    startedAt: new Date().toISOString(),
    desktop: { platform: platformName(process.platform), architecture: architectureName(machine()) },
    source: null,
    remote: null,
    artifacts: null,
    test: { command, source: testSource, exitCode: null, checks: null },
  };
  const missing = inputs.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    report.missing = missing;
    return report;
  }

  let failure = "unsupported_desktop";
  try {
    if (!report.desktop.platform || !report.desktop.architecture) {
      throw new Error("desktop platform unavailable");
    }
    failure = "unverified_source";
    report.source = {
      twiglane: cleanRef(root, sourcePaths.twiglane),
      cliora: cleanRef(cliora, sourcePaths.cliora),
    };
    failure = "invalid_fixture";
    const { env, artifacts } = fixtureEnvironment(process.env);
    report.artifacts = artifacts;
    failure = "fixture_probe_failed";
    report.remote = probeFixture(root, env);
    failure = "cargo_failed";
    const result = run("cargo", cargoArgs, root, env);
    report.test.exitCode = result.status;
    const outcome = parseGate(result);
    report.test.checks = outcome.checks;
    failure = "source_changed";
    if (cleanRef(root, sourcePaths.twiglane) !== report.source.twiglane
        || cleanRef(cliora, sourcePaths.cliora) !== report.source.cliora) {
      throw new Error("source changed during execution");
    }
    report.status = outcome.status;
    report.reason = outcome.reason;
  } catch {
    // Child output can contain credentials or local paths. Keep a fixed
    // failure code and the exit code, without forwarding SSH or Cargo logs.
    report.status = "failed";
    report.reason = failure;
  }
  return report;
}

function main(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write(usage);
    return;
  }
  if (args[0] !== "--run" || !(args.length === 1 || (args.length === 3 && args[1] === "--output" && args[2]))) {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  const report = collect();
  report.finishedAt = new Date().toISOString();
  report.unverified = unverifiedFor(report.status, report.desktop, report.remote);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.length === 3) {
    try {
      writeFileSync(args[2], json, { flag: "wx" });
    } catch {
      process.stderr.write("Could not create the evidence file. Choose a new output path.\n");
      process.exitCode = 2;
      return;
    }
  } else {
    process.stdout.write(json);
  }
  process.exitCode = report.status === "passed" ? 0 : report.status === "skipped" ? 2 : 1;
}

if (import.meta.main) main(process.argv.slice(2));
