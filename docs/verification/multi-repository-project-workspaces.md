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


## T2-A2 独立审查返修

开发核验延续至 2026-11-17（Asia/Shanghai），受控回执的 UTC 时间为准。

本轮基于 Twiglane `1235545e65c37e08451510f5a193aef811d51384` 返修。已存在的 build.rs / capability 最小 ACL 补丁原样保留；它们此前遗漏于固定候选，由 Owner 在本轮实际 candidate 收录时对账，不能用工作区测试代替候选文件收录。新增候选截图也需随本轮 gallery 收录，Worker 没有操作 Git index/HEAD。

草稿修前反例是实际 App 路径：A 输入 old → B → A 改为 new 并等待 650ms 保存 → 忘记当前 A → recent B → 项目名单 A。单独回归明确得到 Expected `A-new-preserve` / Received `A-old`，且没有未处理的 fixture 异常，回执 `cb8942fe6e0a452938ce567a2410843d000e43be2faf5a5cf2a419e6f4dae2ca`。初次批量修前用例同时复现 POSIX helper/cache/候选去重三例及候选缺搜索；其中草稿 fixture 缺 Promise mock 的异常已先修正，不能拿该异常作为草稿根因证据。

修复后阅读上下文不再存储提交草稿；持久值以 native open 返回为准，只有 DraftBuffer 中未确认保存的本地编辑可以覆盖它。保存按 checkout 串行，旧回执不能清除较新输入，失败只回到原 checkout 的待保存记录。忘记当前仓库先等待保存，失败保留仓库和草稿；文件编辑的原保存/放弃/取消关卡保持。回归包含 0ms 和 650ms 保存窗口、旧请求在途时的新输入、失败后的原弹层重试，以及离开后不得把旧缓存写回 native store。

候选区现有独立名称/完整路径搜索、无匹配提示、匹配结果全选/清除及明确的总数/已选数；筛选不改变筛选外多选。60 个候选排除第 48 项后，跨名称/路径/无匹配筛选及清空搜索仍保持 59 项，确认只纳入这 59 项。候选预览图单列为 `project-candidates`，与已纳入成员搜索区分。

checkoutKey 先识别原始 Windows drive/UNC/extended 语法才规范化反斜杠及大小写；POSIX 目录保留字面反斜杠及大小写。helper、CheckoutContexts、DraftBuffer、候选去重与项目归属均有反例覆盖。原生临时 Git 测试实际创建 `team\service` 与 `team/service` 两个不同目录，验证 common directory、成员、打开目标和持久草稿独立；没有改动原生 Git 行为来绕过这个反例。

| A2 开发检查 | 实际结果 | 回执目录名 |
| --- | --- | --- |
| npm run check | 0 errors、0 warnings | `a560349cea6c1556ecb49678b9102fdee21cb30579863290a3497fc2a6fe1e76` |
| 真实 POSIX 两目录单独回归 | 1 通过 | `87366edcebbfd2c7e76df7d1d78bdd884aa419feb0a0fd3e9b83b4222d4d74cd` |
| 全 Rust library / main / doc | 404 / 0 / 0 通过 | `c4c621e6e214d6b9e6e5c7457f7502cbeae44e94acf7ed619fb54e69ac9af5ac` |
| Clippy all-targets -D warnings | 通过 | `47fd3c436dba64e244ba28bd04a0b45d41cb043f7e390dc78efb4d70cc5ea2cb` |
| npm run build | 通过 | `289df37526222e387b7f5b09d57d9db49f35b130045b9446d5d94c6c0bcfc7a2` |
| npm test 全量 | 1481 / 1482 通过；唯一旧 changes 断言在重试开始清 error 时就检查成功 blocker，未等待 Native 成功落地，随后仅修测试等待真实成功终态 | `adb5508dc8b3d515275a784bb4c87d80e5b1cb8efc22ddfbfe33fe6125d283b7` |
| 提交/改动直接组补验 | 116 通过；保留并加强 Native repo/消息/generation、成功 toast、草稿清空、empty-index 文件行和精确 blocker 的检查 | `c8f276b2de3566376c5ba8e70f4f9ad34492b39d513037e0769aa692360b652d` |
| A2 浏览器完整复验 | 6 / 6 通过，16 图；Native mock 与界面均保持 A-new-preserve；60 候选过滤后仅纳入 59 项；真实主题匹配、modal/backdrop opacity=1、水平溢出 0，无页面错误 | `a1cd17cd9c18a3cc100c88afb499a39d85d9fa50bf7a9c2367a036e8c358272b` |

