# 石墨靛蓝界面重做验证记录（2026-11-01）

本文件记录 `docs/requirements/2026-11-01-ui-ux-重做.md` 的实际验证结果。`docs/verification/report.json` 由 `measure-delivery` / `verify-delivery` 在对应平台生成，本次未改动。旧版 `ui-rework-2026-11-01.md` 是上一轮重做的历史记录，其中的 rail 和数据不适用于本次。

环境：Linux，Node 24.22.1，`npm` 不在 PATH，正式命令直接调用 `node_modules/.bin`。候选为 `feat/ui-rework` HEAD `6767dbd` 加 T7 工作区改动。

## 一、门禁

| 命令 | 结果 | 观察 |
| --- | --- | --- |
| `svelte-check --tsconfig ./tsconfig.json --threshold error` | 通过 | 382 个文件，0 错误，0 警告 |
| `vitest run` | 通过 | 21 个文件，377 个用例（基线 20 个文件，213 个用例） |
| `vite build`（`--outDir` 指向私有目录） | 通过 | 只有 chunk 超 500 kB 的既有提示 |
| `node scripts/check-contrast.mjs` | 通过 | 1294 对；正文最低 4.58:1，交互最低 3.10:1，合成最低 4.67:1；两套主题 |
| `git diff --quiet ff78537 -- src-tauri public` | 通过 | 退出码 0，Rust 与图标未改（R16、R18） |
| `cargo test` | **未验证** | 本机缺 `cc`、`pkg-config` 与 webkit，无法运行，不记为通过 |
| `cargo clippy --all-targets -- -D warnings` | **未验证** | 同上，由 CI 或具备环境的机器补验 |

## 二、基线对比

条件：`/?merge=conflict`，mock 数据，headless Chrome，深色和浅色结果相同。预览只能证明 mock 数据下的表现。

| 指标 | 基线 | 判据 | 1280×840 实测 | 900×600 实测 |
| --- | --- | --- | --- | --- |
| 改动差异区宽度 | 约 620px | 不小于 900px | 919px | 559px |
| 完全可见差异行（`rows.txt`） | 45 | 不少于 40 | 41 | 27 |
| 完全可见文件行 | 8 | 大于 8 | 11 | 4 |
| 历史差异区宽度 | 约 440px | 大于基线 | 680px | 379px |
| 合并首屏完整冲突代码行 | 5 | 大于基线 | 6 | 5 |
| 合并代码区高度 | 482px | 参考项 | 678px | 438px |

基线来源：前四项来自 `02-technical-solution.md` 的基线表。合并两项是 T5 改动前的实测（T5 审查记录 `evidence/reviews/19.json`，提交 `f487334`，900×600 基线为 4 行），不是 `ff78537` 上的重测。判据只针对 1280×840；900×600 列用于 R4、R14 的可用性观察。

## 三、截图与横向滚动

`docs/verification/` 下共 24 张，命名 `rework-<屏>-<主题>-<宽x高>.png`：

| 屏 | 深色 1280×840 | 深色 900×600 | 浅色 1280×840 | 浅色 900×600 |
| --- | --- | --- | --- | --- |
| 改动 changes | `rework-changes-dark-1280x840.png` | `rework-changes-dark-900x600.png` | `rework-changes-light-1280x840.png` | `rework-changes-light-900x600.png` |
| 历史 history | `rework-history-dark-1280x840.png` | `rework-history-dark-900x600.png` | `rework-history-light-1280x840.png` | `rework-history-light-900x600.png` |
| 合并 merge | `rework-merge-dark-1280x840.png` | `rework-merge-dark-900x600.png` | `rework-merge-light-1280x840.png` | `rework-merge-light-900x600.png` |
| 分支 branch | `rework-branch-dark-1280x840.png` | `rework-branch-dark-900x600.png` | `rework-branch-light-1280x840.png` | `rework-branch-light-900x600.png` |
| 设置 settings | `rework-settings-dark-1280x840.png` | `rework-settings-dark-900x600.png` | `rework-settings-light-1280x840.png` | `rework-settings-light-900x600.png` |
| 起始页 welcome | `rework-welcome-dark-1280x840.png` | `rework-welcome-dark-900x600.png` | `rework-welcome-light-1280x840.png` | `rework-welcome-light-900x600.png` |

