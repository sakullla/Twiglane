# 双应用当前主机同步 host-sync v1

Twiglane 与 Cliora 的双向跳转在交接仓库或审查上下文之前，先对**当前这一台主机**做一次一次性同步。同步不经过任何 SSH 连接，只在本机两套配置之间核对与迁移：配置、关联标识与密码各自的真实来源和回执都在本机。

## 0. 本版本范围（T5）

本版本只落地 **helper 级入口**与 **deep link 的 URL 解析**：

- 可执行文件的 `--host-sync-v1` 入口（`begin` / `check` / `fetch` / `settle` / `receive`）在 Tauri 初始化之前分流，桌面退出后仍可用。
- deep link 上的可选 `hostSync` 字段会被解析、校验（64 位小写十六进制）并保留在审查来源上。
- **应用内的 IPC 接收接线延后到 T6**：本版本没有 `remote_host_sync_begin` / `remote_host_sync_receive` 两条 Tauri 命令，也没有对应的 ACL/capability 登记。因此 Twiglane 桌面端在本版本**不会**发起或接收主机同步，不会改动本机主机配置与密码；跳转时只会如实提示这一点。跨端联跑请直接调用两侧 helper。

## 1. 会话

来源应用（发起跳转的一方）在桌面进程里创建会话：

```
<来源应用可执行文件> --host-sync-v1 begin <hostId>
```

成功时 stdout 只输出一行 JSON：

```json
{"protocol":1,"kind":"host-sync-v1","role":"source","sessionRef":"<64 位小写十六进制>","hostId":"...","sharedHostId":"...","configFingerprint":"<64 位小写十六进制>","configRevision":2,"expiresAt":1893456000,"ttlSeconds":120}
```

规则：

- `sessionRef` 是 32 字节随机值的十六进制形式，只用于本次跳转。deep link 只带它，不带配置、不带密码、不带主机地址。
- 会话绑定 `hostId`、begin 时的配置指纹与修订。来源主机在会话期间被修改（指纹或修订不同）时，helper 直接作废会话并返回 `session_stale`。
- TTL 120 秒；过期会话文件被删除，之后任何调用只得到 `session_expired`。
- `check` 幂等可重放，最多 8 次；`fetch` 最多 2 次（一次正常取回 + 一次部分失败后的重试）。`settle` 立即删除会话。会话不能当作长期读取主机簿或密码的入口。
- 会话文件写在应用数据目录的 `host-sync/<sessionRef>.json`，目录 0700、文件 0600，内容只有 hostId、begin 时的非秘密配置、关联 id 与计数。
- 同步不发起 SSH 连接，因此不受「远程 SSH 总开关」和逐台启停影响；`enabled` 也不参与配置指纹。

来源应用桌面退出后 helper 仍可用：`--host-sync-v1` 参数在 Tauri 初始化之前分流。helper 通过 `TWIGLANE_HOST_SYNC_DATA_DIR`（Twiglane）或 `CLIORA_HOST_SYNC_DIR`（Cliora）指向测试用目录，缺省使用与桌面相同的应用数据目录。

对端 helper 的可执行文件同样可以显式指定：Twiglane 侧读 `TWIGLANE_CLIORA_CONNECTOR`（默认找 Cliora 的安装位置），Cliora 侧读 `TWIGLANE_HOST_SYNC_HELPER`（默认找 Twiglane 的安装位置）。

## 2. check：只回事实

```
--host-sync-v1 check <sessionRef> <challenge>
```

`challenge` 是接收方每次现取的 32 字节随机值（64 位小写十六进制）。响应：

```json
{"protocol":1,"kind":"host-sync-v1","role":"source","hostId":"...","sharedHostId":"...","configFingerprint":"...","configRevision":2,"password":{"state":"available","proof":"..."},"expiresAt":1893456000}
```

- `password.state`：`available`（本机有密码且可读）、`absent`（没有保存密码）、`unavailable`（系统凭据不可读）。
- `password.proof` = HMAC-SHA256(key = 密码 UTF-8 字节, message = `"twiglane-host-sync-v1\n" + sessionRef + "\n" + challenge`) 的小写十六进制。
- 接收方用**自己本机保存的密码**算出同一证明再比较：相等即密码相同。明文密码不进入 check，未持有密码的一方无法从证明反推。

**无法读取或比较时必须报 unknown**：来源 `unavailable`、本机凭据不可读、或来源给了 `available` 但没有 proof 时，结论是 `unknown`，不能当作一致跳过。

## 3. fetch：只取真正缺的部分

```
--host-sync-v1 fetch <sessionRef> <challenge> <config|password|all>
```

