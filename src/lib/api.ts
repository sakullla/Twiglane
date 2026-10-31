import { normalizeError } from "./errors";
import type {
  BranchState,
  CloneResult,
  CommitPushReport,
  CommitResult,
  DiffResponse,
  GitInfo,
  OpenedRepository,
  PanelWidths,
  RecentRepo,
  RemoteState,
  SettingsDto,
  StatusSnapshot,
  Theme,
} from "./types";

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  try {
    return await call<T>(command, args);
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function listenEvent<T>(
  name: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(name, (event) => handler(event.payload));
}

export async function pickDirectory(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

export async function pickFile(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: false, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

export const api = {
  detectGit: () => invoke<GitInfo>("detect_git"),
  setGitExecutable: (path: string) => invoke<GitInfo>("set_git_executable", { path }),
  clearGitExecutable: () => invoke<GitInfo>("clear_git_executable"),
  getSettings: () => invoke<SettingsDto>("get_settings"),
  addRepository: (path: string, requestId: number) =>
    invoke<OpenedRepository>("add_repository", { path, requestId }),
  createRepository: (path: string, requestId: number) =>
    invoke<OpenedRepository>("create_repository", { path, requestId }),
  openRepository: (path: string, requestId: number) =>
    invoke<OpenedRepository>("open_repository", { path, requestId }),
  closeRepository: () => invoke<void>("close_repository"),
  forgetRecent: (path: string) => invoke<RecentRepo[]>("forget_recent", { path }),
  refreshStatus: (path: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("refresh_status", { path, generation, requestId }),
  loadDiff: (
    path: string,
    relative: string,
    staged: boolean,
    generation: number,
    requestId: number,
    original: string | null = null,
    offset = 0,
    limit = 0,
  ) =>
    invoke<DiffResponse>("load_diff", {
      path,
      relative,
      original,
      staged,
      generation,
      requestId,
      offset,
      limit,
    }),
  stageFiles: (path: string, paths: string[], generation: number, requestId: number) =>
    invoke<StatusSnapshot>("stage_files", { path, paths, generation, requestId }),
  unstageFiles: (path: string, paths: string[], generation: number, requestId: number) =>
    invoke<StatusSnapshot>("unstage_files", { path, paths, generation, requestId }),
  stageHunks: (
    path: string,
    relative: string,
    staged: boolean,
    hunks: number[],
    snapshot: string,
    generation: number,
    requestId: number,
    original: string | null = null,
  ) =>
    invoke<StatusSnapshot>("stage_hunks", {
      path,
      relative,
      original,
      staged,
      hunks,
      snapshot,
      generation,
      requestId,
    }),
  commitChanges: (path: string, message: string, generation: number, requestId: number) =>
    invoke<CommitResult>("commit_changes", { path, message, generation, requestId }),
  cloneRepository: (url: string, parent: string, name: string, requestId: number) =>
    invoke<CloneResult>("clone_repository", { url, parent, name, requestId }),
  remoteState: (path: string, generation: number, requestId: number) =>
    invoke<RemoteState>("remote_state", { path, generation, requestId }),
  addRemote: (path: string, name: string, url: string, generation: number, requestId: number) =>
    invoke<RemoteState>("add_remote", { path, name, url, generation, requestId }),
  setRemoteUrl: (path: string, name: string, url: string, generation: number, requestId: number) =>
    invoke<RemoteState>("set_remote_url", { path, name, url, generation, requestId }),
  fetchRemote: (path: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("fetch_remote", { path, generation, requestId }),
  pullFastForward: (path: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("pull_fast_forward", { path, generation, requestId }),
  pushBranch: (path: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("push_branch", { path, generation, requestId }),
  publishBranch: (path: string, remote: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("publish_branch", { path, remote, generation, requestId }),
  associateUpstream: (path: string, remote: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("associate_upstream", { path, remote, generation, requestId }),
  commitAndPush: (path: string, message: string, generation: number, requestId: number) =>
    invoke<CommitPushReport>("commit_and_push", { path, message, generation, requestId }),
  branchState: (path: string, generation: number, requestId: number) =>
    invoke<BranchState>("branch_state", { path, generation, requestId }),
  createBranch: (path: string, name: string, generation: number, requestId: number) =>
    invoke<BranchState>("create_branch", { path, name, generation, requestId }),
  switchBranch: (path: string, name: string, generation: number, requestId: number) =>
    invoke<BranchState>("switch_branch", { path, name, generation, requestId }),
  deleteBranch: (
    path: string,
    name: string,
    confirmUnmerged: boolean,
    generation: number,
    requestId: number,
  ) =>
    invoke<BranchState>("delete_branch", {
      path,
      name,
      confirmUnmerged,
      generation,
      requestId,
    }),
  deleteRemoteBranch: (
    path: string,
    remote: string,
    name: string,
    confirm: boolean,
    generation: number,
    requestId: number,
  ) =>
    invoke<BranchState>("delete_remote_branch", {
      path,
      remote,
      name,
      confirm,
      generation,
      requestId,
    }),
  setTheme: (theme: Theme) => invoke<void>("set_theme", { theme }),
  setPanelWidths: (widths: PanelWidths) => invoke<PanelWidths>("set_panel_widths", { widths }),
  saveDraft: (path: string, message: string) => invoke<void>("save_draft", { path, message }),
};
