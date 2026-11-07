/**
 * 后台活动的「安静」显示：活动很快结束时不闪；一旦显示，至少停留一小段时间再收起。
 *
 * 文件监听会在短时间里连续触发重新验证，每次几十到几百毫秒。直接把在途状态画出来，
 * 指示器会一闪一闪；这里把它整形成：开始超过 showDelay 才出现，出现后至少保留 minVisible，
 * 期间又有新活动就接着显示，直到真正空闲。只决定「怎么显示」，不影响任何读取与写入。
 */
export interface QuietActivityOptions {
  showDelay?: number;
  minVisible?: number;
  now?: () => number;
}

export interface QuietActivity {
  /** 当前是否有活动在途。 */
  set(active: boolean): void;
  /** 清掉计时器并立即收起（换仓库、组件销毁）。 */
  reset(): void;
}

export function createQuietActivity(
  onVisible: (visible: boolean) => void,
  { showDelay = 160, minVisible = 480, now = () => Date.now() }: QuietActivityOptions = {},
): QuietActivity {
  let active = false;
  let visible = false;
  let shownAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clear() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function show(next: boolean) {
    if (visible === next) return;
    visible = next;
    if (next) shownAt = now();
    onVisible(next);
  }

  return {
    set(next: boolean) {
      if (next === active) return;
      active = next;
      clear();
      if (active) {
        if (visible) return;
        timer = setTimeout(() => {
          timer = undefined;
          if (active) show(true);
        }, showDelay);
        return;
      }
      if (!visible) return;
      const remaining = minVisible - (now() - shownAt);
      if (remaining <= 0) {
        show(false);
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (!active) show(false);
      }, remaining);
    },
    reset() {
      clear();
      active = false;
      show(false);
    },
  };
}
