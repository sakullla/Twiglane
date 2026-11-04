use std::collections::HashMap;

use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::model::{ChangeKind, CommitFileChange, DiffHunk, DiffLine, FileChange, LineStat};

pub const DIFF_PREVIEW_BYTES: usize = 2 * 1024 * 1024;
pub const DIFF_VIEW_LINE_LIMIT: u32 = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHunk {
    pub index: u32,
    pub header: String,
    pub raw: String,
    pub complete: bool,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiff {
    pub binary: bool,
    pub undecodable: bool,
    pub preamble: String,
    pub hunks: Vec<ParsedHunk>,
    pub additions: u64,
    pub deletions: u64,
    pub truncated: bool,
}

pub fn snapshot_token(raw: &[u8], truncated: bool, path: &str, staged: bool) -> String {
    let mut hasher = Sha256::new();
    hasher.update([u8::from(truncated), u8::from(staged)]);
    hasher.update(path.as_bytes());
    hasher.update(raw);
    hex_encode(hasher.finalize().as_slice())
}

pub fn parse_diff(bytes: &[u8], truncated_input: bool) -> Result<ParsedDiff, AppError> {
    if bytes.is_empty() {
        return Ok(ParsedDiff {
            binary: false,
            undecodable: false,
            preamble: String::new(),
            hunks: Vec::new(),
            additions: 0,
            deletions: 0,
            truncated: truncated_input,
        });
    }
    if bytes.contains(&0) {
        return Ok(ParsedDiff {
            binary: true,
            undecodable: true,
            preamble: String::new(),
            hunks: Vec::new(),
            additions: 0,
            deletions: 0,
            truncated: truncated_input,
        });
    }
    let text = std::str::from_utf8(bytes).map_err(|_| {
        AppError::new(
            "diff_encoding",
            "差异包含无法安全显示的内容，已停止读取且未修改仓库。",
        )
    })?;
    if is_binary_diff(text) {
        return Ok(ParsedDiff {
            binary: true,
            undecodable: false,
            preamble: String::new(),
            hunks: Vec::new(),
            additions: 0,
            deletions: 0,
            truncated: truncated_input,
        });
    }
    let lines = split_keep(text);
    let hunk_at = lines.iter().position(|line| line.starts_with("@@"));
    let (preamble_lines, hunk_lines) = match hunk_at {
        Some(index) => (&lines[..index], &lines[index..]),
        None => (lines.as_slice(), &[][..]),
    };
    let preamble = preamble_lines.concat();
    let mut hunks = Vec::new();
    let mut cursor = 0;
    while cursor < hunk_lines.len() {
        let end = hunk_lines[cursor + 1..]
            .iter()
            .position(|line| line.starts_with("@@"))
            .map(|offset| cursor + 1 + offset)
            .unwrap_or(hunk_lines.len());
        let raw = hunk_lines[cursor..end].concat();
        let header = hunk_lines[cursor]
            .trim_end_matches(['\n', '\r'])
            .to_string();
        let last = end == hunk_lines.len();
        let complete = hunk_is_complete(&header, &hunk_lines[cursor..end], truncated_input && last);
        let display = hunk_display_lines(hunks.len() as u32, &header, &hunk_lines[cursor..end]);
        hunks.push(ParsedHunk {
            index: hunks.len() as u32,
            header,
            raw,
            complete,
            lines: display,
        });
        cursor = end;
    }
    let (additions, deletions) = count_changes(&hunks);
    Ok(ParsedDiff {
        binary: false,
        undecodable: false,
        preamble,
        hunks,
        additions,
        deletions,
        truncated: truncated_input,
    })
}

pub fn build_patch(parsed: &ParsedDiff, indexes: &[u32]) -> Result<Vec<u8>, AppError> {
    if parsed.binary || parsed.undecodable {
        return Err(AppError::new(
            "not_text",
            "二进制或无法解码的文件不能按代码块暂存。可以暂存整个文件。",
        ));
    }
    if indexes.is_empty() {
        return Err(AppError::new(
            "empty_hunks",
            "没有选中的代码块，未修改暂存区。",
        ));
    }
    if indexes.len() > 500 {
        return Err(AppError::new(
            "too_many_hunks",
            "一次选择的代码块过多，未修改暂存区。",
        ));
    }
    let mut ordered = indexes.to_vec();
    ordered.sort_unstable();
    if ordered.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(AppError::new(
            "duplicate_hunk",
            "代码块选择重复，未修改暂存区。",
        ));
    }
    let mut patch = parsed.preamble.clone();
    if !patch.is_empty() && !patch.ends_with('\n') {
        patch.push('\n');
    }
    for index in ordered {
        let hunk = parsed
            .hunks
            .iter()
            .find(|hunk| hunk.index == index)
            .ok_or_else(|| {
                AppError::new("hunk_missing", "所选代码块已不在当前差异中，未修改暂存区。")
            })?;
        if !hunk.complete {
            return Err(AppError::new(
                "truncated_hunk",
                "这个代码块不完整，不能部分暂存。请暂存整个文件，或加载完整差异后再试。",
            ));
        }
        patch.push_str(&hunk.raw);
        if !patch.ends_with('\n') {
            patch.push('\n');
        }
    }
    Ok(patch.into_bytes())
}

