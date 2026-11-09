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

/// 用 `git check-ignore -z --stdin` 判定目录直接子项的忽略状态。
///
/// 待判定路径只从 stdin 以 NUL 分隔传入，Git 仅把每个路径本身与忽略规则匹配，不会枚举其后代，
/// 所以列出父目录时不会读取未展开的子目录内容。只读，不改写任何忽略规则。
/// 不能用 `repo_prefix`：`--literal-pathspecs` 会给 check-ignore 注入 pathspec magic，直接致命失败。
///
/// `--no-index`：这里只问"路径本身是否匹配排除规则"。Git 默认还会自己跳过索引里已有的路径，
/// 但那个隐式行为不该成为"已跟踪文件不会被隐藏"的唯一依据；是否已跟踪由调用方按索引快照显式复核。
pub fn ignore_check_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    (
        git.to_path_buf(),
        vec![
            OsString::from("-c"),
            OsString::from("core.quotePath=false"),
            OsString::from("-C"),
            root.as_os_str().to_os_string(),
            OsString::from("--no-optional-locks"),
            OsString::from("check-ignore"),
            OsString::from("-z"),
            OsString::from("--no-index"),
            OsString::from("--stdin"),
        ],
    )
}

/// 用 `git ls-files -z --cached` 一次读出索引里的全部已跟踪路径。
///
/// 只读、不带 pathspec、不访问工作区：调用方按 repo_key + generation 缓存一份，
/// 目录展开时只在内存里查表判断"这个直接子项是否已被跟踪"，
/// 不会每展开一层就重跑一次全仓 Git 命令。
pub fn index_paths_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    (
        git.to_path_buf(),
        vec![
            OsString::from("-c"),
            OsString::from("core.quotePath=false"),
            OsString::from("-C"),
            root.as_os_str().to_os_string(),
            OsString::from("--no-optional-locks"),
            OsString::from("ls-files"),
            OsString::from("-z"),
            OsString::from("--cached"),
        ],
    )
}

/// 路径枚举：已跟踪 + 未跟踪但未被忽略的路径（--cached --others --exclude-standard）。
///
/// 只读：不写索引、不改忽略规则、不进入 .git 内部。目录范围交给 Git 的 pathspec 前缀判断，
/// 而不是先枚举全仓再在内存里过滤，保证目录 scope 不会隐式扫描其他目录。
pub fn list_paths_command(
    git: &Path,
    root: &Path,
    directory: Option<&Path>,
) -> (PathBuf, Vec<OsString>) {
    let mut args = vec![
        OsString::from("--literal-pathspecs"),
        OsString::from("-c"),
        OsString::from("core.quotePath=false"),
        OsString::from("-C"),
        root.as_os_str().to_os_string(),
        OsString::from("--no-optional-locks"),
        OsString::from("ls-files"),
        OsString::from("-z"),
        OsString::from("--cached"),
        OsString::from("--others"),
        OsString::from("--exclude-standard"),
    ];
    push_directory_pathspec(&mut args, directory);
    (git.to_path_buf(), args)
}

/// 只列被忽略的未跟踪路径（--others --ignored --exclude-standard）。
///
/// 与上面的枚举分开执行、由调用方合并去重：--ignored 只过滤 --others，
/// 混在一条命令里会让「已跟踪且匹配忽略规则」的路径来源不清。
pub fn list_ignored_paths_command(
    git: &Path,
    root: &Path,
    directory: Option<&Path>,
) -> (PathBuf, Vec<OsString>) {
    let mut args = vec![
        OsString::from("--literal-pathspecs"),
        OsString::from("-c"),
        OsString::from("core.quotePath=false"),
        OsString::from("-C"),
        root.as_os_str().to_os_string(),
        OsString::from("--no-optional-locks"),
        OsString::from("ls-files"),
        OsString::from("-z"),
        OsString::from("--others"),
        OsString::from("--ignored"),
        OsString::from("--exclude-standard"),
    ];
    push_directory_pathspec(&mut args, directory);
    (git.to_path_buf(), args)
}

fn push_directory_pathspec(args: &mut Vec<OsString>, directory: Option<&Path>) {
    if let Some(directory) = directory.filter(|path| !path.as_os_str().is_empty()) {
        args.push(OsString::from("--"));
        args.push(directory.as_os_str().to_os_string());
    }
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
            OsString::from("--untracked-files=all"),
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
    file_diff_command_with_context(git, root, paths, staged, numstat, untracked, 3, false)
}

/// 与 `file_diff_command` 相同，但上下文行数可调：「查看完整文件」用一个很大的值让 Git 输出整份文件。
/// 暂存代码块始终走 3 行上下文的版本，补丁格式不受影响。
#[allow(clippy::too_many_arguments)]
pub fn file_diff_command_with_context(
    git: &Path,
    root: &Path,
    paths: &[PathBuf],
    staged: bool,
    numstat: bool,
    untracked: bool,
    context: u32,
    as_text: bool,
) -> (PathBuf, Vec<OsString>) {
    diff_command(git, root, None, paths, staged, numstat, untracked, context, as_text)
}

/// 任务净差异：起点提交直接对工作区，因此同时含后续提交、暂存与未暂存改动的结果。
/// 参数与 `file_diff_command_with_context` 一致，只多一个起点提交。
#[allow(clippy::too_many_arguments)]
pub fn task_diff_command(
    git: &Path,
    root: &Path,
    baseline: &str,
    paths: &[PathBuf],
    untracked: bool,
    context: u32,
    as_text: bool,
) -> (PathBuf, Vec<OsString>) {
    if untracked {
        // 未跟踪文件在起点里根本没有版本：只能和空文件比，不带起点提交。
        return file_diff_command_with_context(
            git, root, paths, false, false, true, context, as_text,
        );
    }
    diff_command(
        git,
        root,
        Some(baseline),
        paths,
        false,
        false,
        false,
        context,
        as_text,
    )
}

