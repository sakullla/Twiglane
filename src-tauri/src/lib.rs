mod atomic;
mod cliora;
mod error;
mod git;
mod measure;
mod model;
mod redact;
mod shutdown;
mod state;
mod update;
mod watch;

pub use measure::mark_process_start;

use update::update_install_supported;

#[cfg(test)]
mod security;
#[cfg(test)]
pub(crate) mod test_support;

#[cfg(all(test, feature = "performance-tests"))]
#[path = "../../scripts/performance/git.rs"]
mod performance_tests;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State, WindowEvent};

use crate::error::AppError;
use crate::git::ops::{self, Backend};
use crate::git::runner::RealRunner;
use crate::model::{
    AbortImpact, BranchState, CherryPickOutcome, CloneResult, CommitDetail, CommitPushReport,
    CommitResult, ConflictView, DiffResponse, DiscardResult, FileHistoryPage, GitInfo, HistoryPage,
    IgnoreOutcome, MergeComplete, MergePreview, MergeSession, OpenedRepository, PanelWidths,
    RecentRepo, RemoteState, RemoteTag, RepoChanged, RepositoryContentSearch, RepositoryDirectory,
    RepositoryFileContent, RepositoryPathSearch, RepositorySearchScope, StashApplyResult,
    StashSaveResult, StashState, StatusSnapshot, TagState, Theme, UndoResult,
};
use crate::shutdown::Shutdown;
use crate::state::{AppStore, PullIntegration};

pub fn run() {
    let shutdown = Shutdown::new();
    let shutdown_for_run = shutdown.clone();
    let app = tauri::Builder::default()
        // single-instance 必须最先注册：第二次启动只负责把链接转给正在跑的实例。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            bring_to_front(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            install_menu(app)?;
            register_deep_link(app);
            // macOS 不经过 single-instance：运行中的实例直接从系统收到链接事件，在这里把窗口带到前台。
            // 其他平台两条路径都会触发，重复聚焦无副作用。
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |_event| bring_to_front(&handle));
            }
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
            // 启动 20 秒后静默检查一次更新：失败不打断当前版本使用。
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                update::auto_check_update(&update_handle).await;
            });
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
            file_preview,
            repository_directory,
            repository_file_content,
            repository_path_search,
            repository_content_search,
            repository_review_token,
            stage_files,
            unstage_files,
            stage_hunks,
            stage_lines,
            commit_changes,
            clone_repository,
            remote_state,
            add_remote,
            set_remote_url,
            fetch_remote,
            pull_fast_forward,
            push_branch,
            push_to_remote,
            track_remote_as,
            cancel_remote,
            repo_heads,
            remove_worktree,
            publish_branch,
            associate_upstream,
            commit_and_push,
            branch_state,
            branch_list,
            create_branch,
            create_branch_from,
            rename_branch,
            reveal_path,
            open_path,
            ignore_path,
            switch_branch,
            delete_branch,
            delete_remote_branch,
            tag_state,
            tag_remote_state,
            create_tag,
            delete_tag,
            push_tag,
            history_page,
            commit_detail,
            commit_file_diff,
            compare_file_diff,
            commit_branches,
            file_history,
            cherry_pick_commits,
            checkout_commit,
            stash_state,
            save_stash,
            apply_stash,
            delete_stash,
            merge_preview,
            start_merge,
            merge_session,
            conflict_view,
            resolve_conflict,
            complete_merge,
            abort_merge,
            undo_commit,
            discard_changes,
            set_theme,
            set_pull_integration,
            set_branch_groups,
            set_files_view,
            set_panel_widths,
            save_draft,
            cancel_reads,
            measure_probe,
            measure_sample,
            measure_finish,
            measure_wait,
            update_install_supported,
            cliora_review_request,
            cliora_review_receipt,
            cliora_review_return
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

/// 已校验的 v1 审查请求。前端只按 worktree_path 打开，不再自己解析一次链接。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClioraReviewRequest {
    review_id: String,
    session_id: String,
    worktree_path: String,
    baseline: Option<String>,
}

