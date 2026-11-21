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
| 能力 | open/status/diff/stage/unstage/commit/receipt | 同上 + 按块/按行 patch、cancel、跨进程写锁、状态令牌 |

v1 的安装、版本握手和写入记录保持可读；v2 不读取也不 reinterpret v1 的记录。两者可以同时
存在于同一台主机。

## 进程与传输

- 启动：`--stdio`（无参数等价）、`--version`、`--probe`。
- 标准输入输出均为 UTF-8 JSON Lines，一问一答，响应可以乱序返回，客户端按 `id` 匹配。
- 请求最多 128 KiB，单条响应最多 4 MiB，同一通道最多 16 个在途请求（超限返回 `busy`）。
- 一个进程持有一个打开的工作树；`repo` 字段必须等于打开时的规范路径。

`--probe` 输出一行 JSON，供安装方在选择产物前判断目标：

``json
{"protocol":2,"agent":"twiglane-agent/2","version":"0.3.40","os":"macos","arch":"aarch64","host":"…","git":"git version …","capabilities":["open","status","diff","stage","unstage","patch","commit","receipt","cancel"]}
``

## 帧

请求：`{"v":2,"id":"<token>","op":"<name>", ...字段}`
成功：`{"v":2,"id":"<token>","ok":true,"result":{...}}`
失败：`{"v":2,"id":"<token>","ok":false,"error":{"code":"…","message":"…","generation":…}}`

`id` 为 1–80 个 ASCII 字母、数字、下划线或连字符；`v` 不等于 2 时返回
`unsupported_protocol`，不按 v2 处理。

自定义字段一律 camelCase，与桌面 DTO 完全一致。

## 操作

| op | 其余字段 | result |
|---|---|---|
| hello | `client?` | `{protocol,agent,version,os,arch,host,client,capabilities,receipts:"git-common-dir",generation:"numeric",stateToken:"opaque"}` |
| open | `path` | 打开摘要：`{repo,root,name,host,generation,stateToken,snapshot,draft,abbrevLength,watchDegraded:true,capabilities}` |
| status | `repo,generation?` | `{repo,generation,stateToken,snapshot}` |
| diff | `repo,path,view,original?,offset?,limit?,context?,cursor?` | `{repo,path,staged,generation,stateToken,nextCursor,diff}` |
| stage / unstage | `repo,operationId,stateToken,paths[]` | `{repo,generation,stateToken,receipt,snapshot}` |
| patch | `repo,operationId,stateToken,path,original?,staged,snapshot,hunks[] | lines[]` | `{repo,generation,stateToken,receipt,snapshot}` |
| commit | `repo,operationId,stateToken,message` | `{repo,generation,stateToken,receipt,commit}` |
| receipt | `repo,operationId` | `{receipt}` 或 `{receipt:null,state:"unknown",reason:"not_recorded",operationId,repo}` |
| cancel | `targetId` | `{targetId,cancelled:bool}` |

- `snapshot` 就是桌面的 `StatusSnapshot`（数值 generation、`BranchInfo`、带重命名/冲突/行统计的
  `FileChange`），差异就是 `DiffResponse`（`hunks`、`lines`、`snapshot`、`offset`、
  `totalLines`）。主界面不需要另一套解析。
- `view` 只能是 `staged` 或 `unstaged`；`limit` 默认 400、上限 2000 行。
- `patch` 用 `hunks` 或 `lines` 二选一，另一项必须缺省或为空；`snapshot` 是读取该差异时
  得到的 `diff.snapshot` 令牌，写入时重新读取差异并核对，因此行身份过期会失败而不是错写。

## 数值 generation 与不透明状态令牌

- `generation` 来自共享调度器的仓库车道，进程内单调，供界面判断迟到响应；进程重启后从 1 重新开始，
  因此它不能单独作为「客户端读到的就是当前状态」的证明。
- `stateToken` 是服务端算出的摘要，绑定 HEAD、索引字节、状态条目和每个改动路径的大小、修改时间与
  （预算内）内容。写入必须带客户端见过的令牌，不符时返回 `state_mismatch` 且不写仓库。
- 续页游标绑定仓库、令牌、文件、视图、每页行数和下一页偏移；换了文件或写入推进了令牌即
  `cursor_expired`，必须从第一页重读。新选择会推进选择 epoch，仍在生成的旧页返回 `superseded`。

## 写入顺序与回执

1. 用 `operationId` 查回执：已 `completed` 且请求摘要相同 → 直接重放原结果（不动仓库）；
   摘要不同 → `operation_conflict`；`registered` → `operation_pending`；`failed` → 原错误码。
2. 核对 `stateToken`。
3. 在 common Git dir 上取跨进程写锁（`twiglane-agent-v2.lock`，`create_new` 创建，持锁进程消失后按文件
   年龄回收），拿锁后重新核对令牌。
4. 登记 `registered` 回执（临时文件 + fsync + rename + 目录 fsync）。
5. 执行共享写入（`changes::stage_files` / `unstage_files` / `stage_hunks` / `stage_lines` /
   `commit_index`），成功改为 `completed`，失败记 `failed` 与原因。
6. 返回新状态，客户端不需要再补一次 status。

回执位于 `<git-common-dir>/twiglane-agent-v2/receipts/<operationId>.json`，与仓库绑定：同一仓库的多个工作区
和多条连接看到同一份记录。进程在 `registered` 与完成之间崩溃时回执停在 `registered`，重连只能查询，
不能重发。

## 明确不在 v2 本版本内的能力

- 审阅基线（`baseline`）：请求带 `baseline` 会返回 `unsupported_baseline`。
- 远端文件变化事件：`open` 返回 `watchDegraded:true`，客户端按聚焦或显式刷新读取状态，不承诺轮询周期。
- 历史、分支标签、同步、stash、合并冲突、修订撤销、worktree、文件与文档、搜索、PTY：由后续任务在同一协议上补齐。
- 普通 Git RPC 没有程序或命令字段：本协议不提供任意 shell。
