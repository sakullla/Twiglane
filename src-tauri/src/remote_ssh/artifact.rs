//! 按目标 system/architecture 选择已签名的 agent v2 产物。
//!
//! 发布物是每个目标平台一份的原生二进制，因此"没有匹配产物"是正常结果，
//! 必须在任何远端写入之前明确失败，绝不下载或本机编译一份替代品推上去。
//!
//! 发行流水线（`scripts/remote-worktree/agent-v2-manifest.mjs`）为每个产物计算
//! SHA-256，并用 Twiglane 更新签名私钥对其签名（`--app-version` 绑定版本）；
//! 清单把摘要、签名与版本一起交给桌面端。运行时这里核对摘要与清单，签名由发布步骤
//! 用同一把公钥验证——运行时的密码学复核需要 `minisign-verify` 依赖（属 T1 的
//! Cargo.toml 范围），见 `docs/integrations/remote-worktree.md` 的"已知缺口"。

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;

/// 单个产物大小上限：远大于当前 agent，也避免把任意大文件读进内存。
pub(crate) const MAX_ARTIFACT_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub(crate) system: String,
    pub(crate) architecture: String,
    pub(crate) version: String,
    pub(crate) file: String,
    pub(crate) sha256: String,
    #[serde(default)]
    pub(crate) signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manifest {
    pub(crate) format: u32,
    pub(crate) artifacts: Vec<Entry>,
}

/// 选中的产物：字节、摘要、签名与版本。安装前先落到临时文件再核对，见 transport.rs。
pub(crate) struct Artifact {
    pub(crate) bytes: Vec<u8>,
    pub(crate) sha256: String,
    pub(crate) version: String,
}

impl std::fmt::Debug for Artifact {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Artifact")
            .field("sha256", &self.sha256)
            .field("version", &self.version)
            .field("bytes", &self.bytes.len())
            .finish()
    }
}

fn manifest_error() -> AppError {
    AppError::new(
        "agent_artifact_manifest",
        "远端组件清单无法读取或格式无效。请重新安装 Twiglane。",
    )
}

fn upper_hex(value: &str) -> Option<String> {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

/// 目标系统与架构的规范化：`uname` 会给出 `Darwin`/`Linux` 与
/// `arm64`/`aarch64`/`x86_64`/`amd64`，产物按 Rust 三元组命名。
pub(crate) fn normalize(system: &str, architecture: &str) -> Option<(String, String)> {
    let system = match system.trim().to_ascii_lowercase().as_str() {
        "linux" => "linux",
        "darwin" | "macos" | "mac os x" => "macos",
        _ => return None,
    };
    let architecture = match architecture.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" | "x64" => "x86_64",
        "aarch64" | "arm64" => "aarch64",
        _ => return None,
    };
    Some((system.into(), architecture.into()))
}

pub(crate) fn load_manifest(dir: &Path) -> Result<Manifest, AppError> {
    let bytes = std::fs::read(dir.join("manifest.json")).map_err(|_| manifest_error())?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| manifest_error())?;
    if manifest.format != 1 {
        return Err(manifest_error());
    }
    Ok(manifest)
}

