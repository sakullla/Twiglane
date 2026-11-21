# Twiglane 远端 Git agent v2

日期：2026-11-21

v2 是远端执行面，不是第二套 Git 实现：二进制直接编译桌面端同一批 Rust 源文件
（`src-tauri/src/model.rs`、`src-tauri/src/git/**`、`state.rs`、`shutdown.rs`、
`atomic.rs`、`watch.rs`），所以仓库模型、命令构造、状态解析、行统计、暂存/提交的写入顺序、
代次校验与错误分类与本地后端同源。桌面专属的部分（Tauri 入口、`lib.rs` 命令层、终端、更新、
变更请求、Cliora 接入、项目工作区）不进入远端进程。

## 与 v1 的关系

| | v1 | v2 |
|---|---|---|
| 产物 | `remote-agent/agent`（Python 3.8+） | `twiglane-agent-v2`（Rust 原生） |
| 安装路径 | `~/.local/share/twiglane/agent/v1` | 独立路径，不覆盖 v1 |
| 版本行 | `twiglane-agent/1` | `twiglane-agent/2` |
| 写入记录 | `XDG_STATE_HOME` | Git common dir 下的 `twiglane-agent-v2/` |
| 能力 | open/status/diff/stage/unstage/commit/receipt | 同上 + 按块/按行 patch、cancel、跨进程写锁、状态令牌，以及历史与搜索、分支标签、fetch/pull/push、stash、merge/rebase/cherry-pick/revert、修订撤销和 worktree |

v1 的安装、版本握手和写入记录保持可读；v2 不读取也不 reinterpret v1 的记录。两者可以同时
存在于同一台主机。

## 进程与传输

- 启动：`--stdio`（无参数等价）、`--version`、`--probe`。
- 标准输入输出均为 UTF-8 JSON Lines，一问一答，响应可以乱序返回，客户端按 `id` 匹配。
- 请求最多 128 KiB，单条响应最多 4 MiB，同一通道最多 16 个在途请求（超限返回 `remote_busy`）。
- 一个进程持有一个打开的工作树；`repo` 字段必须等于打开时的规范路径。

`--probe` 输出一行 JSON，供安装方在选择产物前判断目标：

``json
{"protocol":2,"agent":"twiglane-agent/2","version":"0.3.40","os":"macos","arch":"aarch64","host":"…","git":"git version …","capabilities":["open","status","diff","stage","unstage","patch","commit","receipt","cancel","history","fileHistory","commitDetail","commitDiff","compare","commitBranches","compareFileDiff","branchList","branchState","branchTracking","fetchBranches","deleteRemoteBranch","setUpstream","associateUpstream","tagRemoteState","branchCreate","branchSwitch","branchRename","branchDelete","branchTrack","branchUpdate","branchPublish","tagState","tagCreate","tagDelete","tagPush","remoteState","remoteAdd","remoteSetUrl","fetch","pull","push","pushToRemote","publishBranch","stashState","stashSave","stashApply","stashDelete","mergePreview","mergeSession","mergeStart","mergeComplete","mergeAbort","conflictView","resolveConflict","cherryPick","revert","undoCommit","checkoutCommit","amendCommit","discard","worktrees","worktreeRemove"]}
``

## 帧

请求：`{"v":2,"id":"<token>","op":"<name>", ...字段}`
成功：`{"v":2,"id":"<token>","ok":true,"result":{...}}`
失败：`{"v":2,"id":"<token>","ok":false,"error":{"code":"…","message":"…","generation":…}}`

`id` 为 1–80 个 ASCII 字母、数字、下划线或连字符；`v` 不等于 2 时返回
`unsupported_protocol`，不按 v2 处理。

自定义字段一律 camelCase，与桌面 DTO 完全一致。

## 只读操作

