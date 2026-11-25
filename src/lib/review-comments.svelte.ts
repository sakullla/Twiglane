/**
 * 任务审阅意见（R5，feedback-v1 的准备侧）。
 *
 * 意见只属于当前来源的一次任务范围：身份来自 reviewId + rangeVersion + baseline + head
 * 与读取代次。行定位复用差异里的 hunkIndex / kind / oldNo / newNo，不猜行号、不复用
 * 暂存语义、也不写 Git。范围或代次一变，旧意见整体转入「已失效」，不会映射到新行号上；
 * 代次也进身份，是因为「已修改文件只改了内容」时范围版本不变，只有代次能说明内容变了。
 *
 * 这里只保存当前运行期的内存状态：进程重启后需要重新发起审查，和来源本身一样。
 */
import type { ReviewFeedbackComment } from "./types";

/** 与原生 feedback-v1 一致的上限：整批 64 条，单条正文 16 KiB。 */
export const MAX_COMMENTS = 64;
export const MAX_BODY_BYTES = 16 * 1024;
/** 预览里引用的代码最多保留这么多字符，避免把整行超长内容写进面板。 */
const MAX_QUOTE_CHARS = 200;

export interface ReviewCommentAnchor {
  /** 仓库相对路径。 */
  path: string;
  hunkIndex: number;
  kind: "add" | "del" | "context";
  oldNo: number | null;
  newNo: number | null;
  /** 定位行的一小段原文，仅用于界面预览。 */
  quote: string;
  /**
   * 整块意见覆盖的行号区间。feedback-v1 只认单行锚点，所以整块意见仍挂在块内第一条
   * 改动行上；区间只写进界面标签与送出的正文开头，让原任务知道说的是哪一段。
   */
  range?: { from: number; to: number };
}

