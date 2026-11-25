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
        "dialog:allow-save",
        "updater:default",
        "core:app:allow-version",
        "process:allow-restart",
        "allow-detect-git",
        "allow-set-git-executable",
        "allow-clear-git-executable",
        "allow-get-settings",
        "allow-remote-review-begin",
        "allow-remote-review-accept",
        "allow-remote-review-end",
        "allow-remote-review-return",
        "allow-remote-worktree-targets",
        "allow-remote-worktree-open",
        "allow-remote-worktree-cancel-open",
        "allow-remote-worktree-close",
        "allow-remote-worktree-status",
        "allow-remote-worktree-diff",
        "allow-remote-worktree-write",
        "allow-remote-worktree-recover",
        // 通用远端桥接只开放 op 白名单内的 Git 能力：没有 shell、程序、工作目录或环境变量。
        "allow-remote-worktree-call",
        "allow-remote-worktree-file-copy",
        "allow-remote-change-request",
        "allow-remote-worktree-events",
        "allow-remote-worktree-cancel-reads",
        "allow-remote-ssh-settings",
        "allow-set-remote-ssh-enabled",
        "allow-remote-ssh-save-target",
        "allow-remote-ssh-delete-target",
        "allow-remote-ssh-set-password",
        "allow-remote-ssh-delete-password",
        "allow-remote-ssh-test",
        "allow-remote-ssh-cancel",
        "allow-remote-ssh-install-agent",
        "allow-workspace-list",
        "allow-workspace-create",
        "allow-workspace-preview",
        "allow-workspace-attach",
        "allow-workspace-update",
        "allow-workspace-refresh",
        "allow-workspace-publish",
        "allow-workspace-favorite",
        "allow-workspace-candidates",
        "allow-workspace-discover",
        "allow-workspace-cancel-discovery",
        "allow-workspace-delete",
        "allow-workspace-preview-link",
        "allow-workspace-open-in-cliora",
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
        // 结构操作只接受仓库相对路径；永久删除是独立命令，不是回收站命令的隐式参数。
        // 批量删除同样只收相对路径数组：没有 shell、没有任意路径。
        "allow-repository-create-entry",
        "allow-repository-copy-entry",
        "allow-repository-move-entry",
        "allow-repository-delete-entry",
        "allow-repository-delete-entries",
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
        "allow-fetch-branches",
        "allow-pull-fast-forward",
        "allow-push-branch",
        "allow-publish-branch",
        "allow-associate-upstream",
        "allow-set-upstream",
        "allow-commit-and-push",
        "allow-branch-state",
        "allow-branch-list",
        "allow-branch-tracking",
        "allow-update-branch",
        "allow-push-local-branch",
        "allow-create-branch",
        "allow-create-branch-from",
        // 新建分支并放进新的附属工作区：参数只有仓库路径、分支名、起点与父目录下的一段目录名。
        "allow-create-worktree",
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
        "allow-revert-commits",
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
        "allow-amend-commit",
        "allow-discard-changes",
        "allow-set-theme",
        "allow-set-pull-integration",
        "allow-set-branch-groups",
        "allow-set-files-view",
        "allow-set-change-requests-enabled",
        // change-request 平台命令只接受仓库路径与用户输入；令牌不进普通设置，
        // 没有 shell、文件系统或任意 HTTP 权限。
        "allow-change-request-prepare",
        "allow-change-request-create",
        "allow-change-request-token-status",
        "allow-change-request-set-token",
        "allow-change-request-delete-token",
        "allow-change-request-draft",
        "allow-change-request-open-web",
        "allow-change-request-instances",
        "allow-change-request-save-instance",
        "allow-change-request-delete-instance",
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
        "allow-cliora-review-forget",
        "allow-cliora-review-sources",
        // feedback-v1 交接只有一个命令：校验、写私有一次性文件、打开标识深链。没有正文出口。
        "allow-prepare-review-feedback",
        // 终端只开放结构化命令：探测类型、列出/新建/附着/重启/关闭会话、写入、resize、
        // 全部终止与保存偏好。没有任何命令允许前端指定程序、参数或仓库之外的工作目录。
        "allow-terminal-profiles",
        "allow-terminal-list",
        "allow-terminal-create",
        "allow-terminal-attach",
        "allow-terminal-restart",
        "allow-terminal-close",
        "allow-set-terminal-prefs",
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

