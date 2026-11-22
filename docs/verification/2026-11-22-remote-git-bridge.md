# 远端 Git 与主机同步：端到端取证（2026-11-22）

## 结论

- 桌面桥接命令、前端分派与远端会话优先 v2 已实现并通过独立复核（B1/B2）。
- host-sync v2 已在两端落地并互认：Twiglane `protocol: 2`，Cliora `protocol: 2`。
- **真实 SSH 主机上**：agent v2 的打开/状态/历史/分支/差异/暂存/提交与桌面侧 SSH 传输路径
  （冻结配置 → 探测 → 安装 → 会话）均已实机跑通，见「五」「六」。
- **命令层**：`remote_worktree_targets`/`open`/`status`/`diff`/`write`/`recover`/`close` 直接在真机上
  经命令函数跑通（含 `install_required` 确认分支），见「七」。v2 组件路径与 `cancel_open` 仍未覆盖。
- **仍缺**：双端跳转端到端、桌面 UI 路径、非 Linux-x86_64 目标、发行签名产物，见文末「仍未覆盖」。

## 一、host-sync 双端互认（真实二进制）

Twiglane（`~/.cache/cargo-target/debug/twiglane`，构建于 2026-11-22）：

```
$ twiglane --host-sync-v1 version
{"actions":["begin","check","fetch","settle","receive","confirm"],"app":"twiglane",
 "capabilities":["stdinArgs","confirmation"],"confirmation":{"required":"password","ttlSeconds":120},
 "kind":"host-sync-v1","protocol":2,"ttlSeconds":120}

$ twiglane --host-sync-v1 check a b
{"error":"host_sync_argv_rejected"}

$ echo '{"sessionRef":"000…0","challenge":"000…0"}' | twiglane --host-sync-v1 check
{"error":"session_expired"}        # 参数确实从 stdin 解析
```

Cliora（`~/.cache/cargo-target/debug/cliora`，cliora main @ `290dec62`）：

```
$ cliora --host-sync-v1 version
{"protocol":2,"kind":"host-sync-v1","app":"cliora","capabilities":["stdinArgs"],
 "actions":["begin","check","fetch","settle","receive"],"ttlSeconds":120}

$ cliora --host-sync-v1 check a b
{"error":"host_sync_argv_rejected"}
```

互认条件核对：双方都要求对端 `protocol >= 2` 且 capabilities 含 `stdinArgs`；
Twiglane 侧另有 `confirmation`（一次性票据门控），Cliora 侧如实不声明该能力。

## 二、代码状态

| 提交 | 内容 |
|---|---|
| `443b8e4` | review 阶段改为送达 Cliora 成功后才推进 + 远端会话优先 v2 |
| `0402e9a` | 补齐 v2 会话依赖的传输与 ssh 探测接入 |
| `c36519c` | v2 差异分页读 `totalLines` 并优先透传对端 `nextCursor` |
| `f5d40e4` | 远端历史/分支/同步/stash/合并经 op 白名单接通 |
| `89599cc` | 审查阶段、块级暂存与危险写入的真实语义 |
| `5952a62` | 远端行选入口按真实原因禁用，修正 amend 与回执归因 |

验证命令与结果（本机实跑）：

- `cargo test --manifest-path src-tauri/Cargo.toml` → 567 passed
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → exit 0
- `npm run check` → 0 errors / 0 warnings
- `npm test` → 71 files / 1718 tests passed

## 三、未验证（必须在交付说明中如实标注）

1. **真实 SSH 主机上的远端 Git 全链路**：打开、历史、分支、同步、stash、合并冲突、worktree 与审查返回。
   已由「五」（直接跑 agent 的 `--stdio`）与「六」（桌面 SSH 传输路径）部分覆盖：打开/状态/历史/
   分支/差异/暂存/提交与安装、会话握手都已在真机跑过；「七」进一步把这些能力放到命令函数层
   （`open`/`status`/`diff`/`write`/`recover`/`close`）重跑了一遍。同步、stash、合并冲突、worktree
   与审查返回仍只有 port mock 与假组件帧证据。
2. **双端跳转端到端**：helper 互调、来源应用退出后结算、Cliora 侧接收落库，需在合并后的 Cliora 上实跑；本文件只证明协议互认与实参解析。
3. **v2 组件在产品构建中的可达性**：`src-tauri/agent-v2` 为空目录，发行包必须放入 `manifest.json` 与各平台产物后才会走 v2；否则一律回退内嵌 v1（`remote_protocol_mismatch` 不会触发，因为没有产物）。
4. **远端 amend**：需要暂存区快照令牌，原生桥接未回传，界面已如实标为不可用。
5. **块级/逐行暂存**：`patch` 不在桥接白名单，界面已按真实原因禁用。
6. **worktreeRemove**：v2 只删当前打开的工作树、只收 `force`，与本机按路径删除语义不符，保持不支持。

