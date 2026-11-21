# 本地/远端共享行为夹具（remote parity）

这里放**两侧共用的场景清单**，不是某一端的测试代码。

- `scenarios.json`：每个场景有稳定的 `id`、涉及的 op、步骤和期望值（`expect`）。
  两侧各自用真实 Git 执行同一组步骤，并核对同一组期望值：
  - 远端：`remote-agent/v2/tests/protocol.rs` 的 `shared_parity_scenarios_drive_the_remote_agent`
    直接用 `include_str!` 读本文件，按 `expect` 里的值断言，因此改期望值只改这一份。
  - 桌面：按 `id` 引用同一场景（`src-tauri/src/git` 的回归与 `cargo test --manifest-path
    src-tauri/Cargo.toml git::` 覆盖同一批共享实现），不复制步骤文本。
- 断言只在两端各自的实现里写：本文件描述「应该发生什么」，不描述「怎么读 DTO」。
  新增场景时保持 `expect` 里只放稳定、可观察的值（文件内容、次数、错误码），
  不放 generation、时间戳这类每次运行都会变的值。
- T3 新增的 `file-tree-edit-version` 与 `remote-pty-round-trip` 描述的是文件与终端行为：
  远端由 `remote-agent/v2/tests/protocol.rs` 直接驱动；桌面侧的对应断言来自共享实现自己的
  回归（`cargo test --manifest-path src-tauri/Cargo.toml git::` 覆盖 `git::files`，终端由
  `src-tauri/src/terminal.rs` 的单元测试覆盖），因此这两条场景的本机一半是「同一份实现被覆盖」，
  不是另写一份步骤文本。
