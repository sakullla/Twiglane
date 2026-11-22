mod atomic;
mod change_request;
mod cliora;
mod error;
mod git;
mod measure;
mod model;
mod redact;
mod remote_ssh;
mod remote_ssh_sync;
mod remote_worktree;
pub mod remote_worktree_transport;
mod shutdown;
mod state;
mod terminal;
mod update;
mod watch;
mod workspaces;

pub use measure::mark_process_start;

use update::update_install_supported;

#[cfg(test)]
mod security;
#[cfg(any(test, feature = "benchmarks"))]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod test_support;

#[cfg(feature = "benchmarks")]
#[path = "../../scripts/benchmarks/git.rs"]
mod benchmarks;
#[cfg(feature = "benchmarks")]
pub use benchmarks::run as benchmark_git;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State, WindowEvent};

use crate::error::AppError;
use crate::git::ops::{self, Backend};
use crate::git::runner::RealRunner;
use crate::model::{
    AbortImpact, AmendOutcome, BatchDeleteResult, BranchState, CherryPickOutcome, CloneResult, CommitDetail,
    CommitPushReport, CommitResult, ConflictView, DiffResponse, DiscardResult, FileHistoryPage,
    GitInfo, HistoryPage, IgnoreOutcome, MergeComplete, MergePreview, MergeSession,
    OpenedRepository, PanelWidths, RecentRepo, RemoteState, RemoteTag, RepoChanged,
    RepositoryContentSearch, RepositoryDirectory, RepositoryEditSnapshot, RepositoryFileContent,
    RepositoryPathSearch, RepositorySearchScope, RevertOutcome,
    StashApplyResult, StashSaveResult, StashState, StatusSnapshot, TagState, Theme, UndoResult,
};
use crate::shutdown::Shutdown;
use crate::state::{AppStore, PullIntegration, TerminalPrefs};
use crate::terminal::{
    TerminalActivity, TerminalCloseRequested, TerminalManager, TerminalProfile, TerminalSnapshot,
};

pub fn run() {
    // host-sync helper 必须在 Tauri 之前分流：来源应用已退出也要能完成一次同步会话。
    if remote_ssh_sync::helper_entry() {
        return;
    }
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
            app.manage(Arc::new(workspaces::Discovery::default()));
            let store = AppStore::open(dir.join("state.json"));
            let backend = Arc::new(Backend::new(
                store,
                RealRunner::default(),
                Arc::new(shutdown),
            ));
            app.manage(backend);
            app.manage(Arc::new(remote_worktree::RemoteWorktrees::new(dir.join("remote-worktrees"))));
            // Twiglane 自有 SSH 主机簿：产物目录随发行包，测试/开发可用环境变量指定。
            let agent_artifacts = remote_ssh::RemoteSsh::artifacts_for(app.handle(), &dir);
            app.manage(Arc::new(remote_ssh::RemoteSsh::new(agent_artifacts)));
            // host-sync 会话与 helper 指向同一目录：桌面退出后仍能按 sessionRef 结算。
            app.manage(Arc::new(remote_ssh_sync::HostSync::new(
                dir.join("host-sync"),
            )));
            // 终端独立于 Git 调度器与当前仓库监听：按仓库保存在应用内存中。
            app.manage(TerminalManager::new(Arc::new(terminal::AppEvents::new(
                app.handle().clone(),
            ))));
            // cliora 审查来源只在内存里：返回时按它读取真实工作区状态。
            app.manage(cliora::ReviewSources::default());
            // 启动 20 秒后静默检查一次更新：失败不打断当前版本使用。
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                update::auto_check_update(&update_handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            remote_worktree::review::remote_review_begin,
            remote_worktree::review::remote_review_accept,
            remote_worktree::review::remote_review_end,
            remote_worktree::review::remote_review_return,
            remote_worktree::remote_worktree_targets,
            remote_worktree::remote_worktree_open,
            remote_worktree::remote_worktree_cancel_open,
            remote_worktree::remote_worktree_close,
            remote_worktree::remote_worktree_status,
            remote_worktree::remote_worktree_diff,
            remote_worktree::remote_worktree_write,
            remote_worktree::remote_worktree_recover,
            remote_ssh::remote_ssh_settings,
            remote_ssh::set_remote_ssh_enabled,
            remote_ssh::remote_ssh_save_target,
            remote_ssh::remote_ssh_delete_target,
            remote_ssh::remote_ssh_set_password,
            remote_ssh::remote_ssh_delete_password,
            remote_ssh::remote_ssh_test,
            remote_ssh::remote_ssh_cancel,
            remote_ssh::remote_ssh_install_agent,
            detect_git,
            set_git_executable,
            clear_git_executable,
            get_settings,
            workspace_list,
            workspace_create,
            workspace_preview,
            workspace_attach,
            workspace_update,
            workspace_refresh,
            workspace_publish,
            workspace_favorite,
            workspace_candidates,
            workspace_discover,
            workspace_cancel_discovery,
            workspace_delete,
            workspace_preview_link,
            workspace_open_in_cliora,
            add_repository,
            create_repository,
            open_repository,
            close_repository,
            forget_recent,
            refresh_status,
            load_diff,
            file_preview,
            repository_document,
            document_resource,
            open_document_url,
            document_remote_image,
            cancel_document_resources,
            repository_directory,
            repository_file_content,
            repository_edit_snapshot,
            repository_edit_save,
            repository_create_entry,
            repository_copy_entry,
            repository_move_entry,
            repository_delete_entry,
            repository_delete_entries,
            repository_path_search,
            repository_content_search,
            repository_review_token,
            task_review,
            load_task_diff,
            task_review_token,
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
            fetch_branches,
            pull_fast_forward,
            push_branch,
            push_to_remote,
            track_remote_as,
            cancel_remote,
            repo_heads,
            worktree_overview,
            remove_worktree,
            publish_branch,
            associate_upstream,
            set_upstream,
            commit_and_push,
            branch_state,
            branch_list,
            branch_tracking,
            update_branch,
            push_local_branch,
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
            compare_files,
            commit_branches,
            file_history,
            cherry_pick_commits,
            revert_commits,
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
            amend_commit,
            discard_changes,
            set_theme,
            set_pull_integration,
            set_branch_groups,
            set_files_view,
            set_change_requests_enabled,
            change_request_prepare,
            change_request_create,
            change_request_token_status,
            change_request_set_token,
            change_request_delete_token,
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
            cliora_review_return,
            cliora_review_forget,
            cliora_review_sources,
            terminal_profiles,
            terminal_list,
            terminal_create,
            terminal_attach,
            terminal_restart,
            terminal_close,
            set_terminal_prefs,
            terminal_write,
            terminal_resize,
            terminate_terminals
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
        route_run_event(app_handle, &event, &shutdown_for_run);
    });
}

/// 已校验的 v2/v3 审查请求。前端只按 worktree_path 打开，不再自己解析一次链接。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClioraReviewRequest {
    protocol_version: u8,
    workspace_id: Option<String>,
    repository_id: Option<String>,
    workspace_name: Option<String>,
    review_id: String,
    session_id: String,
    worktree_path: String,
    baseline: Option<String>,
}

