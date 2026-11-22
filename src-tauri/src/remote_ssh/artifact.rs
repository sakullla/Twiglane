//! 按目标 system/architecture 选择已签名的 agent v2 产物。
//!
//! 发布物是每个目标平台一份的原生二进制，因此"没有匹配产物"是正常结果，
//! 必须在任何远端写入之前明确失败，绝不下载或本机编译一份替代品推上去。
//!
//! 发行流水线（`scripts/remote-worktree/agent-v2-manifest.mjs`）为每个产物计算
//! SHA-256，签署二进制和域分离的摘要声明并核实签名。桌面端按目标选择产物并核对
//! 清单摘要；交给 Cliora 连接器的摘要声明签名可在连接器独立验证。

use std::io::Read;
use std::path::Path;

use flate2::read::MultiGzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;

/// 单个产物大小上限：远大于当前 agent，也避免把任意大文件读进内存。
pub(crate) const MAX_ARTIFACT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_GZIP_BYTES: u64 = MAX_ARTIFACT_BYTES + 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub(crate) system: String,
    pub(crate) architecture: String,
    pub(crate) version: String,
    pub(crate) file: String,
    pub(crate) sha256: String,
    /// gzip 发行资源的摘要。sha256 和两种签名始终归属原始二进制。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) resource_sha256: Option<String>,
    #[serde(default)]
    pub(crate) signature: String,
    #[serde(default)]
    pub(crate) digest_signature: String,
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
    pub(crate) signature: String,
    pub(crate) digest_signature: String,
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

/// 目标系统与架构的规范化，供 SSH 探测和 Rust 组件自述共同使用。
pub(crate) fn normalize(system: &str, architecture: &str) -> Option<(String, String)> {
    let system = match system.trim().to_ascii_lowercase().as_str() {
        "linux" => "linux",
        "darwin" | "macos" | "mac os x" => "macos",
        "windows" => "windows",
        _ => return None,
    };
    let architecture = match architecture.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" | "x64" => "x86_64",
        "aarch64" | "arm64" if system != "windows" => "aarch64",
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
            format!("不支持远端目标 {system}/{architecture}：支持 Linux、macOS 的 x86_64/aarch64 和 Windows x64。"),
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
    if entry.file.split('/').any(|part| {
        part.is_empty()
            || matches!(part, "." | "..")
            || !part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    })
    {
        return Err(manifest_error());
    }
    let path = dir.join(&entry.file);
    let inside_bundle = std::fs::canonicalize(dir).and_then(|root| {
        std::fs::canonicalize(&path).map(|path| path.starts_with(root))
    });
    if inside_bundle.is_ok_and(|inside| !inside) {
        return Err(manifest_error());
    }
    let info = std::fs::metadata(&path).map_err(|_| {
        AppError::new(
            "agent_artifact_missing",
            "清单登记了远端组件，但发行包内没有该文件。请重新安装 Twiglane。",
        )
    })?;
    let wrapped = entry.file.ends_with(".gz");
    let resource_limit = if wrapped {
        MAX_GZIP_BYTES
    } else {
        MAX_ARTIFACT_BYTES
    };
    if !info.is_file() || info.len() > resource_limit || info.len() == 0 {
        return Err(AppError::new(
            "agent_artifact_missing",
            "远端组件文件缺失或大小异常。请重新安装 Twiglane。",
        ));
    }
    let mut resource = Vec::new();
    std::fs::File::open(&path)
        .map_err(|_| manifest_error())?
        .take(resource_limit + 1)
        .read_to_end(&mut resource)
        .map_err(|_| manifest_error())?;
    if resource.len() as u64 > resource_limit {
        return Err(manifest_error());
    }
    let bytes = if wrapped {
        let expected_resource = entry
            .resource_sha256
            .as_deref()
            .and_then(upper_hex)
            .ok_or_else(manifest_error)?;
        let resource_digest = format!("{:x}", Sha256::digest(&resource));
        if resource_digest != expected_resource {
            return Err(digest_mismatch());
        }
        let mut bytes = Vec::new();
        MultiGzDecoder::new(resource.as_slice())
            .take(MAX_ARTIFACT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| manifest_error())?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_ARTIFACT_BYTES {
            return Err(manifest_error());
        }
        bytes
    } else {
        if entry.resource_sha256.is_some() {
            return Err(manifest_error());
        }
        resource
    };
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != expected {
        return Err(digest_mismatch());
    }
    Ok(Artifact {
        bytes,
        sha256: digest,
        version: entry.version.clone(),
        signature: entry.signature.clone(),
        digest_signature: entry.digest_signature.clone(),
    })
}

