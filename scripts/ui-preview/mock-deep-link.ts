// Browser-only deep link substitute for the capture harness. Native builds use the real plugin.
const params = new URLSearchParams(location.search);
const SHARED_MANIFEST = "/work/shared/product.dev-workspace.json";
const SHARED_MEMBER = "33333333-3333-4333-8333-000000000000";
/**
 * 项目清单深链替身。`?workspace=2` 模拟另一端的来源仓库直达，`?workspace=v1` 与
 * `?workspace=outsider` 分别模拟旧版链接和非成员仓库，用来看两端会明确拒绝什么。
 * 这里只是浏览器 mock：系统 scheme 路由仍须由安装包在原生环境验证。
 */
function workspaceLink(mode: string): string | null {
  const encoded = encodeURIComponent(SHARED_MANIFEST);
  if (mode === "v1") return `twiglane://workspace?v=1&file=${encoded}`;
  if (mode === "outsider") return `twiglane://workspace?v=2&file=${encoded}&repository=99999999-9999-4999-8999-999999999999`;
  if (mode === "2") return `twiglane://workspace?v=2&file=${encoded}&repository=${SHARED_MEMBER}`;
  return null;
}
export async function getCurrent(): Promise<string[] | null> {
  const workspace = params.get("workspace");
  if (workspace) {
    const link = workspaceLink(workspace);
    return link ? [link] : null;
  }
  const mode = params.get("cliora");
  if (!mode || mode === "external") return null;
  const query = new URLSearchParams({ v: "3", reviewId: "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8", sessionId: "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0", worktreePath: "C:/Users/dev/project/twiglane" });
  if (mode === "nobase") query.set("nobase", "1");
  // ?cliora=multi：先后两条审查链接（附属 worktree 在前，主检出在后），用来看多来源菜单与切换。
  if (mode === "multi") {
    const earlier = new URLSearchParams({ v: "3", reviewId: "7a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9", sessionId: "1c2d3e4f-5061-4283-94a5-b6c7d8e9f0a1", worktreePath: "C:/Users/dev/project/twiglane/wt/review" });
    return ["twiglane://review?" + earlier.toString(), "twiglane://review?" + query.toString()];
  }
  return ["twiglane://review?" + query.toString()];
}
export async function onOpenUrl(handler: (urls: string[]) => void): Promise<() => void> {
  const listener = (event: Event) => handler((event as CustomEvent<string[]>).detail);
  window.addEventListener("twiglane-preview-deep-link", listener);
  return () => window.removeEventListener("twiglane-preview-deep-link", listener);
}