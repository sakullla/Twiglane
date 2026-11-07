import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuietActivity } from "../src/lib/quiet-activity";

describe("安静的后台活动指示", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const seen: boolean[] = [];
    const quiet = createQuietActivity((visible) => seen.push(visible), { showDelay: 160, minVisible: 480, now: () => Date.now() });
    return { seen, quiet };
  }

  it("很快结束的活动不显示，不会一闪", () => {
    const { seen, quiet } = setup();
    quiet.set(true);
    vi.advanceTimersByTime(100);
    quiet.set(false);
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
  });

  it("超过延迟才显示，显示后至少停留一段时间再收起", () => {
    const { seen, quiet } = setup();
    quiet.set(true);
    vi.advanceTimersByTime(160);
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(40);
    quiet.set(false);
    vi.advanceTimersByTime(400);
    expect(seen, "停留时间未满").toEqual([true]);
    vi.advanceTimersByTime(40);
    expect(seen).toEqual([true, false]);
  });

  it("停留期间又有新活动就接着显示，不先收起再出现", () => {
    const { seen, quiet } = setup();
    quiet.set(true);
    vi.advanceTimersByTime(200);
    quiet.set(false);
    vi.advanceTimersByTime(100);
    quiet.set(true);
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([true]);
    quiet.set(false);
    expect(seen, "已经停留够久，空闲后立即收起").toEqual([true, false]);
  });

  it("重置立即收起并清掉在途计时", () => {
    const { seen, quiet } = setup();
    quiet.set(true);
    vi.advanceTimersByTime(200);
    quiet.reset();
    expect(seen).toEqual([true, false]);
    quiet.set(true);
    quiet.reset();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([true, false]);
  });
});
