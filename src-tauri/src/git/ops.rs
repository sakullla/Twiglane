use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use crate::error::AppError;
use crate::git::command::{diff_command, init_command, status_command, toplevel_command};
use crate::git::locate::{detect_git_binary, validate_git, GitLocator, ResolvedGit};
use crate::git::parse::{classify_diff, parse_status, DiffBody};
use crate::git::runner::{ProcessOutput, RealRunner};
use crate::git::schedule::{GitJob, GitScheduler, JobKind, ScheduledOutput};
use crate::model::{
    DiffResponse, GitInfo, OpenedRepository, PanelWidths, RecentRepo, RepoSummary, SettingsDto,
    StatusSnapshot, Theme,
};
use crate::redact::redact_error_text;
use crate::shutdown::Shutdown;
use crate::state::AppStore;
use crate::watch::WatchHub;

pub struct Backend {
    pub git: StdMutex<GitLocator>,
    pub scheduler: GitScheduler<RealRunner>,
    pub store: AppStore,
    pub watches: WatchHub,
    pub shutdown: Arc<Shutdown>,
    pub runner: RealRunner,
}

impl Backend {
    pub fn new(store: AppStore, runner: RealRunner, shutdown: Arc<Shutdown>) -> Self {
        let locator = GitLocator::from_configured(store.snapshot().git_executable.clone());
        let scheduler = GitScheduler::new(
            runner.clone(),
            shutdown.clone(),
            runner.timeout,
            runner.output_limit,
            runner.extra_env.clone(),
        );
        Self {
            git: StdMutex::new(locator),
            scheduler,
            store,
            watches: WatchHub::new(),
            shutdown,
            runner,
        }
    }
}

pub async fn detect_git(backend: &Backend) -> Result<GitInfo, AppError> {
    let configured = lock_git(backend).configured_path();
    let detection = detect_git_binary(&backend.runner, &backend.shutdown, configured.clone()).await;
    Ok(lock_git(backend).apply_detection(configured, detection))
}

pub async fn set_git_executable(backend: &Backend, path: &str) -> Result<GitInfo, AppError> {
    if path.is_empty() {
        return clear_git_executable(backend).await;
    }
    let input = validate_input_path(path)?;
    let resolved = validate_git(&backend.runner, &backend.shutdown, &input).await?;
    let stored = resolved.path.display().to_string();
    backend.store.set_git_executable(Some(stored))?;
    let mut git = lock_git(backend);
    git.set_resolved(resolved);
    Ok(git.info())
}

pub async fn clear_git_executable(backend: &Backend) -> Result<GitInfo, AppError> {
    backend.store.set_git_executable(None)?;
    lock_git(backend).clear_override();
    detect_git(backend).await
}

pub async fn get_settings(backend: &Backend) -> Result<SettingsDto, AppError> {
    let git = detect_git(backend).await?;
    let snapshot = backend.store.snapshot();
    Ok(SettingsDto {
        theme: snapshot.theme,
        panel_widths: snapshot.panel_widths,
        git,
        recent: snapshot.recent,
        settings_warning: backend.store.settings_warning(),
    })
}

pub fn set_theme(backend: &Backend, theme: Theme) -> Result<(), AppError> {
    backend.store.set_theme(theme)
}

pub fn set_panel_widths(backend: &Backend, widths: PanelWidths) -> Result<PanelWidths, AppError> {
    let widths = widths.clamped();
    backend.store.set_panel_widths(widths.clone())?;
    Ok(widths)
}

pub fn save_draft(backend: &Backend, path: &str, message: &str) -> Result<(), AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    backend.store.save_draft(&repo_key(&root), message)
}

pub fn forget_recent(backend: &Backend, path: &str) -> Result<Vec<RecentRepo>, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    backend.store.forget_recent(&repo_key(&root))
}

pub fn close_repository(backend: &Backend) {
    backend.watches.stop();
}