#[allow(clippy::too_many_arguments)]
fn diff_command(
    git: &Path,
    root: &Path,
    revision: Option<&str>,
    paths: &[PathBuf],
    staged: bool,
    numstat: bool,
    untracked: bool,
    context: u32,
    as_text: bool,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.push(OsString::from("diff"));
    if as_text {
        // 「按文本查看」：Git 判成二进制的文件（例如夹了一个 NUL 字节的源码）也逐行输出。
        args.push(OsString::from("--text"));
    }
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
        args.push(OsString::from(format!("--unified={context}")));
    }
    // 起点提交必须放在 pathspec 之前：diff <commit> -- <path> 才是「起点对工作区」。
    if let Some(revision) = revision {
        args.push(OsString::from(revision));
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

/// 读取生效的凭据助手配置（全局与仓库级）。
pub fn credential_helper_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("config"),
        OsString::from("--get-all"),
        OsString::from("credential.helper"),
    ]);
    (git.to_path_buf(), args)
}

/// 把标准输入里的一组凭据交给凭据助手保存。
pub fn credential_approve_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([OsString::from("credential"), OsString::from("approve")]);
    (git.to_path_buf(), args)
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

pub fn set_upstream_to_command(
    git: &Path,
    root: &Path,
    upstream: &str,
    branch: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("branch"),
        OsString::from(format!("--set-upstream-to={upstream}")),
        OsString::from("--"),
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
    let format = "%(refname)\u{1f}%(upstream:short)\u{1f}%(worktreepath)\u{1f}%(HEAD)\u{1f}%(objectname)\u{1f}%(symref:short)".to_string();
    args.extend([
        OsString::from("for-each-ref"),
        OsString::from("--format"),
        OsString::from(format),
        OsString::from("refs/heads"),
        OsString::from("refs/remotes"),
    ]);
    (git.to_path_buf(), args)
}

/// 列出已完整合入 `base`（完整引用名，例如 `refs/heads/main`）的本地和远程跟踪分支。
pub fn merged_branches_command(git: &Path, root: &Path, base: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("for-each-ref"),
        OsString::from("--format"),
        OsString::from("%(refname)"),
        OsString::from("--merged"),
        OsString::from(base),
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

/// 从指定起点创建分支：`git branch --no-track -- <name> <start>`（起点已由调用方核对过）。
pub fn create_branch_at_command(
    git: &Path,
    root: &Path,
    name: &str,
    start: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("branch"),
        OsString::from("--no-track"),
        OsString::from("--"),
        OsString::from(name),
        OsString::from(start),
    ]);
    (git.to_path_buf(), args)
}

/// 重命名本地分支：`git branch -m -- <old> <new>`（不加 -M，目标已存在时由 Git 拒绝）。
pub fn rename_branch_command(
    git: &Path,
    root: &Path,
    old: &str,
    new: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("branch"),
        OsString::from("-m"),
        OsString::from("--"),
        OsString::from(old),
        OsString::from(new),
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

/// 以指定名称新建跟踪远程分支的本地分支并切换：`git switch -c <local> --track <remote/branch>`。
pub fn switch_track_as_command(
    git: &Path,
    root: &Path,
    local: &str,
    remote_branch: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("switch"),
        OsString::from("--track"),
        OsString::from("-c"),
        OsString::from(local),
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

pub fn tag_list_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    let format = "%(refname:short)\u{1f}%(objectname)\u{1f}%(*objectname)\u{1f}%(creatordate:unix)\u{1f}%(subject)".to_string();
    args.extend([
        OsString::from("for-each-ref"),
        OsString::from("--sort=-version:refname"),
        OsString::from("--format"),
        OsString::from(format),
        OsString::from("refs/tags"),
    ]);
    (git.to_path_buf(), args)
}

pub fn check_tag_command(git: &Path, root: &Path, name: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("check-ref-format"),
        OsString::from(format!("refs/tags/{name}")),
    ]);
    (git.to_path_buf(), args)
}

pub fn create_tag_command(
    git: &Path,
    root: &Path,
    name: &str,
    target: &str,
    message: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.push(OsString::from("tag"));
    if !message.trim().is_empty() {
        args.extend([
            OsString::from("-a"),
            OsString::from("-m"),
            OsString::from(message),
        ]);
    }
    args.extend([
        OsString::from("--"),
        OsString::from(name),
        OsString::from(target),
    ]);
    (git.to_path_buf(), args)
}

pub fn delete_tag_command(git: &Path, root: &Path, name: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("tag"),
        OsString::from("-d"),
        OsString::from("--"),
        OsString::from(name),
    ]);
    (git.to_path_buf(), args)
}