| op | 其余字段 | result |
|---|---|---|
| hello | `client?` | `{protocol,agent,version,os,arch,host,client,capabilities,receipts:"git-common-dir",generation:"numeric",stateToken:"opaque"}` |
| open | `path` | 打开摘要：`{repo,root,name,host,generation,stateToken,snapshot,draft,abbrevLength,watchDegraded:true,capabilities}` |
| status | `repo,generation?` | `{repo,generation,stateToken,snapshot}` |
| diff | `repo,path,view,original?,offset?,limit?,context?,cursor?` | `{repo,path,staged,generation,stateToken,nextCursor,diff}` |
| history | `repo,query?,offset?,scope?,author?,since?,until?,pathFilter?` | `{repo,generation,page,nextOffset}`，`page` 是桌面的 `HistoryPage` |
| fileHistory | `repo,path,query?,offset?,scope?,author?,since?,until?` | `{repo,path,generation,page,nextOffset}`，`page` 是 `FileHistoryPage` |
| commitDetail | `repo,oid,parent?` | `{repo,generation,commit}`，`commit` 是 `CommitDetail` |
| commitDiff | `repo,oid,parent?,path,offset?,limit?,context?,asText?` | `{repo,path,generation,diff}`，`diff` 是 `DiffResponse` |
| compare | `repo,base?,head` | `{repo,base,head,compare}`，`compare` 是 `CompareFiles` |
| branchList | `repo` | `{repo,branches}`，`branches` 是 `BranchListing` |
| branchState | `repo` | `{repo,branchState}`，`branchState` 是 `BranchState`（分支列表 + 状态快照） |
| branchTracking | `repo` | `{repo,branchTracking}`，`branchTracking` 是 `BranchTracking`（每条分支的 `ahead`/`behind`/`gone`；`BranchListing` 里没有这些数字，客户端不能自己推） |
| tagRemoteState | `repo,remote` | `{repo,remote,tagRemoteState}`，`tagRemoteState` 是 `RemoteTag[]`（`ls-remote` 的结果） |
| commitBranches | `repo,oid` | `{repo,oid,commitBranches}`，`commitBranches` 是 `CommitBranches`（`branches[]`、`total`、`current`） |
| compareFileDiff | `repo,base,head,path,offset?,limit?,context?` | `{repo,path,base,head,generation,compareFileDiff}`，`compareFileDiff` 是 `DiffResponse`；`base` 为空串时按空树比较 |
| tagState | `repo` | `{repo,tags}`，`tags` 是 `TagState` |
| remoteState | `repo` | `{repo,remote}`，`remote` 是 `RemoteState` |
| stashState | `repo,includeUntracked?` | `{repo,stash}`，`stash` 是 `StashState` |
| mergePreview | `repo,source,target?` | `{repo,preview}`，`preview` 是 `MergePreview` |
| mergeSession | `repo` | `{repo,merge}`，`merge` 是进行中的 `MergeSession`（没有进行中的操作时也返回该结构） |
| conflictView | `repo,path` | `{repo,conflict}`，`conflict` 是 `ConflictView` |
| worktrees | `repo,paths?` | `{repo,worktrees}`，`worktrees` 是 `WorktreeOverview`；缺省只查当前仓库 |
| receipt | `repo,operationId` | `{receipt,operationId,repo}` 或 `{receipt:null,state:"unknown",reason:"not_recorded",operationId,repo}` |
| cancel | `targetId` | `{targetId,cancelled:bool,remoteStopped?:bool}` |

- `snapshot` 就是桌面的 `StatusSnapshot`（数值 generation、`BranchInfo`、带重命名/冲突/行统计的
  `FileChange`），差异就是 `DiffResponse`（`hunks`、`lines`、`snapshot`、`offset`、
  `totalLines`）。主界面不需要另一套解析。
- `branchState`、`branchTracking`、`tagRemoteState`、`commitBranches`、`compareFileDiff` 这五个
  入口把结果放在与 op 同名的字段里（`branchState`/`branchTracking`/`tagRemoteState`/`commitBranches`/
  `compareFileDiff`），DTO 仍是本地同名类型。只读入口里 `branches` 只属于 `branchList`
  （`BranchListing`）；写入入口的 `branches` 是 `BranchState`（见写入结果表），两者按 op 区分，
  新增的只读入口不用这些短名，避免 `branchList` 与 `branchState` 抢同一个字段。
- `view` 只能是 `staged` 或 `unstaged`；`limit` 默认 200、上限 2000 行（`commitDiff` 同样适用）。
- 历史与搜索按页读取：`page.pageSize` 是共享实现的分页大小，`page.hasMore` 为真时 `nextOffset`
  给出下一页偏移；`page.state` 是 `ok`、`empty_repository`、`empty_branch`、`no_match` 之一。
  换查询或换范围就是新的一次分页读取，不沿用上一页结果。
- 只读入口在返回前核对取消标记，读的过程中被取消会返回 `cancelled`，不会把半截结果交出去。
- `cancel` 同时做两件事：翻转本进程的取消标记，以及在目标请求访问远程时停掉共享 `git::sync`
  调度器里那条远程命令（等价于桌面端 `cancel_remote`，排队中或运行中的子进程都会停）。因此
  `remoteStopped:true` 才表示「在途 fetch/pull/push 真的被中止」；远程可能已经收到部分请求，
  回答只说明不再等待，结果以刷新后的状态与回执为准。

