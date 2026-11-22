#!/usr/bin/env node
/**
 * 生成或核对已签名的远端组件。发行使用 --require-all，开发夹具可只提供本机目标。
 * node scripts/remote-worktree/agent-v2-manifest.mjs --write|--check <目录> [--version x.y.z] [--require-all]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const MANIFEST = "manifest.json";
const FORMAT = 1;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_GZIP_BYTES = MAX_ARTIFACT_BYTES + 64 * 1024;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;

const TARGETS = [
  ["Linux-x86_64", "Linux", "x86_64"],
  ["Linux-aarch64", "Linux", "aarch64"],
  ["macOS-x86_64", "macOS", "x86_64"],
  ["macOS-aarch64", "macOS", "aarch64"],
  ["Windows-x86_64", "Windows", "x86_64"],
];

function collect(dir, requireAll) {
  const artifacts = [];
  for (const [folder, system, architecture] of TARGETS) {
    const name = system === "Windows" ? "twiglane-agent-v2.exe" : "twiglane-agent-v2";
    const raw = `${folder}/${name}`;
    // A loose Mach-O resource is re-signed when signing the Mac desktop app.
    // The gzip resource keeps the already signed remote binary byte-for-byte.
    const wrapped = system === "macOS" && (requireAll || existsSync(join(dir, `${raw}.gz`)));
    if (wrapped && existsSync(join(dir, raw))) {
      throw new Error(`发行资源中不能包含未封装的 macOS 组件 ${raw}`);
    }
    const relative = wrapped ? `${raw}.gz` : raw;
    const file = join(dir, relative);
    if (!existsSync(file)) {
      if (requireAll) throw new Error(`缺少远端组件 ${relative}`);
      continue;
    }
    const stat = statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > (wrapped ? MAX_GZIP_BYTES : MAX_ARTIFACT_BYTES)) {
      throw new Error(`远端组件文件大小异常 ${relative}`);
    }
    const resource = readFileSync(file);
    const bytes = wrapped ? gunzipSync(resource, { maxOutputLength: MAX_ARTIFACT_BYTES }) : resource;
    if (bytes.length === 0) throw new Error(`远端组件内容为空 ${relative}`);
    const signature = readSignature(`${file}.sig`, true);
    const digestSignature = readSignature(`${file}.digest.sig`, requireAll);
    artifacts.push({
      system,
      architecture,
      file: relative,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(wrapped ? { resourceSha256: createHash("sha256").update(resource).digest("hex") } : {}),
      signature,
      ...(digestSignature ? { digestSignature } : {}),
    });
  }
  if (artifacts.length === 0) throw new Error("没有找到远端组件");
  return artifacts;
}

function readSignature(path, required) {
  if (!required && !existsSync(path)) return undefined;
  const signature = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (signature.length > 4096 || !SIGNATURE.test(signature)) {
    throw new Error(`${path} 缺少有效的签名文件`);
  }
  return signature;
}

function write(dir, version, requireAll) {
  const artifacts = collect(dir, requireAll).map((entry) => ({ ...entry, version }));
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify({ format: FORMAT, artifacts }, null, 2)}\n`);
}

function check(dir, requireAll, version) {
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  const available = collect(dir, requireAll);
  if (manifest?.format !== FORMAT || !Array.isArray(manifest.artifacts) ||
      manifest.artifacts.length !== available.length) {
    throw new Error("远端组件清单格式或条目数量不符");
  }
  const byTarget = new Map(available.map((entry) => [`${entry.system}/${entry.architecture}`, entry]));
  for (const entry of manifest.artifacts) {
    const target = `${entry?.system}/${entry?.architecture}`;
    const actual = byTarget.get(target);
    if (!actual || actual.file !== entry.file || actual.sha256 !== entry.sha256 ||
        actual.resourceSha256 !== entry.resourceSha256 ||
        actual.signature !== entry.signature || actual.digestSignature !== entry.digestSignature ||
        typeof entry.version !== "string" ||
        !VERSION.test(entry.version) || (version !== undefined && entry.version !== version)) {
      throw new Error(`远端组件 ${target} 的路径、摘要、签名或版本与清单不一致`);
    }
    byTarget.delete(target);
    console.log(`ok ${target} v${entry.version}`);
  }
}

const [action, dir, ...options] = process.argv.slice(2);
if (!["--write", "--check"].includes(action) || !dir) {
  console.error("用法：agent-v2-manifest.mjs --write|--check <目录> [--version x.y.z] [--require-all]");
  process.exit(2);
}

const requireAll = options.includes("--require-all");
const versionOption = options.indexOf("--version");
const version = versionOption >= 0 ? options[versionOption + 1] : undefined;
if (versionOption >= 0 && (version === undefined || !VERSION.test(version))) {
  console.error("版本号只允许数字、字母与 . + -");
  process.exit(2);
}
try {
  if (action === "--write") {
    const defaultVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    write(dir, version ?? defaultVersion, requireAll);
  } else {
    check(dir, requireAll, version);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
