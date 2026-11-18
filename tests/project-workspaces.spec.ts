import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutContexts } from "../src/lib/checkout-context";
import { addCandidates, checkoutKey, projectMemberForCheckout, projectRepos, type Project, type Projects, type WorkspaceManifest } from "../src/lib/workspaces";
import { buildWorktreeGroups } from "../src/lib/recent";
const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), preview: vi.fn(), attach: vi.fn(), favorite: vi.fn(), discover: vi.fn() }));
vi.mock("../src/lib/api", () => ({
  api: { workspaceCreate: mocks.create, workspaceUpdate: mocks.update, workspacePreview: mocks.preview, workspaceAttach: mocks.attach, workspaceFavorite: mocks.favorite, workspaceDiscover: mocks.discover },
  pickFile: vi.fn(async () => "/work/project.dev-workspace.json"), pickDirectories: vi.fn(async () => ["/work/new-repo"]), pickDirectory: vi.fn(async () => "/work"), saveWorkspaceFile: vi.fn(async () => "/work/new.dev-workspace.json"),
}));
import ProjectManager from "../src/lib/components/ProjectManager.svelte";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const host = "11111111-1111-4111-8111-111111111111";
function project(count = 60): Project {
  return { manifest: { schemaVersion: 1, workspaceId: "22222222-2222-4222-8222-222222222222", name: "业务项目", revision: 3,
    repositories: Array.from({ length: count }, (_, i) => ({ id: `repo-${i}`, name: i < 2 ? "demo" : `service-${i}`, locations: [{ hostId: host, path: `/work/team-${i}/demo` }] })),
  }, sourcePath: null, digest: null, error: null, favorites: ["repo-59"], bindings: {} };
}

describe("项目与 checkout 的身份和持久成员", () => {
  it("60 个项目成员不依赖 recent30，收藏置前，状态未读保持 unknown，同名路径可分辨", () => {
    const p = project();
    const repos = projectRepos(p, host, []);
    expect(repos).toHaveLength(60);
    expect(repos[0].path).toBe("/work/team-59/demo");
    const groups = buildWorktreeGroups(repos, new Map(), new Map(), null);
    expect(groups.flatMap((g) => g.rows)).toHaveLength(60);
    expect(groups.every((g) => g.rows.every((r) => r.state === "unknown" && r.dirty === null && r.checkedAtMs === null))).toBe(true);
    expect(repos.filter((r) => r.name === "demo").map((r) => r.path)).toEqual(["/work/team-0/demo", "/work/team-1/demo"]);
  });
  it("选择项目后按当前仓库 → 收藏 → 最近打开 → 名称排序，而不是名单导入顺序", () => {
    const p = project(6);
    p.manifest.repositories.reverse();
    const recent = [
      { name: "service-3", path: "/work/team-3/demo", openedAtMs: 30 },
      { name: "service-4", path: "/work/team-4/demo", openedAtMs: 40 },
    ];
    p.favorites = ["repo-5"];
    const order = projectRepos(p, host, recent, "/work/team-2/demo").map((repo) => repo.path);
    expect(order).toEqual(["/work/team-2/demo", "/work/team-5/demo", "/work/team-4/demo", "/work/team-3/demo", "/work/team-1/demo", "/work/team-0/demo"]);
  });
  it("外机位置不成为本机 Git 目标，独立 recent 仍可打开", () => {
    const p = project(1); p.manifest.repositories[0].locations[0].hostId = "foreign";
    expect(projectRepos(p, host, [])).toEqual([]);
    const recent = [{ name: "alone", path: "/other/alone", openedAtMs: 1 }];
    expect(projectRepos(null, host, recent)).toBe(recent);
  });
  it("批量纳入去重并把附属 worktree 合入同一个稳定仓库；子模块 common 不同独立保留", () => {
    const manifest = { ...project(0).manifest };
    const candidate = (path: string, commonDirectory: string) => ({ path, name: "demo", commonDirectory, repositoryId: null, error: null });
    const added = addCandidates(manifest, [candidate("/a", "/git/a"), candidate("/a", "/git/a"), candidate("/wt/a", "/git/a"), candidate("/a/submodule", "/git/module")], host);
    expect(added.repositories).toHaveLength(2);
    expect(added.repositories[0].locations.map((l) => l.path)).toEqual(["/a", "/wt/a"]);
    expect(manifest.repositories).toEqual([]);
  });
  it("POSIX 大小写不同路径不合并，Windows 别名归同 checkout，A→B→A 恢复各自导航", () => {
    expect(checkoutKey("/work/Repo")).not.toBe(checkoutKey("/work/repo"));
    expect(checkoutKey("C:\\Work\\Demo\\")).toBe(checkoutKey("c:/work/demo"));
    const contexts = new CheckoutContexts<{ view: string; file: string; draft: string }>();
    contexts.save("/a", { view: "history", file: "old.ts", draft: "A draft" });
    contexts.save("/b", { view: "files", file: "new.ts", draft: "B draft" });
    expect(contexts.restore("/a")).toEqual({ view: "history", file: "old.ts", draft: "A draft" });
    expect(contexts.restore("/b")?.draft).toBe("B draft");
  });
});

