# Cliora 审查界面重设计：真实双端联动记录（T7）

执行时间：2026-11-26 07:27–07:37（本地，UTC+8；UTC 2026-11-25T23:27Z–23:37Z）
执行方式：无人值守 agent，在用户已登录但**屏幕锁定**的图形会话中运行。

## 结论

本轮只完成了 Twiglane 一侧的**真实深链接收**验证：冷启动、热启动、重复 reviewId 和无效链接。所用的是已安装的真实 Twiglane 候选构建、系统 `open` 和本机真实 Git 仓库。凡是需要看界面、在界面中点击，或由 Cliora 发起和接收的场景，本轮都**未验证**，包括意见交接预览、普通返回、提交后返回、合入后返回，以及 Cliora 显示的回执。原因见“环境限制”。

`docs/verification/cliora-integration.json` **没有改写**，因为校验器要求的 14 个场景远未全部实机完成。本轮也没有运行 `node scripts/verify-cliora-integration.mjs` 来生成新的通过证据。该文件仍是 2026-11-07 的 Windows 历史记录，不能代表本候选。

本记录全部来自实机操作，没有使用 mock、单元测试或“构建成功”替代任何场景结论。设计层面的 mock 截图另存于 `ui/`（T6），与本文件无关。

## 环境

| 项 | 值 |
|---|---|
| 平台 | macOS 27.0（26A428），arm64 |
| Twiglane 候选 | 0.3.49；源码 HEAD `3e3140008fc01306b89f0bb54f804c0661d77561`，工作区无未提交改动 |
| 候选构建 | `npm run tauri build -- --bundles app` 生成 `~/.cache/cargo-target/release/bundle/macos/Twiglane.app`（ad-hoc 签名，未公证）。可执行文件 `Contents/MacOS/twiglane` 的 SHA-256 为 `bfaccea69716d587ccbb60d3e4b7b2d2ee9082ef233b07afd1d1ea9b9bf9f704`。构建命令最终退出码为 1：.app 已经生成，失败发生在其后的 updater 签名步骤，原因是缺少 `TAURI_SIGNING_PRIVATE_KEY`；这不影响 .app 本身 |
| 用户已安装 Twiglane | `/Applications/Twiglane.app` 0.3.49 正式版；未覆盖、未删除 |
| Cliora | `/Applications/Cliora.app` 0.4.183（com.cliora.desktop），全程保持运行；未修改仓库与设置 |
| Git 仓库 | 临时目录 `/private/tmp/t7-dualend.O4tW/`：`repo`（main，基线 `39f61ad70b60c086d3abcfff6d6c3f52b57b5185`，含 1 个修改文件和 1 个未跟踪文件）、`repo2`（main，基线 `8f72d4e79ce4f0f805338dddf58776f7004f416a`，含 1 个修改文件）、`notrepo`（普通目录）、`missing`（不存在的路径） |
| 截图 | **无**。屏幕锁定时，`screencapture -x` 只能得到全黑图像，`screencapture -l <windowId>` 则报 “could not create image from window”。因此本文件不附截图，也不使用黑图冒充证据 |

## 环境限制（未验证项的原因）

1. **屏幕已锁定**：`CGSessionCopyCurrentDictionary` 返回 `CGSSessionScreenIsLocked=true`，所以截图无法取得，也无法目视检查界面。
2. **没有辅助功能权限**：`osascript` 调用 System Events 时返回 “不允许辅助访问 (-25211)”，因此无法点击 Twiglane 完成栏的“返回 Cliora”，也无法在 Cliora 工作台发起审查。
3. Cliora 只能接收由它自己发起的 reviewId 的回执。本轮链接由 `open` 直接构造，Cliora 不认识这些 reviewId，按协议会忽略其事件，所以**无法在 Cliora 一侧观察 accepted/rejected 回执**。本轮也没有读写 Cliora 数据库。
4. Windows、Linux 未运行；本记录只代表 macOS arm64。