## 四、平台

仅在本机 macOS 上验证；Windows/Linux 的构建与运行未验证。

## 五、真实主机验证（2026-11-22，补）

验证环境：`$TWIGLANE_REAL_SSH_TARGET`，Debian（内核 6.12.43 x86_64），git 2.47.3。
在该主机上按 `remote-agent/v2` 源码构建 `twiglane-agent-v2`（release，7.6 MB），
以 `--stdio` 运行并发送 v2 帧（`{v:2, id:"<string>", op:...}`），对一个真实 git 仓库执行：

| 步骤 | 结果 |
|---|---|
| `hello` | `agent: twiglane-agent/2`、`protocol: 2`、`arch: x86_64`、86 项 capabilities |
| `open` | 返回 `repo`/`root`/`generation: 1`/`stateToken`，含 `snapshot`、`events`、`watchDegraded` |
| `status` | 返回 `generation` 与 `stateToken`，快照含 head/branch/files |
| `history` | `page.commits` 两条，含 `oid`/`summary`/`labels`，最新为本次提交 `second` |
| `branchList` | `branches.branches[0]` = `main`（`current: true`）、`targetOid` = 新提交、`worktree` = 仓库路径 |
| `diff`（`view: "unstaged"`） | `totalLines: 7`、1 个 hunk、`stageable: true` |
| `stage` | `receipt.state: completed` |
| `commit` | `receipt.state: completed`；主机 `git log` 显示新提交 `second` |

结论：agent v2 在真实 Linux 主机上跑通了「打开 → 状态 → 历史 → 分支 → 差异 → 暂存 → 提交」，
并且写操作回执为 `completed`、git 侧确实产生了提交。

本节由 ssh 直接启动 agent 的 `--stdio`；桌面侧传输实现与安装流程后来在「六」里补齐。

仍未覆盖（不要据此声称端到端已完成）：

1. 桌面 UI 路径未验证：主窗口打开远端仓库、桥接命令分派、断线只读、审查返回都没有在真机上点过。
2. 主机为 x86_64 Linux；macOS/Windows 与 aarch64 目标仍未验证。
3. 该主机上的 agent 是从工作区源码临时构建的验证用产物（清单签名标 `development`），
   不是发行包里的签名产物（`src-tauri/agent-v2` 仍为空目录）。

## 六、桌面 SSH 传输路径（真实主机，2026-11-22 补测）

与「五」的区别：这次不绕开产品代码。用例调用的是 `src-tauri/src/remote_ssh` 自己的构造函数——
`Context::build`（`ssh -G` 冻结配置、私有 known_hosts 副本、`BatchMode=yes`、ControlMaster/Forwarding 全关）、
`transport::probe`、`upload_bytes` 的分块上传与回执核对、`open_session` 的 v2 会话——不是用 ssh
直接拉起 `--stdio`。

用例：`src-tauri/src/remote_ssh/live.rs::real_host_transport_path_opens_session_and_reads_history`。

| 门控变量 | 作用 |
|---|---|
| `TWIGLANE_REAL_SSH_TARGET` | `user@host[:port]`；未设置时用例打印跳过原因并 `return`，断言不执行，`cargo test` 默认全绿 |
| `TWIGLANE_REAL_SSH_REPO` | 远端 git 仓库绝对路径；缺失时只跑到握手，随后跳过并说明 |
| `TWIGLANE_AGENT_V2_DIR` | 本机 v2 产物目录（含 `manifest.json`）；远端已装兼容组件时不需要 |
| `TWIGLANE_REAL_SSH_IDENTITY` | 可选，密钥认证私钥绝对路径（缺省交给 ssh 自己选） |

### 6.1 验证用产物（不进仓库、不新增运行时依赖）

该主机是 Linux x86_64，本机没有对应产物，因此在主机上用自己的源码树外目录现编译
`remote-agent/v2`（与产品同一份 Rust 源码，只是构建机不同）：

```
# 本机
tar czf /tmp/twiglane-agent-src.tgz --exclude target remote-agent/v2 src-tauri/src
scp /tmp/twiglane-agent-src.tgz <user>@<host>:~/

# 主机上（~/twiglane-agent-build，位于源码树外）
mkdir -p ~/twiglane-agent-build && tar xzf ~/twiglane-agent-src.tgz -C ~/twiglane-agent-build
cd ~/twiglane-agent-build/remote-agent/v2 && cargo build --release
# Finished `release` profile [optimized] target(s) in 1m 41s → 7 640 136 字节

# 取回本机并生成清单（sha256 = 8f3203b9…b367a8，清单签名标 development：验证用，不是发行签名）
```

