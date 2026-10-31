use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::model::{DiffHunk, DiffLine};

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
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        AppError::new(
            "diff_encoding",
            "差异包含无法安全显示的内容，已停止读取且未修改仓库。",
        )
    })?;
    if is_binary_diff(&text) {
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
    let lines = split_keep(&text);
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
        let header = hunk_lines[cursor].trim_end_matches(['\n', '\r']).to_string();
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
        return Err(AppError::new("empty_hunks", "没有选中的代码块，未修改暂存区。"));
    }
    if indexes.len() > 500 {
        return Err(AppError::new("too_many_hunks", "一次选择的代码块过多，未修改暂存区。"));
    }
    let mut ordered = indexes.to_vec();
    ordered.sort_unstable();
    if ordered.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(AppError::new("duplicate_hunk", "代码块选择重复，未修改暂存区。"));
    }
    let mut patch = parsed.preamble.clone();
    if !patch.is_empty() && !patch.ends_with('\n') {
        patch.push('\n');
    }
    for index in ordered {
        let hunk = parsed.hunks.iter().find(|hunk| hunk.index == index).ok_or_else(|| {
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

pub fn view_lines(parsed: &ParsedDiff, offset: u32, limit: u32) -> (Vec<DiffLine>, Vec<DiffHunk>, u32) {
    let mut all = Vec::new();
    for line in split_keep(&parsed.preamble) {
        let text = line.trim_end_matches(['\n', '\r']).to_string();
        if text.is_empty() {
            continue;
        }
        all.push(DiffLine {
            kind: "meta".to_string(),
            text,
            old_no: None,
            new_no: None,
            hunk_index: None,
        });
    }
    let mut hunks = Vec::new();
    for hunk in &parsed.hunks {
        let start = all.len() as u32;
        all.extend(hunk.lines.iter().cloned());
        hunks.push(DiffHunk {
            index: hunk.index,
            header: hunk.header.clone(),
            complete: hunk.complete,
            stageable: hunk.complete && !parsed.binary,
            start_line: start,
            line_count: hunk.lines.len() as u32,
        });
    }
    let total = all.len() as u32;
    let limit = if limit == 0 { DIFF_VIEW_LINE_LIMIT } else { limit.min(DIFF_VIEW_LINE_LIMIT) };
    let offset = offset.min(total);
    let end = offset.saturating_add(limit).min(total);
    let window = all[offset as usize..end as usize].to_vec();
    let visible = hunks
        .into_iter()
        .filter(|hunk| hunk.start_line + hunk.line_count > offset && hunk.start_line < end)
        .map(|mut hunk| {
            let visible_start = hunk.start_line.max(offset);
            let visible_end = (hunk.start_line + hunk.line_count).min(end);
            hunk.start_line = visible_start - offset;
            hunk.line_count = visible_end.saturating_sub(visible_start);
            hunk
        })
        .collect();
    (window, visible, total)
}

pub fn first_file_diff(bytes: &[u8]) -> &[u8] {
    let marker = b"\ndiff --git ";
    if let Some(index) = bytes.windows(marker.len()).position(|window| window == marker) {
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
        if body.starts_with('+') && !body.starts_with("+++") {
            new_seen = new_seen.saturating_add(1);
        } else if body.starts_with('-') && !body.starts_with("---") {
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
        if body.starts_with('+') && !body.starts_with("+++") {
            let current = new_no;
            new_no = new_no.saturating_add(1);
            display.push(DiffLine {
                kind: "add".to_string(),
                text: body.to_string(),
                old_no: None,
                new_no: Some(current),
                hunk_index: Some(index),
            });
        } else if body.starts_with('-') && !body.starts_with("---") {
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
    fn numstat_distinguishes_binary() {
        assert_eq!(parse_numstat(b"3\t1\ta.txt\0"), Some((Some(3), Some(1))));
        assert_eq!(parse_numstat(b"-\t-\tdata.bin\0"), Some((None, None)));
    }
}
