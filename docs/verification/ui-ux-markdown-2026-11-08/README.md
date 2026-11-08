# UI/UX 与 Markdown 阅读：验证记录（2026-11-08 工作流，任务 T5）

本记录对应当前工作流的最终体验与 Markdown 阅读能力。它只写**实际跑过的东西**：浏览器截图来自 mock 数据，跨版本读取与路径边界由 Rust 真实 Git 夹具与前端用例覆盖；没有跑成的部分写在「未覆盖与限制」里，不当作通过。

- 需求：`docs/requirements/2026-11-08-ui-ux-markdown.md`（R1–R7，修订 3）
- 优化前基线：`docs/sakullla-workflow/2026-11-08-ui-ux-markdown/evidence/ui-baseline/`（20 张）与 `evidence/ui-baseline-files/`（4 张），由 01 探索在同一 mock 数据上采集，原图未覆盖。
- 候选图：本目录 `after/`（64 张 = 同数据对照 20 + Markdown 新样例 8 + 关键失败/未知状态 36）；元数据（主题、尺寸、视图、分组、状态、字节数、SHA-256、采集环境）见 `manifest.json`，`shots` 逐张带 `group`（`baseline` / `markdown` / `failure`），64 张的 bytes 与 SHA-256 与文件逐一致。
- 本轮 64 张与 27 个交互场景都由仓库脚本实际跑出，不是人工拼凑：`node scripts/ui-preview/baseline-shots.mjs --failure-targets dark:1280x840,light:1280x840,dark:900x600,light:900x600`（exit 0）与 `node scripts/ui-preview/check-scenarios.mjs`（27/27，exit 0），命令与结果见「自动化检查」。

## 结论（可核对的事实）

1. 同步按钮折叠状态直接区分方向：同一组数据（ahead=2、behind=1）下，基线只显示两个数字 `2`、`1`，候选显示向上箭头 + `2`、向下箭头 + `1`，见 `after/dark-1280x840-changes.png` 与基线 `evidence/ui-baseline/dark-1280x840-changes.png`。
2. 未核对/过期的远程状态在折叠按钮里就有文字标记，不依赖颜色或数字差：`after/<theme>-1280x840-sync-unchecked.png`、`-sync-stale.png` 与 `after/dark-900x600-*` 直接显示「未核」「过期」，`title`/`aria-label` 同时说明上次核对时间与「计数只反映记录的对比」（R3 验收 3）。
3. 左栏视图顺序按需求改为「改动、历史、文件」，三个视图各自保留选择与位置；基线为「改动、文件、历史」。两张同尺寸截图可在同一行按钮上直接对比。
4. Markdown 在文件视图里的默认形态从「带行号源码」变为「排版预览 + 可收起目录」。基线 `evidence/ui-baseline-files/dark-900x600-files-markdown.png` 只有源码；候选 `after/dark-900x600-files-markdown.png`、`after/dark-900x600-files-markdown-toc.png` 为同一文件（mock `README.md`）的预览与目录。
5. 提交区失败原因在长文本时可就地展开换行读全（键盘可达），草稿与暂存不动：`after/<theme>-1280x840-commit-error.png`、`after/dark-900x600-commit-error.png` 已展开显示钩子拒绝全文；「提交并推送」失败时两个阶段分开说明、长推送错误可展开且保留「重试推送」入口，见 `after/<theme>-1280x840-commit-push-error.png`、`after/dark-900x600-commit-push-error.png`（R3 验收 2/4、R6）。
6. 文档读取失败、超过排版预览上限与四处查找的失败状态都有界面证据，且都给出可执行的恢复入口：文档侧是「重新读取 / 查看源码」（`after/*-doc-error.png`、`after/*-doc-large.png`，R4 验收 5），查找侧是原因旁就地放的动作——全仓库文本搜索「重试搜索 / 重新读取目录」（`after/*-search-error.png`）、树过滤补齐「重试补齐」（`after/*-filter-error.png`）、文件内查找「重试查找 / 重新读取文件」（`after/*-find-error.png`）（R2 失败边界、R6）。三种查找失败都不会把失败说成「没有匹配」；`check-scenarios.mjs` 会真的点一次恢复按钮，核对同一条失败重新出现（即请求确实重发了），而不只是检查按钮画出来了。
7. 起始页、设置、任务弹窗与命令面板的标题层级改为共用 `--text-eyebrow`、`--tracking-eyebrow`、`--text-section-title` 三枚令牌，`tests/tokens.spec.ts` 断言这些选择器只引用令牌、不写死字号字距。

