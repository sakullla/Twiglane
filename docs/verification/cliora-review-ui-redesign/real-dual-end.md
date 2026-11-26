# Cliora 审查界面重设计：真实双端联动记录（T7）

本记录只收实机结果：已安装的 Twiglane 候选构建、已安装的 Cliora、本机真实 Git 仓库，并用系统截图留证。mock、单元测试和“构建成功”都不能替代这里的任何结论。T6 的设计 mock 截图在 `ui/`，与本文件无关。

- 第三轮（T7-A3，2026-11-26 07:56–08:18 本地 / UTC 2026-11-25T23:56Z–2026-11-26T00:18Z）：屏幕已解锁，有截图和辅助功能权限，由无人值守 agent 用系统级鼠标/键盘事件实际操作 Twiglane 与 Cliora 界面。截图在 `real/`。
- 第一、二轮（T7-A1/A2，屏幕锁定）只验证了深链接收和 Git 安全，没有截图；结论见文末“历史记录”，已被本轮复测覆盖。

## 结论

**R9 要求的 macOS 实机双端场景，本轮都在真实 Cliora ↔ 真实 Twiglane 候选之间跑通并截图：**

| 清单项 | 结果 | 证据 |
|---|---|---|
| 1 冷启动（Cliora 发起） | 通过 | S1 |
| 2 热启动（已打开另一仓库）＋ S2 疑似缺陷复测 | 通过；疑似缺陷已定位为“未保存编辑确认框”这一设计路径，不是丢链接 | S2、S2b |
| 3 意见交接预览只显示“已准备 / 等待确认” | 通过 | S3 |
| 4 普通返回 | 通过；Cliora 复核结果与 `git rev-parse HEAD`、未提交文件数一致 | S4 |
| 5 提交后返回 | 通过；返回 OID = 提交后 HEAD | S5 |
| 6 合入后返回 | 通过；返回 OID = 合入后 HEAD | S6 |
| 7 无效来源 | 本地错误提示、不切换工作台、Git 不回退：通过。Cliora 侧 rejected 回执：通过真实取消路径观察到；路径/版本类无效链接无法由 Cliora 发起，未在 Cliora 侧观察 | S7、S2b |
| 8 `cliora-integration.json` 与校验器 | **未做**：校验器 14 个场景中仍有多项没有实机运行（见“校验器场景覆盖”），按要求不改写该文件、不运行校验器产出通过证据 | — |
| 9 Windows、Linux | **未运行**；本记录只代表 macOS 27.0 arm64 | — |

R8“深链失败时不展示伪成功”的界面部分，本轮实机确认：所有无效链接都只出现本地错误提示，当前来源和工作台不变；用户取消时 Twiglane 回送 rejected，Cliora 显示红色“没有打开这个工作区”，没有出现“已打开/可以开始审查”。

本轮发现 2 个 Twiglane 侧疑似缺陷（不影响交接/返回声明的正确性）和 3 条 Cliora 侧观察，见“发现的问题”。本轮没有改动任何源码。

**限制**：只在 macOS 27.0 arm64 实测；Windows/Linux 未运行；校验器要求的 14 个场景没有全部实机完成，`docs/verification/cliora-integration.json` 仍是 2026-11-07 的 Windows 历史记录，不代表本候选。

## 环境

| 项 | 值 |
|---|---|
| 平台 | macOS 27.0（26A428），arm64，已解锁的图形会话 |
| Twiglane 候选 | 0.3.49；`~/.cache/cargo-target/release/bundle/macos/Twiglane.app`，可执行文件 SHA-256 `bfaccea69716d587ccbb60d3e4b7b2d2ee9082ef233b07afd1d1ea9b9bf9f704`。该构建出自 `3e31400`；当前 HEAD `eb98daf3f2f151a5ad7bb97a1b72fe9edfaaf848` 与它相比只多了本文档（`git diff --stat 3e31400 HEAD` 只有 `real-dual-end.md`），所以没有重新构建。ad-hoc 签名，未公证 |
| 用户已安装 Twiglane | `/Applications/Twiglane.app` 0.3.49 正式版；未覆盖、未删除 |
| Cliora | `/Applications/Cliora.app` 0.4.183（可执行文件 SHA-256 `62765a27…09cd`），全程运行，没有退出或重启，也没有修改设置和仓库 |
| Git 仓库 | `/private/tmp/t7-dualend.O4tW/repo`（main，起点 `39f61ad70b60c086d3abcfff6d6c3f52b57b5185`；本轮先用 Git 管道命令另建 `feature` 分支 `e7ecc12`，供合入场景使用，没有动工作区）、`repo2`（main，`8f72d4e79ce4f0f805338dddf58776f7004f416a`）、`notrepo`（普通目录）、`missing`（不存在）。没有远端，也没有推送 |
| Cliora 会话 | 只为临时仓库新建了两个 Codex“普通”模式会话（`repo`、`repo2`），没有给初始提示词；Codex 一直停在 “Trust this folder?” 提示，没有任何输入，所以没有调用模型。测试结束后，用 Cliora 的“结束 → 结束进程”关闭了这两个会话。用户的“π Twiglane”和“OC \| Native Rust k…”两个会话没有被输入任何内容，也没有被关闭或中断 |
| 操作方式 | 用 CGEvent 发送鼠标点击和 Unicode 键盘事件，用 System Events 激活窗口、发送 Esc/⌘↩；截图用 `screencapture -R` 只截 Twiglane 或 Cliora 窗口区域，Cliora 侧尽量只截审查菜单 |

