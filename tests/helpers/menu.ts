import { expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/svelte";

/**
 * 右键菜单的二级菜单：点开 menu 里名为 name 的子菜单入口，返回展开出来的子菜单。
 * 子菜单与根菜单是并列的 role="menu" 面板（不嵌在根菜单里），以入口的名称作为 aria-label。
 */
export async function openSubmenu(menu: HTMLElement, name: string | RegExp): Promise<HTMLElement> {
  const trigger = within(menu).getByRole("menuitem", { name });
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  await fireEvent.click(trigger);
  return screen.findByRole("menu", { name });
}

/** 文件树菜单里树级动作的子菜单。 */
export function openTreeSubmenu(menu: HTMLElement): Promise<HTMLElement> {
  return openSubmenu(menu, "文件树");
}

/** 当前打开的根菜单（第一层）。 */
export function rootMenu(): HTMLElement {
  const root = document.querySelector<HTMLElement>('.context-menu[data-depth="0"]');
  if (!root) throw new Error("没有打开的右键菜单");
  return root;
}

/**
 * 沿一条路径点菜单：前面的名字依次展开子菜单，最后一个名字是要执行的条目（menuitem 或 menuitemcheckbox）。
 * 例：pickMenuItem(menu, "路径", "复制相对路径")。
 */
export async function pickMenuItem(menu: HTMLElement, ...names: (string | RegExp)[]): Promise<void> {
  let current = menu;
  for (const name of names.slice(0, -1)) current = await openSubmenu(current, name);
  const last = names[names.length - 1];
  const item = within(current).queryByRole("menuitem", { name: last }) ?? within(current).getByRole("menuitemcheckbox", { name: last });
  await fireEvent.click(item);
}