pub fn push_tag_command(
    git: &Path,
    root: &Path,
    remote: &str,
    name: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("push"),
        OsString::from("--"),
        OsString::from(remote),
        OsString::from(format!("refs/tags/{name}")),
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

pub const HISTORY_PAGE_SIZE: u32 = 100;
pub const EMPTY_TREE_OID: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn history_format() -> OsString {
    OsString::from("--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e")
}

/// 历史读取范围。默认是当前 HEAD，不再带 `--all`。
#[derive(Clone, Debug, Default)]
pub struct HistoryLog {
    pub scope_all: bool,
    pub revision: Option<String>,
    pub author: Option<String>,
    pub grep: Option<String>,
    pub path: Option<PathBuf>,
    pub follow: bool,
    pub skip: Option<u32>,
    pub max_count: Option<u32>,
    pub hits_only: bool,
    /// 与 `--follow` 一起用，列出该提交里当时的路径。调用方据此翻到下一页。
    pub name_status: bool,
    /// 「未推送」范围在没有上游时用：排除所有远程跟踪分支上已有的提交（`--not --remotes`）。
    pub exclude_remotes: bool,
}

pub fn history_log_command(git: &Path, root: &Path, log: &HistoryLog) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.push(OsString::from("log"));
    args.push(OsString::from("--date=unix"));
    if log.hits_only && log.name_status {
        // 记录分隔符放在提交前面，后面的 -z --name-status 才能跟在同一条记录上。
        args.push(OsString::from("--pretty=format:%x1e%H%x1f%at"));
    } else if log.hits_only {
        args.push(OsString::from("--pretty=format:%H%x1f%at%x1e"));
    } else {
        args.push(history_format());
    }
    if log.author.is_some() || log.grep.is_some() {
        args.push(OsString::from("-i"));
        args.push(OsString::from("--fixed-strings"));
    }
    if let Some(author) = &log.author {
        args.push(OsString::from(format!("--author={author}")));
    }
    if let Some(grep) = &log.grep {
        args.push(OsString::from(format!("--grep={grep}")));
    }
    if log.follow {
        args.push(OsString::from("--follow"));
    }
    if log.name_status {
        args.push(OsString::from("-z"));
        args.push(OsString::from("--name-status"));
    }
    if log.scope_all {
        args.push(OsString::from("--all"));
    } else if let Some(revision) = &log.revision {
        args.push(OsString::from(revision));
    }
    if log.exclude_remotes && !log.scope_all {
        args.push(OsString::from("--not"));
        args.push(OsString::from("--remotes"));
    }
    // Git 先执行 --skip，再在真正显示提交时用 --follow 改路径。两者同时出现会跳过
    // 重命名提交，旧路径上的更早提交就消失了。
    if let Some(skip) = log.skip.filter(|_| !log.follow) {
        args.push(OsString::from(format!("--skip={skip}")));
    }
    if let Some(max_count) = log.max_count {
        args.push(OsString::from(format!("--max-count={max_count}")));
    }
    args.push(OsString::from("--"));
    if let Some(path) = &log.path {
        args.push(path.as_os_str().to_os_string());
    }
    (git.to_path_buf(), args)
}

pub fn show_current_branch_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([OsString::from("branch"), OsString::from("--show-current")]);
    (git.to_path_buf(), args)
}

pub fn local_branch_names_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("for-each-ref"),
        OsString::from("--format=%(refname:short)"),
        OsString::from("refs/heads"),
    ]);
    (git.to_path_buf(), args)
}

pub fn verify_local_branch_command(
    git: &Path,
    root: &Path,
    name: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("rev-parse"),
        OsString::from("--verify"),
        OsString::from("--quiet"),
        OsString::from(format!("refs/heads/{name}")),
    ]);
    (git.to_path_buf(), args)
}

/// 当前分支是否设置了上游：`@{upstream}` 解析成功即有。
pub fn verify_upstream_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("rev-parse"),
        OsString::from("--verify"),
        OsString::from("--quiet"),
        OsString::from("@{upstream}"),
    ]);
    (git.to_path_buf(), args)
}

pub fn history_details_command(
    git: &Path,
    root: &Path,
    oids: &[String],
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("log"),
        OsString::from("--no-walk"),
        OsString::from("--date=unix"),
        history_format(),
    ]);
    for oid in oids {
        args.push(OsString::from(oid));
    }
    args.push(OsString::from("--"));
    (git.to_path_buf(), args)
}

pub fn ancestor_command(
    git: &Path,
    root: &Path,
    ancestor: &str,
    descendant: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("merge-base"),
        OsString::from("--is-ancestor"),
        OsString::from(ancestor),
        OsString::from(descendant),
    ]);
    (git.to_path_buf(), args)
}

pub fn cherry_pick_range_command(
    git: &Path,
    root: &Path,
    oids: &[String],
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.push(OsString::from("cherry-pick"));
    for oid in oids {
        args.push(OsString::from(oid));
    }
    (git.to_path_buf(), args)
}

pub fn detach_at_command(git: &Path, root: &Path, oid: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("switch"),
        OsString::from("--detach"),
        OsString::from("--"),
        OsString::from(oid),
    ]);
    (git.to_path_buf(), args)
}

pub fn commit_header_command(git: &Path, root: &Path, oid: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("log"),
        OsString::from("-1"),
        OsString::from("--date=unix"),
        history_format(),
        OsString::from(oid),
        OsString::from("--"),
    ]);
    (git.to_path_buf(), args)
}

pub fn commit_detail_command(git: &Path, root: &Path, oid: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("log"),
        OsString::from("-1"),
        OsString::from("--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e%x00%B"),
        OsString::from(oid),
        OsString::from("--"),
    ]);
    (git.to_path_buf(), args)
}

pub fn any_commit_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("rev-list"),
        OsString::from("-n"),
        OsString::from("1"),
        OsString::from("--all"),
    ]);
    (git.to_path_buf(), args)
}

pub fn ref_labels_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("for-each-ref"),
        OsString::from(
            "--format=%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)%09%(refname)%09%(HEAD)",
        ),
        OsString::from("HEAD"),
        OsString::from("refs/heads"),
        OsString::from("refs/remotes"),
        OsString::from("refs/tags"),
    ]);
    (git.to_path_buf(), args)
}

pub fn diff_tree_command(
    git: &Path,
    root: &Path,
    parent: Option<&str>,
    commit: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("diff-tree"),
        OsString::from("-z"),
        OsString::from("--no-commit-id"),
        OsString::from("--name-status"),
        OsString::from("--find-renames"),
        OsString::from("-r"),
    ]);
    if let Some(parent) = parent {
        args.push(OsString::from(parent));
        args.push(OsString::from(commit));
    } else {
        args.push(OsString::from("--root"));
        args.push(OsString::from(commit));
    }
    (git.to_path_buf(), args)
}

