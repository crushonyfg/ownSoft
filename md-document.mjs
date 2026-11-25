// Markdown documents: imported .md files that can be previewed, edited, annotated and discussed.
// Annotations point into the source text ({ start, quote }); edits move them along.
import { mergeText } from "./text-edits.mjs";
import { moveAnchors, resolveAnchor } from "./text-anchors.mjs";

export const mdTextLimit = 5_000_000;
const contextLimit = 120_000;

// Moves annotations through one edit (the text between a common prefix and suffix changed).
// An annotation whose passage was rewritten is found again by its quote, or marked lost.
export const shiftAnnotations = moveAnchors;
export const reanchor = resolveAnchor;

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

export function mdSelectionOrigin(name, text, start, quote, selection = {}) {
  return { kind: "selection", reference: `Markdown 文档「${name}」中选中的一段`, quote,
    paragraph: selection.lost ? selection.paragraph || [selection.prefix, quote, selection.suffix].filter(Boolean).join("")
      : paragraphAround(text, start, start + quote.length),
    text: [selection.lost && "原文已修改或删除，这次问题仍针对上面的历史选区。", `问题针对选中的这一段。当前文档原文供参考：\n${clip(text)}`].filter(Boolean).join("\n\n") };
}

export function mdCommentOrigin(name, text, comment) {
  return { kind: "md", reference: `Markdown 文档「${name}」`, title: comment.title || "批注", quote: comment.quote,
    paragraph: comment.lost ? [comment.prefix, comment.quote, comment.suffix].filter(Boolean).join("")
      : paragraphAround(text, comment.start, comment.start + comment.quote.length),
    text: `${comment.lost ? "原文已改动；这条批注保留的是历史选区。\n" : ""}${comment.text}` };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const withoutDerived = (item) => Object.fromEntries(Object.entries(item || {}).filter(([key]) => !["bodyRevision", "turns"].includes(key)));

// Merge edits made by two application windows as well as edits made outside the app.
export function mergeRecords(base, incoming, current) {
  const b = new Map(base.map((item) => [item.id, item])), l = new Map(incoming.map((item) => [item.id, item]));
  const r = new Map(current.map((item) => [item.id, item])), result = [];
  for (const id of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
    const original = b.get(id), local = l.get(id), remote = r.get(id);
    if (same(withoutDerived(local), withoutDerived(original))) { if (remote) result.push(remote); continue; }
    if (same(withoutDerived(remote), withoutDerived(original))) { if (local) result.push(local); continue; }
    if (!local || !remote) throw new Error("这条批注在另一处也被修改，请先重新载入文档。当前草稿仍保留在编辑器中。");
    const merged = { ...remote };
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      if (["bodyRevision", "turns"].includes(key)) continue;
      if (same(local[key], original?.[key])) continue;
      if (!same(remote[key], original?.[key]) && !same(local[key], remote[key])) {
        throw new Error("这条批注在另一处也被修改，请先重新载入文档。当前草稿仍保留在编辑器中。");
      }
      if (local[key] === undefined) delete merged[key]; else merged[key] = local[key];
    }
    result.push(merged);
  }
  return result;
}


export function mergeDocumentDraft(base, incoming, current) {
  const merged = mergeText(base.text, incoming.text, current.text);
  if (!merged.clean) return merged;
  const align = (from, records) => shiftAnnotations(from, merged.text, records || []);
  const comments = mergeRecords(align(base.text, base.comments), align(incoming.text, incoming.comments), align(current.text, current.comments));
  const identify = (items) => items.map((item) => ({ ...item, id: item.id || `${item.start}:${item.quote}:${item.style}` }));
  const marks = mergeRecords(identify(align(base.text, base.marks)), identify(align(incoming.text, incoming.marks)), identify(align(current.text, current.marks)))
    .map(({ id: _id, ...mark }) => mark);
  return { ...merged, comments, marks };
}
