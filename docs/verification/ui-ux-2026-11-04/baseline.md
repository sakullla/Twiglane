# UI/UX 优化前基线（2026-11-04）

对应任务：`docs/sakullla-workflow/2026-11-04-ui-ux-optimization/03-execution-plan.md#tasks/T1`，需求 R8。
本文件只记录**浏览器模拟预览**的观察结果与预览链路修复证据；不代表真实 Git 行为，也不代表 Windows/macOS 桌面实机结果。

## 1. 修复前的观察路径故障

现象：`npm run preview:ui` 后页面能渲染起始页，但控制台报
`Cannot read properties of undefined (reading 'transformCallback')`，点击「打开本地仓库」后报 `invoke` 未定义，最近仓库为空。
即浏览器加载的是真实 `src/lib/api.ts`，配置里的 mock 替换没有生效。

定位过程（可复现）：

1. 直接请求当前端口上的模块：`curl http://127.0.0.1:1430/src/lib/api.ts | head -3`
   → 返回 `import { normalizeError } from "/src/lib/errors.ts"`（真实 api），而不是 mock。
2. 在空闲端口用同一份配置启动：`npx vite --config scripts/ui-preview/vite.config.mjs --port 1432`
   → `/src/lib/api.ts` 返回 mock（含 `sampleFor`）。同一份配置在能监听端口时替换正常。
3. 在原端口启动并捕获错误：`node -e "createServer({configFile}).listen()"`
   → `Error: Port 1430 is already in use`；`npm run preview:ui` 的 CLI 只输出一行
   `error when starting dev server:`（Vite 8.3.5 在该环境下不打印原因），进程以 1 退出。
4. 端口占用者是一个更早启动、未加载 mock 插件的 Vite dev server（返回 `/@vite/client` 与真实 api）。
   浏览器标签页仍连着它，于是「起始页能看、进工作区就报 Tauri 错误」。

结论：故障不是 Svelte/Vite 解析出了错，而是**预览没有真正启动却看起来像启动了**——
端口被旧服务占用、CLI 静默失败、页面没有任何手段区分「mock 预览」与「旧的真实 api 服务」。
排查期间终止了占用 1430 的陈旧 node 进程，未修改仓库内其它内容。

## 2. 修复内容（均在 `scripts/ui-preview/` 内）

- `vite.config.mjs`
  - mock 替换改为**按解析后的真实文件判断**：不只匹配 `/api$/` 形式，而是把候选文件与 `src/lib/api.ts` 归一化比较
    （统一分隔符、去 query/hash、忽略大小写、必要时 `realpath`），URL 形式 `/src/lib/api.ts` 同样覆盖；不再有"看起来像 api 就替换"的猜测。
  - 启动前探测端口占用：占用时打印可执行的中文原因并以 1 退出（不再让 CLI 静默失败）；用进程环境变量标记区分"配置热更新重启"与"外部占用"。
  - 启动自检：如果 `./lib/api` 解析结果不是 mock，直接报错并退出，避免把真实 api 当成预览结果。
  - 新增 `GET /__ui-preview/health`：返回 `{ mockApi, resolvedApi, mockModule, realModule }`，任何人都能确认当前端口上跑的是不是 mock 预览。
  - 启动横幅打印预览地址与 mock 文件路径。
- `mock-api.ts`：导出 `UI_PREVIEW_MOCK` 标识，供健康端点/回归测试区分 mock 与真实 api。
- `baseline-shots.mjs`：无额外依赖的 CDP 截图工具，固定矩阵截图并记录页面状态与控制台错误。
- `check-scenarios.mjs`：异常/大规模参数（`?recent=many`、`?recent=empty`、`?git=missing`）的可复跑自检。

修复后的自证：

```
$ curl -s http://127.0.0.1:1430/__ui-preview/health
{ "mockApi": true, "resolvedApi": ".../scripts/ui-preview/mock-api.ts", ... }

$ npm run preview:ui      # 端口被占用时
127.0.0.1:1430 已被其他进程占用，本次预览没有启动。
浏览器仍会打开旧页面，而旧服务加载的是真实 src/lib/api.ts，会报 Tauri invoke/transformCallback 错误。
处理：关闭占用该端口的旧 Vite/预览进程后重试；先用 curl /__ui-preview/health 确认当前端口是不是 mock 预览。
（退出码 1）
```

## 3. 回归测试

新增 `tests/ui-preview.spec.ts`：真起一个 Vite dev server，检查**浏览器会拿到哪个模块**，而不是比对配置字符串。

- `App.svelte` 的模块图引用 `/scripts/ui-preview/mock-api.ts`，且不再出现 `/src/lib/api.ts`；
- 直接请求 `/src/lib/api.ts` 返回 mock（含 `UI_PREVIEW_MOCK`、`preview-theme`），且不含 `@tauri-apps_api_core`；
- 同目录其它模块（`./lib/errors`、`/src/lib/diff.ts`）不被误替换；
- `/__ui-preview/health` 自证 `mockApi: true`；
- `sameFile` 对大小写、反斜杠、query/hash 的归一化，以及不同文件的不相等。

