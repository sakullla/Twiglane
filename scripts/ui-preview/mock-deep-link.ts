// Browser-only deep link substitute for the capture harness. Native builds use the real plugin.
const params = new URLSearchParams(location.search);
export async function getCurrent(): Promise<string[] | null> {
  const mode = params.get("cliora");
  if (!mode || mode === "external") return null;
  const query = new URLSearchParams({ v: "3", reviewId: "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8", sessionId: "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0", worktreePath: "C:/Users/dev/project/twiglane" });
  if (mode === "nobase") query.set("nobase", "1");
  return ["twiglane://review?" + query.toString()];
}
export async function onOpenUrl(handler: (urls: string[]) => void): Promise<() => void> {
  const listener = (event: Event) => handler((event as CustomEvent<string[]>).detail);
  window.addEventListener("twiglane-preview-deep-link", listener);
  return () => window.removeEventListener("twiglane-preview-deep-link", listener);
}
