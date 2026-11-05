# v0.2.16 验证记录

2026-11-05，Windows x64；Node.js 22.23.4、Rust 1.99.1、Git LFS 3.7.1。

## 行为变化

- 标题栏切换分支使用一次 `for-each-ref` 的轻量接口，不再等待合入分析和工作区状态扫描。完整分支管理仍保留合入分析。取消 200 条截断，按视口渲染，保留搜索、分组、键盘导航和其他工作区保护。
- 历史单条提交右键菜单增加「撤销最近提交并保留改动」。只对当前分支 HEAD 开放，复用既有预览、确认、传播范围核对和写锁，改动保留在暂存区。旧提交和游离 HEAD 显示禁用原因。
- 历史版本、索引及工作区文件支持图片预览：PNG、JPEG、GIF、WebP、BMP、ICO、SVG；可切换改动前后和原始大小。
- ZIP、TAR、TAR.GZ/TGZ 支持目录、大小及路径筛选。只展示目录，不解压、不执行包内文件。RAR、7z 及其他格式暂不支持内容预览。
- 识别标准 Git LFS v1 指针。通过 Git LFS 定位本地缓存并核对 SHA-256 和大小；缺失时由用户点击下载，只获取所选对象，不改索引及工作区文件。需要系统安装 Git LFS，认证沿用 Git LFS 配置。
- 历史单文件及多文件视图隐藏后释放差异内容。所有预览共享两个读取槽位，关闭后删除排队请求，迟到响应不覆盖新选择。未知二进制格式不额外读取整个对象。

## 资源边界

单文件内容预览及按需 LFS 下载上限为 16 MiB；位图最多 1600 万像素。超过上限会提示原因，不尝试完整预览。压缩包最多列出 2000 项，TAR 扫描最多 64 MiB 解压内容；目录使用虚拟滚动。切换预览只保留当前版本，没有累积图片缓存。

这些边界和生命周期回归覆盖了资源增长风险；本次没有测量整机常驻内存、长期内存增长或 WebView 帧率，不宣称固定内存降幅。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误、0 警告 |
| `npm test` | 724 项通过 |
| `npm run build` | 通过；保留现有大 chunk 提示 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 149 项通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| `npm run test:performance -- --ui` | 8 项规模用例通过 |
| `npm run test:performance -- --git` | 2 项真实 Git 规模用例通过 |
| `npm run verify:delivery` | 未通过：仓库缺少 `docs/verification/report.json`；未伪造完整交付证据 |

新增覆盖包括：6000 分支滚动及末尾搜索切换、撤销 HEAD 的确认边界、图片版本隔离、2000 项压缩包目录、损坏包和输入上限、路径越界及过期 generation、真实 LFS 下载/缓存与工作区不变、50 个快速预览只启动两个请求。

最终补充检查重新运行了预览后端测试与 lint；功能不依赖外部在线 LFS 服务，LFS 集成测试使用临时本地远程。

## 性能样例

同一临时仓库包含 5002 分支、20000 文件，低并发复测结果：

| 操作 | 耗时 |
| --- | --- |
| 完整分支状态读取 | 1309 ms |
| 切换菜单轻量读取 | 810 ms |
| 20000 文件提交详情 | 3489 ms |
| 两个文件差异（其中一个 5000 行） | 134 ms |
| 20000 文件合并预览 | 272 ms |
| 20000 文件真实快进合并 | 14900 ms |
| 50000 行差异生成 300 个分页 | 22 ms |

分支轻量读取比同次完整读取少约 38% 时间，且测试断言只增加一次引用查询、不执行 status。这是单机样例，不是跨机器或所有仓库的性能承诺。首次与其他检查并行时，20000 文件合并触及测试夹具 30 秒超时；停止竞争任务后，同一用例以原阈值通过。

## 界面与平台

浏览器 mock 预览使用匿名样例，检查了图片、压缩包目录和 LFS 下载入口。截图：[图片](image-preview.png)、[压缩包](archive-preview.png)、[LFS](lfs-preview.png)。截图只证明界面显示，真实 Git 行为由 Rust 集成测试验证。

本次没有运行 macOS/Linux 原生应用或生成原生安装包；tag 推送不代表完整跨平台交付门禁通过。

实现参考：[Git LFS smudge](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-smudge.adoc)、[LFS 存储配置](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc)、[ZIP 原始目录读取](https://docs.rs/zip/9.3.0/zip/read/struct.ZipArchive.html)。
