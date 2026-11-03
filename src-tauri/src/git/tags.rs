use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::AppError;
use crate::git::advice::{classify_problem, problem_error};
use crate::git::command::{
    check_tag_command, create_tag_command, delete_tag_command, ls_remote_tags_command,
    push_tag_command, rev_parse_command, status_command, tag_list_command,
};
use crate::git::gate::action_key;
use crate::git::ops::{
    canonical_existing, git_failure, repo_key, require_git, run_git, status_from_output,
    validate_input_path, Backend,
};
use crate::git::runner::{run_process, RunnerError};
use crate::git::schedule::{internal_request_id, JobKind};
use crate::model::{RemoteTag, TagRecord, TagState};

/// 网络不通时不等满通用的 Git 超时：列表早已显示，这里只决定状态多久变成“未知”。
const REMOTE_TAG_TIMEOUT: Duration = Duration::from_secs(20);

pub async fn tag_state(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<TagState, AppError> {
    let root = repo_root(path)?;
    load_tags(backend, &root, generation, request_id).await
}

/// 只读查询远程标签。结果描述的是远程，与本地 generation 无关，所以绕开调度器：
/// 不做 generation 校验，也不占读并发名额，慢网络不会拖住其他读取；过期响应由调用方丢弃。
/// 同一仓库同时只跑一个，在途时返回 `duplicate`。不复用在途结果：它可能早于刚完成的推送。
pub async fn tag_remote_state(
    backend: &Backend,
    path: &str,
    remote: &str,
) -> Result<Vec<RemoteTag>, AppError> {
    let root = repo_root(path)?;
    let _guard = backend
        .actions
        .enter(action_key("tag-remote", &repo_key(&root)))?;
    validate_remote(remote)
        .map_err(|_| AppError::new("remote_invalid", "远程名称无效，未读取远程标签。"))?;
    let git = require_git(backend).await?;
    let (program, args) = ls_remote_tags_command(&git.path, &root, remote);
    let mut request = backend
        .runner
        .base_request(program, args, backend.shutdown.clone());
    request.timeout = request.timeout.min(REMOTE_TAG_TIMEOUT);
    let output = run_process(request).await.map_err(remote_read_error)?;
    if output.exit_code != 0 {
        return Err(git_failure(
            "tag_remote_failed",
            &output,
            "无法读取远程标签。",
        ));
    }
    Ok(parse_remote_tags(&output.stdout))
}

pub async fn create_tag(
    backend: &Backend,
    path: &str,
    name: &str,
    target: &str,
    message: &str,
    generation: u64,
    request_id: u64,
) -> Result<TagState, AppError> {
    let root = repo_root(path)?;
    let _guard = backend.actions.enter(action_key("tag", &repo_key(&root)))?;
    validate_tag_name(name)?;
    validate_target(target)?;
    let git = require_git(backend).await?;
    let (program, args) = check_tag_command(&git.path, &root, name);
    let checked = run_git(backend, &repo_key(&root), JobKind::Read, request_id, program, args, Some(generation)).await?;
    if checked.output.exit_code != 0 {
        return Err(AppError::new("tag_invalid", "标签名称无效，未创建标签。").with_generation(checked.generation));
    }
    let current = load_tags(backend, &root, checked.generation, internal_request_id()).await?;
    if current.tags.iter().any(|tag| tag.name == name) {
        return Err(AppError::new("tag_duplicate", "已有同名标签，未再创建。").with_generation(current.generation));
    }
    let revision = format!("{target}^{{commit}}");
    let (program, args) = rev_parse_command(&git.path, &root, &revision);
    let verified = run_git(
        backend,
        &repo_key(&root),
        JobKind::Read,
        internal_request_id(),
        program,
        args,
        Some(current.generation),
    )
    .await?;
    if verified.output.exit_code != 0 {
        return Err(AppError::new("tag_target", "目标提交不存在或不是有效提交，未创建标签。").with_generation(verified.generation));
    }
    let (program, args) = create_tag_command(&git.path, &root, name, target, message);
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Write,
        internal_request_id(),
        program,
        args,
        Some(verified.generation),
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(tag_failure("tag_create_failed", &scheduled.output, scheduled.generation, "没有创建标签。"));
    }
    settle_read!(backend, &root, scheduled.generation, |current| load_tags(backend, &root, current, internal_request_id()).await)
}

