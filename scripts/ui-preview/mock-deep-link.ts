// 预览用的 deep link 插件替身：?cliora=1 时冷启动带一条 cliora v1 审查链接，
// 外壳按真实流程解析（mock 的 clioraReviewRequest）、打开工作树并进入历史里的任务范围。
// ?cliora=nobase 模拟链接没带起点：只打开普通历史并说明原因。
const params = new URLSearchParams(location.search);

export async function getCurrent(): Promise<string[] | null> {
  const mode = params.get("cliora");
  if (!mode) return null;
  return [`twiglane://review?v=1&reviewId=preview-review&sessionId=preview-session${mode === "nobase" ? "&nobase=1" : ""}`];
}

export async function onOpenUrl(_handler: (urls: string[]) => void): Promise<() => void> {
  return () => {};
}
