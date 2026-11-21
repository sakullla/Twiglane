# 项目工作区浏览器 gallery

输入为 synthetic native API：60 个持久项目成员、60 个发现候选、两个同名目录、长名称、收藏、外机位置及来源失效快照。6 个场景覆盖候选名称/路径搜索和跨筛选多选、持久草稿经忘记仓库后重开、完整名单搜索、A→B→A 提交草稿和选中上下文、主检出/附属 worktree 项目归属、失效源快照。不是安装应用、原生 Git 或双端系统 scheme 的验收。

当前复跑使用 `node scripts/run-ui-verification.mjs --projects`，新图集默认写临时目录。这里保留历史运行的 8 张代表图。

`report.json` 记录场景和页面错误，`manifest.json` 记录每图真实 theme、表面色、modal/backdrop opacity、水平溢出、字节数和 SHA-256。截图等待主题设置、有限动画和两帧绘制，不能只依据文件名判断主题。

| 场景 | 代表图 |
| --- | --- |
| 项目总览 | [深色桌面](after/dark-1280x840-project-overview.png)、[浅色桌面](after/light-1280x840-project-overview.png) |
| 项目管理 | [深色桌面](after/dark-1280x840-project-manager.png)、[浅色桌面](after/light-1280x840-project-manager.png)、[深色窄窗口](after/dark-900x600-project-manager.png) |
| 候选搜索预览 | [深色窄窗口](after/dark-900x600-project-candidates.png)、[浅色桌面](after/light-1280x840-project-candidates.png) |
| 来源失效 | [浅色窄窗口](after/light-900x600-project-source-missing.png) |

已人工查看代表图：深色 900 和浅色 1280 候选搜索预览、深色 900 项目管理、浅色 900 来源失效、深浅色 1280 总览及管理。弹窗完全不透明，真实主题与标签一致，长路径可换行，内部成员列表可滚动；页面水平溢出为 0。

T2-A2 历史采集结果：6 / 6 场景通过、采集 16 图，页面错误和水平溢出均为 0。已再次查看 `dark-900x600-project-candidates.png` 和 `light-1280x840-project-candidates.png`，两图的 1 / 60 匹配结果与筛选外 59 项选择、长路径及确认按钮可读；真实主题匹配，modal/backdrop opacity 为 1。受控命令回执：`a1cd17cd9c18a3cc100c88afb499a39d85d9fa50bf7a9c2367a036e8c358272b`。
