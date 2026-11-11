# 浏览器界面预览

`npm run preview:ui` 会用 Vite 起一个只用于调样式的预览：把 `src/lib/api.ts` 换成 `mock-api.ts`，
监听 `http://127.0.0.1:1430`。它不进 Tauri 构建，也不代表真实 Git 行为。

## 先确认跑的是 mock

```bash
curl -s http://127.0.0.1:1430/__ui-preview/health
# {"mockApi": true, "resolvedApi": ".../scripts/ui-preview/mock-api.ts", ...}
```

`mockApi` 为 `false` 或请求失败，说明当前端口不是 mock 预览（多半是旧的 Vite 进程还占着端口）。
`vite.config.mjs` 在启动前会探测端口：被占用时直接打印原因并以 1 退出，不会让你对着旧页面调样式。

## 文件

- `vite.config.mjs`：mock 替换（按真实文件判断，不靠字符串猜测）、端口占用提示、启动自检、健康端点。
- `mock-api.ts`：mock 数据与异常/大规模参数（见文件顶部注释）。与本文相关的几组：
  - `?doc=error` / `?doc=large` / `?doc=stale`：只读文档读取的失败、超过 2 MiB 排版预算、过期重读分支；
  - `?remote=unchecked` / `?remote=stale`：远程核对状态停在「从未核对」（无时间戳）或「缓存已过期」（带上次核对时间）；两者的领先/落后计数仍是默认的 2/1，用来核对「未核 / 过期」标记与 `aria-label`/`title` 里的说明；
  - `?commit=error`：本地提交被钩子拒绝，失败说明足够长会触发展开；草稿与暂存保留；
  - `?commit=push`：本地提交成功、推送失败，长推送错误可展开，重试入口只推送；
  - `?commitdoc=1`：给提交详情补一个 `README.md`，用来走「历史差异 → 阅读文档」入口（默认数据不变，不影响既有对照截图）；
  - `?edit=conflict` / `?edit=fail` / `?edit=mixed`：轻量编辑的保存冲突（草稿保留、不能按旧基线再保存）、写入失败（草稿保留、可就地重试）与混合行尾只读；不带参数时保存只改写 mock 内存里的文件内容，不代表真实写入；
  - `?terminal=error` / `?terminal=exited` / `?terminal=write`：底部终端的启动失败、打开时已退出（可重新启动）与写入失败。默认 mock 只在内存里回显输入，输入 `exit` 回车后给出退出码 0；它不执行真实命令，也不代表桌面 PTY 行为；
  - `?recent=many`、`?recent=empty`、`?git=missing`、`?merge=conflict`、`?filter=truncated`、`?filter=error`、`?search=error` 等按异常状态展开。`?filter=error` 让树过滤的全仓补齐整体失败（说明里给「重试补齐」），`?search=error` 让全仓库文本搜索与文件内查找都失败（各自给出「重试搜索 / 重新读取目录」与「重试查找 / 重新读取文件」）。
- `mock-files.ts` / `samples.ts`：目录、文档与差异样例。`README.md` 覆盖中文标题、同名重复标题、GFM 表格、只读任务列表、相对/缺失/外链、本地图片与远程图片占位。
- `baseline-shots.mjs`：用 Chrome DevTools Protocol 驱动真实浏览器，按「起始页/改动/历史/任务/工作区总览/提交区/合并/设置」× 深色/浅色 × 1280×840/900×600 截图；Markdown 阅读样例另存为 `files-markdown`、`files-markdown-toc`，manifest 里 `group: "markdown"`，与对照图分开统计（新样例不能混进优化前后对照）；再用 `?remote=unchecked`、`?remote=stale`、`?commit=error`、`?commit=push`、`?doc=error`、`?doc=large`、`?search=error`、`?filter=error`、文件内查找失败、`?task=error` 与 `?history=hang` 截 11 个关键失败/未知状态（`group: "failure"`）。manifest 顶层写当前 workflow 标识（`2026-11-09-ai-coding-ui-ux`）与 `capturedAt`，runner 会核对这两项。失败态采哪几种「主题 × 尺寸」组合由 `--failure-targets` 决定（逗号分隔的 `<theme>:<size>`，默认 `dark:1280x840,light:1280x840,dark:900x600`；列四种即采全四组合），拼错的组合会打印可选值而不是安静跳过。产物命名是 `<theme>-<size>-<view>.png`，写到 `--out` 目录；`manifest.json` 默认写到 `--out` 的上一级（可用 `--manifest` 覆盖），`shots` 逐张记录 `theme/size/view/group/state/bytes/sha256`，收尾按 `group` 打印三类数量，与 `docs/verification/ui-ux-markdown-2026-11-08/manifest.json` 的结构一致。`--base` 换地址，`CHROME_PATH` 指定浏览器。
- 任务、工作区总览与历史取消（T5 新增，全部只用于界面呈现）：
  - `?task=error`：起点校验失败——任务页就地说明「起点不是当前分支的祖先」，并给出重新读取与重选起点；
  - `?task=empty`：成功读取但任务为空（空任务只在完整读取成功后才出现）；
  - `?worktree=stale`：主仓库的远程状态标为「过期」，其余项仍按真实状态逐项显示；
  - `?worktree=error`：整批工作区状态读取失败（界面必须说明整批失败，不能把旧数字当新鲜结果）；
  - `?history=hang`：最新的两条提交详情永不返回，用来复现「旧批次在途请求挂住、换一批选择还要能读」；
  - `?history=detail-error`：多选详情全部失败，界面给失败说明与「重新读取所选提交」。
