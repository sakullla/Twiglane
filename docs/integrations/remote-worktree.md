# 通过 Cliora 打开远端 Git 工作树

在 Twiglane 的起始页或命令面板选择「打开远端仓库」，然后选择 Cliora 已启用的 SSH 主机并输入远端工作树的绝对路径。Twiglane 直接使用 Cliora 安装包提供的无界面连接工具，Cliora 桌面可以保持退出。连接使用 Cliora 的 SSH 配置、已信任的主机密钥、身份文件和已保存的密码。

首次打开时，Twiglane 会显示目标主机和 agent 版本。确认后，由本机通过 SSH 上传内置产物。远端登录账号需要 Python 3.8 及以上、支持引用事务的 Git，以及个人目录的写入和执行权限。重连会先核对 SSH 对端和已安装的 agent。若确认安装期间主机身份改变，需要重新打开并确认。

文件级暂存、取消暂存和提交作用于显示的远端工作树。连接在写入结束前中断时，主窗口显示「结果待确认」。重新打开同一个远端仓库时只核对原操作的回执，期间仍可阅读已读内容；必要时保留待确认状态，避免重发同一次提交。

## 主窗口接入（T6）

远端仓库不再有独立弹层：选择主机与远端路径后，仓库在现有主窗口打开，与本机仓库共用同一套
`OpenedRepository` / `StatusSnapshot` / `DiffResponse`。

- 仓库键是 `ssh://<hostId>/<远端绝对路径>`，不含显示名、连接会话或秘密；最近记录、草稿、
  选择与审阅进度都按这个键隔离。两台主机的同名路径是两个仓库，切换后旧连接的响应不会被贴到新仓库上。
- 远端状态读取失败（断线、超时、认证失败）后该仓库转为只读：已读内容保留，写入与新的读取都不再发送，
  直到重新打开。
- 远端写入按操作 ID 记录：明确未生效的失败会清掉待确认记录；未收到回执一律按「结果未知」处理，
  不重发、不冒充失败。
- Cliora 远端审查来源同样在主窗口打开：主机、远端工作树与基线按来源绑定校验，安装仍需用户确认；
  「返回 Cliora」只发送真实结果，阶段按这次会话里**被原生审查账本登记的提交**声明：只有走
  write 通道的 commit 会 `record_commit`，因此 `committed` 只由提交产生。
- 远端合入（`mergeComplete`）经桥接执行，原生不会为它记合入提交，审查账本里永远没有那个
  提交：桌面不再把它记成 `merged`。这种情况（以及修订、拣选、还原带来的新提交）返回时按
  `reviewed` 送出，并在界面写明「远端合入未记录提交，无法作为 merged 送回 Cliora」。
- 返回结果的冲突只在一种情况下说成「已经送回」：这次会话自己成功送过不早于当前阶段的阶段。
  其余的 `conflict`（阶段被别处推进、审查账本里没有记录提交）原样显示后端原因，不伪装成幂等。
- 本机草稿库只按本机仓库路径保存，远端仓库的提交说明草稿存在会话内存里、按仓库键分开：
  切到别的仓库再回来仍是原来那份，但进程重启后不会出现。最近记录同理。应用内 host-sync
  接收接线仍未接入。

### 会话优先 v2，三条必须知道的事实

1. **发行包必须带 `agent-v2` 产物，否则回退 v1。** 选组件时先看本机资源目录里有没有匹配
   目标平台的可执行文件；没有（空仓库、未跑 `scripts/remote-worktree/agent-v2-manifest.mjs`
   的构建）就静默用内嵌的 v1 组件，界面行为不变，但没有 v2 的按块暂存能力、数值 generation
   与 `stateToken`。这不是失败路径，只是能力更低的一条路。
2. **带 `reviewId` 或 `baseline` 的打开强制走 v1。** 审查来源与任务基线只有 v1 组件支持，
   所以这条会话即使本机有 v2 产物也不会用 v2；它的写入令牌是字符串 generation，没有
   `stateToken`。
3. **v2 差异是分页游标读取的。** 远端给出 `nextCursor`，桌面把整份差异续读完后一次解析；
   跨页被切开的 UTF-8 字节在拼接后才解码，游标只在本机内部使用（`v2:<行偏移>`），不暴露给界面。
   续读达到页数上限时明确标为截断，不当成完整差异。

### 远端桥接：op 白名单

主窗口的历史、分支标签、同步、stash、合并冲突、撤销与 worktree 都经同一条命令
`remote_worktree_call(sessionId, op, fields, generation)`，op 必须在白名单里：

- 只读：`history`、`fileHistory`、`commitDetail`、`commitDiff`、`compare`、
  `commitBranches`、`compareFileDiff`、`branchList`、`branchState`、`branchTracking`、
  `tagState`、`tagRemoteState`、`remoteState`、`stashState`、`mergePreview`、
  `mergeSession`、`conflictView`、`worktrees`。
