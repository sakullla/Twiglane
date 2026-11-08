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
  - `?recent=many`、`?recent=empty`、`?git=missing`、`?merge=conflict`、`?filter=truncated`、`?search=error` 等按异常状态展开。
- `mock-files.ts` / `samples.ts`：目录、文档与差异样例。`README.md` 覆盖中文标题、同名重复标题、GFM 表格、只读任务列表、相对/缺失/外链、本地图片与远程图片占位。
- `baseline-shots.mjs`：用 Chrome DevTools Protocol 驱动真实浏览器，按「起始页/改动/历史/合并/设置」× 深色/浅色 × 1280×840/900×600 截图；Markdown 阅读样例另存为 `files-markdown`、`files-markdown-toc`，manifest 里以 `group: "markdown"` 与对照图分开统计（新样例不能混进优化前后对照）；再用 `?remote=unchecked`、`?remote=stale`、`?commit=error`、`?commit=push`、`?doc=error`、`?doc=large`、`?search=error` 截 7 个关键失败/未知状态（`group: "failure"`，两主题 1280×840 + 深色 900×600）。产物命名是 `<theme>-<size>-<view>.png`，写到 `--out` 目录；`manifest.json` 默认写到 `--out` 的上一级（可用 `--manifest` 覆盖），逐张记录 `theme/size/view/state/bytes/sha256`，与 `docs/verification/ui-ux-markdown-2026-11-08/manifest.json` 的结构一致。`--base` 换地址，`CHROME_PATH` 指定浏览器。
- `check-scenarios.mjs`：异常、大规模、提交/同步失败与 Markdown 阅读场景的可复跑自检（25 个场景，含文档预览、目录、源码往返、相对链接、超限退路、读取失败、历史提交里的 Markdown 差异、远程未核/过期与提交失败展开）。其中「目录列出中文重复标题且各自可辨」会实际点击两个同名目录项，核对 heading 锚点不同、`aria-current` 落在各自条目且滚动位置不同。

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
