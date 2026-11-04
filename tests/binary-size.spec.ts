import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import LineCounts from "../src/lib/components/LineCounts.svelte";
import { commitLineStat } from "../src/lib/history";
import { binarySizeText, formatBytes, sizeDelta } from "../src/lib/ui";

describe("二进制改动显示文件大小", () => {
  it("字节数按 B / KB / MB 读写，小于 10 保留一位小数", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12 * 1024 + 300)).toBe("12 KB");
    expect(formatBytes(3 * 1024 * 1024 + 400 * 1024)).toBe("3.4 MB");
    expect(sizeDelta(1024, 2048)).toBe("增大 1 KB");
    expect(sizeDelta(2048, 1748)).toBe("减小 300 B");
    expect(sizeDelta(5, 5)).toBe("大小不变");
  });

  it("前后都有写成 A → B，新增只写新大小，删除写原大小，都没有时为空", () => {
    expect(binarySizeText(1024, 2048)).toEqual({ text: "1 KB → 2 KB", label: "二进制文件，大小由 1 KB 变为 2 KB" });
    expect(binarySizeText(null, 3)?.text).toBe("3 B");
    expect(binarySizeText(4096, undefined)?.label).toBe("二进制文件已删除，原为 4 KB");
    expect(binarySizeText(undefined, null)).toBeNull();
  });

  it("文件行、提交文件行的计数位置显示大小，读不到大小才退回「二进制」", () => {
    const view = render(LineCounts, { props: { stat: { additions: null, deletions: null, oldSize: 100, newSize: 150 } } });
    expect(screen.getByLabelText("二进制文件，大小由 100 B 变为 150 B").textContent).toBe("100 B → 150 B");
    expect(screen.queryByText("二进制")).toBeNull();
    view.unmount();

    render(LineCounts, { props: { stat: commitLineStat({ binary: true, oldSize: null, newSize: 2048 }) } });
    expect(screen.getByLabelText("二进制文件，2 KB").textContent).toBe("2 KB");
  });

  it("文件清单行里不显示二进制标记，文本行数照常", () => {
    const view = render(LineCounts, { props: { stat: { additions: null, deletions: null, oldSize: 100, newSize: 150 }, hideBinary: true } });
    expect(document.querySelector(".diff-stats")).toBeNull();
    view.unmount();
    render(LineCounts, { props: { stat: { additions: 2, deletions: 1 }, hideBinary: true } });
    expect(screen.getByLabelText("新增 2 行，删除 1 行")).toBeTruthy();
  });

  it("没有大小信息时保持原来的「二进制」标记", () => {
    render(LineCounts, { props: { stat: { additions: null, deletions: null } } });
    expect(screen.getByText("二进制")).toBeTruthy();
  });
});
