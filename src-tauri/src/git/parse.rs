use crate::error::AppError;
use crate::model::{BranchInfo, ChangeKind, FileChange, StatusSnapshot};

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub enum DiffBody {
    Empty,
    Binary,
    Text(String),
}

pub fn parse_status(bytes: &[u8]) -> Result<StatusSnapshot, AppError> {
    let mut files = Vec::new();
    let branch = visit_status(bytes, |file| {
        files.push(FileChange {
            path: file.path.to_string(),
            original_path: file.original_path.map(str::to_string),
            staged: file.staged,
            unstaged: file.unstaged,
            untracked: file.untracked,
            unmerged: file.unmerged,
            staged_lines: None,
            unstaged_lines: None,
        });
    })?;
    Ok(StatusSnapshot {
        generation: 0,
        branch,
        files,
    })
}

/// The switcher needs counts, not an owned path and FileChange for every file.
#[derive(Debug, Default)]
pub struct StatusSummary {
    pub branch: BranchInfo,
    pub changed: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
}

pub fn parse_status_summary(bytes: &[u8]) -> Result<StatusSummary, AppError> {
    let mut summary = StatusSummary::default();
    summary.branch = visit_status(bytes, |file| {
        summary.changed += 1;
        summary.staged += u32::from(file.unmerged || file.staged != ChangeKind::None);
        summary.unstaged += u32::from(
            !file.untracked && (file.unmerged || file.unstaged != ChangeKind::None),
        );
        summary.untracked += u32::from(file.untracked);
        summary.conflicted += u32::from(file.unmerged);
    })?;
    Ok(summary)
}

struct StatusFile<'a> {
    path: &'a str,
    original_path: Option<&'a str>,
    staged: ChangeKind,
    unstaged: ChangeKind,
    untracked: bool,
    unmerged: bool,
}

/// Borrow the process output and visit records without copying or indexing it.
/// Both consumers share validation, including the extra NUL record for renames.
fn visit_status(bytes: &[u8], mut visit: impl FnMut(StatusFile<'_>)) -> Result<BranchInfo, AppError> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        AppError::new(
            "status_encoding",
            "Git 状态包含无法安全显示的路径，已停止解析且未修改仓库。",
        )
    })?;
    let mut parts = text.split_terminator('\0');
    let mut branch = BranchInfo::default();
    while let Some(record) = parts.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix("# ") {
            apply_header(&mut branch, header);
            continue;
        }
        if record.starts_with("2 ") {
            let original = parts.next().ok_or_else(|| {
                AppError::new(
                    "status_parse",
                    "Git 重命名记录不完整，未据此修改仓库。",
                )
            })?;
            visit(parse_rename(record, original)?);
            continue;
        }
        if record.starts_with("1 ") {
            visit(parse_ordinary(record)?);
            continue;
        }
        if let Some(path) = record.strip_prefix("? ") {
            // `--untracked-files=all` 下列出的是文件。目录行不能成为可暂存的变更。
            if path.ends_with('/') {
                continue;
            }
            visit(StatusFile {
                path,
                original_path: None,
                staged: ChangeKind::None,
                unstaged: ChangeKind::None,
                untracked: true,
                unmerged: false,
            });
            continue;
        }
        if record.starts_with("! ") {
            continue;
        }
        if record.starts_with("u ") {
            visit(parse_unmerged(record)?);
            continue;
        }
        return Err(AppError::new(
            "status_parse",
            "无法识别 Git 状态记录，未据此修改仓库。",
        ));
    }
    Ok(branch)
}

#[cfg(test)]
pub fn classify_diff(bytes: &[u8]) -> Result<DiffBody, AppError> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        AppError::new(
            "diff_encoding",
            "差异包含无法安全显示的内容，已停止读取且未修改仓库。",
        )
    })?;
    if text.trim().is_empty() {
        return Ok(DiffBody::Empty);
    }
    let lower = text.to_ascii_lowercase();
    let binary = (lower.contains("binary files ") || lower.starts_with("binary file"))
        && !text.contains("\n@@");
    if binary {
        Ok(DiffBody::Binary)
    } else {
        Ok(DiffBody::Text(text))
    }
}

