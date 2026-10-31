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

pub fn diff_command(git: &Path, root: &Path, relative: &Path, staged: bool) -> (PathBuf, Vec<OsString>) {
    let mut args = vec![
        OsString::from("--literal-pathspecs"),
        OsString::from("-C"),
        root.as_os_str().to_os_string(),
        OsString::from("--no-optional-locks"),
        OsString::from("diff"),
    ];
    if staged {
        args.push(OsString::from("--cached"));
    }
    args.extend([
        OsString::from("--no-color"),
        OsString::from("--no-ext-diff"),
        OsString::from("--unified=3"),
        OsString::from("--"),
        relative.as_os_str().to_os_string(),
    ]);
    (git.to_path_buf(), args)
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
    assert!(!args.iter().any(|arg| arg == "sh" || arg == "bash" || arg == "cmd" || arg == "cmd.exe"));
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
        let relative = Path::new("dir/file;name.txt");
        let (_program, diff_args) = diff_command(git, root, relative, false);
        assert_eq!(diff_args.last().unwrap(), relative.as_os_str());
        assert!(diff_args.iter().any(|arg| arg == "--"));
    }
}
