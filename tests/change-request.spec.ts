import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchRecord, BranchTrack, ChangeRequestOutcome, ChangeRequestPrepare, OpenedRepository } from "../src/lib/types";

/* ------------------------------------------------------------------ *
 * 「创建 MR / PR」的前端行为边界（R1–R6 的界面一侧）：
 * 入口开关、远程选择、显式提交与重复防护、结果状态、失败保留输入、
 * 迟到响应隔离。平台请求、钥匙串与系统浏览器都在原生侧，
 * 这里只证明界面按 DTO 如实反映结果，不构成平台实机证据。
 * ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
  branchList: vi.fn(),
  branchTracking: vi.fn(),
  prepareChangeRequest: vi.fn(),
  createChangeRequest: vi.fn(),
  changeRequestTokenStatus: vi.fn(),
  setChangeRequestToken: vi.fn(),
  deleteChangeRequestToken: vi.fn(),
  openDocumentUrl: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({ api: mocks }));

import ChangeRequestModal from "../src/lib/components/ChangeRequestModal.svelte";
import BranchSwitcher from "../src/lib/components/BranchSwitcher.svelte";

const repoPath = "/work/demo";
const otherPath = "/work/other";

const snapshot = {
  generation: 4,
  branch: {
    name: "feature/login",
    detached: false,
    unborn: false,
    upstream: "origin/feature/login",
    ahead: 1,
    behind: 0,
    liveRemoteChecked: false,
    remoteCheckedAtMs: null,
    remoteCheckStale: false,
  },
  files: [],
} as unknown as OpenedRepository["snapshot"];

function openedFor(path = repoPath, branchName: string | null = "feature/login"): OpenedRepository {
  return {
    summary: { name: "demo", path },
    generation: 4,
    snapshot: { ...snapshot, branch: { ...snapshot.branch, name: branchName } },
  } as OpenedRepository;
}

const ready: ChangeRequestPrepare = {
  status: "ready",
  choices: [],
  provider: "github",
  providerLabel: "GitHub",
  remote: "origin",
  host: "github.com",
  repository: "sakullla/twiglane",
  repositoryWeb: "https://github.com/sakullla/twiglane",
  sourceBranch: "feature/login",
  targetBranch: "main",
  defaultBranch: "main",
  generation: 4,
};

function outcome(overrides: Partial<ChangeRequestOutcome> = {}): ChangeRequestOutcome {
  return {
    status: "created",
    url: "https://github.com/sakullla/twiglane/pull/12",
    provider: "github",
    providerLabel: "GitHub",
    repository: "sakullla/twiglane",
    sourceBranch: "feature/login",
    targetBranch: "main",
    webPrefilled: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.branchList.mockResolvedValue({
    generation: 4,
    branches: [
      { name: "main", remote: false, current: false, upstream: "origin/main", worktree: null },
      { name: "feature/login", remote: false, current: true, upstream: "origin/feature/login", worktree: null },
      { name: "origin/main", remote: true, current: false, upstream: null, worktree: null },
    ] as BranchRecord[],
    defaultBranch: "main",
    mergeBases: [],
  });
  mocks.branchTracking.mockResolvedValue({ generation: 4, branches: [] as BranchTrack[] });
  mocks.prepareChangeRequest.mockResolvedValue(ready);
  mocks.changeRequestTokenStatus.mockResolvedValue({ configured: true });
  mocks.openDocumentUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/* ------------------------------------------------------------------ *
 * R1：入口只在开关开启且当前分支可用时出现，关闭时不调用平台命令
 * ------------------------------------------------------------------ */

function showSwitcher(extra: Record<string, unknown> = {}) {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const props = {
    anchor,
    opened: openedFor(),
    blockedReason: null as string | null,
    nextId: () => 9,
    onBusy: vi.fn(),
    onGeneration: vi.fn(),
    onSnapshot: vi.fn(),
    onFailure: vi.fn(),
    onNotice: vi.fn(),
    onCommand: vi.fn(),
    onCreateBranch: vi.fn(),
    onTracking: vi.fn(),
    onClose: vi.fn(),
    branchGroups: false,
    ...extra,
  };
  render(BranchSwitcher, { props });
  return props;
}

