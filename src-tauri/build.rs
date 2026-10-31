fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "detect_git",
                "set_git_executable",
                "clear_git_executable",
                "get_settings",
                "add_repository",
                "create_repository",
                "open_repository",
                "close_repository",
                "forget_recent",
                "refresh_status",
                "load_diff",
                "set_theme",
                "set_panel_widths",
                "save_draft",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