A2 末轮检查中，产品源码保持冻结；仅修正了旧提交测试的成功终态等待，以及浏览器驱动的兄弟操作按钮/右键菜单、残留弹层关闭和按完整路径选 B，未用更长超时或产品改动绕过失败。全量前端 1481 / 1482 加上相关 116 项补验按原样记录，未写成“1482 项整批一次通过”；正式累计验证仍交 Delivery。

已再次实际查看最终 `after/dark-900x600-project-candidates.png` 与 `after/light-1280x840-project-candidates.png`：候选名称、长完整路径、1 / 60 搜索结果、筛选外 59 项多选及确认操作均清楚可见，弹窗不透明且主题正确。浏览器证据仍只适用于 synthetic API，不证明双端安装应用或系统 scheme。


## T5-A1：双端来源审查集成（开发记录）

当前结论：T5-A2 返修与开发直接回归已完成；最终双主题 12 图通过，macOS 27.0 arm64 的真实 Native IPC / 系统 scheme 双向闭环、拣选 committed 返回及下一基线推进已观察并完成恢复清理。原生证据使用隔离测试包、临时 pass-through 驱动与 fixture CLI，按文末边界解释，不替代正式累计验证或完整平台矩阵。

开发基线：Cliora `f46d0007b26af6cf1a61366ecc3349eadb27e4e9`、Twiglane `3e956c7da8fa9636492ba8869dc86ce17d5a0a20`。T1–T4 的已成立证据保留。本轮覆盖 v3 合同、按来源版本兼容 v2、多来源保留与选择、返回结果顺序，以及两项目范围提示词到原会话返回的直接消费者；没有跨仓自动 Git 写入或 Agent 编排。

双端 `docs/integrations/twiglane-review-v3.md` 和 `tests/fixtures/reviews/protocol-v3.json` 逐字相同；夹具 26 条 request、30 条 event，包含独立来源、项目 UUID/显示名、严格 v2/v3 字段交叉、大小/路径/meta/返回序号边界。夹具 SHA-256：`59749b1e3e1958225af8278344dbb063844942744c3c09eb53c7730bfd6c340f`。URL 不含名单或提示词正文。v3 returned 新增原生分配的 resultRevision，Cliora 拒绝重复/逆序结果和 returned 后迟到的接收回执；v2 不偷加字段、不自动降级。

Twiglane 来源与结果以 reviewId 隔离，A → B → A 保留基线；同一 checkout 可显式选择来源，Git 操作在开始时捕获 reviewId，迟到成功不能记入新选择。八条容量包含 pending，满时明确报错；关闭来源才释放，重启后无法恢复的来源明确失效。审阅标记沿 T2 checkoutKey 语义，POSIX 大小写与字面反斜杠不合并。Twiglane 新增 forget IPC 的 AppManifest 与 capability 源接线，权限文件按仓库惯例由 tauri-build 生成；没有手改或强制收录生成物。

Cliora 发起读取会话原登记项目/仓库身份，保留原 cwd 和远端拒绝边界。每次 v3 结果按 reviewId + resultRevision 重新读取真实 HEAD/dirty，checkout 不符为未确认。下一审查基线只消费原生复核过的提交；项目不会因一个仓库的提交而被标记完成。

已完成的开发检查：

| 检查 | 结果 | 受控回执键 |
| --- | --- | --- |
| Twiglane Svelte/TS check（第二批） | 0 errors、0 warnings | `17832bef94b69ad614412900ffb696e497b665104de6577e9e5759a888137668` |
| Twiglane integration/sources/api/review-progress 直接组 | 59/59 | `15acfe8c33565766afa202434847a50e7b588abb3ac7ededc326cea84082a0ef` |
| Cliora TypeScript + Vite build | 通过 | `e45da54fdcb37d09a6b04d23e1fcba26544892de1f655c8b7ae57330c3b41dae` |
| Cliora review-projects + workbench-twiglane Playwright | 21/21 | `6e73f4e8c5bcdb7cad1399bc23641c9167e1d1646d20962bdb4785b548a8626f` |

