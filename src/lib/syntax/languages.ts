/**
 * 路径 → 语法高亮语言。
 *
 * 语言 id 采用 Shiki（TextMate 语法，与 VS Code 同源）的命名；这里只做「文件名 / 扩展名 → id」
 * 的推断，语法本身按需加载。推断不到、或用户选了「纯文本」时不高亮。
 * 推断顺序：完整文件名（Dockerfile、Makefile…）→ 复合扩展名（.d.ts、.blade.php…）→ 扩展名
 * → 扩展名本身就是语言 id 或别名（.elm、.zig…）。
 */

import { bundledLanguagesInfo } from "shiki/langs";

export interface LanguageOption {
  id: string;
  name: string;
  aliases: string[];
}

/** 全部可选语言（按名称排序）；用于手动选择语言的列表。 */
export const LANGUAGE_OPTIONS: LanguageOption[] = bundledLanguagesInfo
  .map((info) => ({ id: info.id, name: info.name, aliases: [...(info.aliases ?? [])] }))
  .sort((a, b) => a.name.localeCompare(b.name, "en"));

const KNOWN = new Map<string, string>();
for (const option of LANGUAGE_OPTIONS) {
  KNOWN.set(option.id, option.id);
  for (const alias of option.aliases) if (!KNOWN.has(alias)) KNOWN.set(alias, option.id);
}

/** 语言 id 或别名 → 规范 id；不认识时为 null。 */
export function canonicalLanguage(id: string | null | undefined): string | null {
  if (!id) return null;
  return KNOWN.get(id.toLowerCase()) ?? null;
}

export function languageName(id: string | null): string {
  if (!id) return "纯文本";
  return LANGUAGE_OPTIONS.find((option) => option.id === id)?.name ?? id;
}

/** 完整文件名（小写）。 */
const FILENAMES: Record<string, string> = {
  dockerfile: "docker",
  containerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  "cmakelists.txt": "cmake",
  jenkinsfile: "groovy",
  vagrantfile: "ruby",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  fastfile: "ruby",
  brewfile: "ruby",
  procfile: "shellscript",
  justfile: "just",
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
  ".npmignore": "ignore",
  ".prettierignore": "ignore",
  ".eslintignore": "ignore",
  ".gitattributes": "ini",
  ".gitmodules": "ini",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".env": "dotenv",
  ".bashrc": "shellscript",
  ".bash_profile": "shellscript",
  ".zshrc": "shellscript",
  ".profile": "shellscript",
  "nginx.conf": "nginx",
  "go.mod": "go",
  "go.sum": "txt",
  "cargo.lock": "toml",
  "pipfile": "toml",
  "poetry.lock": "toml",
  "yarn.lock": "yaml",
  "pnpm-lock.yaml": "yaml",
  "package.json": "json",
  "tsconfig.json": "jsonc",
  "jsconfig.json": "jsonc",
  ".babelrc": "json",
  ".eslintrc": "json",
  ".prettierrc": "json",
  "license": "txt",
  "codeowners": "codeowners",
};

/** 复合扩展名（从长到短匹配）。 */
const COMPOUND: [string, string][] = [
  [".d.ts", "typescript"],
  [".d.mts", "typescript"],
  [".d.cts", "typescript"],
  [".blade.php", "blade"],
  [".html.erb", "erb"],
  [".gitlab-ci.yml", "yaml"],
  [".env.local", "dotenv"],
  [".env.example", "dotenv"],
  [".tf.json", "json"],
];