## 操作路径对照（R2 验收 4）

基线侧事实取自 01 探索的既有实现（`2106e04` 的 `ViewSwitcher.svelte`/`shortcuts.ts`/`FileContent.svelte`/`files.svelte.ts`）、基线截图与 01 探索记录；候选侧取自当前实现与实际截图。动作记为「点击 / 输入 / 快捷键」，箭头表示一个界面结果。

| 常用任务 | 优化前（基线）操作路径 | 优化后（候选）操作路径 | 减少的重复/无效跳转 |
| --- | --- | --- | --- |
| 定位并打开一个文件（README.md） | 起始页点最近仓库 → 点左栏第 2 项「文件」（快捷键却是 `Ctrl+3`，位置与数字不一致）→ 逐级展开目录或 `Ctrl+P` 输入路径 → 点文件行。≤4 次点击 + 1 次输入；空状态「最近打开」可能混入目录条目，需要靠图标/路径辨认 | 起始页点最近仓库 → `Ctrl+3` 或点第 3 项「文件」（数字与位置一致）→ 空状态「最近打开」只列文件，1 次点击回到刚打开的文件；首次定位仍可 `Ctrl+P`。≤3 次点击 | 快捷键与按钮位置一致，少一次「按错视图再切回」；最近打开不再混入目录，重复打开同一文件可直接 1 次点击（基线可能点到目录）；首次定位可用同一套目录/路径入口 |
| 从改动进入历史、看某文件并返回 | 改动视图选文件 → 点第 3 项「历史」或 `Ctrl+2`（`Ctrl+2` 打开的是第 3 项，数字与位置错位）→ 选提交 → 点文件 → 点第 1 项返回改动；历史里的 Markdown 只能看差异源码，读不到该版本正文 | 改动视图选文件 → `Ctrl+2`（第 2 项，位置与数字一致）→ 选提交 → 点文件 → 差异/提交文件里的「阅读文档」读到该提交的正文，返回后恢复原选择与位置（R5）→ `Ctrl+1` 回改动 | 少一次按错视图的回退；历史 Markdown 不必先切回工作区或另开文件才能读正文；视图往返保留选择与阅读位置，不用重新找文件 |
| 阅读 Markdown 并定位某一节（含同名标题） | 文件视图打开 README → 默认带行号源码；定位「中文重复标题」需 `Ctrl+F` + 输入标题或手动滚动；同名标题只能靠行号/顺序区分 | 文件视图打开 README → 默认排版预览 → 点「目录」→ 点同名条目 1 次即定位；两个同名项分别落到不同 heading 锚点与不同滚动位置，`aria-current` 跟着当前条目（`check-scenarios.mjs` 会实际点击两个条目核对这三件事，结果见「自动化检查」） | 定位小节从「查找输入 + 回车」变为 1 次目录点击、0 输入；重复标题无需再用搜索词或行号辨认；预览/源码往返保留各自位置 |
| 暂存、提交并处理失败 | 改动视图点行 → 点「暂存」→ 输入说明 → `Ctrl+Enter` 提交 → 失败时提交区只有单行截断原因，读全要悬停 `title`（键盘不可达）或去通知条；「提交并推送」失败后重试目标需要自己判断 | 同一条暂存与提交流程；失败时长原因就地「展开」1 次（原生按钮，可键盘操作）换行读全，草稿与已暂存内容保留；「提交并推送」失败时分成两条说明，并提供只推送的「重试推送」 | 读全失败原因不必离开提交区或悬停；失败后不用重新输入说明；两阶段结果分开后重试目标明确，不会重复创建本地提交 |
| 判断同步方向与远程时效 | 按钮只有 `2`、`1` 两个数字，判断哪个是待推送/待拉取要打开同步菜单读「推送 2 个提交 / 拉取 1 个提交」；离线或未核对时按钮不说明，缓存数字看起来像刚验证 | 折叠按钮直接 `↑2 ↓1`；未核对/过期另有「未核/过期」文字标记，`title`/`aria-label` 说明上次核对时间与「计数只反映记录的对比」 | 判断方向从「打开菜单再读」变为 0 次点击；远程时效在按钮上就能看到，避免把未核对状态当成已验证后去做无效的推送/拉取 |