pub async fn add_repository(
    backend: &Backend,
    path: &str,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let input = validate_input_path(path)?;
    ensure_directory(&input)?;
    let git = require_git(backend).await?;
    let toplevel = match show_toplevel(backend, &git.path, &input, request_id).await {
        Ok(found) => found,
        Err(Probe::NotRepo) => {
            return Err(AppError::new(
                "not_repository",
                "该目录不是 Git 仓库，未做任何修改。",
            ));
        }
        Err(Probe::Failed(error)) => return Err(error),
    };
    let root = canonical_existing(&toplevel)?;
    open_root(backend, root, request_id.wrapping_add(1)).await
}

pub async fn create_repository(
    backend: &Backend,
    path: &str,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let input = validate_input_path(path)?;
    ensure_directory(&input)?;
    let root = canonical_existing(&input)?;
    if root.join(".git").exists() {
        return Err(AppError::new(
            "git_dir_exists",
            "该目录已有 .git，未重新初始化。",
        ));
    }
    let git = require_git(backend).await?;
    match show_toplevel(backend, &git.path, &root, request_id).await {
        Ok(parent) => {
            let parent = canonical_existing(&parent)?;
            if parent == root {
                return Err(AppError::new(
                    "already_repository",
                    "该目录已经是 Git 仓库，未重新初始化。",
                ));
            }
            return Err(AppError::new(
                "inside_repository",
                "所选目录位于已有仓库内部，未初始化嵌套仓库。",
            ));
        }
        Err(Probe::NotRepo) => {}
        Err(Probe::Failed(error)) => return Err(error),
    }
    let (program, args) = init_command(&git.path, &root);
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Write,
        request_id.wrapping_add(1),
        program,
        args,
        None,
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(git_failure(
            "init_failed",
            &scheduled.output,
            "初始化失败。未删除已有文件。",
        ));
    }
    open_root(backend, root, request_id.wrapping_add(2)).await
}

pub async fn open_repository(
    backend: &Backend,
    path: &str,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    ensure_directory(&root)?;
    if !root.join(".git").exists() {
        return Err(AppError::new(
            "not_repository",
            "该目录不是 Git 仓库，未做任何修改。",
        ));
    }
    open_root(backend, root, request_id).await
}

pub async fn refresh_status(
    backend: &Backend,
    path: &str,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let git = require_git(backend).await?;
    let (program, args) = status_command(&git.path, &root);
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Read,
        request_id,
        program,
        args,
        Some(generation),
    )
    .await?;
    status_from_output(&scheduled)
}

pub async fn load_diff(
    backend: &Backend,
    path: &str,
    relative: &str,
    staged: bool,
    generation: u64,
    request_id: u64,
) -> Result<DiffResponse, AppError> {
    let root = canonical_existing(&validate_input_path(path)?)?;
    let relative_path = safe_relative(relative)?;
    let git = require_git(backend).await?;
    let (program, args) = diff_command(&git.path, &root, &relative_path, staged);
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Read,
        request_id,
        program,
        args,
        Some(generation),
    )
    .await?;
    if scheduled.output.exit_code != 0 {
        return Err(git_failure(
            "diff_failed",
            &scheduled.output,
            "无法读取差异，未修改仓库。",
        ));
    }
    let body = classify_diff(&scheduled.output.stdout)?;
    Ok(DiffResponse {
        generation: scheduled.generation,
        path: relative.to_string(),
        staged,
        binary: matches!(body, DiffBody::Binary),
        text: match body {
            DiffBody::Text(text) => Some(text),
            DiffBody::Empty | DiffBody::Binary => None,
        },
    })
}

async fn open_root(
    backend: &Backend,
    root: PathBuf,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let git = require_git(backend).await?;
    let (program, args) = status_command(&git.path, &root);
    let scheduled = run_git(
        backend,
        &repo_key(&root),
        JobKind::Read,
        request_id,
        program,
        args,
        None,
    )
    .await?;
    let snapshot = status_from_output(&scheduled)?;
    let summary = RepoSummary {
        name: repo_name(&root),
        path: repo_key(&root),
    };
    backend
        .store
        .touch_recent(summary.name.clone(), summary.path.clone())?;
    let draft = backend.store.draft(&summary.path);
    let generation = snapshot.generation;
    Ok(OpenedRepository {
        summary,
        generation,
        snapshot,
        draft,
        watch_degraded: false,
    })
}

