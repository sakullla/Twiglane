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
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

use crate::error::AppError;
use crate::git::ops::{self, Backend};
use crate::git::runner::RealRunner;
use crate::model::{
    DiffResponse, GitInfo, OpenedRepository, PanelWidths, RecentRepo, RepoChanged, SettingsDto,
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
            let backend = Arc::new(Backend::new(store, RealRunner::default(), Arc::new(shutdown)));
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
    let menu = Menu::with_items(app, &[&search])?;
    app.set_menu(menu)?;
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

fn start_watch(app: &AppHandle, backend: &Arc<Backend>, path: &str) -> bool {
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
                let generation = degraded_backend.scheduler.current_generation(&degraded_path);
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
async fn set_git_executable(state: State<'_, Arc<Backend>>, path: String) -> Result<GitInfo, AppError> {
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

#[tauri::command]
async fn add_repository(
    app: AppHandle,
    state: State<'_, Arc<Backend>>,
    path: String,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let backend = Arc::clone(state.inner());
    let mut opened = ops::add_repository(&backend, &path, request_id).await?;
    opened.watch_degraded = start_watch(&app, &backend, &opened.summary.path);
    Ok(opened)
}

#[tauri::command]
async fn create_repository(
    app: AppHandle,
    state: State<'_, Arc<Backend>>,
    path: String,
    request_id: u64,
) -> Result<OpenedRepository, AppError> {
    let backend = Arc::clone(state.inner());
    let mut opened = ops::create_repository(&backend, &path, request_id).await?;
    opened.watch_degraded = start_watch(&app, &backend, &opened.summary.path);
    Ok(opened)
}

#[tauri::command]
async fn open_repository(
    app: AppHandle,
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
fn forget_recent(state: State<'_, Arc<Backend>>, path: String) -> Result<Vec<RecentRepo>, AppError> {
    ops::forget_recent(state.inner(), &path)
}

#[tauri::command]
async fn refresh_status(
    state: State<'_, Arc<Backend>>,
    path: String,
    generation: u64,
    request_id: u64,
) -> Result<StatusSnapshot, AppError> {
    ops::refresh_status(state.inner(), &path, generation, request_id).await
}

#[tauri::command]
async fn load_diff(
    state: State<'_, Arc<Backend>>,
    path: String,
    relative: String,
    staged: bool,
    generation: u64,
    request_id: u64,
) -> Result<DiffResponse, AppError> {
    ops::load_diff(state.inner(), &path, &relative, staged, generation, request_id).await
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
fn save_draft(state: State<'_, Arc<Backend>>, path: String, message: String) -> Result<(), AppError> {
    ops::save_draft(state.inner(), &path, &message)
}
