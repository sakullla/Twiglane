# 测试分工

使用 Node.js 26（与 `.nvmrc`、CI 和发布构建一致）。

- `npm test`：纯逻辑和组件回归，使用 4 个隔离线程；不共享测试文件的 mock 状态。
- `npm run test:integration`：真实 Vite 预览接线与大列表功能边界，CI 单独执行。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：原生行为与真实 Git/PTY 回归。
- `npm run benchmark:git -- text`、`npm run benchmark:status -- HEAD`：可选测量，见 [benchmark 说明](../scripts/benchmarks/README.md)。不属于测试套件。

纯逻辑套件使用 Node 环境；DOM 交互使用 happy-dom。编辑文本与读取生命周期的小套件分别集中在 `editor-text.spec.ts` 和 `read-lifecycle.spec.ts`，避免为每个小模块重复创建 worker。

优先测试用户行为、错误边界、取消/过期响应、资源上限和 Git 写入安全。避免重复锁定 CSS 色值、像素、文件结构和文案；主题只保留一致性、对比度、焦点和减少动效的契约。状态机定时行为可使用假时钟；超时保护用于发现挂起，不作为性能基准。

原生菜单单元测试只验证事件路由，不在 Rust 测试线程创建要求主线程的 macOS 菜单。
