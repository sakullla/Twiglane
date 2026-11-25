import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftChangeRequest, titleFromBranch } from "../src/lib/change-request-draft";
import type { ChangeRequestPrepare, OpenedRepository } from "../src/lib/types";

/* ------------------------------------------------------------------ *
 * 创建 MR / PR 的草稿生成、无令牌时在浏览器创建、记住自建 GitLab 实例。
 * 平台与钥匙串都在原生侧；这里只证明界面按 DTO 如实反映，并调用正确的命令。
 * ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
  prepareChangeRequest: vi.fn(),
  createChangeRequest: vi.fn(),
  changeRequestTokenStatus: vi.fn(),
  setChangeRequestToken: vi.fn(),
  deleteChangeRequestToken: vi.fn(),
  changeRequestDraft: vi.fn(),
  openChangeRequestWeb: vi.fn(),
  openDocumentUrl: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({ api: mocks }));

import ChangeRequestModal from "../src/lib/components/ChangeRequestModal.svelte";

const opened = {
  summary: { name: "demo", path: "/work/demo" },
  generation: 4,
  snapshot: { generation: 4, branch: { name: "feature/login" }, files: [] },
} as unknown as OpenedRepository;

const ready: ChangeRequestPrepare = {
  status: "ready",
  choices: [],
  provider: "gitlab",
  providerLabel: "GitLab",
  remote: "origin",
  host: "git.example.test",
  repository: "team/app",
  repositoryWeb: "https://git.example.test/team/app",
  sourceBranch: "feature/login",
  targetBranch: "develop",
  defaultBranch: "develop",
  generation: 4,
  remoteHost: "git.example.test",
};

const commits = [
  { subject: "fix: 修复登录跳转", body: "" },
  { subject: "fixup! feat: 登录页重做", body: "" },
  { subject: "feat: 登录页重做", body: "按设计稿重做登录页" },
];

function show(extra: Record<string, unknown> = {}) {
  const props = { opened, nextId: () => 7, onClose: vi.fn(), onNotice: vi.fn(), ...extra };
  render(ChangeRequestModal, { props });
  return props;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.prepareChangeRequest.mockResolvedValue(ready);
  mocks.changeRequestTokenStatus.mockResolvedValue({ configured: true });
  mocks.changeRequestDraft.mockResolvedValue({ commits, truncated: false });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("草稿生成", () => {
  it("多个提交：标题取最早的有效提交，描述按时间顺序列出，过程提交不计入", () => {
    const draft = draftChangeRequest(commits, "feature/login");
    expect(draft.title).toBe("feat: 登录页重做");
    expect(draft.body).toBe("## 变更内容\n\n- feat: 登录页重做\n- fix: 修复登录跳转");
  });

  it("单个提交沿用它的标题与正文；没有提交时按分支名整理", () => {
    expect(draftChangeRequest([{ subject: "feat: x", body: "正文" }], "a")).toEqual({ title: "feat: x", body: "正文" });
    expect(draftChangeRequest([], "feature/login-page-redesign").title).toBe("Login page redesign");
    expect(titleFromBranch("st")).toBe("");
  });

  it("打开后按来源相对目标的提交自动填入标题与描述，并可随时重新生成", async () => {
    show();
    const title = (await screen.findByLabelText("标题")) as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe("feat: 登录页重做"));
    expect(mocks.changeRequestDraft).toHaveBeenCalledWith("/work/demo", "origin", "feature/login", "develop", 4, expect.any(Number));
    expect((screen.getByLabelText("描述") as HTMLTextAreaElement).value).toContain("- fix: 修复登录跳转");
    expect(screen.getByText(/已根据 3 个提交生成/)).toBeTruthy();

    // 用户改过的内容不被自动覆盖；点「根据提交生成」才显式覆盖。
    await fireEvent.input(title, { target: { value: "我的标题" } });
    await fireEvent.click(screen.getByRole("button", { name: /根据提交生成/ }));
    await waitFor(() => expect(title.value).toBe("feat: 登录页重做"));
  });
});

describe("没有令牌时在浏览器创建", () => {
  it("缺少令牌时直接创建不可用，在浏览器中创建可用并带上草稿", async () => {
    mocks.changeRequestTokenStatus.mockResolvedValue({ configured: false });
    mocks.openChangeRequestWeb.mockResolvedValue({
      status: "fallbackOpened",
      url: "https://git.example.test/team/app/-/merge_requests/new?x",
      provider: "gitlab",
      providerLabel: "GitLab",
      repository: "team/app",
      sourceBranch: "feature/login",
      targetBranch: "develop",
      webPrefilled: true,
    });
    show();
    const dialog = await screen.findByRole("dialog", { name: "创建 MR / PR" });
    await waitFor(() => expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe("feat: 登录页重做"));
    await waitFor(() => expect(within(dialog).getByText(/未配置/)).toBeTruthy());

    const create = within(dialog).getByRole("button", { name: "创建 MR / PR" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(create.title).toContain("在浏览器中创建");

    await fireEvent.click(within(dialog).getByRole("button", { name: "在浏览器中创建" }));
    await waitFor(() => expect(mocks.openChangeRequestWeb).toHaveBeenCalledTimes(1));
    expect(mocks.openChangeRequestWeb).toHaveBeenCalledWith(
      "/work/demo",
      "origin",
      "develop",
      "feat: 登录页重做",
      expect.stringContaining("## 变更内容"),
      4,
      expect.any(Number),
      ready,
    );
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
    const result = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-change-request-result="fallback"]');
      if (!found) throw new Error("没有网页结果");
      return found;
    });
    expect(result.textContent).toContain("不认为已经创建");
    expect(result.textContent).toContain("已预填");
  });
});

describe("记住自建 GitLab 实例", () => {
  it("手填地址确认成功后提示已记住；记住的实例显示「已记住」并可更改", async () => {
    const url = "http://git.example.test";
    mocks.prepareChangeRequest
      .mockRejectedValueOnce({ code: "change_request_network", message: "桌面端无法连接远程对应的 Web 实例。" })
      .mockResolvedValueOnce({ ...ready, gitlabInstance: { url, remoteFingerprint: "f".repeat(64) } });
    const props = show();
    const address = await screen.findByLabelText("自建 GitLab 实例地址");
    await fireEvent.input(address, { target: { value: url } });
    await fireEvent.click(screen.getByRole("button", { name: "使用此 GitLab 实例" }));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith(expect.stringContaining("已记住 git.example.test")));
    const scope = await screen.findByRole("list", { name: "创建范围" });
    expect(scope.textContent).toContain(url);
    expect(scope.textContent).toContain("已记住");

    await fireEvent.click(within(scope).getByRole("button", { name: "更改" }));
    expect((screen.getByLabelText("自建 GitLab 实例地址") as HTMLInputElement).value).toBe(url);
  });

  it("原生沿用了设置里记住的实例时直接显示，不再要求填写", async () => {
    mocks.prepareChangeRequest.mockResolvedValue({
      ...ready,
      instanceSaved: true,
      gitlabInstance: { url: "http://git.example.test", remoteFingerprint: "f".repeat(64) },
    });
    show();
    const scope = await screen.findByRole("list", { name: "创建范围" });
    expect(scope.textContent).toContain("已记住");
    expect(screen.queryByLabelText("自建 GitLab 实例地址")).toBeNull();
    expect(mocks.prepareChangeRequest).toHaveBeenCalledWith("/work/demo", null, 4, expect.any(Number));
  });
});
