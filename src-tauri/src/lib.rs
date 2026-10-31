mod atomic;
mod error;
mod git;
mod model;
mod redact;
mod shutdown;
mod state;
mod watch;

#[cfg(test)]
mod security;
#[cfg(test)]
pub(crate) mod test_support;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State, WindowEvent};

use crate::error::AppError;
use crate::git::ops::{self, Backend};
use crate::git::runner::RealRunner;
use crate::model::{
    BranchState, CloneResult, CommitPushReport, CommitResult, DiffResponse, GitInfo,
    OpenedRepository, PanelWidths, RecentRepo, RemoteState, RepoChanged, SettingsDto,
    StatusSnapshot, Theme,
};
use crate::shutdown::Shutdown;
use crate::state::AppStore;

pub fn run() {
    let shutdown = Shutdown::new();
    let shutdown_for_run = shutdown.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            install_menu(app)?;
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
            let store = AppStore::open(dir.join("state.json"));
            let backend = Arc::new(Backend::new(
                store,
                RealRunner::default(),
                Arc::new(shutdown),
            ));
            app.manage(backend);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_git,
            set_git_executable,
            clear_git_executable,
            get_settings,
            add_repository,
            create_repository,
            open_repository,
            close_repository,
            forget_recent,
            refresh_status,
            load_diff,
            stage_files,
            unstage_files,
            stage_hunks,
            commit_changes,
            clone_repository,
            remote_state,
            add_remote,
            set_remote_url,
            fetch_remote,
            pull_fast_forward,
            push_branch,
            publish_branch,
            associate_upstream,
            commit_and_push,
            branch_state,
            create_branch,
            switch_branch,
            delete_branch,
            delete_remote_branch,
            set_theme,
            set_panel_widths,
            save_draft
        ])
        .build(tauri::generate_context!())
        .expect("启动 Twiglane 失败");
    app.run(move |app_handle, event| {
        if focused(&event) {
            let _ = app_handle.emit("window-focused", ());
        }
        if blurred(&event) {
            let _ = app_handle.emit("window-blurred", ());
        }
        if should_stop(&event) {
            stop_backend(app_handle, &shutdown_for_run);
        }
    });
}

fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let search = MenuItem::with_id(app, "focus-search", "搜索仓库", true, Some("CmdOrCtrl+K"))?;
    let commit = MenuItem::with_id(
        app,
        "commit-local",
        "提交到本地",
        true,
        Some("CmdOrCtrl+Enter"),
    )?;
    let menu = Menu::with_items(app, &[&search, &commit])?;
    app.set_menu(menu)?;
    app.on_menu_event(|app_handle, event| {
        let name = match event.id().0.as_str() {
            "focus-search" => "menu-search",
            "commit-local" => "menu-commit",
            _ => return,
        };
        let _ = app_handle.emit(name, ());
    });
    Ok(())
}

fn focused(event: &RunEvent) -> bool {
    matches!(
        event,
        RunEvent::WindowEvent {
            event: WindowEvent::Focused(true),
            ..
        }
    )
}

fn blurred(event: &RunEvent) -> bool {
    matches!(
        event,
        RunEvent::WindowEvent {
            event: WindowEvent::Focused(false),
            ..
        }
    )
}

fn should_stop(event: &RunEvent) -> bool {
    matches!(
        event,
        RunEvent::Exit
            | RunEvent::ExitRequested { .. }
            | RunEvent::WindowEvent {
                event: WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed,
                ..
            }
    )
}

fn stop_backend(app: &AppHandle, fallback: &Shutdown) {
    if let Some(backend) = app.try_state::<Arc<Backend>>() {
        backend.watches.stop();
        backend.shutdown.cancel();
    } else {
        fallback.cancel();
    }
}

