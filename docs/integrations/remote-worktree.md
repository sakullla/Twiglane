# 通过 Cliora 打开远端 Git 工作树

在 Twiglane 的起始页或命令面板选择「打开远端仓库」，然后选择 Cliora 已启用的 SSH 主机并输入远端工作树的绝对路径。Twiglane 直接使用 Cliora 安装包提供的无界面连接工具，Cliora 桌面可以保持退出。连接使用 Cliora 的 SSH 配置、已信任的主机密钥、身份文件和已保存的密码。

首次打开时，Twiglane 会显示目标主机和 agent 版本。确认后，由本机通过 SSH 上传内置产物。远端登录账号需要 Python 3.8 及以上、支持引用事务的 Git，以及个人目录的写入和执行权限。重连会先核对 SSH 对端和已安装的 agent。若确认安装期间主机身份改变，需要重新打开并确认。

文件级暂存、取消暂存和提交作用于显示的远端工作树。连接在写入结束前中断时，窗口显示「结果待确认」。重连并核对该操作的远端记录期间，仍可阅读当前工作树的差异。必要时保留待确认状态，避免重发同一次提交。

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
  生成一次性 askpass 脚本（0700）与秘密文件（0600）放在本次连接的私有目录里，只回答
  `password` / `passphrase` 类提示；主机密钥的 `authenticity`、`fingerprint`、`yes/no`
  提示一律拒绝回答，因此 Twiglane 不会替用户信任新主机。

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

相关命令（前端只经这些入口，全部在 `build.rs` 与主窗口 capability 中登记）：
`remote_ssh_settings`、`set_remote_ssh_enabled`、`remote_ssh_save_target`、
`remote_ssh_delete_target`、`remote_ssh_set_password`、`remote_ssh_delete_password`、
`remote_ssh_test`、`remote_ssh_cancel`、`remote_ssh_install_agent`。

### 发行与验证

- 清单由 `scripts/remote-worktree/agent-v2-manifest.mjs` 生成：`--write <目录>` 为每个
  `<system>-<arch>/twiglane-agent-v2` 计算摘要并要求同名 `.sig` 签名；
  `--check <目录>` 只核对已有清单与文件是否一致（可用于 CI 与本地复核）。
- 本机回归：`cargo test --manifest-path src-tauri/Cargo.toml remote_ssh` 用 `ssh` 替身在临时
  HOME 下真实执行探测、上传、摘要核对和原子替换；`npm test` 覆盖设置界面与原生契约
  （`tests/remote-ssh-settings.spec.ts`、`tests/remote-ssh-native.spec.ts`）。
- 真实 SSH 双主机、弱网与签名桌面包的验收属于 T9/Delivery 的集成证据；当前仓库没有该环境，
  这一层没有被这些测试替代。

### 已知缺口

- 登录时对签名做**密码学复核**需要 `minisign-verify` 依赖（`src-tauri/Cargo.toml` 属 T1 范围，
  本 Task 不改）。当前运行时核对"清单里的签名存在且格式有效 + 产物摘要与清单一致"，签名
  本身由发行步骤用 Twiglane 更新钥匙验证。补齐该依赖后应把 `artifact::select` 的签名检查换成
  真正的 `PublicKey::verify`。
- 密码认证的 askpass 目前只在 unix 实现（`sh` 脚本 + 私有秘密文件）；Windows 桌面用密码认证
  会返回 `ssh_askpass_unavailable` 并提示改用密钥或 ssh-agent，尚未在 Windows 实机验收。
- `remote-worktree_open` 尚未切换到这个 provider（T6 负责把远端仓库接入主窗口）；当前它仍
  走 Cliora 连接器，两条路径并存。