### 链接路由（影响复现）

本机有多个相同 bundle id（`app.twiglane.desktop`）的 Twiglane 副本，`/Applications/Twiglane.app` 优先，并会被 LaunchServices 自动重新注册。

- **一次作废的尝试**：23:59:51Z，Cliora 第一次“在 Twiglane 中审查”时，系统启动的是 `/Applications` 的 0.3.49 正式版（pid 9527）。它打开了 repo，并且很可能回送了 accepted，随后被结束。这次尝试**不计入候选结论**；它写入 state.json 的内容已经按备份还原。
- **冷启动的做法**：结束所有 Twiglane，执行 `lsregister -u /Applications/Twiglane.app`，并用 `NSWorkspace.urlForApplication(toOpen:)` 确认 `twiglane://` 指向候选，然后立刻在 Cliora 里点击发起。实际启动的进程是候选（pid 10146）。
- **热启动的做法**：候选已经运行时，系统把 URL 交给正在运行的候选，不会另起进程；每次都用 `pgrep` 核对。

## 场景记录

所有时间均为 UTC。HEAD 一律用 `git rev-parse HEAD` 读取。

### S1 冷启动（Cliora 发起）—— 通过

- 00:01:51Z：Twiglane 没有运行。在 Cliora 的 `repo` 会话中点击 Git 分支菜单 →“在 Twiglane 中审查”。
- 2 秒内候选进程 pid 10146 启动。Twiglane 直接进入顶部的“审查”视图，显示任务净差异：起点 `39f61ad` → main `39f61ad` + 未提交改动，3 个文件，并选中第一个文件 `review.txt`。来源卡显示“独立仓库 · repo / 刚刚接受”，底部完成栏显示“没有待送回的意见 · 本次没有提交或合入 · 工作区还有 3 个未提交的改动”。
- Cliora 的审查菜单显示绿色的“Twiglane 已打开这个工作区，可以开始审查。”。这一条属于本次新发起的 reviewId：如果没有收到新的 accepted，按协议这里应显示“正在等待 Twiglane 确认…”，或在 10 秒后显示“打开结果未知”。
- 截图：`real/01-cold-start-twiglane-workbench.png`、`real/01-cold-start-cliora-accepted.png`

### S2 热启动（另一个仓库已打开）＋ 疑似缺陷复测 —— 通过

- 00:09:47Z：为 `repo2` 新建 Cliora 会话，并在会话启动后给 `f.txt` 追加一行。
- 00:10:17Z：候选 pid 10146 正在运行，当前打开的是 **repo**，没有未保存的编辑。在 `repo2` 会话中点击“在 Twiglane 中审查”（这是一个新 reviewId）。
- 没有新增进程。8 秒内 Twiglane 切换到 repo2，显示审查视图：起点 `8f72d4e`，1 个文件，`f.txt` +2。来源卡显示“最新发起 · 刚刚接受 · 共 2 个来源”。来源菜单列出 repo2（当前、最新发起、已审阅 0/1）和 repo（较早发起、8 分钟前），并提供“关闭 / 关闭此审查来源 / 关闭全部来源”。Cliora 的 repo2 会话显示“Twiglane 已打开这个工作区，可以开始审查。”。
- 截图：`real/02-hot-start-twiglane-repo2-8s.png`、`real/02-hot-start-twiglane-source-menu.png`、`real/02-hot-start-cliora-accepted.png`

**S2b：疑似缺陷的定位（`confirmEditorLeave` 路径）**