- 写入：`branchCreate/Switch/Rename/Delete/Track/Update/Publish`、`tagCreate/Delete/Push`、
  `remoteAdd`、`remoteSetUrl`、`fetch`、`pull`、`push`、`pushToRemote`、`publishBranch`、
  `stashSave/Apply/Delete`、`mergeStart/Complete/Abort`、`resolveConflict`、`cherryPick`、
  `revert`、`undoCommit`、`checkoutCommit`、`amendCommit`、`discard`、`worktreeRemove`。

规则与边界：

- 未列入白名单的 op 一律返回 `remote_unsupported`，远端不执行、也不会转到本机 Git。
- 参数里出现 `program`、`command`、`shell`、`cwd`、`env`、`args` 直接
  `invalid_request`：桥接不引入任何任意执行面。
- 只读 op 的 result 就是桌面的同名 DTO（`page`、`commit`、`diff`、`branches`、
  `branchState`、`tags`、`remote`、`stash`、`preview`、`merge`、`conflict`）；
  写入 op 只回「有没有生效」与新状态，因此前端再用一次只读 op 拼出与本机同名方法相同的
  DTO，由重新读取得到的字段在 `note` 里说明来源，不把没读到的证据写成成功。
- 危险写入（`discard`、`cherryPick`、`revert`、`undoCommit`、`amendCommit`）沿用本机的
  确认语义：预览/取消一律不发送写入，确认只发送一次写入，随后按「回执 + 一次只读 op」
  （`commitDetail` 或回执自带的新状态）组成 DTO。回执里确实没有的证据——实际创建了几个
  提交、跳过了哪些、暂存区快照令牌——在 `note` 里如实说明读不到，不猜一个数字冒充。
- v2 写入必须带最新 `stateToken`（由原生桥接从最近一次 status/diff 刷新里取），前端只按
  数值 generation 判断新旧；generation 只在能解析成 u64 时才发给 v2 远端。
- 同一 `operationId` 已完成时重放只回原回执，客户端应重读状态而不是把响应当成完整结果。
- 远端 diff 里载荷给的 `hunksStageable` **不能**当成桌面能按块写入的证据：桥接白名单里
  没有 patch 写入，`stageHunks` / `stageLines` 对远端恒为 `remote_unsupported`。桌面因此
  一律按「不可按块/逐行暂存」解析，并把原因交给界面（远端自己给了 `hunksStageableReason`
  就原样带上，没有就给「远端暂不支持块级/逐行暂存」）；块级按钮保持禁用，不再显示一个
  按不动的入口。二进制差异即使标了也不给按块写入。

**仍然不可用的入口**（命令面板同步隐藏，直接调用返回 `remote_unsupported` 并说明原因）：

| 入口 | 原因 |
|---|---|
| 文件视图、文件搜索、在文件管理器里显示 | 依赖本机文件系统，远端没有对应桥接 op |
| 任务范围 / 发布任务 | `task_review` 计划器在本机，远端还没有同名 op |
| 关联上游、修改上游、获取全部分支、删除远程分支 | v2 有这些 op，但还没列入桥接白名单 |
| 提交并推送 | 桥接按 op 分开执行，没有一次回两段结果的 op |
| 终端 | 远端 PTY 是另一组会话 op，本版本未接 |
| 按块 / 逐行暂存 | patch 写入不在桥接白名单里，桌面发不出块级/逐行写入（只能整文件暂存） |
| 修订最近提交的「确认」 | 预览与取消可用；确认需要暂存区快照令牌，而它只由远端写锁内算出，只读桥接读不到，因此不会发出一次注定被拒的写 |
| 删除工作区 | 远端 `worktreeRemove` 只删「当前打开的那棵工作树」，不接受 `path`；这条命令还要返回本机最近列表 |
| 工作区总览（仓库切换器） | 只枚举本机最近路径与 `git worktree` 元数据；远端 `worktrees` op 还没有接进这块界面 |

## 发行与联调

发行构建把 agent 及其摘要签名嵌入 Twiglane。签名由发行流程使用现有更新密钥生成，Cliora 的连接工具在传输前验证，运行前再次核对远端文件。兼容已安装版本的连接可以复用该版本的验证信息。

开发构建可以通过 `TWIGLANE_CLIORA_CONNECTOR` 指向兄弟 Cliora checkout 的本机构建。Cliora 的开发连接工具只接受当前兄弟 Twiglane checkout 中字节匹配的未签名 agent。`CLIORA_TWIGLANE_TEST_DB` 可指向隔离的测试配置库。两个环境变量只用于开发联调。

- [Twiglane agent v1 协议](remote-agent-v1.md)

## Twiglane 自有 SSH 主机簿（不经 Cliora）

