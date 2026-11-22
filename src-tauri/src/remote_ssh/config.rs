//! 冻结 OpenSSH 解析后的有效配置，并绑定实际对端与信任材料。
//!
//! 一次连接只消费这里的快照：别名、Host/Match/Include 或 include 的文件在选择之后
//! 被改动，不会把上传或会话换到另一台主机。规则与 Cliora 已实机验证的 v1 连接器一致
//! （`ssh -G` 快照、known_hosts/撤销文件、ProxyJump、实际对端身份、配置修订），
//! 但这里不查找也不调用 Cliora。

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::state::SshTarget;

use super::SshExec;

/// 任何一次连接都固定的 OpenSSH 选项：不共享控制通道、不转发、不允许本地命令，
/// 密码提示最多一次。探测、安装、会话用同一组参数，避免三条路径的实际配置不同。
const WRAPPER: [&str; 13] = [
    "-T",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "NumberOfPasswordPrompts=1",
];

/// 冻结配置里额外固定的项：信任只按快照里的文件核对，不接受新的主机密钥。
const FROZEN: [&str; 4] = [
    "ControlMaster no",
    "ControlPath none",
    "UpdateHostKeys no",
    "NoHostAuthenticationForLocalhost no",
];

/// ProxyJump 最多展开的跳板层级；超过就明确失败，不猜。
const MAX_HOPS: usize = 4;

fn unavailable() -> AppError {
    AppError::new(
        "ssh_configuration_unavailable",
        "无法读取该主机的有效 SSH 配置。请检查主机别名、配置文件与已知主机文件。",
    )
}

fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `ssh -G` 把单个操作数原样打印、不带来源引号；路径或用户名里有空格时
/// 需要还原它们的 token 边界。
fn quoted_option(key: &str) -> bool {
    matches!(
        key,
        "identityfile"
            | "certificatefile"
            | "identityagent"
            | "pkcs11provider"
            | "securitykeyprovider"
            | "revokedhostkeys"
            | "xauthlocation"
            | "controlpath"
            | "user"
            | "hostname"
            | "hostkeyalias"
            | "bindaddress"
            | "bindinterface"
            | "setenv"
    )
}

fn parse_profile(text: &str) -> Result<Vec<(String, String)>, AppError> {
    let mut lines = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(' ') else {
            return Err(unavailable());
        };
        if value.chars().any(char::is_control) {
            return Err(unavailable());
        }
        lines.push((key.to_ascii_lowercase(), value.to_string()));
    }
    if lines.is_empty() {
        return Err(unavailable());
    }
    Ok(lines)
}

fn run_profile(exec: &SshExec, args: &[OsString]) -> Result<Vec<(String, String)>, AppError> {
    let mut command = exec.command();
    command.arg("-G");
    for flag in WRAPPER {
        command.arg(flag);
    }
    command.args(args);
    let output = command.output().map_err(|_| {
        AppError::new(
            "ssh_unavailable",
            "无法执行 OpenSSH 客户端（ssh）。请确认已安装 OpenSSH 并可从 PATH 调用。",
        )
    })?;
    if !output.status.success() || output.stdout.len() > 256 * 1024 {
        return Err(unavailable());
    }
    let text = String::from_utf8(output.stdout).map_err(|_| unavailable())?;
    parse_profile(&text)
}

fn base_args(target: &SshTarget) -> Vec<OsString> {
    let mut args = Vec::new();
    if let Some(config) = &target.ssh_config {
        args.push(OsString::from("-F"));
        args.push(OsString::from(config));
    }
    args.push(OsString::from("-p"));
    args.push(OsString::from(target.port.to_string()));
    args.push(OsString::from("-l"));
    args.push(OsString::from(&target.user));
    if target.auth_method == "key" {
        if let Some(identity) = &target.identity_file {
            args.push(OsString::from("-i"));
            args.push(OsString::from(identity));
        }
    }
    args
}

/// 跳板只看它自己的用户配置：根目标的端口和用户名不能套到跳板上。
fn hop_args(target: &SshTarget) -> Vec<OsString> {
    match &target.ssh_config {
        Some(config) => vec![OsString::from("-F"), OsString::from(config)],
        None => Vec::new(),
    }
}

