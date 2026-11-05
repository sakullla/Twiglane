import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmDialog from "../src/lib/components/ConfirmDialog.svelte";

/**
 * 删除、中止、放弃共用的确认框：固定版式、安全的初始焦点、写入在途锁住，
 * 以及几千个受影响对象时只渲染视口附近的行。
 */
describe("确认框", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function base(extra: Record<string, unknown> = {}) {
    return {
      title: "删除本地分支",
      titleId: "confirm-test-title",
      message: "删除本地分支 topic？",
      targets: [{ icon: "branch", name: "topic", detail: "本地分支 · 仅存在于本地" }],
      targetsLabel: "要删除的分支",
      notes: [
        { tone: "ok", text: "已完整包含在 main 中" },
        { tone: "warn", text: "删除后不能由这里恢复" },
      ],
      confirmLabel: "删除分支",
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      ...extra,
    };
  }

  it("版式：一句话、受影响对象、后果，右下角取消在前、具体动作在后；危险操作焦点落在取消上", async () => {
    const props = base();
    render(ConfirmDialog, { props: props as never });
    const dialog = screen.getByRole("dialog", { name: "删除本地分支" });
    expect(dialog.textContent).toContain("删除本地分支 topic？");
    expect(within(dialog).getByRole("list", { name: "要删除的分支" }).textContent).toContain("topic");
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>(".modal-foot .btn")].map((button) => button.textContent?.trim());
    expect(buttons).toEqual(["取消", "删除分支"]);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("取消"));
    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    await fireEvent.click(within(dialog).getByRole("button", { name: "删除分支" }));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("远程操作在途且可取消：取消、Esc、右上角关闭都转为停止操作，停止中不重复请求", async () => {
    const onAbort = vi.fn();
    const props = base({ busy: true, onAbort });
    const view = render(ConfirmDialog, { props: props as never });
    const cancel = screen.getByRole("button", { name: "取消" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("可以随时取消");
    await fireEvent.click(cancel);
    expect(onAbort).toHaveBeenCalledTimes(1);
    await fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onAbort).toHaveBeenCalledTimes(2);
    expect(props.onCancel).not.toHaveBeenCalled();

    await view.rerender({ ...props, aborting: true } as never);
    const stopping = screen.getByRole("button", { name: /正在取消/ }) as HTMLButtonElement;
    expect(stopping.disabled).toBe(true);
    await fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onAbort).toHaveBeenCalledTimes(2);
    expect((screen.getByRole("button", { name: "删除分支" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("写入在途：确认按钮转圈，取消、Esc 和右上角关闭都不生效；不可用时写明原因", async () => {
    const props = base({ busy: true });
    const view = render(ConfirmDialog, { props: props as never });
    const confirm = screen.getByRole("button", { name: "删除分支" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.querySelector(".spinner")).toBeTruthy();
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.keyDown(document.body, { key: "Escape" });
    await fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
    expect(props.onCancel).not.toHaveBeenCalled();

    await view.rerender({ ...props, busy: false, confirmBlocked: "至少选择一个文件" } as never);
    const blocked = screen.getByRole("button", { name: "删除分支" }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toBe("至少选择一个文件");
  });

  it("几千个受影响对象只渲染视口附近的行，滚动后换窗口，总数仍然说得清", async () => {
    const targets = Array.from({ length: 5000 }, (_, index) => ({ icon: "file", name: `src/module-${index}/file.ts` }));
    render(ConfirmDialog, { props: base({ targets, targetsLabel: "受影响的路径" }) as never });
    const list = screen.getByRole("list", { name: "受影响的路径" });
    const rows = () => [...list.querySelectorAll<HTMLElement>("li:not(.confirm-spacer)")];
    expect(rows().length).toBeLessThan(60);
    expect(rows()[0].getAttribute("aria-setsize")).toBe("5000");
    expect(document.querySelector(".confirm-targets-caption")?.textContent).toContain("5000");
    // 占位把滚动高度撑到全量：32px × 5000。
    const spacerHeight = [...list.querySelectorAll<HTMLElement>(".confirm-spacer")].reduce((sum, node) => sum + parseFloat(node.style.height), 0);
    expect(spacerHeight + rows().length * 32).toBe(5000 * 32);

    Object.defineProperty(list, "clientHeight", { configurable: true, value: 220 });
    list.scrollTop = 32 * 3000;
    await fireEvent.scroll(list);
    await waitFor(() => expect(rows().some((row) => row.textContent?.includes("module-3000/"))).toBe(true));
    expect(rows().length).toBeLessThan(60);
    expect(rows().some((row) => row.textContent?.includes("module-0/"))).toBe(false);
  });
});