fn status_from_output(scheduled: &ScheduledOutput) -> Result<StatusSnapshot, AppError> {
    if scheduled.output.exit_code != 0 {
        return Err(git_failure(
            "status_failed",
            &scheduled.output,
            "无法读取仓库状态。",
        ));
    }
    let mut snapshot = parse_status(&scheduled.output.stdout)?;
    snapshot.generation = scheduled.generation;
    snapshot.branch.live_remote_checked = false;
    Ok(snapshot)
}

#[derive(Debug)]
enum Probe {
    NotRepo,
    Failed(AppError),
}

enum ProbeClass {
    NotRepo,
    Failed(&'static str),
}

async fn show_toplevel(
    backend: &Backend,
    git: &Path,
    path: &Path,
    request_id: u64,
) -> Result<PathBuf, Probe> {
    let (program, args) = toplevel_command(git, path);
    let scheduled = match run_git(
        backend,
        &repo_key(path),
        JobKind::Read,
        request_id,
        program,
        args,
        None,
    )
    .await
    {
        Ok(scheduled) => scheduled,
        Err(error) => return Err(Probe::Failed(error)),
    };
    classify_toplevel(&scheduled.output)
}

fn classify_toplevel(output: &ProcessOutput) -> Result<PathBuf, Probe> {
    if output.exit_code == 0 {
        let found = toplevel_text(&output.stdout);
        if found.is_empty() {
            return Err(Probe::Failed(AppError::new(
                "repository_probe",
                "无法确认仓库根目录，未创建或修改任何文件。",
            )));
        }
        return Ok(PathBuf::from(found));
    }
    match probe_class(&probe_text(output)) {
        ProbeClass::NotRepo => Err(Probe::NotRepo),
        ProbeClass::Failed(code) => Err(Probe::Failed(probe_failure(code, output))),
    }
}

// Git localizes these lines. Only an explicit "not a repository" may allow init.
fn probe_class(text: &str) -> ProbeClass {
    let lower = text.to_ascii_lowercase();
    if has_probe_phrase(
        &lower,
        &[
            "dubious ownership",
            "unsafe repository",
            "safe.directory",
            "可疑的仓库所有权",
        ],
    ) {
        return ProbeClass::Failed("repository_ownership");
    }
    if has_probe_phrase(
        &lower,
        &["permission denied", "operation not permitted", "权限不够"],
    ) {
        return ProbeClass::Failed("permission");
    }
    if has_probe_phrase(
        &lower,
        &[
            "must be run in a work tree",
            "not a working tree",
            "必须在一个工作区中运行",
        ],
    ) {
        return ProbeClass::Failed("not_work_tree");
    }
    if has_probe_phrase(&lower, &["not a git repository", "不是 git 仓库"]) {
        return ProbeClass::NotRepo;
    }
    ProbeClass::Failed("repository_probe")
}

fn has_probe_phrase(haystack: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|phrase| haystack.contains(phrase))
}

fn probe_failure(code: &str, output: &ProcessOutput) -> AppError {
    let fallback = match code {
        "repository_ownership" => "Git 因仓库所有权拒绝读取，未创建或修改任何文件。",
        "permission" => "Git 因权限拒绝读取，未创建或修改任何文件。",
        "not_work_tree" => "该路径不是 Git 工作区，未创建或修改任何文件。",
        _ => "无法确认该目录是否为 Git 仓库，未创建或修改任何文件。",
    };
    let detail = redact_error_text(command_detail(output).trim());
    if detail.is_empty() {
        AppError::new(code, fallback)
    } else {
        AppError::new(code, format!("{fallback} {detail}"))
    }
}

fn probe_text(output: &ProcessOutput) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    )
}

fn command_detail(output: &ProcessOutput) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn toplevel_text(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0 || *byte == b'\n')
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_string()
}

