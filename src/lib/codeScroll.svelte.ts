import { untrack } from "svelte";

/**
 * 代码窗口横向滚动的运行时部分，写在滚动容器上的三个变量：
 *
 * - `--code-x`：当前横向偏移，`.code-in` 按它平移。
 * - `--code-view`：scroller.clientWidth。bind:clientWidth 走 border-box 的 ResizeObserver，
 *   竖向滚动条增减时外框不变、回调不来，所以这里直接读属性：滚动、内容变化、尺寸变化都重读，
 *   同时观察滚动容器和内容轨道——内容变高带出滚动条时，变的是轨道。
 * - `--code-floor`：已渲染行的实测最大宽度，只增不减。标尺候选漏掉的行一旦渲染就撑大标尺，
 *   最长行因此一定能滚到；内容换了才归零。
 */
export function trackCodeScroll(
  scroller: () => HTMLElement | null,
  /** 标尺内容：对象变化表示内容换了。 */
  ruler: () => unknown,
  /** 渲染窗口：变化时重新实测已渲染行。 */
  rendered: () => unknown,
): void {
  let floor = 0;
  let basis: unknown;
  let measured: HTMLElement | null = null;

  function setVar(node: HTMLElement, name: string, value: string) {
    if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
  }

  function syncBox(node: HTMLElement) {
    setVar(node, "--code-view", `${node.clientWidth}px`);
    setVar(node, "--code-x", `${node.scrollLeft}px`);
  }

  $effect(() => {
    const node = scroller();
    if (!node) return;
    const sync = () => syncBox(node);
    node.addEventListener("scroll", sync, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(node);
    if (node.firstElementChild) observer?.observe(node.firstElementChild);
    return () => {
      node.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  });

  $effect(() => {
    const node = scroller();
    const next = ruler();
    rendered();
    if (!node) return;
    untrack(() => {
      if (next !== basis || node !== measured) {
        basis = next;
        measured = node;
        floor = 0;
        setVar(node, "--code-floor", "0px");
      }
      syncBox(node);
      let widest = floor;
      for (const code of node.querySelectorAll<HTMLElement>(".code-in")) widest = Math.max(widest, code.offsetWidth);
      if (widest > floor) {
        floor = widest;
        setVar(node, "--code-floor", `${floor}px`);
      }
    });
  });
}