新增异步归属反例最初失败于测试在 Tauri 动态 import 完成前调用未安装的 resolver（`1b2837761df7cae7d4e42e695091152d05c5c6239ece0ae09b6162dabeb8d172`）。修正为等待精确 native 写入进入，再切来源和完成旧写入；同时保留新来源成功与旧来源不被改写的正反断言，上表 59/59 是修后实际结果。Rust 第二批发现本 macOS 文件卷不支持同目录仅大小写不同的两个目录（AlreadyExists），以及旧 v2 测试仍把现已合法的 v3 当未知版本；分别调整 fixture 布局和未知版本为 4，保留 POSIX 纯语义与真实字面反斜杠目录覆盖，不声称本卷是大小写敏感文件系统。

浏览器与系统 scheme 的最终实际结果将在后续本 Task 检查完成后补充；上述 Playwright/合成 IPC 不是原生平台验收，正式累计验证由 Delivery 执行。


### T5 最终冻结候选开发检查

最终开发波已通过，命令全部由 Owner 受控前台执行并 cleanup released；生产源码、测试与捕获驱动在这些检查后冻结。这里记录的是本 Task 开发验证，不能替代 Delivery 的累计正式验证。

| 检查 | 实际结果 | 受控回执键 |
| --- | --- | --- |
| Cliora `twiglane::tests --lib` | 29/29；含 512 次并发 revision、立即回执与 publish 失败回滚 | `9e02c3948bc31d71af86e193f6931db382648a43740531a2fd76d0be1c885637` |
| Cliora `session_baseline::tests --lib` | 5/5 | `a78b6fc4da0f5bce1ed28b53aec5b63c4cd48a52cb986ed44fe6cdd935581c4a` |
| Twiglane `cliora --lib` | 28/28；协议、容量、失效、原生独立结果与恢复 | `30cae364dd388bcd32ccb53b9a5266479b3d2e39bfcf48f03945e533257ba034` |
| Twiglane `review_ --lib` | 24/24；明确包含失效 `.git` 不回退父仓、主检出/linked worktree 状态独立读取 | `b244e6be715029387b1eed30fa3bd750a608d4f75da6abb523fb1a27bfcf1679` |
| Cliora Clippy all-targets / `-D warnings` | 通过 | `eeed28c790a0792be6791b067b27c4cefcad8a5d3da3d52b9c5e0929c72988c4` |
| Twiglane Clippy all-targets / `-D warnings` | 通过 | `1882aaf51954b88d740dde4e8318d50f4e3421189b880eba5e571cc233ed4b34` |
| Twiglane Svelte/TS check | 0 errors、0 warnings | `9d9e8545a15495b5f890c44bcb1962b2737a58602dd6023a5a180e8355d89caa` |
| Twiglane integration/sources/api/review-progress | 65/65 | `96302beb15356c7a012464da0f685d906f09ba96515cd12d2c0c3ecef89587e9` |
| Twiglane production build | 通过 | `d1a2e9c7ccbd14dfa74efc06edbea4e7850e8029eb813664d6d5a34668bd0113` |
| Cliora Node unit | 193/193 | `935951526d55fef94d0d8f0c59294dba7632d19104ad8c64aea00101bb3b912f` |

Cliora 本 Task 前一批 TypeScript/Vite build 与 21/21 审查 UI 直接组保持有效（上表前节回执）；此后 Cliora 变化仅为原生登记/元数据与对应 Rust 回归。Twiglane 新恢复波曾出现 commit-and-push 的 `oid` 为 String 却按 Option 读取的编译错误，以及来源列表 mock 非 Promise 覆盖后端 clean/dirty/unknown 提示的测试问题；均已修正，上表 native、65 项前端及 Clippy 是修后实际通过结果，不把未执行的组冒称通过。

来源恢复以原生当前进程的八条有界记录为准，保存完整身份、baseline、协议、独立成功 Git 结果与最近返回声明。首次 bootstrap 串行过期旧 pending 后才 prepare 新链接；mutation epoch 拒绝关闭或新结果之后迟到的快照。失效的非活动来源无需打开即可在管理入口明确关闭。传输错误不把已接受来源伪造为 rejected；`lastReturn` 是返回声明，不能单独证明系统投递、Cliora 确认或 Git 复核成功。