pub fn commit_diff_command(
    git: &Path,
    root: &Path,
    parent: &str,
    commit: &str,
    paths: &[PathBuf],
    context: u32,
    as_text: bool,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.push(OsString::from("diff"));
    if as_text {
        args.push(OsString::from("--text"));
    }
    args.extend([
        OsString::from("--no-color"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-textconv"),
        OsString::from("--find-renames"),
        OsString::from(format!("--unified={context}")),
        OsString::from(parent),
        OsString::from(commit),
        OsString::from("--"),
    ]);
    for path in paths {
        args.push(path.as_os_str().to_os_string());
    }
    (git.to_path_buf(), args)
}

pub fn commit_numstat_command(
    git: &Path,
    root: &Path,
    parent: &str,
    commit: &str,
    paths: &[PathBuf],
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("diff"),
        OsString::from("--numstat"),
        OsString::from("-z"),
        OsString::from(parent),
        OsString::from(commit),
        OsString::from("--"),
    ]);
    for path in paths {
        args.push(path.as_os_str().to_os_string());
    }
    (git.to_path_buf(), args)
}

pub fn stash_list_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("stash"),
        OsString::from("list"),
        OsString::from("--format=%H%x1f%ct%x1f%gs"),
    ]);
    (git.to_path_buf(), args)
}

fn stash_prefix(root: &Path) -> Vec<OsString> {
    // stash push -u removes untracked files with pathspec magic. Global
    // --literal-pathspecs records them but leaves the worktree copy in place.
    vec![
        OsString::from("-c"),
        OsString::from("core.quotePath=false"),
        OsString::from("-C"),
        root.as_os_str().to_os_string(),
    ]
}

pub fn stash_push_command(
    git: &Path,
    root: &Path,
    include_untracked: bool,
    message: Option<&str>,
) -> (PathBuf, Vec<OsString>) {
    let mut args = stash_prefix(root);
    args.extend([OsString::from("stash"), OsString::from("push")]);
    if include_untracked {
        args.push(OsString::from("--include-untracked"));
    }
    if let Some(message) = message {
        args.push(OsString::from("-m"));
        args.push(OsString::from(message));
    }
    (git.to_path_buf(), args)
}

pub fn stash_apply_command(git: &Path, root: &Path, oid: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = stash_prefix(root);
    args.extend([
        OsString::from("stash"),
        OsString::from("apply"),
        OsString::from(oid),
    ]);
    (git.to_path_buf(), args)
}

pub fn stash_drop_command(git: &Path, root: &Path, stash_ref: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = stash_prefix(root);
    args.extend([
        OsString::from("stash"),
        OsString::from("drop"),
        OsString::from(stash_ref),
    ]);
    (git.to_path_buf(), args)
}

/// 工作区或暂存区全部文件的 `--numstat -z`。重命名记录是 `added\tdeleted\t\0old\0new\0`。
pub fn numstat_command(git: &Path, root: &Path, staged: bool) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.push(OsString::from("diff"));
    if staged {
        args.push(OsString::from("--cached"));
    }
    args.extend([
        OsString::from("--numstat"),
        OsString::from("-z"),
        OsString::from("--find-renames"),
    ]);
    (git.to_path_buf(), args)
}

/// 任务净状态的文件队列：起点提交对工作区的名称与状态（含重命名检测）。
pub fn task_name_status_command(
    git: &Path,
    root: &Path,
    baseline: &str,
    paths: &[PathBuf],
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("diff"),
        OsString::from("-z"),
        OsString::from("--name-status"),
        OsString::from("--find-renames"),
        OsString::from(baseline),
        OsString::from("--"),
    ]);
    for path in paths {
        args.push(path.as_os_str().to_os_string());
    }
    (git.to_path_buf(), args)
}

/// 与 `task_name_status_command` 同一范围的增删行数：二进制记作两个 `-`。
pub fn task_numstat_command(
    git: &Path,
    root: &Path,
    baseline: &str,
    paths: &[PathBuf],
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("diff"),
        OsString::from("--numstat"),
        OsString::from("-z"),
        OsString::from("--find-renames"),
        OsString::from(baseline),
        OsString::from("--"),
    ]);
    for path in paths {
        args.push(path.as_os_str().to_os_string());
    }
    (git.to_path_buf(), args)
}

/// 单条路径的状态：任务快照只关心这一条路径的两侧状态、未跟踪与冲突。
pub fn path_status_command(git: &Path, root: &Path, relative: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = vec![
        OsString::from("--literal-pathspecs"),
        OsString::from("-C"),
        root.as_os_str().to_os_string(),
        OsString::from("--no-optional-locks"),
        OsString::from("status"),
        OsString::from("--porcelain=v2"),
        OsString::from("-z"),
        OsString::from("--untracked-files=all"),
        OsString::from("--"),
    ];
    args.push(relative.as_os_str().to_os_string());
    (git.to_path_buf(), args)
}

/// 某个提交（或树）里一条路径的条目：任务快照用它给出起点侧的内容版本。
pub fn ls_tree_entry_command(
    git: &Path,
    root: &Path,
    tree: &str,
    relative: &Path,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("ls-tree"),
        OsString::from("-z"),
        OsString::from("--full-tree"),
        OsString::from(tree),
        OsString::from("--"),
    ]);
    args.push(relative.as_os_str().to_os_string());
    (git.to_path_buf(), args)
}

