# AI 编码界面与交互验证（2026-11-09 批次，T6）

本目录是工作流 `2026-11-09-ai-coding-ui-ux` 的 T6（隔离正式 UI 验证输出并修复既有 Markdown 文件预览场景）实际运行产物。
**这里的全部结论都只覆盖「Chrome headless + mock 数据」**，不代表真实 Git 行为、桌面 WebView、安装包或其它平台。

## 一键复跑

```bash
# 正式验证：默认写操作系统临时目录，不改写候选输入
node scripts/run-ui-verification.mjs

# 归档证据：只有显式 --out 才写本目录
node scripts/run-ui-verification.mjs --out docs/verification/ai-coding-ui-ux-2026-11-09
```

顺序是：确认 1430 空闲 → 用 `scripts/ui-preview/vite.config.mjs` 起 mock 预览 → 轮询
`/__ui-preview/health` 直到 `mockApi: true` → 跑 `check-scenarios.mjs`（33 个场景）→
跑 `baseline-shots.mjs`（两主题 × 1280×840/900×600 + 失败态）→ 写 `report.json`。

runner 对证据的要求（任一不满足即输出 `failed` 并以非 0 退出）：

- 场景与截图两个子进程的退出码都必须是 0；
- 场景数必须大于 0，失败场景必须为 0；
- `manifest.json` 必须是本次运行新写出的（`capturedAt` 不早于运行开始），且 `workflow` 等于 `2026-11-09-ai-coding-ui-ux`；
- manifest 里逐张登记的截图文件必须真的存在。

## 本次实际结果

| 项目 | 结果 |
| --- | --- |
| 健康端点 | `mockApi: true`，`resolvedApi: scripts/ui-preview/mock-api.ts` |
| 场景自检 | **33 / 33 通过**（原 3 个 Markdown 场景已真实修复，见下） |
| 截图 | **84 张**：对照 32（`group: "baseline"`）、Markdown 8、失败/未知状态 44（`group: "failure"`） |
| manifest | `workflow: 2026-11-09-ai-coding-ui-ux`、`task: T6`、`skipped: []`（没有跳过项） |
| 对比度门禁 | `node scripts/check-contrast.mjs` 通过（1454 对，正文最低 4.59:1，交互最低 3.16:1） |
| 环境 | Windows x64、Node v26.4.0、Chrome 157.0.8103.38（DevTools 协议驱动，headless） |

逐张清单与 sha256 见 `manifest.json`；本次汇总（含子进程退出码、失败原因与限制）见 `report.json`。
84 张 = 8 个视图 × 2 主题 × 2 尺寸（32）+ 2 个 Markdown 样例 × 4 组合（8）+ 11 类失败态 × 4 组合（44）。
上一批的 80 张缺的正是 `files-markdown-toc` 的 4 张：文件视图没有目录开关时脚本只登记跳过原因，
本次修复后这个入口真实存在，4 张目录图按现场采集，不用旧图补齐。

### 同数据对照（`group: "baseline"`，两主题 × 两个尺寸，各 8 张 = 32 张）

起始页 `start`、改动 `changes`、历史 `history`、任务 `task`、工作区总览 `worktree`、
提交区 `composer`、合并弹窗 `merge`、设置 `settings`。命名是 `<theme>-<size>-<view>.png`，
四种组合都能同数据横向比较（1280×840 / 900×600 × dark / light）。

### Markdown 阅读（`group: "markdown"`，4 组合 × 2 张 = 8 张）

- `files-markdown`：默认排版预览（含远程图片「尚未加载」提示、本地图片加载入口）；
- `files-markdown-toc`：目录工具行展开后的中文重复标题目录。

### 失败与恢复（`group: "failure"`，11 类 × 4 组合 = 44 张）

远程未核对、远程过期、提交被钩子拒绝、本地提交成功推送失败、文档读取失败、文档超限、
树过滤/全仓搜索/文件内查找失败、`task-error`（任务起点不是当前分支的祖先）、
`history-cancel-recovered`（用户报告的挂起路径：最新两条提交详情永不返回，换一批更早的提交后加载结束）。

## 本次修复：文件视图的 Markdown 排版预览

上一批剩下的 3 个失败场景都出在文件视图的排版预览上，不是测试预期问题：

| 场景 | 现场缺口 | 修复 |
| --- | --- | --- |
| `Markdown 默认排版预览` | 文件视图给 `DocumentReader` 传 `header={false}`，页面上没有 `.doc-source`/`.doc-path` 来源标识 | 底部状态条补 `.doc-source`（工作区）与 `.doc-path`（当前路径），不另起一行 |
| `目录列出中文重复标题且各自可辨` | 目录入口是文件工具条上的私有类按钮，阅读器的目录控件（`.md-small-button`）在预览里被关掉 | 目录入口改用阅读器同一套控件外观（`.md-small-button`），仍放在工具条上，展开后由阅读器渲染 `.md-outline` |
| `相对链接留在同一阅读器打开目标` | 同上缺 `.doc-path`，跳到目标文档后界面没有可核对的当前路径 | 与上一条同一处来源标识；相对链接仍走 `onFollow` → 文件树定位 → 同一阅读器打开 |

修复不含任何测试预期改动，也没有删除场景；`tests/file-content.spec.ts` 补了来源标识与目录控件的回归断言。

## 其它门禁（本次实际运行）

| 命令 | 结果 |
| --- | --- |
| `npm test` | 见下方「验证记录」 |
| `npm run check`（svelte-check） | 见下方「验证记录」 |
| `npm run build` | 见下方「验证记录」 |
| `node scripts/check-contrast.mjs` | 通过（1454 对；正文最低 4.59:1、交互最低 3.16:1） |

## 键鼠闭环（真实 DOM 键鼠）

`check-scenarios.mjs` 的键鼠场景用 CDP `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent` /
`Input.insertText` 发真实输入，不是 `element.click()`，也不是直接改 `value`：任务打开与连续审阅
（`Alt+M` / `Alt+Shift+→`）、空格整文件暂存、提交区提交并回到提交区、历史换选择后的加载结束，
以及工作区总览的分组/未知/缺失/过期。

关于「返回 Cliora」：mock 预览不注册系统深链协议，无法在浏览器里伪造一条真实 Cliora 链接，
因此浏览器脚本覆盖的是同一段落里可达的「回到提交区」返回路径；Cliora 深链往返由
`tests/cliora-integration.spec.ts`（组件级）与 `scripts/verify-cliora-integration.mjs`（真实 Git）分别覆盖，
本目录不声称浏览器证据等于深链闭环。

## 边界

- 只证明「浏览器 + mock」。真实 Git 的净差异、token、写入保护由 Rust 夹具（`cargo test`）与
  `scripts/verify-delivery.mjs` 覆盖；桌面 WebView、安装包、macOS/Linux 行为本次未运行。
- 临时目录运行的结果写在系统临时目录并由 `report.json` 记录路径；它不进入候选，也不改写本归档。
- 归档只由显式 `--out` 写入，并与 `manifest.json` 的 sha256 一一对应。