远端夹具仓库：`<repo>`（`git init -b main`，两个提交 `first` / `second`）。

### 6.2 第一次执行：远端无组件 → 走真实安装

```
$ TWIGLANE_REAL_SSH_TARGET=$TWIGLANE_REAL_SSH_TARGET \
  TWIGLANE_REAL_SSH_REPO=$TWIGLANE_REAL_SSH_REPO \
  TWIGLANE_AGENT_V2_DIR=/tmp/twiglane-agent-v2 \
  cargo test --manifest-path src-tauri/Cargo.toml real_host_transport_path -- --nocapture

[live-ssh] 探测：host=<host> system=Linux architecture=x86_64 git=Some("git version 2.47.3")
[live-ssh] 配置修订=54bd631e…0a3e32c 对端修订=feb02a68…027c203a6 对端身份=564c33be…c89a73574f
[live-ssh] 已装组件：installed=false digest=None version=None compatible=false probe=false
[live-ssh] 上传产物：version=0.3.40-dev sha256=8f3203b9…b367a8 bytes=7640136
[live-ssh] 上传进度 1966080/7640136 字节
[live-ssh] 上传进度 3932160/7640136 字节
[live-ssh] 上传进度 5898240/7640136 字节
[live-ssh] 上传进度 7640136/7640136 字节
[live-ssh] hello：protocol=2 agent=twiglane-agent/2 version=0.3.40 os=linux arch=x86_64 capabilities=86
[live-ssh] open：repo=<repo> root=<repo> name=<name>
           generation=1 stateToken=baed6ed2…1ebceefd branch=main files=0 watchDegraded=false
[live-ssh] status：generation=1 stateToken=baed6ed2…1ebceefd branch=main files=0
[live-ssh] history：commits=2 nextOffset=null 最新=257a4d7db311b694d8b83eca1167d947ec6f9a73 second
[live-ssh] 全部通过：桌面 SSH 传输路径（build → probe → install → session → history）
test result: ok. 1 passed; 0 failed; 0 ignored; 567 filtered out; finished in 1.14s
```

覆盖到的内容：`ssh -G` 冻结配置成功、私有 known_hosts 副本通过主机密钥校验、密钥认证（`BatchMode=yes`，
无交互回退）连通、`transport::probe` 解析出 system/architecture/git 与组件自述、
`upload_bytes` 分块上传 7.6 MB 后远端回执摘要与清单一致、安装后重新探测摘要与 `agent_compatible` 匹配、
`open_session` 的 `connect` 命令串核过摘要后 exec、`hello` 报 `protocol: 2`、
`open` 返回 `repo`/`root`/`generation`/`stateToken`/分支、`status` 能刷新代次与令牌、
`history.page.commits` 非空。

### 6.3 第二次执行：复用已安装组件（不重复上传）

```
[live-ssh] 已装组件：installed=true digest=Some("8f3203b9…b367a8") version=Some("0.3.40") compatible=true probe=true
[live-ssh] 复用远端已安装组件：8f3203b9…b367a8
[live-ssh] hello：protocol=2 agent=twiglane-agent/2 version=0.3.40 os=linux arch=x86_64 capabilities=86
[live-ssh] open：… generation=1 stateToken=baed6ed2…1ebceefd branch=main …
[live-ssh] history：commits=2 最新=257a4d7db311b694d8b83eca1167d947ec6f9a73 second
test result: ok. 1 passed; 0 failed; 0 ignored; 567 filtered out; finished in 0.41s
```

两次执行的对端修订与对端身份（`feb02a68…` / `564c33be…`）一致：同一份冻结配置与同一把主机密钥，
说明探测→安装→会话三条路径共用同一套身份绑定，没有被中途改写到别的主机。

### 6.4 回归

- `cargo test --manifest-path src-tauri/Cargo.toml` → 568 passed（原 567 + 新增用例 1，未设门控时走跳过分支）
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → 0 warning
- `npm run check` → 0 errors / 0 warnings
- `npm test` → 71 files / 1718 tests passed

仍未覆盖：

1. 桌面 UI 本身（主窗口打开远端仓库、桥接命令分派、断线只读、审查返回）没有在真机上点过。
2. macOS/Windows 与 aarch64 目标未验证。
3. 清单签名标 `development`：验证的是上传与执行路径，不是发行签名的可信链（`src-tauri/agent-v2` 仍为空目录）。
## 七、命令层门控测试（真实主机，2026-11-22 补）

