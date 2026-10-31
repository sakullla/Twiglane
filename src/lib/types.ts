export type Theme = "light" | "dark";

export type ChangeKind =
  | "none"
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "unmerged"
  | "unknown";

export interface RecentRepo {
  name: string;
  path: string;
  openedAtMs: number;
}

export interface GitInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  overridden: boolean;
  belowBaseline: boolean;
  message: string;
}

export interface RepoSummary {
  name: string;
  path: string;
}

export interface FileChange {
  path: string;
  originalPath: string | null;
  staged: ChangeKind;
  unstaged: ChangeKind;
  untracked: boolean;
  unmerged: boolean;
}

export interface BranchInfo {
  name: string | null;
  detached: boolean;
  unborn: boolean;
  headOid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  liveRemoteChecked: boolean;
}

export interface StatusSnapshot {
  generation: number;
  branch: BranchInfo;
  files: FileChange[];
}

export interface DiffLine {
  kind: "add" | "del" | "context" | "hunk" | "meta" | "nonewline" | string;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  hunkIndex: number | null;
}

export interface DiffHunk {
  index: number;
  header: string;
  complete: boolean;
  stageable: boolean;
  startLine: number;
  lineCount: number;
}

export interface DiffResponse {
  generation: number;
  path: string;
  staged: boolean;
  binary: boolean;
  text: string | null;
  summary: string;
  additions: number;
  deletions: number;
  complete: boolean;
  truncated: boolean;
  snapshot: string;
  hunks: DiffHunk[];
  lines: DiffLine[];
  offset: number;
  totalLines: number;
}

export interface CommitResult {
  oid: string;
  generation: number;
  branch: string;
  summary: string;
  files: string[];
  pushed: boolean;
  snapshot: StatusSnapshot;
}

export interface OpenedRepository {
  summary: RepoSummary;
  generation: number;
  snapshot: StatusSnapshot;
  draft: string;
  watchDegraded: boolean;
}

export interface PanelWidths {
  sidebar: number;
  files: number;
}

export interface SettingsDto {
  theme: Theme;
  panelWidths: PanelWidths;
  git: GitInfo;
  recent: RecentRepo[];
  settingsWarning: string | null;
}

export interface RepoChanged {
  path: string;
  generation: number;
  degraded: boolean;
}

export interface AppFailure {
  code: string;
  message: string;
  generation?: number;
}

export type DiffSide = "staged" | "unstaged";

export interface FileSelection {
  path: string;
  side: DiffSide;
}

export interface FileRow extends FileChange {
  side: DiffSide;
}
