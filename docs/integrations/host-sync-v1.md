# 双应用当前主机同步 host-sync v1

Twiglane 与 Cliora 的双向跳转在交接仓库或审查上下文之前，先对**当前这一台主机**做一次一次性同步。同步不经过任何 SSH 连接，只在本机两套配置之间核对与迁移：配置、关联标识与密码各自的真实来源和回执都在本机。

## 0. 本版本范围（T5）

本版本只落地 **helper 级入口**与 **deep link 的 URL 解析**：

- 可执行文件的 `--host-sync-v1` 入口（`version` / `begin` / `check` / `fetch` / `settle` / `receive` / `confirm`）在 Tauri 初始化之前分流，桌面退出后仍可用。
- `confirm` 是本版本的确认入口：只有它（以及 T6 之后的 UI 按钮）能写一次性确认票据，非 TTY 一律拒绝。
- deep link 上的可选 `hostSync` 字段会被解析、校验（64 位小写十六进制）并保留在审查来源上。
- **应用内的 IPC 接收接线延后到 T6**：本版本没有 `remote_host_sync_begin` / `remote_host_sync_receive` 两条 Tauri 命令，也没有对应的 ACL/capability 登记。因此 Twiglane 桌面端在本版本**不会**发起或接收主机同步，不会改动本机主机配置与密码；跳转时只会如实提示这一点。跨端联跑请直接调用两侧 helper。

## 1. 会话

**协议版本 2，两种调用形态都接受。** 调用方必须先读对端 `version`，再决定传参方式：

```
<对端可执行文件> --host-sync-v1 version
{"protocol":2,"kind":"host-sync-v1","app":"twiglane","capabilities":["stdinArgs","legacyArgv","confirmation"],"actions":["begin","check","fetch","settle","receive","confirm"],"ttlSeconds":120,"confirmation":{"required":"password","ttlSeconds":120}}
```

- 对端 `capabilities` 里有 `stdinArgs` → 用 **stdin 形态**（v2）：argv 只放动作名（`receive` 另加
  对端程序路径），会话引用与主机标识从 stdin 读一行参数（首选一行 JSON，也接受同样的定位纯文本字段）。
- 对端没有 `stdinArgs`，或 `version` 根本不返回能力 → 用 **旧 argv 形态**（v1）：动作名与参数都在
  argv。已发布的 Cliora v0.4.168 的 helper 只按 argv 位置解析参数，并且它 spawn 对端时 stdin 是
  `Stdio::null()`，所以对它写 stdin 只会得到 broken pipe——这是与它互通的唯一方式。
- 两种形态解析出同一套动作参数；argv 位置对不上（多一个或少一个参数）一律 `host_sync_argv_rejected`，
  不会被悄悄忽略。

stdin 形态（v2）：

```
echo '{"hostId":"<hostId>"}' | <来源应用可执行文件> --host-sync-v1 begin
```

旧 argv 形态（v1）：

```
<来源应用可执行文件> --host-sync-v1 begin <hostId>
<来源应用可执行文件> --host-sync-v1 check <sessionRef> <challenge>
<来源应用可执行文件> --host-sync-v1 fetch <sessionRef> <challenge> config|password|all
<来源应用可执行文件> --host-sync-v1 settle <sessionRef>
```

**代价与边界**：argv 形态下 `ps`、进程审计与崩溃报告能看到本次会话引用与主机标识（配置层面的
可见性）。**密码不受影响**：无论哪种形态，password scope 都必须持有一次性确认票据（第 3.1 节），
argv 形态没有票据同样返回 `sync_confirmation_required`，因此 argv 可观测性最多泄漏配置，不泄漏密码。

来源应用（发起跳转的一方）在桌面进程里创建会话。成功时 stdout 只输出一行 JSON：

```json
{"protocol":2,"kind":"host-sync-v1","role":"source","sessionRef":"<64 位小写十六进制>","hostId":"...","sharedHostId":"...","configFingerprint":"<64 位小写十六进制>","configRevision":2,"expiresAt":1893456000,"ttlSeconds":120}
```

规则：