/// 工作区文件的内容版本：只算对象 id，不加 `-w`，因此不写对象库。只读通道用。
pub fn read_object_hash_command(
    git: &Path,
    root: &Path,
    relative: &Path,
) -> (PathBuf, Vec<OsString>) {
    let mut args = vec![
        OsString::from("--literal-pathspecs"),
        OsString::from("-C"),
        root.as_os_str().to_os_string(),
        OsString::from("--no-optional-locks"),
        OsString::from("hash-object"),
        OsString::from("--"),
    ];
    args.push(relative.as_os_str().to_os_string());
    (git.to_path_buf(), args)
}

/// 范围内提交数（`rev-list --count`）：只读，不为此翻页。
pub fn rev_list_count_command(git: &Path, root: &Path, revision: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("rev-list"),
        OsString::from("--count"),
        OsString::from(revision),
    ]);
    (git.to_path_buf(), args)
}

pub fn rev_parse_command(git: &Path, root: &Path, revision: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("rev-parse"),
        OsString::from("--verify"),
        OsString::from(revision),
    ]);
    (git.to_path_buf(), args)
}

/// 仓库的提交缩写长度：`rev-parse --short` 按 core.abbrev 取值，未设置时由 Git 按对象数自动放长（最少 7 位），
/// 与 `git log --oneline` 的显示一致。只读，不写入仓库。
pub fn abbrev_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("rev-parse"),
        OsString::from("--short"),
        OsString::from("--verify"),
        OsString::from("--quiet"),
        OsString::from("HEAD"),
    ]);
    (git.to_path_buf(), args)
}

pub fn ignored_files_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("ls-files"),
        OsString::from("-z"),
        OsString::from("-o"),
        OsString::from("-i"),
        OsString::from("--exclude-standard"),
    ]);
    (git.to_path_buf(), args)
}

pub fn merge_no_commit_command(git: &Path, root: &Path, branch: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("merge"),
        OsString::from("--no-commit"),
        OsString::from("--no-ff"),
        OsString::from("--no-edit"),
        OsString::from("--"),
        OsString::from(branch),
    ]);
    (git.to_path_buf(), args)
}

pub fn merge_ff_only_command(git: &Path, root: &Path, branch: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("merge"),
        OsString::from("--ff-only"),
        OsString::from("--no-edit"),
        OsString::from("--"),
        OsString::from(branch),
    ]);
    (git.to_path_buf(), args)
}

/// `target..source` 上待带入的提交（最新在前），格式与历史列表一致。
pub fn merge_incoming_log_command(
    git: &Path,
    root: &Path,
    target: &str,
    source: &str,
    limit: u32,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("log"),
        OsString::from("--date=unix"),
        history_format(),
        OsString::from(format!("--max-count={limit}")),
        OsString::from(format!("{target}..{source}")),
        OsString::from("--"),
    ]);
    (git.to_path_buf(), args)
}

/// 输出 `<只在 target 的提交数>\t<只在 source 的提交数>`。
pub fn merge_divergence_command(
    git: &Path,
    root: &Path,
    target: &str,
    source: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("rev-list"),
        OsString::from("--left-right"),
        OsString::from("--count"),
        OsString::from(format!("{target}...{source}")),
        OsString::from("--"),
    ]);
    (git.to_path_buf(), args)
}

/// 两个分支的共同祖先（只取一个）。
pub fn merge_base_command(
    git: &Path,
    root: &Path,
    target: &str,
    source: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("merge-base"),
        OsString::from(target),
        OsString::from(source),
    ]);
    (git.to_path_buf(), args)
}

/// 包含某个提交的本地与远程分支。
pub fn branches_containing_command(git: &Path, root: &Path, oid: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("for-each-ref"),
        OsString::from(format!("--contains={oid}")),
        OsString::from("--format=%(refname)"),
        OsString::from("refs/heads"),
        OsString::from("refs/remotes"),
    ]);
    (git.to_path_buf(), args)
}

/// 把当前分支推送到指定远程的同名分支；不强推，不改上游。
pub fn push_to_remote_command(
    git: &Path,
    root: &Path,
    remote: &str,
    branch: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("push"),
        OsString::from("--"),
        OsString::from(remote),
        OsString::from(format!("refs/heads/{branch}:refs/heads/{branch}")),
    ]);
    (git.to_path_buf(), args)
}

/// 来源相对共同祖先改了哪些文件（即合并会带入的文件）。
pub fn merge_incoming_files_command(
    git: &Path,
    root: &Path,
    target: &str,
    source: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("diff"),
        OsString::from("--name-status"),
        OsString::from("-z"),
        OsString::from("--find-renames"),
        OsString::from(format!("{target}...{source}")),
        OsString::from("--"),
    ]);
    (git.to_path_buf(), args)
}

/// 不碰工作区与索引的试合并（Git 2.38+）：退出码 0 无冲突、1 有冲突，其余视为无法预测。
pub fn merge_tree_command(
    git: &Path,
    root: &Path,
    target: &str,
    source: &str,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("merge-tree"),
        OsString::from("--write-tree"),
        OsString::from("--name-only"),
        OsString::from("--no-messages"),
        OsString::from("-z"),
        OsString::from(target),
        OsString::from(source),
    ]);
    (git.to_path_buf(), args)
}

pub fn merge_abort_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([OsString::from("merge"), OsString::from("--abort")]);
    (git.to_path_buf(), args)
}

/// 沿用变基或拣选已经准备好的说明，不打开编辑器，也不改写说明。
pub fn commit_no_edit_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([OsString::from("commit"), OsString::from("--no-edit")]);
    (git.to_path_buf(), args)
}

/// 非交互变基。不传 `--interactive`，也不提供逐条挑选、压缩或跳过。
pub fn rebase_command(git: &Path, root: &Path, base: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("rebase"),
        OsString::from("--"),
        OsString::from(base),
    ]);
    (git.to_path_buf(), args)
}