Cliora 在公开系统 URL 前原子预登记；可控立即 accepted/returned、失败回滚、并发较新事实和连续失败链均有回归。项目名称只读 `workspace_projects.name`，保持 session 原归属及 80 字符限制，不为审查来源显示探测其它成员仓库。


### 双端浏览器捕获的首轮反例

首轮 `capture-review-roundtrip.mjs` 退出 1，没有成功 manifest；回执 `1738ecd74a2a924b293fcc983a9b4312b25acd1c16a51ffb0cdd0434af57a382`。五张浅色图和逐图 SHA 原样保存在 Cliora `docs/verification/ui-review-roundtrip-failure-1738ecd7/failure.json`，不作为完成证据。

实际查看 `light-twiglane-source-manager.png`：原生 select 的 DOM value 已是 A，实际来源说明仍为支付系统、仓库路径仍是 `/work/payments/api`，并显示正在读取仓库。驱动把 selectOption 的同步 DOM 变化当成异步仓库切换完成，存在在仍活动的 B 上提前返回的竞态；该图片证据只定位了就绪判断缺口，不能单独证明完整返回失败根因。捕获驱动现等待实际 `.cliora-chip` reviewId 和当前仓库路径均属于 A，再截取就绪任务队列并点击返回；返回投递前严格检查 v3、A 的 reviewId/sessionId 与 resultRevision=1。保留 Cliora 自动选择原会话及草稿不变断言，没有手动点选 A 或延长超时。产品源未修改，已通过的核心回归不为此重复执行。


第二轮回执 `191174ab04d29a193a65a61fa8aa902d53bbac36678a443af0f6270606890f35` 仍退出 1：新增诊断明确证明返回 URL 属于 A 的 reviewId/sessionId、v3、resultRevision=1，但 Cliora A 仍未自动选中。因此没有把 select 就绪修正冒称完整根因或成功。当前进一步以独立 light 诊断检查 DEV/React.StrictMode 下合成事件桥的注册/解除、实际入站 kind/reason 和活动会话；产品代码保持冻结。


独立 light 诊断回执 `eee8a9b12cfc8f47e8aa165b555b45e5bc6705487c974ff2a812b209de1aeae1` 明确定位完整返回失败：DEV/React.StrictMode 注册 deep-link handlers 13、14，14 已 unlisten，但合成桥仍只向最后的 14 发出三个 accepted/returned；实际 `twiglane_review_link` incoming 为空，两条来源仍 opening/revision 0、活动会话仍 B。没有 native registry 拒绝 A 的事实。这修正了前述局部就绪归因：完整问题是合成桥把已清理 effect 当活动订阅，而非产品协议或会话返回失败。

修复只改变 capture fixture 的事件模型：独立 listenerId、每事件多个订阅、按 eventId 真正解除监听，emit 仅给仍活动订阅；保留诊断及 A 自动返回/草稿/独立结果断言。另将 prepared `lastReturn` 的 UI 文案改为“已保留上次返回尝试，接收结果以 Cliora 为准”，避免把缓存声明说成已经送达；对应一条文字断言同步，协议和状态逻辑不变。


### 双端浏览器最终捕获

最终重采回执 `552d51750f43523d040fe4d760e763a35e4119f494b3380aa48bbe128abdacda` 退出 0、cleanup released。Cliora `docs/verification/ui-review-roundtrip/manifest.json` 与 `index.html` 记录浅色/深色 1360×900 共 12 图：仓库范围提示词全文预览、Twiglane A/B 来源、切回 A、显式来源管理及自动返回 Cliora 原会话。输入为两业务项目、49 个仓库成员、124 条提示词和两个来源；全部图水平溢出 0、页面错误为空。两主题均验证 A 的 reviewId/sessionId/v3/revision=1 返回，A 自动选中、B 保持 accepted、A 原草稿追加提示词后不变且没有发送操作。