export interface ReviewComment {
  id: string;
  anchor: ReviewCommentAnchor;
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** 一次任务范围的身份：任何一项变化都让旧意见失效。 */
export interface CommentScope {
  reviewId: string;
  sessionId: string;
  worktree: string;
  baselineOid: string;
  headOid: string;
  rangeVersion: string;
  /**
   * 读到这个范围时的仓库代次。起点、HEAD 与工作区状态形状都没变、只是已修改文件的
   * 内容被改写时，rangeVersion 不会变，代次一定前进；它是「这份任务范围又被读过一次」
   * 的唯一证据，所以必须进入身份，否则旧意见会被挂到已经变化的内容上。
   */
  generation: number;
}

export interface StaleCommentBatch {
  scope: CommentScope;
  comments: ReviewComment[];
  reason: string;
}

/**
 * 每个来源一份正在写的意见草稿：锚点（新增时）、正文与正在编辑的意见 id。
 * 切换文件、视图与来源都不丢；只有显式清除或关闭来源时才删除。仍只存内存。
 */
export interface CommentDraft {
  anchor: ReviewCommentAnchor | null;
  body: string;
  editingId: string | null;
}

/** 最近一次成功准备送回的批次签名：批次身份 + 每条意见的 id@updatedAt。 */
interface PreparedSignature {
  scopeKey: string;
  entries: string[];
}

const store = $state({
  batches: {} as Record<string, ReviewComment[]>,
  /** 每个来源最近一次失效的批次：只用于说明，不参与任何定位。 */
  stale: {} as Record<string, StaleCommentBatch[]>,
  /** reviewId → 当前生效的 scope（失效说明需要分清是范围变了还是只有内容被重读）。 */
  active: {} as Record<string, CommentScope>,
  /** reviewId → 意见草稿槽。 */
  drafts: {} as Record<string, CommentDraft>,
  /** reviewId → 最近一次成功准备的签名（用于计算「未送回」的意见）。 */
  prepared: {} as Record<string, PreparedSignature>,
});

/**
 * 批次身份：来源 + 范围 + 读取代次。代次进身份是为了覆盖「状态形状没变、内容变了」
 * 这一种情况——范围版本对它不敏感，代次敏感。
 */
export function commentScopeKey(scope: CommentScope): string {
  return [scope.reviewId, scope.rangeVersion, scope.baselineOid, scope.headOid, scope.generation].join("|");
}

/** 差异行与意见锚点共用的身份键：路径 + 块号 + 行类型 + 两个行号。 */
export function commentLineKey(
  path: string,
  line: { hunkIndex: number | null; kind: string; oldNo: number | null; newNo: number | null },
): string {
  return [path, line.hunkIndex ?? "-", line.kind, line.oldNo ?? "", line.newNo ?? ""].join("|");
}

export function anchorKey(anchor: ReviewCommentAnchor): string {
  return commentLineKey(anchor.path, anchor);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** 正文的统一校验：trim 后 1 个字节以上、不超过 16 KiB。 */
export function normalizedBody(body: string): string {
  const text = body.trim();
  if (text === "") throw new Error("意见正文不能为空。");
  if (utf8Bytes(text) > MAX_BODY_BYTES) throw new Error("单条意见超过 16 KiB，请拆开写。");
  return text;
}

/** 范围本身变了：起点、HEAD 或未提交状态的形状不再相同。 */
const SCOPE_CHANGED_REASON = "任务范围（起点、HEAD 或工作区）已经变化，这批意见不会自动对应到新行号。";

/**
 * 失效说明必须说清是哪一种变化：范围换了，还是范围没换但工作区内容被重新读到过。
 * 后者是「状态形状不变、内容变了」的唯一可见证据，不能含糊地混进范围变化的说法里。
 */
function invalidationReason(before: CommentScope, after: CommentScope): string {
  const rangeMoved =
    before.worktree !== after.worktree ||
    before.baselineOid !== after.baselineOid ||
    before.headOid !== after.headOid ||
    before.rangeVersion !== after.rangeVersion;
  if (rangeMoved) return SCOPE_CHANGED_REASON;
  if (before.generation !== after.generation) {
    return (
      "任务范围没变，但工作区在这次读取之后又被改过（读取代次 " +
      before.generation +
      " → " +
      after.generation +
      "），这批意见挂的行可能已经不是原来那一行，不会自动对应到新行号。"
    );
  }
  return SCOPE_CHANGED_REASON;
}

/**
 * 读到一个新的任务范围时同步：范围或读取代次真的变了才把上一批意见标为失效。
 * 同一范围、同一代次重复读取（重复渲染、无关刷新）不会清空正在写的意见。
 */
export function adoptCommentScope(scope: CommentScope): void {
  const key = commentScopeKey(scope);
  const previous = store.active[scope.reviewId];
  const previousKey = previous ? commentScopeKey(previous) : null;
  if (previousKey === key) return;
  const known = previousKey !== null && Object.hasOwn(store.batches, previousKey) ? store.batches[previousKey] ?? [] : [];
  store.active = { ...store.active, [scope.reviewId]: scope };
  if (previousKey !== null && known.length > 0 && previous) {
    const entry: StaleCommentBatch = {
      scope,
      comments: known,
      reason: invalidationReason(previous, scope),
    };
    store.stale = { ...store.stale, [scope.reviewId]: [entry, ...(store.stale[scope.reviewId] ?? [])].slice(0, 4) };
    const batches = { ...store.batches };
    delete batches[previousKey];
    store.batches = batches;
  }
}

export function commentsIn(scope: CommentScope): ReviewComment[] {
  return store.batches[commentScopeKey(scope)] ?? [];
}

/** 当前范围里已挂意见的行身份集合（DiffView 用来在行上标出已有意见）。 */
export function commentLines(scope: CommentScope | null): ReadonlySet<string> {
  if (!scope) return new Set<string>();
  return new Set(commentsIn(scope).map((comment) => anchorKey(comment.anchor)));
}

export function staleBatches(reviewId: string): StaleCommentBatch[] {
  return store.stale[reviewId] ?? [];
}

function newId(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  // 预览与旧浏览器没有 randomUUID 时的退路：仍然是一批内唯一的 UUID 形式。
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function batchOf(scope: CommentScope): ReviewComment[] {
  return store.batches[commentScopeKey(scope)] ?? [];
}

function writeBatch(scope: CommentScope, comments: ReviewComment[]): void {
  if (comments.length === 0) {
    const batches = { ...store.batches };
    delete batches[commentScopeKey(scope)];
    store.batches = batches;
    return;
  }
  store.batches = { ...store.batches, [commentScopeKey(scope)]: comments };
}

/** 新增一条行定位意见。上限、空正文与重复锚点都在这里挡住，抛出的消息直接给用户看。 */
export function addComment(scope: CommentScope, anchor: ReviewCommentAnchor, body: string): ReviewComment {
  const text = normalizedBody(body);
  const comments = batchOf(scope);
  if (comments.length >= MAX_COMMENTS) throw new Error("一次最多送回 64 条意见，请先送回这批或删掉一些。");
  if (!anchor.path || anchor.path.startsWith("/")) throw new Error("意见路径必须是仓库相对路径。");
  if (anchor.kind !== "add" && anchor.kind !== "del" && anchor.kind !== "context") throw new Error("意见行类型无效。");
  if (anchor.oldNo === null && anchor.newNo === null) throw new Error("这一行没有可定位的行号。");
  const now = Date.now();
  const comment: ReviewComment = {
    id: newId(),
    anchor: { ...anchor, quote: anchor.quote.slice(0, MAX_QUOTE_CHARS) },
    body: text,
    createdAt: now,
    updatedAt: now,
  };
  if (utf8Bytes(sentBody(comment)) > MAX_BODY_BYTES) throw new Error("单条意见超过 16 KiB，请拆开写。");
  writeBatch(scope, [...comments, comment]);
  return comment;
}

export function editComment(scope: CommentScope, id: string, body: string): ReviewComment | null {
  const text = normalizedBody(body);
  const comments = batchOf(scope);
  const existing = comments.find((comment) => comment.id === id);
  if (!existing) return null;
  const next: ReviewComment = { ...existing, body: text, updatedAt: Date.now() };
  if (utf8Bytes(sentBody(next)) > MAX_BODY_BYTES) throw new Error("单条意见超过 16 KiB，请拆开写。");
  writeBatch(scope, comments.map((comment) => (comment.id === id ? next : comment)));
  return next;
}

export function deleteComment(scope: CommentScope, id: string): boolean {
  const comments = batchOf(scope);
  if (!comments.some((comment) => comment.id === id)) return false;
  writeBatch(scope, comments.filter((comment) => comment.id !== id));
  return true;
}

/** 意见的行号标签：新增看新侧，删除看旧侧，上下文两侧一致时只写一个；整块写区间。 */
export function anchorLabel(anchor: ReviewCommentAnchor): string {
  if (anchor.range) {
    return anchor.range.from === anchor.range.to
      ? "第 " + anchor.range.from + " 行这一块"
      : "第 " + anchor.range.from + "–" + anchor.range.to + " 行这一块";
  }
  if (anchor.kind === "del") return "删除第 " + (anchor.oldNo ?? "?") + " 行";
  if (anchor.kind === "add") return "新增第 " + (anchor.newNo ?? "?") + " 行";
  return "第 " + (anchor.newNo ?? anchor.oldNo ?? "?") + " 行";
}

/** 送出的正文：整块意见在开头写明区间，接收端只看得到单行锚点。 */
function sentBody(comment: { anchor: ReviewCommentAnchor; body: string }): string {
  return comment.anchor.range ? "（" + anchorLabel(comment.anchor) + "）" + chr10 + comment.body : comment.body;
}

/** 整批预览：只在本地展示与复制，不写文件、不打开任何深链。 */
const chr10 = String.fromCharCode(10);

export function previewComments(comments: readonly ReviewComment[]): string {
  if (comments.length === 0) return "";
  return comments
    .map((comment, index) => index + 1 + ". " + comment.anchor.path + "（" + anchorLabel(comment.anchor) + "）" + chr10 + comment.body)
    .join(chr10 + chr10);
}

export function previewText(scope: CommentScope): string {
  return previewComments(commentsIn(scope));
}

/** 交接请求：feedbackId 与 digest 由原生生成，这里只给已校验来源与当前范围里的意见。 */
export function feedbackComments(scope: CommentScope): ReviewFeedbackComment[] {
  return commentsIn(scope).map((comment) => ({
    id: comment.id,
    path: comment.anchor.path,
    hunkIndex: comment.anchor.hunkIndex,
    kind: comment.anchor.kind,
    oldNo: comment.anchor.oldNo,
    newNo: comment.anchor.newNo,
    body: sentBody(comment),
  }));
}

/* ------------------------------------------------------------------ *
 * 草稿槽：按 reviewId 保存，不参与上限校验（保存时才走 addComment/editComment）。
 * ------------------------------------------------------------------ */

export function commentDraft(reviewId: string): CommentDraft | null {
  const draft = store.drafts[reviewId];
  return draft ? { anchor: draft.anchor ? { ...draft.anchor } : null, body: draft.body, editingId: draft.editingId } : null;
}

/** 写入（合并）草稿；锚点与编辑 id 都为空且正文为空时等同清除。 */
export function setCommentDraft(reviewId: string, patch: Partial<CommentDraft>): CommentDraft | null {
  const previous = store.drafts[reviewId] ?? { anchor: null, body: "", editingId: null };
  const next: CommentDraft = {
    anchor: patch.anchor !== undefined ? (patch.anchor ? { ...patch.anchor } : null) : previous.anchor,
    body: patch.body !== undefined ? patch.body : previous.body,
    editingId: patch.editingId !== undefined ? patch.editingId : previous.editingId,
  };
  if (next.anchor === null && next.editingId === null && next.body === "") {
    clearCommentDraft(reviewId);
    return null;
  }
  store.drafts = { ...store.drafts, [reviewId]: next };
  return commentDraft(reviewId);
}

export function clearCommentDraft(reviewId: string): void {
  if (!Object.hasOwn(store.drafts, reviewId)) return;
  const drafts = { ...store.drafts };
  delete drafts[reviewId];
  store.drafts = drafts;
}

/** 草稿是否有会丢失的内容：只有正文不为空才算（打开空编辑器不算草稿）。 */
export function hasCommentDraft(reviewId: string): boolean {
  return (store.drafts[reviewId]?.body.trim() ?? "") !== "";
}

/** 草稿数（当前每个来源最多一条），供完成栏与关闭确认计算。 */
export function commentDraftCount(reviewId: string): number {
  return hasCommentDraft(reviewId) ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * 最近成功准备的签名：「未送回」= 当前批次里不在最近一次成功准备签名内的意见。
 * ------------------------------------------------------------------ */

function signatureEntry(comment: ReviewComment): string {
  return comment.id + "@" + comment.updatedAt;
}

/** 当前批次的签名字符串（批次身份 + 排序后的 id@updatedAt）。 */
export function commentsSignature(scope: CommentScope): string {
  return [commentScopeKey(scope), ...commentsIn(scope).map(signatureEntry).sort()].join("\n");
}

/** 准备送回成功后调用：记录这一刻当前批次的签名。 */
export function recordPreparedComments(scope: CommentScope): void {
  store.prepared = {
    ...store.prepared,
    [scope.reviewId]: { scopeKey: commentScopeKey(scope), entries: commentsIn(scope).map(signatureEntry) },
  };
}

/** 最近一次成功准备的签名；从未成功准备时为 null。 */
export function preparedSignature(reviewId: string): string | null {
  const prepared = store.prepared[reviewId];
  return prepared ? [prepared.scopeKey, ...[...prepared.entries].sort()].join("\n") : null;
}

/** 当前批次里还没送回的意见：新增、改过，或批次身份已变（之前准备的不算这一批）。 */
export function unsentComments(scope: CommentScope): ReviewComment[] {
  const comments = commentsIn(scope);
  const prepared = store.prepared[scope.reviewId];
  if (!prepared || prepared.scopeKey !== commentScopeKey(scope)) return comments;
  const sent = new Set(prepared.entries);
  return comments.filter((comment) => !sent.has(signatureEntry(comment)));
}

export function unsentCommentCount(scope: CommentScope | null): number {
  return scope ? unsentComments(scope).length : 0;
}

/** 显式关闭来源时一起丢掉它的意见：这些意见只属于那个 reviewId。 */
export function forgetComments(reviewId: string): void {
  const prefix = reviewId + "|";
  const batches: Record<string, ReviewComment[]> = {};
  for (const [key, comments] of Object.entries(store.batches)) {
    if (!key.startsWith(prefix)) batches[key] = comments;
  }
  store.batches = batches;
  const stale = { ...store.stale };
  delete stale[reviewId];
  store.stale = stale;
  const active = { ...store.active };
  delete active[reviewId];
  store.active = active;
  clearCommentDraft(reviewId);
  const prepared = { ...store.prepared };
  delete prepared[reviewId];
  store.prepared = prepared;
}

/** 测试用：清空全部意见与失效记录。 */
export function resetReviewComments(): void {
  store.batches = {};
  store.stale = {};
  store.active = {};
  store.drafts = {};
  store.prepared = {};
}