describe("当前分支创建入口（R1）", () => {
  it("设置关闭时没有入口，也不调用任何平台命令", async () => {
    showSwitcher();
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    await waitFor(() => expect(within(popover).getAllByRole("option").length).toBeGreaterThan(0));
    expect(within(popover).queryByText(/创建 MR \/ PR/)).toBeNull();
    expect(document.querySelector("[data-create-change-request]")).toBeNull();
    // 关闭状态下连「读令牌/准备远程」都不该发生。
    expect(mocks.prepareChangeRequest).not.toHaveBeenCalled();
    expect(mocks.changeRequestTokenStatus).not.toHaveBeenCalled();
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });

  it("开启时出现当前分支入口，点击只交出意图，不直接发请求", async () => {
    const onCreateChangeRequest = vi.fn();
    showSwitcher({ changeRequestsEnabled: true, onCreateChangeRequest });
    const entry = await screen.findByRole("button", { name: /为 feature\/login 创建 MR \/ PR/ });
    await fireEvent.click(entry);
    expect(onCreateChangeRequest).toHaveBeenCalledTimes(1);
    expect(mocks.prepareChangeRequest).not.toHaveBeenCalled();
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });

  it("外壳把开关、入口与对话框接在同一个单槽上", () => {
    const app = readFileSync("src/App.svelte", "utf8");
    // 开关值一路传到分支弹层；关闭时不渲染入口，因此不会调用任何平台命令。
    expect(app).toContain("{changeRequestsEnabled}");
    expect(app).toContain("onCreateChangeRequest={openChangeRequest}");
    expect(app).toContain('taskModal === "changeRequest"');
    expect(app).toContain("<ChangeRequestModal");
  });

  it("没有可用的当前分支（游离 HEAD）时不显示入口", async () => {
    showSwitcher({ changeRequestsEnabled: true, onCreateChangeRequest: vi.fn(), opened: openedFor(repoPath, null) });
    const popover = await screen.findByRole("dialog", { name: "切换分支" });
    await waitFor(() => expect(within(popover).getAllByRole("option").length).toBeGreaterThan(0));
    expect(document.querySelector("[data-create-change-request]")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 创建对话框：远程选择、表单、令牌、提交与结果状态
 * ------------------------------------------------------------------ */

function showModal(extra: Record<string, unknown> = {}) {
  const props = {
    opened: openedFor(),
    nextId: () => 21,
    returnFocus: null as HTMLElement | null,
    onClose: vi.fn(),
    onNotice: vi.fn(),
    ...extra,
  };
  const view = render(ChangeRequestModal, { props });
  return { ...view, props };
}

async function readyForm() {
  const dialog = await screen.findByRole("dialog", { name: "创建 MR / PR" });
  await waitFor(() => expect(screen.getByLabelText("目标分支")).toBeTruthy());
  return dialog;
}

async function fillForm(title = "feat: 登录页重做") {
  await fireEvent.input(screen.getByLabelText("标题"), { target: { value: title } });
}

describe("远程选择与表单（R2、R4）", () => {
  it("多个远程时先让用户选，选择后才按该远程重新准备", async () => {
    mocks.prepareChangeRequest
      .mockResolvedValueOnce({
        ...ready,
        status: "remoteChoice",
        provider: "",
        providerLabel: "",
        remote: "",
        host: "",
        repository: "",
        repositoryWeb: "",
        sourceBranch: "",
        targetBranch: "",
        defaultBranch: null,
        choices: [
          { remote: "origin", host: "github.com", repository: "sakullla/twiglane", provider: "GitHub" },
          { remote: "upstream", host: "git.example.com", repository: "dev/twiglane", provider: null },
        ],
      })
      .mockResolvedValueOnce(ready);
    showModal();

    const choice = await screen.findByRole("button", { name: /origin/ });
    // 选择前没有任何写操作或平台请求。
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("标题")).toBeNull();

    await fireEvent.click(choice);
    await waitFor(() =>
      expect(mocks.prepareChangeRequest).toHaveBeenLastCalledWith(repoPath, "origin", 4, expect.any(Number)),
    );
    await readyForm();
    expect((screen.getByLabelText("目标分支") as HTMLInputElement).value).toBe("main");
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });

  it("显式提交把来源留给原生：只传仓库、远程、目标、标题与描述", async () => {
    mocks.createChangeRequest.mockResolvedValue(outcome());
    showModal();
    const dialog = await readyForm();
    await fillForm();
    await fireEvent.input(screen.getByLabelText("描述"), { target: { value: "说明" } });
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();

    await fireEvent.click(within(dialog).getByRole("button", { name: "创建 MR / PR" }));
    await waitFor(() => expect(mocks.createChangeRequest).toHaveBeenCalledTimes(1));
    expect(mocks.createChangeRequest).toHaveBeenCalledWith(
      repoPath,
      "origin",
      "main",
      "feat: 登录页重做",
      "说明",
      4,
      expect.any(Number),
    );
  });

  it("标题为空时创建按钮不可用并说明原因", async () => {
    showModal();
    const dialog = await readyForm();
    const submit = within(dialog).getByRole("button", { name: "创建 MR / PR" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(submit.getAttribute("title")).toBe("先填写标题");
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });
});

describe("按实例令牌（R3）", () => {
  it("未配置时提供配置入口，保存后清空输入并只显示布尔状态", async () => {
    mocks.changeRequestTokenStatus.mockResolvedValue({ configured: false });
    mocks.setChangeRequestToken.mockResolvedValue({ configured: true });
    showModal();
    const dialog = await readyForm();

    await waitFor(() => expect(within(dialog).getByText(/未配置/)).toBeTruthy());
    await fireEvent.click(within(dialog).getByRole("button", { name: "配置令牌…" }));
    const input = screen.getByLabelText("Personal Access Token") as HTMLInputElement;
    expect(input.type).toBe("password");
    await fireEvent.input(input, { target: { value: "ghp_example_token" } });
    await fireEvent.click(within(dialog).getByRole("button", { name: "保存令牌" }));

    await waitFor(() => expect(mocks.setChangeRequestToken).toHaveBeenCalledTimes(1));
    expect(mocks.setChangeRequestToken).toHaveBeenCalledWith(
      repoPath,
      "origin",
      "ghp_example_token",
      4,
      expect.any(Number),
    );
    // 保存后输入框与界面都不再保留明文。
    await waitFor(() => expect(screen.queryByLabelText("Personal Access Token")).toBeNull());
    expect(document.body.textContent ?? "").not.toContain("ghp_example_token");
    expect(within(dialog).getByText(/已保存到系统钥匙串/)).toBeTruthy();
  });

  it("已配置时可以显式删除这个实例的令牌", async () => {
    mocks.deleteChangeRequestToken.mockResolvedValue({ configured: false });
    showModal();
    const dialog = await readyForm();
    await waitFor(() => expect(within(dialog).getByText(/已保存到系统钥匙串/)).toBeTruthy());
    await fireEvent.click(within(dialog).getByRole("button", { name: "删除令牌" }));
    await waitFor(() => expect(mocks.deleteChangeRequestToken).toHaveBeenCalledTimes(1));
    expect(mocks.deleteChangeRequestToken).toHaveBeenCalledWith(repoPath, "origin", 4, expect.any(Number));
    await waitFor(() => expect(within(dialog).getByText(/未配置/)).toBeTruthy());
  });
});

describe("结果状态（R4、R5、R6）", () => {
  it("提交在途时不能重复创建", async () => {
    const pending = deferred<ChangeRequestOutcome>();
    mocks.createChangeRequest.mockReturnValue(pending.promise);
    showModal();
    const dialog = await readyForm();
    await fillForm();

    const submit = within(dialog).getByRole("button", { name: "创建 MR / PR" });
    await fireEvent.click(submit);
    await waitFor(() => expect(mocks.createChangeRequest).toHaveBeenCalledTimes(1));
    await fireEvent.click(submit);
    await fireEvent.click(submit);
    expect(mocks.createChangeRequest).toHaveBeenCalledTimes(1);
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    pending.resolve(outcome());
    await waitFor(() => expect(within(dialog).getByText(/已在 GitHub 创建/)).toBeTruthy());
  });

  it("created 展示平台返回的链接，并说明不代表评审完成", async () => {
    mocks.createChangeRequest.mockResolvedValue(outcome());
    showModal();
    const dialog = await readyForm();
    await fillForm();
    await fireEvent.click(within(dialog).getByRole("button", { name: "创建 MR / PR" }));
    const result = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-change-request-result="created"]');
      if (!found) throw new Error("没有 created 结果");
      return found;
    });
    expect(result.textContent).toContain("已在 GitHub 创建");
    expect(result.textContent).toContain("不表示评审、测试或合并已经完成");
    expect(document.querySelector("[data-change-request-url]")?.textContent).toContain(
      "https://github.com/sakullla/twiglane/pull/12",
    );
  });

  it("fallbackOpened 明确需要在网页继续，不当作创建成功", async () => {
    mocks.createChangeRequest.mockResolvedValue(
      outcome({
        status: "fallbackOpened",
        url: "https://github.com/sakullla/twiglane/compare/main...feature/login?quick_pull=1",
        webPrefilled: false,
      }),
    );
    showModal();
    const dialog = await readyForm();
    await fillForm();
    await fireEvent.click(within(dialog).getByRole("button", { name: "创建 MR / PR" }));
    const result = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-change-request-result="fallback"]');
      if (!found) throw new Error("没有 fallback 结果");
      return found;
    });
    expect(result.textContent).toContain("系统浏览器打开新建页面");
    expect(result.textContent).toContain("不认为已经创建");
    expect(result.textContent).toContain("需要在网页里填写");
    expect(document.body.textContent ?? "").not.toContain("已在 GitHub 创建");
  });

  it("普通失败保留输入并给出平台原因，由用户决定是否再次创建", async () => {
    mocks.createChangeRequest.mockRejectedValue({
      code: "change_request_rate_limited",
      message: "平台限流（429）。请稍后再由你手动重试；应用不会自动重试。",
    });
    showModal();
    const dialog = await readyForm();
    await fillForm("feat: 保留这段标题");
    await fireEvent.click(within(dialog).getByRole("button", { name: "创建 MR / PR" }));

    const failure = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-change-request-result="failed"]');
      if (!found) throw new Error("没有失败提示");
      return found;
    });
    expect(failure.textContent).toContain("平台限流（429）");
    // 只有用户显式点击才会再发一次。
    expect(mocks.createChangeRequest).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe("feat: 保留这段标题");
    const again = within(dialog).getByRole("button", { name: "再次创建" });
    expect((again as HTMLButtonElement).disabled).toBe(false);
  });

  it("结果未知时不报成功，也不提供盲目重试的主按钮", async () => {
    mocks.createChangeRequest.mockRejectedValue({
      code: "change_request_unknown",
      message: "请求已发出但未拿到完整响应，创建结果未知。请先在平台核对，不要直接重复创建。",
    });
    showModal();
    const dialog = await readyForm();
    await fillForm();
    await fireEvent.click(within(dialog).getByRole("button", { name: "创建 MR / PR" }));

    const result = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-change-request-result="unknown"]');
      if (!found) throw new Error("没有未知结果提示");
      return found;
    });
    expect(result.textContent).toContain("结果未知");
    expect(result.textContent).toContain("请先在平台核对");
    expect(screen.queryByRole("button", { name: "再次创建" })).toBeNull();
    expect(document.body.textContent ?? "").not.toContain("已在 GitHub 创建");
    // 表单内容仍在，用户可以自己核对后再决定。
    expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe("feat: 登录页重做");
  });

  it("切仓后迟到的创建响应不污染新上下文", async () => {
    const pending = deferred<ChangeRequestOutcome>();
    mocks.createChangeRequest.mockReturnValue(pending.promise);
    const { rerender } = showModal();
    const dialog = await readyForm();
    await fillForm();
    await fireEvent.click(within(dialog).getByRole("button", { name: "创建 MR / PR" }));
    await waitFor(() => expect(mocks.createChangeRequest).toHaveBeenCalledTimes(1));
    expect(mocks.createChangeRequest).toHaveBeenCalledWith(
      repoPath,
      "origin",
      "main",
      "feat: 登录页重做",
      "",
      4,
      expect.any(Number),
    );

    await rerender({ opened: openedFor(otherPath) });
    await tick();
    pending.resolve(outcome());
    await tick();
    await tick();
    expect(document.querySelector('[data-change-request-result="created"]')).toBeNull();
    expect(document.body.textContent ?? "").not.toContain("已在 GitHub 创建");
  });

  it("关闭（卸载）后迟到的准备响应不会让对话框重新出现", async () => {
    const pending = deferred<ChangeRequestPrepare>();
    mocks.prepareChangeRequest.mockReturnValue(pending.promise);
    const { unmount } = showModal();
    await waitFor(() => expect(mocks.prepareChangeRequest).toHaveBeenCalledTimes(1));
    unmount();
    await tick();
    pending.resolve(ready);
    await tick();
    await tick();
    expect(document.querySelector("[data-task-modal]")).toBeNull();
    expect(screen.queryByLabelText("标题")).toBeNull();
  });
});