fn start_watch<R: Runtime>(app: &AppHandle<R>, backend: &Arc<Backend>, path: &str) -> bool {
    let watched = path.to_string();
    let backend_for_event = Arc::clone(backend);
    let app_for_event = app.clone();
    let degraded_backend = Arc::clone(backend);
    let degraded_app = app.clone();
    let degraded_path = watched.clone();
    backend
        .watches
        .watch(
            PathBuf::from(&watched),
            Arc::new(move || {
                let generation = backend_for_event.scheduler.bump_generation(&watched);
                let _ = app_for_event.emit(
                    "repo-changed",
                    RepoChanged {
                        path: watched.clone(),
                        generation,
                        degraded: false,
                    },
                );
            }),
            Arc::new(move || {
                let generation = degraded_backend
                    .scheduler
                    .current_generation(&degraded_path);
                let _ = degraded_app.emit(
                    "repo-changed",
                    RepoChanged {
                        path: degraded_path.clone(),
                        generation,
                        degraded: true,
                    },
                );
            }),
        )
        .is_err()
}

#[tauri::command]
async fn detect_git(state: State<'_, Arc<Backend>>) -> Result<GitInfo, AppError> {
    ops::detect_git(state.inner()).await
}

#[tauri::command]
async fn set_git_executable(
    state: State<'_, Arc<Backend>>,
    path: String,
) -> Result<GitInfo, AppError> {
    ops::set_git_executable(state.inner(), &path).await
}

#[tauri::command]
async fn clear_git_executable(state: State<'_, Arc<Backend>>) -> Result<GitInfo, AppError> {
    ops::clear_git_executable(state.inner()).await
}

#[tauri::command]
async fn get_settings(state: State<'_, Arc<Backend>>) -> Result<SettingsDto, AppError> {
    ops::get_settings(state.inner()).await
}

#[tauri::command(rename_all = "camelCase")]
async fn add_repository<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<Backend>>,
    path: String,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let backend = Arc::clone(state.inner());
    let mut opened = ops::add_repository(&backend, &path, request_id).await?;
    opened.watch_degraded = start_watch(&app, &backend, &opened.summary.path);
    Ok(opened)
}

#[tauri::command(rename_all = "camelCase")]
async fn create_repository<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<Backend>>,
    path: String,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let backend = Arc::clone(state.inner());
    let mut opened = ops::create_repository(&backend, &path, request_id).await?;
    opened.watch_degraded = start_watch(&app, &backend, &opened.summary.path);
    Ok(opened)
}

#[tauri::command(rename_all = "camelCase")]
async fn open_repository<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<Backend>>,
    path: String,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let backend = Arc::clone(state.inner());
    let mut opened = ops::open_repository(&backend, &path, request_id).await?;
    opened.watch_degraded = start_watch(&app, &backend, &opened.summary.path);
    Ok(opened)
}

#[tauri::command]
fn close_repository(state: State<'_, Arc<Backend>>) {
    ops::close_repository(state.inner());
}

#[tauri::command]
fn forget_recent(
    state: State<'_, Arc<Backend>>,
    path: String,
) -> Result<Vec<RecentRepo>, AppError> {
    ops::forget_recent(state.inner(), &path)
}