fn apply_header(branch: &mut BranchInfo, header: &str) {
    if let Some(value) = header.strip_prefix("branch.oid ") {
        if value == "(initial)" {
            branch.unborn = true;
            branch.head_oid = None;
        } else {
            branch.head_oid = Some(value.to_string());
        }
    } else if let Some(value) = header.strip_prefix("branch.head ") {
        if value == "(detached)" {
            branch.detached = true;
            branch.name = None;
        } else {
            branch.name = Some(value.to_string());
        }
    } else if let Some(value) = header.strip_prefix("branch.upstream ") {
        if !value.is_empty() {
            branch.upstream = Some(value.to_string());
        }
    } else if let Some(value) = header.strip_prefix("branch.ab ") {
        let mut pieces = value.split_whitespace();
        branch.ahead = pieces.next().and_then(parse_divergence);
        branch.behind = pieces.next().and_then(parse_divergence);
    }
    branch.live_remote_checked = false;
}

fn parse_ordinary(record: &str) -> Result<StatusFile<'_>, AppError> {
    let (fields, path) = split_fields::<8>(record)?;
    let (staged, unstaged) = xy(fields[1])?;
    Ok(StatusFile {
        path,
        original_path: None,
        staged,
        unstaged,
        untracked: false,
        unmerged: staged == ChangeKind::Unmerged || unstaged == ChangeKind::Unmerged,
    })
}

fn parse_rename<'a>(record: &'a str, original: &'a str) -> Result<StatusFile<'a>, AppError> {
    let (fields, path) = split_fields::<9>(record)?;
    let (staged, unstaged) = xy(fields[1])?;
    Ok(StatusFile {
        path,
        original_path: Some(original),
        staged,
        unstaged,
        untracked: false,
        unmerged: false,
    })
}

fn parse_unmerged(record: &str) -> Result<StatusFile<'_>, AppError> {
    let (fields, path) = split_fields::<10>(record)?;
    let (staged, unstaged) = xy(fields[1])?;
    Ok(StatusFile {
        path,
        original_path: None,
        staged,
        unstaged,
        untracked: false,
        unmerged: true,
    })
}

