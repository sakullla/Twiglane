# Cliora 与 Twiglane 远端审查协议 v1

Cliora 从已登记的远端会话发起审查。它在该会话的 SSH 主机上读取实际 Git 工作树，绑定认证过的主机及远端目录，并保留会话开始时记录的 HEAD。Twiglane 在本机打开该工作树，通过远端 agent 读取状态和任务差异。返回时，Cliora 在原目标独立读取 Git 状态，再向原会话展示结果。

## 发起

使用 `twiglane://remote-review?v=1&...`。以下字段各出现一次。URL 最多 8192 字节，查询值按 URL 表单格式编码。

| 字段 | 值 |
|---|---|
| `reviewId`，`sessionId` | 分别是本次审查与本地工作台会话的 UUID。 |
| `targetId`，`targetRevision` | Cliora 当前保存的 SSH 主机和配置版本。 |
| `peerRevision`，`peerIdentity` | 认证后的对端版本和最终主机公钥身份，均为 64 位小写十六进制。 |
| `worktreePath` | 远端 Git 工作树根目录的规范绝对路径。 |
| `worktreeIdentity` | Twiglane agent v1 的 `repo` 身份，和远端探测计算出的目录及 Git 元数据位置绑定。 |
| `baseline` | 可选的会话起点 commit OID。没有记录起点时展示当前工作树改动。 |

缺失、重复、未知字段及身份不符会拒绝请求。Twiglane 以当前通过 SSH 验证的目标和 agent 报告的工作树身份核对来源。缺少 agent 时使用普通的安装确认。用户取消后，来源结束。

## 回执与返回

使用 `cliora://remote-review?v=1&event=...&reviewId=...&sessionId=...`。

- `opening` 表示 Twiglane 已收到请求并开始连接或等待安装确认。
- `accepted` 表示已通过主机和工作树身份检查并打开审查。
- `rejected` 带 `reason`，说明打开失败或被取消。
- `returned` 带严格递增的正整数 `resultRevision`、`outcome` 和 `worktreeState`。结果是 `reviewed` 或 `committed`，工作树状态是 `clean`、`dirty` 或 `unknown`。提交结果还须带已由原来源验证的 `headOid`。仅审阅结果可附上当前 HEAD。

Cliora 将事件匹配到原审查和会话。重复、过期和无来源的事件结束处理。对于返回结果，Cliora 根据真实远端 HEAD、工作树身份及未提交状态进行复核。冲突或无法读取时显示未确认。

本地审查继续使用 [v3 协议](twiglane-review-v3.md) 及其既有兼容规则。共享测试样例位于两仓的 `tests/fixtures/reviews/remote-protocol-v1.json`。
