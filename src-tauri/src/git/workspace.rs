//! 工作区里的文件级便捷动作：在系统文件管理器中显示、用默认程序打开、加入 .gitignore。
//!
//! 约束与其它写操作一致：
//! - 路径只接受仓库内的相对路径（不含 `..`、绝对路径或控制字符），解析后必须仍在仓库根目录下；
//! - 打开外部程序不经过 shell，参数逐个传入（Windows `explorer.exe`、macOS `open`、Linux `xdg-open`）；
//! - 改写 .gitignore 走仓库写锁，完成后 generation 递增，过期的响应照常被拒绝；
//!   写入用临时文件替换，原文件末尾缺换行时先补一个，已存在的同一条规则不重复追加。

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::atomic::atomic_write;
use crate::error::AppError;
use crate::git::ops::{canonical_existing, repo_key, safe_relative, validate_input_path, Backend};

const MAX_PATTERN_LEN: usize = 1024;

fn repo_root(path: &str) -> Result<PathBuf, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    if !root.join(".git").exists() {
        return Err(AppError::new(
            "not_repository",
            "该目录不是 Git 仓库，未执行此操作。",
        ));
    }
    Ok(root)
}

/// 仓库内的目标：文件已被删除时退回到仍存在的最近一级目录。
fn resolve_inside(root: &Path, relative: &str) -> Result<(PathBuf, bool), AppError> {
    let relative = if relative.is_empty() {
        PathBuf::new()
    } else {
        safe_relative(relative)?
    };
    let mut candidate = root.join(&relative);
    let mut exact = true;
    while !candidate.exists() {
        exact = false;
        if !candidate.pop() || !candidate.starts_with(root) {
            candidate = root.to_path_buf();
            break;
        }
    }
    let resolved = canonical_existing(&candidate)?;
    if !resolved.starts_with(root) {
        return Err(AppError::new(
            "invalid_path",
            "只能打开仓库内部的文件，未执行。",
        ));
    }
    Ok((resolved, exact))
}

fn spawn(program: &str, args: &[&std::ffi::OsStr]) -> Result<(), AppError> {
    Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            AppError::new(
                "open_failed",
                format!(
                    "没有打开系统程序：{}",
                    crate::redact::redact_error_text(&error.to_string())
                ),
            )
        })
}

/// 在系统文件管理器里显示（并选中）仓库内的文件；文件已删除时打开它所在的目录。
pub fn reveal_path(path: &str, relative: &str) -> Result<(), AppError> {
    let root = repo_root(path)?;
    let (target, exact) = resolve_inside(&root, relative)?;
    let target = target.as_os_str();
    if cfg!(target_os = "windows") {
        if exact {
            // explorer 的 /select, 与路径必须拼成一个参数。
            let mut arg = std::ffi::OsString::from("/select,");
            arg.push(target);
            spawn("explorer.exe", &[arg.as_os_str()])
        } else {
            spawn("explorer.exe", &[target])
        }
    } else if cfg!(target_os = "macos") {
        if exact {
            spawn("open", &[std::ffi::OsStr::new("-R"), target])
        } else {
            spawn("open", &[target])
        }
    } else {
        let folder = if exact {
            Path::new(target)
                .parent()
                .map(Path::as_os_str)
                .unwrap_or(target)
        } else {
            target
        };
        spawn("xdg-open", &[folder])
    }
}

/// 用系统默认程序打开仓库内的文件。文件不存在时不打开任何东西。
pub fn open_path(path: &str, relative: &str) -> Result<(), AppError> {
    let root = repo_root(path)?;
    let (target, exact) = resolve_inside(&root, relative)?;
    if !exact {
        return Err(AppError::new(
            "path_missing",
            "文件已不在工作区（可能已删除），未打开。",
        ));
    }
    let target = target.as_os_str();
    if cfg!(target_os = "windows") {
        spawn("explorer.exe", &[target])
    } else if cfg!(target_os = "macos") {
        spawn("open", &[target])
    } else {
        spawn("xdg-open", &[target])
    }
}

