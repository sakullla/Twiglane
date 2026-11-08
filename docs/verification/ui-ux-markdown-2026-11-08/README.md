# UI/UX 与 Markdown 阅读：验证记录（2026-11-08 工作流，任务 T5）

本记录对应当前工作流的最终体验与 Markdown 阅读能力。它只写**实际跑过的东西**：浏览器截图来自 mock 数据，跨版本读取与路径边界由 Rust 真实 Git 夹具与前端用例覆盖；没有跑成的部分写在「未覆盖与限制」里，不当作通过。

- 需求：`docs/requirements/2026-11-08-ui-ux-markdown.md`（R1–R7，修订 3）
- 优化前基线：`docs/sakullla-workflow/2026-11-08-ui-ux-markdown/evidence/ui-baseline/`（20 张）与 `evidence/ui-baseline-files/`（4 张），由 01 探索在同一 mock 数据上采集，原图未覆盖。
- 候选图：本目录 `after/`（49 张 = 同数据对照 20 + Markdown 新样例 8 + 关键失败/未知状态 21）；元数据（主题、尺寸、视图、状态、字节数、SHA-256、采集环境）见 `manifest.json`，49 张的 bytes 与 SHA-256 已逐张复核一致。

## 结论（可核对的事实）

1. 同步按钮折叠状态直接区分方向：同一组数据（ahead=2、behind=1）下，基线只显示两个数字 `2`、`1`，候选显示向上箭头 + `2`、向下箭头 + `1`，见 `after/dark-1280x840-changes.png` 与基线 `evidence/ui-baseline/dark-1280x840-changes.png`。
2. 未核对/过期的远程状态在折叠按钮里就有文字标记，不依赖颜色或数字差：`after/<theme>-1280x840-sync-unchecked.png`、`-sync-stale.png` 与 `after/dark-900x600-*` 直接显示「未核」「过期」，`title`/`aria-label` 同时说明上次核对时间与「计数只反映记录的对比」（R3 验收 3）。
3. 左栏视图顺序按需求改为「改动、历史、文件」，三个视图各自保留选择与位置；基线为「改动、文件、历史」。两张同尺寸截图可在同一行按钮上直接对比。
4. Markdown 在文件视图里的默认形态从「带行号源码」变为「排版预览 + 可收起目录」。基线 `evidence/ui-baseline-files/dark-900x600-files-markdown.png` 只有源码；候选 `after/dark-900x600-files-markdown.png`、`after/dark-900x600-files-markdown-toc.png` 为同一文件（mock `README.md`）的预览与目录。
5. 提交区失败原因在长文本时可就地展开换行读全（键盘可达），草稿与暂存不动：`after/<theme>-1280x840-commit-error.png`、`after/dark-900x600-commit-error.png` 已展开显示钩子拒绝全文；「提交并推送」失败时两个阶段分开说明、长推送错误可展开且保留「重试推送」入口，见 `after/<theme>-1280x840-commit-push-error.png`、`after/dark-900x600-commit-push-error.png`（R3 验收 2/4、R6）。
6. 文档读取失败、超过排版预览上限与搜索局部失败都有界面证据，且都给出可执行的恢复入口（重新读取 / 查看源码 / 明确失败原因而不是「没有匹配」）：`after/*-doc-error.png`、`after/*-doc-large.png`、`after/*-search-error.png`（R4 验收 5、R2 失败边界、R6）。
7. 起始页、设置、任务弹窗与命令面板的标题层级改为共用 `--text-eyebrow`、`--tracking-eyebrow`、`--text-section-title` 三枚令牌，`tests/tokens.spec.ts` 断言这些选择器只引用令牌、不写死字号字距。

## 操作路径对照（R2 验收 4）

基线侧事实取自 01 探索的既有实现（`2106e04` 的 `ViewSwitcher.svelte`/`shortcuts.ts`/`FileContent.svelte`/`files.svelte.ts`）、基线截图与 01 探索记录；候选侧取自当前实现与实际截图。动作记为「点击 / 输入 / 快捷键」，箭头表示一个界面结果。