/// 解析并校验 cliora 的 v2/v3 审查链接。不打开仓库、不读 Git、不落盘；校验通过的
/// reviewId → 工作树只在内存里暂存为待定。前端此时还没决定是否接受这条链接，
/// 要等 accepted 回执才成为返回时读取真实工作区状态的来源。
#[tauri::command]
fn cliora_review_request(
    sources: State<'_, cliora::ReviewSources>,
    url: String,
) -> Result<ClioraReviewRequest, AppError> {
    let request = cliora::parse_review_url(&url)?;
    sources.stage_request(&request)?;
    Ok(ClioraReviewRequest {
        protocol_version: request.protocol_version,
        workspace_id: request.workspace_id,
        repository_id: request.repository_id,
        workspace_name: request.workspace_name,
        review_id: request.review_id,
        session_id: request.session_id,
        worktree_path: request.worktree_path,
        baseline: request.baseline,
    })
}

/// 回送接收结果。accepted 为假时必须带协议里的稳定错误码。
///
/// 接受时把这条链接的待定记录提升为正式来源（同一 reviewId 已有正式来源时不覆盖）；
/// 拒绝时丢掉待定记录。被忽略、被拒绝或打开失败的链接因此不会改写当前审查的来源。
#[tauri::command(rename_all = "camelCase")]
fn cliora_review_receipt<R: Runtime>(
    app: AppHandle<R>,
    sources: State<'_, cliora::ReviewSources>,
    review_id: String,
    session_id: String,
    accepted: bool,
    reason: Option<String>,
) -> Result<(), AppError> {
    let request = sources.request_for(&review_id, &session_id, false)?;
    let url = if accepted {
        let path = ops::canonical_existing(std::path::Path::new(&request.worktree_path))?;
        let url = cliora::source_event_url(&request, None, cliora::accepted_url(&review_id, &session_id)?)?;
        sources.accept_path(&review_id, &session_id, path.to_string_lossy().into_owned())?;
        url
    } else {
        let reason = reason.unwrap_or_else(|| "open_failed".to_string());
        let url = cliora::source_event_url(&request, None, cliora::rejected_url(&review_id, &session_id, &reason)?)?;
        sources.reject(&review_id, &session_id);
        url
    };
    // 回执只是告诉 cliora 结果，用户此刻要在 Twiglane 里审查：不把 cliora 切到前台。
    cliora::notify_cliora(&app, &url)
}

/// Hydrate the running process's bounded source state after a webview reload. No disk restore.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClioraReviewSources {
    sources: Vec<cliora::ReviewSourceSnapshot>,
    expired_pending: usize,
}
#[tauri::command(rename_all = "camelCase")]
fn cliora_review_sources(sources: State<'_, cliora::ReviewSources>, reset_pending: Option<bool>) -> ClioraReviewSources {
    let expired_pending = if reset_pending == Some(true) { sources.expire_pending() } else { 0 };
    ClioraReviewSources { sources: sources.snapshots(), expired_pending }
}

/// Explicitly release a source; this does not close a repository or discard any draft.
#[tauri::command(rename_all = "camelCase")]
fn cliora_review_forget(sources: State<'_, cliora::ReviewSources>, review_id: String, session_id: String) -> Result<(), AppError> {
    sources.forget(&review_id, &session_id)
}

/// 返回后告诉前端这次实际发送的工作区状态，提示据此如实说明；uncommitted 只在读到时有值。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClioraReturnSent {
    worktree_state: &'static str,
    uncommitted: Option<u32>,
}

/// 按审查来源工作树读一次真实 `git status`，返回未提交文件数。Git 不可用、非零退出或
/// 读不懂输出都返回 None（声明为 unknown），不当作干净。只读，不写仓库。
async fn cliora_uncommitted_files(backend: &Backend, worktree: &std::path::Path) -> Option<usize> {
    let git = ops::require_git(backend).await.ok()?;
    let root = ops::canonical_existing(worktree).ok()?;
    // Match open_repository's root requirement. Git must not walk up to a parent after .git disappears.
    if !root.join(".git").exists() { return None; }
    let (program, args) = crate::git::command::status_command(&git.path, &root);
    let scheduled = ops::run_git(
        backend,
        &ops::repo_key(&root),
        crate::git::schedule::JobKind::Read,
        crate::git::schedule::internal_request_id(),
        program,
        args,
        None,
    )
    .await
    .ok()?;
    if scheduled.output.exit_code != 0 {
        return None;
    }
    crate::git::parse::parse_status(&scheduled.output.stdout)
        .ok()
        .map(|snapshot| snapshot.files.len())
}

/// 回送返回事件：Git 结果必须匹配原生成功缓存，工作区状态按来源工作树重新读取真实 Git 状态
/// 填写（读不到就是 unknown）。不带原始 Git 输出；返回本身不写仓库。
#[tauri::command(rename_all = "camelCase")]
async fn cliora_review_return<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<Backend>>,
    sources: State<'_, cliora::ReviewSources>,
    review_id: String,
    session_id: String,
    outcome: String,
    head_oid: Option<String>,
) -> Result<ClioraReturnSent, AppError> {
    let outcome = cliora::Outcome::parse(&outcome).ok_or_else(|| {
        AppError::new(
            cliora::INVALID_RECEIPT,
            "返回结果只能是 reviewed、committed 或 merged，未回送任何结果。",
        )
    })?;
    let request = sources.request_for(&review_id, &session_id, true)?;
    let actual = sources.snapshots().into_iter().find(|entry| entry.source.review_id == review_id).and_then(|entry| entry.result);
    let matches = match actual {
        Some(result) => result.outcome == outcome && Some(result.head_oid.as_str()) == head_oid.as_deref(),
        None => outcome == cliora::Outcome::Reviewed && head_oid.is_none(),
    };
    if !matches { return Err(AppError::new("source_result_changed", "来源的 Git 结果已变化或无法恢复，请重新选择来源后重试；未发送结果。")); }
    // Allocate on request entry, before async Git reads: a slow older request keeps its older revision.
    let revision = sources.next_result_revision(&review_id, &session_id)?;
    let uncommitted = cliora_uncommitted_files(state.inner(), std::path::Path::new(&request.worktree_path)).await;
    // A source explicitly closed during the read cannot send a late return.
    sources.request_for(&review_id, &session_id, true)?;
    let worktree_state = cliora::worktree_state_of(uncommitted);
    let declaration = cliora::ReviewReturn {
        review_id,
        session_id,
        outcome,
        head_oid,
        worktree_state,
        // 说明性元数据：只放应用版本这类短事实，cliora 保留但不据此改变 Git 结论。
        meta: vec![(
            "twiglane.version".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
        )],
    };
    let url = cliora::source_event_url(&request, Some(revision), cliora::returned_url(&declaration)?)?;
    sources.remember_return(revision, &declaration)?;
    cliora::open_in_cliora(&app, &url)?;
    Ok(ClioraReturnSent {
        worktree_state: worktree_state.as_str(),
        uncommitted: uncommitted.map(|count| u32::try_from(count).unwrap_or(u32::MAX)),
    })
}

