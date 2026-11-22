//! Shared filesystem discovery for project worktree locations.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::error::AppError;

fn text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "目录名称无法用当前系统文字编码表示".into())
}

fn failure(message: impl Into<String>) -> AppError {
    AppError::new("workspace", message)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub name: String,
    pub common_directory: Option<String>,
    pub repository_id: Option<String>,
    pub error: Option<String>,
}

pub(crate) fn identity(path: &str) -> Option<(String, String)> {
    let input = Path::new(path);
    if !input.is_absolute() {
        return None;
    }
    let root = dunce::canonicalize(input).ok()?;
    let git = crate::git::heads::resolve_git_dir(&root)?;
    let common = match fs::read_to_string(git.join("commondir")) {
        Ok(value) => dunce::canonicalize(git.join(value.trim())).ok()?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => dunce::canonicalize(git).ok()?,
        Err(_) => return None,
    };
    Some((text(&root).ok()?, text(&common).ok()?))
}

pub(crate) async fn inspect_candidate(
    backend: &crate::git::ops::Backend,
    git: &Path,
    path: String,
    ids: &HashMap<String, String>,
) -> Candidate {
    use crate::git::{
        command::toplevel_command,
        ops::{canonical_existing, repo_key, run_git, validate_input_path},
        schedule::{internal_request_id, JobKind},
    };
    let found = async {
        let root = canonical_existing(&validate_input_path(&path)?)?;
        let (program, args) = toplevel_command(git, &root);
        let output = run_git(
            backend,
            &repo_key(&root),
            JobKind::Read,
            internal_request_id(),
            program,
            args,
            None,
        )
        .await?;
        if output.output.exit_code != 0 {
            return Err(failure("不是可读取的 Git 仓库"));
        }
        let top = std::str::from_utf8(&output.output.stdout)
            .map_err(|_| failure("仓库路径编码无法读取"))?
            .trim_end_matches(['\n', '\r']);
        identity(top).ok_or_else(|| failure("无法确认 Git common directory"))
    }
    .await;
    let (path, common_directory, repository_id, error) = match found {
        Ok((root, common)) => {
            let id = ids.get(&common).cloned();
            (root, Some(common), id, None)
        }
        Err(error) => (path, None, None, Some(error.message)),
    };
    Candidate {
        name: Path::new(&path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path,
        common_directory,
        repository_id,
        error,
    }
}

/// Bounded to the explicit root; never follow directory symlinks or enter .git metadata.
pub fn discover_paths(
    root: &str,
    cancel: &AtomicBool,
) -> Result<(Vec<String>, Vec<Candidate>, bool), AppError> {
    const DIRECTORY_LIMIT: usize = 50_000;
    let root = dunce::canonicalize(crate::git::ops::validate_input_path(root)?)
        .map_err(|e| failure(e.to_string()))?;
    let mut queue = std::collections::VecDeque::from([root]);
    let mut visited = 0;
    let mut paths = Vec::new();
    let mut issues = Vec::new();
    let mut partial = false;
    while let Some(path) = queue.pop_front() {
        if cancel.load(Ordering::Relaxed) {
            return Ok((paths, issues, true));
        }
        visited += 1;
        let mut has_marker = false;
        let mut exact_marker = false;
        let mut case_variants = Vec::new();
        let mut saw_case_variant = false;
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) => {
                if path.join(".git").exists() {
                    paths.push(text(&path).map_err(failure)?);
                }
                partial = true;
                issues.push(Candidate {
                    path: text(&path).map_err(failure)?,
                    name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    common_directory: None,
                    repository_id: None,
                    error: Some(format!("目录无法读取：{error}")),
                });
                continue;
            }
        };
        for entry in entries {
            if cancel.load(Ordering::Relaxed) {
                return Ok((paths, issues, true));
            }
            let Ok(entry) = entry else {
                partial = true;
                has_marker |= path.join(".git").exists();
                continue;
            };
            let name = entry.file_name();
            // Confirm only potential markers, including alternate casing on
            // case-insensitive volumes. Never descend into Git metadata.
            if name == ".git" {
                exact_marker = path.join(".git").exists();
                has_marker |= exact_marker;
                continue;
            }
            if name.eq_ignore_ascii_case(".git") && path.join(".git").exists() {
                saw_case_variant = true;
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    case_variants.push(entry.path());
                }
                continue;
            }
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => {
                    if visited + queue.len() >= DIRECTORY_LIMIT {
                        partial = true;
                        has_marker |= path.join(".git").exists();
                        break;
                    }
                    queue.push_back(entry.path());
                }
                Err(_) => partial = true,
                _ => {}
            }
        }
        // Both spellings can coexist on a case-sensitive volume. In that case
        // only the exact .git entry is metadata and the others are searchable.
        if exact_marker {
            for variant in case_variants {
                if visited + queue.len() == DIRECTORY_LIMIT {
                    partial = true;
                    break;
                }
                queue.push_back(variant);
            }
        } else if saw_case_variant {
            has_marker = true;
        }
        if has_marker {
            paths.push(text(&path).map_err(failure)?);
        }
    }
    Ok((paths, issues, partial))
}

