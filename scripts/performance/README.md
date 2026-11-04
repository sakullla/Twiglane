# 性能压力工具

使用 Node.js 22、稳定版 Rust 和系统 Git，在仓库根目录运行：

```sh
npm run test:performance
npm run test:performance -- --ui
npm run test:performance -- --git
```

规模用例集中在本目录，由 `PerformanceFixture` 生成匿名数据。普通 `npm test` 和 `cargo test` 不执行这些用例；Rust 用例仅在启用 `performance-tests` feature 时编译。

- UI：5,000 个分支、20,000 个文件和冲突、单文件 5,000 行，以及 20,000 行替换和多提交文件并集；检查 DOM 数量、请求并发、远距离导航和旧响应隔离。
- Git：临时仓库生成 5,002 个分支、20,000 个文件，运行真实列表、文件大小批量读取、提交详情、文件差异、合并预览和快进合并；检查大小读取的进程数量、目录缓存与 generation 边界，并输出耗时。
- 本地未提交：20,000 个文件的选择刷新只索引一次文件列表；多文件差异跳转到末尾时仍限制为 3 个在途读取，隐藏页面后丢弃迟到内容。另用 50,000 行差异连续构造 300 个 400 行页面，测量分页处理耗时。

只运行分页微基准：

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --features performance-tests uncommitted_diff_paging_at_scale -- --nocapture
```

本次优化的范围、对比结果与验证限制见 [2026-11-04 未提交改动性能记录](../../docs/verification/uncommitted-performance-2026-11-04.md)。

所有路径、分支和内容均为生成的测试数据，不使用个人仓库。原生用例会在系统临时目录写入大量文件，结束后自动清理。耗时受磁盘、杀毒软件和系统负载影响，不作为跨机器的固定阈值。happy-dom 检查不能代替桌面 WebView 的帧率测量。

优化参考：[Svelte 原始状态](https://svelte.dev/docs/svelte/$state#state.raw)、[响应式副作用依赖](https://svelte.dev/docs/svelte/$effect)、[Git 状态性能](https://git-scm.com/docs/git-status)、[Tauri 异步命令](https://v2.tauri.app/develop/calling-rust/)。工具不会修改个人 Git 配置。
