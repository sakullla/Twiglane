use crate::error::AppError;
use crate::model::{BranchInfo, ChangeKind, FileChange, StatusSnapshot};

#[derive(Debug, PartialEq, Eq)]
pub enum DiffBody {
    Empty,
    Binary,
    Text(String),
}

pub fn parse_status(bytes: &[u8]) -> Result<StatusSnapshot, AppError> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        AppError::new(
            "status_encoding",
            "Git 状态包含无法安全显示的路径，已停止解析且未修改仓库。",
        )
    })?;
    let mut parts: Vec<&str> = text.split('\0').collect();
    if parts.last().is_some_and(|part| part.is_empty()) {
        parts.pop();
    }
    let mut branch = BranchInfo::default();
    let mut files = Vec::new();
    let mut index = 0;
    while index < parts.len() {
        let record = parts[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix("# ") {
            apply_header(&mut branch, header);
            continue;
        }
        if record.starts_with("2 ") {
            if index >= parts.len() {
                return Err(AppError::new(
                    "status_parse",
                    "Git 重命名记录不完整，未据此修改仓库。",
                ));
            }
            let original = parts[index];
            index += 1;
            files.push(parse_rename(record, original)?);
            continue;
        }
        if record.starts_with("1 ") {
            files.push(parse_ordinary(record)?);
            continue;
        }
        if let Some(path) = record.strip_prefix("? ") {
            files.push(FileChange {
                path: path.to_string(),
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
            files.push(parse_unmerged(record)?);
            continue;
        }
        return Err(AppError::new(
            "status_parse",
            "无法识别 Git 状态记录，未据此修改仓库。",
        ));
    }
    Ok(StatusSnapshot {
        generation: 0,
        branch,
        files,
    })
}

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
        branch.ahead = pieces.next().and_then(|piece| piece.parse().ok());
        branch.behind = pieces.next().and_then(|piece| piece.parse().ok());
    }
    branch.live_remote_checked = false;
}

fn parse_ordinary(record: &str) -> Result<FileChange, AppError> {
    let (fields, path) = split_fields(record, 8)?;
    let (staged, unstaged) = xy(fields[1])?;
    Ok(FileChange {
        path: path.to_string(),
        original_path: None,
        staged,
        unstaged,
        untracked: false,
        unmerged: staged == ChangeKind::Unmerged || unstaged == ChangeKind::Unmerged,
    })
}

fn parse_rename(record: &str, original: &str) -> Result<FileChange, AppError> {
    let (fields, path) = split_fields(record, 9)?;
    let (staged, unstaged) = xy(fields[1])?;
    Ok(FileChange {
        path: path.to_string(),
        original_path: Some(original.to_string()),
        staged,
        unstaged,
        untracked: false,
        unmerged: false,
    })
}

fn parse_unmerged(record: &str) -> Result<FileChange, AppError> {
    let (fields, path) = split_fields(record, 10)?;
    let (staged, unstaged) = xy(fields[1])?;
    Ok(FileChange {
        path: path.to_string(),
        original_path: None,
        staged,
        unstaged,
        untracked: false,
        unmerged: true,
    })
}

fn xy(value: &str) -> Result<(ChangeKind, ChangeKind), AppError> {
    let mut chars = value.chars();
    let staged = chars.next();
    let unstaged = chars.next();
    match (staged, unstaged, chars.next()) {
        (Some(staged), Some(unstaged), None) => {
            Ok((ChangeKind::from_status_char(staged), ChangeKind::from_status_char(unstaged)))
        }
        _ => Err(AppError::new(
            "status_parse",
            "Git 状态标记无法识别，未据此修改仓库。",
        )),
    }
}

fn split_fields(record: &str, count: usize) -> Result<(Vec<&str>, &str), AppError> {
    let mut rest = record;
    let mut fields = Vec::with_capacity(count);
    for _ in 0..count {
        rest = rest.trim_start();
        let Some((token, tail)) = rest.split_once(' ') else {
            return Err(AppError::new(
                "status_parse",
                "Git 状态记录缺少字段，未据此修改仓库。",
            ));
        };
        fields.push(token);
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
    fn parses_nul_status_with_spaces_and_renames() {
        let raw = "# branch.oid abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -2\x001 .M N... 100644 100644 100644 aaa bbb dir/file one.txt\x002 R. N... 100644 100644 100644 aaa bbb R50 file two.txt\0file one.txt\0? new file.txt\0";
        let status = parse_status(raw.as_bytes()).unwrap();
        assert_eq!(status.branch.name.as_deref(), Some("main"));
        assert_eq!(status.branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.branch.ahead, Some(1));
        assert_eq!(status.branch.behind, Some(-2));
        assert!(!status.branch.live_remote_checked);
        assert_eq!(status.files.len(), 3);
        assert_eq!(status.files[0].path, "dir/file one.txt");
        assert_eq!(status.files[0].unstaged, ChangeKind::Modified);
        assert_eq!(status.files[1].path, "file two.txt");
        assert_eq!(status.files[1].original_path.as_deref(), Some("file one.txt"));
        assert_eq!(status.files[1].staged, ChangeKind::Renamed);
        assert!(status.files[2].untracked);
        assert_eq!(status.files[2].path, "new file.txt");
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
