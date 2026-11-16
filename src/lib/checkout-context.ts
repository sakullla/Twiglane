import { checkoutKey } from "./workspaces";
/** Session-only reading state. No Git snapshots or private credentials enter shared manifests. */
export class CheckoutContexts<T> {
  private contexts = new Map<string, T>();
  save(path: string, context: T): void { this.contexts.set(checkoutKey(path), context); }
  restore(path: string): T | undefined { return this.contexts.get(checkoutKey(path)); }
  clear(): void { this.contexts.clear(); }
}

const positions = new Map<string, { top: number; left: number }>();
/** Restore after asynchronous content has enough height; scrolling events keep the same checkout key. */
export function rememberScroll(node: HTMLElement, initialKey: string | null) {
  let key: string | null = null;
  let pending: { top: number; left: number } | undefined;
  let restoring = false;
  const save = () => {
    if (key && !pending && !restoring) positions.set(key, { top: node.scrollTop, left: node.scrollLeft });
  };
  const restore = () => {
    if (!pending) return;
    restoring = true;
    node.scrollTop = pending.top;
    node.scrollLeft = pending.left;
    // If a smaller result no longer reaches the old position, keep a useful clamped position.
    if (node.scrollHeight >= pending.top + node.clientHeight || node.scrollHeight > node.clientHeight) {
      pending = undefined;
      node.dispatchEvent(new Event("scroll"));
    }
    restoring = false;
  };
  const update = (next: string | null) => {
    if (next === key) { schedule(); return; }
    save();
    const previous = key;
    key = next;
    pending = key ? positions.get(key) : undefined;
    if (pending) schedule();
    else if (key && previous) {
      restoring = true;
      node.scrollTop = 0; node.scrollLeft = 0;
      node.dispatchEvent(new Event("scroll"));
      restoring = false;
    }
  };
  let frame: number | null = null;
  const schedule = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = null; restore(); });
  };
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  resize?.observe(node);
  const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
  mutation?.observe(node, { childList: true, subtree: true });
  node.addEventListener("scroll", save, { passive: true });
  update(initialKey);
  return { update, destroy() { save(); if (frame !== null) cancelAnimationFrame(frame); resize?.disconnect(); mutation?.disconnect(); node.removeEventListener("scroll", save); } };
}