```json
{"protocol":1,"kind":"host-sync-v1","role":"source","hostId":"...","sharedHostId":"...","configRevision":2,"configFingerprint":"...","config":{"displayName":"...","host":"...","port":22,"user":"...","authMethod":"password","identityFile":"/Users/me/.ssh/id_ed25519","defaultPath":"/srv/app"},"password":"...","passwordState":"available"}
```

- `config` 只含非秘密字段；私钥只传路径（`identityFile`）。不传私钥内容。
- `password` 只在 scope 含 `password` 时出现，且只经这一次私有 stdin/stdout 管道；接收方必须立即写入自己的系统凭据库，不落盘、不进日志、不回前端。
- `passwordState` 与 check 同义，另有 `not_requested`。

## 4. 接收侧：对齐、写入与回执

接收方（被跳转到的一方）按 `sessionRef` 调用来源应用 helper，并据此写入本机记录。本版本这一角色只由 helper（`--host-sync-v1 receive`）承担；桌面进程内的 IPC 入口延后到 T6，届时才由前端触发：

1. **关联**：优先用来源的 `sharedHostId` 找本机记录。找不到时，
   - 本机存在**未关联候选**（`sharedHostId` 为空）：返回 `association_required` 与候选列表，要求显式选择；**绝不按名称或地址自动合并**。
   - 本机完全没有记录：首次关联，新建一条记录（`enabled=false`，`sharedHostId` 取来源值），不触碰其他主机。
   - 来源没有 `sharedHostId`（更早的来源版本）：同样返回 `association_required`。
   - 显式选择时，若该记录已属于另一个 `sharedHostId`，返回 `association_conflict`，不覆盖。
2. **一致即结束**：配置指纹相同且密码相等（或两端都没有密码）时，不取回配置或秘密、不写记录、不推进修订，直接 `settle`。
3. **按需取回**：配置不同取 `config`，密码不同/缺失/未知取 `password`，两者都要取 `all`。
4. **写入前重新核对**：比对本地记录的修订，若检查之后被本机修改，返回 `conflict`，不静默覆盖。
5. **分别回执**：配置与密码各自一条回执。密码写入失败时保留原密码（不删除、不改写），结果是 `partial`，会话不销毁，可用原会话上下文重试；重试时已一致的字段不再改写。

响应：

```json
{"protocol":1,"kind":"host-sync-v1","role":"receiver","result":"applied","hostId":"...","sharedHostId":"...","password":"equal","receipts":[{"kind":"config","state":"saved"},{"kind":"password","state":"saved"}],"revision":2,"sessionClosed":true}
```

`result` 取值：`consistent`、`applied`、`partial`、`unknown`、`unchanged`、`association_required`、`conflict`。`receipts[].state` 取值：`unchanged`、`saved`、`failed`、`absent`、`unavailable`、`conflict`。回执里没有密码，也没有私钥内容。

`receive` 也可以直接从 helper 调用（供双端联跑与排障）：

```
--host-sync-v1 receive <来源应用可执行文件> <sessionRef> [<本机 hostId>]
```

## 5. 错误

局部错误以退出码 2 结束，stderr 只有一行 `{"error":"<code>"}`：`host_sync_request`、`session_expired`、`session_stale`、`target_unavailable`、`host_sync_busy`、`host_sync_unavailable`、`host_sync_protocol`、`host_sync_failed`、`association_conflict`。stderr 不含诊断文本、主机名或路径。

## 6. 秘密边界

- deep link（`twiglane://remote-review?...`）只新增可选字段 `hostSync`，值为会话引用，校验为 64 位小写十六进制；旧链接不带该字段仍然有效。返回事件链接不带 `hostSync`。
- 同步日志只有结构化结果与状态字符串；配置（含私钥路径）与密码都不进入日志、URL 或前端文案。
- Twiglane 的密码条目仍在系统钥匙串的 `twiglane.remote-ssh` 命名空间，与 MR/PR 令牌互不可见；同步不为 SSH 新开明文通道。
- 同步只作用于当前这一台主机及其关联元数据，不枚举、不创建、不更新、不删除其他主机。

## 7. 已知缺口

- Cliora 反向跳转的 URL 构造在 `src-tauri/src/twiglane/remote_review.rs`，加上 `hostSync` 参数需要该文件归属的 Task 配合；本协议两侧 helper 已可独立联跑。
- 真实签名桌面包上的双端跳转与人工确认流程属于 T9 的实机证据范围。
- 应用内 IPC 接收接线（`remote_host_sync_begin` / `remote_host_sync_receive` 两条命令、ACL 与 capability 登记、前端调用）延后到 T6；本版本只有 helper 级入口与 URL 解析。
