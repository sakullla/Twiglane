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
- `mock-api.ts`：mock 数据与异常/大规模参数（`?recent=many`、`?recent=empty`、`?git=missing`、`?merge=conflict` 等，见文件顶部注释）。
- `samples.ts`：差异样例文本。
- `baseline-shots.mjs`：用 Chrome DevTools Protocol 截取「起始页/改动/历史/合并/设置」× 深色/浅色 × 1280×840/900×600 的图，
  并记录页面状态与控制台错误。`--base` 换地址，`--out` 换输出目录，`CHROME_PATH` 指定浏览器。
- `check-scenarios.mjs`：异常与大规模参数的可复跑自检。

## 边界

截图与自检只证明浏览器 + mock 数据下的外观和可达性，不能替代真实 Git 行为、桌面 WebView 或平台验证。