| 常用任务 | 优化前（基线）操作路径 | 优化后（候选）操作路径 | 减少的重复/无效跳转 |
| --- | --- | --- | --- |
| 定位并打开一个文件（README.md） | 起始页点最近仓库 → 点左栏第 2 项「文件」（快捷键却是 `Ctrl+3`，位置与数字不一致）→ 逐级展开目录或 `Ctrl+P` 输入路径 → 点文件行。≤4 次点击 + 1 次输入；空状态「最近打开」可能混入目录条目，需要靠图标/路径辨认 | 起始页点最近仓库 → `Ctrl+3` 或点第 3 项「文件」（数字与位置一致）→ 空状态「最近打开」只列文件，1 次点击回到刚打开的文件；首次定位仍可 `Ctrl+P`。≤3 次点击 | 快捷键与按钮位置一致，少一次「按错视图再切回」；最近打开不再混入目录，重复打开同一文件可直接 1 次点击（基线可能点到目录）；首次定位可用同一套目录/路径入口 |
| 从改动进入历史、看某文件并返回 | 改动视图选文件 → 点第 3 项「历史」或 `Ctrl+2`（`Ctrl+2` 打开的是第 3 项，数字与位置错位）→ 选提交 → 点文件 → 点第 1 项返回改动；历史里的 Markdown 只能看差异源码，读不到该版本正文 | 改动视图选文件 → `Ctrl+2`（第 2 项，位置与数字一致）→ 选提交 → 点文件 → 差异/提交文件里的「阅读文档」读到该提交的正文，返回后恢复原选择与位置（R5）→ `Ctrl+1` 回改动 | 少一次按错视图的回退；历史 Markdown 不必先切回工作区或另开文件才能读正文；视图往返保留选择与阅读位置，不用重新找文件 |
| 阅读 Markdown 并定位某一节（含同名标题） | 文件视图打开 README → 默认带行号源码；定位「中文重复标题」需 `Ctrl+F` + 输入标题或手动滚动；同名标题只能靠行号/顺序区分 | 文件视图打开 README → 默认排版预览 → 点「目录」→ 点同名条目 1 次即定位；两个同名项分别落到不同 heading 锚点与不同滚动位置，`aria-current` 跟着当前条目（见「自动化检查」里的场景表达式结果） | 定位小节从「查找输入 + 回车」变为 1 次目录点击、0 输入；重复标题无需再用搜索词或行号辨认；预览/源码往返保留各自位置 |
| 暂存、提交并处理失败 | 改动视图点行 → 点「暂存」→ 输入说明 → `Ctrl+Enter` 提交 → 失败时提交区只有单行截断原因，读全要悬停 `title`（键盘不可达）或去通知条；「提交并推送」失败后重试目标需要自己判断 | 同一条暂存与提交流程；失败时长原因就地「展开」1 次（原生按钮，可键盘操作）换行读全，草稿与已暂存内容保留；「提交并推送」失败时分成两条说明，并提供只推送的「重试推送」 | 读全失败原因不必离开提交区或悬停；失败后不用重新输入说明；两阶段结果分开后重试目标明确，不会重复创建本地提交 |
| 判断同步方向与远程时效 | 按钮只有 `2`、`1` 两个数字，判断哪个是待推送/待拉取要打开同步菜单读「推送 2 个提交 / 拉取 1 个提交」；离线或未核对时按钮不说明，缓存数字看起来像刚验证 | 折叠按钮直接 `↑2 ↓1`；未核对/过期另有「未核/过期」文字标记，`title`/`aria-label` 说明上次核对时间与「计数只反映记录的对比」 | 判断方向从「打开菜单再读」变为 0 次点击；远程时效在按钮上就能看到，避免把未核对状态当成已验证后去做无效的推送/拉取 |

## 同数据对照（两主题 × 两尺寸）

数据、主题、窗口尺寸与任务路径与 01 基线一致；基线来自开发服务器 + mock，候选来自同一 mock 的静态单文件构建（见「采集方法」）。

