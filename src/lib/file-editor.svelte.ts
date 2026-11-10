import { api } from "./api";
import { normalizeError } from "./errors";
import type { RepositoryEditSnapshot } from "./types";

/**
 * 轻量编辑会话：当前工作区普通文本文件的内存草稿。
 *
 * 会话身份是「仓库 + 路径」，草稿永远挂在读取时的 baseDigest（原始字节 SHA-256）上：
 * - 保存只发送 baseDigest 与草稿，后端在写锁内复核摘要，不一致返回 edit_conflict 且不写；
 * - 外部修改时干净的会话直接换到新基线，dirty 会话保留草稿并标出冲突，从不自动合并或覆盖；
 * - 保存失败保留草稿与原 baseDigest，只有用户明确「重新读取」才换基线；
 * - 草稿只在内存里：重启不恢复，换仓库前由外壳要求保存、放弃或取消。
 *
 * 这里不运行 Git、不暂存、不提交，也不提供终端、命令执行或 IDE 能力。
 */

export type EditPhase = "loading" | "ready" | "readonly" | "failed";

export interface EditSession {
  /** 会话实例号：关闭后同一路径重新打开是另一个会话，在途结果按它丢弃。 */
  id: number;
  repository: string;
  path: string;
  phase: EditPhase;
  /** 当前草稿的基线摘要；只读或读取失败时为 null。 */
  baseDigest: string | null;
  /** 基线文本（LF 行尾，不含 BOM）。 */
  baseText: string;
  draft: string;
  snapshot: RepositoryEditSnapshot | null;
  saving: boolean;
  /** 明确重新读取进行中：草稿保持显示，读完才换基线。 */
  reloading: boolean;
  /** 只读原因、读取失败或保存失败的说明。 */
  error: string | null;
  /** 外部修改或保存冲突：草稿仍在，但不能按旧基线保存。 */
  conflict: string | null;
  /** 基线或保存每变一次就前进：外部检查的迟到结果按它丢弃。 */
  revision: number;
  /** 最近一次保存成功的时间（只用于提示）。 */
  savedAt: number | null;
}

/** 读取/保存需要的仓库上下文：代次在调用时取当前值，旧代次由后端返回 stale。 */
export interface EditContext {
  generation: number;
  nextId: () => number;
  onGeneration?: (generation: number) => void;
}

export type SaveOutcome =
  | { ok: true; snapshot: RepositoryEditSnapshot }
  | { ok: false; code: string; message: string };

export const EXTERNAL_CONFLICT =
  "文件在编辑期间被外部修改。草稿仍保留在这里，没有覆盖任何内容；可以先复制草稿，再放弃草稿并重新读取。";

export function sessionKey(repository: string, path: string): string {
  return `${repository}\u0000${path}`;
}

/** 有未保存修改：只有可编辑会话才有草稿；只读、读取中与失败都不算。 */
export function isDirty(session: EditSession | null | undefined): boolean {
  return Boolean(session && session.phase === "ready" && session.draft !== session.baseText);
}

/** 为什么现在不能保存；null 表示可以保存。 */
export function saveBlocker(session: EditSession | null | undefined, writeLocked = false): string | null {
  if (!session || session.phase !== "ready") return "文件还不能编辑";
  if (session.saving) return "正在保存";
  if (session.reloading) return "正在重新读取";
  if (session.conflict) return "文件已被外部修改：请先复制草稿，再重新读取";
  if (!isDirty(session)) return "没有未保存的修改";
  if (writeLocked) return "正在执行其他操作，稍后再保存";
  return null;
}

/** 行尾与编码的一句说明：保存会按它还原，不静默改写。 */
export function encodingLabel(snapshot: RepositoryEditSnapshot | null): string {
  if (!snapshot) return "";
  const ending = snapshot.lineEnding === "crlf" ? "CRLF" : snapshot.lineEnding === "lf" ? "LF" : "无换行";
  return `${ending} · UTF-8${snapshot.bom ? " BOM" : ""}`;
}