- `sessionRef` 是 32 字节随机值的十六进制形式，只用于本次跳转。deep link 只带它，不带配置、不带密码、不带主机地址。
- 会话绑定 `hostId`、begin 时的配置指纹与修订。来源主机在会话期间被修改（指纹或修订不同）时，helper 直接作废会话并返回 `session_stale`。
- TTL 120 秒；过期会话文件被删除，之后任何调用只得到 `session_expired`。
- `check` 幂等可重放，最多 8 次；`fetch` 最多 2 次（一次正常取回 + 一次部分失败或确认后的重试）。
  被 `sync_confirmation_required` 拒掉的那一趟没有读取任何秘密，**不计入**配额。`settle` 立即删除会话。
  会话不能当作长期读取主机簿或密码的入口。
- 会话文件写在应用数据目录的 `host-sync/<sessionRef>.json`，目录 0700、文件 0600，内容只有 hostId、begin 时的非秘密配置、关联 id 与计数。
- 同步不发起 SSH 连接，因此不受「远程 SSH 总开关」和逐台启停影响；`enabled` 也不参与配置指纹。

来源应用桌面退出后 helper 仍可用：`--host-sync-v1` 参数在 Tauri 初始化之前分流。helper 通过 `TWIGLANE_HOST_SYNC_DATA_DIR`（Twiglane）或 `CLIORA_HOST_SYNC_DIR`（Cliora）指向测试用目录，缺省使用与桌面相同的应用数据目录。

对端 helper 的可执行文件同样可以显式指定：Twiglane 侧读 `TWIGLANE_CLIORA_CONNECTOR`（默认找 Cliora 的安装位置），Cliora 侧读 `TWIGLANE_HOST_SYNC_HELPER`（默认找 Twiglane 的安装位置）。

## 2. check：只回事实

```
echo '{"sessionRef":"<sessionRef>","challenge":"<challenge>"}' | <来源应用可执行文件> --host-sync-v1 check
```

`challenge` 是接收方每次现取的 32 字节随机值（64 位小写十六进制）。响应：

```json
{"protocol":2,"kind":"host-sync-v1","role":"source","hostId":"...","sharedHostId":"...","configFingerprint":"...","configRevision":2,"password":{"state":"available","proof":"..."},"expiresAt":1893456000}
```

- `password.state`：`available`（本机有密码且可读）、`absent`（没有保存密码）、`unavailable`（系统凭据不可读）。
- `password.proof` = HMAC-SHA256(key = 密码 UTF-8 字节, message = `"twiglane-host-sync-v1\n" + sessionRef + "\n" + challenge`) 的小写十六进制。
- 接收方用**自己本机保存的密码**算出同一证明再比较：相等即密码相同。明文密码不进入 check，未持有密码的一方无法从证明反推。

**无法读取或比较时必须报 unknown**：来源 `unavailable`、本机凭据不可读、或来源给了 `available` 但没有 proof 时，结论是 `unknown`，不能当作一致跳过。

## 3. fetch：只取真正缺的部分

```
echo '{"sessionRef":"<sessionRef>","challenge":"<challenge>","scope":"config|password|all"}' \
  | <来源应用可执行文件> --host-sync-v1 fetch
```

scope 含 `password` 时还必须持有一张一次性确认票据（见第 3.1 节）。

```json
{"protocol":2,"kind":"host-sync-v1","role":"source","hostId":"...","sharedHostId":"...","configRevision":2,"configFingerprint":"...","config":{"displayName":"...","host":"...","port":22,"user":"...","authMethod":"password","identityFile":"/Users/me/.ssh/id_ed25519","defaultPath":"/srv/app"},"password":"...","passwordState":"available"}
```

- `config` 只含非秘密字段；私钥只传路径（`identityFile`）。不传私钥内容。
- `password` 只在 scope 含 `password` 时出现，且只经这一次私有 stdin/stdout 管道；接收方必须立即写入自己的系统凭据库，不落盘、不进日志、不回前端。
- `passwordState` 与 check 同义，另有 `not_requested`。

### 3.1 一次性确认票据（password scope 的前置条件）

`fetch` 只有在 scope 含 `password` 时才输出明文密码，因此它额外要求一张**一次性确认票据**，
证明用户刚刚在终端里（T6 之后也可以是界面按钮）确认过「这一次跳转可以带走这台主机的密码」：

- 路径：`${XDG_STATE_HOME:-~/.local/state}/twiglane/host-sync/<sessionRef>.confirm`
  （测试可用 `TWIGLANE_HOST_SYNC_CONFIRM_DIR` 指向绝对路径）。