| 视图 | 基线 | 候选 | 同尺寸下的具体差异 |
| --- | --- | --- | --- |
| 起始页 | `evidence/ui-baseline/<theme>-<size>-start.png` | `after/<theme>-<size>-start.png` | 同数据、同尺寸下版式一致；标题层级改用共享令牌，字号与字距未变 |
| 改动 | `evidence/ui-baseline/<theme>-<size>-changes.png` | `after/<theme>-<size>-changes.png` | 同步按钮多出方向箭头（`2 1` → `↑2 ↓1`）；视图顺序为改动/历史/文件；差异内容与工具栏分组不变 |
| 历史 | `evidence/ui-baseline/<theme>-<size>-history.png` | `after/<theme>-<size>-history.png` | 视图顺序变化；900×600 下提交头与变更文件列表更紧，可见差异区上移约 20px（同一提交、同一主题，来自提交头与会话内文件列表的收敛，不作像素预算承诺） |
| 合并 / 设置 | 同上 | `after/<theme>-<size>-merge.png`、`-settings.png` | 布局与内容一致；弹窗标题、分区标题同一档字号与字重 |

复跑方式：按本目录上一级需求文档与 `scripts/ui-preview/README.md` 说明采集，基线不覆盖，候选另存目录。

## 关键失败/未知状态（新增证据）

同一 mock 数据、同一构建，通过 `scripts/ui-preview/mock-api.ts` 的查询参数进入失败/未知分支；`manifest.json` 里 `groups.failure` 与 `state` 字段记录每张的状态。深色 1280×840、浅色 1280×840、深色 900×600 三种组合各采 7 个状态（共 21 张）。

| 状态 | 文件（3 张／状态） | 证明的需求 |
| --- | --- | --- |
| 同步未核对 `?remote=unchecked` | `after/dark-1280x840-sync-unchecked.png`、`after/light-1280x840-sync-unchecked.png`、`after/dark-900x600-sync-unchecked.png` | R3 验收 3：离线或未核对时不把缓存状态描述为刚刚验证；按钮「未核」+ `aria-label`「未核对远程」+ `title`「计数只反映记录的对比」 |
| 同步已过期 `?remote=stale` | `after/dark-1280x840-sync-stale.png`、`after/light-1280x840-sync-stale.png`、`after/dark-900x600-sync-stale.png` | R3 验收 3：过期状态与上次核对时间可见；`aria-label`「远程状态已过期（上次检查 …）」 |
| 本地提交失败（长原因展开）`?commit=error` | `after/dark-1280x840-commit-error.png`、`after/light-1280x840-commit-error.png`、`after/dark-900x600-commit-error.png` | R3 验收 2：失败保留输入并说明恢复方式；长原因就地展开换行读全、键盘可达；R1：长错误不挤出关键操作（900×600 下提交按钮仍可见） |
| 提交成功、推送失败（长原因展开）`?commit=push` | `after/dark-1280x840-commit-push-error.png`、`after/light-1280x840-commit-push-error.png`、`after/dark-900x600-commit-push-error.png` | R3 验收 4：两个阶段分别呈现、重试只推送；R6：失败状态不反复挤动主要操作 |
| 文档读取失败 `?doc=error` | `after/dark-1280x840-doc-error.png`、`after/light-1280x840-doc-error.png`、`after/dark-900x600-doc-error.png` | R4 验收 5 / R6：读取失败就地说明原因，仍给「重新读取 / 查看源码」，不把旧正文当作当前内容 |
| 文档超过排版预览上限 `?doc=large` | `after/dark-1280x840-doc-large.png`、`after/light-1280x840-doc-large.png`、`after/dark-900x600-doc-large.png` | R4 验收 5：超限时给出真实状态与源码退路，不把片段伪装成完整文档 |
| 搜索局部失败 `?search=error` | `after/dark-1280x840-search-error.png`、`after/light-1280x840-search-error.png`、`after/dark-900x600-search-error.png` | R2 失败边界：搜索无结果与读取失败可区分，失败给原因；R6：结果区不伪造命中 |

失败态没有混入「同数据前后对照」：`manifest.json` 以 `groups.failure` 单独成组，`state` 写清进入参数；对照表只统计 `groups.baseline`。

## Markdown 新样例（单独成组，不参与前后对照）

`after/<theme>-<size>-files-markdown.png` 与 `after/<theme>-<size>-files-markdown-toc.png` 是**本轮新增能力**的样例，不是「优化前后同一数据」的对照，`manifest.json` 里以 `groups.markdown` 分开记录。样例文档 `scripts/ui-preview/mock-files.ts` 的 `README.md` 覆盖：中文标题、两个同名「中文重复标题」、GFM 表格、只读任务列表、引用、相对链接（`docs/guide/getting-started.md`）、缺失链接、外部网页链接、本地图片与远程图片占位。

