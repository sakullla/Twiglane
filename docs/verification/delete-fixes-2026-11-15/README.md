# 删除行为修复验证

验证环境：Windows，Node.js 26.4.0，Rust 1.99.1。

## 修复与复现

- Windows 文件删除原先无回收站适配器，直接返回 `entry_platform_unsupported`。现在通过 Windows `IFileOperation` 回收文件和非空目录，固定祖先目录句柄，在 Shell 删除前后核对目标身份，拒绝 reparse point、Git 元数据及嵌套仓库。
- 勾选“同时删除本地分支”后，Git 拒绝删除未合并分支的说明原先被列表刷新立即清空。新增回归先复现了说明丢失及缺少后续确认，现在刷新后保留结果，并接续图标原有的“仍然删除”确认。
- 右键、更多菜单和图标使用同一删除入口。工作区移除、Git 拒绝操作造成的代次变化统一重试一次；未合并分支必须再次确认，权限等其他错误不升级为强删。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 0 errors，0 warnings |
| `npm test` | 53 个文件，1423 项通过 |
| `npm run build` | 通过，保留已有的大分块提示 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 369 项通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| `npm run verify:delivery` | 未通过：仓库缺少 `docs/verification/report.json` |

Rust 回归实际将中文/空格文件名和非空目录放入 Windows 系统回收站，核对内容、原始恢复路径、HEAD/index 不变、代次推进及过期请求拒绝；之后只还原本次测试创建的回收站条目。另覆盖目标替换、祖先目录固定、reparse point、嵌套仓库、回收站失败及失败后的状态刷新。

## 界面证据

浏览器使用 `preview:ui` 的 mock 数据，将未强删的 `deleteBranch` 请求注入为 `branch_unmerged`。勾选并删除工作区后，确认按钮变为“仍然删除”，焦点为“取消”；再次确认后才发送 `force=true` 请求并移除分支。

- [勾选删除本地分支](worktree-delete-option.png)
- [未合并分支再次确认](unmerged-branch-confirm.png)
- [浏览器请求与焦点记录](browser-result.json)

截图只证明浏览器中的界面流程，真实 Windows 回收站行为由 Rust 回归验证。未测试 macOS/Linux 运行时，也未构建或安装新版桌面安装包；本记录不代表完整交付认证。

实现参考：[Microsoft IFileOperation 操作标志](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags)、[删除前回调与取消规则](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperationprogresssink-predeleteitem)。
