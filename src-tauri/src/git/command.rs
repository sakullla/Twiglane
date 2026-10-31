use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub fn version_command(git: &Path) -> (PathBuf, Vec<OsString>) {
    (git.to_path_buf(), vec![OsString::from("--version")])
}

pub fn toplevel_command(git: &Path, path: &Path) -> (PathBuf, Vec<OsString>) {
    (
        git.to_path_buf(),
        vec![
            OsString::from("--literal-pathspecs"),
            OsString::from("-C"),
            path.as_os_str().to_os_string(),
            OsString::from("--no-optional-locks"),
            OsString::from("rev-parse"),
            OsString::from("--path-format=absolute"),
            OsString::from("--show-toplevel"),
        ],
    )
}

pub fn init_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    (
        git.to_path_buf(),
        vec![
            OsString::from("-C"),
            root.as_os_str().to_os_string(),
            OsString::from("init"),
        ],
    )
}

pub fn status_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    (
        git.to_path_buf(),
        vec![
            OsString::from("--literal-pathspecs"),
            OsString::from("-C"),
            root.as_os_str().to_os_string(),
            OsString::from("--no-optional-locks"),
            OsString::from("status"),
            OsString::from("--porcelain=v2"),
            OsString::from("--branch"),
            OsString::from("-z"),
            OsString::from("--untracked-files=normal"),
        ],
    )
}

pub fn file_diff_command(
    git: &Path,
    root: &Path,
    paths: &[PathBuf],
    staged: bool,
    numstat: bool,
    untracked: bool,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.push(OsString::from("diff"));
    if untracked {
        args.push(OsString::from("--no-index"));
    } else if staged {
        args.push(OsString::from("--cached"));
    }
    args.extend([
        OsString::from("--no-color"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-textconv"),
        OsString::from("--find-renames"),
    ]);
    if numstat {
        args.push(OsString::from("--numstat"));
        args.push(OsString::from("-z"));
    } else {
        args.push(OsString::from("--unified=3"));
    }
    if untracked {
        args.push(OsString::from(null_device()));
        if let Some(path) = paths.first() {
            args.push(path.as_os_str().to_os_string());
        }
    } else {
        args.push(OsString::from("--"));
        for path in paths {
            args.push(path.as_os_str().to_os_string());
        }
    }
    (git.to_path_buf(), args)
}

pub fn add_command(git: &Path, root: &Path, paths: &[PathBuf]) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.push(OsString::from("add"));
    args.push(OsString::from("--"));
    for path in paths {
        args.push(path.as_os_str().to_os_string());
    }
    (git.to_path_buf(), args)
}

pub fn restore_staged_command(
    git: &Path,
    root: &Path,
    paths: &[PathBuf],
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("restore"),
        OsString::from("--staged"),
        OsString::from("--source=HEAD"),
        OsString::from("--"),
    ]);
    for path in paths {
        args.push(path.as_os_str().to_os_string());
    }
    (git.to_path_buf(), args)
}

pub fn unstage_unborn_command(
    git: &Path,
    root: &Path,
    paths: &[PathBuf],
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("rm"),
        OsString::from("--cached"),
        OsString::from("--ignore-unmatch"),
        OsString::from("--"),
    ]);
    for path in paths {
        args.push(path.as_os_str().to_os_string());
    }
    (git.to_path_buf(), args)
}

pub fn apply_cached_command(
    git: &Path,
    root: &Path,
    reverse: bool,
    check: bool,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("apply"),
        OsString::from("--cached"),
        OsString::from("--whitespace=nowarn"),
    ]);
    if reverse {
        args.push(OsString::from("--reverse"));
    }
    if check {
        args.push(OsString::from("--check"));
    }
    (git.to_path_buf(), args)
}

pub fn commit_command(git: &Path, root: &Path, message: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("commit"),
        OsString::from("-m"),
        OsString::from(message),
    ]);
    (git.to_path_buf(), args)
}

pub fn head_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([OsString::from("rev-parse"), OsString::from("HEAD")]);
    (git.to_path_buf(), args)
}

pub fn identity_command(git: &Path, root: &Path, variable: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([OsString::from("var"), OsString::from(variable)]);
    (git.to_path_buf(), args)
}

pub fn ls_files_command(git: &Path, root: &Path, relative: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("ls-files"),
        OsString::from("-z"),
        OsString::from("--"),
        relative.as_os_str().to_os_string(),
    ]);
    (git.to_path_buf(), args)
}

pub fn clone_command(git: &Path, url: &str, destination: &Path) -> (PathBuf, Vec<OsString>) {
    (
        git.to_path_buf(),
        vec![
            OsString::from("clone"),
            OsString::from("--"),
            OsString::from(url),
            destination.as_os_str().to_os_string(),
        ],
    )
}

pub fn remote_verbose_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([OsString::from("remote"), OsString::from("-v")]);
    (git.to_path_buf(), args)
}

pub fn remote_add_command(
    git: &Path,
    root: &Path,
    name: &str,
    url: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("remote"),
        OsString::from("add"),
        OsString::from("--"),
        OsString::from(name),
        OsString::from(url),
    ]);
    (git.to_path_buf(), args)
}

pub fn remote_set_url_command(
    git: &Path,
    root: &Path,
    name: &str,
    url: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("remote"),
        OsString::from("set-url"),
        OsString::from("--"),
        OsString::from(name),
        OsString::from(url),
    ]);
    (git.to_path_buf(), args)
}

pub fn fetch_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("fetch"),
        OsString::from("--prune"),
        OsString::from("--all"),
    ]);
    (git.to_path_buf(), args)
}

