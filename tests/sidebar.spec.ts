import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import RepoSidebar from "../src/lib/components/RepoSidebar.svelte";
import type { RecentRepo } from "../src/lib/types";

const repos: RecentRepo[] = [
  { name: "demo", path: "/work/alpha/demo", openedAtMs: 2 },
  { name: "demo", path: "/work/beta/demo", openedAtMs: 1 },
];

describe("仓库侧栏", () => {
  it("同时展示同名仓库的完整路径", () => {
    render(RepoSidebar, {
      props: {
        repos,
        query: "",
        selectedPath: repos[0].path,
        theme: "light",
        onQuery: () => {},
        onSelect: () => {},
        onForget: () => {},
        onShowPath: () => {},
        onTheme: () => {},
      },
    });
    expect(screen.getAllByText("demo")).toHaveLength(2);
    expect(screen.getByText("/work/alpha/demo")).toBeTruthy();
    expect(screen.getByText("/work/beta/demo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "浅色" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "深色" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("工作区导航展示改动与冲突数量，并切换视图", async () => {
    const onView = vi.fn();
    render(RepoSidebar, {
      props: {
        repos,
        query: "",
        selectedPath: repos[0].path,
        theme: "dark",
        workspaceView: "changes",
        workspaceEnabled: true,
        changeCount: 8,
        conflictCount: 1,
        onView,
        onQuery: () => {},
        onSelect: () => {},
        onForget: () => {},
        onShowPath: () => {},
        onTheme: () => {},
      },
    });
    expect(screen.getByRole("button", { name: /^改动 8/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: /^分支合并 1/ })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: /^提交历史/ }));
    expect(onView).toHaveBeenCalledWith("history");
  });
});
