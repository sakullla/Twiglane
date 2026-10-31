import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FIXTURE_SEED, FIXTURES } from "./delivery-lib.mjs";

export function filePath(index) {
  const bucket = String(Math.floor(index / 100)).padStart(4, "0");
  return `files/${bucket}/${String(index).padStart(6, "0")}.txt`;
}

export function fileBytes(seed, index, size) {
  const header = Buffer.from(`${seed}:${index}\n`);
  const bytes = Buffer.alloc(size, 97 + (index % 26));
  header.copy(bytes, 0, 0, Math.min(header.length, size - 1));
  bytes[size - 1] = 10;
  return bytes;
}

function git(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(Buffer.concat(err).toString() || `git ${args.join(" ")} 失败`));
      else resolve(Buffer.concat(out).toString());
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function onceDrain(stream) {
  return new Promise((resolve) => stream.once("drain", resolve));
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) await onceDrain(stream);
}

async function streamImport(repo, plan, seed) {
  const per = plan.files / plan.commits;
  if (!Number.isInteger(per)) throw new Error("文件数必须能被提交数整除");
  const child = spawn("git", ["fast-import", "--quiet", "--done"], { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const finished = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr || "fast-import 失败"))));
  });
  const author = "Twiglane Fixture <fixture@twiglane.invalid>";
  let fileIndex = 0;
  for (let commit = 0; commit < plan.commits; commit += 1) {
    const message = `fixture ${seed} ${commit}\n`;
    let header = `commit refs/heads/main\n`;
    header += `mark :${commit + 1}\n`;
    header += `author ${author} ${1700000000 + commit} +0000\n`;
    header += `committer ${author} ${1700000000 + commit} +0000\n`;
    header += `data ${Buffer.byteLength(message)}\n${message}`;
    if (commit > 0) header += `from :${commit}\n`;
    await writeChunk(child.stdin, header);
    for (let offset = 0; offset < per; offset += 1) {
      const body = fileBytes(seed, fileIndex, plan.fileBytes);
      const relative = filePath(fileIndex);
      fileIndex += 1;
      await writeChunk(child.stdin, `M 100644 inline ${relative}\ndata ${body.length}\n`);
      await writeChunk(child.stdin, body);
      await writeChunk(child.stdin, "\n");
    }
    if (commit === plan.commits - 1 && plan.textBytes > 0) {
      const text = Buffer.alloc(plan.textBytes, 97);
      text[0] = 84;
      text[text.length - 1] = 10;
      await writeChunk(child.stdin, `M 100644 inline bulk/text-10mib.txt\ndata ${text.length}\n`);
      await writeChunk(child.stdin, text);
      await writeChunk(child.stdin, "\n");
    }
    if (commit === plan.commits - 1 && plan.binaryBytes > 0) {
      const binary = Buffer.alloc(plan.binaryBytes, 0);
      binary[1] = 1;
      binary[binary.length - 1] = 2;
      await writeChunk(child.stdin, `M 100644 inline bulk/binary-100mib.bin\ndata ${binary.length}\n`);
      await writeChunk(child.stdin, binary);
      await writeChunk(child.stdin, "\n");
    }
  }
  child.stdin.end("done\n");
  await finished;
}

async function verifyRepo(repo, plan, seed) {
  const commits = Number((await git(repo, ["rev-list", "--count", "HEAD"])).trim());
  const files = (await git(repo, ["ls-files"])).split("\n").filter(Boolean);
  const status = (await git(repo, ["status", "--porcelain"])).split("\n").filter(Boolean);
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const sample = readFileSync(path.join(repo, filePath(0)));
  const expectedFiles = plan.files + (plan.textBytes > 0 ? 1 : 0) + (plan.binaryBytes > 0 ? 1 : 0);
  if (commits !== plan.commits) throw new Error(`提交数是 ${commits}，不是 ${plan.commits}`);
  if (files.length !== expectedFiles) throw new Error(`文件数是 ${files.length}，不是 ${expectedFiles}`);
  if (status.length !== plan.modifications) throw new Error(`改动数是 ${status.length}，不是 ${plan.modifications}`);
  if (sample.length !== plan.fileBytes) throw new Error("样例文件大小不对");
  if (plan.textBytes > 0 && statSync(path.join(repo, "bulk/text-10mib.txt")).size !== plan.textBytes) {
    throw new Error("10 MiB 文本大小不对");
  }
  if (plan.binaryBytes > 0 && statSync(path.join(repo, "bulk/binary-100mib.bin")).size !== plan.binaryBytes) {
    throw new Error("100 MiB 二进制大小不对");
  }
  const diffNames = (await git(repo, ["diff", "--name-only"])).split("\n").filter(Boolean);
  if (diffNames.length !== plan.modifications) throw new Error("工作区差异数量与声明不一致");
  const countObjects = await git(repo, ["count-objects", "-v"]);
  return {
    seed,
    commits,
    files: files.length,
    modifications: status.length,
    head,
    sampleBytes: sample.length,
    textBytes: plan.textBytes,
    binaryBytes: plan.binaryBytes,
    countObjects: countObjects.trim(),
    verified: true,
  };
}

export async function generateFixture({ dest, size, seed = FIXTURE_SEED, plan }) {
  const selected = plan ?? FIXTURES[size];
  if (!selected) throw new Error(`未知仓库规模 ${size}`);
  const resolved = path.resolve(dest);
  if (resolved === path.resolve(process.cwd())) throw new Error("不能在仓库根目录生成夹具");
  rmSync(resolved, { recursive: true, force: true });
  const repo = path.join(resolved, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await git(repo, ["config", "core.safecrlf", "false"]);
  await git(repo, ["config", "user.name", "Twiglane Fixture"]);
  await git(repo, ["config", "user.email", "fixture@twiglane.invalid"]);
  await streamImport(repo, selected, seed);
  await git(repo, ["checkout", "-f", "main"]);
  for (let index = 0; index < selected.modifications; index += 1) {
    const absolute = path.join(repo, filePath(index));
    const bytes = readFileSync(absolute);
    bytes[bytes.length - 2] = bytes[bytes.length - 2] === 88 ? 89 : 88;
    writeFileSync(absolute, bytes);
  }
  const manifest = await verifyRepo(repo, selected, seed);
  manifest.size = size;
  writeFileSync(path.join(resolved, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...manifest, repo };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] ?? "";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const size = argument("--size");
  const dest = argument("--dest");
  if (!FIXTURES[size] || !dest) {
    console.error("用法: node scripts/generate-fixture.mjs --size S|M|L --dest <目录>");
    process.exit(2);
  }
  const manifest = await generateFixture({ dest, size });
  console.log(`${size} 已生成 ${manifest.repo} head ${manifest.head} files ${manifest.files} commits ${manifest.commits} changes ${manifest.modifications}`);
}
