import { fireEvent, screen, waitFor } from "@testing-library/svelte";

/** 打开 SelectMenu 下拉并点选 data-value 对应的选项（替代原生 select 的 change）。 */
export async function pickMenu(name: string, value: string): Promise<void> {
  await fireEvent.click(screen.getByRole("button", { name }));
  const option = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>(".popover [role=option]")].find((node) => node.dataset.value === value);
    if (!found) throw new Error(`下拉 ${name} 里没有 ${value}`);
    return found;
  });
  await fireEvent.click(option);
}

/** 展开下拉读出全部选项的值，再按 Esc 收起。 */
export async function menuValues(name: string): Promise<string[]> {
  await fireEvent.click(screen.getByRole("button", { name }));
  const values = await waitFor(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>(".popover [role=option]")];
    if (nodes.length === 0) throw new Error(`下拉 ${name} 没有打开`);
    return nodes.map((node) => node.dataset.value ?? "");
  });
  await fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  return values;
}