24 张逐张读回：`documentElement.scrollWidth` 等于 `clientWidth`（1280 或 900）；`.shell`、`.workspace`、`.content`、`.welcome`、`.pane`、`.file-list`、`.history-list`、`.modal-card`、`.modal-body`、`.mp-foot`、`.cr-toolbar` 等容器没有超出，也没有任何 `overflow-x: auto|scroll` 的元素出现横向滚动。代码视图（`.diff-scroll`、`.cr-scroll`、三栏编辑区）的横向滚动是功能，不在判定内。

## 四、浏览器观察

以下均为 mock 预览下的实测。

- 合并工具条：在 1280、1241、1240、1180、1101、1100、900 宽度逐档量，`.cr-toggle` 高 17px 单行，工具条 40px，`scrollWidth` 不超出，“更多冲突操作”完整可见。
- 合并底部：900×600 把标记按钮改成最长文案“先完成正在编辑的一处”后，按钮右缘 369，说明框左缘 385，不再重叠；底部 44px 单行。这一项的长文案由脚本写入，没有走真实状态。
- 合并标题行：900 宽注入长 note 和 120 字符分支名，两个分支 chip 保持 220px，只有 note 收缩，中止按钮完整。
- 长名：160 字符无断点名字写入分支删除确认、重命名区和标签删除确认后，900×600 下 `.modal-body` 的 `scrollWidth` 等于 `clientWidth`（850）。名字由脚本写入 DOM。
- 提交区：左栏最窄时（900×600 渲染宽度 244）聚焦说明框，说明框 74px，文件列表 190px；隐藏左栏、缩放窗口再显示后聚焦，说明框回到 112px，文件列表 432px；全程未写入保存值。
- Modal 焦点：Chrome 里焦点落到 body 后 Tab 回到弹窗；焦点所在按钮被禁用后 Esc 仍关闭弹窗。
- 焦点环：深浅两套主题在起始页、改动、历史、分支弹层、分支 modal、设置、合并逐个 Tab，全部控件都有 `--focus` 焦点环（深 `rgb(149,155,250)`，浅 `rgb(79,86,224)`）；两条分隔线用 `--focus` 指示条。覆盖的是 Tab 能到达的控件，方向键内部导航的条目未逐项枚举。
- 动效：普通模式打开设置和仓库弹层，运行中的动画是 `pop`；`prefers-reduced-motion: reduce` 下 `getAnimations()` 为空，`transform` 为 `none`。
- 嵌套：在主工作区统计圆角且有描边的容器（宽 120、高 60 以上）最大嵌套深度，改动 0，历史 0，历史多文件 1（`.multi-file`）。
- 起始页：`?git=missing` 下诊断只出现一处（`.infobar` 0 个，`.welcome-diagnostic` 1 个），900×600 无需滚动。
- 主题：mock 默认主题改为 dark，与真实默认一致。

## 五、未验证项

1. **`cargo test`、`cargo clippy`**：见第一节，本次未改 Rust，但不记为通过。
2. **Windows、macOS 实机**：未运行。自绘标题栏、系统窗口按钮避让、最小窗口的真实表现没有实机证据，不写成已验证。
3. **真实应用的默认深色**：只核对到 mock 默认值和既有代码，没有在安装包里观察。
4. **真实 Git 流程**：截图和测量都来自 mock。在途锁定、标签写入、Git 缺失诊断的在途路径由 Vitest 受控 mock 覆盖，预览不能进入这些状态，只有 `?git=missing` 可在预览看到诊断入口。
5. **“文件无历史”“空仓库”空状态**：由组件用例覆盖文案和图标互不相同，预览无法进入，没有截图。
6. **安装包与性能**：本次没有重跑 `measure-delivery`、`verify-delivery`，`report.json` 不代表本候选。
