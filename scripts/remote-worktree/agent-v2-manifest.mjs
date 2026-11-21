#!/usr/bin/env node
/**
 * 生成或核对 agent v2 产物清单（docs/integrations/remote-worktree.md 的「远端组件 v2 的安装」）。
 *
 * 每个远端目标一份原生二进制，因此清单必须逐目标登记摘要与签名：
 *   <目录>/Linux-x86_64/twiglane-agent-v2      产物
 *   <目录>/Linux-x86_64/twiglane-agent-v2.sig  发布签名（minisign，tauri signer 生成）
 *
 * 用法：
 *   node scripts/remote-worktree/agent-v2-manifest.mjs --write <目录> [--version 0.3.40]
 *   node scripts/remote-worktree/agent-v2-manifest.mjs --check <目录>
 *
 * 退出码：0 一致；1 缺少产物/签名或摘要不一致（清单不会被写坏）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "twiglane-agent-v2";
const SIGNATURE = "twiglane-agent-v2.sig";
const MANIFEST = "manifest.json";
const FORMAT = 1;
/** 目录名 → 清单里的 system/architecture。与原生归一化保持一致。 */
const TARGETS = [
  ["Linux-x86_64", "Linux", "x86_64"],
  ["Linux-aarch64", "Linux", "aarch64"],
  ["macOS-x86_64", "macOS", "x86_64"],
  ["macOS-aarch64", "macOS", "aarch64"],
];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function defaultVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

function parseArgs(argv) {
  const action = argv[0];
  const dir = argv[1];
  let version = defaultVersion();
  const index = argv.indexOf("--version");
  if (index > 0 && argv[index + 1]) version = argv[index + 1];
  if (!["--write", "--check"].includes(action) || !dir) {
    console.error("用法：agent-v2-manifest.mjs --write|--check <产物目录> [--version x.y.z]");
    process.exit(2);
  }
  if (!/^[0-9A-Za-z.+-]{1,32}$/.test(version)) {
    console.error("版本号只允许数字、字母与 . + -");
    process.exit(2);
  }
  return { action, dir, version };
}

function collect(dir) {
  const artifacts = [];
  for (const [folder, system, architecture] of TARGETS) {
    const file = join(dir, folder, FILE);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const bytes = readFileSync(file);
    const signaturePath = join(dir, folder, SIGNATURE);
    const signature = existsSync(signaturePath) ? readFileSync(signaturePath, "utf8").trim() : "";
    artifacts.push({
      system,
      architecture,
      file: `${folder}/${FILE}`,
      sha256: digest(bytes),
      signature,
      size: bytes.length,
    });
  }
  return artifacts;
}

function write(dir, version) {
  const artifacts = collect(dir);
  if (artifacts.length === 0) {
    console.error(`没有找到任何 ${FILE} 产物；清单不会写入。`);
    process.exit(1);
  }
  const missing = artifacts.filter((item) => item.signature.length === 0 || item.signature.length > 4096);
  if (missing.length > 0) {
    for (const item of missing) {
      console.error(`${item.file} 缺少 ${SIGNATURE} 或签名长度异常，清单不会写入。`);
    }
    process.exit(1);
  }
  const manifest = {
    format: FORMAT,
    artifacts: artifacts.map(({ size, ...entry }) => ({ ...entry, version })),
  };
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const item of artifacts) {
    console.log(`ok ${item.system}/${item.architecture} ${item.sha256} ${item.size} 字节`);
  }
  return 0;
}

function check(dir) {
  const path = join(dir, MANIFEST);
  if (!existsSync(path)) {
    console.error(`缺少 ${MANIFEST}；请先用 --write 生成。`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.format !== FORMAT || !Array.isArray(manifest.artifacts)) {
    console.error("清单格式无效。");
    return 1;
  }
  let failed = 0;
  for (const entry of manifest.artifacts) {
    const file = join(dir, entry.file);
    if (typeof entry.file !== "string" || entry.file.includes("..") || !existsSync(file)) {
      console.error(`${entry.system}/${entry.architecture}: 缺少产物文件`);
      failed += 1;
      continue;
    }
    const bytes = readFileSync(file);
    if (digest(bytes) !== String(entry.sha256).toLowerCase()) {
      console.error(`${entry.system}/${entry.architecture}: 摘要与清单不一致`);
      failed += 1;
      continue;
    }
    if (typeof entry.signature !== "string" || entry.signature.trim().length === 0) {
      console.error(`${entry.system}/${entry.architecture}: 清单里没有签名`);
      failed += 1;
      continue;
    }
    console.log(`ok ${entry.system}/${entry.architecture} v${entry.version}`);
  }
  return failed === 0 ? 0 : 1;
}

const { action, dir, version } = parseArgs(process.argv.slice(2));
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`产物目录不存在：${dir}`);
  process.exit(2);
}
process.exit(action === "--write" ? write(dir, version) : check(dir));