设置里的「远程 SSH」是 Twiglane 自己的主机簿，缺省关闭。关闭时任何路径都不建立新的 SSH
连接：主机记录、已保存的密码和已经打开的活动会话都保留，只是不再新建连接。

主机记录字段与 Cliora 的 `RemoteTarget` 对齐：`displayName`、`host`、`port`、`user`、
`authMethod`（`key` / `password` / `agent`）、`identityFile`、`sshConfig`、`defaultPath`、
`enabled`、`sharedHostId`、`revision`。密码不进入 `state.json`：它保存在独立的系统钥匙串
命名空间 `twiglane.remote-ssh`，与 MR/PR 令牌的 `twiglane.change-request` 互不可见。
列表接口只返回每台主机的 `hasPassword` 布尔值，删除主机时一并清理该条目。

`revision` 是单调配置修订，只有连接身份字段（host/port/user/authMethod/identityFile/sshConfig/
enabled）变化才推进；仅改显示名或默认目录不推进，因此"改名"不会要求重新确认。

### 连接身份由 `ssh -G` 快照决定

原生直接调用 OpenSSH，沿用 Cliora 已实机验证的规则：

- 每次操作先用 `ssh -G` 解析该主机的有效配置（Host/Match/Include、ProxyJump 跳板），把结果
  冻结成一份私有配置，连接只消费这份快照；别名或 include 的文件在选择之后被改动，不会把
  上传或会话换到另一台主机。
- `userknownhostsfile`、`globalknownhostsfile` 与 `revokedhostkeys` 的内容被复制进本次连接的
  私有目录并计入修订；文件内容变化就是信任变化。自定义 `KnownHostsCommand` 不被使用，
  因为它的输出无法冻结。
- 冻结配置固定 `StrictHostKeyChecking yes`、`UpdateHostKeys no`、`ControlMaster no`、
  `ClearAllForwardings yes`、`ForwardAgent no`、`PermitLocalCommand no`。新主机密钥不会
  被自动接受：失败返回 `ssh_host_key_untrusted`，请先在系统 known_hosts 中确认该主机。
- 探测用 `ssh -v` 记录本次实际出示的主机密钥，得到 `peerIdentity`（对端身份）与
  `peerRevision`（配置修订 + 对端密钥）。只改信任文件时 `peerRevision` 变、`peerIdentity`
  不变，与"同一台主机、不同信任材料"一致。
- 密钥与 ssh-agent 认证使用 `BatchMode=yes`，没有已保存密码时不会退回交互提示。密码认证
  生成一次性 askpass 脚本（0700）与秘密文件（0600）放在本次连接的私有目录里，只有提示文本
  既出现 `password` / `passphrase`、又出现该目标主机名（`host` 或 `user@host`）时才作答。
  ProxyJump 跳板机的密码提示（例如 `deploy@jump.example.com's password:`）里没有目标主机名，
  因此拿到的是拒绝而不是目标主机的密码；目标主机名只经 `TWIGLANE_SSH_ASKPASS_HOST` 传给脚本，
  `HostName` / `CanonicalizeHostname` 把名字改写成与所填主机不一致时同样拒绝（宁可失败也不外泄）。
  密钥口令提示（`Enter passphrase for key '...'`）里没有目标主机名，因此也会被拒绝：
  askpass 只在密码认证时安装，绝不会把登录密码当作私钥口令交出去。
  主机密钥的 `authenticity`、`fingerprint`、`yes/no` 提示一律拒绝回答，因此 Twiglane
  不会替用户信任新主机。

### 远端组件 v2 的安装

v2 产物是原生二进制，必须按目标 `system`/`architecture` 选择，不能在本机临时编译一份推上去。
发行包在资源目录 `agent-v2/` 提供 `manifest.json`：

```json
{
  "format": 1,
  "artifacts": [
    {
      "system": "Linux",
      "architecture": "x86_64",
      "version": "0.3.40",
      "file": "linux-x86_64/twiglane-agent-v2",
      "sha256": "<64 位小写十六进制>",
      "signature": "<minisign 签名文本>"
    }
  ]
}
```

- 探测得到目标 `uname -s`/`uname -m` 后归一化（`amd64`/`x86_64`、`arm64`/`aarch64`），
  只接受 Linux 与 macOS 的这两种架构。没有匹配项时返回 `agent_artifact_unavailable`，
  **在任何远端写入之前**失败，不下载也不本机编译替代品。
- 清单缺失或格式无效返回 `agent_artifact_manifest`；产物摘要与清单不一致返回
  `agent_digest_mismatch`；签名为空返回 `agent_artifact_signature`。
- 已安装且 `--probe` 握手成功（协议 2、os/arch 与目标一致）的组件直接复用，不重复传输。
  否则需要用户显式确认：第一次调用只返回 `{kind:"install_required", confirmationId, version,
  size, sha256}`，确认后第二次调用才上传。