export interface FileEditor {
  session(repository: string, path: string): EditSession | null;
  /** 某个仓库里所有有未保存修改的会话（按路径排序）。 */
  dirty(repository: string): EditSession[];
  /** 进入编辑：新会话读取完整快照；已有会话按当前文件复核外部变化。 */
  open(repository: string, path: string, context: EditContext): Promise<void>;
  input(repository: string, path: string, text: string): void;
  /** 把草稿还原成基线文本（不重新读取文件）。 */
  revert(repository: string, path: string): void;
  save(repository: string, path: string, context: EditContext): Promise<SaveOutcome>;
  /** 明确放弃草稿并按当前文件重新读取基线。 */
  reload(repository: string, path: string, context: EditContext): Promise<void>;
  /** 文件版本变化：干净会话换到新基线，dirty 会话保留草稿并标出冲突。 */
  checkExternal(repository: string, path: string, context: EditContext): Promise<void>;
  /** 结束这个文件的编辑并丢掉草稿（调用方负责先确认）。 */
  close(repository: string, path: string): void;
  /** 换仓库：别的仓库里干净的会话直接结束，未保存草稿留在内存里等用户回来处理。 */
  retainRepository(repository: string): string[];
  reset(): void;
}

async function readSnapshot(repository: string, path: string, context: EditContext): Promise<RepositoryEditSnapshot> {
  try {
    return await api.repositoryEditSnapshot(repository, path, context.generation, context.nextId());
  } catch (error) {
    const failure = normalizeError(error);
    if (failure.code !== "stale" || failure.generation === undefined) throw error;
    context.onGeneration?.(failure.generation);
    return api.repositoryEditSnapshot(repository, path, failure.generation, context.nextId());
  }
}