- 权限：`0600`（Posix 权限不是 0600 的票据一律不算确认）；目录由写入方创建。
- 内容：`{"protocol":2,"hostId":"...","sharedHostId":"...","createdAt":<unix 秒>,"expiresAt":<unix 秒>}`，
  字段之外的多余字段、缺失字段都拒绝。`expiresAt - createdAt` 不得超过 120 秒，且 `expiresAt` 必须晚于当前时间。
- 语义：票据只对 `sessionRef` 对应的这一次会话、这一台主机（`hostId` 与 `sharedHostId` 都要对上）有效。
- **消费是原子的**：helper 先把票据 `rename` 到本进程独占的临时名（`<sessionRef>.claim-<uuid>`），
  再读取与校验，最后删除。`rename` 是唯一竞争点，同一张票据被两次 `fetch` 抢只有一个能成功，
  不会出现「两边都确认过」。删除失败**报错**（`host_sync_unavailable`）而不是静默忽略：
  能留下的票据就有被重放的可能。不识别的票据同样删除，不留在磁盘上。
  因此同一张票据不能用第二次，重试需要用户重新确认。
- **谁写**：`--host-sync-v1 confirm <sessionRef>`（本版本已实现），或 T6 接线后的桌面 UI 按钮
  （必须写同一格式、同一路径的票据）。两处都只由「用户当场确认」那一个分支写入。

### 3.2 `confirm`：人写票据的唯一入口

```
<来源应用可执行文件> --host-sync-v1 confirm <sessionRef>
```

- **必须跑在真终端里**：stdin 不是 TTY 一律 `host_sync_tty_required`，脚本无法静默确认。
- 终端里回显目标主机名、地址与主机标识，并说明「确认会把这台主机的密码同步给发起跳转的另一款应用」；
  用户必须输入 `y`/`yes` 才写票据，其它输入返回 `host_sync_declined`。
- 写的是第 3.1 节同一格式、同一路径、0600 的票据（TTL 120 秒），成功后 stdout 一行
  `{"protocol":2,"kind":"host-sync-v1","confirmed":true,"hostId":"...","sharedHostId":"...","expiresAt":<unix 秒>,"ttlSeconds":120}`，
  不含任何密码。
- 会话必须仍然有效：`confirm` 用的是这一次跳转的 `sessionRef`，过期会话直接 `session_expired`。
- T6 接线后，UI 按钮写同一格式票据，作为 `confirm` 的图形入口；两者是同一个入口的两种形态，
  自动重试、后台任务或批量流程都不得代写票据。

`begin` 与 `check` 不需要票据：前者不输出任何秘密，后者只输出相等证明。

没有票据时 `fetch` 的 password scope 直接返回 `sync_confirmation_required`：**不读取密码、不输出明文**，
会话文件与主机记录都不变（连 fetch 次数也不消耗）。调用方据此只把**密码这一路**记成
`needs_confirmation`，而不是把整次同步判成失败（第 4 节）。

## 4. 接收侧：对齐、写入与回执

接收方（被跳转到的一方）按 `sessionRef` 调用来源应用 helper，并据此写入本机记录。本版本这一角色只由 helper（`--host-sync-v1 receive`）承担；桌面进程内的 IPC 入口延后到 T6，届时才由前端触发：

1. **关联**：优先用来源的 `sharedHostId` 找本机记录。找不到时按**来源主机地址**核对本机同地址记录：
   - 同地址记录**已关联到另一个 `sharedHostId`**：返回 `association_conflict` 与 `conflicts` 列表，
     **不新建重复记录、不写任何记录、不推进修订**（两条记录是两端各自的历史身份，不能靠复制掩盖）。
   - 同地址存在**未关联候选**（`sharedHostId` 为空）：返回 `association_required` 与候选列表，要求显式选择；**绝不按名称或地址自动合并**。
   - 同地址完全没有记录：首次关联，新建一条记录（`enabled=false`，`sharedHostId` 取来源值），不触碰其他主机。
   - 来源没有 `sharedHostId`（更早的来源版本）：同样返回 `association_required`。
   - 显式选择（`resolveTo`）时，若该记录已属于另一个 `sharedHostId`，返回 `association_conflict`，不覆盖。
