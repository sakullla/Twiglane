# Twiglane（枝序）

让每次改动，都清晰有序。

Twiglane 是面向个人开发者和小团队的轻量 Git 桌面客户端。安装名称和主界面使用 Twiglane，中文介绍使用枝序。首版围绕本地仓库的日常操作，不内置研发平台、专用资源管理或 AI 聊天。

## 当前工作区

应用使用 Tauri 2、Rust 和 Svelte/TypeScript。界面是中文三栏：最近仓库、改动与提交说明、差异。添加目录只检查它是不是 Git 仓库；只有在确认“初始化仓库”后才会新建。无效路径不会创建目录，也不会改写原文件。

最近仓库按完整路径区分同名项目，可搜索，并在重启后保留。主题、面板宽度和每个仓库的提交草稿写入应用数据目录，使用临时文件替换完成原子更新。配置不保存远程地址、令牌或私钥；草稿里疑似凭据会被拒绝。

Git 由 Rust 以参数数组异步启动，不经过 shell。同一仓库的写操作串行，读取最多同时两个；响应带有 generation，过期结果不会当成当前状态。输出超过上限会停止进程。错误会脱敏。外部文件变化会去抖后刷新，窗口重新聚焦时也会刷新；关闭窗口会停止监听和进行中的 Git 进程。监听不可用时，只在窗口处于前台时低频重新读取。

远程检查、提交、推送和安装包验证不属于这一层。状态栏中的上游数字只表示本地已记录的跟踪信息，并标为“未检查远程”。

## 开发

需要 Node.js、Rust、系统 Git，以及 macOS 上的 Xcode 或 Windows 上的 WebView2。推荐 Git 2.48 或更高版本；更低版本会提示并继续尝试。图形界面的 PATH 可能和终端不同，因此启动时会检查 PATH 与常见安装位置，也可以手动选择 `git` 可执行文件。

```bash
npm install
npm run tauri dev
```

开发测试：

```bash
npm run check
npm run test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

这些命令只覆盖当前开发环境。正式交付还需要双平台安装包、协议和性能记录，不能用这里的本地测试代替。

## 数据

应用状态位于系统提供的应用数据目录中的 `state.json`。从最近列表移除仓库只会更新这份列表，不会删除仓库文件。
