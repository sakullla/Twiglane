import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RepoSwitcher from "../src/lib/components/RepoSwitcher.svelte";
import SettingsModal from "../src/lib/components/SettingsModal.svelte";
import TitleBar from "../src/lib/components/TitleBar.svelte";
import Welcome from "../src/lib/components/Welcome.svelte";
import { shortcutCommand } from "../src/lib/shortcuts";
import type { RecentRepo, RepoSummary } from "../src/lib/types";
import { hueOf, repoBadgeLetter, repoBadgeLetters, statusMark } from "../src/lib/ui";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setPullIntegration: vi.fn(),
  setBranchGroups: vi.fn(),
  setTheme: vi.fn(),
  setPanelWidths: vi.fn(),
  openRepository: vi.fn(),
  mergeSession: vi.fn(),
  refreshStatus: vi.fn(),
  cancelReads: vi.fn(),
  loadDiff: vi.fn(),
  commitChanges: vi.fn(),
  measureProbe: vi.fn(),
  measureSample: vi.fn(),
  measureFinish: vi.fn(),
  measureWait: vi.fn(),
  listenEvent: vi.fn(),
  pickDirectory: vi.fn(),
  pickFile: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  api: { ...mocks },
  listenEvent: mocks.listenEvent,
  pickDirectory: mocks.pickDirectory,
  pickFile: mocks.pickFile,
}));

import App from "../src/App.svelte";

afterEach(() => {
  cleanup();
});

const webPath = "/work/kite-web";
const apiPath = "/work/kite-api";

function repo(name: string, path: string, openedAtMs = 1): RecentRepo {
  return { name, path, openedAtMs };
}

const pair = [repo("kite-web", webPath, 2), repo("kite-api", apiPath, 1)];

function badges(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".repo-badge")];
}

function badgeText(root: ParentNode = document): string[] {
  return badges(root).map((node) => node.textContent?.trim() ?? "");
}

function emptySnapshot() {
  return {
    generation: 1,
    branch: {
      name: "main",
      detached: false,
      unborn: false,
      headOid: "a".repeat(40),
      upstream: null,
      ahead: 0,
      behind: 0,
      liveRemoteChecked: false,
      remoteCheckedAtMs: null,
      remoteCheckStale: false,
    },
    files: [],
  };
}

describe("仓库徽标文字", () => {
  it("同前缀取第一个不同字符，单独名称取首字符，空名是问号", () => {
    expect(repoBadgeLetters(["kite-web"])).toEqual(["K"]);
    expect(repoBadgeLetters(["kite-web", "kite-api"])).toEqual(["W", "A"]);
    expect(repoBadgeLetters(["Kite-web", "kite-api"])).toEqual(["W", "A"]);
    expect(repoBadgeLetters(["kite-web", "kite-api", ""])).toEqual(["W", "A", "?"]);
    expect(repoBadgeLetters([""])).toEqual(["?"]);
    expect(repoBadgeLetters(["   "])).toEqual(["?"]);
    expect(repoBadgeLetters(["demo", "demo"])).toEqual(["D", "D"]);
    expect(repoBadgeLetters(["app", "apple"])).toEqual(["A", "L"]);
    expect(repoBadgeLetter("kite-api", ["kite-web", "kite-api"])).toBe("A");
  });

  it("颜色只由路径决定，同一路径反复计算不变", () => {
    expect(hueOf(webPath)).toBe(hueOf(webPath));
    expect(hueOf(webPath)).not.toBe(hueOf(apiPath));
  });

  it("文件行状态字母仍是状态，不是仓库徽标", () => {
    expect(statusMark("未跟踪")).toEqual({ letter: "U", tone: "st-new" });
    expect(statusMark("新增").letter).toBe("A");
    expect(statusMark("修改").letter).toBe("M");
    expect(statusMark("删除").letter).toBe("D");
    expect(statusMark("冲突").letter).toBe("!");
  });

  it("欢迎页同时显示 kite-web 与 kite-api 时徽标分别是 W 和 A，颜色跟路径走", () => {
    const { container } = render(Welcome, {
      props: { recent: pair, disabled: false, onAdd: () => {}, onClone: () => {}, onCreate: () => {}, onOpen: () => {} },
    });
    expect(badgeText(container)).toEqual(["W", "A"]);
    const nodes = badges(container);
    expect(nodes[0].getAttribute("style")).toContain(String(hueOf(webPath)));
    expect(nodes[1].getAttribute("style")).toContain(String(hueOf(apiPath)));
  });

  it("欢迎页只有一个名称时取首字符，空名称是问号", () => {
    const { container } = render(Welcome, {
      props: {
        recent: [repo("kite-web", webPath), repo("", "/work/empty")],
        disabled: false,
        onAdd: () => {},
        onClone: () => {},
        onCreate: () => {},
        onOpen: () => {},
      },
    });
    expect(badgeText(container)).toEqual(["K", "?"]);
  });

  it("仓库切换用当前可见名称区分，滤成一个时回到首字符", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const { container } = render(RepoSwitcher, {
      props: {
        anchor,
        repos: pair,
        currentPath: webPath,
        blockedReason: null,
        actionReason: null,
        onSelect: () => {},
        onForget: () => {},
        onCopyPath: () => {},
        onContextMenu: () => {},
        onCommand: () => {},
        onClose: () => {},
      } as never,
    });
    expect(badgeText(container)).toEqual(["W", "A"]);
    expect(badges(container)[0].getAttribute("style")).toContain(String(hueOf(webPath)));
    await fireEvent.input(screen.getByRole("combobox", { name: "搜索仓库名称或路径" }), { target: { value: "kite-web" } });
    expect(badgeText(container)).toEqual(["K"]);
  });

  it("标题栏使用同时可见的仓库名，只有当前仓库时取首字符", () => {
    const summary: RepoSummary = { name: "kite-web", path: webPath };
    const props = {
      repo: summary,
      branch: "main",
      theme: "dark" as const,
      onBrand: () => {},
      onRepo: () => {},
      onBranch: () => {},
      onFetch: () => {},
      onPull: () => {},
      onPush: () => {},
      onRemote: () => {},
      onTheme: () => {},
      onSettings: () => {},
    };
    const alone = render(TitleBar, { props });
    expect(badgeText(alone.container)).toEqual(["K"]);
    expect(badges(alone.container)[0].getAttribute("style")).toContain(String(hueOf(webPath)));
    alone.unmount();

    const together = render(TitleBar, { props: { ...props, repoNames: ["kite-web", "kite-api"] } });
    expect(badgeText(together.container)).toEqual(["W"]);
    expect(badges(together.container)[0].getAttribute("style")).toContain(String(hueOf(webPath)));
  });
});