fn jump_destination(hop: &str) -> String {
    if hop.starts_with("ssh://") {
        hop.to_string()
    } else {
        format!("ssh://{hop}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hop {
    pub(crate) alias: String,
    pub(crate) hostname: String,
    pub(crate) user: String,
    pub(crate) port: String,
}

/// 一次连接的有效配置快照：冻结的 Host 段、信任文件内容、跳板链与修订。
pub(crate) struct Snapshot {
    /// 配置修订：目标身份字段 + 冻结配置 + 信任文件内容 + 跳板链。
    /// 只改显示名或默认目录不会改变它。
    pub(crate) revision: String,
    /// OpenSSH 实际解析出的主机名，用于界面展示。
    pub(crate) hostname: String,
    sections: Vec<(String, String)>,
    trust: Vec<(PathBuf, Option<Vec<u8>>)>,
    pub(crate) hops: Vec<Hop>,
}

impl Snapshot {
    pub(crate) fn resolve(exec: &SshExec, target: &SshTarget) -> Result<Self, AppError> {
        let mut root = base_args(target);
        root.push(OsString::from("--"));
        root.push(OsString::from(format!("{}@{}", target.user, target.host)));
        let root_profile = run_profile(exec, &root)?;

        let mut sections: Vec<(String, String)> = Vec::new();
        let mut trust = Vec::new();
        let mut hops: Vec<Hop> = Vec::new();
        let mut hostname = None;
        let mut seen: BTreeSet<String> = BTreeSet::new();

        // 待解析队列：根目标用上面已经拿到的 profile，跳板按需再问一次 ssh -G。
        let mut pending: Vec<(String, bool)> = vec![(String::new(), true)];
        let mut index = 0;
        while index < pending.len() {
            let (destination, is_root) = pending[index].clone();
            index += 1;
            let profile = if is_root {
                root_profile.clone()
            } else {
                let mut args = hop_args(target);
                args.push(OsString::from("--"));
                args.push(OsString::from(&destination));
                run_profile(exec, &args)?
            };

            let mut body = String::new();
            let mut section_name = None;
            let mut host = None;
            let mut user = None;
            let mut port = None;
            let mut jumps = Vec::new();
            for (key, value) in &profile {
                match key.as_str() {
                    "host" => {
                        section_name = Some(value.clone());
                        continue;
                    }
                    "hostname" => host = Some(value.clone()),
                    "user" => user = Some(value.clone()),
                    "port" => port = Some(value.clone()),
                    "userknownhostsfile" | "globalknownhostsfile" | "revokedhostkeys" => {
                        let multiple = key != "revokedhostkeys";
                        body.push_str(&trust_directive(key, value, multiple, &mut trust)?);
                        continue;
                    }
                    "proxyjump" if value != "none" => {
                        jumps.extend(value.split(',').map(str::to_owned));
                        continue;
                    }
                    // ssh -G 已经做过 canonicalization，重复它可能因 DNS 或配置变化改目标。
                    "canonicalizehostname" => {
                        body.push_str("canonicalizehostname no\n");
                        continue;
                    }
                    // 自定义 KnownHostsCommand 让信任来自任意程序，快照无法冻结它的输出。
                    "knownhostscommand" => continue,
                    _ => {}
                }
                if quoted_option(key) {
                    body.push_str(&format!("{key} {}\n", quoted(value)));
                } else {
                    body.push_str(&format!("{key} {value}\n"));
                }
            }
            let resolved_host = host.ok_or_else(unavailable)?;
            let alias = match (section_name, is_root) {
                (Some(name), _) => name,
                (None, true) => target.host.clone(),
                (None, false) => return Err(unavailable()),
            };
            if alias.is_empty()
                || alias.contains(['*', '?', '!', '\\', '"'])
                || alias.chars().any(char::is_whitespace)
            {
                return Err(unavailable());
            }
            if !seen.insert(alias.clone()) {
                return Err(unavailable());
            }
            if seen.len() > MAX_HOPS + 1 {
                return Err(unavailable());
            }
            if !is_root {
                hops.push(Hop {
                    alias: alias.clone(),
                    hostname: resolved_host.clone(),
                    user: user.clone().unwrap_or_else(|| target.user.clone()),
                    port: port.clone().unwrap_or_else(|| "22".into()),
                });
            }
            hostname.get_or_insert(resolved_host);
            sections.push((alias, body));
            if pending.len() + jumps.len() > MAX_HOPS + 1 {
                return Err(unavailable());
            }
            for hop in jumps {
                pending.push((jump_destination(&hop), false));
            }
        }

        let mut digest = Sha256::new();
        digest.update(target.host.as_bytes());
        digest.update([0]);
        digest.update(target.port.to_string().as_bytes());
        digest.update([0]);
        digest.update(target.user.as_bytes());
        digest.update([0]);
        digest.update(target.auth_method.as_bytes());
        digest.update([0]);
        digest.update(target.identity_file.as_deref().unwrap_or("").as_bytes());
        digest.update([0]);
        digest.update(target.ssh_config.as_deref().unwrap_or("").as_bytes());
        digest.update([0, u8::from(target.enabled)]);
        for (alias, body) in &sections {
            digest.update(alias.as_bytes());
            digest.update([0]);
            digest.update(body.as_bytes());
        }
        for (path, bytes) in &trust {
            digest.update(path.as_os_str().as_encoded_bytes());
            digest.update([0]);
            match bytes {
                Some(bytes) => {
                    digest.update([1]);
                    digest.update(Sha256::digest(bytes));
                }
                None => digest.update([0]),
            }
        }
        for hop in &hops {
            digest.update(hop.alias.as_bytes());
            digest.update([0]);
            digest.update(hop.hostname.as_bytes());
            digest.update([0]);
            digest.update(hop.user.as_bytes());
            digest.update([0]);
            digest.update(hop.port.as_bytes());
        }
        Ok(Self {
            revision: format!("{:x}", digest.finalize()),
            hostname: hostname.ok_or_else(unavailable)?,
            sections,
            trust,
            hops,
        })
    }

    /// 把冻结配置与信任材料写进本次连接的私有目录，返回 `ssh` 参数（止于 `--` 与目标）。
    /// 目录生命周期跟随调用方：连接结束即删除，权限只给当前用户。
    pub(crate) fn args(&self, folder: &Path, target: &SshTarget) -> Result<Vec<OsString>, AppError> {
        for (index, (_, bytes)) in self.trust.iter().enumerate() {
            if let Some(bytes) = bytes {
                let file = folder.join(format!("trust-{index}"));
                let mut handle = fs::File::create(&file).map_err(|_| unavailable())?;
                handle.write_all(bytes).map_err(|_| unavailable())?;
            }
        }
        let mut output = String::new();
        for (alias, body) in &self.sections {
            output.push_str("Host ");
            output.push_str(alias);
            output.push('\n');
            output.push_str("StrictHostKeyChecking yes\n");
            for line in FROZEN {
                output.push_str(line);
                output.push('\n');
            }
            for line in body.lines() {
                let Some((key, value)) = line.split_once(' ') else {
                    output.push_str(line);
                    output.push('\n');
                    continue;
                };
                if matches!(
                    key,
                    "userknownhostsfile" | "globalknownhostsfile" | "revokedhostkeys"
                ) && value != "none"
                {
                    output.push_str(key);
                    for part in value.split_whitespace() {
                        let index = part.parse::<usize>().map_err(|_| unavailable())?;
                        if index >= self.trust.len() {
                            return Err(unavailable());
                        }
                        output.push(' ');
                        let file = folder.join(format!("trust-{index}"));
                        output.push_str(&quoted(&file.to_string_lossy()));
                    }
                    output.push('\n');
                    continue;
                }
                output.push_str(line);
                output.push('\n');
            }
        }
        let config = folder.join("config");
        let mut handle = fs::File::create(&config).map_err(|_| unavailable())?;
        handle
            .write_all(output.as_bytes())
            .map_err(|_| unavailable())?;
        let mut args: Vec<OsString> = vec![
            OsString::from("-F"),
            config.into_os_string(),
            OsString::from("-p"),
            OsString::from(target.port.to_string()),
            OsString::from("-l"),
            OsString::from(&target.user),
        ];
        for flag in WRAPPER {
            args.push(OsString::from(flag));
        }
        args.push(OsString::from("--"));
        args.push(OsString::from(format!("{}@{}", target.user, target.host)));
        Ok(args)
    }

    /// 实际对端身份：本次连接 OpenSSH 出示的主机密钥。持久回执绑它，不绑显示名。
    pub(crate) fn peer_identity(host_keys: &[String]) -> Option<String> {
        if host_keys.is_empty() {
            return None;
        }
        let mut digest = Sha256::new();
        for key in host_keys {
            digest.update(key.as_bytes());
            digest.update([0]);
        }
        Some(format!("{:x}", digest.finalize()))
    }
}

/// 信任文件的原文进入修订；文件不存在与空文件是不同状态。
fn trust_directive(
    key: &str,
    value: &str,
    multiple: bool,
    trust: &mut Vec<(PathBuf, Option<Vec<u8>>)>,
) -> Result<String, AppError> {
    if value == "none" {
        return Ok(format!("{key} none\n"));
    }
    let parts: Vec<&str> = if multiple {
        value.split_whitespace().collect()
    } else {
        vec![value]
    };
    if parts.is_empty() {
        return Ok(format!("{key} none\n"));
    }
    let mut indices = Vec::new();
    for part in parts {
        let path = trust_path(part)?;
        if let Some(index) = trust.iter().position(|(known, _)| known == &path) {
            indices.push(index.to_string());
            continue;
        }
        let bytes = match fs::metadata(&path) {
            Ok(info) if info.is_file() => {
                if info.len() > 8 * 1024 * 1024 {
                    return Err(AppError::new(
                        "ssh_trust_unavailable",
                        "已知主机文件过大，拒绝读取。",
                    ));
                }
                Some(fs::read(&path).map_err(|_| {
                    AppError::new("ssh_trust_unavailable", "无法读取已知主机文件。")
                })?)
            }
            Ok(info) if info.is_dir() => {
                return Err(AppError::new(
                    "ssh_trust_unavailable",
                    "已知主机路径不是文件。",
                ))
            }
            // /dev/null 一类的设备文件按"存在但没有内容"处理。
            Ok(_) => Some(Vec::new()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => {
                return Err(AppError::new("ssh_trust_unavailable", "无法读取已知主机文件。"))
            }
        };
        indices.push(trust.len().to_string());
        trust.push((path, bytes));
    }
    // 按索引引用冻结的文件，ProgramData 和单路径参数中的空格不会改变路径边界。
    Ok(format!("{key} {}\n", indices.join(" ")))
}

fn trust_path(value: &str) -> Result<PathBuf, AppError> {
    #[cfg(windows)]
    if let Some(tail) = value.strip_prefix("__PROGRAMDATA__") {
        // ssh -G 原样打印 Win32 OpenSSH 的两个内建全局路径。只展开固定的目录和文件名。
        let normalized = tail.replace('\\', "/");
        let file = match normalized.as_str() {
            "/ssh/ssh_known_hosts" => "ssh_known_hosts",
            "/ssh/ssh_known_hosts2" => "ssh_known_hosts2",
            _ => return Err(unavailable()),
        };
        let dir = program_data()?;
        return Ok(dir.join("ssh").join(file));
    }
    let path = PathBuf::from(value);
    path.is_absolute().then_some(path).ok_or_else(unavailable)
}

#[cfg(windows)]
fn program_data() -> Result<PathBuf, AppError> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{
        FOLDERID_ProgramData, KF_FLAG_DEFAULT, SHGetKnownFolderPath,
    };

    // SAFETY: Folder ID is valid and no user token is required for ProgramData. A
    // successful lookup gives a NUL-terminated UTF-16 allocation owned by the caller.
    let path = unsafe {
        let name = SHGetKnownFolderPath(&FOLDERID_ProgramData, KF_FLAG_DEFAULT, None)
            .map_err(|_| unavailable())?;
        let path = PathBuf::from(OsString::from_wide(name.as_wide()));
        CoTaskMemFree(Some(name.0.cast()));
        path
    };
    path.is_absolute().then_some(path).ok_or_else(unavailable)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn native_windows_ssh_defaults_are_frozen_as_absolute_trust_files() {
        let target = SshTarget {
            id: "windows-profile".into(),
            display_name: "Windows OpenSSH".into(),
            host: "localhost".into(),
            port: 22,
            user: "fixture".into(),
            auth_method: "agent".into(),
            identity_file: None,
            ssh_config: Some("none".into()),
            default_path: None,
            enabled: true,
            shared_host_id: None,
            revision: 0,
        };
        let exec = SshExec {
            program: PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/OpenSSH/ssh.exe"),
            env: Vec::new(),
        };
        let snapshot = Snapshot::resolve(&exec, &target).unwrap();
        for name in ["ssh_known_hosts", "ssh_known_hosts2"] {
            let expected = program_data().unwrap().join("ssh").join(name);
            assert!(snapshot.trust.iter().any(|(path, _)| path == &expected));
        }
        let dir = tempfile::Builder::new()
            .prefix("Twiglane SSH profile ")
            .tempdir()
            .unwrap();
        let args = snapshot.args(dir.path(), &target).unwrap();
        let frozen = fs::read_to_string(dir.path().join("config")).unwrap();
        assert!(!frozen.contains("__PROGRAMDATA__"));
        assert!(frozen.contains("StrictHostKeyChecking yes"));
        let checked = exec.command().arg("-G").args(args).output().unwrap();
        assert!(checked.status.success(), "{:?}", checked.status);
    }

    #[test]
    fn windows_program_data_token_rejects_paths_outside_the_default_pair() {
        for path in [
            r"__PROGRAMDATA__\..\ssh_known_hosts",
            r"__PROGRAMDATA__\ssh\ssh_known_hosts:alternate",
            r"__PROGRAMDATA__\C:\ssh\ssh_known_hosts",
            r"__PROGRAMDATA__ssh\ssh_known_hosts",
        ] {
            assert!(trust_path(path).is_err(), "{path}");
        }
    }
}