## 写入操作

每类写入都是独立的 op 名，回执按它区分动作，而不是共用「有 operationId 就算同类」：合并、变基、
拣选、回退、修订撤销、stash 与 worktree 的 Git 原子边界不同，回执必须能显示是哪一个停在半途。

| 类别 | op | 其余字段（除 `repo,operationId,stateToken`） |
|---|---|---|
| 改动 | `stage` / `unstage` | `paths[]` |
| 改动 | `patch` | `path,original?,staged,snapshot,hunks[] 或 lines[]` |
| 改动 | `discard` | `paths[],confirm` |
| 提交 | `commit` | `message` |
| 提交 | `amendCommit` | `expectedHead,message?,includeStaged?,stagedToken?,confirm` |
| 分支 | `branchCreate` | `name,start?,checkout?` |
| 分支 | `branchSwitch` / `branchUpdate` / `branchPublish` | `name` |
| 分支 | `branchRename` | `old,new` |
| 分支 | `branchDelete` | `name,confirmUnmerged?` |
| 分支 | `branchTrack` | `remoteBranch,name` |
| 分支 | `setUpstream` | `upstream`（已有远程跟踪分支名，如 `origin/main`） |
| 分支 | `associateUpstream` | `remote?`（可空串，由共享实现按现有远程决定） |
| 标签 | `tagCreate` | `name,target,message?` |
| 标签 | `tagDelete` | `name,confirm` |
| 标签 | `tagPush` | `remote,name` |
| 同步 | `remoteAdd` / `remoteSetUrl` | `name,url` |
| 同步 | `fetch` / `pull` / `push` | 无 |
| 同步 | `pushToRemote` / `publishBranch` | `remote` |
| 同步 | `fetchBranches` | 无（fetch 后返回 `BranchState`） |
| 同步 | `deleteRemoteBranch` | `remote,name,confirm` |
| stash | `stashSave` | `includeUntracked?,message?` |
| stash | `stashApply` | `oid` |
| stash | `stashDelete` | `oid,confirm` |
| 合并 | `mergeStart` | `source,target?,mode?`（`mode` 为 `merge` 或 `rebase`） |
| 合并 | `mergeComplete` / `mergeAbort` | `message?` / `confirm` |
| 合并 | `resolveConflict` | `path,choice,content?`（`choice` 为 `text`、`ours` 或 `theirs`） |
| 历史 | `cherryPick` | `oids[]` |
| 历史 | `revert` | `oids[],expectedHead,confirm` |
| 历史 | `undoCommit` | `expectedHead,confirm` |
| 历史 | `checkoutCommit` | `oid` |
| worktree | `worktreeRemove` | `force`（只接受这四个字段，见下文） |

写入结果统一为 `{repo,generation,stateToken,receipt,<结果字段>}`，结果字段沿用本地同名 DTO：

| op | 结果字段 |
|---|---|
| `stage` / `unstage` / `patch` / `fetch` / `pull` / `push` / `pushToRemote` / `publishBranch` / `checkoutCommit` | `snapshot` |
| `commit` | `commit` |
| `associateUpstream` | `snapshot`（`StatusSnapshot`，含新的 `branch.upstream`） |
| `branchCreate` / `branchSwitch` / `branchRename` / `branchDelete` / `branchTrack` / `branchUpdate` / `branchPublish` / `setUpstream` / `fetchBranches` / `deleteRemoteBranch` | `branches`（`BranchState`） |
| `tagCreate` / `tagDelete` / `tagPush` | `tags`（`TagState`） |
| `remoteAdd` / `remoteSetUrl` | `remote`（`RemoteState`） |
| `stashSave` / `stashApply` / `stashDelete` | `stash` |
| `mergeStart` / `mergeComplete` / `mergeAbort` / `resolveConflict` | `merge` |
| `cherryPick` / `revert` / `undoCommit` | `cherryPick` / `revert` / `undo` |
| `amendCommit` | `amend` |
| `discard` | `discard` |
| `worktreeRemove` | `recent` |

- `patch` 用 `hunks` 或 `lines` 二选一，另一项必须缺省或为空；`snapshot` 是读取该差异时得到的
  `diff.snapshot` 令牌，写入时重新读取差异并核对，因此行身份过期会失败而不是错写。
