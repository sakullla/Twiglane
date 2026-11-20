import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const output = process.env.GITHUB_ENV;
if (!output || !process.env.TAURI_SIGNING_PRIVATE_KEY) {
  throw new Error("The remote agent release requires the Tauri updater signing key.");
}
const digest = createHash("sha256").update(readFileSync("remote-agent/agent")).digest("hex");
const directory = mkdtempSync(join(tmpdir(), "twiglane-agent-sign-"));
try {
  const manifest = join(directory, "twiglane-remote-agent.txt");
  writeFileSync(manifest, `twiglane-agent-v1 sha256:${digest}\n`);
  const cli = require.resolve("@tauri-apps/cli/tauri.js");
  const signed = spawnSync(process.execPath, [cli, "signer", "sign", manifest], { stdio: "ignore" });
  if (signed.status !== 0) throw new Error("Could not sign the remote agent.");
  const signature = readFileSync(`${manifest}.sig`, "utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new Error("Unexpected remote agent signature format.");
  }
  appendFileSync(output, `TWIGLANE_REMOTE_AGENT_SIGNATURE=${signature}\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
