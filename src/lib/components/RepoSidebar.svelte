<script lang="ts">
  import type { RecentRepo, Theme, WorkspaceView } from "../types";
  import WorkspaceRail, { type RailTask } from "./WorkspaceRail.svelte";

  /**
   * 兼容层：旧契约 `RepoSidebar` 原样保留 prop 形状，内部改为渲染 rail。
   * 侧栏的实现已抽取到 WorkspaceRail（导航组、任务组、最近仓库），
   * 这里只做旧视图 id 到「导航 / 任务」的映射，等外壳编排把 rail 直接接上后再删除。
   * 主题切换已按 R10 迁到标题栏与设置 modal，不再由侧栏承载。
   */
  interface Props {
    repos: RecentRepo[];
    query: string;
    selectedPath: string | null;
    theme?: Theme;
    disabled?: boolean;
    workspaceView?: WorkspaceView;
    workspaceEnabled?: boolean;
    changeCount?: number;
    conflictCount?: number;
    mergeInProgress?: boolean;
    collapsed?: boolean;
    onView?: (view: WorkspaceView) => void;
    onQuery: (value: string) => void;
    onSelect: (path: string) => void;
    onForget: (path: string) => void;
    onShowPath: (path: string) => void;
    onTheme?: (theme: Theme) => void;
    onAdd?: () => void;
    onClone?: () => void;
    onCreate?: () => void;
    onToggleCollapsed?: () => void;
  }

  let {
    repos,
    query,
    selectedPath,
    disabled = false,
    workspaceView = "changes",
    workspaceEnabled = false,
    changeCount = 0,
    conflictCount = 0,
    mergeInProgress = false,
    collapsed = false,
    onView,
    onQuery,
    onSelect,
    onForget,
    onShowPath,
    onAdd,
    onClone,
    onCreate,
    onToggleCollapsed,
  }: Props = $props();

  function taskAsView(task: RailTask) {
    // 旧外壳把临时保存与合并当作视图；分支与远程在旧外壳里是 dialog，留给新外壳接线。
    if (task === "stash" || task === "merge") onView?.(task);
  }
</script>

<WorkspaceRail
  {repos}
  {query}
  {selectedPath}
  {workspaceView}
  {workspaceEnabled}
  {changeCount}
  {conflictCount}
  {mergeInProgress}
  {collapsed}
  {disabled}
  onView={(view) => onView?.(view)}
  onTask={taskAsView}
  {onToggleCollapsed}
  {onQuery}
  {onSelect}
  {onForget}
  {onShowPath}
  {onAdd}
  {onClone}
  {onCreate}
/>
