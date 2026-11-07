/**
 * 提交缩写长度：跟随当前仓库的 Git 设置（core.abbrev；未设置时 Git 按对象数自动放长，最少 7 位），
 * 与 `git log --oneline`、终端里看到的缩写一致。打开仓库时由后端读出，这里只保存显示用的长度。
 *
 * 是 $state：换仓库后所有 shortOid 的显示随之更新；值不合法（旧后端缺省、异常输入）时退回 7 位。
 */
export const DEFAULT_ABBREV_LENGTH = 7;
const MIN_ABBREV_LENGTH = 4;
const MAX_ABBREV_LENGTH = 64;

const abbrev = $state({ length: DEFAULT_ABBREV_LENGTH });

export function abbrevLength(): number {
  return abbrev.length;
}

export function normalizeAbbrevLength(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_ABBREV_LENGTH && value <= MAX_ABBREV_LENGTH
    ? value
    : DEFAULT_ABBREV_LENGTH;
}

export function setAbbrevLength(value: unknown): void {
  abbrev.length = normalizeAbbrevLength(value);
}