fn digest_mismatch() -> AppError {
    AppError::new(
        "agent_digest_mismatch",
        "远端组件与发布清单的摘要不一致，拒绝安装。",
    )
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
    fn windows_amd64_selects_an_executable_and_its_digest_signature() {
        let dir = tempfile::tempdir().unwrap();
        let file = "Windows-x86_64/twiglane-agent-v2.exe";
        write(dir.path(), file, b"windows-agent");
        manifest(dir.path(), vec![Entry {
            system: "Windows".into(),
            architecture: "x86_64".into(),
            version: "0.3.40".into(),
            file: file.into(),
            sha256: digest(b"windows-agent"),
            resource_sha256: None,
            signature: "c2ln".into(),
            digest_signature: "YXR0".into(),
        }]);
        let selected = select(dir.path(), "windows", "AMD64").unwrap();
        assert_eq!(selected.bytes, b"windows-agent");
        assert_eq!(selected.digest_signature, "YXR0");
        assert!(normalize("Windows", "ARM64").is_none());
    }

    #[test]
    fn macos_gzip_resources_provide_the_original_signed_binary() {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let raw = b"\xcf\xfa\xed\xfeoriginal Mac binary";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(raw).unwrap();
        let mut wrapped = encoder.finish().unwrap();
        let file = "macOS-aarch64/twiglane-agent-v2.gz";
        write(dir.path(), file, &wrapped);
        manifest(
            dir.path(),
            vec![Entry {
                system: "macOS".into(),
                architecture: "aarch64".into(),
                version: "0.3.40".into(),
                file: file.into(),
                sha256: digest(raw),
                resource_sha256: Some(digest(&wrapped)),
                signature: "c2ln".into(),
                digest_signature: "YXR0".into(),
            }],
        );

        let selected = select(dir.path(), "Darwin", "arm64").unwrap();
        assert_eq!(selected.bytes, raw);
        assert_eq!(selected.sha256, digest(raw));
        assert_eq!(selected.signature, "c2ln");
        assert_eq!(selected.digest_signature, "YXR0");

        wrapped[4] ^= 1; // gzip timestamp only, uncompressed bytes are unchanged
        write(dir.path(), file, &wrapped);
        assert_eq!(
            select(dir.path(), "Darwin", "arm64").unwrap_err().code,
            "agent_digest_mismatch"
        );
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
                    resource_sha256: None,
                    signature: "c2lnbmF0dXJl".into(),
                    digest_signature: String::new(),
                },
                Entry {
                    system: "Darwin".into(),
                    architecture: "aarch64".into(),
                    version: "0.3.40".into(),
                    file: "macos-aarch64/twiglane-agent-v2".into(),
                    sha256: digest(b"mac-agent"),
                    resource_sha256: None,
                    signature: "c2lnbmF0dXJl".into(),
                    digest_signature: String::new(),
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
                resource_sha256: None,
                signature: "c2ln".into(),
                digest_signature: String::new(),
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
                resource_sha256: None,
                signature: "c2ln".into(),
                digest_signature: String::new(),
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
                resource_sha256: None,
                signature: "  ".into(),
                digest_signature: String::new(),
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
                resource_sha256: None,
                signature: "c2ln".into(),
                digest_signature: String::new(),
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