pub fn rebase_continue_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([OsString::from("rebase"), OsString::from("--continue")]);
    (git.to_path_buf(), args)
}

pub fn rebase_abort_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([OsString::from("rebase"), OsString::from("--abort")]);
    (git.to_path_buf(), args)
}

pub fn cherry_pick_continue_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([OsString::from("cherry-pick"), OsString::from("--continue")]);
    (git.to_path_buf(), args)
}

pub fn cherry_pick_abort_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([OsString::from("cherry-pick"), OsString::from("--abort")]);
    (git.to_path_buf(), args)
}

pub fn unmerged_index_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("ls-files"),
        OsString::from("-u"),
        OsString::from("-z"),
    ]);
    (git.to_path_buf(), args)
}

/// 批量查对象类型与大小：对象名逐行从 stdin 写入，输出与输入逐行对应。
pub fn batch_check_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("cat-file"),
        OsString::from("--batch-check=%(objecttype) %(objectsize)"),
    ]);
    (git.to_path_buf(), args)
}

/// 大批同一版本的大小一次遍历目录，避免逐个 `<tree>:<path>` 重复解压、查找树。
pub fn tree_sizes_command(git: &Path, root: &Path, tree: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("ls-tree"),
        OsString::from("-r"),
        OsString::from("-z"),
        OsString::from("--format=%(objecttype) %(objectsize)%x09%(path)"),
        OsString::from(tree),
        OsString::from("--"),
    ]);
    (git.to_path_buf(), args)
}

pub fn cat_blob_command(git: &Path, root: &Path, oid: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("cat-file"),
        OsString::from("blob"),
        OsString::from(oid),
    ]);
    (git.to_path_buf(), args)
}

pub fn git_path_command(git: &Path, root: &Path, name: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("rev-parse"),
        OsString::from("--git-path"),
        OsString::from(name),
    ]);
    (git.to_path_buf(), args)
}

/// 在主仓库里删除一个附属工作区。路径是规范化后的绝对路径，不会被当成选项。
/// `force` 时加一个 `--force`：丢弃其中未提交的改动；锁定的工作区仍然拒绝。
pub fn worktree_remove_command(
    git: &Path,
    main: &Path,
    target: &Path,
    force: bool,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(main, false);
    args.extend([OsString::from("worktree"), OsString::from("remove")]);
    if force {
        args.push(OsString::from("--force"));
    }
    args.push(target.as_os_str().to_os_string());
    (git.to_path_buf(), args)
}

/// 枚举主仓库及其附属工作区：`--porcelain` 直接给出路径、HEAD、分支、锁定与可清理状态。
/// 只读：不 prune、不改写任何工作区元数据。
pub fn worktree_list_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("worktree"),
        OsString::from("list"),
        OsString::from("--porcelain"),
    ]);
    (git.to_path_buf(), args)
}

pub fn git_paths_command(git: &Path, root: &Path, names: &[&str]) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.push(OsString::from("rev-parse"));
    for name in names {
        args.extend([OsString::from("--git-path"), OsString::from(name)]);
    }
    (git.to_path_buf(), args)
}

pub fn head_record_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("log"),
        OsString::from("-1"),
        OsString::from("--format=%H%x1f%P%x1f%s"),
    ]);
    (git.to_path_buf(), args)
}

pub fn remote_names_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([OsString::from("remote")]);
    (git.to_path_buf(), args)
}

pub fn fetch_one_command(git: &Path, root: &Path, remote: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("fetch"),
        OsString::from("--prune"),
        OsString::from("--tags"),
        OsString::from("--"),
        OsString::from(remote),
    ]);
    (git.to_path_buf(), args)
}

pub fn ls_remote_tags_command(git: &Path, root: &Path, remote: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("ls-remote"),
        OsString::from("--tags"),
        OsString::from("--"),
        OsString::from(remote),
    ]);
    (git.to_path_buf(), args)
}

pub fn remote_tracking_command(git: &Path, root: &Path, remote: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("for-each-ref"),
        OsString::from("--format=%(refname)"),
        OsString::from(format!("refs/remotes/{remote}")),
    ]);
    (git.to_path_buf(), args)
}

pub fn push_reflog_command(git: &Path, root: &Path, refname: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("reflog"),
        OsString::from("show"),
        OsString::from("--format=%H%x1f%gs"),
        OsString::from(refname),
    ]);
    (git.to_path_buf(), args)
}

pub fn branch_contains_command(git: &Path, root: &Path, oid: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("branch"),
        OsString::from("-r"),
        OsString::from("--contains"),
        OsString::from(oid),
    ]);
    (git.to_path_buf(), args)
}

pub fn cached_diff_quiet_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.extend([
        OsString::from("diff"),
        OsString::from("--cached"),
        OsString::from("--quiet"),
    ]);
    (git.to_path_buf(), args)
}

pub fn reset_soft_command(git: &Path, root: &Path, parent: &str) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("reset"),
        OsString::from("--soft"),
        OsString::from(parent),
    ]);
    (git.to_path_buf(), args)
}

pub fn checkout_index_stage_command(
    git: &Path,
    root: &Path,
    stage: &str,
    path: &Path,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("checkout-index"),
        OsString::from("-f"),
        OsString::from(format!("--stage={stage}")),
        OsString::from("--"),
        path.as_os_str().to_os_string(),
    ]);
    (git.to_path_buf(), args)
}

pub fn hash_object_command(git: &Path, root: &Path, path: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("hash-object"),
        OsString::from("-w"),
        OsString::from("--"),
        path.as_os_str().to_os_string(),
    ]);
    (git.to_path_buf(), args)
}

pub fn update_index_info_command(git: &Path, root: &Path) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("update-index"),
        OsString::from("--index-info"),
    ]);
    (git.to_path_buf(), args)
}