与「六」的区别：这次调用的是 IPC 命令函数本身，不是它们内部的传输/会话函数。
用例：`src-tauri/src/remote_worktree/live.rs::real_host_command_layer_opens_reads_diffs_and_writes`。

### 7.0 动手前的研究结论

1. **命令函数能否在测试里直接调用**：可以，不需要 Tauri 的 IPC 派发，但 `State` 只能由应用实例给出。
   `remote_worktree_open` 需要 `State<Arc<RemoteWorktrees>>`、`State<Arc<Backend>>`、`State<Arc<RemoteSsh>>`
   三份状态加一个 `Channel<Progress>`（`Channel::new(|_| Ok(()))` 即可，不需要 webview）；
   `status`/`diff`/`write`/`recover`/`close` 只需要第一份。用
   `tauri::test::mock_builder().manage(...).build(mock_context(noop_assets()))` 建 mock app，再
   `app.state::<T>()` 取 `State`，三份状态的类型与 `lib.rs` `run()` 里的 `app.manage(...)` 一一对应。
   此前**没有**测试构造过 `Arc<RemoteWorktrees>` 的 `State`：`remote_worktree::tests` 直接构造
   `RemoteWorktrees`/`Session` 调内部函数；`lib.rs` 的 IPC 测试只托管过 `Arc<Backend>`。
2. **v1 内嵌 agent 路径需要什么**：不是「仅一个 `Target` 值」。`connect()` 先 `list()` 取目录，
   再按 `targetId`/`targetRevision` 选中目标，然后才 `probe`/`install`/`connect`。所以需要
   ①Cliora 连接器可执行文件（debug 下 `TWIGLANE_CLIORA_CONNECTOR` 可覆盖，见 `remote_worktree.rs` 的
   `connector()`）②Cliora 的目标存储里真有这台主机。目标存储是 Cliora 自己的库，
   `CLIORA_TWIGLANE_TEST_DB` 只有在 **Cliora 开发构建**中才被读取
   （`cliora/src-tauri/src/remote/twiglane.rs`），发行版固定读安装库 —— 因此本用例要求连接器指向
   开发构建，并在临时目录合成一份最小目标库。
3. **v2 路径的最小夹具**：本机要有 v2 产物清单（`TWIGLANE_AGENT_V2_DIR` 或资源目录 `agent-v2`），
   且自有主机簿里有一条 `shared_host_id` 等于该 Cliora `targetId` 的启用目标（`remote_ssh::shared_target`
   按 `shared_host_id` 匹配、并要求 `remote_ssh_enabled`），此外**仍然**需要 Cliora 目标本身。
   本轮 `src-tauri/agent-v2` 是空目录，`select_provider` 一律回退内嵌 v1，所以 v2 未覆盖（见 7.3）。

### 7.1 夹具与门控

| 项 | 内容 |
|---|---|
| `TWIGLANE_REAL_SSH_TARGET` | `user@host[:port]`；未设置即打印原因并 `return`，`cargo test` 默认全绿 |
| `TWIGLANE_REAL_SSH_REPO` | 远端 git 仓库绝对路径 |
| `TWIGLANE_CLIORA_CONNECTOR` | Cliora **开发构建**绝对路径（发行版不读 `CLIORA_TWIGLANE_TEST_DB`） |
| `TWIGLANE_REAL_SSH_IDENTITY` | 可选，写进合成目标库的私钥路径 |
| 前置改动 | 用例用本机 `ssh` 给远端仓库第一个已跟踪文件追加一行（产生 unstaged 差异），结束 `reset` + `checkout` 复原；桥接白名单没有「写文件」op，这段只准备变更，不算命令层覆盖 |
| 合成目标库 | `sqlite3` 写入临时库：`app_settings` + `remote_targets` 两表，结构与 `scripts/remote-worktree/verify-live.py` 验证过的一致；不触碰用户自己的 Cliora 库 |

### 7.2 实际输出（真实主机 Linux x86_64）

第一次（远端已装内嵌组件，复用）：

