import type { ChangeRequestDraftCommit } from "./types";

/**
 * 根据「来源相对目标多出的提交」生成 MR/PR 的标题与描述草稿。
 *
 * 只做可预测的整理，不编造内容：标题取一条真实提交的标题（或由分支名整理），
 * 描述按时间顺序列出提交标题；单个提交时直接沿用它的正文。用户随时可以改写。
 */

export interface ChangeRequestDraftText {
  title: string;
  body: string;
}

/** fixup/squash/WIP 之类的过程提交不适合当标题，也不进摘要列表。 */
const NOISE = /^(fixup!|squash!|amend!|wip\b|merge (branch|remote-tracking branch|pull request)\b)/i;

function meaningful(commit: ChangeRequestDraftCommit): boolean {
  const subject = commit.subject.trim();
  return subject.length > 0 && !NOISE.test(subject);
}

/** 分支名整理成标题：去掉 feature/ 一类前缀，分隔符换成空格。太短或不像描述时返回空串。 */
export function titleFromBranch(branch: string): string {
  const tail = branch.split("/").filter(Boolean).pop() ?? "";
  const words = tail.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  if (words.length < 4 || !/\s/.test(words)) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function draftChangeRequest(
  commits: ChangeRequestDraftCommit[],
  sourceBranch: string,
  truncated = false,
): ChangeRequestDraftText {
  // 原生给的是新的在前：描述按时间顺序读起来更自然。
  const ordered = [...commits].reverse();
  const useful = ordered.filter(meaningful);
  const list = useful.length > 0 ? useful : ordered;

  if (list.length === 0) {
    return { title: titleFromBranch(sourceBranch), body: "" };
  }

  if (list.length === 1 && !truncated) {
    const only = list[0];
    return { title: only.subject.trim(), body: only.body.trim() };
  }

  const title = list[0].subject.trim();
  const lines = list.map((commit) => `- ${commit.subject.trim()}`);
  if (truncated) lines.push("- …");
  const body = [`## 变更内容`, "", ...lines].join("\n");
  return { title, body };
}