- `check-scenarios.mjs` 的键鼠场景用 CDP `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent` / `Input.insertText`
  发真实输入（不是 `element.click()` 或直接改 value）：任务打开、连续审阅（Alt+M / Alt+Shift+→）、空格整文件暂存、
  提交区提交、历史换选择后的加载结束，以及工作区总览的分组/未知/缺失/过期。滚动定位关掉了平滑滚动，并对候选点做
  `elementFromPoint` 命中测试，避免点到吸顶标题上。
- `check-scenarios.mjs`：异常、大规模、提交/同步失败与 Markdown 阅读场景的可复跑自检（41 个场景，含轻量编辑的保存/冲突/写入失败/混合行尾只读、文档预览、目录、源码往返、相对链接、超限退路、读取失败、历史提交里的 Markdown 差异、远程未核/过期、提交失败展开，以及终端的展开/输入退出、启动失败、已退出重启与写入失败）。其中「目录列出中文重复标题且各自可辨」会实际点击两个同名目录项，核对 heading 锚点不同、`aria-current` 落在各自条目且滚动位置不同；三个查找失败场景（全文搜索、树过滤补齐、文件内查找）会实际点击恢复按钮并核对同一条失败重新出现，确认恢复入口可执行。

## 静态单文件页（没有常驻服务器时）

有些环境不允许长期驻留的开发服务器，也不允许从子进程启动浏览器。这时可以把同一份预览构建成单文件页再用浏览器打开，数据与配置完全一致：

```bash
# 1) 构建（mock 替换仍由 preview 配置完成）
node node_modules/vite/bin/vite.js build --config scripts/ui-preview/vite.config.mjs --configLoader native --base ./ --outDir /tmp/twiglane-ui

# 2) 把入口 JS 与 CSS 内联进 index.html，得到可以直接用 file:// 打开的单文件页
#    需要把异步分块一起合进来时，用 Vite 的 JS API 构建并设置 output.codeSplitting: false
```

`file://` 下无法创建工作线程，页面需要把 `window.Worker` 置空，Markdown 解析会走 `client.ts` 的内联退路——解析器与排版结果相同，只影响解析线程。截图与自检仍应按上面的脚本在正常环境中重跑，不要把静态页结果当作 `preview:ui` 的替代。

## 边界

截图与自检只证明浏览器 + mock 数据下的外观和可达性，不能替代真实 Git 行为、桌面 WebView 或平台验证。`npm test` 里的 `tests/ui-preview.spec.ts` 会真起一次 dev server 校验 mock 替换与端口守卫。

## 一键复跑（场景 + 截图）

```bash
node scripts/run-ui-verification.mjs
```

它按顺序做四件事，任何一步失败都以非 0 退出并把原因写进 `report.json`。默认把场景、截图、manifest 与 report
全写到操作系统临时目录（终端会打印路径），只有显式 `--out` 才写调用者目录，正式验证不会改写候选输入：

1. 确认 1430 空闲，否则直接报「端口被占用」而不是对着旧页面出证据；
2. 用 `scripts/ui-preview/vite.config.mjs` 起 mock 预览，轮询 `/__ui-preview/health` 直到 `mockApi` 为 `true`；
3. 跑 `check-scenarios.mjs`（场景自检，含键鼠闭环）；
4. 跑 `baseline-shots.mjs`：两主题 × 1280×840/900×600 的起始页、改动、历史、任务、工作区总览、提交区与设置，
   外加失败/未知状态（`group: "failure"`）与「历史多选换选择后恢复」的证据图。

可选参数：`--skip-shots` 只跑场景、`--only <场景名片段>` 只跑匹配的场景、`--base` 换地址、`--out <目录>` 归档证据（例如 `--out docs/verification/ai-coding-ui-ux-2026-11-09`）。runner 会核对场景与截图两个子进程的退出码、本次新写出的 `capturedAt`、manifest 的 workflow 标识与逐张截图文件；零场景、子失败或沿用旧 manifest 都判为 failed 并非 0 退出。

### 采集不到时的写法

截图脚本对「这一版界面本来就没有入口」的视图不再抛错中断：它把这件事实写进 manifest 的 `skipped` 与
`report.json`，并在终端打印跳过原因。**没有采集到的对照图不会用旧图或合成图补齐。**