/** 扩展名（不含点，小写）。 */
const EXTENSIONS: Record<string, string> = {
  // Web
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  html: "html",
  htm: "html",
  xhtml: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  styl: "stylus",
  stylus: "stylus",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  mdx: "mdx",
  hbs: "handlebars",
  handlebars: "handlebars",
  pug: "pug",
  jade: "pug",
  ejs: "html",
  njk: "jinja",
  jinja: "jinja",
  jinja2: "jinja",
  j2: "jinja",
  liquid: "liquid",
  twig: "twig",
  erb: "erb",
  wasm: "wasm",
  wat: "wasm",
  graphql: "graphql",
  gql: "graphql",
  // 数据与配置
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  jsonl: "jsonl",
  ndjson: "jsonl",
  geojson: "json",
  webmanifest: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "properties",
  env: "dotenv",
  xml: "xml",
  xsd: "xml",
  xsl: "xsl",
  xslt: "xsl",
  svg: "xml",
  plist: "xml",
  csproj: "xml",
  vbproj: "xml",
  fsproj: "xml",
  props: "xml",
  targets: "xml",
  resx: "xml",
  xaml: "xml",
  storyboard: "xml",
  csv: "csv",
  tsv: "tsv",
  sql: "sql",
  prisma: "prisma",
  proto: "proto",
  hcl: "hcl",
  tf: "terraform",
  tfvars: "terraform",
  nix: "nix",
  dhall: "dhall",
  cue: "cue",
  // 文档
  md: "markdown",
  markdown: "markdown",
  mdown: "markdown",
  rst: "rst",
  adoc: "asciidoc",
  asciidoc: "asciidoc",
  tex: "latex",
  ltx: "latex",
  sty: "latex",
  cls: "latex",
  bib: "bibtex",
  typ: "typst",
  org: "org",
  txt: "txt",
  log: "log",
  diff: "diff",
  patch: "diff",
  // 系统与脚本
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ksh: "shellscript",
  fish: "fish",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "bat",
  cmd: "bat",
  awk: "awk",
  vim: "viml",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  t: "perl",
  raku: "raku",
  rakumod: "raku",
  tcl: "tcl",
  nu: "nushell",
  // 通用语言
  py: "python",
  pyw: "python",
  pyi: "python",
  pyx: "cython",
  ipynb: "json",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  ru: "ruby",
  php: "php",
  phtml: "php",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sc: "scala",
  sbt: "scala",
  groovy: "groovy",
  gradle: "groovy",
  gvy: "groovy",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  edn: "clojure",
  go: "go",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  ipp: "cpp",
  inl: "cpp",
  ino: "cpp",
  cu: "cpp",
  cuh: "cpp",
  m: "objective-c",
  mm: "objective-cpp",
  swift: "swift",
  cs: "csharp",
  csx: "csharp",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  vb: "vb",
  dart: "dart",
  zig: "zig",
  nim: "nim",
  v: "v",
  d: "d",
  hs: "haskell",
  lhs: "haskell",
  elm: "elm",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  ml: "ocaml",
  mli: "ocaml",
  re: "reason",
  rei: "reason",
  purs: "purescript",
  lisp: "common-lisp",
  lsp: "common-lisp",
  el: "emacs-lisp",
  scm: "scheme",
  rkt: "racket",
  jl: "julia",
  r: "r",
  rmd: "markdown",
  f: "fortran-fixed-form",
  for: "fortran-fixed-form",
  f90: "fortran-free-form",
  f95: "fortran-free-form",
  f03: "fortran-free-form",
  pas: "pascal",
  pp: "pascal",
  ada: "ada",
  adb: "ada",
  ads: "ada",
  cob: "cobol",
  cbl: "cobol",
  asm: "asm",
  s: "asm",
  nasm: "asm",
  sol: "solidity",
  move: "move",
  cairo: "cairo",
  vy: "vyper",
  gd: "gdscript",
  gdshader: "gdshader",
  hlsl: "hlsl",
  glsl: "glsl",
  vert: "glsl",
  frag: "glsl",
  shader: "shaderlab",
  wgsl: "wgsl",
  sv: "system-verilog",
  svh: "system-verilog",
  vhd: "vhdl",
  vhdl: "vhdl",
  coffee: "coffee",
  ls: "javascript",
  cr: "crystal",
  hx: "haxe",
  gleam: "gleam",
  odin: "odin",
  mojo: "mojo",
  apex: "apex",
  abap: "abap",
  ahk: "ahk",
  au3: "autoit",
  bicep: "bicep",
  cmake: "cmake",
  mk: "make",
  mak: "make",
  dockerfile: "docker",
  http: "http",
  rest: "http",
  plantuml: "plantuml",
  puml: "plantuml",
  mermaid: "mermaid",
  mmd: "mermaid",
  dot: "dot",
  gv: "dot",
  po: "po",
  pot: "po",
  srt: "srt",
  vtt: "vtt",
  reg: "reg",
  rego: "rego",
  smali: "smali",
  tsp: "typespec",
  qml: "qml",
  qmldir: "qmldir",
  wl: "wolfram",
  nb: "wolfram",
  sas: "sas",
  stata: "stata",
  do: "stata",
  matlab: "matlab",
  mat: "matlab",
  ps: "postcss",
  pcss: "postcss",
  postcss: "postcss",
  sparql: "sparql",
  rq: "sparql",
  ttl: "turtle",
  kdl: "kdl",
  zen: "zenscript",
  "1": "roff",
  man: "roff",
};

function resolved(id: string | undefined): string | null {
  return id ? canonicalLanguage(id) : null;
}

/** 由路径推断语言；推断不到返回 null（按纯文本显示）。 */
export function detectLanguage(path: string): string | null {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  if (!name) return null;
  const byName = resolved(FILENAMES[name]);
  if (byName) return byName;
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return resolved("docker");
  if (name.startsWith(".env.")) return resolved("dotenv");
  for (const [suffix, id] of COMPOUND) if (name.endsWith(suffix)) return resolved(id);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 && !name.startsWith(".")) return null;
  const ext = name.slice(dot + 1);
  return resolved(EXTENSIONS[ext]) ?? canonicalLanguage(ext);
}

/** 用户覆盖与偏好按「扩展名」记：同类文件一次选定，处处生效（如 .h 统一按 C++）。 */
export function extensionKey(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : name;
}
