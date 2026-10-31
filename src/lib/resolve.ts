export function operationCaption(operation: string): string {
  switch (operation) {
    case "merge":
      return "正在进行分支合并";
    case "rebase":
      return "检测到 rebase 进行中";
    case "cherry-pick":
      return "检测到 cherry-pick 进行中";
    case "revert":
      return "检测到 revert 进行中";
    case "bisect":
      return "检测到 bisect 进行中";
    case "unmerged":
      return "有未合并文件，但不是分支合并";
    default:
      return "没有进行中的合并";
  }
}

export function conflictKindLabel(kind: string): string {
  switch (kind) {
    case "text":
      return "文本冲突";
    case "binary":
      return "二进制冲突";
    case "content":
      return "内容冲突";
    case "modify_delete":
      return "修改/删除冲突";
    case "delete_modify":
      return "删除/修改冲突";
    case "both_deleted":
      return "双方删除";
    default:
      return "冲突";
  }
}

export function canCompleteMerge(operation: string, unresolved: number): boolean {
  return operation === "merge" && unresolved === 0;
}

export function showMergeAbort(operation: string, canAbort: boolean): boolean {
  return operation === "merge" && canAbort;
}

export function discardBoundary(): string {
  return "确认只影响所选文件。取消不写入，未选择的文件保持原内容。";
}

export function undoActionLabel(): string {
  return "撤销最近提交并保留改动";
}

export function discardActionLabel(): string {
  return "放弃所选文件修改";
}