实际查看最终 `dark-twiglane-source-manager.png`、`light-twiglane-switchback-a.png`、`light-cliora-returned-original-session.png`、`dark-cliora-repository-prompt.png`：来源/项目未关联标识、真实目标路径、任务基线、独立来源列表和原会话草稿清楚可读，深浅主题正确，无观察到的布局溢出。捕获使用两个真实前端和合成 IPC/链接投递，manifest 明确 `realGit=false`、`systemScheme=false`、`nativePlatform=unverified`，不能替代真实桌面联动。

“返回尝试”文案定向回执 `65d3333f62296f7366188d4626c813d18a13dfe245aa656b78e2eedc677b4dfb` 通过 1 项，其余 22 项未选；没有把定向检查写成全组通过。完整核心 65 项的既有回执与本次纯文字补验分别保留。成功捕获与三次失败/诊断回执分开记录，没有用手动选回 A、延时或更长超时掩盖失败。


### macOS 原生尝试：首轮构建前置结果

Owner 的首次独立候选构建在启动应用前被 Tauri 的版本一致性检查阻止：本机安装目录中的 updater 为 2.14.1，Rust 对应为 2.13.1；Owner 核对现有 package-lock 锁定 2.13.1，定位为 node_modules 环境漂移。受控回执 `00a11209018925b60c2e4dbc3cc089b11df20641e24e93b37e6bf48cd637697f` 的外层 child 退出 0，但业务报告为 attempt-incomplete，不能记为原生通过。该轮没有启动任何候选应用、没有修改系统 handler。

Owner 按现有锁执行 npm ci 修复环境，不改 manifest/lock，也不跳过版本一致性检查；随后重新构建私有 frontend 与隔离候选，并在锁定环境下进行后续正式累计验证。当前原生结论仍待实际 bundle/IPC/scheme 尝试补录。


锁定环境修复回执 `32ef6a3ce34b150638eb09af55b4be00d1da1dc1c755ba8e77e657af83c5ceea`：Cliora `npm ci --prefer-offline --no-audit --no-fund` 成功、cleanup released；其 Node/Rust 锁均为 updater 2.13.1，漂移的仅原 node_modules 2.14.1。Twiglane 的 Node/Rust 锁和实际安装均为 2.14.1，无需重装。两仓 manifest/lock 与产品源码没有因此改动。Owner 为候选环境一致再次执行同 12 图捕获并重建隔离 Native 候选；前一成功捕获保留为已发生观察，最终引用以锁定环境回执为准。


锁定依赖后的最终双主题捕获回执为 `fc8a611e71298078d0bbcf2889ed412c577c7a6591d256f14931ef91c3e57f43`，退出 0、cleanup released，同样为 12 图、0 页面错误/水平溢出及 A 自动返回、B 独立、草稿保留且不发送。当前 gallery/manifest 对应该锁定环境；Owner 再次实际查看浅色原会话返回与深色来源管理代表图。先前 `552d...` 成功观察保留，但以本轮作为最终浏览器候选证据。

macOS 原生 attempt 2 回执 `611b15c04e05288b62e9f04b392d0a4b70de15fcf598aca6d664ec340327c81d`：两份私有隔离 app 已实际打包（Cliora 约 164 MiB、Twiglane 约 71 MiB），宿主为 macOS 27.0 arm64。临时 probe 确认 native bridge ready，但尚未观测到两端生产根 DOM mount，因此没有 source launch、没有默认 handler 切换，也没有系统 scheme 往返成功结论。业务报告仍为 incomplete；`handlerRestored=true` 在该轮仅表示原 handler 状态未改变，所属进程已清理并 released。

Owner 保留 attempt 2 报告/日志，只在私有测试 frontend 的临时 probe 增强 error/rejection/CSP/resource 诊断并重建同源候选。当前不能把未 mount 归因于产品或平台限制；生产源与测试保持冻结，等待具体错误和实际尝试结果。


后续原生诊断已纠正“未 mount”判断：attempt 3 观察到 `#root` / `#app` 均已有实际生产 DOM，临时 probe 等待两个 requestAnimationFrame 在后台未完成才造成前轮假失败，没有证据表明产品启动故障。attempt 4 的中止点是观察脚本请求 Twiglane 未开放的 `core:path:resolve_directory`，没有为此扩产品权限；私有测试包只改用最小 `core:app:allow-identifier` 观察隔离身份，实际 Cliora AppDataDir 与 Twiglane runtime identifier 的私有隔离均已证实。

