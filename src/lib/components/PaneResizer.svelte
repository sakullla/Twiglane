<script lang="ts">
  import { clampWidth, MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, nudgeWidth } from "../layout";

  /**
   * 左栏右沿的拖动条，改动和历史共用。value 是当前渲染宽度：窗口窄时它可能小于已保存宽度，
   * 所以只有渲染宽度真的变了才回写。点一下、或顶着窗口上限继续调宽，都不会把收紧后的值存成偏好。
   */
  interface Props {
    value: number;
    label: string;
    /** 把想要的宽度换算成实际渲染宽度。 */
    fit: (width: number) => number;
    onResize: (width: number) => void;
    onCommit: () => void;
  }

  let { value, label, fit, onResize, onCommit }: Props = $props();

  function start(event: PointerEvent) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const startX = event.clientX;
    const startValue = value;
    let moved = false;
    target.setPointerCapture?.(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const next = clampWidth(startValue + pointer.clientX - startX);
      if (fit(next) === value) return;
      moved = true;
      onResize(next);
    };
    const stop = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      target.removeEventListener("pointercancel", stop);
      if (moved) onCommit();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
    target.addEventListener("pointercancel", stop);
  }

  function key(event: KeyboardEvent) {
    const next = nudgeWidth(value, event.key);
    if (next === null) return;
    event.preventDefault();
    if (fit(next) === value) return;
    onResize(next);
    onCommit();
  }
</script>

<div
  class="resizer"
  role="slider"
  tabindex="0"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuemin={MIN_PANEL_WIDTH}
  aria-valuemax={MAX_PANEL_WIDTH}
  aria-valuenow={value}
  onpointerdown={start}
  onkeydown={key}
></div>