pub async fn delete_tag(
    backend: &Backend,
    path: &str,
    name: &str,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<TagState, AppError> {
    if !confirm {
        return Err(AppError::new("confirm_required", "删除标签需要明确确认，未执行。"));
    }
    let root = repo_root(path)?;
    let _guard = backend.actions.enter(action_key("tag", &repo_key(&root)))?;
    validate_tag_name(name)?;
    let git = require_git(backend).await?;
    let current = load_tags(backend, &root, generation, request_id).await?;
    if !current.tags.iter().any(|tag| tag.name == name) {
        return Err(AppError::new("tag_missing", "这个标签已不存在，没有重复删除。").with_generation(current.generation));
    }
    let (program, args) = delete_tag_command(&git.path, &root, name);
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Write,
        internal_request_id(),
        program,
        args,
        Some(current.generation),
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(tag_failure("tag_delete_failed", &scheduled.output, scheduled.generation, "没有删除标签。"));
    }
    settle_read!(backend, &root, scheduled.generation, |current| load_tags(backend, &root, current, internal_request_id()).await)
}

pub async fn push_tag(
    backend: &Backend,
    path: &str,
    remote: &str,
    name: &str,
    generation: u64,
    request_id: u64,
) -> Result<TagState, AppError> {
    let root = repo_root(path)?;
    let _guard = backend.actions.enter(action_key("sync", &repo_key(&root)))?;
    validate_tag_name(name)?;
    validate_remote(remote)?;
    let git = require_git(backend).await?;
    let current = load_tags(backend, &root, generation, request_id).await?;
    if !current.tags.iter().any(|tag| tag.name == name) {
        return Err(AppError::new("tag_missing", "这个标签已不存在，没有推送。").with_generation(current.generation));
    }
    let (program, args) = push_tag_command(&git.path, &root, remote, name);
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Write,
        internal_request_id(),
        program,
        args,
        Some(current.generation),
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(tag_failure("tag_push_failed", &scheduled.output, scheduled.generation, "没有推送标签，远程未被强行改写。"));
    }
    settle_read!(backend, &root, scheduled.generation, |current| load_tags(backend, &root, current, internal_request_id()).await)
}

async fn load_tags(
    backend: &Backend,
    root: &Path,
    generation: u64,
    request_id: u64,
) -> Result<TagState, AppError> {
    let git = require_git(backend).await?;
    let (program, args) = tag_list_command(&git.path, root);
    let listed = run_git(backend, &repo_key(root), JobKind::Read, request_id, program, args, Some(generation)).await?;
    if listed.output.exit_code != 0 {
        return Err(tag_failure("tag_read_failed", &listed.output, listed.generation, "无法读取标签。"));
    }
    let tags = parse_tags(&listed.output.stdout)?;
    let (program, args) = status_command(&git.path, root);
    let status = run_git(
        backend,
        &repo_key(root),
        JobKind::Read,
        internal_request_id(),
        program,
        args,
        Some(listed.generation),
    )
    .await?;
    let snapshot = status_from_output(backend, root, &status).await?;
    Ok(TagState {
        generation: snapshot.generation,
        tags,
        snapshot,
    })
}

fn parse_tags(bytes: &[u8]) -> Result<Vec<TagRecord>, AppError> {
    let text = String::from_utf8_lossy(bytes);
    let mut tags = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\u{1f}').collect();
        if fields.len() != 5 {
            return Err(AppError::new("tag_parse", "无法解析标签列表，未修改仓库。"));
        }
        let created_at = fields[3].parse::<i64>().unwrap_or(0);
        tags.push(TagRecord {
            name: fields[0].to_string(),
            target_oid: if fields[2].is_empty() { fields[1].to_string() } else { fields[2].to_string() },
            message: fields[4].to_string(),
            created_at,
        });
    }
    Ok(tags)
}

