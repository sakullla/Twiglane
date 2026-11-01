import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const stylesDir = path.join(root, "src", "styles");
const layerFiles = ["tokens.css", "base.css", "components.css", "layout.css"] as const;

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 取出单条规则的声明体；selector 按字面量匹配，要求从行首或上一条规则后开始。 */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stripComments(css).match(new RegExp(`(?:^|[\\n;}])\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`未找到规则 ${selector}`);
  return match[1];
}

function tokensOf(body: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const raw of body.split(";")) {
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (!key.startsWith("--") || !value) continue;
    tokens.set(key, value);
  }
  return tokens;
}

function block(css: string, regex: RegExp): Map<string, string> {
  const match = css.replace(/\/\*[\s\S]*?\*\//g, "").match(regex);
  if (!match) throw new Error(`未找到匹配 ${String(regex)} 的令牌块`);
  return tokensOf(match[1]);
}

/** 一条 CSS 规则（不含 @ 前缀的 at-rule 本身）；selector 为未拆分的完整前导串。 */
type ParsedRule = { selector: string; body: string };

/**
 * 极简 CSS 规则扫描：只做本仓库需要的两件事——取到规则前导与声明体、进入 @media/@container
 * 继续扫描、跳过 @keyframes 里的关键帧块。规则体内不允许再嵌套花括号（本仓库无嵌套语法）。
 */
function parseRules(css: string): ParsedRule[] {
  const text = stripComments(css);
  const rules: ParsedRule[] = [];
  const atRules: string[] = [];
  let prelude = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "{") {
      const head = prelude.trim();
      prelude = "";
      if (head.startsWith("@")) {
        atRules.push(head);
        index += 1;
        continue;
      }
      const end = text.indexOf("}", index);
      if (end === -1) throw new Error(`规则未闭合：${head}`);
      const inKeyframes = atRules.some((at) => at.startsWith("@keyframes"));
      if (head && !inKeyframes) rules.push({ selector: head, body: text.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (char === "}") {
      atRules.pop();
      prelude = "";
      index += 1;
      continue;
    }
    if (char === ";") {
      prelude = "";
      index += 1;
      continue;
    }
    prelude += char;
    index += 1;
  }
  return rules;
}

/** 拆选择器组：只在括号外（:not(...) 等）按逗号分割。 */
function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** 引用装饰发丝线的 var(--border) / var(--border-strong)（不会命中 --control-border）。 */
const HAIRLINE_REFERENCE = /var\(\s*--border(?:-strong)?\s*\)/;

/** 取出声明体内所有引用发丝线的 border / border-color / border-* 声明。 */
function hairlineBorderDeclarations(body: string): string[] {
  return body
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => /^border(?:-[a-z]+)*\s*:/.test(declaration) && HAIRLINE_REFERENCE.test(declaration));
}

const tokensCss = read(path.join(stylesDir, "tokens.css"));
const shared = block(tokensCss, /(?:^|\n)\s*:root\s*\{([^}]*)\}/);
const light = block(tokensCss, /:root,\s*\[data-theme="light"\]\s*\{([^}]*)\}/);
const dark = block(tokensCss, /\[data-theme="dark"\]\s*\{([^}]*)\}/);

describe("设计令牌", () => {
  it("浅色与深色定义的令牌键集合完全一致", () => {
    const lightKeys = [...light.keys()].sort();
    const darkKeys = [...dark.keys()].sort();
    const onlyLight = lightKeys.filter((key) => !dark.has(key));
    const onlyDark = darkKeys.filter((key) => !light.has(key));
    expect({ onlyLight, onlyDark }).toEqual({ onlyLight: [], onlyDark: [] });
    expect(darkKeys).toEqual(lightKeys);
  });

  it("两套主题的每个令牌都有非空取值", () => {
    for (const [theme, tokens] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const [key, value] of tokens) {
        expect(value, `${theme} ${key}`).not.toBe("");
        expect(value.trim(), `${theme} ${key}`).toBe(value);
      }
    }
  });

  it("补齐间距、字阶、动效时长与层级四类维度", () => {
    const groups: Record<string, string[]> = {
      间距: ["--space-2", "--space-4", "--space-6", "--space-8", "--space-12", "--space-16", "--space-24", "--space-32"],
      字阶: ["--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--weight-normal", "--weight-medium", "--weight-semibold", "--leading-tight", "--leading-normal", "--leading-relaxed"],
      动效: ["--duration-fast", "--duration-base", "--duration-slow", "--ease", "--ease-out"],
      层级: ["--z-sticky", "--z-resizer", "--z-rail", "--z-titlebar", "--z-progress", "--z-menu", "--z-palette", "--z-modal", "--z-toast"],
    };
    for (const [group, keys] of Object.entries(groups)) {
      const missing = keys.filter((key) => !shared.has(key));
      expect(missing, `${group}缺失`).toEqual([]);
    }
  });

  it("层级令牌按 resizer < rail < 标题栏 < 菜单 < 面板 < modal < toast 递增", () => {
    const order = ["--z-resizer", "--z-rail", "--z-titlebar", "--z-menu", "--z-palette", "--z-modal", "--z-toast"];
    const values = order.map((key) => Number.parseInt(shared.get(key) ?? "", 10));
    expect(values.every((value) => Number.isInteger(value))).toBe(true);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i], `${order[i]} 应大于 ${order[i - 1]}`).toBeGreaterThan(values[i - 1]);
    }
  });

  it("主题选择器只出现在令牌层", () => {
    for (const file of layerFiles.filter((name) => name !== "tokens.css")) {
      expect(read(path.join(stylesDir, file)), file).not.toMatch(/\[data-theme/);
    }
  });

  it("可交互控件的边界由 --control-border 提供，而不是装饰发丝线", () => {
    const components = read(path.join(stylesDir, "components.css"));
    const layout = read(path.join(stylesDir, "layout.css"));
    const expectControlBoundary = (css: string, selector: string) => {
      const body = ruleBody(css, selector);
      expect(body, selector).toMatch(/var\(--control-border(-hover)?\)/);
      expect(body, selector).not.toMatch(/var\(--border(-strong)?\)/);
    };
    for (const selector of [".field", ".input, .textarea, .select", ".checkbox", ".switch input", ".btn-secondary", ".conflict-file"]) {
      expectControlBoundary(components, selector);
    }
    for (const selector of [".branch-pill", ".action-card", ".sidebar-add"]) {
      expectControlBoundary(layout, selector);
    }
    for (const [file, css, selector] of [
      ["components.css", components, ".field:hover"],
      ["components.css", components, ".btn-secondary:hover:not(:disabled)"],
      ["components.css", components, ".conflict-file:hover:not(:disabled)"],
      ["layout.css", layout, ".branch-pill:hover:not(:disabled)"],
      ["layout.css", layout, ".action-card:hover:not(:disabled)"],
      ["layout.css", layout, ".sidebar-add:hover:not(:disabled)"],
    ] as const) {
      expect(ruleBody(css, selector), `${file} ${selector}`).toMatch(/var\(--control-border-hover\)/);
    }
  });

  it("控件边界令牌在两套主题中定义且对每个表面都不低于 3:1", () => {
    const surfaces = ["--surface", "--bg", "--surface-2", "--surface-3"];
    const parse = (value: string): number[] => {
      const hex = value.match(/^#([0-9a-fA-F]{6})$/);
      if (!hex) throw new Error(`不是 6 位十六进制色：${value}`);
      return [0, 2, 4].map((offset) => Number.parseInt(hex[1].slice(offset, offset + 2), 16));
    };
    const luminance = (rgb: number[]): number => {
      const channel = (c: number) => {
        const scaled = c / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    };
    const contrast = (a: number[], b: number[]): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const [theme, tokens] of [["light", light], ["dark", dark]] as const) {
      for (const token of ["--control-border", "--control-border-hover"]) {
        const value = tokens.get(token);
        expect(value, `${theme} ${token}`).toBeTruthy();
        for (const surface of surfaces) {
          const surfaceValue = tokens.get(surface);
          expect(surfaceValue, `${theme} ${surface}`).toBeTruthy();
          const measured = contrast(parse(value as string), parse(surfaceValue as string));
          expect(measured, `${theme} ${token} on ${surface}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });
});