attempt 5 未能把系统默认 handler 选成候选，仍未 source launch，原 handler 已恢复。另有独立只读宿主事实 `CGSSessionScreenIsLocked=1`；这是锁屏状态与路由失败的并存观察，尚不能单凭它推定 LSSet 失败原因。Owner 继续记录 LSSet 状态码、候选注册 URL、新鲜进程读回与恢复结果，不解锁桌面或代替用户同意；在默认路由未确认时不发起会自动回执的业务来源，避免测试流量落到已安装用户应用。


Native attempt 7（受控 `3fbed857a4092960a4f5fd3b29ad996a5ae3ff1754cba4a4e1b1b3f4def78f03`）有实质进展：仅把同源候选临时复制到 `~/Applications/Sakullla Review Probe 8c6f1439/` 后，两个候选 ID 均成功注册，LSSet 状态为 0，独立读回选中了该目录内的私有 app；先前 `/tmp` 目标 URL 为 none 的范围因此缩小为安装/注册条件，不再将“默认路由不可用”视为已确定环境终点。

| 本轮实际候选 | runtime identifier | 报告 sha256 字段 |
| --- | --- | --- |
| Cliora Native Review Probe.app / 0.4.142 | `com.cliora.reviewprobe.8c6f1439` | `a480cf5eb6c30beb734d635a9a8b5d560ae53207b8d5b3b1ead71a496cc467cd` |
| Twiglane Native Review Probe.app / 0.3.23 | `app.twiglane.reviewprobe.8c6f1439` | `dec861e96b3caf9954a6214ac601e553c588d8a83e4cd387d3bccbc446d3e61d` |

真实 IPC 的自定义 CLI 路径、首选 Workbench、创建业务项目、关联临时真实 Git 仓库均成功；随后等待 `launch_workspace_cli` 40 秒超时，尚未 `start_review`，业务报告仍为 incomplete。两 handler 均恢复为 `com.cliora.desktop` / `app.twiglane.desktop`，专属临时安装目录已删除，所属进程 cleanup released。

Worker 只读核对该专属 DB：schema 33、业务项目/仓库/位置各 1，但旧目录 projects、workspace_sessions、会话 checkpoint、账号、配置绑定、Skills 操作均为空。真实调用链应先 `prepare_launch` 创建并提交旧目录上下文，再进入 CLI 版本探测与真实 PTY；故不能把该超时直接归因于 fixture cat、PTY 或锁屏。fixture 的版本输出与其余参数下常驻 cat 符合 Workbench 不等待子进程退出的约束，baseline capture 也是异步。Owner 正补临时观察脚本的 action/invoke 入口记录、owned 进程采样和安全 argv 诊断，以区分是否真正进入 Native launch；生产源继续冻结。


### 最终 macOS 真实 IPC / 系统 scheme 观测

最终受控回执 `681fe746cdd6d9234127040d17c6252f7e123789128c70f63e3b7b9c96212b8a` 退出 0、cleanup released。统一证据入口为 Cliora `docs/sakullla-workflow/2026-11-16-multi-repository-project-workspaces/evidence/native-review-runtime/index.json`；其中含原始 `report.json`、`action-results.jsonl` / `native-ipc.jsonl`、两仓 source inputs、测试 overlays、probe/driver、fixture CLI/argv 记录与构建日志，并记录逐文件 SHA。`postflight.json` 是恢复后的新进程读回。

同一冻结产品源码下，临时 probe 使用服务端长轮询，去掉对后台 JS setTimeout 的调度依赖。`action-native-enter` 与实际结果证明 `launch_workspace_cli` 约 0.16 秒建立真实 PTY 会话；之后为：Cliora `start_review` → OS 默认 Twiglane 候选 → 真实产品接收处理 → Cliora accepted；Twiglane 原生 `cliora_review_return` → OS 默认 Cliora 候选 → 原生 returned / resultRevision=1。动作记录没有直接调用 receipt/link 回填。此前第 7 轮缺入口证据的 40 秒超时在不改产品后没有复现，不将它表述为产品 PTY 或锁屏故障。