## 观察手段

Twiglane 成功打开仓库时，会把它写入 `~/Library/Application Support/app.twiglane.desktop/state.json` 的 `recent[]`，同时记录 `openedAtMs`。`handleClioraLink` 的源码路径是 `openRepository → rememberOpened`；解析失败或拒绝时会在打开仓库之前返回。本轮用 `recent[]` 的变化判断深链是否真的让候选打开了指定工作树，用 `git rev-parse HEAD`、`git symbolic-ref`、`git status --porcelain` 确认 Git 没有被改写或回退，用 `pgrep` 确认运行的是候选进程、热启动时没有生成第二个进程。

这些手段**只能证明是否打开了指定工作树**，不能证明界面进入了审查工作台，也不能证明回执已到达 Cliora。

## 场景记录

### S1 冷启动 —— 部分通过（界面与回执未验证）

- 步骤：结束用户的 Twiglane 0.3.49 进程；用 `lsregister -f` 注册候选；执行 `open -a <候选.app> "twiglane://review?v=3&reviewId=bfec6505-…&sessionId=9adde80a-…&worktreePath=%2Fprivate%2Ftmp%2Ft7-dualend.O4tW%2Frepo&baseline=39f61ad…"`（23:31:54Z）。
- 观察：启动的进程是候选路径 `…/bundle/macos/Twiglane.app/Contents/MacOS/twiglane`（pid 96415）。`recent[0]` 变为 `/private/tmp/t7-dualend.O4tW/repo`（openedAtMs 1795649516090）。repo 的 HEAD、分支和工作区状态都没有变化。
- 对照：23:34:37Z 用 repo2 的新 reviewId 再次冷启动（pid 98119），`recent` 中新增 repo2。
- 未验证：界面是否进入审查工作台、是否选中任务净差异，以及 Cliora 是否收到 accepted。

### S2 热启动 —— 部分通过，有一次未复现的失败

- 通过：候选 pid 98119 运行期间，用 `open -a <候选.app>` 依次送入 repo（R5 `312daaba-…`，23:34:46Z）和 repo2（`7032515e-…`，23:36:26Z）的新 reviewId。两次都没有新增进程，对应仓库的 `openedAtMs` 也都在 15 秒内更新。
- 重复 reviewId：再次送入已处理的 R4 `6236d5db-…`（23:36:11Z），`openedAtMs` 不变，说明没有重复打开。这符合“同一 reviewId 只处理一次”。
- **未解释的失败**：第一个候选实例（pid 96415）在 23:32:53Z 收到 repo2 的新 reviewId R3 `805cc181-…`，6 秒内 `recent` 没有出现 repo2。由于看不到界面，无法区分以下可能：观察时间太短、界面上有模态框或切换被阻塞（`openModalCount()>0` 或 `switchBlocked` 会拒绝该链接）、锁屏期间 WebContent 进程被挂起（同期日志中有 WebKit ProcessSuspension 记录），或者确实是缺陷。新实例中同类操作已两次成功。建议解锁后复测。
- 路由注意事项：23:32:16Z 曾用不带 `-a` 的 `open "twiglane://…"`（R2），系统把链接交给 `/Applications/Twiglane.app`，启动了 0.3.49 进程（pid 96515）；该进程随即退出，链接没有生效。原因是本机有多个相同 bundle id 的副本，属于环境问题，不计为候选结论。其后的场景一律使用 `open -a <候选.app>`。
- 未验证：热启动时界面是否切换到新来源、多来源选择器的表现，以及回执。

### S3 无效来源 —— Git 安全与“未打开”已验证；界面提示与 rejected 回执未验证

每个用例都先结束候选进程，再用 `open -a <候选.app>` 冷启动（23:33:25Z–23:34:16Z）。每次都确认候选进程已启动，`recent` 中没有新增目标路径，`repo`/`repo2` 的 HEAD、分支和 `status --porcelain` 与开始前完全一致。