describe("样式分层结构", () => {
  it("四层文件齐备", () => {
    for (const file of layerFiles) {
      expect(read(path.join(stylesDir, file)).trim().length, file).toBeGreaterThan(0);
    }
  });

  it("颜色字面值只出现在令牌层，组件与布局不内联主题外颜色", () => {
    for (const file of layerFiles.filter((name) => name !== "tokens.css")) {
      const css = stripComments(read(path.join(stylesDir, file)));
      const withoutUrls = css.replace(/url\((['"]?)[^)]*\1\)/g, "url()");
      expect(withoutUrls, file).not.toMatch(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/);
      // 颜色函数只允许由 var() 组合（如 hsl(var(--hue, 150) var(--x-sat) var(--x-light))），
      // 首参是数值或十六进制即属写死的颜色。
      expect(withoutUrls, file).not.toMatch(/\b(?:rgba?|hsla?)\((?!\s*var\()/);
      // data URI 里的 %23abcdef 同样是写死的颜色，无法随主题切换
      expect(css, file).not.toMatch(/%23[0-9a-fA-F]{6}/);
    }
    expect(stripComments(read(path.join(stylesDir, "tokens.css")))).toMatch(/#[0-9a-fA-F]{6}/);
  });

  it("头像与仓库徽标的色相在实例元素上合成，不在 :root 提前解析", () => {
    const components = read(path.join(stylesDir, "components.css"));
    const layout = read(path.join(stylesDir, "layout.css"));
    const avatar = ruleBody(components, ".avatar");
    const badge = ruleBody(layout, ".repo-badge");
    expect(avatar).toMatch(/background:\s*hsl\(var\(--hue, 150\) var\(--avatar-bg-sat\) var\(--avatar-bg-light\)\)/);
    expect(badge).toMatch(/color:\s*hsl\(var\(--hue, 150\) var\(--repo-badge-fg-sat\) var\(--repo-badge-fg-light\)\)/);
    expect(badge).toMatch(/background:\s*hsl\(var\(--hue, 150\) var\(--repo-badge-bg-sat\) var\(--repo-badge-bg-light\)\)/);
    // 派生颜色不能再以 :root 令牌的形式出现（那样 var(--hue) 会在根元素上取缺省值）
    const tokensCss = stripComments(read(path.join(stylesDir, "tokens.css")));
    for (const name of ["--avatar-bg", "--repo-badge-fg", "--repo-badge-bg"]) {
      expect(tokensCss).not.toMatch(new RegExp(`${name}\\s*:`));
    }
    for (const [theme, tokens] of [["light", light], ["dark", dark]] as const) {
      for (const name of ["--avatar-bg-sat", "--avatar-bg-light", "--repo-badge-fg-sat", "--repo-badge-fg-light", "--repo-badge-bg-sat", "--repo-badge-bg-light"]) {
        expect(tokens.get(name), `${theme} ${name}`).toMatch(/^[\d.]+%$/);
      }
    }
  });

  it("下拉箭头跟随主题变量而不是内联 SVG 颜色", () => {
    const body = ruleBody(read(path.join(stylesDir, "components.css")), ".select");
    expect(body).toMatch(/var\(--fg-subtle\)/);
    expect(body).not.toMatch(/data:image/);
  });

  it("src/app.css 只做 @import 聚合且顺序固定", () => {
    const entry = read(path.join(root, "src", "app.css")).replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const imports = [...entry.matchAll(/@import\s+"([^"]+)";/g)].map((match) => match[1]);
    expect(imports).toEqual(["./styles/tokens.css", "./styles/base.css", "./styles/components.css", "./styles/layout.css"]);
    const withoutImports = entry.replace(/@import\s+"[^"]+";/g, "").trim();
    expect(withoutImports, "入口文件不应包含规则").toBe("");
  });
});

/**
 * 装饰性发丝线白名单 —— 「默认拒绝」门禁的事实清单
 * ---------------------------------------------------------------------------
 * 为什么是白名单而不是逐条列举控件：`--border` / `--border-strong` 是发丝线，
 * 在白底上只有 1.1:1，只允许出现在「没有交互态、不承担控件边界」的轮廓与分隔线上。
 * 反过来（枚举所有控件）每加一个控件就漏一次，因此改成：任何在 border 族声明里
 * 引用发丝线的规则，只要选择器不在下表，测试就红。新增控件必须显式改用
 * `--control-border` / `--control-border-hover`（或可测的 `--accent` 状态边界），
 * 否则唯一的合法出路是带着理由进这张表。
 *
 * 每条的理由都要回答「为什么这里不需要 ≥3:1 的可辨识边界」：通常是因为
 * (a) 元素本身不可交互、没有 hover/focus/pressed 态；或
 * (b) 它是容器/表格轮廓，容器内的可交互控件各自带控件边界；
 * 或 (c) 它只做分区（标题栏底部、卡片头部底部这类横向分隔线）。
 *
 * 本门禁扫描 base.css / components.css / layout.css 三层（比要求的组件层+布局层多含基础层，
 * 因为 kbd、滚动条这些基础规则的边界同样不该冒充控件边界）。覆盖边界（明说不含糊）：
 * - 只审 `border` / `border-color` / `border-*` 声明。用 `background` 或 `box-shadow`
 *   画出来的线不在内（`.resizer`、`.menu-sep`、`.merge-step-line`、
 *   `.art-branch-line > span`、`.empty-icon`、`.context-separator` 的 `color`）：
 *   它们同样只做分区/描边，且没有哪一处是某个控件唯一的可见边界。
 * - 以 `transparent` 为常态的控件不会被命中：它们的可辨识度由其它手段承担，属另一套判据，
 *   不在本门禁内。现存四处，逐个说明为何可接受：
 *   `.btn`（文字按钮/实心按钮由标签与填充识别，ghost 有 hover 背景）、
 *   `.file-row` 与 `.history-row`（列表行由 hover 背景 + 选中态 accent-soft 填充与 accent 竖条识别）、
 *   `.action-card.primary`（强调卡是实心 accent 填充，边界本就无意义）。
 *   注意 `.file-tools .field` 曾经也是 transparent，填充差只有 1.04:1，已被改为继承
 *   `.field` 的 --control-border（见下方「被点名过的控件」用例）。
 */
const DECORATIVE_HAIRLINE_RULES: Record<string, string> = {
  // --- base.css ---
  kbd: "键位提示标签，纯展示文本；按钮内的 kbd 不承载点击态",

  // --- components.css：容器与浮层外框（容器内的控件各自带边界） ---
  ".menu": "浮层外框；菜单项自身用 hover 背景与文字色标示，外框不充当控件边界",
  ".toast": "通知卡外框，卡体不可交互（关闭按钮自带 hover 背景）",
  ".modal-card": "modal 卡片外框；层次由遮罩与阴影表达，卡内输入/按钮各自带边界",
  ".modal-foot": "modal 底部横向分隔线，分隔正文与操作区",
  ".callout": "提示框外框，静态说明块，无交互态",
  ".card": "卡片骨架外框（任务面板容器），卡内控件各自带边界",
  ".card-head": "卡片头部横向分隔线",
  ".card-foot": "卡片底部横向分隔线",
  ".list-box": "列表容器外框，行结构由行分隔线与 hover 背景表达",
  ".list-row": "列表行底部分隔线；行 hover 用背景色、选中用 accent 竖条",
  ".list-section": "分组标题底部分隔线，纯分区",
  ".list-empty": "空状态底部分隔线，纯分区",
  ".scope-list": "提交范围路径清单容器轮廓，清单项是只读文本",
  ".composer": "提交区与上方差异面板之间的顶部分区线",
  ".diff": "差异面板容器外框；工具条控件各自带边界",
  ".diff-toolbar": "差异工具条底部分隔线",
  ".diff-more": "差异面板底部横向分隔线",
  ".full-value": "详情弹窗的只读展示框（readonly textarea），只区分文本块；可编辑态 textarea.full-value.editable 用控件边界",
  ".commit-body": "提交信息正文块的容器轮廓，只读文本",
  ".history-files": "提交内文件列表的容器轮廓",
  ".multi-file": "多文件卡外框，卡内文件行自带交互反馈",
  ".span-main": "历史/合并面板容器外框",
  ".branch-current": "当前分支卡的 accent 16% 强调描边，是状态容器而非控件边界",
  ".branch-create": "新建分支表单容器轮廓；内部 .input/.field 自带控件边界",
  ".tag-create": "新建标签表单容器轮廓；内部 .input 自带控件边界",
  ".merge-guide": "合并指引卡外框；卡内 select 与按钮各自带边界",
  ".merge-guide-branch": "指引里的分支卡外框；内部 select 无边框但由卡片强调区分",
  ".merge-guide-result": "合并结果块外框；就绪/受阻态另有 accent/warning 描边",
  ".three-way-merge": "三方合并容器外框",
  ".art-card": "起始页插画卡外框（装饰性插画，不可交互）",
  ".welcome-recent": "最近仓库网格外框",
  ".toolbar-group": "标题栏按钮组外框；组内 .tb-btn 自带 hover 背景",
  ".view-heading-status": "视图标题右侧状态胶囊，静态展示",
  ".chip.ignore": "忽略标记 chip 的虚线描边，是状态标记而非可点击控件",
  ".history-hash": "哈希 chip 外框；内部复制按钮自带 hover 背景",
  ".branch-current-sync > span": "上游/下游计数胶囊，静态展示",
  ".merge-step-index": "步骤序号圆圈；当前步以 accent 描边强调，圆圈本身不可点",

  // --- components.css：表格/列分隔线与分区线 ---
  ".pane-head": "面板标题栏底部横向分隔线",
  ".panel-toolbar": "面板工具条底部横向分隔线",
  ".history-list": "历史列表与详情之间的竖向分栏线",
  ".history-meta": "提交元信息区块底部横向分隔线",
  ".history-multi-head": "多选头部底部横向分隔线",
  ".multi-file.expanded .multi-file-head": "展开的文件卡头部底部横向分隔线",
  ".stash-record": "临时保存记录底部横向分隔线",
  ".merge-guide-actions": "指引操作条顶部横向分隔线",
  ".conflict-sidebar": "冲突侧栏右分隔线（分区线，不是行边界）",
  ".three-way-title": "三方合并表头底部横向分隔线",
  ".three-way-foot": "三方合并表尾顶部横向分隔线",
  ".diff-line .ln + .ln": "差异视图行号列的表格竖线",
  ".side-cell + .side-cell": "双栏差异的列分隔竖线",
  ".three-way-title.result": "结果列表头的左右表格竖线",

  // --- components.css：合并 modal 与逐处处理冲突 ---
  ".mp-head": "合并面板标题条底部横向分隔线",
  ".mp-foot": "合并面板底部操作条顶部横向分隔线",
  ".cr-main": "冲突流容器外框；内部可交互的是各处冲突的按钮，按钮自带控件边界",
  ".cr-card": "冲突块左右轮廓，只把同一处冲突的行框成一组；当前一处另用 --accent 状态边",
  ".cr-head": "冲突块头部顶边，卡片轮廓的一部分；头部里的按钮各自带控件边界",
  ".cr-cols": "当前/来源列标题行底部分隔线",
  ".cr-half + .cr-half": "并排两栏之间的表格竖线",
  ".cr-row.last": "冲突块末行底边，卡片轮廓的一部分",
  ".cr-ruler": "总览标尺与冲突流之间的竖向分隔线；刻度本身是按钮，用实心色块标示",

  // --- components.css：语义色混合的容器描边（不是控件边界） ---
  ".merge-guide-branch.target": "目标分支卡 accent 混合描边，状态强调",
  ".merge-guide-result.ready": "结果块就绪态 accent 混合描边，状态强调",
  ".merge-guide-result.blocked": "结果块受阻态 warning 混合描边，状态强调",

  // --- layout.css ---
  ".topbar": "标题栏底部横向分区线",
  ".infobar": "通知条底部横向分区线",
  ".workspace-nav": "侧栏导航组底部横向分区线",
  ".sidebar-foot": "侧栏底部顶部横向分区线",
  ".files": "文件列表面板外框；行内交互由 .file-row 的选中竖条承担",
  ".view-title-line .count": "视图标题计数胶囊描边，纯装饰数字标记",
  ".sidebar-section .count": "侧栏分组计数胶囊描边，纯装饰数字标记",
  ".welcome-recent button": "最近仓库网格的行分隔线；行本身由文字与 hover 背景标示，与 .list-row 同类",
  ".welcome-recent button:nth-child(odd)": "最近仓库网格的列分隔竖线",
  ".welcome-recent button:nth-last-child(-n+2)": "网格末行去掉底部分隔线（覆盖为分区修正）",
  ".statusbar": "状态栏顶部横向分区线",
};

describe("控件边界策略（默认拒绝）", () => {
  const layerFilesToScan = ["base.css", "components.css", "layout.css"] as const;

  it("引用装饰发丝线的 border 声明必须落在显式白名单内", () => {
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const file of layerFilesToScan) {
      const css = read(path.join(stylesDir, file));
      for (const rule of parseRules(css)) {
        const declarations = hairlineBorderDeclarations(rule.body);
        if (declarations.length === 0) continue;
        for (const selector of splitSelectorList(rule.selector)) {
          used.add(selector);
          if (!Object.prototype.hasOwnProperty.call(DECORATIVE_HAIRLINE_RULES, selector)) {
            offenders.push(`${file} :: ${selector} { ${declarations.join("; ")} }`);
          }
        }
      }
    }
    expect(
      offenders,
      "以下规则的边界引用了装饰发丝线 --border/--border-strong，却不在 tests/tokens.spec.ts 的装饰白名单内：" +
        "请在 components.css/layout.css 里改用 --control-border / --control-border-hover（或可测的 --accent 状态边界），" +
        "或把选择器连同「为什么它是纯装饰」的理由加进 DECORATIVE_HAIRLINE_RULES",
    ).toEqual([]);
  });

  it("白名单没有过期条目，且每条都写了理由", () => {
    const used = new Set<string>();
    for (const file of layerFilesToScan) {
      for (const rule of parseRules(read(path.join(stylesDir, file)))) {
        if (hairlineBorderDeclarations(rule.body).length === 0) continue;
        for (const selector of splitSelectorList(rule.selector)) used.add(selector);
      }
    }
    const stale = Object.keys(DECORATIVE_HAIRLINE_RULES).filter((selector) => !used.has(selector));
    expect(stale, "白名单条目已不再引用发丝线（规则被删或改用了控件边界），请同步删除").toEqual([]);
    const unexplained = Object.entries(DECORATIVE_HAIRLINE_RULES)
      .filter(([, reason]) => reason.trim().length < 8)
      .map(([selector]) => selector);
    expect(unexplained, "白名单条目必须写明为什么是纯装饰").toEqual([]);
  });

  it("被点名过的控件不再借装饰发丝线做边界", () => {
    const components = read(path.join(stylesDir, "components.css"));
    const fileToolsField = ruleBody(components, ".file-tools .field");
    expect(fileToolsField, ".file-tools .field 不能把边界覆盖成透明").not.toMatch(/border(-color)?:\s*[^;]*transparent/);
    for (const selector of [
      ".composer-box",
      ".composer-box:hover",
      ".composer-box:focus-within",
      "textarea.full-value.editable",
      "textarea.full-value.editable:hover",
      "textarea.full-value.editable:focus",
      ".conflict-sidebar .conflict-file",
      ".conflict-sidebar .conflict-file:hover:not(:disabled)",
      '.conflict-sidebar .conflict-file[aria-pressed="true"]',
      ".file-tools .field:focus-within",
      ".three-way-pane.result",
      ".three-way-pane.result:focus-within",
    ]) {
      expect(ruleBody(components, selector), selector).not.toMatch(/var\(--border(-strong)?\)/);
    }
    expect(ruleBody(components, ".composer-box"), ".composer-box 常态").toMatch(/var\(--control-border\)/);
    expect(ruleBody(components, ".composer-box:hover"), ".composer-box hover").toMatch(/var\(--control-border-hover\)/);
    expect(ruleBody(components, "textarea.full-value.editable"), ".full-value.editable 常态").toMatch(/var\(--control-border\)/);
    expect(ruleBody(components, "textarea.full-value.editable:hover"), ".full-value.editable hover").toMatch(
      /var\(--control-border-hover\)/,
    );
    for (const selector of [
      ".conflict-sidebar .conflict-file",
      ".conflict-sidebar .conflict-file:hover:not(:disabled)",
      '.conflict-sidebar .conflict-file[aria-pressed="true"]',
    ]) {
      const body = ruleBody(components, selector);
      expect(body, selector).toMatch(/border(-color)?:\s*1px solid var\(--(control-border(-hover)?|accent)\)|border-color:\s*var\(--(control-border(-hover)?|accent)\)/);
    }
    expect(ruleBody(components, ".three-way-pane.result"), ".three-way-pane.result 常态").toMatch(
      /border-(right|left):\s*1px solid var\(--control-border\)/,
    );
    expect(ruleBody(components, ".three-way-pane.result:focus-within"), ".three-way-pane.result 焦点态").toMatch(
      /var\(--accent\)/,
    );
    // 栏内 textarea 铺满整栏，栏上的内描边会被它盖住，因此焦点环必须落在 textarea 自身上。
    expect(ruleBody(components, ".three-way-pane.result textarea:focus-visible"), "合并结果编辑框焦点环").toMatch(
      /outline:\s*2px solid var\(--focus\)/,
    );
  });

  /**
   * 弱化位点的判据：不用元素级 opacity，改用弱化令牌。
   * 整行/文字 opacity 会把前景与所在表面按 α 合成，令牌层通过的值渲染后可能掉到
   * 4.5:1 以下（整行 0.75 会把 --fg-subtle 的 5.10:1 压到 3.11:1，同时把该行的
   * --control-border 压到 2.46:1）。scripts/check-contrast.mjs 的 COMPOSITE_TEXT_PAIRS
   * 按合成值兜底，这里挡住「重新加回 opacity」这一步。
   */
  it("弱化文字走弱化令牌，不用元素级 opacity", () => {
    const components = read(path.join(stylesDir, "components.css"));
    const layout = read(path.join(stylesDir, "layout.css"));
    const opacityDecl = /(?:^|;)\s*opacity\s*:\s*([\d.]+)\s*(?:;|$)/;

    const resolvedRow = ruleBody(components, ".conflict-sidebar .conflict-file.resolved");
    expect(opacityDecl.test(resolvedRow), ".conflict-file.resolved 不能用整行 opacity 弱化").toBe(false);
    expect(ruleBody(components, ".conflict-file.resolved .conflict-file-copy strong"), "已标记行名字").toMatch(
      /color:\s*var\(--fg-dimmed\)/,
    );

    const fromPath = ruleBody(components, ".file-name .fd.from");
    expect(opacityDecl.test(fromPath), ".fd.from 不能用文字 opacity 弱化").toBe(false);
    expect(fromPath, "来源路径弱化色").toMatch(/color:\s*var\(--purple-dimmed\)/);

    // 键位提示是正文信息：显示时必须完全不透明（0.75 会把 --fg-subtle 压到 3.11:1）。
    const navKbd = ruleBody(layout, ".workspace-nav-item:hover kbd, .workspace-nav-item:focus-visible kbd");
    expect(navKbd, "键位提示显示态").toMatch(/opacity:\s*1(?:;|\s|$)/);

    // 弱化令牌两套主题都要定义，且不得与基础正文色同值（否则「弱化」没有语义）。
    for (const [theme, tokens] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const [dim, base] of [
        ["--fg-dimmed", "--fg-subtle"],
        ["--purple-dimmed", "--purple"],
      ] as const) {
        expect(tokens.get(dim), `${theme} ${dim}`).toBeTruthy();
        expect(tokens.get(dim), `${theme} ${dim} 不应等于 ${base}`).not.toBe(tokens.get(base));
      }
    }
  });

  /**
   * 主行动卡（起始页第一入口）的说明文字是正文：必须取不透明的 --accent-fg
   * （对 --accent 浅 4.56:1 / 深 7.55:1，对 --accent-hover 浅 5.85:1 / 深 9.04:1）。
   * 75% 的 color-mix 淡化合成后只剩 3.27:1（浅）/ 4.46:1（深），低于正文 4.5:1；
   * 淡化只留给同一行那个纯字形箭头，并由 scripts/check-contrast.mjs 的
   * COLOR_MIX_ALPHA_SITES 按非文本 3:1 校验。
   */
  it("主行动卡的正文不淡化，淡化只留给图标字形", () => {
    const layout = read(path.join(stylesDir, "layout.css"));
    const copy = ruleBody(layout, ".action-card.primary .ac-copy > span");
    expect(copy, "主行动卡正文取不透明 --accent-fg").toMatch(/color:\s*var\(--accent-fg\)/);
    expect(copy, "主行动卡正文不能再用 alpha 淡化").not.toMatch(/color-mix|transparent/);
    const glyph = ruleBody(layout, ".action-card.primary > .icon");
    expect(glyph, "箭头字形保留 75% 淡化（已登记进 check-contrast 的淡化位点清单）").toMatch(
      /color-mix\(in srgb, var\(--accent-fg\) 75%, transparent\)/,
    );
  });

  /**
   * 焦点可见性：被清零 outline 的可聚焦元素/容器必须补回 ≥3:1 的可见焦点环。
   * 判据是「环本身的颜色」而不是它旁边有什么：--accent-soft 只是 9.5%（深 13%）alpha 的
   * tint，对 --surface 合成后约 1.13:1，画出来的环等于不可见；--focus 对 --surface 浅
   * 3.56:1 / 深 9.31:1、对 --surface-2 浅 3.40:1 / 深 8.84:1，也已在 check-contrast 的
   * 交互对里。R15 的验收归 T5，这里只挡住样式层把洞开回去。
   */
  it("被清零 outline 的可聚焦元素都补回可见焦点环", () => {
    const components = read(path.join(stylesDir, "components.css"));
    for (const selector of [
      ".menu-item:focus-visible",
      ".file-list:focus-visible",
      ".diff-scroll:focus-visible",
      ".history-list:focus-visible",
      ".merge-guide-select select:focus-visible",
      ".three-way-pane.result textarea:focus-visible",
    ]) {
      const body = ruleBody(components, selector);
      expect(body, `${selector} 必须有可见焦点环`).toMatch(/outline:\s*2px solid var\(--focus\)/);
      expect(body, `${selector} 不能再用低透明度色块冒充焦点环`).not.toMatch(/var\(--accent-soft(?:er)?\)/);
    }
  });
});