- 写后只回一次新状态：具体结果、新令牌和 `generation` 在同一个响应里，客户端不需要再补一次
  `status`。`worktreeRemove` 删掉的正是被读取的那棵工作树，因此该项成功时可能不带 `stateToken`；
  客户端应关闭这棵工作树，而不是继续用旧令牌写入。
- `worktreeRemove` 只接受 `repo`、`operationId`、`stateToken`、`force` 四个字段。多带任何
  字段（例如本地命令习惯里的 `path`）返回 `invalid_request` 且不删任何东西：v2 的这条 op
  删除的始终是「当前打开的那棵工作树」，不按字段另选目录，所以静默忽略一个 `path` 会让调用方
  以为删了别的目录。
- `mergeAbort` 的结果字段也是 `merge`，但它的 DTO 是「撤销影响」而不是进行中的会话：
  `mergeStart`/`resolveConflict` 回的是 `MergeSession`（`unresolved`、`conflicts[]`、`canContinue`），
  `mergeComplete` 回 `MergeComplete`（`oid`、`files[]`、`snapshot`），`mergeAbort` 回的是撤销后
  的差异与恢复条目。按 `merge.unresolved` 是否存在判断「还在合并中」，不要共用一套字段假设。
- 同一个 `operationId` 已完成时重放只回原回执：`{receipt,replayed:true,result:null,reconcile:"reread"}`。
  v2 不持久化上次的结果 DTO，客户端应据回执里的 `head`/`branch` 重读一次状态，而不是把这次
  响应当成完整结果。
- 远程写入（`fetch`/`fetchBranches`/`pull`/`push`/`pushToRemote`/`publishBranch`/`deleteRemoteBranch`/`tagPush`）
  在 `cancelled`、`timeout`、`network` 下回执记为 `pending`（`reason` 为真实错误码）而不是
  `failed`：远端可能已经收到这次请求。`pending` 与 `registered` 一样不能重发，只能用 `receipt`
  核对后重读状态。

## 数值 generation 与不透明状态令牌

- `generation` 来自共享调度器的仓库车道，进程内单调，供界面判断迟到响应；进程重启后从 1 重新开始，
  因此它不能单独作为「客户端读到的就是当前状态」的证明。
- `stateToken` 是服务端算出的摘要，绑定 HEAD、索引字节、状态条目和每个改动路径的大小、修改时间与
  （预算内）内容。写入必须带客户端见过的令牌，不符时返回 `state_mismatch` 且不写仓库。
- 续页游标绑定仓库、令牌、文件、视图、每页行数和下一页偏移；换了文件或写入推进了令牌即
  `cursor_expired`，必须从第一页重读。新选择会推进选择 epoch，仍在生成的旧页返回 `superseded`。

## 写入顺序与回执

1. 在 common Git dir 上取跨进程写锁（`twiglane-agent-v2.lock`，`create_new` 创建）。
2. 拿锁后按 `operationId` 查回执：已 `completed` 且请求摘要相同 → 直接重放原结果（不动仓库）；
   摘要或 op 名不同 → `operation_conflict`；`registered` 或 `pending` → `operation_pending`；`failed` → 原错误码。
   回执文件存在但无法解析时返回 `receipt_unreadable`，按「结果未确认」处理：既不当成没写过，
   也不当成已完成，同一 `operationId` 不会被重新执行，也不会覆盖那份回执。
3. 核对 `stateToken`；不符时登记一条 `failed` 回执（原因 `state_mismatch`）再返回错误。
4. 登记 `registered` 回执（临时文件 + fsync + rename + 目录 fsync）。查重与登记在同一个写锁
   临界区内完成，所以两个客户端用同一 `operationId` 并发提交时，只有一个能看到「没有记录」。
5. 执行共享写入（`changes::*`、`sync::*`、`tags::*`、`history::*`、`resolve::*`、`worktree::*`），
   成功改为 `completed`，失败记 `failed` 与该阶段的真实错误码。
6. 读一次新状态并与结果一起返回，客户端不需要再补一次 status。

锁的取用与回收按当前实现如实描述（`src-tauri/src/git/gate.rs`）：

- 取锁用 `create_new` 创建 `twiglane-agent-v2.lock`，写入 `pid` 与毫秒时间戳并 fsync；拿不到就在
  10 秒内每 25 ms 重试一次，仍拿不到返回 `write_locked`，不改动仓库。进程正常结束时 `Drop` 删除锁文件。
- 回收判据只有文件年龄一项：锁文件修改时间超过 10 分钟即视为持有者已消失，直接 `remove_file`
  后重试创建。