pub fn pull_ff_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("pull"),
        OsString::from("--ff-only"),
        OsString::from("--no-rebase"),
        OsString::from("--no-edit"),
    ]);
    (git.to_path_buf(), args)
}

pub fn push_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.push(OsString::from("push"));
    (git.to_path_buf(), args)
}

pub fn publish_command(
    git: &Path,
    root: &Path,
    remote: &str,
    branch: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("push"),
        OsString::from("--set-upstream"),
        OsString::from("--"),
        OsString::from(remote),
        OsString::from(branch),
    ]);
    (git.to_path_buf(), args)
}

pub fn delete_remote_branch_command(
    git: &Path,
    root: &Path,
    remote: &str,
    branch: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("push"),
        OsString::from("--delete"),
        OsString::from("--"),
        OsString::from(remote),
        OsString::from(branch),
    ]);
    (git.to_path_buf(), args)
}

pub fn branch_list_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    let format = "%(refname)\u{1f}%(upstream:short)\u{1f}%(worktreepath)\u{1f}%(HEAD)".to_string();
    args.extend([
        OsString::from("for-each-ref"),
        OsString::from("--format"),
        OsString::from(format),
        OsString::from("refs/heads"),
        OsString::from("refs/remotes"),
    ]);
    (git.to_path_buf(), args)
}

pub fn check_branch_command(git: &Path, root: &Path, name: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("check-ref-format"),
        OsString::from("--branch"),
        OsString::from(name),
    ]);
    (git.to_path_buf(), args)
}

pub fn create_branch_command(git: &Path, root: &Path, name: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("branch"),
        OsString::from("--"),
        OsString::from(name),
    ]);
    (git.to_path_buf(), args)
}

pub fn switch_command(git: &Path, root: &Path, name: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("switch"),
        OsString::from("--"),
        OsString::from(name),
    ]);
    (git.to_path_buf(), args)
}

pub fn switch_track_command(
    git: &Path,
    root: &Path,
    remote_branch: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("switch"),
        OsString::from("--track"),
        OsString::from("--"),
        OsString::from(remote_branch),
    ]);
    (git.to_path_buf(), args)
}

pub fn delete_branch_command(
    git: &Path,
    root: &Path,
    name: &str,
    force: bool,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("branch"),
        OsString::from(if force { "-D" } else { "-d" }),
        OsString::from("--"),
        OsString::from(name),
    ]);
    (git.to_path_buf(), args)
}

pub fn delete_remote_tracking_command(
    git: &Path,
    root: &Path,
    name: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("branch"),
        OsString::from("-d"),
        OsString::from("-r"),
        OsString::from("--"),
        OsString::from(name),
    ]);
    (git.to_path_buf(), args)
}

fn repo_prefix(root: &Path, optional_locks: bool) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("-c"),
        OsString::from("core.quotePath=false"),
        OsString::from("--literal-pathspecs"),
        OsString::from("-C"),
        root.as_os_str().to_os_string(),
    ];
    if optional_locks {
        args.push(OsString::from("--no-optional-locks"));
    }
    args
}

fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

// cdylib 不会把仅测试调用算作可达，避免 dead_code 挡住 clippy。
#[allow(dead_code)]
pub fn assert_structured(program: &Path, args: &[OsString]) {
    let name = program
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    assert!(name == "git" || name == "git.exe", "{name}");
    assert!(!args
        .iter()
        .any(|arg| arg == "sh" || arg == "bash" || arg == "cmd" || arg == "cmd.exe"));
    assert!(!args.iter().any(|arg| arg == "-c"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_commands_keep_paths_as_single_arguments() {
        let git = Path::new("/usr/bin/git");
        let root = Path::new("/tmp/demo; rm -rf");
        let (program, args) = status_command(git, root);
        assert_structured(&program, &args);
        assert_eq!(args[1], "-C");
        assert_eq!(args[2], root.as_os_str());
        let (_program, init_args) = init_command(git, root);
        assert_structured(git, &init_args);
        assert_eq!(init_args[1], root.as_os_str());
        assert_eq!(init_args[2], "init");
        let relative = PathBuf::from("dir/file;name.txt");
        let (_program, diff_args) = file_diff_command(
            git,
            root,
            std::slice::from_ref(&relative),
            false,
            false,
            false,
        );
        assert_eq!(diff_args.last().unwrap(), relative.as_os_str());
        assert!(diff_args.iter().any(|arg| arg == "--"));
        assert!(diff_args
            .windows(2)
            .any(|pair| pair[0] == "-c" && pair[1] == "core.quotePath=false"));
        let destination = Path::new("/tmp/new repo");
        let (_program, clone_args) =
            clone_command(git, "https://example.com/acme/app.git", destination);
        assert_structured(git, &clone_args);
        assert_eq!(clone_args[2], "https://example.com/acme/app.git");
        assert_eq!(clone_args[3], destination.as_os_str());
        for builder in [
            fetch_command(git, root).1,
            pull_ff_command(git, root).1,
            push_command(git, root).1,
            publish_command(git, root, "origin", "main").1,
            delete_remote_branch_command(git, root, "origin", "feature").1,
        ] {
            assert_no_force(&builder);
            assert!(!builder.iter().any(|arg| {
                let text = arg.to_string_lossy();
                text == "sh" || text == "bash" || text == "cmd" || text == "cmd.exe"
            }));
        }
    }

    fn assert_no_force(args: &[OsString]) {
        for arg in args {
            let text = arg.to_string_lossy();
            assert_ne!(text, "--force");
            assert_ne!(text, "-f");
            assert_ne!(text, "--force-with-lease");
            assert!(!text.starts_with("--force"));
        }
    }
}
