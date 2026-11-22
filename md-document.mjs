// Markdown documents: imported .md files that can be previewed, edited, annotated and discussed.
// Annotations point into the source text ({ start, quote }); edits move them along.
import { findAnchor } from "./notebook.mjs";

export const mdTextLimit = 5_000_000;
const contextLimit = 120_000;

// Moves annotations through one edit (the text between a common prefix and suffix changed).
// An annotation whose passage was rewritten is found again by its quote, or marked lost.
export function shiftAnnotations(before, after, comments) {
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const changedEnd = before.length - suffix;
  const delta = after.length - before.length;
  return comments.map((comment) => {
    if (comment.lost) return reanchor(after, comment);
    const end = comment.start + comment.quote.length;
    if (end <= prefix) return comment;
    if (comment.start >= changedEnd) return { ...comment, start: comment.start + delta };
    return reanchor(after, comment);
  });
}

export function reanchor(text, comment) {
  const start = findAnchor(text, comment);
  if (start === null) return { ...comment, lost: true };
  const { lost, ...rest } = comment;
  return { ...rest, start };
}

// The paragraph (blank-line separated) around a passage, for a question's context.
export function paragraphAround(text, start, end = start) {
  const from = text.lastIndexOf("\n\n", start);
  const to = text.indexOf("\n\n", end);
  return text.slice(from < 0 ? 0 : from + 2, to < 0 ? text.length : to).trim();
}

const clip = (text) => text.length > contextLimit
  ? `${text.slice(0, contextLimit)}\n\n（文档后面还有 ${text.length - contextLimit} 个字符未附上。）` : text;

function annotationsText(comments) {
  return comments.filter((item) => !item.lost).map((item, index) =>
    `${index + 1}. 「${item.quote.slice(0, 200)}」：${item.text}`).join("\n");
}

// What a member is told about the document, for each kind of question.
export function mdDocumentOrigin(name, text, comments = []) {
  const notes = annotationsText(comments);
  return { kind: "selection", reference: `Markdown 文档「${name}」`,
    text: [`这是关于整篇 Markdown 文档的对话。文档原文：\n${clip(text)}`, notes && `已有批注：\n${notes}`]
      .filter(Boolean).join("\n\n") };
}

export function mdSelectionOrigin(name, text, start, quote) {
  return { kind: "selection", reference: `Markdown 文档「${name}」中选中的一段`, quote,
    paragraph: paragraphAround(text, start, start + quote.length),
    text: `问题针对选中的这一段。文档原文供参考：\n${clip(text)}` };
}

export function mdCommentOrigin(name, text, comment) {
  return { kind: "md", reference: `Markdown 文档「${name}」`, title: comment.title || "批注", quote: comment.quote,
    paragraph: paragraphAround(text, comment.start, comment.start + comment.quote.length), text: comment.text };
}