- 00:12:19Z：Twiglane 在 repo2 的文件编辑器里有未保存修改（第 4 行键入 `unsaved-draft`，没有保存）。此时在 Cliora 的 `repo` 会话中再次点击“在 Twiglane 中审查”（又一个新 reviewId，目标是另一个工作树）。
- Twiglane 弹出“有未保存的编辑：按 cliora 审查链接打开另一个工作区之前，先处理这些文件里还没保存的修改（f.txt）”，提供“取消 / 放弃修改 / 保存”。用户处理之前，链接**一直挂起**，不会打开 repo；15 秒时仍是这个状态。
- 00:12:52Z：点击“取消”。Twiglane 显示“已保留未保存的编辑草稿，没有打开 cliora 审查链接。”，编辑器内容保持不变，磁盘文件没有被写入。Cliora 的 repo 会话变成红色的“Twiglane 没有打开这个工作区 · 系统没有接受打开请求。”，并提供“重新发起审查”，说明真实收到了 rejected 回执。之后在 Twiglane 中“放弃修改 → 确认放弃”，清掉了草稿。
- 结论：第一轮 S2 中 R3 未打开 repo2 的现象，与这条设计内的等待路径一致。锁屏时，确认框或其他模态框会让链接一直挂起，没有人能处理。本轮解锁后，在“已打开另一仓库、没有草稿”的条件下用新 reviewId 复测，8 秒内就打开了；有草稿时则按设计弹出确认框，且没有静默丢弃。**不再判为缺陷**。不过第一轮锁屏时到底是哪一种模态框，已经无法回溯。
- 截图：`real/02b-hot-start-unsaved-draft-confirm.png`、`real/02b-cancel-twiglane-local-notice.png`、`real/02b-cancel-cliora-rejected.png`

### S3 原位意见与交接预览（“已准备 / 等待确认”）—— 通过

- 00:03–00:04Z，在 repo 的审查工作台中：
  1. 在差异行 `+ B changed`（新增第 2 行）右侧点击意见按钮，编辑器在该行下方展开，显示引用“B changed”和提示“⌘Enter 保存 · Esc 取消 · 只存在本窗口，不会自动发送”。
  2. 输入“T7 实机意见：请把 B changed 改回小写 b。”，按 ⌘↩ 保存。界面提示“已添加意见：review.txt（新增第 2 行）。只存在本窗口，没有发送。”，“有意见 1”“意见 1”计数随之更新，完成栏出现“送回 1 条意见”。
  3. 00:04:36Z 点击“送回 1 条意见”。Twiglane 提示“已准备 1 条意见（批次 05d1396d）。到 Cliora 里确认预览后再发送，这里没有发送任何内容。”，完成栏显示“已准备 1 条意见，已打开 Cliora 等待确认”。
- Cliora 原会话顶部出现“Twiglane 审阅意见”预览：“来自审查 0d9e09d1 · 第 0 次结果 · 1 条”，内容为 `review.txt:2 add` 和意见正文，并说明“当前终端界面没有可输入提示框，先打开终端并复制意见，再手动确认发送。”，只提供“复制意见 / 关闭预览”。Codex 终端没有收到任何输入。
- 两端都没有出现“已发送给 Agent / 已执行 / 修复完成 / 批准”之类的伪成功文案。
- 截图：`real/03-inline-comment-saved.png`、`real/03-feedback-prepared-twiglane.png`、`real/03-feedback-preview-cliora.png`（只截右侧会话面板）

### S4 普通返回 —— 通过

- 00:05:11Z：HEAD `39f61ad70b60c086d3abcfff6d6c3f52b57b5185`；`git status --porcelain` 有 3 项（` M review.txt`、`?? added.txt`、`?? long.txt`）。点击完成栏中的“返回 Cliora”。
- Twiglane 显示“已返回 cliora：本次没有提交或合入，工作区还有 3 个未提交的改动。”，完成栏显示“已返回 Cliora（第 1 次），结果待 Cliora 复核”。
- Cliora 原会话顶部横幅和审查菜单都显示“这次没有提交或合入；工作区有 3 个未提交文件。”，菜单头为 `main · 39f61ad`，与真实 HEAD 和未提交文件数一致。会话进入“待审阅”分组。
- 截图：`real/04-normal-return-twiglane.png`、`real/04-normal-return-cliora.png`

### S5 提交后返回 —— 通过