pub fn view_lines(
    parsed: &ParsedDiff,
    offset: u32,
    limit: u32,
) -> (Vec<DiffLine>, Vec<DiffHunk>, u32) {
    let meta = || {
        parsed
            .preamble
            .split_inclusive('\n')
            .map(|line| line.trim_end_matches(['\n', '\r']))
            .filter(|line| !line.is_empty())
    };
    let meta_count = meta().count() as u32;
    let total = meta_count
        + parsed
            .hunks
            .iter()
            .map(|hunk| hunk.lines.len() as u32)
            .sum::<u32>();
    let limit = if limit == 0 {
        DIFF_VIEW_LINE_LIMIT
    } else {
        limit.min(DIFF_VIEW_LINE_LIMIT)
    };
    let offset = offset.min(total);
    let end = offset.saturating_add(limit).min(total);
    // 只克隆当前页：完整文件预览可能有数万行，不能每次续读都复制整份文本。
    let mut window = Vec::with_capacity((end - offset) as usize);
    if offset < meta_count {
        for text in meta().skip(offset as usize).take((end - offset) as usize) {
            window.push(DiffLine {
                kind: "meta".to_string(),
                text: text.to_string(),
                old_no: None,
                new_no: None,
                hunk_index: None,
            });
        }
    }
    let mut visible = Vec::new();
    let mut start = meta_count;
    for hunk in &parsed.hunks {
        if start >= end {
            break;
        }
        let hunk_end = start + hunk.lines.len() as u32;
        if hunk_end > offset {
            let visible_start = start.max(offset);
            let visible_end = hunk_end.min(end);
            window.extend(
                hunk.lines[(visible_start - start) as usize..(visible_end - start) as usize]
                    .iter()
                    .cloned(),
            );
            visible.push(DiffHunk {
                index: hunk.index,
                header: hunk.header.clone(),
                complete: hunk.complete,
                stageable: hunk.complete && !parsed.binary,
                start_line: visible_start - offset,
                line_count: visible_end - visible_start,
            });
        }
        start = hunk_end;
    }
    (window, visible, total)
}

pub fn first_file_diff(bytes: &[u8]) -> &[u8] {
    let marker = b"\ndiff --git ";
    if let Some(index) = bytes
        .windows(marker.len())
        .position(|window| window == marker)
    {
        if index > 0 {
            return &bytes[..index + 1];
        }
    }
    bytes
}

pub fn parse_numstat(bytes: &[u8]) -> Option<(Option<u64>, Option<u64>)> {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0 || *byte == b'\n')
        .unwrap_or(bytes.len());
    let line = String::from_utf8_lossy(&bytes[..end]);
    let mut parts = line.split('\t');
    let added = parts.next()?;
    let deleted = parts.next()?;
    Some((parse_stat(added), parse_stat(deleted)))
}

fn parse_stat(token: &str) -> Option<u64> {
    if token == "-" {
        return None;
    }
    token.parse().ok()
}

fn is_binary_diff(text: &str) -> bool {
    if text.contains("GIT binary patch") {
        return true;
    }
    let lower = text.to_ascii_lowercase();
    (lower.contains("binary files ") || lower.starts_with("binary file")) && !text.contains("\n@@")
}

