import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const cliora = resolve(process.env.TWIGLANE_VERIFY_CLIORA ?? "../cliora");
const report = JSON.parse(readFileSync(resolve(root, "docs/verification/remote-worktrees.json"), "utf8"));
const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

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
assert.deepEqual(report.network.map(({ profile }) => profile), ["baseline", "high-rtt", "low-bw", "combined", "stress"]);
for (const sample of report.network) {
  assert.ok(sample.observedRoundTripMs > 0);
  assert.equal(sample.lists.length, 2);
  assert.ok(sample.lists[0].files < sample.lists[1].files);
  for (const list of sample.lists) {
    assert.equal(list.rpcCount, 1);
    assert.ok(list.elapsedMs > 0 && list.downBytes > 0);
  }
  assert.ok(sample.smallDiffMs > 0 && sample.smallDiffDownBytes > 0);
  assert.ok(sample.switchMs > 0 && sample.switchDownBytes > 0);
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
