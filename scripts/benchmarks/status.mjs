import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Compile the actual parser sources with their DTOs, without linking the desktop
// runtime. Measure parser allocations only; this is not an application RSS test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baseline = process.argv[2] ?? "HEAD";
const read = (file) => readFileSync(path.join(root, file), "utf8");
const before = execFileSync("git", ["show", `${baseline}:src-tauri/src/git/parse.rs`], { cwd: root, encoding: "utf8", windowsHide: true });
const after = read("src-tauri/src/git/parse.rs");
const model = read("src-tauri/src/model.rs");
const start = model.lastIndexOf("#[derive", model.indexOf("pub enum ChangeKind"));
const end = model.lastIndexOf("#[derive", model.indexOf("pub struct DiffLine {"));
const plain = (source) => source.replace(/^use serde::[^;]+;\r?\n/gm, "")
  .replace(/#\[serde\([^\n]*\)\]\r?\n/g, "")
  .replace(/\bSerialize,?\s*/g, "").replace(/\bDeserialize,?\s*/g, "");
const temp = mkdtempSync(path.join(tmpdir(), "twiglane-status-bench-"));
try {
  writeFileSync(path.join(temp, "before.rs"), before);
  writeFileSync(path.join(temp, "after.rs"), after);
  writeFileSync(path.join(temp, "model.rs"), plain(model.slice(start, end)));
  writeFileSync(path.join(temp, "error.rs"), plain(read("src-tauri/src/error.rs")));
  writeFileSync(path.join(temp, "main.rs"), String.raw`
#![allow(dead_code)]
mod model;
mod error;
mod before;
mod after;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
struct Meter;
#[global_allocator]
static ALLOCATOR: Meter = Meter;
fn add(bytes: usize) {
    let live = LIVE.fetch_add(bytes, Relaxed) + bytes;
    PEAK.fetch_max(live, Relaxed);
    ALLOCS.fetch_add(1, Relaxed);
}
unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() { add(layout.size()); }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Relaxed);
        System.dealloc(ptr, layout);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let next = System.realloc(ptr, layout, size);
        if !next.is_null() { LIVE.fetch_sub(layout.size(), Relaxed); add(size); }
        next
    }
}
fn measure<T>(label: &str, mut parse: impl FnMut() -> T) {
    drop(std::hint::black_box(parse()));
    let mut samples = Vec::with_capacity(30);
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    ALLOCS.store(0, Relaxed);
    for _ in 0..30 {
        let start = std::time::Instant::now();
        drop(std::hint::black_box(parse()));
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let peak = PEAK.load(Relaxed) - base;
    let allocs = ALLOCS.load(Relaxed) / 30;
    samples.sort_by(f64::total_cmp);
    println!("{{\"case\":\"{}\",\"p50Ms\":{},\"p95Ms\":{},\"peakParserBytes\":{},\"allocationsPerParse\":{}}}", label, samples[14], samples[28], peak, allocs);
}
fn main() {
    let mut raw = String::from("# branch.oid abcdef\0# branch.head main\0");
    for index in 0..100_000 {
        raw.push_str(&format!("1 .M N... 100644 100644 100644 aaa bbb src/file-{index:06}.ts\0"));
    }
    assert_eq!(before::parse_status(raw.as_bytes()).unwrap(), after::parse_status(raw.as_bytes()).unwrap());
    assert_eq!(after::parse_status_summary(raw.as_bytes()).unwrap().changed, 100_000);
    measure("baseline-full", || before::parse_status(raw.as_bytes()).unwrap());
    measure("current-full", || after::parse_status(raw.as_bytes()).unwrap());
    measure("current-overview", || after::parse_status_summary(raw.as_bytes()).unwrap());
}
`);
  const executable = path.join(temp, process.platform === "win32" ? "bench.exe" : "bench");
  execFileSync("rustc", ["--edition=2021", "-O", path.join(temp, "main.rs"), "-o", executable], { windowsHide: true, stdio: "pipe" });
  const results = execFileSync(executable, [], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/).map(JSON.parse);
  console.log(JSON.stringify({
    platform: process.platform,
    node: process.version,
    baseline: execFileSync("git", ["rev-parse", baseline], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
    currentParserSha256: createHash("sha256").update(after).digest("hex"),
    records: 100_000,
    iterations: 30,
    scope: "Parser time and peak additional live allocations; excludes Git, IPC, WebView and input buffer",
    results,
  }, null, 2));
} finally {
  // mkdtemp supplies a unique absolute directory owned by this invocation.
  if (path.dirname(temp) !== path.resolve(tmpdir()) || !path.basename(temp).startsWith("twiglane-status-bench-")) {
    throw new Error("Unexpected benchmark temporary directory");
  }
  rmSync(temp, { recursive: true, force: true });
}
