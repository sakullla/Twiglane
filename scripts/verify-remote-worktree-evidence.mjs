import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  command, format, scope, sourcePaths, testSource, unverifiedFor,
} from "./remote-worktree/verify-desktop-parity.mjs";

const root = process.cwd();
const cliora = resolve(process.env.TWIGLANE_VERIFY_CLIORA ?? "../cliora");
const report = JSON.parse(readFileSync(resolve(root, process.argv[2] ?? "docs/verification/remote-worktrees.json"), "utf8"));
const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

function verifyNativeSmoke() {
  assert.equal(report.scope, scope);
  assert.equal(report.status, "passed", "Native SSH smoke status must be passed");
  assert.equal(report.reason, null);
  const started = Date.parse(report.startedAt);
  const finished = Date.parse(report.finishedAt);
  assert.ok(Number.isFinite(started) && Number.isFinite(finished) && finished >= started);
  for (const platform of [report.desktop, report.remote]) {
    assert.ok(["linux", "macos", "windows"].includes(platform.platform));
    assert.ok(["x86_64", "aarch64"].includes(platform.architecture));
  }
  assert.equal(report.remote.probe, "authenticated-agent-hello");
  assert.equal(report.remote.authenticated, true);
  assert.equal(report.remote.samePeerAndWorktree, true);
  const sessionPlatform = { platform: report.remote.platform, architecture: report.remote.architecture };
  assert.deepEqual(report.remote.sessions, { native: sessionPlatform, cliora: sessionPlatform });
  for (const field of ["connectorSha256", "peerHelperSha256", "agentManifestSha256", "agentResourcesSha256"]) {
    assert.match(report.artifacts[field], /^[0-9a-f]{64}$/);
  }
  assert.match(report.fixture.beforeSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.fixture.afterSha256, report.fixture.beforeSha256, "Fixture inputs changed");
  assert.match(report.fixture.probeBeforeSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.fixture.probeAfterSha256, report.fixture.probeBeforeSha256, "Fixture peer changed");
  assert.equal(typeof report.fixture.legacyRequested, "boolean");
  assert.equal(report.test.command, command);
  assert.equal(report.test.source, testSource);
  assert.equal(report.test.exitCode, 0);
  assert.ok(Number.isSafeInteger(report.test.checks.directV2History) && report.test.checks.directV2History > 0);
  assert.equal(report.test.checks.clioraV2Baseline, true);
  assert.equal(report.test.checks.legacyV1ReceiptRecovery, report.fixture.legacyRequested ? "passed" : "untested");
  assert.deepEqual(report.unverified, unverifiedFor(report.status, report.desktop, report.remote));
  for (const [name, cwd] of [["twiglane", root], ["cliora", cliora]]) {
    const ref = report.source[name];
    const paths = sourcePaths[name];
    assert.match(ref, /^[0-9a-f]{40}$/);
    git(cwd, ["merge-base", "--is-ancestor", ref, "HEAD"]);
    git(cwd, ["diff", "--quiet", ref, "--", ...paths]);
    assert.equal(git(cwd, ["status", "--porcelain", "--untracked-files=all", "--", ...paths]), "");
  }
  console.log(
    `Development native SSH smoke passed (${report.desktop.platform} ${report.desktop.architecture} → ${report.remote.platform} ${report.remote.architecture}). Release UI, signatures and full parity remain untested.`,
  );
}

function verifyLegacy() {
  assert.equal(report.format, "twiglane-remote-worktree-evidence/v1");
  for (const name of ["twiglane", "cliora"]) {
    assert.match(report.source[name], /^[0-9a-f]{40}$/);
  }
  git(root, ["merge-base", "--is-ancestor", report.source.twiglane, "HEAD"]);
  git(root, ["diff", "--quiet", report.source.twiglane, "--", "src", "src-tauri", "remote-agent", ".github", "docs/integrations"]);
  assert.equal(git(cliora, ["rev-parse", "HEAD"]), report.source.cliora);
  assert.equal(git(cliora, ["status", "--porcelain", "--", "src", "src-tauri"]), "");
  for (const field of [
    "authenticatedKey", "authenticatedPassword", "ordinaryAccounts", "sameCanonicalPath", "isolatedCommit",
    "remoteAgentInstalledAndReused", "interruptedInstallRetried", "lostReceiptRecoveredExactlyOnce",
    "independentReviewBaselineAndHead",
  ]) {
    assert.equal(report.ssh[field], true, `Linux SSH verification missing: ${field}`);
  }
  const profiles = {
    baseline: { delayMs: 0, rate: null },
    "high-rtt": { delayMs: 400, rate: null },
    "low-bw": { delayMs: 0, rate: 32768 },
    combined: { delayMs: 400, rate: 32768 },
    stress: { delayMs: 900, rate: 8192 },
  };
  assert.deepEqual(report.network.map(({ profile }) => profile), Object.keys(profiles));
  for (const sample of report.network) {
    const { delayMs, rate } = profiles[sample.profile];
    assert.equal(sample.oneWayDelayMs, delayMs);
    assert.equal(sample.configuredBytesPerSec, rate);
    assert.ok(sample.observedRoundTripMs > 0 && sample.observedRoundTripMs >= 2 * delayMs,
      `${sample.profile} RTT does not demonstrate the injected delay`);
    assert.deepEqual(sample.lists.map(({ files }) => files), [5, 252]);
    for (const list of sample.lists) {
      assert.equal(list.rpcCount, 1);
      assert.ok(list.elapsedMs > 0 && list.downBytes > 0);
      if (rate) {
        assert.ok(list.elapsedMs + 1 >= 1000 * list.downBytes / rate,
          `${sample.profile} list timing is incompatible with the declared rate`);
      }
    }
    assert.ok(sample.smallDiffMs > 0 && sample.smallDiffDownBytes > 0 && sample.smallDiffDownBytes < 32 * 1024);
    assert.ok(["superseded", "one_page"].includes(sample.oldReply), "Old read must stop or return at most one page");
    assert.ok(sample.switchMs > 0 && sample.switchDownBytes > 0 && sample.switchDownBytes < 64 * 1024,
      "Switching should not transfer the old full diff");
    assert.ok(sample.sshUp > 0 && sample.sshDown > 0);
  }
  const fixturePath = "tests/fixtures/reviews/remote-protocol-v1.json";
  const fixture = readFileSync(resolve(root, fixturePath));
  assert.deepEqual(fixture, readFileSync(resolve(cliora, fixturePath)));
  assert.equal(createHash("sha256").update(fixture).digest("hex"), report.protocol.fixtureSha256);
  assert.equal(report.protocol.requests, "pass");
  assert.equal(report.protocol.events, "pass");
  assert.ok(Array.isArray(report.limitations));
  console.log("Linux SSH, write recovery, weak-network and paired-protocol evidence matches the checked-out implementation.");
}

if (report.format === format) verifyNativeSmoke();
else verifyLegacy();