pub fn checkout_side_command(
    git: &Path,
    root: &Path,
    side: &str,
    path: &Path,
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("checkout"),
        OsString::from(side),
        OsString::from("--"),
        path.as_os_str().to_os_string(),
    ]);
    (git.to_path_buf(), args)
}

pub fn remove_path_command(git: &Path, root: &Path, paths: &[PathBuf]) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("rm"),
        OsString::from("-f"),
        OsString::from("--"),
    ]);
    for path in paths {
        args.push(path.as_os_str().to_os_string());
    }
    (git.to_path_buf(), args)
}

pub fn restore_worktree_command(
    git: &Path,
    root: &Path,
    paths: &[PathBuf],
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("restore"),
        OsString::from("--source=HEAD"),
        OsString::from("--staged"),
        OsString::from("--worktree"),
        OsString::from("--"),
    ]);
    for path in paths {
        args.push(path.as_os_str().to_os_string());
    }
    (git.to_path_buf(), args)
}

pub fn head_match_command(
    git: &Path,
    root: &Path,
    cached: bool,
    paths: &[PathBuf],
) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, true);
    args.push(OsString::from("diff"));
    if cached {
        args.push(OsString::from("--cached"));
    }
    args.extend([
        OsString::from("--quiet"),
        OsString::from("HEAD"),
        OsString::from("--"),
    ]);
    for path in paths {
        args.push(path.as_os_str().to_os_string());
    }
    (git.to_path_buf(), args)
}

