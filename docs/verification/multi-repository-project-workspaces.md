# Twiglane 多仓库业务项目：T2 开发验证

候选范围：Twiglane `987f1a2` 上的 T2 工作区改动。日期：2026-11-16。这里记录开发验证；正式 Delivery 和两端安装应用的系统 scheme 往返由后续阶段处理。

## 已实现的使用路径

项目栏和原有 RepoSwitcher 接入独立于 recent30 的持久项目成员；支持创建本地项目、批量选目录、限定根目录发现、候选预览选择、名称和完整路径搜索、收藏、成员移除和本机位置修复。仓库状态继续复用原 GitScheduler 总览的读取预算、unknown/stale 和主仓库/worktree 分组；活动仓库仍只有原有单 watcher。成员关系不会合并各仓库的索引或 Git 写入。

用户可以发布 `*.dev-workspace.json`，或预览后关联 Cliora 创建的同一份文件。两端共用的三个 fixtures 原样镜像于 `tests/fixtures/workspaces/`；合同镜像见 `docs/integrations/project-workspace-v1.md`。源文件更新在打开项目、窗口获焦和手动刷新时重读。缺源、损坏、未知版本或倒退/同版本内容变化保留最后快照和错误；预览取消不写入。UUID、JS 安全 revision、完整绝对位置、共同 host provenance、sidecar 文件锁、摘要 CAS、发布前身份冲突检查、原子替换、显式 unlock 与发布后投影恢复都在原生边界实现。没有跨仓源码 import、共享数据库或新增常驻服务。

state.json v1 升级到 v2 前保留精确字节备份 `state.v1.backup.json`，再原子保存。未知/损坏版本不覆盖。recent 淘汰和“忘记最近仓库”均不删除提交草稿；移除项目成员也保留源码与草稿。仓库切换仍先经过文件草稿确认、写入阻塞和 cancelReads/readSerial。App、文件树及历史面板按 checkout 保存阅读视图、选择、导航、筛选、任务范围与位置；回到仓库后重读相应 Git 数据，迟到结果不能写入其他仓库。普通文本复用原分页位置恢复机制，文件阅读位置按 checkout 分别保留预算，60 个仓库不会共用旧的 48 条总位置配额。主检出与附属 worktree 的项目归属通过现有 HEAD 元数据关系确认，子模块不会按父目录归属。

审查 v2/v3 协议及来源管理没有在 T2 改动；后续 T5 可消费已保留的 taskRequest、checkout 阅读上下文及项目仓库身份。

## 输入与实际观察

- Rust 临时 Git 场景创建 35 个真实独立仓库，含两个同名目录、子目录入口、1 个 linked worktree、1 个 submodule。限定根目录发现获得 37 个位置；未把 submodule 合入父仓，linked worktree 的 common directory 与主检出相同。项目 35 个成员在 recent 淘汰为 30 后及状态重开后仍在，旧 checkout 草稿保留。对 A 暂存并提交，B 的文件字节、索引字节、HEAD 和 status 均不变。临时目录由现有测试 fixture 清理。
- 原生清单场景覆盖共同 fixtures、大小/版本/路径验证、未知字段、host 锁和损坏 token、预览摘要变化、幂等接收、同版本内容变化/版本倒退、忙锁/CAS、发布不覆盖已有文件、已发布而私有存储替换真实失败后的刷新恢复，以及活跃成员关联冲突必须在共享文件发布前拒绝。
- Vitest 验证 60 个持久成员、收藏、未知状态、同名路径、外机位置、批量 worktree 去重、搜索/预览取消/失败候选、A→B→A 的提交草稿和文件选择、文件树导航及迟到结果、历史查询/提交/scroll，以及 60 checkout 的独立位置预算。
- 浏览器使用 `scripts/run-ui-verification.mjs --projects`，由 synthetic API 提供 60 个成员、长名称、同名路径、外机位置及缺源快照。场景包括全文名单搜索、A→B→A 草稿/选择、附属 worktree 归属和来源失效。截图按深浅主题和 1280×840/900×600 采集项目总览、管理和缺源状态；每图等待真实主题、有限动画完成和绘制，并记录 computed theme、表面颜色、modal/backdrop opacity 与水平溢出。图片和报告位于 `multi-repository-project-workspaces-ui/`。mock、浏览器图片及 Rust 临时 Git 各有证据边界；没有将它们当作双端已安装应用或其他平台的实机验收。

## 开发验证记录

受控命令回执均在 `/Users/yanggeng/.sakullla/runtime/controlled-commands/`，以下为实际完成过的记录；最终补验记录在交付前追加。