/// 选择并读取目标产物。没有匹配项时返回明确错误，调用方不得开始任何上传。
pub(crate) fn select(dir: &Path, system: &str, architecture: &str) -> Result<Artifact, AppError> {
    let Some((system, architecture)) = normalize(system, architecture) else {
        return Err(AppError::new(
            "agent_artifact_unavailable",
            format!("不支持远端目标 {system}/{architecture}：Twiglane 只为 Linux 与 macOS 的 x86_64/aarch64 发行远端组件。"),
        ));
    };
    let manifest = load_manifest(dir)?;
    let entry = manifest
        .artifacts
        .iter()
        .find(|entry| {
            normalize(&entry.system, &entry.architecture)
                .is_some_and(|pair| pair == (system.clone(), architecture.clone()))
        })
        .ok_or_else(|| {
            AppError::new(
                "agent_artifact_unavailable",
                format!("没有匹配 {system}/{architecture} 的已签名远端组件，未安装、也未写入任何文件。"),
            )
        })?;
    let expected = upper_hex(&entry.sha256).ok_or_else(manifest_error)?;
    if entry.signature.trim().is_empty() || entry.signature.len() > 4096 {
        return Err(AppError::new(
            "agent_artifact_signature",
            "远端组件缺少发布签名，拒绝安装。",
        ));
    }
    if entry.file.is_empty()
        || entry.file.contains("..")
        || entry.file.starts_with('/')
        || entry.file.chars().any(char::is_control)
    {
        return Err(manifest_error());
    }
    let path = dir.join(&entry.file);
    let info = std::fs::metadata(&path).map_err(|_| {
        AppError::new(
            "agent_artifact_missing",
            "清单登记了远端组件，但发行包内没有该文件。请重新安装 Twiglane。",
        )
    })?;
    if !info.is_file() || info.len() > MAX_ARTIFACT_BYTES || info.len() == 0 {
        return Err(AppError::new(
            "agent_artifact_missing",
            "远端组件文件缺失或大小异常。请重新安装 Twiglane。",
        ));
    }
    let bytes = std::fs::read(&path).map_err(|_| manifest_error())?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != expected {
        return Err(AppError::new(
            "agent_digest_mismatch",
            "远端组件与发布清单的摘要不一致，拒绝安装。",
        ));
    }
    Ok(Artifact {
        bytes,
        sha256: digest,
        version: entry.version.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, file: &str, bytes: &[u8]) {
        let path = dir.join(file);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn manifest(dir: &Path, entries: Vec<Entry>) {
        let value = serde_json::to_vec(&Manifest {
            format: 1,
            artifacts: entries,
        })
        .unwrap();
        fs::write(dir.join("manifest.json"), value).unwrap();
    }

    #[test]
    fn selects_the_artifact_for_the_probed_target_only() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "linux-x86_64/twiglane-agent-v2", b"linux-agent");
        write(dir.path(), "macos-aarch64/twiglane-agent-v2", b"mac-agent");
        manifest(
            dir.path(),
            vec![
                Entry {
                    system: "Linux".into(),
                    architecture: "x86_64".into(),
                    version: "0.3.40".into(),
                    file: "linux-x86_64/twiglane-agent-v2".into(),
                    sha256: digest(b"linux-agent"),
                    signature: "c2lnbmF0dXJl".into(),
                },
                Entry {
                    system: "Darwin".into(),
                    architecture: "aarch64".into(),
                    version: "0.3.40".into(),
                    file: "macos-aarch64/twiglane-agent-v2".into(),
                    sha256: digest(b"mac-agent"),
                    signature: "c2lnbmF0dXJl".into(),
                },
            ],
        );
        let linux = select(dir.path(), "Linux", "amd64").unwrap();
        assert_eq!(linux.bytes, b"linux-agent");
        assert_eq!(linux.sha256, digest(b"linux-agent"));
        // uname 在不同平台给出 arm64 / aarch64，二者必须指向同一产物。
        let mac = select(dir.path(), "Darwin", "arm64").unwrap();
        assert_eq!(mac.bytes, b"mac-agent");
    }

    #[test]
    fn missing_target_fails_before_any_bytes_are_read() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "linux-x86_64/twiglane-agent-v2", b"linux-agent");
        manifest(
            dir.path(),
            vec![Entry {
                system: "Linux".into(),
                architecture: "x86_64".into(),
                version: "0.3.40".into(),
                file: "linux-x86_64/twiglane-agent-v2".into(),
                sha256: digest(b"linux-agent"),
                signature: "c2ln".into(),
            }],
        );
        let error = select(dir.path(), "Linux", "aarch64").unwrap_err();
        assert_eq!(error.code, "agent_artifact_unavailable");
        assert!(error.message.contains("linux/aarch64"), "{}", error.message);
        let unsupported = select(dir.path(), "FreeBSD", "x86_64").unwrap_err();
        assert_eq!(unsupported.code, "agent_artifact_unavailable");
    }

    #[test]
    fn tampered_or_unsigned_artifacts_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "linux-x86_64/twiglane-agent-v2", b"replaced");
        manifest(
            dir.path(),
            vec![Entry {
                system: "Linux".into(),
                architecture: "x86_64".into(),
                version: "0.3.40".into(),
                file: "linux-x86_64/twiglane-agent-v2".into(),
                sha256: digest(b"original"),
                signature: "c2ln".into(),
            }],
        );
        assert_eq!(
            select(dir.path(), "Linux", "x86_64").unwrap_err().code,
            "agent_digest_mismatch"
        );

        manifest(
            dir.path(),
            vec![Entry {
                system: "Linux".into(),
                architecture: "x86_64".into(),
                version: "0.3.40".into(),
                file: "linux-x86_64/twiglane-agent-v2".into(),
                sha256: digest(b"replaced"),
                signature: "  ".into(),
            }],
        );
        assert_eq!(
            select(dir.path(), "Linux", "x86_64").unwrap_err().code,
            "agent_artifact_signature"
        );

        manifest(
            dir.path(),
            vec![Entry {
                system: "Linux".into(),
                architecture: "x86_64".into(),
                version: "0.3.40".into(),
                file: "../escape".into(),
                sha256: digest(b"replaced"),
                signature: "c2ln".into(),
            }],
        );
        assert_eq!(
            select(dir.path(), "Linux", "x86_64").unwrap_err().code,
            "agent_artifact_manifest"
        );
    }

    #[test]
    fn missing_manifest_is_reported_not_guessed() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            select(dir.path(), "Linux", "x86_64").unwrap_err().code,
            "agent_artifact_manifest"
        );
    }
}