async fn run_git(
    backend: &Backend,
    repo_key: &str,
    kind: JobKind,
    request_id: u64,
    program: PathBuf,
    args: Vec<std::ffi::OsString>,
    generation: Option<u64>,
) -> Result<ScheduledOutput, AppError> {
    let mut attempt = 0_u64;
    let mut current = generation.unwrap_or_else(|| backend.scheduler.current_generation(repo_key));
    loop {
        let result = backend
            .scheduler
            .execute(GitJob {
                repo_key: repo_key.to_string(),
                kind,
                request_id: request_id.wrapping_add(attempt),
                generation: current,
                program: program.clone(),
                args: args.clone(),
            })
            .await;
        match result {
            Err(error) if error.code == "stale" && generation.is_none() && attempt < 2 => {
                current = error
                    .generation
                    .unwrap_or_else(|| backend.scheduler.current_generation(repo_key));
                attempt += 1;
            }
            other => return other,
        }
    }
}

async fn require_git(backend: &Backend) -> Result<ResolvedGit, AppError> {
    if let Some(resolved) = lock_git(backend).resolved().cloned() {
        return Ok(resolved);
    }
    let info = detect_git(backend).await?;
    if !info.available {
        return Err(AppError::new("git_missing", info.message));
    }
    lock_git(backend)
        .resolved()
        .cloned()
        .ok_or_else(|| AppError::new("git_missing", "未检测到 Git。请安装 Git 或选择可执行文件后重试。"))
}

fn lock_git(backend: &Backend) -> std::sync::MutexGuard<'_, GitLocator> {
    backend.git.lock().unwrap_or_else(|error| error.into_inner())
}

pub fn validate_input_path(path: &str) -> Result<PathBuf, AppError> {
    if path.is_empty() || path.contains('\0') || path.contains('\n') || path.contains('\r') {
        return Err(AppError::new(
            "invalid_path",
            "路径无效，未创建或修改任何文件。",
        ));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(AppError::new(
            "invalid_path",
            "需要绝对路径，未创建或修改任何文件。",
        ));
    }
    Ok(path)
}

pub fn safe_relative(path: &str) -> Result<PathBuf, AppError> {
    if path.is_empty() || path.contains('\0') || path.contains('\n') || path.contains('\r') {
        return Err(AppError::new(
            "invalid_path",
            "该路径无法安全读取，未修改仓库。",
        ));
    }
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            !matches!(component, Component::Normal(_) | Component::CurDir)
        })
    {
        return Err(AppError::new(
            "invalid_path",
            "差异路径必须留在仓库内部。",
        ));
    }
    Ok(relative.to_path_buf())
}

fn ensure_directory(path: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Err(AppError::new(
            "path_missing",
            "路径不存在，未创建或修改任何文件。",
        ));
    }
    if !path.is_dir() {
        return Err(AppError::new(
            "not_directory",
            "所选路径不是目录，原文件保持不变。",
        ));
    }
    match fs::read_dir(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => Err(AppError::new(
            "permission",
            "无法读取该目录，未修改其中的文件。",
        )),
        Err(error) => Err(AppError::new(
            "path_unreadable",
            format!(
                "无法读取该目录，未修改其中的文件。{}",
                redact_error_text(&error.to_string())
            ),
        )),
    }
}

pub fn canonical_existing(path: &Path) -> Result<PathBuf, AppError> {
    dunce::canonicalize(path).map_err(|error| {
        AppError::new(
            "path_unreadable",
            format!(
                "无法解析路径，未修改文件。{}",
                redact_error_text(&error.to_string())
            ),
        )
    })
}

pub fn repo_key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn repo_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| repo_key(path))
}