| 命令/场景 | 结果 | 回执目录名 |
| --- | --- | --- |
| Rust `workspaces::tests` | 8 通过，含 35 个真实 Git 仓库 | `354a46fbacb979efa8ce1b286a3ccb2aaca83ae9ea045004b34568102b84f6b3` |
| Rust `state::tests` | 9 通过 | `ddbbe06e6354398d772d639c653049e11834885eebd1198a357fa8d6d4249a51` |
| npm test（最终前端业务候选） | 1470 通过 | `5872f7cc11bfd9343f68c7b24b81f6f9c311ce6ea223ad47a214c7f1089ed2bc` |
| npm run build（同前端业务候选） | 通过 | `466bfc7917280467c1d51bada1b45f8d54229e4d57cbe24e21e6e3de1aa8f012` |
| 原生 IPC ACL 注册 | 通过，11 个 workspace 命令均在 manifest/capability；发布另有 dialog save 权限 | `f0008babf9c884e098c02b323b7b66e92e899468c24c183c9d7f58fda8aabd66` |

## 全 Rust 回归发现的既有 macOS FD 枚举问题

首次全 Rust 402 项中，T2 新命令的 ACL 缺口已补齐。另外两个失败为 `permanent_delete_removes_files_and_directories_without_touching_git_metadata` 和 `batch_delete_removes_thousands_of_files_in_one_lock_and_reports_absent_targets`。Owner 使用 `987f1a2` 的独立临时 git archive 快照运行相同 exact 测试，两项同样失败，证据为 `ce2bf744019d5727c29c65b72357dd06f340c627180a21a382bbe653d24aad86`；不是 T2 引入，未改动当前 Git HEAD/index 来构造基线。

经 Owner 授权，最小修复覆盖原安全文件操作消费者。现场临时目录反例：macOS 对 `/dev/fd/N` 执行目录枚举返回 errno 20 `Not a directory`；`fdopendir(dup(fd))` 首次读到 3 项，原描述符游标变为 2147483647，第二次枚举为 0 项；`openat(fd, ".", O_DIRECTORY)` 得到独立枚举描述符后再次读到 3 项。

修复让原 `directory_names` 使用已有 no-follow/cloexec 的 `open_at` 相对绑定目录打开 `.`，取得独立游标；永久删除复用此原语，取消 `/dev/fd` 或 `/proc/self/fd` 路径回退。保留所有最终操作的 FD 身份、目录替换、符号链接与 .git 防护，不调整旧失败断言。新增重复枚举及父路径被替换后仍只读取原目录的回归；原两失败和安全相邻验证结果在最终补验记录中说明。

最终补验（继续均为开发验证）：

| 命令/场景 | 结果 | 回执目录名 |
| --- | --- | --- |
| npm run check（将 opened 声明移到派生状态之前后） | 0 errors、0 warnings；仅声明顺序变化，不改变已通过 1470 项的前端行为 | `e6bef344f3563bf2a6bb8de6123631f83b9ffd16352e231adbd6e179f1250404` |
| `git::files::` 原生直接影响组 | 87 通过，含原两删除失败、重复枚举/目录替换新增回归和安全相邻覆盖 | `ce22c8f49a3b793be417404f3cbce191f2695132563965bb0d9364d34784b290` |
| 项目浏览器场景和绘制就绪截图 | 4/4、12 图；真实主题匹配，modal/backdrop opacity=1，水平溢出 0；已人工查看代表图 | `ccafcb95dcbd3ca272d6672b72f1a43c936364bfca0fd3b14728f7e56e842a9f` |
| Rust 完整开发回归 | 403 项中 402 通过，既有两删除失败均已修复；唯一 security 精确权限期望仍为旧列表，随后按新增 11 个项目命令和 dialog save 最小权限更新 | `8880e1a044d9e5ab95590e61205ca842f381c2efd671a7d0188a7ea7bb19df06` |
| Rust security 补验 | 3 通过；精确 allowlist、禁止 generic shell/宽文件系统能力的门禁均保留 | `cada756c27fd93807d9f69fce163e44a785068d966d7e8edec26f12f4a497983` |
| Rust clippy all-targets（含 FD 修复） | 通过，`-D warnings`；随后仅同步 security 测试中的最小权限期望 | `e4fa598924ecc15e58e0570905ef57c2d27dcebcd64b82d8dcfab552b1303da2` |
| 缓存选中文件失效直接影响组 | 189 通过，含新增 A→B→A 后路径移除的文件历史入口，以及旧改动不再列出时通知和提交草稿保留 | `56dc3a3e50d79dddd52951836ddaab75d532b90dafcd4c07cab2bc1456886b09` |
| 最后 npm run check | 0 errors、0 warnings | `69fe3937814d18a88f1005f7ceec27b9b5e1b23810da5926c84b2559e0632b36` |

最后两条前端失效选择回归在 1470 项全量测试之后加入；相关 189 项与类型检查已补验。完整 Rust 的 security 期望通过独立 3 项补验闭合，没有把分段通过写成“最终完整 403 项已一次通过”。最终候选的累计正式命令仍交 Delivery。

人工查看最终 gallery 的固定图：`multi-repository-project-workspaces-ui/after/light-900x600-project-source-missing.png`、`multi-repository-project-workspaces-ui/after/dark-900x600-project-manager.png`，以及深浅色 1280 总览/管理代表图。最后重采报告范围文案只声明项目场景，不声称验证了审查协议或系统深链。
