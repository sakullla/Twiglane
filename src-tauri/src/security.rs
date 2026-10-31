use std::fs;
use std::path::Path;

#[test]
fn capabilities_do_not_grant_a_shell() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let capabilities: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("capabilities/default.json")).unwrap(),
    )
    .unwrap();
    let permissions: Vec<&str> = capabilities["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    let expected = [
        "core:event:allow-listen",
        "dialog:allow-open",
        "allow-detect-git",
        "allow-set-git-executable",
        "allow-clear-git-executable",
        "allow-get-settings",
        "allow-add-repository",
        "allow-create-repository",
        "allow-open-repository",
        "allow-close-repository",
        "allow-forget-recent",
        "allow-refresh-status",
        "allow-load-diff",
        "allow-stage-files",
        "allow-unstage-files",
        "allow-stage-hunks",
        "allow-commit-changes",
        "allow-set-theme",
        "allow-set-panel-widths",
        "allow-save-draft",
    ];
    assert_eq!(permissions, expected);
    assert!(permissions.iter().all(|permission| {
        !permission.contains("shell") && !permission.contains("fs:") && !permission.contains("http")
    }));
    let config = fs::read_to_string(root.join("tauri.conf.json")).unwrap();
    assert!(config.contains("\"productName\": \"Twiglane\""));
    assert!(!config.to_ascii_lowercase().contains("shell"));
    let cargo = fs::read_to_string(root.join("Cargo.toml")).unwrap();
    assert!(!cargo.contains("tauri-plugin-shell"));
    assert_source_has_no_shell(root.join("src").as_path());
}

fn assert_source_has_no_shell(dir: &Path) {
    let shell = format!("Command::new({}sh{})", '"', '"');
    let bash = format!("Command::new({}bash{})", '"', '"');
    let cmd = format!("Command::new({}cmd{})", '"', '"');
    let cmd_exe = format!("Command::new({}cmd.exe{})", '"', '"');
    let powershell = format!("Command::new({}powershell{})", '"', '"');
    for path in rust_files(dir) {
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains(&shell), "{}", path.display());
        assert!(!text.contains(&bash), "{}", path.display());
        assert!(!text.contains(&cmd), "{}", path.display());
        assert!(!text.contains(&cmd_exe), "{}", path.display());
        assert!(!text.contains(&powershell), "{}", path.display());
        let plugin = ["tauri", "_plugin_", "shell"].concat();
        assert!(!text.contains(&plugin), "{}", path.display());
    }
}

fn rust_files(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(rust_files(&path));
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            files.push(path);
        }
    }
    files
}
