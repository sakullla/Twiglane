const { readFileSync } = require("node:fs");

function validateVersion(tag, root = ".") {
  const version = tag.replace(/^v/, "");
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error("Release tags must use vMAJOR.MINOR.PATCH.");
  }
  const json = (path) => JSON.parse(readFileSync(`${root}/${path}`, "utf8"));
  const cargo = readFileSync(`${root}/src-tauri/Cargo.toml`, "utf8")
    .split("[package]")[1]?.split(/\n\[/)[0]
    .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const cargoLock = readFileSync(`${root}/src-tauri/Cargo.lock`, "utf8")
    .split("[[package]]").find((entry) => /^name = "twiglane"$/m.test(entry))
    ?.match(/^version = "([^"]+)"/m)?.[1];
  const versions = [
    json("package.json").version,
    json("package-lock.json").version,
    json("package-lock.json").packages[""].version,
    json("src-tauri/tauri.conf.json").version,
    cargo,
    cargoLock,
  ];
  if (versions.some((value) => value !== version)) {
    throw new Error(`Tag ${tag} does not match all package versions: ${versions.join(", ")}`);
  }
}

async function waitForMainCi({ github, repo, sha, log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 120 }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...repo, workflow_id: "ci.yml", branch: "main", event: "push", head_sha: sha, per_page: 100,
    });
    // Never accept a PR run, a different commit, or an older successful run
    // while a newer run for this same commit is pending or has failed.
    const run = data.workflow_runs
      .filter((item) => item.head_sha === sha && item.head_branch === "main" && item.event === "push")
      .sort((a, b) => b.id - a.id)[0];
    if (run?.status === "completed") {
      if (run.conclusion !== "success") {
        throw new Error(`Main CI did not succeed (${run.conclusion}): ${run.html_url}`);
      }
      const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
        ...repo, basehead: `${sha}...main`,
      });
      if (!["ahead", "identical"].includes(comparison.status)) {
        throw new Error(`Release commit ${sha} is no longer on main.`);
      }
      log(`Main CI passed for ${sha}: ${run.html_url}`);
      return run;
    }
    log(`Waiting for main CI for ${sha} (${attempt + 1}/${attempts})`);
    if (attempt + 1 < attempts) await sleep(15_000);
  }
  throw new Error(`Timed out waiting for main CI for ${sha}; rerun release after CI succeeds.`);
}

module.exports = { validateVersion, waitForMainCi };