## 同数据对照（两主题 × 两尺寸）

数据、主题、窗口尺寸与任务路径与 01 基线一致；基线与候选都来自 `preview:ui` 的开发服务器 + 同一份 mock（见「采集方法」）。

| 视图 | 基线 | 候选 | 同尺寸下的具体差异 |
| --- | --- | --- | --- |
| 起始页 | `evidence/ui-baseline/<theme>-<size>-start.png` | `after/<theme>-<size>-start.png` | 同数据、同尺寸下版式一致；标题层级改用共享令牌，字号与字距未变 |
| 改动 | `evidence/ui-baseline/<theme>-<size>-changes.png` | `after/<theme>-<size>-changes.png` | 同步按钮多出方向箭头（`2 1` → `↑2 ↓1`）；视图顺序为改动/历史/文件；差异内容与工具栏分组不变 |
| 历史 | `evidence/ui-baseline/<theme>-<size>-history.png` | `after/<theme>-<size>-history.png` | 视图顺序变化；900×600 下提交头与变更文件列表更紧，可见差异区上移约 20px（同一提交、同一主题，来自提交头与会话内文件列表的收敛，不作像素预算承诺） |
| 合并 / 设置 | 同上 | `after/<theme>-<size>-merge.png`、`-settings.png` | 布局与内容一致；弹窗标题、分区标题同一档字号与字重 |

复跑方式：按本目录上一级需求文档与 `scripts/ui-preview/README.md` 说明采集，基线不覆盖，候选另存目录。

## 关键失败/未知状态（新增证据）

同一 mock 数据、同一构建，通过 `scripts/ui-preview/mock-api.ts` 的查询参数进入失败/未知分支；`manifest.json` 里每张的 `group`（`failure`）与 `state` 字段记录分组与状态。深色 1280×840、浅色 1280×840、深色 900×600、浅色 900×600 四种组合各采 9 个状态（共 36 张）：四种「主题 × 尺寸」组合都在，才不用靠单变量推断另一维。

| 状态 | 文件（4 张／状态） | 证明的需求 |
| --- | --- | --- |
| 同步未核对 `?remote=unchecked` | `after/<theme>-<size>-sync-unchecked.png` | R3 验收 3：离线或未核对时不把缓存状态描述为刚刚验证；按钮「未核」+ `aria-label`「未核对远程」+ `title`「计数只反映记录的对比」 |
| 同步已过期 `?remote=stale` | `after/<theme>-<size>-sync-stale.png` | R3 验收 3：过期状态与上次核对时间可见；`aria-label`「远程状态已过期（上次检查 …）」 |
| 本地提交失败（长原因展开）`?commit=error` | `after/<theme>-<size>-commit-error.png` | R3 验收 2：失败保留输入并说明恢复方式；长原因就地展开换行读全、键盘可达；R1：长错误不挤出关键操作（900×600 下提交按钮仍可见） |
| 提交成功、推送失败（长原因展开）`?commit=push` | `after/<theme>-<size>-commit-push-error.png` | R3 验收 4：两个阶段分别呈现、重试只推送；R6：失败状态不反复挤动主要操作。画面本身也自洽：本地提交已落地，所以暂存区为空、领先计数由 2 变 3，与「本地提交 abc 已完成」的说明一致 |
| 文档读取失败 `?doc=error` | `after/<theme>-<size>-doc-error.png` | R4 验收 5 / R6：读取失败就地说明原因，仍给「重新读取 / 查看源码」，不把旧正文当作当前内容 |
| 文档超过排版预览上限 `?doc=large` | `after/<theme>-<size>-doc-large.png` | R4 验收 5：超限时给出真实状态与源码退路，不把片段伪装成完整文档 |
| 全仓库文本搜索失败 `?search=error` | `after/<theme>-<size>-search-error.png` | R2 失败边界 / R6：失败与「没有匹配」可区分，原因旁就地给「重试搜索 / 重新读取目录」，结果区不伪造命中 |
| 树过滤补齐失败 `?filter=error` | `after/<theme>-<size>-filter-error.png` | R2 失败边界 / R6：补齐失败时说「全仓库补齐失败」而不是「没有匹配的路径」，空态里就地给「重试补齐」 |
| 文件内查找失败 `?search=error` + 打开 README + 文件内查找 | `after/<theme>-<size>-find-error.png` | R2 失败边界 / R6：文件内查找失败时原因旁就地给「重试查找 / 重新读取文件」，重读文件后会按新内容重找 |

