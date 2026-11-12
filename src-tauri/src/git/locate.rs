use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use regex::Regex;

use crate::error::AppError;
use crate::git::command::version_command;
use crate::git::runner::{run_process, RealRunner};
use crate::model::GitInfo;
use crate::redact::redact_error_text;
use crate::shutdown::Shutdown;

static VERSION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)git version\s+(\d+)\.(\d+)(?:\.(\d+))?").expect("git version regex")
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedGit {
    pub path: PathBuf,
    pub version: String,
    pub major: u64,
    pub minor: u64,
    pub below_baseline: bool,
}

#[derive(Debug, Clone)]
pub struct GitLocator {
    configured: Option<PathBuf>,
    resolved: Option<ResolvedGit>,
}

impl GitLocator {
    pub fn from_configured(path: Option<String>) -> Self {
        Self {
            configured: path.map(PathBuf::from),
            resolved: None,
        }
    }

    pub fn resolved(&self) -> Option<&ResolvedGit> {
        self.resolved.as_ref()
    }

    pub fn set_resolved(&mut self, resolved: ResolvedGit) {
        self.configured = Some(resolved.path.clone());
        self.resolved = Some(resolved);
    }

    pub fn clear_override(&mut self) {
        self.configured = None;
        self.resolved = None;
    }

    pub fn configured_path(&self) -> Option<PathBuf> {
        self.configured.clone()
    }

    pub fn apply_detection(&mut self, expected: Option<PathBuf>, detection: Detection) -> GitInfo {
        if self.configured != expected {
            return self.info();
        }
        match detection {
            Detection::Resolved(resolved) => {
                self.resolved = Some(resolved);
                self.info()
            }
            Detection::OverrideFailed { path, message } => {
                self.resolved = None;
                GitInfo {
                    available: false,
                    path: Some(path),
                    version: None,
                    overridden: true,
                    below_baseline: false,
                    message,
                }
            }
            Detection::Missing => {
                self.resolved = None;
                self.info()
            }
        }
    }

    pub fn info(&self) -> GitInfo {
        if let Some(resolved) = &self.resolved {
            let message = if resolved.below_baseline {
                format!(
                    "已检测到 Git {}，低于建议基线 2.48，仍会继续使用。",
                    resolved.version
                )
            } else {
                format!("已检测到 Git {}。", resolved.version)
            };
            return GitInfo {
                available: true,
                path: Some(resolved.path.display().to_string()),
                version: Some(resolved.version.clone()),
                overridden: self.configured.is_some(),
                below_baseline: resolved.below_baseline,
                message,
            };
        }
        if let Some(path) = &self.configured {
            return GitInfo {
                available: false,
                path: Some(path.display().to_string()),
                version: None,
                overridden: true,
                below_baseline: false,
                message: "已选择的 Git 无法执行。可以重新选择，或恢复自动检测。".into(),
            };
        }
        GitInfo {
            available: false,
            path: None,
            version: None,
            overridden: false,
            below_baseline: false,
            message: "未检测到 Git。请安装 Git 或选择可执行文件后重试。".into(),
        }
    }
}

pub enum Detection {
    Resolved(ResolvedGit),
    OverrideFailed { path: String, message: String },
    Missing,
}

pub async fn detect_git_binary(
    runner: &RealRunner,
    shutdown: &Arc<Shutdown>,
    configured: Option<PathBuf>,
) -> Detection {
    if let Some(path) = configured {
        return match validate_git(runner, shutdown, &path).await {
            Ok(resolved) => Detection::Resolved(resolved),
            Err(error) => Detection::OverrideFailed {
                path: path.display().to_string(),
                message: error.message,
            },
        };
    }
    for candidate in candidates() {
        if !is_executable(&candidate) {
            continue;
        }
        if let Ok(resolved) = validate_git(runner, shutdown, &candidate).await {
            return Detection::Resolved(resolved);
        }
    }
    Detection::Missing
}

pub async fn validate_git(
    runner: &RealRunner,
    shutdown: &Arc<Shutdown>,
    path: &Path,
) -> Result<ResolvedGit, AppError> {
    let canonical = dunce::canonicalize(path).map_err(|_| {
        AppError::new(
            "git_invalid",
            "无法读取所选 Git 可执行文件，未替换当前检测结果。",
        )
    })?;
    if !is_executable(&canonical) {
        return Err(AppError::new(
            "git_invalid",
            "所选路径不是可执行文件，未替换当前检测结果。",
        ));
    }
    let (program, args) = version_command(&canonical);
    let output = run_process(runner.base_request(program, args, shutdown.clone()))
        .await
        .map_err(|error| {
            AppError::new(
                "git_invalid",
                format!(
                    "无法执行所选 Git：{}",
                    redact_error_text(&format!("{error:?}"))
                ),
            )
        })?;
    if output.exit_code != 0 {
        return Err(AppError::new(
            "git_invalid",
            "所选文件没有返回 Git 版本，未替换当前检测结果。",
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr.to_string()
    } else {
        stdout.to_string()
    };
    let mut resolved = parse_git_version(&text)?;
    resolved.path = canonical;
    Ok(resolved)
}

pub fn parse_git_version(text: &str) -> Result<ResolvedGit, AppError> {
    let Some(captures) = VERSION_RE.captures(text) else {
        return Err(AppError::new(
            "git_invalid",
            "所选文件没有返回可识别的 Git 版本，未替换当前检测结果。",
        ));
    };
    let major: u64 = captures[1].parse().unwrap_or(0);
    let minor: u64 = captures[2].parse().unwrap_or(0);
    let patch = captures.get(3).map(|value| value.as_str()).unwrap_or("0");
    let version = format!("{major}.{minor}.{patch}");
    Ok(ResolvedGit {
        path: PathBuf::new(),
        version,
        major,
        minor,
        below_baseline: below_baseline(major, minor),
    })
}

pub fn below_baseline(major: u64, minor: u64) -> bool {
    major < 2 || (major == 2 && minor < 48)
}

fn candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path_var) = env::var_os("PATH") {
        for dir in env::split_paths(&path_var) {
            paths.push(dir.join(git_file_name()));
        }
    }
    paths.extend(known_locations());
    paths
}

fn git_file_name() -> &'static str {
    if cfg!(windows) {
        "git.exe"
    } else {
        "git"
    }
}

fn known_locations() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/opt/homebrew/bin/git"));
        paths.push(PathBuf::from("/usr/local/bin/git"));
        paths.push(PathBuf::from("/usr/bin/git"));
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(program_files) = env::var_os("ProgramFiles") {
            let root = PathBuf::from(program_files);
            paths.push(root.join("Git").join("cmd").join("git.exe"));
            paths.push(root.join("Git").join("bin").join("git.exe"));
        }
        paths.push(PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"));
        paths.push(PathBuf::from(r"C:\Program Files\Git\bin\git.exe"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        paths.push(PathBuf::from("/usr/bin/git"));
        paths.push(PathBuf::from("/usr/local/bin/git"));
    }
    paths
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parser_marks_baseline() {
        let current = parse_git_version("git version 2.48.1").unwrap();
        assert_eq!(current.version, "2.48.1");
        assert!(!current.below_baseline);
        let old = parse_git_version("git version 2.47.0").unwrap();
        assert!(old.below_baseline);
        assert!(parse_git_version("not a version").is_err());
    }
}
