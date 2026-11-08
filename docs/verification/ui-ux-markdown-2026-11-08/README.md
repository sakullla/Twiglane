# UI/UX 与 Markdown 阅读：验证记录（2026-11-08 工作流，任务 T5）

本记录对应当前工作流的最终体验与 Markdown 阅读能力。它只写**实际跑过的东西**：浏览器截图来自 mock 数据，跨版本读取与路径边界由 Rust 真实 Git 夹具与前端用例覆盖；没有跑成的部分写在「未覆盖与限制」里，不当作通过。

- 需求：`docs/requirements/2026-11-08-ui-ux-markdown.md`（R1–R7，修订 3）
- 优化前基线：`docs/sakullla-workflow/2026-11-08-ui-ux-markdown/evidence/ui-baseline/`（20 张）与 `evidence/ui-baseline-files/`（4 张），由 01 探索在同一 mock 数据上采集，原图未覆盖。
- 候选图：本目录 `after/`（28 张，含 Markdown 新样例）；元数据（主题、尺寸、视图、字节数、SHA-256、采集环境）见 `manifest.json`。

## 结论（可核对的事实）

1. 同步按钮折叠状态直接区分方向：同一组数据（ahead=2、behind=1）下，基线只显示两个数字 `2`、`1`，候选显示向上箭头 + `2`、向下箭头 + `1`，未核对或过期时按钮内另有「未核 / 过期」文字标记。见 `after/dark-1280x840-changes.png` 与基线 `evidence/ui-baseline/dark-1280x840-changes.png`。
2. 左栏视图顺序按需求改为「改动、历史、文件」，三个视图各自保留选择与位置；基线为「改动、文件、历史」。两张同尺寸截图可在同一行按钮上直接对比。
3. Markdown 在文件视图里的默认形态从「带行号源码」变为「排版预览 + 可收起目录」。基线 `evidence/ui-baseline-files/dark-900x600-files-markdown.png` 只有源码；候选 `after/dark-900x600-files-markdown.png`、`after/dark-900x600-files-markdown-toc.png` 为同一文件（mock `README.md`）的预览与目录。
4. 提交区失败原因在长文本时可就地展开换行读全（键盘可达），草稿与暂存不动；重试推送仍只推送。该交互由 `tests/commit-draft.spec.ts` 的行为断言覆盖，本轮未单独截图（见限制）。
5. 起始页、设置、任务弹窗与命令面板的标题层级改为共用 `--text-eyebrow`、`--tracking-eyebrow`、`--text-section-title` 三枚令牌，`tests/tokens.spec.ts` 断言这些选择器只引用令牌、不写死字号字距。

## 同数据对照（两主题 × 两尺寸）

数据、主题、窗口尺寸与任务路径与 01 基线一致；基线来自开发服务器 + mock，候选来自同一 mock 的静态单文件构建（见「采集方法」）。

| 视图 | 基线 | 候选 | 同尺寸下的具体差异 |
| --- | --- | --- | --- |
| 起始页 | `evidence/ui-baseline/<theme>-<size>-start.png` | `after/<theme>-<size>-start.png` | 同数据、同尺寸下版式一致；标题层级改用共享令牌，字号与字距未变 |
| 改动 | `evidence/ui-baseline/<theme>-<size>-changes.png` | `after/<theme>-<size>-changes.png` | 同步按钮多出方向箭头（`2 1` → `↑2 ↓1`）；视图顺序为改动/历史/文件；差异内容与工具栏分组不变 |
| 历史 | `evidence/ui-baseline/<theme>-<size>-history.png` | `after/<theme>-<size>-history.png` | 视图顺序变化；900×600 下提交头与变更文件列表更紧，可见差异区上移约 20px（同一提交、同一主题，来自提交头与会话内文件列表的收敛，不作像素预算承诺） |
| 合并 / 设置 | 同上 | `after/<theme>-<size>-merge.png`、`-settings.png` | 布局与内容一致；弹窗标题、分区标题同一档字号与字重 |

复跑方式：按本目录上一级需求文档与 `scripts/ui-preview/README.md` 说明采集，基线不覆盖，候选另存目录。

## Markdown 新样例（单独成组，不参与前后对照）

`after/<theme>-<size>-files-markdown.png` 与 `after/<theme>-<size>-files-markdown-toc.png` 是**本轮新增能力**的样例，不是「优化前后同一数据」的对照，`manifest.json` 里以 `groups.markdown` 分开记录。样例文档 `scripts/ui-preview/mock-files.ts` 的 `README.md` 覆盖：中文标题、两个同名「中文重复标题」、GFM 表格、只读任务列表、引用、相对链接（`docs/guide/getting-started.md`）、缺失链接、外部网页链接、本地图片与远程图片占位。

## 采集方法

浏览器与 mock 下的界面证据：

- 构建：`node node_modules/vite/bin/vite.js build --config scripts/ui-preview/vite.config.mjs --configLoader native --base ./ --outDir <临时目录>`，并把异步分块合并为单包（Vite API 的 `build` + `output.codeSplitting: false`），再把入口 JS 与 CSS 内联进 `index.html`。
- 采集：Chrome 157（DevTools 协议）打开该单文件页，`Emulation.setDeviceMetricsOverride` 固定 `1280×840` / `900×600`、`deviceScaleFactor=1`，通过 `preview-theme` 切换浅/深主题，逐视图截图并写入本目录。
- 为什么不用 `npm run preview:ui`：本轮执行环境的沙箱不允许长期驻留的开发服务器（命令结束后进程被回收），也不允许从子进程启动浏览器；因此改用同一份 mock 数据、同一份构建配置的静态单文件页。静态页把 `window.Worker` 置空，Markdown 解析走 `src/lib/markdown/client.ts` 的内联退路，解析器与排版结果与工作线程路径相同；这只影响解析线程，不改变界面排版。
- 差异说明：基线与候选的浏览器版本、来源（开发服务器 vs 静态页）不完全相同；CSS 布局按 CSS 像素比对，字体渲染差异可能存在，因此本记录不据截图做像素级结论。