失败态没有混入「同数据前后对照」：`manifest.json` 以 `group` 逐张分成 `baseline` / `markdown` / `failure`，`state` 写清进入参数与画面重点；对照表只统计 `group: "baseline"`。前三行查找失败证据同时是四处查找语义（R2）的失败侧证据：三种查找各有自己的范围，也各有自己的失败恢复入口。

## Markdown 新样例（单独成组，不参与前后对照）

`after/<theme>-<size>-files-markdown.png` 与 `after/<theme>-<size>-files-markdown-toc.png` 是**本轮新增能力**的样例，不是「优化前后同一数据」的对照，`manifest.json` 里 `group` 为 `markdown`，与其他组分开统计。样例文档 `scripts/ui-preview/mock-files.ts` 的 `README.md` 覆盖：中文标题、两个同名「中文重复标题」、GFM 表格、只读任务列表、引用、相对链接（`docs/guide/getting-started.md`）、缺失链接、外部网页链接、本地图片与远程图片占位。

## 采集方法

浏览器与 mock 下的界面证据（本轮由脚本实际跑出）：

- 服务：`npm run preview:ui`（`scripts/ui-preview/vite.config.mjs`，mock 替换真实 `src/lib/api.ts`，`127.0.0.1:1430`）；启动后先用 `/__ui-preview/health` 确认返回 `"mockApi": true`，避免对着旧 Vite 进程采集。
- 采集：Chrome 157（DevTools 协议，`--headless=new`）由 `baseline-shots.mjs` 驱动；`Emulation.setDeviceMetricsOverride` 固定 `1280×840` / `900×600`、`deviceScaleFactor=1`，用 `localStorage.preview-theme` 切换浅/深主题，逐视图截图并写入本目录。
- Markdown 解析走页面自己的工作线程（本轮是正常 dev server，没有把 `window.Worker` 置空）。
- 失败态：同一服务只改查询参数（`?remote=unchecked`、`?remote=stale`、`?commit=error`、`?commit=push`、`?doc=error`、`?doc=large`、`?search=error`、`?filter=error`），重新打开同一仓库后按操作路径进入状态；`find-error` 用 `?search=error` 并在打开 README 后发起文件内查找。截图前的就绪条件就是该状态的界面判据（例如失败原因与恢复按钮都在位），不是固定等待。
- 差异说明：基线与候选的浏览器版本、来源不完全相同；CSS 布局按 CSS 像素比对，字体渲染差异可能存在，因此本记录不据截图做像素级结论。

## 可复跑入口

```bash
# 1) 起 mock 预览
npm run preview:ui                     # http://127.0.0.1:1430，先确认 /__ui-preview/health 返回 mockApi: true

# 2) 同数据、两主题、两尺寸截图 + Markdown 新样例 + 9 个关键失败状态 × 四种组合
#    产物：docs/verification/ui-ux-markdown-2026-11-08/after/<theme>-<size>-<view>.png
#    manifest：docs/verification/ui-ux-markdown-2026-11-08/manifest.json（--manifest 可覆盖）
node scripts/ui-preview/baseline-shots.mjs --failure-targets dark:1280x840,light:1280x840,dark:900x600,light:900x600

# 3) 交互场景自检（27 个场景）
node scripts/ui-preview/check-scenarios.mjs

# 4) 规模与旧响应回归
node scripts/performance/run.mjs --ui
```