pub fn clean_files_command(git: &Path, root: &Path, paths: &[PathBuf]) -> (PathBuf, Vec<OsString>) {
    let mut args = repo_prefix(root, false);
    args.extend([
        OsString::from("clean"),
        OsString::from("-f"),
        OsString::from("--"),
    ]);
    for path in paths {
        args.push(path.as_os_str().to_os_string());
    }
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
    assert!(!args
        .iter()
        .any(|arg| arg == "sh" || arg == "bash" || arg == "cmd" || arg == "cmd.exe"));
    assert!(!args.iter().any(|arg| arg == "-c"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_log_defaults_to_head_and_keeps_author_out_of_grep() {
        let git = Path::new("git");
        let root = Path::new("/repo");
        let plain = history_log_command(git, root, &HistoryLog::default());
        assert!(plain.1.iter().any(|arg| arg == "log"));
        assert!(!plain.1.iter().any(|arg| arg == "--all"));
        assert!(!plain.1.iter().any(|arg| arg == "--author"));
        let filtered = HistoryLog {
            scope_all: true,
            author: Some("Ada".to_string()),
            grep: Some("needle".to_string()),
            path: Some(PathBuf::from("docs/a.txt")),
            skip: Some(10),
            max_count: Some(5),
            ..Default::default()
        };
        let args = history_log_command(git, root, &filtered).1;
        assert!(args.iter().any(|arg| arg == "--all"));
        assert!(args.iter().any(|arg| arg == "--author=Ada"));
        assert!(args.iter().any(|arg| arg == "--grep=needle"));
        assert!(args.iter().any(|arg| arg == "--fixed-strings"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--" && pair[1] == "docs/a.txt"));
        assert!(args.iter().any(|arg| arg == "--skip=10"));
        assert!(args.iter().any(|arg| arg == "--max-count=5"));
        let branch = HistoryLog {
            revision: Some("feature".to_string()),
            follow: true,
            skip: Some(100),
            max_count: Some(101),
            name_status: true,
            hits_only: true,
            path: Some(PathBuf::from("new.txt")),
            ..Default::default()
        };
        let branch_args = history_log_command(git, root, &branch).1;
        assert!(branch_args.iter().any(|arg| arg == "feature"));
        assert!(branch_args.iter().any(|arg| arg == "--follow"));
        assert!(branch_args.iter().any(|arg| arg == "--name-status"));
        assert!(branch_args.iter().any(|arg| arg == "-z"));
        assert!(branch_args.iter().any(|arg| arg == "--max-count=101"));
        assert!(!branch_args.iter().any(|arg| arg == "--all"));
        assert!(!branch_args
            .iter()
            .any(|arg| arg.to_string_lossy().starts_with("--skip")));
        let pick = cherry_pick_range_command(git, root, &["aaa".to_string(), "bbb".to_string()]);
        assert_eq!(
            pick.1
                .iter()
                .filter(|arg| *arg == "cherry-pick" || *arg == "aaa" || *arg == "bbb")
                .count(),
            3
        );
        assert!(!pick
            .1
            .iter()
            .any(|arg| arg == "--all" || arg == "-n" || arg == "--no-commit"));
        let detach = detach_at_command(git, root, "abc");
        assert!(detach
            .1
            .windows(2)
            .any(|pair| pair[0] == "--detach" && pair[1] == "--"));
        assert!(detach.1.iter().any(|arg| arg == "abc"));
        assert!(!detach.1.iter().any(|arg| arg == "--force" || arg == "-f"));
    }

    #[test]
    fn repo_commands_keep_paths_as_single_arguments() {
        let git = Path::new("/usr/bin/git");
        let root = Path::new("/tmp/demo; rm -rf");
        let (program, args) = status_command(git, root);
        assert_structured(&program, &args);
        assert_eq!(args[1], "-C");
        assert_eq!(args[2], root.as_os_str());
        assert!(args.iter().any(|arg| arg == "--untracked-files=all"));
        assert!(!args.iter().any(|arg| arg == "--untracked-files=normal"));
        let numstat_args = numstat_command(git, root, true).1;
        assert!(numstat_args.iter().any(|arg| arg == "--cached"));
        assert!(numstat_args.iter().any(|arg| arg == "--numstat"));
        assert!(numstat_args.iter().any(|arg| arg == "-z"));
        assert!(numstat_args
            .windows(2)
            .any(|pair| pair[0] == "-c" && pair[1] == "core.quotePath=false"));
        let git_path_args = git_path_command(git, root, "info/exclude").1;
        assert!(git_path_args.iter().any(|arg| arg == "--git-path"));
        assert_eq!(
            git_path_args.last().map(OsString::as_os_str),
            Some(std::ffi::OsStr::new("info/exclude"))
        );
        assert!(git_path_args
            .windows(2)
            .any(|pair| pair[0] == "-c" && pair[1] == "core.quotePath=false"));
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
        let upstream_args = set_upstream_to_command(git, root, "origin/main", "main").1;
        assert!(upstream_args
            .iter()
            .any(|arg| arg == "--set-upstream-to=origin/main"));
        assert!(upstream_args.iter().any(|arg| arg == "--"));
        assert_eq!(
            upstream_args.last().map(OsString::as_os_str),
            Some(std::ffi::OsStr::new("main"))
        );
        assert!(!upstream_args
            .iter()
            .any(|arg| arg == "push" || arg == "--set-upstream" || arg == "-u"));
        let merge_args = merge_no_commit_command(git, root, "feature").1;
        assert!(merge_args.iter().any(|arg| arg == "--no-commit"));
        assert!(merge_args.iter().any(|arg| arg == "--no-ff"));
        assert_eq!(
            merge_args.last().map(OsString::as_os_str),
            Some(std::ffi::OsStr::new("feature"))
        );
        let rebase_args = rebase_command(git, root, "origin/main").1;
        assert!(rebase_args.iter().any(|arg| arg == "rebase"));
        assert_eq!(
            rebase_args.last().map(OsString::as_os_str),
            Some(std::ffi::OsStr::new("origin/main"))
        );
        assert!(rebase_continue_command(git, root)
            .1
            .iter()
            .any(|arg| arg == "--continue"));
        assert!(rebase_abort_command(git, root)
            .1
            .iter()
            .any(|arg| arg == "--abort"));
        assert!(cherry_pick_abort_command(git, root)
            .1
            .iter()
            .any(|arg| arg == "--abort"));
        for sequencer in [
            rebase_args.clone(),
            rebase_continue_command(git, root).1,
            rebase_abort_command(git, root).1,
            cherry_pick_continue_command(git, root).1,
            cherry_pick_abort_command(git, root).1,
        ] {
            assert!(!sequencer.iter().any(|arg| {
                let text = arg.to_string_lossy();
                text == "--interactive"
                    || text == "-i"
                    || text == "--skip"
                    || text == "--squash"
                    || text == "squash"
            }));
        }
        let reset_args = reset_soft_command(git, root, "abc123").1;
        assert!(reset_args.iter().any(|arg| arg == "--soft"));
        assert!(!reset_args
            .iter()
            .any(|arg| arg == "--hard" || arg == "--mixed"));
        let clean_args = clean_files_command(git, root, &[PathBuf::from("only.txt")]).1;
        assert!(clean_args.iter().any(|arg| arg == "-f"));
        assert!(!clean_args
            .iter()
            .any(|arg| arg == "-d" || arg == "-x" || arg == "-fd"));
        assert_eq!(
            clean_args.last().map(OsString::as_os_str),
            Some(std::ffi::OsStr::new("only.txt"))
        );
        for builder in [
            merge_args,
            merge_abort_command(git, root).1,
            rebase_args,
            rebase_continue_command(git, root).1,
            rebase_abort_command(git, root).1,
            cherry_pick_continue_command(git, root).1,
            cherry_pick_abort_command(git, root).1,
            reset_args,
            fetch_one_command(git, root, "origin").1,
            ls_remote_tags_command(git, root, "origin").1,
            remote_tracking_command(git, root, "origin").1,
            push_reflog_command(git, root, "refs/remotes/origin/main").1,
            head_match_command(git, root, true, &[PathBuf::from("a.txt")]).1,
            checkout_side_command(git, root, "--ours", Path::new("my file.txt")).1,
            restore_worktree_command(git, root, &[PathBuf::from("my file.txt")]).1,
        ] {
            assert_no_force(&builder);
            assert!(!builder.iter().any(|arg| {
                let text = arg.to_string_lossy();
                text == "sh"
                    || text == "bash"
                    || text == "cmd"
                    || text == "cmd.exe"
                    || text == "--hard"
            }));
        }
        for builder in [
            fetch_command(git, root).1,
            pull_ff_command(git, root).1,
            push_command(git, root).1,
            publish_command(git, root, "origin", "main").1,
            delete_remote_branch_command(git, root, "origin", "feature").1,
            set_upstream_to_command(git, root, "origin/main", "main").1,
        ] {
            assert_no_force(&builder);
            assert!(!builder.iter().any(|arg| {
                let text = arg.to_string_lossy();
                text == "sh" || text == "bash" || text == "cmd" || text == "cmd.exe"
            }));
        }
    }

    #[test]
    fn branch_list_reads_origin_head_without_a_shell() {
        let git = Path::new("/usr/bin/git");
        let root = Path::new("/tmp/demo");
        let (program, args) = branch_list_command(git, root);
        assert_eq!(program, git);
        assert!(args.iter().any(|arg| arg == "for-each-ref"));
        assert!(args.iter().any(|arg| arg == "refs/heads"));
        assert!(args.iter().any(|arg| arg == "refs/remotes"));
        assert!(args
            .iter()
            .any(|arg| arg.to_string_lossy().contains("%(symref:short)")));
        assert!(!args.iter().any(|arg| {
            let text = arg.to_string_lossy();
            text == "sh" || text == "bash" || text == "cmd" || text == "cmd.exe"
        }));
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