该次 reviewId 为 `924eeff4-4877-449b-976d-47c36fc59407`；业务项目 `45027af9-af87-4ac1-80a4-e83b992a7afb`、仓库 `566b74a1-875b-49c6-9572-e71f0c3b31bb`、会话 `92719b21-d4bf-42ac-852d-b675aedc8616` 在 accepted / returned 中精确一致。真实 `workbench_code_status` 为 ready，main 的 HEAD 与 baseline 同为 `6b76c0700d987a5c373797e719f012c2d8cda6f9`、未提交数 0；本例为 reviewed + clean，没有 Git 写入或项目完成结论。

| 最终候选 | 标识 / 版本 | 实际执行二进制 SHA-256 |
| --- | --- | --- |
| Cliora Native Review Probe.app | `com.cliora.reviewprobe.8c6f1439` / 0.4.142 | `ce09272b95fe0424378e38a38a31bb91d460ff5ee048d484246d07ef107a6693` |
| Twiglane Native Review Probe.app | `app.twiglane.reviewprobe.8c6f1439` / 0.3.23 | `2f3a60276aaf76090f91fdd92e401643725a9010304932c52958ccbc43b317dc` |

实际短暂安装/运行位置为 `~/Applications/Sakullla Review Probe 8c6f1439/`。清理后该安装目录不存在、两私有 identifier 的进程数均为 0，默认标识与实际物理目标分别恢复为 `com.cliora.desktop` → `/Applications/Cliora.app`、`app.twiglane.desktop` → `/Applications/Twiglane.app`。原缓存中的保留 `.app` 路径见 index 的 retainedBundle；其二进制字节 SHA 与实际短暂安装执行一致，不把已删除运行路径当作仍安装。没有为测试新建账号、连接或 Key，也没有对用户 DB 迁移；目录和 Git 输入仅为 owned fixture。

边界：宿主 macOS 27.0 arm64、观测时仍锁屏；候选是正常生产源码的隔离 identifier、ad-hoc bundles，使用临时前端 pass-through 真实 IPC / loopback 观察及最小身份元数据测试 capability。PTY 子进程是输出兼容版本并常驻 cat 的受控 fixture，不能声称真实 Codex 登录、推理或 CLI 全能力验收。键鼠、焦点、IME、签名/公证发布包完整场景矩阵和 Windows/Linux 原生行为未验证。前述真实 Git 单测、56 条协议 fixtures、65 项前端直接回归及双主题 12 图分别支撑各自层级，不拿任何一层替代另一层。正式累计验证与最终交付审查仍由 Delivery 执行。


## T5-A2：独立审查返修

基线 Cliora `f1af43b333505e7901e278526820c88ef6a42a09`、Twiglane `4de55c10c6757042b6fddf6e6dd3b5dca0a1eef9`。Cliora 固定范围审查通过的判断保留；前述 Native 8 与 12 图属于 A1 候选，不能自动转作 A2 的新源码证据。A2 只处理两项 P2 与直接安全测试合同。

修前受控结果：前端 4 项中 3 个产品反例失败、1 个负例通过（47 未选），回执 `67b77f0d1793b0ee27ce200d46af5bf7c331de7983102130cf0bb7ff52dea763`。真实 Git/IPC 六项中，拣选成功/部分冲突的源缓存为空及继续拣选误作 merged 为三项真实失败；纯冲突、纯失败两负例通过，回执 `921b460a2e86838b1790626fcb638922148beae4524e4e42092cad1cb6e3a3c2`。all-skip 初始 fixture 误用了无 parent 的 root commit，服务本来就应拒绝；仅改为普通已有 ancestor 提交后，未改生产代码单项通过 `256824b4a19197327dbbf1e9a5ed6d0e89072c0b61cdde151bf9409b29549bed`，不将它记作产品根因。原 security 精确 allowlist 失败回执 `7cf329bd70be811a5d8648a0be7ee4c50e0cc953356399583c09331ed05e5d0f`。