/// `ls-remote --tags` 的输出：`<oid>\trefs/tags/<name>`，附注标签紧跟一行 `<name>^{}`
/// 给出解引用后的提交。本地 `targetOid` 同样是解引用后的值，所以以 `^{}` 行为准。
fn parse_remote_tags(bytes: &[u8]) -> Vec<RemoteTag> {
    let text = String::from_utf8_lossy(bytes);
    let mut tags: BTreeMap<String, String> = BTreeMap::new();
    for line in text.lines() {
        let Some((oid, reference)) = line.split_once('\t') else {
            continue;
        };
        let Some(name) = reference.trim().strip_prefix("refs/tags/") else {
            continue;
        };
        let oid = oid.trim().to_ascii_lowercase();
        if let Some(peeled) = name.strip_suffix("^{}") {
            tags.insert(peeled.to_string(), oid);
        } else {
            tags.entry(name.to_string()).or_insert(oid);
        }
    }
    tags.into_iter()
        .map(|(name, oid)| RemoteTag { name, oid })
        .collect()
}

fn remote_read_error(error: RunnerError) -> AppError {
    match error {
        RunnerError::Timeout => AppError::new("timeout", "读取远程标签超时，已停止。"),
        RunnerError::Cancelled => AppError::new("cancelled", "操作已取消。"),
        RunnerError::OutputLimit => {
            AppError::new("output_limit", "远程标签列表超过上限，已停止读取。")
        }
        RunnerError::Spawn(message) | RunnerError::Io(message) => AppError::new(
            "git_io",
            format!(
                "无法读取远程标签：{}",
                crate::redact::redact_error_text(&message)
            ),
        ),
    }
}

fn repo_root(path: &str) -> Result<PathBuf, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    if !root.join(".git").exists() {
        return Err(AppError::new("not_repository", "该目录不是 Git 仓库，未执行标签操作。"));
    }
    Ok(root)
}

fn validate_tag_name(name: &str) -> Result<(), AppError> {
    if name.is_empty()
        || name.starts_with('-')
        || name.chars().any(|character| character.is_whitespace() || character.is_control())
        || name.contains(['~', '^', ':', '?', '*', '[', '\\'])
        || name.contains("..")
        || name.contains("@{")
        || name.ends_with('.')
        || name.ends_with(".lock")
    {
        return Err(AppError::new("tag_invalid", "标签名称无效，未创建或修改标签。"));
    }
    Ok(())
}

fn validate_target(target: &str) -> Result<(), AppError> {
    if target.trim().is_empty() || target.starts_with('-') || target.chars().any(|character| character.is_control()) {
        return Err(AppError::new("tag_target", "目标提交无效，未创建标签。"));
    }
    Ok(())
}

fn validate_remote(remote: &str) -> Result<(), AppError> {
    if remote.is_empty()
        || remote.starts_with('-')
        || remote.chars().any(|character| character.is_whitespace() || character.is_control())
        || remote.contains([':', '\\'])
    {
        return Err(AppError::new("remote_invalid", "远程名称无效，未推送标签。"));
    }
    Ok(())
}

