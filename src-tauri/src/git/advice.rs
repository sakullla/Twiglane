use crate::error::AppError;
use crate::redact::redact_error_text;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitProblem {
    Auth,
    Permission,
    RemoteMissing,
    Network,
    Diverged,
    PushRejected,
    LocalChanges,
    UnmergedBranch,
}

pub fn classify_problem(text: &str) -> Option<GitProblem> {
    let lower = text.to_ascii_lowercase();
    if contains_any(
        &lower,
        &[
            "would be overwritten",
            "please commit your changes or stash them",
            "local changes to the following files",
            "将被检出操作覆盖",
            "将被合并操作覆盖",
            "请提交或贮藏",
            "请先提交或贮藏",
        ],
    ) {
        return Some(GitProblem::LocalChanges);
    }
    if contains_any(
        &lower,
        &[
            "not possible to fast-forward",
            "diverging branches",
            "无法快进",
            "不能快进",
            "分支已经分叉",
        ],
    ) {
        return Some(GitProblem::Diverged);
    }
    if contains_any(
        &lower,
        &[
            "non-fast-forward",
            "updates were rejected",
            "[rejected]",
            "拒绝更新",
            "非快进",
        ],
    ) {
        return Some(GitProblem::PushRejected);
    }
    if contains_any(&lower, &["not fully merged", "没有完全合并"]) {
        return Some(GitProblem::UnmergedBranch);
    }
    if contains_any(
        &lower,
        &[
            "authentication failed",
            "could not read username",
            "terminal prompts disabled",
            "permission denied (publickey)",
            "permission denied (keyboard-interactive)",
            "support for password authentication was removed",
            "身份验证失败",
            "认证失败",
            "没有权限读取",
        ],
    ) {
        return Some(GitProblem::Auth);
    }
    if lower.contains("repository") && lower.contains("not found")
        || contains_any(&lower, &["remote repository not found", "仓库不存在"])
    {
        return Some(GitProblem::RemoteMissing);
    }
    if contains_any(
        &lower,
        &[
            "returned error: 403",
            "returned error: 401",
            "access denied",
            "you don't have permission",
            "not permitted to",
            "拒绝访问",
        ],
    ) {
        return Some(GitProblem::Permission);
    }
    if contains_any(
        &lower,
        &[
            "could not resolve host",
            "failed to connect",
            "couldn't connect",
            "could not connect",
            "connection refused",
            "connection timed out",
            "operation timed out",
            "network is unreachable",
            "unable to access",
            "connection reset",
            "the remote end hung up unexpectedly",
            "could not read from remote repository",
            "无法连接",
            "无法解析",
            "连接超时",
            "连接被拒绝",
        ],
    ) {
        return Some(GitProblem::Network);
    }
    None
}

pub fn problem_error(problem: GitProblem, detail: &str) -> AppError {
    let (code, message) = match problem {
        GitProblem::Auth => (
            "auth",
            "认证失败。请在系统凭据助手或 SSH agent 中准备可用凭据后重试。Twiglane 不保存令牌，本地查看、暂存、提交和分支操作也不需要登录研发平台。",
        ),
        GitProblem::Permission => (
            "permission",
            "远程拒绝访问。请确认账号对该仓库有权限，修正后重试。界面不会显示完整凭据。",
        ),
        GitProblem::RemoteMissing => (
            "remote_missing",
            "远程仓库不存在，或当前身份看不到它。请核对地址和权限后重试。",
        ),
        GitProblem::Network => (
            "network",
            "无法连接远程。请检查网络、地址和代理后重试。本地查看、暂存、提交和分支操作仍可继续。",
        ),
        GitProblem::Diverged => (
            "diverged",
            "本地和远程都有新提交，不能快进。没有合并，也没有覆盖工作区。请先走分支合并，再继续同步。",
        ),
        GitProblem::PushRejected => (
            "push_rejected",
            "推送被拒绝，因为远程已有新提交。没有强行推送。若还没有上游，请先只关联上游（不会推送），再快进拉取；已经有上游时请先快进拉取。不能快进时请走分支合并，不要强行推送。",
        ),
        GitProblem::LocalChanges => (
            "local_changes",
            "此操作会覆盖未提交的修改，已停止。这些修改仍留在工作区。请先提交，或先临时保存，然后再继续。",
        ),
        GitProblem::UnmergedBranch => (
            "branch_unmerged",
            "该分支含有尚未合入当前分支的提交，未删除。确认风险后才会删除；删除后这些提交不能由本操作自动恢复。",
        ),
    };
    let detail = redact_error_text(detail.trim());
    if detail.is_empty() {
        AppError::new(code, message)
    } else {
        AppError::new(code, format!("{message} {detail}"))
    }
}

pub fn remote_timeout(error: AppError) -> AppError {
    if error.code == "timeout" {
        AppError::new(
            "timeout",
            "远程操作超时并已停止，没有继续等待交互输入。请确认系统凭据助手或 SSH agent 可用后重试。本地查看和提交不受影响。",
        )
    } else {
        error
    }
}

fn contains_any(haystack: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|phrase| haystack.contains(phrase))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_auth_permission_network_and_hides_tokens() {
        let auth = problem_error(
            classify_problem("fatal: Authentication failed for 'https://user:ghp_abcdefghijklmnopqrstuvwxyz1234@github.com/acme/app.git'").unwrap(),
            "fatal: Authentication failed for 'https://user:ghp_abcdefghijklmnopqrstuvwxyz1234@github.com/acme/app.git'",
        );
        assert_eq!(auth.code, "auth");
        assert!(auth.message.contains("SSH agent"));
        assert!(!auth.message.contains("ghp_abcdefghijklmnopqrstuvwxyz1234"));

        let public_key =
            classify_problem("git@github.com: Permission denied (publickey).").unwrap();
        assert_eq!(public_key, GitProblem::Auth);
        assert_eq!(
            classify_problem(
                "fatal: unable to access 'https://example.com/': Could not resolve host"
            )
            .unwrap(),
            GitProblem::Network
        );
        assert_eq!(
            classify_problem("fatal: the requested URL returned error: 403").unwrap(),
            GitProblem::Permission
        );
        assert_eq!(
            classify_problem("fatal: repository 'https://example.com/missing.git' not found")
                .unwrap(),
            GitProblem::RemoteMissing
        );
    }

    #[test]
    fn classifies_divergence_without_treating_it_as_success() {
        assert_eq!(
            classify_problem("fatal: Not possible to fast-forward, aborting.").unwrap(),
            GitProblem::Diverged
        );
        assert_eq!(
            classify_problem("! [rejected] main -> main (non-fast-forward)").unwrap(),
            GitProblem::PushRejected
        );
        let rejected = problem_error(GitProblem::PushRejected, "");
        assert!(!rejected.message.contains("强行推送已"));
        assert!(rejected.message.contains("没有强行推送"));
        assert!(rejected.message.contains("只关联上游"));
        assert!(rejected.message.contains("快进拉取"));
        assert!(!rejected.message.contains("请先拉取或合并"));
        assert_eq!(
            classify_problem("error: Your local changes to the following files would be overwritten by checkout:\nPlease commit your changes or stash them before you switch branches.").unwrap(),
            GitProblem::LocalChanges
        );
        assert_eq!(
            classify_problem("error: the branch 'topic' is not fully merged").unwrap(),
            GitProblem::UnmergedBranch
        );
    }
}
