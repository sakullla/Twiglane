use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

use serde_json::Value;

static STARTED: OnceLock<Instant> = OnceLock::new();

pub fn mark_process_start() {
    let _ = STARTED.set(Instant::now());
}

pub fn elapsed_ms() -> u128 {
    STARTED
        .get()
        .map(|start| start.elapsed().as_millis())
        .unwrap_or(0)
}

pub fn directory() -> Option<PathBuf> {
    let raw = std::env::var_os("TWIGLANE_MEASURE_DIR")?;
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return None;
    }
    let canonical = fs::canonicalize(&path).ok()?;
    if !canonical.is_dir() {
        return None;
    }
    Some(canonical)
}

fn inside(dir: &Path, path: &Path) -> bool {
    path.starts_with(dir)
}

pub fn load_script() -> Result<Option<Value>, String> {
    let Some(dir) = directory() else {
        return Ok(None);
    };
    let path = dir.join("script.json");
    if !inside(&dir, &path) {
        return Err("测量脚本路径无效".into());
    }
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    Ok(Some(value))
}

pub fn append_sample(name: &str, detail: &Value) -> Result<(), String> {
    let Some(dir) = directory() else {
        return Err("测量目录不可用".into());
    };
    let path = dir.join("samples.jsonl");
    if !inside(&dir, &path) {
        return Err("测量样本路径无效".into());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    let line = serde_json::json!({
        "name": name,
        "elapsedMs": elapsed_ms(),
        "pid": std::process::id(),
        "detail": detail,
    });
    writeln!(file, "{line}").map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())?;
    Ok(())
}
