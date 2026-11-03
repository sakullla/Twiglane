# 性能压力工具

使用 Node.js 22、稳定版 Rust 和系统 Git，在仓库根目录运行：

```sh
npm run test:performance
npm run test:performance -- --ui
npm run test:performance -- --git
```

规模用例集中在本目录，由 `PerformanceFixture` 生成匿名数据。普通 `npm test` 和 `cargo test` 不执行这些用例；Rust 用例仅在启用 `performance-tests` feature 时编译。

- UI：5,000 个分支、20,000 个文件和冲突、单文件 5,000 行，检查 DOM 数量、请求并发、远距离导航和旧响应隔离。
- Git：临时仓库生成 5,002 个分支、20,000 个文件，运行真实列表、提交详情、文件差异、合并预览和快进合并；检查目录缓存与 generation 边界，并输出耗时。

所有路径、分支和内容均为生成的测试数据，不使用个人仓库。原生用例会在系统临时目录写入大量文件，结束后自动清理。耗时受磁盘、杀毒软件和系统负载影响，不作为跨机器的固定阈值。happy-dom 检查不能代替桌面 WebView 的帧率测量。

优化参考：[Svelte 原始状态](https://svelte.dev/docs/svelte/$state#state.raw)、[响应式副作用依赖](https://svelte.dev/docs/svelte/$effect)、[Git 状态性能](https://git-scm.com/docs/git-status)、[Tauri 异步命令](https://v2.tauri.app/develop/calling-rust/)。工具不会修改个人 Git 配置。
