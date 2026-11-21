# 通过 Cliora 打开远端 Git 工作树

在 Twiglane 的起始页或命令面板选择「打开远端仓库」，然后选择 Cliora 已启用的 SSH 主机并输入远端工作树的绝对路径。Twiglane 直接使用 Cliora 安装包提供的无界面连接工具，Cliora 桌面可以保持退出。连接使用 Cliora 的 SSH 配置、已信任的主机密钥、身份文件和已保存的密码。

首次打开时，Twiglane 会显示目标主机和 agent 版本。确认后，由本机通过 SSH 上传内置产物。远端登录账号需要 Python 3.8 及以上、支持引用事务的 Git，以及个人目录的写入和执行权限。重连会先核对 SSH 对端和已安装的 agent。若确认安装期间主机身份改变，需要重新打开并确认。

文件级暂存、取消暂存和提交作用于显示的远端工作树。连接在写入结束前中断时，窗口显示「结果待确认」。重连并核对该操作的远端记录期间，仍可阅读当前工作树的差异。必要时保留待确认状态，避免重发同一次提交。

## 发行与联调

发行构建把 agent 及其摘要签名嵌入 Twiglane。签名由发行流程使用现有更新密钥生成，Cliora 的连接工具在传输前验证，运行前再次核对远端文件。兼容已安装版本的连接可以复用该版本的验证信息。

开发构建可以通过 `TWIGLANE_CLIORA_CONNECTOR` 指向兄弟 Cliora checkout 的本机构建。Cliora 的开发连接工具只接受当前兄弟 Twiglane checkout 中字节匹配的未签名 agent。`CLIORA_TWIGLANE_TEST_DB` 可指向隔离的测试配置库。两个环境变量只用于开发联调。

- [Twiglane agent v1 协议](remote-agent-v1.md)