- 上传把字节写进标准输入；远端脚本写入 `~/.local/share/twiglane/agent/v2/.incoming.$$`，
  核对 SHA-256 后才 `mv -f` 原子替换。摘要不符、上传不完整或目录对其他用户可写时保留原组件
  并返回明确错误。取消安装会终止本机拥有的 SSH 进程树。
- 安装路径与 v1 的 `agent/v1` 不重叠，两者可以同时存在。

相关命令（前端只经这些入口，共 9 条，同一份清单出现在三处，任一处缺失都会被测试或构建拦下）：
`remote_ssh_settings`、`set_remote_ssh_enabled`、`remote_ssh_save_target`、
`remote_ssh_delete_target`、`remote_ssh_set_password`、`remote_ssh_delete_password`、
`remote_ssh_test`、`remote_ssh_cancel`、`remote_ssh_install_agent`。

- `src-tauri/build.rs` 的 `tauri_build::Attributes::app_manifest().commands(..)` 逐条登记这 9 个
  命令；漏登记时生成的应用清单与 `generate_handler!` 不匹配，构建即失败。
- `src-tauri/capabilities/default.json` 为每个命令给出对应的 `allow-remote-ssh-*` 等最小 ACL
  条目；`src-tauri/src/security.rs` 的 `capabilities_grant_only_explicit_terminal_ipc_not_a_generic_shell`
  断言 capability 集合与这份白名单逐一相等，多一条或漏一条都会让 `cargo test` 失败。

### 发行与验证

- 安装路径可达靠 `src-tauri/tauri.conf.json` 的 `bundle.resources`：`"agent-v2/": "agent-v2/"`
  把该目录整棵打进安装包的资源目录，运行时 `RemoteSsh::artifacts_for` 读
  `resource_dir()/agent-v2`（开发/测试可用 `TWIGLANE_AGENT_V2_DIR` 显式指定）。
- 发行步骤：先在 `src-tauri/agent-v2/` 放好各平台 `twiglane-agent-v2` 与生成的
  `manifest.json`（含同名 `.sig` 签名），再执行 `npm run tauri build`；打包时目录里有
  什么就收录什么。
- 仓库里通常没有这些产物，而 tauri-build 遇到不存在的资源路径会让构建直接失败，因此
  `build.rs` 的 `ensure_agent_bundle_dir` 会先保证该目录存在（并在为空时打印
  `cargo:warning`）。于是空仓库照样能 `cargo check` / `cargo test` / `npm run tauri build`，
  只是装出来的包不带远端组件：此时运行时会返回 `agent_artifact_manifest`（清单读不到），
  提示重新安装 Twiglane，而不会上传任何文件。
- 清单由 `scripts/remote-worktree/agent-v2-manifest.mjs` 生成：`--write <目录>` 为每个
  `<system>-<arch>/twiglane-agent-v2` 计算摘要并要求同名 `.sig` 签名；
  `--check <目录>` 只核对已有清单与文件是否一致（可用于 CI 与本地复核）。
- 本机回归：`cargo test --manifest-path src-tauri/Cargo.toml remote_ssh` 用 `ssh` 替身在临时
  HOME 下真实执行探测、上传、摘要核对和原子替换；`npm test` 覆盖设置界面与原生契约
  （`tests/remote-ssh-settings.spec.ts`、`tests/remote-ssh-native.spec.ts`）。
- 真实 SSH 双主机、弱网与已签名安装包的验收属于 T9/Delivery 的集成证据；当前仓库没有该环境，
  这一层没有被这些测试替代。

### 已知缺口

- 签名字段目前**只做存在性检查**：`artifact::select` 要求 `signature` 非空且长度不超过
  4096 字节，不解码 minisign 结构，也不做任何密码学验签。安装前唯一的完整性保证是清单里的
  `sha256` 与产物实际摘要逐字节比对（不一致返回 `agent_digest_mismatch`），以及清单由发行步骤
  用 Twiglane 更新钥匙签名这件事本身。要真正做到运行时可验证，需要 `minisign-verify` 依赖
  （`src-tauri/Cargo.toml` 属 T1 范围，本 Task 不改），补齐后应把这里的长度检查换成
  真正的 `PublicKey::verify`，并对 `--app-version` 绑定做校验。
- 密码认证的 askpass 目前只在 unix 实现（`sh` 脚本 + 私有秘密文件）；Windows 桌面用密码认证
  会返回 `ssh_askpass_unavailable` 并提示改用密钥或 ssh-agent，尚未在 Windows 实机验收。
- `remote-worktree_open` 尚未切换到这个 provider（T6 负责把远端仓库接入主窗口）；当前它仍
  走 Cliora 连接器，两条路径并存。