- 00:06:32Z：在 Twiglane 的“改动”视图中暂存 `review.txt` 和 `long.txt`，`added.txt` 保持未跟踪。输入提交说明 `test: T7 commit-and-return`，按 ⌘↩ 提交。
- 提交后 `git rev-parse HEAD` 为 `304f8641ea253fd2b92abdd3b939468cfc719a1c`，未提交 1 项（`?? added.txt`）。审查视图显示“范围内提交 1”“已提交 304f864（待复核）”；原意见显示“1 条意见已失效，不会送回”。
- 00:07:04Z：点击“返回 Cliora”。Twiglane 显示“已返回 cliora：提交或合入结果以待复核声明发送，工作区还有 1 个未提交的改动。”，完成栏显示“已返回 Cliora（第 2 次）”。
- Cliora 显示“Twiglane 已提交 304f864；工作区仍有 1 个未提交文件。”，菜单头为 `main · 304f864`，与真实 HEAD 一致。
- 截图：`real/05-commit-twiglane-before-return.png`、`real/05-commit-return-twiglane.png`、`real/05-commit-return-cliora.png`

### S6 合入后返回 —— 通过

- 00:08:06Z：在 Twiglane 中打开分支菜单 →“合并到当前分支”，来源选 `feature`，目标 `main`。界面显示“可以合并，没有冲突”，方式为“创建合并提交”，点击“合并到 main”。完成页显示“已把 feature 合并到 main · 合并提交 685ea2a · 推送：这个分支还没有发布到远程”。
- `git rev-parse HEAD` 为 `685ea2aa4372884e5cfee36c694500c4acef1904`，它是一个合并提交，父提交为 `304f864` 和 `e7ecc12`；未提交 1 项。审查视图显示“已合入 685ea2a（待复核）”，范围内提交 3 个，文件 4 个（新增 `feature.txt`）。
- 00:08:42Z：点击“返回 Cliora”。Twiglane 显示“已返回 Cliora（第 3 次）”。Cliora 显示“Twiglane 已合入 685ea2a；工作区仍有 1 个未提交文件。”，菜单头为 `main · 685ea2a`，与真实 HEAD 一致。
- 截图：`real/06-merge-twiglane-done.png`、`real/06-merge-return-twiglane.png`、`real/06-merge-return-cliora.png`

### S7 无效来源 —— 本地提示与 Git 安全：通过；Cliora 侧 rejected 见 S2b

00:13:57Z–00:14:25Z：候选正在运行，当前来源是 repo2 的审查工作台。用 `open "twiglane://…"` 依次送入下列无效链接（reviewId 和 sessionId 均为新生成的 UUID），每条在 1.8 秒时截图，7 秒后核对进程和 HEAD：

| 用例 | Twiglane 本地提示 | 工作台 | Git |
|---|---|---|---|
| `v=1` | 支持 v2/v3 审查链接，请把 Twiglane 和 cliora 升级到同一协议版本。 | 停留在 repo2，来源不变 | repo `685ea2a`、repo2 `8f72d4e` 均未变 |
| 相对路径 `worktreePath=repo2` | 审查链接里的工作树路径不是绝对路径。 | 同上 | 未变 |
| 路径不存在 | 无法解析路径，未修改文件。No such file or directory (os error 2) | 同上 | 未变 |
| 非仓库目录 | 该目录不是 Git 仓库，未做任何修改。 | 同上 | 未变 |
| 非法 baseline `abc` | baseline 不是完整的提交标识，未做任何修改。 | 同上 | 未变 |

- 进程始终只有候选 pid 10146，没有切换仓库，也没有回退主检出。
- 这些链接是手工构造的，Cliora 不认识其中的 reviewId，因此无法在 Cliora 侧把它们对应到“rejected 回执”。在 Cliora 中，由会话发起的路径/版本类无效来源无法自然产生：Cliora 会先在本地校验目录。本轮 Cliora 侧唯一真实观察到的 rejected 来自 S2b 的“用户取消”。
- 截图：`real/07-invalid-v1.png`、`real/07-invalid-relative.png`、`real/07-invalid-missing.png`、`real/07-invalid-notrepo.png`、`real/07-invalid-badbaseline.png`

## 发现的问题（未改源码）

### Twiglane 侧疑似缺陷

1. **上一来源的“已准备意见”提示泄漏到新来源。**
   - 复现：在来源 A（repo）中送回 1 条意见，得到“已准备 1 条意见（批次 05d1396d）…”；再从 Cliora 对另一个仓库发起来源 B（repo2）并热启动切换。
   - 现象：B 的审查工作台顶部仍然显示 A 的“已准备 1 条意见（批次 05d1396d）。到 Cliora 里确认预览后再发送…”，而 B 的“有意见”为 0。见 `real/02-hot-start-twiglane-repo2-8s.png`、`real/07-*.png`。
   - 预期：这类按来源生成的交接提示只在对应来源中显示（R7 来源隔离）。
   - 影响：只是展示，不会把 A 的意见发给 B。但用户可能误以为 B 也有待确认的意见。
