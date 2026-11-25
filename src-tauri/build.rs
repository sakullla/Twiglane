/// 发行包把远端组件放在资源目录的 `agent-v2/`（见 `tauri.conf.json` 的
/// `bundle.resources` 与 `remote_ssh::RemoteSsh::artifacts_for`）。
///
/// 这些二进制由发行流水线生成，普通 checkout 里没有；而 tauri-build 遇到不存在的
/// 资源路径会直接让整个构建失败。所以这里先保证目录存在，做到「存在即打包」：
/// 目录为空时 tauri-build 跳过（不打包任何文件），有产物时按原样收录。
fn ensure_agent_bundle_dir() {
    let dir = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("agent-v2");
    if !dir.is_dir() {
        match std::fs::create_dir_all(&dir) {
            Ok(()) => println!(
                "cargo:warning=仓库里没有发行用的远端组件产物，已创建空的 {}。本次构建的安装包不带远端组件，远端 SSH 安装会在运行时报 agent_artifact_manifest。",
                dir.display()
            ),
            Err(error) => {
                println!(
                    "cargo:warning=无法创建远端组件资源目录 {}：{error}。tauri-build 会因资源路径缺失而失败，请手动创建该目录后重试。",
                    dir.display()
                );
                return;
            }
        }
    }
    let empty = std::fs::read_dir(&dir).map(|mut entries| entries.next().is_none());
    if empty.unwrap_or(false) {
        println!(
            "cargo:warning={} 是空目录：发行包只会在放入 manifest.json 与各平台 twiglane-agent-v2 后携带远端组件。",
            dir.display()
        );
    }
}

fn main() {
    ensure_agent_bundle_dir();
    let attributes = tauri_build::Attributes::new();
    let attributes = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // tauri-build links its manifest only into application binaries. Library
        // tests also need Common Controls v6 or they fail with 0xc0000139.
        // https://github.com/tauri-apps/tauri/issues/13419
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows/app.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        attributes
    };
    tauri_build::try_build(
        attributes.app_manifest(tauri_build::AppManifest::new().commands(&[
            "detect_git",
            "set_git_executable",
            "clear_git_executable",
            "get_settings",
            "remote_review_begin",
            "remote_review_accept",
            "remote_review_end",
            "remote_review_return",
            "remote_worktree_targets",
            "remote_worktree_open",
            "remote_worktree_cancel_open",
            "remote_worktree_close",
            "remote_worktree_status",
            "remote_worktree_diff",
            "remote_worktree_write",
            "remote_worktree_recover",
            "remote_worktree_call",
            "remote_worktree_file_copy",
            "remote_change_request",
            "remote_worktree_events",
            "remote_worktree_cancel_reads",
            "remote_ssh_settings",
            "set_remote_ssh_enabled",
            "remote_ssh_save_target",
            "remote_ssh_delete_target",
            "remote_ssh_set_password",
            "remote_ssh_delete_password",
            "remote_ssh_test",
            "remote_ssh_cancel",
            "remote_ssh_install_agent",
            "workspace_list",
            "workspace_create",
            "workspace_preview",
            "workspace_attach",
            "workspace_update",
            "workspace_refresh",
            "workspace_publish",
            "workspace_favorite",
            "workspace_candidates",
            "workspace_discover",
            "workspace_cancel_discovery",
            "workspace_delete",
            "workspace_preview_link",
            "workspace_open_in_cliora",
            "add_repository",
            "create_repository",
            "open_repository",
            "close_repository",
            "forget_recent",
            "refresh_status",
            "load_diff",
            "file_preview",
            "repository_document",
            "document_resource",
            "open_document_url",
            "document_remote_image",
            "cancel_document_resources",
            "repository_directory",
            "repository_file_content",
            "repository_edit_snapshot",
            "repository_edit_save",
            "repository_create_entry",
            "repository_copy_entry",
            "repository_move_entry",
            "repository_delete_entry",
            "repository_delete_entries",
            "repository_path_search",
            "repository_content_search",
            "repository_review_token",
            "task_review",
            "load_task_diff",
            "task_review_token",
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
            "branch_list",
            "branch_tracking",
            "update_branch",
            "push_local_branch",
            "create_branch",
            "create_branch_from",
            "create_worktree",
            "rename_branch",
            "reveal_path",
            "open_path",
            "ignore_path",
            "switch_branch",
            "delete_branch",
            "delete_remote_branch",
            "tag_state",
            "tag_remote_state",
            "create_tag",
            "delete_tag",
            "push_tag",
            "history_page",
            "commit_detail",
            "commit_file_diff",
            "file_history",
            "cherry_pick_commits",
            "revert_commits",
            "checkout_commit",
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
            "amend_commit",
            "discard_changes",
            "set_theme",
            "set_pull_integration",
            "set_branch_groups",
            "set_files_view",
            "set_change_requests_enabled",
            "change_request_prepare",
            "change_request_create",
            "change_request_token_status",
            "change_request_set_token",
            "change_request_delete_token",
            "change_request_draft",
            "change_request_open_web",
            "change_request_instances",
            "change_request_save_instance",
            "change_request_delete_instance",
            "set_panel_widths",
            "save_draft",
            "cancel_reads",
            "push_to_remote",
            "track_remote_as",
            "cancel_remote",
            "repo_heads",
            "worktree_overview",
            "remove_worktree",
            "compare_file_diff",
            "compare_files",
            "commit_branches",
            "measure_probe",
            "measure_sample",
            "measure_finish",
            "measure_wait",
            "update_install_supported",
            "cliora_review_request",
            "cliora_review_receipt",
            "cliora_review_return",
            "cliora_review_forget",
            "cliora_review_sources",
            "prepare_review_feedback",
            "terminal_profiles",
            "terminal_list",
            "terminal_create",
            "terminal_attach",
            "terminal_restart",
            "terminal_close",
            "set_terminal_prefs",
            "terminal_write",
            "terminal_resize",
            "terminate_terminals",
        ])),
    )
    .expect("failed to run tauri-build");
}