/// 解析并校验 cliora 的 v1 审查链接。纯解析：不打开仓库、不读 Git、不写任何状态。
#[tauri::command]
fn cliora_review_request(url: String) -> Result<ClioraReviewRequest, AppError> {
    let request = cliora::parse_review_url(&url)?;
    Ok(ClioraReviewRequest {
        review_id: request.review_id,
        session_id: request.session_id,
        worktree_path: request.worktree_path,
        baseline: request.baseline,
    })
}

/// 回送接收结果。accepted 为假时必须带协议里的稳定错误码。
#[tauri::command(rename_all = "camelCase")]
fn cliora_review_receipt<R: Runtime>(
    app: AppHandle<R>,
    review_id: String,
    session_id: String,
    accepted: bool,
    reason: Option<String>,
) -> Result<(), AppError> {
    let url = if accepted {
        cliora::accepted_url(&review_id, &session_id)?
    } else {
        let reason = reason.unwrap_or_else(|| "open_failed".to_string());
        cliora::rejected_url(&review_id, &session_id, &reason)?
    };
    // 回执只是告诉 cliora 结果，用户此刻要在 Twiglane 里审查：不把 cliora 切到前台。
    cliora::notify_cliora(&app, &url)
}

/// 回送返回事件：只声明结果，不带原始 Git 输出；返回本身不写仓库。
#[tauri::command(rename_all = "camelCase")]
fn cliora_review_return<R: Runtime>(
    app: AppHandle<R>,
    review_id: String,
    session_id: String,
    outcome: String,
    head_oid: Option<String>,
) -> Result<(), AppError> {
    let outcome = match outcome.as_str() {
        "reviewed" => cliora::Outcome::Reviewed,
        "committed" => cliora::Outcome::Committed,
        "merged" => cliora::Outcome::Merged,
        _ => {
            return Err(AppError::new(
                cliora::INVALID_RECEIPT,
                "返回结果只能是 reviewed、committed 或 merged，未回送任何结果。",
            ))
        }
    };
    let url = cliora::returned_url(&review_id, &session_id, outcome, head_oid.as_deref())?;
    cliora::open_in_cliora(&app, &url)
}

/// 通过链接唤起时把主窗口带到前台：先显示、取消最小化，再请求焦点。
pub(crate) fn bring_to_front<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 登记 scheme。安装包由 deep-link 插件的安装脚本写入，所以 Windows 只有 debug 构建
/// （开发模式）才运行期登记，release 不再覆盖安装器写好的登记；Linux 没有安装器负责登记，
/// 任何构建都注册。失败只影响链接入口，不影响仓库编辑，所以不中断启动。
fn register_deep_link<R: Runtime>(app: &tauri::App<R>) {
    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        if let Err(error) = app.deep_link().register_all() {
            eprintln!("cliora 审查 scheme 登记失败：{error}");
        }
    }
    #[cfg(not(any(target_os = "linux", all(debug_assertions, windows))))]
    {
        let _ = app;
    }
}
fn install_menu<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let search = MenuItem::with_id(app, "focus-search", "搜索仓库", true, Some("CmdOrCtrl+K"))?;
    let commit = MenuItem::with_id(
        app,
        "commit-local",
        "提交到本地",
        true,
        Some("CmdOrCtrl+Enter"),
    )?;
    // 系统编辑动作不进 menu_event_name，因此不会打开搜索，也不会提交。
    let undo = PredefinedMenuItem::undo(app, Some("撤销"))?;
    let redo = PredefinedMenuItem::redo(app, Some("重做"))?;
    let cut = PredefinedMenuItem::cut(app, Some("剪切"))?;
    let copy = PredefinedMenuItem::copy(app, Some("复制"))?;
    let paste = PredefinedMenuItem::paste(app, Some("粘贴"))?;
    let select_all = PredefinedMenuItem::select_all(app, Some("全选"))?;
    let edit = Submenu::with_id_and_items(
        app,
        "app-edit",
        "编辑",
        true,
        &[&undo, &redo, &cut, &copy, &paste, &select_all],
    )?;
    let menu = Menu::with_items(app, &[&search, &commit, &edit])?;
    app.set_menu(menu)?;
    app.on_menu_event(|app_handle, event| {
        let Some(name) = menu_event_name(event.id().0.as_str()) else {
            return;
        };
        let _ = app_handle.emit(name, ());
    });
    Ok(())
}