fn hunk_is_complete(header: &str, lines: &[&str], truncated_tail: bool) -> bool {
    let Some((_, old_count, _, new_count)) = parse_hunk_header(header) else {
        return false;
    };
    if truncated_tail && lines.last().is_some_and(|line| !line.ends_with('\n')) {
        return false;
    }
    let (old_seen, new_seen) = body_counts(&lines[1..]);
    old_seen == old_count && new_seen == new_count
}

fn body_counts(lines: &[&str]) -> (u32, u32) {
    let mut old_seen = 0_u32;
    let mut new_seen = 0_u32;
    for line in lines {
        let body = line.trim_end_matches(['\n', '\r']);
        if body.starts_with('\\') {
            continue;
        }
        // Preamble file headers are not in the hunk body. A leading '+' or '-' is the marker,
        // so "+++ ..." and "--- ..." are added or deleted lines.
        if body.starts_with('+') {
            new_seen = new_seen.saturating_add(1);
        } else if body.starts_with('-') {
            old_seen = old_seen.saturating_add(1);
        } else if body.starts_with(' ') || body.is_empty() {
            old_seen = old_seen.saturating_add(1);
            new_seen = new_seen.saturating_add(1);
        } else {
            return (u32::MAX, u32::MAX);
        }
    }
    (old_seen, new_seen)
}

fn hunk_display_lines(index: u32, header: &str, lines: &[&str]) -> Vec<DiffLine> {
    let mut display = Vec::new();
    display.push(DiffLine {
        kind: "hunk".to_string(),
        text: header.to_string(),
        old_no: None,
        new_no: None,
        hunk_index: Some(index),
    });
    let (mut old_no, mut new_no) = parse_hunk_header(header)
        .map(|(old_start, _, new_start, _)| (old_start, new_start))
        .unwrap_or((0, 0));
    for line in lines.iter().skip(1) {
        let body = line.trim_end_matches(['\n', '\r']);
        if body.starts_with('\\') {
            display.push(DiffLine {
                kind: "nonewline".to_string(),
                text: body.to_string(),
                old_no: None,
                new_no: None,
                hunk_index: Some(index),
            });
            continue;
        }
        if body.starts_with('+') {
            let current = new_no;
            new_no = new_no.saturating_add(1);
            display.push(DiffLine {
                kind: "add".to_string(),
                text: body.to_string(),
                old_no: None,
                new_no: Some(current),
                hunk_index: Some(index),
            });
        } else if body.starts_with('-') {
            let current = old_no;
            old_no = old_no.saturating_add(1);
            display.push(DiffLine {
                kind: "del".to_string(),
                text: body.to_string(),
                old_no: Some(current),
                new_no: None,
                hunk_index: Some(index),
            });
        } else {
            let current_old = old_no;
            let current_new = new_no;
            old_no = old_no.saturating_add(1);
            new_no = new_no.saturating_add(1);
            display.push(DiffLine {
                kind: "context".to_string(),
                text: body.to_string(),
                old_no: Some(current_old),
                new_no: Some(current_new),
                hunk_index: Some(index),
            });
        }
    }
    display
}

fn parse_hunk_header(header: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = header.strip_prefix("@@ ")?;
    let (ranges, _) = rest.split_once(" @@")?;
    let mut parts = ranges.split_whitespace();
    let old = parts.next()?;
    let new = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let (old_start, old_count) = parse_range(old.strip_prefix('-')?)?;
    let (new_start, new_count) = parse_range(new.strip_prefix('+')?)?;
    Some((old_start, old_count, new_start, new_count))
}

fn parse_range(token: &str) -> Option<(u32, u32)> {
    if let Some((start, count)) = token.split_once(',') {
        Some((start.parse().ok()?, count.parse().ok()?))
    } else {
        Some((token.parse().ok()?, 1))
    }
}

fn count_changes(hunks: &[ParsedHunk]) -> (u64, u64) {
    let mut additions = 0_u64;
    let mut deletions = 0_u64;
    for hunk in hunks {
        for line in &hunk.lines {
            if line.kind == "add" {
                additions += 1;
            } else if line.kind == "del" {
                deletions += 1;
            }
        }
    }
    (additions, deletions)
}

