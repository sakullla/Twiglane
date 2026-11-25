# 审查界面重设计：浏览器 mock 证据（T6）

**性质：mock。** 本目录全部来自 Chrome headless + `scripts/ui-preview` mock API（含 mock 深链、mock 回执、mock 意见交接与返回）。
它只证明界面接线、状态、文案、键鼠可达性与布局；**不代表**真实 Git、Tauri 桌面 WebView、安装包、系统 scheme 路由或 Cliora 实机联动。
`manifest.json` 与 `report.json` 都写了 `"nature": "mock"`，runner 会校验 manifest 的这个标注。实机双端结果另行记录，不与本目录混用。

## 复跑

```bash
node scripts/run-ui-verification.mjs --workflow 2026-11-25-cliora-review-ui-ux-redesign --task T6 --out docs/verification/cliora-review-ui-redesign/ui
```

本次：场景 61/61 通过，截图 38 张（审查 12、失败态 14、对照 7、项目 4、Markdown 1），平台 macOS arm64，浏览器与时间见 `manifest.json` / `report.json`。

## 审查场景（`check-scenarios.mjs` 中「审查：」一组，CDP 真实键鼠）

| 场景 | 窗口 | 核对要点 |
|---|---|---|
| 有效进入 | 1280×840 | 来源卡「刚刚接受」、8 个任务文件、完成栏返回；读取过程按帧采样，完成栏/主区不跳，不闪「没有任务范围」 |
| 无起点 | 900×600 | 整页说明不用 HEAD 补缺，给出「查看普通历史 / 返回 Cliora」 |
| 空任务 | 1280×840 | 说明没有净改动，完成栏仍可返回 |
| 读取失败 | 900×600 | alert + 错误码详情；点「重新读取」期间完成栏、差异区上沿与宽度不变 |
| 纯键盘连续审阅 | 1280×840 | Tab 走 40 个控件全部焦点可见；↓ 进队列、Alt+M、Alt+Shift+→、Alt+Shift+M、空格整文件暂存 |
| 原位意见增改删 | 1280×840 | 行标记 → 编辑器 → 添加；线程内编辑并 ⌘/Ctrl+Enter 保存；删除后完成栏回到「没有待送回的意见」 |
| 意见失效 | 1280×840 | 队列里空格暂存使读取代次前进，旧意见整体进「已失效」分区，完成栏警告且不再提供送回 |
| 交接成功 | 1280×840 | 只显示「已准备 1 条意见，已打开 Cliora 等待确认」，深链里没有意见正文 |
| 交接失败 | 900×600 | 错误分项 +「重试送回 1 条意见」，意见标记保留，没有生成交接深链 |
| 返回：committed + dirty | 1280×840 | 提交区提交后回到审查返回：「已提交 abcdef1（待复核）」与「工作区还有 N 个未提交的改动」分项，回送 outcome=committed、worktreeState=dirty |
| 返回：unknown | 900×600 | 「没有读到工作区状态（按未知处理）」，不说成干净 |
| 多来源切换 | 1280×840 | 两个来源的最新/较早标签，切到附属 worktree 再切回，各自阅读进度保留，Esc 收起菜单并归还焦点 |
| 含意见关闭保护 | 1280×840 | 关闭前确认列出 1 条未送回意见与复制入口；Esc 取消后意见仍在，确认后不自动切到别的来源 |

每个审查场景都核对页面没有横向溢出（`scrollWidth ≤ innerWidth + 1`）。

## 截图（`after/`）

- `review`、`review-comment`（原位意见编辑展开态）、`review-sources`（多来源菜单）：深浅 × 1280×840 / 900×600 各一张。
- 失败态 `review-error`（读取失败）、`review-feedback-error`（交接失败）：四种组合各一张；`review-return-unknown`：深色两种尺寸。
- 其余为既有对照、Markdown、失败态与项目图，与审查无关的部分保持原口径。