fn tag_failure(code: &str, output: &crate::git::runner::ProcessOutput, generation: u64, fallback: &str) -> AppError {
    let text = format!("{}\n{}", String::from_utf8_lossy(&output.stderr), String::from_utf8_lossy(&output.stdout));
    if let Some(problem) = classify_problem(&text) {
        return problem_error(problem, &text).with_generation(generation);
    }
    git_failure(code, output, fallback).with_generation(generation)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    use super::{
        create_tag, delete_tag, parse_remote_tags, push_tag, repo_root, tag_remote_state, tag_state,
    };
    use crate::git::gate::action_key;
    use crate::git::ops::{open_repository, repo_key};

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new(crate::test_support::system_git())
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", crate::test_support::isolated_gitconfig())
            .env("GIT_AUTHOR_NAME", "Twiglane Test")
            .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
            .env("GIT_COMMITTER_NAME", "Twiglane Test")
            .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
            .status()
            .unwrap();
        assert!(status.success(), "{args:?}");
    }

    #[test]
    fn remote_tags_use_the_peeled_commit_of_annotated_tags() {
        let raw = b"1111\trefs/tags/v1.0.0\n2222\trefs/tags/v2.0.0\nAAAA\trefs/tags/v2.0.0^{}\n3333\trefs/heads/main\nnot a record\n";
        let tags = parse_remote_tags(raw);
        let pairs: Vec<(&str, &str)> = tags
            .iter()
            .map(|tag| (tag.name.as_str(), tag.oid.as_str()))
            .collect();
        assert_eq!(pairs, vec![("v1.0.0", "1111"), ("v2.0.0", "aaaa")]);
        assert!(parse_remote_tags(b"").is_empty());
    }

    #[tokio::test]
    async fn remote_tag_state_reads_without_touching_generation() {
        let fixture = crate::test_support::git_fixture("tag-remote");
        let repo = fixture.repo("demo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "content\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "initial"]);
        git(&repo, &["tag", "light"]);
        git(&repo, &["tag", "-a", "annotated", "-m", "release"]);
        let path = repo.to_string_lossy().to_string();
        let backend = std::sync::Arc::new(fixture.backend());
        let opened = open_repository(&backend, &path, 1).await.unwrap();

        let missing = tag_remote_state(&backend, &path, "origin").await.unwrap_err();
        assert_eq!(missing.code, "tag_remote_failed");
        let invalid = tag_remote_state(&backend, &path, "--upload-pack=x").await.unwrap_err();
        assert_eq!(invalid.code, "remote_invalid");

        let key = action_key("tag-remote", &repo_key(&repo_root(&path).unwrap()));
        let held = backend.actions.enter(key).unwrap();
        let busy = tag_remote_state(&backend, &path, "origin").await.unwrap_err();
        assert_eq!(busy.code, "duplicate");
        drop(held);

        let bare = fixture.path().join("remote.git");
        git(fixture.path(), &["init", "--bare", bare.to_string_lossy().as_ref()]);
        git(&repo, &["remote", "add", "origin", bare.to_string_lossy().as_ref()]);
        assert!(tag_remote_state(&backend, &path, "origin").await.unwrap().is_empty());
        git(&repo, &["push", "origin", "--tags"]);

        let local = tag_state(&backend, &path, opened.generation, 2).await.unwrap();
        let remote = tag_remote_state(&backend, &path, "origin").await.unwrap();
        assert_eq!(remote.len(), 2);
        for tag in &local.tags {
            let found = remote.iter().find(|item| item.name == tag.name).unwrap();
            assert_eq!(found.oid, tag.target_oid, "{}", tag.name);
        }
        // generation 不变：沿用旧值的读取不会被判为过期。
        let after = tag_state(&backend, &path, local.generation, 3).await.unwrap();
        assert_eq!(after.generation, opened.generation);
        backend.watches.stop();
    }

    #[tokio::test]
    async fn tag_create_push_and_delete_use_real_git() {
        let fixture = crate::test_support::git_fixture("tag-lifecycle");
        let repo = fixture.repo("demo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "content\n").unwrap();
        git(&repo, &["add", "--", "file.txt"]);
        git(&repo, &["commit", "-m", "initial"]);
        let backend = std::sync::Arc::new(fixture.backend());
        let opened = open_repository(&backend, &repo.to_string_lossy(), 1).await.unwrap();
        let created = create_tag(&backend, &repo.to_string_lossy(), "v1.0.0", "HEAD", "release", opened.generation, 2)
            .await
            .unwrap();
        assert_eq!(created.tags.len(), 1);
        assert_eq!(created.tags[0].name, "v1.0.0");
        assert_eq!(created.tags[0].target_oid.len(), 40);
        assert_eq!(created.tags[0].message, "release");

        let bare = fixture.path().join("remote.git");
        git(fixture.path(), &["init", "--bare", bare.to_string_lossy().as_ref()]);
        git(&repo, &["remote", "add", "origin", bare.to_string_lossy().as_ref()]);
        let pushed = push_tag(&backend, &repo.to_string_lossy(), "origin", "v1.0.0", created.generation, 3)
            .await
            .unwrap();
        assert_eq!(pushed.tags.len(), 1);
        git(&bare, &["show-ref", "--verify", "refs/tags/v1.0.0"]);

        assert!(delete_tag(&backend, &repo.to_string_lossy(), "v1.0.0", false, pushed.generation, 4)
            .await
            .is_err());
        let deleted = delete_tag(&backend, &repo.to_string_lossy(), "v1.0.0", true, pushed.generation, 5)
            .await
            .unwrap();
        assert!(deleted.tags.is_empty());
        assert!(tag_state(&backend, &repo.to_string_lossy(), deleted.generation, 6)
            .await
            .unwrap()
            .tags
            .is_empty());
        backend.watches.stop();
    }
}