fn split_keep(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines = Vec::new();
    let mut rest = text;
    while let Some(index) = rest.find('\n') {
        lines.push(&rest[..index + 1]);
        rest = &rest[index + 1..];
    }
    if !rest.is_empty() {
        lines.push(rest);
    }
    lines
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumstatEntry {
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub path: String,
}

/// 解析 `git diff --numstat -z`。普通记录是 `added\tdeleted\tpath\0`，
/// 重命名是 `added\tdeleted\t\0old\0new\0`，计数记在新路径上。二进制两侧都是 `-`。
pub fn parse_numstat_list(bytes: &[u8]) -> Vec<NumstatEntry> {
    let mut parts = Vec::new();
    let mut start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == 0 {
            parts.push(&bytes[start..index]);
            start = index + 1;
        }
    }
    if start < bytes.len() {
        parts.push(&bytes[start..]);
    }
    let mut entries = Vec::new();
    let mut index = 0;
    while index < parts.len() {
        let record = parts[index];
        if record.is_empty() {
            index += 1;
            continue;
        }
        let text = String::from_utf8_lossy(record);
        let mut fields = text.split('\t');
        let (Some(added), Some(deleted)) = (fields.next(), fields.next()) else {
            index += 1;
            continue;
        };
        let mut path = fields.next().unwrap_or("").to_string();
        for extra in fields {
            path.push('\t');
            path.push_str(extra);
        }
        let additions = parse_stat(added);
        let deletions = parse_stat(deleted);
        if path.is_empty() {
            if index + 2 >= parts.len() {
                break;
            }
            let new_path = String::from_utf8_lossy(parts[index + 2]).into_owned();
            if !new_path.is_empty() {
                entries.push(NumstatEntry {
                    additions,
                    deletions,
                    path: new_path,
                });
            }
            index += 3;
        } else {
            entries.push(NumstatEntry {
                additions,
                deletions,
                path,
            });
            index += 1;
        }
    }
    entries
}

pub fn numstat_map(entries: Vec<NumstatEntry>) -> HashMap<String, LineStat> {
    let mut map = HashMap::new();
    for entry in entries {
        let stat = match (entry.additions, entry.deletions) {
            (Some(additions), Some(deletions)) => LineStat {
                additions: Some(additions),
                deletions: Some(deletions),
                old_size: None,
                new_size: None,
            },
            _ => LineStat {
                additions: None,
                deletions: None,
                old_size: None,
                new_size: None,
            },
        };
        map.insert(entry.path, stat);
    }
    map
}

/// 空文件 0 行；以换行结尾时换行数就是行数，否则还要算上最后一行。
#[cfg(test)]
pub fn count_text_lines(bytes: &[u8]) -> u64 {
    if bytes.is_empty() {
        return 0;
    }
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count() as u64;
    if bytes.last() == Some(&b'\n') {
        newlines
    } else {
        newlines + 1
    }
}

/// Git 把前 8000 字节里的 NUL 当成二进制。二进制两侧计数都空着，不能写成 0。
#[cfg(test)]
pub fn line_stat_of_bytes(bytes: &[u8]) -> LineStat {
    let window = &bytes[..bytes.len().min(8000)];
    if window.contains(&0) {
        LineStat {
            additions: None,
            deletions: None,
            old_size: None,
            new_size: None,
        }
    } else {
        LineStat {
            additions: Some(count_text_lines(bytes)),
            deletions: Some(0),
            old_size: None,
            new_size: None,
        }
    }
}

pub fn assign_worktree_numstat(
    files: &mut [FileChange],
    staged: &HashMap<String, LineStat>,
    unstaged: &HashMap<String, LineStat>,
) {
    for file in files {
        if file.untracked {
            continue;
        }
        if file.unmerged || file.staged != ChangeKind::None {
            if let Some(stat) = staged.get(&file.path) {
                file.staged_lines = Some(*stat);
            }
        }
        if file.unmerged || file.unstaged != ChangeKind::None {
            if let Some(stat) = unstaged.get(&file.path) {
                file.unstaged_lines = Some(*stat);
            }
        }
    }
}