`baseline-shots.mjs` 的产物命名、分组与 manifest 位置/字段与已提交证据一致：文件名是 `<theme>-<size>-<view>.png`，manifest 在验证目录根部，`shots` 逐张记录 `theme/size/view/group/state/bytes/sha256`，收尾按 `group` 统计（本轮打印 `对照 20 / Markdown 8 / 失败态 36`）。截图字节会因为状态栏里的采集时间、浏览器与字体版本不同而变，哈希以重跑生成的 manifest 为准。

`--failure-targets` 决定失败态采哪几种「主题 × 尺寸」组合，默认是已提交证据的前三种；要补齐第四组合就显式列四种（如上）。拼错的组合会打印可选值，不会安静地少采一组。

本轮已提交的 64 张就是上面第 2 条命令的输出（exit 0，manifest 由该次运行写出）；27 个场景是第 3 条命令的输出（27/27，exit 0），命令与结果见下节。

`check-scenarios.mjs` 里的失败态场景不只断言「原因文字在」：它们会真的点一次恢复按钮（`重试搜索` / `重新读取目录` / `重试补齐` / `重试查找`），再核对同一条失败重新出现，确认恢复入口是可执行的而不是摆设；`?search=error` 场景同时断言结果区没有伪造命中。

## 自动化检查（本次实际结果）

| 检查 | 实际结果 |
| --- | --- |
| `npm run check`（`svelte-check`） | 通过（exit 0）：0 error / 0 warning |
| `npm test -- --maxWorkers=2` | 通过（exit 0）：48 个文件、1162 项全部通过 |
| `npm run build` | 通过（exit 0）：`vite build` 完成（仅既有的 chunk 体积提示） |
| `node scripts/check-contrast.mjs` | 通过（exit 0）：1454 对（正文 1356 / 交互 90 / 含 opacity 合成 8），正文最低 4.59:1，交互边界最低 3.16:1，合成最低 4.77:1 |
| `node scripts/ui-preview/baseline-shots.mjs --failure-targets dark:1280x840,light:1280x840,dark:900x600,light:900x600` | 通过（exit 0）：64 张截图（对照 20 / Markdown 8 / 失败态 36），manifest 由该次运行写出 |
| `node scripts/ui-preview/check-scenarios.mjs` | 通过（exit 0）：27/27 个场景 |
| `npm run test:performance -- --ui` | 通过（exit 0）：14 项规模与旧响应用例（含 800 段落 Markdown 首屏、两万条路径结果、两万行替换配对） |
| `node scripts/verify-delivery.mjs` | 失败（exit 1）：`缺少 docs/verification/report.json`。按要求未制造发布报告、未改门禁 |
| `manifest.json` 复核 | 64 张逐张比对 bytes 与 SHA-256，全部一致（0 处不符）；`group` 逐张存在，统计为 20 / 8 / 36 |

场景自检 27/27 覆盖：大量/空最近仓库、Git 缺失、文件视图（目录树、资源预览、按路径打开、全文搜索分组、仅改动墓碑、仅改动叠过滤、补齐截断、补齐失败重试、全文搜索失败恢复、文件内查找失败恢复）、改动视图审阅与隐藏、Markdown 阅读（默认预览、重复标题锚点、目录收起、预览/源码往返、相对链接、超限退路、读取失败）、历史提交里的 Markdown 差异、远程未核/过期、提交失败与推送失败展开、默认起始页。

## 未覆盖与限制

- **Node 版本**：本机为 Node.js v26.4.0，仓库 CI 与正式检查要求 Node.js 22。本轮结果是在 26 上得到的，不能写成 CI 环境（Node 22）通过。
- **平台**：没有 macOS / WebView 实机运行记录，也没有 Windows 安装包实机验收；本文所有界面结论仅限浏览器 + mock。
- **像素与性能口径**：截图只做同尺寸同主题的定性对照（如「差异区上移约 20px」），不构成像素预算或帧率结论；性能数字来自 happy-dom 下的规模用例，不是桌面进程实测。
- **`verify:delivery`**：仍缺 `docs/verification/report.json`（跨平台安装与运行证据），该项失败如实保留。
- **失败态组合**：36 张失败态覆盖「深色/浅色 × 1280×840/900×600」四种组合 × 9 个状态，组合已齐；但每个状态仍是同一条 mock 故障（例如目录读取失败只有一种原因），没有覆盖多种失败原因叠加的情形。
