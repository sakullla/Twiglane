export function operationCaption(operation: string): string {
  switch (operation) {
    case "merge":
      return "正在进行分支合并";
    case "rebase":
      return "正在变基";
    case "cherry-pick":
      return "正在拣选";
    case "revert":
      return "正在还原提交";
    case "bisect":
      return "检测到 bisect 进行中";
    case "unmerged":
      return "有未合并文件，但不是分支合并";
    default:
      return "没有进行中的合并";
  }
}

/** 进行中的操作以哪个动词描述：还原文案不能借用“合并”。 */
export function operationVerb(operation: string): string {
  switch (operation) {
    case "rebase":
      return "变基";
    case "cherry-pick":
      return "拣选";
    case "revert":
      return "还原";
    default:
      return "合并";
  }
}

export function continueActionLabel(operation: string): string {
  if (operation === "rebase") return "继续变基";
  if (operation === "cherry-pick") return "继续拣选";
  if (operation === "revert") return "继续还原";
  return "完成合并";
}

export function abortActionLabel(operation: string): string {
  if (operation === "rebase") return "中止变基";
  if (operation === "cherry-pick") return "中止拣选";
  if (operation === "revert") return "中止还原";
  return "中止合并";
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

/**
 * 能否结束当前会话：revert 也要继续，但 sequencer 停在后续目标（canContinue 为 false）时
 * 只能中止，不能继续。旧调用方不传 canContinue 时保持原有“只看冲突数”的结论。
 */
export function canCompleteMerge(operation: string, unresolved: number, canContinue = true): boolean {
  return (
    (operation === "merge" || operation === "rebase" || operation === "cherry-pick" || operation === "revert") &&
    unresolved === 0 &&
    canContinue
  );
}

export function showMergeAbort(operation: string, canAbort: boolean): boolean {
  return (
    (operation === "merge" ||
      operation === "rebase" ||
      operation === "cherry-pick" ||
      operation === "revert") &&
    canAbort
  );
}

export function discardBoundary(): string {
  return "确认只影响所选文件。取消不写入，未选择的文件保持原内容。";
}

export function undoActionLabel(): string {
  return "撤销最近提交并保留改动";
}

export function amendActionLabel(): string {
  return "修订最近提交";
}

export function discardActionLabel(): string {
  return "放弃所选文件修改";
}
