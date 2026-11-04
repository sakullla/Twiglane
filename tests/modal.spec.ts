import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Modal, { openModalCount } from "../src/lib/components/Modal.svelte";
import PublishModal from "../src/lib/components/PublishModal.svelte";
import SettingsModal from "../src/lib/components/SettingsModal.svelte";

const body = (html: string) => createRawSnippet(() => ({ render: () => `<div>${html}</div>` }));

function open(title: string, extra: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const view = render(Modal, {
    props: { title, titleId: `${title}-title`, onClose, children: body(`<button id="${title}-a">甲</button><button id="${title}-b">乙</button>`), ...extra },
  });
  return { onClose, view };
}

const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key, ...init });

describe("Modal 键盘处理不依赖焦点位置", () => {
  afterEach(() => {
    cleanup();
    expect(openModalCount()).toBe(0);
  });

  const blurToBody = () => (document.activeElement as HTMLElement | null)?.blur();

  it("焦点落到 body 时 Esc 仍能关闭", async () => {
    const { onClose } = open("甲窗");
    blurToBody();
    expect(document.activeElement).toBe(document.body);
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("焦点落到 body 时 Tab 拉回弹窗，Shift+Tab 落在末项", async () => {
    open("甲窗");
    const dialog = screen.getByRole("dialog");
    blurToBody();
    await press("Tab");
    expect(dialog.contains(document.activeElement)).toBe(true);
    blurToBody();
    await press("Tab", { shiftKey: true });
    expect(document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.id).toBe("甲窗-b");
  });

  it("Tab 在首尾循环", async () => {
    open("甲窗");
    document.getElementById("甲窗-b")!.focus();
    await press("Tab");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("关闭对话框");
    await press("Tab", { shiftKey: true });
    expect(document.activeElement?.id).toBe("甲窗-b");
  });

  it("叠层时只有最上层响应", async () => {
    const lower = open("下层");
    const upper = open("上层");
    await press("Escape");
    expect(upper.onClose).toHaveBeenCalledTimes(1);
    expect(lower.onClose).not.toHaveBeenCalled();
  });

  it("上层在同一次按键里卸载，下层也不接着关", async () => {
    const lower = open("下层");
    const onClose = vi.fn();
    const upper = render(Modal, {
      props: { title: "上层", titleId: "上层-title", children: body("<button>甲</button>"), onClose: () => { onClose(); upper.unmount(); } },
    });
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lower.onClose).not.toHaveBeenCalled();
  });

  it("内层处理过的 Esc 不再关闭弹窗", async () => {
    const { onClose } = open("甲窗");
    const inner = document.getElementById("甲窗-a")!;
    inner.addEventListener("keydown", (event) => event.preventDefault());
    await fireEvent.keyDown(inner, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.keyDown(inner, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("写入在途锁定：Esc、背板和右上角都不关闭，结束后恢复", async () => {
    const { onClose, view } = open("甲窗", { locked: true });
    await press("Escape");
    await fireEvent.mouseDown(document.querySelector("[data-modal-backdrop]")!);
    const close = screen.getByRole("button", { name: "关闭对话框" });
    expect(close.hasAttribute("disabled")).toBe(true);
    expect(close.getAttribute("title")).toContain("写入完成");
    expect(onClose).not.toHaveBeenCalled();
    await view.rerender({ locked: false });
    await tick();
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("关闭后不再监听", async () => {
    const { onClose, view } = open("甲窗");
    view.unmount();
    await press("Escape");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("headExtra 排在标题之后、关闭按钮之前", () => {
    open("甲窗", { headExtra: createRawSnippet(() => ({ render: () => `<div id="extra"></div>` })) });
    const head = document.querySelector(".modal-head")!;
    expect(head.querySelector(".modal-titles + #extra + button")).toBeTruthy();
  });
});

/**
 * 关闭后的焦点去处（T5 返工）。
 *
 * 从命令面板执行任务命令时，面板与弹窗在同一批更新里换位：Modal 打开瞬间的 activeElement
 * 是随即卸载的搜索框。这时如果只把它记成「回来的地方」，关闭后焦点就落到 body。
 * 这里直接验 Modal 的判断：传入的 returnFocus 优先，且不接管调用方自己的收尾顺序。
 */
describe("关闭后的焦点去处", () => {
  afterEach(() => {
    cleanup();
    expect(openModalCount()).toBe(0);
  });

  /** 面板打开前的控件：和弹窗不在一棵树里，弹窗卸载不会带走它。 */
  function attachOrigin() {
    const origin = document.createElement("button");
    origin.id = "palette-origin";
    document.body.appendChild(origin);
    return origin;
  }

  /** 面板里的搜索框：与弹窗同一批更新卸载，Modal 打开那一刻它还是 activeElement。 */
  function attachSearch() {
    const search = document.createElement("input");
    document.body.appendChild(search);
    search.focus();
    return search;
  }

  it("打开瞬间的焦点已卸载：Esc 后回到 returnFocus，不落 body", async () => {
    const origin = attachOrigin();
    origin.focus();
    const search = attachSearch();
    const { onClose } = open("甲窗", { returnFocus: origin });
    search.remove();
    expect(search.isConnected, "搜索框已随面板卸载").toBe(false);

    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement, "关闭后回到打开面板前的控件").toBe(origin);
    expect(document.activeElement, "不是 body").not.toBe(document.body);
    origin.remove();
  });

  it("宿主自己收槽位（直接卸载）时同样回到 returnFocus", async () => {
    const origin = attachOrigin();
    origin.focus();
    const search = attachSearch();
    const { view } = open("甲窗", { returnFocus: origin });
    search.remove();
    view.unmount();
    expect(document.activeElement).toBe(origin);
    origin.remove();
  });

  it("不传 returnFocus 时按原语义：不把焦点交给已卸载的节点", async () => {
    const search = attachSearch();
    const { view } = open("甲窗");
    search.remove();
    view.unmount();
    expect(document.activeElement, "已卸载的搜索框拿不到焦点").not.toBe(search);
    expect(search.isConnected).toBe(false);
  });

  it("传入的 returnFocus 在关闭前被卸载：不把焦点交给已卸载节点", async () => {
    const origin = attachOrigin();
    origin.focus();
    const { view } = open("甲窗", { returnFocus: origin });
    origin.remove();
    view.unmount();
    expect(document.activeElement, "已卸载的 returnFocus 拿不到焦点").not.toBe(origin);
    expect(document.activeElement).toBe(document.body);
  });
});

/**
 * 任务弹窗共用同一个 Modal 外壳：头部（图标 + 标题 + 关闭）与底部（次要动作 → 取消 → 主操作）
 * 的层级对所有弹窗一致。这里用两个真实任务弹窗把 T5 的两处统一钉住：
 * 设置弹窗原来没有头部图标，标题比其他弹窗左移 46px；发布弹窗原来把「取消」放在最左。
 */
describe("任务弹窗共用外壳", () => {
  afterEach(() => {
    cleanup();
    expect(openModalCount()).toBe(0);
  });

  it("设置弹窗有头部图标，标题与其他任务弹窗同一列", async () => {
    render(SettingsModal, {
      props: {
        theme: "dark" as const,
        git: { available: true, path: "git", version: "2.49.0", overridden: false, belowBaseline: false, message: "Git 2.49.0 可用" },
        disabled: false,
        onClose: vi.fn(),
        onTheme: vi.fn(),
        onRedetect: vi.fn(),
        onChooseGit: vi.fn(),
        onClearGit: vi.fn(),
      },
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("data-task-modal")).toBe("settings");
    expect(dialog.getAttribute("aria-labelledby")).toBe("settings-modal-title");
    const head = dialog.querySelector(".modal-head")!;
    expect(head.children[0].classList.contains("modal-icon"), "图标位在标题之前").toBe(true);
    expect(head.querySelector(".modal-icon + .modal-titles h2")?.textContent).toBe("设置");
  });

  it("发布弹窗底部：次要动作 → 取消 → 主操作，取消不再单独占最左", async () => {
    render(PublishModal, {
      props: {
        branch: "feature/ui",
        upstream: null,
        remote: "origin",
        ahead: 3,
        disabled: false,
        onClose: vi.fn(),
        onPublish: vi.fn(),
        onAssociate: vi.fn(),
      },
    });
    const dialog = await screen.findByRole("dialog");
    const foot = dialog.querySelector(".modal-foot")!;
    const order = [...foot.children].map((element) => (element.classList.contains("spacer") ? "spacer" : (element.textContent ?? "").trim()));
    expect(order).toEqual(["spacer", "只关联上游", "取消", "发布分支"]);
    expect(foot.lastElementChild?.classList.contains("btn-primary"), "主操作在最右").toBe(true);
    expect(foot.firstElementChild?.classList.contains("spacer"), "左侧留给说明，动作靠右对齐").toBe(true);
  });
});