/// 只有搜索和提交是应用命令。编辑项的 id 落在这里会得到 None。
fn menu_event_name(id: &str) -> Option<&'static str> {
    match id {
        "focus-search" => Some("menu-search"),
        "commit-local" => Some("menu-commit"),
        _ => None,
    }
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

#[cfg(test)]
mod menu_edit {
    use super::{install_menu, menu_event_name};
    use tauri::menu::MenuItemKind;
    use tauri::Runtime;

    fn walk<R: Runtime>(items: &[MenuItemKind<R>], found: &mut Vec<(String, String, bool)>) {
        for item in items {
            match item {
                MenuItemKind::MenuItem(entry) => {
                    found.push((entry.id().0.clone(), entry.text().unwrap(), false));
                }
                MenuItemKind::Predefined(entry) => {
                    found.push((entry.id().0.clone(), entry.text().unwrap(), true));
                }
                MenuItemKind::Submenu(entry) => {
                    found.push((entry.id().0.clone(), entry.text().unwrap(), false));
                    walk(&entry.items().unwrap(), found);
                }
                _ => {}
            }
        }
    }

    #[test]
    fn system_edit_items_do_not_open_search_or_commit() {
        assert_eq!(menu_event_name("focus-search"), Some("menu-search"));
        assert_eq!(menu_event_name("commit-local"), Some("menu-commit"));
        for id in [
            "app-edit",
            "undo",
            "redo",
            "cut",
            "copy",
            "paste",
            "select_all",
        ] {
            assert_eq!(menu_event_name(id), None, "{id}");
        }

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("menu app");
        install_menu(&app).expect("install menu");
        let menu = app.menu().expect("app menu");
        let mut found = Vec::new();
        walk(&menu.items().expect("items"), &mut found);

        assert!(found.iter().any(|(id, text, predefined)| {
            id == "focus-search" && text == "搜索仓库" && !predefined
        }));
        assert!(found.iter().any(|(id, text, predefined)| {
            id == "commit-local" && text == "提交到本地" && !predefined
        }));
        let edit: Vec<&str> = found
            .iter()
            .filter(|(_, text, _)| !text.is_empty())
            .skip_while(|(_, text, _)| text != "撤销")
            .take(6)
            .map(|(_, text, _)| text.as_str())
            .collect();
        assert_eq!(edit, ["撤销", "重做", "剪切", "复制", "粘贴", "全选"]);
        for label in ["撤销", "重做", "剪切", "复制", "粘贴", "全选"] {
            let (id, _, predefined) = found
                .iter()
                .find(|(_, text, _)| text == label)
                .unwrap_or_else(|| panic!("missing {label}"));
            assert!(predefined, "{label}");
            assert_ne!(id, "focus-search");
            assert_ne!(id, "commit-local");
            assert_eq!(menu_event_name(id), None);
        }
    }
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
async fn get_settings(state: State<'_, Arc<Backend>>) -> Result<ops::AppSettings, AppError> {
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
    context: Option<u32>,
    as_text: Option<bool>,
) -> Result<DiffResponse, AppError> {
    crate::git::changes::load_diff_with_context(
        state.inner(),
        &path,
        &relative,
        original.as_deref(),
        staged,
        generation,
        request_id,
        offset.unwrap_or(0),
        limit.unwrap_or(0),
        context.unwrap_or(3),
        as_text.unwrap_or(false),
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

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn stage_lines(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    original: Option<String>,
    staged: bool,
    lines: Vec<crate::model::DiffLineSelection>,
    snapshot: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::changes::stage_lines(
        state.inner(),
        &path,
        &relative,
        original.as_deref(),
        staged,
        &lines,
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
    credential: Option<crate::git::credential::HttpCredential>,
    request_id: u64,
) -> Result<CloneResult, AppError> {
    let backend = Arc::clone(state.inner());
    let mut cloned = crate::git::sync::clone_repository(
        &backend,
        &url,
        &parent,
        &name,
        credential.as_ref(),
        request_id,
    )
    .await?;
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
async fn push_to_remote(
    state: State<'_, Arc<Backend>>,
    path: String,
    remote: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::sync::push_to_remote(state.inner(), &path, &remote, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn track_remote_as(
    state: State<'_, Arc<Backend>>,
    path: String,
    remote_branch: String,
    local: String,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    crate::git::sync::track_remote_as(
        state.inner(),
        &path,
        &remote_branch,
        &local,
        generation,
        request_id,
    )
    .await
}

#[tauri::command]
fn cancel_remote(state: State<'_, Arc<Backend>>, path: String) -> Result<(), AppError> {
    crate::git::sync::cancel_remote(state.inner(), &path)
}

#[tauri::command]
async fn repo_heads(paths: Vec<String>) -> Result<Vec<crate::git::heads::RepoHead>, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::git::heads::repo_heads(&paths))
        .await
        .map_err(|_| AppError::new("cancelled", "读取仓库分支已中断。"))
}

#[tauri::command(rename_all = "camelCase")]
async fn remove_worktree(
    state: State<'_, Arc<Backend>>,
    path: String,
    force: bool,
    request_id: u64,
) -> Result<Vec<RecentRepo>, AppError> {
    crate::git::worktree::remove_worktree(state.inner(), &path, force, request_id).await
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
async fn file_preview(
    state: State<'_, Arc<Backend>>,
    path: String,
    source: crate::git::preview::PreviewSource,
    generation: u64,
    download: bool,
) -> Result<crate::git::preview::FilePreview, AppError> {
    crate::git::preview::file_preview(state.inner(), &path, &source, generation, download).await
}

#[tauri::command(rename_all = "camelCase")]
async fn repository_directory(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    include_ignored: bool,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryDirectory, AppError> {
    crate::git::files::repository_directory(
        state.inner(),
        &path,
        &relative,
        include_ignored,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn repository_file_content(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    offset: u64,
    limit: Option<usize>,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryFileContent, AppError> {
    crate::git::files::repository_file_content(
        state.inner(),
        &path,
        &relative,
        offset,
        limit,
        generation,
        request_id,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn repository_path_search(
    state: State<'_, Arc<Backend>>,
    path: String,
    query: String,
    directory: Option<String>,
    include_ignored: bool,
    limit: Option<usize>,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryPathSearch, AppError> {
    crate::git::files::repository_path_search(
        state.inner(),
        &path,
        &query,
        directory.as_deref(),
        include_ignored,
        limit,
        generation,
        request_id,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn repository_content_search(
    state: State<'_, Arc<Backend>>,
    path: String,
    query: String,
    scope: RepositorySearchScope,
    include_ignored: bool,
    limit: Option<usize>,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryContentSearch, AppError> {
    crate::git::files::repository_content_search(
        state.inner(),
        &path,
        &query,
        scope,
        include_ignored,
        limit,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn repository_review_token(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::RepositoryReviewToken, AppError> {
    crate::git::files::repository_review_token(
        state.inner(),
        &path,
        &relative,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn branch_list(
    state: State<'_, Arc<Backend>>,
    path: String,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::BranchListing, AppError> {
    crate::git::sync::branch_list(state.inner(), &path, generation, request_id).await
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

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn create_branch_from(
    state: State<'_, Arc<Backend>>,
    path: String,
    name: String,
    start: String,
    checkout: bool,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    crate::git::sync::create_branch_from(
        state.inner(),
        &path,
        &name,
        &start,
        checkout,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn rename_branch(
    state: State<'_, Arc<Backend>>,
    path: String,
    old: String,
    new: String,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    crate::git::sync::rename_branch(state.inner(), &path, &old, &new, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn reveal_path(path: String, relative: String) -> Result<(), AppError> {
    crate::git::workspace::reveal_path(&path, &relative)
}

#[tauri::command(rename_all = "camelCase")]
async fn open_path(path: String, relative: String) -> Result<(), AppError> {
    crate::git::workspace::open_path(&path, &relative)
}

#[tauri::command(rename_all = "camelCase")]
async fn ignore_path(
    state: State<'_, Arc<Backend>>,
    path: String,
    pattern: String,
    local: bool,
    generation: u64,
    request_id: u64,
) -> Result<IgnoreOutcome, AppError> {
    let written = crate::git::workspace::ignore_path(
        state.inner(),
        &path,
        &pattern,
        local,
        generation,
        request_id,
    )
    .await?;
    let snapshot = ops::refresh_status(
        state.inner(),
        &path,
        written.generation,
        crate::git::schedule::internal_request_id(),
    )
    .await?;
    Ok(IgnoreOutcome {
        snapshot,
        note: written.note,
    })
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

#[tauri::command(rename_all = "camelCase")]
async fn tag_state(
    state: State<'_, Arc<Backend>>,
    path: String,
    generation: u64,
    request_id: u64,
) -> Result<TagState, AppError> {
    crate::git::tags::tag_state(state.inner(), &path, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn tag_remote_state(
    state: State<'_, Arc<Backend>>,
    path: String,
    remote: String,
) -> Result<Vec<RemoteTag>, AppError> {
    crate::git::tags::tag_remote_state(state.inner(), &path, &remote).await
}

#[tauri::command(rename_all = "camelCase")]
async fn create_tag(
    state: State<'_, Arc<Backend>>,
    path: String,
    name: String,
    target: String,
    message: String,
    generation: u64,
    request_id: u64,
) -> Result<TagState, AppError> {
    crate::git::tags::create_tag(
        state.inner(),
        &path,
        &name,
        &target,
        &message,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn delete_tag(
    state: State<'_, Arc<Backend>>,
    path: String,
    name: String,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<TagState, AppError> {
    crate::git::tags::delete_tag(state.inner(), &path, &name, confirm, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn push_tag(
    state: State<'_, Arc<Backend>>,
    path: String,
    remote: String,
    name: String,
    generation: u64,
    request_id: u64,
) -> Result<TagState, AppError> {
    crate::git::tags::push_tag(state.inner(), &path, &remote, &name, generation, request_id).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn history_page(
    state: State<'_, Arc<Backend>>,
    path: String,
    query: String,
    offset: u32,
    generation: u64,
    request_id: u64,
    scope: Option<String>,
    author: Option<String>,
    since: Option<i64>,
    until: Option<i64>,
    path_filter: Option<String>,
) -> Result<HistoryPage, AppError> {
    let request = crate::git::history::HistoryRequest {
        query,
        offset,
        scope: scope.unwrap_or_else(|| "current".to_string()),
        author: author.unwrap_or_default(),
        since,
        until,
        path: path_filter.unwrap_or_default(),
    };
    crate::git::history::history_page(state.inner(), &path, &request, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn commit_detail(
    state: State<'_, Arc<Backend>>,
    path: String,
    oid: String,
    parent: Option<String>,
    generation: u64,
    request_id: u64,
) -> Result<CommitDetail, AppError> {
    crate::git::history::commit_detail(
        state.inner(),
        &path,
        &oid,
        parent.as_deref(),
        generation,
        request_id,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn commit_file_diff(
    state: State<'_, Arc<Backend>>,
    path: String,
    oid: String,
    parent: Option<String>,
    relative: String,
    generation: u64,
    request_id: u64,
    offset: Option<u32>,
    limit: Option<u32>,
    context: Option<u32>,
    as_text: Option<bool>,
) -> Result<DiffResponse, AppError> {
    crate::git::history::commit_file_diff(
        state.inner(),
        &path,
        &oid,
        parent.as_deref(),
        &relative,
        generation,
        request_id,
        offset.unwrap_or(0),
        limit.unwrap_or(0),
        context.unwrap_or(3),
        as_text.unwrap_or(false),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn compare_file_diff(
    state: State<'_, Arc<Backend>>,
    path: String,
    base: String,
    head: String,
    relative: String,
    generation: u64,
    request_id: u64,
    offset: Option<u32>,
    limit: Option<u32>,
    context: Option<u32>,
) -> Result<DiffResponse, AppError> {
    crate::git::history::compare_file_diff(
        state.inner(),
        &path,
        &base,
        &head,
        &relative,
        generation,
        request_id,
        offset.unwrap_or(0),
        limit.unwrap_or(0),
        context.unwrap_or(3),
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn commit_branches(
    state: State<'_, Arc<Backend>>,
    path: String,
    oid: String,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::CommitBranches, AppError> {
    crate::git::history::commit_branches(state.inner(), &path, &oid, generation, request_id).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn file_history(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    offset: u32,
    generation: u64,
    request_id: u64,
    scope: Option<String>,
    author: Option<String>,
    since: Option<i64>,
    until: Option<i64>,
    query: Option<String>,
) -> Result<FileHistoryPage, AppError> {
    let request = crate::git::history::HistoryRequest {
        query: query.unwrap_or_default(),
        offset,
        scope: scope.unwrap_or_else(|| "current".to_string()),
        author: author.unwrap_or_default(),
        since,
        until,
        path: String::new(),
    };
    crate::git::history::file_history(
        state.inner(),
        &path,
        &relative,
        &request,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn cherry_pick_commits(
    state: State<'_, Arc<Backend>>,
    path: String,
    oids: Vec<String>,
    generation: u64,
    request_id: u64,
) -> Result<CherryPickOutcome, AppError> {
    crate::git::resolve::cherry_pick_commits(state.inner(), &path, &oids, generation, request_id)
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn checkout_commit(
    state: State<'_, Arc<Backend>>,
    path: String,
    oid: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::resolve::checkout_commit(state.inner(), &path, &oid, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn stash_state(
    state: State<'_, Arc<Backend>>,
    path: String,
    include_untracked: bool,
    generation: u64,
    request_id: u64,
) -> Result<StashState, AppError> {
    crate::git::history::stash_state(
        state.inner(),
        &path,
        include_untracked,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn save_stash(
    state: State<'_, Arc<Backend>>,
    path: String,
    include_untracked: bool,
    message: String,
    generation: u64,
    request_id: u64,
) -> Result<StashSaveResult, AppError> {
    crate::git::history::save_stash(
        state.inner(),
        &path,
        include_untracked,
        &message,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn apply_stash(
    state: State<'_, Arc<Backend>>,
    path: String,
    oid: String,
    generation: u64,
    request_id: u64,
) -> Result<StashApplyResult, AppError> {
    crate::git::history::apply_stash(state.inner(), &path, &oid, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn merge_preview(
    state: State<'_, Arc<Backend>>,
    path: String,
    source: String,
    target: Option<String>,
    generation: u64,
    request_id: u64,
) -> Result<MergePreview, AppError> {
    crate::git::resolve::merge_preview(
        state.inner(),
        &path,
        &source,
        target.as_deref(),
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn start_merge(
    state: State<'_, Arc<Backend>>,
    path: String,
    source: String,
    target: Option<String>,
    mode: Option<String>,
    generation: u64,
    request_id: u64,
) -> Result<MergeSession, AppError> {
    crate::git::resolve::start_merge(
        state.inner(),
        &path,
        &source,
        target.as_deref(),
        mode.as_deref(),
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn merge_session(
    state: State<'_, Arc<Backend>>,
    path: String,
    generation: u64,
    request_id: u64,
) -> Result<MergeSession, AppError> {
    crate::git::resolve::merge_session(state.inner(), &path, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn conflict_view(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    generation: u64,
    request_id: u64,
) -> Result<ConflictView, AppError> {
    crate::git::resolve::conflict_view(state.inner(), &path, &relative, generation, request_id)
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn resolve_conflict(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    choice: String,
    content: Option<String>,
    generation: u64,
    request_id: u64,
) -> Result<MergeSession, AppError> {
    crate::git::resolve::resolve_conflict(
        state.inner(),
        &path,
        &relative,
        &choice,
        content,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn complete_merge(
    state: State<'_, Arc<Backend>>,
    path: String,
    message: String,
    generation: u64,
    request_id: u64,
) -> Result<MergeComplete, AppError> {
    crate::git::resolve::complete_merge(state.inner(), &path, &message, generation, request_id)
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn abort_merge(
    state: State<'_, Arc<Backend>>,
    path: String,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<AbortImpact, AppError> {
    crate::git::resolve::abort_merge(state.inner(), &path, confirm, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn undo_commit(
    state: State<'_, Arc<Backend>>,
    path: String,
    expected_head: String,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<UndoResult, AppError> {
    crate::git::resolve::undo_commit(
        state.inner(),
        &path,
        &expected_head,
        confirm,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn discard_changes(
    state: State<'_, Arc<Backend>>,
    path: String,
    paths: Vec<String>,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<DiscardResult, AppError> {
    crate::git::resolve::discard_changes(
        state.inner(),
        &path,
        &paths,
        confirm,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn delete_stash(
    state: State<'_, Arc<Backend>>,
    path: String,
    oid: String,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<StashState, AppError> {
    crate::git::history::delete_stash(state.inner(), &path, &oid, confirm, generation, request_id)
        .await
}

#[tauri::command]
fn set_theme(state: State<'_, Arc<Backend>>, theme: Theme) -> Result<(), AppError> {
    ops::set_theme(state.inner(), theme)
}

#[tauri::command(rename_all = "camelCase")]
fn set_pull_integration(
    state: State<'_, Arc<Backend>>,
    pull_integration: PullIntegration,
) -> Result<(), AppError> {
    ops::set_pull_integration(state.inner(), pull_integration)
}

#[tauri::command(rename_all = "camelCase")]
fn set_branch_groups(state: State<'_, Arc<Backend>>, branch_groups: bool) -> Result<(), AppError> {
    ops::set_branch_groups(state.inner(), branch_groups)
}

#[tauri::command(rename_all = "camelCase")]
fn set_files_view(state: State<'_, Arc<Backend>>, files_view: bool) -> Result<(), AppError> {
    ops::set_files_view(state.inner(), files_view)
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

#[tauri::command]
fn cancel_reads(state: State<'_, Arc<Backend>>) -> Result<(), AppError> {
    state.scheduler.cancel_reads();
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MeasureProbe {
    enabled: bool,
    elapsed_ms: u128,
    script: Option<serde_json::Value>,
}

#[tauri::command]
fn measure_probe() -> Result<MeasureProbe, AppError> {
    let enabled = measure::directory().is_some();
    let script = if enabled {
        measure::load_script().map_err(|message| AppError::new("measure", message))?
    } else {
        None
    };
    Ok(MeasureProbe {
        enabled,
        elapsed_ms: measure::elapsed_ms(),
        script,
    })
}

#[tauri::command]
fn measure_sample(name: String, detail: serde_json::Value) -> Result<(), AppError> {
    if measure::directory().is_none() {
        return Err(AppError::new("measure", "测量模式未开启。"));
    }
    measure::append_sample(&name, &detail).map_err(|message| AppError::new("measure", message))
}

#[tauri::command]
async fn measure_wait(ms: u64) -> Result<(), AppError> {
    if measure::directory().is_none() {
        return Err(AppError::new("measure", "测量模式未开启。"));
    }
    tokio::time::sleep(std::time::Duration::from_millis(ms.min(120_000))).await;
    Ok(())
}

#[tauri::command]
fn measure_finish(app: AppHandle) -> Result<(), AppError> {
    if measure::directory().is_none() {
        return Err(AppError::new("measure", "测量模式未开启。"));
    }
    measure::append_sample("finished", &serde_json::json!({}))
        .map_err(|message| AppError::new("measure", message))?;
    app.exit(0);
    Ok(())
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
    const LIB_SOURCE: &str = include_str!("lib.rs");
    const BUILD_SOURCE: &str = include_str!("../build.rs");
    const CAPABILITIES: &str = include_str!("../capabilities/default.json");

    fn handler_commands() -> Vec<String> {
        let start = LIB_SOURCE
            .find("generate_handler![")
            .expect("invoke handler")
            + "generate_handler![".len();
        let end = start + LIB_SOURCE[start..].find(']').expect("handler end");
        LIB_SOURCE[start..end]
            .split(',')
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect()
    }

    /// 注册到 invoke handler 的命令必须同时进入 app manifest 与主窗口 capability，
    /// 否则前端调用会在运行时报 `Command xxx not allowed by ACL`。
    #[test]
    fn every_handler_command_is_allowed_by_acl() {
        let commands = handler_commands();
        assert!(commands.len() > 40, "{commands:?}");
        let mut missing = Vec::new();
        for command in &commands {
            if !BUILD_SOURCE.contains(&format!("\"{command}\"")) {
                missing.push(format!("build.rs: {command}"));
            }
            let permission = format!("\"allow-{}\"", command.replace('_', "-"));
            if !CAPABILITIES.contains(&permission) {
                missing.push(format!("capabilities/default.json: {permission}"));
            }
        }
        assert!(missing.is_empty(), "命令未放行：{missing:#?}");
    }

    /// 联动入口的静态注册：scheme 写在 tauri.conf.json，出/入站命令必须在 handler、
    /// app manifest 与 capability 三处齐全，否则运行时会被 ACL 拒绝或系统不会转交链接。
    #[test]
    fn cliora_review_entry_is_registered() {
        let config = include_str!("../tauri.conf.json");
        assert!(
            config.contains("\"deep-link\""),
            "tauri.conf.json 缺少 deep-link 配置"
        );
        assert!(
            config.contains(&format!("\"{}\"", crate::cliora::SCHEME)),
            "tauri.conf.json 缺少 {} scheme",
            crate::cliora::SCHEME
        );
        assert!(
            CAPABILITIES.contains("\"deep-link:default\""),
            "capabilities 缺少 deep-link:default",
        );
        let commands = handler_commands();
        for command in [
            "cliora_review_request",
            "cliora_review_receipt",
            "cliora_review_return",
        ] {
            assert!(
                commands.iter().any(|name| name == command),
                "{command} 没有注册到 invoke handler",
            );
        }
    }

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
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .expect("local origin"),
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
            "stage_lines",
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
            "tag_state",
            "create_tag",
            "delete_tag",
            "push_tag",
            "history_page",
            "commit_detail",
            "commit_file_diff",
            "file_history",
            "repository_path_search",
            "repository_content_search",
            "repository_review_token",
            "stash_state",
            "save_stash",
            "apply_stash",
            "delete_stash",
            "merge_preview",
            "start_merge",
            "merge_session",
            "conflict_view",
            "resolve_conflict",
            "complete_merge",
            "abort_merge",
            "undo_commit",
            "discard_changes",
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
                super::stage_lines,
                super::commit_changes,
                super::clone_repository,
                super::fetch_remote,
                super::commit_and_push,
                super::delete_branch,
                super::history_page,
                super::delete_stash,
                super::merge_session,
                super::abort_merge,
                super::undo_commit,
                super::discard_changes
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
                "stage_lines",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "relative": "a",
                    "staged": false,
                    "lines": [{"hunkIndex": 0, "kind": "add", "oldNo": null, "newNo": 3}],
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
            (
                "history_page",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "query": "",
                    "offset": 0,
                    "generation": 1,
                    "request_id": 1
                }),
            ),
            (
                "delete_stash",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "oid": "abc",
                    "confirm": false,
                    "generation": 1,
                    "request_id": 1
                }),
            ),
            (
                "merge_session",
                serde_json::json!({"path": "/tmp/unused", "generation": 1, "request_id": 1}),
            ),
            (
                "abort_merge",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "confirm": false,
                    "generation": 1,
                    "request_id": 1
                }),
            ),
            (
                "undo_commit",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "expectedHead": "abc",
                    "confirm": false,
                    "generation": 1,
                    "request_id": 1
                }),
            ),
            (
                "discard_changes",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "paths": ["a"],
                    "confirm": false,
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