pub fn apply_commit_numstat(files: &mut [CommitFileChange], stats: &HashMap<String, LineStat>) {
    for file in files.iter_mut() {
        match stats.get(&file.path) {
            Some(stat) if stat.additions.is_none() || stat.deletions.is_none() => {
                file.binary = true;
                file.additions = None;
                file.deletions = None;
            }
            Some(stat) => {
                file.binary = false;
                file.additions = stat.additions;
                file.deletions = stat.deletions;
            }
            None => {
                file.binary = false;
                file.additions = None;
                file.deletions = None;
            }
        }
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> &'static str {
        "\
diff --git a/demo.txt b/demo.txt
index c4352f8..8964c93 100644
--- a/demo.txt
+++ b/demo.txt
@@ -1,7 +1,7 @@
 line 1
 line 2
 line 3
-line 4
+CHANGED A
 line 5
 line 6
 line 7
@@ -12,7 +12,7 @@ line 11
 line 12
 line 13
 line 14
-line 15
+CHANGED B
 line 16
 line 17
 line 18
"
    }

    #[test]
    fn selected_hunk_patch_keeps_header_and_excludes_the_other_hunk() {
        let parsed = parse_diff(sample().as_bytes(), false).unwrap();
        assert_eq!(parsed.hunks.len(), 2);
        assert!(parsed.hunks.iter().all(|hunk| hunk.complete));
        let patch = String::from_utf8(build_patch(&parsed, &[0]).unwrap()).unwrap();
        assert!(patch.contains("diff --git a/demo.txt b/demo.txt"));
        assert!(patch.contains("+CHANGED A"));
        assert!(!patch.contains("CHANGED B"));
        assert!(patch.contains("\\ No newline").eq(&false));
    }

    #[test]
    fn diff_pages_preserve_lines_and_hunk_boundaries() {
        let parsed = parse_diff(sample().as_bytes(), false).unwrap();
        let (all, hunks, total) = view_lines(&parsed, 0, 0);
        for offset in 0..=total + 1 {
            for limit in [1, 3, 8, 400] {
                let (page, visible, count) = view_lines(&parsed, offset, limit);
                let start = offset.min(total);
                let end = (start + limit).min(total);
                assert_eq!(count, total);
                assert_eq!(page, all[start as usize..end as usize]);
                let expected: Vec<_> = hunks
                    .iter()
                    .filter(|hunk| {
                        hunk.start_line < end && hunk.start_line + hunk.line_count > start
                    })
                    .map(|hunk| {
                        let mut visible = hunk.clone();
                        let from = hunk.start_line.max(start);
                        visible.start_line = from - start;
                        visible.line_count = (hunk.start_line + hunk.line_count).min(end) - from;
                        visible
                    })
                    .collect();
                assert_eq!(visible, expected);
            }
        }
        let empty = parse_diff(b"\n\r\n", false).unwrap();
        assert_eq!(view_lines(&empty, u32::MAX, 1), (vec![], vec![], 0));
        let cut_at = sample().find("+CHANGED B").unwrap() + 4;
        let cut = parse_diff(&sample().as_bytes()[..cut_at], true).unwrap();
        let (_, visible, _) = view_lines(&cut, 0, 400);
        assert!(visible[0].stageable);
        assert!(!visible[1].stageable);
    }

    #[test]
    fn truncated_hunk_cannot_be_patched() {
        let full = sample();
        let cut = &full[..full.find("+CHANGED B").unwrap() + 4];
        let parsed = parse_diff(cut.as_bytes(), true).unwrap();
        assert!(parsed.hunks[0].complete);
        assert!(!parsed.hunks[1].complete);
        let error = build_patch(&parsed, &[1]).unwrap_err();
        assert_eq!(error.code, "truncated_hunk");
        let first = build_patch(&parsed, &[0]).unwrap();
        assert!(!String::from_utf8(first).unwrap().contains("CHANGED B"));
    }

    #[test]
    fn no_newline_marker_stays_in_the_hunk() {
        let raw = "\
diff --git a/n.txt b/n.txt
--- a/n.txt
+++ b/n.txt
@@ -1,2 +1,2 @@
-a
+A
-h
\\ No newline at end of file
+H
\\ No newline at end of file
";
        let parsed = parse_diff(raw.as_bytes(), false).unwrap();
        assert!(parsed.hunks[0].complete);
        assert!(parsed.hunks[0].raw.contains("\\ No newline at end of file"));
        let patch = String::from_utf8(build_patch(&parsed, &[0]).unwrap()).unwrap();
        assert!(patch.contains("\\ No newline at end of file"));
    }

    #[test]
    fn binary_and_nul_have_no_text_hunks() {
        let binary = parse_diff(b"Binary files a/data.bin and b/data.bin differ\n", false).unwrap();
        assert!(binary.binary);
        assert!(binary.hunks.is_empty());
        assert_eq!(build_patch(&binary, &[0]).unwrap_err().code, "not_text");
        let nul = parse_diff(b"hello\0", true).unwrap();
        assert!(nul.undecodable);
        assert!(nul.hunks.is_empty());
    }

    #[test]
    fn snapshot_changes_when_bytes_or_side_change() {
        let left = snapshot_token(b"abc", false, "a.txt", false);
        let right = snapshot_token(b"abd", false, "a.txt", false);
        let staged = snapshot_token(b"abc", false, "a.txt", true);
        assert_ne!(left, right);
        assert_ne!(left, staged);
        assert_eq!(left.len(), 64);
    }

    #[test]
    fn hunk_body_dash_and_plus_markers_are_stageable_changes() {
        let raw = "\
diff --git a/marks.txt b/marks.txt
index 1111111..2222222 100644
--- a/marks.txt
+++ b/marks.txt
@@ -1,5 +1,5 @@
 line 1
--- dash
+++ plus
 line 3
 line 4
 line 5
@@ -12,7 +12,7 @@ line 11
 line 12
 line 13
 line 14
-keep
+other
 line 16
 line 17
 line 18
";
        let parsed = parse_diff(raw.as_bytes(), false).unwrap();
        assert!(parsed.hunks.iter().all(|hunk| hunk.complete));
        assert_eq!(parsed.additions, 2);
        assert_eq!(parsed.deletions, 2);
        let first = &parsed.hunks[0];
        assert_eq!(first.lines[2].kind, "del");
        assert_eq!(first.lines[2].text, "--- dash");
        assert_eq!(first.lines[2].old_no, Some(2));
        assert_eq!(first.lines[2].new_no, None);
        assert_eq!(first.lines[3].kind, "add");
        assert_eq!(first.lines[3].text, "+++ plus");
        assert_eq!(first.lines[3].old_no, None);
        assert_eq!(first.lines[3].new_no, Some(2));
        let patch = String::from_utf8(build_patch(&parsed, &[0]).unwrap()).unwrap();
        assert!(patch.contains("--- a/marks.txt"));
        assert!(patch.contains("+++ b/marks.txt"));
        assert!(patch.contains("--- dash"));
        assert!(patch.contains("+++ plus"));
        assert!(!patch.contains("+other"));
    }

    #[test]
    fn numstat_distinguishes_binary() {
        assert_eq!(parse_numstat(b"3\t1\ta.txt\0"), Some((Some(3), Some(1))));
        assert_eq!(parse_numstat(b"-\t-\tdata.bin\0"), Some((None, None)));
    }

    #[test]
    fn numstat_list_keeps_rename_on_the_new_path_and_binary_blank() {
        let entries =
            parse_numstat_list(b"2\t1\tbase.txt\0-\t-\tdata.bin\x000\t0\t\0a.txt\0b.txt\0");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "base.txt");
        assert_eq!(entries[0].additions, Some(2));
        assert_eq!(entries[0].deletions, Some(1));
        assert_eq!(entries[1].path, "data.bin");
        assert_eq!(entries[1].additions, None);
        assert_eq!(entries[2].path, "b.txt");
        assert_eq!(entries[2].additions, Some(0));
        assert_eq!(count_text_lines(b""), 0);
        assert_eq!(count_text_lines(b"a\nb\nc"), 3);
        assert_eq!(count_text_lines(b"a\nb\nc\n"), 3);
        let text = line_stat_of_bytes(b"a\nb\n");
        assert_eq!(text.additions, Some(2));
        assert_eq!(text.deletions, Some(0));
        let binary = line_stat_of_bytes(b"a\0b");
        assert_eq!(binary.additions, None);
        assert_eq!(binary.deletions, None);
    }
}