describe("项目管理实际交互", () => {
  function mount(p = project()) {
    const data: Projects = { hostId: host, projects: [p] };
    const onData = vi.fn();
    render(ProjectManager, { data, selectedId: p.manifest.workspaceId, nextId: () => 1, onData, onSelect: vi.fn(), onClose: vi.fn() });
    return { p, data, onData };
  }
  it("搜索完整路径、收藏与移除关联只提交目标项目成员", async () => {
    const { p, data } = mount();
    mocks.favorite.mockResolvedValue(data); mocks.update.mockResolvedValue(data);
    await fireEvent.input(screen.getByRole("textbox", { name: "搜索项目仓库" }), { target: { value: "team-48" } });
    expect(screen.queryByText("service-47")).toBeNull();
    expect(screen.getByText("service-48")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "收藏 service-48" }));
    await waitFor(() => expect(mocks.favorite).toHaveBeenCalledWith(p.manifest.workspaceId, "repo-48", true));
    await waitFor(() => expect(screen.getByRole("button", { name: "移除项目关联" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "移除项目关联" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    const [manifest, expected] = mocks.update.mock.calls[0] as [WorkspaceManifest, number];
    expect(expected).toBe(3); expect(manifest.repositories).toHaveLength(59);
    expect(manifest.repositories.some((r) => r.id === "repo-48")).toBe(false);
    expect(p.manifest.repositories).toHaveLength(60);
  });
  it("同 ID 不同内容先完整预览并明确勾选接收；取消没有写入", async () => {
    const { p } = mount();
    mocks.preview.mockResolvedValue({ manifest: p.manifest, path: "/work/project.dev-workspace.json", digest: "observed", conflict: true });
    await fireEvent.click(screen.getByRole("button", { name: "打开项目清单" }));
    const preview = await screen.findByRole("region", { name: "项目清单预览" });
    expect(within(preview).getByText("/work/team-59/demo", { exact: false })).toBeTruthy();
    expect(within(preview).getByRole("button", { name: "关联此项目清单" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(within(preview).getByRole("button", { name: "取消预览" }));
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("发现结果先选择再纳入，失败候选不写入；保留现有名单", async () => {
    const { p, data } = mount(project(1)); mocks.update.mockResolvedValue(data);
    mocks.discover.mockResolvedValue({ partial: true, cancelled: false, candidates: [
      { path: "/work/new", name: "new", commonDirectory: "/work/new/.git", repositoryId: null, error: null },
      { path: "/work/unreadable", name: "unreadable", commonDirectory: null, repositoryId: null, error: "无法读取" },
    ] });
    await fireEvent.click(screen.getByRole("button", { name: "从目录发现" }));
    expect(await screen.findByText(/发现未完成全部目录/)).toBeTruthy();
    expect(mocks.update).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "确认纳入 1 个位置" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0][0].repositories).toHaveLength(2);
    expect(mocks.update.mock.calls[0][0].repositories[0]).toEqual(p.manifest.repositories[0]);
  });
});

it("主检出与附属 worktree 复用项目仓库身份，子模块不按父目录误归属", () => {
  const p = project(1);
  const main = p.manifest.repositories[0].locations[0].path;
  const heads = [
    { path: main, mainPath: null, branch: "main", detached: null, missing: false, worktree: false },
    { path: "/other/linked", mainPath: main, branch: "feature", detached: null, missing: false, worktree: true },
    { path: `${main}/module`, mainPath: null, branch: "main", detached: null, missing: false, worktree: false },
  ];
  expect(projectMemberForCheckout(p, host, "/other/linked", heads)?.id).toBe(p.manifest.repositories[0].id);
  expect(projectMemberForCheckout(p, host, `${main}/module`, heads)).toBeNull();
  expect(projectMemberForCheckout(p, "foreign", "/other/linked", heads)).toBeNull();
});


describe("返修：POSIX 字面路径身份", () => {
  const literal = String.raw`/tmp/team\service`;
  const nested = "/tmp/team/service";
  it("helper 保留 POSIX 反斜杠与大小写，仅 Windows 语法做 Windows 规范化", () => {
    expect(checkoutKey(literal)).toBe(literal);
    expect(checkoutKey(literal)).not.toBe(checkoutKey(nested));
    expect(checkoutKey("/tmp/Team")).not.toBe(checkoutKey("/tmp/team"));
    expect(checkoutKey(String.raw`C:\Work\Demo`)).toBe(checkoutKey("c:/work/demo"));
    expect(checkoutKey(String.raw`\\Server\Share\Repo`)).toBe(checkoutKey("//server/share/repo"));
    expect(checkoutKey(String.raw`\\?\C:\Work\Demo`)).toBe(checkoutKey("c:/work/demo"));
    expect(checkoutKey(String.raw`\\?\UNC\Server\Share\Repo`)).toBe(checkoutKey("//server/share/repo"));
    expect(checkoutKey("/")).toBe("/");
  });
  it("checkout 缓存不把字面反斜杠目录的草稿传给嵌套目录", () => {
    const contexts = new CheckoutContexts<{ draft: string }>();
    contexts.save(literal, { draft: "literal-only" });
    expect(contexts.restore(nested)).toBeUndefined();
    contexts.save(nested, { draft: "nested-only" });
    expect(contexts.restore(literal)?.draft).toBe("literal-only");
  });
  it("候选去重与项目归属区分两个合法 POSIX 工作目录", () => {
    const candidate = (path: string) => ({ path, name: "service", commonDirectory: `${path}/.git`, repositoryId: null, error: null });
    const result = addCandidates(project(0).manifest, [candidate(literal), candidate(nested)], host);
    expect(result.repositories).toHaveLength(2);
    const p = { ...project(0), manifest: { ...result, repositories: [result.repositories[0]] } };
    expect(projectMemberForCheckout(p, host, nested, [])).toBeNull();
  });
});

it("返修：60 个发现候选可按名称和完整路径搜索，隐藏的多选仍保留", async () => {
  const p = project(0);
  const data: Projects = { hostId: host, projects: [p] };
  const found = Array.from({ length: 60 }, (_, index) => ({ path: `/work/team-${index}/service-${index}`, name: `service-${index}`, commonDirectory: `/git/${index}`, repositoryId: null, error: null }));
  mocks.discover.mockResolvedValue({ candidates: found, partial: false, cancelled: false });
  mocks.update.mockResolvedValue(data);
  render(ProjectManager, { data, selectedId: p.manifest.workspaceId, nextId: () => 1, onData: vi.fn(), onSelect: vi.fn(), onClose: vi.fn() });
  await fireEvent.click(screen.getByRole("button", { name: "从目录发现" }));
  const candidates = await screen.findByRole("region", { name: "候选仓库" });
  const search = within(candidates).getByRole("textbox", { name: "搜索候选仓库" });
  await fireEvent.input(search, { target: { value: "service-48" } });
  expect(within(candidates).getAllByRole("checkbox")).toHaveLength(1);
  await fireEvent.click(within(candidates).getByRole("checkbox"));
  await fireEvent.input(search, { target: { value: "/work/team-59/" } });
  expect(within(candidates).getAllByRole("checkbox")).toHaveLength(1);
  expect((within(candidates).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  await fireEvent.input(search, { target: { value: "no-match" } });
  expect(within(candidates).queryAllByRole("checkbox")).toHaveLength(0);
  expect(within(candidates).getByText(/没有匹配的候选/)).toBeTruthy();
  await fireEvent.input(search, { target: { value: "" } });
  expect(within(candidates).getAllByRole("checkbox")).toHaveLength(60);
  await fireEvent.click(within(candidates).getByRole("button", { name: "确认纳入 59 个位置" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  expect(mocks.update.mock.calls[0][0].repositories).toHaveLength(59);
  expect(mocks.update.mock.calls[0][0].repositories.some((repo: { locations: { path: string }[] }) => repo.locations[0].path.includes("team-48/"))).toBe(false);
});