2. **一致即结束**：配置指纹相同且密码相等（或两端都没有密码）时，不取回配置或秘密、不写记录、不推进修订，直接 `settle`。
3. **按需取回**：配置不同取 `config`，密码不同/缺失/未知取 `password`，两者都要取 `all`。
4. **写入前重新核对**：在**任何**写入之前比对本地记录的修订（配置与密码两路都一样）。核对之后
   本机记录被**修改或被删除**都返回 `conflict`：既不覆盖配置也不覆盖密码，也**不按会话里的旧身份
   重建一条记录**。冲突回执按配置/密码分别给出（只标真正要同步的那两路）。
5. **分别回执**：配置与密码各自一条回执。密码写入失败时保留原密码（不删除、不改写），结果是 `partial`，
   会话不销毁，可用原会话上下文重试；重试时已一致的字段不再改写。
6. **密码缺票据不算整体失败**：需要密码而对端返回 `sync_confirmation_required` 时，接收方**照写配置**，
   并分别回执 `{"kind":"config","state":"saved"}` 与 `{"kind":"password","state":"needs_confirmation"}`，
   `result` 是 `partial`、`password` 是 `needs_confirmation`、`sessionClosed` 为 `false`。
   既不回滚配置，也不把 `sync_confirmation_required` 折叠成 `host_sync_failed`。
   被拒的这一趟对端没有读取任何秘密，也不消耗它的 fetch 次数，所以用户 `confirm` 之后还能再取一次密码。

响应：

```json
{"protocol":2,"kind":"host-sync-v1","role":"receiver","result":"applied","hostId":"...","sharedHostId":"...","password":"equal","receipts":[{"kind":"config","state":"saved"},{"kind":"password","state":"saved"}],"revision":2,"sessionClosed":true}
```

`result` 取值：`consistent`、`applied`、`partial`、`unknown`、`unchanged`、`association_required`、`association_conflict`、`conflict`。
`association_conflict` 与 `association_required` 都不写任何记录，所以它们的回执**不带** `hostId`
与 `password`（`association_conflict` 带 `sharedHostId` 与 `conflicts`，每项含 `hostId`、`displayName`、
`host`、`sharedHostId`），`receipts` 为空。`receipts[].state` 取值：`unchanged`、`saved`、`failed`、
`absent`、`unavailable`、`conflict`、`needs_confirmation`。`password` 取值：`equal`、`differs`、`absent`、
`unknown`、`needs_confirmation`。回执里没有密码，也没有私钥内容。

`receive` 也可以直接从 helper 调用（供双端联跑与排障）：

```
echo '{"sessionRef":"<sessionRef>","resolveTo":"<本机 hostId>"}' \
  | <来源应用可执行文件> --host-sync-v1 receive <来源应用可执行文件>
```

`resolveTo` 可省略（按 `sharedHostId` 自动对齐）。这是 v2 的 stdin 形态：动作名与对端程序路径是 argv 上
仅有的两段内容，其余参数走 stdin。v1 的 argv 形态见第 1 节。

## 5. 错误

局部错误以退出码 2 结束，stderr 只有一行 `{"error":"<code>"}`：`host_sync_request`、`host_sync_argv_rejected`、
`sync_confirmation_required`、`session_expired`、`session_stale`、`target_unavailable`、`host_sync_busy`、
`host_sync_unavailable`、`host_sync_protocol`、`host_sync_failed`、`association_conflict`、
`host_sync_tty_required`、`host_sync_declined`。
stderr 不含诊断文本、主机名、路径或密码。

- `host_sync_argv_rejected`：argv 里出现了这次动作不接受的内容（位置对不上、多给了参数，
  或 `confirm` 给了不止一个会话引用）。两种合法形态见第 1 节。
- `host_sync_tty_required`：`confirm` 的 stdin 不是 TTY，拒绝写票据。
- `host_sync_declined`：用户在终端里没有输入 `y`/`yes`，没有写票据。
- `sync_confirmation_required`：password scope 缺确认票据；接收方据此只把密码回执记成
  `needs_confirmation`，配置照写。

## 6. 秘密边界

