import { spawnSync } from "node:child_process";

// 专用入口：普通 npm test / cargo test 不会执行规模压力用例。
const args = new Set(process.argv.slice(2));
function run(program, argv) {
  const result = spawnSync(program, argv, { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!args.has("--git")) {
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "scripts/performance/vitest.config.ts"]);
}
if (!args.has("--ui")) {
  run("cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--features", "performance-tests", "performance_tests::", "--", "--nocapture", "--test-threads=1"]);
}
