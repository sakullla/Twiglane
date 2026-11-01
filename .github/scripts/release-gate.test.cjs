const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateVersion, waitForMainCi } = require("./release-gate.cjs");

const success = { id: 1, head_sha: "commit", head_branch: "main", event: "push",
  status: "completed", conclusion: "success", html_url: "https://example.com/run/1" };

function fixture(pages, status = "identical") {
  let calls = 0;
  return {
    repo: { owner: "owner", repo: "repo" }, sha: "commit", attempts: pages.length,
    log() {}, async sleep() {},
    github: { rest: {
      actions: { async listWorkflowRuns(request) {
        assert.equal(request.workflow_id, "ci.yml");
        assert.equal(request.branch, "main");
        assert.equal(request.head_sha, "commit");
        return { data: { workflow_runs: pages[calls++] } };
      } },
      repos: { async compareCommitsWithBasehead() { return { data: { status } }; } },
    } },
  };
}

test("accepts the exact main commit only after CI completes", async () => {
  const result = await waitForMainCi(fixture([[], [{ ...success, status: "in_progress" }], [success]]));
  assert.equal(result.id, 1);
});

test("rejects failed, cancelled and skipped CI", async () => {
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"]) {
    await assert.rejects(waitForMainCi(fixture([[{ ...success, conclusion }]])), /did not succeed/);
  }
});

test("does not accept another commit, a PR, or a different branch", async () => {
  for (const overrides of [{ head_sha: "other" }, { event: "pull_request" }, { head_branch: "feature" }]) {
    await assert.rejects(waitForMainCi(fixture([[{ ...success, ...overrides }]])), /Timed out/);
  }
});

test("a newer unsuccessful run overrides an older success", async () => {
  await assert.rejects(waitForMainCi(fixture([[success, { ...success, id: 2, conclusion: "failure" }]])), /did not succeed/);
});

test("requires the tested commit to remain on main", async () => {
  await assert.rejects(waitForMainCi(fixture([[success]], "diverged")), /no longer on main/);
  assert.equal((await waitForMainCi(fixture([[success]], "ahead"))).id, 1);
});

test("requires a stable tag matching all project versions", () => {
  const version = require("../../package.json").version;
  validateVersion(`v${version}`);
  assert.throws(() => validateVersion("v9999.0.0"), /does not match/);
  assert.throws(() => validateVersion(`v${version}-rc.1`), /vMAJOR/);
});
