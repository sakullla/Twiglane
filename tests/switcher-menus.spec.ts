import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const commitBranches = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/api", () => ({ api: { commitBranches } }));

import CommitBranches from "../src/lib/components/CommitBranches.svelte";
import SelectMenu from "../src/lib/components/SelectMenu.svelte";
import TitleBar from "../src/lib/components/TitleBar.svelte";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("标题栏项目下拉：选项右键是应用菜单", () => {
  it("右键选项挡掉原生菜单并给出条目；执行条目前下拉先收起", async () => {
    const run = vi.fn();
    const optionMenu = vi.fn((option: { value: string }) => (option.value ? [{ id: "rename", label: "重命名…", run }] : null));
    render(SelectMenu, {
      props: {
        label: "业务项目",
        value: "",
        options: [
          { value: "", label: "全部仓库" },
          { value: "p1", label: "青山", detail: "17 个仓库" },
        ],
        onChange: vi.fn(),
        optionMenu,
      },
    });
    await fireEvent.click(screen.getByRole("button", { name: "业务项目" }));
    const option = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.popover [data-value="p1"]');
      if (!found) throw new Error("没有选项");
      return found;
    });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    option.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const menu = await screen.findByRole("menu", { name: "青山 的操作" });
    await fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名…" }));
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelector(".popover")).toBeNull());

    // 「全部仓库」没有条目：只挡原生菜单，不弹空菜单。
    await fireEvent.click(screen.getByRole("button", { name: "业务项目" }));
    const all = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.popover [data-value=""]');
      if (!found) throw new Error("没有选项");
      return found;
    });
    const quiet = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    all.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("标题栏项目下拉：没有搜索框时的键盘与焦点", () => {
  const options = [
    { value: "", label: "全部仓库" },
    { value: "p1", label: "青山" },
    { value: "p2", label: "北辰" },
  ];

  async function open() {
    const onChange = vi.fn();
    render(SelectMenu, { props: { label: "业务项目", value: "", options, onChange } });
    const trigger = screen.getByRole("button", { name: "业务项目" });
    trigger.focus();
    // 触发按钮上的方向键直接展开，并停在当前项上。
    await fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const list = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".popover [role='listbox']");
      if (!found) throw new Error("弹层没有打开");
      return found;
    });
    return { onChange, trigger, list };
  }

  it("方向键换当前项，回车选中并收起，焦点回到触发按钮", async () => {
    const { onChange, trigger, list } = await open();
    // 没有搜索框：焦点落在列表本身，方向键交给弹层而不是页面滚动。
    await waitFor(() => expect(document.activeElement).toBe(list));
    expect(document.querySelector(".popover input")).toBeNull();
    expect(list.getAttribute("aria-activedescendant")).toBe(`${list.id}-0`);

    await fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list.getAttribute("aria-activedescendant")).toBe(`${list.id}-1`);
    await fireEvent.keyDown(list, { key: "ArrowUp" });
    await fireEvent.keyDown(list, { key: "ArrowUp" });
    // 循环：从第一项向上回到最后一项。
    expect(list.getAttribute("aria-activedescendant")).toBe(`${list.id}-2`);

    await fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("p2");
    await waitFor(() => expect(document.querySelector(".popover")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("Tab 与 Esc 都收起弹层并归还焦点，不把焦点留在已卸载的列表上", async () => {
    for (const key of ["Tab", "Escape"]) {
      const { trigger, list } = await open();
      await waitFor(() => expect(document.activeElement).toBe(list));
      await fireEvent.keyDown(list, { key });
      await waitFor(() => expect(document.querySelector(".popover")).toBeNull());
      expect(document.activeElement, `${key} 收起后焦点回到触发按钮`).toBe(trigger);
      cleanup();
      document.body.innerHTML = "";
    }
  });

  it("点外面关闭不抢焦点：焦点留在用户点的位置", async () => {
    const { list } = await open();
    await waitFor(() => expect(document.activeElement).toBe(list));
    const outside = document.createElement("button");
    outside.textContent = "外面";
    document.body.append(outside);
    outside.focus();
    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".popover")).toBeNull());
    expect(document.activeElement).toBe(outside);
  });

  it("选项变多出现搜索框时，焦点回到搜索框而不是列表", async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ value: `p${index}`, label: `项目 ${index}` }));
    render(SelectMenu, { props: { label: "业务项目", value: "", options: many, onChange: vi.fn() } });
    await fireEvent.click(screen.getByRole("button", { name: "业务项目" }));
    const search = await waitFor(() => {
      const found = document.querySelector<HTMLInputElement>(".popover input");
      if (!found) throw new Error("没有搜索框");
      return found;
    });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(screen.getByRole("button", { name: "业务项目" })).toBeTruthy();
  });
});

describe("标题栏分支汇总提醒", () => {
  function props(overrides: Record<string, unknown> = {}) {
    return {
      repo: { name: "demo", path: "/work/demo" },
      branch: "main",
      theme: "dark",
      onBrand: () => {},
      onRepo: () => {},
      onBranch: vi.fn(),
      onFetch: () => {},
      onPull: () => {},
      onPush: () => {},
      onRemote: () => {},
      onTheme: () => {},
      onSettings: () => {},
      ...overrides,
    };
  }

  it("有分支需要拉取 / 推送时分支按钮带小点和说明，同步菜单第一行汇总并能打开分支弹层", async () => {
    const onBranch = vi.fn();
    render(TitleBar, { props: props({ onBranch, branchSync: { pull: 3, push: 1 } }) as never });
    const pill = screen.getByRole("button", { name: /^当前分支 main/ });
    expect(pill.getAttribute("aria-label")).toContain("3 个分支需要拉取 · 1 个分支需要推送");
    expect(pill.querySelector("[data-branch-sync-dot]")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: /^同步/ }));
    const item = screen.getByRole("menuitem", { name: /3 个分支需要拉取/ });
    await fireEvent.click(item);
    expect(onBranch).toHaveBeenCalledWith(pill);
  });

  it("都为 0 时不打扰", () => {
    render(TitleBar, { props: props({ branchSync: { pull: 0, push: 0 } }) as never });
    expect(document.querySelector("[data-branch-sync-dot]")).toBeNull();
  });
});

describe("提交所在分支：长分支名不重叠", () => {
  it("「不在当前分支」芯片里的名字可省略，完整名在提示里；芯片可右键复制", async () => {
    const long = "feature/ups-energy-control-tower-20261104-with-a-very-long-suffix";
    commitBranches.mockResolvedValue({ generation: 1, oid: "abc", total: 1, current: long, branches: [{ name: "origin/develop", remote: true, current: false }] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(CommitBranches, { props: { repo: "/repo", oid: "abc", generation: 1, currentBranch: long, nextId: () => 1, onGeneration: vi.fn() } });
    const warn = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-not-on-current]");
      if (!found) throw new Error("还没有芯片");
      return found;
    }, { timeout: 2000 });
    expect(warn.querySelector(".cb-name")?.textContent).toBe(`不在当前分支 ${long}`);
    expect(warn.title).toContain(long);
    await fireEvent.contextMenu(warn, { clientX: 4, clientY: 4 });
    await fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "复制分支名" }));
    expect(writeText).toHaveBeenCalledWith(long);

    const css = readFileSync(path.join(__dirname, "../src/styles/components.css"), "utf8");
    const chip = css.match(/\.cb-chip \{[^}]*\}/)?.[0] ?? "";
    expect(chip).toContain("min-width: 0");
    expect(chip).toContain("overflow: hidden");
    expect(css).toMatch(/\.commit-branches-list \{[^}]*flex-wrap: wrap/);
  });
});
