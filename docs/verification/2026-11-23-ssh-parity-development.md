# 远端 SSH 候选开发验收

验证日期为 2026-11-23。Twiglane `0.3.43` 源码 `6be2aba434fef3ad0fe2562b29ef9fe24a3f1b4c`，Cliora 源码 `2765a91339d1241783c60d1f7bff481ce5ce0183`。Windows 11 专业版 x64（构建 26300）运行隔离的 Twiglane WebView 和开发版 Cliora 连接器。连接目标为 Debian 13.7 x86_64 容器和经模拟运行的 Debian 13.7 aarch64 容器，两者均通过真实 SSH、远端 Agent 和 Git 完成操作。Agent 使用一次性测试签名。

## 真实 SSH 与桌面回放

| 范围 | 实际结果 |
|---|---|
| R1 历史与文件 | Windows WebView 分别经 Twiglane 主机和 Cliora 主机簿连接 Debian ARM64。历史里的提交与远端 `git rev-parse` 一致，可查看改动文件与差异。Files 回放覆盖文件树、预览、快速打开、全文搜索、保存后读取和外部编辑冲突。见[历史截图](ssh-parity-development/history-native.png)及[文件截图](ssh-parity-development/files-cliora.png)。 |
| R2 仓库及桌面操作 | Debian x64 两条入口通过真实创建、克隆及原路径复用、项目路径扫描和确认、两种忽略范围、普通文件和仓库内符号链接的本机副本、Gitea 回环服务的单次 PR 请求、最近仓库和提交草稿重启恢复。关窗取消后 PTY 进程仍在，确认关窗后进程退出。阶段回放另覆盖首次发布、部分同步后续推、stash、合并和附属工作树操作。逐项入口、初始状态及 Git 对照见[功能核对清单](2026-11-23-ssh-parity-inventory.md)。 |
| R3 主机、工作树与任务基线 | 两种架构的冒烟测试均从直接入口读到提交，并通过 Cliora 连接器打开同一已认证账号与工作树，验证任务基线。WebView 的 Cliora 主机簿回放覆盖选主机及路径。已安装应用通过操作系统跳转并将审查结果送回原任务仍待验证。 |
| R4 失败与回执恢复 | Debian x64 两条 WebView 入口用待确认的创建操作回放。普通重连保留旧 ID 且目标目录仍未创建。明确确认新操作后，远端 `git init` 成功、桌面待确认状态清除，旧回执保持原字节。冒烟测试另外从两条入口找回真实旧版提交回执，操作类型不符时保留待确认记录。见[待确认截图](ssh-parity-development/provision-pending-native.png)。 |

原生冒烟由 [`verify-desktop-parity.mjs`](../../scripts/remote-worktree/verify-desktop-parity.mjs) 生成，[Debian x86_64（含旧回执）](ssh-parity-development/debian-x64.json)与 [Debian aarch64](ssh-parity-development/debian-arm64.json)均通过 [`verify-remote-worktree-evidence.mjs`](../../scripts/verify-remote-worktree-evidence.mjs) 检查。两份 JSON 记录下方迁移复验后的候选源码、架构、产物摘要和未测项。WebView 截图来自上文的隔离构建。

## 回归结果

| 检查 | 结果 |
|---|---|
| Twiglane `npm run check`、`npm run build` | 通过。Svelte 0 错误、0 警告。 |
| Twiglane `npm test` | 72 个测试文件，1776 项通过。 |
| Twiglane Windows `cargo test`、Clippy（`-D warnings`） | 564 项通过。Clippy 通过。真实 SSH 由上面的独立冒烟命令运行。 |
| Agent 协议套件 | Debian x86_64 77 项通过。Windows 本机 65 项通过，运行于 T7-A2，T7-A3 没有改动 Agent 或其共用 Git 生产代码。 |
| Cliora `npm run verify` | 通过。浏览器套件 1141 项通过，1 项跳过。 |
| Cliora Windows 原生专项 `remote::twiglane::` | 3 项通过。 |
| Cliora Windows 原生全量 | 1713 项通过，16 项失败，36 项忽略。失败包括工作区深链的 POSIX 路径夹具、迁移版本断言、远端事务及上传、provider 套接字 `WouldBlock`。 |
| Twiglane `npm run verify:delivery` | 退出码 1。缺少发行证据 `docs/verification/report.json`。 |

## Cliora 迁移复验

旧候选的四个测试在数据库迁移到 38 后仍断言 36。Cliora `bc0b9dc453fa71b10fc67bdbb9474e2cc7c6fdb8` 统一了这四处的版本断言，并保留回执、已有记录和重开的检查。同一 Windows 主机上运行改造前的 Cliora `0cba868d7c4bd607995ef0b77a1b9b1234253ba2`，结果为 1714 项通过、11 项失败、36 项忽略。集成修复后的全量复跑为 1718 项通过、11 项失败、36 项忽略，失败测试与改造前逐名一致。旧候选的 provider 套接字失败未复现。

首次正式收集中的 Cliora 原生命令遇到 Windows 构建文件占用。随后在集成工作树完成了上面的原生全量复跑。正式收集中的 Cliora 浏览器套件为 1139 项通过、2 项超时、1 项跳过，两个超时的测试单独串行复跑均通过。

## R5 与 R6 待验收

- 在正常分发的签名构建上逐项对照本地操作与远端结果，核对组件安装与升级、失败恢复、实际 PR/MR 及发行验证。需要签名桌面安装包、受信发布证书与组件、受控 Git 上游和平台账号。现有证据使用隔离的开发构建、测试签名和回环 Gitea 服务。Linux 与 macOS 桌面发行构建也待验收。
- 在实际安装的 Cliora 与 Twiglane 中回放有基线与无基线任务，通过操作系统深链跳转及返回，并在原任务核对「已审阅」「已提交」「已合入」和重复送达后的状态。需要已安装的双端候选及测试任务。Cliora 的全量失败仍需逐项定位和复验。
- 补齐 macOS x86_64、macOS ARM64 和 Windows OpenSSH x64 三类远端实机。Windows 需覆盖带盘符、空格与中文的路径，核对保存落盘、Git 索引和 PTY 工作目录。现有 Windows 本机 Agent 测试只覆盖组件行为。NFS 与 exFAT 的编辑回退也未实测。