/// 通过链接唤起时把主窗口带到前台：先显示、取消最小化，再请求焦点。
pub(crate) fn bring_to_front<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Windows 的 scheme 统一由安装器登记，debug 和 release 启动都不覆盖，
/// 避免开发构建把正式版的 twiglane:// 入口劫持到 target/debug。
/// Linux 没有安装器负责登记，仍在运行期注册。失败只影响链接入口，不中断启动。
fn register_deep_link<R: Runtime>(app: &tauri::App<R>) {
    #[cfg(target_os = "linux")]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        if let Err(error) = app.deep_link().register_all() {
            eprintln!("cliora 审查 scheme 登记失败：{error}");
        }
    }
    #[cfg(not(target_os = "linux"))]
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
    use super::menu_event_name;

    #[test]
    fn system_edit_items_do_not_open_search_or_commit() {
        assert_eq!(menu_event_name("focus-search"), Some("menu-search"));
        assert_eq!(menu_event_name("commit-local"), Some("menu-commit"));
        for id in ["app-edit", "undo", "redo", "cut", "copy", "paste", "select_all"] {
            assert_eq!(menu_event_name(id), None, "{id}");
        }
    }
}

/// 关窗/退出事件路由。有活动终端时先阻止立即关闭并请求界面确认；
/// 没有活动终端时维持原来的直接停止行为。
fn route_run_event(app: &AppHandle, event: &RunEvent, fallback: &Shutdown) {
    match event {
        RunEvent::WindowEvent {
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            if request_terminal_confirmation(app) {
                api.prevent_close();
            } else {
                stop_backend(app, fallback);
            }
        }
        RunEvent::ExitRequested { api, .. } => {
            if request_terminal_confirmation(app) {
                api.prevent_exit();
            } else {
                terminate_terminals_best_effort(app);
                stop_backend(app, fallback);
            }
        }
        RunEvent::WindowEvent {
            event: WindowEvent::Destroyed,
            ..
        }
        | RunEvent::Exit => {
            terminate_terminals_best_effort(app);
            stop_backend(app, fallback);
        }
        _ => {}
    }
}

/// 只以管理器记录的活动进程为准，不看前端面板是否展开。发出确认事件后返回 true。
fn request_terminal_confirmation(app: &AppHandle) -> bool {
    let Some(manager) = app.try_state::<TerminalManager>() else {
        return false;
    };
    let sessions = manager.active();
    if sessions.is_empty() {
        return false;
    }
    let _ = app.emit(
        terminal::CLOSE_REQUESTED_EVENT,
        TerminalCloseRequested { sessions },
    );
    true
}

