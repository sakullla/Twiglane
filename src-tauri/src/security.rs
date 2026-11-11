use std::fs;
use std::path::Path;

#[test]
fn capabilities_grant_only_explicit_terminal_ipc_not_a_generic_shell() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let capabilities: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(root.join("capabilities/default.json")).unwrap())
            .unwrap();
    let permissions: Vec<&str> = capabilities["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    let expected = [
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "core:window:allow-start-dragging",
        "core:window:allow-minimize",
        "core:window:allow-toggle-maximize",
        "core:window:allow-close",
        "core:window:allow-is-maximized",
        "core:window:allow-internal-toggle-maximize",
        "dialog:allow-open",
        "updater:default",
        "core:app:allow-version",
        "process:allow-restart",
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
        "allow-file-preview",
        "allow-repository-document",
        "allow-document-resource",
        "allow-open-document-url",
        "allow-document-remote-image",
        "allow-cancel-document-resources",
        "allow-repository-directory",
        "allow-repository-file-content",
        // 轻量编辑只有完整快照读取与写锁内保存两个命令：没有 shell、没有任意文件写入。
        "allow-repository-edit-snapshot",
        "allow-repository-edit-save",
        "allow-repository-path-search",
        "allow-repository-content-search",
        "allow-repository-review-token",
        // 任务审阅只有三个只读命令：聚合范围、单文件净差异与单路径快照确认。
        "allow-task-review",
        "allow-load-task-diff",
        "allow-task-review-token",
        "allow-stage-files",
        "allow-unstage-files",
        "allow-stage-hunks",
        "allow-stage-lines",
        "allow-commit-changes",
        "allow-clone-repository",
        "allow-remote-state",
        "allow-add-remote",
        "allow-set-remote-url",
        "allow-fetch-remote",
        "allow-pull-fast-forward",
        "allow-push-branch",
        "allow-publish-branch",
        "allow-associate-upstream",
        "allow-set-upstream",
        "allow-commit-and-push",
        "allow-branch-state",
        "allow-branch-list",
        "allow-create-branch",
        "allow-create-branch-from",
        "allow-rename-branch",
        "allow-reveal-path",
        "allow-open-path",
        "allow-ignore-path",
        "allow-switch-branch",
        "allow-delete-branch",
        "allow-delete-remote-branch",
        "allow-tag-state",
        "allow-tag-remote-state",
        "allow-create-tag",
        "allow-delete-tag",
        "allow-push-tag",
        "allow-history-page",
        "allow-commit-detail",
        "allow-commit-file-diff",
        "allow-file-history",
        "allow-cherry-pick-commits",
        "allow-checkout-commit",
        "allow-stash-state",
        "allow-save-stash",
        "allow-apply-stash",
        "allow-delete-stash",
        "allow-merge-preview",
        "allow-start-merge",
        "allow-merge-session",
        "allow-conflict-view",
        "allow-resolve-conflict",
        "allow-complete-merge",
        "allow-abort-merge",
        "allow-undo-commit",
        "allow-discard-changes",
        "allow-set-theme",
        "allow-set-pull-integration",
        "allow-set-branch-groups",
        "allow-set-files-view",
        "allow-set-panel-widths",
        "allow-save-draft",
        "allow-cancel-reads",
        "allow-push-to-remote",
        "allow-track-remote-as",
        "allow-cancel-remote",
        "allow-repo-heads",
        "allow-worktree-overview",
        "allow-remove-worktree",
        "allow-compare-file-diff",
        "allow-compare-files",
        "allow-commit-branches",
        "allow-measure-probe",
        "allow-measure-sample",
        "allow-measure-finish",
        "allow-measure-wait",
        "allow-update-install-supported",
        // cliora 审查联动只加固定 scheme 的 deep link 读取与三个协议命令：没有 shell、
        // 没有文件系统或 HTTP 权限，链接本身只能请求打开仓库。
        "deep-link:default",
        "allow-cliora-review-request",
        "allow-cliora-review-receipt",
        "allow-cliora-review-return",
        // 终端只开放五个结构化命令：打开/附着、重启、写入、resize 与全部终止。
        // 没有任何命令允许前端指定程序、参数或工作目录之外的路径。
        "allow-open-terminal",
        "allow-restart-terminal",
        "allow-terminal-write",
        "allow-terminal-resize",
        "allow-terminate-terminals",
    ];
    assert_eq!(permissions, expected);
    assert!(permissions.iter().all(|permission| {
        !permission.contains("shell") && !permission.contains("fs:") && !permission.contains("http")
    }));
    let config = fs::read_to_string(root.join("tauri.conf.json")).unwrap();
    assert!(config.contains("\"productName\": \"Twiglane\""));
    assert!(config.contains("\"app\""));
    assert!(config.contains("\"dmg\""));
    assert!(config.contains("\"nsis\""));
    assert!(config.contains("\"downloadBootstrapper\""));
    assert!(config.contains("\"minimumSystemVersion\": \"13.0\""));
    assert!(config.contains("\"signingIdentity\": \"-\""));
    assert!(!config.to_ascii_lowercase().contains("shell"));
    let cargo = fs::read_to_string(root.join("Cargo.toml")).unwrap();
    assert!(!cargo.contains("tauri-plugin-shell"));
    // 真实终端由 portable-pty 提供，而不是通用 shell 插件。
    assert!(cargo.contains("portable-pty"));
    assert_source_has_no_shell(root.join("src").as_path());
    assert_terminal_start_is_fixed(root);
}

