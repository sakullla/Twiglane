import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ABBREV_LENGTH, abbrevLength, normalizeAbbrevLength, setAbbrevLength } from "../src/lib/abbrev.svelte";
import { shortOid } from "../src/lib/history";

const oid = "280ec9afecd88f38a755cac618a180bbc4a0f3c2";

describe("提交缩写长度", () => {
  afterEach(() => setAbbrevLength(DEFAULT_ABBREV_LENGTH));

  it("默认与 Git 的最小自动长度一致", () => {
    expect(abbrevLength()).toBe(7);
    expect(shortOid(oid)).toBe("280ec9a");
  });

  it("跟随仓库的缩写长度（core.abbrev 或 Git 按对象数放长）", () => {
    setAbbrevLength(12);
    expect(shortOid(oid)).toBe("280ec9afecd8");
    setAbbrevLength(40);
    expect(shortOid(oid)).toBe(oid);
  });

  it("旧响应缺省或异常值退回 7 位", () => {
    for (const value of [undefined, null, 0, 3, 65, 7.5, "12", Number.NaN]) {
      expect(normalizeAbbrevLength(value)).toBe(DEFAULT_ABBREV_LENGTH);
    }
    setAbbrevLength(12);
    setAbbrevLength(undefined);
    expect(shortOid(oid)).toBe("280ec9a");
  });
});