describe("设置里的拉取方式与分支分组", () => {
  function open(overrides: Record<string, unknown> = {}) {
    return render(SettingsModal, {
      props: {
        theme: "dark",
        git: null,
        disabled: false,
        onClose: () => {},
        onTheme: () => {},
        onRedetect: () => {},
        onChooseGit: () => {},
        onClearGit: () => {},
        ...overrides,
      },
    });
  }

  it("缺省是合并且分组开启，两项都可以改", async () => {
    const onPullIntegration = vi.fn();
    const onBranchGroups = vi.fn();
    open({ onPullIntegration, onBranchGroups });
    await screen.findByRole("dialog");
    const pull = screen.getByRole("group", { name: "分叉时的拉取" });
    expect(within(screen.getByRole("group", { name: "外观" })).getAllByRole("button")[0]).toBe(document.activeElement);
    expect(within(pull).getByRole("button", { name: "合并" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(pull).getByRole("button", { name: "变基" }).getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByRole("checkbox", { name: /按斜杠分组分支/ }) as HTMLInputElement).checked).toBe(true);
    await fireEvent.click(within(pull).getByRole("button", { name: "变基" }));
    expect(onPullIntegration).toHaveBeenCalledWith("rebase");
    await fireEvent.click(screen.getByRole("checkbox", { name: /按斜杠分组分支/ }));
    expect(onBranchGroups).toHaveBeenCalledWith(false);
  });

  it("已保存的变基和关闭分组会显示出来", async () => {
    open({ pullIntegration: "rebase", branchGroups: false });
    await screen.findByRole("dialog");
    const pull = screen.getByRole("group", { name: "分叉时的拉取" });
    expect(within(pull).getByRole("button", { name: "变基" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("checkbox", { name: /按斜杠分组分支/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe("窗口快捷键层", () => {
  it("不把全选、复制、剪切、粘贴和撤销当成已登记命令", () => {
    for (const key of ["a", "c", "x", "v", "z"]) {
      expect(shortcutCommand({ key, ctrlKey: true })).toBeNull();
      expect(shortcutCommand({ key, metaKey: true })).toBeNull();
    }
    expect(shortcutCommand({ key: "k", ctrlKey: true })).toBe("palette.open");
    expect(shortcutCommand({ key: "Enter", metaKey: true })).toBe("commit.local");
  });
});

describe("外壳接线", () => {
  const snapshot = emptySnapshot();
  const savedSettings = {
    theme: "dark",
    panelWidths: { sidebar: 256, files: 360 },
    git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 可用" },
    recent: pair,
    settingsWarning: null,
    pullIntegration: "rebase" as const,
    branchGroups: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listenEvent.mockResolvedValue(() => {});
    mocks.measureProbe.mockResolvedValue({ enabled: false, elapsedMs: 0, script: null });
    mocks.getSettings.mockResolvedValue(savedSettings);
    mocks.setPullIntegration.mockResolvedValue(undefined);
    mocks.setBranchGroups.mockResolvedValue(undefined);
    mocks.setTheme.mockResolvedValue(undefined);
    mocks.setPanelWidths.mockImplementation(async (widths: unknown) => widths);
    mocks.cancelReads.mockResolvedValue(undefined);
    mocks.openRepository.mockResolvedValue({
      summary: { name: "kite-web", path: webPath },
      generation: 1,
      snapshot,
      draft: "",
      watchDegraded: false,
    });
    mocks.mergeSession.mockResolvedValue({
      generation: 1,
      operation: "none",
      canContinue: false,
      canAbort: false,
      source: null,
      target: null,
      headOid: null,
      conflicts: [],
      unresolved: 0,
      note: "",
      snapshot,
    });
    mocks.refreshStatus.mockResolvedValue(snapshot);
    mocks.loadDiff.mockResolvedValue(null);
    mocks.commitChanges.mockResolvedValue(null);
  });

  function key(target: EventTarget, name: string, mods: { ctrl?: boolean; meta?: boolean } = {}) {
    const event = new KeyboardEvent("keydown", {
      key: name,
      ctrlKey: mods.ctrl ?? false,
      metaKey: mods.meta ?? false,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event;
  }

  it("文本框编辑键不打开搜索也不提交，已登记的 Ctrl+K 仍打开命令面板", async () => {
    render(App);
    await screen.findByText("kite-web");
    const area = document.createElement("textarea");
    document.body.append(area);
    area.focus();
    for (const name of ["a", "c", "x", "v", "z"]) {
      const event = key(area, name, { ctrl: true });
      expect(event.defaultPrevented, name).toBe(false);
    }
    expect(screen.queryByRole("dialog", { name: "命令面板" })).toBeNull();
    expect(mocks.commitChanges).not.toHaveBeenCalled();

    const openSearch = key(window, "k", { meta: true, ctrl: true });
    expect(openSearch.defaultPrevented).toBe(true);
    expect(await screen.findByRole("dialog", { name: "命令面板" })).toBeTruthy();
  });

  it("三处徽标能区分同前缀仓库，设置修改会按 camelCase 写回", async () => {
    render(App);
    await screen.findByText("kite-api");
    const welcome = document.querySelector(".welcome");
    expect(welcome).toBeTruthy();
    expect(badgeText(welcome!)).toEqual(["W", "A"]);
    expect(badges(welcome!)[0].getAttribute("style")).toContain(String(hueOf(webPath)));
    expect(badges(welcome!)[1].getAttribute("style")).toContain(String(hueOf(apiPath)));

    await fireEvent.click(screen.getByText(webPath));
    await waitFor(() => expect(document.querySelector(".titlebar .repo-badge")?.textContent?.trim()).toBe("W"));
    expect(document.querySelector(".titlebar .repo-badge")?.getAttribute("style")).toContain(String(hueOf(webPath)));
    await fireEvent.click(screen.getByRole("button", { name: "当前仓库 kite-web" }));
    await waitFor(() => expect(badgeText(document.querySelector(".popover") ?? document)).toEqual(["W", "A"]));

    await fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const pull = await screen.findByRole("group", { name: "分叉时的拉取" });
    await waitFor(() => expect(within(pull).getByRole("button", { name: "变基" }).getAttribute("aria-pressed")).toBe("true"));
    expect((screen.getByRole("checkbox", { name: /按斜杠分组分支/ }) as HTMLInputElement).checked).toBe(false);
    await fireEvent.click(within(pull).getByRole("button", { name: "合并" }));
    await fireEvent.click(screen.getByRole("checkbox", { name: /按斜杠分组分支/ }));
    await waitFor(() => expect(mocks.setPullIntegration).toHaveBeenCalledWith("merge"));
    expect(mocks.setBranchGroups).toHaveBeenCalledWith(true);
    const apiSource = readFileSync("src/lib/api.ts", "utf8");
    expect(apiSource).toContain('invoke<void>("set_pull_integration", { pullIntegration })');
    expect(apiSource).toContain('invoke<void>("set_branch_groups", { branchGroups })');
  });

  it("旧设置响应没有这两项时仍按合并和开启分组显示", async () => {
    mocks.getSettings.mockResolvedValue({
      theme: "dark",
      panelWidths: { sidebar: 256, files: 360 },
      git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 可用" },
      recent: [],
      settingsWarning: null,
    });
    render(App);
    await waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
    await fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const pull = await screen.findByRole("group", { name: "分叉时的拉取" });
    await waitFor(() => expect(within(pull).getByRole("button", { name: "合并" }).getAttribute("aria-pressed")).toBe("true"));
    expect((screen.getByRole("checkbox", { name: /按斜杠分组分支/ }) as HTMLInputElement).checked).toBe(true);
  });
});