/// .gitignore 规则的最小校验：单行、非空、不含控制字符、不以 `!`/`#` 开头、不跳出仓库。
pub fn validate_ignore_pattern(pattern: &str) -> Result<String, AppError> {
    let trimmed = pattern.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_PATTERN_LEN
        || trimmed.starts_with('!')
        || trimmed.starts_with('#')
        || trimmed.chars().any(|character| character.is_control())
        || trimmed.split('/').any(|part| part == "..")
    {
        return Err(AppError::new(
            "ignore_invalid",
            "忽略规则无效，未修改 .gitignore。",
        ));
    }
    Ok(trimmed.to_string())
}

/// 把规则追加到 .gitignore 末尾后的完整内容；已有同一条规则时返回 None（不重复写）。
pub fn append_ignore_rule(existing: &str, pattern: &str) -> Option<String> {
    if existing.lines().any(|line| line.trim() == pattern) {
        return None;
    }
    let newline = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut next = existing.to_string();
    if !next.is_empty() && !next.ends_with('\n') {
        next.push_str(newline);
    }
    next.push_str(pattern);
    next.push_str(newline);
    Some(next)
}

/// 把规则加入仓库根目录的 .gitignore；返回写入后的 generation（调用方随后刷新状态）。
pub async fn ignore_path(
    backend: &Backend,
    path: &str,
    pattern: &str,
    generation: u64,
    request_id: u64,
) -> Result<u64, AppError> {
    let root = repo_root(path)?;
    let pattern = validate_ignore_pattern(pattern)?;
    let target = root.join(".gitignore");
    if target
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
    {
        return Err(AppError::new(
            "ignore_link",
            ".gitignore 是符号链接，未改写。",
        ));
    }
    let mut guard = backend
        .scheduler
        .lock_write(&repo_key(&root), request_id, generation)
        .await?;
    let existing = match std::fs::read(&target) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| {
            AppError::new("ignore_encoding", ".gitignore 不是 UTF-8 文本，未改写。")
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => {
            return Err(AppError::new(
                "ignore_read",
                "无法读取 .gitignore，未改写。",
            ));
        }
    };
    if let Some(next) = append_ignore_rule(&existing, &pattern) {
        atomic_write(&target, next.as_bytes()).map_err(|_| {
            AppError::new("ignore_write", "无法写入 .gitignore，原文件保持不变。")
        })?;
        guard.mark_written();
    }
    Ok(guard.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignore_rules_are_single_line_and_not_negations() {
        assert_eq!(validate_ignore_pattern("  /build/  ").unwrap(), "/build/");
        assert_eq!(validate_ignore_pattern("*.log").unwrap(), "*.log");
        for bad in [
            "",
            "   ",
            "!keep.txt",
            "# comment",
            "a\nb",
            "../outside",
            "a/../../b",
            "x\u{0}y",
        ] {
            assert_eq!(
                validate_ignore_pattern(bad).unwrap_err().code,
                "ignore_invalid",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn appending_keeps_existing_content_and_line_endings() {
        assert_eq!(append_ignore_rule("", "*.log").as_deref(), Some("*.log\n"));
        assert_eq!(
            append_ignore_rule("dist", "*.log").as_deref(),
            Some("dist\n*.log\n")
        );
        assert_eq!(
            append_ignore_rule("dist\r\n", "*.log").as_deref(),
            Some("dist\r\n*.log\r\n")
        );
        assert_eq!(append_ignore_rule("dist\n*.log\n", "*.log"), None);
    }

    #[test]
    fn targets_must_stay_inside_the_repository() {
        let temp = std::env::temp_dir().join(format!("twiglane-ws-{}", std::process::id()));
        std::fs::create_dir_all(temp.join("src")).unwrap();
        std::fs::write(temp.join("src/a.txt"), "x").unwrap();
        let root = canonical_existing(&temp).unwrap();
        let (found, exact) = resolve_inside(&root, "src/a.txt").unwrap();
        assert!(exact && found.ends_with("a.txt"));
        let (fallback, exact) = resolve_inside(&root, "src/gone/b.txt").unwrap();
        assert!(!exact && fallback.ends_with("src"));
        assert!(resolve_inside(&root, "../escape").is_err());
        let _ = std::fs::remove_dir_all(&temp);
    }
}
