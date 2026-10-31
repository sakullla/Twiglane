import { normalizeError } from "./errors";
import type {
  DiffResponse,
  GitInfo,
  OpenedRepository,
  PanelWidths,
  RecentRepo,
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
    invoke<OpenedRepository>("add_repository", { path, request_id: requestId }),
  createRepository: (path: string, requestId: number) =>
    invoke<OpenedRepository>("create_repository", { path, request_id: requestId }),
  openRepository: (path: string, requestId: number) =>
    invoke<OpenedRepository>("open_repository", { path, request_id: requestId }),
  closeRepository: () => invoke<void>("close_repository"),
  forgetRecent: (path: string) => invoke<RecentRepo[]>("forget_recent", { path }),
  refreshStatus: (path: string, generation: number, requestId: number) =>
    invoke<StatusSnapshot>("refresh_status", { path, generation, request_id: requestId }),
  loadDiff: (
    path: string,
    relative: string,
    staged: boolean,
    generation: number,
    requestId: number,
  ) =>
    invoke<DiffResponse>("load_diff", {
      path,
      relative,
      staged,
      generation,
      request_id: requestId,
    }),
  setTheme: (theme: Theme) => invoke<void>("set_theme", { theme }),
  setPanelWidths: (widths: PanelWidths) => invoke<PanelWidths>("set_panel_widths", { widths }),
  saveDraft: (path: string, message: string) => invoke<void>("save_draft", { path, message }),
};