- **尚未实现** `pid` 存活判断、活着时刷新时间戳、以及「先 rename 到本进程独占的临时名再删除」的
  互斥回收。因此当前实现有两个已知限制：一次超过 10 分钟的 fetch/push 期间，另一个进程可以把
  仍在使用的锁当成陈旧锁删掉；两个进程同时判定陈旧时，后一方删除可能落在另一方新建的锁上。
  加固补丁已经写好但不在本 Task 范围内：
  `docs/sakullla-workflow/2026-11-21-remote-repository-parity-ssh/evidence/owner-notes/pending-gate-lock-hardening.patch`
  （改 `gate.rs`，需要单独授权）。在补丁落地前，客户端应把超过 10 分钟的远程写入视为「可能被
  并发写入」，按回执与刷新后的状态核对。

回执位于 `<git-common-dir>/twiglane-agent-v2/receipts/<operationId>.json`，与仓库绑定：同一仓库的多个工作区
和多条连接看到同一份记录。进程在 `registered` 与完成之间崩溃时回执停在 `registered`，重连只能查询，
不能重发。

## 与本地同效的核对方式

v2 不复制 Git 语义，而是编译同一批桌面源文件，所以「同效」是按模块对齐的：

| 行为 | 共享实现 | 真实 Git 回归 |
|---|---|---|
| 状态、差异、暂存/取消暂存、按块/按行、提交 | `git::changes`、`git::patch`、`git::ops` | `remote-agent/v2/tests/protocol.rs`（stage/patch/commit 用例） |
| 历史与搜索、文件历史、提交详情与比较 | `git::history` | `history_search_file_history_and_commit_diff_page_the_selected_range` |
| 分支与标签 | `git::sync`、`git::tags` | `branch_and_tag_writes_return_the_shared_state_and_replay_receipts` |
| fetch/pull/push | `git::sync` | `fetch_push_and_pull_run_real_git_on_the_remote_side` |
| stash | `git::history` | `stash_save_apply_and_delete_round_trip_through_the_agent` |
| merge/rebase/冲突处理 | `git::resolve` | `merge_conflict_blocks_completion_until_the_conflict_is_resolved` |
| cherry-pick、revert、修订撤销 | `git::resolve` | `cherry_pick_undo_and_revert_write_real_commits` |
| worktree 总览与删除 | `git::heads`、`git::worktree` | `linked_worktrees_are_listed_and_removable_from_the_agent` |
| 写锁、回执、未知结果 | `git::gate`、`receipts` | 钩子失败、索引锁、外部 HEAD 漂移、断线重连、并发占用锁等用例 |
| 分支跟踪、上游关联、远端分支删除、远端标签、提交所属分支、任意两点单文件差异 | `git::sync`、`git::tags`、`git::history` | `the_window_read_entries_track_branches_tags_and_commit_membership`、`upstream_and_remote_branch_writes_go_through_shared_sync` |
| 在途远程命令的取消 | `git::schedule`（`cancel_remote`）+ `git::runner` | `cancel_stops_an_in_flight_fetch_and_leaves_the_result_unknown` |

每条断言都读取真实 Git（`rev-parse`、`rev-list`、文件内容、`status`），而不是只看 DTO 字段，
因此「远端返回本地同名 DTO」与「远端真的执行了这次 Git」是分别被验证的两件事。同一批共享源文件
也由桌面端的 `cargo test --manifest-path src-tauri/Cargo.toml git::` 覆盖，两边跑的是同一份实现。

跨两端的共享行为清单在 `tests/fixtures/remote-parity/scenarios.json`：每个场景有稳定的 `id`、
步骤和 `expect`（文件内容、次数、错误码这类稳定值）。远端侧由
`shared_parity_scenarios_drive_the_remote_agent` 直接 `include_str!` 读取该文件，按其中的期望值
驱动冲突合并、stash 往返、worktree 增删三个场景；桌面侧按同一批 `id` 引用，不复制步骤文本。
改期望只改这一份，避免两端各自维护一份会漂移的清单。

## 明确不在 v2 本版本内的能力

- 审阅基线（`baseline`）：请求带 `baseline` 会返回 `unsupported_baseline`。
- 远端文件变化事件：`open` 返回 `watchDegraded:true`，客户端按聚焦或显式刷新读取状态，不承诺轮询周期。
- 文件树、文件正文、文档与资源、路径/全文搜索、终端 PTY：由后续任务在同一协议上补齐。
- 普通 Git RPC 没有程序或命令字段：本协议不提供任意 shell。

