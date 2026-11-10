/**
 * 命令面板的匹配与排序。
 *
 * 只按子串过滤时，「合并分支」找不到「分支合并」、「管理分支」找不到「分支与标签」，
 * 输入 Git 的英文叫法（stash、push、merge）也什么都没有。这里把匹配分成几档：
 *
 * 1. 标题以关键词开头；
 * 2. 标题包含关键词；
 * 3. 某条别名以关键词开头，或分组名包含关键词；
 * 4. 三个字以上的中文关键词不计字序：每个字都出现在标题或同一条别名里；
 * 5. （弱）别名中间包含关键词——仓库路径片段走这一档；
 * 6. （弱）说明文字包含关键词。
 *
 * 空格分开的多个词须全部命中；一条命令的得分是各词档位之和，越小越靠前，同分保持原序。
 * 弱匹配只是兜底：只要有命令在前四档里命中，弱匹配就不出现。否则搜「提交」会因为
 * 说明里的一句「不暂存、不提交」把毫不相干的命令带出来，真正想要的反而被挤到后面。
 * 这里只负责「匹配谁、谁在前」，可用与否的排序由面板自己决定。
 */
export interface PaletteSearchable {
  title: string;
  group: string;
  /** 只参与匹配、不显示的检索词；空格分开的每一段是一条独立的别名。 */
  keywords?: string;
  /** 一行说明：最弱的一档，只认原样包含。 */
  hint?: string;
}

const TITLE_PREFIX = 0;
const TITLE_SUBSTRING = 1;
const ALIAS = 2;
const LOOSE = 3;
/** 从这一档起是弱匹配：有更强的结果时整档不显示。 */
const WEAK = 4;
const ALIAS_SUBSTRING = 4;
const HINT = 5;
/** 不计字序的匹配至少要三个字：两个字太容易在不相干的别名里凑齐。 */
const LOOSE_MIN = 3;

const CJK = /^[\u3400-\u9fff\uf900-\ufaff]+$/;

export function queryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** 不计顺序：关键词的每个字都在同一段文字里出现。只用于三个字以上的中文关键词。 */
function looseHit(token: string, phrase: string): boolean {
  for (const char of token) {
    if (!phrase.includes(char)) return false;
  }
  return true;
}

function tokenScore(token: string, item: PaletteSearchable): number | null {
  const title = item.title.toLowerCase();
  if (title.startsWith(token)) return TITLE_PREFIX;
  if (title.includes(token)) return TITLE_SUBSTRING;
  const keywords = (item.keywords ?? "").toLowerCase();
  // 逐条别名各自判断：把所有别名拼成一袋字会让毫不相干的组合也命中。
  const phrases = keywords.split(/\s+/).filter(Boolean);
  if (phrases.some((phrase) => phrase.startsWith(token)) || item.group.toLowerCase().includes(token)) return ALIAS;
  if (token.length >= LOOSE_MIN && CJK.test(token)) {
    if (looseHit(token, title) || phrases.some((phrase) => looseHit(token, phrase))) return LOOSE;
  }
  if (keywords.includes(token)) return ALIAS_SUBSTRING;
  if (item.hint && item.hint.toLowerCase().includes(token)) return HINT;
  return null;
}

interface Score {
  total: number;
  /** 有任何一个词只靠弱匹配命中。 */
  weak: boolean;
}

function score(item: PaletteSearchable, tokens: string[]): Score | null {
  let total = 0;
  let weak = false;
  for (const token of tokens) {
    const value = tokenScore(token, item);
    if (value === null) return null;
    if (value >= WEAK) weak = true;
    total += value;
  }
  return { total, weak };
}

/** 一条命令对整串关键词的得分；有任何一个词没命中就是 null。 */
export function paletteScore(item: PaletteSearchable, tokens: string[]): number | null {
  return score(item, tokens)?.total ?? null;
}

/**
 * 过滤并按匹配质量排序；空关键词原样返回。排序稳定：同分的命令保持注册表里的先后。
 * 弱匹配（别名中间包含、说明包含）只在没有更强的结果时才返回。
 */
export function rankPalette<T extends PaletteSearchable>(items: readonly T[], query: string): T[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [...items];
  const scored: { item: T; total: number; weak: boolean; index: number }[] = [];
  items.forEach((item, index) => {
    const result = score(item, tokens);
    if (result) scored.push({ item, ...result, index });
  });
  const strong = scored.filter((entry) => !entry.weak);
  const shown = strong.length > 0 ? strong : scored;
  shown.sort((a, b) => a.total - b.total || a.index - b.index);
  return shown.map((entry) => entry.item);
}