## 采集方法

浏览器与 mock 下的界面证据：

- 构建：`node node_modules/vite/bin/vite.js build --config scripts/ui-preview/vite.config.mjs --configLoader native --base ./ --outDir <临时目录>`，并把异步分块合并为单包（Vite API 的 `build` + `output.codeSplitting: false`），再把入口 JS 与 CSS 内联进 `index.html`。
- 采集：Chrome 157（DevTools 协议）打开该单文件页，`Emulation.setDeviceMetricsOverride` 固定 `1280×840` / `900×600`、`deviceScaleFactor=1`，通过 `preview-theme` 切换浅/深主题，逐视图截图并写入本目录。
- 失败态：同一单文件页只改查询参数（`?remote=unchecked`、`?remote=stale`、`?commit=error`、`?commit=push`、`?doc=error`、`?doc=large`、`?search=error`），重新打开同一仓库后按操作路径进入状态，再截图与读取 `title`/`aria-label` 等可访问文本作为佐证。
- 为什么不用 `npm run preview:ui`：本轮执行环境的沙箱不允许长期驻留的开发服务器（命令结束后进程被回收），也不允许从子进程启动浏览器；因此改用同一份 mock 数据、同一份构建配置的静态单文件页。静态页把 `window.Worker` 置空，Markdown 解析走 `src/lib/markdown/client.ts` 的内联退路，解析器与排版结果与工作线程路径相同；这只影响解析线程，不改变界面排版。
- 差异说明：基线与候选的浏览器版本、来源（开发服务器 vs 静态页）不完全相同；CSS 布局按 CSS 像素比对，字体渲染差异可能存在，因此本记录不据截图做像素级结论。

## 可复跑入口

```bash
# 1) 起 mock 预览（正常环境）
npm run preview:ui                     # http://127.0.0.1:1430，先确认 /__ui-preview/health 返回 mockApi: true

# 2) 同数据、两主题、两尺寸截图 + Markdown 新样例 + 7 个关键失败状态
#    产物：docs/verification/ui-ux-markdown-2026-11-08/after/<theme>-<size>-<view>.png
#    manifest：docs/verification/ui-ux-markdown-2026-11-08/manifest.json（--manifest 可覆盖）
node scripts/ui-preview/baseline-shots.mjs

# 3) 交互场景自检（25 个场景）
node scripts/ui-preview/check-scenarios.mjs

# 4) 规模与旧响应回归
node scripts/performance/run.mjs --ui
```

`baseline-shots.mjs` 的产物命名、分组与 manifest 位置/字段已与已提交证据统一：文件名是 `<theme>-<size>-<view>.png`，manifest 在验证目录根部，逐张记录 `theme/size/view/state/bytes/sha256`，因此同环境重跑会得到同一套命名与结构一致的 manifest（截图字节可能因字体/浏览器版本不同而变，哈希以重跑生成的 manifest 为准）。

本轮已提交的 49 张仍由人工 CDP 在单文件静态页上采集（沙箱不能启动浏览器，见限制），采集时用的就是上面的查询参数与选择器；脚本本身未在本轮命令行跑通，不能写成已由脚本复现。

`check-scenarios.mjs` 本轮新增/改写 5 个场景：重复标题点击核对锚点与滚动位置、远程未核对、远程过期、提交长错误展开、提交成功推送失败展开。这些场景的 `ready`/`check` 表达式已在同一静态页逐条执行通过（见下节），但脚本本身未能在命令行跑完：本机沙箱无法启动 Chrome。

## 自动化检查（本次实际结果）