## 可复跑入口

```bash
# 1) 起 mock 预览（正常环境）
npm run preview:ui                     # http://127.0.0.1:1430，先确认 /__ui-preview/health 返回 mockApi: true

# 2) 同数据、两主题、两尺寸截图（含 Markdown 新样例，单独成组）
node scripts/ui-preview/baseline-shots.mjs --out docs/verification/ui-ux-markdown-2026-11-08/after

# 3) 交互场景自检（21 个场景）
node scripts/ui-preview/check-scenarios.mjs

# 4) 规模与旧响应回归
node scripts/performance/run.mjs --ui
```

`check-scenarios.mjs` 本轮新增 9 个场景：Markdown 默认预览、目录列出中文重复标题、目录收起后仍可读、预览与源码往返、相对链接同版本跳转、超出排版预算给源码、读取失败就地说明、历史提交里的 Markdown 差异。选择器在本次静态页上逐条手工验证过（`?doc=error` 的「重新读取 / 查看源码」、`?doc=large` 的超限说明与源码退路、目录项为 `button` 而非 `a`、相对链接把 `.doc-path` 切到 `docs/guide/getting-started.md`、`?commitdoc=1` 让首个提交出现 README.md）。场景脚本本身未能在命令行跑完：本机沙箱无法启动浏览器（见限制）。

## 自动化检查（本次实际结果）

| 检查 | 实际结果 |
| --- | --- |
| `node scripts/check-contrast.mjs` | 通过（exit 0）：1454 对（正文 1356 / 交互 90 / 含 opacity 合成 8），正文最低 4.59:1，交互边界最低 3.16:1，合成最低 4.77:1 |
| 前端测试（`vitest run`，等价命令见下） | 48 个文件、1157 项：1149 通过、5 跳过、3 失败；3 项失败均为沙箱限制（`spawn EPERM`／无法启动 dev server），见下 |
| 性能 UI 用例（`vitest run --config scripts/performance/vitest.config.ts`） | 14 项全部通过。同一套用例两次运行分别打印：800 段落 Markdown 首屏 198.67 / 426.40ms、两万条路径结果 316.99 / 485.06ms、两万行目录 71.36 / 131.32ms、两万提交文件配对 5.92 / 5.49ms。两次差异来自并行负载，只作为可用性与上限的回归信号，不是性能承诺 |
| `node scripts/verify-delivery.mjs` | 失败（exit 1）：`缺少 docs/verification/report.json`。按要求未制造发布报告、未改门禁 |
| `svelte-check` | 3 项错误，均为加载 `scripts/ui-preview/vite.config.mjs` 时 `spawn EPERM`（`svelte(style)` 阶段），与本次改动无关；无 TypeScript 类型错误 |

本机等价命令（沙箱不允许 `npm`/`vitest` 直接建管道 stdio）：

```bash
node node_modules/vitest/vitest.mjs run --configLoader native --pool=threads --maxWorkers=2
node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json --threshold error
node --require <临时目录>/cp-shim.cjs node_modules/vite/bin/vite.js build --config scripts/ui-preview/vite.config.mjs --configLoader native
```

## 未覆盖与限制

- **Node 版本**：本机为 Node.js v26.4.0，仓库 CI 与正式检查要求 Node.js 22。本轮结果是在 26 上得到的，不能写成 CI 环境（Node 22）通过。
- **平台**：没有 macOS / WebView 实机运行记录，也没有 Windows 安装包实机验收；本文所有界面结论仅限浏览器 + mock。
- **3 项测试失败均为环境**：`tests/tokens.spec.ts`（内部 `spawnSync` 跑对比度脚本）、`tests/delivery.spec.ts`（`generate-fixture.mjs` 用管道 stdio 调 git）、`tests/ui-preview.spec.ts`（真起 dev server 时配置打包 `spawn EPERM`）。对应的独立命令 `node scripts/check-contrast.mjs` 已实跑通过。
- **截图脚本未在命令行跑通**：沙箱阻止启动 Chrome，因此 `baseline-shots.mjs` / `check-scenarios.mjs` 本轮未作为脚本执行；候选截图由 DevTools 协议在同一 mock 数据上人工驱动完成，选择器已逐条核对。正常开发环境下应按上面「可复跑入口」重跑，并保留 01 基线不覆盖。
- **提交失败态与阅读窗口没单独截图**：长错误展开、重试只推送、阅读窗口来源标签等由 `tests/commit-draft.spec.ts`、`tests/document-reader.spec.ts`、`tests/review-diff.spec.ts` 覆盖；本轮未额外补这两类截图，界面证据只覆盖上文列出的视图。
- **像素与性能口径**：截图只做同尺寸同主题的定性对照（如「差异区上移约 20px」），不构成像素预算或帧率结论；性能数字来自 happy-dom 下的规模用例，不是桌面进程实测。
- **`verify:delivery`**：仍缺 `docs/verification/report.json`（跨平台安装与运行证据），该项失败如实保留。