fn parse_divergence(token: &str) -> Option<u64> {
    let digits = token
        .strip_prefix('+')
        .or_else(|| token.strip_prefix('-'))?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn xy(value: &str) -> Result<(ChangeKind, ChangeKind), AppError> {
    let mut chars = value.chars();
    let staged = chars.next();
    let unstaged = chars.next();
    match (staged, unstaged, chars.next()) {
        (Some(staged), Some(unstaged), None) => Ok((
            ChangeKind::from_status_char(staged),
            ChangeKind::from_status_char(unstaged),
        )),
        _ => Err(AppError::new(
            "status_parse",
            "Git 状态标记无法识别，未据此修改仓库。",
        )),
    }
}

fn split_fields<const N: usize>(record: &str) -> Result<([&str; N], &str), AppError> {
    let mut rest = record;
    let mut fields = [""; N];
    for field in &mut fields {
        rest = rest.trim_start();
        let Some((token, tail)) = rest.split_once(' ') else {
            return Err(AppError::new(
                "status_parse",
                "Git 状态记录缺少字段，未据此修改仓库。",
            ));
        };
        *field = token;
        rest = tail;
    }
    let path = rest.trim_start();
    if path.is_empty() {
        return Err(AppError::new(
            "status_parse",
            "Git 状态记录缺少路径，未据此修改仓库。",
        ));
    }
    Ok((fields, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_counts_match_full_status_for_all_record_kinds() {
        let raw = concat!(
            "# branch.oid abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +3 -2\0",
            "1 MM N... 100644 100644 100644 aaa bbb both.txt\0",
            "1 .D N... 100644 100644 000000 aaa bbb deleted.txt\0",
            "2 R. N... 100644 100644 100644 aaa bbb R100 renamed.txt\0old name.txt\0",
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt\0",
            "? 新文件.txt\0? directory/\0! ignored.txt\0",
        );
        let full = parse_status(raw.as_bytes()).unwrap();
        let summary = parse_status_summary(raw.as_bytes()).unwrap();
        assert_eq!(summary.branch, full.branch);
        assert_eq!(summary.changed, full.files.len() as u32);
        assert_eq!(summary.changed, 5);
        assert_eq!(summary.staged, 3);
        assert_eq!(summary.unstaged, 3);
        assert_eq!(summary.untracked, 1);
        assert_eq!(summary.conflicted, 1);
        assert_eq!(parse_status_summary(b"").unwrap().changed, 0);
    }

    #[test]
    fn summary_rejects_the_same_malformed_input_as_full_status() {
        for bytes in [
            &b"? invalid-\xff\0"[..],
            &b"2 R. N... 100644 100644 100644 aaa bbb R100 name\0"[..],
            &b"1 missing-fields\0"[..],
            &b"1 X N... 100644 100644 100644 aaa bbb name\0"[..],
            &b"unexpected\0"[..],
        ] {
            assert_eq!(
                parse_status_summary(bytes).unwrap_err(),
                parse_status(bytes).unwrap_err(),
            );
        }
    }

    #[test]
    fn parses_nul_status_with_spaces_and_renames() {
        let raw = "# branch.oid abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -2\x001 .M N... 100644 100644 100644 aaa bbb dir/file one.txt\x002 R. N... 100644 100644 100644 aaa bbb R50 file two.txt\0file one.txt\0? new file.txt\0";
        let status = parse_status(raw.as_bytes()).unwrap();
        assert_eq!(status.branch.name.as_deref(), Some("main"));
        assert_eq!(status.branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.branch.ahead, Some(1));
        assert_eq!(status.branch.behind, Some(2));
        assert!(!status.branch.live_remote_checked);
        assert_eq!(status.files.len(), 3);
        assert_eq!(status.files[0].path, "dir/file one.txt");
        assert_eq!(status.files[0].unstaged, ChangeKind::Modified);
        assert_eq!(status.files[1].path, "file two.txt");
        assert_eq!(
            status.files[1].original_path.as_deref(),
            Some("file one.txt")
        );
        assert_eq!(status.files[1].staged, ChangeKind::Renamed);
        assert!(status.files[2].untracked);
        assert_eq!(status.files[2].path, "new file.txt");
    }

    #[test]
    fn branch_ab_signs_are_directions() {
        let diverged = parse_status(b"# branch.ab +1 -1\0").unwrap();
        assert_eq!(diverged.branch.ahead, Some(1));
        assert_eq!(diverged.branch.behind, Some(1));
        let level = parse_status(b"# branch.ab +0 -0\0").unwrap();
        assert_eq!(level.branch.ahead, Some(0));
        assert_eq!(level.branch.behind, Some(0));
        let broken = parse_status(b"# branch.ab +\0").unwrap();
        assert_eq!(broken.branch.ahead, None);
        assert_eq!(broken.branch.behind, None);
    }

    #[test]
    fn parses_unborn_and_detached_headers() {
        let unborn = parse_status(b"# branch.oid (initial)\0# branch.head main\0").unwrap();
        assert!(unborn.branch.unborn);
        assert_eq!(unborn.branch.name.as_deref(), Some("main"));
        let detached = parse_status(b"# branch.oid abc\0# branch.head (detached)\0").unwrap();
        assert!(detached.branch.detached);
        assert_eq!(detached.branch.head_oid.as_deref(), Some("abc"));
    }

    #[test]
    fn classifies_binary_without_treating_it_as_text() {
        let body = classify_diff(b"Binary files a/data.bin and b/data.bin differ\n").unwrap();
        assert_eq!(body, DiffBody::Binary);
        let text = classify_diff(b"diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-a\n+b\n").unwrap();
        assert!(matches!(text, DiffBody::Text(_)));
    }
}
