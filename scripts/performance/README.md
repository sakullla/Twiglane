# 性能工具已迁移

独立 benchmark 的运行方式见 [benchmarks/README.md](../benchmarks/README.md)。

- `npm run benchmark:git -- text`：Git 与大文本耗时测量。
- `npm run benchmark:status -- <baseline-commit>`：状态解析器耗时与分配测量。
- `npm run test:integration`：只验证真实预览接线、虚拟渲染、读取并发等功能边界，不测量或断言耗时。

benchmark 不再注册为 Vitest 或 Rust 测试，普通测试和 CI 都不会运行 benchmark。