#[tauri::command(rename_all = "camelCase")]
async fn refresh_status(
    state: State<'_, Arc<Backend>>,
    path: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    ops::refresh_status(state.inner(), &path, generation, request_id).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn load_diff(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    original: Option<String>,
    staged: bool,
    generation: u64,
    request_id: u64,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<DiffResponse, AppError> {
    crate::git::changes::load_diff(
        state.inner(),
        &path,
        &relative,
        original.as_deref(),
        staged,
        generation,
        request_id,
        offset.unwrap_or(0),
        limit.unwrap_or(0),
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn stage_files(
    state: State<'_, Arc<Backend>>,
    path: String,
    paths: Vec<String>,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::changes::stage_files(state.inner(), &path, &paths, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn unstage_files(
    state: State<'_, Arc<Backend>>,
    path: String,
    paths: Vec<String>,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::changes::unstage_files(state.inner(), &path, &paths, generation, request_id).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn stage_hunks(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    original: Option<String>,
    staged: bool,
    hunks: Vec<u32>,
    snapshot: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::changes::stage_hunks(
        state.inner(),
        &path,
        &relative,
        original.as_deref(),
        staged,
        &hunks,
        &snapshot,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn commit_changes(
    state: State<'_, Arc<Backend>>,
    path: String,
    message: String,
    generation: u64,
    request_id: u64,
) -> Result<CommitResult, AppError> {
    crate::git::changes::commit_index(state.inner(), &path, &message, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn clone_repository<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<Backend>>,
    url: String,
    parent: String,
    name: String,
    request_id: u64,
) -> Result<CloneResult, AppError> {
    let backend = Arc::clone(state.inner());
    let mut cloned =
        crate::git::sync::clone_repository(&backend, &url, &parent, &name, request_id).await?;
    cloned.opened.watch_degraded = start_watch(&app, &backend, &cloned.opened.summary.path);
    Ok(cloned)
}

#[tauri::command(rename_all = "camelCase")]
async fn remote_state(
    state: State<'_, Arc<Backend>>,
    path: String,
    generation: u64,
    request_id: u64,
) -> Result<RemoteState, AppError> {
    crate::git::sync::remote_state(state.inner(), &path, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn add_remote(
    state: State<'_, Arc<Backend>>,
    path: String,
    name: String,
    url: String,
    generation: u64,
    request_id: u64,
) -> Result<RemoteState, AppError> {
    crate::git::sync::add_remote(state.inner(), &path, &name, &url, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn set_remote_url(
    state: State<'_, Arc<Backend>>,
    path: String,
    name: String,
    url: String,
    generation: u64,
    request_id: u64,
) -> Result<RemoteState, AppError> {
    crate::git::sync::set_remote_url(state.inner(), &path, &name, &url, generation, request_id)
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn fetch_remote(
    state: State<'_, Arc<Backend>>,
    path: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::sync::fetch_remote(state.inner(), &path, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn pull_fast_forward(
    state: State<'_, Arc<Backend>>,
    path: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::sync::pull_fast_forward(state.inner(), &path, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn push_branch(
    state: State<'_, Arc<Backend>>,
    path: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::sync::push_branch(state.inner(), &path, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn publish_branch(
    state: State<'_, Arc<Backend>>,
    path: String,
    remote: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::sync::publish_branch(state.inner(), &path, &remote, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn associate_upstream(
    state: State<'_, Arc<Backend>>,
    path: String,
    remote: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::sync::associate_upstream(state.inner(), &path, &remote, generation, request_id)
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn commit_and_push(
    state: State<'_, Arc<Backend>>,
    path: String,
    message: String,
    generation: u64,
    request_id: u64,
) -> Result<CommitPushReport, AppError> {
    crate::git::sync::commit_and_push(state.inner(), &path, &message, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn branch_state(
    state: State<'_, Arc<Backend>>,
    path: String,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    crate::git::sync::branch_state(state.inner(), &path, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn create_branch(
    state: State<'_, Arc<Backend>>,
    path: String,
    name: String,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    crate::git::sync::create_branch(state.inner(), &path, &name, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn switch_branch(
    state: State<'_, Arc<Backend>>,
    path: String,
    name: String,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    crate::git::sync::switch_branch(state.inner(), &path, &name, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn delete_branch(
    state: State<'_, Arc<Backend>>,
    path: String,
    name: String,
    confirm_unmerged: bool,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    crate::git::sync::delete_branch(
        state.inner(),
        &path,
        &name,
        confirm_unmerged,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn delete_remote_branch(
    state: State<'_, Arc<Backend>>,
    path: String,
    remote: String,
    name: String,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    crate::git::sync::delete_remote_branch(
        state.inner(),
        &path,
        &remote,
        &name,
        confirm,
        generation,
        request_id,
    )
    .await
}

#[tauri::command]
fn set_theme(state: State<'_, Arc<Backend>>, theme: Theme) -> Result<(), AppError> {
    ops::set_theme(state.inner(), theme)
}

#[tauri::command]
fn set_panel_widths(
    state: State<'_, Arc<Backend>>,
    widths: PanelWidths,
) -> Result<PanelWidths, AppError> {
    ops::set_panel_widths(state.inner(), widths)
}

#[tauri::command]
fn save_draft(
    state: State<'_, Arc<Backend>>,
    path: String,
    message: String,
) -> Result<(), AppError> {
    ops::save_draft(state.inner(), &path, &message)
}

#[cfg(test)]
mod ipc_contract {
    use std::fs;
    use std::path::Path;
    use std::process::Command;
    use std::sync::Arc;
    use std::time::Duration;

    use crate::git::ops::repo_key;

    const API_SOURCE: &str = include_str!("../../src/lib/api.ts");

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new(crate::test_support::system_git())
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .env("GIT_AUTHOR_NAME", "Twiglane Test")
            .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
            .env("GIT_COMMITTER_NAME", "Twiglane Test")
            .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
            .status()
            .unwrap();
        assert!(status.success(), "{args:?}");
    }

    fn payload_after(command: &str) -> &str {
        let marker = format!("\"{command}\"");
        let start = API_SOURCE
            .find(&marker)
            .unwrap_or_else(|| panic!("missing {command}"));
        let rest = &API_SOURCE[start + marker.len()..];
        let end = rest.find("invoke<").unwrap_or(rest.len());
        &rest[..end]
    }

    fn invoke<W>(
        webview: &W,
        cmd: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String>
    where
        W: AsRef<tauri::Webview<tauri::test::MockRuntime>>,
    {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        webview.as_ref().clone().on_message(
            tauri::webview::InvokeRequest {
                cmd: cmd.to_string(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().expect("local origin"),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
            Box::new(move |_webview, _cmd, response, _callback, _error| {
                let _ = tx.send(response);
            }),
        );
        let response = rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| format!("ipc timed out: {cmd}"))?;
        match response {
            tauri::ipc::InvokeResponse::Ok(body) => {
                body.deserialize().map_err(|error| error.to_string())
            }
            tauri::ipc::InvokeResponse::Err(tauri::ipc::InvokeError(value)) => {
                Err(value.to_string())
            }
        }
    }

    #[test]
    fn frontend_and_ipc_use_request_id_camel_case() {
        for command in [
            "add_repository",
            "create_repository",
            "open_repository",
            "refresh_status",
            "load_diff",
            "stage_files",
            "unstage_files",
            "stage_hunks",
            "commit_changes",
            "clone_repository",
            "remote_state",
            "add_remote",
            "set_remote_url",
            "fetch_remote",
            "pull_fast_forward",
            "push_branch",
            "publish_branch",
            "associate_upstream",
            "commit_and_push",
            "branch_state",
            "create_branch",
            "switch_branch",
            "delete_branch",
            "delete_remote_branch",
        ] {
            let payload = payload_after(command);
            assert!(payload.contains("requestId"), "{command}: {payload}");
            assert!(!payload.contains("request_id"), "{command}: {payload}");
        }

        let fixture = crate::test_support::git_fixture("ipc-contract");
        let repo = fixture.repo("demo");
        fs::create_dir_all(repo.join("sub")).unwrap();
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file one.txt"), "before\n").unwrap();
        git(&repo, &["add", "--", "file one.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        fs::write(repo.join("file one.txt"), "before\nafter\n").unwrap();
        let plain = fixture.path().join("plain-dir");
        fs::create_dir(&plain).unwrap();
        fs::write(plain.join("keep.txt"), b"same").unwrap();

        let backend = Arc::new(fixture.backend());
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&backend))
            .invoke_handler(tauri::generate_handler![
                super::add_repository,
                super::create_repository,
                super::open_repository,
                super::refresh_status,
                super::load_diff,
                super::stage_files,
                super::unstage_files,
                super::stage_hunks,
                super::commit_changes,
                super::clone_repository,
                super::fetch_remote,
                super::commit_and_push,
                super::delete_branch
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("ipc test app");
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("ipc test window");

        for (cmd, body) in [
            (
                "add_repository",
                serde_json::json!({"path": "/tmp/unused", "request_id": 1}),
            ),
            (
                "create_repository",
                serde_json::json!({"path": "/tmp/unused", "request_id": 1}),
            ),
            (
                "open_repository",
                serde_json::json!({"path": "/tmp/unused", "request_id": 1}),
            ),
            (
                "refresh_status",
                serde_json::json!({"path": "/tmp/unused", "generation": 1, "request_id": 1}),
            ),
            (
                "load_diff",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "relative": "a",
                    "staged": false,
                    "generation": 1,
                    "request_id": 1
                }),
            ),
            (
                "stage_files",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "paths": ["a"],
                    "generation": 1,
                    "request_id": 1
                }),
            ),
            (
                "unstage_files",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "paths": ["a"],
                    "generation": 1,
                    "request_id": 1
                }),
            ),
            (
                "stage_hunks",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "relative": "a",
                    "staged": false,
                    "hunks": [0],
                    "snapshot": "abc",
                    "generation": 1,
                    "request_id": 1
                }),
            ),
            (
                "commit_changes",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "message": "note",
                    "generation": 1,
                    "request_id": 1
                }),
            ),
            (
                "clone_repository",
                serde_json::json!({
                    "url": "https://example.com/app.git",
                    "parent": "/tmp/unused",
                    "name": "app",
                    "request_id": 1
                }),
            ),
            (
                "fetch_remote",
                serde_json::json!({"path": "/tmp/unused", "generation": 1, "request_id": 1}),
            ),
            (
                "commit_and_push",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "message": "note",
                    "generation": 1,
                    "request_id": 1
                }),
            ),
            (
                "delete_branch",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "name": "topic",
                    "confirmUnmerged": false,
                    "generation": 1,
                    "request_id": 1
                }),
            ),
        ] {
            let error = invoke(&window, cmd, body).expect_err(cmd);
            assert!(error.contains("requestId"), "{cmd}: {error}");
        }

        let repo_path = repo_key(&crate::git::ops::canonical_existing(&repo).unwrap());
        let sub_path = repo_key(&repo.join("sub"));
        let opened = invoke(
            &window,
            "add_repository",
            serde_json::json!({"path": sub_path, "requestId": 11}),
        )
        .expect("add");
        assert_eq!(opened["summary"]["path"], repo_path);
        assert_eq!(opened["snapshot"]["branch"]["name"], "main");
        assert_eq!(opened["snapshot"]["branch"]["liveRemoteChecked"], false);
        assert!(opened["snapshot"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "file one.txt"));
        let generation = opened["generation"].as_u64().unwrap();
        let refreshed = invoke(
            &window,
            "refresh_status",
            serde_json::json!({"path": repo_path, "generation": generation, "requestId": 12}),
        )
        .expect("refresh");
        assert_eq!(refreshed["branch"]["name"], "main");
        let diff = invoke(
            &window,
            "load_diff",
            serde_json::json!({
                "path": repo_path,
                "relative": "file one.txt",
                "staged": false,
                "generation": generation,
                "requestId": 13
            }),
        )
        .expect("diff");
        assert!(diff["text"].as_str().unwrap().contains("+after"));
        let reopened = invoke(
            &window,
            "open_repository",
            serde_json::json!({"path": repo_path, "requestId": 14}),
        )
        .expect("open");
        assert_eq!(reopened["summary"]["path"], repo_path);
        let plain_path = repo_key(&plain);
        let created = invoke(
            &window,
            "create_repository",
            serde_json::json!({"path": plain_path, "requestId": 15}),
        )
        .expect("create");
        assert_eq!(created["summary"]["name"], "plain-dir");
        assert!(plain.join(".git").is_dir());
        assert_eq!(fs::read(plain.join("keep.txt")).unwrap(), b"same");
        backend.watches.stop();
    }
}