fn terminate_terminals_best_effort(app: &AppHandle) {
    if let Some(manager) = app.try_state::<TerminalManager>() {
        manager.shutdown();
    }
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
    sources: State<'_, cliora::ReviewSources>,
    review_id: Option<String>,
    path: String,
    message: String,
    generation: u64,
    request_id: u64,
) -> Result<CommitResult, AppError> {
    let result = crate::git::changes::commit_index(state.inner(), &path, &message, generation, request_id).await?;
    sources.record_git_result(review_id.as_deref(), &path, cliora::Outcome::Committed, &result.oid);
    Ok(result)
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
async fn fetch_branches(
    state: State<'_, Arc<Backend>>,
    path: String,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    crate::git::sync::fetch_branches(state.inner(), &path, generation, request_id).await
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

/// worktree 总览：从最近仓库解析主仓库、枚举附属工作区并逐项读取真实状态。
/// 只读、不 fetch；单项失败只影响该项。前端另起请求，不阻塞搜索与切换。
#[tauri::command(rename_all = "camelCase")]
async fn worktree_overview(
    state: State<'_, Arc<Backend>>,
    paths: Vec<String>,
    request_id: u64,
) -> Result<crate::git::heads::WorktreeOverview, AppError> {
    crate::git::heads::worktree_overview(state.inner(), &paths, request_id).await
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
async fn set_upstream(
    state: State<'_, Arc<Backend>>,
    path: String,
    upstream: String,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    crate::git::sync::set_upstream(state.inner(), &path, &upstream, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn commit_and_push(
    state: State<'_, Arc<Backend>>,
    sources: State<'_, cliora::ReviewSources>,
    review_id: Option<String>,
    path: String,
    message: String,
    generation: u64,
    request_id: u64,
) -> Result<CommitPushReport, AppError> {
    let report = crate::git::sync::commit_and_push(state.inner(), &path, &message, generation, request_id).await?;
    if report.committed { sources.record_git_result(review_id.as_deref(), &path, cliora::Outcome::Committed, &report.oid); }
    Ok(report)
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

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn repository_document(
    state: State<'_, Arc<Backend>>,
    path: String,
    source: crate::git::document::DocumentSource,
    generation: u64,
    request_id: u64,
    mode: String,
    offset: u64,
    limit: Option<usize>,
    expected_version: Option<String>,
) -> Result<crate::git::document::RepositoryDocument, AppError> {
    crate::git::document::repository_document(
        state.inner(),
        &path,
        &source,
        generation,
        request_id,
        &mode,
        offset,
        limit,
        expected_version.as_deref(),
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn document_resource(
    state: State<'_, Arc<Backend>>,
    path: String,
    source: crate::git::document::DocumentSource,
    generation: u64,
    request_id: u64,
) -> Result<crate::git::preview::FilePreview, AppError> {
    crate::git::document::document_resource(state.inner(), &path, &source, generation, request_id)
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn open_document_url(app: AppHandle, url: String) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let url = crate::git::document::validate_web_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| AppError::new("document_url", "无法打开系统浏览器。"))
}

#[tauri::command(rename_all = "camelCase")]
async fn document_remote_image(
    state: State<'_, Arc<Backend>>,
    url: String,
    request_id: u64,
) -> Result<crate::git::preview::FilePreview, AppError> {
    crate::git::document::document_remote_image(state.inner(), &url, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
fn cancel_document_resources(request_id: u64) {
    crate::git::document::cancel_document_resources(request_id);
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

#[tauri::command(rename_all = "camelCase")]
async fn repository_edit_snapshot(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryEditSnapshot, AppError> {
    crate::git::files::repository_edit_snapshot(
        state.inner(),
        &path,
        &relative,
        generation,
        request_id,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn repository_edit_save(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    expected_digest: String,
    content: String,
    generation: u64,
    request_id: u64,
) -> Result<RepositoryEditSnapshot, AppError> {
    crate::git::files::repository_edit_save(
        state.inner(),
        &path,
        &relative,
        &expected_digest,
        &content,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn repository_create_entry(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    kind: crate::git::files::RepositoryCreateEntryKind,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::files::repository_create_entry(
        state.inner(),
        &path,
        &relative,
        kind,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn repository_copy_entry(
    state: State<'_, Arc<Backend>>,
    path: String,
    source: String,
    target: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::files::repository_copy_entry(
        state.inner(),
        &path,
        &source,
        &target,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn repository_move_entry(
    state: State<'_, Arc<Backend>>,
    path: String,
    source: String,
    target: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::files::repository_move_entry(
        state.inner(),
        &path,
        &source,
        &target,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn repository_delete_entry(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    crate::git::files::repository_delete_entry(
        state.inner(),
        &path,
        &relative,
        generation,
        request_id,
    )
    .await
}
/// 删除命令（含单条）：权限与参数形状一致，只多一个 `relatives` 数组与显式的 `permanent` 落点。
/// `permanent` 为假时进系统回收站；为真时才是不可恢复的永久删除，绝不降级、绝不隐式切换。
#[tauri::command(rename_all = "camelCase")]
async fn repository_delete_entries(
    state: State<'_, Arc<Backend>>,
    path: String,
    relatives: Vec<String>,
    permanent: bool,
    generation: u64,
    request_id: u64,
) -> Result<BatchDeleteResult, AppError> {
    let mode = if permanent {
        crate::git::files::DeleteMode::Permanent
    } else {
        crate::git::files::DeleteMode::Trash
    };
    crate::git::files::repository_delete_entries(
        state.inner(),
        &path,
        &relatives,
        mode,
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

/// 只读任务范围：起点提交 → HEAD → 索引 → 工作区（含未跟踪文件）的最终净差异。
#[tauri::command(rename_all = "camelCase")]
async fn task_review(
    state: State<'_, Arc<Backend>>,
    path: String,
    baseline: String,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::TaskReview, AppError> {
    crate::git::task::task_review(state.inner(), &path, &baseline, generation, request_id).await
}

/// 只读单文件任务差异：必须带上任务快照的完整起点与 HEAD。
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn load_task_diff(
    state: State<'_, Arc<Backend>>,
    path: String,
    baseline: String,
    head: String,
    relative: String,
    original: Option<String>,
    generation: u64,
    request_id: u64,
    offset: Option<u32>,
    limit: Option<u32>,
    context: Option<u32>,
    as_text: Option<bool>,
) -> Result<DiffResponse, AppError> {
    crate::git::task::load_task_diff(
        state.inner(),
        &path,
        &baseline,
        &head,
        &relative,
        original.as_deref(),
        generation,
        request_id,
        offset.unwrap_or(0),
        limit.unwrap_or(0),
        context.unwrap_or(3),
        as_text.unwrap_or(false),
    )
    .await
}

/// 单条任务路径的只读快照确认：token 只在完整确认这条路径的净内容时产生。
#[tauri::command(rename_all = "camelCase")]
async fn task_review_token(
    state: State<'_, Arc<Backend>>,
    path: String,
    baseline: String,
    head: String,
    relative: String,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::TaskReviewToken, AppError> {
    crate::git::task::task_review_token(
        state.inner(),
        &path,
        &baseline,
        &head,
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
async fn branch_tracking(
    state: State<'_, Arc<Backend>>,
    path: String,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::BranchTracking, AppError> {
    crate::git::sync::branch_tracking(state.inner(), &path, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn update_branch(
    state: State<'_, Arc<Backend>>,
    path: String,
    name: String,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    crate::git::sync::update_branch(state.inner(), &path, &name, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn push_local_branch(
    state: State<'_, Arc<Backend>>,
    path: String,
    name: String,
    generation: u64,
    request_id: u64,
) -> Result<BranchState, AppError> {
    crate::git::sync::push_local_branch(state.inner(), &path, &name, generation, request_id).await
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
async fn compare_files(
    state: State<'_, Arc<Backend>>,
    path: String,
    base: Option<String>,
    head: String,
    generation: u64,
    request_id: u64,
) -> Result<crate::model::CompareFiles, AppError> {
    crate::git::history::compare_files(
        state.inner(),
        &path,
        base.as_deref(),
        &head,
        generation,
        request_id,
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
    sources: State<'_, cliora::ReviewSources>,
    review_id: Option<String>,
    path: String,
    oids: Vec<String>,
    generation: u64,
    request_id: u64,
) -> Result<CherryPickOutcome, AppError> {
    let result = crate::git::resolve::cherry_pick_commits(state.inner(), &path, &oids, generation, request_id).await?;
    if result.created > 0 { if let Some(oid) = result.head_oid.as_deref() { sources.record_git_result(review_id.as_deref(), &path, cliora::Outcome::Committed, oid); } }
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
async fn revert_commits(
    state: State<'_, Arc<Backend>>,
    sources: State<'_, cliora::ReviewSources>,
    review_id: Option<String>,
    path: String,
    oids: Vec<String>,
    expected_head: String,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<RevertOutcome, AppError> {
    let result = crate::git::resolve::revert_commits(
        state.inner(),
        &path,
        &oids,
        &expected_head,
        confirm,
        generation,
        request_id,
    ).await?;
    if result.wrote && result.created > 0 { if let Some(oid) = result.head_oid.as_deref() { sources.record_git_result(review_id.as_deref(), &path, cliora::Outcome::Committed, oid); } }
    Ok(result)
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
#[allow(clippy::too_many_arguments)]
async fn start_merge(
    state: State<'_, Arc<Backend>>,
    sources: State<'_, cliora::ReviewSources>,
    review_id: Option<String>,
    path: String,
    source: String,
    target: Option<String>,
    mode: Option<String>,
    generation: u64,
    request_id: u64,
) -> Result<MergeSession, AppError> {
    let result = crate::git::resolve::start_merge(
        state.inner(),
        &path,
        &source,
        target.as_deref(),
        mode.as_deref(),
        generation,
        request_id,
    ).await?;
    if result.fast_forwarded || result.rebased { if let Some(oid) = result.head_oid.as_deref() { sources.record_git_result(review_id.as_deref(), &path, cliora::Outcome::Merged, oid); } }
    Ok(result)
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
    sources: State<'_, cliora::ReviewSources>,
    review_id: Option<String>,
    path: String,
    message: String,
    generation: u64,
    request_id: u64,
) -> Result<MergeComplete, AppError> {
    let done = crate::git::resolve::complete_merge(state.inner(), &path, &message, generation, request_id).await?;
    let outcome = match done.operation.as_str() { "revert" | "cherry-pick" => cliora::Outcome::Committed, _ => cliora::Outcome::Merged };
    sources.record_git_result(review_id.as_deref(), &path, outcome, &done.oid);
    Ok(done)
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
#[allow(clippy::too_many_arguments)]
async fn amend_commit(
    state: State<'_, Arc<Backend>>,
    sources: State<'_, cliora::ReviewSources>,
    review_id: Option<String>,
    path: String,
    expected_head: String,
    message: Option<String>,
    include_staged: bool,
    staged_token: Option<String>,
    confirm: bool,
    generation: u64,
    request_id: u64,
) -> Result<AmendOutcome, AppError> {
    let result = crate::git::resolve::amend_commit(
        state.inner(),
        &path,
        &expected_head,
        message.as_deref(),
        include_staged,
        staged_token.as_deref(),
        confirm,
        generation,
        request_id,
    ).await?;
    if result.wrote { if let Some(oid) = result.head_oid.as_deref() { sources.record_git_result(review_id.as_deref(), &path, cliora::Outcome::Committed, oid); } }
    Ok(result)
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

#[tauri::command(rename_all = "camelCase")]
fn set_change_requests_enabled(
    state: State<'_, Arc<Backend>>,
    change_requests_enabled: bool,
) -> Result<(), AppError> {
    ops::set_change_requests_enabled(state.inner(), change_requests_enabled)
}

/// 用 tauri-plugin-opener 打开已校验过的回退网页。打开失败由 change_request
/// 映射成 browser_open，不显示创建或回退成功。
struct OpenerHandle<R: Runtime>(AppHandle<R>);

impl<R: Runtime> change_request::WebOpener for OpenerHandle<R> {
    fn open(&self, url: &str) -> Result<(), AppError> {
        use tauri_plugin_opener::OpenerExt;
        self.0
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|_| AppError::new("browser_open", "无法打开系统浏览器。"))
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn change_request_prepare(
    state: State<'_, Arc<Backend>>,
    path: String,
    remote: Option<String>,
    generation: u64,
    request_id: u64,
) -> Result<change_request::ChangeRequestPrepare, AppError> {
    change_request::prepare(state.inner(), &path, remote.as_deref(), generation, request_id).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn change_request_create<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<Backend>>,
    path: String,
    remote: Option<String>,
    target_branch: String,
    title: String,
    body: String,
    generation: u64,
    request_id: u64,
) -> Result<change_request::ChangeRequestOutcome, AppError> {
    let input = change_request::CreateInput {
        path,
        remote,
        target_branch,
        title,
        body,
    };
    change_request::create(
        state.inner(),
        input,
        generation,
        request_id,
        &OpenerHandle(app),
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn change_request_token_status(
    state: State<'_, Arc<Backend>>,
    path: String,
    remote: String,
    generation: u64,
    request_id: u64,
) -> Result<change_request::ChangeRequestTokenStatus, AppError> {
    change_request::token_status(state.inner(), &path, &remote, generation, request_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn change_request_set_token(
    state: State<'_, Arc<Backend>>,
    path: String,
    remote: String,
    token: String,
    generation: u64,
    request_id: u64,
) -> Result<change_request::ChangeRequestTokenStatus, AppError> {
    change_request::set_token(
        state.inner(),
        &path,
        &remote,
        &token,
        generation,
        request_id,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn change_request_delete_token(
    state: State<'_, Arc<Backend>>,
    path: String,
    remote: String,
    generation: u64,
    request_id: u64,
) -> Result<change_request::ChangeRequestTokenStatus, AppError> {
    change_request::delete_token(state.inner(), &path, &remote, generation, request_id).await
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

/// 终端只接受仓库路径、会话 id 与终端类型 id：shell 程序、参数、工作目录和进程树都由
/// 后端按本机探测结果与仓库规范路径固定。
#[tauri::command(async)]
fn terminal_profiles(state: State<'_, TerminalManager>) -> Vec<TerminalProfile> {
    state.profiles()
}

#[tauri::command(async)]
fn terminal_list(
    state: State<'_, TerminalManager>,
    path: String,
) -> Result<Vec<TerminalSnapshot>, AppError> {
    state.list(&path)
}

#[tauri::command(async)]
fn terminal_create(
    state: State<'_, TerminalManager>,
    backend: State<'_, Arc<Backend>>,
    path: String,
    profile: Option<String>,
) -> Result<TerminalSnapshot, AppError> {
    let preferred = backend.store.snapshot().terminal.profile;
    state.create(&path, profile.as_deref(), preferred.as_deref())
}

#[tauri::command(async, rename_all = "camelCase")]
fn terminal_attach(
    state: State<'_, TerminalManager>,
    session_id: String,
) -> Result<TerminalSnapshot, AppError> {
    state.attach(&session_id)
}

#[tauri::command(async, rename_all = "camelCase")]
fn terminal_restart(
    state: State<'_, TerminalManager>,
    session_id: String,
) -> Result<TerminalSnapshot, AppError> {
    state.restart(&session_id)
}

#[tauri::command(async, rename_all = "camelCase")]
fn terminal_close(state: State<'_, TerminalManager>, session_id: String) -> Result<(), AppError> {
    state.close(&session_id)
}

#[tauri::command(rename_all = "camelCase")]
fn set_terminal_prefs(
    state: State<'_, Arc<Backend>>,
    prefs: TerminalPrefs,
) -> Result<TerminalPrefs, AppError> {
    state.store.set_terminal_prefs(prefs)
}

#[tauri::command(rename_all = "camelCase")]
fn terminal_write(
    state: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    state.write(&session_id, &data)
}

// ConPTY 尺寸调整可能等待控制台响应，不能占用窗口消息线程。
#[tauri::command(async, rename_all = "camelCase")]
fn terminal_resize(
    state: State<'_, TerminalManager>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), AppError> {
    state.resize(&session_id, rows, cols)
}

#[tauri::command(async)]
fn terminate_terminals(
    state: State<'_, TerminalManager>,
) -> Result<Vec<TerminalActivity>, AppError> {
    state.terminate_all()
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
            .filter_map(|name| name.trim().rsplit("::").next())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
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

    /// 本版本的 host-sync 只有 helper 级入口：run() 必须在 Tauri 初始化之前分流
    /// --host-sync-v1，否则来源应用桌面退出后无法完成同步。应用内 IPC 接收接线
    /// 延后到 T6，所以这里同时断言 handler 里还没有这两条命令。
    #[test]
    fn host_sync_helper_entry_runs_before_tauri() {
        let helper = LIB_SOURCE
            .find("remote_ssh_sync::helper_entry()")
            .expect("run() 缺少 helper 分流");
        let builder = LIB_SOURCE
            .find("tauri::Builder::default()")
            .expect("run() 缺少 Tauri 初始化");
        assert!(
            helper < builder,
            "helper 必须在 Tauri 初始化之前分流，桌面退出后才能同步",
        );
        let commands = handler_commands();
        for command in ["remote_host_sync_begin", "remote_host_sync_receive"] {
            assert!(
                !commands.iter().any(|name| name == command),
                "{command} 属于 T6 的接收接线，本版本不应注册",
            );
        }
    }

    /// Windows 的协议归安装器管理。没有注册插件的 app 也必须能完成此步骤，
    /// 防止开发启动再次调用插件，把正式版入口覆盖为当前 debug/test 可执行文件。
    #[cfg(windows)]
    #[test]
    fn windows_startup_leaves_installer_protocol_registration_alone() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        super::register_deep_link(&app);
    }

    /// 返回时的工作区状态由后端读真实 `git status`：干净是 0，有修改或未跟踪文件按条数计，
    /// 来源目录已不存在时读不到（None，声明为 unknown），不会被当作干净。
    #[tokio::test]
    async fn cliora_return_reads_the_real_worktree_state() {
        let fixture = crate::test_support::git_fixture("cliora-return");
        let repo = fixture.repo("demo");
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("a.txt"), "one
").unwrap();
        git(&repo, &["add", "--", "a.txt"]);
        git(&repo, &["commit", "-m", "init"]);
        let backend = fixture.backend();

        assert_eq!(crate::cliora_uncommitted_files(&backend, &repo).await, Some(0));
        fs::write(repo.join("a.txt"), "one
two
").unwrap();
        fs::write(repo.join("new.txt"), "fresh
").unwrap();
        assert_eq!(crate::cliora_uncommitted_files(&backend, &repo).await, Some(2));
        assert_eq!(
            crate::cliora::worktree_state_of(crate::cliora_uncommitted_files(&backend, &repo).await),
            crate::cliora::WorktreeState::Dirty,
        );
        let missing = fixture.path().join("gone");
        assert_eq!(crate::cliora_uncommitted_files(&backend, &missing).await, None);
        assert_eq!(
            crate::cliora::worktree_state_of(crate::cliora_uncommitted_files(&backend, &missing).await),
            crate::cliora::WorktreeState::Unknown,
        );
    }

    /// 同一 reviewId、指向另一个仓库的重复链接只被解析、没有被接受：返回时仍读取最初被接受的
    /// 工作树的真实状态，不会用另一个目录的未提交数量冒充当前审查。
    #[tokio::test]
    async fn duplicate_review_link_does_not_change_the_worktree_read_on_return() {
        let fixture = crate::test_support::git_fixture("cliora-duplicate");
        let accepted = fixture.repo("accepted");
        let other = fixture.repo("other");
        for repo in [&accepted, &other] {
            git(repo, &["init", "-b", "main"]);
            fs::write(repo.join("a.txt"), "one\n").unwrap();
            git(repo, &["add", "--", "a.txt"]);
            git(repo, &["commit", "-m", "init"]);
        }
        fs::write(other.join("a.txt"), "changed\n").unwrap();
        fs::write(other.join("b.txt"), "new\n").unwrap();
        let backend = fixture.backend();
        let sources = crate::cliora::ReviewSources::default();
        let review = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
        let session = "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0";

        let request = crate::cliora::ReviewRequest {
            protocol_version: 3, workspace_id: None, repository_id: None, workspace_name: None,
            review_id: review.into(), session_id: session.into(), worktree_path: accepted.to_string_lossy().into_owned(), baseline: None,
        };
        sources.stage_request(&request).unwrap();
        sources.accept_path(review, session, request.worktree_path.clone()).unwrap();
        // 重复链接：解析成功，但前端因为 reviewId 已处理而忽略，不会再回执。
        assert!(sources.stage_request(&crate::cliora::ReviewRequest { worktree_path: other.to_string_lossy().into_owned(), ..request.clone() }).is_err());
        let worktree = sources.request_for(review, session, true).unwrap().worktree_path;
        assert_eq!(
            crate::cliora_uncommitted_files(&backend, std::path::Path::new(&worktree)).await,
            Some(0),
            "返回时读取的是最初被接受的干净工作树",
        );
        // 即便重复链接之后又收到一次 accepted 回执，也不覆盖已有正式来源。
        sources.accept_path(review, session, other.to_string_lossy().into_owned()).unwrap();
        let worktree = sources.request_for(review, session, true).unwrap().worktree_path;
        assert_eq!(
            crate::cliora_uncommitted_files(&backend, std::path::Path::new(&worktree)).await,
            Some(0),
        );
        assert_eq!(crate::cliora_uncommitted_files(&backend, &other).await, Some(2));
    }

    #[tokio::test]
    async fn expired_review_root_never_falls_back_to_a_parent_repository() {
        let fixture = crate::test_support::git_fixture("cliora-expired-nested");
        let parent = fixture.repo("parent");
        git(&parent, &["init", "-b", "main"]);
        let child = parent.join("child"); fs::create_dir(&child).unwrap();
        git(&child, &["init", "-b", "main"]);
        let backend = fixture.backend();
        assert_eq!(crate::cliora_uncommitted_files(&backend, &child).await, Some(0));
        fs::remove_dir_all(child.join(".git")).unwrap();
        // Without the review root guard, ordinary Git discovery still succeeds on the parent.
        git(&child, &["rev-parse", "--show-toplevel"]);
        assert_eq!(crate::cliora_uncommitted_files(&backend, &child).await, None);
    }

    #[tokio::test]
    async fn review_states_are_read_from_main_and_linked_roots_independently() {
        let fixture = crate::test_support::git_fixture("cliora-main-linked");
        let main = fixture.repo("main");
        git(&main, &["init", "-b", "main"]);
        fs::write(main.join("a.txt"), "one\n").unwrap();
        git(&main, &["add", "--", "a.txt"]); git(&main, &["commit", "-m", "init"]);
        let linked = fixture.path().join("linked");
        git(&main, &["worktree", "add", "-b", "feature", linked.to_str().unwrap()]);
        fs::write(linked.join("b.txt"), "linked remains dirty\n").unwrap();
        let backend = fixture.backend();
        assert_eq!(crate::cliora_uncommitted_files(&backend, &main).await, Some(0));
        assert_eq!(crate::cliora_uncommitted_files(&backend, &linked).await, Some(1));
    }

    /// 发给前端的返回结果只有实际发送的工作区状态和读到的条数，camelCase 与 TS 类型一致。
    #[test]
    fn cliora_return_sent_serializes_in_camel_case() {
        let sent = crate::ClioraReturnSent { worktree_state: "dirty", uncommitted: Some(2) };
        assert_eq!(
            serde_json::to_value(&sent).unwrap(),
            serde_json::json!({ "worktreeState": "dirty", "uncommitted": 2 }),
        );
        let unknown = crate::ClioraReturnSent { worktree_state: "unknown", uncommitted: None };
        assert_eq!(
            serde_json::to_value(&unknown).unwrap(),
            serde_json::json!({ "worktreeState": "unknown", "uncommitted": null }),
        );
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

    fn cliora_cherry_pick_case(case: &str) {
        use tauri::Manager;
        let skip = case.starts_with("skip"); let failure = case.starts_with("failure"); let preserve = case.ends_with("preserve");
        let fixture = crate::test_support::git_fixture("cliora-cherry-result");
        let repo = fixture.repo("A"); let other = fixture.repo("B");
        for path in [&repo, &other] {
            git(path, &["init", "-b", "main"]);
            fs::write(path.join("shared.txt"), "base\n").unwrap();
            git(path, &["add", "--", "shared.txt"]); git(path, &["commit", "-m", "base"]);
        }
        let oid = |path: &Path, reference: &str| {
            let output = Command::new(crate::test_support::system_git()).current_dir(path).args(["rev-parse", reference]).output().unwrap();
            assert!(output.status.success()); String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        git(&repo, &["checkout", "-b", "feature"]);
        let conflict = matches!(case, "conflict" | "continue" | "partial") || failure;
        let first = if case == "partial" {
            fs::write(repo.join("picked.txt"), "first\n").unwrap(); git(&repo, &["add", "--", "picked.txt"]);
            git(&repo, &["commit", "-m", "first", "--date=2001-01-01T00:00:00Z"]);
            Some(oid(&repo, "HEAD"))
        } else { None };
        fs::write(repo.join(if conflict { "shared.txt" } else { "picked.txt" }), "picked\n").unwrap();
        git(&repo, &["add", "--", "."]); git(&repo, &["commit", "-m", "picked", "--date=2002-01-01T00:00:00Z"]);
        let patch = oid(&repo, "HEAD"); git(&repo, &["checkout", "main"]);
        if conflict && !failure {
            fs::write(repo.join("shared.txt"), "main\n").unwrap(); git(&repo, &["commit", "-am", "main"]);
        }
        if skip || preserve {
            // The service rejects root/merge commits before ancestor skipping; use a normal existing commit.
            fs::write(repo.join("existing.txt"), "already here\n").unwrap();
            git(&repo, &["add", "--", "existing.txt"]); git(&repo, &["commit", "-m", "already"]);
        }
        let before = oid(&repo, "HEAD"); let other_before = oid(&other, "HEAD");
        if failure { fs::write(repo.join("shared.txt"), "local unsaved\n").unwrap(); }
        let backend = Arc::new(fixture.backend()); let sources = crate::cliora::ReviewSources::default();
        let review_a = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
        let review_b = "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
        let session = "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0";
        for (review, path) in [(review_a, &repo), (review_b, &other)] {
            let request = crate::cliora::ReviewRequest { protocol_version: 3, workspace_id: None, repository_id: None, workspace_name: None, review_id: review.into(), session_id: session.into(), worktree_path: repo_key(path), baseline: Some(oid(path, if review == review_a && preserve { "HEAD~1" } else { "HEAD" })) };
            sources.stage_request(&request).unwrap(); sources.accept_path(review, session, repo_key(path)).unwrap();
        }
        if preserve { sources.record_git_result(Some(review_a), &repo_key(&repo), crate::cliora::Outcome::Committed, &before); }
        let app = tauri::test::mock_builder().manage(Arc::clone(&backend)).manage(sources)
            .invoke_handler(tauri::generate_handler![super::cherry_pick_commits, super::complete_merge])
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let path = repo_key(&repo); let mut picks = first.into_iter().collect::<Vec<_>>();
        picks.push(if skip { before.clone() } else { patch });
        let result = invoke(&window, "cherry_pick_commits", serde_json::json!({ "path": path, "oids": picks, "generation": backend.scheduler.current_generation(&path), "requestId": 99001, "reviewId": review_a }));
        if failure { assert!(result.is_err()); }
        else {
            let result = result.unwrap();
            assert_eq!(result["conflicted"], matches!(case, "conflict" | "continue" | "partial"));
            if skip { assert_eq!(result["skipped"].as_array().unwrap().len(), 1); }
            assert_eq!(result["created"], if matches!(case, "success" | "partial") { 1 } else { 0 });
            assert_eq!(result["headOid"], if matches!(case, "success" | "partial") { serde_json::json!(oid(&repo, "HEAD")) } else { serde_json::Value::Null });
        }
        if case == "continue" {
            git(&repo, &["checkout", "--theirs", "--", "shared.txt"]); git(&repo, &["add", "--", "shared.txt"]);
            let completed = invoke(&window, "complete_merge", serde_json::json!({ "path": path, "message": "", "generation": backend.scheduler.current_generation(&path), "requestId": 99002, "reviewId": review_a })).unwrap();
            assert_eq!(completed["operation"], "cherry-pick");
        }
        let snapshots = app.state::<crate::cliora::ReviewSources>().snapshots();
        let a = snapshots.iter().find(|source| source.source.review_id == review_a).unwrap();
        let b = snapshots.iter().find(|source| source.source.review_id == review_b).unwrap();
        if matches!(case, "success" | "partial" | "continue") {
            let after = oid(&repo, "HEAD"); assert_ne!(after, before);
            let result = a.result.as_ref().expect("a real created commit must be retained for source A");
            assert_eq!(result.outcome, crate::cliora::Outcome::Committed); assert_eq!(result.head_oid, after);
        } else {
            assert_eq!(oid(&repo, "HEAD"), before);
            if preserve { assert_eq!(a.result.as_ref().unwrap().head_oid, before); } else { assert!(a.result.is_none()); }
        }
        assert!(b.result.is_none()); assert_eq!(oid(&other, "HEAD"), other_before);
        assert_eq!(fs::read_to_string(other.join("shared.txt")).unwrap(), "base\n");
    }

    #[test]
    fn cliora_cherry_pick_success_records_real_source_commit() { cliora_cherry_pick_case("success"); }
    #[test]
    fn cliora_cherry_pick_all_skipped_records_no_commit() { cliora_cherry_pick_case("skip"); }
    #[test]
    fn cliora_cherry_pick_pure_conflict_records_no_commit() { cliora_cherry_pick_case("conflict"); }
    #[test]
    fn cliora_cherry_pick_failure_records_no_commit() { cliora_cherry_pick_case("failure"); }
    #[test]
    fn cliora_cherry_pick_partial_conflict_retains_created_commit() { cliora_cherry_pick_case("partial"); }
    #[test]
    fn cliora_cherry_pick_continue_is_committed_not_merged() { cliora_cherry_pick_case("continue"); }

    #[test]
    fn cliora_cherry_pick_skip_preserves_existing_result() { cliora_cherry_pick_case("skip-preserve"); }
    #[test]
    fn cliora_cherry_pick_failure_preserves_existing_result() { cliora_cherry_pick_case("failure-preserve"); }

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
            "fetch_branches",
            "pull_fast_forward",
            "push_branch",
            "publish_branch",
            "associate_upstream",
            "set_upstream",
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
            "task_review",
            "load_task_diff",
            "task_review_token",
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
            .manage(crate::cliora::ReviewSources::default())
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
                super::revert_commits,
                super::merge_session,
                super::abort_merge,
                super::undo_commit,
                super::amend_commit,
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
                "revert_commits",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "oids": ["abc"],
                    "expectedHead": "def",
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
                "amend_commit",
                serde_json::json!({
                    "path": "/tmp/unused",
                    "expectedHead": "abc",
                    "message": "next",
                    "includeStaged": false,
                    "stagedToken": "def",
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

    #[test]
    fn change_request_switch_ipc_defaults_off_and_keeps_camel_case() {
        let fixture = crate::test_support::git_fixture("ipc-change-requests");
        let backend = Arc::new(fixture.backend());
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&backend))
            .invoke_handler(tauri::generate_handler![
                super::set_change_requests_enabled,
                super::get_settings
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        // 升级/新装：IPC 上读到的就是关闭，前端不需要额外推断。
        let initial = invoke(&window, "get_settings", serde_json::json!({})).expect("settings");
        assert_eq!(initial["changeRequestsEnabled"], false);

        // snake_case 参数必须被拒绝，否则前端 camelCase 契约会悄悄失效。
        let snake = invoke(
            &window,
            "set_change_requests_enabled",
            serde_json::json!({ "change_requests_enabled": true }),
        )
        .expect_err("snake_case must be rejected");
        assert!(snake.contains("changeRequestsEnabled"), "{snake}");
        assert!(!backend.store.change_requests_enabled());

        invoke(
            &window,
            "set_change_requests_enabled",
            serde_json::json!({ "changeRequestsEnabled": true }),
        )
        .expect("camelCase");
        assert!(backend.store.change_requests_enabled());
        let after = invoke(&window, "get_settings", serde_json::json!({})).expect("settings");
        assert_eq!(after["changeRequestsEnabled"], true);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&fs::read_to_string(backend.store.path()).unwrap())
                .unwrap()["changeRequestsEnabled"],
            true
        );
        backend.watches.stop();
    }

    #[test]
    fn change_request_commands_are_gated_and_use_camel_case_arguments() {
        let fixture = crate::test_support::git_fixture("ipc-change-request-commands");
        let backend = Arc::new(fixture.backend());
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&backend))
            .invoke_handler(tauri::generate_handler![
                super::change_request_prepare,
                super::change_request_create,
                super::change_request_token_status,
                super::change_request_set_token,
                super::change_request_delete_token,
                super::set_change_requests_enabled
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let path = repo_key(fixture.path());

        // snake_case 参数被拒绝，前端必须传 camelCase。
        for (cmd, body) in [
            (
                "change_request_prepare",
                serde_json::json!({ "path": path, "remote": null, "generation": 0, "request_id": 1 }),
            ),
            (
                "change_request_create",
                serde_json::json!({
                    "path": path,
                    "remote": "origin",
                    "targetBranch": "main",
                    "title": "t",
                    "body": "",
                    "generation": 0,
                    "request_id": 1
                }),
            ),
            (
                "change_request_token_status",
                serde_json::json!({ "path": path, "remote": "origin", "generation": 0, "request_id": 1 }),
            ),
            (
                "change_request_set_token",
                serde_json::json!({ "path": path, "remote": "origin", "token": "t", "generation": 0, "request_id": 1 }),
            ),
            (
                "change_request_delete_token",
                serde_json::json!({ "path": path, "remote": "origin", "generation": 0, "request_id": 1 }),
            ),
        ] {
            let error = invoke(&window, cmd, body).expect_err(cmd);
            assert!(error.contains("requestId"), "{cmd}: {error}");
        }

        // 关闭时全部拒绝：不读钥匙串、不探测远程、不发平台请求。
        for (cmd, body) in [
            (
                "change_request_prepare",
                serde_json::json!({ "path": path, "remote": null, "generation": 0, "requestId": 1 }),
            ),
            (
                "change_request_create",
                serde_json::json!({
                    "path": path,
                    "remote": "origin",
                    "targetBranch": "main",
                    "title": "标题",
                    "body": "",
                    "generation": 0,
                    "requestId": 1
                }),
            ),
            (
                "change_request_token_status",
                serde_json::json!({ "path": path, "remote": "origin", "generation": 0, "requestId": 1 }),
            ),
            (
                "change_request_set_token",
                serde_json::json!({ "path": path, "remote": "origin", "token": "token-value-1234", "generation": 0, "requestId": 1 }),
            ),
            (
                "change_request_delete_token",
                serde_json::json!({ "path": path, "remote": "origin", "generation": 0, "requestId": 1 }),
            ),
        ] {
            let error = invoke(&window, cmd, body).expect_err(cmd);
            assert!(error.contains("已关闭"), "{cmd}: {error}");
        }

        // 启用后应用参数进入实际解析：这里刻意用一个不是仓库的目录。
        invoke(
            &window,
            "set_change_requests_enabled",
            serde_json::json!({ "changeRequestsEnabled": true }),
        )
        .expect("enable");
        let error = invoke(
            &window,
            "change_request_prepare",
            serde_json::json!({ "path": path, "remote": null, "generation": 0, "requestId": 2 }),
        )
        .expect_err("prepare on non-repository");
        assert!(error.contains("不是 Git 仓库"), "{error}");
        backend.watches.stop();
    }
}

async fn workspace_io<T: Send + 'static>(work: impl FnOnce() -> Result<T, AppError> + Send + 'static) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| AppError::new("workspace", "项目读取已中断"))?
}
#[tauri::command]
async fn workspace_list(state: State<'_, Arc<Backend>>) -> Result<workspaces::Projects, AppError> {
    let backend = Arc::clone(state.inner());
    workspace_io(move || workspaces::list(&backend.store)).await
}
#[tauri::command]
async fn workspace_create(state: State<'_, Arc<Backend>>, name: String) -> Result<workspaces::Projects, AppError> {
    let backend = Arc::clone(state.inner());
    workspace_io(move || workspaces::create(&backend.store, &name)).await
}
#[tauri::command]
async fn workspace_preview(state: State<'_, Arc<Backend>>, path: String) -> Result<workspaces::Preview, AppError> {
    let backend = Arc::clone(state.inner());
    workspace_io(move || workspaces::preview(&backend.store, &path)).await
}
#[tauri::command]
async fn workspace_attach(state: State<'_, Arc<Backend>>, preview: workspaces::Preview, adopt: bool) -> Result<workspaces::Projects, AppError> {
    let backend = Arc::clone(state.inner());
    workspace_io(move || workspaces::attach(&backend.store, preview, adopt)).await
}
#[tauri::command(rename_all = "camelCase")]
async fn workspace_update(state: State<'_, Arc<Backend>>, manifest: workspaces::Manifest, expected_revision: u64) -> Result<workspaces::Projects, AppError> {
    let backend = Arc::clone(state.inner());
    workspace_io(move || workspaces::update(&backend.store, manifest, expected_revision)).await
}
#[tauri::command]
async fn workspace_refresh(state: State<'_, Arc<Backend>>, id: String) -> Result<workspaces::Projects, AppError> {
    let backend = Arc::clone(state.inner());
    workspace_io(move || workspaces::refresh(&backend.store, &id)).await
}
#[tauri::command(rename_all = "camelCase")]
async fn workspace_publish(state: State<'_, Arc<Backend>>, id: String, expected_revision: u64, path: String) -> Result<workspaces::Projects, AppError> {
    let backend = Arc::clone(state.inner());
    workspace_io(move || workspaces::publish(&backend.store, &id, expected_revision, &path)).await
}
#[tauri::command(rename_all = "camelCase")]
async fn workspace_favorite(state: State<'_, Arc<Backend>>, id: String, repository_id: String, enabled: bool) -> Result<workspaces::Projects, AppError> {
    let backend = Arc::clone(state.inner());
    workspace_io(move || workspaces::favorite(&backend.store, &id, &repository_id, enabled)).await
}
#[tauri::command(rename_all = "camelCase")]
async fn workspace_candidates(state: State<'_, Arc<Backend>>, paths: Vec<String>, request_id: u64) -> Result<Vec<workspaces::Candidate>, AppError> {
    workspaces::candidates(state.inner(), paths, request_id, None).await
}
#[tauri::command(rename_all = "camelCase")]
async fn workspace_discover(state: State<'_, Arc<Backend>>, discovery: State<'_, Arc<workspaces::Discovery>>, root: String, request_id: u64) -> Result<workspaces::DiscoveryResult, AppError> {
    use std::sync::atomic::Ordering;
    let discovery = Arc::clone(discovery.inner());
    // One discovery at a time; a second call must not reset an active caller's cancel token.
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) { return Err(AppError::new("workspace_busy", "仓库发现正在进行，请先取消或等待")); }
    struct Guard;
    impl Drop for Guard { fn drop(&mut self) { RUNNING.store(false, Ordering::SeqCst); } }
    let _guard = Guard;
    discovery.0.store(false, Ordering::SeqCst);
    let scan = Arc::clone(&discovery);
    let (paths, issues, partial) = workspace_io(move || workspaces::discover_paths(&root, &scan.0)).await?;
    let mut candidates = issues;
    candidates.extend(workspaces::candidates(state.inner(), paths, request_id, Some(discovery.clone())).await?);
    Ok(workspaces::DiscoveryResult { candidates, partial, cancelled: discovery.0.load(Ordering::SeqCst) })
}
#[tauri::command]
fn workspace_cancel_discovery(discovery: State<'_, Arc<workspaces::Discovery>>) {
    discovery.0.store(true, std::sync::atomic::Ordering::SeqCst);
}
#[tauri::command]
async fn workspace_delete(state: State<'_, Arc<Backend>>, id: String) -> Result<workspaces::Projects, AppError> {
    let backend = Arc::clone(state.inner());
    workspace_io(move || workspaces::delete(&backend.store, &id)).await
}
#[tauri::command]
async fn workspace_preview_link(state: State<'_, Arc<Backend>>, url: String) -> Result<workspaces::Preview, AppError> {
    let backend = Arc::clone(state.inner());
    workspace_io(move || workspaces::preview_link(&backend.store, &url)).await
}
#[tauri::command]
fn workspace_open_in_cliora<R: Runtime>(app: AppHandle<R>, path: String, repository_id: String) -> Result<(), AppError> {
    workspaces::open_in_cliora(&app, &path, &repository_id)
}
