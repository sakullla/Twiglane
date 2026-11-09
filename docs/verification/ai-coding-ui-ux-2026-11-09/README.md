# AI 编码界面与交互验证（2026-11-09 批次，T5）

本目录是 T5（跨视图键盘、视觉、失败恢复与可复跑 UI 证据）的实际运行产物。
**这里的全部结论都只覆盖「Chrome headless + mock 数据」**，不代表真实 Git 行为、桌面 WebView、安装包或其它平台。

## 一键复跑

```bash
node scripts/run-ui-verification.mjs
```

顺序是：确认 1430 空闲 → 用 `scripts/ui-preview/vite.config.mjs` 起 mock 预览 → 轮询
`/__ui-preview/health` 直到 `mockApi: true` → 跑 `check-scenarios.mjs`（33 个场景）→
跑 `baseline-shots.mjs`（两主题 × 1280×840/900×600 + 失败态）→ 写 `report.json`。
任一步失败都以非 0 退出，并把失败原因写进 `report.json`；不会用旧图或合成分补上没采集到的对照。

## 本次实际结果

| 项目 | 结果 |
| --- | --- |
| 健康端点 | `mockApi: true`，`resolvedApi: scripts/ui-preview/mock-api.ts` |
| 场景自检 | **30 / 33 通过**（失败 3 个，全部是既有的 Markdown 目录/远程图片场景，见下） |
| 截图 | **80 张**：对照 32（`group: "baseline"`）、Markdown 4、失败/未知状态 44（`group: "failure"`） |
| 对比度门禁 | `node scripts/check-contrast.mjs` 通过（1454 对，正文最低 4.59:1，交互最低 3.16:1） |
| 环境 | Windows x64、Node v26.4.0、Chrome 157.0.8103.38（DevTools 协议驱动，headless） |

逐张清单与 sha256 见 `manifest.json`；本次汇总（含失败场景与限制）见 `report.json`。

### 同数据对照（`group: "baseline"`，两主题 × 两个尺寸，各 8 张 = 32 张）

起始页 `start`、改动 `changes`、历史 `history`、**任务 `task`**、**工作区总览 `worktree`**、
**提交区 `composer`**、合并弹窗 `merge`、设置 `settings`。命名是 `<theme>-<size>-<view>.png`，
四种组合都能同数据横向比较（1280×840 / 900×600 × dark / light）。

### 失败与恢复（`group: "failure"`，44 张）

原有 7 类：远程未核对、远程过期、提交被钩子拒绝、本地提交成功推送失败、文档读取失败、文档超限、树过滤/全仓搜索/文件内查找失败。
本次新增 2 类：

- `task-error`：任务起点不是当前分支的祖先——任务页就地说明并给出「重新读取 / 重选起点」，不摆出上一次的结果；
- `history-cancel-recovered`：**用户报告的挂起路径**——最新的两条提交详情永不返回，换一批更早的提交后
  加载结束、文件队列与差异块都在（修复前这里会一直停在「正在读取所选提交的详情」）。

### 跳过项（manifest `skipped`）

`files-markdown-toc`（4 次）：当前文件视图的 Markdown 预览不渲染工具行（`showTools=false`），
没有目录开关可点。脚本记录跳过原因而不是伪造一张目录图；这是既有差异，不是本次改动引入。

## 其它门禁（本次实际运行）

| 命令 | 结果 |
| --- | --- |
| `npm run check`（svelte-check） | 0 errors / 0 warnings |
| `npm test` | 51 个文件、1281 个用例全部通过（连续两次完整运行；过程中有一次 `tests/app-shell.spec.ts` 的「左栏头部切换视图…」在 1s 懒加载等待上超时，单独重跑与随后两次全量都通过，判为既有时间抖动，未用重跑掩盖失败） |
| `npm run build` | 通过（vite build，exit 0） |
| `node scripts/check-contrast.mjs` | 通过（1454 对；正文最低 4.59:1、交互最低 3.16:1） |

## 键鼠闭环（真实 DOM 键鼠）

`check-scenarios.mjs` 的 6 个新场景用 CDP `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent` /
`Input.insertText` 发真实输入，不是 `element.click()`，也不是直接改 `value`：