- deep link（`twiglane://remote-review?...`）只新增可选字段 `hostSync`，值为会话引用，校验为 64 位小写十六进制；旧链接不带该字段仍然有效。返回事件链接不带 `hostSync`。
- `hostSync` 不参与审查来源的同一性判定：同一个 `reviewId` 重新发起跳转时同步引用会变，但来源仍算同一来源（不报 `target_changed`）；其余身份字段仍逐字段严格比较。
- 一次性确认票据只含 hostId、sharedHostId 与时间戳，不含任何密码；密码仍只在 `fetch` 的这一次私有管道里出现。
- 同步日志只有结构化结果与状态字符串；配置（含私钥路径）与密码都不进入日志、URL 或前端文案。
- Twiglane 的密码条目仍在系统钥匙串的 `twiglane.remote-ssh` 命名空间，与 MR/PR 令牌互不可见；同步不为 SSH 新开明文通道。
- 同步只作用于当前这一台主机及其关联元数据，不枚举、不创建、不更新、不删除其他主机。

## 7. 威胁模型

**本版本抵御**：

- **别的用户**：会话文件 0700/0600、票据 0600，都在当前用户的状态目录里；同机其它用户既读不到会话，
  也写不了票据，因此既不能调用 `fetch` 拿到会话，也无法伪造确认。
- **远程进程**：同步完全不发起或接受任何网络连接（不启动 SSH），远端无法直接触达 helper。
- **argv 观测**：v2 调用形态下会话引用与主机标识只走 stdin，`ps`、进程审计与崩溃报告看不到它们。
  与 v1 对端（Cliora v0.4.168）互通时必须走 argv 形态，此时会话引用与主机标识对 `ps` 可见
  （配置层面的可见性）；**密码仍受确认票据约束，argv 形态拿不到密码**。
- **重放**：会话一次性（`settle` 即删，TTL 120 秒，`fetch` 最多 2 次），票据用后即删且绑定 hostId
  与 sharedHostId，同一张票据不能用第二次，也不能换主机用。
- **长期读取面**：会话不是主机簿或密码的通用读取接口——它只覆盖 begin 时冻结的那一台主机，配置变化即作废。

**本版本不抵御（接受残留风险）**：

- **同用户进程**：会话目录与票据目录都在当前用户下，能以同一用户身份运行的进程（例如同一账户里的
  恶意脚本）可以自己 `begin` 拿到 `sessionRef`，再按格式**自己写一张票据**，然后 `fetch` 读出该主机的
  明文密码。票据是「用户刚确认过」的**可见性约束**，不是密码学上的授权边界；它能挡住不看 UI 的顺手调用、
  挡住 argv 泄漏、挡住跨用户与远程读取，但挡不住已经能在同一账户里任意写文件的本机代码。
  真正的边界仍是操作系统账户隔离与本机磁盘的可信度。
- **已拿到本机凭据库访问权的进程**：能读系统钥匙串的同用户进程本来就能直接读密码，同步协议不改变这一点。
- **UI 欺骗**：本版本的票据由 `confirm` 在终端里写（回显主机名与地址，必须输入 yes）；T6 接线后的
  桌面 UI 按钮若未把「这次跳转会带走这台主机的密码」说清楚，用户仍可能在不知情时确认。

**T6 接线要求**：票据只由「用户点了确认」的那一个分支写入，写入前展示主机名与「将把密码同步到另一款应用」，
写入后不缓存；任何自动重试、后台任务或批量流程都不得代写票据。

## 8. 已知缺口

- Cliora 反向跳转的 URL 构造在 `src-tauri/src/twiglane/remote_review.rs`，加上 `hostSync` 参数需要该文件归属的 Task 配合；本协议两侧 helper 已可独立联跑。
- 真实签名桌面包上的双端跳转与人工确认流程属于 T9 的实机证据范围。
- 应用内 IPC 接收接线（`remote_host_sync_begin` / `remote_host_sync_receive` 两条命令、ACL 与 capability 登记、前端调用）延后到 T6；本版本只有 helper 级入口与 URL 解析。
- 确认票据在本版本由终端命令 `--host-sync-v1 confirm <sessionRef>` 写入（第 3.2 节），**不需要**等待 UI。
  T6 落地后由界面按钮写同一格式、同一路径的票据，作为同一个入口的图形版本；两条路径都不得代写票据。
- 与 Cliora v0.4.168（只有 argv 形态）联跑时，`password` scope 仍要求对端也有一张确认票据；对端侧
  的写票据入口不在本仓范围内。本版本接收侧已保证：即使密码没取到，配置也照写、回执照实分两条。
- `secrets()` 与 `cliora_helper()` 目前带 `allow(dead_code)`：T6 把两条命令注册进 invoke handler 与 ACL 后应删掉这两个标记。
