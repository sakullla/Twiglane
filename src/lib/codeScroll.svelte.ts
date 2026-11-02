import { untrack } from "svelte";
import type { RulerLine } from "./layout";

/**
 * 代码窗口横向滚动的运行时部分，写在滚动容器上的三个变量：
 *
 * - `--code-x`：当前横向偏移，`.code-in` 按它平移。
 * - `--code-view`：scroller.clientWidth。bind:clientWidth 走 border-box 的 ResizeObserver，
 *   竖向滚动条增减时外框不变、回调不来，所以这里直接读属性：滚动、内容变化、尺寸变化都重读，
 *   同时观察滚动容器和内容轨道——内容变高带出滚动条时，变的是轨道。
 * - `--code-floor`：已渲染行的实测最大宽度，只增不减。标尺候选漏掉的行一旦渲染就撑大标尺，
 *   最长行因此一定能滚到；内容键变了才重新起算。
 *
 * 实测必须等 DOM 稳定：分词缓存命中时结果在 $effect 里同步送达，Svelte 要再跑一轮才更新
 * 复用的 {#each} 项。第一轮的 $effect 看到的是「旧片段文字 + 新追加片段」，比真实行宽约一倍，
 * 只增不减地锁存就成了幽灵滚动行程。所以放到下一帧量，并用 data-len 核对行文本长度。
 */
export function trackCodeScroll(
  scroller: () => HTMLElement | null,
  /** 标尺内容：采样文字和余量都相同才算同一份标尺，刷新出来的同内容新对象不算内容换了。 */
  ruler: () => RulerLine[],
  /** 渲染窗口：变化时重新实测已渲染行。 */
  rendered: () => unknown,
  /** 全部代码行的规模：标尺只留最长的几行，其余行换了要靠它识别，否则残留的 floor 不会重算。 */
  size: () => number,
): void {
  let floor = 0;
  let measuredKey: string | null = null;
  let measuredNode: HTMLElement | null = null;

  function setVar(node: HTMLElement, name: string, value: string) {
    if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
  }

  function syncBox(node: HTMLElement) {
    setVar(node, "--code-view", `${node.clientWidth}px`);
    setVar(node, "--code-x", `${node.scrollLeft}px`);
  }

  function measure(node: HTMLElement, key: string) {
    const fresh = key !== measuredKey || node !== measuredNode;
    let widest = fresh ? 0 : floor;
    for (const code of node.querySelectorAll<HTMLElement>(".code-in")) {
      if (Number(code.dataset.len) !== code.textContent?.length) continue;
      widest = Math.max(widest, code.offsetWidth);
    }
    measuredKey = key;
    measuredNode = node;
    if (fresh || widest > floor) {
      // 一次写入新值：先写 0 会让滚动范围瞬间收缩，scrollLeft 被钳回去。
      floor = widest;
      setVar(node, "--code-floor", `${floor}px`);
    }
    syncBox(node);
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

  let keyOf: RulerLine[] | null = null;
  let key = "";

  $effect(() => {
    const node = scroller();
    const lines = ruler();
    const scale = size();
    rendered();
    if (!node) return;
    return untrack(() => {
      if (lines !== keyOf) {
        keyOf = lines;
        key = lines.map((line) => `${line.restCh}\u0001${line.restIc}\u0001${line.text}`).join("\u0000");
      }
      syncBox(node);
      const stableKey = `${scale}\u0000${key}`;
      const frame = requestAnimationFrame(() => measure(node, stableKey));
      return () => cancelAnimationFrame(frame);
    });
  });
}