| 场景 | 实际做了什么 | 结果 |
| --- | --- | --- |
| 任务：键盘打开任务、连续审阅与空格整文件暂存 | 点最近仓库 → `Ctrl+4` 切任务 → 选起点 → 点文件行 → `Alt+M` 标记已审阅 → `Alt+Shift+→` 下一个未审阅 → `空格` 整文件暂存 | PASS（`范围内 4 个提交 8 个文件 +184 −82 含未提交改动`） |
| 任务：键盘提交真实暂存并回到提交区 | 同上前半 → `空格` 暂存 → 点「回到提交区」（任务页按钮）→ 在提交说明里输入 → 点提交按钮 | PASS（提交后草稿清空、`暂存区为空`） |
| 历史：旧批次请求挂住时换选择仍能读到文件并结束加载 | 选最新 4 个提交（两条详情永不返回）→ 换到更早 4 个 → 等加载结束 | PASS（4 个文件；差异块出现） |
| 历史：多选详情全部失败时说明原因并给出重新读取 | 选 3 个提交（全部失败）→ 等失败说明与恢复入口 | PASS（`提交详情读取失败…` + `重新读取`） |
| 任务：起点不可用时就地说明，仍能换起点 | 选一个不可用的起点 | PASS（`读取任务范围失败…重新读取 / 重选起点`） |
| 工作区总览：分组、未知、缺失与过期逐项登记 | 打开工作区总览 | PASS（1 个分组；未知 2 项；缺失 1 项；过期 1 项） |

关于「返回 Cliora」：mock 预览不注册系统深链协议，无法在浏览器里伪造一条真实 Cliora 链接，
因此浏览器脚本覆盖的是**同一段落里可达的「回到提交区」返回路径**；Cliora 深链往返由
`tests/cliora-integration.spec.ts`（组件级）与 `scripts/verify-cliora-integration.mjs`（真实 Git）分别覆盖，
本目录不声称浏览器证据等于深链闭环。

## 本次修复的缺陷：多选历史一直转圈

用户报告的现象：选 4 个提交后，右侧同时停在「正在读取所选提交的详情 / 正在读取提交中的文件」，转圈不结束。

实际原因（两层）：

1. `src/lib/latest-batch-read.ts` 的并发位置是**整个队列共享**的：旧批次被替换后，它那两个仍挂着的请求
   会一直占着两个位置，新批次永远排不上队；旧请求如果不返回，新批次的 promise 既不 resolve 也不 reject，
   `multiLoading` 永远是 true —— 界面就一直转圈。
2. `src/lib/components/HistoryPanel.svelte` 的加载态只由「没有 cancelled」决定，没有请求边界：
   被替代/取消之后既没有终态，也没有用户可见的失败说明；右侧「正在读取差异」只按
   `multiDiffs.length === 0` 显示，读取早已结束时也还是转圈。

修复语义（不是加动画或超时遮掉）：

- 并发位置改成**批次自己的**：取消时旧批次立刻以 `cancelled` 结算并释放位置，新批次按自己的两项并发开始；
  旧批次的迟到结果与迟到错误永不落地（既不 resolve 成空结果，也不覆盖新批次）。
- 组件侧给每次读取发一张「票」（`multiTicket`）：只有当前票能改 `multiLoading / multiDetails / multiError`；
  结束（读完、失败、被替代、切视图）都在当前请求边界内把加载态收掉。
- 用户可见恢复：失败/被替代时给说明与「重新读取所选提交」「重新读取差异」入口，绝不把 cancelled 当成
  「这些提交没有文件变化」。

回归测试：

- `tests/latest-batch-read.spec.ts`：旧批次在途请求永不结束也不占新批次位置；被替代只以 `cancelled` 结束；
  取消/关闭立即结算不等旧请求。
- `tests/history.spec.ts`：旧批次在途详情永不返回时新选择仍会读取并结束加载；详情失败可就地重读；
  切走再回来不残留上一层的转圈。

## 边界

- 只证明「浏览器 + mock」。真实 Git 的净差异、token、写入保护由 Rust 夹具（`cargo test`）与
  `scripts/verify-delivery.mjs` 覆盖；桌面 WebView、安装包、macOS/Linux 行为本次未运行。
- 3 个既有失败场景（`文档阅读：Markdown 默认排版预览`、`目录列出中文重复标题且各自可辨`、
  `相对链接留在同一阅读器里打开目标`）涉及的 `mock-files.ts`、`samples.ts`、`check-scenarios.mjs` 与
  文档阅读组件都没有被本次改动触碰；它们与「文件视图的 Markdown 预览不显示目录工具行」是同一条既有差异，
  本批次没有修复，也**没有**把它们算成通过。