#[test]
fn entry_commands_are_relative_structured_and_delete_location_is_explicit() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let lib = fs::read_to_string(root.join("src/lib.rs")).unwrap();
    for name in [
        "repository_create_entry",
        "repository_copy_entry",
        "repository_move_entry",
        "repository_delete_entry",
    ] {
        let signature = command_signature(&lib, name);
        assert!(signature.contains("generation: u64"), "{name}");
        assert!(signature.contains("request_id: u64"), "{name}");
        for forbidden in ["absolute", "permanent", "args:", "command:", "shell:"] {
            assert!(!signature.contains(forbidden), "{name}: {signature}");
        }
    }
    for name in ["repository_copy_entry", "repository_move_entry"] {
        let signature = command_signature(&lib, name);
        assert!(signature.contains("source: String"), "{name}");
        assert!(signature.contains("target: String"), "{name}");
    }
    let create = command_signature(&lib, "repository_create_entry");
    assert!(create.contains("relative: String") && create.contains("kind:"));
    let delete = command_signature(&lib, "repository_delete_entry");
    assert!(delete.contains("relative: String") && !delete.contains("target:"));
    // 删除命令只收仓库相对路径数组；落点由显式 permanent 布尔决定，没有绝对路径或 shell 片段。
    let batch = command_signature(&lib, "repository_delete_entries");
    for required in ["relatives: Vec<String>", "permanent: bool", "generation: u64", "request_id: u64"] {
        assert!(batch.contains(required), "{required}");
    }
    for forbidden in ["absolute", "target:", "args:", "command:", "shell:", "relative: String"] {
        assert!(!batch.contains(forbidden), "{forbidden}: {batch}");
    }
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
        let source = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
        // This trailing test module launches the fixed Windows transport via
        // cmd to exercise OpenSSH's Windows command-line decoding.
        let text = if path.ends_with(Path::new("remote_ssh/transport.rs")) {
            source.split_once("#[cfg(test)]\nmod tests {").map_or(source.as_str(), |(code, _)| code)
        } else {
            source.as_str()
        };
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
        source.contains("CommandBuilder::new(&spec.program)"),
        "终端必须使用后端解析出的终端类型启动"
    );
    for candidate in ["\"pwsh.exe\"", "\"powershell.exe\"", "find_git_bash()", "\"wsl.exe\""] {
        assert!(
            source.contains(candidate),
            "Windows 终端类型必须来自固定候选：缺少 {candidate}"
        );
    }
    assert!(
        source.find("\"pwsh.exe\"") < source.find("\"powershell.exe\""),
        "Windows 默认 shell 必须优先 PowerShell 7，其次 5.1"
    );
    assert!(
        source.contains("std::env::var_os(\"COMSPEC\")"),
        "Windows 缺少 PowerShell 时必须退回 %COMSPEC%"
    );
    assert!(
        source.contains("std::env::var_os(\"SHELL\")"),
        "Unix 默认 shell 必须来自 $SHELL"
    );
    assert!(
        source.contains("fn resolve_profile("),
        "前端只能按 id 选择探测结果"
    );
    assert!(
        !source.contains("#[tauri::command]"),
        "终端命令只在 lib.rs 暴露，模块本身不注册额外 IPC"
    );

    let lib = fs::read_to_string(root.join("src/lib.rs")).unwrap();
    for name in [
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

/// 三处注册必须逐名字一致：`generate_handler!` 里的命令、`build.rs` 的
/// `AppManifest::commands` 与 `capabilities/default.json` 的 allow-* 权限。
///
/// 任何一处漏加都会让命令在打包后不可调用（或被 capabilities 拒绝），而漏加只会
/// 表现为运行时的 `not allowed`，所以这里做全量比对而不是只抽查新增项。
#[test]
fn command_registration_is_identical_in_handler_manifest_and_capabilities() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let lib = fs::read_to_string(root.join("src/lib.rs")).unwrap();
    let marker = "generate_handler![";
    let start = lib.find(marker).expect("缺少 generate_handler") + marker.len();
    let end = lib[start..]
        .find("])")
        .map(|offset| start + offset)
        .expect("generate_handler 缺少结尾");
    let handler = registered_commands(&lib[start..end]);

    let build = fs::read_to_string(root.join("build.rs")).unwrap();
    let marker = "commands(&[";
    let start = build.find(marker).expect("缺少 AppManifest::commands") + marker.len();
    let end = build[start..]
        .find("])")
        .map(|offset| start + offset)
        .expect("AppManifest::commands 缺少结尾");
    let manifest = registered_commands(&build[start..end]);

    let capabilities: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("capabilities/default.json")).unwrap(),
    )
    .unwrap();
    let mut allowed: Vec<String> = capabilities["permissions"]
        .as_array()
        .expect("capabilities permissions 必须是数组")
        .iter()
        .filter_map(|value| value.as_str())
        .filter_map(|permission| permission.strip_prefix("allow-"))
        .map(|name| name.replace('-', "_"))
        .collect();
    allowed.sort();

    assert_eq!(handler, manifest, "generate_handler 与 build.rs 不一致");
    assert_eq!(handler, allowed, "capabilities 与命令注册不一致");
    for command in ["remote_worktree_call", "remote_worktree_events", "remote_worktree_cancel_reads"] {
        assert!(handler.iter().any(|name| name == command), "{command} 必须在三处同时登记");
    }
}

/// 从注册片段里取出命令名：`module::command` 与 `"command"` 两种写法都取最后一段。
fn registered_commands(source: &str) -> Vec<String> {
    let mut names: Vec<String> = source
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == ':' || c == '"'))
        .map(|token| token.trim_matches('"'))
        .filter_map(|token| token.rsplit("::").next())
        .filter(|token| {
            !token.is_empty()
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        })
        .map(str::to_string)
        .collect();
    names.sort();
    names.dedup();
    names
}

fn command_signature<'a>(source: &'a str, name: &str) -> &'a str {
    let marker = format!("fn {name}(");
    let start = source
        .find(&marker)
        .or_else(|| source.find(&format!("fn {name}<")))
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
