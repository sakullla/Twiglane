# v0.2.18 验证记录

日期：2026-11-06 · 环境：Windows 11 Pro 10.0.26300 · Node 22 / Rust stable / 系统 Git

## 实际执行的验证

以下命令在发布提交上一次通过（完整日志存于 workflow 本地证据 `docs/sakullla-workflow/2026-11-05-app-update/delivery-report.yaml`，candidate `fe4d779` 代码基线 + 本发布提交的版本号同步改动）：

- `npm run check`：458 文件，0 错误 0 警告。
- `npm test`：32 个文件 764 用例全部通过，其中 `tests/app-update.spec.ts` 19 例覆盖更新事件写入、手动检查三路径、下载进度与重启、失败保留与重试、防重入、deb 不支持应用内安装、状态栏入口与一次性提醒。
- `cargo test --manifest-path src-tauri/Cargo.toml`：159 用例通过，含 `update` 模块（静默边界、事件 payload 契约、installSupported 判定与命令同源）与 capabilities/security 契约测试。
- `cargo clippy --all-targets -- -D warnings`：无告警。

四项独立审查（T1 后端、T2 前端两次含返修复审、T3 提示载体、T4 发布链）与 Delivery Review 均通过，无阻断问题；一条非阻断备注：`auto_check_update` 的 `check()` 网络失败静默分支与 `updater()` 不可用分支共用同一返回表达式，仅后者有直接测试。

## 未验证边界

- 真实更新链路（旧版本客户端检出 latest.json → 下载验签 → 安装 → 重启进入新版本）依赖本版本先发布；属下个版本的端到端验收项。
- GitHub Actions 上 tauri-action 自动产出 `.exe.sig` / `.AppImage.sig` / `.deb.sig` 与 macOS `.app.tar.gz` 格式沿用 cliora 已发布验证的同构机制，本仓库 CI 首次执行以 verify-release 资产校验为准（缺失即失败，不发布无签名资产）。
- macOS 与 Linux 安装包未在本机安装验收（与 v0.2.17 记录一致）；`npm run verify:delivery` 所需的 `docs/verification/report.json` 流程本版本未使用，验证以上述直接执行结果为准。
