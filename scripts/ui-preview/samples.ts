// 预览用的多语言差异样本：按扩展名给出「改动前 / 改动后」两份真实感代码，用来看语法高亮与行内改动标记。
// 仅用于 npm run preview:ui，不进入 Tauri 构建。

export interface Sample {
  before: string;
  after: string;
}

const svelte: Sample = {
  before: `<script lang="ts">
  import { onMount } from "svelte";
  import { legacyRender } from "./legacy";

  /** 旧的渲染入口 */
  export let theme = "classic";
  let count = 0;

  onMount(() => {
    legacyRender("#app", { theme });
  });
</script>

<main class="app" data-theme={theme}>
  <h1>Twiglane</h1>
  <button on:click={() => count++}>点击 {count} 次</button>
</main>

<style>
  .app { padding: 16px; color: #333; }
</style>
`,
  after: `<script lang="ts">
  import { onMount } from "svelte";
  import { render, type View } from "./render";

  /** 新的渲染入口：主题由外壳传入 */
  let { theme = "modern" }: { theme?: string } = $props();
  let count = $state(0);
  let view: View | null = null;

  onMount(() => {
    view = render("#app", { theme, density: "compact" });
    return () => view?.destroy();
  });
</script>

<main class="app" data-theme={theme}>
  <h1>Twiglane</h1>
  <button onclick={() => count++}>点击 {count} 次</button>
</main>

<style>
  .app { padding: 12px 16px; color: var(--fg); }
</style>
`,
};

const css: Sample = {
  before: `:root {
  --accent: #0e7c55;
  --radius: 11px;
}

/* 按钮 */
.btn {
  height: 34px;
  padding: 0 14px;
  border-radius: var(--radius);
  transition: background 120ms ease;
}

.btn:hover { background: rgba(0, 0, 0, 0.05); }
`,
  after: `:root {
  --accent: #10a37f;
  --radius: 12px;
  --ring: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
}

/* 按钮：统一高度与焦点环 */
.btn {
  height: 32px;
  padding: 0 12px;
  border-radius: var(--radius);
  transition: background 120ms ease, box-shadow 120ms ease;
}

.btn:hover { background: var(--hover); }
.btn:focus-visible { box-shadow: var(--ring); }
`,
};

const ts: Sample = {
  before: `import { api } from "./api";

export interface Panel {
  id: string;
  title: string;
}

// 旧面板：同步读取，失败时静默
export function loadPanels(repo: string): Panel[] {
  const raw = api.readSync(repo, "panels.json");
  return JSON.parse(raw) as Panel[];
}

export const LIMIT = 20;
`,
  after: `import { api } from "./api";
import { normalizeError } from "./errors";

export interface Panel {
  id: string;
  title: string;
  pinned?: boolean;
}

/**
 * 新面板：异步读取，失败时给出可读原因。
 * 模板字符串与块注释跨行也能正确着色。
 */
export async function loadPanels(repo: string, signal?: AbortSignal): Promise<Panel[]> {
  try {
    const raw = await api.read(repo, \`panels/\${repo.length}.json\`, { signal });
    return (JSON.parse(raw) as Panel[]).filter((panel) => panel.id.length > 0);
  } catch (error) {
    throw normalizeError(error);
  }
}

export const LIMIT = 50;
`,
};

const md: Sample = {
  before: `# Twiglane

轻量的 Git 桌面客户端。

## 安装

\`\`\`bash
npm install
npm run tauri dev
\`\`\`

- 本地优先
- 无需登录
`,
  after: `# Twiglane（枝序）

让每次改动，都清晰有序。

## 安装

\`\`\`bash
npm ci
npm run tauri dev
\`\`\`

- 本地优先，**无需登录**
- 支持 [200+ 种语言](https://shiki.style/languages) 的语法高亮
- 冲突逐处处理
`,
};

const py: Sample = {
  before: `import json


def load(path):
    with open(path) as f:
        return json.load(f)


class Repo:
    def __init__(self, path):
        self.path = path
`,
  after: `import json
from pathlib import Path
from typing import Any


def load(path: Path) -> dict[str, Any]:
    """读取配置；文件不存在时返回空字典。"""
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


class Repo:
    def __init__(self, path: Path, *, bare: bool = False) -> None:
        self.path = path
        self.bare = bare
`,
};

const rust: Sample = {
  before: `use std::path::Path;

pub fn open(path: &Path) -> Result<Repo, String> {
    if !path.exists() {
        return Err("not found".to_string());
    }
    Ok(Repo { path: path.to_path_buf() })
}
`,
  after: `use std::path::{Path, PathBuf};

/// 打开仓库：只检查目录是否存在，不写入任何文件。
pub fn open(path: &Path) -> Result<Repo, AppError> {
    if !path.exists() {
        return Err(AppError::new("not_found", format!("{} 不存在", path.display())));
    }
    Ok(Repo { path: PathBuf::from(path), watch: true })
}
`,
};

export const SAMPLES: Record<string, Sample> = {
  svelte,
  css,
  ts,
  md,
  py,
  rs: rust,
};

export function sampleFor(path: string): Sample | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SAMPLES[ext] ?? null;
}