```
$ TWIGLANE_REAL_SSH_TARGET=$TWIGLANE_REAL_SSH_TARGET \
  TWIGLANE_REAL_SSH_REPO=$TWIGLANE_REAL_SSH_REPO \
  TWIGLANE_CLIORA_CONNECTOR=~/.cache/cargo-target/debug/cliora \
  cargo test --manifest-path src-tauri/Cargo.toml real_host_command_layer -- --nocapture

[live-command] 远端仓库：<repo>
[live-command] 夹具改动：note.txt 追加一行（twiglane command layer probe 98abdf20-…）
[live-command] 目标：live-command-target b6218a8b… host=<host> user=<user>
[live-command] open：session=887d7485-… repo=9d8fc0a3… head=257a4d7d… branch="main" files=1
[live-command] status：generation=cbb08692… note.txt xy=" M"
[live-command] diff：181 字节 unified，hunksStageable=false
[live-command] stage：operationId="45e1f45c-…" state="completed" 之后 note.txt xy="M "
[live-command] recover："unknown"
[live-command] 全部通过：命令层 targets → open → status → diff → write → recover → close
test result: ok. 1 passed; 0 failed; 0 ignored; 568 filtered out; finished in 1.81s
```

第二次（把远端 `~/.local/share/twiglane` 挪开，逼出安装分支）：

```
[live-command] 远端没有兼容的内嵌组件：version="v1" size=33303，按确认回执重试
[live-command] open：session=f62906bc-… repo=9d8fc0a3… head=257a4d7d… branch="main" files=1
[live-command] status：generation=de306802… note.txt xy=" M"
[live-command] diff：181 字节 unified，hunksStageable=false
[live-command] stage：operationId="c2698eba-…" state="completed" 之后 note.txt xy="M "
[live-command] recover："unknown"
test result: ok. 1 passed; 0 failed; 0 ignored; 568 filtered out; finished in 2.82s
```

两次跑完远端仓库 `git status --porcelain` 为空、`~/.local/share/twiglane/agent` 仍在：夹具复原，
安装是可重复的。

### 7.3 命令层覆盖了什么 / 没覆盖什么

覆盖（真机、走命令函数）：

- `remote_worktree_targets`：合成目标库里的目标被 `list` 读出，`targetId`/`targetRevision` 交给 `open`。
- `remote_worktree_open`：`install_required` → 带 `confirmationId` 重试 → `kind: open`；断言
  `protocol: 1`、`agentVersion: "v1"`（本机无 v2 产物）、`snapshot.repo/head/generation` 齐全。
- `remote_worktree_status`：`generation` 刷新，`files` 里就是被追加的那一行，`xy` 为 `" M"`。
- `remote_worktree_diff`：`data` 解出 181 字节 unified 文本，含夹具那一行与 `@@` hunk；
  `hunksStageable: false` 且带原因（v1 无 `patch` 能力）。
- `remote_worktree_write`（`WriteKind::Stage`）：`state: completed`、`operationId` 原样回执，
  随后 `status` 的 `xy` 变成 `"M "` —— 回执与状态一致。
- `remote_worktree_recover`：没有待确认记录时返回 `state: unknown`，不谎称完成。
- `remote_worktree_close`：关闭后同一条 `status` 报 `remote_disconnected`。

未覆盖（原因）：

1. **v2 组件路径**：本机 `src-tauri/agent-v2` 为空目录，`select_provider` 只能回退内嵌 v1；
   要覆盖需要先放入 v2 清单+产物，并在自有主机簿里加一条 `shared_host_id` 等于 Cliora `targetId` 的目标。
2. **`remote_worktree_cancel_open`**：要在 `open` 进行中并发触发才有意义，且函数无返回值；
   本轮没有做并发编排，仍属未覆盖。
3. **`remote_worktree_call`（op 白名单桥接）**：不在本次范围，仍只有假组件帧证据（见「三」）。
4. **安装失败/被拒分支**：只覆盖了成功安装；`target_changed`（确认已失效）等分支仍靠既有单测的
   替身连接器覆盖。
5. **断线、只读降级、并发写入串行化**：未在真机上制造，仍属未覆盖。
6. **门控用例的运行约束**：`CLIORA_TWIGLANE_TEST_DB` 是进程级环境变量，应与
   `remote_worktree::review` 里设置 `TWIGLANE_CLIORA_CONNECTOR` 的用例分开跑（按用例名过滤执行）；
   另需本机有 `sqlite3` 与 Cliora 开发构建。发行版 Cliora 无法用于本用例。

### 7.4 回归

- `cargo test --manifest-path src-tauri/Cargo.toml` → 580 passed（未设门控时走跳过分支）
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → 0 warning
- `npm run check` → 0 errors / 0 warnings
- `npm test` → 71 files / 1718 tests passed
- 提交前自查：在 src / src-tauri / docs 下检索「192.168 开头形式的私有网段地址」与「root 紧跟 @ 的账号串」应无命中（本行故意不写出可直接命中的字面量，否则自查会命中自己）；主机、用户名、端口只经运行时环境变量传入，文档一律用 `<target>` / `<repo>` 占位