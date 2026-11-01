# Windows 仓库打开与后台进程验证

## 修改

- Git 统一进程启动器在 Windows 使用 `CREATE_NO_WINDOW`，保留管道输出、错误输出、退出码、取消和超时处理。用户主动打开资源管理器的行为保持不变。
- 接收 Tauri 原生文件拖放事件，通过 `add_repository` 校验并打开目录；子目录仍由后端归一到仓库根目录。
- 拒绝多路径、操作进行中和对话框打开时的拖放；失败保留当前仓库，不初始化目录。
- 切换前保存当前提交草稿；保存失败保留输入。拖放监听在卸载后及时注销，包括异步注册晚于卸载的情形。
- 原生测量遇到刷新错误时报告失败，避免把保留的旧快照算成成功。
- 库目标改名为 `twiglane_lib`，消除 Windows 库和可执行文件争用 `twiglane.pdb` 的 Cargo 警告，应用名称和标识不变。
- 发布版本升级为 `0.2.6`；现有 exact-SHA main CI 发布门禁与固定 macOS 签名保持不变。
- 未修改主题色。

## 性能与内存

- 同一仓库会话的密集刷新合并为一项在途读取和一次后续读取；20 个同时到达的事件回归只发起 2 次状态读取。
- 仓库重开后拒绝旧会话响应；旧 generation 不回退当前状态，也不会自行触发无上限重试。
- 不可变的仓库快照和差异使用 Svelte raw state，避免大型数组及每行对象的深层代理开销。
- 高亮缓存同时受 48 项 LRU 和 8 MiB 估算保留开销约束。超过单项预算的内容仍然显示，但不留在缓存中。该预算不是应用总内存上限。
- 大文档逐行计算缓存键，避免 `join` 再复制一份完整文本；命中时只更新 LRU 顺序，不重新遍历 token。
- 高亮 Worker 空闲 30 秒后终止以释放加载过的语法和引擎，缓存命中仍保留；新任务会取消释放计时。已完成任务的迟到取消消息不再累积取消标记。
- Vite Worker 使用 ES module 输出，保留语言语法的动态加载。旧 IIFE Worker 入口为 8,174,708 字节，新入口为 189,017 字节；约减少 97.7%。这比较的是 Worker 入口，不是安装包总大小。

## 自动化检查

- Node.js 22：`npm run check`，0 errors / 0 warnings。
- `npm test -- --maxWorkers=1`：206 项通过；随后新增旧 generation 不无限重试的回归，再运行外壳测试，21 项通过。最终高亮与测量相关测试联合复核，22 项通过。
- Rust：`cargo test --locked --manifest-path src-tauri/Cargo.toml -- --test-threads=4`，94 项通过，0 ignored；设置 `RUSTFLAGS=-D warnings`、`RUSTDOCFLAGS=-D warnings`。
- 严格 Clippy：`cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` 通过，同样启用上述 Rust 警告门禁。
- `rustfmt --edition 2021 --check src-tauri/src/git/runner.rs` 通过。全仓 `cargo fmt --check` 仍报告原有文件中的格式差异，未混入本次修改。

## 进程回归判据

`CREATE_NO_WINDOW` 保留没有窗口的控制台，`GetConsoleCP()` 仍可能返回 936，不能用编码值作为弹窗判据。回归实际运行 Python 子进程，断言无窗口且没有继承父测试进程的控制台，同时验证 stderr 和非零退出码。

本机对照实验：未设置标志时结果为 `0 1`（继承当前隐藏终端），设置后为 `0 0`（无窗口、未继承父控制台）。Rust 回归要求后者。

## v0.2.6 原生构建与实测

- `npm run tauri -- build --bundles nsis` 成功；Windows EXE 的 ProductVersion/FileVersion 均为 `0.2.6`。启用 Rust/Rustdoc 警告门禁，无 Rust/Cargo 警告；Vite 仍提示个别按需加载的语法包超过 500 kB。
- 可执行文件：`C:/Users/12976/.cargo/target/release/twiglane.exe`。
- 安装包：`C:/Users/12976/.cargo/target/release/bundle/nsis/Twiglane_0.2.6_x64-setup.exe`，4,137,997 字节。
- Rillight 实际仓库：`C:/Users/12976/project/Rillight`，3 次打开、30 次刷新全部通过；提交 ID 为 `0ef51f9ab8bb1e20d88ce022e1a00b37322646e7`，工作区改动数为 0，进程正常退出。
- TypeScript、Rust、C++ 在原生 WebView2 中按需加载高亮，原文还原和样式 token 检查均通过。[原生样本](raw/windows-v026-smoke.jsonl)

### 性能对照

比较本轮性能优化前的本地 0.2.5 修复构建与最终 0.2.6 release 构建。各执行 30 次刷新，每秒采样应用及 WebView2 子进程；空闲内存取结束前 10 至 2 秒的中位数。高亮场景使用独立临时仓库中的 1000 行 TypeScript 改动，未改写 Rillight。

| 场景 | 刷新中位数 ms | 刷新 P95 ms | 空闲私有提交量 MiB | 峰值私有提交量 MiB |
| --- | ---: | ---: | ---: | ---: |
| Rillight，优化前 | 55.65 | 71.50 | 303.00 | 313.77 |
| Rillight，优化后 | 58.85 | 66.30 | 340.08 | 344.52 |
| TypeScript 差异，优化前 | 235.40 | 278.10 | 312.69 | 496.41 |
| TypeScript 差异，优化后 | 200.75 | 516.60 | 260.19 | 459.64 |

高亮场景空闲私有提交量在此样本下降约 16.8%，峰值下降约 7.4%。干净仓库的私有提交量没有下降，TypeScript P95 存在较大波动，因此不能据此宣称所有场景都更快或总内存固定下降。私有提交量不是物理 RAM，工作集相加还可能重复计算共享页；这是单机观察，不是跨平台性能验收。[原始对照样本](raw/windows-v026-performance.json)

## 验证边界

文件夹拖放已验证事件处理、错误和并发守卫，未进行资源管理器到窗口的人工鼠标拖放验收。未进行本轮 macOS、Linux 原生验证。

`npm run verify:delivery` 仍未通过：现有总报告缺少跨平台安装、性能、协议等交付证据。本记录不替代完整交付验收。
