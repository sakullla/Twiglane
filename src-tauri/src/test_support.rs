use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use crate::git::ops::Backend;
use crate::git::runner::RealRunner;
use crate::shutdown::Shutdown;
use crate::state::AppStore;

static SEQ: AtomicU64 = AtomicU64::new(1);

pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "twiglane-{label}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub struct GitFixture {
    root: TempDir,
}

impl GitFixture {
    pub fn path(&self) -> &Path {
        self.root.path()
    }

    pub fn repo(&self, name: &str) -> PathBuf {
        let path = self
            .root
            .path()
            .join(SEQ.fetch_add(1, Ordering::Relaxed).to_string())
            .join(name);
        fs::create_dir_all(&path).unwrap();
        path
    }

    pub fn backend(&self) -> Backend {
        self.backend_with_limit(1024 * 1024, Vec::new())
    }

    pub fn backend_with_extra_env(&self, extra: Vec<(OsString, OsString)>) -> Backend {
        self.backend_with_limit(1024 * 1024, extra)
    }

    pub fn backend_with_limit(&self, limit: usize, extra: Vec<(OsString, OsString)>) -> Backend {
        let mut extra_env = vec![
            (OsString::from("GIT_CONFIG_NOSYSTEM"), OsString::from("1")),
            (
                OsString::from("GIT_CONFIG_GLOBAL"),
                isolated_gitconfig().as_os_str().to_os_string(),
            ),
            (
                OsString::from("GIT_CEILING_DIRECTORIES"),
                self.root.path().as_os_str().to_os_string(),
            ),
            (OsString::from("GIT_AUTHOR_NAME"), OsString::from("Twiglane Test")),
            (
                OsString::from("GIT_AUTHOR_EMAIL"),
                OsString::from("twiglane-test@example.com"),
            ),
            (
                OsString::from("GIT_COMMITTER_NAME"),
                OsString::from("Twiglane Test"),
            ),
            (
                OsString::from("GIT_COMMITTER_EMAIL"),
                OsString::from("twiglane-test@example.com"),
            ),
        ];
        extra_env.extend(extra);
        let store = AppStore::open(self.root.path().join("state.json"));
        let runner = RealRunner {
            timeout: Duration::from_secs(30),
            output_limit: limit,
            extra_env,
        };
        Backend::new(store, runner, std::sync::Arc::new(Shutdown::new()))
    }
}

pub fn git_fixture(label: &str) -> GitFixture {
    GitFixture {
        root: TempDir::new(label),
    }
}

pub fn isolated_gitconfig() -> &'static Path {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let path = std::env::temp_dir().join(format!("twiglane-gitconfig-{}", std::process::id()));
        fs::write(&path, "[init]\n\tdefaultBranch = main\n").unwrap();
        path
    })
}

pub fn system_git() -> PathBuf {
    std::env::var_os("PATH")
        .and_then(|path| {
            std::env::split_paths(&path).find_map(|dir| {
                let candidate = dir.join(if cfg!(windows) { "git.exe" } else { "git" });
                candidate.is_file().then_some(candidate)
            })
        })
        .unwrap_or_else(|| PathBuf::from("git"))
}
