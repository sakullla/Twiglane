# 独立 benchmark

这些命令按需运行，不属于单元测试，不由 CI 自动执行，也不使用耗时阈值决定测试通过。

```sh
npm run benchmark:git -- text
npm run benchmark:git -- paging
npm run benchmark:git -- all
npm run benchmark:status -- HEAD
npm run benchmark:text
```

`text` 对比有无缓存时的 104 MB 文本续读和历史差异分页；两组 Git 对比都先完成环境探测与文件目录预热，文本缓存组先建立前页位置。首次打开或首次定位未读区域仍须扫描。`paging` 测量 50,000 行补丁的分页构造；`all` 还生成 5,002 个分支和 20,000 个文件，执行真实列表、预检、合并和状态读取。

Git benchmark 通过 `cargo run --features benchmarks --example benchmark-git` 执行，默认是未优化构建。`status` 独立编译指定提交与当前工作区的状态解析器，测量时间和分配；没有启动桌面 WebView。耗时受编译模式、磁盘缓存和系统负载影响，不等同于桌面帧率或应用 RSS。

`text` 命令使用 Node 22 的 TypeScript 类型剥离，运行冲突解析与来源标记的纯逻辑测量。原先单元测试中的 1.5 秒耗时断言已移除。

工具使用临时匿名仓库和隔离的 Git 配置，不修改个人仓库；结束后清理临时数据。断言只用于确认被测结果有效，不把计时阈值设为通过条件。

功能性规模回归移到 `tests/integration`，用 `npm run test:integration` 运行；只检查 DOM 数量、请求并发、取消与数据正确性，不输出 benchmark 计时。