fn git_failure(code: &str, output: &ProcessOutput, fallback: &str) -> AppError {
    let detail = redact_error_text(String::from_utf8_lossy(&output.stderr).trim());
    if detail.is_empty() {
        AppError::new(code, fallback)
    } else {
        AppError::new(code, format!("{fallback} {detail}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs;
    use std::process::Command;

    use crate::git::runner::ProcessOutput;
    use crate::state::AppStore;

    #[tokio::test]
    async fn add_does_not_modify_invalid_paths_and_create_is_explicit() {
        let fixture = crate::test_support::git_fixture("repo-safety");
        let backend = fixture.backend();
        let missing = fixture.path().join("missing-dir");
        let missing_error = add_repository(&backend, &repo_key(&missing), 1)
            .await
            .unwrap_err();
        assert_eq!(missing_error.code, "path_missing");
        assert!(!missing.exists());

        let file_path = fixture.path().join("plain.txt");
        fs::write(&file_path, b"keep").unwrap();
        let before = fs::read(&file_path).unwrap();
        let file_error = add_repository(&backend, &repo_key(&file_path), 2)
            .await
            .unwrap_err();
        assert_eq!(file_error.code, "not_directory");
        assert_eq!(fs::read(&file_path).unwrap(), before);

        let plain = fixture.path().join("plain-dir");
        fs::create_dir(&plain).unwrap();
        let keep = plain.join("keep.txt");
        fs::write(&keep, b"same").unwrap();
        let modified = fs::metadata(&keep).unwrap().modified().unwrap();
        let add_error = add_repository(&backend, &repo_key(&plain), 3)
            .await
            .unwrap_err();
        assert_eq!(add_error.code, "not_repository");
        assert!(!plain.join(".git").exists());
        assert_eq!(fs::read(&keep).unwrap(), b"same");
        assert_eq!(fs::metadata(&keep).unwrap().modified().unwrap(), modified);

        let newline = add_repository(&backend, "/tmp/bad\npath", 4).await.unwrap_err();
        assert_eq!(newline.code, "invalid_path");
        assert!(safe_relative("a\nb").is_err());
        assert!(safe_relative("../outside").is_err());

        let created = create_repository(&backend, &repo_key(&plain), 5)
            .await
            .unwrap();
        assert!(plain.join(".git").is_dir());
        assert_eq!(fs::read(&keep).unwrap(), b"same");
        assert_eq!(created.summary.name, "plain-dir");
        assert!(created.snapshot.branch.unborn || created.snapshot.branch.name.is_some());
        assert!(!created.snapshot.branch.live_remote_checked);

        let again = create_repository(&backend, &created.summary.path, 8)
            .await
            .unwrap_err();
        assert_eq!(again.code, "git_dir_exists");

        let nested = plain.join("nested");
        fs::create_dir(&nested).unwrap();
        let nested_error = create_repository(&backend, &repo_key(&nested), 9)
            .await
            .unwrap_err();
        assert_eq!(nested_error.code, "inside_repository");
        assert!(!nested.join(".git").exists());
    }

    #[tokio::test]
    async fn opens_real_repository_and_keeps_same_names_distinct() {
        let fixture = crate::test_support::git_fixture("repo-open");
        let backend = fixture.backend();
        let first = fixture.repo("demo");
        let second = fixture.repo("demo");
        fs::create_dir_all(first.join("sub")).unwrap();
        run_git_ok(&first, &["init", "-b", "main"]);
        fs::write(first.join("sub").join("说明.txt"), "你好\n").unwrap();
        fs::write(first.join("file one.txt"), "before\n").unwrap();
        run_git_ok(&first, &["add", "--", "file one.txt", "sub/说明.txt"]);
        run_git_ok(&first, &["commit", "-m", "init"]);
        fs::write(first.join("file one.txt"), "before\nafter\n").unwrap();
        fs::write(second.join("keep.txt"), b"untouched").unwrap();
        run_git_ok(&second, &["init", "-b", "main"]);

        let opened = add_repository(&backend, &repo_key(&first.join("sub")), 1)
            .await
            .unwrap();
        assert_eq!(opened.summary.path, repo_key(&canonical_existing(&first).unwrap()));
        assert_eq!(opened.snapshot.branch.name.as_deref(), Some("main"));
        assert!(opened
            .snapshot
            .files
            .iter()
            .any(|file| file.path == "file one.txt"));
        let diff = load_diff(
            &backend,
            &opened.summary.path,
            "file one.txt",
            false,
            opened.generation,
            2,
        )
        .await
        .unwrap();
        let text = diff.text.unwrap();
        assert!(text.contains("+after"));
        assert!(!diff.binary);

        let other = add_repository(&backend, &repo_key(&second), 3)
            .await
            .unwrap();
        assert_ne!(opened.summary.path, other.summary.path);
        assert_eq!(opened.summary.name, other.summary.name);
        let recent = backend.store.snapshot().recent;
        assert_eq!(recent.len(), 2);
        assert_eq!(fs::read(second.join("keep.txt")).unwrap(), b"untouched");

        backend
            .store
            .save_draft(&opened.summary.path, "第一份草稿")
            .unwrap();
        backend
            .store
            .save_draft(&other.summary.path, "第二份草稿")
            .unwrap();
        let reloaded = AppStore::open(backend.store.path().to_path_buf());
        assert_eq!(reloaded.draft(&opened.summary.path), "第一份草稿");
        assert_eq!(reloaded.draft(&other.summary.path), "第二份草稿");
    }

    fn run_git_ok(dir: &Path, args: &[&str]) {
        let git = crate::test_support::system_git();
        let status = Command::new(git)
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

    fn extra_env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(key, value)| (OsString::from(*key), OsString::from(*value)))
            .collect()
    }

    fn git_output(exit_code: i32, stderr: &[u8]) -> ProcessOutput {
        ProcessOutput {
            exit_code,
            stdout: Vec::new(),
            stderr: stderr.to_vec(),
        }
    }

    #[test]
    fn only_confirmed_non_repositories_allow_initialization() {
        let not_repo = git_output(
            128,
            b"fatal: not a git repository (or any of the parent directories): .git\n",
        );
        assert!(matches!(
            super::classify_toplevel(&not_repo),
            Err(super::Probe::NotRepo)
        ));
        let chinese = git_output(128, "致命错误：不是 git 仓库（或者任何父目录）：.git\n".as_bytes());
        assert!(matches!(
            super::classify_toplevel(&chinese),
            Err(super::Probe::NotRepo)
        ));

        let owned = git_output(
            128,
            b"fatal: detected dubious ownership in repository at '/tmp/repo'\n\tgit config --global --add safe.directory /tmp/repo\n",
        );
        match super::classify_toplevel(&owned) {
            Err(super::Probe::Failed(error)) => {
                assert_eq!(error.code, "repository_ownership");
                assert!(error.message.contains("dubious ownership"));
                assert!(!error.message.contains("不是 Git 仓库"));
            }
            other => panic!("ownership probe was not rejected: {other:?}"),
        }
        let owned_zh = git_output(
            128,
            "致命错误：在 '/tmp/repo' 检测到可疑的仓库所有权\n\tgit config --global --add safe.directory /tmp/repo\n"
                .as_bytes(),
        );
        match super::classify_toplevel(&owned_zh) {
            Err(super::Probe::Failed(error)) => assert_eq!(error.code, "repository_ownership"),
            other => panic!("{other:?}"),
        }

        let bare = git_output(128, b"fatal: this operation must be run in a work tree\n");
        match super::classify_toplevel(&bare) {
            Err(super::Probe::Failed(error)) => {
                assert_eq!(error.code, "not_work_tree");
                assert!(error.message.contains("work tree"));
            }
            other => panic!("{other:?}"),
        }
        let bare_zh = git_output(128, "致命错误：该操作必须在一个工作区中运行\n".as_bytes());
        match super::classify_toplevel(&bare_zh) {
            Err(super::Probe::Failed(error)) => assert_eq!(error.code, "not_work_tree"),
            other => panic!("{other:?}"),
        }

        let denied = git_output(128, b"fatal: cannot change to '/tmp/locked': Permission denied\n");
        match super::classify_toplevel(&denied) {
            Err(super::Probe::Failed(error)) => {
                assert_eq!(error.code, "permission");
                assert!(error.message.to_ascii_lowercase().contains("permission denied"));
            }
            other => panic!("{other:?}"),
        }

        let unknown = git_output(128, b"fatal: something unexpected\n");
        match super::classify_toplevel(&unknown) {
            Err(super::Probe::Failed(error)) => assert_eq!(error.code, "repository_probe"),
            other => panic!("{other:?}"),
        }
        let empty = git_output(0, b"");
        match super::classify_toplevel(&empty) {
            Err(super::Probe::NotRepo) => panic!("empty success was treated as a missing repository"),
            Err(super::Probe::Failed(error)) => assert_eq!(error.code, "repository_probe"),
            Ok(path) => panic!("empty success returned {}", path.display()),
        }

        let secret = git_output(
            128,
            b"fatal: detected dubious ownership in repository at '/tmp/ghp_abcdefghijklmnopqrstuvwxyz1234'\n",
        );
        match super::classify_toplevel(&secret) {
            Err(super::Probe::Failed(error)) => {
                assert!(!error.message.contains("ghp_abcdefghijklmnopqrstuvwxyz1234"));
                assert!(error.message.contains("dubious ownership"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn probe_failures_do_not_initialize_a_nested_repository() {
        let fixture = crate::test_support::git_fixture("probe-guard");
        let owned = fixture.repo("owned");
        fs::write(owned.join("keep.txt"), b"keep").unwrap();
        run_git_ok(&owned, &["init", "-b", "main"]);
        let ownership = fixture.backend_with_extra_env(extra_env(&[("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1")]));
        let added = add_repository(&ownership, &repo_key(&owned), 1)
            .await
            .unwrap_err();
        assert_eq!(added.code, "repository_ownership");
        assert!(
            added.message.contains("dubious ownership") || added.message.contains("safe.directory"),
            "{}",
            added.message
        );
        assert!(!added.message.contains("不是 Git 仓库"));
        assert_eq!(fs::read(owned.join("keep.txt")).unwrap(), b"keep");
        assert!(owned.join(".git").is_dir());

        let child = owned.join("child");
        fs::create_dir(&child).unwrap();
        fs::write(child.join("keep.txt"), b"child").unwrap();
        let created = create_repository(&ownership, &repo_key(&child), 2)
            .await
            .unwrap_err();
        assert_eq!(created.code, "repository_ownership");
        assert!(!created.message.contains("不是 Git 仓库"));
        assert!(!child.join(".git").exists());
        assert_eq!(fs::read(child.join("keep.txt")).unwrap(), b"child");

        let normal = fixture.backend();
        let opened = add_repository(&normal, &repo_key(&owned), 3).await.unwrap();
        assert_eq!(opened.snapshot.branch.name.as_deref(), Some("main"));

        let bare = fixture.path().join("bare.git");
        run_git_ok(fixture.path(), &["init", "--bare", "bare.git"]);
        let head = fs::read(bare.join("HEAD")).unwrap();
        let bare_add = add_repository(&normal, &repo_key(&bare), 4).await.unwrap_err();
        assert_eq!(bare_add.code, "not_work_tree");
        assert!(
            bare_add.message.to_ascii_lowercase().contains("work tree")
                || bare_add.message.contains("工作区")
        );
        assert!(!bare_add.message.contains("不是 Git 仓库"));
        assert!(!bare.join(".git").exists());
        assert_eq!(fs::read(bare.join("HEAD")).unwrap(), head);
        let bare_create = create_repository(&normal, &repo_key(&bare), 5)
            .await
            .unwrap_err();
        assert_ne!(bare_create.code, "not_repository");
        assert!(!bare.join(".git").exists());
        assert_eq!(fs::read(bare.join("HEAD")).unwrap(), head);
    }

    #[tokio::test]
    async fn localized_probe_keeps_explicit_create_and_blocks_nested_init() {
        let fixture = crate::test_support::git_fixture("probe-locale");
        let backend = fixture.backend_with_extra_env(extra_env(&[
            ("LC_ALL", "zh_CN.UTF-8"),
            ("LANG", "zh_CN.UTF-8"),
        ]));
        let plain = fixture.path().join("plain-dir");
        fs::create_dir(&plain).unwrap();
        fs::write(plain.join("keep.txt"), b"same").unwrap();
        let missing = add_repository(&backend, &repo_key(&plain), 1)
            .await
            .unwrap_err();
        assert_eq!(missing.code, "not_repository");
        assert!(!plain.join(".git").exists());
        let created = create_repository(&backend, &repo_key(&plain), 2).await.unwrap();
        assert!(plain.join(".git").is_dir());
        assert_eq!(fs::read(plain.join("keep.txt")).unwrap(), b"same");
        assert!(created.snapshot.branch.unborn || created.snapshot.branch.name.is_some());
        let nested = plain.join("nested");
        fs::create_dir(&nested).unwrap();
        let nested_error = create_repository(&backend, &repo_key(&nested), 5)
            .await
            .unwrap_err();
        assert_eq!(nested_error.code, "inside_repository");
        assert!(!nested.join(".git").exists());

        let owned = fixture.repo("owned");
        fs::write(owned.join("keep.txt"), b"keep").unwrap();
        run_git_ok(&owned, &["init", "-b", "main"]);
        let ownership = fixture.backend_with_extra_env(extra_env(&[
            ("LC_ALL", "zh_CN.UTF-8"),
            ("LANG", "zh_CN.UTF-8"),
            ("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1"),
        ]));
        let child = owned.join("child");
        fs::create_dir(&child).unwrap();
        fs::write(child.join("keep.txt"), b"child").unwrap();
        let blocked = create_repository(&ownership, &repo_key(&child), 6)
            .await
            .unwrap_err();
        assert_ne!(blocked.code, "not_repository");
        assert!(!blocked.message.contains("不是 Git 仓库"));
        assert!(!child.join(".git").exists());
        assert_eq!(fs::read(child.join("keep.txt")).unwrap(), b"child");

        let bare = fixture.path().join("bare.git");
        run_git_ok(fixture.path(), &["init", "--bare", "bare.git"]);
        let bare_add = add_repository(&backend, &repo_key(&bare), 7).await.unwrap_err();
        assert_eq!(bare_add.code, "not_work_tree");
        assert!(!bare.join(".git").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_directory_probe_is_permission_and_does_not_init() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = crate::test_support::git_fixture("probe-permission");
        let backend = fixture.backend();
        let locked = fixture.path().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("keep.txt"), b"perm").unwrap();
        let info = detect_git(&backend).await.unwrap();
        let git = PathBuf::from(info.path.expect("git"));
        let mut perms = fs::metadata(&locked).unwrap().permissions();
        perms.set_mode(0o0);
        fs::set_permissions(&locked, perms).unwrap();
        struct Reset(PathBuf);
        impl Drop for Reset {
            fn drop(&mut self) {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&self.0) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = fs::set_permissions(&self.0, perms);
                }
            }
        }
        let _reset = Reset(locked.clone());
        let error = match super::show_toplevel(&backend, &git, &locked, 1).await {
            Err(super::Probe::Failed(error)) => error,
            Err(super::Probe::NotRepo) => panic!("permission failure was treated as a missing repository"),
            Ok(path) => panic!("unexpected toplevel {}", path.display()),
        };
        let created = create_repository(&backend, &repo_key(&locked), 2)
            .await
            .unwrap_err();
        let mut perms = fs::metadata(&locked).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&locked, perms).unwrap();
        assert_eq!(error.code, "permission");
        assert!(error.message.to_ascii_lowercase().contains("permission denied"));
        assert_eq!(created.code, "permission");
        assert!(!locked.join(".git").exists());
        assert_eq!(fs::read(locked.join("keep.txt")).unwrap(), b"perm");
    }

    #[tokio::test]
    async fn recorded_divergence_uses_non_negative_counts() {
        let fixture = crate::test_support::git_fixture("divergence");
        let backend = fixture.backend();
        let origin = fixture.repo("origin");
        run_git_ok(&origin, &["init", "-b", "main"]);
        fs::write(origin.join("file.txt"), "base\n").unwrap();
        run_git_ok(&origin, &["add", "--", "file.txt"]);
        run_git_ok(&origin, &["commit", "-m", "base"]);
        let work = fixture.path().join("work");
        let origin_path = repo_key(&origin);
        run_git_ok(fixture.path(), &["clone", origin_path.as_str(), "work"]);
        fs::write(work.join("file.txt"), "base\nlocal\n").unwrap();
        run_git_ok(&work, &["commit", "-am", "local"]);
        fs::write(origin.join("file.txt"), "base\nupstream\n").unwrap();
        run_git_ok(&origin, &["commit", "-am", "upstream"]);
        run_git_ok(&work, &["fetch", "origin"]);
        let opened = add_repository(&backend, &repo_key(&work), 1).await.unwrap();
        assert_eq!(opened.snapshot.branch.ahead, Some(1));
        assert_eq!(opened.snapshot.branch.behind, Some(1));
        assert!(!opened.snapshot.branch.live_remote_checked);
    }
}