accepted 返修以既有 repository epoch、canonical 路径和来源 mutation epoch 判断上下文是否仍有效；过期完成只保留 A 来源，不激活、不改 B 的任务起点，也不使用长时间全局锁。Git 结果补齐实际 cherry-pick producer：created/headOid 由受控 write guard 内核实，支持已创建提交后冲突；全跳过、纯冲突/失败不制造或清空结果。complete_merge 返回 guard 实际完成的 operation，拣选/还原归 committed，merge/rebase 归 merged，不信任切仓后的前端 operation。Rust/TS DTO、preview fixtures 和双端合同同步；checkout/reset/分支切换不自动推断提交。security 仅同步 forget/sources 两项最小授权期望，保留禁止通用 shell/fs/http 的全部守卫。

修后直接验证结果见下表；正式累计验证仍交 Delivery。Native 与捕获针对冻结的 A2 重新取证，A1 原始材料保留。


A2 修后直接组均由 Owner 受控执行，退出 0、cleanup released；生产源、测试和 preview fixture 在这轮后冻结：

| 开发验证 | 实际结果 | 受控回执 |
| --- | --- | --- |
| Svelte/TS check | 0 errors、0 warnings | `63de400e942fe0eb04987873ba0ca505a8dce5b92adf8c9a22acfb9c9b071ed7` |
| integration / api / sources / review-progress | 70/70，含迟到 accepted 和拣选/继续原反例 | `a734a03878e20eebcd8ce1fd4470515378c4f1fca96bb45c84b160ab942e39c8` |
| ipc_contract | 16/16，含 8 项真实 Git 拣选：成功、全跳过、纯冲突、失败、部分冲突、继续完成及旧结果保留 | `8efcc00076cff8b98b316cb2b1fa7e8c2748a87f69b963c68d28afd304c69bb0` |
| security | 3/3，精确授权与禁止通用能力守卫均保留 | `d5841d9e60ea284ea1a8a607d3787c98e8d865a5f85b44ca65effe2ef90139a8` |
| git::resolve 直接服务组 | 48/48，覆盖拣选、还原、合并/变基及继续入口 | `10c95789d45d4816bfd5f3ada496b973ace0b39a23ba56e1713bfd508eed6893` |
| Clippy all-targets / -D warnings | 通过 | `330be09d1fbb9bff119219a4ba30a4e2fdd990521d15b8fcfabfa5f9b41f1b68` |
| production build | 通过 | `3f7b0925b8b2523dd178c5e4c7ed6ff41b467cd3e20d788bb3aa74c95c2c2151` |

producer 核对包括普通提交、提交推送、拣选、还原、修订、start_merge 的 ff/rebase 完成，以及 complete_merge 下实际 merge/rebase/cherry-pick/revert；继续拣选的 committed 分类来自原生 guard 回传的 operation。checkout/reset/分支切换和 stash 等不因 HEAD 或 Git 对象变化被推断成源提交。既有 IPC mock AppState 补齐真实 app 已有的 ReviewSources 管理，未弱化请求参数或安全断言。Cliora 产品源码未变，复用其有效固定范围审查；双端合同逐字同步，56 条 URI fixtures 的字段/字节不变。


A2 最终同源捕获回执 `5ee8141b5aa98638740c39d3faf934c99879d864ec6550504ce4d41e2cb117d2`：12 图、页面错误 0、水平溢出 0，A 自动返回、草稿保留未发送、B 仍 accepted。
A2 原生回执 `fdc89a1de898dc928edeaa0cd58adee875af8561eccd471b2c9b69a5b487c322`：真实 owned Git 拣选 created=1、HEAD=`73e08f7c82b537f66d678ac7135c0284e29217d2`，committed/clean、revision=1 返回原会话；Cliora 实际复核后下一审查 baseline 等于该 HEAD。
统一证据为 Cliora workflow 的 `evidence/native-review-runtime-a2/index.json` / `report.json`；候选路径、SHA、源码输入和外置驱动均在索引，A1 原始证据/二进制另行保留。`postflight-a2.json` 确认原 `/Applications` handlers 已恢复、owned 安装目录不存在、owned 进程为空；两次命令均退出 0、cleanup released。
边界仍为隔离 ad-hoc bundles、fixture CLI 和外置 pass-through IPC 驱动，不代表真实 Codex 登录/推理、键鼠/焦点/IME、Windows/Linux 或完整原生矩阵验收；正式累计验证交 Delivery。
