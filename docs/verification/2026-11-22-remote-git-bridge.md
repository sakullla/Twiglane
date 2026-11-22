# 远端 Git 与主机同步：端到端取证（2026-11-22）

## 结论

- 桌面桥接命令、前端分派与远端会话优先 v2 已实现并通过独立复核（B1/B2）。
- host-sync v2 已在两端落地并互认：Twiglane `protocol: 2`，Cliora `protocol: 2`。
- **真实 SSH 主机上的远端 Git 全链路与双端跳转未验证**，见「未验证」一节。

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

1. **真实 SSH 主机上的远端 Git 全链路**：打开、历史、分支、同步、stash、合并冲突、worktree 与审查返回，只有 port mock 与假组件帧证据，没有真实主机的执行记录。
2. **双端跳转端到端**：helper 互调、来源应用退出后结算、Cliora 侧接收落库，需在合并后的 Cliora 上实跑；本文件只证明协议互认与实参解析。
3. **v2 组件在产品构建中的可达性**：`src-tauri/agent-v2` 为空目录，发行包必须放入 `manifest.json` 与各平台产物后才会走 v2；否则一律回退内嵌 v1（`remote_protocol_mismatch` 不会触发，因为没有产物）。
4. **远端 amend**：需要暂存区快照令牌，原生桥接未回传，界面已如实标为不可用。
5. **块级/逐行暂存**：`patch` 不在桥接白名单，界面已按真实原因禁用。
6. **worktreeRemove**：v2 只删当前打开的工作树、只收 `force`，与本机按路径删除语义不符，保持不支持。

## 四、平台

仅在本机 macOS 上验证；Windows/Linux 的构建与运行未验证。