/// macOS 需要原生装饰框承载交通灯，Windows 用自绘标题栏。平台覆盖文件由 Tauri 以 RFC 7396
/// JSON Merge Patch 合并（`app.windows` 数组整体替换），所以这里直接调用 Tauri 的配置解析入口，
/// 核对 macOS 与 Windows 构建各自拿到的最终窗口配置。
#[test]
fn window_config_is_frameless_on_windows_and_decorated_on_macos() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let macos = merged_window(root, tauri::utils::platform::Target::MacOS);
    let windows = merged_window(root, tauri::utils::platform::Target::Windows);
    assert_eq!(windows["label"].as_str(), Some("main"));
    assert_eq!(
        windows["decorations"].as_bool(),
        Some(false),
        "Windows 用自绘标题栏"
    );
    assert!(
        windows.get("titleBarStyle").is_none(),
        "macOS 专属字段不得出现在 Windows 生效配置里"
    );
    assert_eq!(
        macos["decorations"].as_bool(),
        Some(true),
        "macOS 必须有装饰框，否则没有交通灯"
    );
    assert_eq!(macos["titleBarStyle"].as_str(), Some("Overlay"));
    assert_eq!(macos["hiddenTitle"].as_bool(), Some(true));
    for key in [
        "title",
        "width",
        "height",
        "minWidth",
        "minHeight",
        "resizable",
        "fullscreen",
    ] {
        assert_eq!(
            macos[key], windows[key],
            "{key} 在 base 与 macOS 覆盖中必须一致：合并会整体替换 app.windows 数组"
        );
    }
    for window in [&windows, &macos] {
        serde_json::from_value::<tauri::utils::config::WindowConfig>(window.clone())
            .expect("窗口配置必须被 Tauri 的窗口定义接受");
    }
}

fn merged_window(root: &Path, target: tauri::utils::platform::Target) -> serde_json::Value {
    let (config, paths) = tauri::utils::config::parse::read_from(target, root)
        .unwrap_or_else(|error| panic!("{target} 配置无法解析: {error}"));
    assert!(!paths.is_empty());
    config["app"]["windows"][0].clone()
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

/// 终端模块只能启动解析出的默认 shell；前端能调用的命令不得携带程序、参数或 shell 字段。
fn assert_terminal_start_is_fixed(root: &Path) {
    let source = fs::read_to_string(root.join("src/terminal.rs")).unwrap();
    assert_eq!(
        source.matches("CommandBuilder::new(").count(),
        1,
        "终端只能有一个固定的 shell 启动点"
    );
    assert!(
        source.contains("CommandBuilder::new(&shell)"),
        "终端必须使用解析后的默认 shell 启动"
    );
    assert!(
        source.contains("std::env::var_os(\"COMSPEC\")"),
        "Windows 默认 shell 必须来自 %COMSPEC%"
    );
    assert!(
        source.contains("std::env::var_os(\"SHELL\")"),
        "Unix 默认 shell 必须来自 $SHELL"
    );
    assert!(
        !source.contains("#[tauri::command]"),
        "终端命令只在 lib.rs 暴露，模块本身不注册额外 IPC"
    );

    let lib = fs::read_to_string(root.join("src/lib.rs")).unwrap();
    for name in [
        "open_terminal",
        "restart_terminal",
        "terminal_write",
        "terminal_resize",
        "terminate_terminals",
    ] {
        let signature = command_signature(&lib, name);
        for forbidden in ["program", "args:", "command:", "shell:", "cwd:", "env:"] {
            assert!(
                !signature.contains(forbidden),
                "{name} 不得接受前端指定的 {forbidden}: {signature}"
            );
        }
    }
}

fn command_signature<'a>(source: &'a str, name: &str) -> &'a str {
    let marker = format!("fn {name}(");
    let start = source
        .find(&marker)
        .unwrap_or_else(|| panic!("缺少命令 {name}"));
    let rest = &source[start..];
    let end = rest
        .find(") ->")
        .or_else(|| rest.find('{'))
        .expect("命令签名不完整");
    &rest[..end]
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