2. **提交后到返回之前，完成栏的工作区状态不是最新的。**
   - 复现：S4 普通返回后（当时工作区有 3 个未提交改动），在 Twiglane 中提交 2 个文件，再回到审查视图。
   - 现象：真实未提交项只剩 1 个，顶部“改动 1”也正确，但完成栏仍显示“工作区还有 3 个未提交的改动”，直到再次“返回 Cliora”后才变成 1。见 `real/05-commit-twiglane-before-return.png`。
   - 预期：这一项要么反映当前工作区，要么明确标注为“上次返回时”的状态。
   - 影响：返回声明本身正确（Cliora 复核为 1），只是返回前的展示有误导。

### 其他观察（非缺陷或不在本仓库范围内）

- 路径不存在时，提示里直接带出英文 OS 错误“No such file or directory (os error 2)”，和其他用例的中文提示不一致（UX 细节）。
- Cliora：用户在 Twiglane 中取消（Twiglane 回送 `open_failed`）时，Cliora 显示的是“系统没有接受打开请求”，并不准确，因为实际原因是用户在 Twiglane 中取消。这是 Cliora 的文案，不在本仓库范围内。
- Cliora：S7 手工链接之后，Cliora 当前会话出现横幅“原 cliora 审查会话已失效，无法返回”。推测这是 Twiglane 对不存在路径、非仓库目录（格式合法的 UUID）回送的 rejected，被 Cliora 当成未知会话事件展示出来。这一点未进一步验证，也不在本仓库范围内。
- 作废的路由尝试（见“链接路由”）说明：本机同时装有正式版和候选时，Cliora 交给系统的链接会优先打开 `/Applications` 中的正式版。这是测试环境问题，不是候选的结论。

## 校验器场景覆盖（`scripts/verify-cliora-integration.mjs`）

本轮实机覆盖或部分覆盖的场景如下：

- `cold-start-review`：S1，已覆盖。
- `commit-and-return`：S5，已覆盖。
- `merge-and-stale-head`：只覆盖了合入复核（S6）；“返回后 HEAD 变化显示未确认”没有测。
- `invalid-links`：只覆盖了路径失效和无效协议（S7）；旧 reviewId、原会话失效、未注册 handler 都没有专门测。
- `multi-source-switchback` / `same-checkout-source-selection`：只看到双来源列表（S2），没有验证 A→B→A 的基线和草稿保留，也没有验证结果只进入选中来源。

完全没有运行的场景：`project-prompt-review-return`、`source-capacity-and-expiry`、`v2-source-roundtrip`、`result-revision-order`、`standalone-repository`、`light-edit-return`、`extension-and-version-mismatch`、`return-fix-and-re-review`。

因此本轮**不改写** `docs/verification/cliora-integration.json`，也**不运行**校验器生成通过证据。

## 清理与恢复

- 00:16–00:17Z：在 Cliora 中关闭本轮新建的 `repo`、`repo2` 会话（结束 → 结束进程），关闭意见预览和横幅，并把选中会话切回用户原来的“π”会话。
- 00:18:04Z：退出候选 Twiglane。将 `state.json` 按测试前备份还原，SHA-256 为 `ad6a8c47b365bbd1add15521724d47e28e11871b7e8c115824de405cc60550ce`，与测试前一致。执行 `lsregister -f /Applications/Twiglane.app`，并执行 `lsregister -u` 注销候选路径；确认 `twiglane://` 处理程序只剩 `/Applications/Twiglane.app`。随后重新启动 `/Applications/Twiglane.app`（pid 15934），恢复用户测试前正在运行的 Twiglane，并恢复测试前的剪贴板文本。
- 临时仓库 `/private/tmp/t7-dualend.O4tW/` 保留，供复查；其中不含凭据。本轮产生的 `repo` 提交 `304f864`、合并 `685ea2a`、`feature` 分支以及 `repo2/f.txt` 的改动只存在于这个临时目录。

## 历史记录（T7-A1/A2，屏幕锁定，已被本轮覆盖）

- 2026-11-26 07:27–07:37（本地）的第一轮在锁屏会话中进行，没有截图，也没有辅助功能权限，只验证了 Twiglane 接收深链的一侧：冷启动、热启动、重复 reviewId 只处理一次、6 类无效链接不打开仓库且 Git 不变。判断依据是 `state.json` 中 `recent[]` 的变化和 `git` 状态。当时第一个候选实例收到 repo2 的新 reviewId（R3 `805cc181-…`）后约 32 秒都没有打开仓库，被列为疑似缺陷；本轮 S2/S2b 已复测并定位到设计内的确认框等待路径。
- 07:47（本地），T7-A2 复查时屏幕仍然锁定，只修正了文档。
