//! Twiglane 远端 Git agent v2。
//!
//! 这个二进制不复制 Git 语义：它直接编译桌面端同一批 Rust 源文件（`src-tauri/src/model.rs`、
//! `src-tauri/src/git/**`、`state.rs`、`shutdown.rs`、`atomic.rs`、`watch.rs`），因此仓库
//! 模型、命令构造、状态解析、行统计、暂存/提交的写入顺序与保护条件都是同一份实现，不存在
//! 第二套「同效」定义。桌面专属的部分（Tauri 入口、`lib.rs` 的命令层、终端、更新、变更请求、
//! Cliora 接入）都不在这里。
//!
//! 与 v1 的关系：v1 的安装路径 `~/.local/share/twiglane/agent/v1`、`twiglane-agent/1` 版本
//! 字符串和 `XDG_STATE_HOME` 下的写入记录都保持不变；v2 只使用自己的协议号和 Git 目录内的
//! `twiglane-agent-v2/` 子目录，不读取也不 reinterpret v1 的记录。

// 共享源文件按桌面库的方式组织，桌面侧由 `pub` 命令层消费；这里只用到其中一部分，
// 其余 DTO 与辅助函数在远端进程内自然不可达，按模块统一放行 dead_code。
#[allow(dead_code)]
#[path = "../../../src-tauri/src/model.rs"]
mod model;
#[allow(dead_code)]
#[path = "../../../src-tauri/src/error.rs"]
mod error;
#[allow(dead_code)]
#[path = "../../../src-tauri/src/redact.rs"]
mod redact;
#[allow(dead_code)]
#[path = "../../../src-tauri/src/shutdown.rs"]
mod shutdown;
#[allow(dead_code)]
#[path = "../../../src-tauri/src/atomic.rs"]
mod atomic;
#[allow(dead_code)]
#[path = "../../../src-tauri/src/watch.rs"]
mod watch;
#[allow(dead_code)]
#[path = "../../../src-tauri/src/state.rs"]
mod state;
#[allow(dead_code)]
#[path = "../../../src-tauri/src/git/mod.rs"]
mod git;
// 共享源文件里的 #[cfg(test)] 单测依赖桌面侧的临时仓库脚手架。Cargo.toml 对 [[bin]] 设了
// test = false，所以 cargo test 不会在本 crate 里运行那些单测：它们仍由桌面
// cargo test --manifest-path src-tauri/Cargo.toml 覆盖，v2 自己的行为只由 tests/protocol.rs
// 以真实进程黑盒验证。这里编译 test_support 只是让 --all-targets 的检查不缺模块，
// 不代表本 crate 会跑那批单测。
#[allow(dead_code)]
#[cfg(test)]
#[path = "../../../src-tauri/src/test_support.rs"]
mod test_support;

// 边界适配：桌面侧的 workspaces 依赖 Tauri，远端进程只需要设置模型里的占位结构。
mod workspaces;

mod protocol;
mod receipts;
mod server;
mod session;

pub const AGENT_NAME: &str = "twiglane-agent/2";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    for arg in &args {
        match arg.as_str() {
            "--version" => {
                println!("{AGENT_NAME}");
                return;
            }
            "--probe" => {
                println!("{}", probe_line());
                return;
            }
            // 无参数也可启动；保留 --stdio 与 v1 的调用方式一致。
            "--stdio" => {}
            other => {
                eprintln!("twiglane-agent-v2: 未知参数 {other}");
                std::process::exit(2);
            }
        }
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("twiglane-agent-v2: 无法启动运行时：{error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = runtime.block_on(server::serve()) {
        eprintln!("twiglane-agent-v2: {} {}", error.code, error.message);
        std::process::exit(1);
    }
}

/// 目标探测：安装方在传输任何产物前据此选择 system/architecture 对应的签名包。
fn probe_line() -> String {
    let value = serde_json::json!({
        "protocol": protocol::PROTOCOL,
        "agent": AGENT_NAME,
        "version": VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "host": host_name(),
        "git": git_version(),
        "capabilities": protocol::CAPABILITIES,
    });
    value.to_string()
}

fn git_version() -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// 登录主机的显示名。只用于标识会话主机，不参与身份判断。
pub fn host_name() -> String {
    if let Ok(name) = std::env::var("HOSTNAME") {
        let name = name.trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    for path in ["/etc/hostname", "/proc/sys/kernel/hostname"] {
        if let Ok(name) = std::fs::read_to_string(path) {
            let name = name.trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    "unknown".to_string()
}
