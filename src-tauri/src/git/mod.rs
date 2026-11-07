/// 写入已经完成之后的读取。
///
/// 写锁释放后，文件监视器可能因为刚才的写入再推高 generation，此时按旧 generation
/// 读取会得到 `stale`。前端把 `stale` 理解为「什么都没写、可以按新 generation 重试」，
/// 于是会把已经成功的写操作再执行一次（例如临时保存成功后又报「没有可保存的内容」）。
/// 因此写后读取遇到 `stale` 时在后端用最新 generation 重读，绝不把 `stale` 交出去。
macro_rules! settle_read {
    ($backend:expr, $root:expr, $generation:expr, |$g:ident| $body:expr) => {{
        let mut $g: u64 = $generation;
        let mut attempt = 0u32;
        loop {
            match $body {
                Err(error) if error.code == "stale" && attempt < 6 => {
                    attempt += 1;
                    $g = $backend
                        .scheduler
                        .current_generation(&crate::git::ops::repo_key($root));
                }
                other => break other,
            }
        }
    }};
}

pub mod advice;
pub mod changes;
pub mod command;
pub mod credential;
pub mod files;
pub mod gate;
pub mod heads;
pub mod history;
pub mod locate;
pub mod ops;
pub mod parse;
pub mod patch;
pub mod preview;
pub mod resolve;
pub mod runner;
pub mod schedule;
pub mod sizes;
pub mod sync;
pub mod tags;
pub mod workspace;
pub mod worktree;
