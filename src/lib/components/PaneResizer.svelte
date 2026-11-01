<script lang="ts">
  import { clampWidth, MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, nudgeWidth } from "../layout";

  /**
   * 左栏右沿的拖动条，改动和历史共用。value 是当前渲染宽度：窗口窄时它可能小于已保存宽度，
   * 所以只有真的拖动或按键才回写，单纯点一下不会把收紧后的值存成偏好。
   */
  interface Props {
    value: number;
    label: string;
    onResize: (width: number) => void;
    onCommit: () => void;
  }

  let { value, label, onResize, onCommit }: Props = $props();

  function start(event: PointerEvent) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const startX = event.clientX;
    const startValue = value;
    let moved = false;
    target.setPointerCapture?.(event.pointerId);
    const move = (pointer: PointerEvent) => {
      moved = true;
      onResize(clampWidth(startValue + pointer.clientX - startX));
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