export function createFileEditor(): FileEditor {
  const state = $state<{ sessions: Record<string, EditSession> }>({ sessions: {} });
  let nextSession = 1;

  function find(repository: string, path: string): EditSession | null {
    return state.sessions[sessionKey(repository, path)] ?? null;
  }

  /** 在途结果只写回发起它的那个会话；会话被关闭或重开就丢弃。 */
  function current(repository: string, path: string, id: number): EditSession | null {
    const session = find(repository, path);
    return session && session.id === id ? session : null;
  }

  function adopt(session: EditSession, snapshot: RepositoryEditSnapshot): void {
    session.snapshot = snapshot;
    session.revision += 1;
    session.conflict = null;
    session.reloading = false;
    if (snapshot.editable && snapshot.digest && snapshot.text !== null) {
      session.phase = "ready";
      session.baseDigest = snapshot.digest;
      session.baseText = snapshot.text;
      session.draft = snapshot.text;
      session.error = null;
    } else {
      session.phase = "readonly";
      session.baseDigest = null;
      session.baseText = "";
      session.draft = "";
      session.error = snapshot.message || "这个文件不能在这里编辑。";
    }
  }

  async function open(repository: string, path: string, context: EditContext): Promise<void> {
    const existing = find(repository, path);
    if (existing) {
      if (existing.phase === "failed") await reload(repository, path, context);
      else await checkExternal(repository, path, context);
      return;
    }
    const id = nextSession++;
    state.sessions[sessionKey(repository, path)] = {
      id,
      repository,
      path,
      phase: "loading",
      baseDigest: null,
      baseText: "",
      draft: "",
      snapshot: null,
      saving: false,
      reloading: false,
      error: null,
      conflict: null,
      revision: 0,
      savedAt: null,
    };
    try {
      const snapshot = await readSnapshot(repository, path, context);
      const session = current(repository, path, id);
      if (session) adopt(session, snapshot);
    } catch (error) {
      const session = current(repository, path, id);
      if (!session) return;
      session.phase = "failed";
      session.error = normalizeError(error).message || "无法读取这个文件的完整内容。";
    }
  }

  function input(repository: string, path: string, text: string): void {
    const session = find(repository, path);
    if (!session || session.phase !== "ready") return;
    session.draft = text;
  }

  function revert(repository: string, path: string): void {
    const session = find(repository, path);
    if (!session || session.phase !== "ready" || session.saving) return;
    session.draft = session.baseText;
    session.error = null;
  }

  async function save(repository: string, path: string, context: EditContext): Promise<SaveOutcome> {
    const session = find(repository, path);
    const blocked = saveBlocker(session);
    if (!session || blocked || !session.baseDigest) {
      return { ok: false, code: session?.conflict ? "edit_conflict" : "edit_not_ready", message: blocked ?? "文件还不能保存。" };
    }
    const id = session.id;
    const sent = session.draft;
    const digest = session.baseDigest;
    session.saving = true;
    session.error = null;
    // 保存期间读到的外部检查结果可能就是这次写入本身，不能拿它判冲突。
    session.revision += 1;
    try {
      let snapshot: RepositoryEditSnapshot;
      try {
        snapshot = await api.repositoryEditSave(repository, path, digest, sent, context.generation, context.nextId());
      } catch (error) {
        const failure = normalizeError(error);
        if (failure.code !== "stale" || failure.generation === undefined) throw error;
        // 只是代次旧了：摘要仍在写锁内复核，用新代次重发一次是安全的。
        context.onGeneration?.(failure.generation);
        snapshot = await api.repositoryEditSave(repository, path, digest, sent, failure.generation, context.nextId());
      }
      const live = current(repository, path, id);
      if (live) {
        live.snapshot = snapshot;
        live.baseDigest = snapshot.digest;
        live.baseText = snapshot.text ?? sent;
        // 保存在途时又输入了内容：新输入继续是草稿，不被保存结果盖掉。
        if (live.draft === sent) live.draft = live.baseText;
        live.revision += 1;
        live.conflict = null;
        live.error = null;
        live.savedAt = Date.now();
      }
      return { ok: true, snapshot };
    } catch (error) {
      const failure = normalizeError(error);
      const live = current(repository, path, id);
      if (live) {
        if (failure.code === "edit_conflict") live.conflict = failure.message || EXTERNAL_CONFLICT;
        else live.error = `保存失败，草稿仍保留：${failure.message || "未知错误"}`;
      }
      return { ok: false, code: failure.code, message: failure.message };
    } finally {
      const live = current(repository, path, id);
      if (live) live.saving = false;
    }
  }

  async function reload(repository: string, path: string, context: EditContext): Promise<void> {
    const session = find(repository, path);
    if (!session || session.saving) return;
    const id = session.id;
    session.reloading = true;
    if (session.phase === "failed") session.phase = "loading";
    try {
      const snapshot = await readSnapshot(repository, path, context);
      const live = current(repository, path, id);
      if (live) adopt(live, snapshot);
    } catch (error) {
      const live = current(repository, path, id);
      if (!live) return;
      live.reloading = false;
      const message = normalizeError(error).message || "无法读取这个文件的完整内容。";
      if (live.phase === "loading") live.phase = "failed";
      live.error = live.phase === "failed" ? message : `重新读取失败，草稿仍保留：${message}`;
    }
  }

  async function checkExternal(repository: string, path: string, context: EditContext): Promise<void> {
    const session = find(repository, path);
    if (!session || session.phase === "loading" || session.phase === "failed" || session.saving || session.reloading) return;
    const id = session.id;
    const revision = session.revision;
    let snapshot: RepositoryEditSnapshot;
    try {
      snapshot = await readSnapshot(repository, path, context);
    } catch {
      // 复核读不到不是冲突结论：保留现状，保存时后端仍会在写锁内复核。
      return;
    }
    const live = current(repository, path, id);
    if (!live || live.revision !== revision || live.saving || live.reloading) return;
    if (live.phase === "ready" && snapshot.editable && snapshot.digest === live.baseDigest) {
      // 内容没变（例如只是元数据或别的文件变化）；外部改回原样时冲突也随之解除。
      live.conflict = null;
      return;
    }
    if (!isDirty(live)) {
      adopt(live, snapshot);
      return;
    }
    // dirty 草稿绝不被外部内容覆盖：只标冲突，基线保持不变，保存会被后端拒绝。
    live.conflict = snapshot.editable
      ? EXTERNAL_CONFLICT
      : `文件已不再可编辑（${snapshot.message || "状态改变"}）。草稿仍保留在这里，没有写入任何内容。`;
  }

  function close(repository: string, path: string): void {
    delete state.sessions[sessionKey(repository, path)];
  }

  function dirty(repository: string): EditSession[] {
    return Object.values(state.sessions)
      .filter((session) => session.repository === repository && isDirty(session))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  function retainRepository(repository: string): string[] {
    const kept: string[] = [];
    for (const [key, session] of Object.entries(state.sessions)) {
      if (session.repository === repository) continue;
      if (isDirty(session)) kept.push(`${session.repository}:${session.path}`);
      else delete state.sessions[key];
    }
    return kept;
  }

  function reset(): void {
    for (const key of Object.keys(state.sessions)) delete state.sessions[key];
  }

  return {
    session: find,
    dirty,
    open,
    input,
    revert,
    save,
    reload,
    checkExternal,
    close,
    retainRepository,
    reset,
  };
}

/** 应用内唯一的编辑会话表：文件视图写入，外壳在换仓库与返回来源前读取。 */
export const fileEditor = createFileEditor();
