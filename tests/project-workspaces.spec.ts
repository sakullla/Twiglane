import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutContexts } from "../src/lib/checkout-context";
import { addCandidates, checkoutKey, projectMemberForCheckout, projectRepos, type Project, type Projects, type WorkspaceManifest } from "../src/lib/workspaces";
import { buildWorktreeGroups } from "../src/lib/recent";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  preview: vi.fn(),
  attach: vi.fn(),
  favorite: vi.fn(),
  discover: vi.fn(),
  remove: vi.fn(),
  openInCliora: vi.fn(),
  repoHeads: vi.fn(),
}));
vi.mock("../src/lib/api", () => ({
  api: {
    workspaceCreate: mocks.create,
    workspaceUpdate: mocks.update,
    workspacePreview: mocks.preview,
    workspaceAttach: mocks.attach,
    workspaceFavorite: mocks.favorite,
    workspaceDiscover: mocks.discover,
    workspaceDelete: mocks.remove,
    workspaceOpenInCliora: mocks.openInCliora,
    repoHeads: mocks.repoHeads,
  },
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
  it("两千个发现结果只挂载当前页，搜索覆盖末页，批量纳入保留跨页选择", async () => {
    const { data } = mount(project(0));
    const found = Array.from({ length: 2000 }, (_, index) => ({
      name: `service-${index}`, path: `/scale/${index}`, commonDirectory: `/git/${index}`, repositoryId: null, error: null,
    }));
    mocks.discover.mockResolvedValue({ candidates: found, partial: false, cancelled: false });
    mocks.update.mockResolvedValue(data);
    await fireEvent.click(screen.getByRole("button", { name: "从目录发现" }));
    const region = within(await screen.findByRole("region", { name: "候选仓库" }));
    expect(region.getAllByRole("checkbox")).toHaveLength(100);
    await fireEvent.click(region.getByRole("button", { name: "下一页" }));
    await fireEvent.click(region.getByRole("checkbox", { name: "service-100 /scale/100" }));
    const search = region.getByRole("textbox", { name: "搜索候选仓库" });
    await fireEvent.input(search, { target: { value: "/scale/1999" } });
    expect(region.getAllByRole("checkbox")).toHaveLength(1);
    await fireEvent.click(region.getByRole("button", { name: "确认纳入 1999 个位置" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    const repos = mocks.update.mock.calls[0][0].repositories as WorkspaceManifest["repositories"];
    expect(repos).toHaveLength(1999);
    expect(repos.some((repo) => repo.name === "service-100")).toBe(false);
    expect(repos.at(-1)?.name).toBe("service-1999");
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

describe("项目管理生命周期、筛选、打开与深链预览一次性消费", () => {
  it("成员按收藏置前，识别缺失目录并提供筛选胶囊、多词搜索、直接打开与在 Cliora 打开", async () => {
    const p: Project = {
      manifest: {
        schemaVersion: 1,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        name: "共享平台",
        revision: 2,
        repositories: [
          { id: "repo-curr", name: "alpha-current", locations: [{ hostId: host, path: "/work/alpha" }] },
          { id: "repo-gone", name: "beta-missing", locations: [{ hostId: host, path: "/work/gone" }] },
          { id: "repo-fav", name: "gamma-fav", locations: [{ hostId: host, path: "/work/platform/gamma" }] },
        ],
      },
      sourcePath: "/work/shared.dev-workspace.json",
      digest: "d1",
      error: null,
      favorites: ["repo-fav"],
      bindings: {},
    };
    mocks.repoHeads.mockResolvedValue([
      { path: "/work/alpha", mainPath: null, branch: "main", detached: null, missing: false, worktree: false },
      { path: "/work/gone", mainPath: null, branch: null, detached: null, missing: true, worktree: false },
      { path: "/work/platform/gamma", mainPath: null, branch: "main", detached: null, missing: false, worktree: false },
    ]);
    mocks.openInCliora.mockResolvedValue(undefined);
    const onOpenRepo = vi.fn();
    render(ProjectManager, {
      data: { hostId: host, projects: [p] },
      selectedId: p.manifest.workspaceId,
      currentPath: "/work/alpha",
      nextId: () => 1,
      onData: vi.fn(),
      onSelect: vi.fn(),
      onOpenRepo,
      onClose: vi.fn(),
    });

    await waitFor(() => expect(screen.getByText(/目录不存在，请重新关联/)).toBeTruthy());
    // 收藏置前：gamma-fav 排在第一位，其余保持清单顺序。
    const items = [...document.querySelectorAll(".project-member")];
    expect(items.map((el) => el.querySelector("strong")?.textContent)).toEqual(["gamma-fav", "alpha-current", "beta-missing"]);
    expect(items[1].querySelector(".pm-current-badge")?.textContent).toBe("当前");
    expect(items[2].classList.contains("broken")).toBe(true);

    // 筛选胶囊：待处理只留缺失目录项，再点恢复全部。
    const filters = screen.getByRole("group", { name: "筛选项目成员" });
    await fireEvent.click(within(filters).getByRole("button", { name: /待处理 1/ }));
    expect([...document.querySelectorAll(".project-member strong")].map((el) => el.textContent)).toEqual(["beta-missing"]);
    await fireEvent.click(within(filters).getByRole("button", { name: /全部 3/ }));

    // 多词跨名称与路径匹配 + 清空按钮。
    const search = screen.getByRole("textbox", { name: "搜索项目仓库" }) as HTMLInputElement;
    await fireEvent.input(search, { target: { value: "platform gamma" } });
    expect([...document.querySelectorAll(".project-member strong")].map((el) => el.textContent)).toEqual(["gamma-fav"]);
    await fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(search.value).toBe("");
    expect(document.querySelectorAll(".project-member")).toHaveLength(3);

    // 在 Cliora 打开共享清单 + 打开某个成员仓库。
    await fireEvent.click(screen.getByRole("button", { name: "在 Cliora 打开" }));
    await waitFor(() => expect(mocks.openInCliora).toHaveBeenCalledWith("/work/shared.dev-workspace.json"));
    await fireEvent.click(screen.getByRole("button", { name: "打开 gamma-fav" }));
    expect(onOpenRepo).toHaveBeenCalledWith("/work/platform/gamma");
  });

  it("移除本地项目与取消关联共享清单均需明确确认，且切换选中项目", async () => {
    const shared: Project = { ...project(1), sourcePath: "/work/shared.dev-workspace.json", digest: "d1" };
    const local: Project = {
      ...project(1),
      manifest: { ...project(1).manifest, workspaceId: "99999999-9999-4999-8999-999999999999", name: "本机项目" },
    };
    const nextData: Projects = { hostId: host, projects: [local] };
    mocks.remove.mockResolvedValue(nextData);
    mocks.repoHeads.mockResolvedValue([]);
    const onData = vi.fn();
    const onSelect = vi.fn();
    render(ProjectManager, {
      data: { hostId: host, projects: [shared, local] },
      selectedId: shared.manifest.workspaceId,
      nextId: () => 1,
      onData,
      onSelect,
      onClose: vi.fn(),
    });

    await fireEvent.click(screen.getByRole("button", { name: "取消关联清单" }));
    const confirmRegion = screen.getByRole("region", { name: "确认取消关联清单" });
    expect(confirmRegion.textContent).toContain(".dev-workspace.json");
    expect(mocks.remove).not.toHaveBeenCalled();
    await fireEvent.click(within(confirmRegion).getByRole("button", { name: "确认取消关联" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(shared.manifest.workspaceId));
    expect(onData).toHaveBeenCalledWith(nextData);
    expect(onSelect).toHaveBeenCalledWith(local.manifest.workspaceId);
  });

  it("initialPreview 交给弹窗后立即消费父层意图，关闭预览后不会残留", async () => {
    const p = project(1);
    mocks.repoHeads.mockResolvedValue([]);
    const onConsumeInitialPreview = vi.fn();
    render(ProjectManager, {
      data: { hostId: host, projects: [] },
      selectedId: null,
      initialPreview: { manifest: p.manifest, path: "/work/incoming.dev-workspace.json", digest: "obs", conflict: false },
      nextId: () => 1,
      onData: vi.fn(),
      onSelect: vi.fn(),
      onConsumeInitialPreview,
      onClose: vi.fn(),
    });
    expect(await screen.findByRole("region", { name: "项目清单预览" })).toBeTruthy();
    expect(onConsumeInitialPreview).toHaveBeenCalledTimes(1);
    expect(mocks.attach).not.toHaveBeenCalled();
  });
});

describe("管理项目页：新建项目", () => {
  it("没有项目时只有一个新建入口；点开后搜索词带入名称并能创建", async () => {
    mocks.repoHeads.mockResolvedValue([]);
    const created = project(1);
    mocks.create.mockResolvedValue({ hostId: host, projects: [created] });
    const onData = vi.fn();
    render(ProjectManager, { data: { hostId: host, projects: [] }, selectedId: null, nextId: () => 1, onData, onSelect: vi.fn(), onClose: vi.fn() });
    expect(screen.queryByRole("textbox", { name: "新项目名称" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /新建项目/ })).toHaveLength(1);
    await fireEvent.input(screen.getByRole("textbox", { name: "搜索项目" }), { target: { value: "34343" } });
    await fireEvent.click(screen.getByRole("button", { name: /新建项目/ }));
    const input = (await screen.findByRole("textbox", { name: "新项目名称" })) as HTMLInputElement;
    expect(input.value).toBe("34343");
    await fireEvent.click(screen.getByRole("button", { name: /创建项目/ }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("34343"));
    expect(onData).toHaveBeenCalled();
  });
});

describe("管理项目页：项目列表、右键与浏览不改范围", () => {
  function two(): Projects {
    const a = project(3);
    const b: Project = { ...project(2), manifest: { ...project(2).manifest, workspaceId: "33333333-3333-4333-8333-333333333333", name: "端到端" } };
    return { hostId: host, projects: [a, b] };
  }

  it("左侧列出全部项目并可搜索；点选只切换查看，不改标题栏范围，「设为当前范围」才改", async () => {
    mocks.repoHeads.mockResolvedValue([]);
    const data = two();
    const onSelect = vi.fn();
    render(ProjectManager, { data, selectedId: data.projects[0].manifest.workspaceId, nextId: () => 1, onData: vi.fn(), onSelect, onClose: vi.fn() });
    expect(screen.getByRole("dialog", { name: "管理项目" })).toBeTruthy();
    const list = screen.getByRole("group", { name: "全部项目" });
    expect(within(list).getAllByRole("button").map((b) => b.querySelector(".pmx-project-name")?.textContent)).toEqual(["业务项目", "端到端"]);
    await fireEvent.input(screen.getByRole("textbox", { name: "搜索项目" }), { target: { value: "端到" } });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    await fireEvent.click(within(list).getByRole("button", { name: /端到端/ }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "端到端" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "设为当前范围" }));
    expect(onSelect).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333");
  });

  it("项目与成员行右键是应用菜单（不出原生菜单）：重命名、编辑成员、删除；成员可复制路径、移除", async () => {
    mocks.repoHeads.mockResolvedValue([]);
    const data = two();
    mocks.update.mockResolvedValue(data);
    render(ProjectManager, { data, selectedId: null, nextId: () => 1, onData: vi.fn(), onSelect: vi.fn(), onClose: vi.fn() });
    const row = within(screen.getByRole("group", { name: "全部项目" })).getByRole("button", { name: /端到端/ });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    let menu = await screen.findByRole("menu", { name: "端到端 的操作" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(
      expect.arrayContaining(["设为当前范围", "重命名…", "编辑成员…", "刷新清单", "删除项目…"]),
    );
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名…" }));
    const field = await screen.findByRole("textbox", { name: "项目显示名称" });
    await fireEvent.input(field, { target: { value: "端到端测试" } });
    await fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0][0].name).toBe("端到端测试");

    const member = document.querySelector<HTMLElement>(".project-member")!;
    await fireEvent.contextMenu(member, { clientX: 20, clientY: 20 });
    menu = await screen.findByRole("menu", { name: /的操作$/ });
    expect(within(menu).getByRole("menuitem", { name: "复制完整路径" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "从项目移除" })).toBeTruthy();
  });

  it("从标题栏菜单带来的意图：直接定位项目并展开删除确认", async () => {
    mocks.repoHeads.mockResolvedValue([]);
    const data = two();
    render(ProjectManager, {
      data,
      selectedId: data.projects[0].manifest.workspaceId,
      focus: { id: "33333333-3333-4333-8333-333333333333", action: "delete" },
      nextId: () => 1,
      onData: vi.fn(),
      onSelect: vi.fn(),
      onClose: vi.fn(),
    });
    expect(await screen.findByRole("region", { name: "确认移除本地项目" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "端到端" })).toBeTruthy();
  });
});