| 检查 | 实际结果 |
| --- | --- |
| `node scripts/check-contrast.mjs` | 通过（exit 0）：1454 对（正文 1356 / 交互 90 / 含 opacity 合成 8），正文最低 4.59:1，交互边界最低 3.16:1，合成最低 4.77:1 |
| 定向前端用例 `vitest run tests/sidebar.spec.ts tests/tokens.spec.ts tests/commit-draft.spec.ts tests/app-shell.spec.ts` | 4 个文件、286 项：285 通过、1 失败。失败项是 `tests/tokens.spec.ts` 的对比度门禁用例：它用 `spawnSync` 起子进程跑脚本，沙箱拒绝管道 stdio（`status` 为 null，非对比度结论）；独立命令 `node scripts/check-contrast.mjs` 已实跑通过 |
| `node scripts/ui-preview/check-scenarios.mjs` | 失败（exit 1）：`无法连接 Chrome 调试端口`——沙箱拒绝从子进程启动浏览器。替代验证：新增/改写的 5 个场景表达式在静态单文件页上逐条执行，结果见下 |
| 场景表达式（手工逐条执行） | 重复标题：两次点击后 `scrollTop` 275.33 → 324.67，锚点为 `中文重复标题` / `中文重复标题-1`，`aria-current` 分别落在两个条目；同步未核/过期：`data-sync-remote` 为 `off`/`stale` 且 `aria-label` 文案匹配；提交失败：长原因展开含 `pre-commit` 且草稿仍在；推送失败：展开文本含「本地提交」且「重试推送」仍在 |
| `node scripts/verify-delivery.mjs` | 失败（exit 1）：`缺少 docs/verification/report.json`。按要求未制造发布报告、未改门禁 |
| `manifest.json` 复核 | 49 张逐张比对 bytes 与 SHA-256，全部一致（0 处不符） |
| `svelte-check` | 3 项错误，均为加载 `scripts/ui-preview/vite.config.mjs` 时 `spawn EPERM`（`svelte(style)` 阶段），与本次改动无关；`tsc --noEmit` 另有 9 项既有 `*.svelte` 模块导出误报（Svelte 组件导出未被 TS 声明识别），未涉及本次改动的文件 |

本机等价命令（沙箱不允许 `npm`/`vitest` 直接建管道 stdio）：

```bash
node node_modules/vitest/vitest.mjs run tests/sidebar.spec.ts tests/tokens.spec.ts tests/commit-draft.spec.ts tests/app-shell.spec.ts --configLoader native --pool=threads
node scripts/check-contrast.mjs
node --require <临时目录>/cp-shim.cjs node_modules/vite/bin/vite.js build --config scripts/ui-preview/vite.config.mjs --configLoader native
```

## 未覆盖与限制

- **失败态组合**：21 张失败态覆盖深色 1280×840、浅色 1280×840、深色 900×600 三种组合；未采集「浅色 × 900×600」这一组合（单变量已各自覆盖：浅色见 1280×840，最小窗口见深色 900×600；再叠加组合只是同一状态的重复取证，没有新增结论）。若需要四组合全量，按上面「可复跑入口」在正常环境跑 `baseline-shots.mjs` 会补齐。
- **Node 版本**：本机为 Node.js v26.4.0，仓库 CI 与正式检查要求 Node.js 22。本轮结果是在 26 上得到的，不能写成 CI 环境（Node 22）通过。
- **平台**：没有 macOS / WebView 实机运行记录，也没有 Windows 安装包实机验收；本文所有界面结论仅限浏览器 + mock。
- **1 项定向用例失败为环境**：`tests/tokens.spec.ts` 内部 `spawnSync` 跑对比度脚本被沙箱拒绝；脚本自身的独立运行已通过，因此不是对比度回退。其余 285 项通过（含本轮新增的远程未核/过期外壳接线用例）。
- **截图脚本未在命令行跑通**：沙箱阻止启动 Chrome，因此 `baseline-shots.mjs` / `check-scenarios.mjs` 本轮未作为脚本执行；候选截图由 DevTools 协议在同一 mock 数据上人工驱动完成，场景表达式逐条手工执行（结果见上表）。正常开发环境下应按「可复跑入口」重跑，并保留 01 基线不覆盖。
- **像素与性能口径**：截图只做同尺寸同主题的定性对照（如「差异区上移约 20px」），不构成像素预算或帧率结论；性能数字来自 happy-dom 下的规模用例，不是桌面进程实测（本轮未重跑性能用例）。
- **`verify:delivery`**：仍缺 `docs/verification/report.json`（跨平台安装与运行证据），该项失败如实保留。