| 用例 | 链接要点 | 结果 |
|---|---|---|
| v1 | `v=1`，worktreePath 指向 repo2 | 未打开 repo2；Git 未变 |
| 相对路径 | `worktreePath=repo2` | 未打开；Git 未变 |
| 路径不存在 | `…/missing` | 未打开；Git 未变 |
| 非仓库目录 | `…/notrepo` | 未打开；Git 未变 |
| 非法 baseline | `baseline=abc` | 未打开 repo2；Git 未变 |
| 非法 host | `twiglane://other?…` | 未打开；Git 未变 |

热启动时的无效链接也做了检查（23:35:14Z–23:35:45Z）：空 reviewId/sessionId（这是脚本变量为空时意外产生的畸形链接）、空 baseline、路径不存在。三次都没有打开仓库，没有新增进程，Git 也没有变化。

由此可以确认，无效来源不会打开仓库，也不会回退主检出。“不进入工作台”的界面表现、本地错误提示和发给 Cliora 的 rejected 回执都**未验证**。

### S4 意见交接预览（“已准备 / 等待确认”）—— 未验证

这个场景需要在界面上写意见、打开交接预览并看文案，锁屏且没有辅助功能权限时无法完成。

### S5 普通返回 —— 未验证

这个场景需要点击完成栏的“返回 Cliora”，并在 Cliora 原会话中查看结果，无法自动驱动。

### S6 提交后返回、合入后返回（返回声明与真实 HEAD 一致）—— 未验证

返回声明只能由 Twiglane 界面发起。即使能用 Git CLI 提交，也无法产生返回事件，Cliora 一侧也无法观察，因此本轮没有做提交或合入。

### S7 Cliora 发起的审查（真实 Cliora → Twiglane 链路）—— 未验证

这个场景需要在 Cliora 工作台中操作。

## 校验器场景覆盖（`scripts/verify-cliora-integration.mjs`）

14 个场景中，没有一个达到校验器要求的完整实机记录：两端安装、Cliora 侧观察和返回闭环都缺。`cold-start-review` 与 `invalid-links` 只完成了 Twiglane 接收一侧，其余场景均未运行。因此本轮**不改写** `cliora-integration.json`。

## 清理与恢复

- 23:36:5xZ 结束候选进程。
- 恢复 `state.json`：测试前已备份，SHA-256 为 `ad6a8c47b365bbd1add15521724d47e28e11871b7e8c115824de405cc60550ce`。备份与测试后文件相比只有 `recent` 不同，即多出两个临时仓库。已用备份原样还原，SHA-256 一致。
- 执行 `lsregister -f /Applications/Twiglane.app` 恢复正式版注册，再用 `lsregister -u` 注销候选构建路径。`lsregister -dump` 中已经没有候选路径；`/Volumes/…` 下的历史条目不是本轮产生的，没有处理。
- 23:37:04Z 重新启动 `/Applications/Twiglane.app`（pid 98905），恢复用户原本运行中的 Twiglane。
- 临时仓库 `/private/tmp/t7-dualend.O4tW/` 保留供复查，不含任何凭据。

## 待人工补测（建议在解锁的图形会话中进行）

1. 由 Cliora 0.4.183 工作台发起冷启动和热启动审查，截取 Twiglane 审查工作台的界面，并在 Cliora 侧确认 accepted 状态。
2. 在差异中写意见，打开交接预览，确认只显示“已准备 / 等待确认”。
3. 测试普通返回、本地提交后返回、合入后返回，在 Cliora 中核对返回 OID 与 `git rev-parse HEAD` 一致。
4. 对无效来源截图，确认没有进入工作台并出现本地错误提示；在 Cliora 中确认 rejected 回执。
5. 复测 S2 中第一次热启动未生效的情况。
6. Windows、Linux 实机测试。