负向对照：临时移除 mock 插件后运行该测试，3 条断言失败（模块图、直接请求、健康端点）；恢复后 5 条全通过。
说明测试能区分「替换生效」与「替换失效」，不是恒真断言。

## 4. 环境

| 项 | 值 |
| --- | --- |
| 系统 | Windows 10.0.26300（x64） |
| 运行时 | Node.js v26.4.0、npm（仓库锁文件依赖） |
| Vite | 8.3.5（rolldown 版 CLI） |
| 浏览器 | Chrome 156.0.8078.80，headless |
| 预览 | `http://127.0.0.1:1430`，mock 数据来自 `scripts/ui-preview/mock-api.ts` |
| 数据 | mock 内置样例：13 个改动文件（14 行含编辑器行）、合并冲突 3 个、历史 28/23 行 |

## 5. 优化前基线（同数据、同环境）

截图目录：`docs/verification/ui-ux-2026-11-04/baseline/`，共 20 张（5 个界面 × 2 主题 × 2 窗口），
每张图的页面状态（`data-theme`、背景色、弹窗标题、行数、是否横向溢出）记录在 `manifest.json`。

| 界面 | 进入方式 | 深色 1280×840 | 浅色 1280×840 | 深色 900×600 | 浅色 900×600 |
| --- | --- | --- | --- | --- | --- |
| 起始页 | 直接打开 | `dark-1280x840-start.png` | `light-1280x840-start.png` | `dark-900x600-start.png` | `light-900x600-start.png` |
| 改动 | 点击最近仓库 | `dark-1280x840-changes.png` | `light-1280x840-changes.png` | `dark-900x600-changes.png` | `light-900x600-changes.png` |
| 历史 | 视图切换 | `dark-1280x840-history.png` | `light-1280x840-history.png` | `dark-900x600-history.png` | `light-900x600-history.png` |
| 合并 | 命令面板「分支合并」 | `dark-1280x840-merge.png` | `light-1280x840-merge.png` | `dark-900x600-merge.png` | `light-900x600-merge.png` |
| 普通弹窗（设置） | 命令面板「设置」 | `dark-1280x840-settings.png` | `light-1280x840-settings.png` | `dark-900x600-settings.png` | `light-900x600-settings.png` |

可核对的状态值（取自 `manifest.json`）：

- 主题确实生效：深色 `body` 背景 `rgb(13, 14, 17)`，浅色 `rgb(244, 244, 246)`；`document.documentElement.dataset.theme` 分别为 `dark` / `light`。
- 改动视图 14 行、历史视图 1280×840 为 28 行、900×600 为 23 行（可见区域渲染，窗口变矮行数变少属预期）。
- 合并弹窗标题「合并分支」、设置弹窗标题「设置」，两种尺寸下都能通过命令面板进入。
- 8 次会话（2 主题 × 2 尺寸 × 5 界面）合计 20 张截图，控制台错误 0 条（修复前起始页即有 Tauri 错误）。
- 两种尺寸下 `document.documentElement.scrollWidth === clientWidth`，页面无横向溢出。

场景自检（`node scripts/ui-preview/check-scenarios.mjs`，4/4 通过）：

| 场景 | 参数 | 观察结果 |
| --- | --- | --- |
| 默认起始页 | 无 | 5 行最近仓库 |
| 大规模最近仓库 | `?recent=many` | 头部计数「共 500 个」，只渲染前 5 行 |
| 空最近仓库 | `?recent=empty` | 「还没有最近仓库，先打开或克隆一个。」 |
| Git 缺失 | `?git=missing` | 「没有找到 Git，请安装后重新检测」 |

## 6. 复现方式

```bash
npm run preview:ui                                        # 另开终端，确认 mock 生效
curl -s http://127.0.0.1:1430/__ui-preview/health         # 期望 "mockApi": true
node scripts/ui-preview/baseline-shots.mjs                # 20 张基线截图 + manifest.json
node scripts/ui-preview/check-scenarios.mjs               # 异常/大规模参数自检
npx vitest run tests/ui-preview.spec.ts                   # 预览替换回归
```

截图输出目录可用 `--out` 覆盖；换浏览器可用 `CHROME_PATH` 指定。

## 7. 已知限制

- 全部证据来自 **headless Chrome + mock 数据**：字体渲染、DPI、滚动条、动画与真实 WebView2（Windows）/
  WKWebView（macOS）不完全一致，不能据此判断桌面观感或自绘标题栏结果。
- mock 只模拟接口返回，**不验证真实 Git 行为**（暂存、提交、合并、冲突写回、远程操作均未在真实仓库上执行）。
- 覆盖的是 1280×840 与 900×600 两个尺寸、深/浅两主题；未覆盖 4K/HiDPI、窗口最大化、系统缩放、
  减少动态效果、纯键盘操作路径与屏幕阅读器。
- 未覆盖大规模数据下的性能（500 分支、20,000 文件等压力场景仍需 `npm run test:performance` 单独测量）。
- 截图只证明被截到的这一刻；后续任务改动 `src/` 后需要重新生成，不能沿用本目录作为新基线。
